# Tracks

Recording a sail, keeping it, and getting it off the boat.

[← back to the README](../README.md)

## Tracks

The race track map used to be page 0 of the carousel. It is an app now,
which leaves the dial and the music as the two pages and the dock as the
way to everything else.

It is the **same markup and the same listeners**: `#tmap` is *moved*
into the app body rather than rebuilt, so a hundred-odd ids and
everything bound to them at boot keep working without being re-wired. It
goes back to its parking place on close — before `closeApp` empties the
body, or the whole page would be thrown away with it. Parked, it is
`display:none` and costs layout nothing.

What it gives back is what it actually costs while it is up:

| | closed | open | closed again |
|---|---|---|---|
| DOM nodes | 1014 | 1899 | **920** |
| satellite tiles | 0 | 16 | **0** |
| track segments | 0 | 859 | **0** |
| JS heap | 1.9 MB | 2.2 MB | 1.8 MB |

Detaching the subtree does **not** free those. It only makes them
eligible, and a hidden page full of decoded tile bitmaps is exactly the
sort of thing that sits in a Pi's heap until something else needs the
room. Emptying `#t-tiles` and `#t-path` by hand is what frees them, along
with `MAPVIEW`, a race loaded out of the library, and the cached server
track. The redraw loop stops on its own: it was already gated on
`#tmap.open`, which goes with the app.

CPU while it is open measures *lower* than at rest — 1.0% against 1.8%
— because `dialVisible()` is false with any app up, so the dial stops
drawing. The map costs less than the instrument it replaces.

The numbering deliberately did not shift down. `PAGE_I===1` means the
dial in a dozen places and `PAGE_I===2` the music; renumbering to save
one unused integer would have been a dozen chances to get it wrong for
nothing. Pages now run 1..2 and `PAGE_MIN` says so.

### The icon

Tesla's FSD glyph, translated: the route running away up the glass with
the boat riding it. Three drafts died on the way there, and all for the
same reason — at `stroke-width:1.9` in a 24-unit box, three diagonal
outlines have nowhere to be. A stroked arrow on a stroked band merged
into a monogram every time; the first two attempts read as **W** and
then as **A**.

What fixed it was the **filled** marker. Solid, it needs no internal gap
and cannot fuse with what it sits on, and it keeps 1.5 units of clear
glass either side of it inside the band.

The first diagonal attempt failed for a different reason than I read at
the time: I blamed the diagonal, tried a perspective road instead, and
shipped that. The diagonal was fine — the band was simply too narrow and
the arrow too small. Widened to 10.8 units with a longer, narrower
marker, it holds at 46px as well as large, and it is the reference's
geometry rather than a substitute for it.

Rendered every version side by side at both sizes to pick, because the
one that looks better at 132px is not reliably the one that survives
at 46.

### Deleting a track off the boat

The library has two lists and they were not equal. **Saved here** is
IndexedDB, per device, and has always had a `✕`. **On the boat** is the
`gpx` folder AvNav serves, which every device on the boat WiFi can see
— and it offered download and a QR code and no way to get rid of
anything. That is the half you cannot clean up from a phone *or* from
the helm, because the file is on the Pi.

So netd gained `/gpx/delete`, and the row gained a bin. The delete asks
first: one tap arms it and the button stops being round and says
`SURE?` in the alarm colour, a second does it, and four seconds or a tap
elsewhere disarms. It does not come back — every device on the boat
loses that track at once.

**The listing is the authority** on which names are legal, not a
sanitiser. `gpx_save` sanitises because it is inventing a filename from
a race title someone typed; doing the same on delete would be wrong in
both directions. It cannot make an unsafe name safe that membership
would not already refuse, and it mangles the legitimate ones — a file
called `Race one.gpx`, which is what you get if anyone drops a track in
by hand, would become `Race-one.gpx` and could never be deleted at all.
That was not a theory: the first version did exactly that and its own
test caught it refusing a file sitting right there.

### Two-word names break at the space

A dock label breaks where the name has a space, not where 150px runs
out. `GOLDEN HOUR` fits on one line at 139 of 150 and would never wrap
on its own, and a label that wraps only once it is a few pixels too long
is a layout that changes shape the next time somebody renames an app.

It is a newline with `white-space:pre-line`, **not** a `<br>`. The tag
eats the space, so `textContent` came back as `GOLDENHOUR` — which is
what anything reading the label rather than looking at it would get.

The tiles stay top-aligned, so the icons still sit level across the row
and only the dock grows: 149px to 175, with its lowest corners still
529 from the centre.

### One pill, four apps

The name pill at y44 is the header, and it is the same in all four:
same line, same height, same size and weight and tracking, same padding
and corner, same background. What sits **under** it is each app's own
business — and three of the four have nothing to say there.

It used to be `background:var(--panel)`. On Radar and Golden Hour that
sits on a photograph and reads as the chip it is; on Course and Tracks,
whose own background *is* the panel, it was the same colour as what it
sat on — a name floating in the middle of nothing. One step off, to
`--chip`, shows the shape in all four.

**And it is painted over the app now.** `#tmap` carries `z-index:1` from
the days it was a page rather than an app, and inside `#app-run` that
was enough to paint the map over the pill and the top of the close
cross. Tracks was the one app whose name you could not read.
`#app-name`, `#app-msg` and `#app-close` sit at `z-index:3`.

Under the pill:

| app | |
|---|---|
| Radar | its HUD: the sweep's time, and what it is doing or why it is not |
| Course | **nothing**. It said how far round the course was; the strip two rows down says what the course is, which is the question |
| Tracks | **nothing**, until a race is loaded. It said `TRACKS` under a pill already saying `TRACKS`, over `IMAGERY © ESRI` |
| Golden Hour | the sun's state and its altitude — that is the app |

`.a-h1` (28 px, 600, `.24em`) over `.a-h2` (17 px, `.1em`) is still the
format for what does appear, so the map's line and the sun's match. The
map's is **empty until a race is loaded** out of the library, and then
it is that race's name — a name the pill cannot know. An empty `.a-h1`
collapses (`:empty{display:none}`), so a map with nothing loaded shows
nothing but its pill.

**The Esri credit came off the glass**, by request. It was the line
under the map's head. Worth knowing what that means: the imagery comes
from Esri's unkeyed World Imagery service, whose terms ask for
attribution, and this app now shows it in one place only — the radar's
HUD, which credits `Esri` along with BrightVoyant, Tomorrow.io and
Open-Meteo. The tiles are used by the map, the course preview and the
radar alike.

That last bit has a consequence: `publishGPX` names a file after that
line, and it is now empty rather than `Tracks`, so a track sent with
nothing loaded is `Confluence-<stamp>` — the check is simply whether
there is a name at all.

Two things that came with the page becoming an appTwo things that came with the page becoming an app, both of them the
same mistake — furniture that belonged to a page still standing where
the app's own chrome now goes:

- **the map's lock button**, which sat at the foot of the glass exactly
  where the app's close cross does now. A page you could be locked on
  needed it; an app does not.

That cross is the only way out of anything here, and it **goes back one
step** where there is one: with the library in front of the map it
closes that, and the app on the next tap; in the course app it leaves
the mark form or an open menu first. The course sheet had a `DONE` of
its own beside its heading until the cross took the job — two ways out
on a 1080 circle is not a convenience, it is a question about which one
you meant. With nothing in front of it, the first tap closes the app,
as it always did.

**The course is no longer one of the map's sheets.** It was reached by
a `COURSE` button on the track rail, which meant that setting a course
first spun up satellite tiles and up to 800 path segments — ten minutes
before a gun, on the busiest the Pi gets — for a sheet that reads none
of it. Marks come from a form with a keypad, or from the club; nothing
in it touches the chart. What reads the course is the dial: `NEXT MARK`,
the leg, the rounding, the finish. So it is its own app now, second on
the dock, right off the radar. The rail is six buttons again and each is
back to 92 px.

The map still draws the course on the chart — numbered circles, the
rounding side lettered, the view fitted to include them — because
`COURSE` is the boat's state and not the sheet's. That was always true;
it is just visible now that the editor has left.
- **the library's hint line**, which had the foot to itself and was
  underneath it. It has moved up, and now says what the two row
  buttons do rather than repeating how to close a sheet.

The chart also ran into the numbers: the clip circle reached y=665 with
the stats row starting at 640. Up and in a little — `MAP_CY 430→404`,
`MAP_R 250→232` — clears both it and the credit line above it.

### The chart is a sideways circle now

A round 456 threw away the widest part of round glass. At the height of
the chart the panel is nearly 800 px across and the map was using 456 of
it, which on a lake — a thing you want more of across than down — is the
wrong 456.

It is an ellipse, 840 by 460, clipped by an `<ellipse>` instead of a
`<circle>`. The tile box stands 4 px proud of the curve so there is
something behind it, exactly as the circle's `MAP_R 232` stood proud of
its `r 228`.

| | circle | oblong (one commit) | ellipse |
|---|---|---|---|
| width | 456 | 776 | **840** (1.84×) |
| height | 456 | 460 | 460 |
| area | 163 300 px² | 356 960 px² | 303 500 px² (1.86×) |
| worst point | — | 94.5% of the radius | 81.6% |

**Why an oval and not the oblong.** On round glass an oval reads as a
viewport cut *into* the panel; a rectangle reads as a rectangle dropped
*on* it. The oval also reaches further sideways for the same clearance,
because its widest point sits on the centre line instead of at a corner —
840 against 776 here, and it could be taken to **972** before the curve
met the rim.

It is not taken there. An oval that nearly touches the glass stops looking
like a viewport and starts looking like a letterbox; the even margin is
the whole of why the shape reads. Renders at 840, 940 and 972 made that
obvious in a way the arithmetic did not, and there is a probe holding the
worst point under 90% of the radius so nobody widens it back on a hunch.

**The edges are chosen, not inherited.** Top and bottom are where the
circle's were, so no water was given up to gain the width: above is the
empty band under the name pill and the race title, and below, y=636 still
clears the stats row that starts around 662 — the chart ran into those
numbers once, as the paragraph above records, and it was not worth doing
twice.

**`MAP_R` became four constants.** `MAP_RX`/`MAP_RY` are the clip;
`MAP_HW`/`MAP_HH` are the tile box 4 px around it. Nothing here is round
any more, so both the off-view test and the tile box have to know which
way they are being asked. `outOfView` tests the *ellipse* rather than its
bounding box — a fix out in a corner of the box is clipped away by the
curve, and a box test would call it visible and never refit — and
`cacheArea` fetches a matching oblong rather than a square, because a
square the width of the view would pull a band above and below that the
chart can never show, which on a dock connection is the difference between
a cache that finishes and one that hits `tileCap`.

**`MAP_FIT` is the one that is deliberately unchanged, at 232.** The ask
was a wider view *at the same zoom*, and those two pull against each
other. A fit measured against the new shape would put a track's widest reach
at 420 px instead of 232 and zoom in on every course — you would
get a bigger track rather than more lake, which is the opposite of the
point. The first attempt at this did exactly that, and the arithmetic
caught it before the screenshot did: the probe for it compares a real
track's fitted scale against `(232*0.90)/r` and would catch anyone later
"tidying" `MAP_FIT` into `MAP_RX`.

The oval's inscribed circle is `min(rx,ry)` = 230, comfortably larger than
the fit's 208.8, so a fitted track can never touch the curve however it is
shaped — there is a probe for that too.

So a course lands at precisely the size it always did, and all of the
extra glass fills with water.

The one gate that had to change is the QR sheet's. It lives inside
`#tmap`, and raising it while Tracks is shut would put it somewhere
nobody can see or tap — and `judgeGesture` hands whichever surface is
showing ownership of every gesture, so a sheet stranded off a closed app
silently ate the dial's. It asks whether the map is up now, rather than
which page is.

## Getting a track onto a phone

The race library is IndexedDB, which is **per origin and per device**. A
phone opening the same page gets its own empty library — none of the
races the kiosk recorded are in it. So exporting on the helm used to
mean a `.gpx` in the Pi's `~/Downloads`, where nothing can reach it.

The track now goes the other way. `⤓` on the track page POSTs the XML to
`netd`, which writes it into `~/avnav/data/user/helm/gpx/` — a folder
**AvNav already serves**, at `/user/helm/gpx/<name>.gpx`. Any device on
the boat WiFi can fetch it; on iOS it lands in Files, and the share sheet
from there reaches SailTies, HealthFit and anything else that eats GPX.

Publishing raises a **QR code** of that URL, because the remaining
problem was never the file — it was getting the phone to the address.
Point the camera at the helm and Safari does the rest.

- `index.json` is rewritten beside the files on every save, so the app
  can list them without a directory listing.
- The library reads that index **from AvNav, not from netd** — netd is
  loopback-only and a phone cannot reach it. Same origin as the app, so
  the same code works in a pocket and at the helm.
- The library shows two sections. *On the boat* rows are plain links: on
  a phone a tap downloads, on the helm a tap raises the QR instead
  (a download there would just land in the Pi's own Downloads).
- With no helper — i.e. on a phone — `⤓` falls back to the old Blob
  download, which is what that device wanted anyway.
- Names are rebuilt from `[A-Za-z0-9._-]` on the way in. A race title is
  typed at the helm and ends up as a path, so no slash survives it.

### Two networks, one code

The Pi usually has two addresses: the hotspot it runs for the boat and
whatever marina network the dongle joined. The code leads with the
**hotspot**, since a phone at the helm is on it — but a phone on the
shore network cannot reach `10.42.0.1` at all, so **tapping the code**
cycles to the other address. Tapping anywhere else puts the sheet away.

### The QR encoder

Written into the file rather than pulled in, because this file has no
dependencies and gets none. Byte mode, error correction **M**, versions
1–10; a URL with a long race name is about 75 bytes, which is version 5.
Past version 10 it returns `null` and the sheet shows the plain URL to
type instead.

Verified by decoding, not by inspection: every version boundary 1–10
plus multibyte UTF-8 round-trips through OpenCV's detector, and the
rendered sheet still decodes shrunk to 190 px, blurred, rotated 45°,
under perspective, and with a specular highlight across one corner.

**`netd`'s POST body cap used to be 4 kB.** Bodies were WiFi passwords
when that number was chosen; a track is a hundred times that, so it
arrived truncated, failed to parse, and reported itself as empty. The
cap now follows `GPX_MAX`.

**A flash in the track page's status line has to hold the slot.**
`paintTrack()` rewrites that text four times a second, so `trkFlash()`
sets a deadline that `paintTrack()` checks rather than just writing into
it.
