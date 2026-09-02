# The display

The three pages, the gestures that move between them, and everything that changes how the glass looks.

[← back to the README](../README.md)

## The sensor row

Four glyphs - GPS, depth, wind, heading - green when that source is
feeding, dim when it is not. They live at the top of the **control
panel** rather than on the dial: the face's foot was the one place the
lock and the page dots both needed, and "is anything actually feeding
me" is a question you ask when you are already in the settings.

Their liveness is evaluated in DATA rather than DRAW. Left where it was,
inside the dial's draw gate, the glyphs would freeze whenever the control
panel was open - which is now the only time you can see them.

## Pages

> **This section described three pages and now there are two.** The track
> map became an app in the dock; the code is the record — `PAGE_MIN=1`,
> `PAGE_MAX=2`, and `#dots` holds two marks. The reasoning below still
> stands for the two that remain, and for why a page is not an app: a
> page is always loaded and always costing something, which is exactly
> why the map stopped being one. The original text is kept as written.

Two places rather than two overlays: the dial and the music panel sit
side by side, and swiping left or right moves along the row. Two dots at
the foot of the screen say where you are. The dial is the one you come
back to.

```
        DIAL   <->   music
       * .            . *
```

The control panel is still an overlay, pulled up from the bottom over
whatever page you are on - and now reachable from any of them, the way
control centre is on a phone. It is a layer over a place, not a place.
While it is up it owns the gestures: left and right do nothing until you
swipe it away.

### How many fingers

Two answers, because the two gestures are not the same risk.

| Gesture | Fingers |
|---|---|
| Page left/right between the two dials | **three** |
| Control panel down / up | **one** |
| App dock up / down | **one** |
| Dismiss a launched app, the library, the QR sheet | **one** |
| Taps, holds, every button on every page | one, as always |

**Paging takes the whole hand.** Changing which instrument you are
looking at mid-race because a wave put a wrist on the glass is the
failure worth designing against, and one finger is what rain, spray and
a sleeve produce.

**Everything else takes one.** Raising and dismissing the drawers, a
launched app, the race library, the QR sheet: all visibly reversible, so
a stray touch costs a second rather than your instruments. A tap
anywhere off the dock also closes it.

The drawers were **two fingers** for a while, on the theory that a wave
or a sleeve could raise them by accident. Sailed with, it was wrong. The
drawers are what you reach for most, usually with one hand already busy,
and making the commonest gesture on the panel the fiddliest is a worse
trade than the occasional stray open — which is one swipe to undo. The
knob survives the retreat: `CFG.drawerFingers` is 1, and setting it to 2
puts both drawers back to needing two, in both directions.

`FINGERS` clamps `CFG.swipeFingers` — the **paging** count — and
`DRAWERS` clamps `CFG.drawerFingers` the same way, both against what the
touchscreen can actually report, so a panel that tracks fewer touches
has paging rather than none. It also means the control panel can never
become unreachable if the drawers are ever set back to two — which
matters, because that is where the setting that would fix it lives. A
mouse reports zero touch points, so a desktop browser and the windowed
copy fall back to one finger for everything.

Both are source constants, not panel controls — there is no tile for
them, and the clamp means no setting could rescue a one-point panel
anyway. Change them in `CFG` and deploy.

The overlay branches in `judgeGesture()` deliberately use the
finger-count-free `swipeL`/`swipeR` rather than `left`/`right`: an
overlay that took three fingers to close while one opened the panel
would be the odd one out. The drawer branches ask for `DRAWERS`
explicitly, through `drawUp`/`drawDown`, so that a drawer's dismissal
always costs exactly what raising it did — at 1 that is the same as
plain `up`/`down`, which is what ships.

A gesture is every finger down between the first touch and the last
lift, and the direction is the average of their travel: one finger that
slips while the other two hold still is not a swipe, and averaging says
so.

### Stacking

Written down in the CSS rather than left to DOM order, because it bit
once already:

```
1 pages   2 dots   20 control panel   30 screensaver
55 alerts   70 lock   80 hold ring   90 veil   99 fps readout
```

`#qr-sheet` is the exception: `z-index:10` **within the track page**, so
it covers the race library — its sibling, which has no level of its own —
without leaving the page it belongs to.

The veil is the brightness control on a panel with no backlight to
drive, so it sits above everything and dims the lot. It was on `auto`
until the pages and the panel were given levels, at which point it ended
up underneath both and the slider silently stopped doing anything.

`#panel` sits *before* the music and track pages in the document, so with
everything on `auto` those pages painted over it: the control panel
opened behind whichever page you were on - invisible, and holding the
gestures hostage. That could not happen while the panel was reachable
only from the dial. Making it reachable everywhere is what exposed it.

Nothing new is resident. All three layers were always in the DOM, parked
off-screen with a transform; only the transform is now computed from one
index rather than toggled by a class. Layer promotion stays scoped to the
gesture, so the compositor holds no more than it did.

The dots replaced the SWIPE LEFT/RIGHT/DOWN TO CLOSE captions. Those
existed because nothing indicated the relationship between the views; the
dots make it structural, so there is nothing left to spell out.

Two things to know if you touch this:

- `.open` on `#tmap` and `#music` is now **derived state**, kept in step
  with the index by `layoutPages()`. Everything that already asked
  whether the map or the music panel was showing keeps working; do not
  set it by hand.
- `dialVisible()` is now a question about place - `PAGE_I===1` - not
  about what is covering the dial. During a page change the dial can be
  both on screen and moving, which is the expensive combination, so the
  render freeze over `SLIDE_MS` matters more than it used to.

```
phone / laptop  ->  edit  ->  git push
                                 |
Pi (every 5 min):  git pull  ->  deploy.sh  ->  kiosk restarts
```

`autopull.sh` runs from `~/.config/autostart/` and does that loop. It only
acts when the commit actually changed, so an unchanged poll costs nothing
and the display is never restarted for no reason.

It pulls `--ff-only` deliberately: if the Pi's copy has diverged it stops
and logs rather than inventing a merge commit on a machine nobody is
watching. Being offline is treated as normal, not an error — that is the
usual state out on the water.

The kiosk restart works by killing Chromium and letting `start-kiosk.sh`'s
existing restart loop bring it back, which needs no window-manager tooling.
It matches the kiosk instance only, so a desktop-shortcut window is left
alone.

To deploy without the display restarting under you:

```bash
AUTOPULL_RELOAD=0 bash ~/helm/autopull.sh
```

Manual equivalent, any time:

```bash
cd ~/helm && git pull && bash deploy.sh
```

### Which version am I looking at

`deploy.sh` stamps the served copy with the commit it published, and the
panel prints it at the very bottom of the control panel, under the
shallow-alarm section:

```
87b205f
```

A `+` means the repo had uncommitted changes when it was deployed. The
literal `__BUILD__` means the page came from `~/helm` over `file://` and
was never deployed at all.

This exists because the copies drift, and for a long time nothing said so.
Three of them can disagree at once: the repo, the served copy, and
whatever a running Chromium still has in memory. The specific trap is a
`git pull` run by hand - it moves the repo without deploying, and
`autopull` used to compare only commits, so from then on every poll saw
`before == after` and never noticed that what AvNav was serving was a
different vintage. It now asks `deploy.sh --check` each cycle and
republishes on drift, whatever the commits say.

Each Chromium launch also gets a fresh `?v=` - the kiosk loop and the
windowed one the helper starts. Without it Chromium paints the copy it
already has, so a restart shows the old panel for a moment before the
network catches up. The query string does not change the origin, so chart
tiles and the track library in browser storage survive it.

## Golden hour

The icon is a half sun on the horizon with its light on the water — half
a disc rather than a whole one, because a sun *on* the horizon is the
subject and a full circle would read as "weather". Five alternatives
were drawn and rejected, three of them for the reason that keeps coming
up at this stroke weight: shapes that crowd, fuse. An arc with the sun
as a dot on it came out a snail; stacked reflection lines came out a
hamburger; longer rays came out a crown.

Where the sun is in the day, drawn rather than listed. The curve is
today's altitude from midnight to midnight, the disc is now, and the
whole glass is washed in the colour the sky is at that altitude — so the
thing you opened it to check is answered before you read a word of it.
Under it: what is happening, what is next and how long, and the four
times a sailor asks for.

**The palette is keyed on altitude, not on the clock.** That is the only
way it is right in December as well as June, and right at 60° north as
well as 28. Stops are the light a sailor names — night, the three
twilights, the horizon, golden, day — and everything between is
interpolated.

### One altitude became six

`sunTimes` had always answered for exactly one: **-0.833°**, the
horizon, which is sunrise and sunset. Golden hour and the three
twilights are the *same calculation* asked for a different altitude, and
an arc of the day also wants where the sun is right now — so the orbit
came out into a core the three of them share rather than a second copy
of maths that is hard to check by eye.

`sunTimes` keeps its exact old answer, and that is asserted rather than
assumed: the test runs the pre-refactor implementation beside the new
one across six latitudes from Orlando to Svalbard, every seventh day of
a year, and requires **0 ms** of difference — including agreeing on the
35 sampled days where the sun never reaches the altitude at all, which
is not a hypothetical once you sail far enough north.

One honest limit it also pins down: the event solver and the altitude
formula are two different approximations of the same orbit and do not
share every simplification, so the altitude at the moment `sunset` says
is about **-1.0°** rather than exactly -0.833. A fifth of a degree near
the horizon is about forty-five seconds. The test asserts that bound
rather than pretending they agree.

### The bug worth remembering

A leftover gradient from an earlier draft mixed a colour out of `sky.b`,
which is an `rgb()` string the moment the altitude falls *between* two
stops — so it parsed as `NaN` and `addColorStop` threw. It therefore
threw **only at the interpolated altitudes**: at noon and at midnight,
where the altitude clamps to a palette stop and the colour is still hex,
everything worked. Which is to say it was broken at golden hour and blue
hour, and nowhere else — the two states the app exists for.

Rendering it at four moments of one day is what found it, and the suite
now walks every altitude from -40 to +60 through both the palette and a
full repaint.

### What it costs

4.4 MB of canvas while open, nothing when shut — `width = height = 0` on
close, and the ticker cleared. CPU is **1.5% open against 2.4% at rest**,
lower than the dial it replaces for the same reason Tracks is: with an
app up the dial stops drawing. The curve is redrawn once a minute; only
the countdown ticks every second, and that is four lines of text.

## A panel and a dock

Swipe **down** for the control panel, **up** for the app dock. Opposite
edges, opposite gestures, each going back the way it came — the panel
used to come up from the bottom, which is where the drawer lives now, and
two surfaces sharing an edge and an animation would have been two things
that felt like one.

An **app is not a page**. A page is always loaded and always costing
something; an app exists between the tap that launches it and the tap
that closes it, and then it is torn down. Each entry in `APPS` carries
its own `open(host)` and `close()`, because only the app knows what it
allocated.

The two are not the same shape, and should not be. The panel takes the
whole glass because it is somewhere you go. The dock is a **dock**: one
row tall, and the dial keeps drawing behind it, because reaching for an
app should not feel like leaving the page.

660 wide with its foot at y=954 puts its lowest corners 529 out — the
same geometry the radar toolbar sits on, and the same 11px of margin
inside the 540 the glass stops at. The row is held to 600 rather than
the dock's full inner width, so its ends cannot reach the rim when a
second app arrives.

### The dead band at the foot of the dial

A swipe up could not *start* at the bottom of the glass, which is
exactly where a thumb reaches to pull the dock. The dial's lock sits at
`translate(540 950)` and `holdBind` used to `stopPropagation()` its
pointerdown — so `#stage` never saw the touch, no gesture was ever
created, and y≈940–990 was dead. Measured: a 220px flick up opened the
dock from every height **except** 950 and 980.

Swallowing was the wrong tool. The touch is **claimed** instead, and the
claim is marked as one that gives way:

```js
if(G.releaseOnDrag && Math.hypot(q.x-q.x0, q.y-q.y0) > 24){
  G.claimed = false; G.releaseOnDrag = false; holdCancel();
}
```

A finger that stays put still holds, and still owns the gesture, so a
hold on the lock cannot also fire the dial's hold-to-reset. A finger
that travels releases the claim and cancels the hold, and the swipe is
judged normally. Opt-in via `releaseOnDrag`, because the claims that are
*not* holds — the radar scrub, the volume ring — drag on purpose and
must keep theirs.

`pointerup` no longer stops propagation either, and never needed to:
`endGesture` listens on window in the **capture** phase, which runs
before any of it.

### Swiping off the bezel

A swipe that begins at the **rim** is not the same gesture as one that
begins in the middle, and asking the same of it is why it never felt
like you could start on the bezel. The thumb is already at the edge of
the glass when it lands, so there is less panel to travel over; it
arrives rolling in off the bezel, so it arrives diagonally; and it is a
deliberate reach rather than a flick, so it is slower.

Outside 78% of the radius, all three get their own allowance:

| | middle | rim |
|---|---|---|
| travel | 70px | **40px** |
| time | 700ms | **900ms** |
| off-axis | must dominate | may lean 25% |

40 is still well clear of the 24px that separates a tap from a drag, so
a touch at the rim does not become a swipe by accident — measured, a
30px movement out there is still a tap, and a 50px one in the middle is
still not a swipe. The dial does not become twitchy to pay for the rim.

Rim or middle is decided from the **average** start point, the same way
the travel is averaged, so a second finger along for the ride does not
move the gesture out of the rim's allowance. Tested both ways, off the
bezel with no `pointerdown` at all (below): one thumb and two fingers
each raise the dock from y=1074.

### touch-action does not inherit

This is the one that actually killed edge swipes on the hardware, and no
headless test could ever have caught it: synthetic `PointerEvent`s never
go near the browser's touch pipeline.

`html, body { touch-action: none }` was set, and it changed **nothing**
for anything inside the stage — the property is not inherited, so every
tick, dial and button computed to `auto`. On a real touchscreen `auto`
hands Chromium the right to decide a touch is a pan of its own and fire
`pointercancel` part way through, which is a swipe that dies silently.
The browser is keenest to claim exactly at the edges.

```css
#stage, #stage * { touch-action: none }
```

The radar canvas and the scrub band already carried their own copy of
this, for exactly that reason. The dial never got one — and the bottom
centre, the major tick you reach for to pull the dock, is where it
showed. Nothing inside the stage scrolls or pinches, so nothing is given
up. What is asserted in the test is the computed property itself, since
the failure it prevents cannot be reproduced.

### A finger that arrives already moving

Coming in over the **bezel**, the contact begins off the glass. The
digitizer first sees it mid-motion, and the `pointerdown` that should
start the gesture is swallowed by the controller's edge rejection — or
never fires at all, because there was nothing to press down on. The page
is given moves and nothing else, and a tracker keyed on `pointerdown`
never learns the finger exists.

So the first **move** seeds the gesture:

```js
if(!q && e.buttons) q = gAdd(e);
```

`buttons`, because a mouse merely hovering across the panel must not
open anything; for touch it is set for as long as there is contact.

That cuts both ways, though. If a gesture can begin without a
`pointerdown`, a contact can also end without a `pointerup` — the rim
does exactly that, the finger simply stops being reported — and
`G.live` would never come back to zero, leaving every later gesture dead
with no way out but a power cycle. That failure has bitten this file
before. So every gesture is now born in one place, `gStart()`, which
discards a wreck older than `GESTURE_MAX` rather than joining it.

Time, not live count: `gClaim` makes a `G` with no fingers in it and the
pointerdown adds one a moment later, so a live-count test would throw
the claim away in between.

The listeners also moved from `#stage` to **window**. `#stage` is
`border-radius:50%`, and a rounded box does not hit-test outside its own
shape — so a touch that landed on the rim, or on the digitizer's report
of it a pixel or two proud of the glass, missed the element entirely and
never became a gesture at all. Window catches everything, and still runs
after the target's own listeners, which is what `gClaim` depends on.

### The dismiss swipe is local

The dock covers a strip at the foot and leaves the dial in plain sight,
so a flick anywhere on that dial should not dismiss a thing sitting
somewhere else. A downward swipe closes it only if it **started** within
`DOCK_REACH` (110px) of the card — measured from where the fingers went
down, averaged the same way their travel is. Generous rather than exact,
because a thumb aiming at a card is not aiming at its border. A tap off
the dock still closes it from anywhere.

A tap anywhere off the dock closes it; a tap on it does not. The
full-height surface is still there for that, just transparent — which is
what a scrim would otherwise be for.

`dialVisible()` deliberately does **not** list the dock. The panel covers
the glass and a running app replaces it, but a dock leaves the dial in
plain sight, and a dial frozen in plain sight reads as a crash.

The `.grab` mark sits on whichever edge the overlay travels from — the
edge your thumb pulls. The panel comes down from the top now, so its
grab belongs at the bottom; it sat at the top for as long as the panel
came up, and stayed there when the gesture was flipped.

## Preferences

Theme, depth units, the shallow alarm and brightness persist in
`localStorage` under `helmPrefs`. They did not before: every kiosk
restart - which is every deploy, every autopull and every crash - put them
silently back to AUTO, feet and 6 ft. An instrument that forgets how you
set it is not one you can trust to be set.

Values are validated on the way in, not trusted. That storage outlives
every version of this app that has ever run on the Pi, and something
merely old must not be able to break the boot: an unknown theme, a depth
of 99999 or a string where a number belongs all fall back to the default.

## Brightness

Two mechanisms, and only one of them is real.

The slider used to paint a black veil over the picture. The backlight
stayed at full behind it, so at night it still lit the cockpit, still drew
the same power, and only made the instruments harder to read. A browser
cannot reach the backlight - but `netd.py` can, where the kernel exposes
one and udev has made it writable.

When it can, the slider drives the real backlight and the veil stays at
zero. When it cannot - which is the case on this boat's panel, where the
kernel exposes no backlight at all and the display has no DDC either -
the veil is all there is.

Worth knowing what that means: compositing black over the image does
reduce emitted light, because the LCD pixels block more of it, so it
genuinely helps at night. What it cannot do is turn the lamp down. Blacks
stay grey, contrast falls as you dim, and the power draw does not change -
so dimming the screen overnight at anchor saves nothing on the battery.

If your panel has a backlight the kernel knows about but the file is
root-only:

```
echo 'SUBSYSTEM=="backlight",RUN+="/bin/chmod 666 /sys/class/backlight/%k/brightness"' \
  | sudo tee /etc/udev/rules.d/99-backlight.rules
```

then reboot. `netd.py` says which it found at startup:

```
[netd] backlight: rpi_backlight at 100%
[netd] backlight: NO - present but not writable
[netd] backlight: NO - none exposed
```

The helper floors it at 5% and never writes zero. A helm you cannot see is
a helm where you cannot find the slider to turn it back up.

## Touch lock

A small padlock in the same place on every page - just above the page
dots, at the foot of the screen. The dial's copy is drawn in the SVG at
the matching y rather than as an HTML button: the face is a 1080 viewBox
over a 1080 stage, so the coordinates line up exactly and it scales with
the dial in windowed mode. **Hold it for two seconds** and the helm locks.
Hold anywhere for two seconds and it unlocks.

Both directions are the same deliberate act, so there is nothing to learn
twice, and both draw the same indicator: a ring sweeping round the whole
bezel. At 1080 across it is unmistakable from the other side of the
cockpit, and it makes an accidental brush obviously not a lock.

Why it exists: spray and rain generate touches on capacitive glass, and a
wave should not be able to change the shallow alarm or drop the hotspot.
Two seconds is the one gesture weather cannot produce.

The overlay swallows every pointer event and paints nothing over the
instruments. **Locked is read-only, not blank** - you still need depth and
speed while the boat is being rained on. It does not survive a reload,
deliberately: being locked out by a crash would be worse than the problem
it solves.

The icons are state, not instruction, and they follow it: the overlay is
transparent, so all three page buttons stay in plain sight while the helm
is locked, and a shackle still hanging open under a locked screen would
simply be wrong. They close and take the accent colour when locked.

**There is no badge.** A `HOLD TO UNLOCK` card used to appear on every
touch of a locked screen. It was one more thing between you and the
instruments, and it was saying what the shut padlock at the foot of the
page already says. Locked reads as an instrument panel now, not as a
padlock you have to look past.

Everything that binds the hold stops propagation as well as preventing
default. These sit on top of the gesture handler, and without it a hold
that wanders a few pixels reads as a swipe - and a locked screen happily
opens panels behind itself, which is what the first version did.

## Alerts

One surface for anything that needs attention, so the next thing to raise
one - anchor drag, low battery, an adapter that vanished - does not have
to invent its own way of saying so.

```js
alertRaise('depth','alarm','SHALLOW · 15 FT','ALARM SET AT 40 FT');
alertClear('depth');
```

Two levels. `alarm` wakes the screensaver, `warn` does not. The banner
shows the worst unacknowledged alert; tapping snoozes it for ten minutes
while the condition stays live underneath and says so again when the
snooze expires.

The shallow alarm is its first customer, and moving it exposed a real bug:
it used to be a class toggle inside the dial's DRAW gate, so it **did not
run at all while the map or the music panel was open** - precisely when
nobody is watching the number. Alerts are evaluated in DATA, which always
runs, and the banner sits above the panels and the screensaver so it is
visible wherever you are.

Alert text carries whole units rather than tenths on purpose: to a tenth
the banner would rewrite itself several times a second for no added
meaning.
