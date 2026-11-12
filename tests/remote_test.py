#!/usr/bin/env python3
"""The phone remote's door.

A settings remote: it changes WHICH reading sits in which slot, and the
theme. No boat data crosses - the payload is slot names and reading
keys, so the phone never learns the depth.

The property these tests exist for is the one the repo's own docs warn
about (docs/network.md): "There is no auth in the service because the
socket makes it unnecessary; if you ever bind it wider, that stops
being true." So the remote does NOT bind netd wider. It gets its own
socket and its own handler class, and that class has no call path to
route() - the twenty-seven endpoints are unreachable from the phone
because the code to reach them is not there, not because a list says
so.

    python3 tests/remote_test.py
"""
import json, os, sys, threading, time, unittest, urllib.error, urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# The token lives in a file so a saved app keeps working across
# reboots, which means these tests would otherwise write into the
# developer's own ~/.config and leak a token between runs.
import atexit, tempfile                                     # noqa: E402
_CFGDIR = tempfile.mkdtemp(prefix='helm-remote-test-')
os.environ['HELM_REMOTE_CFG'] = os.path.join(_CFGDIR, 'remote.json')
os.environ.setdefault('HELM_REMOTE_PORT', '18093')
atexit.register(lambda: __import__('shutil').rmtree(_CFGDIR, ignore_errors=True))
from wifi_test import rig, ONBOARD, MAC_USB                 # noqa: E402

DONGLE = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
          'state': '100 (connected)', 'con': 'Phone', 'auto': 'yes',
          'ip': '172.20.10.3/28'}

SLOTS = {'dial': ['c0', 'c1', 'c2', 'c3', 'c4'], 'mus': ['a', 'p', 's']}
READINGS = [{'k': 'sog', 'sen': 'gps', 'name': 'BOAT SPEED'},
            {'k': 'dpt', 'sen': 'dpt', 'name': 'DEPTH'},
            {'k': 'vmg', 'sen': 'perf', 'name': 'VMG'}]


class Phone:
    """A pretend phone on the dongle's socket."""

    def __init__(self, netd):
        self.netd = netd
        # Bind on loopback and tell the handler the kernel is doing the
        # filtering, which is the shape on a box where SO_BINDTODEVICE
        # works. The subnet fallback gets its own test below.
        netd._remote['how'] = 'device'
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), netd.RemoteHandler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def req(self, path, body=None, ctype='application/json', method=None):
        url = 'http://127.0.0.1:%d%s' % (self.port, path)
        data = json.dumps(body).encode() if body is not None else None
        h = {'Content-Type': ctype} if data else {}
        r = urllib.request.Request(url, data=data, headers=h,
                                   method=method or ('POST' if data else 'GET'))
        try:
            with urllib.request.urlopen(r, timeout=5) as f:
                return f.status, f.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def js(self, *a, **k):
        code, raw = self.req(*a, **k)
        try:
            return code, json.loads(raw or b'{}')
        except ValueError:
            return code, {}

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def armed(netd):
    """Arm without opening a real socket - the socket is the one thing
    that cannot be exercised in a container with no wlan1."""
    netd._remote.update(
        armed=True, token='T0KEN', how='device', pend={}, at=0.0,
        slots=SLOTS, readings=[r['k'] for r in READINGS],
        themes=['day', 'dusk', 'night', 'auto'],
        cidr='172.20.10.3/28', now={'slots': {'dial:c1': 'dpt'}, 'theme': 'dusk'})


class Door(unittest.TestCase):

    def test_netds_own_endpoints_are_not_there_at_all(self):
        """The whole point. Not refused by a list - absent, because
        RemoteHandler has no call path to route()."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for path in ('/status', '/wifi/power', '/wifi/disconnect',
                             '/power/do', '/display/mode', '/buzz',
                             '/gpx/delete', '/bt/power'):
                    for u in (path, path + '?t=T0KEN'):
                        code, _ = p.js(u)
                        self.assertEqual(code, 404, '%s answered %s' % (u, code))
                        code, _ = p.js(u, {'on': False})
                        self.assertEqual(code, 404, '%s answered POST' % u)
                # and the onboard radio - SeaWire - was never touched
                d = [x for x in netd.wifi_devices() if x['dev'] == 'wlan0'][0]
                self.assertTrue(d['up'], d)
            finally:
                p.close()

    def test_the_page_is_served_and_carries_no_boat_data(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                code, raw = p.req('/r')
                self.assertEqual(code, 200)
                self.assertIn(b'<!doctype html>', raw.lower())
                # No reading VALUES anywhere in what the phone receives.
                for word in (b'speedOverGround', b'depthBelow', b'knots'):
                    self.assertNotIn(word, raw)
            finally:
                p.close()

    def test_a_command_needs_the_token(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                cmd = {'kind': 'slot', 'page': 'dial', 'slot': 'c1',
                       'reading': 'vmg'}
                for q in ('', '?t=', '?t=wrong'):
                    code, j = p.js('/r/cmd' + q, cmd)
                    self.assertEqual(code, 403, j)
                self.assertEqual(netd._remote['pend'], {})
                code, j = p.js('/r/cmd?t=T0KEN', cmd)
                self.assertEqual(code, 200, j)
                # That the command LANDED, not what it is filed under:
                # the key shape belongs to the latest-wins probe, and
                # asserting it here made this probe fail for that too.
                pend = list(netd._remote['pend'].values())
                self.assertEqual(len(pend), 1, netd._remote['pend'])
                self.assertEqual(pend[0].get('reading'), 'vmg', pend)
            finally:
                p.close()

    def test_disarmed_takes_commands_from_nobody(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            netd._remote['armed'] = False
            p = Phone(netd)
            try:
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'theme', 'theme': 'night'})
                self.assertEqual(code, 403, j)
                self.assertEqual(j.get('error'), 'NOT ARMED')
            finally:
                p.close()

    def test_a_slot_or_reading_it_does_not_know_is_refused(self):
        """netd validates against what the PANEL said it had. It keeps no
        catalogue of its own: the readings live in the HTML, and a second
        list here would drift the first time one was added."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                bad = [{'kind': 'slot', 'page': 'dial', 'slot': 'c9',
                        'reading': 'vmg'},
                       {'kind': 'slot', 'page': 'nope', 'slot': 'c1',
                        'reading': 'vmg'},
                       {'kind': 'slot', 'page': 'dial', 'slot': 'c1',
                        'reading': 'rm -rf'},
                       {'kind': 'theme', 'theme': 'disco'},
                       {'kind': 'exec', 'cmd': 'reboot'},
                       {}]
                for b in bad:
                    code, j = p.js('/r/cmd?t=T0KEN', b)
                    self.assertEqual(code, 400, '%s -> %s %s' % (b, code, j))
                self.assertEqual(netd._remote['pend'], {})
            finally:
                p.close()

    def test_two_taps_on_one_slot_are_one_change(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for r in ('dpt', 'vmg', 'sog'):
                    p.js('/r/cmd?t=T0KEN', {'kind': 'slot', 'page': 'dial',
                                            'slot': 'c1', 'reading': r})
                drained = netd.remote_poll({})
                self.assertEqual(len(drained['cmds']), 1, drained)
                self.assertEqual(drained['cmds']['slot:dial:c1']['reading'],
                                 'sog')
                self.assertEqual(netd.remote_poll({})['cmds'], {})
            finally:
                p.close()

    def test_a_command_the_panel_never_collected_goes_stale(self):
        """A panel that was asleep should not come back and replay a tap
        from ten minutes ago."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                p.js('/r/cmd?t=T0KEN', {'kind': 'theme', 'theme': 'night'})
                netd._remote['at'] = time.time() - netd.REMOTE_STALE - 1
                self.assertEqual(netd.remote_poll({})['cmds'], {})
            finally:
                p.close()

    def test_a_preflight_is_refused_rather_than_answered(self):
        """An obliging OPTIONS would let any page on the phone try its
        luck and leave the token as the only thing in the way."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                code, raw = p.req('/r/cmd', method='OPTIONS')
                self.assertEqual(code, 403)
                self.assertNotIn(b'Access-Control', raw)
            finally:
                p.close()

    def test_a_non_json_post_is_refused(self):
        """text/plain is a simple request - a browser sends it with no
        preflight at all."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'theme', 'theme': 'night'},
                               ctype='text/plain')
                self.assertEqual(code, 415, j)
            finally:
                p.close()

    def test_no_cors_header_is_ever_sent(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                url = 'http://127.0.0.1:%d/r' % p.port
                with urllib.request.urlopen(url, timeout=5) as f:
                    hdrs = '\n'.join('%s: %s' % kv for kv in f.getheaders())
                self.assertNotIn('Access-Control', hdrs)
            finally:
                p.close()

    def test_the_subnet_fallback_keeps_strangers_out(self):
        """When SO_BINDTODEVICE is unavailable the kernel is not doing
        the filtering and this code is, which is the weaker guarantee -
        so it had better work."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            # After Phone(), which sets how='device' for the usual shape.
            netd._remote['how'] = 'subnet'
            netd._remote['cidr'] = '172.20.10.3/28'
            try:
                # 127.0.0.1 is not in 172.20.10.0/28
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'theme', 'theme': 'night'})
                self.assertEqual(code, 403, j)
                self.assertEqual(j.get('error'), 'NOT HERE')
                netd._remote['cidr'] = '127.0.0.1/8'
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'theme', 'theme': 'night'})
                self.assertEqual(code, 200, j)
            finally:
                p.close()

    def test_the_subnet_maths_is_right(self):
        with rig([], devices=[dict(ONBOARD)]) as netd:
            same = netd._same_subnet
            self.assertTrue(same('172.20.10.5', '172.20.10.3/28'))
            self.assertFalse(same('172.20.10.20', '172.20.10.3/28'))
            self.assertTrue(same('192.168.1.99', '192.168.1.1/24'))
            self.assertFalse(same('192.168.2.1', '192.168.1.1/24'))
            self.assertFalse(same('nonsense', '192.168.1.1/24'))
            self.assertFalse(same('192.168.1.1', ''))

    def test_state_hands_over_names_and_never_values(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                code, j = p.js('/r/state?t=T0KEN')
                self.assertEqual(code, 200, j)
                self.assertEqual(j['slots'], SLOTS)
                self.assertIn('dpt', j['readings'])
                self.assertEqual(j['now']['slots']['dial:c1'], 'dpt')
                code, j = p.js('/r/state?t=wrong')
                self.assertEqual(code, 403, j)
            finally:
                p.close()

    def test_register_refuses_a_catalogue_it_cannot_validate_against(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            for bad in ({}, {'slots': {}}, {'slots': SLOTS},
                        {'slots': SLOTS, 'readings': []},
                        {'slots': {'dial': 'c0'}, 'readings': ['sog']}):
                r = netd.remote_register(bad)
                self.assertFalse(r['ok'], '%s -> %s' % (bad, r))
            self.assertFalse(netd._remote['armed'])


class AlwaysOn(unittest.TestCase):
    """There is nothing to arm and no tile to arm it from. The app on
    the phone is a saved URL that has to keep working across reboots,
    which is what makes the token persist and the door open itself."""

    def test_the_token_survives_a_restart(self):
        """A fresh token per session would break the saved app every
        reboot, which is the opposite of what was asked for."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            first = netd.remote_token()
            self.assertTrue(first)
            self.assertEqual(netd.remote_token(), first, 'it re-minted')
            path = netd.REMOTE_CFG
        self.assertTrue(os.path.isfile(path), path)
        # A second netd, same file.
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd2:
            self.assertEqual(netd2.remote_token(), first,
                             'a restart handed out a different token')

    def test_the_token_file_is_not_world_readable(self):
        with rig([], devices=[dict(ONBOARD)]) as netd:
            netd.remote_token()
            mode = os.stat(netd.REMOTE_CFG).st_mode & 0o777
        self.assertEqual(mode, 0o600, oct(mode))

    def test_the_door_opens_itself_when_the_dongle_has_an_address(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                self.assertTrue(netd.remote_up(), 'it did not come up')
                self.assertTrue(netd._remote['armed'])
                self.assertIn('172.20.10.3', netd._remote['url'])
                self.assertIn(netd.remote_token(), netd._remote['url'])
            finally:
                netd.remote_disarm()

    def test_no_address_means_no_door(self):
        """The dongle on this boat drops. The door should go with it
        rather than listen on a subnet nobody is on."""
        with rig([], devices=[dict(ONBOARD)]) as netd:     # no dongle at all
            self.assertFalse(netd.remote_up())
            self.assertFalse(netd._remote['armed'])

    def test_a_new_lease_moves_the_door(self):
        """The phone is the access point and the Pi is a client on it,
        so the address changes. Only the subnet check cares - the bind
        is on 0.0.0.0 - but it is the subnet check that is doing the
        work when SO_BINDTODEVICE is unavailable."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                netd.remote_up()
                self.assertEqual(netd._remote['cidr'], '172.20.10.3/28')
                netd._dev_subnet = lambda dev: '192.168.43.57/24'
                self.assertTrue(netd.remote_up())
                self.assertEqual(netd._remote['cidr'], '192.168.43.57/24')
                self.assertIn('192.168.43.57', netd._remote['url'])
            finally:
                netd.remote_disarm()

    def test_coming_up_twice_on_the_same_lease_changes_nothing(self):
        """remote_up runs on a 30 s timer; it must not rebuild the
        socket every time it is asked."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                netd.remote_up()
                srv = netd._remote['srv']
                netd.remote_up()
                self.assertIs(netd._remote['srv'], srv, 'it rebound for nothing')
            finally:
                netd.remote_disarm()

    def test_disarm_stays_disarmed(self):
        """The first version just closed the socket and the thirty
        second watcher reopened it, which is not an escape hatch - it is
        a thirty second pause with a reassuring name."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                netd.remote_up()
                self.assertTrue(netd._remote['armed'])
                netd.remote_disarm()
                self.assertFalse(netd._remote['armed'])
                self.assertFalse(netd.remote_up(), 'the watcher reopened it')
                self.assertFalse(netd._remote['armed'])
            finally:
                netd._remote['held'] = False
                netd.remote_disarm()

    def test_the_panel_reloading_lifts_the_latch(self):
        """The latch is in memory, and a register is what the owner
        reaches for when the remote has stopped working - so an owner
        who shut it in a hurry and forgot is not left with a remote that
        never works again and no idea why."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                netd.remote_disarm()
                r = netd.remote_register({'slots': SLOTS,
                                          'readings': [x['k'] for x in READINGS]})
                self.assertTrue(r['armed'], r)
            finally:
                netd._remote['held'] = False
                netd.remote_disarm()

    def test_registering_brings_the_door_up(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                r = netd.remote_register({'slots': SLOTS,
                                          'readings': [x['k'] for x in READINGS]})
                self.assertTrue(r['ok'], r)
                self.assertTrue(r['armed'], r)
            finally:
                netd.remote_disarm()


if __name__ == '__main__':
    unittest.main(verbosity=1)
