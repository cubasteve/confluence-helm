# Readings

What the numbers on the glass are, where each one comes from, and how to
put a different one in any slot.

[← back to the README](../README.md)

## Every slot is a choice

There are no fixed readouts. **Tap any number and a menu unrolls from
it**, listing every reading with its live value; tap one and
it takes that slot. The reading that was there moves to wherever the new
one came from — a swap, not a shuffle, so nothing you did not touch ever
moves.

![The reading picker, open on the dial's depth cell](img/picker.png)

The menu is grouped by **instrument**, which is the useful sort: it
answers "what else can this box tell me", and it makes a dead sensor
obvious. A whole group dashed out is a wire to check; one dashed row
among many reads as normal.

It opens on the reading the slot already holds, centred, rather than at
the top — the list is longer than fits, and starting at BOAT SPEED
every time means hunting for where you are before you can go anywhere.
Drag to scroll it; a flick coasts. A drag never chooses anything, however
it ends.

Choices are saved per page (`musSlots` and `dialSlots` in browser
storage) and survive a restart. The two pages keep separate maps — the
dial and the music page are not showing the same things and never were.

## The readings

Values are magnetic where a compass is involved, and metric or imperial
follows the depth-unit setting.

### GPS

| Reading | Header | Unit | Signal K path |
|---|---|---|---|
| BOAT SPEED | `SOG` | KT | `navigation.speedOverGround` |
| COURSE | `COG` | compass point | `navigation.courseOverGroundTrue` |

**COURSE** is where the boat is *going*, which is not where it is
pointing — the difference is tide and leeway, and on a windward leg it is
the whole story. True, not magnetic: that is what the GPS puts on the
wire, and relabelling it would be a lie.

### Depth

| Reading | Header | Unit | Signal K path |
|---|---|---|---|
| DEPTH | `DEPTH` | FT / M | `environment.depth.belowKeel`, falling back to `…belowTransducer` |

Below the keel when the sounder is configured with an offset, below the
transducer when it is not. This is the reading the shallow alarm watches.

### Wind

| Reading | Header | Unit | Signal K path |
|---|---|---|---|
| APPARENT WIND | `AWS` | KT | `environment.wind.speedApparent` |
| TRUE WIND SPEED | `TWS` | KT | `environment.wind.speedTrue` |
| WIND ANGLE | `AWA` | — | `environment.wind.angleApparent` |
| TRUE WIND ANGLE | `TWA` | STBD / PORT | `environment.wind.angleTrueWater` |
| WIND DIRECTION | `TWD` | compass point | `environment.wind.directionTrue` |
| WIND SHIFT | `SHIFT` | LIFT / HEADER / STEADY | the direction against its own five-minute mean |

**WIND DIRECTION** is the one wind number that does not move when the
boat turns, which is what makes a shift a shift rather than a helm error.

**WIND SHIFT** is that direction against a slow average of where it has
been: the number is how far, the line under it which way — LIFT or
HEADER by tack, STEADY under two degrees with the degrees still shown,
because a 1° is not a 0°. Green for a lift, red for a header. The
average keeps running whether or not the reading is on the glass, so
picking it mid-lift shows the lift rather than a mean that has just
been reset to now.

**WIND ANGLE** is signed either side of the bow, the way it is called on
deck: forty degrees to starboard is 40, not 320. **TRUE WIND ANGLE** is
unsigned with the side spelled out underneath, because 12 STBD reads the
way it is said where −12 has to be decoded.

### Motion — the 9-axis

| Reading | Header | Unit | Signal K path |
|---|---|---|---|
| HEADING | `HDING` | compass point | `navigation.headingMagnetic`, falling back to `…courseOverGroundTrue` |
| HEEL | `HEEL` | STBD / PORT | `navigation.attitude` → roll |
| PITCH | `PITCH` | BOW UP / BOW DN | `navigation.attitude` → pitch |
| RATE OF TURN | `ROT` | °/MIN | `navigation.rateOfTurn` |

**HEADING** carries its compass point on the unit line — the one thing
three figures do not tell you at a glance. 258 is a number you decode; W
is a direction you already know. Eight points rather than four, because
four are wrong most of the time: 258 is not west, it is west by a bit.

**PITCH** is fore-and-aft trim: crew weight upwind, and how hard she is
burying the bow off it.

**RATE OF TURN** is degrees per *minute*, not per second — a boat turns
at a rate you would otherwise be reading as 0.2. Signed, because a heel
and a swing both reading "12 STBD" would be two cells that look
identical, and the rate is the part you cannot guess.

### Performance

| Reading | Header | Unit | Source |
|---|---|---|---|
| VMG | `VMG` | KT | `performance.velocityMadeGood`, or SOG × cos(TWA) |
| TARGET SPEED | `TGT` | % | SOG against the polar target for this true wind |

Not sensors, and they do not pretend to be. The Signal K plugin serves
VMG when it can; the arithmetic is the same number when it cannot.

**TARGET SPEED** is how close the boat is to what the polar says she
should be doing at this wind speed and angle: green at 98 % and up, red
under 90 %. It used to live with the race set and was asked out — it is
wanted on a Sunday beat as much as on a leg, and no more a start-line
number than VMG is.

## Where they can go

**The dial** has five slots.

![The dial](img/dial.png)

| Slot | Where | Default |
|---|---|---|
| `c0` | the big number in the middle, with its unit beside it | BOAT SPEED |
| `c4` | the strip under it — header, value and unit on one line | TRUE WIND SPEED |
| `c1` `c2` `c3` | the row along the bottom | DEPTH · HEEL · VMG |

The bottom three are one size. A rule under the big number and another
above the row make the strip a band between them, and two hairlines
down from the lower rule cut the row into its cells, so the lower half
reads as one table: the number, its strip, the three cells. The middle one used to be smaller and dimmer, because the three
are 214 px apart and only the outer two could spill towards the rim;
with the cuts there is nowhere to spill, so all three are sized to the
space between them and read the same.

**The music page** has three, arranged around the album art.

![The music page](img/music.png)

| Slot | Where | Default |
|---|---|---|
| `a` | above the art | HEADING |
| `p` `s` | port and starboard of it | APPARENT WIND · DEPTH |

## What a reading looks like

Every one is three lines — header, value, unit — on both pages:

```
   AWS          <- what it is
   13.4         <- the number
   KT           <- what the number is in
```

The third line is the unit, unless the reading has a side to report, in
which case it is that: `STBD`, `PORT`, `BOW UP`. Heading and course put
their compass point there. Degree signs are drawn at 0.52 em and lifted
back to the top of the digits, so the ring reads as a unit rather than as
a fourth figure.

The dial's big cell is the exception: its unit sits *beside* the number
rather than under it, measured off the number's own right edge so it
stays against the last digit.

## RACE

A pill above the countdown that says where in the race you are, and
opens into a box over the big number with the numbers that matter for
that part of it.

| The pill says | Colour | Icon | When |
|---|---|---|---|
| `RACE` | blue | slashes | idle |
| `COUNTDOWN` | amber | flag | the countdown |
| `RACING` | green | chevrons | after the gun |
| the mark's name, `RUM` | orange | buoy | racing, within 300 m of the next mark |
| `FINISH` | orange | chequered flag | racing, within 300 m of the finish line, once clear of it since the gun |
| `FINISHED` | slate | chequered flag | after the finish |

The box's border takes the pill's colour, so the two read as one thing.

**Opening and closing.** Tap the pill and the box opens or closes in
any state. The countdown opens it by itself and the gun closes it.
Closing on a mark opens it by itself and the rounding closes it — and
so does sailing back out beyond 350 m, so a range that wobbles about
the line does not flap it. A hand that closed it stays respected until
the next thing happens. Reset closes it.

The countdown also sounds. The face flashes and the sounder goes, on
the pattern a race committee sounds — out of the Pi's 3.5 mm jack into
an amp and a speaker, or off a GPIO pin into a piezo.
→ [Countdown signals](display.md#countdown-signals)

**The box covers the big cell**, so its first slot carries whatever
that cell was showing — SOG, or depth, or whatever you put there — and
nothing is lost. The strip and the three readings along the bottom stay
in view under it. What fills the other slots depends on where you are:

![The RACE box during a countdown](img/dial-countdown.png)

*Before the gun*, the line:

| Item | What it is |
|---|---|
| `LINE` | distance to the line, metres or feet with the depth unit; red when you are over |
| `BURN` | seconds to burn off before the gun at this speed on this course: `+` is slack, `−` is red and means you cannot make the line in time. Dashes until the clock runs, and whenever you are not closing on the line — sailing away from it or drifting, there is no time-to-line to count against |
| `LINE BIAS` | the favoured end and what it is worth, `PIN +12`, between the two ends |
| `P` `B` | the two ends of the line; tap each as you pass it, and the bias is then about the line you pinged rather than the club marks |

![The RACE box closing on a mark](img/dial-mark.png)

*After the gun*, the leg:

| Item | What it is |
|---|---|
| `DIST` | range to the next mark, metres under 1000 and nautical miles beyond |
| `BRG` | true bearing to it, to steer against COG; double-tap it to move the course on by hand, for a mark rounded wide or one the committee dropped |
| `MARK 2 OF 5 · TO PORT` | which mark, which side to leave it, and what follows it: `RUM · THEN GOSLING`; on the last leg, `FINISH LINE` |

**The line starts and finishes the race on its own.** Crossing it is
watched on every fix, and the instant is interpolated between the two
fixes either side of it rather than rounded to the one that noticed.
Both fixes have to fall between the ends, so a boat rounding outside
the pin is not a crossing, and a jump of more than 80 m between them is
discarded as a bad fix rather than believed.

*The gun can be scheduled.* `START TIME` is the first of the five
settings under the marks on the course sheet: type the time off the
sailing instructions — three or four digits and `AM`/`PM`, so `6` `2`
`5` `PM` — and the countdown starts itself `COUNTDOWN` before it and
runs out exactly on it. The readout then says when the gun is and lights
to show it is armed, the one beside it says how long the countdown runs,
and the RACE pill carries the time, so you can see it without opening
anything.

- Set it **inside** the window — three minutes before a five minute
  sequence — and the countdown starts at once, still ending on the gun.
- It is **one shot**: it clears when it fires, so it cannot fire again
  into the race it just started. Starting a countdown by hand disarms
  it for the same reason.
- A time that has **already passed** is refused rather than rolled to
  tomorrow. `18:25` typed at `18:30` is a typo far more often than it is
  a plan for tomorrow evening, and arming for tomorrow would look
  exactly like working while doing nothing tonight.
- It survives a restart, because the kiosk restarts on every deploy —
  but it is dropped on load once it is more than a countdown old, so
  yesterday's race does not arm itself tonight.
- A gun that went while the panel was off starts nothing.
- `12` is the one the clock face gets backwards: `12:25 PM` is twenty
  five past noon and `12:25 AM` is twenty five past midnight, and
  neither is twelve hours on from the other eleven.

The pad's keys are **112 px**, which is 45 on a 430 px phone — the
smallest thing worth asking a thumb to hit is 44, and the 56 px it
borrowed from the mark keyboard was 22. There is **one** `SET`, on the
pad where the last digit leaves your thumb; it was on the pad *and* on
the bar, which is the same action twice. And the bar's other button says
`NO START TIME` rather than `CLEAR`: backspace clears a *digit* and that
clears the whole scheduled gun, and two very different consequences were
wearing the same word.

*Which kind of start* it is comes from the **SEQUENCE** readout under
the marks on the course sheet — `GUN` or `WINDOW`. Nothing on the water
tells them apart: the same crossing, at the same place, at the same
moment, is a start on one night and a foul on the other.

| | during the countdown | at zero | after |
|---|---|---|---|
| `GUN` | the line is **shut**. A crossing is being over early, and starts nothing | the gun goes, the race starts | **the gun stands.** Crossing twenty seconds late is twenty seconds of lost time |
| `WINDOW` | the line is **live**. Crossing is your gun, and the clock runs from that instant | if you never crossed, it starts anyway | the latest crossing within three minutes moves the start to it |

`GUN` is a proper sequence — Saturday. `WINDOW` is an open five minutes
you go when you are ready — Wednesday. Its menu shows both with what
each does to the line, opened on the one in force. It is remembered
across a restart, because it is a fact about the series and not about
today.

It lived on the control panel until the start time arrived. Everything
about a start is one thing, and the panel is where the boat is set up
rather than where a race is.

The difference *after* the gun is the one that reaches the scoreboard.
On a gun start the fleet's time runs from the gun whoever was where, so
a late crossing is lost time — the cost of a bad start, and not
something an instrument gets to refund. On a window start your own
crossing is your start, so the clock follows it.

Either way, crossing **onto the course side** is what counts. Turning
back across the line never starts the race — that crossing changes the
sign exactly as a start does, and taking it would start your race as
you retreat from the line. The crossing after it starts you, which is
what a boat that was over early wants.

*The finish* needs two more things to be true:

- **You have been clear of the line since the gun** — more than 60 m
  from it at some point. Without this the gun itself would finish the
  race.
- **The course is sailed.** Every mark rounded, or no course set at all.
  Plenty of club courses bring you back through the line on a leg, and a
  windward-leeward with the line mid-course does it every lap; before
  this the race ended on lap one, armed and crossing exactly as a finish
  looks. With no course set there is nothing to wait for and nothing
  changes.

Either way a double tap on the clock does it by hand, and nothing
automatic happens at all until you have started the countdown yourself.
The finish needs a true wind direction to know which side of the line is
which — from the wind instrument, or from `COG` and `TWA` — so a rig
with no wind data finishes by hand.

**The track between races.** Recording runs from the countdown to the
finish, so the approach to the line is in it too. The finish writes the
track to browser storage, which is the buffer that survives a reload —
it is **not** a saved race. Putting one in `RACES`, with its distance,
elapsed, average and maximum, is the save button on the track map, and
it stays deliberate.

A new countdown has to start on an empty track, or the next race saved
covers two and its numbers are nonsense. So the old one is set aside
rather than cleared: the new track starts clean, and a card comes up on
the face saying `LAST RACE NOT SAVED` with what it is holding —
`6.46 NM · 59:59 · 02:09` — and two answers, `SAVE TO RACES` and
`DISCARD`. Discard is armed and asks `SURE?` on the first tap, because a
mis-tap there throws away a race.

The card goes up *after* the countdown is already running, so answering
it is never on the critical path of a start, and it waits as long as it
takes: the held race is on disk, and a reload puts the card back rather
than losing it. A start that was aborted before the gun is cleared
without a question — there is no race in it to ask about — and so is one
already sitting in `RACES`.

**The score, at the finish.** Sailing the race is half the job; the
other half is typing the result into the club's scorer at
[vuduwave.com/lmsa](https://vuduwave.com/lmsa). Two things have to go
in, and the helm knows exactly one of them.

So it asks the other. A card comes up at the finish with a single
question — `SPINNAKER?` — because the boat has two entries in the
roster, the same hull under two handicaps, and the answer decides which
one the result belongs to:

| Answer | Class | Racer |
|---|---|---|
| no | `CAP22NS` | 200 |
| yes | `CAP22` | 201 |

The card shows the name and the class — `STEVEN ARTAU · G4 · CAP22NS`.
The racer id is what the API wants and nothing you would recognise at a
glance, so it stays out of sight.

Then it asks the second question — `SUBMIT TO VUDU WAVE?` — with the
entry and the elapsed time on the card, so what you are agreeing to is
in front of you. Two answers:

- **YES** posts it and shows what the server said back. The reply is
  the server's own words rather than ours: it is the only thing that
  knows whether the result went in.
- **NO** shows what to type instead — the time, the entry, and a QR
  code that opens the page on your phone.

A refusal or a dead connection lands on the same face as NO, with the
reason on it. The number still has to get in either way, and a card
that claimed success on a request that failed would be worse than no
card at all.

The time is written the way the form wants it. It takes `hh.mm.ss`,
`h.mm.ss`, `mm.ss`, `m.ss` or `DNF`/`DNS`/`DSQ`, with a dot, colon or
comma between; the card always writes the long one, so `0.48.15` rather
than `48.15` — both are valid and there is no boundary to get wrong.

It asks both questions every time rather than remembering, and a new
finish asks again rather than assuming.

### How the submission goes

**Straight from the page.** `vuduwave.com` answers a CORS preflight by
reflecting whatever `Origin` asked, so a `POST` from here is allowed
wherever this file is served from — the panel, a phone, GitHub Pages:

```
POST https://vuduwave.com/api/add_scratch_time
{"racer_id": 201, "elapsed_time": "1.04.15"}
```

That is the endpoint the page's own *Add Result* button posts to.

It used to go through `netd`, on the assumption that the browser would
be blocked. That assumption was wrong, and it cost the phone the whole
feature: the helper only exists on the Pi, and the phone is exactly
where you are standing when the race ends. **`netd` is the backstop
now, not the road** — if the direct post is blocked or the connection
dies, and the helper is there, the card tries `POST /score` before
giving up. On a phone there is no helper and no second chance, and the
card says so rather than pretending.

A device that already knows it has no network is not offered the
choice at all: the card goes straight to what to type, marked
`OFFLINE`.

`HELM_SCORE_URL` repoints the helper's copy; empty switches its half
off.

**The same result cannot go twice.** The last one that actually landed
is remembered for five minutes, so a second tap on an identical result
is refused with `ALREADY SENT` — but a retry after a *failure* goes
through, because nothing went in to repeat. A corrected time always
goes: the form itself says an incorrect time can be resubmitted. The
helper keeps its own ten-second floor between any two submissions, for
when it is the one doing the posting.

**No CAPTCHA token is sent.** The entry form runs an invisible
reCAPTCHA — you would never see it, which is the point of an invisible
one — and `netd` has no way to produce a token and no business faking
one. So the request goes without, and whatever the server answers comes
back for the card to show. If it is refused, it is refused, and the
fallback is the number on the glass and a phone.

**Rounding** advances the course on its own, and it does not trust the
mark's position to the metre. It watches for the two things that mean
you went round something: you got as close as you were going to get,
and then you went *past* it — the distance opened by 50 m and the
compass bearing to the mark swung by 40 degrees or more.

Both halves are load-bearing. Opening alone is also what a tack away
from a layline looks like, and on a beat that happens twice a leg; the
bearing barely moves on a tack, because the mark stays in the same
direction whatever the boat is pointing at.

Reading it off the bearing rather than off `COG` is deliberate. Only
position is involved, so nothing here needs a second sensor to be
right, and a rig that never publishes course over the ground rounds
marks exactly as well as one that does.

It replaced an absolute test — inside 40 m of the recorded position,
then back outside 60 — which is a bet that loses. Club coordinates come
to a tenth of a minute, which is 185 m of latitude and so up to 90 m of
error before anyone mistypes anything; a buoy swings a scope of its rode
around its anchor all day; and rounding wide is normal racing. Miss the
40 m and the mark never advanced at all, which is what happened on the
water.

A mark more than 200 m from where the boat actually sails never arms.
That is not a tolerance to widen: it means the position is wrong, and
the fix is to stand at the buoy and correct the mark with `HERE` —
see below, it works on the club's marks too. Meanwhile `BRG` in the
RACE box advances the course on a double tap.

![The course sheet](img/course-sheet.png)

The next mark comes from the course set in the **Course app** — second
on the dock, right off the radar. It was a sheet inside Tracks until
the tiles it made you wait for turned out to be tiles it never used. **The course
reads across the top as a strip**, in the order you will sail it —
`FLAG – BALL  1 RUM  2 GOSLING  3 CB 12  FINISH`, the line it starts on
first and the same line at the end — and every mark this boat knows
sits under it as a tile. **Tap a tile to put that mark on the end of the
course.** Every tap adds a rounding, so tapping the same tile twice
sails past that buoy twice — the tile then says `IN COURSE · 1,3` and
the map draws one circle at the buoy carrying both numbers. The mark
being sailed to is the chip with the ring round it. With no course set,
the only leg is back to the line — and that is exactly what the strip
shows: `FLAG – BALL  FINISH`, start here and come back here, nothing
between. It used to carry `NOTHING YET · TAP A MARK BELOW, OR SYNC THE
CLUB'S`, a sentence explaining the two things directly under it — a grid
of marks with `TAP TO ADD` written on every tile, and a readout that
says `SYNC`. An empty route looks like an empty route now.

**A tap on a chip's number takes that one rounding out**, and the rest
close up. Removal lives on the chip rather than on the tile because the
chip is the rounding you are pointing at; a tile stands for every
rounding of that mark, so there is nothing for a second tap on it to
mean but *again*. It used to toggle, which read well until the day the
course wanted the same buoy twice.

**And the number now says so**, with a small cross in its top corner.
That was true for a long time before anything on the glass admitted it:
the number dropped the rounding and looked exactly like a number.

The cross is a **label, not a control**. The whole 44 px circle under it
is still the target — asking a cold thumb on a moving boat to hit 24 px
would be the opposite of the point — and the cross is simply where the
eye learns that the circle does something. It takes the tap as well,
because a finger aimed at a cross that lands two pixels off it should not
flip the rounding to the other side of the mark instead.

Two details that look like fussiness and are not:

- It is **drawn, not typed**. At 13 px the `✕` character is a few
  hairlines of whatever face fontconfig found and reads as a smudge; two
  round-capped paths are the same mark at any size and in any theme, and
  match the cross on the app frame and the one on a user mark's tile.
- It sits **beside the number, not inside it**. The number's text is what
  the strip *is* — the probes read it, and so would anything else that
  wants to know which rounding this is — and a glyph smuggled in would
  make that `1✕`.

  The probe guarding that is structural rather than textual, and it took
  a deliberate break to find out why: an `<svg>` contributes nothing to
  `textContent`, so a cross nested inside the number still reads as `1`
  and a text check passes while the thing it guards is broken.

The club's course waiting in dashed outline carries no crosses. None of
it is yours yet, and nothing in it can be dropped until the second tap
loads it.

It was a list of rows, one to a mark, with the course's order given as
numbers down the left margin. Every mark was legible and the one thing
the sheet exists for — what the course *is*, in order — was the one
thing you had to assemble in your head.

**A tap anywhere else on a chip flips which side that rounding is left
on**, `P` or `S` — port unless you say otherwise, red and green the way
the lights are. It is by rounding and not by mark, so a buoy taken to
port on the way out can be taken to starboard on the way back. The side
shows on the map by the mark's number and in the box as you close on it.
A third button on every chip would have made the strip half again as
long, and it is a choice between exactly two things.

**Each tile is the buoy, its short name, and where it stands in the
course** — and the buoy is drawn as it looks on the water, because that
is how it is found:

| | |
|---|---|
| **yellow special, X topmark** | `RUM`, `GOSLING` — the club's own inflatables. Marks of the *course*, which is what the X says |
| **red board on a piling** | `CB 2`, `CB 8`, `CB 10`, `CB 12`. The channel here is not buoyed, it is **beaconed**: a stick out of the water with a square board on top |
| **green board on a tripod** | `GREEN`, the Green Buoy — three wooden sticks leaned together in a teepee with the board across the top. Two pilings apart at a glance, which is the whole reason for drawing them |
| **white can** | `MAN 1`, `MAN 2` — the manatee zone's regulatory marks, floating, on a waterline |
| **white lighted buoy** | `FLAG`, the pin end. Not a flag at all: a donut of a float, a cylinder standing out of it, and the light on top |
| **one big grey ball** | `BALL`, the boat end — the Romance sail ball |
| **a plain pillar in the accent** | a mark of your own that has not said what it is |

**A mark of your own can say which buoy it is.** The form carries all
seven, under the position: tap one and it is kept with the mark, in
browser storage with everything else about it, and the sheet draws it.
Correcting one of the club's marks can change its buoy too, on the same
terms as its name: stored only if you changed it, so the correction
stays a correction and the table still says what the table says.

On the **night** theme every one of them is the same red, as everything
there is; the shapes still tell them apart, which is what tells them
apart out on the water in the dark anyway.

The drawing says in a glance what a line of type was spelling out, so
the tiles are smaller than they were — four across, and the club's
eleven marks fit without scrolling. Tiles carry the short name, the one the
cell headers and the RACE box use, where a name has to fit in 32 px.

In **EDIT** the tile says the mark's position instead of its place in
the course, as a chart writes it — `28 49.284N · 081 16.508W` — and the
grid goes to three across to fit it. The hemisphere is a letter and the
degrees are padded, because nothing read at arm's length should turn on
spotting a minus sign at 13 px.

### Every section carries its own control

There were four buttons in a row across the foot of the sheet — `+ MARK`,
`CLEAR`, `EDIT`, `DONE` — 86 px of the narrowest glass on the face, spent
on things that each belong to one part of what is above them and none of
which said *which* part. The row is gone and each one went home:

| | now | because |
|---|---|---|
| `CLEAR` | in the `ROUTE` heading | it empties the route. Disabled while there is no route to empty |
| `PREVIEW` | in the `ROUTE` heading, beside it | it draws the route. See below |
| `EDIT` | in the `MARKS` heading | it changes what is in the list |
| `+ MARK` | the **last tile in the grid** | a mark appears in the grid, so that is where you make one, and it stands in the place the new one will take. It led the grid for a while, which put it under your thumb and also put it in front of eleven marks you have to get past it |
| `START LINE` | **first in the route**, in line with it | the route starts on the line and comes home to it. It was down among the evening's settings, next to the countdown, as though it were another thing about the clock |
| `DONE` | **gone** | the ✕ at the foot already meant *out of here*. It goes back one step now: a sheet in front of the app closes first, the app itself next. Two ways out on a face this small is not a convenience, it is a question about which one you meant |

The sheet is 46 px taller for it, all of it given to the marks grid, and
the strip lost its `›` separators on the same argument — the chips are
numbered, which is what says the order, and eleven pixels of punctuation
per gap was what tipped a four-mark course onto a second row.

The line is a chip at the head of the strip, dashed like `FINISH`
because neither is a mark you round, and drawn the way the map draws a
line: two ends with a dashed run between them.

It costs 216 px of a row 816 wide, which is the whole of the honest
accounting here: a two-mark course fits on one row at 740, and three
does not — 931. Twenty of that came back by taking the chip gap from 10
to 8 and the side badge from 46 to 42, and the rest cannot be had
without giving up something that earns its place. The `P`/`S` badge
could go and its colour move to the chip's border, which would save 50 a
chip and fit five marks on a row — and on the night theme, where
everything is one red, a coloured border says nothing at all. So the
strip wraps, and a three-mark course is two rows of chips at 151 px
rather than one at 72. What is bought for that is the route reading as a
route: you start on the line, you round these, you come home to it.

### The course, drawn — the club's own picture

`PREVIEW`, next to `CLEAR` in the `ROUTE` heading, puts the course on a
card over the sheet.

The strip says what the course **is**, in order, which is the thing you
read at the wheel. What it cannot say is what the course *looks like* —
which of the two marks off the point is the third one, whether leg two
is a beat or a reach.

**This is not our drawing.** LMSA's member app already draws exactly
that on its Race Day page — the course over satellite imagery, the
roundings in red and green — and we sync the course from that same site.
So the code is lifted from `lmsa.pages.dev/assets/race.js` and kept in
one block, `LMSA`, with its own little vector helpers rather than folded
into this file's: the point of copying it is that it can be compared
with theirs line for line when either changes. What differs is only what
it is drawn *with* — theirs is Leaflet on a web page, this is one SVG on
a round panel.

What comes across whole:

| | |
|---|---|
| the imagery | Esri World Imagery, the same tiles the track page caches |
| `#D7263D` / `#11945A` | the club's nautical red and green, for a rounding to port and to starboard |
| `#1C2B5E` | navy, for a buoy rounded both ways — neither colour is right |
| `#0b1530` + white | the route: a dark casing at weight 7, white at weight 3 over it |
| `#FFC53D` | the start line, dashed `7 6`, with a disc at each end |
| `R = 110 m` | the rounding circle, in metres of real water |
| `LEAD 160`, `CROSS_OFF 85`, `APPROACH 220` | how far the route runs through the line, off its middle, and out before the first leg |
| `CLOSE 45`, `RUN 150` | closer than 45° to the wind is beaten up in tacks; past 150° is run down in gybes; between, a reach that sags to leeward |
| `boards()`, `chaikin()` | the tacks, and the smoothing that makes a tack a turn rather than a kink |
| the shoreline | Lake Monroe from OpenStreetMap, ~19 KB, so a route that would cross land is put round it |

The badges are the club's too: `S` and `F` on the line, numbers on the
roundings, a buoy rounded twice carrying `1·3`, coloured by side. So is
the legend bottom-left, the wind box top-right, and the sentence at the
foot — `ABOUT 4.2 NM SAILED · ONE BEAT AND ONE RUN`.

Three deliberate departures, and only three:

- **Names are drawn on**, where the club uses hover tooltips. There is
  no hover on a touch panel.
- **Night dims the imagery.** A satellite picture at full brightness on
  a dark-adapted eye is an hour of night vision gone, and that is the
  one thing this panel is not allowed to spend. Day and dusk get it as
  the club draws it.
- **The wind can come from the forecast.** See below.

**Keeping the route on the water** is `keepOnWater()`: the drawn line is
densified to 10 m, any stretch on land is replaced by an A\* path over a
30 m grid of the lake — shrunk by a cell so detours keep off the bank —
and the result is smoothed only if smoothing keeps it wet. The grid is
built once, by scanline over every shoreline ring, islands as holes.

#### And the wind can come off the forecast

The masthead is the truth and always wins. But the course is set at the
dock, often before the instruments are awake and always before the boat
has sailed anywhere, and a preview that cannot route is no preview. So
when there is no true wind aboard and no heading-plus-angle to make one
from, the card asks **Open-Meteo**:

```
api.open-meteo.com/v1/forecast?latitude=…&longitude=…
  &current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn
```

No key, no login, no account. `wind_direction_10m` is the direction the
wind is **from**, in degrees, which is TWD as it stands. One request per
quarter hour — Open-Meteo's own step — cached in `localStorage`, because
the first thing a Wednesday does is reload the page. It fails quietly:
no signal at the dock is the normal case, not an error. The wind box
says `FORECAST` under the speed when that is where the number came from.

With neither instrument nor forecast, `legRoute()` falls back the way the
club's does — no tacks, and each leg bowed to alternate sides so a
windward-leeward is two lines rather than one drawn twice.

**What we gave up to match them.** This panel carries the boat's own
polars, and the best-VMG angles they give for a Capri 22 in nine knots
are 45° and 154° — within four degrees of the club's fixed 45 and 150.
Using the polars instead is a two-line change, and the reason not to is
that the picture would stop being the same picture.

### The four settings### The four settings

**Everything about the evening that is not the course itself is one row
under the heading**, drawn the way the dial's readings are — a small label
over a value — because that is what they are: things you read at a
glance and only occasionally change.

| | reads | a tap |
|---|---|---|
| `START TIME` | `6:25 PM`, or `NOT SET` | opens the pad that types it — see below |
| `COUNTDOWN` | `5 MIN` | **steps** it: 5, 10, 15, `OFF`, and round again |
| `SEQUENCE` | `GUN` or `WINDOW` | opens a menu: both, with what each does to the line |
| `CLUB` | `SYNC`, `CHECKING…`, `4 MARKS?` | asks the club site and opens on the answer — see below |

The row is at the **head** of the sheet, above the route and the marks.
It sat across the foot, which put the thing you set once below the two
you work at all evening, and made the page read bottom-up. The two clock
facts are next to each other because between them they say when the
countdown starts, which neither says alone. The row is 816 wide, the
same as the strip and the marks below it, so its ends line up with
both — it was 940 and hanging 62 px proud of each when there were five
readings and a button row holding it higher up the glass.

The countdown is the only one that opens nothing. Four values is not
worth opening, scrolling and dismissing something for. It is how long
the countdown runs — the club's sequence is five minutes, and a regatta
that runs ten or fifteen needs saying once. Change it while nothing is
running and the RACE pill carries the new length at once rather than at
the next reset.

**`OFF` is a countdown of nothing.** Press `START` and the gun goes at
once and the race is running. It is not the clock turned off — the race
clock runs and the line still starts and finishes you — it is the
*sequence* being none. A practice start, a pursuit where your gun has
already gone, or a race you joined late all want it, and the only way to
get one before was to start a five and sit through it. It is written
`OFF` rather than `0 MIN` because nought of something reads as a broken
number, and this is the absence of the thing rather than none of it.
Being a length like any other, it is remembered across a restart — and
it is the one most easily lost by code that tests a number for truth
instead of for membership, so `persist` asserts it by name.

**The menu is the dial's readings picker** — the same box, the same
code: painted in `--panel` over a hairline so it reads as something in
front rather than a hole, **swiped to scroll** because nothing under
`#stage` scrolls itself, and **tapped to choose**. What the course sheet
supplies is the rows, the head and foot, and what a tap means. It opens
*above* its readout — the settings row has the sheet's own bar under it,
and a menu over that covers the way out — and on the value already in
force, so the choice you have is under your finger. With one open, a tap
on another of them moves it; a tap anywhere else puts it away, and that
tap does nothing else.

They all open **downwards**, into the sheet. They asked to open upwards
for as long as the row was across the foot with the sheet's own button
bar under it — a menu over that bar covered the way out. The bar is gone
and the row is at the top, so upwards is now off the glass.

**`START LINE` is which line the race starts *and* finishes on**, and it
is the one fact on this sheet you cannot work out from anything else on
it — so it names both ends rather than saying that a line exists. There
are exactly two, and its menu is those two:

| | |
|---|---|
| `FLAG – BALL` | the club's marks. They do not move — that is the line at LMSA |
| `PINGED` | the line you pinged with `P` and `B` on the race box, tapping each as you pass it |

A pinged line wins while it is there, for a day the committee lays it
somewhere else. Choosing `FLAG – BALL` **drops the pings** and goes back
to the marks — the way back from a ping taken at the wrong end. Until
both ends are pinged, `PINGED` is shown greyed rather than left out,
with `PING BOTH ENDS WITH P AND B ON THE RACE BOX` under it: a menu that
hid the other line would not say how to get it.

![The two lines there are](img/course-line.png)

### The start time pad

It comes up **over** the sheet rather than in place of it, on a scrim
that dims everything behind. It used to
take the whole page, which meant the course you were setting a time for
vanished while you set it — the one thing you might want to look at —
and a full page for four digits is what a phone does because a phone has
nothing else on the screen. 640 × 736 on a 1080 circle, with a veil to
tap away.

640 and not the 520 it was first drawn at, because **430 px of phone
shows 1080 px of layout**: a key is 0.398 of what the stylesheet says,
and 112 is the smallest that still lands 44 px under a thumb. A pop-out
is worth having; a pop-out you cannot hit is not. A probe holds that
number.

The field is a **fixed two-and-two mask** that fills as you type —
`––:––`, `6–:––`, `62:––`, `06:25` — with the digits not yet typed drawn
in the hairline. It showed the raw digits with the colon two from the
right before, which meant the number changed width and jumped sideways
under the thumb on every key. A clock is four characters wide whatever
you have typed into it so far. The `GUN AT` label beside it is gone: the
pad is titled, the readout it came from is titled, and a label on the
number as well was the third time of asking.

**The dim is not decoration.** A pad floating over a live sheet leaves
the cross at the foot, `CLEAR` and every mark tile looking exactly as
tappable as they were a moment ago — and the one of those that is a real
hazard is the cross, which closes the whole app. So the veil and the pad
are children of the **stage**, not of the sheet: inside the sheet they
sat in `#tmap`'s stacking context at z1, where a z26 veil cannot reach
over an app at z25, and the cross stayed bright and live on top of the
dim. A probe now hit-tests the middle of the cross and requires the veil
to be what a tap there would land on.

### CLUB SYNC

![The club's course, found and waiting](img/course-club.png)

The club posts the evening's marks on the members' site by 5:30, the
same ones that go on the clubhouse door. The **`CLUB`** readout fetches
them: they are these marks under three different names, so the site does
the translating and hands back ids this file already knows.

**Two taps, never one.** The first asks, and shows what came back — the
club's course drawn in the strip in dashed outline, in the place it
would take, the readout reading `4 MARKS?`, and its menu open on when it
was posted and anything the committee wrote on it. With nothing posted
the menu is one line, `NOTHING POSTED`, and no heading over it: the
readout you opened it from says `CLUB` and the line says what came back,
so a `TONIGHT, FROM THE CLUB` above those was a third way of saying the
same thing. No date on it either — the sync asks for today and nothing
else, so the date could only ever be today's. The second tap is
`LOAD 4 MARKS` at the foot of that menu, and it is the only thing that
replaces your course. Tapping a control and having the course you are
three marks into vanish is not something this sheet should be able to do
by accident.

**The start comes over with it.** The site posts it with the course now
— `start: {at, mode, countdown}` — so three things arrive together:

| | |
|---|---|
| `at` | the club's own wall clock, `"18:25"`. Empty means *the schedule's usual*, which is what a course that said nothing always meant |
| `mode` | `window` or `gun`. The Rum Race is self-timed off an open line; a monthly club race is a gun, and the committee now says which |
| `countdown` | how many minutes the countdown runs up to it |

Loading takes all three: `GUNAT`, `CFG.startMode`, `CFG.startMins`. The
menu says so before you commit — `GUN AT 7:10 PM` over
`15 MIN COUNTDOWN · LOADING SETS ALL THREE` — and the first tap still
changes nothing.

**A start that has already gone is refused**, with
`THAT START HAS GONE · THE CLOCK IS LEFT ALONE`, and the clock is left
where you had it. That is the right behaviour and it is also what rotted
the `club` probe: the fixture posts a start for 2026-09-30, which passed
three days after it was written, and from then on thirteen assertions
failed because the app was correctly refusing a race that was over.

The fix is a frozen clock rather than a newer date — a newer date only
resets the fuse. `club.mjs` pins `Date.now()` to 16:00 at the lake on the
fixture's own day for the length of the start section and restores it
after. It has to span the whole section, not each sync: `clubApply` reads
the clock parsing the reply, and then the periodic gun check reads it
again and **drops a gun that has already gone** — so a freeze that covered
only the sync set `GUNAT` correctly and had it cleared out from under the
assertion 120 ms later. Everything else in that file keeps its fixed
dates, because the rest is tested for what the calendar says about them,
which does not change.

The `＋` on `COUNTDOWN` steps through five, ten, fifteen and off, but the
club's editor takes any number, so **what is valid is wider than what the
stepper cycles to**: `startMins` accepts 0–60 and survives a reload.
Stepping on from a posted seven lands on five, which is where
`indexOf(-1)+1` points and is the right place for it to land.

**When `at` is empty** the window still comes from the club's own
schedule — `assets/schedule.js`, the file its calendar and its Race Day
page both read — with the rule copied:

> Rum Races are every Wednesday of the season, `18:25–18:30`, except
> early and late in it — Mar 11 to Apr 8, and Sep 30 to Oct 28 — where
> the window moves to `18:00–18:05` for the light. Everything else that
> has a window carries its own: Ladies on the Lake at noon, the Jameson
> Sine Metu at one or two.

Copied rather than fetched. `schedule.js` is 15 KB of JavaScript object
literal, and parsing someone's source at the dock to learn what time to
start is a worse dependency than six lines of arithmetic. The menu says
which of the two you are getting: a posted time is stated plainly, the
schedule's says `· THE USUAL TIME`.

The time is **Florida's**, not the browser's. The panel on the boat is
in `America/New_York` so it is usually a no-op, but the same page opens
on a phone in another state, and 18:25 means 18:25 at Lake Monroe either
way. `clubMoment()` asks `Intl` what that instant reads as in the club's
zone and applies the difference once, which is the only way to get the
two Sundays a year right.

Two things it will not do:

| | |
|---|---|
| the start has already gone | the clock, the countdown and the sequence are all left alone. You are sailing in it, and arming a countdown that runs out the moment it starts is worse than no countdown. The course still loads — the marks are the point of the sync |
| no start for the date | `NO START TIME FOR THIS DATE · SET IT YOURSELF` |

What did not come across is said **before** you load rather than found
out at the mark: `1 MARK THIS BOAT HAS NOT GOT`, and `IT DOES NOT START
ON THE LINE` for a course this sheet cannot draw a start for. That is
the moment it can still change your mind, so it is the only moment it is
said. Nothing reports the load afterwards — the strip already shows it,
and a line under the marks saying `LOADED` said nothing you could not
see.

A mark can fail to arrive two ways, and both are counted. The site names
the ones *it* could not translate. The other is the site believing this
boat has a mark it has not got — the site's list of what the helm
carries and the table in this file are kept in step by hand, so they can
drift — and that one is only visible from here. A course arriving a leg
short with nothing said about it is the worst of the three outcomes.

A site that does not answer says `NO ANSWER · IS THERE WIFI?` in the
menu and changes nothing. Asking again is tapping `CLUB` again: the
readout is the button, so the menu needs none of its own.

It has to be *us* that asks. The helper binds loopback, so nothing off
the Pi can reach in and set a course — the right way round for a box on
a boat. The read at the other end is open, because a posted course is
public by the time it matters, so there is no login to carry.

It keeps its own colour among the four — `--club`, a teal, with a cloud
the course comes down out of. It is not one of the app's blue actions:
it is the only one of the four that reaches off the boat, and the only
tap on this sheet that can replace a course you are already sailing.

![Adding a mark of your own](img/course-form.png)

**Marks of your own.** The `＋ NEW MARK` tile at the head of the grid
opens a form: a name,
a position typed on the app's own keyboard or taken from the GPS with
`HERE`, and which of the seven buoys it is. Positions read as the sailing instructions write them,
degrees and decimal minutes with a space between, or as decimal
degrees, with the hemisphere as a letter at either end or as a minus
for west and south — `28 49.03 N` and `081 16.17 W` go in as the chart
writes them. A position more than 100 NM from the
boat is refused with a hint about the minus: a longitude typed without
it lands in Asia, and the map would try to fit the globe. `SAVE` keeps
the mark for good —
it is there after a reboot, on the sheet, on the map and in the
readings like the club's — and adds it to the course.

![The course in edit mode](img/course-edit.png)

**EDIT** is for the list itself, not the course — the course's order is
the strip, set by tapping. It puts a band down the right of every tile:
drag it onto another tile and the mark takes that place in the grid, the
club's marks included, and the order is kept. A mark of your own gets a
✕ in edit mode, which removes it from storage and from every rounding
of it in the course.

**Tapping a mark in edit mode opens it**, with its name and position
already in the fields. Outside edit mode a tap still adds a rounding to
the course, which is what that tap is for the rest of the time. `EDIT`
in the heading is a toggle, lit in the accent while it is on.

What `SAVE` then does depends on whose mark it is.

### Correcting the club's marks

The coordinates in the file come from the sailing instructions, and the
sailing instructions are not a survey. They are given to a tenth of a
minute — 185 m of latitude before anyone mistypes anything — a buoy
swings its rode around its anchor all day, and one gets dragged and
reset a boat length from where it was without anybody writing it down.

So **a club mark can be corrected from the boat, standing at it, with
`HERE`** — the only instrument aboard that actually knows where the
thing is. Tap `EDIT`, tap the mark, tap `HERE`, tap `SAVE`.

| | |
|---|---|
| A mark of your own | edited in place — it *is* its position, there is nothing underneath |
| A club mark | **overridden** — the compiled coordinate stays, the correction sits over it |

A corrected mark writes its position in the accent colour on the sheet,
so you can see at a glance you are no longer looking at what the book
printed, and its row carries a **↺** where a mark of your own carries a
bin. That puts the sailing instructions' number back.

The override is stored by mark id, so it survives a reload and follows
into the course, the map, the readings and the rounding. The compiled
value is never touched — which matters the day the club re-lays a mark
and republishes: the file updates, and you find out whether your
correction still agrees with theirs.

Only the position is stored unless you change the name too, so a
correction stays a correction rather than quietly freezing the club's
name for that mark as well. An override for a mark the file no longer
has is kept rather than discarded — the club may bring it back. Target speed and the wind
shift are not in the box: they are readings, picked into any slot like
the rest.

## When a sensor is not there

A reading with nothing behind it shows `––` on the glass and `—` in the
menu, dimmed. It stays selectable — the sensor may wake up — but it does
not look live. Which instruments are actually feeding is shown by the
four glyphs at the top of the control panel.
