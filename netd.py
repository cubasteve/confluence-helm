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
    return run(['nmcli', '-t', '-f', 'WIFI', 'radio'], 6)[1].strip() == 'enabled'


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
    return re.search(r'Powered:\s*yes', bt_call(['show'], 8)[1]) is not None


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


# --------------------------------------------------------------- http

def route(path, body):
    if path == '/status':
        return {'ok': True, 'wifi': wifi_status(), 'bt': bt_status()}

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
        except Exception as e:                       # a radio wobble is not a 500
            return self._send({'ok': False, 'error': str(e)[:160]}, 200)
        if res is None:
            return self._send({'ok': False, 'error': 'no such endpoint'}, 404)
        self._send(res)

    def do_GET(self):
        self._handle({})

    def do_POST(self):
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
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
    print('[netd] listening on %s:%d' % (BIND, PORT), flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
