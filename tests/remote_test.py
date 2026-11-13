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
route() - EVERY endpoint is unreachable from the phone
because the code to reach them is not there, not because a list says
so. (This said "the twenty-seven endpoints" until there were
thirty-three of them, which is what a count written into prose always
does.)

    python3 tests/remote_test.py
"""
import json, os, shutil, sys, threading, time, unittest, urllib.error, urllib.request
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
                self.hdr = dict(f.headers)
                return f.status, f.read()
        except urllib.error.HTTPError as e:
            self.hdr = dict(e.headers)
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


class App(unittest.TestCase):
    """What turns the saved link into an app on the home screen."""

    def test_the_page_carries_the_token_into_the_manifest(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                code, raw = p.req('/r?t=T0KEN')
                self.assertEqual(code, 200)
                page = raw.decode()
                self.assertIn('href="/r/manifest.webmanifest?t=T0KEN"', page)
                self.assertIn('rel="apple-touch-icon"', page)
                # Without these the home screen gives a bookmark that
                # opens in the browser, chrome and all.
                self.assertIn('name="apple-mobile-web-app-capable"', page)
                self.assertIn('name="mobile-web-app-capable"', page)
                self.assertNotIn('%T%', page)
            finally:
                p.close()

    def test_the_manifest_needs_the_token_because_it_holds_one(self):
        """start_url carries the token - that is the point of it, the
        credential written down where the home screen can relaunch with
        it. So the manifest cannot be public, or anything else on the
        hotspot could simply read it."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for bad in ('', '?t=', '?t=wrong'):
                    code, j = p.js('/r/manifest.webmanifest' + bad)
                    self.assertEqual(code, 403, j)
                code, j = p.js('/r/manifest.webmanifest?t=T0KEN')
                self.assertEqual(code, 200, j)
                self.assertEqual(j['start_url'], '/r?t=T0KEN', j)
                self.assertEqual(j['display'], 'standalone', j)
                # The full name is what an install prompt shows; the
                # short one is the dozen characters a launcher has room
                # for under an icon, and "Confluence Helm" is not a
                # dozen - it would arrive as "Confluence H...".
                self.assertEqual(j['name'], 'Confluence Helm', j)
                self.assertEqual(j['short_name'], 'Confluence', j)
                self.assertTrue(len(j['short_name']) <= 12, j)
                # With the stamp of its own bytes on it, so a new
                # picture is a new address and the week of max-age on
                # it becomes true rather than a gamble.
                self.assertRegex(j['icons'][0]['src'],
                                 r'^/r/icon\.png\?v=[0-9a-f]{8}$')
                self.assertIn('maskable', j['icons'][0]['purpose'], j)
                self.assertEqual(p.hdr['Content-Type'],
                                 'application/manifest+json')
            finally:
                p.close()

    def test_the_icon_is_a_picture_and_is_allowed_to_be_cached(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                # No token: it is a picture of the number 45, and the
                # manifest's own icon fetch does not carry one.
                code, raw = p.req('/r/icon.png')
                self.assertEqual(code, 200)
                self.assertTrue(raw.startswith(b'\x89PNG'), raw[:8])
                self.assertEqual(p.hdr['Content-Type'], 'image/png')
                # Everything else here is state and must not be cached;
                # this is twenty kilobytes that never change.
                self.assertIn('max-age', p.hdr['Cache-Control'])
                code, j = p.js('/r/state?t=T0KEN')
                self.assertEqual(p.hdr['Cache-Control'], 'no-store')
            finally:
                p.close()

    def test_a_new_icon_gets_a_new_address(self):
        """A week of max-age on a URL that does not change when the
        picture does means the old one stays on the phone until the
        cache lets go. The stamp is of the bytes, so a different icon
        cannot arrive at the same address."""
        import tempfile
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            d = tempfile.mkdtemp(prefix='helm-icon-')
            keep = netd.REMOTE_ICON
            netd.REMOTE_ICON = os.path.join(d, 'i.png')
            try:
                with open(netd.REMOTE_ICON, 'wb') as fh:
                    fh.write(b'\x89PNG' + b'one')
                a = netd.icon_tag()
                self.assertRegex(a, r'^[0-9a-f]{8}$')
                self.assertEqual(a, netd.icon_tag(), 'and is stable')
                # a different picture, same path
                os.utime(netd.REMOTE_ICON, (0, 0))
                with open(netd.REMOTE_ICON, 'wb') as fh:
                    fh.write(b'\x89PNG' + b'another one entirely')
                self.assertNotEqual(netd.icon_tag(), a)
            finally:
                netd.REMOTE_ICON = keep
                shutil.rmtree(d, ignore_errors=True)

    def test_no_icon_is_a_blank_stamp_and_not_a_crash(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            keep = netd.REMOTE_ICON
            netd.REMOTE_ICON = '/nonexistent/remote-icon.png'
            try:
                self.assertEqual(netd.icon_tag(), '')
            finally:
                netd.REMOTE_ICON = keep

    def test_a_missing_icon_is_a_404_and_not_a_stack_trace(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            keep = netd.REMOTE_ICON
            netd.REMOTE_ICON = '/nonexistent/remote-icon.png'
            try:
                code, j = p.js('/r/icon.png')
                self.assertEqual(code, 404, j)
                # and the app still works without it
                code, j = p.js('/r/manifest.webmanifest?t=T0KEN')
                self.assertEqual(code, 200, j)
            finally:
                netd.REMOTE_ICON = keep
                p.close()


class Icon(unittest.TestCase):
    """The home screen icon is the dial in miniature, and it is
    GENERATED from the panel's own cell rects rather than drawn by eye.
    So it can drift, the same way a written-down coordinate drifts, and
    the same rule applies: if it can drift, something checks."""

    def rects(self):
        import io, re
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        html = io.open(os.path.join(root, 'confluence_helm.html'),
                       encoding='utf-8').read()
        i = html.index('<g id="dial-cells">')
        g = html[i:html.index('</g>', i)]
        cells = {m.group(1): [int(m.group(k)) for k in (2, 3, 4, 5)]
                 for m in re.finditer(
                     r'data-slot="(\w+)"\s+x="(\d+)"\s+y="(\d+)"\s*\n?\s*'
                     r'width="(\d+)"\s+height="(\d+)"', g)}
        svg = io.open(os.path.join(root, 'boot', 'remote-icon.svg')).read()
        drawn = [[float(x) for x in m.groups()] for m in re.finditer(
            r'<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" '
            r'height="([\d.]+)"', svg)]
        return cells, drawn

    def test_the_icon_is_the_panel_s_own_cells(self):
        cells, drawn = self.rects()
        self.assertEqual(len(cells), 5, cells)
        self.assertEqual(len(drawn), 5, drawn)
        k = 196.0 / 540.0
        want = sorted([256 + (c[0] - 540) * k, 256 + (c[1] - 540) * k,
                       c[2] * k, c[3] * k] for c in cells.values())
        for a, b in zip(want, sorted(drawn)):
            for p, q in zip(a, b):
                self.assertLess(abs(p - q), 0.6, '%s vs %s' % (a, b))

    def test_the_artwork_stays_inside_the_maskable_circle(self):
        """A launcher may mask this to any shape it likes. Everything
        has to sit inside the 80% circle or the mask takes a bite out
        of it."""
        _, drawn = self.rects()
        for x, y, w, h in drawn:
            for cx, cy in ((x, y), (x + w, y), (x, y + h), (x + w, y + h)):
                r = ((cx - 256) ** 2 + (cy - 256) ** 2) ** 0.5
                self.assertLess(r, 205, (x, y, w, h))


# The shape of the glass's power sheet, as a fixture - like SLOTS and
# READINGS above it, and for the same reason: what is tested here is
# netd's filtering and validation, not the glass's list. That the PANEL
# really sends its own POWER_ACTIONS is tests/remote.mjs's assertion,
# made against POWER_ACTIONS itself, where it cannot drift.
POWER = [{'a': 'reload', 'name': 'Reload the app', 'verb': 'RELOAD',
          'danger': 0, 'need': ''},
         {'a': 'helper', 'name': 'Restart helper', 'verb': 'RESTART',
          'danger': 0, 'need': ''},
         {'a': 'desktop', 'name': 'Desktop', 'verb': 'START THE DESKTOP',
          'danger': 0, 'need': 'power.desktop'},
         {'a': 'cage', 'name': 'Back to the kiosk', 'verb': 'GO BACK',
          'danger': 0, 'need': 'power.cage'},
         {'a': 'reboot', 'name': 'Reboot', 'verb': 'REBOOT',
          'danger': 1, 'need': ''},
         {'a': 'poweroff', 'name': 'Shut down', 'verb': 'SHUT DOWN',
          'danger': 1, 'need': ''}]


# The shape of the glass's settings catalogue, as a fixture like the
# two above it. That the PANEL really sends its own REM_SET is
# tests/remote.mjs's assertion, made where it cannot drift.
SETTINGS = [{'k': 'dim', 'kind': 'range', 'g': 'DISPLAY',
             'name': 'Brightness', 'min': 25, 'max': 100, 'step': 5,
             'unit': '%', 'unitOf': ''},
            {'k': 'sogAvg', 'kind': 'cycle', 'g': 'GPS AVERAGING',
             'name': 'Speed', 'opts': [1, 2, 3, 5, 10, 30],
             'labels': None, 'unit': ' SEC', 'unitOf': ''},
            {'k': 'click', 'kind': 'cycle', 'g': 'SOUND', 'name': 'Touch',
             'opts': ['off', 'tick', 'glass', 'bell'],
             'labels': None, 'unit': '', 'unitOf': ''},
            {'k': 'keepAwake', 'kind': 'toggle', 'g': 'SOUND',
             'name': 'Hold the speaker awake', 'unit': '', 'unitOf': ''},
            {'k': 'horn', 'kind': 'action', 'g': 'SOUND',
             'name': 'Test the horn', 'unit': '', 'unitOf': ''}]


def armed(netd):
    """Arm without opening a real socket - the socket is the one thing
    that cannot be exercised in a container with no wlan1."""
    netd._remote.update(
        armed=True, token='T0KEN', how='device', pend={}, at=0.0,
        slots=SLOTS, readings=[dict(r) for r in READINGS],
        power=[dict(a) for a in POWER],
        settings=[dict(x) for x in SETTINGS],
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

    def test_a_page_it_was_not_told_about_is_not_a_page(self):
        """The tab turns the glass as well as the phone, and the only
        pages there are are the ones the panel registered."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for bad in ('nope', '__proto__', '', 1, None):
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'page', 'page': bad})
                    self.assertEqual(code, 400, '%r -> %s %s' % (bad, code, j))
                self.assertEqual(netd._remote['pend'], {})
                code, j = p.js('/r/cmd?t=T0KEN', {'kind': 'page',
                                                  'page': 'mus'})
                self.assertEqual(code, 200, j)
                self.assertEqual(netd._remote['pend']['page'],
                                 {'kind': 'page', 'page': 'mus'})
                # Latest wins, as it does for a slot: the phone is on one
                # page and the panel is going to that one.
                p.js('/r/cmd?t=T0KEN', {'kind': 'page', 'page': 'dial'})
                self.assertEqual(netd._remote['pend']['page']['page'], 'dial')
            finally:
                p.close()

    def test_the_radios_are_a_read_and_nothing_else(self):
        """The second stated exception to "no live data crosses", and a
        narrower one than the clock: it is read-only. No switch, no
        scan, no join - the picker stays on the glass, because a scan
        is ten seconds of the hotspot stuttering for every device on
        it, the asking phone included."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            was = (netd.wifi_status, netd.bt_status)
            netd.wifi_status = lambda: {
                'available': True, 'radio': True, 'devices': [
                    {'dev': 'wlan0', 'bus': 'builtin', 'up': True,
                     'conn': True, 'ap': True, 'ssid': 'CONFLUENCE',
                     'signal': 0, 'ip': '10.42.0.1',
                     'state': 'connected', 'managed': True}]}
            netd.bt_status = lambda: {'available': True, 'powered': True,
                                      'connected': ['JBL FLIP'],
                                      'scanning': False}
            try:
                armed(netd)
                p = Phone(netd)
                try:
                    for q in ('', '?t=', '?t=wrong'):
                        code, j = p.js('/r/radios' + q)
                        self.assertEqual(code, 403, j)
                    netd._remote['armed'] = False
                    code, j = p.js('/r/radios?t=T0KEN')
                    self.assertEqual(code, 403, j)
                    netd._remote['armed'] = True
                    netd.bust()                    # the 4 s memo above
                    code, j = p.js('/r/radios?t=T0KEN')
                    self.assertEqual(code, 200, j)
                    d = j['wifi']['devices'][0]
                    self.assertEqual(d['ssid'], 'CONFLUENCE')
                    self.assertTrue(d['ap'])
                    self.assertEqual(j['bt']['names'], ['JBL FLIP'])
                    # Only the fields the phone draws with. The address
                    # and NetworkManager's own state word are the
                    # boat's business, not a remote's.
                    self.assertEqual(sorted(d),
                                     ['ap', 'bus', 'conn', 'dev',
                                      'signal', 'ssid', 'up'])
                    # And nothing on this socket can touch them. A
                    # scan, a join and a switch are all on the panel's
                    # own endpoints, which RemoteHandler cannot reach.
                    for path in ('/wifi/list', '/wifi/power',
                                 '/wifi/connect', '/bt/scan', '/bt/power',
                                 '/r/radios/scan', '/r/wifi'):
                        code, j = p.js(path + '?t=T0KEN', {'dev': 'wlan0'})
                        self.assertEqual(code, 404,
                                         '%s -> %s %s' % (path, code, j))
                finally:
                    p.close()
            finally:
                netd.wifi_status, netd.bt_status = was

    def test_the_panel_can_report_without_draining(self):
        """The poll carries `now` in the request and the commands come
        back in the reply, so what netd holds is the state from before
        the commands it just handed over. The panel says so again as
        soon as it has applied them - and that report must NOT drain,
        or a command queued in the moment since is collected by a reply
        nobody is reading."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            netd._remote['now'] = {'set': {'sogAvg': 1}}
            netd._remote['pend'] = {
                'set:dim': {'kind': 'set', 'k': 'dim', 'v': 40}}
            # Through the router, which is the door the panel knocks
            # on - calling the function direct would pass with the
            # route never wired up.
            r = netd.route('/remote/now', {'now': {'set': {'sogAvg': 30}}})
            self.assertTrue(r and r.get('ok'), r)
            self.assertEqual(netd._remote['now'], {'set': {'sogAvg': 30}})
            # Still there: the report is not a poll.
            self.assertIn('set:dim', netd._remote['pend'])
            drained = netd.remote_poll({})
            self.assertIn('set:dim', drained['cmds'])
            # And it refuses what is not a state.
            for bad in (None, 'now', 42, []):
                self.assertFalse(netd.route('/remote/now',
                                            {'now': bad})['ok'], bad)
            self.assertFalse(netd.route('/remote/now', {})['ok'])
            self.assertEqual(netd._remote['now'], {'set': {'sogAvg': 30}})

    def test_the_settings_arrive_by_registering(self):
        """armed() above writes _remote directly, so every other test
        here would pass with the register throwing the catalogue away.
        This is the one that goes in the front door."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            netd._remote.update(armed=True, token='T0KEN', how='device',
                                cidr='', settings=[], pend={})
            r = netd.remote_register({
                'slots': SLOTS, 'readings': [dict(x) for x in READINGS],
                'themes': ['day', 'night'],
                'settings': [dict(x) for x in SETTINGS]})
            self.assertTrue(r['ok'], r)
            self.assertEqual([a['k'] for a in netd._remote['settings']],
                             [a['k'] for a in SETTINGS])
            netd._remote.update(armed=True, how='device')
            p = Phone(netd)
            try:
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'set', 'k': 'dim', 'v': 40})
                self.assertEqual(code, 200, j)
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'set', 'k': 'nope', 'v': 1})
                self.assertEqual(code, 400, j)
                # And it goes down the wire, so the phone can draw it.
                code, j = p.js('/r/state?t=T0KEN')
                self.assertEqual(code, 200, j)
                self.assertEqual([a['k'] for a in j['settings']],
                                 [a['k'] for a in SETTINGS])
            finally:
                p.close()

    def test_a_setting_is_checked_against_its_own_entry(self):
        """netd writes down no settings of its own. An entry's kind is
        what a value is checked against, so a setting added to the
        glass needs no change in this file - and a value the glass
        never offered cannot be the one that arrives."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                ok = [('dim', 40), ('dim', 25), ('dim', 100),
                      ('sogAvg', 10), ('click', 'bell'),
                      ('keepAwake', False), ('horn', None)]
                for k, v in ok:
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'set', 'k': k, 'v': v})
                    self.assertEqual(code, 200, '%s=%r -> %s' % (k, v, j))
                    self.assertEqual(netd._remote['pend']['set:' + k],
                                     {'kind': 'set', 'k': k, 'v': v})
                bad = [('dim', 24), ('dim', 101), ('dim', 'bright'),
                       ('dim', None), ('dim', True),
                       ('sogAvg', 4), ('sogAvg', '10'), ('sogAvg', True),
                       ('click', 'kazoo'), ('click', 1),
                       ('keepAwake', 1), ('keepAwake', 'yes'),
                       ('nope', 1), ('__proto__', 1), ('', 1)]
                netd._remote['pend'] = {}
                for k, v in bad:
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'set', 'k': k, 'v': v})
                    self.assertEqual(code, 400, '%s=%r -> %s %s'
                                     % (k, v, code, j))
                self.assertEqual(netd._remote['pend'], {})
            finally:
                p.close()

    def test_true_is_not_a_number_on_a_cycle(self):
        """True == 1 in Python, so a bool walks through an `in [1,2,3]`
        test and arrives at the panel as a number the glass never
        offered. The same trap _geom() was written around."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            netd._remote['settings'] = netd._settings(
                [{'k': 'avg', 'kind': 'cycle', 'opts': [1, 2, 3],
                  'g': 'GPS', 'name': 'Speed'}])
            p = Phone(netd)
            try:
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'set', 'k': 'avg', 'v': True})
                self.assertEqual(code, 400, j)
                code, j = p.js('/r/cmd?t=T0KEN',
                               {'kind': 'set', 'k': 'avg', 'v': 2})
                self.assertEqual(code, 200, j)
            finally:
                p.close()

    def test_two_taps_on_one_setting_are_one_change(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for v in (30, 40, 50):
                    p.js('/r/cmd?t=T0KEN',
                         {'kind': 'set', 'k': 'dim', 'v': v})
                drained = netd.remote_poll({})
                self.assertEqual(len(drained['cmds']), 1, drained)
                self.assertEqual(drained['cmds']['set:dim']['v'], 50)
                self.assertEqual(netd.remote_poll({})['cmds'], {})
            finally:
                p.close()

    def test_a_half_formed_setting_is_not_drawn(self):
        """A range with no ends and a cycle with no options both mean
        accepting anything, which is the opposite of what this list is
        for."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            out = netd._settings([
                {'k': 'dim', 'kind': 'range', 'min': 25, 'max': 100,
                 'step': 5, 'g': 'DISPLAY', 'name': 'Brightness'},
                {'k': 'a', 'kind': 'range'},                  # no ends
                {'k': 'b', 'kind': 'range', 'min': 9, 'max': 1},
                {'k': 'c', 'kind': 'range', 'min': True, 'max': 9},
                {'k': 'd', 'kind': 'cycle'},                  # no options
                {'k': 'e', 'kind': 'cycle', 'opts': []},
                {'k': 'f', 'kind': 'cycle', 'opts': [{'a': 1}]},
                {'k': 'g', 'kind': 'slider'},                 # no such kind
                {'kind': 'toggle', 'name': 'Nameless'},       # no key
                'not a dict', None, 42,
            ])
            self.assertEqual([a['k'] for a in out], ['dim'], out)
            self.assertEqual(out[0]['min'], 25)
            self.assertEqual(out[0]['step'], 5)
            # A missing step is one, not nothing: a range with step 0
            # is a range you cannot move.
            one = netd._settings([{'k': 'x', 'kind': 'range',
                                   'min': 0, 'max': 9}])
            self.assertEqual(one[0]['step'], 1)
            # Labels only count when there is one per option.
            lab = netd._settings([{'k': 'y', 'kind': 'cycle',
                                   'opts': [1, 2], 'labels': ['ONE']}])
            self.assertIsNone(lab[0]['labels'])
            self.assertEqual(netd._settings('dim'), [])

    def test_the_power_sheet_is_the_panels_and_netd_keeps_no_list(self):
        """netd decides which actions are AVAILABLE and nothing else.
        A list of these in this file would drift the first time one was
        added to the glass, and the thing it would drift about is which
        button shuts the boat down."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            was_st = netd.power_status
            netd.power_status = lambda: {'available': True, 'uptime': '1d',
                                         'desktop': True, 'cage': False}
            try:
                armed(netd)
                got = [a['a'] for a in netd.remote_available_power()]
                self.assertEqual(got, ['reload', 'helper', 'desktop',
                                       'reboot', 'poweroff'], got)
                # Its mirror: the two are offered one at a time, by
                # construction, so the sheet always shows one way out of
                # wherever you are and never both.
                netd.power_status = lambda: {'available': True, 'uptime': '1d',
                                             'desktop': False, 'cage': True}
                # The read is cached for twenty seconds, because the
                # phone re-polls every four while the start clock runs
                # and power_status shells out. Going either way between
                # the desktop and the kiosk busts it, since that is the
                # one thing that changes the answer.
                netd._remote_power_bust()
                got = [a['a'] for a in netd.remote_available_power()]
                self.assertIn('cage', got)
                self.assertNotIn('desktop', got)
            finally:
                netd.power_status = was_st

    def test_leaving_the_kiosk_is_noticed_without_waiting_for_the_cache(self):
        """The read is cached for twenty seconds, because the phone
        re-polls every four while the start clock runs and power_status
        shells out. Going to the desktop or back to the kiosk is the one
        thing that changes the answer, and it is a thing this file has
        just done - so it must not be twenty seconds before the sheet
        agrees, which is long enough to press the tile again because
        nothing appeared to happen."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            was_do, was_st = netd.power_do, netd.power_status
            st = {'available': True, 'uptime': '1d',
                  'desktop': True, 'cage': False}
            netd.power_status = lambda: dict(st)
            netd.power_do = lambda a: {'ok': True}
            try:
                armed(netd)
                netd._remote_power_bust()
                p = Phone(netd)
                try:
                    got = [a['a'] for a in netd.remote_available_power()]
                    self.assertIn('desktop', got)       # and now cached
                    # The helper has done its work: there is a desktop
                    # running, so the way out is the kiosk now.
                    st.update(desktop=False, cage=True)
                    code, j = p.js('/r/power?t=T0KEN', {'action': 'desktop'})
                    self.assertEqual(code, 200, j)
                    got = [a['a'] for a in netd.remote_available_power()]
                    self.assertIn('cage', got)
                    self.assertNotIn('desktop', got)
                finally:
                    p.close()
            finally:
                netd.power_do, netd.power_status = was_do, was_st

    def test_a_half_formed_sheet_is_not_drawn(self):
        """A row whose words say one thing and whose action does another
        is the worst shape this can arrive in, and two of them shut the
        boat down."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            out = netd._power_sheet([
                {'a': 'reboot', 'name': 'Reboot', 'verb': 'REBOOT',
                 'danger': 1},
                {'a': 'poweroff'},            # no name
                {'name': 'Nameless'},         # no action
                {'a': 'rm -rf /', 'name': 'Tidy up'},   # not a word
                {'a': 'x' * 40, 'name': 'Long'},
                'not a dict', None, 42,
            ])
            self.assertEqual([a['a'] for a in out], ['reboot'], out)
            self.assertEqual(out[0]['verb'], 'REBOOT')
            # A verb is optional and falls back to the name, so a row
            # can never arm a bar that says nothing.
            one = netd._power_sheet([{'a': 'cage', 'name': 'Kiosk'}])
            self.assertEqual(one[0]['verb'], 'Kiosk')
            self.assertEqual(one[0]['danger'], 0)
            self.assertEqual(netd._power_sheet('reboot'), [])
            self.assertEqual(netd._power_sheet(None), [])

    def test_an_action_the_sheet_does_not_offer_is_not_an_action(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            was_do, was_st = netd.power_do, netd.power_status
            did = []
            netd.power_do = lambda a: (did.append(a), {'ok': True})[1]
            netd.power_status = lambda: {'available': True, 'uptime': '1d',
                                         'desktop': False, 'cage': False}
            try:
                armed(netd)
                p = Phone(netd)
                try:
                    for bad in ('cage', 'desktop', 'display', 'rm -rf',
                                '', None, 42, ['reboot']):
                        code, j = p.js('/r/power?t=T0KEN', {'action': bad})
                        self.assertEqual(code, 400,
                                         '%r -> %s %s' % (bad, code, j))
                    self.assertEqual(did, [])
                    # Wrong token, no token, disarmed: the same three
                    # gates /r/cmd is behind.
                    for q in ('', '?t=', '?t=wrong'):
                        code, j = p.js('/r/power' + q, {'action': 'reboot'})
                        self.assertEqual(code, 403, j)
                    netd._remote['armed'] = False
                    code, j = p.js('/r/power?t=T0KEN', {'action': 'reboot'})
                    self.assertEqual(code, 403, j)
                    self.assertEqual(j.get('error'), 'NOT ARMED')
                    self.assertEqual(did, [])
                    # And the one it does offer goes straight through,
                    # rather than being queued for a panel that may be
                    # the reason you are reaching for this at all.
                    netd._remote['armed'] = True
                    code, j = p.js('/r/power?t=T0KEN', {'action': 'reboot'})
                    self.assertEqual(code, 200, j)
                    self.assertEqual(did, ['reboot'])
                    self.assertEqual(netd._remote['pend'], {})
                finally:
                    p.close()
            finally:
                netd.power_do, netd.power_status = was_do, was_st

    def test_a_reload_is_queued_because_netd_cannot_reload_a_browser(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            was_do = netd.power_do
            did = []
            netd.power_do = lambda a: (did.append(a), {'ok': True})[1]
            try:
                armed(netd)
                p = Phone(netd)
                try:
                    code, j = p.js('/r/power?t=T0KEN', {'action': 'reload'})
                    self.assertEqual(code, 200, j)
                    self.assertEqual(did, [])
                    self.assertEqual(netd._remote['pend']['power'],
                                     {'kind': 'power', 'action': 'reload'})
                finally:
                    p.close()
            finally:
                netd.power_do = was_do

    def test_the_power_route_does_not_reach_the_panels_own_endpoints(self):
        """RemoteHandler has no call path to route(). /r/power calls one
        function by name - it is not a way to ask for any of the other
        twenty-seven."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for path in ('/power/do', '/status', '/wifi/power',
                             '/r/power/../power/do', '/r/cmd/../power/do'):
                    code, j = p.js(path + '?t=T0KEN', {'action': 'reboot'})
                    self.assertEqual(code, 404, '%s -> %s %s' % (path, code, j))
            finally:
                p.close()

    def test_clock_gestures_queue_as_a_sequence(self):
        """Everything else on this wire is latest-wins, which is right
        for a slot - the last reading you chose is the one you want.
        These are EVENTS: a hold then a tap means reset and then start,
        and keeping only the last leaves the boat in a state nobody
        asked for."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for g in ('tap', 'double', 'hold'):
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'clock', 'do': g})
                    self.assertEqual(code, 200, j)
                self.assertEqual(netd._remote['pend']['clock'],
                                 {'kind': 'clock',
                                  'seq': ['tap', 'double', 'hold']})
                # Handed over once, in order, and gone after.
                drained = netd.remote_poll({})
                self.assertEqual(drained['cmds']['clock']['seq'],
                                 ['tap', 'double', 'hold'])
                self.assertEqual(netd.remote_poll({})['cmds'], {})
            finally:
                p.close()

    def test_a_held_finger_cannot_queue_an_afternoon_of_them(self):
        """Four is already more than a finger makes inside the panel's
        1.5 s poll. The cap is what stops a phone that has lost the
        boat handing over a hundred of them the moment it comes back."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for _ in range(20):
                    p.js('/r/cmd?t=T0KEN', {'kind': 'clock', 'do': 'tap'})
                self.assertEqual(netd._remote['pend']['clock']['seq'],
                                 ['tap'] * 4)
                # The LAST four, not the first: what you just did
                # matters more than what you did twenty presses ago.
                p.js('/r/cmd?t=T0KEN', {'kind': 'clock', 'do': 'hold'})
                self.assertEqual(netd._remote['pend']['clock']['seq'][-1],
                                 'hold')
                self.assertEqual(len(netd._remote['pend']['clock']['seq']), 4)
            finally:
                p.close()

    def test_a_gesture_the_glass_does_not_have_is_refused(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for bad in ('start', 'triple', '', 'TAP', 1, None, True,
                            ['tap']):
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'clock', 'do': bad})
                    self.assertEqual(code, 400, '%r -> %s %s' % (bad, code, j))
                code, j = p.js('/r/cmd?t=T0KEN', {'kind': 'clock'})
                self.assertEqual(code, 400, j)
                self.assertEqual(netd._remote['pend'], {})
            finally:
                p.close()

    def test_taps_on_the_clock_add_up_rather_than_replacing(self):
        """The one place latest-wins is the wrong rule. Three taps before
        the panel polls are three minutes, and dropping two of them loses
        a start the owner thinks they have set."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for _ in range(3):
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'timer', 'by': 60})
                    self.assertEqual(code, 200, j)
                self.assertEqual(netd._remote['pend']['timer'],
                                 {'kind': 'timer', 'by': 180})
                p.js('/r/cmd?t=T0KEN', {'kind': 'timer', 'by': -60})
                self.assertEqual(netd._remote['pend']['timer']['by'], 120)
                # Back to where it started is nothing to send, not a
                # nudge of zero - which the panel would refuse anyway,
                # but a queue that never empties is a queue that keeps
                # waking the panel.
                for _ in range(2):
                    p.js('/r/cmd?t=T0KEN', {'kind': 'timer', 'by': -60})
                self.assertNotIn('timer', netd._remote['pend'])
                # And it is handed over once, as one total.
                p.js('/r/cmd?t=T0KEN', {'kind': 'timer', 'by': 60})
                drained = netd.remote_poll({})
                self.assertEqual(drained['cmds']['timer'],
                                 {'kind': 'timer', 'by': 60})
                self.assertEqual(netd.remote_poll({})['cmds'], {})
            finally:
                p.close()

    def test_the_clock_cannot_be_nudged_past_an_hour(self):
        """A held finger on a phone that has lost the panel could queue
        all afternoon. The panel refuses a total over an hour, so netd
        must not build one - the alternative is a queue that is thrown
        away whole the moment the panel comes back."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for _ in range(80):
                    p.js('/r/cmd?t=T0KEN', {'kind': 'timer', 'by': 60})
                self.assertEqual(netd._remote['pend']['timer']['by'], 3600)
                for _ in range(160):
                    p.js('/r/cmd?t=T0KEN', {'kind': 'timer', 'by': -60})
                self.assertEqual(netd._remote['pend']['timer']['by'], -3600)
            finally:
                p.close()

    def test_a_nudge_is_a_whole_minute_either_way(self):
        """What the glass's own two buttons do, and nothing else. The
        total netd builds may be any multiple of a minute; a single
        press is one."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            p = Phone(netd)
            try:
                for bad in (30, 61, 3600, 0, '60', True, None, 1e309):
                    code, j = p.js('/r/cmd?t=T0KEN',
                                   {'kind': 'timer', 'by': bad})
                    self.assertEqual(code, 400, '%r -> %s %s' % (bad, code, j))
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
                self.assertEqual(j['now']['slots']['dial:c1'], 'dpt')
                # What the PAGE needs off each reading, not merely that
                # the key is in there somewhere. This probe asserted
                # `'dpt' in readings` and passed on a list of bare keys
                # that the page cannot draw: it reads .name for the row
                # and .sen for the group heading, and would have put
                # every reading under a heading called undefined.
                for r in j['readings']:
                    self.assertIsInstance(r, dict, j['readings'])
                    for want in ('k', 'name', 'sen'):
                        self.assertTrue(r.get(want), r)
                    # and no numbers: the phone shows what is in a slot,
                    # never what it reads.
                    self.assertEqual(set(r) - {'k', 'name', 'sen'}, set(), r)
                self.assertIn('dpt', [r['k'] for r in j['readings']])
                code, j = p.js('/r/state?t=wrong')
                self.assertEqual(code, 403, j)
            finally:
                p.close()

    def test_the_drain_says_when_netd_has_forgotten(self):
        """The catalogue is in memory, so a netd restart leaves the door
        open, the phone with nothing to show and every command refused.
        The panel polls anyway, so the poll is where it finds out."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            self.assertFalse(netd.remote_poll({})['have'])
            armed(netd)
            self.assertTrue(netd.remote_poll({})['have'])

    def test_the_face_survives_the_round_trip_whole(self):
        """The geometry is the only thing on this wire the phone cannot
        work out for itself, and a box that arrives bent is a touch
        target in the wrong place on a face that still looks right."""
        geom = {'dial': {'box': {'c0': [270, 322, 620, 278]},
                         'a': {'c0': [540, 510]},
                         'cut': [[200, 606, 880, 606]]},
                'mus': {'box': {'a': [410, 64, 260, 142]},
                        'a': {'a': [540, 140]}, 'cut': [], 'art': [400, 400, 280, 280]}}
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            armed(netd)
            r = netd.remote_register({'slots': SLOTS,
                                      'readings': [dict(x) for x in READINGS],
                                      'tags': {'sog': 'SOG'},
                                      'sens': {'gps': 'GPS'},
                                      'geom': geom})
            self.assertTrue(r['ok'], r)
            p = Phone(netd)
            try:
                code, j = p.js('/r/state?t=T0KEN')
                self.assertEqual(code, 200, j)
                self.assertEqual(j['geom'], geom, j['geom'])
                self.assertEqual(j['tags'], {'sog': 'SOG'}, j)
                self.assertEqual(j['sens'], {'gps': 'GPS'}, j)
            finally:
                p.close()

    def test_a_face_that_is_not_numbers_is_refused(self):
        """It raises rather than filtering, for the reason the
        catalogue already gives: a box silently dropped is a phone
        drawing a mirror with a hole in it and nothing saying why."""
        bad = [
            {'dial': {'box': {'c0': ['270', 322, 620, 278]}}},   # a string
            {'dial': {'box': {'c0': [True, 0, 1, 1]}}},          # bool is int
            {'dial': {'box': {'c0': [None, 0, 1, 1]}}},
            {'dial': {'box': {'c0': {'x': {'y': {'z': {'w': 1}}}}}}},  # too deep
        ]
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            for g in bad:
                r = netd.remote_register({'slots': SLOTS,
                                          'readings': [dict(x) for x in READINGS],
                                          'geom': g})
                self.assertFalse(r['ok'], '%s -> %s' % (g, r))
                self.assertEqual(r['error'], 'BAD GEOM', r)

    def test_true_is_not_a_coordinate(self):
        """True is an int in Python, so [True,0,1,1] passes every
        numeric test there is and arrives as a one-by-one target at the
        origin - a slot you cannot tap on a face that looks almost
        right. The guard is first in _geom for that reason."""
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            self.assertRaises(ValueError, netd._geom, True)
            self.assertRaises(ValueError, netd._geom, [True, 0, 1, 1])
            self.assertEqual(netd._geom([1, 2.5, 3]), [1, 2.5, 3])

    def test_register_refuses_a_catalogue_it_cannot_validate_against(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            for bad in ({}, {'slots': {}}, {'slots': SLOTS},
                        {'slots': SLOTS, 'readings': []},
                        # bare keys: the shape the two halves disagreed
                        # over. remote_cmd could validate against it and
                        # the page could not draw it.
                        {'slots': SLOTS, 'readings': ['sog', 'dpt']},
                        {'slots': SLOTS, 'readings': [{'k': 'sog'}]},
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
                                          'readings': [dict(x) for x in READINGS]})
                self.assertTrue(r['armed'], r)
            finally:
                netd._remote['held'] = False
                netd.remote_disarm()

    def test_registering_brings_the_door_up(self):
        with rig([], devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            try:
                r = netd.remote_register({'slots': SLOTS,
                                          'readings': [dict(x) for x in READINGS]})
                self.assertTrue(r['ok'], r)
                self.assertTrue(r['armed'], r)
            finally:
                netd.remote_disarm()


if __name__ == '__main__':
    unittest.main(verbosity=1)
