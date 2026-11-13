#!/usr/bin/env python3
# Radios for the helm display.
#
# The helm app runs in a browser, and a browser cannot see the WiFi or the
# Bluetooth stack: there is no web API for either. navigator.bluetooth pairs
# a device to the *page*, which is a different thing entirely, and there is
# no WiFi equivalent at all. So the panel's connectivity tiles talk to this
# instead - a small local service that shells out to nmcli and bluetoothctl
# and hands back JSON.
#
# WiFi is modelled per adapter, not per machine. A boat Pi typically has the
# onboard radio running the hotspot everything aboard is connected to, and a
# USB dongle reaching out to a marina - two radios with opposite jobs, which
# a single on/off switch cannot express.
#
# Bound to 127.0.0.1 on purpose. Only Chromium on the Pi can reach it, so a
# phone loading the same page over boat WiFi finds nothing and hides the
# tiles - which is the behaviour we want. No guest on the boat network gets
# to re-point the boat's networking, and you cannot cut your own connection
# from the cockpit by switching off the very AP you are talking over.
#
# Started from ~/.config/autostart/confluence-netd.desktop, and that matters
# for more than convenience: NetworkManager's polkit rules grant a local
# ACTIVE SESSION the right to change networking without a password. Running
# out of the desktop session gets that for free. The same script under a
# systemd unit is an inactive session and gets refused.
#
#   python3 ~/helm/netd.py [port]
#
# Stdlib only. This runs on a boat computer that must come up without a
# network, so it has no business needing pip.

import array, contextlib, json, math, os, re, secrets, shutil, socket
import subprocess, sys
import tempfile, threading, time, urllib.error, urllib.request, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
BIND = os.environ.get('HELM_NETD_BIND', '127.0.0.1')
# Only ever anything else in a test rig: there is no way to fake an adapter
# on a real Pi, and bus detection is the one thing here that reads hardware.
SYSFS = os.environ.get('HELM_SYSFS', '/sys')

# The kiosk loads the app from AvNav on :8080, and falls back to file:// when
# AvNav is slow to come up - which arrives here as a null Origin. Both are the
# same browser on the same machine as this process, and the socket is
# loopback-only, so both are allowed and nothing else is.
ORIGINS = {'http://localhost:8080', 'http://127.0.0.1:8080', 'null'}

# The panel's like button. netd only ever writes the request here and
# checks whether credentials exist - spotify-now.py owns the token and
# does the talking. See spotify_status() for why that split matters.
SPOTIFY_CFG = os.path.expanduser('~/.config/confluence-spotify.json')
SPOTIFY_CMD = os.environ.get('HELM_SPOTIFY_CMD', '/tmp/confluence-spotify-cmd.json')

MAC = re.compile(r'^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$')
BT_MAC = re.compile(r'^Device ((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}) (.*)$')


def run(argv, timeout=30, env=None):
    """Run a command and return (rc, stdout, stderr).

    Never shell=True. SSIDs and device names are user data, and spaces,
    quotes and semicolons are all legitimate inside one.

    `env` is merged over this process's own, for the one caller that
    needs it: xrandr has to be told which X display to talk to, and this
    process may well have been started by cage - where there was none."""
    try:
        e = dict(os.environ)
        # The C locale, in UTF-8, always. Two separate things ride on it.
        #
        # The charset. nmcli writes its output in the locale's charset and
        # puts '?' in place of anything it cannot spell. A Pi that came up
        # without a locale is handed ASCII, so an iPhone hotspot - iOS names
        # them with a curly apostrophe, "Steven’s iPhone" - reaches the
        # panel as "Steven?s iPhone". The name on the glass is then one
        # NetworkManager has never heard of, and joining it or forgetting it
        # fails with nothing on screen that explains why.
        #
        # The language. wifi_error() reads nmcli's failures in English. On a
        # Pi set to anything else none of them would match and every failure
        # would come back as a raw string, which is the same bug in a hat.
        e['LC_ALL'] = 'C.UTF-8'
        if env:
            e.update(env)
        # Decode explicitly rather than by whatever the locale happens to be,
        # and never raise: an SSID is arbitrary bytes, and a panel that dies
        # mid-scan because a neighbour's router has a bad one is worse than a
        # row with a smudge in its name. Names are for reading; anything that
        # acts on a connection goes by uuid.
        p = subprocess.run(argv, capture_output=True, text=True,
                           encoding='utf-8', errors='replace',
                           timeout=timeout, env=e)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return 127, '', argv[0] + ' is not installed'
    except subprocess.TimeoutExpired:
        return 124, '', argv[0] + ' timed out'


def terse(line):
    r"""Split one line of `nmcli -t` output.

    Terse mode is colon-separated with literal colons backslash-escaped,
    which matters more than it sounds: every BSSID is full of them, and a
    naive split() turns one field into seven."""
    out, cur, esc = [], '', False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == '\\':
            esc = True
        elif ch == ':':
            out.append(cur)
            cur = ''
        else:
            cur += ch
    out.append(cur)
    return out


# ---------------------------------------------------------------- wifi

_cap = {'at': 0, 'nm': False, 'bt': False}
_lock = threading.Lock()          # one mutating radio command at a time
_apmemo = {}                      # profile name -> (checked_at, is_access_point)
_cache = {}


_gen = [0]


def memo(key, ttl, fn):
    """Answer from cache, refresh behind the answer.

    /status is what the panel waits on before it can draw the radios, and
    the Bluetooth half of it costs three or four subprocesses - two whole
    seconds on real hardware. A plain TTL cache does not fix that: it
    expires, and the next poll pays the full price again while someone is
    looking at the panel. So a stale entry is served immediately and
    refreshed on a thread. Only the very first call ever waits."""
    hit = _cache.get(key)
    now = time.time()
    if hit:
        if now - hit[0] >= ttl and not hit[2]:
            hit[2] = True                    # one refresh in flight, not five
            threading.Thread(target=_refresh, args=(key, fn, _gen[0]),
                             daemon=True).start()
        return hit[1]
    val = fn()
    _cache[key] = [now, val, False]
    return val


def _refresh(key, fn, gen):
    try:
        val = fn()
    except Exception:
        val = None
    # A bust() while this was running means the world changed underneath
    # it; writing the result now would put the stale answer back.
    if val is not None and gen == _gen[0]:
        _cache[key] = [time.time(), val, False]
    elif key in _cache:
        _cache[key][2] = False


def bust():
    """After anything that changes a radio, every cached answer is a lie."""
    _gen[0] += 1
    _cache.clear()
    _apmemo.clear()


def capabilities():
    """What this Pi can actually do, re-probed occasionally.

    Cached because /status is polled while the panel is open, and shelling
    out twice a second to learn something that changes once a year is the
    kind of idle work this display is careful not to do."""
    now = time.time()
    if now - _cap['at'] < 30:
        return _cap
    _cap['at'] = now
    # nmcli existing is not enough - it exits non-zero when NetworkManager
    # itself is not running, which is exactly the wpa_supplicant case we
    # want to detect rather than half-support.
    _cap['nm'] = bool(shutil.which('nmcli')) and run(['nmcli', '-t', '-f', 'STATE', 'general'], 6)[0] == 0
    # The rc matters as much as the text, for the same reason it does for
    # nmcli one line up. This used to read stdout alone, and run() returns
    # (124, '', ...) on timeout - so a bluetoothd that is stopped or wedged
    # on D-Bus blocked the full 6 s and then reported bt AVAILABLE, because
    # 'No default controller' is not in ''. The tile then rendered in the
    # 'off' class, which reads as "switched off" rather than "broken", and
    # tapping it took _lock for up to 15 s - the same lock a WiFi join
    # needs, so the join queued behind a dead Bluetooth call.
    bt_rc, bt_out, _ = run(['bluetoothctl', 'show'], 6) if shutil.which('bluetoothctl') else (127, '', '')
    _cap['bt'] = bt_rc == 0 and 'No default controller' not in bt_out
    return _cap


def wifi_powered():
    """The global rfkill switch. It is all-or-nothing across every adapter,
    which is exactly why the per-adapter toggles do not use it."""
    return memo('wifipow', 3, lambda:
                run(['nmcli', '-t', '-f', 'WIFI', 'radio'], 6)[1].strip() == 'enabled')


def dev_bus(dev):
    """Onboard or plugged in.

    The Pi's own radio hangs off SDIO; a dongle hangs off USB, so the
    device symlink says which is which. It decides the order the tiles
    appear in and which one gets the aerial mark, so it has to be stable
    across reboots - which a name like wlan1 is not."""
    path = '%s/class/net/%s/device' % (SYSFS, dev)
    try:
        return 'usb' if '/usb' in os.path.realpath(path) else 'onboard'
    except OSError:
        return 'onboard'


def con_is_ap(name):
    """Is this profile a hotspot rather than a network we joined?

    Two ways of saying it, and images differ on which they set, so accept
    either: 802-11-wireless.mode=ap is the radio in master mode, and
    ipv4.method=shared is NetworkManager handing out the addresses."""
    hit = _apmemo.get(name)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    rc, out, _ = run(['nmcli', '-t', '-f', '802-11-wireless.mode,ipv4.method',
                      'connection', 'show', name], 8)
    mode = meth = ''
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 2:
            if f[0] == '802-11-wireless.mode':
                mode = f[1]
            elif f[0] == 'ipv4.method':
                meth = f[1]
    val = (mode == 'ap') or (meth == 'shared')
    _apmemo[name] = (time.time(), val)
    return val


def dev_signal(dev):
    # A scan to learn one number, on a poll. Ten seconds of staleness in a
    # signal percentage is not worth what asking every time costs.
    return memo('sig:' + dev, 10, lambda: _dev_signal(dev))


def _dev_signal(dev):
    rc, out, _ = run(['nmcli', '-t', '-f', 'IN-USE,SIGNAL', 'device', 'wifi',
                      'list', 'ifname', dev], 12)
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 2 and f[0] == '*':
            try:
                return int(f[1])
            except ValueError:
                return 0
    return 0


_STCODE = re.compile(r'\s*(\d+)')
_STNAME = {0: 'unknown', 10: 'unmanaged', 20: 'unavailable',
           30: 'disconnected', 100: 'connected', 110: 'deactivating',
           120: 'failed'}


def state_code(s):
    """The number in front of GENERAL.STATE: "30 (disconnected)" -> 30.

    nmcli always prints "$NUM ($NICK)" for this field, terse mode
    included. The number is the only part that is stable. The nick gains
    a suffix when NetworkManager has ASSUMED a device rather than
    activated it - "connected (externally)" - so the old test, the
    substring '(connected)', needs a close bracket straight after the
    word and does not match it. That reads a working access point as
    DOWN, which on this boat is the one carrying the hotspot."""
    m = _STCODE.match(s or '')
    # Unparseable: 30, managed and idle, so the autoconnect flag below
    # decides rather than a missing number forcing the radio off.
    return int(m.group(1)) if m else 30


def state_name(s):
    c = state_code(s)
    if c in _STNAME:
        return _STNAME[c]
    return 'connecting' if 40 <= c <= 90 else str(c)


# One call for every adapter. AUTOCONNECT is in it because it is the
# only thing in `device show` that remembers the user asked for the
# radio to be off - see the comment on `up` below.
_FIELDS_FULL = ('GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,'
                'GENERAL.AUTOCONNECT,GENERAL.CONNECTION,IP4.ADDRESS')
_FIELDS_SAFE = ('GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,'
                'GENERAL.CONNECTION,IP4.ADDRESS')
_fields = [_FIELDS_FULL]


def wifi_devices():
    """Every managed WiFi adapter and what it is doing.

    One `device show` covers the lot - state, profile and address for all
    of them in a single call - because this is polled, and a subprocess
    per adapter per field adds up fast on a Pi."""
    rc, out, _ = run(['nmcli', '-t', '-f', _fields[0], 'device', 'show'], 15)
    if rc and _fields[0] is _FIELDS_FULL:
        # An nmcli that does not know ONE of these names fails the whole
        # call with empty output, and this function then returns [] -
        # which empties the panel, access point tile and all, looking
        # exactly like NetworkManager being down. GENERAL.AUTOCONNECT is
        # valid in 1.42.4 so this is insurance, not a known fault; it
        # costs one retry once and then stops asking.
        _fields[0] = _FIELDS_SAFE
        rc, out, _ = run(['nmcli', '-t', '-f', _fields[0], 'device', 'show'], 15)
    if rc:
        return []
    raw, cur = [], None
    for line in out.splitlines():
        f = terse(line)
        if len(f) < 2:
            continue
        k, v = f[0], f[1]
        if k == 'GENERAL.DEVICE':
            cur = {'dev': v, 'type': '', 'state': '', 'auto': 'yes',
                   'con': '', 'ip': ''}
            raw.append(cur)
        elif cur is None:
            continue
        elif k == 'GENERAL.TYPE':
            cur['type'] = v
        elif k == 'GENERAL.STATE':
            cur['state'] = v                      # e.g. "100 (connected)"
        elif k == 'GENERAL.AUTOCONNECT':
            cur['auto'] = v                       # "yes"/"no", untranslated
        elif k == 'GENERAL.CONNECTION':
            cur['con'] = '' if v in ('', '--') else v
        elif k.startswith('IP4.ADDRESS') and not cur['ip']:
            cur['ip'] = v.split('/')[0]

    devs = []
    for d in raw:
        if d['type'] != 'wifi':
            continue
        # An unmanaged adapter used to be dropped here, which is why a
        # dongle sometimes "did not show up at all": it was plugged in and
        # enumerated, NetworkManager had simply not taken it on - which is
        # what happens to one that appears after NM has started. Hiding it
        # left nothing on the panel to tap, and the one command that adopts
        # it is the one behind the switch you could not see. Show it, down,
        # and let the switch take it over.
        code = state_code(d['state'])
        unmanaged = code == 10
        ap = con_is_ap(d['con']) if d['con'] and not unmanaged else False
        # TWO QUESTIONS, and conflating them is what put "I cannot turn
        # it on, it just clicks off automatically" on the water.
        #
        #   up   - has the user switched this radio ON? The SWITCH asks
        #          this, and so does the tile.
        #   conn - has it actually JOINED something? The signal arcs and
        #          the scan cost ask this.
        #
        # They were one field reading '(connected)', so a radio that was
        # powered and idle read as OFF: tap the switch, netd turns the
        # radio on exactly as asked, the next poll says `disconnected`,
        # the switch flicks itself back - and because the sheet hides the
        # network list behind that same flag, there was then no way to
        # join anything by hand either. The ACTION was fixed in 84d56bd,
        # "the wifi switch turns the radio on; it does not join
        # anything"; the INDICATOR was left behind.
        #
        # Nothing in `device show` reports radio POWER - there is no
        # POWERED, RADIO or ENABLED field. AUTOCONNECT is the only thing
        # that remembers a user asked, which is why wifi_power writes it.
        #
        #   code > 20      not unknown, unmanaged or unavailable. 20 is
        #                  where a wifi device sits under rfkill, and NM
        #                  gets there without touching autoconnect - so
        #                  `> 10` would report a dead radio as on.
        #   40..100        in use, from `connecting` through `connected`.
        #                  NOT `>= 100`: 110 deactivating and 120 failed
        #                  would make the tile flick ON during the OFF
        #                  tap's own teardown, which is this bug's mirror.
        #   auto != 'no'   fails toward ON. A switch that cannot be
        #                  turned on is a boat with no helm; one that
        #                  reads on for an idle radio is a complaint.
        conn = code == 100
        row = {'dev': d['dev'], 'bus': dev_bus(d['dev']),
               'up': code > 20 and (40 <= code <= 100 or d['auto'] != 'no'),
               'conn': conn,
               'managed': not unmanaged,
               'ssid': '' if unmanaged else d['con'], 'ap': ap,
               'ip': '' if unmanaged else d['ip'], 'signal': 0,
               'state': state_name(d['state'])}
        # Signal is meaningless for an adapter that is itself the AP, and
        # costs a SCAN to ask for. Gated on conn and not on up: a radio
        # that is on but not associated has no IN-USE row, so the scan is
        # guaranteed to return 0 - and on an RTL8188EU, scanning on a
        # poll is the thing most likely to make the next join flaky.
        if conn and not ap:
            row['signal'] = dev_signal(d['dev'])
        devs.append(row)
    # Onboard first, then dongles: a stable order matters when the tiles
    # carry no words to tell them apart.
    devs.sort(key=lambda r: (r['bus'] == 'usb', r['dev']))
    return devs


def dev_mac(dev):
    """An adapter's MAC, which is the only name it keeps.

    wlan0 and wlan1 can swap between boots - the panel's own tile order
    is keyed off the bus for exactly that reason - so anything that has
    to mean THIS radio tomorrow has to say it this way."""
    try:
        with open('%s/class/net/%s/address' % (SYSFS, dev)) as f:
            return f.read().strip().upper()
    except OSError:
        return ''


def hotspot_pin():
    """Make the boat's own hotspot come up by itself, on the onboard radio.

    Two settings, and neither is clever - they were simply never set.

    `connection.autoconnect` is what NetworkManager reads at boot, and a
    profile made with `nmcli device wifi hotspot` does not have it. Nor
    does one that has been through a `device disconnect`. So the hotspot
    everything aboard is joined to came up only when somebody tapped it
    up on the panel, which is a poor arrangement on a boat where the
    panel is reached over the hotspot.

    `802-11-wireless.mac-address` is which radio it comes up ON. Left
    open, NM is free to take the dongle - whose whole job is the opposite
    one, reaching out to a marina. Pinned by MAC and not by wlan0,
    because those swap.

    Deliberately narrow. It never creates a hotspot and never decides
    which profile is one: it acts only on a profile con_is_ap() already
    recognises, refuses if there is more than one, and will not move a
    pin that somebody has already set. Returns what it did, for the
    startup line.
    """
    onboard = [d for d in wifi_devices() if d['bus'] == 'onboard']
    if not onboard:
        return 'no onboard radio'
    mac = dev_mac(onboard[0]['dev'])
    aps = [(n, u) for n, u in wifi_conns() if con_is_ap(u)]
    if not aps:
        return 'no hotspot profile'
    if len(aps) > 1:
        return 'more than one hotspot profile - left alone'
    name, uuid = aps[0]
    rc, out, _ = run(['nmcli', '-t', '-f',
                      'connection.autoconnect,802-11-wireless.mac-address',
                      'connection', 'show', uuid], 8)
    auto, pinned = '', ''
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 2:
            if f[0] == 'connection.autoconnect':
                auto = f[1]
            elif f[0] == '802-11-wireless.mac-address':
                pinned = '' if f[1] in ('', '--') else f[1].upper()
    argv = []
    if auto != 'yes':
        argv += ['connection.autoconnect', 'yes',
                 'connection.autoconnect-priority', '100']
    if not pinned and mac:
        argv += ['802-11-wireless.mac-address', mac]
    if not argv:
        return '%s already comes up on its own' % name
    rc, _, err = run(['nmcli', 'connection', 'modify', 'uuid', uuid] + argv, 15)
    if rc:
        return 'could not set up %s: %s' % (name, err[:80])
    if pinned and pinned != mac:
        return ('%s now autoconnects, but it is pinned to %s and the onboard '
                'radio is %s - left as found' % (name, pinned, mac))
    return '%s comes up on its own now, on %s' % (name, mac or onboard[0]['dev'])


def kernel_wifi():
    """The wifi adapters the KERNEL has.

    Not the same list as the one NetworkManager will talk about, and the
    difference is the whole point. An adapter NM has not adopted still
    appears in `device show` as unmanaged, and the panel lists those. One
    the kernel does not have appears nowhere, and no amount of nmcli will
    conjure it - that is a cable, a power budget or a driver, and it is
    not a thing the panel can fix.

    Those two look identical from the helm: the row is missing either
    way. So ask the kernel directly and let the difference be reportable.
    A netdev is wifi if it has a phy80211 link or a wireless directory;
    cfg80211 drivers give the first, a few older ones only the second."""
    base = '%s/class/net' % SYSFS
    out = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return out
    for n in names:
        d = os.path.join(base, n)
        if os.path.exists(os.path.join(d, 'phy80211')) \
           or os.path.isdir(os.path.join(d, 'wireless')):
            out.append(n)
    return out


def wifi_status():
    if not capabilities()['nm']:
        return {'available': False}
    devs = wifi_devices()
    seen = {d['dev'] for d in devs}
    # Adapters the kernel has and NetworkManager is not reporting. Normally
    # empty. When it is not, "the radio did not show up" has an answer that
    # is not a shrug: the hardware is there and the stack above it is what
    # lost it.
    return {'available': bool(devs), 'radio': wifi_powered(), 'devices': devs,
            'unseen': [n for n in kernel_wifi() if n not in seen]}


def find_dev(dev):
    """Resolve a device name from the panel, falling back to the first
    adapter so a single-radio Pi never has to send one."""
    devs = wifi_devices()
    for d in devs:
        if d['dev'] == dev:
            return d
    return devs[0] if devs else None


def wifi_conns():
    """Every saved wifi profile, as (name, uuid)."""
    rc, out, _ = run(['nmcli', '-t', '-f', 'NAME,UUID,TYPE', 'connection', 'show'], 8)
    conns = []
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 3 and f[2] == '802-11-wireless':
            conns.append((f[0], f[1]))
    return conns


def saved_wifi():
    return {n for n, _ in wifi_conns()}


def wifi_uuid(ssid):
    """The uuid of the profile the panel means by this name, or ''.

    A name is not a handle. run() forces a UTF-8 locale now, so nothing
    new arrives with '?' where its apostrophe should be - but a panel
    that has been up for a season already has one of those on the glass,
    and tapping X on it has to work. Nothing else can get rid of it from
    the boat.

    So: an exact match, and failing that, '?' standing for any single
    character. Only if that picks out exactly one profile. Two hotspots
    differing by one character is a coin toss, and deleting the wrong one
    is worse than saying no.
    """
    conns = wifi_conns()
    hit = [u for n, u in conns if n == ssid]
    if not hit and '?' in ssid:
        pat = re.compile('(?s)^'
                         + '.'.join(re.escape(x) for x in ssid.split('?'))
                         + '$')
        hit = [u for n, u in conns if pat.match(n)]
    return hit[0] if len(hit) == 1 else ''


def wifi_list(dev, rescan=False):
    if not capabilities()['nm']:
        return {'available': False, 'nets': []}
    d = find_dev(dev)
    if not d:
        return {'available': False, 'nets': []}
    argv = ['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi',
            'list', 'ifname', d['dev'], '--rescan', 'yes' if rescan else 'auto']
    rc, out, err = run(argv, 40 if rescan else 15)
    if rc:
        # --rescan landed in nmcli 1.12. On anything older the flag is the
        # only thing wrong with the command, so drop it and try again.
        rc, out, err = run(argv[:-2], 15)
        if rc:
            return {'available': True, 'powered': wifi_powered(), 'nets': [],
                    'dev': d['dev'], 'ap': d['ap'], 'up': d['up'],
                    'error': err or 'scan failed'}
    saved = saved_wifi()
    best = {}
    for line in out.splitlines():
        f = terse(line)
        if len(f) < 4:
            continue
        ssid = f[1]
        if not ssid:
            continue                      # hidden network: nothing to tap
        try:
            sig = int(f[2] or 0)
        except ValueError:
            sig = 0
        sec = '' if f[3] in ('', '--') else f[3]
        row = {'ssid': ssid, 'signal': sig, 'secure': bool(sec),
               'saved': ssid in saved, 'active': f[0] == '*'}
        # One SSID, several APs: a marina with three repeaters is one
        # network to a human. Keep the strongest, but never let a weak
        # sighting overwrite the one we are actually joined to.
        old = best.get(ssid)
        if not old or (row['active'] or (not old['active'] and sig > old['signal'])):
            best[ssid] = row
    nets = sorted(best.values(), key=lambda n: (not n['active'], -n['signal']))
    return {'available': True, 'powered': wifi_powered(), 'nets': nets,
            'dev': d['dev'], 'ap': d['ap'], 'up': d['up']}


def wifi_error(err):
    """nmcli's failures, in words that fit on a tile.

    Empty in, empty out: a command that said nothing succeeded, and
    labelling that FAILED is how a working join comes back looking
    broken."""
    if not err:
        return ''
    e = err.lower()
    if 'secrets were required' in e or 'no secrets' in e or '802-11-wireless-security.psk' in e:
        return 'WRONG PASSWORD'
    if 'timeout' in e or 'timed out' in e:
        return 'TIMED OUT'
    if 'not authorized' in e or 'not permitted' in e or 'access denied' in e:
        return 'NOT PERMITTED'
    if 'no network with ssid' in e:
        return 'OUT OF RANGE'
    if no_target(e):
        return 'NOTHING TO JOIN'
    return (err or 'FAILED')[:120]


def no_target(err):
    """NetworkManager saying "you did not tell me what to join".

    `device connect` asks it to ACTIVATE something on an adapter, not to
    switch the adapter on, and with nothing saved and in range it has
    nothing to pick. What comes back is

        Failed to add/activate new connection: A 'wireless' setting is
        required if no AP path was given.

    which is seventy characters of NetworkManager internals arriving on a
    tile that is two words wide, in answer to someone tapping a switch.

    Note the quotes around 'wireless' in the real 1.42.4 message: the
    second pattern here used to read "wireless setting is required",
    which that string does not contain, so it never once fired. Only the
    'ap path' test was carrying this."""
    e = (err or '').lower()
    return 'ap path' in e or "'wireless' setting is required" in e


def not_active(err):
    """NetworkManager refusing to disconnect something that is not up.

    Device.Disconnect() rejects any device at or below `disconnected`
    with "This device is not active" and records nothing at all - so on
    an idle radio the old OFF path was a complete no-op in NM, and
    nmcli exited 6. Not a failure of the switch: there was simply no
    link to drop."""
    return 'not active' in (err or '').lower()


def wifi_connect(dev, ssid, psk):
    d = find_dev(dev)
    if not d:
        return {'ok': False, 'error': 'NO WIFI ADAPTER'}
    with _lock:
        # Clear any OFF the switch left behind first. Activating a device
        # clears only NM's INTERNAL autoconnect block - the user one that
        # `device set autoconnect no` sets survives it - so without this,
        # joining a network after switching the radio off leaves a
        # connected adapter still flagged `AUTOCONNECT:no`, and the
        # switch snaps back off the moment the link drops.
        run(['nmcli', 'device', 'set', d['dev'], 'autoconnect', 'yes'], 20)
        # A saved profile carries its own key, and re-supplying one we were
        # never given would overwrite it with nothing. So a saved network
        # with no password typed is a plain `connection up`.
        known = wifi_uuid(ssid) if not psk else ''
        if known:
            rc, out, err = run(['nmcli', '-w', '35', 'connection', 'up', 'uuid', known,
                                'ifname', d['dev']], 45)
        else:
            argv = ['nmcli', '-w', '35', 'device', 'wifi', 'connect', ssid,
                    'ifname', d['dev']]
            if psk:
                argv += ['password', psk]
            rc, out, err = run(argv, 45)
        if rc:
            # A rejected key leaves a broken profile behind that would then
            # be offered as "saved" and fail for ever. Bin it.
            if psk:
                u = wifi_uuid(ssid)
                if u:
                    run(['nmcli', 'connection', 'delete', 'uuid', u], 10)
            return {'ok': False, 'error': wifi_error(err or out)}
    _apmemo.clear()                       # this adapter's role may have changed
    return {'ok': True}


def wifi_power(dev, on):
    """Per-adapter, so one radio can be off while the other stays up.

    Not rfkill: rfkill is global on this hardware, so turning one adapter
    off that way would take the other down with it - and on a boat that
    other one is often the hotspot everything else is talking over."""
    d = find_dev(dev)
    if not d:
        return {'ok': False, 'error': 'NO WIFI ADAPTER'}
    with _lock:
        if on:
            # Something else may have rfkilled the lot; an adapter cannot
            # come up underneath that, and the error would not say so.
            if not wifi_powered():
                run(['nmcli', 'radio', 'wifi', 'on'], 20)
            # Hand the adapter back to NetworkManager. This is the half
            # that actually turns the radio on, and it was missing.
            # `device disconnect` does not only drop the link - it tells NM
            # to stop autoconnecting on that device, and nothing lifts that
            # on its own. So an adapter switched off here, or dropped by a
            # hotspot going away, stayed switched off no matter what the
            # list underneath offered.
            run(['nmcli', 'device', 'set', d['dev'], 'managed', 'yes',
                 'autoconnect', 'yes'], 20)
            # Then try to put it back on whatever it was on. A convenience,
            # NOT the switch: `device connect` asks NM to activate
            # something, and with nothing saved and in range it fails -
            # see no_target(). The radio is on either way, and the list
            # below the switch is where you pick a network. Reporting that
            # as the switch failing is how both adapters came to look dead
            # when they were only idle.
            rc, out, err = run(['nmcli', '-w', '30', 'device', 'connect', d['dev']], 45)
            if rc and no_target(err or out):
                rc, out, err = 0, '', ''
        else:
            # `device disconnect` ALONE cannot express off. NM refuses it
            # for any device at or below `disconnected` - "this device is
            # not active" - and records nothing, so switching off an idle
            # radio did nothing whatsoever. It only ever appeared to work
            # because `up` meant "connected", so the tile was already
            # dark. Now that the tile means "switched on", off has to be
            # a thing NM remembers.
            #
            # autoconnect FIRST, because it is the half that sticks. The
            # disconnect after it is just dropping the link if there is
            # one, and having none is not a failure.
            rc, out, err = run(['nmcli', 'device', 'set', d['dev'],
                                'autoconnect', 'no'], 20)
            rc2, out2, err2 = run(['nmcli', 'device', 'disconnect',
                                   d['dev']], 30)
            if rc2 and not not_active(err2 or out2):
                rc, out, err = rc2, out2, err2
            # And do not believe the exit code of the autoconnect write.
            # libnm puts it through a legacy setter whose own comment
            # says it "is not cancellable and ignores the return value" -
            # it passes NULL for the error and gives up after 2 seconds -
            # so a polkit refusal, or NM busy mid-scan on a Pi, comes
            # back as success. Read it back instead of claiming it.
            if rc == 0:
                _, chk, _ = run(['nmcli', '-t', '-f', 'GENERAL.AUTOCONNECT',
                                 'device', 'show', d['dev']], 10)
                if 'no' not in chk.lower():
                    return {'ok': False, 'error': 'RADIO WOULD NOT STAY OFF'}
    return {'ok': rc == 0, 'error': wifi_error(err or out)}


# ----------------------------------------------------------- bluetooth

_scan = {'until': 0}


def bt_call(args, timeout=15):
    return run(['bluetoothctl'] + args, timeout)


def bt_powered():
    return memo('btpow', 3, lambda:
                re.search(r'Powered:\s*yes', bt_call(['show'], 8)[1]) is not None)


def bt_status():
    if not capabilities()['bt']:
        return {'available': False}
    powered = bt_powered()
    names = [d['name'] for d in bt_devices()['devices'] if d['connected']] if powered else []

    return {'available': True, 'powered': powered, 'connected': names,
            'scanning': time.time() < _scan['until']}


def bt_named(args):
    rc, out, _ = bt_call(args, 12)
    found = []
    for line in out.splitlines():
        m = BT_MAC.match(line.strip())
        if m:
            found.append((m.group(1), m.group(2)))
    return found


def bt_devices():
    return memo('bt', 3, _bt_devices)


def _bt_devices():
    if not capabilities()['bt']:
        return {'available': False, 'devices': []}
    powered = bt_powered()
    known = bt_named(['devices']) if powered else []
    if not known:
        return {'available': True, 'powered': powered, 'devices': [],
                'scanning': time.time() < _scan['until']}
    # bluez 5.65 grew `devices Paired`, which answers in one call what used
    # to take one `info` per device. Older bluez prints nothing useful for
    # it, and that empty answer is the signal to do it the slow way.
    paired = {m for m, _ in bt_named(['devices', 'Paired'])}
    conn = {m for m, _ in bt_named(['devices', 'Connected'])}
    if not paired:
        paired = {m for m, _ in bt_named(['paired-devices'])}
    if paired and not conn:
        for mac in list(paired)[:12]:          # bounded: this is N subprocesses
            if re.search(r'Connected:\s*yes', bt_call(['info', mac], 8)[1]):
                conn.add(mac)
    devs = [{'mac': m, 'name': n or m, 'paired': m in paired, 'connected': m in conn}
            for m, n in known]
    # Connected first, then paired, then whatever the scan turned up.
    devs.sort(key=lambda d: (not d['connected'], not d['paired'], d['name'].lower()))
    return {'available': True, 'powered': powered, 'devices': devs,
            'scanning': time.time() < _scan['until']}


def bt_scan():
    """Discovery runs for a fixed window in the background.

    `scan on` never returns on its own, so it is given a deadline and the
    UI simply re-lists while the window is open. Leaving discovery running
    for ever costs power and keeps the adapter busy."""
    if time.time() < _scan['until']:
        return {'ok': True, 'scanning': True}
    _scan['until'] = time.time() + 14
    threading.Thread(target=bt_call, args=(['--timeout', '12', 'scan', 'on'], 25),
                     daemon=True).start()
    return {'ok': True, 'scanning': True}


def bt_connect(mac):
    with _lock:
        if not any(d['mac'] == mac and d['paired'] for d in bt_devices()['devices']):
            rc, out, err = bt_call(['--timeout', '25', 'pair', mac], 35)
            if 'Failed to pair' in (out + err):
                # Nothing here can answer a PIN prompt - there is no keyboard
                # on the helm and no agent listening. Just-works devices
                # (speakers, headsets, most handhelds) pair fine; anything
                # that wants a number typed has to be done from the desktop.
                return {'ok': False, 'error': 'PAIRING REFUSED'}
            bt_call(['trust', mac], 10)
        rc, out, err = bt_call(['--timeout', '20', 'connect', mac], 30)
    if 'Connection successful' in out or rc == 0 and 'Failed' not in (out + err):
        return {'ok': True}
    return {'ok': False, 'error': 'CONNECT FAILED'}


# ------------------------------------------------------------- display
#
# The panel's FULL tile used to be wired to the Fullscreen API, which on
# this Pi is wired to nothing: --kiosk is not the Fullscreen API, so
# document.fullscreenElement is null while the display is manifestly full
# screen. The tile read OFF, and tapping it flipped its own label without
# changing a pixel. These endpoints give it something real to drive.

CHROME = shutil.which('chromium-browser') or shutil.which('chromium') or ''
APP_URL = os.environ.get('HELM_URL',
                         'http://localhost:8080/user/helm/confluence_helm.html')
KIOSK_FLAG = '--kiosk'
WIN_FLAG = '--start-maximized'          # how we tell our windowed one apart
# Anchored on the executable: an unanchored -f pattern also matches any
# shell whose command line happens to mention the flag.
KIOSK_PAT = r'^[^ ]*chromium[^ ]* .*--kiosk'
WIN_PAT = r'^[^ ]*chromium[^ ]* .*--start-maximized'
LOOP = os.path.expanduser('~/helm/start-kiosk.sh')


def xenv():
    """A desktop to launch into.

    Inherited for free from the autostart session; defaulted so that the
    same call still works when netd was started by hand over SSH."""
    env = dict(os.environ)
    env.setdefault('DISPLAY', ':0')
    env.setdefault('XAUTHORITY', os.path.expanduser('~/.Xauthority'))
    return env


def spawn(argv):
    subprocess.Popen(argv, env=xenv(), stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)


def display_status():
    """One pgrep for the lot - this rides along with /status, which the
    panel polls, so it is not the place for three subprocesses."""
    if not CHROME:
        return {'available': False}
    rc, out, _ = run(['pgrep', '-af', 'chromium|start-kiosk|cage'], 8)
    kiosk = win = loop = other = cage = False
    for line in out.splitlines():
        cmd = line.split(None, 1)[1] if ' ' in line else ''
        # cage runs one maximized application and there is no windowing
        # to switch to, so this is the fact that retires the FULL/KIOSK
        # tile. cage-session.sh counts as well as cage itself: between
        # relaunches the compositor is briefly gone but the mode is not.
        if 'cage-session.sh' in cmd or re.match(r'(\S*/)?cage(\s|$)', cmd):
            cage = True
            continue          # the launcher, not a browser launch
        if 'start-kiosk.sh' in line:
            loop = True
        elif '--type=' in line:
            continue          # a renderer or gpu child, not a browser launch
        elif KIOSK_FLAG in line:
            kiosk = True
        elif WIN_FLAG in line:
            win = True
        elif 'chromium' in line:
            # Something else owns the profile - the desktop shortcut, most
            # likely. It matters because Chromium is single-instance: while
            # this is true, no other launch can take the screen.
            other = True
    return {'available': bool(kiosk or win or other or os.environ.get('DISPLAY')),
            'kiosk': kiosk, 'windowed': win, 'loop': loop, 'other': other,
            'cage': cage}


def go_windowed():
    # The loop first, or it simply puts the kiosk back three seconds later.
    run(['pkill', '-f', 'start-kiosk.sh'], 10)
    run(['pkill', '-f', KIOSK_PAT], 10)
    time.sleep(1.5)
    # If a window already owns the profile - the desktop shortcut, or a
    # windowed one we started earlier - then launching another gets us
    # nothing, and worse than nothing: Chromium is single-instance per
    # profile, so it hands that window the URL, that window opens a
    # SECOND one, and the launcher quits. Stopping the kiosk was the
    # whole job. `windowed` counts here as well as `other`; leaving it
    # out meant a second tap could stack another maximized window on the
    # one already there.
    st = display_status()
    if st.get('other') or st.get('windowed'):
        return
    # ?v= for the same reason start-kiosk.sh uses one: without it Chromium
    # paints the copy it already has and the old panel flashes up first.
    spawn([CHROME, WIN_FLAG, '--noerrdialogs', '--disable-infobars',
           APP_URL + ('&' if '?' in APP_URL else '?') + 'v=%d' % int(time.time())])
    # Never strand the helm with no browser at all. If the windowed one
    # did not come up, put the kiosk back rather than leave black glass
    # and SSH as the only way in.
    time.sleep(6)
    if not display_status().get('windowed'):
        go_kiosk()


def go_kiosk():
    run(['pkill', '-f', WIN_PAT], 10)
    time.sleep(1.0)
    if not display_status().get('loop'):
        spawn(['bash', LOOP])


def display_restart():
    """Bring the browser back fresh. If nothing is supervising it, start
    the loop instead - killing it would leave nothing to relaunch."""
    if display_status().get('loop'):
        run(['pkill', '-f', KIOSK_PAT], 10)
    else:
        spawn(['bash', LOOP])


def later(fn):
    """Answer first, act after.

    Every one of these kills the browser that made the request, so doing
    the work inline means the response never arrives and the panel cannot
    tell a success from a crash."""
    threading.Timer(0.4, fn).start()
    return {'ok': True}


# ------------------------------------------------------------ backlight
#
# The panel's brightness slider was a black veil painted over the pixels.
# The backlight stayed at full behind it, so at night it still lit the
# cockpit, still cost the same power, and still wrecked night vision - it
# only made the picture darker. A browser cannot reach the backlight. This
# can, when the kernel exposes one and the udev rules make it writable.

_bl = {'at': 0, 'dev': None}


def backlight_dev():
    """First /sys/class/backlight device with the two files we need."""
    if time.time() - _bl['at'] < 60:
        return _bl['dev']
    _bl['at'] = time.time()
    _bl['dev'] = None
    base = SYSFS + '/class/backlight'   # SYSFS is real except in the test rig
    try:
        names = sorted(os.listdir(base))
    except OSError:
        names = []
    for n in names:
        d = os.path.join(base, n)
        if os.path.exists(os.path.join(d, 'brightness')) and \
           os.path.exists(os.path.join(d, 'max_brightness')):
            _bl['dev'] = d
            break
    return _bl['dev']


def _bl_read(path):
    with open(path) as f:
        return int(f.read().strip())


def backlight_status():
    d = backlight_dev()
    if not d:
        return {'available': False}
    try:
        mx = _bl_read(d + '/max_brightness')
        cur = _bl_read(d + '/brightness')
    except Exception:
        return {'available': False}
    # Readable but not writable is a real and confusing state - the panel
    # needs to know it cannot actually dim, so it can fall back to the
    # veil and say so rather than appearing to do nothing.
    return {'available': os.access(d + '/brightness', os.W_OK),
            'pct': int(round(cur * 100.0 / mx)) if mx else 0,
            'dev': os.path.basename(d)}


def backlight_set(pct):
    d = backlight_dev()
    if not d:
        return {'ok': False, 'error': 'NO BACKLIGHT'}
    try:
        mx = _bl_read(d + '/max_brightness')
        # Floored at 5%, never 0. A helm you cannot see is a helm where you
        # cannot find the slider to turn it back up.
        #
        # There was an allow_off flag here for a screensaver that put the
        # display out. It went, with the saver: a page cannot turn a
        # display off, the panel this runs on exposes no backlight to the
        # kernel at all, and the display's own power button does the real
        # thing while leaving the Pi running.
        pct = max(5, min(100, int(pct)))
        with open(d + '/brightness', 'w') as f:
            f.write(str(max(1, int(round(mx * pct / 100.0)))))
        return {'ok': True, 'pct': pct}
    except PermissionError:
        return {'ok': False, 'error': 'NOT WRITABLE'}
    except Exception as e:
        return {'ok': False, 'error': str(e)[:80]}


# --------------------------------------------------------------- sounder
#
# A countdown you can hear without looking. A browser can reach a GPIO
# pin no more than it can reach the WiFi, and it cannot pick a sound card
# either, so the race timer posts here at each signal and this makes the
# noise.
#
# Two ways of making it, because the boat can be wired either way:
#
#   audio   a tone out of the Pi's 3.5 mm jack, into a powered amp and a
#           speaker. The plug IS the connector - keyed by shape, findable
#           by feel, good for thousands of insertions - which is what you
#           want on the thing you unplug after every race. It also lets
#           the gun have a different voice from the warnings, which one
#           piezo frequency cannot.
#   gpio    an ACTIVE piezo buzzer - the kind with its own oscillator,
#           which sounds as soon as it has voltage - switched by a MOSFET
#           off a pin. A passive one needs a square wave and would need
#           this to bit-bang, which a Python process sharing a Pi with a
#           browser has no business promising. No amp and no speaker, but
#           one tone and a header connection you should not keep pulling.
#
# HELM_BUZZER_MODE picks: auto (the default), audio, gpio or off. auto
# takes audio when there is a player and an output to send it to, and
# falls back to the pin.
#
# Stdlib only, which is the rule for everything in this file: the tones
# are synthesised with `wave` and handed to aplay, and aplay ships with
# Raspberry Pi OS. No pip, no sound library, nothing to be missing on a
# boat with no network.

SOUND_MODE = os.environ.get('HELM_BUZZER_MODE', 'auto').strip().lower()
if SOUND_MODE not in ('auto', 'audio', 'gpio', 'off'):
    SOUND_MODE = 'auto'

# ---- the audio path ----

AUDIO_RATE = 44100
# Two voices, each a fundamental and the relative weight of its
# harmonics. The warnings sit where the ear is most sensitive and carry
# a harmonic to cut through wind and hull noise. The gun is low and fat,
# because the one signal you act on should not sound like the four that
# precede it - the same reason it does not look like them.
AUDIO_VOICE = {
    'warn': (2500.0, (1.0, 0.35)),
    'gun':  (420.0, (1.0, 0.55, 0.3)),
}
# Headroom under full scale. Each voice is normalised against its own
# true peak, so nothing here can clip on its own; this margin is for the
# inter-sample peaks the DAC's reconstruction filter puts back.
AUDIO_PEAK = 0.9 * 32767
AUDIO_EDGE_MS = 4.0
_voice_peak = {}


def _peak_of(harm):
    """The true peak of a voice, so the beep can go out at full scale.

    Dividing by the sum of the harmonic weights is the easy way and it
    throws away several dB - the harmonics do not all crest together.
    One period at 2048 points, once per voice, and the tone is as loud
    as 16 bits allow."""
    p = _voice_peak.get(harm)
    if p is None:
        p = max(abs(sum(a * math.sin(2 * math.pi * (k + 1) * i / 2048.0)
                        for k, a in enumerate(harm)))
                for i in range(2048))
        _voice_peak[harm] = p
    return p


def _audio_player():
    return 'aplay' if shutil.which('aplay') else None


def _audio_card():
    """The card name of the 3.5 mm jack, from `aplay -l`.

    HDMI is a separate card and is usually the default one, so naming
    the jack is not optional - a beep out of a monitor nobody has the
    volume up on is the same as no beep."""
    rc, out, _ = run(['aplay', '-l'], 5)
    if rc != 0:
        return None
    for line in out.splitlines():
        m = re.match(r'^card \d+: (\S+) \[([^]]*)\]', line)
        if m and 'headphone' in (m.group(1) + m.group(2)).lower():
            return m.group(1)
    return None


# Env-overridable for the same reason HELM_SPOTIFY_CMD is: a test rig
# must not write into the home directory of whoever is running it.
AUDIO_CFG = (os.environ.get('HELM_AUDIO_CFG', '').strip()
             or os.path.expanduser('~/.config/confluence-helm-audio.json'))


def _audio_saved():
    """The output last chosen from the panel, if any."""
    try:
        with open(AUDIO_CFG) as f:
            v = (json.load(f) or {}).get('dev', '')
        return v.strip() if isinstance(v, str) else ''
    except Exception:
        return ''


def _audio_device():
    # The environment wins: it is how a rig with something unusual in
    # front of ALSA is pinned, and it should not be silently overridden
    # by a tap on a panel.
    d = os.environ.get('HELM_AUDIO_DEV', '').strip()
    if d:
        return d
    d = _audio_saved()
    if d:
        return d
    c = AUDIO_CARD
    # plughw: rather than hw:, so ALSA converts rather than refusing a
    # rate the bcm2835 device will not take. Falling back to `default`
    # means whatever the system thinks is the output - right on a rig
    # with PipeWire in front, wrong on a bare one with HDMI first.
    return ('plughw:CARD=%s,DEV=0' % c) if c else 'default'


# The outputs worth offering, in the order they are offered. aplay can
# only address ALSA, so a Bluetooth speaker is reached through whatever
# sits in front of it - PipeWire's or PulseAudio's ALSA device, or
# bluealsa on a rig that runs that instead. Which of these exist is what
# `aplay -L` answers, so that is what decides the list rather than a
# guess about the image.
AUDIO_LABELS = [
    ('pipewire', 'PIPEWIRE'),
    ('pulse', 'PIPEWIRE / PULSE'),
    ('default', 'SYSTEM DEFAULT'),
    ('bluealsa', 'BLUETOOTH'),
]


def _aplay_pcms():
    """The PCM names aplay will take, from `aplay -L`.

    Names sit at column 0 and their descriptions are indented under
    them, so the names are the unindented lines."""
    rc, out, _ = run(['aplay', '-L'], 5)
    if rc != 0:
        return []
    return [l.strip() for l in out.splitlines()
            if l and not l[:1].isspace() and not l.startswith('#')]


def audio_outs():
    """Where the sounder can be pointed, for the panel to offer.

    The jack first and always, because it is the one that is certainly
    there and certainly awake. Everything else is whatever this image
    actually has in front of ALSA."""
    outs = []
    if AUDIO_CARD:
        outs.append({'dev': 'plughw:CARD=%s,DEV=0' % AUDIO_CARD,
                     'name': '3.5 MM JACK'})
    have = _aplay_pcms()
    for pcm, label in AUDIO_LABELS:
        if any(p == pcm or p.startswith(pcm + ':') for p in have):
            outs.append({'dev': pcm, 'name': label})
    # Whatever is in force but not on the list - a pinned HELM_AUDIO_DEV,
    # or a saved choice from an image that has since changed - is still
    # shown, because a setting you cannot see is one you cannot undo.
    if AUDIO_DEV and not any(o['dev'] == AUDIO_DEV for o in outs):
        outs.insert(0, {'dev': AUDIO_DEV, 'name': AUDIO_DEV})
    return outs


def audio_out_set(dev):
    """Point the sounder somewhere else, and remember it.

    Only at somewhere aplay says it has: a typo here is a silent boat,
    and silence is the one failure a sounder cannot report."""
    global AUDIO_DEV
    dev = str(dev or '').strip()
    if not any(o['dev'] == dev for o in audio_outs()):
        return {'ok': False, 'error': 'NO SUCH OUTPUT'}
    if os.environ.get('HELM_AUDIO_DEV', '').strip():
        return {'ok': False, 'error': 'PINNED BY HELM_AUDIO_DEV'}
    AUDIO_DEV = dev
    _snd['armed'] = 0.0          # a different output is a different DAC
    try:
        os.makedirs(os.path.dirname(AUDIO_CFG), exist_ok=True)
        tmp = AUDIO_CFG + '.part'
        with open(tmp, 'w') as f:
            json.dump({'dev': dev}, f)
        os.replace(tmp, AUDIO_CFG)
    except Exception as e:
        return {'ok': True, 'device': dev, 'saved': False, 'error': str(e)[:60]}
    return {'ok': True, 'device': dev, 'saved': True}


AUDIO_CARD = _audio_card() if (SOUND_MODE in ('auto', 'audio')
                               and _audio_player()) else None
AUDIO_DEV = _audio_device()
_snd = {'lock': threading.Lock(), 'busy': False, 'dir': None,
        'wav': {}, 'armed': 0.0, 'arm_proc': None}


def _audio_gain():
    """Wind the output up, once, at startup.

    A fresh Raspberry Pi OS comes up with the analogue output well below
    full, and the amp's pot cannot make up what the Pi never sent. The
    control is named differently across cards, so try the usual ones and
    keep the first that takes it."""
    if not AUDIO_CARD or not shutil.which('amixer'):
        return None
    try:
        pct = max(10, min(100, int(os.environ.get('HELM_AUDIO_VOL', '100'))))
    except ValueError:
        pct = 100
    for ctl in ('PCM', 'Headphone', 'Master', 'Speaker', 'Digital'):
        rc, _, _ = run(['amixer', '-q', '-c', AUDIO_CARD,
                        'sset', ctl, '%d%%' % pct], 5)
        if rc == 0:
            return ctl
    return None


def _frames(kind, ms):
    """One beep, as 16-bit stereo frames."""
    hz, harm = AUDIO_VOICE.get(kind, AUDIO_VOICE['warn'])
    n = max(1, int(AUDIO_RATE * ms / 1000.0))
    # A raised-cosine edge at each end. A tone that starts at full
    # amplitude on a non-zero sample is a step, and a step into a
    # class-D amp is a click you hear before the beep - which on the
    # gun is worse than being four milliseconds late.
    edge = max(1, min(int(AUDIO_RATE * AUDIO_EDGE_MS / 1000.0), n // 2))
    pk = _peak_of(harm)
    buf = array.array('h', bytes(4 * n))
    for i in range(n):
        t = i / float(AUDIO_RATE)
        v = 0.0
        for k, a in enumerate(harm):
            v += a * math.sin(2 * math.pi * hz * (k + 1) * t)
        g = i / float(edge) if i < edge else \
            (n - i) / float(edge) if i > n - edge else 1.0
        s = int(AUDIO_PEAK * (v / pk) * (0.5 - 0.5 * math.cos(math.pi * g)))
        buf[2 * i] = s
        buf[2 * i + 1] = s
    return buf


def _quiet_frames(ms):
    return array.array('h', bytes(4 * max(1, int(AUDIO_RATE * ms / 1000.0))))


def _audio_dir():
    if not _snd['dir']:
        _snd['dir'] = tempfile.mkdtemp(prefix='helm-sound-')
    return _snd['dir']


def _audio_wav(kind, ms, n, gap):
    """The WHOLE pattern as one file, gaps included.

    One aplay for the pattern rather than one per beep: the gaps come
    out of the sample clock instead of out of time.sleep() either side
    of a process launch, so three short beeps are three short beeps and
    not an approximation of them."""
    key = (kind, ms, n, gap)
    p = _snd['wav'].get(key)
    if p and os.path.exists(p):
        return p
    # 'quiet' is the arming file: the DAC opens, nothing is heard.
    beep = _quiet_frames(ms) if kind == 'quiet' else _frames(kind, ms)
    buf = array.array('h')
    for i in range(n):
        if i:
            buf.extend(_quiet_frames(gap))
        buf.extend(beep)
    if sys.byteorder == 'big':
        buf.byteswap()                  # WAV frames are little-endian
    path = os.path.join(_audio_dir(), '%s-%d-%d-%d.wav' % (kind, ms, n, gap))
    tmp = path + '.part'
    with contextlib.closing(wave.open(tmp, 'wb')) as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(AUDIO_RATE)
        w.writeframes(buf.tobytes())
    os.replace(tmp, path)               # so a half-written file is never played
    _snd['wav'][key] = path
    return path


def _audio_run(path, timeout, arm=False):
    """aplay, held by its handle rather than shelled and forgotten.

    The handle is the whole reason: an arming silence has to be cut
    short the instant a real signal wants the output, and on an
    exclusive ALSA device the second aplay would simply be refused."""
    try:
        p = subprocess.Popen(['aplay', '-q', '-D', AUDIO_DEV, path],
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    except OSError:
        return
    if arm:
        _snd['arm_proc'] = p
    try:
        p.wait(timeout)
    except subprocess.TimeoutExpired:
        p.kill()
    finally:
        if arm and _snd.get('arm_proc') is p:
            _snd['arm_proc'] = None


def _arm_stop():
    """Silence yields to sound. Waited for, not just killed: the beep
    behind it is about to open the same device."""
    p = _snd.get('arm_proc')
    if p is None:
        return
    try:
        if p.poll() is None:
            p.kill()
        p.wait(1)
    except Exception:
        pass
    _snd['arm_proc'] = None


def _arm_ms():
    """How much silence it takes to have the output awake.

    The bcm2835 jack wants a couple of hundred milliseconds. Anything
    reached through PipeWire, PulseAudio or bluealsa is a Bluetooth
    speaker as often as not, and an A2DP link that has gone idle takes
    the better part of a second to come back - during which the front of
    whatever is playing is simply not there. That is the truncated first
    beep, and it is a property of the link rather than of this program;
    the only thing to do about it is to open the stream sooner."""
    return 120 if AUDIO_DEV.startswith('plughw:') else 1200


def audio_arm():
    """Wake the DAC, without making a sound.

    The bcm2835 analogue output powers down when it is idle, and opening
    it again costs a couple of hundred milliseconds and a pop. Neither
    matters on a warning beep. Both matter on the opening signal of a
    sequence and on the gun - so the timer arms the output when the
    countdown starts and again as the last ten seconds open, and the
    five short beeps from there keep it awake to the gun.

    It never claims the sounder: a signal arriving mid-arm kills the
    silence and plays, because a beep dropped for the sake of a beep
    that made no sound would be a poor trade."""
    now = time.time()
    if _snd['busy'] or now - _snd['armed'] < 2.0:
        return {'ok': True, 'armed': False}
    _snd['armed'] = now
    ms = _arm_ms()
    threading.Thread(target=_audio_run,
                     args=(_audio_wav('quiet', ms, 1, 0), ms / 1000.0 + 3),
                     kwargs={'arm': True}, daemon=True).start()
    return {'ok': True, 'armed': True, 'ms': ms}


def audio_warm():
    """Render the three signals up front.

    Synthesising 700 ms of tone is tens of milliseconds of Python, and
    the first thing that would ever ask for it is a gun. Off the startup
    thread, where nobody is listening."""
    for kind, ms in (('warn', 90), ('warn', 260), ('gun', 700), ('quiet', 150)):
        try:
            _audio_wav(kind, ms, 1, 0)
        except Exception:
            return

# ---- the gpio path ----

BUZZER_CMD = os.environ.get('HELM_BUZZER_CMD', '')   # a test rig overrides this
# A bare MOSFET sounds on a HIGH gate, which is the default here. Some
# ready-made driver and relay boards invert, and one of those wired up
# unset would sit on from boot until the first beep ENDED it. One env
# var rather than a code change, because the place you find this out is
# a cockpit.
BUZZER_INVERT = os.environ.get('HELM_BUZZER_INVERT', '').strip().lower() \
                in ('1', 'true', 'yes', 'on')


def _buzzer_pin():
    """The configured pin, or None if the buzzer is switched off."""
    v = os.environ.get('HELM_BUZZER_GPIO', '17').strip().lower()
    if v in ('off', 'none', ''):
        return None
    try:
        n = int(v)
    except ValueError:
        return None
    return n if 0 <= n <= 27 else None


BUZZER_GPIO = _buzzer_pin()


def buzzer_tool():
    # pinctrl on Bookworm, raspi-gpio on Bullseye. The same words work on
    # both, and both ship with Raspberry Pi OS. Shelling out costs a few
    # ms either side of the pulse; against a 90 ms beep that is inaudible,
    # and it buys not holding a GPIO line open for the life of the process.
    if BUZZER_CMD:
        return BUZZER_CMD.split()
    for t in ('pinctrl', 'raspi-gpio'):
        if shutil.which(t):
            return [t]
    return None


def _buz_set(on):
    t = buzzer_tool()
    if not t or BUZZER_GPIO is None:
        return
    level = 'dh' if (bool(on) != BUZZER_INVERT) else 'dl'
    run(t + ['set', str(BUZZER_GPIO), 'op', level], 3)


def buzz_quiet():
    """Drive the pin to its silent state, once, at startup.

    Until something claims a GPIO it floats, and a floating gate on a
    sounder's MOSFET is a sounder that may be howling from boot until
    the first beep switches it off. A pull-down resistor on the gate is
    the real fix and belongs in the wiring; this is the belt to that
    brace, and it costs one subprocess at startup."""
    if SOUND['mode'] == 'gpio':
        _buz_set(False)


def _buz_run(ms, n, gap):
    """The pattern, off the HTTP thread. The finally is not tidiness: a
    pin left high is a buzzer that screams until someone pulls a wire,
    and this runs on a boat where that wire is behind the panel."""
    try:
        for i in range(n):
            if i:
                time.sleep(gap / 1000.0)
            _buz_set(True)
            time.sleep(ms / 1000.0)
            _buz_set(False)
    finally:
        _buz_set(False)


# ---- what the two of them share ----

def _resolve_mode():
    """Which path this Pi actually has, decided once.

    Asked on every /status otherwise, and each answer is two subprocess
    launches - on a poll that runs all day."""
    if SOUND_MODE == 'off':
        return {'mode': 'off', 'why': 'OFF'}
    if SOUND_MODE in ('auto', 'audio'):
        if _audio_player():
            return {'mode': 'audio', 'device': AUDIO_DEV, 'card': AUDIO_CARD}
        if SOUND_MODE == 'audio':
            return {'mode': 'off', 'why': 'NO APLAY'}
    if BUZZER_GPIO is None:
        return {'mode': 'off', 'why': 'OFF'}
    if not buzzer_tool():
        return {'mode': 'off', 'why': 'NO PINCTRL'}
    return {'mode': 'gpio', 'gpio': BUZZER_GPIO}


SOUND = _resolve_mode()


def buzzer_status():
    if SOUND['mode'] == 'off':
        return {'available': False, 'mode': 'off',
                'why': SOUND.get('why', 'OFF')}
    st = dict(SOUND, available=True)
    if st['mode'] == 'audio':
        st['device'] = AUDIO_DEV
        st['outs'] = audio_outs()
        st['pinned'] = bool(os.environ.get('HELM_AUDIO_DEV', '').strip())
    return st


def _sound_run(kind, ms, n, gap):
    try:
        if SOUND['mode'] == 'audio':
            _arm_stop()
            # A generous ceiling on a pattern that cannot last more than
            # about eight seconds: aplay should finish long before, and a
            # wedged one must not hold the sounder busy for the race.
            _audio_run(_audio_wav(kind, ms, n, gap),
                       (ms * n + gap * n) / 1000.0 + 5)
        else:
            _buz_run(ms, n, gap)
    finally:
        _snd['busy'] = False


def buzz(ms, n, gap, kind=None, arm=False):
    st = buzzer_status()
    if not st.get('available'):
        return dict(st, ok=False, error='NO BUZZER')
    if arm:
        return dict(audio_arm() if SOUND['mode'] == 'audio'
                    else {'ok': True, 'armed': False}, mode=SOUND['mode'])
    try:
        ms = int(90 if ms is None else ms)
        n = int(1 if n is None else n)
        gap = int(120 if gap is None else gap)
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'BAD PATTERN'}
    # Clamped, not rejected. The ceiling is the point: a caller that asks
    # for a ten-second blast has a bug, and the boat should not wear it.
    ms = max(10, min(2000, ms))
    n = max(1, min(6, n))
    gap = max(20, min(1000, gap))
    # The caller names the voice; length decides it for anyone who does
    # not, so a bare {"ms": 700} from a curl still sounds like a gun.
    if kind not in ('warn', 'gun'):
        kind = 'gun' if ms >= 500 else 'warn'
    with _snd['lock']:
        if _snd['busy']:
            return {'ok': False, 'error': 'BUSY'}
        _snd['busy'] = True
    threading.Thread(target=_sound_run, args=(kind, ms, n, gap),
                     daemon=True).start()
    return {'ok': True, 'ms': ms, 'n': n, 'kind': kind, 'mode': SOUND['mode']}


# ----------------------------------------------------------------- score
#
# The club scores on Vudu Wave, and this is the FALLBACK way to reach
# it, not the only one. The page posts to vuduwave.com itself: the
# server reflects whatever Origin it is asked from, so a browser's
# fetch goes straight through, and a phone with no helper behind it can
# submit exactly like the helm can. This was built on the opposite
# belief - that the server sent no CORS headers - and that belief was
# wrong, and cost the phone the feature until a preflight said so.
#
# What is left for this to do is the case the page cannot cover: a
# proxy in the way, a TLS failure, a browser that refuses for its own
# reasons. The page tries itself first and comes here when that throws.
#
# ONE race, ONE submission, and only ever because a hand on the glass
# said yes. The two limits below are not for this boat's benefit - it is
# somebody else's small server, and a bug in a loop here would be a bug
# in a loop pointed at them.
#
# No captcha token is sent. The entry form runs an invisible reCAPTCHA;
# this has no way to produce a token and no business faking one, so the
# request goes without and whatever the server answers comes back
# verbatim for the panel to show. Refused is refused - the helm then
# falls back to putting the number on the glass for you to type.

SCORE_URL = os.environ.get('HELM_SCORE_URL',
                           'https://vuduwave.com/api/add_scratch_time')
def _score_secs(name, dflt):
    """The limits, with a way for a test rig to shorten them. Nothing on
    the boat ever sets these: ten seconds between submissions is not a
    number anyone needs tuned, and shortening it on the water would only
    ever point more requests at somebody else's server."""
    try:
        return max(0.0, float(os.environ.get(name, '') or dflt))
    except ValueError:
        return dflt


SCORE_GAP = _score_secs('HELM_SCORE_GAP', 10.0)    # between any two
SCORE_SAME = _score_secs('HELM_SCORE_SAME', 300.0)  # before the SAME one again
_score = {'lock': threading.Lock(), 'at': 0.0, 'last': None, 'last_at': 0.0}

# The formats that form accepts, which are worth checking here rather
# than finding out from a round trip: hh.mm.ss, h.mm.ss, mm.ss, m.ss,
# or a retirement. Dot, colon or comma between.
SCORE_TIME = re.compile(r'^(?:[0-9]+[,:.][0-5][0-9][,:.][0-5][0-9]'
                        r'|[0-5]?[0-9][,:.][0-5][0-9]'
                        r'|[Dd][NnSs][FfSsQq])$')


def score_status():
    return {'available': bool(SCORE_URL), 'url': SCORE_URL}


def score_submit(racer_id, elapsed):
    st = score_status()
    if not st['available']:
        return {'ok': False, 'error': 'SCORING OFF'}
    try:
        rid = int(racer_id)
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'BAD RACER'}
    elapsed = str(elapsed or '').strip()
    if not SCORE_TIME.match(elapsed):
        return {'ok': False, 'error': 'BAD TIME'}

    now = time.time()
    with _score['lock']:
        if now - _score['at'] < SCORE_GAP:
            return {'ok': False, 'error': 'TOO SOON'}
        if (_score['last'] == (rid, elapsed)
                and now - _score['last_at'] < SCORE_SAME):
            # The form says an incorrect time can be resubmitted, so this
            # is a guard against a double tap and not against you.
            return {'ok': False, 'error': 'ALREADY SENT'}
        _score['at'] = now

    body = json.dumps({'elapsed_time': elapsed, 'racer_id': rid}).encode()
    req = urllib.request.Request(
        SCORE_URL, data=body, method='POST',
        headers={'Content-Type': 'application/json',
                 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            code, raw = r.status, r.read(8192).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read(8192).decode('utf-8', 'replace')
    except Exception as e:
        # No marina wifi, no DNS, no internet off the hotspot. Not a
        # failure worth dressing up: the fallback is a QR and a phone.
        return {'ok': False, 'error': str(e)[:80]}

    msg = ''
    try:
        msg = str((json.loads(raw) or {}).get('message', ''))
    except Exception:
        msg = raw[:120]
    ok = 200 <= code < 300
    if ok:
        with _score['lock']:
            _score['last'] = (rid, elapsed)
            _score['last_at'] = time.time()
    return {'ok': ok, 'status': code, 'message': msg[:160],
            'error': '' if ok else ('REFUSED ' + str(code))}


# ---------------------------------------------------------------- power
#
# Shutting down properly matters more on a boat than on a desk. Cutting
# power to a running Pi is the usual way an SD card dies, and the helm has
# no keyboard to do it the normal way - so until now the only clean
# shutdown was over SSH, from a phone, over the hotspot the Pi is running.
#
# poweroff and reboot go through logind, which polkit grants to a local
# ACTIVE session without a password - the same reason netd runs from the
# desktop session rather than a systemd unit. From SSH they come back
# "Interactive authentication required", which is reported rather than
# swallowed.

HAS_SYSTEMCTL = bool(shutil.which('systemctl'))


def find_dm():
    """Which display manager this image has, if any.

    Only meaningful in cage mode, where there is no desktop running and
    the panel is the only way to ask for one. Probed once: the answer
    cannot change without a reinstall."""
    if not HAS_SYSTEMCTL:
        return ''
    for dm in ('lightdm', 'gdm3', 'sddm'):
        rc, out, err = run(['systemctl', 'list-unit-files', dm + '.service'], 8)
        if rc == 0 and dm in out:
            return dm
    return ''


DM = find_dm()


def uptime_txt():
    """Straight from /proc - a subprocess for this would be silly, and it
    rides along on every /status."""
    try:
        # `with`, because this rides along on every /status: an unclosed
        # handle every few seconds is a slow leak on a box that stays up
        # for a season, and it is what made the probe output noisy.
        with open('/proc/uptime') as f:
            secs = float(f.read().split()[0])
    except Exception:
        return ''
    d, rest = divmod(int(secs), 86400)
    h, rest = divmod(rest, 3600)
    m = rest // 60
    if d:
        return '%dd %dh' % (d, h)
    if h:
        return '%dh %dm' % (h, m)
    return '%dm' % m


# ---------------------------------------------------- the round panel
#
# A square desktop on a round panel loses its four corners: the taskbar's
# ends, the clock, the close buttons. The fix is to shrink the whole
# output and centre it, so the desktop becomes the largest square that
# FITS INSIDE the circle with black around it.
#
# The largest square inside a circle of diameter D has side D/sqrt(2) -
# about 70.7%. On this 1080 panel that is 763px, and 159px of margin on
# every side.
#
# X11 only, and that is not a limitation to work around: wlr-randr has no
# transform at all, so on Wayland there is no live equivalent. The probe
# (boot/check-display.py) is what says which you have.
FIT_MIN, FIT_MAX = 40, 100
FIT_DEFAULT = 100.0 / math.sqrt(2.0)          # 70.71%, the inscribed square

# Which environment reaches the X server, once it is known. netd may have
# been started by cage-session.sh, which has no DISPLAY at all, so this
# is DISCOVERED rather than read from the environment - the same approach
# boot/check-display.py takes, and for the same reason.
_xenv = {'env': None, 'at': 0.0}


def _x_candidates():
    """Every plausible way in, most likely first."""
    if os.environ.get('DISPLAY'):
        yield {'DISPLAY': os.environ['DISPLAY']}
    homes = []
    try:
        homes = ['/home/' + u for u in os.listdir('/home')]
    except Exception:
        pass
    homes.append(os.path.expanduser('~'))
    for disp in (':0', ':1'):
        yield {'DISPLAY': disp}
        for h in homes:
            xa = os.path.join(h, '.Xauthority')
            if os.path.isfile(xa):
                yield {'DISPLAY': disp, 'XAUTHORITY': xa}


def x_env():
    """An env that can reach an X server, or None. Re-probed sparingly.

    A negative is cached too, and briefly: on a Wayland or cage Pi this
    would otherwise try every candidate on every /status poll, which is
    two subprocesses a second for an answer that is always no."""
    if time.time() - _xenv['at'] < 20:
        return _xenv['env']
    _xenv['at'] = time.time()
    _xenv['env'] = None
    for env in _x_candidates():
        rc, out, _ = run(['xrandr', '--query'], 8, env=env)
        if rc == 0 and 'connected' in out:
            _xenv['env'] = env
            break
    return _xenv['env']


_OUT_RE = re.compile(r'^(\S+) connected (?:primary )?(\d+)x(\d+)\+', re.M)
# The panel's REAL pixel size, from the current mode rather than from the
# geometry on the `connected` line. Those are the same number until a
# transform is applied and different afterwards: the geometry field then
# reports the CRTC's extent in framebuffer space, which for a shrink is
# larger than the panel. Reading it there meant a second apply computed
# from 1531 instead of 1080 - and a desktop scaled for a panel half again
# too big shows you its left-hand corners and hides the other two, which
# is exactly what it did.
_MODE_RE = re.compile(r'^\s+(\d+)x(\d+)\s+[\d.]+\*', re.M)
# The SCREEN - the framebuffer every window is laid out inside. It is a
# different number from the panel and from the mode, and it is the one
# that decides whether the desktop's right-hand side exists at all.
_SCREEN_RE = re.compile(r'^Screen \d+:.*?current\s+(\d+)\s*x\s*(\d+)', re.M)


def fit_status():
    """The output, its size, and whether it is currently shrunk."""
    env = x_env()
    if not env:
        return {'available': False}
    rc, out, _ = run(['xrandr', '--query'], 8, env=env)
    m = _OUT_RE.search(out or '')
    if rc != 0 or not m:
        return {'available': False}
    name = m.group(1)
    mm = _MODE_RE.search(out[m.end():] or '')
    if mm:
        w, h = int(mm.group(1)), int(mm.group(2))
    else:
        # No starred mode - fall back to the geometry, which is right
        # whenever nothing is transformed, and say nothing clever.
        w, h = int(m.group(2)), int(m.group(3))
    # The transform is read back rather than remembered. netd restarts -
    # autopull kills it on every push - and a remembered flag would come
    # back saying "full size" over a desktop that is still shrunk.
    rc, ver, _ = run(['xrandr', '--query', '--verbose'], 10, env=env)
    scale = 1.0
    mt = re.search(r'Transform:\s+([\d.eE+-]+)', ver or '')
    if rc == 0 and mt:
        try:
            scale = float(mt.group(1))
        except ValueError:
            scale = 1.0
    fitted = abs(scale - 1.0) > 0.001
    sm = _SCREEN_RE.search(out or '')
    sw, sh = (int(sm.group(1)), int(sm.group(2))) if sm else (0, 0)
    return {'available': True, 'output': name, 'w': w, 'h': h,
            # Reported so it can be SEEN rather than deduced from what is
            # missing off the edge of the glass.
            'screen': '%dx%d' % (sw, sh) if sw else '?',
            'oversize': bool(sw and (sw > w or sh > h)),
            'fitted': fitted,
            # Two mutually exclusive gates, the same shape the Desktop and
            # Kiosk tiles use: the sheet offers one way and never both.
            'can_fit': not fitted,
            'pct': round(100.0 / scale, 1) if fitted and scale else 100.0,
            'suggest': round(FIT_DEFAULT, 1)}


def _fit_cmd(name, w, h, pct):
    """The xrandr call, and the arithmetic behind it.

    The transform maps OUTPUT pixels to FRAMEBUFFER pixels, so shrinking
    the desktop means scaling UP: the output samples a region larger than
    itself, and the framebuffer lands in the middle of it. With side s and
    margin t = (w-s)/2, output t must sample framebuffer 0 and output w-t
    must sample framebuffer w, which gives a = w/s and c = -a*t.
    """
    side = int(min(w, h) * pct / 100.0)
    side -= side % 2                      # even, so the margins match
    side = max(2, side)
    ax, ay = w / float(side), h / float(side)
    cx, cy = -ax * ((w - side) / 2.0), -ay * ((h - side) / 2.0)
    matrix = '%f,0,%f,0,%f,%f,0,0,1' % (ax, cx, ay, cy)
    return side, ['xrandr', '--output', name, '--transform', matrix]


# ---- the touchscreen has to move with the picture ------------------
#
# xrandr --transform moves the OUTPUT. It does not move the INPUT: an
# absolute device still maps its own [0,1] square onto the whole
# framebuffer, so once the desktop is shrunk into the middle of the
# glass, every touch lands somewhere it is not. Offset AND scaled, which
# reads as "the pointer clicks in the wrong place".
#
# X11's fix is the device's Coordinate Transformation Matrix, and it has
# to be the same map the output got. A touch at panel pixel p should
# reach framebuffer f = a*(p - t), with a = w/side and t = (w-side)/2.
# The CTM works in NORMALISED coordinates, so X computes
# f = w*(m00*(p/w) + m02); equating the two gives m00 = a and
# m02 = -a*t/w, which simplifies to -(w-side)/(2*side).
_TOUCH_RE = re.compile(r'^\W*(.+?)\s+id=(\d+)\s+\[slave\s+pointer', re.M)


def touch_devices(env):
    """Absolute pointing devices only.

    Relative ones are excluded deliberately and this is not a detail: the
    same matrix on a mouse does not reposition it, it multiplies every
    movement - so a fitted desktop would come with a mouse that flies off
    the screen. `Mode: absolute` on a valuator is what separates them."""
    rc, out, _ = run(['xinput', 'list'], 8, env=env)
    if rc != 0:
        return []
    devs = []
    for name, did in _TOUCH_RE.findall(out or ''):
        rc2, d, _ = run(['xinput', 'list', did], 8, env=env)
        if rc2 == 0 and re.search(r'Mode:\s*absolute', d, re.I):
            devs.append((did, name.strip()))
    return devs


IDENTITY = ('1', '0', '0', '0', '1', '0', '0', '0', '1')


def touch_map(env, w, h, side):
    """Point the touchscreen at where the picture actually is.

    Returns (how many devices, a short note). Never raises: a panel that
    fits but cannot be touched is worse than one that does not fit, so
    the note travels back to the sheet rather than being swallowed."""
    if not shutil.which('xinput'):
        return 0, 'NO XINPUT'
    if side is None:
        m = IDENTITY
    else:
        ax, ay = w / float(side), h / float(side)
        m = ('%f' % ax, '0', '%f' % (-(w - side) / (2.0 * side)),
             '0', '%f' % ay, '%f' % (-(h - side) / (2.0 * side)),
             '0', '0', '1')
    devs = touch_devices(env)
    if not devs:
        return 0, 'NO TOUCH DEVICE'
    done = 0
    for did, name in devs:
        rc, out, err = run(['xinput', 'set-prop', did,
                            'Coordinate Transformation Matrix'] + list(m), 8, env=env)
        if rc == 0:
            done += 1
            print('[netd] touch: %s (id=%s) -> %s'
                  % (name, did, 'identity' if side is None else ' '.join(m[:3])),
                  flush=True)
        else:
            print('[netd] touch: %s (id=%s) REFUSED: %s'
                  % (name, did, (err or out)[:80]), flush=True)
    return done, '' if done else 'TOUCH REFUSED'


# The revert timer. This is the whole safety story: the panel cannot see
# what the panel looks like, so a transform that leaves the screen
# unreadable would be unfixable from the screen. It goes back on its own
# unless something confirms, which is how every monitor-test dialog since
# 1998 has worked and for the same reason.
FIT_GRACE = 25
_fit = {'timer': None}


def _fit_revert(name, env, w=0, h=0):
    # --fb goes back with the transform, and that is not belt and braces.
    # `--transform none` alone does NOT shrink the screen again: xrandr
    # grew it to cover the transformed extents and leaves it there. The
    # next apply then starts from a screen half again too big and lands
    # the desktop's right-hand side off the glass.
    argv = ['xrandr', '--output', name, '--transform', 'none']
    if w and h:
        argv += ['--fb', '%dx%d' % (w, h),
                 # off, not left pinned: panning that outlives the
                 # transform confines a full-size desktop for no reason.
                 '--panning', '0x0']
    rc, out, err = run(argv, 15, env=env)
    # The touchscreen goes back with it, always - including when the
    # xrandr call above failed. A half-reverted panel whose picture is
    # full size and whose touch is still offset is the worst of both.
    touch_map(env, 0, 0, None)
    print('[netd] display: reverted to full size (%s)'
          % ('ok' if rc == 0 else (err or out)), flush=True)


def _fit_disarm():
    t = _fit['timer']
    _fit['timer'] = None
    if t:
        t.cancel()


def fit_set(pct, arm=True):
    try:
        pct = float(pct)
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'BAD SIZE'}
    if not FIT_MIN <= pct <= FIT_MAX:
        return {'ok': False, 'error': 'BAD SIZE'}
    st = fit_status()
    if not st.get('available'):
        return {'ok': False, 'error': 'NO X DISPLAY'}
    env = x_env()
    name, w, h = st['output'], st['w'], st['h']
    _fit_disarm()
    if pct >= 100:
        _fit_revert(name, env, w, h)
        return dict(fit_status(), ok=True)
    side, cmd = _fit_cmd(name, w, h, pct)
    # --fb pins the desktop to the panel's own size, and it is not
    # optional. Without it xrandr grows the screen to cover the
    # transformed output's extents and the desktop gets BIGGER rather
    # than smaller - you see its top-left and bottom-left corners and the
    # other two are off the glass.
    #
    # There used to be a fallback that dropped --fb when it was refused.
    # That was worse than failing: it produced a picture that looks
    # deliberate and is wrong, with no way to tell from the panel which
    # of the two you were looking at. A refusal now reverts and says so.
    # --panning as well as --fb, and this is the part that decides whether
    # the DESKTOP fits or only the picture does.
    #
    # A transform that shrinks the picture makes the output sample a
    # framebuffer region LARGER than itself - 1080 * 1.417 = 1531 here -
    # and xrandr sizes the screen to cover that. The letterbox then looks
    # right while the desktop behind it is half again too wide, so its
    # right-hand edge, where a taskbar keeps the clock and the tray, is
    # off the glass. --panning pins the CRTC's area to the panel instead
    # of letting the transform dictate it.
    box = '%dx%d' % (w, h)
    rc, out, err = run(cmd + ['--fb', box, '--panning', box + '+0+0'], 20, env=env)
    how = 'fb+panning'
    if rc != 0:
        # Without the panning constraint, in case this xrandr will not
        # take it. The screen is read back either way, so an oversized
        # desktop is REPORTED rather than left to be discovered by
        # something going missing off the right-hand side.
        rc, out, err = run(cmd + ['--fb', box], 20, env=env)
        how = 'fb'
    if rc != 0:
        _fit_revert(name, env, w, h)
        return {'ok': False,
                'error': ('SCREEN REFUSED: ' + (err or out or ''))[:120]}
    touched, note = touch_map(env, w, h, side)
    after = fit_status()
    print('[netd] display: %dx%d of %dx%d (%.1f%%, %s), screen %s, touch: %s'
          % (side, side, w, h, pct, how, after.get('screen', '?'),
             note or ('%d device(s)' % touched)), flush=True)
    if after.get('oversize'):
        print('[netd] display: the screen is BIGGER than the panel, so the '
              'desktop runs off the right-hand side. xrandr would not take '
              'the panning constraint on this version.', flush=True)
    # Whatever the screen ended up as, the desktop's panel was laid out
    # for the size it had a moment ago. lxpanel spans the screen width and
    # does not re-read it, so its right-hand end - the clock and the tray -
    # stays wherever the old width put it. Asking it to restart is cheap
    # and is the difference between a fitted desktop and a fitted desktop
    # you can read the clock on.
    relayout(env)
    # No timer on the automatic path. A revert there would undo the very
    # thing tapping Desktop asked for, 25 seconds after it arrived.
    if arm:
        t = threading.Timer(FIT_GRACE, _fit_revert, args=(name, env, w, h))
        t.daemon = True
        _fit['timer'] = t
        t.start()
    return dict(after, ok=True, side=side, how=how,
                grace=FIT_GRACE if arm else 0,
                touched=touched, touchnote=note)


def relayout(env):
    """Nudge the desktop's own panel to re-read the screen size.

    Only things that are known to be safe to restart and that come back
    on their own. Never raises, never waits long."""
    if shutil.which('lxpanelctl'):
        rc, out, err = run(['lxpanelctl', 'restart'], 8, env=env)
        print('[netd] display: lxpanel restart %s'
              % ('ok' if rc == 0 else (err or out)[:60]), flush=True)
        return 'lxpanel'
    return ''


def fit_auto():
    """Fit the corners as soon as there is an X server to fit them on.

    Tapping Desktop is a request for a usable desktop on a round panel,
    and a square desktop on a round panel has no corners - so this is part
    of what Desktop MEANS rather than a second thing to remember. It runs
    on a thread because the display manager is still starting when the
    tile's request returns, and X takes several seconds to answer.

    No revert is armed. A revert here would undo what was just asked for.
    If it ever goes wrong the way back is a reboot, which brings cage up
    with a fresh X server, or over SSH:
        xrandr --output HDMI-1 --transform none --fb 1080x1080
    """
    def go():
        for _ in range(40):                       # ~40s, X is slow to arrive
            time.sleep(1.0)
            _xenv['at'] = 0.0                     # the display is new; re-probe
            if not x_env():
                continue
            st = fit_status()
            if not st.get('available'):
                continue
            if st.get('fitted'):
                print('[netd] display: already fitted, leaving it', flush=True)
                return
            r = fit_set(FIT_DEFAULT, arm=False)
            if r.get('ok'):
                return
            print('[netd] display: auto-fit failed: %s'
                  % r.get('error', '?'), flush=True)
            return
        print('[netd] display: no X server appeared, nothing to fit', flush=True)
    t = threading.Thread(target=go)
    t.daemon = True
    t.start()


def fit_keep():
    """Cancel the revert. Only meaningful while one is armed."""
    armed = _fit['timer'] is not None
    _fit_disarm()
    return dict(fit_status(), ok=True, kept=armed)


TO_DESKTOP = '/usr/local/sbin/confluence-to-desktop'
TO_CAGE = '/usr/local/sbin/confluence-to-cage'


def power_status():
    # 'desktop' is offered only when there is a display manager to start
    # AND nothing graphical is already running - on a normal desktop
    # session the tile would be a no-op that switches you to the login
    # screen, which is not what anyone means by it.
    #
    # 'cage' is its exact mirror: offered only when a desktop IS running
    # and there is a helper installed to leave it with. The two are
    # mutually exclusive by construction, so the power sheet always shows
    # one way out of wherever you are and never both.
    running = desktop_running()
    return {'available': HAS_SYSTEMCTL, 'uptime': uptime_txt(),
            'desktop': bool(DM) and not running,
            'cage': running and os.path.isfile(TO_CAGE)}


def desktop_running():
    if not DM:
        return False
    rc, out, err = run(['systemctl', 'is-active', DM + '.service'], 8)
    return out.strip() == 'active'


def _via_sudo(helper):
    """Run one of the two root helpers and turn its failure into words.

    -n so a missing sudoers rule fails at once instead of hanging on a
    password prompt nobody can answer at the helm."""
    rc, out, err = run(['sudo', '-n', helper], 30)
    if rc == 0:
        return {'ok': True}
    e = (err or out).lower()
    if ('password' in e or 'no tty' in e or 'not allowed' in e
            or 'not permitted' in e or 'sorry' in e):
        return {'ok': False, 'error': 'NOT PERMITTED FROM HERE'}
    return {'ok': False, 'error': (err or out or 'FAILED')[:120]}


def power_do(action):
    if action == 'display':
        return later(display_restart)
    if action == 'desktop':
        # Not `systemctl start <dm>` directly: the kiosk has to stop
        # first, or the display manager and cage both want the seat and
        # you get a display server with no session on it - a black
        # screen with a pointer and no panel. confluence-to-desktop does
        # that in the right order, and is root-owned outside $HOME so
        # the NOPASSWD grant is not a way to become root by editing it.
        #
        # -n so a missing sudoers rule fails at once instead of hanging
        # on a prompt nobody can answer at the helm.
        if not DM:
            return {'ok': False, 'error': 'NO DISPLAY MANAGER'}
        r = _via_sudo(TO_DESKTOP)
        if r.get('ok'):
            fit_auto()
        return r
    if action == 'cage':
        # Synchronous, like its opposite number and for the same reason:
        # the helper checks that cage, the tty1 autologin and the login
        # hook are all present BEFORE it stops anything, so a setup or
        # permission failure comes back fast with the page still alive to
        # show it. Only success takes the screen away, and by then the
        # answer has nowhere to go anyway.
        if not os.path.isfile(TO_CAGE):
            return {'ok': False, 'error': 'NO KIOSK HELPER'}
        # Put the screen back before the X server that holds it is
        # stopped. Not because cage would inherit anything - it is a
        # different compositor and starts clean - but because an armed
        # revert timer would otherwise fire into a dead display a few
        # seconds later and log a failure that means nothing.
        _fit_disarm()
        st = fit_status()
        if st.get('fitted'):
            _fit_revert(st['output'], x_env(), st['w'], st['h'])
        return _via_sudo(TO_CAGE)
    if action == 'helper':
        # netd.sh's loop brings it straight back with whatever is on disk.
        # Deferred, because this one kills the process answering.
        return later(lambda: run(['pkill', '-f', r'^python3 .*netd\.py'], 10))
    if action not in ('poweroff', 'reboot'):
        return {'ok': False, 'error': 'UNKNOWN ACTION'}
    if not HAS_SYSTEMCTL:
        return {'ok': False, 'error': 'NO SYSTEMCTL'}
    # Inline rather than deferred, unlike everything else here that kills
    # the browser. systemctl returns as soon as logind has accepted the
    # job, and running it inline is the only way a refusal can be reported
    # at all - a deferred one would look identical to success.
    rc, out, err = run(['systemctl', action], 12)
    if rc == 0:
        return {'ok': True}
    e = (err or out).lower()
    if 'interactive authentication' in e or 'not authorized' in e or 'access denied' in e:
        return {'ok': False, 'error': 'NOT PERMITTED FROM HERE'}
    return {'ok': False, 'error': (err or out or 'FAILED')[:120]}


# ------------------------------------------------------------------ gpx
#
# Getting a track off this boat used to mean the kiosk downloading a file
# into ~/Downloads on the Pi, where nothing can reach it. The race library
# itself is browser storage, which is per origin and per device - so a
# phone loading the same page gets its own empty library and none of the
# races that were actually sailed.
#
# So the panel hands the XML here and this writes it into the folder AvNav
# already serves. From then on any phone on the boat WiFi can fetch it at
#   http://<pi>:8080/user/helm/gpx/<name>.gpx
# which on iOS lands in Files, and from there the share sheet reaches
# SailTies, HealthFit and anything else that takes a GPX.
#
# index.json sits beside the files so the app can list them without
# needing a directory listing - and without needing to reach this service,
# which a phone cannot: it is loopback-only. The phone reads the index
# from AvNav, same origin as the app itself.

GPX_DIR = os.path.expanduser('~/avnav/data/user/helm/gpx')
GPX_SAFE = re.compile(r'[^A-Za-z0-9._-]')
GPX_MAX = 8 * 1024 * 1024


def gpx_dir():
    try:
        os.makedirs(GPX_DIR, exist_ok=True)
        return GPX_DIR
    except OSError:
        return None                       # no AvNav, or no room


def gpx_list():
    d = gpx_dir()
    out = []
    if not d:
        return out
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for n in names:
        if not n.endswith('.gpx'):
            continue                      # index.json is not a track
        try:
            st = os.stat(os.path.join(d, n))
        except OSError:
            continue
        out.append({'name': n, 'size': st.st_size, 'at': int(st.st_mtime)})
    out.sort(key=lambda f: -f['at'])       # newest first, like the library
    return out


def gpx_write_index():
    d = gpx_dir()
    if not d:
        return
    try:
        with open(os.path.join(d, 'index.json'), 'w') as f:
            json.dump(gpx_list(), f)
    except OSError:
        pass


def gpx_save(name, xml):
    d = gpx_dir()
    if not d:
        return {'ok': False, 'error': 'NO GPX FOLDER'}
    if not xml or len(xml) > GPX_MAX:
        return {'ok': False, 'error': 'EMPTY OR TOO BIG'}
    # The name comes from a race title someone typed at the helm; it ends
    # up as a path, so it is rebuilt from safe characters rather than
    # trusted. No slashes survive this, so it cannot leave the folder.
    name = GPX_SAFE.sub('-', (name or 'track').strip())[:64].lstrip('.-') or 'track'
    if not name.endswith('.gpx'):
        name += '.gpx'
    try:
        with open(os.path.join(d, name), 'w') as f:
            f.write(xml)
    except OSError as e:
        return {'ok': False, 'error': str(e)[:80]}
    gpx_write_index()
    return {'ok': True, 'name': name, 'url': 'gpx/' + name}


def gpx_delete(name):
    """Remove one track from the folder AvNav serves.

    The listing IS the authority here. A name has to be exactly one of
    the files this folder reports, and gpx_list only ever reports
    basenames ending .gpx that it found in the folder itself - so a
    traversal is not refused by cleaning it up, it is refused by not
    being there.

    gpx_save sanitises instead, and it has to: it is inventing a
    filename from a race title someone typed. Doing the same here would
    be wrong in both directions. It cannot make an unsafe name safe that
    membership would not already refuse, and it mangles the legitimate
    ones - a file called "Race one.gpx", which is what you get if
    anybody ever drops a track into the folder by hand, would become
    "Race-one.gpx" and could never be deleted at all."""
    d = gpx_dir()
    if not d:
        return {'ok': False, 'error': 'NO GPX FOLDER'}
    name = (name or '').strip()
    if not name or name != os.path.basename(name) or not name.endswith('.gpx'):
        return {'ok': False, 'error': 'NOT A GPX'}
    if name not in [f['name'] for f in gpx_list()]:
        return {'ok': False, 'error': 'NO SUCH TRACK'}
    try:
        os.remove(os.path.join(d, name))
    except OSError as e:
        return {'ok': False, 'error': str(e)[:80]}
    gpx_write_index()
    return {'ok': True, 'name': name}


def gpx_status():
    return {'available': gpx_dir() is not None, 'count': len(gpx_list())}


# --------------------------------------------------------------- http

def spotify_status():
    """Whether the panel should offer a like button at all.

    Only that the credentials exist - netd deliberately knows nothing
    else about Spotify. It does not hold the token and never talks to
    the API: spotify-now.py owns both, because Spotify can hand back a
    rotated refresh token and two processes refreshing independently
    would eventually leave one of them holding a dead one."""
    return {'available': os.path.isfile(SPOTIFY_CFG)}


def spotify_like(track_id, want):
    """Hand the request to the poller and return at once.

    Writing a file rather than making the call is the whole design - see
    spotify_status. The poller watches for this between polls, so it is
    picked up within half a second, and the panel fills its heart
    optimistically rather than waiting for either of us."""
    track_id = str(track_id or '').strip()
    # Spotify IDs are base62, 22 characters. Anything else is not going
    # into a file another process will act on.
    if not track_id or len(track_id) > 40 or not track_id.isalnum():
        return {'ok': False, 'error': 'BAD TRACK ID'}
    if not os.path.isfile(SPOTIFY_CFG):
        return {'ok': False, 'error': 'NO SPOTIFY CREDENTIALS'}
    r = _spotify_write({'id': track_id, 'want': bool(want)})
    return dict(r, want=bool(want)) if r.get('ok') else r


def _spotify_write(cmd):
    """One command file, written atomically so the poller never reads a
    half-written one. Last press wins: two taps inside the poller's
    half-second pickup collapse to one, which for a skip is the right
    answer anyway."""
    try:
        d = os.path.dirname(SPOTIFY_CMD) or '/tmp'
        fd, tmp = tempfile.mkstemp(dir=d, prefix='.spot-cmd-')
        with os.fdopen(fd, 'w') as f:
            json.dump(cmd, f)
        os.replace(tmp, SPOTIFY_CMD)
        return {'ok': True}
    except Exception as e:
        return {'ok': False, 'error': str(e)[:120]}


SPOTIFY_OPS = ('next', 'prev', 'play', 'pause')


def spotify_control(op):
    """Transport, handed to the poller the same way a like is - netd does
    not hold the token and must not start. See spotify_status."""
    op = str(op or '').strip()
    if op not in SPOTIFY_OPS:
        return {'ok': False, 'error': 'BAD OP'}
    if not os.path.isfile(SPOTIFY_CFG):
        return {'ok': False, 'error': 'NO SPOTIFY CREDENTIALS'}
    return _spotify_write({'op': op})


def spotify_volume(pct):
    """Volume, by the same route as everything else Spotify: netd writes
    a request, the poller performs it. Validated here rather than trusted
    - this arrives over HTTP, and 0-100 is the whole of what Spotify will
    accept."""
    try:
        n = int(pct)
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'BAD VOLUME'}
    if not 0 <= n <= 100:
        return {'ok': False, 'error': 'BAD VOLUME'}
    if not os.path.isfile(SPOTIFY_CFG):
        return {'ok': False, 'error': 'NO SPOTIFY CREDENTIALS'}
    return _spotify_write({'op': 'volume', 'pct': n})


def route(path, body):
    if path == '/status':
        return {'ok': True, 'wifi': wifi_status(), 'bt': bt_status(),
                'display': display_status(), 'power': power_status(),
                'backlight': backlight_status(), 'buzzer': buzzer_status(),
                'score': score_status(), 'gpx': gpx_status(),
                'spotify': spotify_status(), 'fit': fit_status()}

    # The remote's three, all LOOPBACK: they arrive on the panel's own
    # socket, from the panel's own browser. Nothing on the phone's
    # socket can reach route() at all - see RemoteHandler.
    if path == '/remote/status':
        return remote_status()
    if path == '/remote/register':
        return remote_register(body)
    # No tile arms this and none disarms it - the point is an app on a
    # phone that just works. Kept as an escape hatch over ssh, for the
    # day something is wrong and the door should be shut without
    # stopping netd and the panel's radios with it.
    if path == '/remote/disarm':
        return remote_disarm()
    if path == '/remote/poll':
        return remote_poll(body)

    if path == '/spotify/like':
        return spotify_like(body.get('id'), body.get('want'))
    if path == '/spotify/control':
        return spotify_control(body.get('op'))
    if path == '/spotify/volume':
        return spotify_volume(body.get('pct'))

    if path == '/display/status':
        return dict(display_status(), ok=True)
    if path == '/display/fit':
        if body.get('keep'):
            return fit_keep()
        return fit_set(body.get('pct', FIT_DEFAULT))
    if path == '/display/mode':
        if not CHROME:
            return {'ok': False, 'error': 'NO BROWSER'}
        return later(go_kiosk if body.get('mode') == 'kiosk' else go_windowed)
    if path == '/gpx/list':
        return {'ok': True, 'files': gpx_list()}
    if path == '/gpx/delete':
        return gpx_delete((body or {}).get('name'))
    if path == '/gpx/save':
        return gpx_save(str(body.get('name', '')), str(body.get('xml', '')))
    if path == '/score':
        return score_submit(body.get('racer_id'), body.get('elapsed_time'))
    if path == '/buzz/out':
        if SOUND['mode'] != 'audio':
            return {'ok': False, 'error': 'NO AUDIO OUT'}
        return audio_out_set(body.get('dev'))
    if path == '/buzz':
        return buzz(body.get('ms'), body.get('n'), body.get('gap'),
                    body.get('kind'), body.get('arm'))
    if path == '/backlight':
        if 'pct' in body:
            return dict(backlight_set(body['pct']), **backlight_status())
        return dict(backlight_status(), ok=True)
    if path == '/power/do':
        return power_do(str(body.get('action', '')))
    if path == '/display/restart':
        if not CHROME:
            return {'ok': False, 'error': 'NO BROWSER'}
        return later(display_restart)

    # Every wifi route is per-adapter. An absent dev means "the only one
    # you have", which is what a single-radio Pi will always send.
    if path == '/wifi/list':
        return dict(wifi_list(str(body.get('dev', '')), bool(body.get('rescan'))), ok=True)
    if path == '/wifi/power':
        return wifi_power(str(body.get('dev', '')), bool(body.get('on')))
    if path == '/wifi/connect':
        ssid = str(body.get('ssid', ''))[:64]
        psk = str(body.get('psk', ''))[:96]
        if not ssid:
            return {'ok': False, 'error': 'NO SSID'}
        return wifi_connect(str(body.get('dev', '')), ssid, psk)
    if path == '/wifi/disconnect':
        return wifi_power(str(body.get('dev', '')), False)
    if path == '/wifi/forget':
        with _lock:
            u = wifi_uuid(str(body.get('ssid', ''))[:64])
            if not u:
                return {'ok': False, 'error': 'NOT SAVED'}
            rc, _, err = run(['nmcli', 'connection', 'delete', 'uuid', u], 20)
        return {'ok': rc == 0, 'error': wifi_error(err)}

    if path == '/bt/list':
        return dict(bt_devices(), ok=True)
    if path == '/bt/power':
        with _lock:
            rc, _, err = bt_call(['power', 'on' if body.get('on') else 'off'], 15)
        _scan['until'] = 0
        return {'ok': rc == 0, 'error': err[:120]}
    if path == '/bt/scan':
        return bt_scan()
    if path == '/bt/connect':
        mac = str(body.get('mac', ''))
        return bt_connect(mac) if MAC.match(mac) else {'ok': False, 'error': 'BAD ADDRESS'}
    if path == '/bt/disconnect':
        with _lock:
            rc, _, _ = bt_call(['disconnect', str(body.get('mac', ''))], 20)
        return {'ok': rc == 0}
    if path == '/bt/forget':
        mac = str(body.get('mac', ''))
        with _lock:
            bt_call(['disconnect', mac], 15)
            rc, _, _ = bt_call(['remove', mac], 15)
        return {'ok': rc == 0}
    return None


# ---------------------------------------------------------------- remote
#
# The phone remote. A settings remote and not a second instrument: it
# changes WHICH reading sits in which slot, and the theme, and nothing
# else. No boat data crosses - the payload is slot names and reading
# keys both ways, so the phone never learns the depth.
#
# ---- what is exposed, and what is not --------------------------------
#
# Not netd. The repo already wrote down why, in docs/network.md: "There
# is no auth in the service because the socket makes it unnecessary; if
# you ever bind it wider, that stops being true." Flipping
# HELM_NETD_BIND would publish all 27 routes at once.
#
# So the remote gets its own socket and its own handler class, and that
# class has NO call path to route(). Not an allowlist inside one
# dispatcher - a different dispatcher. The property is then structural
# rather than maintained: a route added to route() next year cannot
# become remotely reachable, because nothing on that socket can reach
# route() to begin with.
#
# ---- which interface, and why not an address check -------------------
#
# Pinned to the dongle by SO_BINDTODEVICE, not by IP.
#
# An address check does not do what it looks like it does. The Pi is
# SeaWire's access point and its default gateway, so a guest on SeaWire
# who dials wlan1's address has the packet ARRIVE on wlan0 and be
# accepted for a locally-configured address - and a check on
# client_address, or on getsockname, passes it. Binding wlan1's address
# directly has its own problem: it fails with EADDRNOTAVAIL before DHCP
# and goes stale the next time the phone hands out a different lease.
#
# SO_BINDTODEVICE filters on the device the packet ARRIVED on, which is
# the property actually wanted, and the bind stays on 0.0.0.0 so a new
# lease changes nothing.
#
# It needed CAP_NET_RAW before Linux 5.9 and does not since. netd runs
# as the desktop user, so if that relaxation is not present here the
# setsockopt raises and we fall back to a per-request subnet check -
# which is a guarantee made by this code rather than by the kernel, and
# remote_how() says which one is in force so nobody has to guess.
#
# ---- always on, because a saved app is the point --------------------
#
# This is meant to live on the owner's home screen and just work, so
# there is nothing to arm and no tile on the glass to arm it from. The
# socket comes up with netd and stays up, and the TOKEN PERSISTS -
# minted once, kept in a file, and carried in the URL that gets saved.
# A fresh token per session would break the saved app every reboot,
# which is the opposite of what was asked for.
#
# What that costs, said plainly: the door is open whenever netd is
# running and the dongle has an address. Anyone on the same hotspot who
# knows the token can change which reading sits in which slot, and the
# theme. Nothing else - not the radios, not power, not the marks. The
# hotspot is the owner's own phone, so "anyone" is whoever he has let
# onto it.
REMOTE_DEV = os.environ.get('HELM_REMOTE_DEV', 'wlan1')
REMOTE_PORT = int(os.environ.get('HELM_REMOTE_PORT', PORT + 2))
REMOTE_CFG = os.environ.get('HELM_REMOTE_CFG') or os.path.expanduser(
    '~/.config/confluence-remote.json')
# The home screen icon, as a file rather than a base64 blob in the
# middle of a stdlib service: it is a picture, you should be able to
# look at it. Missing is survivable - the manifest simply has no
# icons and the phone falls back to a screenshot of the page.
REMOTE_ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'boot', 'remote-icon.png')
# Commands older than this are dropped rather than applied. A panel that
# was asleep, or reloading, should not come back and replay a tap from
# ten minutes ago.
REMOTE_STALE = 30

_remote = {'armed': False, 'token': '', 'how': '', 'srv': None, 'cidr': '',
           'pend': {}, 'at': 0.0,
           # What the PANEL says its slots and readings are, handed over
           # when it arms. netd validates against this rather than
           # carrying its own copy of the catalogue - the readings live
           # in the HTML and a second list here would drift the first
           # time one was added.
           'slots': {}, 'readings': [], 'themes': [],
           'pages': {}, 'names': {}, 'tags': {}, 'sens': {}, 'geom': {}}
_rlock = threading.Lock()


def remote_how():
    """Which guarantee is in force: the kernel's, or this file's."""
    return _remote['how']


def remote_token():
    """Minted once and kept, because the app on the phone saves a URL.

    Not a secret worth much - it rides in a query string on an
    unencrypted link - and it is not pretending to be. It is the
    difference between someone on this hotspot being able to drive the
    panel by guessing a path and having to be told a token, which on a
    boat is the whole threat model."""
    t = _remote.get('token')
    if t:
        return t
    try:
        with open(REMOTE_CFG) as f:
            t = (json.load(f) or {}).get('token') or ''
    except Exception:
        t = ''
    if not t:
        t = secrets.token_urlsafe(9)
        try:
            os.makedirs(os.path.dirname(REMOTE_CFG), exist_ok=True)
            # 0600: it is in a URL anyway, but a token in a world-readable
            # file in a home directory is a different kind of careless.
            fd = os.open(REMOTE_CFG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump({'token': t}, f)
        except Exception:
            pass                      # a read-only home still gets a session
    _remote['token'] = t
    return t


def _dev_subnet(dev):
    """The dongle's address and prefix, for the fallback path only."""
    rc, out, _ = run(['nmcli', '-t', '-f', 'IP4.ADDRESS', 'device', 'show', dev], 8)
    for line in out.splitlines():
        v = line.split(':', 1)[-1].strip()
        if '/' in v:
            return v
    return ''


def _same_subnet(ip, cidr):
    """Is ip inside cidr, without importing ipaddress for one call."""
    try:
        net, bits = cidr.split('/')
        bits = int(bits)
        to_i = lambda a: int.from_bytes(bytes(int(x) for x in a.split('.')), 'big')
        mask = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF
        return (to_i(ip) & mask) == (to_i(net) & mask)
    except Exception:
        return False


def remote_socket():
    """A listening socket on the dongle, by the strongest means available."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    how = 'subnet'
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE,
                     REMOTE_DEV.encode())
        how = 'device'
    except OSError:
        pass                      # pre-5.9, or no permission: see the fallback
    s.bind(('0.0.0.0', REMOTE_PORT))
    s.listen(8)
    return s, how


def remote_status():
    r = _remote
    return {'ok': True, 'armed': r['armed'], 'how': r['how'],
            'url': r.get('url', ''), 'token': r['token'],
            'dev': REMOTE_DEV, 'port': REMOTE_PORT}


def _geom(v, d=0):
    """The face's geometry, which is numbers and nothing else.

    It RAISES rather than filtering, for the reason remote_register
    already gives about the catalogue: a panel that sends the wrong
    shape should be told so, not quietly half-served. A box that was
    silently dropped is a phone drawing a mirror with a hole in it and
    nothing anywhere saying why.

    The bool test is first and is not decoration. True is an int in
    Python, so [True, 0, 1, 1] passes every numeric test there is and
    arrives as a one-by-one touch target at the origin - a slot you
    cannot tap, on a face that looks almost right."""
    if isinstance(v, bool):
        raise ValueError('BAD GEOM')
    if isinstance(v, (int, float)):
        return v
    if d >= 4:                     # geom.dial.box.c0[0] is the deepest leaf
        raise ValueError('BAD GEOM')
    if isinstance(v, list):
        return [_geom(x, d + 1) for x in v]
    if isinstance(v, dict):
        return {str(k): _geom(x, d + 1) for k, x in v.items()}
    raise ValueError('BAD GEOM')


def _power_sheet(v):
    """The panel's own POWER_ACTIONS, kept only as the fields the phone
    draws with. Validated rather than filtered: a sheet that arrived
    half-formed would show a button whose words say one thing and whose
    action does another, and two of these shut the boat down."""
    out = []
    if not isinstance(v, list):
        return out
    for a in v[:12]:
        if not isinstance(a, dict):
            continue
        act, name = a.get('a'), a.get('name')
        if not isinstance(act, str) or not isinstance(name, str):
            continue
        if not act or len(act) > 24 or not act.isalpha():
            continue
        out.append({'a': act, 'name': name[:40],
                    'short': str(a.get('short') or name)[:16],
                    'verb': str(a.get('verb') or name)[:40],
                    'danger': 1 if a.get('danger') else 0,
                    'need': str(a.get('need') or '')[:40]})
    return out


_pw_at, _pw_st = 0.0, None


def _remote_power_status():
    """power_status(), but not once every four seconds.

    The phone re-polls /r/state every 4 s while the start clock is
    running, and power_status() shells out to `systemctl is-active` -
    which would be a subprocess every four seconds on a Pi 4, during a
    start sequence, for an answer that changes when somebody leaves the
    kiosk and at no other time. Twenty seconds is far inside the time it
    takes to notice a Desktop tile that should have appeared, and well
    outside the poll.

    It also makes the sheet you were SHOWN the sheet that is honoured
    when your finger lands: remote_power checks the action against this
    same read, so without it a Desktop row drawn a second ago could be
    refused as NO SUCH ACTION because the kiosk state moved in between.
    A control found that, by taking the cache out."""
    global _pw_at, _pw_st
    now = time.monotonic()
    if _pw_st is None or now - _pw_at > 20:
        _pw_st, _pw_at = power_status(), now
    return _pw_st


def _remote_power_bust():
    """Forget it. Going to the desktop or back to the kiosk is the one
    thing that changes the answer, and it is a thing this file has just
    done - so the sheet is right on the next fetch rather than up to
    twenty seconds later, which is long enough to press the tile again
    because nothing appeared to happen."""
    global _pw_st
    _pw_st = None


def _settings(v):
    """The panel's settings catalogue, kept as the fields the phone draws
    with and the fields a value is checked against.

    Validated rather than filtered for the same reason the power sheet
    is: a half-formed entry is a row whose words say one thing and whose
    value does another. A `range` with no bounds and a `cycle` with no
    options are both dropped, because either would mean accepting
    anything."""
    out = []
    if not isinstance(v, list):
        return out
    for a in v[:40]:
        if not isinstance(a, dict):
            continue
        k, kind = a.get('k'), a.get('kind')
        if not isinstance(k, str) or not k or len(k) > 24:
            continue
        if kind not in ('range', 'cycle', 'toggle', 'action'):
            continue
        e = {'k': k, 'kind': kind, 'g': str(a.get('g') or '')[:40],
             'name': str(a.get('name') or k)[:48],
             'unit': str(a.get('unit') or '')[:8],
             # "my unit is the value of that other setting" - the depth
             # alarm's is FT or M depending on the units row above it.
             'unitOf': str(a.get('unitOf') or '')[:24],
             # Whether the glass draws it as a tile rather than a row,
             # and whether it draws its own picture of it above.
             'tile': 1 if a.get('tile') else 0,
             'bar': 1 if a.get('bar') else 0}
        if kind == 'range':
            lo, hi, st = a.get('min'), a.get('max'), a.get('step')
            if not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                       for x in (lo, hi)):
                continue
            if not lo < hi:
                continue
            e['min'], e['max'] = lo, hi
            e['step'] = st if isinstance(st, (int, float)) and st > 0 else 1
        elif kind == 'cycle':
            o = a.get('opts')
            if not isinstance(o, list) or not o or len(o) > 24:
                continue
            if not all(isinstance(x, (str, int, float))
                       and not isinstance(x, bool) for x in o):
                continue
            e['opts'] = list(o)
            lb = a.get('labels')
            e['labels'] = ([str(x)[:24] for x in lb]
                           if isinstance(lb, list) and len(lb) == len(o)
                           else None)
        out.append(e)
    return out


def remote_available_power():
    """The sheet, minus what this Pi cannot do right now.

    `need` is the panel's own dotted path into /status, and every one of
    them is under power, so it resolves here against power_status()
    alone - the same filter the glass applies, made by the half that
    knows the answer. The phone asks nothing: it is handed the list it
    should draw."""
    st = _remote_power_status()
    out = []
    for a in (_remote.get('power') or []):
        need = a.get('need') or ''
        if need:
            part = need.split('.')
            if len(part) != 2 or part[0] != 'power' or not st.get(part[1]):
                continue
        out.append(a)
    return out


def remote_radios():
    """What the radios ARE, and nothing you can do to them.

    The second stated exception to "no live data crosses", after the
    start clock, and a narrower one: it is read-only. There is no
    switch, no scan and no join on this path - the picker stays on the
    glass, because its content is the readings and because a scan is
    ten seconds of the hotspot stuttering for every device on it,
    the asking phone included.

    Fetched when the settings sheet opens and at no other time. The
    panel itself only asks while its control-panel drawer is open, for
    the reason its own comment gives - a panel that spends its life on
    the dial has no business asking about radios all day, and each ask
    is a handful of subprocesses. The phone makes the same deal.

    Cached for four seconds on top of that, so opening the sheet twice
    in a row, or two phones opening it at once, is one ask."""
    w = wifi_status()
    out = []
    for d in (w.get('devices') or []):
        out.append({'dev': str(d.get('dev') or ''),
                    'bus': str(d.get('bus') or ''),
                    'up': bool(d.get('up')),
                    'conn': bool(d.get('conn')),
                    'ap': bool(d.get('ap')),
                    'ssid': str(d.get('ssid') or ''),
                    'signal': int(d.get('signal') or 0)})
    b = bt_status()
    return {'wifi': {'available': bool(w.get('available')), 'devices': out},
            'bt': {'available': bool(b.get('available')),
                   'on': bool(b.get('powered')),
                   'names': [str(n) for n in (b.get('connected') or [])][:4]}}


def remote_power(action, token):
    """One of the glass's own power actions, asked for from the phone.

    Straight through to power_do rather than queued for the panel,
    because the reason you reach for this is usually that the glass has
    stopped answering - and a command the panel has to collect is a
    command that never arrives exactly then. 'reload' is the one
    exception and is queued, because the thing being reloaded is the
    panel's page and netd cannot reload a browser without killing it."""
    if not _remote['armed']:
        return {'ok': False, 'error': 'NOT ARMED'}, 403
    if not secrets.compare_digest(token, _remote['token']):
        return {'ok': False, 'error': 'BAD TOKEN'}, 403
    if not isinstance(action, str):
        return {'ok': False, 'error': 'NO SUCH ACTION'}, 400
    # Against what the PANEL registered and this Pi can currently do,
    # which is the same gate the glass's own tiles are behind. Nothing
    # here is a list netd wrote: an action the sheet does not offer is
    # not an action, however well spelled.
    if action not in [a['a'] for a in remote_available_power()]:
        return {'ok': False, 'error': 'NO SUCH ACTION'}, 400
    if action == 'reload':
        with _rlock:
            _remote['pend']['power'] = {'kind': 'power', 'action': 'reload'}
        return {'ok': True, 'queued': True}, 200
    r = power_do(action)
    # Whatever it was, it may have been the one that changes which way
    # out of the kiosk is offered.
    _remote_power_bust()
    return r, (200 if r.get('ok') else 400)


def remote_register(body):
    """The panel saying what it has. Not an arm - there is nothing to
    arm, and no tile to arm it from.

    netd validates every command against this and keeps no catalogue of
    its own on purpose: the readings live in the HTML, and a second list
    in this file would drift the first time one was added, in the
    direction of refusing a good command or accepting a meaningless
    one."""
    slots = body.get('slots')
    readings = body.get('readings')
    if not isinstance(slots, dict) or not slots:
        return {'ok': False, 'error': 'NO SLOTS'}
    if not isinstance(readings, list) or not readings:
        return {'ok': False, 'error': 'NO READINGS'}
    # Objects, not keys. The phone draws a NAME under a GROUP heading
    # and sends back a key; the first version of this took whatever the
    # panel sent and the two halves disagreed - remote_cmd validated
    # `reading in readings`, which only works on a list of keys, while
    # /r/state handed the page objects and read .name and .sen off
    # them. Both halves passed their own probes. Checked here, once, so
    # a panel that sends the wrong shape is told so instead of half
    # working.
    if not all(isinstance(x, dict) and x.get('k') and x.get('name')
               for x in readings):
        return {'ok': False, 'error': 'BAD READINGS'}
    if not all(isinstance(v, list) and v for v in slots.values()):
        return {'ok': False, 'error': 'BAD SLOTS'}
    themes = body.get('themes')
    if not isinstance(themes, list) or not themes:
        themes = ['day', 'dusk', 'night', 'auto']
    # What each page and each slot is CALLED. Optional, and strings
    # only: the phone is looking at a list rather than at the glass, and
    # `c2` names the cell perfectly well without saying which one it is.
    def _labels(v):
        return ({str(a): str(b) for a, b in v.items()}
                if isinstance(v, dict) else {})
    try:
        geom = _geom(body.get('geom') or {})
    except ValueError:
        return {'ok': False, 'error': 'BAD GEOM'}
    with _rlock:
        _remote.update(slots={k: list(v) for k, v in slots.items()},
                       readings=list(readings), themes=list(themes),
                       pages=_labels(body.get('pages')),
                       names=_labels(body.get('names')),
                       # The word the GLASS puts over each reading, and
                       # the instrument headings it files them under.
                       # Both are the panel's, for the same reason the
                       # catalogue is: netd holding its own copy of
                       # either is a copy that drifts.
                       tags=_labels(body.get('tags')),
                       sens=_labels(body.get('sens')),
                       # The power sheet as the GLASS has it, so the
                       # phone draws the same words in the same order
                       # with the same two marked dangerous. netd
                       # decides which are available and nothing else.
                       power=_power_sheet(body.get('power')),
                       # Every setting the phone may reach, and what a
                       # legal value for it is. netd writes down no
                       # list of its own here either: an entry's own
                       # kind is what a value is checked against, so a
                       # setting added to the glass needs no change in
                       # this file.
                       settings=_settings(body.get('settings')),
                       geom=geom)
        if isinstance(body.get('now'), dict):
            _remote['now'] = body['now']
        # A register also lifts a hand-shut latch. The panel registers
        # when it loads, so a reload is the move an owner makes when the
        # remote has stopped working - and it should be the move that
        # fixes it, rather than leaving them with a dead remote and no
        # idea that an ssh session weeks ago is why.
        _remote['held'] = False
    remote_up()
    return remote_status()


def remote_up():
    """Open the door if the dongle has an address, and move it if that
    address changed. Idempotent, and safe to call on a timer.

    The address moves because the phone is the access point and the Pi
    is a DHCP client on it - a new lease, or a different phone, and the
    old socket is listening on a subnet nobody is on. The bind itself is
    on 0.0.0.0, so only the FALLBACK path cares; it is the subnet check
    that goes stale, not the socket."""
    if _remote.get('held'):
        return False                  # shut by hand; see remote_disarm
    cidr = _dev_subnet(REMOTE_DEV)
    with _rlock:
        if not cidr:
            if _remote['armed']:
                _remote_stop()        # the dongle went; so does the door
            return False
        if _remote['armed'] and cidr == _remote.get('cidr'):
            return True               # already up, same subnet
        if _remote['armed']:
            _remote_stop()
        try:
            sock, how = remote_socket()
        except OSError:
            return False
        srv = ThreadingHTTPServer.__new__(ThreadingHTTPServer)
        ThreadingHTTPServer.__init__(srv, ('0.0.0.0', REMOTE_PORT),
                                     RemoteHandler, bind_and_activate=False)
        srv.socket.close()
        srv.socket = sock
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        _remote.update(armed=True, how=how, srv=srv, cidr=cidr,
                       token=remote_token(),
                       url='http://%s:%d/r?t=%s'
                           % (cidr.split('/')[0], REMOTE_PORT, remote_token()))
    return True


def _remote_stop():
    """Close the door. Keeps the TOKEN - that lives in a file and the
    phone has it saved; only the socket and the pending commands go."""
    srv = _remote.get('srv')
    if srv:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass
    _remote.update(armed=False, srv=None, pend={}, how='', url='', cidr='')


def remote_disarm():
    """The escape hatch, over ssh. Nothing on the glass calls this -
    there is no tile - but the day something is wrong the door should
    be shuttable without stopping netd and taking the panel's radios
    with it.

    It STAYS shut. The first version of this just closed the socket,
    and the thirty-second watcher reopened it - which is not an escape
    hatch, it is a thirty-second pause with a reassuring name. The
    latch is in memory on purpose: restarting netd opens the door
    again, so an owner who shut it in a hurry and forgot is not left
    with a remote that never works again and no idea why."""
    with _rlock:
        _remote['held'] = True
        _remote_stop()
    return remote_status()


def remote_watch():
    """Every half minute, because a lease change is the one thing that
    silently breaks this and nothing else will notice."""
    while True:
        time.sleep(30)
        try:
            remote_up()
        except Exception:
            pass


def remote_poll(body=None):
    """See remote_poll below - this signature takes the panel's own
    current state along with the drain, so the phone can show what is
    in each slot without ever being told what it reads."""
    body = body or {}
    now = body.get('now')
    if isinstance(now, dict):
        _remote['now'] = now
    return _remote_drain()


def _remote_drain():
    """The panel draining whatever the phone has asked for.

    Loopback only, and it touches no subprocess and takes no lock the
    radios use - it is a dict swap, which is what lets the panel poll it
    at a second and a half without costing anything."""
    with _rlock:
        pend, at = _remote['pend'], _remote['at']
        _remote['pend'] = {}
        if at and time.time() - at > REMOTE_STALE:
            pend = {}                      # the panel was away; do not replay
    # `have` is netd admitting it has forgotten. The catalogue lives in
    # memory, so a netd restart - a crash, an upgrade, systemd - leaves
    # the door open and the phone with nothing to show and every command
    # refused. The panel polls anyway, so the poll is where it should
    # find that out and register again.
    return {'ok': True, 'armed': _remote['armed'], 'cmds': pend,
            'have': bool(_remote['readings'] and _remote['slots'])}


def remote_cmd(body, token):
    """One command from the phone. Validated against what the panel said
    it had, because nothing arriving on that socket is trusted."""
    r = _remote
    if not r['armed']:
        return {'ok': False, 'error': 'NOT ARMED'}, 403
    if not token or not secrets.compare_digest(token, r['token']):
        return {'ok': False, 'error': 'BAD TOKEN'}, 403
    kind = body.get('kind')
    with _rlock:
        if kind == 'slot':
            page, slot = body.get('page'), body.get('slot')
            reading = body.get('reading')
            if page not in r['slots'] or slot not in r['slots'].get(page, []):
                return {'ok': False, 'error': 'NO SUCH SLOT'}, 400
            if not any(x.get('k') == reading for x in r['readings']):
                return {'ok': False, 'error': 'NO SUCH READING'}, 400
            # Latest wins, per slot. Two taps on the same cell before the
            # panel polls should be one change, not a queue of them.
            r['pend']['slot:%s:%s' % (page, slot)] = {
                'kind': 'slot', 'page': page, 'slot': slot, 'reading': reading}
        elif kind == 'theme':
            theme = body.get('theme')
            if theme not in r['themes']:
                return {'ok': False, 'error': 'NO SUCH THEME'}, 400
            r['pend']['theme'] = {'kind': 'theme', 'theme': theme}
        elif kind == 'page':
            # Turning the glass to the page the phone is looking at.
            # Validated against the catalogue like a slot is: the panel
            # said which pages it has, and nothing else is a page.
            page = body.get('page')
            if page not in r['slots']:
                return {'ok': False, 'error': 'NO SUCH PAGE'}, 400
            r['pend']['page'] = {'kind': 'page', 'page': page}
        elif kind == 'set':
            k = body.get('k')
            d = None
            for e in (r.get('settings') or []):
                if e['k'] == k:
                    d = e
                    break
            if d is None:
                return {'ok': False, 'error': 'NO SUCH SETTING'}, 400
            v = body.get('v')
            if d['kind'] == 'action':
                v = None
            elif d['kind'] == 'toggle':
                if not isinstance(v, bool):
                    return {'ok': False, 'error': 'NOT A SWITCH'}, 400
            elif d['kind'] == 'cycle':
                # `is True` first: True == 1 in Python, so a bool would
                # pass an `in [1, 2, 3]` test and arrive at the panel as
                # a number it never offered.
                if isinstance(v, bool) or v not in d['opts']:
                    return {'ok': False, 'error': 'NO SUCH VALUE'}, 400
            else:
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    return {'ok': False, 'error': 'NO SUCH VALUE'}, 400
                if v < d['min'] or v > d['max']:
                    return {'ok': False, 'error': 'OUT OF RANGE'}, 400
            # Latest-wins per setting, like a slot: two taps on one
            # before the panel polls are one change. An action is the
            # exception in spirit but not in effect - pressing TEST
            # twice inside 1.5 s is one horn either way.
            r['pend']['set:' + k] = {'kind': 'set', 'k': k, 'v': v}
        elif kind == 'clock':
            # Queued as a SEQUENCE, not latest-wins. These are events:
            # a hold then a tap means reset and then start, and keeping
            # only the last leaves the boat in a state nobody asked
            # for. Four is more than a finger produces inside the
            # panel's 1.5 s poll, and a cap is what stops a phone that
            # has lost the boat queueing an afternoon of them.
            g = body.get('do')
            if g not in ('tap', 'double', 'hold'):
                return {'ok': False, 'error': 'NO SUCH GESTURE'}, 400
            was = r['pend'].get('clock')
            seq = ((was['seq'] if was else []) + [g])[-4:]
            r['pend']['clock'] = {'kind': 'clock', 'seq': seq}
        elif kind == 'timer':
            # A whole minute either way, which is the whole of what the
            # glass's own two buttons do. Not an arbitrary number: a
            # start clock is not a thing to let a network set freely,
            # and every press the panel can receive is a press someone
            # could have made standing at it.
            by = body.get('by')
            if by not in (60, -60):
                return {'ok': False, 'error': 'NO SUCH NUDGE'}, 400
            # These ACCUMULATE rather than latest-wins: three taps on +
            # before the panel polls is three minutes, and keeping only
            # the last would silently drop two of them. Capped so a
            # stuck finger cannot wind the clock to the moon.
            was = r['pend'].get('timer')
            tot = (was['by'] if was else 0) + by
            tot = max(-3600, min(3600, tot))
            if tot:
                r['pend']['timer'] = {'kind': 'timer', 'by': tot}
            else:
                r['pend'].pop('timer', None)
        else:
            return {'ok': False, 'error': 'NO SUCH COMMAND'}, 400
        r['at'] = time.time()
    return {'ok': True}, 200


REMOTE_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Confluence Helm</title>
<link rel="manifest" href="/r/manifest.webmanifest?t=%T%">
<link rel="apple-touch-icon" href="/r/icon.png?v=%V%">
<!-- Both spellings: the apple- one is what iOS has always read, the
     bare one is the standard that replaced it, and Android reads the
     manifest instead. Together they are what makes Add to Home Screen
     give an app with no browser chrome rather than a bookmark. -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<!-- NOT black-translucent. That makes a saved app draw under the
     status bar, and on a phone with a notch the first line of it is
     simply gone: the clock sits on top of the app's own name. default
     keeps the bar opaque and starts the page below it. -->
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Confluence">
<meta name="theme-color" content="#0B0C0E">
<style>
:root{color-scheme:dark light;
 /* Replaced wholesale from now.pal the moment the state lands. These
    are the dusk values, and they are only what is on screen for the
    one frame before the boat answers. */
 --bg:#0B0C0E; --ink:#F2F4F6; --ink-dim:#9AA2A9; --label:#6C757C;
 --hairline:#242A2F; --accent:#4A9EFF; --panel:#15181B; --chip:#1B2531;
 /* The shallow alarm's two zones. Dusk's, like the rest, and on screen
    only for the frame before the boat answers - but without them that
    frame draws the bar in nothing at all. */
 --warn:#FFB020; --alarm:#FF3B30;
 --pad:14px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--ink);
 font:600 17px/1.3 -apple-system,'Segoe UI',Roboto,sans-serif;
 /* A floor under the inset as well as the inset itself: a browser
    that reports none - any Android, and iOS in a tab - still owes the
    top of the page a little room, and 10px is the difference between
    the name sitting ON the edge and sitting below it. */
 padding:calc(env(safe-area-inset-top) + 10px) var(--pad)
         env(safe-area-inset-bottom);
 min-height:100dvh;display:flex;flex-direction:column}
/* Under the dim with everything else. It stood in front of it for a
   while so the two buttons stayed pressable and one could swap
   straight to the other - but the owner wants the whole page to go
   back, and a sheet you close before opening the other is what every
   modal does anyway. */
.top{padding:14px 2px 12px;font-size:15px;letter-spacing:.26em;
 color:var(--ink);border-bottom:2px solid var(--hairline);margin-bottom:4px;
 display:flex;align-items:center;gap:10px}
.top b{flex:1;font-weight:inherit;letter-spacing:inherit}
#pwslot{display:flex;align-items:center;gap:10px;flex:none}
#main{flex:1}

/* The switch. Outlined rather than filled: hairline-to-accent is how
   this whole app says "in force", and the one filled inversion on the
   glass is a single key on the gun pad. A filled chip here would make
   the remote louder than the instrument it mirrors. */
.pg{display:flex;gap:8px;margin:12px 0 10px}
.pg button{flex:1;background:none;border:2px solid var(--hairline);
 color:var(--label);border-radius:14px;padding:13px 0;font:inherit;
 font-size:12px;letter-spacing:.18em}
.pg button.on{border-color:var(--accent);color:var(--accent)}

/* The face. Full content width - the mirror's job is to be a picture,
   and the strip is the smallest target on it. */
.fv{display:block;width:100%;aspect-ratio:1}
.rim{fill:none;stroke:var(--hairline);stroke-width:6;stroke-dasharray:3 15}
.spoke{stroke:var(--label);stroke-width:6;stroke-linecap:round;opacity:.55}
.cut{stroke:var(--hairline);stroke-width:4}
.art{fill:none;stroke:var(--hairline);stroke-width:5}
.mk{fill:var(--ink);font-weight:700;text-anchor:middle;letter-spacing:-.06em;
 dominant-baseline:middle}
/* The start clock, in the glass's own two parts: the numerals, and the
   two buttons that nudge them a minute either way. */
.tm{fill:var(--ink);text-anchor:middle;dominant-baseline:middle;
 font-weight:600;font-variant-numeric:tabular-nums;
 font-family:-apple-system,'Segoe UI',Roboto,sans-serif}
.tm.idle{fill:var(--label)}
.tm.hot{fill:#C81E1E}
/* Asked, not yet answered. The phone cannot work out what a gesture
   did - only the boat knows what state it was in - so rather than
   guess and correct itself a second later it says it is waiting. */
.tm.wait{opacity:.45}
.tmg{fill:transparent;cursor:pointer}
.tb circle{fill:none;stroke:var(--hairline);stroke-width:3}
.tb rect{fill:var(--label)}
.tb .grab{fill:transparent;stroke:none}
.tb:active circle{fill:var(--chip)}
.tb.off{opacity:.2;pointer-events:none}
/* The lane is the touch target and the box is the glass's own rect.
   They are not the same shape on purpose: the rect is where the ink
   goes, the lane is everything up to the hairline you can see, because
   a dead gutter that reads as part of a cell is a tap that does
   nothing. */
.cl{fill:transparent}
.tg{fill:var(--ink);text-anchor:middle;font-weight:600;
 dominant-baseline:middle;
 font-family:-apple-system,'Segoe UI',Roboto,sans-serif}
g.z.on .cl{fill:var(--accent);fill-opacity:.14}
g.z.on .tg{fill:var(--accent)}
.hint{text-align:center;color:var(--label);font-size:11px;
 letter-spacing:.16em;margin:10px 0 0}
.fb p{color:var(--label);font-size:11px;letter-spacing:.14em;
 text-align:center;margin:18px 0 14px;line-height:1.6}
.fbr{border:2px solid var(--hairline) !important;margin-bottom:8px}
.fbr i{color:var(--ink)}

h1{font-size:12px;letter-spacing:.22em;color:var(--label);margin:16px 0 10px}
.th{display:flex;gap:8px;margin-bottom:10px}
.th button{flex:1;background:none;border:2px solid var(--hairline);
 color:var(--label);border-radius:14px;padding:13px 0;font:inherit;
 font-size:13px;letter-spacing:.1em}
.th button.on{border-color:var(--accent);color:var(--accent)}
/* The two ways in, in the corner a thumb reaches last. Everything
   below them is the face, which is what this app is for - a full-width
   row under it read as another setting, and these are not settings,
   they are the device.
   Circled, because a bare glyph on a header reads as a label rather
   than a thing you press. The ring is close in around the glyph: it
   is there to say "button", not to be the button, and at 38 it read
   as a tile with something in the middle of it.
   The ring is not the target either. The padding outside it carries
   the tap to 46 - more than the 44 a thumb wants - and the negative
   margin keeps both of them on the name's own line while the tap area
   runs past it. */
.hb{background:none;padding:6px;margin:-6px 0;border-radius:50%;
 display:flex;line-height:0;
 border:2px solid var(--hairline);color:var(--label);
 width:30px;height:30px;align-items:center;justify-content:center;
 box-sizing:content-box;background-clip:content-box}
/* Unchanged while the ring came in: the glyph is what you are looking
   for and the circle is only what says it can be pressed. */
.hb svg{width:19px;height:19px;flex:none}
.hb:active{background:var(--chip)}
/* The power one wears its own colour, because it is the one on this
   header that can take the boat's instruments down. The same red the
   sheet marks Reboot and Shut down in, and the glass marks its own
   danger with. On the night theme everything is red for night vision
   and the ring is what carries it instead. */
#pwb{border-color:#C81E1E;color:#C81E1E}
svg.gl{fill:none;stroke:currentColor;stroke-width:2;
 stroke-linecap:round;stroke-linejoin:round}
svg.gl .f{fill:currentColor;stroke:none}

/* The scrim, and the sheet in the middle of it. The glass does exactly
   this with #netsheet - a dim over everything and the box in the
   centre of it - and the owner asked for the mirror to match. Dimming
   rather than sitting on the bottom edge also puts the thing you came
   for in the middle of the glass, where you are looking, instead of
   under your own thumb. */
#scrim{position:fixed;inset:0;z-index:8;
 background:rgba(0,0,0,.46);opacity:0;visibility:hidden;
 transition:opacity .2s ease, visibility 0s linear .2s;
 display:flex;align-items:center;justify-content:center;
 padding:calc(env(safe-area-inset-top) + 16px) var(--pad)
         calc(env(safe-area-inset-bottom) + 16px)}
#scrim.on{opacity:1;visibility:visible;transition-delay:0s}
/* The power sheet stands further forward, because what is on it is
   further-reaching than a palette. */
#scrim.pw{background:rgba(0,0,0,.68)}
#sheet{width:100%;max-height:100%;display:flex;flex-direction:column;
 background:var(--panel);border-radius:20px;
 border:2px solid var(--hairline);overflow:hidden;
 box-shadow:0 20px 48px rgba(0,0,0,.38);
 /* Out from under the header it was hanging off, and into the middle.
    Short enough not to be a wait and long enough to be a movement you
    can follow, which is the whole job of it: the sheet arrives from
    somewhere rather than replacing what you were looking at. */
 transform:translateY(22px) scale(.96);opacity:0;
 transition:transform .22s cubic-bezier(.2,.9,.3,1), opacity .16s ease}
#scrim.on #sheet{transform:none;opacity:1}
@media (prefers-reduced-motion:reduce){
  #sheet{transition:opacity .16s ease}
  #sheet,#scrim.on #sheet{transform:none}
}
#sheet .hd{display:flex;align-items:center;gap:10px;padding:12px 14px;
 border-bottom:2px solid var(--hairline)}
#sheet .hd b{flex:1;font-size:11px;letter-spacing:.18em;color:var(--label);
 font-weight:600}
#sheet .hd button{background:none;border:0;color:var(--accent);font:inherit;
 font-size:12px;letter-spacing:.14em;padding:4px 2px}
#shr{padding:8px;overflow:auto;-webkit-overflow-scrolling:touch}
.prow i{font-style:normal;color:var(--accent);font-size:15px;flex:none}
.prow em{font-style:normal;color:var(--label);font-size:11px;
 letter-spacing:.16em;flex:none}
.prow svg[viewBox="0 0 40 40"]{width:23px;height:23px}
/* The settings rows. A label on the left and its value on the right,
   which is the shape every settings list on every phone has - and the
   shape that lets you read the whole sheet down the right-hand edge
   without reading a word of it. */
.srow{display:flex;align-items:center;gap:12px;width:100%;background:none;
 border:0;color:inherit;border-radius:12px;padding:12px;font:inherit;
 text-align:left}
.srow:active{background:var(--chip)}
.srow s{flex:1;text-decoration:none;font-size:16px}
.srow b{font-size:14px;letter-spacing:.1em;color:var(--accent);
 font-weight:600;flex:none;font-variant-numeric:tabular-nums}
.srow.act b{color:var(--label)}
/* The group headings, the same ones the glass puts on its cards. */
.sgrp{font-size:10px;letter-spacing:.2em;color:var(--label);
 margin:14px 0 2px 12px}
.sgrp:first-child{margin-top:2px}
/* A switch rather than a word, because on and off is the one value you
   should not have to read. */
.sw{width:46px;height:28px;border-radius:14px;flex:none;position:relative;
 background:var(--chip);border:2px solid var(--hairline);transition:.15s}
.sw i{position:absolute;top:3px;left:3px;width:18px;height:18px;
 border-radius:50%;background:var(--label);transition:.15s}
.srow.on .sw{background:var(--accent);border-color:var(--accent)}
.srow.on .sw i{left:21px;background:#fff}
/* The slider. Its own row under the label, because 46px of thumb and a
   readable label do not both fit across a 358px sheet. */
.srow.rng{flex-wrap:wrap}
.srow.rng input{width:100%;margin:10px 2px 0;accent-color:var(--accent)}
/* The glass's own picture of the shallow alarm, shrunk: the alarm zone
   from nothing to the threshold, the warning zone to twice it, and the
   scale under them. The bar the panel draws also carries a marker at
   the depth under the boat right now; that one is a reading and stays
   on the glass. */
/* width:100% on both, because the row they sit in is the wrapping
   flex the slider needs - without it the bar is a flex item beside the
   value and the scale's three numbers run together as 02040. */
.dbar{position:relative;height:16px;border-radius:6px;width:100%;
 background:var(--chip);overflow:hidden;margin:9px 2px 0}
.dbar i{position:absolute;top:0;bottom:0;display:block}
.dbar .al{left:0;background:var(--alarm);opacity:.55}
.dbar .wa{background:var(--warn);opacity:.35}
.dscale{display:flex;justify-content:space-between;margin:3px 4px 0;
 width:100%;box-sizing:border-box;
 font-size:9.5px;font-weight:600;letter-spacing:.1em;color:var(--label)}
/* A status, not a control. No :active, no button, and the value in the
   label's own colour rather than the accent - accent on this sheet
   means "you can change this", and on these two you cannot.
   Its own proportions as well: an SSID is as long as somebody felt
   like making it, so the name takes one line with the interface under
   it and the state takes the rest, right-aligned and smaller. Equal
   halves put "Built-in" on two lines to make room for a word nobody
   is reading letter by letter. */
/* The radios are tiles, as they are on the glass's own control row:
   the glyph says which adapter and what it is doing, and under it in
   small letters is the thing you opened this to read - the network it
   is on, or what is connected to it. No colour from the accent, and
   nothing to press: accent on this sheet means "you can change this",
   and on these you cannot. */
.rtier{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;
 gap:8px;padding:8px 10px 12px}
.rtile{display:flex;flex-direction:column;align-items:center;gap:7px;
 padding:4px 2px;min-width:0}
.rtile svg{width:26px;height:26px;flex:none;color:var(--ink-dim)}
/* Two lines rather than an ellipsis. Four tiles across a 358px sheet
   is 85px each, and at a letter-spacing that suits a heading an SSID
   gets five characters and a dot - which is not the thing the owner
   opened this to read. Tight spacing and a second line hold
   CONFLUENCE and MARINA-GUEST whole. */
.rtile u{text-decoration:none;font-size:9.5px;letter-spacing:.02em;
 color:var(--label);text-align:center;line-height:1.3;
 max-width:100%;align-self:stretch;overflow:hidden;
 word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;
 -webkit-line-clamp:2}
.rtile em{font-style:normal;display:block;font-size:11px;
 color:var(--ink-dim);letter-spacing:.08em;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap}
.rtile.off svg, .rtile.off em{color:var(--label);opacity:.5}

/* A setting the glass draws as a tile. Same shape as a radio's, with
   the label where the network goes and the value under it - which is
   what the Display card puts side by side on the panel. */
/* The pair spans the card, each taking half of what is left after the
   gap, so it is symmetric about its middle - and its outer edges stop
   where every ROW's words stop rather than against the sheet's own
   border. Flush looked like two borders touching; this lines the pills
   up with the column everything else on the sheet is written in.
   Sized DOWN by their padding and their type rather than by their
   width, which is what 124px columns did and it left the pair hanging
   off the left with the slack all on one side. */
.stier{display:grid;grid-template-columns:repeat(2,1fr);
 gap:8px;padding:2px 12px 10px}
.stile{display:flex;flex-direction:column;align-items:center;gap:6px;
 padding:9px 4px;border:2px solid var(--hairline);border-radius:14px;
 background:none;color:var(--label);font:inherit}
.stile:active{background:var(--chip)}
.stile svg{width:22px;height:22px;flex:none}
.stile svg[viewBox="0 0 40 40"]{width:24px;height:24px}
.stile u{text-decoration:none;font-size:9px;letter-spacing:.16em}
.stile b{font-size:12px;font-weight:600;letter-spacing:.08em;
 color:var(--accent)}
.prow{display:flex;align-items:center;gap:13px;width:100%;background:none;
 border:0;color:inherit;border-radius:12px;padding:13px 12px;font:inherit;
 text-align:left}
.prow s{flex:1;text-decoration:none;font-size:17px}
.prow svg{width:21px;height:21px;flex:none;color:var(--label)}
.prow:active{background:var(--chip)}
/* Lit, the way the glass lights an armed tile - and the way this app
   already lights the zone whose card is open. One idiom for "this is
   the thing you are about to do". */
.prow.arm{background:var(--chip);color:var(--accent)}
.prow.arm svg{color:var(--accent)}
.prow.dgr.arm{color:#C81E1E}
.prow.dgr.arm svg{color:#C81E1E}
/* The power sheet is tiles, which is what the glass's own is: an icon
   and the one word that fits under it. A list of sentences is a list
   you read; a grid of glyphs is one you aim at, and this is the sheet
   you reach for with one hand on something else.
   Two tiers, as the glass has them - the safe ones above the rule and
   the two that take the boat down below it, which is the separation
   that does not depend on colour. Night is a single red hue. */
.ptier{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;
 padding:10px}
.ptier.low{grid-template-columns:repeat(2,1fr);
 border-top:2px solid var(--hairline);padding-top:14px}
.ptile{border:2px solid var(--hairline);border-radius:18px;
 padding:16px 6px 13px;display:flex;flex-direction:column;
 align-items:center;gap:9px;color:var(--ink);background:none;font:inherit}
.ptile:active{background:var(--chip)}
.ptile svg{width:28px;height:28px;flex:none;color:var(--label)}
.ptile b{font-size:12px;font-weight:600;letter-spacing:.08em;
 text-align:center;line-height:1.15}
.ptile.arm{background:var(--chip);border-color:var(--accent);
 color:var(--accent)}
.ptile.arm svg{color:var(--accent)}
.ptile.dgr{border-color:#C81E1E}
.ptile.dgr svg, .ptile.dgr b{color:#C81E1E}
.ptile.dgr.arm{background:var(--chip)}
/* The bar that does it. The glass asks for a full slide, because a
   round panel at speed produces touches nobody offered - a sleeve on
   the rim, a knuckle passing through. A phone in a hand does not do
   that and a phone in a pocket is locked, so this asks for a HOLD
   instead: still a gesture no stray contact completes, and one your
   thumb can do without looking, which a drag across a 390px glass in a
   seaway is not. */
#hold{position:relative;margin:4px 8px 10px;border-radius:14px;
 overflow:hidden;background:var(--chip);border:2px solid var(--accent);
 padding:15px 0;text-align:center;touch-action:none;display:none}
#hold.on{display:block}
#hold.dgr{border-color:#C81E1E}
#hold i{position:absolute;left:0;top:0;bottom:0;width:0;
 background:var(--accent);opacity:.3}
#hold.dgr i{background:#C81E1E;opacity:.45}
#hold b{position:relative;font-size:13px;letter-spacing:.14em;
 color:var(--accent)}
#hold.dgr b{color:#C81E1E}

/* The card. It drops from the face's FEET and never covers it, so the
   zone it belongs to stays lit while you choose - which is the signal
   the glass gives by turning the open cell accent, and the thing that
   makes this a drop-down rather than a second screen. */
/* Under the scrim and over the page: a sheet is in front of the card,
   and the card is in front of the face it drops from. */
#list{position:fixed;left:var(--pad);right:var(--pad);display:none;z-index:7;
 flex-direction:column;background:var(--panel);border-radius:18px;
 border:2px solid var(--hairline);overflow:hidden}
#list.on{display:flex}
#list .hd{display:flex;align-items:center;gap:10px;padding:12px 14px;
 border-bottom:2px solid var(--hairline);flex:none}
#list .hd b{flex:1;font-size:12px;letter-spacing:.2em;color:var(--label)}
#list .hd button{background:none;border:0;color:var(--accent);font:inherit;
 font-size:12px;letter-spacing:.14em;padding:4px 2px}
#roll{overflow:auto;padding:8px;flex:1;-webkit-overflow-scrolling:touch}
.row{display:flex;align-items:center;gap:12px;width:100%;background:none;
 border:0;color:inherit;border-radius:12px;padding:12px 12px;
 margin-bottom:4px;font:inherit;text-align:left}
.row s{flex:1;text-decoration:none;font-size:17px;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap}
.row i{font-style:normal;color:var(--accent);font-size:15px;flex:none}
.row:active{background:var(--chip)}
.row.sel{background:var(--chip)}
.grp{font-size:10px;letter-spacing:.2em;color:var(--accent);
 margin:12px 0 4px 12px}
#msg{position:fixed;left:var(--pad);right:var(--pad);
 bottom:calc(14px + env(safe-area-inset-bottom));
 background:#C81E1E;color:#fff;border-radius:12px;padding:12px 16px;
 font-size:14px;display:none;z-index:10}
/* While a sheet is up the message goes to the TOP instead. It is
   fixed to the bottom of the glass and the sheet is too, so a word
   about what just happened sat straight on the bar that does the next
   thing - and for the two and a half seconds it was there, pressing
   that bar pressed the message. */
body.shon #msg{bottom:auto;top:calc(env(safe-area-inset-top) + 64px)}
</style></head><body>
<div class="top"><b>CONFLUENCE HELM</b><span id="pwslot"></span></div>
<div id="main"></div>
<div id="foot"></div>
<div id="list"></div>
<div id="scrim"><div id="sheet"></div></div>
<div id="msg"></div>
<script>
var T=new URLSearchParams(location.search).get('t')||'';
var S=null, PG='', OPEN=null;
/* Furniture, and nothing with a coordinate in it: every line and box on
   the face arrives on the wire. What is left here is which page wears a
   tick ring and which wears an album square, which is decoration. */
var ART={dial:{ticks:1, mark:'45'}, mus:{ticks:1}};
/* The power sheet's glyphs, keyed by action and local for the same
   reason the tick ring is: a picture is decoration, and everything on
   this wire that is not decoration is escaped on arrival. The words,
   the order and which two are dangerous all come from the glass. An
   action it grows later shows up here with no glyph and reads fine. */
var PICO={
 reload:'<path d="M20.5 11A8.5 8.5 0 0 0 6.3 6.3L3.5 9"/>'
       +'<path d="M3.5 4.5V9h4.5"/>'
       +'<path d="M3.5 13a8.5 8.5 0 0 0 14.2 4.7l2.8-2.7"/>'
       +'<path d="M20.5 19.5V15H16"/>',
 helper:'<rect x="5" y="5" width="14" height="14" rx="3"/>'
       +'<circle class="f" cx="12" cy="12" r="2.2"/>',
 desktop:'<rect x="3" y="4" width="18" height="13" rx="2"/>'
        +'<path d="M8 21h8M12 17v4"/>',
 cage:'<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/>',
 reboot:'<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3v4.4h-4.4"/>',
 poweroff:'<path d="M12 3.4v8.2"/><path d="M6.9 6.7a8 8 0 1 0 10.2 0"/>'};
/* The glass's own theme glyphs, on its own 40-unit box. Local, like
   the power sheet's, and for the same reason: a picture is decoration.
   What AUTO resolves to is not - that comes over the wire as now.eff. */
var TICO={
 auto:'<circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="3"/>'
     +'<path d="M20 12v9l6 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
 day:'<circle cx="20" cy="20" r="8" fill="currentColor"/><g stroke="currentColor" '
    +'stroke-width="3" stroke-linecap="round"><path d="M20 2v5M20 33v5M2 20h5M33 20h5'
    +'M7 7l3.5 3.5M29.5 29.5L33 33M33 7l-3.5 3.5M10.5 29.5L7 33"/></g>',
 dusk:'<path d="M8 26a12 12 0 0 1 24 0" fill="currentColor"/><g stroke="currentColor" '
     +'stroke-width="3" stroke-linecap="round"><path d="M3 31h34M20 4v5M5 12l3 3M35 12l-3 3"/></g>',
 night:'<path d="M27 25A13 13 0 0 1 15 6a14 14 0 1 0 12 19z" fill="currentColor"/>'};
function tly(k){
  return TICO[k] ? '<svg viewBox="0 0 40 40">'+TICO[k]+'</svg>' : '';
}
/* The radios' own glyphs, drawn from the fields the status carries -
   a base station for the adapter that IS the hotspot, a fan of arcs
   for one reaching out, a stub on a USB one and a slash on one that is
   down. The glass draws the same four distinctions; these are its
   ideas at a phone's size, kept here because a picture is decoration. */
function icoWifi(d){
  var g='';
  if(d.ap){
    g='<path d="M12 20v-5"/><circle class="f" cx="12" cy="12" r="2.4"/>'
     +'<path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4"/>'
     +'<path d="M5 19a9.5 9.5 0 0 1 0-14M19 5a9.5 9.5 0 0 1 0 14"/>';
  }else{
    /* An adapter that is down still draws its dot and first arc: the
       slash has to cross SOMETHING, or a radio that is off reads as a
       stray line rather than as a radio. */
    var n=!d.up ? 1 : d.conn ? (d.signal>=70?3:d.signal>=45?2:1) : 1;
    g='<circle class="f" cx="12" cy="18.6" r="1.7"/>';
    /* Named, so a probe can say "this one still has an arc under its
       slash" rather than counting shapes and hoping. */
    if(n>=1) g+='<path class="arc" d="M8.6 15.4a4.8 4.8 0 0 1 6.8 0"/>';
    if(n>=2) g+='<path class="arc" d="M5.6 12.2a9 9 0 0 1 12.8 0"/>';
    if(n>=3) g+='<path class="arc" d="M2.6 9.1a13.2 13.2 0 0 1 18.8 0"/>';
  }
  if(d.bus==='usb') g+='<path d="M20.4 3.2v4.2M18.6 4.6h3.6"/>';
  if(!d.up) g+='<path d="M4.2 3.6l15.6 16.8"/>';
  return '<svg class="gl" viewBox="0 0 24 24">'+g+'</svg>';
}
var ICO_BT='<path d="M8.4 7.2L15.6 16.8 12 19.8V4.2l3.6 3L8.4 16.8"/>';
/* A clock face with the delay written in it, which is what the glass's
   own SAVER tile does - the setting is readable without opening it. */
function icoSaver(lbl){
  return '<svg class="gl" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.4"/>'
    + (lbl && lbl!=='OFF'
       ? '<text x="12" y="12" text-anchor="middle" dominant-baseline="central"'
         +' font-size="9" font-weight="700" fill="currentColor"'
         +' stroke="none">'+esc(lbl)+'</text>'
       : '<path d="M6.6 6.6l10.8 10.8"/>')
    + '</svg>';
}

/* A gear, for the settings the theme is the whole of. */
var ICO_GEAR='<circle cx="12" cy="12" r="3.3"/>'
 +'<path d="M12 2.6l1.4 2.5 2.8-.5.5 2.8 2.5 1.4-1.6 2.4 1.6 2.4-2.5 1.4'
 +'-.5 2.8-2.8-.5L12 21.4l-1.4-2.5-2.8.5-.5-2.8-2.5-1.4L6.4 12 4.8 9.6'
 +'l2.5-1.4.5-2.8 2.8.5z"/>';
function gly(k,cls){
  return PICO[k] ? '<svg class="gl '+(cls||'')+'" viewBox="0 0 24 24">'
                   +PICO[k]+'</svg>' : '';
}
/* Which page index each key IS on the glass. The panel sends its own
   PAGE_I with `now`, and this is the only way to read it back. */
var PAGE_OF={dial:1, mus:2};
/* The buttons are 46 units across, which on a 362px face is thirty-one
   pixels - drawn right and too small to hit. 68 takes the tap without
   moving what is drawn, and stops just clear of the big number's box
   at 322. */
var TM_GRAB=68;
/* How far ABOVE the numerals the gesture zone reaches. 68 either way
   put it four pixels outside the ink, which is no target at all: an
   SVG text hit-tests on its glyphs and not on its box, so a finger
   between the 5 and the colon landed on the face behind it and did
   nothing. Below is fixed at TM_GRAB by the big number's box, which
   starts at 322 and must stay tappable; above is empty rim, so the
   zone takes it and is asymmetric on purpose. */
var TM_UP=96;
/* The clock the phone runs between polls. `at` is when the figure
   arrived, by the phone's own monotonic clock - the two machines are
   not assumed to agree about the time of day, only about how long is
   left. */
var TM={ms:0, st:'idle', at:0};
function tmLeft(){
  var gone=(performance.now()-TM.at);
  if(TM.st==='countdown') return Math.max(0, TM.ms-gone);
  if(TM.st==='racing')    return TM.ms+gone;
  return TM.ms;                       /* idle and finished do not move */
}
function tmTxt(ms){
  var s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor(s/60)%60;
  var ss=String(s%60);
  if(ss.length<2) ss='0'+ss;
  if(!h) return Math.floor(s/60)+':'+ss;
  var mm=String(m); if(mm.length<2) mm='0'+mm;
  return h+':'+mm+':'+ss;
}
/* Everything drawn here came over a network from a panel that is
   trusted - and is escaped anyway, because the day it is not is the day
   nobody remembers this file builds its markup as strings. */
function esc(s){return String(s===undefined||s===null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');}
function say(m){var e=document.getElementById('msg');e.textContent=m;
  e.style.display='block';setTimeout(function(){e.style.display='none'},2500);}
function get(u,cb){var x=new XMLHttpRequest();x.open('GET',u);
  x.onload=function(){try{cb(JSON.parse(x.responseText))}catch(e){say('BAD REPLY')}};
  x.onerror=function(){say('NO ANSWER FROM THE BOAT')};x.send();}
function post(b,cb){var x=new XMLHttpRequest();x.open('POST','/r/cmd?t='+T);
  x.setRequestHeader('Content-Type','application/json');
  x.onload=function(){var j={};try{j=JSON.parse(x.responseText)}catch(e){}
    if(x.status!==200){say(j.error||('HTTP '+x.status));return}cb&&cb()};
  x.onerror=function(){say('NO ANSWER FROM THE BOAT')};x.send(JSON.stringify(b));}

function held(p,sl){return (S.now.slots||{})[p+':'+sl];}
function tag(k){return (S.tags||{})[k] || nameOf(k);}
function nameOf(k){for(var i=0;i<S.readings.length;i++)
  if(S.readings[i].k===k)return S.readings[i].name;return k||'—';}
function slotName(p,sl){return (S.names||{})[p+':'+sl]||sl.toUpperCase();}

/* The lanes. Each slot's rect grown to meet its neighbours halfway, so
   the gutters the glass can afford to leave dead - forty units between
   two cells, nothing at all on a 1080px screen under a 44mm target -
   belong to somebody by the time they are a third the size.
   On the dial the halfway point lands exactly on the rules the glass
   draws, so the boundary you can see is the boundary you feel. */
/* Nothing may claim the album art. The two flanks grow toward each
   other across a page with nothing between them, so each took half the
   gap and both ran through the middle of the square - a tap anywhere on
   the artwork set the port or starboard reading depending on which side
   of centre it landed. They stop at its edge now. */
function keepOff(ln, art){
  if(!art) return ln;
  const ax=art[0], ay=art[1], aw=art[2], ah=art[3];
  const x0=ln[0], x1=ln[0]+ln[2], y0=ln[1], y1=ln[1]+ln[3];
  if(y1<=ay || y0>=ay+ah || x1<=ax || x0>=ax+aw) return ln;
  return ((x0+x1)/2 < ax+aw/2)
    ? [x0, ln[1], Math.max(24, ax-x0), ln[3]]
    : [ax+aw, ln[1], Math.max(24, x1-(ax+aw)), ln[3]];
}

function lanes(G){
  var sl, k, out={}, box=G.box||{};
  var ks=Object.keys(box);
  /* Rows first: slots whose boxes overlap vertically share a band. */
  var rows=[];
  ks.forEach(function(k){
    var b=box[k], mid=b[1]+b[3]/2, r=null;
    rows.forEach(function(x){ if(mid>=x.t && mid<=x.b) r=x; });
    if(!r){ r={t:b[1], b:b[1]+b[3], ks:[]}; rows.push(r); }
    r.t=Math.min(r.t,b[1]); r.b=Math.max(r.b,b[1]+b[3]); r.ks.push(k);
  });
  rows.sort(function(x,y){return x.t-y.t;});
  /* Nothing may sit on the clock. Its two buttons are at the same
     height as the top of the big number's box, so without this the
     lane covers them and every press of + opens the picker instead. */
  var tmBot=0;
  if(G.btn && G.btn.up) tmBot=G.btn.up[1]+TM_GRAB;
  /* Vertical: meet the next row halfway, and the glass at the ends. */
  for(var i=0;i<rows.length;i++){
    var t = i ? (rows[i-1].b+rows[i].t)/2
              : Math.max(tmBot, Math.max(0, rows[i].t-60));
    var bm= i<rows.length-1 ? (rows[i].b+rows[i+1].t)/2
                            : Math.min(1080, rows[i].b+60);
    rows[i].T=t; rows[i].B=bm;
  }
  /* A band thinner than MINH cannot be hit. The strip is 60 units - 20
     pixels on a 362px face - and no amount of care finds it. It takes
     what it needs from whichever neighbour is taller, which on the dial
     is the big number and which has it to give. */
  var MINH=88;
  for(var i=0;i<rows.length;i++){
    var r=rows[i], need=MINH-(r.B-r.T);
    if(need<=0) continue;
    var up=i?rows[i-1]:null, dn=i<rows.length-1?rows[i+1]:null;
    var fromUp = up && (up.B-up.T)>=(dn?(dn.B-dn.T):0) ? up : dn;
    if(fromUp===up && up){ up.B-=need; r.T-=need; }
    else if(dn){ dn.T+=need; r.B+=need; }
  }
  /* The rules are the content's width. The big number's own rect runs
     270 to 890 and so centres on 580, not 540 - the face's middle, and
     where its anchor and both rules are. On the glass that rect is a
     transparent tap target and nobody ever sees it; here the lane is
     DRAWN when its card is open, so the forty units showed up as a
     block sitting right of everything above and below it.
     A row with one slot in it takes the full ruled width, and no lane
     reaches past the rules at all. */
  var span=null;
  (G.cut||[]).forEach(function(c){
    var lo=Math.min(c[0],c[2]), hi=Math.max(c[0],c[2]);
    span = span ? [Math.min(span[0],lo), Math.max(span[1],hi)] : [lo,hi];
  });
  rows.forEach(function(r){
    r.ks.sort(function(x,y){return box[x][0]-box[y][0];});
    for(var j=0;j<r.ks.length;j++){
      var k=r.ks[j], b=box[k];
      var L = j ? (box[r.ks[j-1]][0]+box[r.ks[j-1]][2]+b[0])/2
                : Math.max(0, b[0]-40);
      var R = j<r.ks.length-1 ? (b[0]+b[2]+box[r.ks[j+1]][0])/2
                              : Math.min(1080, b[0]+b[2]+40);
      if(span){
        if(r.ks.length===1){ L=span[0]; R=span[1]; }
        else { L=Math.max(L,span[0]); R=Math.min(R,span[1]); }
      }
      out[k]=keepOff([L, r.T, R-L, r.B-r.T], G.art);
    }
  });
  return out;
}

/* A tag has to fit the lane it is in. WIND SPEED · AUTO in a 220-unit
   cell is a word and a half past the hairline, and the glass never has
   to solve this because the glass prints a NUMBER there - four
   characters, by construction.

   Shrunk to fit was the first answer and it only went so far: at the
   floor the longest names still crossed the rules, and shrinking
   everything to the width of the worst one would have made the short
   tags unreadable to save the long ones. So a tag that will not fit on
   one line is broken onto two, at the space nearest its middle - WIND
   SPEED / · AUTO rather than WIND / SPEED · AUTO - and only then
   shrunk if the longer half still needs it. */
function est(txt, z){
  return z*(0.60*txt.length+0.08*Math.max(0,txt.length-1));
}
function fit(txt, w, base){
  if(est(txt,base)<=w*0.88) return {ls:[txt], z:base};
  var p=txt.split(' ');
  if(p.length>1){
    var cut=1, best=1e9;
    for(var i=1;i<p.length;i++){
      var d=Math.abs(p.slice(0,i).join(' ').length-p.slice(i).join(' ').length);
      if(d<best){ best=d; cut=i; }
    }
    var ls=[p.slice(0,cut).join(' '), p.slice(cut).join(' ')];
    var need=Math.max(est(ls[0],1), est(ls[1],1));
    return {ls:ls, z:Math.max(17, Math.min(base, w*0.88/need))};
  }
  return {ls:[txt], z:Math.max(17, w*0.88/est(txt,1))};
}

/* A page the panel could not measure still has to be reachable. The
   music overlay is only measurable on a 1080 glass - see remoteGeom -
   so a kiosk window someone resized would otherwise leave three
   complications with no way to change them. Rows, which is what this
   whole app was before, and they say plainly that it is the PICTURE
   that is missing rather than the page. */
function rows(pg){
  var h='<div class="fb"><p>NO PICTURE OF THIS PAGE &mdash; '
       +'THE PANEL IS NOT AT ITS FULL SIZE</p>';
  (S.slots[pg]||[]).forEach(function(sl){
    h+='<button class="row fbr" data-p="'+esc(pg)+'" data-s="'+esc(sl)+'">'
      +'<s>'+esc(slotName(pg,sl))+'</s><i>'+esc(tag(held(pg,sl)))
      +'</i></button>';});
  return h+'</div>';
}

function face(pg){
  var G=(S.geom||{})[pg];
  if(!G||!G.box||!Object.keys(G.box).length) return rows(pg);
  var A=ART[pg]||{}, L=lanes(G), h='';
  h+='<svg class="fv" viewBox="0 0 1080 1080">';
  /* The glass is round and so is this: without the clip the watermark
     is a 1320-unit numeral on a square canvas and the corners of it
     show outside the rim. */
  h+='<defs><clipPath id="rnd"><circle cx="540" cy="540" r="537"/>'
    +'</clipPath></defs>';
  h+='<circle class="rim" cx="540" cy="540" r="537"/>';
  if(A.ticks){
    /* Twelve spokes, not the glass's hundred and twenty ticks: at a
       third the size they close into a grey band and the face loses
       its edge instead of gaining one. */
    for(var d=0; d<360; d+=30){
      var a=(d-90)*Math.PI/180;
      h+='<line class="spoke" x1="'+(540+474*Math.cos(a)).toFixed(1)
        +'" y1="'+(540+474*Math.sin(a)).toFixed(1)
        +'" x2="'+(540+516*Math.cos(a)).toFixed(1)
        +'" y2="'+(540+516*Math.sin(a)).toFixed(1)+'"/>';
    }
  }
  if(A.mark){
    /* The glass's own: 1320 units at x488 y672, which is so much
       bigger than the face that it bleeds off every edge and reads as
       texture rather than as a number. Drawn smaller it becomes a
       legible grey 45 sitting in the middle of everything, which is
       the first thing I did and the loudest thing on the face.
       y is a MIDDLE and not a baseline: the glass sets
       dominant-baseline:middle on every text it draws, so the same 672
       that centres it there put it most of a line high here. On a
       numeral 1320 units tall that is not a nudge.
       The opacity is the theme's, because .032 of near-black on a day
       panel and .07 of near-white on a night one are the same whisper
       and no single number is. */
    var op={day:.032, dusk:.055, night:.07}[(S.now||{}).eff] || .055;
    h+='<text class="mk" x="488" y="672" font-size="1320" opacity="'+op
      +'" clip-path="url(#rnd)">'+esc(A.mark)+'</text>';
  }
  /* The album art, at the box the panel measured. Nothing on this
     page carries a coordinate of its own - the moment one did, it
     would be a second place that knows where the glass puts things. */
  if(G.art) h+='<rect class="art" x="'+G.art[0]+'" y="'+G.art[1]+'" width="'
    +G.art[2]+'" height="'+G.art[3]+'" rx="18"/>';
  (G.cut||[]).forEach(function(c){
    h+='<line class="cut" x1="'+c[0]+'" y1="'+c[1]+'" x2="'+c[2]+'" y2="'+c[3]+'"/>';
  });
  if(G.tmr) h+=clockFace(G);
  Object.keys(G.box).forEach(function(sl){
    var ln=L[sl]||G.box[sl], an=(G.a||{})[sl]
      || [G.box[sl][0]+G.box[sl][2]/2, G.box[sl][1]+G.box[sl][3]/2];
    var t=tag(held(pg,sl));
    /* The big one gets a size and a half - the smallest step that reads
       as a step rather than as a rendering difference. */
    var big=G.box[sl][3]>=240, f=fit(t, ln[2], big?48:32);
    /* Two lines straddle the anchor rather than hanging off it: the
       anchor is where the glass prints the number, and the pair should
       sit where the one would have. */
    var n=f.ls.length, y0=an[1]-(n-1)*f.z*0.56;
    var tx='';
    for(var i=0;i<n;i++)
      tx+='<text class="tg" x="'+an[0]+'" y="'+(y0+i*f.z*1.12).toFixed(1)
        +'" font-size="'+f.z.toFixed(1)
        +'" letter-spacing="'+(f.z*0.08).toFixed(2)+'">'+esc(f.ls[i])+'</text>';
    h+='<g class="z'+(OPEN&&OPEN.p===pg&&OPEN.s===sl?' on':'')
      +'" data-p="'+esc(pg)+'" data-s="'+esc(sl)+'">'
      +'<rect class="cl" x="'+ln[0]+'" y="'+ln[1]+'" width="'+ln[2]
      +'" height="'+ln[3]+'" rx="16"/>'+tx+'</g>';
  });
  h+='</svg>';
  return h;
}

/* Most slots first. The dial has five of the eight, and a remote that
   opens on the other page makes you tap twice for the readings you
   came for. */
function pages(){
  return Object.keys(S.slots).sort(function(a,b){
    return (S.slots[b]||[]).length-(S.slots[a]||[]).length; });
}

/* The clock and its two buttons, where the glass has them. The one
   reading that crosses to the phone, because it is not really a
   reading: it is a control you are holding, and the moment you want it
   is the moment you are on the rail with both hands full. */
function clockFace(G){
  var ms=tmLeft(), off=(TM.st==='racing'||TM.st==='finished');
  var b=G.btn||{};
  /* The numerals take the glass's own three gestures, so a grab goes
     under them - bounded by the two buttons' own tap circles, because
     the thing you must never do reaching for + is reset the race.
     Grab and numerals in ONE group: a transparent fill still hit-tests,
     so without the group a finger on the digits would land on the text
     and a finger beside them on the rect, and only one of the two would
     be a gesture. */
  var h='<g class="tmz">';
  if(b.up && b.dn){
    var L=b.up[0]+TM_GRAB, R=b.dn[0]-TM_GRAB;
    if(R>L) h+='<rect class="tmg" x="'+L+'" y="'+(G.tmr[1]-TM_UP)+'" width="'
              +(R-L)+'" height="'+(TM_UP+TM_GRAB)+'"/>';
  }
  h+='<text class="tm'+(TM.st==='idle'?' idle':'')+(TM.wait?' wait':'')
     +(TM.st==='countdown'&&ms<60000?' hot':'')+'" x="'+G.tmr[0]
     +'" y="'+G.tmr[1]+'" font-size="104">'+esc(tmTxt(ms))+'</text></g>';
  [['up',1],['dn',-1]].forEach(function(p){
    var c=b[p[0]]; if(!c) return;
    var r=c[2], bar=Math.round(r*1.04), th=Math.round(r*0.22);
    h+='<g class="tb'+(off?' off':'')+'" data-by="'+(p[1]*60)+'">'
      +'<circle cx="'+c[0]+'" cy="'+c[1]+'" r="'+r+'"/>'
      +'<rect x="'+(c[0]-bar/2)+'" y="'+(c[1]-th/2)+'" width="'+bar
      +'" height="'+th+'" rx="'+(th/2)+'"/>'
      +(p[1]>0 ? '<rect x="'+(c[0]-th/2)+'" y="'+(c[1]-bar/2)+'" width="'+th
                 +'" height="'+bar+'" rx="'+(th/2)+'"/>' : '')
      +'<circle class="grab" cx="'+c[0]+'" cy="'+c[1]+'" r="'+TM_GRAB+'"/></g>';
  });
  return h;
}

function draw(){
  /* Busiest page first, which is the same rule that chooses the one
     to open on - otherwise the switch and the opening page disagree
     and the live button is the second one. */
  var h='<div class="pg">';
  pages().forEach(function(p){
    h+='<button data-f="'+esc(p)+'"'+(p===PG?' class="on"':'')
      +'>'+esc((S.pages||{})[p]||p.toUpperCase())+'</button>'; });
  h+='</div>'+face(PG)
    +'<div class="hint">TAP A COMPLICATION TO CHANGE IT</div>';
  document.getElementById('main').innerHTML=h;
  /* The theme used to be four buttons along the bottom. It is behind
     the gear now, where the owner asked for it - and the room that
     frees goes to the face, which is the thing this app is. */
  document.getElementById('foot').innerHTML='';
  /* Only when there is something on it. A Pi with no systemctl offers
     nothing here, and a button that opens an empty sheet is worse than
     no button. Drawn from here rather than sitting in the page so that
     it appears with the rest of what the boat said, instead of being
     there from the first frame and then possibly not meaning anything. */
  document.getElementById('pwslot').innerHTML =
    '<button class="hb" id="thb" aria-label="Display">'
    +'<svg class="gl" viewBox="0 0 24 24">'+ICO_GEAR+'</svg></button>'
    + ((S.power||[]).length
       ? '<button class="hb" id="pwb" aria-label="Power">'
         +gly('poweroff')+'</button>' : '');
  if(OPEN) place();
}

function place(){
  var sv=document.querySelector('.fv'), L=document.getElementById('list');
  /* Below the HEADER when there is no face. The fallback page draws
     rows instead of a mirror, and the card was left wherever the last
     face put it - which, now that the header is an opaque bar in front
     of the page, is underneath it: the card was there and its CLOSE
     could not be pressed. */
  if(!sv){
    var hd=document.querySelector('.top');
    L.style.top=Math.round(hd ? hd.getBoundingClientRect().bottom+8 : 8)+'px';
    L.style.bottom='calc(10px + env(safe-area-inset-bottom))';
    return;
  }
  /* Measured at open time rather than computed from the stack: every
     number above the face is a line box the system font decides, and a
     card that assumes them is a card that covers the mirror on one
     phone in five. */
  var b=sv.getBoundingClientRect();
  L.style.top=Math.round(b.bottom+8)+'px';
  L.style.bottom='calc(10px + env(safe-area-inset-bottom))';
}

function pick(p,sl){
  OPEN={p:p, s:sl};
  var cur=held(p,sl), last='', G=S.sens||{};
  var h='<div class="hd"><b>'+esc(slotName(p,sl))+'</b>'
       +'<button data-back="1">CLOSE</button></div><div id="roll">';
  S.readings.forEach(function(r){
    if(r.sen!==last){last=r.sen;
      h+='<div class="grp">'+esc(G[r.sen]||r.sen)+'</div>';}
    h+='<button class="row'+(r.k===cur?' sel':'')+'" data-k="'+esc(r.k)+'">'
      +'<s>'+esc(r.name)+'</s>'+(r.k===cur?'<i>&#10003;</i>':'')+'</button>';});
  var L=document.getElementById('list');
  L.innerHTML=h+'</div>';
  L.className='on';
  draw();                       /* so the zone lights while you choose */
  place();
  var at=L.querySelector('.sel');
  if(at) at.scrollIntoView({block:'center'});
  L.onclick=function(e){
    if(e.target.closest('[data-back]')) return void shut();
    var b=e.target.closest('[data-k]'); if(!b) return;
    post({kind:'slot',page:p,slot:sl,reading:b.dataset.k},function(){
      S.now.slots=S.now.slots||{}; S.now.slots[p+':'+sl]=b.dataset.k;
      shut();});
  };
}
function shut(){ OPEN=null;
  document.getElementById('list').className=''; draw(); }

/* ---- the sheet, in its two guises --------------------------------------
   POWER is the glass's own sheet: same words, same order, same two in
   red, and the same two-step - arm the thing, then do a gesture a
   stray touch does not complete. Least destructive first, which is the
   glass's rule and matters more here: the top of a list is where a
   hurried thumb lands, and that should not be the shutdown.

   DISPLAY is the theme, which used to be four buttons along the
   bottom. It needs no arming: nothing on it is destructive, and a
   theme you did not mean is undone by picking the one you did. */
var SHEET=null, ARM=null, HOLD_MS=900, HT=null;
/* True between a slider's first move and letting go. `input` fires all
   the way along and `change` at the release, so the two bracket the
   drag; pointerup clears it for a drag that ends where no change
   fires. */
var DRAG=false;
/* A finished action puts the sheet away after a beat, and that beat
   outlives the sheet: close it yourself and open the other one inside
   the second and a half, and the old timer shuts the new one in your
   face. Opening anything cancels it. */
var shAuto=null, shWipe=null;
/* One pending re-read, not one per change. Every setting asks the boat
   again just past its next poll, and with a timer each, changing two
   things inside a second and a half let the FIRST one's answer land
   after the second's - putting the old value back under your finger
   until the second's own answer caught up. */
var reloadT=null;
function reloadSoon(){ clearTimeout(reloadT);
                       reloadT=setTimeout(load, 1800); }
function shOpen(which){
  var e=document.getElementById('sheet'),
      sc=document.getElementById('scrim');
  clearTimeout(shAuto); shAuto=null;
  SHEET=which||null; ARM=null;
  document.body.classList.toggle('shon', !!SHEET);
  if(!SHEET){
    sc.className=''; e.className='';
    /* Emptied only once it has finished going away, or the box
       collapses to nothing on the first frame of the fade and the
       thing you watched leave is a line rather than a sheet. */
    clearTimeout(shWipe);
    shWipe=setTimeout(function(){ if(!SHEET) e.innerHTML=''; }, 260);
    return;
  }
  clearTimeout(shWipe);
  if(SHEET==='set') radGet();
  shPaint();
  e.className='on';
  sc.className='on'+(SHEET==='power'?' pw':'');
}
function shPaint(){
  document.getElementById('sheet').innerHTML =
    SHEET==='power' ? pwRows() : stRows();
}
function shHead(title){
  return '<div class="hd"><b>'+esc(title)+'</b>'
        +'<button data-shx="1">CLOSE</button></div><div id="shr">';
}
function pwRows(){
  var h=shHead(S.uptime ? 'DEVICE RUNTIME: '+S.uptime : 'DEVICE');
  var safe='', risk='';
  (S.power||[]).forEach(function(a){
    var t='<button class="ptile'+(a.danger?' dgr':'')
      +(ARM&&ARM.a===a.a?' arm':'')+'" data-pa="'+esc(a.a)+'">'
      +gly(a.a)+'<b>'+esc(a.short||a.name)+'</b></button>';
    if(a.danger) risk+=t; else safe+=t;
  });
  h+='<div class="ptier">'+safe+'</div>'
    +(risk?'<div class="ptier low">'+risk+'</div>':'');
  return h+'</div><div id="hold"'
    +(ARM?(' class="on'+(ARM.danger?' dgr':'')+'"'):'')+'>'
    +'<i></i><b>'+esc(ARM?('HOLD TO '+(ARM.verb||'CONFIRM')):'')+'</b></div>';
}
/* What a setting reads as. The value, in the words the panel gave it:
   a cycle's own label if it has one, otherwise the value and its unit. */
function sVal(d,v){
  if(d.kind==='cycle'){
    var i=d.opts.indexOf(v);
    if(i<0) return '—';
    var w=(d.labels ? d.labels[i] : String(d.opts[i]))+(d.unit||'');
    /* On auto the mode and the outcome are two different facts and you
       want both - the glass puts the same pair on its own theme tile,
       and only the panel knows what the clock has chosen. */
    if(d.k==='theme' && v==='auto' && (S.now||{}).eff)
      w+=' · '+String(S.now.eff).toUpperCase();
    return w;
  }
  if(d.kind==='range'){
    var u=d.unit||'';
    if(d.unitOf){
      var o=((S.now||{}).set||{})[d.unitOf];
      if(o!=null) u=' '+String(o).toUpperCase();
    }
    return String(v)+u;
  }
  return '';
}
/* The radios, as a status and nothing else: no switch, no scan, no
   join. Fetched when this sheet opens and at no other time - the panel
   only asks while its own drawer is open, for the reason its comment
   gives, and the phone makes the same deal. Drawn as a dash until the
   answer lands, so the sheet opens at once rather than waiting out a
   Bluetooth read that costs two seconds on real hardware. */
var RAD=null;
function radGet(){
  RAD=null;
  get('/r/radios?t='+encodeURIComponent(T), function(j){
    if(!j || !j.ok) return;
    RAD=j;
    if(SHEET==='set') shPaint();
  });
}
function radName(d){
  return d.ap ? 'HOTSPOT' : d.bus==='usb' ? 'USB' : 'BUILT-IN';
}
/* The one line you opened this to read: what it is ON. */
function radWhat(d){
  if(!d.up)  return 'OFF';
  if(d.ssid) return d.ssid;
  return d.conn ? 'ON' : 'NOT JOINED';
}
function radTile(ico,top,sub,off){
  return '<div class="rtile'+(off?' off':'')+'">'+ico
    +'<em>'+esc(top)+'</em><u>'+esc(sub)+'</u></div>';
}
function radRows(){
  if(!RAD){
    return '<div class="sgrp">RADIOS</div><div class="rtier">'
      + radTile('<svg class="gl" viewBox="0 0 24 24"></svg>',
                '…','ASKING THE BOAT',1)+'</div>';
  }
  var t='', w=RAD.wifi||{}, b=RAD.bt||{};
  (w.available ? (w.devices||[]) : []).forEach(function(d){
    t+=radTile(icoWifi(d), radName(d), radWhat(d), !d.up);
  });
  if(b.available)
    t+=radTile('<svg class="gl" viewBox="0 0 24 24">'+ICO_BT+'</svg>',
               'BLUETOOTH',
               !b.on ? 'OFF'
                     : (b.names||[]).length ? b.names.join(', ') : 'NOTHING ON IT',
               !b.on);
  return t ? '<div class="sgrp">RADIOS</div><div class="rtier">'+t+'</div>'
           : '';
}

/* The alarm's two zones as the panel computes them, drawn as widths.
   Nothing here decides where a zone ENDS - the bar's full scale is 40
   feet or 12 metres and that is the panel's arithmetic. */
function dBar(at){
  var b=(S.now||{}).bar;
  if(!b || !(b.max>0)) return '';
  /* `at` previews a thumb still moving. An argument rather than a
     write into S.now, so the only copy of what the boat is set to
     stays the one the boat sent - a drag let go of where no change
     fires used to leave the bar drawing one number under a label that
     said another, with nothing to correct it.
     Scaled by the ratio the PANEL sent, not a copy of its rule: warn
     is twice alarm on the glass today, and the day it stops being
     twice, a phone holding its own 2 draws a zone the boat has not. */
  if(at!=null && b.alarm>0)
    b={max:b.max, alarm:at, warn:at*(b.warn/b.alarm)};
  var pc=function(n){ return Math.max(0, Math.min(100, n/b.max*100)); };
  var a=pc(b.alarm), w=pc(b.warn);
  return '<div class="dbar"><i class="al" style="width:'+a+'%"></i>'
    +'<i class="wa" style="left:'+a+'%;width:'+Math.max(0,w-a)+'%"></i></div>'
    +'<div class="dscale"><span>0</span><span>'+esc(String(Math.round(b.max/2)))
    +'</span><span>'+esc(String(b.max))+'</span></div>';
}

function stRows(){
  var h=shHead('SETTINGS')+radRows(), set=(S.now||{}).set||{}, last='';
  var tiles='';
  var flush=function(){
    if(tiles){ h+='<div class="stier">'+tiles+'</div>'; tiles=''; }
  };
  (S.settings||[]).forEach(function(d){
    if(d.g && d.g!==last){ flush(); last=d.g;
                           h+='<div class="sgrp">'+esc(d.g)+'</div>'; }
    var v=set[d.k];
    if(d.tile){
      /* Held back and laid out side by side at the end of their card,
         which is where the Display card puts them on the glass. */
      tiles+='<button class="stile" data-sk="'+esc(d.k)+'">'
        +(d.k==='theme' ? tly(v) : icoSaver(sVal(d,v)))
        +'<u>'+esc(d.name.toUpperCase())+'</u>'
        +'<b>'+esc(sVal(d,v))+'</b></button>';
      return;
    }
    if(d.kind==='toggle'){
      h+='<button class="srow'+(v?' on':'')+'" data-sk="'+esc(d.k)+'">'
        +'<s>'+esc(d.name)+'</s><span class="sw"><i></i></span></button>';
    }else if(d.kind==='action'){
      h+='<button class="srow act" data-sk="'+esc(d.k)+'">'
        +'<s>'+esc(d.name)+'</s><b>TEST</b></button>';
    }else if(d.kind==='range'){
      /* A slider, not a stepper. The glass has a + and a - because a
         capacitive panel at sea wants discrete targets; a thumb on
         glass you are holding does not, and the alarm you want is two
         or three steps away, not fifteen. */
      h+='<div class="srow rng" data-sk="'+esc(d.k)+'">'
        +'<s>'+esc(d.name)+'</s><b>'+esc(sVal(d,v))+'</b>'
        +(d.bar ? dBar() : '')
        +'<input type="range" min="'+d.min+'" max="'+d.max+'" step="'
        +(d.step||1)+'" value="'+(v==null?d.min:v)+'"></div>';
    }else{
      h+='<button class="srow" data-sk="'+esc(d.k)+'">'
        +'<s>'+esc(d.name)+'</s><b>'+esc(sVal(d,v))+'</b></button>';
    }
  });
  flush();
  return h+'</div>';
}

/* Tapping the armed one again disarms it, which is the way out without
   doing anything - the same way the glass's armed tile works, and the
   reason neither needs a caption saying so. */
function pwArm(a){ ARM=(ARM&&ARM.a===a.a)?null:a; shPaint(); }

function holdStop(ok){
  clearTimeout(HT); HT=null;
  var h=document.getElementById('hold'); if(!h) return;
  var bar=h.querySelector('i');
  if(bar){ bar.style.transition='none'; bar.style.width=ok?'100%':'0'; }
}
function holdGo(){
  var a=ARM; if(!a) return;
  var h=document.getElementById('hold'), bar=h&&h.querySelector('i');
  if(!bar) return;
  bar.style.transition='width '+HOLD_MS+'ms linear';
  bar.style.width='100%';
  HT=setTimeout(function(){
    HT=null;
    /* A shutdown takes netd down with everything else, so no answer is
       the success case for those two - saying NO ANSWER FROM THE BOAT
       there would read as a failure at the exact moment it worked. */
    var heavy=(a.a==='poweroff'||a.a==='reboot');
    say(a.name.toUpperCase()+'…');
    pwPost(a, heavy);
  }, HOLD_MS);
}
function pwPost(a,heavy){
  var x=new XMLHttpRequest();
  x.open('POST','/r/power?t='+T);
  x.setRequestHeader('Content-Type','application/json');
  x.onload=function(){
    var j={}; try{ j=JSON.parse(x.responseText); }catch(e){}
    if(x.status!==200 || !j.ok){
      holdStop(false);
      return say(j.error||('HTTP '+x.status));
    }
    say(a.a==='poweroff' ? 'SHUTTING DOWN…'
      : a.a==='reboot'   ? 'REBOOTING…'
      : a.a==='reload'   ? 'RELOADING THE PANEL…' : 'DONE');
    if(!heavy) shAuto=setTimeout(function(){ shOpen(null); }, 1400);
  };
  x.onerror=function(){
    if(heavy) return say('GOING DOWN…');
    holdStop(false); say('NO ANSWER FROM THE BOAT');
  };
  x.send(JSON.stringify({action:a.a}));
}

/* A tap on the dim itself puts it away - the glass's own sheet does
   the same, and on a phone it is the gesture a thumb makes before it
   finds CLOSE. Only on the scrim ITSELF: a tap that lands on the box
   is a tap on the box. */
document.getElementById('scrim').addEventListener('click',function(e){
  if(e.target.id==='scrim') shOpen(null);
});
document.getElementById('sheet').addEventListener('click',function(e){
  if(e.target.closest('[data-shx]')) return void shOpen(null);
  var sr=e.target.closest('[data-sk]');
  if(sr && !e.target.closest('input')){
    var d=(S.settings||[]).filter(function(x){ return x.k===sr.dataset.sk; })[0];
    if(!d || d.kind==='range') return;
    var cur=((S.now||{}).set||{})[d.k], nv;
    if(d.kind==='toggle')      nv=!cur;
    else if(d.kind==='action') nv=null;
    else nv=d.opts[(d.opts.indexOf(cur)+1)%d.opts.length];   /* round */
    return void sSend(d, nv);
  }
  var r=e.target.closest('[data-pa]');
  if(!r) return;
  var a=(S.power||[]).filter(function(x){ return x.a===r.dataset.pa; })[0];
  if(a) pwArm(a);
});

/* The slider reports continuously while a thumb is on it and that is a
   command each time, so only the value you let go of is sent. The
   number beside the label follows the thumb, because a slider whose
   readout waits for the boat is a slider you cannot aim. */
document.getElementById('sheet').addEventListener('input',function(e){
  var sr=e.target.closest('[data-sk]'); if(!sr) return;
  DRAG=true;
  var d=(S.settings||[]).filter(function(x){ return x.k===sr.dataset.sk; })[0];
  var b=sr.querySelector('b');
  if(b && d) b.textContent=sVal(d, +e.target.value);
  /* The picture follows the thumb too. One that waited for the boat
     would be a picture of the number you had before you moved it. */
  if(d && d.bar){
    var old=sr.querySelector('.dbar'), sc=sr.querySelector('.dscale');
    var tmp=document.createElement('div');
    tmp.innerHTML=dBar(+e.target.value);
    /* Both halves or neither: dBar has its own reasons to draw nothing
       - no bar on the wire yet, a scale of zero - and replaceChild
       with nothing to put there throws on every move of the thumb. */
    if(old && sc && tmp.children.length===2){
      sr.replaceChild(tmp.firstChild, old);
      sr.replaceChild(tmp.firstChild, sc);
    }
  }
});
document.getElementById('sheet').addEventListener('change',function(e){
  DRAG=false;
  var sr=e.target.closest('[data-sk]'); if(!sr) return;
  var d=(S.settings||[]).filter(function(x){ return x.k===sr.dataset.sk; })[0];
  if(d) sSend(d, +e.target.value);
});

/* Shown before the boat has answered, like a slot and like the clock.
   An action has nothing to show, so it says it went instead. */
function sSend(d,v){
  if(d.kind!=='action'){
    S.now=S.now||{}; S.now.set=S.now.set||{};
    S.now.set[d.k]=v;
    shPaint();
  }
  /* The theme keeps its own command kind: netd checks it against the
     themes the panel registered, which is a tighter check than the
     catalogue's, and the panel delegates both to one apply. */
  post(d.k==='theme' ? {kind:'theme', theme:v} : {kind:'set', k:d.k, v:v},
       function(){
    if(d.kind==='action') say(d.name.toUpperCase());
    /* The panel is the one that knows what a setting turned into -
       flipping FEET to METRES converts the alarm with it, and the
       phone must not be left showing the number from before. */
    reloadSoon();
  });
}
/* pointerdown rather than touchstart: one path for a finger and for the
   mouse a probe uses, and pointercancel is what a scroll or an incoming
   call looks like - both have to let go of the bar. */
['pointerdown'].forEach(function(ev){
  document.getElementById('sheet').addEventListener(ev,function(e){
    if(!e.target.closest('#hold.on')) return;
    e.preventDefault(); holdStop(false); holdGo();
  });
});
['pointerup','pointercancel','pointerleave'].forEach(function(ev){
  document.getElementById('sheet').addEventListener(ev,function(e){
    DRAG=false;
    if(HT) holdStop(false);
  });
});



['pointerdown','pointerup','pointercancel','pointerleave'].forEach(
  function(ev){
    document.getElementById('main').addEventListener(ev,function(e){
      if(!e.target.closest('.tmz')) return;
      if(ev==='pointerdown'){ e.preventDefault(); return gStart(); }
      if(ev==='pointerup')  return gEnd();
      gOff();                       /* a scroll or an incoming call */
    });
  });

document.getElementById('main').onclick=function(e){
  var f=e.target.closest('[data-f]');
  if(f){
    PG=f.dataset.f; shut();
    /* And turn the glass with it. A phone showing the music page while
       the panel shows the dial is a mirror of something nobody is
       looking at. Sent after the switch, not waited on: the tab is the
       phone's own and should not stutter on the wifi. */
    post({kind:'page', page:PG});
    return;
  }
  var tb=e.target.closest('[data-by]');
  if(tb){
    /* CSS stops a finger landing on a dimmed one; this stops everything
       else, and is the half that can be checked. netd refuses the nudge
       as well - three guards for one press, because the press that gets
       through moves the start of a race that has already started. */
    if(tb.classList.contains('off')) return;
    var by=+tb.dataset.by;
    /* Moved here before the boat has answered, like a slot is: a clock
       that waits a second and a half to admit a press is a clock you
       press twice. */
    TM.ms=Math.max(0, TM.ms+by*1000); tmRun();
    post({kind:'timer', by:by});
    return;
  }
  var z=e.target.closest('[data-s]');
  if(z){ if(OPEN && OPEN.p===z.dataset.p && OPEN.s===z.dataset.s) shut();
         else pick(z.dataset.p, z.dataset.s); }
};
document.querySelector('.top').onclick=function(e){
  /* Only reachable with nothing up: the header fades under the dim
     with the rest of the page, so the way out of a sheet is CLOSE or a
     tap on the dim, and the way to the other one is through there. */
  if(SHEET) return;
  if(e.target.closest('#pwb')) return void shOpen('power');
  if(e.target.closest('#thb')) return void shOpen('set');
};

/* ---- the clock's three gestures --------------------------------------
   The glass's own, with the glass's own two numbers: 320 ms is the
   double-tap window it uses, 700 ms the hold. Nothing here decides what
   a gesture MEANS - timerGesture() on the panel does, because only the
   boat knows which state it is in and this app's copy is up to four
   seconds old. Sending the gesture rather than the transition is what
   keeps the two from ever disagreeing.

     tap ........ idle: start the five minute prep
                  counting down: sync to the nearest whole minute
     double ..... counting down: you crossed, start the race clock
                  racing: finished, freeze the elapsed time
     hold ....... any state: back to idle                           */
var G_DBL=320, G_HOLD=700;
var gLast=0, gTap=null, gHold=null;
function gFire(k){
  clearTimeout(gTap); gTap=null;
  post({kind:'clock', do:k});
  /* The phone cannot say what that did - it does not know for certain
     what state the boat was in. Rather than guess and correct itself a
     second later it says it is waiting, and asks again just past the
     panel's next poll. */
  TM.wait=true; tmRun();
  setTimeout(load, 1800);
}
function gStart(){
  clearTimeout(gHold);
  gHold=setTimeout(function(){ gHold=null; gLast=0; gFire('hold'); }, G_HOLD);
}
function gEnd(){
  /* gHold is the whole of "a press is live": set when one lands on the
     zone, cleared when the hold fires. So this one line covers both a
     release the hold already answered - which must not ALSO be a tap,
     or a reset would be followed by a countdown - and a release that
     began somewhere else. A second flag alongside it said the same
     thing twice, and no control could make either of them fail. */
  if(!gHold) return;
  clearTimeout(gHold); gHold=null;
  var now=performance.now();
  if(now-gLast < G_DBL){ gLast=0; return gFire('double'); }
  gLast=now;
  /* One double-tap window, so the first half of a double never fires
     the single action - the glass waits the same 320 ms for the same
     reason. */
  clearTimeout(gTap);
  gTap=setTimeout(function(){ gTap=null; gFire('tap'); }, G_DBL);
}
function gOff(){ clearTimeout(gHold); gHold=null; }

/* Redrawn on its own, not through draw(): the whole face is a string
   and rebuilding it twice a second would throw away the card, the lit
   zone and any scroll in it. Only the numerals move. */
var tmTick=0;
function tmRun(){
  clearTimeout(tmTick);
  var el=document.querySelector('.fv .tm');
  if(el){ el.textContent=tmTxt(tmLeft());
          el.classList.toggle('wait', !!TM.wait); }
  if(TM.st==='countdown'||TM.st==='racing') tmTick=setTimeout(tmRun, 250);
}

function paint(){
  var p=(S.now||{}).pal||{}, r=document.documentElement;
  for(var k in p) r.style.setProperty('--'+k, p[k]);
  var m=document.querySelector('meta[name=theme-color]');
  if(m && p.bg) m.setAttribute('content', p.bg);
}

/* While the clock is MOVING the phone asks again every four seconds,
   so its own count cannot drift from the glass's and a nudge made at
   the panel shows up here. Idle, it asks for nothing: the figure is not
   going anywhere and the app was deliberately fetch-once. */
var reTick=0;
function reSync(){
  clearTimeout(reTick);
  if(TM.st!=='countdown' && TM.st!=='racing') return;
  reTick=setTimeout(function(){ if(!document.hidden) load(); else reSync(); },
                    4000);
}

function load(){
  get('/r/state?t='+encodeURIComponent(T),function(j){
    if(!j.ok){ say(j.error||'NOT ARMED'); return; }
    S=j; S.now=S.now||{};
    var t=S.now.t;
    if(t){ TM={ms:t.ms, st:t.st, at:performance.now()}; }
    /* The panel's own page, so the tab agrees with the glass when the
       app opens - and when someone has swiped the glass since. */
    if(S.now.page){
      var byIdx=pages().filter(function(k){ return (S.slots[k]||[]).length; });
      byIdx.forEach(function(k){ if(PAGE_OF[k]===S.now.page) PG=k; });
    }
    /* Open on the page with the most to change: the dial has five of
       the eight, and a remote that opens on the other one makes you tap
       twice for the readings you came for. */
    if(!PG||!S.slots[PG]) PG=pages()[0]||'';
    paint(); draw(); tmRun(); reSync();
    /* And the sheet, if one is up. Without this it kept whatever it
       was drawn with: flip FEET to METRES and the panel converts the
       alarm, the next poll brings back 2 M on a 12 M scale, and the
       sheet still said 3 FT over a 40 FT bar - a lying mirror of
       exactly the setting you had just changed.
       Not while a thumb is on a slider. The repaint lands 1.8 s after
       the last change, well inside a slow drag, and rebuilding the row
       under the finger takes the thumb with it. */
    if(SHEET && !DRAG) shPaint();
  });
}
load();
/* A stale row was a wrong word; a stale picture is a lying mirror. */
document.addEventListener('visibilitychange',function(){
  if(!document.hidden) load(); });
</script></body></html>"""


_icon_v = {'at': 0, 'v': ''}


def icon_tag():
    """A short stamp of the icon's own bytes.

    The picture is served with a week of max-age, which is right for
    something that never changes and exactly wrong if the ADDRESS stays
    the same when it does: a new icon then sits behind the old one on
    the phone until the cache lets go. Putting the stamp in the URL
    makes a different icon a different address, and the long max-age
    becomes true rather than a gamble."""
    try:
        st = os.stat(REMOTE_ICON)
    except OSError:
        return ''
    key = (int(st.st_mtime), st.st_size)
    if _icon_v['at'] != key:
        import hashlib
        try:
            with open(REMOTE_ICON, 'rb') as fh:
                _icon_v['v'] = hashlib.sha1(fh.read()).hexdigest()[:8]
        except OSError:
            return ''
        _icon_v['at'] = key
    return _icon_v['v']


def html_q(s):
    """Enough quoting for an attribute. The token is base64url and the
    port is an int, so nothing here can carry a quote - which is exactly
    why it should be escaped rather than trusted to stay that way."""
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def remote_manifest(token):
    """What makes the saved link an app rather than a bookmark.

    start_url carries the token, which is the whole reason the manifest
    needs one to fetch: it is the credential, written down on the phone
    where the home screen can relaunch with it."""
    return {
        # name is what an install prompt and a task switcher show;
        # short_name is the twelve-or-so characters a launcher has room
        # for under an icon, and "Confluence Helm" is not twelve.
        'name': 'Confluence Helm', 'short_name': 'Confluence',
        'start_url': '/r?t=' + token,
        'scope': '/r',
        'display': 'standalone',
        'orientation': 'portrait',
        'background_color': '#0B0C0E', 'theme_color': '#0B0C0E',
        # One icon, 512, declared maskable as well: the artwork sits
        # inside the 80% safe circle, so Android can mask it to whatever
        # shape the launcher uses without taking a bite out of the ring.
        'icons': [{'src': '/r/icon.png?v=' + icon_tag(), 'sizes': '512x512',
                   'type': 'image/png', 'purpose': 'any maskable'}],
    }


class RemoteHandler(BaseHTTPRequestHandler):
    """The phone's door, and the whole of it.

    A different class from Handler on purpose. It has no call path to
    route(), so the twenty-seven endpoints behind that function are not
    reachable from this socket by any request - not because a list says
    so, but because the code to reach them is not here. A route added
    next year inherits that for free.
    """

    server_version = 'helm-remote/1.0'

    def log_message(self, fmt, *a):
        pass

    def handle_error(self, *a):
        # The stdlib default prints a traceback to stderr, and
        # cage-session.sh sends stderr to a file on the SD card. A phone
        # walking out of wifi range is not worth a stack trace, and a
        # stranger probing the port is not worth filling the card.
        pass

    def _ok_here(self):
        """Only the dongle, and only when the kernel is not doing it.

        With SO_BINDTODEVICE the socket itself refuses anything that did
        not arrive on wlan1, so there is nothing to check. Without it -
        an older kernel, or no permission - this is the guarantee
        instead, and it is weaker: it is made here rather than by the
        kernel, and it trusts the source address."""
        if _remote['how'] == 'device':
            return True
        return _same_subnet(self.client_address[0], _remote.get('cidr', ''))

    def _send(self, obj, code=200, ctype='application/json', cache=None):
        payload = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(payload)))
        # Everything here is state and none of it should be cached. The
        # icon is the exception and says so for itself: it is twenty
        # kilobytes that never change, and re-fetching it at every
        # launch is twenty kilobytes over a phone hotspot for nothing.
        self.send_header('Cache-Control', cache or 'no-store')
        # No Access-Control-* at all, ever. The token is only a defence
        # against another page on the phone if a browser will not send
        # the request in the first place.
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        # Refused rather than answered. An obliging preflight would let
        # any page on the phone try its luck and leave the token as the
        # only thing in the way.
        self._send({'ok': False, 'error': 'NO'}, 403)

    def _token(self):
        from urllib.parse import parse_qs, urlparse
        return (parse_qs(urlparse(self.path).query).get('t') or [''])[0]

    def do_GET(self):
        if not self._ok_here():
            return self._send({'ok': False, 'error': 'NOT HERE'}, 403)
        path = urlparse_path(self.path)
        if path == '/r':
            # The token goes into the page so the manifest link carries
            # it: a manifest fetched without one would have to be public,
            # and a public manifest holding start_url would hand the
            # token to anything else on the hotspot.
            page = (REMOTE_PAGE.replace('%T%', html_q(self._token()))
                    .replace('%V%', html_q(icon_tag())))
            return self._send(page.encode(), 200, 'text/html; charset=utf-8')
        if path == '/r/icon.png':
            # No token. It is a picture of the number 45.
            try:
                with open(REMOTE_ICON, 'rb') as fh:
                    png = fh.read()
            except OSError:
                return self._send({'ok': False, 'error': 'NO ICON'}, 404)
            return self._send(png, 200, 'image/png', 'max-age=604800')
        if path == '/r/manifest.webmanifest':
            if not secrets.compare_digest(self._token(), _remote['token']):
                return self._send({'ok': False, 'error': 'BAD TOKEN'}, 403)
            return self._send(remote_manifest(_remote['token']), 200,
                              'application/manifest+json')
        if path == '/r/radios':
            r = _remote
            if not r['armed']:
                return self._send({'ok': False, 'error': 'NOT ARMED'}, 403)
            if not secrets.compare_digest(self._token(), r['token']):
                return self._send({'ok': False, 'error': 'BAD TOKEN'}, 403)
            # Its own route rather than a field on /r/state, because
            # /r/state is fetched on every poll of the start clock and
            # this costs a handful of subprocesses. One is cheap and
            # the other is not, so they are not the same door.
            d = memo('rradios', 4, remote_radios)
            return self._send(dict(d, ok=True))
        if path == '/r/state':
            r = _remote
            if not r['armed']:
                return self._send({'ok': False, 'error': 'NOT ARMED'}, 403)
            if not secrets.compare_digest(self._token(), r['token']):
                return self._send({'ok': False, 'error': 'BAD TOKEN'}, 403)
            return self._send({'ok': True, 'slots': r['slots'],
                               'readings': r['readings'],
                               'themes': r['themes'],
                               'pages': r.get('pages') or {},
                               'names': r.get('names') or {},
                               'tags': r.get('tags') or {},
                               'sens': r.get('sens') or {},
                               'geom': r.get('geom') or {},
                               # What this Pi can actually do right now,
                               # and how long it has been up - the same
                               # two things the glass's sheet shows.
                               'settings': r.get('settings') or [],
                               'power': remote_available_power(),
                               # Off the cached read, like the list
                               # itself. It is a runtime to the minute,
                               # not a clock.
                               'uptime': _remote_power_status()
                                         .get('uptime') or '',
                               'now': r.get('now') or {}})
        return self._send({'ok': False, 'error': 'NO'}, 404)

    def do_POST(self):
        if not self._ok_here():
            return self._send({'ok': False, 'error': 'NOT HERE'}, 403)
        path = urlparse_path(self.path)
        # Its own route rather than another `kind` on /r/cmd, because a
        # kind is QUEUED for the panel to collect and this is run here
        # and now. Filing a shutdown behind the same door as a slot
        # change would also mean a shutdown inheriting the 30-second
        # replay the queue has, which is not a property you want on it.
        if path not in ('/r/cmd', '/r/power'):
            return self._send({'ok': False, 'error': 'NO'}, 404)
        if 'json' not in (self.headers.get('Content-Type') or ''):
            # Stops a cross-origin text/plain POST, which a browser will
            # send with no preflight at all.
            return self._send({'ok': False, 'error': 'JSON ONLY'}, 415)
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
            body = json.loads(self.rfile.read(n) or b'{}') if n else {}
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if path == '/r/power':
            res, code = remote_power(body.get('action'), self._token())
        else:
            res, code = remote_cmd(body, self._token())
        self._send(res, code)


def urlparse_path(p):
    return p.split('?')[0].rstrip('/') or '/'


# Anything that changes a radio invalidates the caches above. One list,
# checked in one place, rather than a bust() sprinkled through the routes.
MUTATING = {'/wifi/power', '/wifi/connect', '/wifi/disconnect', '/wifi/forget',
            '/bt/power', '/bt/connect', '/bt/disconnect', '/bt/forget', '/bt/scan'}

# GET is for reading, and these five are the only routes that read.
#
# do_GET dispatched the WHOLE table with an empty body, so five routes
# did their thing with no body at all - and because every argument came
# back None, they did the worst available version of it:
#
#   GET /wifi/power       wifi_power('', False). find_dev('') falls back
#   GET /wifi/disconnect  to devs[0], and devs sorts onboard before usb -
#                         so the adapter it switches off is wlan0, which
#                         is SeaWire. Harmless once, because disconnect
#                         is a no-op on an idle radio; since the switch
#                         was fixed to write `autoconnect no` it STICKS,
#                         and survives a reboot. The access point is the
#                         only way onto this boat.
#   GET /bt/power         body.get('on') is None, so: off. That is the
#                         start horn's speaker.
#   GET /display/mode     mode != 'kiosk', so: go_windowed. A frameless
#                         round panel, un-fullscreened, with no pointer.
#   GET /display/fit      resets the fit to its default.
#   GET /buzz             sounds the horn.
#
# Loopback keeps the world out, but not a link, a prefetch, a typo in
# this repo, or the file:// fallback page start-kiosk.sh loads when
# AvNav is slow - all of which are the same browser on the same machine.
#
# An ALLOWLIST and not a block list, and deliberately not keyed off
# MUTATING above: that set holds nine radio routes and exists to
# invalidate caches, so it says nothing about /display/mode, /buzz,
# /power/do, /gpx/delete or /score. A guard built on it would look
# complete and leave three of the five live. This way a route added
# later is POST-only until someone decides otherwise.
GET_OK = {'/status', '/bt/list', '/wifi/list', '/display/status',
          '/gpx/list', '/remote/status'}


class Handler(BaseHTTPRequestHandler):
    server_version = 'helm-netd/1.0'

    def log_message(self, fmt, *a):
        pass                              # the kiosk polls; a log would be noise

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _send(self, obj, code=200):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _handle(self, body, method='POST'):
        path = self.path.split('?')[0].rstrip('/') or '/status'
        if method == 'GET' and path not in GET_OK:
            return self._send({'ok': False, 'error': 'POST ONLY'}, 405)
        try:
            res = route(path, body)
            if path in MUTATING:
                bust()
        except Exception as e:                       # a radio wobble is not a 500
            return self._send({'ok': False, 'error': str(e)[:160]}, 200)
        if res is None:
            return self._send({'ok': False, 'error': 'no such endpoint'}, 404)
        self._send(res)

    def do_GET(self):
        self._handle({}, 'GET')

    def do_POST(self):
        try:
            # Bodies used to be WiFi passwords, so 4 kB was generous. A
            # published GPX is a couple of hours of trackpoints, so the
            # cap now follows GPX_MAX - short of that a track arrived
            # truncated, failed to parse, and reported itself as empty.
            n = min(int(self.headers.get('Content-Length') or 0), GPX_MAX + 4096)
            body = json.loads(self.rfile.read(n) or b'{}') if n else {}
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}
        self._handle(body, 'POST')


if __name__ == '__main__':
    cap = capabilities()
    print('[netd] wifi via nmcli: %s   bluetooth via bluetoothctl: %s'
          % ('yes' if cap['nm'] else 'NO', 'yes' if cap['bt'] else 'NO'), flush=True)
    if not (cap['nm'] or cap['bt']):
        print('[netd] neither stack is usable - the panel will hide its tiles', flush=True)
    if cap['nm']:
        _k, _n = kernel_wifi(), [d['dev'] for d in wifi_devices()]
        _lost = [x for x in _k if x not in _n]
        print('[netd] wifi adapters: kernel has %s, NetworkManager reports %s%s'
              % (', '.join(_k) or 'none', ', '.join(_n) or 'none',
                 '   NOT REPORTED: ' + ', '.join(_lost) if _lost else ''),
              flush=True)
        print('[netd] hotspot: %s' % hotspot_pin(), flush=True)
    print('[netd] browser control: %s' % (CHROME or 'NO - chromium not found'), flush=True)
    _b = backlight_status()
    print('[netd] backlight: %s' % ('%s at %d%%' % (_b.get('dev'), _b.get('pct', 0))
          if _b.get('available') else
          'NO - ' + ('present but not writable' if backlight_dev() else 'none exposed')),
          flush=True)
    _bz = buzzer_status()
    if not _bz.get('available'):
        _sd = 'NO - ' + _bz.get('why', '')
    elif _bz['mode'] == 'audio':
        _sd = 'audio out %s (gain %s)' % (_bz['device'], _audio_gain() or 'AS SET')
    else:
        _sd = 'GPIO %d%s' % (_bz['gpio'], ' (inverted)' if BUZZER_INVERT else '')
    print('[netd] sounder: %s' % _sd, flush=True)
    buzz_quiet()
    if _bz.get('mode') == 'audio':
        threading.Thread(target=audio_warm, daemon=True).start()
    print('[netd] listening on %s:%d' % (BIND, PORT), flush=True)
    # Fill the caches before anyone asks. The kiosk often comes up at the
    # same moment this does, and the first /status is the one that decides
    # whether the panel draws its radios or its empty state.
    threading.Thread(target=lambda: (wifi_status(), bt_status()),
                     daemon=True).start()
    # The remote's door, opened here rather than by anything on the
    # glass: this is meant to be an app on a phone that already knows
    # how to connect, so there is nothing to arm. It needs the dongle to
    # have an address, which at boot it often does not yet - hence the
    # watcher, which is also what moves the door when the phone hands
    # out a new lease.
    try:
        up = remote_up()
    except Exception as e:
        up, _ = False, print('[netd] remote: %s' % str(e)[:80], flush=True)
    print('[netd] remote: %s' % (_remote.get('url') or
                                 'waiting for an address on ' + REMOTE_DEV),
          flush=True)
    if up:
        print('[netd] remote: %s'
              % ('pinned to %s by the kernel' % REMOTE_DEV
                 if remote_how() == 'device' else
                 'SO_BINDTODEVICE unavailable - falling back to a subnet '
                 'check, which this file enforces rather than the kernel'),
              flush=True)
    threading.Thread(target=remote_watch, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
