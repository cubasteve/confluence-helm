#!/usr/bin/env python3
"""
Make a double TAP register as a double click.

    python3 ~/helm/boot/touch-tune.py            apply
    python3 ~/helm/boot/touch-tune.py --show     what is set now
    python3 ~/helm/boot/touch-tune.py --revert   put it back exactly

No root. It writes the owner's own GTK settings and keeps a byte-for-byte
backup of whatever was there before, so --revert is a restore rather than
a guess at defaults.

WHY THIS IS NEEDED, and it is not the time:

GTK decides "that was a double click" from two thresholds - how long
between the taps, and how far apart they were. The default distance is
FIVE PIXELS. That is a sensible number for a mouse, which does not move
at all between clicks, and a hopeless one for a finger on glass: two
deliberate taps in the same place routinely land 15-25px apart, so GTK
scores them as two separate single clicks and nothing opens. People then
tap harder and faster, which makes the spread worse.

So the distance is the fix and the time is the smaller half. 30px and
500ms is a touch panel's version of the same intent.

This deliberately does NOT turn on single-click-to-open. That would make
both gestures do the same thing, and the point here is to keep them
telling apart: one tap selects, two open.

GTK reads these at application start, so log out and back in - or from
the helm, the Desktop tile then the Kiosk tile - before judging it.
"""
import os
import re
import shutil
import sys

HOME = os.path.expanduser('~')
GTK3 = os.path.join(HOME, '.config', 'gtk-3.0', 'settings.ini')
GTK2 = os.path.join(HOME, '.gtkrc-2.0')
BAK = '.confluence-touch-bak'

TIME_MS = 500
DIST_PX = 30
KEYS = (('gtk-double-click-time', TIME_MS), ('gtk-double-click-distance', DIST_PX))


def backup(path):
    """Once, and only once. A second run must not overwrite the record of
    what the file looked like BEFORE any of this touched it - that is the
    same trap install-cage-kiosk.sh documents about the default target,
    where the second run recorded its own first run as the original."""
    b = path + BAK
    if os.path.exists(path) and not os.path.exists(b):
        shutil.copy2(path, b)
        return 'backed up'
    return 'backup already exists' if os.path.exists(b) else 'nothing to back up'


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return ''
    except Exception as e:
        print('  cannot read %s: %s' % (path, e))
        return ''


def write(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


def set_ini(text):
    """GTK3's settings.ini. The keys have to land INSIDE [Settings] - a
    key appended after some other section is in that section instead, and
    GTK simply never sees it. So this rewrites in place where the key
    already exists and otherwise inserts at the top of [Settings],
    creating the section only if there is none."""
    out, done = [], {k: False for k, _ in KEYS}
    in_settings = False
    saw_settings = False
    for line in text.split('\n'):
        head = re.match(r'\s*\[(.+?)\]\s*$', line)
        if head:
            in_settings = head.group(1).strip().lower() == 'settings'
            saw_settings = saw_settings or in_settings
            out.append(line)
            if in_settings:
                for k, v in KEYS:
                    out.append('%s=%s' % (k, v))
                    done[k] = True
            continue
        m = re.match(r'\s*([\w-]+)\s*=', line)
        if m and m.group(1) in done and in_settings:
            continue                       # replaced by the line above
        out.append(line)
    if not saw_settings:
        out = ['[Settings]'] + ['%s=%s' % (k, v) for k, v in KEYS] + [''] + out
    return '\n'.join(out).strip('\n') + '\n'


def set_rc(text):
    """GTK2's .gtkrc-2.0 - flat `key = value` lines, no sections."""
    out = [l for l in text.split('\n')
           if not re.match(r'\s*gtk-double-click-(time|distance)\s*=', l)]
    out += ['%s = %s' % (k, v) for k, v in KEYS]
    return '\n'.join(out).strip('\n') + '\n'


def show():
    for path in (GTK3, GTK2):
        txt = read(path)
        print('%s%s' % (path, '' if txt else '   (does not exist)'))
        hits = [l.strip() for l in txt.split('\n')
                if 'double-click' in l]
        for h in hits or ['   (nothing set - GTK defaults: 400ms, 5px)']:
            print('   ' + h if hits else h)
        b = path + BAK
        if os.path.exists(b):
            print('   backup: ' + b)
    return 0


def revert():
    n = 0
    for path in (GTK3, GTK2):
        b = path + BAK
        if os.path.exists(b):
            shutil.copy2(b, path)
            os.remove(b)
            print('restored %s' % path)
            n += 1
        elif os.path.exists(path) and 'double-click' in read(path):
            # Applied when the file did not exist, so the restore is a
            # removal of what was added rather than of the whole file -
            # anything else here was not ours to delete.
            txt = '\n'.join(l for l in read(path).split('\n')
                            if 'gtk-double-click-' not in l)
            write(path, txt.strip('\n') + '\n')
            print('removed the two keys from %s' % path)
            n += 1
    if not n:
        print('nothing to revert')
    return 0


def apply():
    print('double-click window: %dms, and %dpx of slop between the taps'
          % (TIME_MS, DIST_PX))
    print('(GTK defaults are 400ms and 5px - the 5 is what fails on glass)')
    for path, fn in ((GTK3, set_ini), (GTK2, set_rc)):
        print('%s  [%s]' % (path, backup(path)))
        write(path, fn(read(path)))
    print()
    print('GTK reads these when an application STARTS, so nothing already')
    print('running will change. Log out and back in - or from the helm, tap')
    print('Desktop and then Kiosk - before judging it.')
    return 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if '--show' in a:
        sys.exit(show())
    if '--revert' in a:
        sys.exit(revert())
    sys.exit(apply())
