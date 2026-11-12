#!/usr/bin/env python3
"""netd's HTTP door, as opposed to its route table.

Every other netd probe calls route() directly, which is why none of
them could see this: do_GET dispatched the WHOLE table with an empty
body, so five routes did their thing with no body at all - and with
every argument None, the worst available version of it.

The one that matters: GET /wifi/power is wifi_power('', False);
find_dev('') falls back to devs[0]; devs sorts onboard before usb. So
the adapter it switches off is wlan0, which carries SeaWire, the only
way onto this boat. That was survivable while disconnect was a no-op
on an idle radio. Once the switch was fixed to write `autoconnect no`
it sticks, and survives a reboot.

Loopback keeps the world out. It does not keep out a link, a prefetch,
a typo in this repo, or the file:// page start-kiosk.sh falls back to
when AvNav is slow - all the same browser on the same machine.

    python3 tests/netdhttp_test.py
"""
import json, os, sys, threading, unittest, urllib.error, urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from wifi_test import rig, calls, ONBOARD, MAC_USB          # noqa: E402

DONGLE = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
          'state': '30 (disconnected)', 'con': '', 'auto': 'yes'}


class Server:
    """netd's real Handler on a real socket, over a pretend nmcli."""

    def __init__(self, netd):
        self.netd = netd
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), netd.Handler)
        self.port = self.srv.server_address[1]
        self.t = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.t.start()

    def req(self, path, body=None):
        url = 'http://127.0.0.1:%d%s' % (self.port, path)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(
            url, data=data, method='POST' if data else 'GET',
            headers={'Content-Type': 'application/json'} if data else {})
        try:
            with urllib.request.urlopen(r, timeout=5) as f:
                return f.status, json.loads(f.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class Door(unittest.TestCase):

    # The five that acted on an empty body, and what they did.
    DANGEROUS = ['/wifi/power', '/wifi/disconnect', '/bt/power',
                 '/display/mode', '/display/fit', '/buzz']

    def test_a_bodyless_get_cannot_switch_a_radio_off(self):
        """The whole reason this file exists."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            s = Server(netd)
            try:
                code, body = s.req('/wifi/power')
                self.assertEqual(code, 405, body)
                self.assertEqual(body.get('error'), 'POST ONLY', body)
                # and nothing reached nmcli
                self.assertFalse([c for _, c in calls()
                                  if 'device set' in c or 'disconnect' in c],
                                 calls())
                # the onboard radio - SeaWire - is still on
                d = [x for x in netd.wifi_devices() if x['dev'] == 'wlan0'][0]
                self.assertTrue(d['up'], d)
            finally:
                s.close()

    def test_none_of_the_five_answer_a_get(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            s = Server(netd)
            try:
                for p in self.DANGEROUS:
                    code, body = s.req(p)
                    self.assertEqual(code, 405, '%s -> %s %s' % (p, code, body))
            finally:
                s.close()

    def test_the_two_the_panel_actually_gets_still_work(self):
        """netApi sends GET only when there is no body, and exactly two
        call sites are bodyless. netd.sh and wifi-report.sh also curl
        /status with no -X, and a 405 there would make the single-instance
        guard respawn netd for ever."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            s = Server(netd)
            try:
                for p in ('/status', '/bt/list'):
                    code, body = s.req(p)
                    self.assertEqual(code, 200, '%s -> %s' % (p, body))
                    self.assertTrue(body.get('ok') or 'wifi' in body, body)
            finally:
                s.close()

    def test_the_bare_root_is_still_status(self):
        """`self.path.rstrip('/') or '/status'` - netd.sh relies on it."""
        with rig([], devices=[dict(ONBOARD)]) as netd:
            s = Server(netd)
            try:
                code, body = s.req('/')
                self.assertEqual(code, 200, body)
                self.assertIn('wifi', body)
            finally:
                s.close()

    def test_post_still_reaches_everything(self):
        """The guard is about the METHOD, not about the route."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            s = Server(netd)
            try:
                code, body = s.req('/wifi/power', {'dev': 'wlan1', 'on': True})
                self.assertEqual(code, 200, body)
                self.assertTrue(body.get('ok'), body)
            finally:
                s.close()

    def test_every_route_is_covered_one_way_or_the_other(self):
        """The guard that keeps this true. Enumerate every path in
        route() and require each to be either a declared reader or
        refused on GET - so a route added next year is POST-only until
        somebody decides otherwise, rather than quietly reachable."""
        import re
        src = open(os.path.join(os.path.dirname(HERE), 'netd.py')).read()
        a = src.index('def route(path, body):')
        b = src.index('\nMUTATING', a)
        paths = sorted(set(re.findall(r"path == '([^']+)'", src[a:b])))
        self.assertGreater(len(paths), 20, 'did the route table move?')
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            stray = sorted(set(netd.GET_OK) - set(paths) - {'/'})
            self.assertFalse(stray, 'GET_OK names routes that do not exist: %s'
                                    % stray)
            s = Server(netd)
            try:
                for p in paths:
                    code, _ = s.req(p)
                    if p in netd.GET_OK:
                        self.assertNotEqual(code, 405, '%s should read' % p)
                    else:
                        self.assertEqual(code, 405,
                                         '%s answers a bodyless GET' % p)
            finally:
                s.close()

    def test_an_unknown_path_is_still_a_404_not_a_405(self):
        """A typo should say what it is, not look like a method problem."""
        with rig([], devices=[dict(ONBOARD)]) as netd:
            s = Server(netd)
            try:
                code, _ = s.req('/nope', {})
                self.assertEqual(code, 404)
            finally:
                s.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
