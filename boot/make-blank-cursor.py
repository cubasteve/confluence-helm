#!/usr/bin/env python3
"""Build a cursor theme whose pointer is a single transparent pixel.

Both X11 and Wayland resolve pointers through Xcursor themes, so one
theme covers whichever the Pi is running - unlike `X -nocursor`, which
only exists under X. The file format is small enough to write directly
rather than depend on xcursorgen being installed.

    python3 boot/make-blank-cursor.py boot/cursor

Importable as well (check-cursor.py takes SHAPES from here), so nothing
runs at import time.
"""
import os, struct, sys


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


def blank_file():
    """The whole Xcursor file. A theme is asked for a nominal size and
    picks the nearest it has, so carry the usual set rather than betting
    on one."""
    imgs = [blank(s) for s in (24, 32, 48, 64)]
    HEADER = 16
    body_at = HEADER + 12 * len(imgs)
    out = struct.pack('<4sIII', b'Xcur', HEADER, 0x00010000, len(imgs))
    pos = body_at
    for typ, sub, chunk in imgs:
        out += struct.pack('<III', typ, sub, pos)
        pos += len(chunk)
    for _, _, chunk in imgs:
        out += chunk
    return out


# Every name anything on this Pi might ask for while it is on screen.
# Relative symlinks so the tree can be copied anywhere.
#
# A name the theme does not have is not "nothing drawn": libwayland-cursor
# and wlroots both hand back a miss, and the caller substitutes an arrow
# of its own. So the list is deliberately the union of everything:
#
#   - every name wlroots 0.18 maps a wp_cursor_shape_v1 shape to
#     (types/wlr_cursor_shape_v1.c). cage 0.2.0 does not offer that
#     protocol, but the next cage that does would otherwise draw an
#     arrow for every shape this list forgot;
#   - the legacy X11 names wlroots falls back to for those shapes
#     (xcursor/wlr_xcursor.c), and the ones Chromium asks for itself when
#     it draws its own pointer (CursorNamesFromType) - which is what it
#     does under cage 0.2.0, and was the arrow in the middle of the glass.
#
# check-cursor.py reads this same list (it imports SHAPES from here), so
# the check and the theme cannot drift apart.
SHAPES = (
    # wlroots 0.18 cursor-shape names, in its order
    'default', 'context-menu', 'help', 'pointer', 'progress', 'wait',
    'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move',
    'no-drop', 'not-allowed', 'grab', 'grabbing',
    'e-resize', 'n-resize', 'ne-resize', 'nw-resize', 's-resize',
    'se-resize', 'sw-resize', 'w-resize', 'ew-resize', 'ns-resize',
    'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize',
    'all-scroll', 'zoom-in', 'zoom-out',
    # legacy X11 names: wlroots' fallbacks, Chromium's own, older toolkits
    'left_ptr', 'arrow', 'top_left_arrow', 'hand1', 'hand2',
    'pointing_hand', 'xterm', 'ibeam', 'watch', 'left_ptr_watch',
    'half-busy', 'question_arrow', 'whats_this', 'cross', 'tcross',
    'plus', 'fleur', 'size_all', 'openhand', 'closedhand',
    'dnd-move', 'dnd-copy', 'dnd-link', 'dnd-none', 'dnd-no-drop',
    'dnd-ask', 'crossed_circle', 'circle', 'forbidden', 'X_cursor',
    'pirate', 'link', 'right_ptr', 'center_ptr', 'draft_large',
    'draft_small', 'color-picker', 'pencil', 'context_menu',
    'sb_h_double_arrow', 'sb_v_double_arrow', 'h_double_arrow',
    'v_double_arrow', 'size_hor', 'size_ver', 'size_bdiag', 'size_fdiag',
    'bd_double_arrow', 'fd_double_arrow', 'split_h', 'split_v',
    'top_left_corner', 'top_right_corner', 'bottom_left_corner',
    'bottom_right_corner', 'top_side', 'bottom_side', 'left_side',
    'right_side', 'ul_angle', 'ur_angle', 'll_angle', 'lr_angle',
    'sb_up_arrow', 'sb_down_arrow', 'sb_left_arrow', 'sb_right_arrow',
    'col_resize', 'row_resize', 'zoom_in', 'zoom_out',
)


def write_theme(out):
    """The whole theme under `out`: one blank file, every name above
    linked to it, and the two index files."""
    cursors = os.path.join(out, 'cursors')
    os.makedirs(cursors, exist_ok=True)
    path = os.path.join(cursors, 'left_ptr')
    if os.path.islink(path):
        os.remove(path)
    with open(path, 'wb') as f:
        f.write(blank_file())
    for name in SHAPES:
        if name == 'left_ptr':
            continue
        link = os.path.join(cursors, name)
        if os.path.lexists(link):
            os.remove(link)
        os.symlink('left_ptr', link)
    write_index(out)
    return path

# Inherits= naming this very theme looks like a mistake and is not: it is
# what makes the theme usable through the x-cursor-theme alternatives
# chain, where /usr/share/icons/default/index.theme is a SYMLINK to this
# file. Read from that path there is no cursors/ directory beside it, so
# without the Inherits line the lookup finds nothing and the compositor
# draws its own arrow. Debian's own DMZ-White does exactly this. Read
# from inside the theme the line is harmless - libxcursor checks the
# theme's own cursors/ directory before it follows any inheritance.
def write_index(out):
    for f in ('index.theme', 'cursor.theme'):
        with open(os.path.join(out, f), 'w') as fh:
            fh.write('[Icon Theme]\n'
                     'Name=Confluence-blank\n'
                     'Comment=A pointer that is one transparent pixel\n'
                     'Inherits=Confluence-blank\n')


if __name__ == '__main__':
    OUT = sys.argv[1] if len(sys.argv) > 1 else 'boot/cursor'
    path = write_theme(OUT)
    print('wrote %s (%d bytes) and %d aliases'
          % (path, os.path.getsize(path),
             len(os.listdir(os.path.join(OUT, 'cursors'))) - 1))
