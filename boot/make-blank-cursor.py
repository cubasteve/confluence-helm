#!/usr/bin/env python3
"""Build a cursor theme whose pointer is a single transparent pixel.

Both X11 and Wayland resolve pointers through Xcursor themes, so one
theme covers whichever the Pi is running - unlike `X -nocursor`, which
only exists under X. The file format is small enough to write directly
rather than depend on xcursorgen being installed.

    python3 boot/make-blank-cursor.py boot/cursor
"""
import os, struct, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'boot/cursor'
CURSORS = os.path.join(OUT, 'cursors')
os.makedirs(CURSORS, exist_ok=True)

def blank(size):
    """One Xcursor image chunk: 1x1, fully transparent, no hotspot."""
    IMAGE = 0xFFFD0002
    chunk = struct.pack('<IIIIIIII',
                        36,        # chunk header size
                        IMAGE,     # type
                        size,      # subtype = nominal size
                        1,         # chunk version
                        1, 1,      # width, height
                        0, 0)      # xhot, yhot
    chunk += struct.pack('<I', 0)          # delay (ms)
    chunk += struct.pack('<I', 0x00000000) # one ARGB pixel: transparent
    return IMAGE, size, chunk

# A theme is asked for a nominal size and picks the nearest it has, so
# carry the usual set rather than betting on one.
imgs = [blank(s) for s in (24, 32, 48, 64)]
HEADER = 16
toc_at = HEADER
body_at = HEADER + 12 * len(imgs)
out = struct.pack('<4sIII', b'Xcur', HEADER, 0x00010000, len(imgs))
pos = body_at
for typ, sub, chunk in imgs:
    out += struct.pack('<III', typ, sub, pos)
    pos += len(chunk)
for _, _, chunk in imgs:
    out += chunk

path = os.path.join(CURSORS, 'left_ptr')
open(path, 'wb').write(out)

# Every name a desktop might ask for while it is on screen. Relative
# symlinks so the tree can be copied anywhere.
for name in ('default', 'arrow', 'top_left_arrow', 'pointer', 'hand1',
             'hand2', 'xterm', 'text', 'watch', 'wait', 'progress',
             'crosshair', 'fleur', 'move', 'grabbing', 'not-allowed',
             'left_ptr_watch', 'sb_h_double_arrow', 'sb_v_double_arrow'):
    link = os.path.join(CURSORS, name)
    if os.path.lexists(link):
        os.remove(link)
    os.symlink('left_ptr', link)

for f in ('index.theme', 'cursor.theme'):
    open(os.path.join(OUT, f), 'w').write(
        '[Icon Theme]\n'
        'Name=Confluence-blank\n'
        'Comment=A pointer that is one transparent pixel\n')

print('wrote %s (%d bytes) and %d aliases'
      % (path, len(out), len(os.listdir(CURSORS)) - 1))
