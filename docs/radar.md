# Radar

Two rain services, a forecast that is metered, and a wind layer - all inside a fixed memory budget.

[← back to the README](../README.md)

## Radar

A slippy map without Leaflet. Web Mercator is two functions and a tile
layer is `drawImage` at a computed offset, so the library buys nothing
here and costs 144 kB, a CDN dependency and fifteen tile layers of DOM.

### The memory is the design

Kept the obvious way — every frame's tiles decoded and held — fifteen
frames over a 1080 view is ~375 tiles at 256 kB, about **100 MB** of
image memory that never appears in the JS heap and never comes back. So
each frame is composited **once** into a single 512² canvas and its
source tiles are released.

Measured, same machine, closing and reopening:

| | CPU @1x | JS heap | image memory |
|---|---|---|---|
| closed | 1.8% | 1.9 MB | **0** |
| radar open | 4.0% | 2.7 MB | **24.9 MB** |
| closed again | 2.4% | 2.4 MB | **0** |

For comparison, `sail-weather.html` measured **34.8%** at the same
throttle. Most of that difference is not the map — it is a 323-particle
wind field on `requestAnimationFrame`, which the dial's wind bezel
already covers.

512 is not a compromise: RainViewer's free radar is real only through z7
and is upscaled above it, so past z7 the native content across the view
is already fewer than 512 px.

### Frames cover the view, not a pixel count

The frame canvas stands for exactly the view, so the tiles fetched must
cover exactly the view — **the same ground at a lower zoom, not the same
number of pixels**. Covering `FRAME × span` px at the radar's zoom is
twice the ground when span is 2, and the radar then draws at half scale
over a base that is correct: two layers of the same coastline, one of
them wrong. One zoom below the view, capped at the radar's native 7, is
also self-consistent with a 512 canvas over a 1080 one.

Frames are built **one at a time**. Fifteen fired at once is sixty-odd
parallel tile requests over a marina's wifi, and the first frame — the
only one anybody sees immediately — arrives last.

### Giving it back

`close()` aborts the one `AbortController` every fetch shares, clears the
timer, and sets every canvas to `width = height = 0`. That last one is
what actually frees the pixel buffer: dropping the reference only makes
it eligible, and a 1080 canvas is 4.7 MB the collector is in no hurry
about.

### Sources, and the one that needs a key and hides it

| | source | key |
|---|---|---|
| base | Esri World Dark Gray Canvas | none |
| radar | RainViewer, last hour + nowcast | none |
| forecast | Tomorrow.io via the `keel-ics` Worker | `TOMORROW_KEY`, a Worker secret |
| forecast, fallback | Open-Meteo 15-minute precipitation grid | none |
| wind field | Open-Meteo current wind, 6x6 grid | none |

### Two sources, and why both

| | RainViewer | Tomorrow.io |
|---|---|---|
| what it is | a radar **mosaic** — measurement | a **model** field |
| span | past 2 h at 10 min, plus a nowcast | **−7 days to +14 days** |
| key | none | yes, and a quota |
| cost | free, unlimited | free tier is a trickle |

**Could one of them do the job alone?**

Tomorrow.io could: its map tiles cover the last seven days as well as
the next fourteen, so one source could draw the whole timeline in one
palette with no seam at all. What stops it is quota. This app's timeline
is sixteen frames; at the six-tile budget the free tier needs, one view
change would be ~96 tile requests. That is why only three forecast hours
come from it, one tile at a time. On a paid plan, Tomorrow.io alone is
the simpler design and the colour question below disappears.

RainViewer could not: two hours of past is not a forecast. Its nowcast
is also **not always published** — the index read while writing this had
`nowcast: []`, zero frames, so on that afternoon RainViewer offered no
future at all.

So the split is doing real work: measurement where measurement exists,
model where it does not, and free where free will do. The seam between
them is labelled rather than hidden — `· NOWCAST`, `· FORECAST` — because
the two halves are different *kinds* of claim, not just different hours.

### RainViewer ignores its own colour-scheme parameter

Their tile URL is `/{size}/{z}/{x}/{y}/{scheme}/{smooth}_{snow}.png`, and
the scheme segment **does nothing**:

```
/256/7/36/53/0/1_1.png  ─┐
/256/7/36/53/4/1_1.png  ─┼─ byte-identical, 710 bytes
/256/7/36/53/6/1_1.png  ─┘
/256/7/36/53/99/1_1.png ─── different: grayscale
```

Checked on tiles never fetched before, so it is not the CDN. Valid
numbers all return **Universal Blue**; anything unparseable returns
black-and-white. The `2` in this app's URL is decoration — and a typo
there would silently hand back a grayscale radar.

Universal Blue's ramp, from their published dBZ table:

```
 15 dBZ  #88ddee   0.3 mm/h    light
 20      #00a3e0   0.6
 25      #0077aa   1.3
 30      #005588   2.7
 35      #ffee00   5.6         yellow starts here
 40      #ffaa00  11.5
 45      #ff4400  23.7
 50      #c10000  48.6
 55      #ffaaff  99.9         magenta, and you are not sailing
```

### Matching the forecast to it

Neither source will do it. RainViewer's palette cannot be chosen, and
the `keel-ics` Worker builds its upstream URL as

```js
"https://api.tomorrow.io/v4/map/tile/" + z+"/"+x+"/"+y +
  "/precipitationIntensity/" + iso + ".png?apikey=" + env.TOMORROW_KEY
```

— path plus key, dropping whatever query the panel sent, so
Tomorrow.io's own `gradient` parameter never arrives. A gradient was
tried here and **measured inert** against a live tile.

So it is done on the way in, the way `sail-weather.html` in the keel app
already did it: the Worker sends `access-control-allow-origin`, so the
forecast tiles can be loaded `crossOrigin` and **read back and
repainted**. `crossOrigin` is asked for on those tiles *only* — the
basemap and radar are drawn and never read, which is why they have never
needed a CORS handshake, and that is not worth giving up to recolour
layers that already match.

**Hue alone is not enough**, which is where a first attempt went wrong.
Tomorrow.io spends green across a wide range of intensity — pale washed
green, vivid green, dark green — so sorting on hue puts all three in one
band and a whole tile comes out the single sand colour at the bottom of
the ramp. Inside the greens it is saturation and value that carry it:
washed out is lightest, vivid next, dark heavier. Yellow, orange and red
then follow on hue as normal.

| Tomorrow.io | | Universal Blue |
|---|---|---|
| green, washed out | → | sand `#d6c88f` · 12 dBZ |
| green, vivid | → | pale cyan `#88ddee` · 15 |
| green, dark | → | cyan `#00a3e0` · 20 |
| yellow | → | blue `#005588` · 30 |
| orange | → | gold `#ffd200` · 37 |
| red / violet | → | red `#d91b00` · 48 |

The recolour is cached on the image, so a tile is repainted once however
many frames draw it, and a tainted canvas falls back to the original
colours rather than to nothing.

One difference from the keel app worth noting: its top band goes to deep
blue, so the heaviest forecast cell reads as merely wet. Universal
Blue's own scale puts red at the top, and this follows it — on both
halves of the timeline, red now means the same thing.

### What the forecast costs, and what it used to

Tomorrow.io's free plan, from their own support docs:

| limit | value | resets |
|---|---|---|
| daily | 500 requests | 00:00 UTC |
| hourly | **25 requests** | top of each hour |
| per second | 3 | automatic |

And: *"Each API request — whether for weather data or a **visual map
tile** — counts toward your usage."* Every tile is a call. Measured
against a live key, the 429 this app was getting was the **hourly** cap,
not the daily one — it cleared at 03:02 UTC.

One forecast build is three frames at four tiles: **twelve calls**. It
used to happen on app open, on every pan, on every pinch and on every
BOAT tour, which is **two view changes an hour** before 429 for the rest
of it. Two changes fixed that.

**The forecast times are anchored to the top of the clock hour**, not
rounded down to the quarter. That sounds cosmetic and is not: at the
quarter hour the tile URL changed every 15 minutes, and the Worker's
edge TTL was 15 minutes too, so the two windows lined up exactly and no
tile was ever served from cache twice. On the hour, one URL is good for
the whole hour and every device aboard shares it.

**This was the half hour for a day, and it ran the tier dry.** Anchored
to the hour the horizon decays as the hour goes on — at 14:05 the frames
are +55m/+1h55/+2h55, by 14:55 only +5m/+1h05/+2h05 — so a rounded `+3h`
label became `+2h` fourteen minutes in and read as a forecast that had
been cut short. Half-hour slots fixed the label by turning the URL over
twice an hour instead of once. The arithmetic:

| anchor | URL sets/hour | calls/hour | calls/day |
|---|---|---|---|
| quarter hour | 4 | 48 | 1152 |
| **half hour** | 2 | 24 | 576 |
| **hour** | 1 | **12** | **288** |
| the caps | | 25 | 500 |

24 against a cap of 25 leaves room for nothing — one pan past the frame
margin, one app reopen, and the next build is a 429. 576 a day is over
the daily cap on its own. It duly ran out, and a panel with no quota
shows **no forecast at all**, which is a far worse answer than a label
that decays. Back on the hour it is 12 and 288, and the Worker's edge
cache takes about a third off both.

**So the label is a clock time, not an offset.** `01:00` is true for the
whole hour; `+3h` stops being true fourteen minutes in. That is what the
half hour was really buying, and a time buys it for free. It is also
**not printed into the markup** — a number there would render in the
second before the forecast frames exist and then change under you — so
it stays blank until there is a real horizon to name, in a box wide
enough that nothing shifts when it arrives.

**The frames are kept across view changes.** They are only rebuilt when
the slot rolls over or the chart moves off them, which is safe now that
every frame carries the view it was composited for. They are also built
with **one zoom level of margin**: fitted exactly to the canvas, a frame
was uncovered by *any* pan at all — one pixel off and it had to be bought
again. One level out covers four times the area for the same four tiles,
because the composite backs off a zoom too.

What the tests hold to:

| | cost |
|---|---|
| open the app | 12 |
| pan an eighth of the glass | **0** |
| zoom in | **0** |
| a whole BOAT tour | **0** |
| zoom out past the margin | 12 |
| pan right off them | 12 |
| the hour rolls over | 12 |

So ordinary use is **twelve calls an hour against a limit of
twenty-five**, where it used to be twelve per pan — and the edge cache
answers a share of those, so the billed figure is lower again.

A refusal is also remembered for the rest of the hour. Without that, a
panel with no quota left asks again on every single pan — which is how
you stay refused.

### Bought once, and not faster than three a second

Two more things `sail-weather` does that this did not.

**A session cache keyed by URL.** It keeps a `url -> Image` map for the
life of the page, which is why panning back over ground you have already
looked at costs nothing - the frames are re-composited, but not one tile
is bought twice. The helm cached *composited frames* only, so a pan past
the margin re-bought every tile underneath them. `CAST_TILES` is that
map, bounded at 24 - two builds' worth, at 256 KB decoded apiece - with
the least-recently-used going when a 25th arrives, and the whole thing
emptied in `radClose` alongside the canvases. **Successes only**: a
refusal is a 429 window that clears in minutes, and remembering it for
the session would be the one way to make sure it never cleared.

**450 ms between tile loads.** Tomorrow.io allows three requests a second
as well as 25 an hour, and off a warm edge cache twelve tiles come back
fast enough to trip it - a self-inflicted 429 on top of a quota that was
fine. `RAD.TMR_GAP` is a floor on the gap, not a queue; the fetch was
already serial. Only the forecast asks for either: the basemap and the
radar are unmetered and fetched in bulk, and putting them behind a 450 ms
gap would make the map crawl in for no reason.

### One bad tile used to cost the whole futurecast

Three failures compounded, and together they are why the panel could sit
there saying `NO FORECAST` with a perfectly healthy Worker:

**No tile was ever asked for twice.** `radImg` resolved `null` on the
first `onerror` and that was that. Tomorrow.io's 429 window is minutes
wide and a marina's wifi drops a request now and then; either one threw
the futurecast away. Forecast tiles now retry **three times** with a
900 ms/1.8 s backoff (`RAD.TMR_TRIES`). The basemap and radar pass no
`tries` and behave exactly as before — they have dozens of tiles, and a
hole in one of them is a hole in the picture, not a feature that
vanishes.

**One empty frame ended the run and stuck for the hour.** Losing the
`+3h` tile — the one nearest the edge of what Tomorrow.io publishes —
cost the `+1h` and `+2h` frames too, and set `castFail` so nothing was
retried until the hour rolled. Now only the **first** frame coming back
empty stops the run, because a service refusing `+1h` is refusing `+2h`;
a later empty frame is dropped and the ones that arrived stay. An empty
frame is never *appended*: an empty frame on the timeline reads as an
hour of clear sky, which is the one thing it must not look like.

**A refused frame is detected on its first tile.** Six retry ladders
before the panel can say `NO FORECAST` is half a minute of nothing. If
the first tile will not come after its retries, the rest are refused
too, so `opt.bail` stops there — three requests, not eighteen.

### The wind, as air rather than as a number

`sail-weather`'s particle field, ported behind a `WIND` pill. A 6x6 grid
of current wind - 36 coordinates in one keyless Open-Meteo request -
bilinearly interpolated, with particles advected through it leaving
trails that fade. It says at a glance what an arrow and a number cannot:
where the shifts are, where it is dying, which side of the course is
paying. Trail colour is the sailing window's own thresholds, so the
colour of the air means the same thing here as it does in the HUD.

**It is off until you ask for it.** It is the only thing in this app that
runs an animation loop while you are merely looking at the screen, and on
a panel that is on all day that is a choice, not a default. Measured on
this machine, three runs, `Performance.TaskDuration` over 14-second
windows:

| | task | heap |
|---|---|---|
| radar running, wind off | 7.3-8.4% | 2.5 MB |
| radar running, wind **on** | 17.6-18.1% | 2.7 MB |
| wind off again | 8.9% | 2.7 MB |
| app closed | ~4% | 2.2 MB |

**About +10 points of one core, and 0.2 MB.** Under a 6x CPU throttle -
roughly what a Pi feels like against this machine - it is +13 to +15
points on top of 23%, so ~38% of a throttled core. It is affordable, and
it is not free; the toggle is there because on some days it will not be.

Three things make it that cheap rather than three times that:

**The strokes are batched by colour band.** Four `Path2D`s a frame,
stroked once each, instead of 650 `beginPath`/`stroke` pairs. This is the
single biggest saving and it costs nothing in the picture - measured, 250
particles and 648 particles land within 0.3 points of each other, which
says the per-particle work is not what you are paying for.

**The layer is drawn at half linear resolution and stretched by CSS.**
The per-frame fade is a full-canvas composite: 1.2M pixels at 1080,
291k at 540. Trails are soft edged and have nothing there to sharpen.
Density is still counted against the *glass*, not the backing store -
off the half-size canvas the area formula lands on its own floor and the
field comes out a third as dense as sail-weather's.

**30 fps, for the reason the BOAT tour is 30 fps.** Nobody can tell a
trail at 30 from one at 60, and it is half the work.

The particles live in screen space, so a pan, a pinch or a BOAT tour
would drag them across ground they were never over: the loop blanks the
layer while `R.cam` or `R.tour` is set and picks up again when the view
settles. A new view remaps the grid it has and buys another only if the
15% of margin no longer reaches. Turning it off cancels the loop and
wipes the canvas; closing the app zeroes it and drops the particle array
with everything else.

### A model, when the measurement is refused

Tomorrow.io's free tier is a trickle and it does run out. The panel used
to answer that with `NO FORECAST` and a blank hour. It answers with a
**model** now - the same fallback `sail-weather` makes.

Open-Meteo's 15-minute precipitation grid needs no key, sends CORS
headers and has limits a boat cannot reach. An 8x8 grid over the frame's
ground is **64 coordinates in one request**, smoothed up into the same
512 frame canvas the tiles composite into, so playback, the scrub, the
tour and `radCovers` cannot tell the two apart.

It is a **model, not a measurement**, and the panel says so rather than
passing one off as the other:

```
              11:00 PM . FORECAST
          MODEL FORECAST - NO TOMORROW.IO
```

Eight cells across the glass is a smear however it is coloured, so the
ramp is the same one the radar and the recoloured tiles use - mm/h onto
the ramp's own dBZ stops through Marshall-Palmer, `R = (Z/200)^0.625`,
which puts 12 dBZ at 0.20 mm/h, 20 at 0.65, 30 at 2.7 and 48 at 37 - but
at **thinner alphas**. At the tiles' opacity a coarse field paints the
chart out completely, which is a model claiming the solidity of a
measurement. Under it the coastline stays readable.

`mk` is null on these frames, because there is no per-frame URL to
rebuild from. The BOAT tour already skips frames without one: it leaves
them composited rather than dropping them, and the next settled view
rebuilds them through `radCovers` like everything else.

### Two services, two failures

`radBuildCast()` used to be the last line of `radBuildFrames()`, so
**every early return skipped it**: a dead RainViewer index, or an index
with nothing published, took Tomorrow.io down with it. They are
different products from different companies on different hosts, and a
boat that has lost one has usually not lost the other. The forecast is
now built on those paths too — you get the futurecast on an empty
timeline, with `NO RADAR` still on the glass saying which half is
missing.

### The futurecast

Three frames at +1h, +2h and +3h from the top of the clock hour,
appended after the radar so the timeline runs past → nowcast → forecast
in one pass. Tomorrow.io publishes on the quarter hour, and the hour is
one; asking for 14:07 returns nothing at all.

The key never reaches the panel. It lives as a secret in the Worker,
which proxies `/tile/{z}/{x}/{y}/{iso}.png` and caches every tile at the
Cloudflare edge — so the free tier is shared across every device instead
of burned per browser:

```bash
cd ics-worker && npx wrangler secret put TOMORROW_KEY && npx wrangler deploy
```

**The edge TTL is 65 minutes**, set in `keel-app`'s `ics-worker/worker.js`
as `Cache-Control: public, max-age=900, s-maxage=3900`. `s-maxage` is
what the edge reads; `max-age` stays at 900 so a browser left on the page
still comes back for a fresher tile.

Sixty-five and not sixty, because every absolute forecast time is asked
for three times an hour apart — the tile for 17:00 by the 14:00 slot, the
15:00 slot and the 16:00 slot — and at exactly 3600 the entry expires as
the next build starts, which is a coin flip. The five minutes of slack
makes the hit deterministic and takes 24 calls an hour down to 16. 7800
would catch the two-hour reuse too and land at 8, but it would serve the
`+1h` frame from a model run two hours old, and the near hour is the one
you are dodging squalls with.

At the old 900 nothing was ever reused — not even between two devices
looking at the same 30-minute slot, since the TTL was half the slot.

To check it after a deploy, ask for a tile twice and read the `age`
header: the Cache API sets it, and `cf-cache-status` does **not** report
this — that header describes the CDN cache in front of a Worker, and a
Worker doing its own `caches.default` lookups reads `DYNAMIC` either way.
An `age` above 900 is the proof that `s-maxage` is being honoured rather
than `max-age`.

```powershell
$T = (Get-Date).ToUniversalTime().AddHours(2).ToString("yyyy-MM-ddTHH:00:00Z")
curl.exe -sI "https://keel-ics.keel-app.workers.dev/tile/7/36/48/$T.png" |
  Select-String 'cache-control|^age:'
```

That trickle of quota is why these frames are fetched **one tile at a
time**, and at a zoom backed off until the view fits in **six tiles**.
A normal tile layer bursts dozens of requests and spends the day's quota
on a single look.

**An empty forecast frame must not read as clear sky.** A quota refusal
and a fine afternoon draw identically — nothing — so each frame reports
how many tiles actually arrived, and a frame that got none is discarded
rather than shown. The run stops at the first refusal too: if the quota
is gone for +1h it is gone for +2h, and three empty frames in the loop
would read as three hours of clear weather. The HUD says
`NO FORECAST — quota or upstream` instead.

The timeline marks where **now** is, so past and forecast are told apart
at a glance rather than by reading the clock, and the label distinguishes
all three: `10:15 PM`, `· NOWCAST`, `· FORECAST`.

### The toolbar

Built in the keel app's idiom: a transport row — play, the two ends of
the timeline named, the track between them — and under it a row of pills
for the layers. Both rows share one scrim, so the map cannot show
through the gap between them.

Both scrims are as short as their contents allow — the HUD is 67px and
the toolbar 130px. On a round panel every row of padding is chart you
cannot see, and the chart is the point. The one thing that did **not**
shrink is the 52px scrub band: it is the tallest thing in the transport
row now, and everything else trimmed around it.

```
[▶]  −2h  ━━━━━━━━━━┃━━●━━━━  1:00 AM
[ RAIN ] [ WIND ]           [ BOAT ]
```

The track carries the shape of the timeline in its own colour: grey
behind, accent at the present, amber out into the forecast — which third
you are in reads before the clock does. 70% is where the present falls
with twelve past frames, the nowcast and three cast hours; `#rad-now`
marks it exactly rather than by the gradient's guess.

There was a third pill, `SEA`, over an OpenSeaMap seamark layer. It is
gone: those tiles come back as 334-byte **fully transparent** PNGs at
every zoom the radar can reach — the seamark icons only start rendering
around z12 and `MAX_Z` is 11 — so the pill toggled a second round of
tile fetches per view that painted nothing at all. Verified by decoding
the tiles at z8, z10 and z11 over Confluence's home water: zero of 65536
pixels inked in each.

The base still carries its **own** generation counter (`bgen`) alongside
`gen`, for the pan that starts a second base build while the first is
still awaiting tiles. Bumping `gen` would throw away fifteen composited
frames that have not changed at all.

`RAIN` is drawn on top, so turning it off is one repaint and turning it
back on is instant: the frames stay in memory, which is the whole point
of keeping them there. The clock says `RAIN OFF` rather than going
blank — an empty map and a stopped layer look identical otherwise.

### BOAT flies there

BOAT used to be a jump cut: the view was somewhere else and then it was
over the boat, and nothing about the picture told you which way it had
moved or how far. It flies now — down onto the boat, a beat while the
close tiles land, then back out to a height you can read weather at.

```
z8 ──► z10 ──► z11         hold        z11 ──► z9
  2.4 s    2.4 s           2.0 s       2.8 s        ≈ 9.6 s in all
```

Slow on purpose: it is a tour, not a jump, and the point is to have
time to read what is under you on the way past.

Each leg glides **one transform** over what is already composited while
the destination's tiles load into a canvas of their own. At the end of
a leg the two agree — same ground, same screen scale — so swapping the
sharp one in and dropping the transform is invisible. A leg therefore
costs **one base build**, not one per animation frame: the whole tour
measured 85 tile requests, where re-tiling per frame would be thousands.

**Which base a leg flies over depends on which way it is going**, and
that is the trick worth keeping:

| | base composited | why |
|---|---|---|
| in | the one you already have, blown up | scaling up never uncovers an edge |
| out | the **wide** one, blown up and shrinking into place | shrinking the close base leaves the map as a postage stamp in an empty screen — the ground around it was never composited |

The first version did the obvious thing in both directions and the
pull-out was a picture floating in void. `radPaint` now also fills with
the map's own `--bg` under any transform, so a scale below 1 uncovers
map-coloured ground rather than the black behind the page.

The dive is capped at **two zoom levels a leg**. One leg from 8 to 11 is
an eightfold blow-up of the tiles you started with, and for half a
second that is all anybody can see; at fourfold it reads as a dive
rather than a smear, and the extra base build is thirty-odd tiles the
browser has mostly cached.

### The radar stays on the glass

A frame is 512 px standing for **the ground its own view covered** — not
for whatever the canvas covers now. Every frame carries that view, so
`radPaint` places it rather than assuming it fills the canvas:

```js
const kk=Math.pow(2, R.view.z-fv.z);
const dx=(wx(fv.lon,fv.z)-W/2)*kk - cv.x + W/2;
g.drawImage(fc, 0,0,fc.width,fc.height, dx,dy, W*kk, H*kk);
```

When the two views agree this is the identity it always was. When they
do not — mid-tour, mid-drag — the weather is still in the right place
instead of being thrown away. Dragging the chart no longer blanks the
radar either; it slides under your finger with the base.

The tour then re-composites the timeline **once**, aimed at where it
will land, and every frame that arrives replaces its own index while the
one it replaces keeps drawing. There is no moment with no radar.

Once, not once per waypoint, because the extra builds bought nothing.
RainViewer's free radar is real only to **z7**: a frame built for a z9
view and a frame built for a z11 view fetch the same z7 tiles, and on
the glass at z11 both work out at a sixteenfold upscale of the same
pixels. Re-compositing at every waypoint cost three times the work for
an identical picture — 46% CPU across the tour against 20%.

That also means `gen` must **not** move at a waypoint. `radBuildFrame`
reads it when it starts and `radImg` nulls any tile that lands after it
changed, so a bump mid-flight hands back empty frames. The tour bumps it
once, at the start; the base builds are guarded by `bgen` and the tour
token instead.

A second press of BOAT, or a hand anywhere on the chart, ends the tour
at the waypoint it was flying to. It does not fight you.

**What it costs.** Idle over the chart is unchanged. The tour measured
**15.8%** CPU averaged across a 13 s window containing it, back to 3.6%
the moment it lands — less than the old three-second version cost, while
being nearly three times as long and drawing the radar the whole way.

Two things got it there. The single re-composite above, and a **30 fps
cap** on the animation: a tick is a full-canvas fill, a 1080 base blit
and a scaled radar blit, which at 60 is the most expensive thing the
panel ever does. On a slow ease over two and a half seconds nobody can
tell which they are watching, and the last frame of a leg always draws
whatever the clock says — it is the one the swap has to line up with.
The cross-fade between frames is also off while the camera moves: two
scaled blits a tick instead of one, for a 200 ms dissolve nobody has
ever seen through a dive.

Memory is one extra 1080² canvas, 4.7 MB, for the length of a leg,
zeroed on every path out including the app closing mid-flight.

The clock does not blank while a tour is in the air. The frames really
are gone, but three seconds of `—` every time you press BOAT reads as a
fault, so the note line says `OVER THE BOAT` instead and the clock is
left alone.

### Tap the clock

The HUD is a handle. Tapping it drops the rest of it down: the tide
table for the nearest gauge, and the hours it is actually worth going
out in.

```
            11:43 PM · FORECAST
          Esri · RainViewer · Tomorrow.io
                      ⌄
  TIDE            PACKWOOD PLACE, MOSQUITO LAGOON · 54 KM
  HIGH  12:38 AM                              2.7 ft
  LOW   07:05 AM                              0.3 ft
  HIGH  12:53 PM                              2.3 ft
  LOW   07:08 PM                              0.1 ft

  SAILING WINDOW
  05:00 PM – 09:00 PM
  SW 6–7 kt · gusts 11
  ▁▁▁▁▂▂▂▃▃▃▃▂▂▁▁  ← a bar an hour, the window behind them
  SUN 11:02 AM – 11:54 PM
```

**Nothing is fetched until that first tap.** Somebody who only ever
wants the radar pays exactly what they paid before — measured against
the previous commit on the same machine, 9.5% CPU open before and 9.2%
after. Both answers are then held outside `R`, which dies with the app,
so closing and reopening the map does not re-download a tide table.

The row *before* now stays on the list, dimmed. Whether the water is
going out or coming in is the thing you actually want, and two future
highs cannot tell you that.

**Today beats longer.** The window is the longest unbroken run of hours
that are daylight, 6–20 kt and gusting under 28 — but the horizon is 24
hours, so from mid-afternoon on it always contains the whole of
tomorrow's daylight, and the longest run in it is tomorrow's every time.
Picked purely by length, the line read `12:00 PM – 08:00 PM` at five in
the afternoon, with nothing to say those were tomorrow's hours. You are
standing on the boat: three good hours left this afternoon is the answer
you want, not eight better ones you cannot use yet. `sailBest` now takes
the longest run that *starts today*, and falls through to tomorrow only
when today has nothing left — which is what `sailWhy`'s
`NO DAYLIGHT LEFT TODAY` always implied the feature was about.

When it does fall through, it says so, small and dim ahead of the times:

```
  SAILING WINDOW
  TOMORROW 07:12 AM – 07:53 PM
```

No tag at all on today's window, which is the common case and should
carry no furniture.

### Two megabytes of tide stations, read as they arrive

NOAA publishes 3499 tide-prediction stations and **no way to ask which
is nearest** — `mdapi` ignores `lat`/`lon`/`radius` and hands back the
entire list, two megabytes of pretty-printed JSON. `JSON.parse` on that
peaks at many times the wire size, on a Pi with a gigabyte, while a map
is open.

So the body is read as it arrives and only the winner is kept:

```js
const rd=res.body.getReader(), dec=new TextDecoder();
let tail='', best=null;
for(;;){
  const {done,value}=await rd.read();
  const buf=tail+(done?dec.decode():dec.decode(value,{stream:true}));
  while((m=RX.exec(buf))){ …keep the nearest… }
  tail=buf.slice(end);
  if(tail.length>8192) tail=tail.slice(-8192);
  if(done) break;
}
```

`id`, `name`, `lat` and `lng` are consecutive in every record, so one
regex takes them; the tail is what a record straddling two chunks needs,
and it is **capped** because a format change must not quietly turn this
into a two-megabyte string. Peak memory is one chunk. The answer goes to
`localStorage` keyed to a quarter-degree cell — about 28 km — so the
download happens once per venue and not once per GPS twitch. Measured
against the real list: 0.2 s, right answer.

**Past 60 km the nearest gauge is telling you about somebody else's
water.** An inland lake gets told `NEAREST GAUGE 140 KM AWAY` instead of
being handed a tide, and no prediction call is made at all.

Times go over the wire as **GMT**, not the station's local time.
`lst_ldt` comes back as `"2026-08-27 03:05"` with no zone on it, and
`Date` reads that as the *browser's* local time — right only while the
boat and the gauge share an offset, and silently an hour out when they
do not.

### The sailing window

Wind comes from **Open-Meteo**: no key, and it sends CORS headers, which
is the whole reason it is here rather than another Tomorrow.io route —
the panel asks it directly and the Worker stays a tile proxy.

An hour counts if it is between sunrise and sunset **and** inside the
band: `MIN 6` to `MAX 20` knots, with a separate `GUST 28` ceiling.
The gust is the number that actually ends an afternoon — the hourly
average can look perfectly reasonable straight through one — so it is
its own limit and its own mark on the chart, a cap above each bar.

The run reported is the **longest** one in the next 24 h, not the first:
a fine two hours at dawn is not the answer when the afternoon has five.
Its end is the end of its last *hour*, capped at sunset, because the
20:00 hour of a day that ends at 20:14 is not sailing until 21:00.

When there is no window the panel says **why** — `TOO LIGHT — UNDER 6 KT
ALL DAY`, `TOO MUCH — BLOWING THROUGH`, `NO DAYLIGHT LEFT TODAY` — which
is more use than an empty range.

`sunTimes` works off the *instant*, so asking it at breakfast and again
at dusk gives sunsets half a minute apart, which showed up as a window
ending one minute before the sunset printed under it. Every question
about a day is now anchored to that day's local noon and the three
readings agree.

The strip's scale **follows the data**, floored at `MIN + 8`. A
six-knot afternoon drawn against a fixed 34 kt is four rows of stubs
that say nothing; against its own maximum it says "light, and steady".
The floor stops the flattery — a drifter cannot be stretched to look
like a breeze — and the two dashed guides are the band itself, so a
bar's height means the same thing at either end of the scale.

### There are no zoom buttons

On a touch panel the glass **is** the zoom control. Two fingers pinch;
the row those two buttons used to occupy is worth more as the transport.

The preview is a continuous scale — one `setTransform` on what is
already composited, tracking the fingers exactly. Rebuilding tiles per
`pointermove` would be dozens of fetches for a gesture that has not
finished saying what it wants.

On release the nearest **integer** zoom wins, and the ground under the
midpoint of the two fingers has to end up back under the midpoint of the
two fingers — a pinch that walks the chart away from the thing you
pinched is the one thing everybody notices. That is what `unwx`/`unwy`,
the inverse of the Mercator projection, are for:

```js
const k=Math.pow(2, zn-z), ox=q.cx-W/2, oy=q.cy-H/2;
const gx=(wx(lon,z)+ox)*k-ox, gy=(wy(lat,z)+oy)*k-oy;
lon=unwx(gx,zn); lat=unwy(gy,zn);
```

`MIN_Z`/`MAX_Z` used to be enforced by the buttons. The preview scale is
now clamped to `2^(MIN_Z−z) … 2^(MAX_Z−z)`, so the picture stops where
the tiles do instead of committing to a zoom that has none.

A second finger turns a pan into a zoom, and a `lock` flag keeps the
finger still down when the pinch ends from starting a fresh pan from
wherever it happens to be — which reads as a jump.

### Play, pause, scrub

It plays on its own; the button at the head of the row holds it. The
glyph is the **action, not the state** — a triangle means "this will
play" — the same rule the music page's transport follows, and for the
same reason: a button that shows what it will do needs no legend.

Paused, the timer keeps running and returns immediately. No advance, no
paint, no compositing. That is what makes resuming instant, and it is
three lines of nothing every 80 ms.

Touching the timeline scrubs to that frame **and pauses**, because a
timeline that keeps running under your thumb fights you. The track is
8px because that is what reads; the band around it is **52px** because
that is what a thumb needs, and the play button is outside that band so
pressing it does not also scrub. Changing the view resumes playing —
that is a new look, not a held frame.

### Everything is checked against the circle, not the viewport

The credit line sat along the foot and was **outside the glass**: a 274px
line at y=1070 has its corners 547px from the centre and the panel stops
at 540. It looked deliberate in the screenshot and was simply clipped.
It lives in the HUD now, inside by construction. The test asserts all
four corners of every control are within 540px of the centre. The
toolbar is 660px wide with its foot at y=950, which puts its lowest
corners 526px out — inside, but that is the sort of margin a single
extra pill would spend without anyone noticing.

**Not Carto**, which `sail-weather.html` uses. `basemaps.cartocdn.com`
now returns a tile with **API KEY REQUIRED** stamped across the middle of
it, on every subdomain — and it looks exactly like a working dark
basemap until you read the words. Esri's canvas service is unkeyed and
asks only for the credit line at the foot of the app.

Esri puts **y before x** in its tile path. Tokens are replaced by name,
so the order in the template is the order on the wire.

Tiles are drawn and never read back, so the canvas may taint and no CORS
handshake is needed — one whole class of failure removed.

No network is `NO RADAR — no internet` on the glass, not a thrown
exception.
