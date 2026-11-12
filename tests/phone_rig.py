#!/usr/bin/env python3
"""The phone's half, on a real socket, for tests/phone.mjs.

Started by that probe, not run by hand. It registers a catalogue, opens
netd's RemoteHandler on loopback and adds two routes of its own: /peek,
so the probe can see what the phone's taps actually queued, and /poke,
which says what page the panel is showing - there is no panel here to
say it. Both are the probe's rig and not part of the remote: what is and
is not reachable on that socket is remote_test.py's business.
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
                               'now': netd._remote.get('now') or {}})
        # Which page the PANEL says it is showing. There is no panel
        # here, so the probe says it - the alternative is a probe that
        # can only ever see the two halves already agreeing, which is
        # the case the code is not for.
        if self.path.split('?')[0] == '/poke':
            q = urllib.parse.parse_qs(self.path.partition('?')[2])
            now = netd._remote.get('now') or {}
            now['page'] = int(q['page'][0])
            return self._send({'ok': True, 'page': now['page']})
        return netd.RemoteHandler.do_GET(self)


with open(ARGS[0]) as f:
    cat = json.load(f)
netd._remote.update(armed=True, token='T0KEN', how='device', cidr='')
r = netd.remote_register(cat)
assert r['ok'], r
# remote_register calls remote_up(), which finds no wlan1 in a container
# and shuts the door again. The socket here is the probe's.
netd._remote.update(armed=True, how='device')

srv = ThreadingHTTPServer(('127.0.0.1', 0), Rig)
print(srv.server_address[1], flush=True)
srv.serve_forever()
