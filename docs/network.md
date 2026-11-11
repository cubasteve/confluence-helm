# Network

WiFi, the hotspot, and the local helper that drives both from the panel.

[← back to the README](../README.md)

## Connectivity

A row of radios sits at the top of the control panel. No words on them -
the state is the icon:

| | |
|---|---|
| arcs, filled to signal | a client adapter, joined to something |
| a base station with waves | this adapter **is** the hotspot |
| a small mast beside the glyph | it is the USB dongle, not the onboard radio |
| a slash through it | the adapter is down |
| accent ring | up; grey ring, faded: down |

Tapping one opens a picker: scan, join, forget, pair, connect, and a switch
for that adapter. The picker is the only place the adapters are named in
words - `BUILT-IN · wlan0`, `USB ADAPTER · wlan1`.

**It is a pop-out over the panel, not a page in front of it.** A 640 px
card on a scrim that dims what is behind, the same shape the start time
pad takes. It was an opaque sheet filling the glass, which meant picking
a network hid the panel you were picking it from, and the whole face
went somewhere else for the ten seconds a scan takes. A tap on the scrim
puts it away, as `DONE` does.

**The list scrolls rather than pages.** It was four rows behind an up and
a down arrow — the right answer for a full page with room for the
arrows, and two controls more than a card this size can spare. Every
network is rendered and the box scrolls, hidden bar and faded edge like
every other list here, driven from pointer events because nothing under
`#stage` scrolls itself. The window stays a fixed four rows for the
reason it always was: a scan that returns a different count every few
seconds must not make the card breathe in and out under your hand.

The count moved in beside `SCAN` and `DONE`, which is one row where
there were two, and it says how many there are — `9 NETWORKS` — rather
than which page of them you are on. Rows are 92 px rather than 112: the
box is smaller, so the things in it are too.

**One button per adapter, not one for "WiFi".** This boat has two radios
with opposite jobs: the onboard one runs the hotspot everything aboard is
joined to, and the dongle reaches out to a marina. A single switch cannot
say that, and a single switch that turned both off at once would take the
boat's own network down as a side effect.

Onboard comes first, then USB. That order has to survive a reboot, so
`netd.py` keys it off the bus - `/sys/class/net/<dev>/device` - and not off
`wlan0`/`wlan1`, which can swap.

A browser can do none of this. There is no web API for WiFi at all, and
`navigator.bluetooth` pairs a device to the *page*, which is a different
thing from pairing it to the Pi. So the buttons talk to `netd.py`, a
stdlib-only service that shells out to `nmcli` and `bluetoothctl`.

```
panel  ->  http://127.0.0.1:8091  ->  nmcli / bluetoothctl
```

### The hotspot is load-bearing

Anything that would take a hotspot adapter down needs a second, deliberate
tap - joining another network on it, or switching it off. The picker says
`TAP AGAIN · THIS DROPS THE HOTSPOT` and forgets it after six seconds.

That is not politeness. Every phone, tablet and laptop aboard is on that
hotspot, quite possibly including the one you would use to put it back. For
the same reason the running hotspot's row has no ✕: forgetting it deletes
the profile the boat runs on.

An adapter is detected as a hotspot when its profile says
`802-11-wireless.mode: ap` **or** `ipv4.method: shared`. Images differ on
which they set, so either counts.

### The hotspot comes up by itself

The boat's own network is on the **onboard** radio, and it has to be up
before anything else aboard can do anything — including reaching the
panel to turn it on. It was not coming up on its own, and the reason was
two settings that had simply never been set.

| | |
|---|---|
| `connection.autoconnect` | what NetworkManager reads at boot. A profile made with `nmcli device wifi hotspot` does not have it, and nor does one that has been through a `device disconnect`. Without it the hotspot came up only when somebody tapped it up on the panel — which is reached over the hotspot. |
| `802-11-wireless.mac-address` | **which radio** it comes up on. Left open, NM is free to take the dongle, whose whole job is the opposite one: reaching out to a marina. Pinned by MAC and not by `wlan0`, because those swap between boots — the same reason the tile order is keyed off the bus. |

`hotspot_pin()` sets both at netd startup and says what it did on the
`[netd] hotspot:` line. It is deliberately narrow: it never creates a
hotspot and never decides which profile is one. It acts only on a profile
`con_is_ap()` already recognises, refuses outright if there is more than
one, and will not move a pin somebody else has set — it says so and
leaves it.

### The dongle that enumerates and never appears

The boat's USB adapter is a Realtek **RTL8188EU** (`0bda:8179`) on the
in-kernel `rtl8xxxu` driver, and `wifi-report.sh` caught it in the act:

```
usb 1-1.4: Product: 802.11n NIC    Manufacturer: Realtek
usb 1-1.4: rtl8xxxu: Loading firmware rtlwifi/rtl8188eufw.bin
usb 1-1.4: Firmware revision 28.0 (signature 0x88e1)
usb 1-1.4: rtl8xxxu_writeN: Failed to write block at addr: 1e80 size: 0080
```

It enumerates, binds, loads firmware, reports its revision — and then
fails a register write partway through init and **never creates a
network interface**. Which is the first row of the table below: the
kernel does not have it, so nothing above the driver can help, and the
panel had nothing to show because there was genuinely no adapter.

Not power, not the cable, not range, and nothing in NetworkManager. The
in-kernel support for this chip is simply unreliable: the old `r8188eu`
staging driver was removed and `rtl8xxxu` inherited the chip without
inheriting its reliability.

**`boot/dongle-rescue.sh` is the answer that costs nothing.** The init is
not impossible, it is unreliable — *sometimes* the adapter shows up — so
unbinding the device from its driver and binding it again runs init
afresh, and a few goes gets there. No package, no DKMS, no out-of-tree
module to rebuild on the next kernel, which is the whole argument for
doing it this way.

Three things in it are not obvious, and all three were measured on the
water:

**The device can have no driver at all.** This is the one that cost a
round trip. The first version looked only for USB *interfaces* bound to
a known wifi driver — and with `rtl8xxxu` having failed, the device sat
there with no driver symlink anywhere, so the script found nothing and
reported `no USB wifi adapter is plugged in` about a dongle that was
plugged in. There is nothing to unbind an interface *from* in that
state, so the whole USB device is reset through the `usb` driver
instead, by device name (`1-1.4`, not `1-1.4:1.0`), and every driver
re-probes it. Recognised by `idVendor:idProduct` rather than by what is
bound, because nothing is.

And when it still matches nothing, it **names every USB device on the
bus** in the log rather than saying "nothing plugged in" and stopping —
so the journal itself says which id belongs in `is_wifi_id()`.


**An interface existing is not success.** The first rebind created
`wlan1` and the adapter still would not come up; a second was what made
it work. A half-initialised device can present an interface that cannot
be brought up, so the test is that the interface goes **up** — a script
stopping at the first `wlanN` hands you a dead row on the panel and
calls it done.

**It never touches a working adapter, and never touches the link at
all.** That is what makes it safe on a timer, which is what
`install-dongle-rescue.sh` sets up: at boot and every five minutes,
because the adapter can go away mid-voyage too, with nobody at the chart
table to notice.

The readiness test used to begin `ip link set <dev> up`, which was wrong
twice over and both ways are worth remembering:

- **It fought the panel.** Bringing the link up is a side effect, and the
  helm's own per-adapter switch turns an adapter off *deliberately* —
  netd uses `nmcli device disconnect` precisely so one radio can be down
  while the other stays up. On a five-minute timer this quietly put it
  back up again, for ever.
- **It called a healthy adapter dead.** `ip link set up` fails with
  *"Operation not possible due to RF-kill"* whenever the radio is soft
  blocked — the Raspberry Pi OS default until a country is set, and what
  `nmcli radio wifi off` does. rfkill is **global** on this hardware
  (netd's `wifi_powered()` says so, and it is why the panel's switch
  avoids it), so one soft block made *every* adapter look dead and the
  timer rebound a working dongle seven times every five minutes. A
  rebind re-runs an init that is known to be flaky, so that is a machine
  for turning working into broken — worse than doing nothing.

It asks nl80211 instead (`iw dev <dev> info`) and leaves up and down to
the panel. With no `iw` installed it falls back to "an interface exists",
because looping on a question it cannot put is the same failure wearing
a different coat.

### And then it was blind to the case it exists for

Backing off to `iw dev info` traded one failure for another, and the
boat found it: *"I do see it. When I try to turn it on, it doesn't turn
on."* `rtl8xxxu` enumerates the device, fails its register write, and
leaves behind a `wlan1` that answers `iw dev info` perfectly well and
that NetworkManager will never use. The rescue looked at a dead adapter,
called it healthy, and went back to sleep — every five minutes, for ever.

The discriminator is **rfkill, not the link**, which is the whole reason
the earlier version was dangerous:

| what sysfs and nmcli say | what it means | what the rescue does |
|---|---|---|
| `rfkill soft` or `hard` = 1 | somebody turned the radio off | nothing |
| state `disconnected` | idle — what the panel's own off switch leaves | nothing |
| state `unmanaged` | one command away, and the panel's switch *is* that command (`device set managed yes`) | names it in the journal |
| state `unavailable` or `failed`, not blocked | the driver enumerated it and gave up | resets it |

Blocked is never broken, so the switch is never fought — and `blocked()`
reads `/sys/class/net/<dev>/phy80211/rfkill*/{soft,hard}` directly, so it
needs neither the `rfkill` binary nor root. With no `nmcli` on the PATH
it falls back to the weaker question again, for the same reason as above.

**And the journal is honest.** Every sysfs write was `> file 2>/dev/null`
with no test, so a run that could not write a thing logged
`rebinding (try 1 … 7)` and read exactly like one that was trying. Each
write is checked and says which way it failed. A run killed partway also
restores anything it unbound, so one interrupted run cannot leave the
adapter in the single state this script cannot see.

### What is actually wrong with this dongle

Worth writing down, because almost everything on the internet about the
RTL8188EU is about a choice that does not exist here.

`rtl8xxxu_writeN: Failed to write block at addr: 1e80` is **not** a
register problem, and `1e80` carries no meaning. `REG_FW_START_ADDRESS`
is `0x1000` and `rtl8xxxu_writeN()` walks the address up one block at a
time, so `0x1e80` is byte 3712 of a 4096-byte firmware page — chunk 29
of 32. Reports of this failure name addresses all over that range
(`1000`, `1080`, `1100`, `1280`, `1500`, `1680`, `1c80`, `1e80`), which
is the giveaway: it is a **transient failure of one USB control
transfer**, status −71 / `EPROTO`. Do not go hunting for that `-71` in the log, though: the
in-tree driver never prints the `usb_control_msg` return value, so its
absence proves nothing. It was identified upstream, not locally. The driver converts it to `-EAGAIN`,
nothing retries, and probe dies with `error -11`.

The `size:` field is the interesting one. `size: 0080` is 128 bytes —
the block size upstream raised to 196 (`00c4`) in **6.14**, because a
reporter proved 128 loses this race and 196 does not. **6.15** then
wrapped the whole download in a six-attempt retry loop. The Raspberry Pi
kernel on this box (`rpi-6.6.y`) has **neither**, so one unlucky
`EPROTO` is fatal to probe and every fresh probe is an independent coin
flip. That is exactly why a rebind "worked on the second attempt".

Two consequences worth holding on to:

- **It is not power, and not a dying chip.** Inserting a 5 ms delay
  before the first write makes it load every time; so does the 196-byte
  block size. Neither of those fixes a power problem. That is the
  general argument, and it is worth distrusting on a boat — a 12 V-to-5 V
  supply is exactly where a Pi 4's rail sags, and none of the reports
  behind it were on one. So the script reads `vcgencmd get_throttled`
  and prints it rather than asserting. On this box it reads `0x0`.

  **But do not read more into that than it says.** `0x0` means the Pi's
  own **5 V input** never sagged past threshold since boot (bit 0 is
  now, bit 16 is since boot). It says nothing about a droop across a USB
  connector, a thin extension lead or a corroded contact — which is
  exactly where this class of fault lives. There is no per-port USB
  current telemetry on a Pi 4 at all, and its downstream USB budget is
  about **1.1 A shared across all four sockets**, not per socket.
  `bMaxPower` in the topology dump is a *declared* descriptor figure,
  not a measurement. Port choice is
  worth trying because it is free, not because it is known to work: all
  four of the Pi 4's type-A ports hang off the one VL805 controller, so
  moving between them changes the port and the speed but not the
  controller. The detailed reports do have the dongle sharing a bus with
  something busy, which is suggestive and no more.
- **There is no fallback driver and no choice to make.** Mainline
  deleted `drivers/staging/r8188eu` and taught `rtl8xxxu` this chip in
  the *same* release, 6.3. Every RPi branch that still carries
  `r8188eu` (5.10, 6.1) has an `rtl8xxxu` that does not claim
  `0bda:8179`; every branch that claims it (6.6, 6.12, 6.18) has no
  `r8188eu` at all. Debian packages none of it. `rtl8xxxu` is the right
  driver, not the consolation prize.

The permanent fix is a kernel: `rpi-6.12.y` carries the retry loop
(survives the race), `rpi-6.18.y` also carries the 196-byte block size
(removes it).

### The timer and the hammer

`dongle-rescue.sh` is the **timer**. It runs unattended every five
minutes and must never yank an adapter that is working, so it asks one
question and leaves if the answer is good. That timidity is a feature
right up until the adapter is in a state where the question has the
wrong answer — and then it is useless, silently: the loop breaks on try
1, and the log line for try 1 is suppressed, so running it by hand
prints *nothing at all* and changes *nothing at all*. Reported from the
boat as "the dongle rescue is not working", which is exactly what it
looks like.

`dongle-fix.sh` is the **hammer**, and it is run by a person:

```
sudo bash boot/dongle-fix.sh --look    # diagnose, change nothing
sudo bash boot/dongle-fix.sh           # diagnose, then act
```

It prints the full state first — which USB device, which driver if any,
the interface, the rfkill bits, nmcli's STATE **and** REASON, whether
`r8188eu` could even exist here, the kernel's own complaints, the power
picture — and then reads a **verdict** out of the log, because the two
failures live on opposite sides of `probe()` and want opposite
treatments:

| state | what it means | what it does |
|---|---|---|
| no interface, and the last thing in the log was `probe of … failed with error -11` | the firmware upload lost its race; there is no driver state to fix | rolls the dice again — 20 fresh device resets, which is upstream's own 6.15 retry loop supplied from userspace |
| an interface exists | the chip is fine, whatever is in the log; resetting it brings it back identical | works above the driver: hand it back to NM, rebind, and surface the MAC-randomisation remedy |

**dmesg is a ring buffer, not a status register**, and the first version
of that verdict forgot it. A bare `grep -q` for the failure found a
stale `-11` from an hour earlier and announced a failed firmware upload
about a `wlan1` sitting in `connected`. Caught on the boat, in the
script's own `--look` output.

That is not cosmetic. `fwrace` sends the ladder into twenty USB resets,
and doing that to a working adapter is precisely the harm the rfkill
guard exists to prevent — arriving through a different door. The rule
that settles it cannot be argued with: **an interface existing proves
this incarnation's firmware push succeeded**, because the push happens
inside `rtl8xxxu_init_device()` and `ieee80211_register_hw()` runs only
after it returns. "Failed to write block" and "I can see wlan1" cannot
both describe the same incarnation. Failing that, the verdict goes by
whichever of the two lines came *last* in the buffer. The block size is
read off the live failure only, for the same reason.

That second remedy is **printed, not applied** by `dongle-fix.sh` — a
reset is transient and an edit under `/etc` is not. It has an installer
of its own.

### Scan-time MAC randomisation — already done, and a dead end

```
bash boot/check-wifi-mac.sh      # read-only; writes nothing
```

This started as an installer that wrote
`wifi.scan-rand-mac-address=no` into `/etc/NetworkManager/conf.d/`. It
was a no-op, and finding that out killed the theory behind it.

**Raspberry Pi does not ship Debian's `network-manager`.** It ships its
own rebuild, and the only thing the rebuild changes is this. Verified
against the actual arm64 package rather than docs — `network-manager
1.42.4-1+rpt1+deb12u1`, whose changelog reads, in full:

```
  * NetworkManager.conf: disable MAC randomization feature
 -- Serge Schneider <serge@raspberrypi.com>  Mon, 07 Apr 2025 13:28:21 +0100
```

The binary ships `/etc/NetworkManager/NetworkManager.conf` as a dpkg
**conffile**, and it is:

```ini
[main]
plugins=ifupdown,keyfile

[ifupdown]
managed=false

[device]
wifi.scan-rand-mac-address=no
```

A bare `[device]` section, so it covers every radio, and it has been
there since the image was built. Two things follow.

**It was already off while the dongle was failing, so it cannot have
been the cause.** The mechanism was never silly — setting a wifi MAC
means taking the interface administratively down and back up (because
`wpa_supplicant` needs that to notice), and NM does it every five
minutes to any device that is not associated, which is real USB churn
on an adapter already struggling. It just was not happening here. Keep
looking.

**And layering another file on top would have been worse than
useless.** Every config file merges into **one** keyfile, group by
group, so a second bare `[device]` section merges into the distro's.
Today that writes the same key with the same value and changes nothing
— but it leaves a section sitting there that anyone adding a
`match-device` to would silently *narrow* the distro's global setting,
re-enabling five-minutely down/up MAC churn on the radio carrying the
hotspot. Meanwhile a `conf.d` file NetworkManager cannot parse is fatal
at **startup**, not at reload: `read_config()` returns FALSE on any
key-file error and `main.c` prints `Failed to read configuration` and
`exit(1)`. No hotspot, no SSH, at the next power cycle.

So the script writes nothing. What it does is report where the setting
comes from, what the *merged* config says (via `NetworkManager
--print-config`, which reads from disk through the same path the daemon
uses and is safe beside a running one), and whether the conffile still
matches the shipped original — a conffile survives upgrades, so it can
have been edited. If randomisation really is on, the advice is to
restore the distro file, not to layer over it.

It distinguishes **unknown** from **on**: without the `NetworkManager`
binary it cannot see precedence, and saying "it is on" would send
someone reinstalling a package over the very link that may be at fault.

`tests/wifimac_test.py` — 9 tests, including that the md5 constant still
matches the real package and that the script modifies nothing anywhere
under `/etc`. Four controls run: wrong md5, guess when it cannot merge,
treat a missing setting as neutral, or write a file after all.

`tests/dongle_test.py` drives it against a pretend `/sys` with pretend
`ip`, `iw` and `nmcli` on the PATH — a script whose job is to yank the boat's
network adapter is not one to ship unexercised. It holds it to all of
the above, including that an unknown driver is left alone: a rebind is a
real interruption, not something to try on the off chance.

### Three ways a radio goes missing, and telling them apart

"The radio didn't show up" looks the same from the helm whichever of
these it is, and they have nothing in common but the symptom:

| what is true | what fixes it |
|---|---|
| the kernel doesn't have it | a cable, a power budget, a driver — nothing above this line can help |
| the kernel has it, NM doesn't report it | the stack above the hardware |
| NM has it, unmanaged | one command, and the panel's switch **is** that command |

`kernel_wifi()` reads `/sys/class/net` directly — a netdev is wifi if it
has a `phy80211` link or a `wireless` directory — and `wifi_status()`
returns the difference as **`unseen`**: adapters the kernel has that NM
is not reporting. Normally empty. When it isn't, the missing row has an
answer instead of a shrug. netd also prints both lists at startup:

```
[netd] wifi adapters: kernel has wlan0, wlan1, NetworkManager reports wlan0   NOT REPORTED: wlan1
```

**`wifi-report.sh`** puts all three rows of that table on one screen,
plus the USB lines from this boot, NetworkManager's last ten minutes and
the power-saving state of each adapter. Read-only, changes nothing, and
meant to be run over SSH from a phone on the hotspot:

```
bash ~/helm/wifi-report.sh
```

### An adapter NetworkManager has not adopted is still an adapter

A USB dongle that enumerates *after* NetworkManager has started is left
`unmanaged`, which is most boots. Those used to be filtered out of the
device list, so the panel showed nothing at all — and "the radio doesn't
show up" was the whole of what there was to go on, for a dongle that was
plugged in, enumerated, and one command away from working.

They are on the list now, reading as down. The switch's first act is
`device set <dev> managed yes`, so turning it on is what adopts it. The
command that fixes it was always the one behind the switch you could not
see.

### The switch turns the radio on; it does not join anything

The per-adapter switch is `device disconnect` / `device connect` rather
than rfkill, because rfkill is global on this hardware — one adapter off
that way takes the other down with it, and on a boat the other one is
often the hotspot everything else is talking over.

That pairing was wrong in both directions.

**`device connect` is not "on".** It asks NetworkManager to *activate*
something on the adapter. With nothing saved and in range it has nothing
to pick, and answers:

```
Error: Failed to add/activate new connection: 802-11-wireless setting
is required if no AP path was given.
```

Seventy characters of NetworkManager internals landing on a tile two
words wide, in answer to someone tapping a switch — and the switch
reported failure, so an adapter that was merely idle looked dead. That
sentence is `NOTHING TO JOIN` now, and the switch no longer treats it as
a failure at all: the radio is on either way, and the list underneath is
where you pick a network.

**`device disconnect` is more than "off".** It also tells NM to stop
autoconnecting on that device, and nothing lifts that on its own. So an
adapter switched off here — or dropped when a hotspot went away — stayed
down, whatever the list underneath was offering. Turning it on now does
`device set <dev> managed yes autoconnect yes` **first**; that is the half
that actually switches the radio back on, and it was missing.

### A name is not a handle

`nmcli` writes its output in the locale's charset and substitutes `?` for
anything it cannot spell. A Pi that comes up without a locale — which is
the normal case under a bare autostart session — is therefore handed
ASCII, and an iPhone hotspot comes back wrong: iOS names them with a
**curly apostrophe**, so `Steven’s iPhone` reaches the panel as
`Steven?s iPhone`.

That is not only a smudge on a label. The panel sends the name it was
given straight back, so the row it is showing you is one NetworkManager
has never heard of. Joining it fails. Tapping its ✕ fails with
`Error: unknown connection 'Steven?s iPhone'`, and there is nothing on the
glass that can ever delete it, because the real character was gone before
netd saw it.

Two things close that off:

- **`run()` forces `LC_ALL=C.UTF-8` on every child.** The charset is the
  actual fix. The language is a second gain that was always a latent bug:
  `wifi_error()` reads nmcli's failures in English, and on a Pi set to
  anything else none of them would have matched.
- **Anything that acts on a connection goes by `uuid`.** `wifi_uuid()`
  resolves a name once, and `connection up` and `connection delete` take
  the uuid. Names are for reading.

A panel already carrying a mangled row still has to be able to lose it, so
`wifi_uuid()` falls back to treating `?` as any single character — and only
when that picks out exactly one profile. Two hotspots differing at that one
position is a coin toss, and deleting the wrong one is worse than refusing.
nmcli substitutes one `?` per character, so the wildcard matches a character
that was *replaced*, never one that is missing.

### Three decisions worth knowing

**Loopback.** `netd.py` binds `127.0.0.1`, so only Chromium on the Pi can
reach it. A phone loading the same page over boat WiFi resolves that
address to itself, finds nothing, and the app leaves the row empty - no
dead buttons, and nothing to explain. That is the access control: no guest
on the boat network can re-point the boat's networking. There is no auth in
the service because the socket makes it unnecessary; if you ever bind it
wider, that stops being true.

**The desktop session, not systemd.** NetworkManager's polkit rules grant a
local *active session* the right to change networking without a password.
Started from `~/.config/autostart/` it inherits that. The same script under
a systemd unit is an inactive session and gets refused - which looks
exactly like a broken WiFi driver and is not. The same applies to running
it by hand over SSH: reads work, joins may come back `NOT PERMITTED`.

**Per-adapter off is `device disconnect`, not rfkill.** rfkill is global on
this hardware - blocking one adapter would take the other down with it, and
on a boat the other one is usually the hotspot everything is talking over.
So "off" means NetworkManager drops the adapter's connection and "on" means
it reconnects. If something else has rfkilled the lot, turning an adapter
on lifts that first, since it could not come up underneath it.

### NetworkManager only

Bookworm and later. `netd.py` probes at startup and says what it found:

```
[netd] wifi via nmcli: yes   bluetooth via bluetoothctl: yes
```

On an older image running `dhcpcd`/`wpa_supplicant` it reports `NO`, the
row stays empty, and nothing else changes. Half-driving a stack it cannot
really drive would be worse than declining.

### Installing it

```bash
cp ~/helm/autostart/*.desktop ~/.config/autostart/
```

All of them, not just this one. Each entry resolves `$HOME` for itself
through `bash -c`, so a plain copy is the whole install under any
account - they used to carry a literal `/home/pi`, and on any other
account netd simply never started, which looks from the helm like every
radio, brightness and power tile being dead for no stated reason.

`confluence-spotify.desktop` is safe to copy even with no Spotify set
up: `spotify-now.py` exits at once with a log line when
`~/.config/confluence-spotify.json` is missing.

**In cage mode none of these entries run at all.** cage reads no
`~/.config/autostart`, so `cage-session.sh` starts netd, autopull and
the now-playing poller by hand. Every feature whose starter lives in an
autostart entry is invisible to cage, and each one that has been
forgotten failed the same way: silently, looking exactly like the
feature having nothing to show. The music page sat on "Nothing playing",
which is also what an idle Spotify looks like — so it now distinguishes
the three cases:

| the page says | means |
|---|---|
| `NOT SET UP` | `nowplaying.json` 404s — the poller has never written it |
| `OFFLINE` | nothing answered: AvNav down, or the page opened over `file://` |
| `Nothing playing` | the poller **is** running and Spotify is genuinely idle |

`/tmp/cage-session.log` says which, and names the fix
(`python3 ~/helm/spotify-auth.py`) when there are no credentials.
