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
NEEDS = ('bash', 'date', 'sleep', 'tty', 'pgrep', 'grep', 'head', 'curl',
         'sed', 'tr', 'sort', 'ls', 'find', 'mkdir', 'ln', 'cut', 'python3')
KIOSK = os.path.join(ROOT, 'start-kiosk.sh')


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
        # NEVER write through a link to the real tool: unlink first.
        if os.path.lexists(p):
            os.remove(p)
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

    def test_dark_until_the_panel_paints(self):
        _, _, calls = self.launched(['chromium-browser'])
        self.assertIn('--force-dark-mode', calls[0], calls)
        self.assertIn('--no-first-run', calls[0], calls)

    def test_neither_says_so(self):
        rc, out, calls = self.launched([])
        self.assertEqual(rc, 1)
        self.assertIn('neither chromium-browser nor chromium', out)
        self.assertEqual(calls, [])


class Cage(unittest.TestCase):

    def launched(self, browsers, setup=None, inspect=None, **env):
        r = Rig(browsers)
        try:
            if setup:
                env.update(setup(r) or {})
            r.run(CAGE, **env)
            try:
                with open(os.path.join(r.d, 'session.log')) as f:
                    self.session_log = f.read()
            except OSError:
                self.session_log = ''
            if inspect:
                inspect(r)
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

    def test_start_up_work_is_switched_off(self):
        a = self.launched(['chromium-browser'])[0].split()
        for f in ('--force-dark-mode', '--disable-renderer-accessibility',
                  '--no-first-run', '--disable-component-update',
                  '--disable-background-networking'):
            self.assertIn(f, a)
        feats = [x for x in a if x.startswith('--disable-features=')]
        # Chromium honours only one --disable-features: there must be one.
        self.assertEqual(len(feats), 1, a)
        self.assertIn('PreloadTopChromeWebUI', feats[0].split('=', 1)[1].split(','))
        # Headless-only; it never did anything here and must not come back
        # looking like the fix for the white screen.
        self.assertFalse([x for x in a if x.startswith('--default-background-color')], a)

    def test_the_fallback_flag_set_is_the_same_minus_wayland(self):
        # A cage that exits at once: the loop goes to FLAGS_B after two,
        # then gives up after five. sleep is stubbed so this takes no time.
        def setup(r):
            r.stub('sleep', ':')
            r.stub('cage', 'shift 2; printf "cage %s\\n" "$*" >> ' + r.log)
        calls = self.launched(['chromium-browser'], setup=setup, GOOD_RUN='999')
        self.assertGreaterEqual(len(calls), 3, calls)
        a, b = calls[0].split(), calls[2].split()
        self.assertIn('--ozone-platform=wayland', a)
        self.assertNotIn('--ozone-platform=wayland', b)
        self.assertEqual([x for x in a if x != '--ozone-platform=wayland'][:-1],
                         b[:-1], (a, b))

    def test_served_url_goes_through_the_dark_launch_page(self):
        def setup(r):
            os.makedirs(os.path.join(r.d, 'boot'))
            shutil.copy(os.path.join(ROOT, 'boot', 'launch.html'),
                        os.path.join(r.d, 'boot', 'launch.html'))
        calls = self.launched(['chromium-browser'], setup=setup,
                              URL='http://localhost:9/confluence_helm.html',
                              FILE_URL='file:///nonexistent.html')
        url = calls[0].split()[-1]
        self.assertTrue(url.startswith('file://'), url)
        page, _, target = url.partition('#')
        self.assertTrue(page.endswith('/boot/launch.html'), url)
        self.assertTrue(target.startswith(
            'http://localhost:9/confluence_helm.html?v='), url)
        self.assertRegex(self.session_log,
                         r'chromium launched \(uptime [\d.?]+s, FLAGS_A\)')

    def test_no_launch_page_means_the_url_itself(self):
        calls = self.launched(['chromium-browser'],
                              URL='http://localhost:9/confluence_helm.html',
                              FILE_URL='file:///nonexistent.html')
        self.assertTrue(calls[0].split()[-1].startswith(
            'http://localhost:9/confluence_helm.html?v='), calls)

    def test_every_theme_name_that_is_asked_for_is_blank(self):
        # gsettings reports the desktop's theme; Chromium draws its own
        # pointer from THAT under cage 0.2.0. It, Adwaita, cage's
        # "default" and Xwayland's "left_ptr" must all reach the blank
        # theme - and the log line must say it checked them.
        def setup(r):
            icons = os.path.join(r.d, 'icons')
            subprocess.run(['python3', os.path.join(ROOT, 'boot',
                            'make-blank-cursor.py'),
                            os.path.join(icons, 'Confluence-blank')],
                           check=True, capture_output=True)
            # The desktop's theme, visible, also on the path.
            os.makedirs(os.path.join(icons, 'PiXflat', 'cursors'))
            os.makedirs(os.path.join(r.d, 'boot'))
            for f in ('check-cursor.py', 'make-blank-cursor.py'):
                shutil.copy(os.path.join(ROOT, 'boot', f),
                            os.path.join(r.d, 'boot', f))
            r.stub('gsettings', "echo \"'PiXflat'\"")
            r.stub('cage', 'shift 2; printf "cage %s\\n" "$*" >> ' + r.log
                   + '; printf "env %s\\n" "$XCURSOR_PATH" >> ' + r.log
                   + '; kill -TERM $PPID')
            self.icons, self.alias = icons, os.path.join(r.d, 'run', 'al')
            return {'XCURSOR_PATH': icons, 'CURSOR_ALIASES': self.alias}
        def inspect(r):
            self.all_calls = r.calls()
            self.aliases = sorted(os.listdir(self.alias)) \
                if os.path.isdir(self.alias) else []
            self.links = {n: os.readlink(os.path.join(self.alias, n))
                          for n in self.aliases}
        self.launched(['chromium-browser'], setup=setup, inspect=inspect)
        r_calls = self.all_calls
        self.assertEqual(self.aliases, ['Adwaita', 'PiXflat', 'default', 'left_ptr'],
                         self.session_log)
        for n, t in self.links.items():
            self.assertEqual(t, os.path.join(self.icons, 'Confluence-blank'), n)
        env = [c for c in r_calls if c.startswith('env ')]
        self.assertEqual(env[0], 'env %s:%s' % (self.alias, self.icons), r_calls)
        self.assertIn('pointer: hidden (all blank: default, left_ptr, '
                      "Confluence-blank, PiXflat (Chromium))", self.session_log)


class Flags(unittest.TestCase):
    """What the three launchers hand Chromium, read off the scripts."""

    def text(self, p):
        with open(p) as f:
            return f.read()

    def test_no_launcher_uses_the_headless_only_background_switch(self):
        for p in (CAGE, KIOSK, WINDOW):
            code = '\n'.join(l for l in self.text(p).splitlines()
                             if not l.lstrip().startswith('#'))
            self.assertNotIn('--default-background-color', code, p)

    def test_start_kiosk_is_dark_and_skips_the_tab_search_preload(self):
        t = self.text(KIOSK)
        self.assertIn('--force-dark-mode', t)
        self.assertIn('PreloadTopChromeWebUI', t)
        self.assertIn('boot/launch.html', t)
        code = [l for l in t.splitlines() if not l.lstrip().startswith('#')]
        self.assertEqual(sum(l.count('--disable-features=') for l in code), 1)

    def test_launch_page_only_follows_a_url(self):
        t = self.text(os.path.join(ROOT, 'boot', 'launch.html'))
        self.assertIn('location.replace', t)
        self.assertIn('(https?|file):', t)
        self.assertIn('cursor:none!important', t)


if __name__ == '__main__':
    unittest.main(verbosity=1)
