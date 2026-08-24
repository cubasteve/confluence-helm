# Confluence Helm

Instrument display for the club racing boat *Confluence*. One self-contained
HTML file, no build step, no dependencies — it runs in Chromium on a
1080×1080 round panel at the helm.

## Layout

```
confluence_helm.html      the whole app: markup, CSS, JS
start-kiosk.sh            what the desktop session launches at boot
deploy.sh                 publishes the app to where AvNav serves it
autopull.sh               pulls the repo and redeploys when it changes
netd.py                   local helper: WiFi and Bluetooth for the panel
netd.sh                   keeps netd.py running, and lets a push replace it
autostart/                the .desktop files that start those two loops
spotify-now.py            polls the Spotify Web API -> nowplaying.json
spotify-auth.py           one-time Spotify authorisation
confluence-helm.svg       desktop shortcut icon
tiles/                    satellite pack (gitignored, ~33 MB)
```

## How it runs

The app is **served over HTTP by AvNav**, not opened from `file://`:

```
http://localhost:8080/user/helm/confluence_helm.html
```

This matters. Chromium cannot `fetch()` a `file://` URL at all, so the
music panel — which polls `nowplaying.json` — silently never worked when
the kiosk loaded from disk. Serving it also makes the display reachable
from any phone or tablet on the boat WiFi.

There are two copies of the HTML, and that is deliberate:

| Path | Role |
|---|---|
| `~/helm/` | the repo — **edit here** |
| `~/avnav/data/user/helm/` | what AvNav serves and the kiosk loads |

They cannot be a symlink (the sshfs mount used to edit them cannot create
one), so `deploy.sh` keeps them in step. It is the only thing that should
write the served copy.

```bash
# edit ~/helm/confluence_helm.html, then
bash ~/helm/deploy.sh
```

`start-kiosk.sh` waits for AvNav's HTTP server before launching Chromium,
falls back to `file://` if it never answers, and relaunches on crash — so
a slow boot degrades rather than leaving a blank helm.

**Autostart changes need a session restart.** A running Chromium never
re-reads `~/.config/autostart/`.

### The KIOSK tile

The panel's third display tile used to be wired to the Fullscreen API,
which on this Pi is wired to nothing. `--kiosk` is not the Fullscreen API:
`document.fullscreenElement` is null under it, so the tile read `OFF` on a
display that was manifestly full, and tapping it flipped its own label
without changing a pixel.

It now asks `netd.py` what is actually on the screen and drives whatever
is real there:

| where | label | tap | hold |
|---|---|---|---|
| the Pi | `KIOSK` | kiosk ⇄ windowed browser | reload the app in place |
| phone, laptop | `FULL` | the Fullscreen API, as before | reload the app in place |

Hold is a reload rather than a browser restart on purpose. A gesture can
only be made when the page is alive, and a live page needs nothing heavier
than `location.reload()`; restarting the process matters exactly when the
page is dead, and a dead page has nothing left to hold down. It is how a
deploy gets picked up at the helm with no SSH and no keyboard.

Switching to windowed stops `start-kiosk.sh` first - otherwise its restart
loop puts the kiosk back three seconds later - then replaces Chromium. The
helper answers the request *before* it acts, because what it does next is
kill the browser that asked. And if the windowed browser does not come up
within six seconds it puts the kiosk back, rather than leaving black glass
and SSH as the only way in.

By hand, if you would rather:

```bash
pkill -f start-kiosk.sh                  # the loop first, or it relaunches
pkill -f 'chromium-browser --kiosk'
curl -s -X POST -d '{"mode":"kiosk"}' localhost:8091/display/mode   # and back
```

The display actions need `DISPLAY` and `XAUTHORITY`, which the helper
inherits from the autostart session. Started by hand over SSH it defaults
them to `:0` and `~/.Xauthority`, which usually works but is not the
supported path.

## Editing from anywhere

The repo is the source of truth; the Pi is a deployment target.

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
panel prints it under SWIPE DOWN TO CLOSE:

```
SWIPE DOWN TO CLOSE   87b205f
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
cp ~/helm/autostart/confluence-netd.desktop ~/.config/autostart/
```

Then restart the session - a running desktop never re-reads
`~/.config/autostart/`. To check it by hand without one:

```bash
python3 ~/helm/netd.py            # foreground, prints what it detected
curl -s localhost:8091/status | python3 -m json.tool
```

`autopull.sh` restarts the helper when a pull changes `netd.py`, so editing
it from a phone works the same way editing the app does. It kills only the
python process; `netd.sh`'s loop brings the new one back.

### What it will not do

Pairing runs without an agent, because there is nothing on the helm that
could answer a PIN prompt. Just-works devices - speakers, headsets, most
handhelds - pair fine. Anything that wants a number typed has to be paired
from the desktop once; after that it connects from the panel like the rest.

The on-screen keyboard exists because the helm has none and Chromium under
`--kiosk` offers none either. It shows the password in the clear on
purpose: typing a 20-character WPA key blind on a wet 5-inch panel is how
you get three failed joins and no idea which character was wrong.

The list is paged rather than scrolled. `html`/`body` carry
`touch-action:none`, so a flick inside an `overflow:auto` box is not
reliably a pan here - and a page you can hit with a wet glove beats a list
you have to nudge.

## Data

SignalK on `:3000` over a WebSocket. Subscriptions are `policy:'fixed'`
at 250 ms — deliberately batched rather than `instant`, because a
continuous drizzle of deltas was landing between animation frames and
costing roughly four dropped frames per slide.

Fitted today: **GPS only**. Wind vane, depth transducer and the BNO080
attitude sensor are not installed, so those readouts hide themselves
rather than showing dashes. `CFG.windDemo` fabricates wind and depth so
the bezel animation can be judged before the hardware lands — **turn it
off once the sensors are real**, as it writes into their live paths.

## Render architecture

`render()` splits in two, and the split is load-bearing:

- **DATA** — always runs. Advances every filter, touches no DOM. It has to
  run even when the dial is hidden, because the music panel's wind bezel
  reads the same filters.
- **DRAW** — only when `dialVisible()`. Every slide-out is a full-bleed
  opaque layer, so painting underneath one is invisible work.

The control panel's depth bar sits **outside** the dial gate on purpose:
it is drawn precisely when the panel is open, which is exactly when the
dial is not.

Smoothing is time-based (`CFG.smoothTau`, 420 ms) rather than a fixed
per-frame alpha. A fixed alpha at 60 fps converged in ~70 ms against a
250 ms feed, so every reading snapped and then sat still — four visible
steps a second. Tau must stay above the feed period.

## Charts

AvNav serves NOAA ENC via its `system-mapproxy` plugin, seeded for offline
use. Caches are plain SQLite MBTiles in `~/avnav/data/mapproxy/cache_data/`
— query them directly rather than probing over HTTP.

`c_noaaenc` uses `meta_size: [6,6]`, so one upstream request caches 36
tiles. Seed on a stride-6 grid; it turns a 3,000-request job into ~100.

NOAA has a genuine coverage hole at z10–12 over Lake Monroe specifically.
The `base` layer fills it.

## Gotchas

- `chmod` does not take over the sshfs mount. Anything needing an exec bit
  or `0600` has to be set on the Pi.
- A swipe that begins on one of the display tiles still closes the panel:
  those tiles let the event through and tell a tap from a drag with the
  same 24 px rule the dial uses. Worth knowing before adding another tile
  there - the row sits almost exactly where a dismiss swipe starts, and a
  tile that swallows pointer events breaks swipe-down from that spot.
- The Spotify config at `~/.config/confluence-spotify.json` holds a client
  secret and refresh token. It should be `0600`.
- WiFi passwords typed at the panel go to NetworkManager and are stored by
  it, under `/etc/NetworkManager/system-connections/`. `netd.py` keeps
  none of its own, and a key NetworkManager rejects takes its half-written
  profile with it - otherwise that profile comes back as "saved" and fails
  for ever.
- Chart tiles and the track library live in **browser storage**, which is
  per-origin. Moving between `file://` and `http://` starts both empty.
