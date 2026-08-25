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
    python3 boot/check-cursor.py --verbose

Exit status is 0 only if every theme checked resolves to a cursor whose
every pixel is fully transparent.

The search path and the inheritance rules below are libxcursor's, from
XcursorLibraryPath() and _XcursorThemeInherits(). Keep them that way: a
check that is merely plausible is worse than no check, because it tells
you the thing is fine while the arrow is still there.
"""
import os
import struct
import sys

VERBOSE = '--verbose' in sys.argv or '-v' in sys.argv
NAMES = [a for a in sys.argv[1:] if not a.startswith('-')] or \
        ['default', 'Confluence-blank']

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


def check(theme):
    print('theme %r' % theme)
    say('search path:', ':'.join(DIRS))
    bad = 0
    # The names that matter. wlroots asks for "default"; X11 stacks and
    # older toolkits ask for "left_ptr". Both have to be blank, because
    # which one you get depends on the compositor, not on us.
    for name in ('default', 'left_ptr'):
        p = find_cursor(theme, name)
        if not p:
            print('   %-10s NOT FOUND - the compositor falls back to its '
                  'own arrow' % name)
            bad += 1
            continue
        real = os.path.realpath(p)
        ok, detail = transparent(p)
        where = p if real == p else '%s -> %s' % (p, os.path.relpath(real, os.path.dirname(p)))
        print('   %-10s %s  %s' % (name, 'blank ' if ok else 'VISIBLE', where))
        if not ok:
            print('              %s' % detail)
            bad += 1
    return bad == 0


if __name__ == '__main__':
    allok = True
    for n in NAMES:
        allok &= check(n)
        print()
    if allok:
        print('OK - the pointer is invisible for every theme checked.')
    else:
        print('FAILED - a pointer will be drawn. See above for which name.')
    sys.exit(0 if allok else 1)
