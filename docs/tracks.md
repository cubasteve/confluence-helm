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

Two things that came with the page becoming an app, both of them the
same mistake — furniture that belonged to a page still standing where
the app's own chrome now goes:

- **the map's lock button**, which sat at the foot of the glass exactly
  where `CLOSE` does now. A page you could be locked on needed it; an
  app does not.
- **the library's hint line**, which had the foot to itself and was
  underneath `CLOSE`. It has moved up, and now says what the two row
  buttons do rather than repeating how to close a sheet.

The chart also ran into the numbers: the clip circle reached y=665 with
the stats row starting at 640. Up and in a little — `MAP_CY 430→404`,
`MAP_R 250→232` — clears both it and the credit line above it.

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
