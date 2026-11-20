"""deploy.sh, run for real in a throwaway home.

The move off AvNav has to go right once, on a boat, with nobody watching:
everything that lived beside the page comes across, nothing is lost or
overwritten, nothing about an old folder can stop the page being
published, and the old addresses only start forwarding once there is
something on the new port to forward TO.

    python3 tests/deploy_test.py
"""
import os, shutil, socket, subprocess, sys, tempfile, threading, unittest
import http.server, functools

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Home(unittest.TestCase):

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='helm-home-')
        self.addCleanup(shutil.rmtree, self.home, True)
        os.makedirs(os.path.join(self.home, 'helm', 'boot'))
        for f in ('confluence_helm.html', 'deploy.sh', 'boot/old-address.html'):
            shutil.copy(os.path.join(ROOT, f), os.path.join(self.home, 'helm', f))
        self.viewer = self.p('avnav/data/user/viewer/helm')
        self.older = self.p('avnav/data/user/helm')
        self.www = self.p('helm-www')
        self.port = free_port()                 # nothing listening yet

    def p(self, rel):
        return os.path.join(self.home, rel)

    def put(self, rel, text):
        f = self.p(rel)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, 'w') as fh:
            fh.write(text)

    def read(self, rel):
        with open(self.p(rel)) as f:
            return f.read()

    def deploy(self, *args, path=None):
        env = dict(os.environ, HOME=self.home, HELM_WWW_PORT=str(self.port))
        env.pop('HELM_WWW_DIR', None)
        if path:
            env['PATH'] = path + os.pathsep + env['PATH']
        return subprocess.run(['bash', self.p('helm/deploy.sh')] + list(args),
                              env=env, capture_output=True, text=True, timeout=60)

    def serve_www(self):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        h = functools.partial(Quiet, directory=self.www)
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', self.port), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

    def boat(self):
        """The two old folders as a Pi has them after today."""
        self.put('avnav/data/user/viewer/helm/confluence_helm.html', 'OLD PANEL')
        self.put('avnav/data/user/viewer/helm/tiles/12/1.jpg', 't12')
        self.put('avnav/data/user/viewer/helm/gpx/race.gpx', 'NEW')
        self.put('avnav/data/user/viewer/helm/nowplaying.json', '{"song":"x"}')
        self.put('avnav/data/user/helm/confluence_helm.html', 'OLDER PANEL')
        self.put('avnav/data/user/helm/gpx/race.gpx', 'OLD')
        self.put('avnav/data/user/helm/gpx/older.gpx', 'older')
        self.put('avnav/data/user/helm/tiles/13/2.jpg', 't13')


class Moving(Home):

    def test_everything_comes_across_and_nothing_is_overwritten(self):
        self.boat()
        r = self.deploy()
        self.assertEqual(r.returncode, 0, r.stderr)
        for f, want in (('tiles/12/1.jpg', 't12'), ('tiles/13/2.jpg', 't13'),
                        ('gpx/race.gpx', 'NEW'), ('gpx/older.gpx', 'older')):
            self.assertEqual(self.read('helm-www/' + f), want, f)
        self.assertIn('<', self.read('helm-www/confluence_helm.html'))

    def test_now_playing_is_left_to_its_poller(self):
        self.boat()
        self.deploy()
        self.assertFalse(os.path.exists(self.p('helm-www/nowplaying.json')))

    def test_once_per_folder(self):
        self.boat()
        self.deploy()
        self.put('avnav/data/user/helm/late.gpx', 'late')
        r = self.deploy()
        self.assertNotIn('moved', r.stdout)
        self.assertFalse(os.path.exists(self.p('helm-www/late.gpx')))

    def test_a_failed_move_is_not_marked_done_and_does_not_stop_the_page(self):
        self.boat()
        shim = tempfile.mkdtemp(prefix='shim-')
        self.addCleanup(shutil.rmtree, shim, True)
        with open(os.path.join(shim, 'mv'), 'w') as f:
            f.write('#!/bin/bash\ncase "$*" in *tiles*) echo "mv: no space" >&2; exit 1;; esac\n'
                    'exec /bin/mv "$@"\n')
        os.chmod(os.path.join(shim, 'mv'), 0o755)
        r = self.deploy(path=shim)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(self.p('helm-www/confluence_helm.html')))
        self.assertFalse(os.path.exists(os.path.join(self.viewer, '.moved-to-helm-www')))
        self.assertIn('tries again', r.stderr)
        r = self.deploy()                          # the next one, mv working
        self.assertTrue(os.path.exists(self.p('helm-www/tiles/12/1.jpg')))
        self.assertTrue(os.path.exists(os.path.join(self.viewer, '.moved-to-helm-www')))

    def test_a_boat_that_never_had_avnav(self):
        r = self.deploy()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(self.p('helm-www/confluence_helm.html')))


class Forwarding(Home):

    def test_nothing_forwards_to_a_port_that_is_not_answering(self):
        self.boat()
        self.deploy()
        self.assertEqual(self.read('avnav/data/user/viewer/helm/confluence_helm.html'),
                         'OLD PANEL')
        # ...and with nothing to forward to, no deploy is owed: autopull
        # would otherwise restart the kiosk every interval for nothing.
        self.assertEqual(self.deploy('--check').returncode, 0)

    def test_the_hand_over_page_is_there_at_once(self):
        self.boat()
        self.deploy()
        h = self.read('avnav/data/user/viewer/helm/helm-export.html')
        self.assertIn('helm-export', h)
        self.assertIn(':%d' % self.port, h)
        self.assertNotIn('__PORT__', h)

    def test_once_the_new_port_answers_a_deploy_is_owed_and_then_forwards(self):
        self.boat()
        self.deploy()
        self.serve_www()
        self.assertEqual(self.deploy('--check').returncode, 1)
        r = self.deploy()
        self.assertEqual(r.returncode, 0, r.stderr)
        fwd = self.read('avnav/data/user/viewer/helm/confluence_helm.html')
        self.assertIn("location.hostname + ':%d'" % self.port, fwd)
        self.assertIn('helm-forward', self.read('avnav/data/user/helm/confluence_helm.html'))
        self.assertEqual(self.deploy('--check').returncode, 0)

    def test_the_forward_is_never_written_into_the_new_folder(self):
        self.boat()
        self.serve_www()
        self.deploy()
        self.deploy()
        self.assertNotIn('helm-forward', self.read('helm-www/confluence_helm.html'))


if __name__ == '__main__':
    unittest.main()
