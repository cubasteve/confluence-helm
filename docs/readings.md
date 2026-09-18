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
| `BURN` | seconds in hand to the line at this speed; red when you are late; dashes until the clock runs |
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

*The start.* The latest crossing within three minutes of the gun moves
the start time to it — a boat that crosses, is recalled, comes back and
crosses again started the second time.

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

Through `netd`, not from the page. The helm is served off the Pi and
vuduwave.com sends no CORS headers, so a `fetch` from the page is
refused before it leaves the machine — the same reason the radios live
in the helper. On a phone loading this page there is no helper, so the
second question is not asked at all and the card goes straight to
telling you what to type.

```
POST /score  {"racer_id": 201, "elapsed_time": "1.04.15"}
```

`netd` checks the time against the same formats the form does — an
unsendable string should not cost a round trip — and forwards it to
`/api/add_scratch_time`, which is what the page's own Add Result button
posts to. `HELM_SCORE_URL` points it somewhere else; empty switches
scoring off and the card stops offering it.

Two limits, neither of them for this boat's benefit. It is somebody
else's small server, and a bug in a loop here would be a bug in a loop
pointed at them:

- **Ten seconds** between any two submissions.
- **Five minutes** before the *same* racer and time may go again, so a
  double tap cannot post twice. A corrected time goes straight through
  — the form itself says an incorrect time can be resubmitted.

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
the fix is to stand at the buoy, take a new mark with `HERE`, and put
that one in the course. Meanwhile `BRG` in the RACE box advances the
course on a double tap.

The next mark comes from the course set in the Tracks app: tap marks
on the course sheet in the order you will sail them; the numbers on
the left are that order. Each mark in the course gets a `P` and an `S` beside it for the side you
will leave it — port unless you say otherwise, red and green the way
the lights are. The side shows on the map by the mark's number and in
the box as you close on it. With no course set, the only leg is back
to the line.

**Every row carries its position**, under the name, as a chart writes
it — `28 49.284N · 081 16.508W`. The hemisphere is a letter and the
degrees are padded, because nothing on a list read at arm's length
should turn on spotting a minus sign at 16 px. The club's marks and
your own read the same way. The short name is not repeated here — the
name is directly above it — but it is still what the cell headers and
the RACE box use, where a name has to fit in 32 px.

![Adding a mark of your own](img/course-form.png)

**Marks of your own.** `+ MARK` on the sheet's bar opens a form: a name,
and a position typed on the app's own keyboard or taken from the GPS
with `HERE`. Positions read as the sailing instructions write them,
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

**EDIT** is for the list itself, not the course — the course's order
is the numbers, set by tapping. It puts a grip on every row: drag it
onto another row and the mark takes that place in the list, the club's
marks included, and the order is kept. A mark of your own gets a ✕ in
edit mode, which removes it from the course and from storage.

**Tapping a mark of your own in edit mode opens it**, with its name and
position already in the fields, and `SAVE` writes over it rather than
making a second one. Outside edit mode a tap still adds and removes
marks from the course, which is what that tap is for the rest of the
time. The club's marks do not open: they are compiled into the page and
there is nowhere to save them to — their position is on the row either
way, which is the half of this that everything needs.

Before this a position could be written and never read back, so a mark
typed slightly wrong could only be deleted and entered again. `DONE`
leaves edit mode. Target speed and the wind
shift are not in the box: they are readings, picked into any slot like
the rest.

## When a sensor is not there

A reading with nothing behind it shows `––` on the glass and `—` in the
menu, dimmed. It stays selectable — the sensor may wake up — but it does
not look live. Which instruments are actually feeding is shown by the
four glyphs at the top of the control panel.
