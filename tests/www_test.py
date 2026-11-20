"""The panel's own page server: netd's second, read-only listener.

It is on the boat's network - phones load the panel from it - so the
whole of this is what it must NOT do: hand out anything outside its one
folder, a hidden file, a listing, a type nobody asked it to serve, or
accept anything but a read. And the one thing it must do, which is serve
the page, its tiles and its GPX with headers a browser will use.

    python3 tests/www_test.py
"""
import http.client, importlib, os, sys, tempfile, threading, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def load(**env):
    for k in ('HELM_WWW_PORT', 'HELM_WWW_DIR', 'HELM_WWW_BIND', 'HELM_URL'):
        os.environ.pop(k, None)
    os.environ.update({k: str(v) for k, v in env.items()})
    return importlib.reload(importlib.import_module('netd'))


class Folder(unittest.TestCase):
    """A ~/helm-www as deploy leaves it, with things beside it that must
    stay out of reach."""

    def setUp(self):
        self.top = tempfile.mkdtemp(prefix='helm-www-')
        self.www = os.path.join(self.top, 'www')
        os.makedirs(os.path.join(self.www, 'tiles', '12'))
        os.makedirs(os.path.join(self.www, 'gpx'))
        os.makedirs(os.path.join(self.www, '.git'))
        def w(p, b):
            with open(os.path.join(self.www, p), 'wb') as f:
                f.write(b)
        w('confluence_helm.html', b'<html>panel</html>')
        w('tiles/12/1.jpg', b'\xff\xd8jpeg')
        w('gpx/race.gpx', b'<gpx/>')
        w('gpx/index.json', b'[]')
        w('nowplaying.json', b'{}')
        w('.git/config', b'secret')
        w('.hidden.json', b'{}')
        w('notes.py', b'print(1)')                 # a type it does not serve
        w('confluence_helm.html.new', b'half a deploy')
        with open(os.path.join(self.top, 'outside.html'), 'w') as f:
            f.write('outside')
        os.symlink(os.path.join(self.top, 'outside.html'),
                   os.path.join(self.www, 'escape.html'))
        self.n = load(HELM_WWW_DIR=self.www)

    def r(self, path):
        f = self.n.www_resolve(path)
        return None if f is None else os.path.relpath(f, self.www)


class Resolve(Folder):

    def test_the_page_is_the_index(self):
        self.assertEqual(self.r('/'), 'confluence_helm.html')
        self.assertEqual(self.r(''), 'confluence_helm.html')

    def test_what_it_is_for(self):
        self.assertEqual(self.r('/confluence_helm.html'), 'confluence_helm.html')
        self.assertEqual(self.r('/tiles/12/1.jpg'), 'tiles/12/1.jpg')
        self.assertEqual(self.r('/gpx/race.gpx'), 'gpx/race.gpx')
        self.assertEqual(self.r('/nowplaying.json'), 'nowplaying.json')

    def test_the_kiosks_cache_buster_is_not_part_of_the_name(self):
        self.assertEqual(self.r('/confluence_helm.html?v=1795188457'),
                         'confluence_helm.html')
        self.assertEqual(self.r('/gpx/index.json?_=1#x'), 'gpx/index.json')

    def test_an_escaped_name_is_the_name(self):
        self.assertEqual(self.r('/gpx/race%2Egpx'), 'gpx/race.gpx')

    def test_no_way_out(self):
        for p in ('/../outside.html', '/tiles/../../outside.html',
                  '/%2e%2e/outside.html', '/%2E%2E%2Foutside.html',
                  '/..%2foutside.html', '/tiles/..%5c..%5coutside.html',
                  '//etc/passwd', '/etc/passwd'):
            self.assertIsNone(self.r(p), p)

    def test_a_symlink_that_leads_out_is_refused(self):
        self.assertIsNone(self.r('/escape.html'))

    def test_nothing_hidden(self):
        for p in ('/.git/config', '/.hidden.json', '/gpx/.', '/./.git/config'):
            self.assertIsNone(self.r(p), p)

    def test_only_its_own_kinds_of_file(self):
        self.assertIsNone(self.r('/notes.py'))
        self.assertIsNone(self.r('/confluence_helm.html.new'))

    def test_no_listings(self):
        self.assertIsNone(self.r('/tiles/'))
        self.assertIsNone(self.r('/gpx'))

    def test_rubbish(self):
        for p in ('/%00.html', '/a%ff.html', '/x\x00.html'):
            self.assertIsNone(self.r(p), repr(p))

    def test_not_there_is_not_there(self):
        self.assertIsNone(self.r('/missing.html'))


class Live(Folder):
    """Over a real socket, the way a phone asks."""

    def setUp(self):
        super().setUp()
        srv = self.n.ThreadingHTTPServer(('127.0.0.1', 0), self.n.WwwHandler)
        srv.daemon_threads = True
        self.port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

    def ask(self, method, path, body=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        c.request(method, path, body=body)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def test_the_page(self):
        r, d = self.ask('GET', '/confluence_helm.html?v=1')
        self.assertEqual(r.status, 200)
        self.assertEqual(d, b'<html>panel</html>')
        self.assertTrue(r.getheader('Content-Type').startswith('text/html'))
        # A deploy has to show at the next load, not the next day.
        self.assertEqual(r.getheader('Cache-Control'), 'no-store')
        self.assertEqual(r.getheader('X-Content-Type-Options'), 'nosniff')

    def test_a_tile_may_be_kept(self):
        r, d = self.ask('GET', '/tiles/12/1.jpg')
        self.assertEqual((r.status, d), (200, b'\xff\xd8jpeg'))
        self.assertEqual(r.getheader('Content-Type'), 'image/jpeg')
        self.assertIn('max-age', r.getheader('Cache-Control'))

    def test_a_track_downloads_as_a_track(self):
        r, d = self.ask('GET', '/gpx/race.gpx')
        self.assertEqual(r.getheader('Content-Type'), 'application/gpx+xml')

    def test_head_is_headers_only(self):
        r, d = self.ask('HEAD', '/confluence_helm.html')
        self.assertEqual(r.status, 200)
        self.assertEqual(d, b'')
        self.assertEqual(r.getheader('Content-Length'), str(len(b'<html>panel</html>')))

    def test_head_sends_no_body_on_the_wire(self):
        # http.client never reads a HEAD body, so it cannot see one sent
        # by mistake - which a phone's browser would then read as the
        # start of the next response. Raw bytes, then.
        import socket
        with socket.create_connection(('127.0.0.1', self.port), timeout=5) as s:
            s.sendall(b'HEAD /confluence_helm.html HTTP/1.0\r\nHost: x\r\n\r\n')
            got = b''
            while True:
                c = s.recv(4096)
                if not c:
                    break
                got += c
        self.assertTrue(got.endswith(b'\r\n\r\n'), got[-60:])

    def test_refused_and_missing_look_the_same(self):
        a, _ = self.ask('GET', '/.git/config')
        b, _ = self.ask('GET', '/missing.html')
        c, _ = self.ask('GET', '/../outside.html')
        self.assertEqual({a.status, b.status, c.status}, {404})

    def test_it_writes_nothing(self):
        for m in ('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'):
            r, _ = self.ask(m, '/confluence_helm.html', body=b'x')
            self.assertEqual(r.status, 405, m)
            self.assertEqual(r.getheader('Allow'), 'GET, HEAD')
        with open(os.path.join(self.www, 'confluence_helm.html'), 'rb') as f:
            self.assertEqual(f.read(), b'<html>panel</html>')


class Wiring(unittest.TestCase):

    def test_a_page_from_it_may_call_the_helper(self):
        # The panel calls netd from the page's origin. Leave the new
        # origin out and every radio, power and sonar call fails CORS -
        # quietly, with the page otherwise looking fine.
        n = load()
        self.assertIn('http://localhost:8090', n.ORIGINS)
        self.assertIn('http://127.0.0.1:8090', n.ORIGINS)
        self.assertIn('null', n.ORIGINS)

    def test_the_port_follows_its_setting(self):
        n = load(HELM_WWW_PORT=8123)
        self.assertIn('http://localhost:8123', n.ORIGINS)
        self.assertIn(':8123/', n.APP_URL)

    def test_gpx_lands_where_it_is_served(self):
        n = load(HELM_WWW_DIR='/tmp/somewhere-www')
        self.assertEqual(n.GPX_DIR, '/tmp/somewhere-www/gpx')

    def test_a_port_already_held_is_survived(self):
        import socket
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', 0))
        s.listen(1)
        self.addCleanup(s.close)
        n = load(HELM_WWW_PORT=s.getsockname()[1], HELM_WWW_BIND='127.0.0.1')
        self.assertIsNone(n.www_start())

    def test_off_is_off(self):
        n = load(HELM_WWW_PORT=0)
        self.assertIsNone(n.www_start())


if __name__ == '__main__':
    unittest.main()
