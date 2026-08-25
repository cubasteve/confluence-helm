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

import json, os, re, shutil, subprocess, sys, threading, time
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

MAC = re.compile(r'^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$')
BT_MAC = re.compile(r'^Device ((?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}) (.*)$')


def run(argv, timeout=30):
    """Run a command and return (rc, stdout, stderr).

    Never shell=True. SSIDs and device names are user data, and spaces,
    quotes and semicolons are all legitimate inside one."""
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
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
    _cap['bt'] = bool(shutil.which('bluetoothctl')) and 'No default controller' not in run(['bluetoothctl', 'show'], 6)[1]
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


def wifi_devices():
    """Every managed WiFi adapter and what it is doing.

    One `device show` covers the lot - state, profile and address for all
    of them in a single call - because this is polled, and a subprocess
    per adapter per field adds up fast on a Pi."""
    rc, out, _ = run(['nmcli', '-t', '-f',
                      'GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,'
                      'GENERAL.CONNECTION,IP4.ADDRESS', 'device', 'show'], 15)
    if rc:
        return []
    raw, cur = [], None
    for line in out.splitlines():
        f = terse(line)
        if len(f) < 2:
            continue
        k, v = f[0], f[1]
        if k == 'GENERAL.DEVICE':
            cur = {'dev': v, 'type': '', 'state': '', 'con': '', 'ip': ''}
            raw.append(cur)
        elif cur is None:
            continue
        elif k == 'GENERAL.TYPE':
            cur['type'] = v
        elif k == 'GENERAL.STATE':
            cur['state'] = v                      # e.g. "100 (connected)"
        elif k == 'GENERAL.CONNECTION':
            cur['con'] = '' if v in ('', '--') else v
        elif k.startswith('IP4.ADDRESS') and not cur['ip']:
            cur['ip'] = v.split('/')[0]

    devs = []
    for d in raw:
        if d['type'] != 'wifi' or 'unmanaged' in d['state']:
            continue
        ap = con_is_ap(d['con']) if d['con'] else False
        row = {'dev': d['dev'], 'bus': dev_bus(d['dev']),
               'up': '(connected)' in d['state'],
               'ssid': d['con'], 'ap': ap, 'ip': d['ip'], 'signal': 0,
               'state': d['state'].split('(')[-1].rstrip(')')}
        # Signal is meaningless for an adapter that is itself the AP, and
        # costs a scan to ask for, so only clients get asked.
        if row['up'] and not ap:
            row['signal'] = dev_signal(d['dev'])
        devs.append(row)
    # Onboard first, then dongles: a stable order matters when the tiles
    # carry no words to tell them apart.
    devs.sort(key=lambda r: (r['bus'] == 'usb', r['dev']))
    return devs


def wifi_status():
    if not capabilities()['nm']:
        return {'available': False}
    devs = wifi_devices()
    return {'available': bool(devs), 'radio': wifi_powered(), 'devices': devs}


def find_dev(dev):
    """Resolve a device name from the panel, falling back to the first
    adapter so a single-radio Pi never has to send one."""
    devs = wifi_devices()
    for d in devs:
        if d['dev'] == dev:
            return d
    return devs[0] if devs else None


def saved_wifi():
    rc, out, _ = run(['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'], 8)
    names = set()
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 2 and f[1] == '802-11-wireless':
            names.add(f[0])
    return names


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
    return (err or 'FAILED')[:120]


def wifi_connect(dev, ssid, psk):
    d = find_dev(dev)
    if not d:
        return {'ok': False, 'error': 'NO WIFI ADAPTER'}
    with _lock:
        # A saved profile carries its own key, and re-supplying one we were
        # never given would overwrite it with nothing. So a saved network
        # with no password typed is a plain `connection up`.
        if not psk and ssid in saved_wifi():
            rc, out, err = run(['nmcli', '-w', '35', 'connection', 'up', 'id', ssid,
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
                run(['nmcli', 'connection', 'delete', 'id', ssid], 10)
            return {'ok': False, 'error': wifi_error(err or out)}
    _apmemo.clear()                       # this adapter's role may have changed
    return {'ok': True}


def wifi_power(dev, on):
    """Per-adapter, so one radio can be off while the other stays up.

    This is `device disconnect` / `device connect`, not rfkill: rfkill is
    global on this hardware, so turning one adapter off that way would
    take the other down with it - and on a boat that other one is often
    the hotspot everything else is talking over."""
    d = find_dev(dev)
    if not d:
        return {'ok': False, 'error': 'NO WIFI ADAPTER'}
    with _lock:
        if on:
            # Something else may have rfkilled the lot; an adapter cannot
            # come up underneath that, and the error would not say so.
            if not wifi_powered():
                run(['nmcli', 'radio', 'wifi', 'on'], 20)
            rc, out, err = run(['nmcli', '-w', '30', 'device', 'connect', d['dev']], 45)
        else:
            rc, out, err = run(['nmcli', 'device', 'disconnect', d['dev']], 30)
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
    rc, out, _ = run(['pgrep', '-af', 'chromium|start-kiosk'], 8)
    kiosk = win = loop = other = False
    for line in out.splitlines():
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
            'kiosk': kiosk, 'windowed': win, 'loop': loop, 'other': other}


def go_windowed():
    # The loop first, or it simply puts the kiosk back three seconds later.
    run(['pkill', '-f', 'start-kiosk.sh'], 10)
    run(['pkill', '-f', KIOSK_PAT], 10)
    time.sleep(1.5)
    # If a window already owns the profile - the desktop shortcut - then
    # launching another gets us nothing: Chromium would hand that window
    # the URL and quit. Stopping the kiosk was the whole job.
    if display_status().get('other'):
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
        pct = max(5, min(100, int(pct)))
        with open(d + '/brightness', 'w') as f:
            f.write(str(max(1, int(round(mx * pct / 100.0)))))
        return {'ok': True, 'pct': pct}
    except PermissionError:
        return {'ok': False, 'error': 'NOT WRITABLE'}
    except Exception as e:
        return {'ok': False, 'error': str(e)[:80]}


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
        secs = float(open('/proc/uptime').read().split()[0])
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


def power_status():
    # 'desktop' is offered only when there is a display manager to start
    # AND nothing graphical is already running - on a normal desktop
    # session the tile would be a no-op that switches you to the login
    # screen, which is not what anyone means by it.
    return {'available': HAS_SYSTEMCTL, 'uptime': uptime_txt(),
            'desktop': bool(DM) and not desktop_running()}


def desktop_running():
    if not DM:
        return False
    rc, out, err = run(['systemctl', 'is-active', DM + '.service'], 8)
    return out.strip() == 'active'


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
        rc, out, err = run(['sudo', '-n', '/usr/local/sbin/confluence-to-desktop'], 30)
        if rc == 0:
            return {'ok': True}
        e = (err or out).lower()
        if ('password' in e or 'no tty' in e or 'not allowed' in e
                or 'not permitted' in e or 'sorry' in e):
            return {'ok': False, 'error': 'NOT PERMITTED FROM HERE'}
        return {'ok': False, 'error': (err or out or 'FAILED')[:120]}
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


def gpx_status():
    return {'available': gpx_dir() is not None, 'count': len(gpx_list())}


# --------------------------------------------------------------- http

def route(path, body):
    if path == '/status':
        return {'ok': True, 'wifi': wifi_status(), 'bt': bt_status(),
                'display': display_status(), 'power': power_status(),
                'backlight': backlight_status(), 'gpx': gpx_status()}

    if path == '/display/status':
        return dict(display_status(), ok=True)
    if path == '/display/mode':
        if not CHROME:
            return {'ok': False, 'error': 'NO BROWSER'}
        return later(go_kiosk if body.get('mode') == 'kiosk' else go_windowed)
    if path == '/gpx/list':
        return {'ok': True, 'files': gpx_list()}
    if path == '/gpx/save':
        return gpx_save(str(body.get('name', '')), str(body.get('xml', '')))
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
            rc, _, err = run(['nmcli', 'connection', 'delete', 'id', str(body.get('ssid', ''))[:64]], 20)
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


# Anything that changes a radio invalidates the caches above. One list,
# checked in one place, rather than a bust() sprinkled through the routes.
MUTATING = {'/wifi/power', '/wifi/connect', '/wifi/disconnect', '/wifi/forget',
            '/bt/power', '/bt/connect', '/bt/disconnect', '/bt/forget', '/bt/scan'}


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

    def _handle(self, body):
        path = self.path.split('?')[0].rstrip('/') or '/status'
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
        self._handle({})

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
        self._handle(body)


if __name__ == '__main__':
    cap = capabilities()
    print('[netd] wifi via nmcli: %s   bluetooth via bluetoothctl: %s'
          % ('yes' if cap['nm'] else 'NO', 'yes' if cap['bt'] else 'NO'), flush=True)
    if not (cap['nm'] or cap['bt']):
        print('[netd] neither stack is usable - the panel will hide its tiles', flush=True)
    print('[netd] browser control: %s' % (CHROME or 'NO - chromium not found'), flush=True)
    _b = backlight_status()
    print('[netd] backlight: %s' % ('%s at %d%%' % (_b.get('dev'), _b.get('pct', 0))
          if _b.get('available') else
          'NO - ' + ('present but not writable' if backlight_dev() else 'none exposed')),
          flush=True)
    print('[netd] listening on %s:%d' % (BIND, PORT), flush=True)
    # Fill the caches before anyone asks. The kiosk often comes up at the
    # same moment this does, and the first /status is the one that decides
    # whether the panel draws its radios or its empty state.
    threading.Thread(target=lambda: (wifi_status(), bt_status()),
                     daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
