#!/usr/bin/env python3
"""Find marks of your own that were deleted, in Chromium's old storage.

    python3 ~/helm/boot/mark-recover.py

READ-ONLY. It opens Chromium's LevelDB files and reads bytes; it writes
nothing, locks nothing and needs no sudo.

---- why there is anything to find -------------------------------------

A mark of your own IS its position - there is nothing underneath it to
go back to, unlike a club mark, where dropping a correction leaves the
book's number. markDelete rewrites localStorage['marks'] without it and
that is the end of it, as far as the app is concerned.

But LevelDB does not overwrite in place. A new value is appended to the
write-ahead log and the old record stays on disk until a compaction
gets round to it. So for a while - hours, often days on a panel that is
mostly idle - the deleted mark is still there, in a file nothing has
reason to touch.

That window is the whole reason this exists, and it is why the first
thing it says is to stop writing to it.

---- the two encodings -------------------------------------------------

Chromium prefixes a localStorage value with one byte saying how the rest
is encoded: 0x01 for Latin-1, 0x00 for UTF-16LE. Which one you get
depends on the characters in the value, so the same key can be written
one way today and the other way tomorrow. Both are searched, because
searching only the obvious one finds nothing and says "they are gone",
which is the worst answer this can give.
"""
import glob
import json
import os
import re
import sys

# One mark object as JSON.stringify writes it - no spaces, and no nested
# braces inside, so a non-greedy run to the first '}' is exact.
PAT = re.compile(rb'\{"id":"u[^}]{0,400}\}')

DEFAULT = os.path.expanduser('~/.config/chromium/Default/Local Storage/leveldb')


def dm(v, pos, neg, w):
    """The way the mark sheet writes a position, so what is printed here
    can be compared with what is on the glass without converting
    anything in your head."""
    a = abs(v)
    d = int(a)
    return '%s %.3f%s' % (str(d).rjust(w, '0'), (a - d) * 60, neg if v < 0 else pos)


def form(v):
    """And the way the NEW MARK form wants it typed: degrees, a space,
    decimal minutes, with a minus for south or west. That is fmtDM."""
    s = '-' if v < 0 else ''
    a = abs(v)
    d = int(a)
    return '%s%d %.3f' % (s, d, (a - d) * 60)


def harvest(path):
    """Every mark object in one file, in both encodings."""
    try:
        with open(path, 'rb') as f:
            raw = f.read()
    except OSError:
        return []
    out = []
    for m in PAT.finditer(raw):
        out.append(m.group(0).decode('latin-1'))
    # UTF-16LE: the same bytes with a NUL between each. Decoding the
    # whole file would choke on the binary around it, so the pattern is
    # widened instead.
    wide = re.compile(
        b''.join(bytes([c]) + b'\x00' for c in b'{"id":"u') +
        b'(?:[^\x00]\x00){0,400}?' + b'}\x00')
    for m in wide.finditer(raw):
        try:
            out.append(m.group(0).decode('utf-16-le'))
        except UnicodeDecodeError:
            pass
    return out


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.isdir(d):
        print('No Chromium storage at:\n   %s' % d)
        print('\nIf the kiosk runs as another user, point me at theirs:')
        print('   python3 %s /home/SOMEONE/.config/chromium/Default/Local\\ Storage/leveldb'
              % sys.argv[0])
        return 1

    files = sorted(glob.glob(os.path.join(d, '*.log')) +
                   glob.glob(os.path.join(d, '*.ldb')))
    if not files:
        print('Nothing to read in %s' % d)
        return 1

    seen, marks = set(), []
    for p in files:
        for js in harvest(p):
            try:
                m = json.loads(js)
            except ValueError:
                continue
            if not isinstance(m, dict) or 'lat' not in m or 'lon' not in m:
                continue
            key = (m.get('name', ''), round(m['lat'], 6), round(m['lon'], 6))
            if key in seen:
                continue
            seen.add(key)
            marks.append((m, os.path.basename(p)))

    print('Looked in %d file%s under' % (len(files), '' if len(files) == 1 else 's'))
    print('   %s\n' % d)
    if not marks:
        print('No marks of your own found, in either encoding.')
        print('')
        print('That means a compaction has already been through, and they')
        print('are not recoverable from here. The club marks are untouched')
        print('either way - those cannot be deleted at all.')
        return 1

    print('%d mark%s ever written, newest storage last. A deleted one is'
          % (len(marks), '' if len(marks) == 1 else 's'))
    print('still listed here - that is the point - so expect to see ones')
    print('you still have alongside the ones you lost.\n')
    for m, src in marks:
        try:
            lat, lon = float(m['lat']), float(m['lon'])
        except (TypeError, ValueError):
            continue
        print('  %-18s %s · %s' % (m.get('name', '(unnamed)'),
                                   dm(lat, 'N', 'S', 2), dm(lon, 'E', 'W', 3)))
        print('  %-18s NEW MARK:  name %s   lat %s   lon %s'
              % ('', m.get('name', ''), form(lat), form(lon)))
        print('  %-18s (%s, buoy %s)\n' % ('', src, m.get('buoy', '?')))
    print('Type the NEW MARK line into the course sheet to put one back.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
