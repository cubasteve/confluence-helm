#!/usr/bin/env python3
"""The blank pointer theme, and the check that says whether it works.

The pointer came back after the November 2026 update while the log said
"hidden", because the check looked at the theme cage uses and not the one
Chromium draws its own pointer from. So these hold three things:

  - the theme carries every name wlroots 0.18 can ask for, and the
    legacy ones Chromium and wlroots fall back to;
  - check-cursor.py fails for a visible or missing core name, says
    "incomplete" (exit 2) for an old theme, and passes a good one;
  - --gtk checks the theme GTK reports, read the way GTK would in that
    environment: the keyfile under GSETTINGS_BACKEND=keyfile, gsettings
    otherwise, Adwaita when neither says.

    python3 tests/cursor_test.py
"""
import importlib.util, os, shutil, struct, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAKE = os.path.join(ROOT, 'boot', 'make-blank-cursor.py')
CHECK = os.path.join(ROOT, 'boot', 'check-cursor.py')

# Read off wlroots 0.18.2, types/wlr_cursor_shape_v1.c, in its order.
WLROOTS_SHAPES = (
    'default context-menu help pointer progress wait cell crosshair text '
    'vertical-text alias copy move no-drop not-allowed grab grabbing '
    'e-resize n-resize ne-resize nw-resize s-resize se-resize sw-resize '
    'w-resize ew-resize ns-resize nesw-resize nwse-resize col-resize '
    'row-resize all-scroll zoom-in zoom-out').split()


def module():
    spec = importlib.util.spec_from_file_location('mbc', MAKE)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def visible_cursor(path):
    """A 1x1 Xcursor whose one pixel is opaque."""
    chunk = struct.pack('<IIIIIIIII', 36, 0xFFFD0002, 24, 1, 1, 1, 0, 0, 0)
    chunk += struct.pack('<I', 0xFF000000)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sIII', b'Xcur', 16, 0x10000, 1)
                + struct.pack('<III', 0xFFFD0002, 24, 28) + chunk)


class Theme(unittest.TestCase):

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='helm-cursor-test-')
        self.icons = os.path.join(self.d, 'icons')
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def make(self, name='Confluence-blank'):
        subprocess.run([sys.executable, MAKE, os.path.join(self.icons, name)],
                       check=True, capture_output=True)
        return os.path.join(self.icons, name)

    def check(self, *args, **env):
        e = {'PATH': self.bin + ':/usr/bin:/bin', 'HOME': self.d,
             'XCURSOR_PATH': self.icons}
        e.update(env)
        p = subprocess.run([sys.executable, CHECK] + list(args), env=e,
                           capture_output=True, text=True, timeout=30)
        return p.returncode, p.stdout + p.stderr

    def gsettings(self, answer):
        p = os.path.join(self.bin, 'gsettings')
        with open(p, 'w') as f:
            f.write('#!/bin/sh\necho "%s"\n' % answer)
        os.chmod(p, 0o755)

    # ---- the theme ---------------------------------------------------

    def test_every_wlroots_shape_name_is_in_the_list(self):
        self.assertEqual([n for n in WLROOTS_SHAPES
                          if n not in module().SHAPES], [])

    def test_the_names_chromium_and_wlroots_fall_back_to(self):
        for n in ('left_ptr', 'hand2', 'xterm', 'watch', 'left_ptr_watch',
                  'fleur', 'sb_h_double_arrow', 'sb_v_double_arrow',
                  'top_left_corner', 'bottom_right_corner', 'question_arrow'):
            self.assertIn(n, module().SHAPES)

    def test_the_built_theme_has_every_name_and_all_of_them_blank(self):
        t = self.make()
        names = set(os.listdir(os.path.join(t, 'cursors')))
        self.assertEqual(names, set(module().SHAPES))
        rc, out = self.check('--all', 'Confluence-blank')
        self.assertEqual(rc, 0, out)
        self.assertIn('other shape names blank', out)

    def test_importing_it_writes_nothing(self):
        cwd = os.getcwd()
        os.chdir(self.d)
        try:
            module()
        finally:
            os.chdir(cwd)
        self.assertEqual(sorted(os.listdir(self.d)), ['bin'])

    def test_the_repo_copy_is_current(self):
        # boot/cursor is what install-cursor.sh copies. Regenerate it with
        # make-blank-cursor.py whenever SHAPES changes.
        rc, out = self.check('--all', 'cursor',
                             XCURSOR_PATH=os.path.join(ROOT, 'boot'))
        self.assertEqual(rc, 0, out)

    # ---- the check ---------------------------------------------------

    def test_an_old_theme_is_incomplete_not_failed(self):
        t = self.make()
        for n in ('zoom-in', 'nwse-resize', 'context-menu'):
            os.remove(os.path.join(t, 'cursors', n))
        rc, out = self.check('Confluence-blank')
        self.assertEqual(rc, 0, out)                 # the core two are fine
        rc, out = self.check('--all', 'Confluence-blank')
        self.assertEqual(rc, 2, out)
        self.assertIn('MISSING', out)
        self.assertIn('install-cursor.sh', out)

    def test_a_visible_core_name_fails(self):
        t = self.make()
        os.remove(os.path.join(t, 'cursors', 'left_ptr'))
        visible_cursor(os.path.join(t, 'cursors', 'left_ptr'))
        rc, out = self.check('--all', 'Confluence-blank')
        self.assertEqual(rc, 1, out)
        self.assertIn('VISIBLE', out)

    def test_a_missing_theme_fails(self):
        self.make()
        rc, out = self.check('Adwaita')
        self.assertEqual(rc, 1, out)
        self.assertIn('NOT FOUND', out)

    # ---- --gtk: the theme Chromium draws from -------------------------

    def test_gtk_name_from_gsettings_is_checked(self):
        t = self.make()
        self.gsettings("'PiXflat'")
        rc, out = self.check('--gtk', 'Confluence-blank')
        self.assertEqual(rc, 1, out)               # PiXflat is not there
        self.assertIn("theme 'PiXflat'  <- what Chromium draws", out)
        os.symlink(t, os.path.join(self.icons, 'PiXflat'))
        rc, out = self.check('--gtk', 'Confluence-blank')
        self.assertEqual(rc, 0, out)
        self.assertIn('checked: Confluence-blank, PiXflat (Chromium)', out)

    def test_no_gsettings_means_adwaita(self):
        self.make()
        rc, out = self.check('--gtk', 'Confluence-blank', PATH=self.bin)
        self.assertIn("theme 'Adwaita'", out)
        self.assertEqual(rc, 1, out)

    def test_keyfile_backend_is_read_like_gtk_reads_it(self):
        self.make()
        self.gsettings("'Adwaita'")                # must NOT be consulted
        kf = os.path.join(self.d, 'cfg', 'glib-2.0', 'settings')
        os.makedirs(kf)
        with open(os.path.join(kf, 'keyfile'), 'w') as f:
            f.write("[org/gnome/desktop/wm/preferences]\ncursor-theme='Nope'\n"
                    "[org/gnome/desktop/interface]\n"
                    "cursor-theme='Confluence-blank'\ncursor-size=24\n")
        rc, out = self.check('--gtk', 'default', GSETTINGS_BACKEND='keyfile',
                             XDG_CONFIG_HOME=os.path.join(self.d, 'cfg'))
        self.assertIn("theme 'Confluence-blank'  <- what Chromium", out)
        self.assertIn('keyfile', out)


if __name__ == '__main__':
    unittest.main(verbosity=1)
