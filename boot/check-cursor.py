#!/usr/bin/env python3
"""Resolve a cursor theme the way libxcursor does, and say whether the
pointer it produces is actually invisible.

This exists because the pointer kept coming back and nothing said why.
Three separate things have to line up - the theme directory, the file
format inside it, and which theme name the compositor asks for - and
when any one of them is wrong the only symptom is an arrow on the glass
for a couple of seconds at boot, with no log line anywhere.

    python3 boot/check-cursor.py                    # check both names
    python3 boot/check-cursor.py Confluence-blank   # check one
    python3 boot/check-cursor.py --gtk              # and the one Chromium uses
    python3 boot/check-cursor.py --all              # every shape name, too
    python3 boot/check-cursor.py --verbose

--gtk adds the theme Chromium itself draws from. Under cage 0.2.0 that is
the pointer you actually see: cage offers no cursor-shape protocol, so
Chromium renders its own arrow from the GTK setting
org.gnome.desktop.interface cursor-theme - not XCURSOR_THEME, not the
compositor's theme. It is read the way GTK would read it in THIS
environment: from the keyfile when GSETTINGS_BACKEND=keyfile (what
cage-session.sh gives Chromium), from `gsettings` otherwise.

--all also checks every name in make-blank-cursor.py's SHAPES list,
not only "default" and "left_ptr".

Exit status:
  0  every theme checked resolves to cursors whose every pixel is
     fully transparent
  1  "default" or "left_ptr" draws something (or is missing): a pointer
     WILL be on the glass
  2  only with --all: those two are blank, but some other shape name is
     missing or visible - an installed theme older than this repo's.
     Re-run install-cursor.sh.

The search path and the inheritance rules below are libxcursor's, from
XcursorLibraryPath() and _XcursorThemeInherits(). Keep them that way: a
check that is merely plausible is worse than no check, because it tells
you the thing is fine while the arrow is still there.
"""
import os
import struct
import sys

VERBOSE = '--verbose' in sys.argv or '-v' in sys.argv
GTK = '--gtk' in sys.argv
ALL = '--all' in sys.argv
NAMES = [a for a in sys.argv[1:] if not a.startswith('-')] or \
        ['default', 'Confluence-blank']

HERE = os.path.dirname(os.path.abspath(__file__))
# The two names every stack asks for. wlroots asks for "default"; X11
# stacks, cage's own cursor and Chromium's pointer ask for "left_ptr".
CORE = ('default', 'left_ptr')


def shapes():
    """make-blank-cursor.py's list, so the check and the theme it checks
    cannot drift apart. Only the core two if that file is not beside
    this one."""
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            'make_blank_cursor', os.path.join(HERE, 'make-blank-cursor.py'))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return tuple(m.SHAPES)
    except Exception:
        return CORE

# GTK's schema default, which is what it uses when nothing is set.
GTK_DEFAULT = 'Adwaita'


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    return v


def gtk_theme():
    """(name, where it came from) for the cursor theme GTK - and so
    Chromium - will ask for in this environment."""
    if os.environ.get('GSETTINGS_BACKEND') == 'keyfile':
        base = os.environ.get('XDG_CONFIG_HOME') or \
            os.path.expanduser('~/.config')
        kf = os.path.join(base, 'glib-2.0', 'settings', 'keyfile')
        group = None
        try:
            with open(kf, errors='replace') as f:
                for line in f:
                    t = line.strip()
                    if t.startswith('[') and t.endswith(']'):
                        group = t[1:-1]
                    elif group == 'org/gnome/desktop/interface' and \
                            t.partition('=')[0].strip() == 'cursor-theme':
                        v = _unquote(t.partition('=')[2])
                        if v:
                            return v, 'keyfile %s' % kf
        except OSError:
            return GTK_DEFAULT, 'no keyfile at %s: the schema default' % kf
        return GTK_DEFAULT, 'not set in %s: the schema default' % kf
    import shutil, subprocess
    if not shutil.which('gsettings'):
        return GTK_DEFAULT, 'no gsettings here: assuming the schema default'
    try:
        p = subprocess.run(['gsettings', 'get', 'org.gnome.desktop.interface',
                            'cursor-theme'], capture_output=True, text=True,
                           timeout=10)
        v = _unquote(p.stdout)
        if p.returncode == 0 and v:
            return v, 'gsettings'
    except Exception:
        pass
    return GTK_DEFAULT, 'gsettings gave no answer: assuming the schema default'

# XCURSOR_PATH, or libxcursor's compiled-in default. The env var wins
# whole, it does not append - same as the library.
DEFAULT_PATH = ('~/.local/share/icons:~/.icons:/usr/share/icons:'
                '/usr/share/pixmaps:/usr/X11R6/lib/X11/icons')
PATH = os.environ.get('XCURSOR_PATH') or DEFAULT_PATH
DIRS = [os.path.expanduser(p) for p in PATH.split(':') if p]

IMAGE = 0xFFFD0002


def say(*a):
    if VERBOSE:
        print('   ', *a)


def inherits(theme_dir):
    """The Inherits= line, read the way libxcursor reads it: first match
    wins, and the value is comma/semicolon/space separated."""
    for fn in ('index.theme', 'cursor.theme'):
        p = os.path.join(theme_dir, fn)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, 'r', errors='replace') as f:
                for line in f:
                    if line.strip().lower().startswith('inherits'):
                        _, _, val = line.partition('=')
                        parts = val.replace(';', ',').replace(' ', ',').split(',')
                        return [x.strip() for x in parts if x.strip()]
        except OSError:
            pass
    return []


def find_cursor(theme, name, seen=None):
    """Return the path of `name` in `theme`, following Inherits. Depth is
    bounded because a theme that inherits itself is a real thing people
    ship, and libxcursor guards against it too."""
    if seen is None:
        seen = set()
    if theme in seen or len(seen) > 32:
        return None
    seen.add(theme)
    for d in DIRS:
        cand = os.path.join(d, theme, 'cursors', name)
        if os.path.exists(cand):          # exists() follows the symlink
            return cand
    for d in DIRS:
        td = os.path.join(d, theme)
        if not os.path.isdir(td):
            continue
        for parent in inherits(td):
            got = find_cursor(parent, name, seen)
            if got:
                return got
    return None


def transparent(path):
    """Parse an Xcursor file with libxcursor's own sanity checks, and
    report whether every image in it is fully transparent.

    Returns (ok, detail). ok is False for a file libxcursor would reject
    as well as for one that draws something - both end with an arrow on
    the screen, so both are failures here."""
    try:
        d = open(path, 'rb').read()
    except OSError as e:
        return False, 'unreadable: %s' % e
    if len(d) < 16:
        return False, 'too short to be an Xcursor file'
    magic, hdr, ver, ntoc = struct.unpack('<4sIII', d[:16])
    if magic != b'Xcur':
        return False, 'not an Xcursor file (magic %r)' % magic
    if ntoc == 0:
        return False, 'no table of contents'
    images = 0
    for i in range(ntoc):
        off = 16 + 12 * i
        if off + 12 > len(d):
            return False, 'truncated table of contents'
        typ, sub, pos = struct.unpack('<III', d[off:off + 12])
        if typ != IMAGE:
            continue                       # comments and the like
        if pos + 36 > len(d):
            return False, 'chunk %d runs past the end of the file' % i
        chdr, ctype, csub, _cver = struct.unpack('<IIII', d[pos:pos + 16])
        if ctype != typ or csub != sub:
            return False, 'chunk %d disagrees with the toc' % i
        w, h, xh, yh, _delay = struct.unpack('<IIIII', d[pos + 16:pos + 36])
        if w == 0 or h == 0 or w > 0x7fff or h > 0x7fff:
            return False, 'chunk %d has bad dimensions %dx%d' % (i, w, h)
        if xh > w or yh > h:
            return False, 'chunk %d has its hotspot outside the image' % i
        px = d[pos + 36:pos + 36 + w * h * 4]
        if len(px) != w * h * 4:
            return False, 'chunk %d has short pixel data' % i
        opaque = sum(1 for j in range(w * h) if px[j * 4 + 3] != 0)
        say('%s: %dx%d at nominal %d, %d of %d pixels visible'
            % (os.path.basename(path), w, h, sub, opaque, w * h))
        if opaque:
            return False, ('nominal size %d draws %d visible pixels'
                           % (sub, opaque))
        images += 1
    if not images:
        return False, 'no image chunks'
    return True, '%d sizes, all fully transparent' % images


def check(theme, why=''):
    """0 if blank, 1 if a core name draws, 2 if only another shape does."""
    print('theme %r%s' % (theme, ('  <- ' + why) if why else ''))
    say('search path:', ':'.join(DIRS))
    core_bad = 0
    for name in CORE:
        p = find_cursor(theme, name)
        if not p:
            print('   %-10s NOT FOUND - the compositor falls back to its '
                  'own arrow' % name)
            core_bad += 1
            continue
        real = os.path.realpath(p)
        ok, detail = transparent(p)
        where = p if real == p else '%s -> %s' % (p, os.path.relpath(real, os.path.dirname(p)))
        print('   %-10s %s  %s' % (name, 'blank ' if ok else 'VISIBLE', where))
        if not ok:
            print('              %s' % detail)
            core_bad += 1
    if core_bad:
        return 1
    if not ALL:
        return 0
    missing, visible = [], []
    for name in shapes():
        if name in CORE:
            continue
        p = find_cursor(theme, name)
        if not p:
            missing.append(name)
        elif not transparent(p)[0]:
            visible.append(name)
    n = len(shapes()) - len(CORE)
    if not missing and not visible:
        print('   and all %d other shape names blank' % n)
        return 0
    if missing:
        print('   %d of %d other shape names MISSING: %s'
              % (len(missing), n, ' '.join(missing[:8])
                 + (' ...' if len(missing) > 8 else '')))
    if visible:
        print('   %d other shape names VISIBLE: %s'
              % (len(visible), ' '.join(visible[:8])
                 + (' ...' if len(visible) > 8 else '')))
    return 2


if __name__ == '__main__':
    todo = [(n, '') for n in NAMES]
    if GTK:
        g, src = gtk_theme()
        todo.append((g, 'what Chromium draws its own pointer from (%s)' % src))
    worst = 0
    checked = []
    for n, why in todo:
        worst = max(worst, check(n, why))
        checked.append(n + (' (Chromium)' if why else ''))
        print()
    if worst == 0:
        print('OK - the pointer is invisible for every theme checked: %s'
              % ', '.join(checked))
    elif worst == 2:
        print('INCOMPLETE - no pointer for the names in use today, but the '
              'installed theme lacks some shape names. Re-run '
              'install-cursor.sh.')
    else:
        print('FAILED - a pointer will be drawn. See above for which name.')
    sys.exit(worst)
