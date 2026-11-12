"""The home screen icon: the dial, in miniature.

    python3 boot/mk-remote-icon.py

Writes boot/remote-icon.svg. The PNG beside it is that file rasterised
at 512 - any renderer will do; this repo uses the chromium the probes
already carry. Run it when a cell on the dial moves; tests/remote_test.py
fails if the icon and the face disagree, which is the whole point of
generating it.

The five rects are the panel's own, lifted from <g id="dial-cells"> in
confluence_helm.html and mapped from the 1080 face into the icon's
circle. So the icon is the same instrument at 1/3 scale rather than a
drawing of one, and if a cell ever moves this file is regenerated from
the new numbers rather than redrawn by eye.
"""
import io, re

HTML = '/home/user/confluence-helm/confluence_helm.html'
OUT = '/home/user/confluence-helm/boot/remote-icon.svg'

src = io.open(HTML, encoding='utf-8').read()
g = src[src.index('<g id="dial-cells">'):src.index('</g>', src.index('<g id="dial-cells">'))]
CELLS = {}
for m in re.finditer(r'data-slot="(\w+)"\s+x="(\d+)"\s+y="(\d+)"\s*\n?\s*'
                     r'width="(\d+)"\s+height="(\d+)"', g):
    CELLS[m.group(1)] = [int(m.group(i)) for i in (2, 3, 4, 5)]
assert len(CELLS) == 5, CELLS
print('read off the glass:', CELLS)

DARK, INK, ACC, DIM = '#0B0C0E', '#F2F4F6', '#4A9EFF', '#1E2429'
R = 196.0                      # the ring, inside the 80% maskable circle
K = R / 540.0                  # 1080 face -> that circle


def m(x, y, w, h):
    return (256 + (x - 540) * K, 256 + (y - 540) * K, w * K, h * K)


body = [
    '<rect width="512" height="512" fill="%s"/>' % DARK,
    # the ring, and the close-hauled groove the glass wears at one o'clock
    '<circle cx="256" cy="256" r="196" fill="none" stroke="%s" stroke-width="14"/>' % DIM,
    '<path d="M256 60 A196 196 0 0 1 427 352" fill="none" stroke="%s" '
    'stroke-width="14" stroke-linecap="round"/>' % ACC,
]
# the big number, the strip under it, and the three cells across the foot
for sl, op, rx in (('c0', .26, 14), ('c4', .50, 8),
                   ('c1', .34, 10), ('c2', .34, 10), ('c3', .34, 10)):
    x, y, w, h = m(*CELLS[sl])
    body.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%d" '
                'fill="%s" opacity="%.2f"/>' % (x, y, w, h, rx, INK, op))

svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
       'viewBox="0 0 512 512">\n<!-- The dial in miniature. The five cells are\n'
       '     the panel\'s own rects from <g id="dial-cells">, mapped from the\n'
       '     1080 face into this circle - generated, not drawn by eye. -->\n'
       + '\n'.join(body) + '\n</svg>\n')
io.open(OUT, 'w').write(svg)
print('wrote', OUT)
