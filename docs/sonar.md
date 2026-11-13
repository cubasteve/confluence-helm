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

## Two numbers, one of them deliberately not computed

netd could work out a depth. It has the firmware's own bottom pick and
the sample rate, and `idx × SAMPLE_TIME × c / 2` is the whole of it.

It does not, and that is the main design decision on this page. The
depth is already on the Signal K bus. A second one, off the same
transducer by another route, would disagree with the first by a few
centimetres and some fraction of a second — and then there would be two
depths on one boat and nothing to say which one the shallow alarm was
ringing about.

So the split is:

| | comes from | shown as |
|---|---|---|
| the number | Signal K | the big figure at the top, and the dial, and the alarm |
| the picture | netd | the waterfall |
| the bottom pick | netd, as a **sample index** | a line drawn *on* the picture |

The pick stays an index on purpose. In that form it is in the same
coordinate system as the samples it is drawn over, so it lands exactly
on the echo it refers to. Converted to metres it would be a second
depth wearing a disguise.

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

The serial path sets the line speed with `stty`, because 250000 is not
one of termios' named rates and the Python standard library has no way
to ask for one that is not.

### Which board have I got?

The two things to look at, neither of which needs a terminal:

- **UNO R4 WiFi** — USB-**C**, and a red 12×8 LED matrix in the middle.
  Streams the binary frames over USB *and* UDP, and emits NMEA on
  SoftwareSerial pins 4/5 at 4800 baud — **not** over USB.
- **UNO R3** — the big square USB-**B** printer plug, no matrix. Binary
  over USB serial at 250000 baud only; no WiFi, no NMEA.

And in Signal K's admin, under Server → Connections, the baud rate of
whatever is feeding depth says which sketch is flashed:

| | |
|---|---|
| **9600** | the `NMEA_DBT_OUT` sketch. Depth works and **there is no echogram**: that sketch never stores the samples. Reflashing is the only cure |
| **4800** | the R4's NMEA pins. The echogram is alive, over UDP |
| **250000** | the raw binary, with something of yours translating it |
| a UDP connection | R4, raw, already on the network |

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
