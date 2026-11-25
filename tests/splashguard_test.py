#!/usr/bin/env python3
"""boot/splash-guard.sh: the apt hook that keeps the splash.

A Raspberry Pi OS full-upgrade reset Plymouth's default theme to 'pix'
with the Confluence theme still installed, and the boat booted to
raspberries. The guard runs after every dpkg run and puts it back. It
runs as root inside apt, so most of what matters is what it must never
do: fail apt, make noise when there is nothing to do, or act when
plymouth or the theme is not there.

Driven with a pretend plymouth-set-default-theme and logger on a PATH
that holds nothing else, and a pretend themes directory, for the same
reason the other boot probes are.

    python3 tests/splashguard_test.py
"""
import os, shutil, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(ROOT, 'boot', 'splash-guard.sh')
HOOK = os.path.join(ROOT, 'boot', '99confluence-splash')
BASH = shutil.which('bash') or '/bin/bash'


class Rig:
    """theme: what plymouth-set-default-theme reports, or None for no
    plymouth at all. installed: whether the confluence theme is on disk.
    fail_set: the -R call exits 1. fail_query: so does the plain query."""

    def __init__(self, theme='confluence', installed=True, fail_set=False,
                 fail_query=False, with_logger=True, with_initramfs=False):
        self.d = tempfile.mkdtemp(prefix='helm-splash-')
        self.bin = os.path.join(self.d, 'bin')
        self.themes = os.path.join(self.d, 'themes')
        self.calls = os.path.join(self.d, 'calls')
        self.logged = os.path.join(self.d, 'logged')
        os.makedirs(self.bin)
        os.makedirs(os.path.join(self.themes, 'pix'))
        if installed:
            t = os.path.join(self.themes, 'confluence')
            os.makedirs(t)
            open(os.path.join(t, 'confluence.plymouth'), 'w').close()
        if theme is not None:
            self._tool('plymouth-set-default-theme', f'''
echo "$*" >> "{self.calls}"
if [ $# -eq 0 ]; then
  {'exit 1' if fail_query else f'echo {theme}'}
  exit 0
fi
{'exit 1' if fail_set else 'exit 0'}
''')
        if with_initramfs:
            self._tool('update-initramfs', f'echo "update-initramfs $*" >> "{self.calls}"')
        if with_logger:
            self._tool('logger', f'echo "$*" >> "{self.logged}"')

    def _tool(self, name, body):
        p = os.path.join(self.bin, name)
        with open(p, 'w') as f:
            f.write('#!%s\n%s' % (BASH, body))
        os.chmod(p, 0o755)

    def run(self):
        env = {'PATH': self.bin, 'CONFLUENCE_PLYMOUTH_THEMES': self.themes,
               'DPKG_MAINTSCRIPT_PACKAGE': 'should-be-unset'}
        return subprocess.run([BASH, GUARD], env=env, capture_output=True,
                              text=True, timeout=20)

    def _lines(self, p):
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return f.read().splitlines()

    @property
    def calls_made(self):
        return self._lines(self.calls)

    @property
    def log_lines(self):
        return self._lines(self.logged)

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Guard(unittest.TestCase):
    def rig(self, **kw):
        r = Rig(**kw)
        self.addCleanup(r.close)
        return r

    def test_every_kernels_initramfs_is_rebuilt(self):
        # Pi OS carries -rpi-v8 (Pi 4) and -rpi-2712 (Pi 5); -R alone
        # rebuilds only the highest, which is the Pi 4's.
        r = self.rig(theme='pix', with_initramfs=True)
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made,
                         ['', 'confluence', 'update-initramfs -u -k all'])
        self.assertEqual(len(r.log_lines), 1)

    def test_already_confluence_does_nothing(self):
        r = self.rig(theme='confluence')
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made, [''])          # the query, nothing else
        self.assertEqual(r.log_lines, [])
        self.assertEqual((p.stdout, p.stderr), ('', ''))

    def test_pix_is_set_back_with_initramfs_rebuild(self):
        r = self.rig(theme='pix')
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made, ['', '-R confluence'])
        self.assertEqual(len(r.log_lines), 1)
        self.assertIn('-t confluence-splash', r.log_lines[0])
        self.assertIn("'pix'", r.log_lines[0])
        self.assertIn('set back to confluence', r.log_lines[0])
        self.assertEqual(p.stdout, '')
        self.assertEqual(len(p.stderr.splitlines()), 1)

    def test_theme_dir_missing_does_nothing(self):
        r = self.rig(theme='pix', installed=False)
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made, [])
        self.assertEqual(r.log_lines, [])
        self.assertEqual((p.stdout, p.stderr), ('', ''))

    def test_plymouth_absent_exits_zero_quietly(self):
        r = self.rig(theme=None)
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.log_lines, [])
        self.assertEqual((p.stdout, p.stderr), ('', ''))

    def test_failing_set_still_exits_zero_and_says_so(self):
        r = self.rig(theme='pix', fail_set=True)
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made, ['', '-R confluence'])
        self.assertEqual(len(r.log_lines), 1)
        self.assertIn('FAILED', r.log_lines[0])

    def test_failing_query_still_exits_zero(self):
        # Cannot tell what the theme is: setting it is the safe guess,
        # and whatever happens apt must not see a failure.
        r = self.rig(theme='pix', fail_query=True, fail_set=True)
        self.assertEqual(r.run().returncode, 0)

    def test_no_logger_still_exits_zero(self):
        r = self.rig(theme='pix', with_logger=False)
        p = r.run()
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r.calls_made, ['', '-R confluence'])

    def test_never_calls_apt_or_dpkg(self):
        with open(GUARD) as f:
            code = '\n'.join(l for l in f.read().splitlines()
                             if not l.lstrip().startswith('#'))
        for word in ('apt-get', 'apt ', 'dpkg ', 'dpkg-'):
            self.assertNotIn(word, code)


class Hook(unittest.TestCase):
    def test_snippet_shape(self):
        with open(HOOK) as f:
            body = f.read()
        self.assertIn('DPkg::Post-Invoke', body)
        self.assertIn('/usr/local/sbin/confluence-splash-guard', body)
        self.assertIn('|| true', body)
        self.assertNotIn(os.path.expanduser('~'), body)   # nothing in a home

    @unittest.skipUnless(shutil.which('apt-config'), 'no apt-config here')
    def test_apt_config_parses_it(self):
        env = dict(os.environ, APT_CONFIG=HOOK)
        p = subprocess.run(['apt-config', 'dump'], env=env,
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr)
        want = ('DPkg::Post-Invoke:: "if [ -x /usr/local/sbin/'
                'confluence-splash-guard ]; then /usr/local/sbin/'
                'confluence-splash-guard; fi || true";')
        self.assertIn(want, p.stdout.splitlines())

    def test_hook_command_survives_missing_guard(self):
        # The command apt would run, with the guard path pointed at
        # somewhere empty: a hook left behind must not fail apt.
        cmd = ('if [ -x /nonexistent/confluence-splash-guard ]; then '
               '/nonexistent/confluence-splash-guard; fi || true')
        p = subprocess.run(['sh', '-c', cmd], capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, '', ''))


if __name__ == '__main__':
    unittest.main()
