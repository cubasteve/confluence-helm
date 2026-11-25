#!/usr/bin/env python3
"""Which browser the window and cage scripts start.

Raspberry Pi OS ships it as `chromium-browser`; Debian, and a fresh
Trixie image, ship it as `chromium`. start-kiosk.sh and netd.py always
looked for both. open-window.sh and boot/cage-session.sh named only the
first, so on an image with the other the panel never appeared.

Each case runs the script with a PATH holding ONLY the tools it needs
and whichever pretend browsers the case wants, so a machine that has a
real chromium on it is not what gets tested.

    python3 tests/browser_test.py
"""
import os, shutil, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOW = os.path.join(ROOT, 'open-window.sh')
CAGE = os.path.join(ROOT, 'boot', 'cage-session.sh')

# What the two scripts call besides the browser. Linked in from the real
# system, one by one, rather than putting /usr/bin on the PATH - which is
# where a real chromium would be.
NEEDS = ('bash', 'date', 'sleep', 'tty', 'pgrep', 'grep', 'head', 'curl')


class Rig:
    def __init__(self, browsers):
        self.d = tempfile.mkdtemp(prefix='helm-browser-test-')
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self.log = os.path.join(self.d, 'calls')
        for t in NEEDS:
            p = shutil.which(t)
            if p:
                os.symlink(p, os.path.join(self.bin, t))
        for b in browsers:
            self.stub(b, 'printf "%s %s\\n" "${0##*/}" "$*" >> ' + self.log)
        # cage runs the browser it is handed, then ends the session so
        # the relaunch loop does not go round: one launch is the answer.
        self.stub('cage', 'shift 2; printf "cage %s\\n" "$*" >> ' + self.log
                  + '; kill -TERM $PPID')

    def stub(self, name, body):
        p = os.path.join(self.bin, name)
        with open(p, 'w') as f:
            f.write('#!/bin/sh\n%s\nexit 0\n' % body)
        os.chmod(p, 0o755)

    def run(self, script, *args, **env):
        e = {'PATH': self.bin, 'HOME': self.d, 'REPO': self.d,
             'LOG': os.path.join(self.d, 'session.log'),
             'WAIT_AVNAV': '0', 'TO_DESKTOP': os.path.join(self.d, 'none'),
             'SYSTEMCTL': 'false'}
        e.update(env)
        p = subprocess.run([shutil.which('bash'), script] + list(args),
                           env=e, capture_output=True, text=True, timeout=30)
        return p.returncode, p.stdout + p.stderr

    def calls(self):
        try:
            with open(self.log) as f:
                return [l.strip() for l in f if l.strip()]
        except OSError:
            return []

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Window(unittest.TestCase):

    def launched(self, browsers):
        r = Rig(browsers)
        try:
            rc, out = r.run(WINDOW, '--force')
            return rc, out, r.calls()
        finally:
            r.close()

    def test_raspberry_pi_os_name(self):
        rc, out, calls = self.launched(['chromium-browser'])
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(calls), 1, calls)
        self.assertTrue(calls[0].startswith('chromium-browser --app='), calls)

    def test_debian_name(self):
        rc, out, calls = self.launched(['chromium'])
        self.assertEqual(rc, 0, out)
        self.assertTrue(calls[0].startswith('chromium --app='), calls)

    def test_both_takes_the_raspberry_pi_os_one_as_before(self):
        _, _, calls = self.launched(['chromium-browser', 'chromium'])
        self.assertTrue(calls[0].startswith('chromium-browser '), calls)

    def test_never_asks_for_a_keyring(self):
        # The Nov 2026 update brought a keyring; without this Chromium
        # stops before the page with a "default keyring" dialog.
        _, _, calls = self.launched(['chromium-browser'])
        self.assertIn('--password-store=basic', calls[0], calls)

    def test_neither_says_so(self):
        rc, out, calls = self.launched([])
        self.assertEqual(rc, 1)
        self.assertIn('neither chromium-browser nor chromium', out)
        self.assertEqual(calls, [])


class Cage(unittest.TestCase):

    def launched(self, browsers, **env):
        r = Rig(browsers)
        try:
            r.run(CAGE, **env)
            return [c for c in r.calls() if c.startswith('cage ')]
        finally:
            r.close()

    def test_raspberry_pi_os_name(self):
        calls = self.launched(['chromium-browser'])
        self.assertEqual(len(calls), 1, calls)
        self.assertTrue(calls[0].startswith('cage chromium-browser --'), calls)

    def test_debian_name(self):
        calls = self.launched(['chromium'])
        self.assertTrue(calls[0].startswith('cage chromium --'), calls)

    def test_never_asks_for_a_keyring(self):
        calls = self.launched(['chromium-browser'])
        self.assertIn('--password-store=basic', calls[0], calls)

    def test_the_environment_still_names_it(self):
        calls = self.launched(['chromium-browser', 'chromium'],
                              CHROME='chromium')
        self.assertTrue(calls[0].startswith('cage chromium --'), calls)


if __name__ == '__main__':
    unittest.main(verbosity=1)
