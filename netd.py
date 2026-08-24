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


def capabilities():
    """What this Pi can actually do, re-probed occasionally.

    Cached because /status is polled while the panel is open and shelling
    out twice a second to learn something that changes once a year is the
    kind of idle work this display is careful not to do."""
    now = time.time()
    if now - _cap['at'] < 30:
        return _cap
    _cap['at'] = now
    # nmcli existing is not enough - it exits non-zero when NetworkManager
    # itself is not running, which is exactly the Bullseye/wpa_supplicant
    # case we want to detect rather than half-support.
    _cap['nm'] = bool(shutil.which('nmcli')) and run(['nmcli', '-t', '-f', 'STATE', 'general'], 6)[0] == 0
    _cap['bt'] = bool(shutil.which('bluetoothctl')) and 'No default controller' not in run(['bluetoothctl', 'show'], 6)[1]
    return _cap


def wifi_dev():
    """First managed WiFi interface, or None."""
    rc, out, _ = run(['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE', 'device'], 8)
    if rc:
        return None
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 3 and f[1] == 'wifi' and f[2] != 'unmanaged':
            return f[0]
    return None


def wifi_powered():
    return run(['nmcli', '-t', '-f', 'WIFI', 'radio'], 6)[1].strip() == 'enabled'


def wifi_status():
    if not capabilities()['nm']:
        return {'available': False}
    powered = wifi_powered()
    st = {'available': True, 'powered': powered, 'ssid': '', 'signal': 0, 'ip': ''}
    dev = wifi_dev()
    if not dev or not powered:
        return st
    rc, out, _ = run(['nmcli', '-t', '-f', 'GENERAL.CONNECTION,IP4.ADDRESS', 'device', 'show', dev], 8)
    for line in out.splitlines():
        f = terse(line)
        if len(f) < 2:
            continue
        if f[0] == 'GENERAL.CONNECTION' and f[1] not in ('', '--'):
            st['ssid'] = f[1]
        elif f[0].startswith('IP4.ADDRESS') and not st['ip']:
            st['ip'] = f[1].split('/')[0]
    if st['ssid']:
        for n in wifi_list()['nets']:
            if n['active']:
                st['signal'] = n['signal']
                break
    return st


def saved_wifi():
    rc, out, _ = run(['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'], 8)
    names = set()
    for line in out.splitlines():
        f = terse(line)
        if len(f) >= 2 and f[1] == '802-11-wireless':
            names.add(f[0])
    return names


def wifi_list(rescan=False):
    if not capabilities()['nm']:
        return {'available': False, 'nets': []}
    fields = 'IN-USE,SSID,SIGNAL,SECURITY'
    argv = ['nmcli', '-t', '-f', fields, 'device', 'wifi', 'list',
            '--rescan', 'yes' if rescan else 'auto']
    rc, out, err = run(argv, 40 if rescan else 15)
    if rc:
        # --rescan landed in nmcli 1.12. On anything older the flag is the
        # only thing wrong with the command, so drop it and try again.
        rc, out, err = run(argv[:-2], 15)
        if rc:
            return {'available': True, 'powered': wifi_powered(), 'nets': [],
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
    return {'available': True, 'powered': wifi_powered(), 'nets': nets}


def wifi_error(err):
    """nmcli's failures, in words that fit on a tile."""
    e = (err or '').lower()
    if 'secrets were required' in e or 'no secrets' in e or '802-11-wireless-security.psk' in e:
        return 'WRONG PASSWORD'
    if 'timeout' in e or 'timed out' in e:
        return 'TIMED OUT'
    if 'not authorized' in e or 'not permitted' in e or 'access denied' in e:
        return 'NOT PERMITTED'
    if 'no network with ssid' in e:
        return 'OUT OF RANGE'
    return (err or 'FAILED')[:120]


def wifi_connect(ssid, psk):
    dev = wifi_dev()
    if not dev:
        return {'ok': False, 'error': 'NO WIFI ADAPTER'}
    with _lock:
        # A saved profile carries its own key, and re-supplying one we were
        # never given would overwrite it with nothing. So a saved network
        # with no password typed is a plain `connection up`.
        if not psk and ssid in saved_wifi():
            rc, out, err = run(['nmcli', '-w', '35', 'connection', 'up', 'id', ssid], 45)
        else:
            argv = ['nmcli', '-w', '35', 'device', 'wifi', 'connect', ssid, 'ifname', dev]
            if psk:
                argv += ['password', psk]
            rc, out, err = run(argv, 45)
        if rc:
            # A rejected key leaves a broken profile behind that would then
            # be offered as "saved" and fail forever. Bin it.
            if psk:
                run(['nmcli', 'connection', 'delete', 'id', ssid], 10)
            return {'ok': False, 'error': wifi_error(err or out)}
    return {'ok': True}


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

    if path == '/wifi/list':
        return dict(wifi_list(rescan=bool(body.get('rescan'))), ok=True)
    if path == '/wifi/power':
        on = 'on' if body.get('on') else 'off'
        with _lock:
            rc, _, err = run(['nmcli', 'radio', 'wifi', on], 20)
        return {'ok': rc == 0, 'error': wifi_error(err)}
    if path == '/wifi/connect':
        ssid = str(body.get('ssid', ''))[:64]
        psk = str(body.get('psk', ''))[:96]
        return wifi_connect(ssid, psk) if ssid else {'ok': False, 'error': 'NO SSID'}
    if path == '/wifi/disconnect':
        dev = wifi_dev()
        with _lock:
            rc, _, err = run(['nmcli', 'device', 'disconnect', dev], 20) if dev else (1, '', 'no adapter')
        return {'ok': rc == 0, 'error': wifi_error(err)}
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
