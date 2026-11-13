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
HELM_SONAR_NMEA=udp:10111         # where to send it
HELM_SONAR_NMEA_HZ=2              # how often (default 2)
HELM_SONAR_KEEL=0.6               # metres from transducer face to keel bottom
```

It goes out as **NMEA 0183 over UDP**, which is what everything else on
a boat already speaks — Signal K, AvNav and OpenCPN all ingest it — so
nothing downstream needs changing. 10110 is the registered port for
NMEA 0183 over IP — but **use 10111**: Signal K's own NMEA-0183 *output*
server listens on 10110, and two things named the same on one machine
is a debugging session nobody needs.

In Signal K that is one connection, with two fields:

> **Server → Data Connections → Add**
> Data Type **NMEA 0183**, NMEA 0183 Source **udp**, Port **10111**,
> **Validate checksum** on, **Append checksum** off (netd appends its
> own).

Give the connection an `id` you will recognise and keep it stable —
it becomes the base of `$source`, so with talker `SD` the Data Browser
will show something like `open-echo.SD`, and source-priority rules
reference it.

A malformed sentence is **dropped silently** with nothing logged
anywhere, because `validateChecksum` defaults on. Get it right once
and confirm in the Data Browser rather than assuming.

Signal K's UDP listener calls `bind()` with no address, so **the port
is open on every interface**, boat WiFi included, and anything on the
LAN can inject a depth. netd sends to loopback by default; close the
other side too:

```sh
sudo nft add rule inet filter input iifname != "lo" udp dport 10111 drop
```

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

### No detection is announced, not kept quiet

A ping reporting index **zero** has not found a bottom; one reporting
the **last sample** searched to the end of its window and gave up
there. Both are excluded from the median — announcing nought metres of
water to a shallow alarm is the worst lie available here.

But silence is the wrong way to say so, and getting this wrong was the
real bug:

> **The failure that matters is not a dead port. It is a live link
> with no echo** — a fouled transducer, air under the hull pounding
> upwind, a planing hull lifting the transducer clear — where perfect
> frames keep arriving and every one of them reports nothing found.

Stay quiet through that and the last good depth sits on the glass
looking current, which most displays will show without comment. So
netd says it out loud, as a DPT with an **empty depth field**, which
the parser turns into `null`:

```
$SDDPT,,-0.60,
```

DPT alone in that case. An empty `DBT` was never checked against the
parser, and guessing is how a null quietly becomes a zero.

Nothing arriving **at all** is different and gets nothing: that means
the reader has stopped, which is not this layer's to announce — the
staleness rules downstream say it better, and the panel drops a
reading after 8 s.

Worth adding downstream: a notification when depth has been null for
N seconds. A sounder that has lost the bottom and says so is only
useful if something is listening for it.

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
| `HELM_SONAR_US` | 13.2 | microseconds per sample, the ADC period |
| `HELM_SONAR_C` | 1500 | metres per second through the water |
| `HELM_SONAR_MPS` | *(from the two above)* | metres per sample, set directly — **measure this** |
| `HELM_SONAR_OFFSET` | 0 | metres added after scaling |
| `HELM_SONAR_BINS` | 256 | columns the picture is squeezed to before it crosses the wire |
| `HELM_SONAR_KEEP` | 600 | pings held. At ~10 Hz, a minute |

`US × C ÷ 2` is the metres each sample covers, and that number times a
ping's own sample count is the depth scale the app draws. At the
defaults a column reaches **17.8 m / 58 ft**.

### Don't trust either constant — measure the product

The project does not agree with itself about either of them:

| | |
|---|---|
| sample period | comments and `echo_interface.py` say **13.2 µs**; the NMEA sketch's code says **13.0**; and the ADC setup (prescaler 16 → 1 MHz ADC clock, 13 clocks per free-running conversion) implies **13.0 exactly** |
| speed of sound | `echo_interface.py` uses **1440**, the NMEA sketch **1450**, fresh water at 15–20 °C is **1450–1460**, seawater about **1500** |

Together that is a **±4 % systematic scale error — 60 cm at 15 m**:

| | 13.0 µs / 1450 m/s | 13.2 µs / 1500 m/s |
|---|---|---|
| per sample | 9.4 mm | 9.9 mm |
| full scale (1800) | 16.96 m | 17.82 m |

They are only ever used as their **product**, so don't pick a side —
fit it. Take a leadline reading at two depths, say 3 m and 12 m, and
solve `depth = MPS × index + OFFSET`. Keep **both** coefficients:
`MPS` absorbs the whole `US × C ÷ 2` product as one number, and
`OFFSET` catches the fixed index error from ring-down delay and
comparator latency — which the R4's firmware has a `DEPTH_OFFSET` for
and the **R3's has no parameter for at all**.

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

That 5224 is misleading and I repeated it before checking: **the NMEA
sketch never allocates it.** The line that would store a sample is
commented out, so the array is garbage-collected by the linker and the
sketch reaches 50 m by *counting* samples without keeping any.

The raw firmware has to keep them, and that is the wall:

> 1800 samples is a **1808-byte** frame struct in a 328P's **2048
> bytes** of SRAM, plus 64 + 64 bytes of serial ring buffer = 1936.
> About 112 bytes are left for the stack.

So **~17.8 m / 58 ft is the ceiling for the echogram on this board**,
full stop — not a default to raise. Below the window you get no
detection rather than a wrong number. More range means either slowing
the sample loop (the host script has a commented-out 52.2 µs option
reaching ~70 m, at four times worse resolution and nearly four times
the acquisition time) or an UNO R4, which has room for ~12000 samples.

If you anchor in 3–8 m and sail over 40, this instrument is useful for
one of those and blind in the other. Worth knowing which problem you
are solving before reflashing.

### The blind zone is the thing to check first

The sketch has `BLINDZONE_SAMPLE_END = 450`, which at 0.95 cm a sample
is about **4.2–4.5 m**. If it does what the name says — ignore returns
before that sample — the sounder is blind in exactly the water where
depth matters: anchorages, marina approaches, every grounding.

This is inferred from the constant's name; the research never got to
the code that consumes it. **Read the sketch before trusting shallow
water to this**, and if it is what it looks like, lowering it is the
first firmware change to make — then check the transducer's own
ring-down does not false-trigger the comparator at short range, which
is what the blanking is there for. Bench-test alongside at a known
depth.

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

## Four things on the Pi that each cost an afternoon

**`brltty` eats the port.** On Debian-derived images it has a udev rule
claiming `1a86:7523` — the CH340's own VID:PID. The symptom is
`ttyUSB0` appearing and then vanishing about a second later.

```sh
dmesg | grep -i ch341
systemctl status brltty        # remove it, or mask its udev rule
```

**ModemManager probes new serial ports with AT commands.** If the board
has the DTR→reset capacitor wired, that resets it and injects garbage
into your first frames. Tell it to leave the device alone with a udev
rule setting `ENV{ID_MM_DEVICE_IGNORE}="1"`.

**`ttyUSB0` moves** the moment you plug in another USB serial device.
Use a stable path — and prefer **`by-path`** over `by-id` here, because
CH340C parts ship with no USB serial number, so the `by-id` name is
generic (`usb-1a86_USB_Serial-if00-port0`) and collides with the next
CH340 you own. `by-path` is tied to the physical socket, which on a
boat is what you actually mean.

```sh
ls -l /dev/serial/by-path/
HELM_SONAR=serial:/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.2:1.0-port0:250000
```

**Two programs on one port is silent.** Linux does not make a `ttyUSB`
exclusive by itself, so an Arduino IDE serial monitor left open takes a
random half of the bytes and neither side is told — it arrives as
checksum failures and resyncs that look exactly like a bad cable. netd
sets `TIOCEXCL` now, so the second opener gets `EBUSY` and knows. (Not
against root, which the kernel exempts; netd runs as the desktop user.)

And one that costs a board rather than an afternoon: **do not Burn
Bootloader, and do not use an ISP programmer**, until you know which
chip you have. If it is a 328PB, avrdude's signature check fails
(`m328p` is 1E 95 0F, `m328pb` is 1E 95 16) and you can brick a working
board fixing a problem you do not have. Ordinary serial uploads work
either way, because Optiboot reports a hardcoded signature.

## The analog chain, which fails silently

Worth knowing before blaming software for a grassy picture:

- The shield's front end is tuned by **solder jumpers** (presets for
  40/150/200/600 kHz), and the firmware's `FILTER_FREQUENCY_REGISTER`
  has to be matched to them **by hand**. A mismatch gives a
  plausible-looking echogram with useless signal-to-noise and no error
  anywhere.
- The project's >50 m results used a 150 kHz in-hull transducer driven
  at **15–20 V from a boost converter**, not from the Arduino's 5 V
  rail. Keep the transducer drive off the Arduino supply.
- Keyestudio publishes no schematic and no regulator part, and
  specifies 150 mA on the 3.3 V rail against a real UNO R3's 50 mA —
  a different power design, with `AREF` never mentioned on either
  page. The shield feeds an analog envelope into A0, so a noisy 5 V
  rail reads directly as a noise floor, which is to say as false
  bottoms. If it looks grassy, suspect the board before the shield.
- **There is no flow control.** The firmware blocks ~72 ms writing each
  frame and the CH340 link has no handshaking. If the Pi stops draining
  the port, bytes are simply lost — truncated frames and resyncs, not
  back-pressure. If checksum failures track Pi load, that is why.

## Still open

Unresolved, and said plainly rather than smoothed over:

- **Which chip is actually on the board.** Keyestudio's two pages
  contradict each other and one contradicts itself. It changes nothing
  about the firmware (either part builds and runs as "Arduino Uno"),
  but it decides whether a second UART exists and whether an ISP
  programmer is safe. `lsusb` settles the bridge; the TQFP marking
  settles the MCU.
- **`BLINDZONE_SAMPLE_END` semantics are inferred from the name**, and
  it is the single most consequential unknown for shallow water.
- **250000 baud has not been tested on this CH340C.** The arithmetic is
  exact on both sides — UBRR 7 with U2X on an AVR, and the ch341 driver
  derives ps=3/div=24 from its 48 MHz clock for exactly 250000 — but
  the bridge runs off an internal oscillator with no crystal and WCH
  does not enumerate 250000. Judge it by checksum pass rate, not by
  arithmetic.
- **Nothing here has been compiled.** No AVR toolchain was available,
  so "it builds" is expected rather than demonstrated.
- The shield facts are for **revision 002**; a revision with an onboard
  boost converter is said to be coming.

And in this repo:

- The gain is a straight divide by the running peak with a noise floor
  under it. No noise-floor *subtraction*, because that would mean
  guessing at the shape of noise nobody here has seen yet. First
  contact with real water is what should decide it.
- The frame carries a temperature and nothing uses it. The day the
  speed of sound matters to a percent, that is the number to refine
  `HELM_SONAR_MPS` with.
- Nothing is recorded. The ring is a minute and then it is gone.
