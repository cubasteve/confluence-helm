#!/usr/bin/env python3
"""The phone's half, on a real socket, for tests/phone.mjs.

Started by that probe, not run by hand. It registers a catalogue, opens
netd's RemoteHandler on loopback and adds two routes of its own: /peek,
so the probe can see what the phone's taps actually queued and what it
asked the device to do, and /poke, which says what page the panel is
showing - there is no panel here to say it. Both are the probe's rig and
not part of the remote: what is and is not reachable on that socket is
remote_test.py's business.

power_do and power_status are replaced here. The first would reboot the
machine running the probe; the second would answer for a container
rather than for a Pi, so the sheet would be empty and every assertion
about it would pass by being about nothing.
"""
import json, os, sys, threading, urllib.parse
from http.server import ThreadingHTTPServer

ARGS = sys.argv[1:]
sys.argv = [sys.argv[0]]                 # netd reads argv[1] as its port
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ['HELM_REMOTE_PORT'] = '0'
os.environ['HELM_REMOTE_CFG'] = os.path.join(ARGS[1], 'remote.json')
sys.path.insert(0, os.path.dirname(HERE))
import netd                                                  # noqa: E402


class Rig(netd.RemoteHandler):
    def do_GET(self):
        if self.path.split('?')[0] == '/peek':
            return self._send({'ok': True, 'pend': netd._remote['pend'],
                               'did': DID,
                               'now': netd._remote.get('now') or {}})
        # Which page the PANEL says it is showing. There is no panel
        # here, so the probe says it - the alternative is a probe that
        # can only ever see the two halves already agreeing, which is
        # the case the code is not for.
        if self.path.split('?')[0] == '/poke':
            q = urllib.parse.parse_qs(self.path.partition('?')[2])
            now = netd._remote.get('now') or {}
            if 'page' in q:
                now['page'] = int(q['page'][0])
            # The shallow alarm's scale, which on a real boat moves when
            # somebody flips FEET to METRES and the panel converts. There
            # is no panel here to convert it.
            if 'max' in q:
                now.setdefault('bar', {})
                now['bar'] = {'max': int(q['max'][0]),
                              'alarm': int(q.get('alarm', ['2'])[0]),
                              'warn': int(q.get('warn', ['4'])[0])}
            return self._send({'ok': True, 'now': {'page': now.get('page'),
                                                   'bar': now.get('bar')}})
        return netd.RemoteHandler.do_GET(self)


with open(ARGS[0]) as f:
    cat = json.load(f)
# The power sheet, with the power taken out of it. A probe that let
# power_do() through would reboot the machine running the probe, and
# power_status() would otherwise answer for THIS container rather than
# for a Pi - so the rig says what is available and records what was
# asked for, and /peek hands both back.
DID = []
netd.power_status = lambda: {'available': True, 'uptime': '3d 4h',
                             'desktop': True, 'cage': False}


def _did(action):
    DID.append(action)
    return {'ok': True}


netd.power_do = _did

# Radios, too. This container has neither, and a real wifi_status() here
# would answer for the machine running the probe rather than for a boat.
netd.wifi_status = lambda: {'available': True, 'radio': True, 'devices': [
    {'dev': 'wlan0', 'bus': 'builtin', 'up': True, 'conn': True, 'ap': True,
     'ssid': 'CONFLUENCE', 'signal': 0},
    {'dev': 'wlan1', 'bus': 'usb', 'up': True, 'conn': True, 'ap': False,
     'ssid': 'MARINA-GUEST', 'signal': 72},
    {'dev': 'wlan2', 'bus': 'usb', 'up': False, 'conn': False, 'ap': False,
     'ssid': '', 'signal': 0, 'ip': '10.0.0.9', 'state': 'disconnected'},
]}
netd.bt_status = lambda: {'available': True, 'powered': True,
                          'connected': ['JBL FLIP'], 'scanning': False}

netd._remote.update(armed=True, token='T0KEN', how='device', cidr='')
r = netd.remote_register(cat)
assert r['ok'], r
# remote_register calls remote_up(), which finds no wlan1 in a container
# and shuts the door again. The socket here is the probe's.
netd._remote.update(armed=True, how='device')

srv = ThreadingHTTPServer(('127.0.0.1', 0), Rig)
print(srv.server_address[1], flush=True)
srv.serve_forever()
