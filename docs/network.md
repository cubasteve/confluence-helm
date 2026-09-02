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
