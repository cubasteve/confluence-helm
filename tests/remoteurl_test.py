#!/usr/bin/env python3
"""boot/remote-url.sh: the one-time errand that tells you where to point
the phone.

The remote has no tile, by choice, so there is nothing on the glass that
says the URL. This script is the whole of how a person finds it, which
makes its output the user interface - and these probes are mostly about
it telling the truth when things are not ready.

    python3 tests/remoteurl_test.py
"""
import json, os, shutil, subprocess, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'boot', 'remote-url.sh')

STATUS = {'ok': True, 'armed': True, 'how': 'device', 'url': '',
          'token': 'TOKEN-abc123', 'dev': 'wlan1', 'port': 8093}


class Netd:
    """A stand-in for netd's /remote/status, on a real socket."""

    def __init__(self, body=STATUS, code=200):
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path != '/remote/status':
                    self.send_error(404)
                    return
                raw = json.dumps(outer.body).encode()
                self.send_response(outer.code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.body, self.code = body, code
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def url(self):
        return 'http://127.0.0.1:%d' % self.srv.server_address[1]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class Rig:
    """A PATH where `hostname` and `ip` say what the test wants."""

    def __init__(self, host='openplotter', addr='192.168.43.17/24'):
        self.d = tempfile.mkdtemp(prefix='helm-remoteurl-')
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self._fake('hostname', 'printf "%s\\n" ' + host)
        if addr is None:
            self._fake('ip', 'exit 0')
        else:
            self._fake('ip', 'printf "1: wlan1 inet %s brd x scope global\\n" '
                       + addr)

    def _fake(self, name, body):
        p = os.path.join(self.bin, name)
        with open(p, 'w') as f:
            f.write('#!/bin/bash\n' + body + '\n')
        os.chmod(p, 0o755)

    def run(self, api):
        env = dict(os.environ)
        env['PATH'] = self.bin + os.pathsep + env['PATH']
        env['HELM_NETD'] = api
        p = subprocess.run(['bash', SCRIPT], capture_output=True, text=True,
                           env=env, timeout=60)
        return p.returncode, p.stdout + p.stderr

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class RemoteUrl(unittest.TestCase):

    def go(self, body=STATUS, addr='192.168.43.17/24', host='openplotter'):
        n = Netd(dict(body))
        r = Rig(host=host, addr=addr)
        try:
            return r.run(n.url)
        finally:
            r.close()
            n.close()

    def test_it_prints_a_url_you_can_type(self):
        rc, out = self.go()
        self.assertEqual(rc, 0, out)
        self.assertIn('http://openplotter.local:8093/r?t=TOKEN-abc123', out)

    def test_the_name_comes_first_and_says_why(self):
        """The number changes every time the hotspot hands out a lease.
        Someone who saves that one has to redo this, so the name has to
        be the one that is obviously meant."""
        rc, out = self.go()
        name = out.index('openplotter.local')
        num = out.index('192.168.43.17:8093')
        self.assertLess(name, num, out)
        self.assertIn('survives', out.split('openplotter.local')[0])

    def test_the_number_is_there_as_a_fallback(self):
        rc, out = self.go()
        self.assertIn('http://192.168.43.17:8093/r?t=TOKEN-abc123', out)

    def test_no_address_says_so_instead_of_printing_half_a_url(self):
        rc, out = self.go(addr=None)
        self.assertEqual(rc, 0, out)
        self.assertNotIn('http://:8093', out)
        self.assertIn('no address', out)
        self.assertIn('Join the hotspot', out)

    def test_a_shut_door_is_explained_rather_than_left_to_be_discovered(self):
        rc, out = self.go(dict(STATUS, armed=False))
        self.assertIn('door: shut', out)
        self.assertIn('thirty seconds', out)

    def test_an_open_door_does_not_explain_itself(self):
        rc, out = self.go()
        self.assertIn('door: open', out)
        self.assertNotIn('thirty seconds', out)

    def test_no_netd_is_a_failure_with_the_reason(self):
        """Silence here would read as 'the remote does not exist'."""
        n = Netd()
        api = n.url
        n.close()                      # nothing listening on that port now
        r = Rig()
        try:
            rc, out = r.run(api)
        finally:
            r.close()
        self.assertEqual(rc, 1, out)
        self.assertIn('not answering', out)
        self.assertNotIn('/r?t=', out)

    def test_a_netd_with_no_token_is_not_dressed_up_as_a_url(self):
        rc, out = self.go(dict(STATUS, token=''))
        self.assertEqual(rc, 1, out)
        self.assertNotIn('/r?t=', out)
        self.assertIn('no token', out)

    def test_it_follows_the_port_netd_reports(self):
        """HELM_REMOTE_PORT moves it, and a script with 8093 written in
        would send you to a door that is not there."""
        rc, out = self.go(dict(STATUS, port=9999))
        self.assertIn('openplotter.local:9999/r?t=', out)
        self.assertNotIn(':8093', out)

    def test_it_reads_the_interface_netd_reports(self):
        rc, out = self.go(dict(STATUS, dev='wlan7'))
        self.assertIn('interface: wlan7', out)

    def test_it_changes_nothing(self):
        """Read-only: it is run by someone with a problem, and the last
        thing that should do is reconfigure the radios."""
        src = open(SCRIPT).read()
        for bad in ('nmcli ', 'rfkill ', 'systemctl restart', ' > /etc',
                    'tee ', 'rm ', 'mv ', 'chmod ', 'ip link set'):
            self.assertNotIn(bad, src, bad)


if __name__ == '__main__':
    unittest.main(verbosity=0)
