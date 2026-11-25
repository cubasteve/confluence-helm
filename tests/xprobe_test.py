#!/usr/bin/env python3
"""netd's search for an X server, and what it must not do under cage.

cage 0.2 starts Xwayland lazily, on the first X11 client to connect to
:0. netd's xrandr probe - run from /status, which the panel polls - was
that client: an Xwayland started at the very moment the panel loaded,
and again every 20-30 s after. And Xwayland answered "XWAYLAND0
connected", which netd took for a display it could fit.

So: under cage, no xrandr at all; anywhere, an Xwayland answer is not an
X server; a real one still is. Plus the one log line the page server
writes, which is the kiosk's own launch and nothing else.

    python3 tests/xprobe_test.py
"""
import contextlib, importlib, io, os, sys, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

REAL = ('Screen 0: minimum 320 x 200, current 1080 x 1080, maximum 8192 x 8192\n'
        'HDMI-1 connected primary 1080x1080+0+0 (normal) 0mm x 0mm\n'
        '   1080x1080     60.00*+\n')
XWAYLAND = ('Screen 0: minimum 16 x 16, current 1280 x 720, maximum 32767 x 32767\n'
            'XWAYLAND0 connected 1280x720+0+0 (normal) 0mm x 0mm\n'
            '   1280x720      59.86*+\n')


class Probe(unittest.TestCase):

    def setUp(self):
        self.n = importlib.reload(importlib.import_module('netd'))
        self.calls = []
        self.cage = False
        self.xrandr = REAL

        def run(argv, timeout=30, env=None):
            self.calls.append(argv)
            if argv[:2] == ['pgrep', '-x'] and argv[2] == 'cage':
                return (0, '1234', '') if self.cage else (1, '', '')
            if argv[0] == 'xrandr':
                return 0, self.xrandr, ''
            return 1, '', ''
        self.n.run = run
        self.n._xenv.update(env=None, at=0.0)

    def xrandrs(self):
        return [c for c in self.calls if c[0] == 'xrandr']

    def test_under_cage_nothing_connects_to_x(self):
        self.cage = True
        self.assertIsNone(self.n.x_env())
        self.assertEqual(self.xrandrs(), [])
        self.assertEqual(self.n.fit_status(), {'available': False})
        self.assertEqual(self.xrandrs(), [])

    def test_the_negative_is_cached_too(self):
        self.cage = True
        self.n.x_env()
        n = len(self.calls)
        self.n.x_env()
        self.assertEqual(len(self.calls), n)

    def test_xwayland_is_not_an_x_server(self):
        self.xrandr = XWAYLAND
        self.assertIsNone(self.n.x_env())
        self.assertTrue(self.xrandrs())            # it did look

    def test_a_real_x_server_is_still_found(self):
        self.assertIsNotNone(self.n.x_env())
        st = self.n.fit_status()
        self.assertTrue(st['available'], st)
        self.assertEqual(st['output'], 'HDMI-1')

    def test_leaving_cage_finds_the_desktop(self):
        # The Desktop tile's auto-fit re-probes once a second while the
        # display manager comes up; cage is gone by then.
        self.cage = True
        self.assertIsNone(self.n.x_env())
        self.cage = False
        self.n._xenv['at'] = 0.0
        self.assertIsNotNone(self.n.x_env())


class PageLog(unittest.TestCase):

    def setUp(self):
        self.n = importlib.reload(importlib.import_module('netd'))

    def said(self, path, ip='127.0.0.1', cmd='GET'):
        h = type('H', (), {})()
        h.path, h.command, h.client_address = path, cmd, (ip, 5555)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.n._www_note_page(h)
        return buf.getvalue()

    def test_the_kiosk_launch_is_logged_with_the_uptime(self):
        out = self.said('/confluence_helm.html?v=1795586199')
        self.assertRegex(out, r'^\[netd\] \d\d:\d\d:\d\d www: page requested '
                              r'\(uptime [\d.?]+s\)\n$')

    def test_nothing_else_is(self):
        for args in (('/confluence_helm.html',),              # curl liveness
                     ('/confluence_helm.html?v=1', '192.168.4.20'),  # a phone
                     ('/tiles/12/1.jpg?v=1',),
                     ('/confluence_helm.html?v=1', '127.0.0.1', 'HEAD')):
            self.assertEqual(self.said(*args), '', args)


if __name__ == '__main__':
    unittest.main(verbosity=1)
