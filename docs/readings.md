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

The middle of the bottom three is set smaller than its neighbours, and
that is geometry rather than preference: the three are 214 px apart and
only the outer two can overflow towards the rim.

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

## The race set

Before the sequence, the start-line numbers live round the timer, which
is where the start already was, so the big number keeps the middle of
the glass at full size and the readings below keep their cells:

```
          (+)      5:00      (-)
   LINE 45 M   (P) PIN +12 (B)   BURN +3 S
```

| Item | What it is |
|---|---|
| `P` `B` | the two ends of the line; tap each as you pass it |
| between them | the line's bias: the favoured end and what it is worth, `PIN +12` |
| `LINE` | distance to the line, metres or feet with the depth unit; red when you are over |
| `BURN` | seconds in hand to the line at this speed; red when you are late; dashes until the clock runs |

All of it is up whenever the clock is idle or counting down, and folds
away at the gun.

The bias sits between the P and B rings because they *are* the two
ends: `PIN +12` with the P ring on its left is the whole sentence. It
is up while the clock is idle as well as counting down, since the end
you pick is decided before the sequence, not during it.

Target speed and the wind shift are not here: they are readings, picked
into any slot like the rest.

## The start

From the first second of the countdown to the gun, the whole face is
the start line. For those five minutes nothing else on the glass
matters, and the dial's numbers are the wrong shape for the question —
*am I going to be on the line, on time, at the right end.*

![The start overlay during a countdown](img/dial-countdown.png)

**The clock** at the top, with the same plus and minus either side to
sync it to a signal. It sits lower than the dial's so the alert banner
cannot cover it — a shoaling warning is exactly what turns up on a start
line.

**The picture** is the line, to scale, looking upwind:

- The wind comes at the line from above, and the arrow is tilted by the
  bias, so a line that is not square to the wind *looks* not square.
- Pin and boat end are on the sides they really are, seen from the
  pre-start side. The favoured end is ringed green with what it is
  worth under it. Tap either end to ping it as you pass — the same as
  the P and B rings on the dial.
- The boat is the arrow: where she actually is against the line,
  pointing where she is actually going, with her course dashed on to
  where it meets the line. Over early and she is drawn above the line,
  in red.
- Everything shares one scale, chosen so the line fills the width and
  the boat always fits: a long way off zooms out, and the line shrinks
  with it, so the geometry never lies.

**The foot** is the three numbers: `LINE`, distance to go; `BURN`, the
seconds in hand at this speed, green with time and red when late; and
`SOG`.

A double tap on the clock is the gun, as on the dial; a hold is reset;
the swipes still open the panel and the dock over it. It goes at the
gun, when the dial and its leg readings come back, and reset brings the
dial back too. Depth is never hidden by it: the shallow alarm is a
banner over everything.

## When a sensor is not there

A reading with nothing behind it shows `––` on the glass and `—` in the
menu, dimmed. It stays selectable — the sensor may wake up — but it does
not look live. Which instruments are actually feeding is shown by the
four glyphs at the top of the control panel.
