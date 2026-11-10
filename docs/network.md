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

**It never touches a working adapter.** That is what makes it safe on a
timer, which is what `install-dongle-rescue.sh` sets up: at boot and
every five minutes, because the adapter can go away mid-voyage too, with
nobody at the chart table to notice.

`tests/dongle_test.py` drives it against a pretend `/sys` with pretend
`ip` and `iw` on the PATH — a script whose job is to yank the boat's
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
