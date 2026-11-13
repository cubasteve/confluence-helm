# Sonar

An Open Echo transducer on the boat, the depth it already gives you, and the echogram it does not.

[← back to the README](../README.md)

## The short version

**Depth needed no code.** The panel has subscribed to
`environment.depth.belowKeel` and `environment.depth.belowTransducer`
since long before there was a transducer to fill them. Get Open Echo
publishing NMEA `$SDDBT`/`$SDDPT` into Signal K and the DEPTH cell, the
shallow alarm and its three-zone bar all start working with nothing
changed in this repo.

**The echogram could not go that way.** One ping is 1800 bytes of echo
strength, about ten times a second. Signal K is a delta protocol for
small scalars; 18 kB/s of binary has no business in a key/value stream,
and there is no path name that would make it one. So the picture takes
its own road:

```
Open Echo  ──UDP or serial──▶  netd.py  ──POST /sonar──▶  the SONAR app
            (1808-byte frames)   (checks, squeezes, keeps a minute)
```

## One depth, and who measures it

The rule is that this boat has **one** depth and everything reads it
from the same place. Two of them — off the same transducer by two
routes, disagreeing by a few centimetres and some fraction of a second
— would leave nothing to say which one the shallow alarm was ringing
about.

Who satisfies that rule depends on the board, and the ATMEGA328P
settles it:

> **An UNO R3 has one hardware UART and it is wired to the USB socket.**
> The board sends the echogram or it sends NMEA. Never both.

So on an R4, where the binary goes out over USB and NMEA goes out on
separate pins, the board announces its own depth and `netd` must keep
its hands off. On an **R3 the two are mutually exclusive** — flashing
the firmware that carries the samples takes the depth off the bus
entirely, and the depth is the number the alarm rings on.

`netd` therefore puts it back, and that is the same rule rather than a
change of mind. What moved is *who measures it*, because a board that
can only say one thing at a time can no longer both measure and
announce.

```
          R4 (two outputs)                 R3 (one output)
  board ──NMEA──▶ Signal K ──▶ panel   board ──binary──▶ netd
  board ──UDP───▶ netd ──▶ echogram                        ├──▶ echogram
                                                           └──NMEA──▶ Signal K ──▶ panel
```

Either way the panel, the alarm, the chartplotter and the log read one
number from `environment.depth.*`, and none of them need to know which
side of that diagram it came from.

### What crosses, and in what form

| | comes from | shown as |
|---|---|---|
| the number | Signal K — whoever put it there | the big figure, the dial, the alarm |
| the picture | netd, always | the waterfall |
| the bottom pick | netd, as a **sample index** | a line drawn *on* the picture |

The pick stays an index on purpose. In that form it is in the same
coordinate system as the samples it is drawn over, so it lands exactly
on the echo it refers to. Converted to metres and printed, it would be
a second depth wearing a disguise — and that is still true even now
that netd computes one for the bus, because the one on the bus is *the*
depth rather than a second opinion about it.

### Announcing it

Off unless asked for, and that default is load-bearing: a boat whose
board still announces its own depth must not acquire a second source.

```sh
HELM_SONAR_NMEA=udp:10110         # where to send it
HELM_SONAR_NMEA_HZ=2              # how often (default 2)
HELM_SONAR_KEEL=0.6               # metres from transducer face to keel bottom
```

It goes out as **NMEA 0183 over UDP**, which is what everything else on
a boat already speaks — Signal K, AvNav and OpenCPN all ingest it — so
nothing downstream needs changing. 10110 is the registered port for
NMEA 0183 over IP.

In Signal K that is one connection, with two fields:

> **Server → Data Connections → Add**
> Data Type **NMEA 0183**, NMEA 0183 Source **udp**, Port **10110**.

UDP is Signal K's only *plain inbound listener*. The alternatives were
checked and rejected on the merits rather than on taste:

| | why not |
|---|---|
| `PUT /signalk/v1/api/…/environment/depth/belowTransducer` | not a data-injection route at all — a stock server answers **405 PUT not supported** |
| the WebSocket delta stream | it does ingest, but writes go through `shouldAllowWrite`, so it wants credentials that a stdlib helper would then have to store and renew |
| NMEA 0183 over **TCP** | Signal K's TCP modes connect *outward* as a client, or serve; neither is a plain listener on a port of your choosing |

UDP needs no auth, no credentials on disk, no outbound anything, and
works with the boat's internet unplugged — which on a lake is the
normal condition.

An unnamed host means **this machine** for a sender and **every
interface** for a listener. The same spelling, defaulting opposite
ways, because `udp:5005` said to a listener and `udp:10110` said to a
sender are both "the obvious one" and the obvious ones point in
opposite directions. Broadcasting the boat's depth to the marina is not
a friendly default.

Two sentences go out, the way a real sounder sends both:

```
$SDDPT,4.57,-0.60*7A
$SDDBT,15.0,f,4.57,M,2.50,F*33
```

`DPT` carries the offset and is what lets a consumer work out the depth
under the **keel** rather than under the transducer. `DBT` carries no
offset and is what older software reads. They say the same thing, so
anything reading both still has one number.

The offset goes out **negative**: NMEA reads a positive offset as the
distance up to the waterline and a negative one as the distance down to
the keel. Get the sign wrong and a boat in four metres is told it has
five, which is the wrong direction to be wrong in. (`-abs(0.0)` is
negative zero, and `%.2f` spells that `-0.00`, so a boat with the
transducer at the keel was briefly announcing a signed nought in a
field that is read as a direction. A probe caught it.)

What is announced is the **median** of the pings since the last
sentence, not the latest of them. One bottom pick is one sample index
off one noisy return, and a sounder that shouts every flyer at the
shallow alarm is a sounder somebody switches off. At 2 Hz over a board
pinging at 10, that is a median of five — enough to throw away an
outlier, not enough to lag a boat.

A ping that reports index **zero** has not found a bottom, and those are
excluded. Announcing nought metres of water to a shallow alarm is the
worst lie available here. If nothing has a lock, netd says nothing at
all and the staleness rules downstream take it from there — the panel
drops the reading after 8 s, which is the truth.

## The frame, and what it leaves out

```
0xAA │ idx u16 │ temp×100 i16 │ vDrv u16 │ <N> sample bytes │ XOR
```

Little-endian. The XOR covers every byte **after** the 0xAA. Total
length is `N + 8` — 1808 at the stock `NUM_SAMPLES` of 1800.

What it does not carry matters as much:

- **no length field.** A reader has to already know `N`.
- **no timestamp, no sequence number.** Ordering is arrival order.
- **nothing naming the build.** A board reflashed with a different
  `NUM_SAMPLES` or sample period looks identical on the wire and is
  silently wrong.

Over **UDP the datagram's own edge stands in for the missing length** —
a frame is a datagram, so `N` is its length less eight, and the
checksum is what says that reading was right. Over **serial there is no
such edge**, so `N` is configuration that has to match the firmware.

The checksum is eight bits over eighteen hundred bytes. It catches a
bit flip and it catches a frame read at the wrong offset; roughly one
bad frame in 256 walks through it. That is the format's arithmetic, not
a choice made here, and it is tolerable because of what it guards: one
wrong column in a scrolling minute, painted over by the next ping. The
alarm does not run on this.

### Resynchronising

`0xAA` is also a perfectly ordinary loud echo, so on the serial path
every `0xAA` is a *candidate* header and the checksum is the only thing
that tells a real one from a bottom return. A failed candidate advances
the window by **one byte**, not by a frame — step a whole frame and you
walk straight over the true header sitting two bytes further in, and
the stream never recovers. `tests/sonar_test.py` holds that case: a
byte dropped mid-stream costs exactly one ping.

## Configuring it

One environment variable, read at startup:

```sh
HELM_SONAR=udp:5005                      # R4 WiFi, broadcasting frames
HELM_SONAR=udp:192.168.8.1:5005          # …pinned to one interface
HELM_SONAR=serial:/dev/ttyACM0:250000    # R3, or R4 over USB
```

Put it in **`~/.config/confluence-helm.env`**, not in `netd.sh`:

```sh
HELM_SONAR=udp:5005
```

`netd.sh` sources that file if it exists. It lives outside the checkout
because autopull replaces every tracked file, so a value edited into the
script would be gone at the next push — most likely without anyone
noticing until the sounder was wanted.

Unset is the default and nothing is opened. netd says which it took at
startup, and says so loudly when `HELM_SONAR` is set to something it
cannot read — an unreadable value and an unset one would otherwise look
identical from the console, and the first is a typo somebody wants to
hear about.

The rest only matter if your firmware is not stock:

| | default | what it is |
|---|---|---|
| `HELM_SONAR_SAMPLES` | 1800 | the firmware's `NUM_SAMPLES`. Serial only — a datagram says its own length |
| `HELM_SONAR_US` | 13.2 | microseconds per sample, the ADC period. ~1 cm of water there and back |
| `HELM_SONAR_C` | 1500 | metres per second through the water |
| `HELM_SONAR_BINS` | 256 | columns the picture is squeezed to before it crosses the wire |
| `HELM_SONAR_KEEP` | 600 | pings held. At ~10 Hz, a minute |

`US × C ÷ 2` is the metres each sample covers, and that number times a
ping's own sample count is the depth scale the app draws. At the
defaults a column reaches **17.8 m / 58 ft**.

### 250000 baud, and why `stty` cannot get there

Linux names 230400 and then jumps to 460800. **250000 is exactly in the
gap** — and it is the rate the Arduino world settled on because on a
16 MHz AVR it divides exactly: zero baud error, where 230400 comes out
3.5 % slow and drops bytes.

Reaching an unnamed rate needs the kernel's `BOTHER` flag and the
`termios2` ioctls. `stty` **cannot** do it — GNU coreutils maps a speed
through its own table of `Bxxxx` constants and refuses anything else
before it even opens the device:

```
$ stty -F /dev/ttyUSB0 250000
stty: invalid argument '250000'
```

Which is what this code shelled out to at first, under a comment
confidently asserting the opposite in both directions. The one
transport the only board has was the one it could not have opened, and
nothing would have said so until somebody was standing on a boat with
it. `netd` does it with `fcntl.ioctl` and a 44-byte struct now — still
stdlib, which is the rule this file lives by — and `tests/sonar_test.py`
reads three frames off a real pty to prove it, using sample bytes
(`0x0A`, `0x0D`, `0x11`, `0x13`) that a line discipline would eat if raw
mode were ever dropped.

### Which board have I got?

The USB-C socket says nothing — it is just a connector, and plenty of
UNO **R3** clones have one. What matters is the MCU and the USB-serial
bridge:

- **UNO R4 WiFi** — a red 12×8 LED matrix in the middle of the board.
  Renesas RA4M1, two serial outputs: binary over USB *and* UDP, with
  NMEA on SoftwareSerial pins 4/5 at 4800 baud. Announces its own
  depth, so `netd` keeps its hands off.
- **UNO R3, and R3 clones** — no matrix. One AVR USART wired to the USB
  bridge, so binary **or** NMEA, never both.
- The **Keyestudio 328 PLUS** is the second kind. Its bridge is a WCH
  **CH340C**, which the mainline `ch341` driver supports over "46 to
  3000000 bps", so 250000 is reachable and the board arrives as
  `/dev/ttyUSB0`.

> **Keyestudio's own documentation contradicts itself** across its
> similarly-named boards: KS0486 "PLUS Control Board" is ATMEGA328P-AU
> with a **CP2102**, while KS0546 "328 PLUS" is **ATMEGA328PB** with a
> CH340C — and one page gives the MCU as 328P while its own memory
> lines say 328PB. Settle it on the Pi rather than from a product page:
>
> ```sh
> lsusb          # 1a86:7523 → CH340   |   10c4:ea60 → CP2102
> ls /dev/ttyUSB* /dev/ttyACM*
> ```
>
> Either bridge appears as `ttyUSB*`, so the device path is the same
> answer either way.

**A 328PB has two USARTs — and it does not help.** The stock Arduino AVR
core has no 328PB entry at all (`boards.txt` contains zero occurrences
of `328pb`), so the board is built and flashed as a 328P and the second
USART is simply not addressable. One output, whichever chip is really
under the label.

**Nor does SoftwareSerial rescue it.** SoftwareSerial transmits by
bit-banging with interrupts off: 1.875 ms a byte at 4800 baud, so an
80-character NMEA sentence busy-waits about **167 ms with ~150 ms of
that interrupts-disabled**. The sampling loop runs at roughly 75 kHz.
Sending one depth sentence would blind the sounder for the length of
fifteen pings. That is why `netd` announces the depth and the board
does not.

### Which firmware is flashed?

In Signal K's admin, under Server → Data Connections, the baud rate of
whatever currently feeds depth:

| | |
|---|---|
| **9600** | `NMEA_DBT_OUT`. Depth works and **there is no echogram** — the line that would store a sample is commented out in the sketch. Reflashing is the only cure, and it takes the depth with it (see [One depth](#one-depth-and-who-measures-it)) |
| **4800** | the R4's NMEA pins. The echogram is alive, over UDP |
| **250000** | the raw binary, with something of yours translating it |
| a UDP connection | R4, raw, already on the network |

The two UNO R3 sketches differ in more than their output, and the
difference sets your depth range:

| | `TUSS4470_arduino` (raw) | `NMEA_DBT_OUT` |
|---|---|---|
| output | 1808-byte binary frames | `$SDDBT` ASCII |
| baud | 250000 | 9600 |
| `NUM_SAMPLES` | **1800** | **5224** |
| range | ~17.8 m / 58 ft | ~50 m |
| echogram | yes | **no** |

Both sample at 13.2 µs, which is 0.95 cm of water per sample — the
range is purely how many samples the sketch keeps. The raw firmware's
1800 is what `HELM_SONAR_SAMPLES` defaults to. Raise both together if
you want more water, and pay for it in ping rate: the board manages
about **9.4 pings a second** at 1800 samples and the bottleneck is the
serial link, so 5224 samples would be nearer 3.

## Squeezing 1800 into 256

By the **loudest** sample in each bucket, never the average.

An echo is a spike a few samples wide sitting in noise. Average a
bucket of seven and a real bottom return in one of them comes back a
seventh as bright — so the harder the squeeze, the fainter the only
thing the picture is for. The max keeps the bottom, and keeps a weed
line and a fish arch with it.

256 is a shade finer than the glass can draw (the echogram gets 660 px
of a 1080 round panel) and seven times fewer bytes than sending the
lot.

## Gain: measuring the transmit pulse rather than guessing it

Every column opens with the receiver still ringing from the ping it
just sent, reading near full scale whatever the water is doing. The
app auto-gains on the peak of the column — and a peak that includes the
transmit pulse is pinned at 255 for ever, which leaves the actual
bottom down in the dark end of the ramp.

The first attempt excluded a fixed fraction of the column. That is the
wrong shape, and it fails in both directions:

- **too short** and the pulse is still inside the window, so the gain
  stays pinned and the picture shows empty water over a bottom that is
  plainly there;
- **too long** and the app blinds itself in the shallows, which is
  where a sounder is most wanted.

How long the pulse rings belongs to the board and the transducer, so it
is **measured**: walk down the column while the samples are still hot,
start the gain window a little after that run gives out. Both failures
above are probes in `tests/sonar.mjs`.

There is deliberately **no ceiling** on that walk. One suggests itself
— the column saturated end to end by a transducer out of the water —
and it puts the fixed-fraction bug straight back for any board that
rings longer than the ceiling. The runaway it would prevent costs
nothing anyway: a column hot all the way down draws as a bright screen
under either rule.

What none of this can do is separate a bottom return that has **merged**
with the transmit pulse, in water shallow enough that the two arrive
together. That is the transducer's minimum depth, and it is physics.

## Colour

Day and dusk get a sounder's own ramp — near enough the one every
plotter has used since paper, because a skipper already knows how to
read it.

**Night does not.** The night theme exists to keep your eyes adapted,
and a hard yellow bottom return at two in the morning undoes twenty
minutes of that. Night stays in the red channel the whole way up — and
that last part was decided by rendering it. The transmit pulse is a bar
across the *full width* of the picture at full scale, so the ramp's top
end is not a highlight here, it is an **area**; area times brightness is
what costs you your dark adaptation, not peak alone. A top stop of
`(240,165,159)` put the brightest and largest thing on the screen at two
in the morning. It is `(255,96,86)` now — hotter in red, about half the
light.

A theme change **repaints the whole minute**, which is why the app keeps
the raw columns and not only the picture of them. On `auto` the switch
arrives by itself at sunset — the one moment the red ramp is for — and a
minute of daylight colours scrolling off afterwards is exactly the harm
it is meant to prevent. 600 columns of 256 bytes is 154 kB, which is
cheaper than being wrong.

The bottom pick is drawn over the ramp in a colour chosen to stay
legible against its bright end.

## The wire, netd → panel

`POST /sonar`, body `{"after": <the sequence you already hold>}`.
POST and not GET, for the reason `GET_OK` exists: a route added later is
POST-only until someone decides otherwise.

```json
{ "ok": true, "on": true, "seq": 2412, "bins": 256,
  "mps": 0.0099, "age": 0.1, "good": 2412, "bad": 0, "error": "",
  "pings": [ {"n": 2411, "t": 1763000000000, "idx": 1042,
              "ns": 1800, "temp": 18.4, "b": "<base64, 256 bytes>"} ] }
```

`after` is what keeps this cheap: a panel polling every 420 ms asks for
the four or five pings it has not seen rather than the six hundred it
has. A fresh app sends `0` and gets the whole ring, because the history
*is* the picture — an app that opened on the last few pings would show
a sliver and fill the rest over the following minute.

A sequence **ahead** of netd's means netd restarted under an open app
and the count began again; netd hands back the ring rather than
nothing, or the waterfall would sit frozen until the count climbed back
past where it had been.

## The app

The picture is a 600 × 256 offscreen canvas that **scrolls**: each new
ping shifts it one column left and paints the new column at the right
edge. Redrawing all six hundred columns per ping would be a hundred and
fifty thousand pixel writes for four new ones.

Now is at the **right**, with the minute of history growing back from
it, and only the columns that have actually arrived are drawn — a
picture that filled from the left would put the newest ping where your
eye goes last, and would shunt the whole minute sideways as it filled.

Four empty states, and not one, because a dark screen has four
different cures and only one of them can be applied from the cockpit:

| | |
|---|---|
| NO HELPER | netd is not answering |
| NO SOUNDER | `HELM_SONAR` is not set |
| SOUNDER ERROR | netd is configured and cannot open the device |
| WAITING FOR THE BOARD | open, and nothing has arrived yet |
| SILENT FOR *n* S | it was pinging and has stopped — which a frozen picture would not say |

Closing the app zeroes **both** canvases. The offscreen is the one
nothing else holds a handle on, and a canvas keeps its backing store
until its dimensions are set to zero however detached it is.

## Still open

- The gain is a straight divide by the running peak with a noise floor
  under it. No noise-floor *subtraction*, because that would mean
  guessing at the shape of noise nobody here has seen yet. First
  contact with real water is what should decide it.
- `HELM_SONAR_C` is fixed at 1500 m/s. The frame carries a temperature,
  so the day a percent matters, that is the number to refine with.
- Nothing is recorded. The ring is a minute and then it is gone.
