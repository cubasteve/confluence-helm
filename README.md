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
open-window.sh            opens the app in its own window (desktop shortcut)
autostart/                the .desktop files that start those two loops
desktop/                  the desktop shortcut itself
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

### Chromium is single-instance, and the kiosk loop has to know it

Only one Chromium can own a browser profile. A second launch does not
start a second browser: it hands the command line to the window already
running and exits immediately.

**And that window then opens a new one with it.** Which is the whole
trap: "the launcher exited" is not "nothing happened". Tap Desktop, and
the desktop session that comes up runs every entry in
`~/.config/autostart` at once — including the windowed app. If anything
else on that Pi also puts the helm on screen at login, the second
launcher hands its URL to the first window, that window opens another,
and you have two Confluences, both working perfectly. That is what it
looks like from the helm, and nothing in the logs calls it an error.

The fix is to ask **before** launching, not after. `start-kiosk.sh` used
to check `owned_by_another` only when Chromium exited inside five
seconds — which is checking after the damage: the duplicate already
exists by the time the check runs, and it correctly reports that someone
else owns the profile, having just created the window it exists to
avoid. It now checks at the top of every iteration and waits instead.
`open-window.sh` carries the matching guard (`--force` overrides it), and
`--app` is the worst case for the want of one: a plain `chromium <url>`
hand-off at least reuses the window, but `--app` always opens a new one,
so the duplicate is guaranteed rather than likely.

Both launchers are started by the same autostart within the same second,
so "is anyone else up yet" can be asked before the other has got as far
as a process. `start-kiosk.sh` settles for three seconds before its first
check — invisible next to the AvNav wait it already does, and it removes
the tie. Everything on this Pi shares one profile on purpose -
the desktop shortcut, the windowed browser the panel can start, and the
kiosk - so that saved races and cached tiles are the same everywhere.

That makes an instant exit ambiguous, and `start-kiosk.sh` used to read it
the wrong way. Kill the kiosk while the desktop window is open and the
loop relaunches, the new process hands off and quits, and three seconds
later it does it again - forever, poking that window into reloading every
time. That is what a "Restart display" looked like from the helm, and
`autopull.sh` could do the same thing on any deploy.

So the loop now distinguishes three cases:

| Chromium exits | means | response |
|---|---|---|
| after running | a crash | restart at once, as before |
| at once, another window has the profile | a handoff that already opened a duplicate | wait for that window to close, then take the screen back — and the check above means this case should now be unreachable |
| at once, nothing else has it | Chromium is unhappy | back off 5s, 10s, … to 30s rather than hammer it |

The process patterns are anchored on the executable (`^[^ ]*chromium[^ ]*
…`). An unanchored `pgrep -f` also matches any shell whose command line
merely mentions the flag, and a false positive in the wait loop would hang
the kiosk for ever - the worst outcome available.

### The desktop shortcut

`desktop/confluence-helm.desktop` opens the app in its own 1080x1080
window, sharing the kiosk's browser profile so saved races and cached
chart tiles are the same ones. Install it over whatever is on the desktop
already, so there is only ever one:

```bash
cp ~/helm/desktop/confluence-helm.desktop ~/Desktop/
chmod +x ~/Desktop/confluence-helm.desktop      # on the Pi - sshfs cannot

# the icon, which the entry names by theme rather than by path
install -Dm644 ~/helm/confluence-helm.svg \
  ~/.local/share/icons/hicolor/scalable/apps/confluence-helm.svg
```

It runs `open-window.sh` rather than calling Chromium directly, and that
indirection is the whole point: `Exec=` is not parsed by a shell, so there
is no way to spell `$(date +%s)` in a `.desktop` file - and without a
fresh `?v=` Chromium renders the copy it already has. Same URL, same
origin, older bytes. That is why this window used to sit a version behind
the kiosk while both were pointed at exactly the same file.

The window is deliberately neither `--kiosk` nor `--start-maximized`.
Those are the two flags `netd.py` matches on, so switching the kiosk
between modes from the panel leaves this window alone.

`--window-size=1080,1080` is load-bearing: a square viewport is what keeps
the dial round. Any other shape and `fitStage()` squares it off.

### The KIOSK tile (removed)

There used to be a third display tile that toggled kiosk against a
windowed browser, with a hold-to-reload on it. It is gone. **Kiosk** and
**Desktop** in the power sheet do the switching now, and they do it
properly — taking the fit, the touch mapping and the desktop's own panel
with them, none of which a tile that only knew about `--kiosk` could.
The power sheet's Reload tile covers what the hold did, and
`POST /display/mode {"mode":"kiosk"|"window"}` is still there for anyone
who wants the old behaviour by hand.

What follows is why that tile was the shape it was, kept because the
reasoning still applies to the helper underneath it.

#### It used to work like this

The panel's third display tile used to be wired to the Fullscreen API,
which on this Pi is wired to nothing. `--kiosk` is not the Fullscreen API:
`document.fullscreenElement` is null under it, so the tile read `OFF` on a
display that was manifestly full, and tapping it flipped its own label
without changing a pixel.

It now asks `netd.py` what is actually on the screen and drives whatever
is real there:

| where | label | tap | hold |
|---|---|---|---|
| the Pi, `start-kiosk.sh` | `KIOSK` | kiosk ⇄ windowed browser | reload the app in place |
| phone, laptop | `FULL` | the Fullscreen API, as before | reload the app in place |
| **cage mode** | — | **the tile is not shown** | — |

**In cage mode it is not merely useless, it is harmful.** cage runs one
maximized application, so "windowed" means killing its client - which
makes cage itself exit, which `cage-session.sh` reads as a crash and
restarts. You would get a black panel for a second, land exactly where
you started, and spend one of the five quick-exit strikes that trigger
the fall back to a desktop. So `display_status()` reports `cage` and the
tile hides; the brightness slider takes the room.

`cage-session.sh` counts as cage as well as `cage` itself, because
between relaunches the compositor is briefly gone but the mode is not.
The match is anchored (`(\S*/)?cage(\s|$)`) so a Chromium command line
that merely contains the word - a file path, say - does not trigger it.

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
pkill -f '^[^ ]*chromium[^ ]* .*--kiosk' # anchored: see below
curl -s -X POST -d '{"mode":"kiosk"}' localhost:8091/display/mode   # and back
```

That pattern is the one rule, and `netd.py`'s `KIOSK_PAT` and
`autopull.sh` both use it verbatim. It has to be anchored and it has to
allow flags before `--kiosk`: under cage the command line is
`chromium-browser --ozone-platform=wayland --kiosk …`, so the older
`'chromium-browser --kiosk'` matched nothing at all — every push
deployed and none of them ever reached the glass. The `^` is what keeps
it off `cage -s -- chromium…`, which must never be killed directly:
that is the supervisor, and killing the browser alone is what makes it
relaunch.

The display actions need `DISPLAY` and `XAUTHORITY`, which the helper
inherits from the autostart session. Started by hand over SSH it defaults
them to `:0` and `~/.Xauthority`, which usually works but is not the
supported path.

## Editing from anywhere

The repo is the source of truth; the Pi is a deployment target.

## The sensor row

Four glyphs - GPS, depth, wind, heading - green when that source is
feeding, dim when it is not. They live at the top of the **control
panel** rather than on the dial: the face's foot was the one place the
lock and the page dots both needed, and "is anything actually feeding
me" is a question you ask when you are already in the settings.

Their liveness is evaluated in DATA rather than DRAW. Left where it was,
inside the dial's draw gate, the glyphs would freeze whenever the control
panel was open - which is now the only time you can see them.

## Pages

Three places rather than three overlays: the track map, the dial and the
music panel sit side by side, and swiping left or right moves along the
row. Three dots at the foot of the screen say where you are. The dial is
the middle one, because it is the one you come back to.

```
   track map   <->   DIAL   <->   music
                 * . .   . * .   . . *
```

The control panel is still an overlay, pulled up from the bottom over
whatever page you are on - and now reachable from any of them, the way
control centre is on a phone. It is a layer over a place, not a place.
While it is up it owns the gestures: left and right do nothing until you
swipe it away.

### How many fingers

Two answers, because the two gestures are not the same risk.

| Gesture | Fingers |
|---|---|
| Page left/right between the three dials | **three** |
| Control panel up / down | **one** |
| Dismiss the picker, the library, the QR sheet | **one** |
| Taps, holds, every button on every page | one, as always |

**Paging takes the whole hand.** Changing which instrument you are
looking at mid-race because a wave put a wrist on the glass is the
failure worth designing against, and one finger is what rain, spray and
a sleeve produce.

**Raising and dismissing takes one.** Those are all visibly reversible:
whatever appeared is on screen and a swipe puts it away, so a stray
touch costs a second rather than your instruments. The control panel is
also the thing you reach for most, and it was the most annoying to need
a whole hand for.

`FINGERS` clamps `CFG.swipeFingers` - now the **paging** count only - to
what the touchscreen can actually report, so a panel that tracks fewer
touches still has paging rather than none. A mouse reports zero touch
points, so a desktop browser and the windowed copy fall back to one
finger for everything.

`swipeFingers` is a source constant, not a panel control - there is no
tile for it, and the clamp means no setting could rescue a one-point
panel anyway. Change it in `CFG` and deploy.

The overlay branches in `judgeGesture()` deliberately use the
finger-count-free `swipeL`/`swipeR` rather than `left`/`right`: an
overlay that took three fingers to close while one finger opened the
panel would be the odd one out.

A gesture is every finger down between the first touch and the last
lift, and the direction is the average of their travel: one finger that
slips while the other two hold still is not a swipe, and averaging says
so.

### Stacking

Written down in the CSS rather than left to DOM order, because it bit
once already:

```
1 pages   2 dots   20 control panel   30 screensaver
55 alerts   70 lock   80 hold ring   90 veil   99 fps readout
```

`#qr-sheet` is the exception: `z-index:10` **within the track page**, so
it covers the race library — its sibling, which has no level of its own —
without leaving the page it belongs to.

The veil is the brightness control on a panel with no backlight to
drive, so it sits above everything and dims the lot. It was on `auto`
until the pages and the panel were given levels, at which point it ended
up underneath both and the slider silently stopped doing anything.

`#panel` sits *before* the music and track pages in the document, so with
everything on `auto` those pages painted over it: the control panel
opened behind whichever page you were on - invisible, and holding the
gestures hostage. That could not happen while the panel was reachable
only from the dial. Making it reachable everywhere is what exposed it.

Nothing new is resident. All three layers were always in the DOM, parked
off-screen with a transform; only the transform is now computed from one
index rather than toggled by a class. Layer promotion stays scoped to the
gesture, so the compositor holds no more than it did.

The dots replaced the SWIPE LEFT/RIGHT/DOWN TO CLOSE captions. Those
existed because nothing indicated the relationship between the views; the
dots make it structural, so there is nothing left to spell out.

Two things to know if you touch this:

- `.open` on `#tmap` and `#music` is now **derived state**, kept in step
  with the index by `layoutPages()`. Everything that already asked
  whether the map or the music panel was showing keeps working; do not
  set it by hand.
- `dialVisible()` is now a question about place - `PAGE_I===1` - not
  about what is covering the dial. During a page change the dial can be
  both on screen and moving, which is the expensive combination, so the
  render freeze over `SLIDE_MS` matters more than it used to.

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
panel prints it at the very bottom of the control panel, under the
shallow-alarm section:

```
87b205f
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

### Authorising, on a Pi with no browser

`spotify-auth.py` catches Spotify's redirect on `127.0.0.1:8888`, which
means the browser you approve in has to be **on the Pi** for that to work
automatically — and a boat Pi is usually driven over SSH with nothing to
open. Two ways through:

- **A browser on the Pi.** The script opens it for you *only* when there
  is a desktop of its own to open it on. Never under the cage kiosk:
  Chromium is single-instance per profile, so handing it the consent URL
  would replace the instruments with a Spotify login screen.
- **A browser anywhere else.** Approve there; the redirect to
  `127.0.0.1` will fail to load, which is expected — the code is in the
  address bar. Paste the whole address (or just the code) when asked.

If the port is busy the script says so **before** asking for anything,
names whatever is holding it, and offers the paste path. It used to bind
after the credentials had been typed and the consent screen approved, so
a busy port threw all of that away and left a traceback. The usual cause
is an earlier run still waiting for a redirect that never arrived:
`pkill -f spotify-auth`.

`CONFLUENCE_AUTH_PORT` moves the port, but only usefully if you also
change the redirect URI registered in the Spotify dashboard — Spotify
matches it exactly.

### Nothing here is a Connect device

Worth stating plainly, because the obvious way to put Spotify on a Pi is
to install `raspotify` and it is the wrong way for this one.

The panel never streams audio. `spotify-now.py` polls the Web API and
writes `nowplaying.json`; the transport and volume drive whatever device
is *actually* playing — typically the phone feeding the cockpit speakers.
Resident size is a few tens of MB against librespot's hundred-plus, on a
Pi that is also running Chromium, AvNav and a chart renderer.

So **this repo installs, enables and references no Connect daemon at
all** — no `raspotify`, no `librespot`, no `spotifyd`, no unit file, no
`apt` line. The only thing any autostart entry or `cage-session.sh`
starts is the poller. If `raspotify` is running on the Pi it arrived from
somewhere else and nothing here will miss it:

```bash
sudo systemctl disable --now raspotify
sudo apt purge -y raspotify        # and this, to stop it coming back
systemctl status raspotify         # "could not be found" is the answer you want
```

`free -h` before and after is the honest measure. Nothing on the music
page changes: it reads the same JSON either way.

### The save button, and who holds the token

The **+** button in the control bar adds and removes the current track from
your library. Scopes are `user-read-currently-playing`,
`user-library-read`, `user-library-modify`, `user-modify-playback-state`
(the transport and the volume ring) and `user-read-playback-state` (the
volume ring's *reading* half — it is what makes the device visible).
Re-run `spotify-auth.py` after any
scope change; a refresh token carries the scopes it was granted with, so
widening the list does nothing until the consent screen is answered
again. This is the single most common cause of a feature here being
present in the code and inert on the glass.

The write path is deliberately indirect. netd has the HTTP listener, so
the panel posts to it — but netd does **not** call Spotify. It writes a
one-line request file, and `spotify-now.py` performs it. The reason is
that Spotify sometimes hands back a *rotated* refresh token, and
whoever receives it writes it to the config: two processes refreshing
independently would eventually leave one holding a token that has been
replaced, and the symptom is a dead integration hours later with nothing
to point at. One process owns the token.

The poller checks for that file between polls rather than only at the
top of the loop, so a tap registers within half a second. The mark ticks
immediately rather than waiting even for that — and because it is
optimistic, a refusal has to be visible or the panel is lying about your
library. A failed tap puts the **+** back and prints the reason where
`NOW PLAYING` normally sits.

`GET /v1/me/library/contains` is asked **only when the track ID
changes**. Asking every poll would double this loop's request rate for an
answer that cannot differ between two polls of the same track.

#### The February 2026 API change

This code used to call `PUT`/`DELETE /v1/me/tracks` and
`GET /v1/me/tracks/contains`. Spotify replaced every per-type save,
remove and contains endpoint with one generic pair that takes Spotify
**URIs** instead of bare IDs:

| was | is |
|---|---|
| `PUT /v1/me/tracks?ids=<id>` | `PUT /v1/me/library?uris=spotify:track:<id>` |
| `DELETE /v1/me/tracks?ids=<id>` | `DELETE /v1/me/library?uris=…` |
| `GET /v1/me/tracks/contains?ids=<id>` | `GET /v1/me/library/contains?uris=…` |

The old paths were not merely marked deprecated. For a **Development
Mode** app — which is what a personal app like this one is — they answer
**403 Forbidden** with a perfectly valid token and the right scopes;
existing dev-mode apps were migrated onto that restriction on 9 March
2026. Scopes did not change, so nothing needs re-authorising. The URIs
go in the query string with their colons percent-encoded (they are one
value, not a path), 40 items maximum, and success is a 200 with an empty
body.

That 403 is the whole of both bugs here: the contains check failed, so
the poller wrote `liked: null` and the button was hidden; and a tap went
to a path that refused it, so nothing reached the library.
It presents exactly like a missing scope and is not one — which is why
`--check` now names *which* endpoint answered, and the 403 log line says
which of the two causes it is.

The legacy paths are still in the code, reached only if `/me/library`
answers **404** — a path that is not there is a better reason to try the
old one than to lose the feature on a boat. A 403 is a real refusal and
is reported, never routed around.

#### A plus and a tick, not a heart

Spotify merged the heart and "add to playlist" into a single **+**
button, and a saved track shows a green **checkmark** rather than a
filled heart. This panel draws the same two marks, so it and the phone in
your pocket agree about what a saved track looks like — which is the
whole job of an icon. It still adds to Liked Songs; only the mark
changed.

Saved fills the disc and punches the tick out of it in the panel colour.
The fill is `--stbd`, not a literal green, so **night mode gets a red
one** — nothing here is allowed to put white-green light in your eyes at
0200.

`--like` followed by its re-read is the way to settle whether a track
really saved, without trusting either UI.

The button shows whenever netd reports credentials and something is
playing — the same bar the transport clears. It is hidden on a phone
loading this page over the boat WiFi, where the loopback helper is
unreachable and a tap could not go anywhere, and that is the only case.

It used to also require the feed to carry a real liked state, and that
was wrong. A token without `user-library-read` answers 403, the poller
writes `liked: null`, and the button simply was not there — beside three
transport buttons that were, with nothing on the glass saying why. Now
an unknown answer is *drawn*: it appears dimmed, it is still
pressable, and a refusal names itself on the state line the way a
refused skip does. A plain **+** means "not in your library"; a dim one
means "I could not find out" — and only one of those is something you
can fix.

The same 403 puts the library check into an hour's backoff (a network
wobble, a minute's). When that expires the check is asked again for the
track still playing: the answer is recorded against a track ID only when
there *is* an answer, since recording the ID beside a `None` reads as
"already asked about this one" and would hold it unknown for the
rest of the track however quickly the fault cleared.

### Playback controls

Previous, play/pause and next, at the foot of the music page in one line
with the lock. They need `user-modify-playback-state` on top of the
library scopes, **Spotify Premium** (a free account answers 403), and an
**active device** — the Pi deliberately is not one, so these drive
whatever is actually playing, typically the phone feeding the cockpit
speakers.

All three of those can fail, and none of them fails at a moment this
code can predict, so each is reported rather than swallowed:

| the page flashes | means |
|---|---|
| `NO ACTIVE DEVICE` | 404 — nothing is playing anywhere to control |
| `NOT ALLOWED` | 403 — no Premium, or the scope was never granted |
| `TIMED OUT` | the request went out and no answer came back |
| `NO NETWORK` | it never left the boat |
| `BAD REPLY` | answered, but not with anything parseable |
| `NO HELPER` | netd unreachable, as on a phone |

Those last three used to be one word, `NO REPLY`, and that was the least
useful thing a boat can be told: it reads as "the press did nothing" when
in fact Spotify may well have carried the command out and only the answer
went astray. Each of these has a different fix, so each says which.

Which leads to the rule that matters more: **the poller re-reads after a
press whatever the outcome, including a reported failure — especially
then.** It used to re-read only on success, so a press that "failed" left
the panel holding the state from *before* it. The music had paused and
the glyph still said it was playing, under a message saying the press had
not worked. A short pause before the re-read covers Spotify accepting a
command a moment before the player catches up, and the next poll is
shortened to a second so the panel converges either way.

Same architecture as the save button: netd writes a command file, the poller
performs it, one process owns the token. Play/pause is optimistic
because the glyph *is* the state and a wrong guess corrects itself
within a poll; skip never is, since pretending the next track had
arrived would mean inventing a title.

The play button shows the **action, not the state** — a triangle means
"this will play", two bars mean "this will pause" — and it is repainted
on *every* poll rather than only when the feed reports a change. That
looks redundant and is not: the glyph is set optimistically on a press,
so it can be showing something the feed never agreed with, and a
change-detector comparing the feed with itself cannot see that. Press
pause, have it refused, and the event never changes — the glyph then sat
inverted until the track did, offering play while the music played on.
A refusal now also puts the guess back, which matters because the button
sends `play` or `pause` according to that same flag: a stuck glyph meant
the next press asked for the wrong one.

None of which was why it did not change. `id="m-playico"` was on the
`<svg>` rather than on the `<path>` inside it, and `d` means nothing on an
`<svg>` — so the write landed on an element that ignores it and the
triangle drawn underneath never moved. It survived two rounds of fixing
the *logic* because the test read the attribute back **off the same id it
had just written to**, which passes whether or not anything is drawn. The
check now finds the path by structure (`#m-play svg path`) and compares
`getTotalLength()`, which is the rendering's own opinion of the shape and
cannot be satisfied by an attribute nothing draws. Put it back the old way
and six assertions fail. After a successful skip the poller
re-reads immediately rather than leaving the old track on the glass for
a whole poll interval.

They live in a **second control bar** under the progress bar, with the
save button — the four things you press about the track, together. The
progress bar keeps its full 520px above them and the lock is back at
dead centre on the foot, the same as every other page. The room came out
of the album art, which was the only place on the page it existed —
though most of it came back afterwards by setting `line-height` on every
row of that page to the font's own box (Poppins measures 1.42em by
`measureText`, so 1.43) instead of leaving it at `normal`, which is
about 1.5 and is pure waste for single-line rows. The art ended at
280px.

It sits slightly apart from the three: at an equal gap it read as
a fourth transport button, and it is not one — those three move the
music, it changes your library.

The whole row collapses when nothing in it is available, which is what a
phone gets: the helper is loopback-only, so neither the save button nor the
transport could do anything there, and an empty 78px band under the bar
would just be a puzzle.

### The volume ring

A tick bezel around the album art. 45 ticks over 300°, lit to the level,
with the 60° at the foot left open — a gap gives the scale a beginning
and an end, and without one 65% reads as nearly full. It is also where
the title is, so nothing down there is a target.

**45, not 44,** and the reason is arithmetic rather than taste. The ticks
span `N-1` gaps, so the majors land on quarters of the scale only when
`N-1` divides by 4, and the middle one sits at twelve o'clock only when
it is even. 44 put the majors at 0, 25.6, 51.2 and 76.7 per cent and the
"half" one 3.5° past top dead centre — invisible until you look at it
against the strip above, and impossible to unsee afterwards. 45 gives 44
gaps: majors every 11 at 0, 25, 50, 75, 100, and 50% dead centre. The
test measures that against the ring's own geometry rather than against
the tick index, so changing the count cannot quietly move it again.

Ticks rather than a solid arc because this panel already has one tick
ring, the wind bezel, and a second idiom for the same kind of reading
would be a second thing to learn.

**It costs the page no height.** The wrapper is exactly the size of the
art; the ring and its hit target both overflow it. There were 21px of
slack above the lock and this spends none of them, so the art stays at
280.

The instrument strip above it moved up 28px to make room, and that costs
nothing either: `.ms-head` carries `margin-top:-28px` against
`margin-bottom:48px`, a pair that cancels. The sheet's total height is
unchanged, so the sheet — which is vertically centred — does not move,
and neither does anything below the strip. Only the strip rises, into
room that was doing nothing between it and the bezel at the rim. The
topmost tick had 8px under it and now has 22.

#### Turning it

Relative, not absolute: what moves the volume is how far you *rotate*,
not where you touch. An absolute ring means a stray knuckle at the top of
the bezel is full volume in a cabin at anchor, and that is not a mistake
worth being able to make. It also means a touch that never moves does
nothing at all — the drag has to clear 8px before it counts.

The hit target sits **behind** the art and 40px wider all round, so it
collects only what lands in the annulus. The art is a circle and CSS
hit-testing respects `border-radius`, so a touch on the cover itself
falls through to the gesture reader and still swipes pages — which
matters, since swiping is how you leave this page. Touches in the open
60° at the foot are ignored for the same reason.

The request is sent **on release only**. Following the finger with a
request every few degrees would be a dozen writes for one turn, and
Spotify does not promise they arrive in order — the last one to land
would win, which is not necessarily the last one you meant.

The number appears over the cover only while you are turning, at 76px.
A permanent readout would have to live below the art and there is no room
below the art. Its scrim is a layer of its own so the number sits on it
at full strength: a translucent black wash was fine at night and
unreadable in daylight, where `--ink` is nearly black too.

#### What can go wrong, and how it says so

| the page flashes | means |
|---|---|
| `DEVICE WON'T` | the active device will not take a volume |
| `NOT ALLOWED` | 403 — no Premium, or the scope was never granted |

`DEVICE WON'T` is deliberately not the transport's `NO ACTIVE DEVICE`.
A 404 on the transport means nothing is playing anywhere; a 404 here
usually means the device that *is* playing refuses volume — an iPhone is
the common case — and telling someone to start playing something would be
wrong advice.

Spotify reports this in advance as `supports_volume`, so the ring does
not have to wait to be pressed to find out. A device that reports a
volume and refuses to set one gets a ring drawn at a third opacity: shown,
so it is not mysteriously missing, plainly not live, and a touch says
why. `--check` reports the same thing before you touch anything:

```
device           Steve iPhone
volume           40%
supports volume  no - the ring cannot work on this device
```

#### The scope, and the fallback under it

Reading the volume needs `GET /v1/me/player` — the same track, position
and playing state as `/currently-playing`, plus the **device**, which is
where `volume_percent` and `supports_volume` live. That endpoint needs
`user-read-playback-state`, which tokens issued before the ring existed
do not carry.

So the poller tries `/me/player` and falls back to `/currently-playing`
on a 403, once, with a log line saying which. The rule from the library
403 stands and is the reason the ring was built this way round: **an
optional feature never takes the music down with it.** Without the scope
you lose the ring and nothing else.

Zero is a real volume, so the feed carries `null` rather than `0` when
there is no answer — the ring has to be able to tell *muted* from *I
cannot see*. Muted lights no ticks at all; rounding it to the first tick
would read as "nearly off" rather than off.

### Long names travel

A title clipped to `Shipping Up To Bos…` is the one thing you cannot fix
by looking harder, so `.m-title` and `.m-artist` scroll instead when the
text overflows — out, a dwell, back, a dwell. The artist's line carries just the artist.

Driven by the Web Animations API with **concrete pixel values**, not a
CSS keyframe reading a custom property: a `var()` inside `@keyframes`
cannot be composited, because Chromium has to resolve it on the main
thread every frame.

Measured rather than assumed. On a bare page the animation is free —
0.09% of the main thread against a 0.03% baseline, zero style recalc,
clipped or not. Inside the app it does cost something: three runs each
at 6× CPU throttle, scrolling against the same page with the animation
cancelled, gave style recalc 1.88% vs 1.12% and main thread 11.7% vs
10.8%, spreads that do not overlap. About a point of throttled main
thread, so roughly 0.15% unthrottled. Not free, and not written up as
though it were.

It pauses whenever the music page is not the one showing — the page is
translated aside rather than hidden, so an animation left running there
would tick behind the dial for the rest of the voyage.

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

## Two drawers, and apps

Swipe **down** for the control panel, **up** for the app drawer. Opposite
edges, opposite gestures, each going back the way it came — the panel
used to come up from the bottom, which is where the drawer lives now, and
two surfaces sharing an edge and an animation would have been two things
that felt like one.

An **app is not a page**. A page is always loaded and always costing
something; an app exists between the tap that launches it and the tap
that closes it, and then it is torn down. Each entry in `APPS` carries
its own `open(host)` and `close()`, because only the app knows what it
allocated.

## Radar

A slippy map without Leaflet. Web Mercator is two functions and a tile
layer is `drawImage` at a computed offset, so the library buys nothing
here and costs 144 kB, a CDN dependency and fifteen tile layers of DOM.

### The memory is the design

Kept the obvious way — every frame's tiles decoded and held — fifteen
frames over a 1080 view is ~375 tiles at 256 kB, about **100 MB** of
image memory that never appears in the JS heap and never comes back. So
each frame is composited **once** into a single 512² canvas and its
source tiles are released.

Measured, same machine, closing and reopening:

| | CPU @1x | JS heap | image memory |
|---|---|---|---|
| closed | 2.8% | 1.9 MB | **0** |
| radar open | 6.0% | 2.7 MB | **24.9 MB** |
| closed again | 3.8% | 2.3 MB | **0** |

For comparison, `sail-weather.html` measured **34.8%** at the same
throttle. Most of that difference is not the map — it is a 323-particle
wind field on `requestAnimationFrame`, which the dial's wind bezel
already covers.

512 is not a compromise: RainViewer's free radar is real only through z7
and is upscaled above it, so past z7 the native content across the view
is already fewer than 512 px.

### Frames cover the view, not a pixel count

The frame canvas stands for exactly the view, so the tiles fetched must
cover exactly the view — **the same ground at a lower zoom, not the same
number of pixels**. Covering `FRAME × span` px at the radar's zoom is
twice the ground when span is 2, and the radar then draws at half scale
over a base that is correct: two layers of the same coastline, one of
them wrong. One zoom below the view, capped at the radar's native 7, is
also self-consistent with a 512 canvas over a 1080 one.

Frames are built **one at a time**. Fifteen fired at once is sixty-odd
parallel tile requests over a marina's wifi, and the first frame — the
only one anybody sees immediately — arrives last.

### Giving it back

`close()` aborts the one `AbortController` every fetch shares, clears the
timer, and sets every canvas to `width = height = 0`. That last one is
what actually frees the pixel buffer: dropping the reference only makes
it eligible, and a 1080 canvas is 4.7 MB the collector is in no hurry
about.

### Sources, and the one that needs a key and hides it

| | source | key |
|---|---|---|
| base | Esri World Dark Gray Canvas | none |
| seamarks | OpenSeaMap | none |
| radar | RainViewer, last hour + nowcast | none |
| forecast | Tomorrow.io via the `keel-ics` Worker | `TOMORROW_KEY`, a Worker secret |

### The futurecast

Three frames at +1h, +2h and +3h, appended after the radar so the
timeline runs past → nowcast → forecast in one pass. Each is rounded
**down to the quarter hour** Tomorrow.io publishes on; asking for 14:07
returns nothing at all.

The key never reaches the panel. It lives as a secret in the Worker,
which proxies `/tile/{z}/{x}/{y}/{iso}.png` and caches every tile at the
Cloudflare edge for 15 minutes — so the free tier is shared across every
device instead of burned per browser:

```bash
cd ics-worker && npx wrangler secret put TOMORROW_KEY && npx wrangler deploy
```

That trickle of quota is why these frames are fetched **one tile at a
time**, and at a zoom backed off until the view fits in **six tiles**.
A normal tile layer bursts dozens of requests and spends the day's quota
on a single look.

**An empty forecast frame must not read as clear sky.** A quota refusal
and a fine afternoon draw identically — nothing — so each frame reports
how many tiles actually arrived, and a frame that got none is discarded
rather than shown. The run stops at the first refusal too: if the quota
is gone for +1h it is gone for +2h, and three empty frames in the loop
would read as three hours of clear weather. The HUD says
`NO FORECAST — quota or upstream` instead.

The timeline marks where **now** is, so past and forecast are told apart
at a glance rather than by reading the clock, and the label distinguishes
all three: `10:15 PM`, `· NOWCAST`, `· FORECAST`.

### Play, pause, scrub

It plays on its own; the fourth button holds it. The glyph is the
**action, not the state** — a triangle means "this will play" — the same
rule the music page's transport follows, and for the same reason: a
button that shows what it will do needs no legend.

Paused, the timer keeps running and returns immediately. No advance, no
paint, no compositing. That is what makes resuming instant, and it is
three lines of nothing every 80 ms.

Touching the timeline scrubs to that frame **and pauses**, because a
timeline that keeps running under your thumb fights you. The bar is 8px
because that is what reads; the hit band around it is **50px** because
that is what a thumb needs. Changing the view resumes playing — that is a
new look, not a held frame.

### Everything is checked against the circle, not the viewport

The credit line sat along the foot and was **outside the glass**: a 274px
line at y=1070 has its corners 547px from the centre and the panel stops
at 540. It looked deliberate in the screenshot and was simply clipped.
It lives in the HUD now, inside by construction. The test asserts all
four corners of every control are within 540px of the centre — the
fourth button widened the control row, and that is exactly the kind of
change that quietly pushes something off a round panel.

**Not Carto**, which `sail-weather.html` uses. `basemaps.cartocdn.com`
now returns a tile with **API KEY REQUIRED** stamped across the middle of
it, on every subdomain — and it looks exactly like a working dark
basemap until you read the words. Esri's canvas service is unkeyed and
asks only for the credit line at the foot of the app.

Esri puts **y before x** in its tile path. Tokens are replaced by name,
so the order in the template is the order on the wire.

Tiles are drawn and never read back, so the canvas may taint and no CORS
handshake is needed — one whole class of failure removed.

No network is `NO RADAR — no internet` on the glass, not a thrown
exception.

## Preferences

Theme, depth units, the shallow alarm and brightness persist in
`localStorage` under `helmPrefs`. They did not before: every kiosk
restart - which is every deploy, every autopull and every crash - put them
silently back to AUTO, feet and 6 ft. An instrument that forgets how you
set it is not one you can trust to be set.

Values are validated on the way in, not trusted. That storage outlives
every version of this app that has ever run on the Pi, and something
merely old must not be able to break the boot: an unknown theme, a depth
of 99999 or a string where a number belongs all fall back to the default.

## Brightness

Two mechanisms, and only one of them is real.

The slider used to paint a black veil over the picture. The backlight
stayed at full behind it, so at night it still lit the cockpit, still drew
the same power, and only made the instruments harder to read. A browser
cannot reach the backlight - but `netd.py` can, where the kernel exposes
one and udev has made it writable.

When it can, the slider drives the real backlight and the veil stays at
zero. When it cannot - which is the case on this boat's panel, where the
kernel exposes no backlight at all and the display has no DDC either -
the veil is all there is.

Worth knowing what that means: compositing black over the image does
reduce emitted light, because the LCD pixels block more of it, so it
genuinely helps at night. What it cannot do is turn the lamp down. Blacks
stay grey, contrast falls as you dim, and the power draw does not change -
so dimming the screen overnight at anchor saves nothing on the battery.

If your panel has a backlight the kernel knows about but the file is
root-only:

```
echo 'SUBSYSTEM=="backlight",RUN+="/bin/chmod 666 /sys/class/backlight/%k/brightness"' \
  | sudo tee /etc/udev/rules.d/99-backlight.rules
```

then reboot. `netd.py` says which it found at startup:

```
[netd] backlight: rpi_backlight at 100%
[netd] backlight: NO - present but not writable
[netd] backlight: NO - none exposed
```

The helper floors it at 5% and never writes zero. A helm you cannot see is
a helm where you cannot find the slider to turn it back up.

## Touch lock

A small padlock in the same place on every page - just above the page
dots, at the foot of the screen. The dial's copy is drawn in the SVG at
the matching y rather than as an HTML button: the face is a 1080 viewBox
over a 1080 stage, so the coordinates line up exactly and it scales with
the dial in windowed mode. **Hold it for two seconds** and the helm locks.
Hold anywhere for two seconds and it unlocks.

Both directions are the same deliberate act, so there is nothing to learn
twice, and both draw the same indicator: a ring sweeping round the whole
bezel. At 1080 across it is unmistakable from the other side of the
cockpit, and it makes an accidental brush obviously not a lock.

Why it exists: spray and rain generate touches on capacitive glass, and a
wave should not be able to change the shallow alarm or drop the hotspot.
Two seconds is the one gesture weather cannot produce.

The overlay swallows every pointer event and paints nothing over the
instruments. **Locked is read-only, not blank** - you still need depth and
speed while the boat is being rained on. It does not survive a reload,
deliberately: being locked out by a crash would be worse than the problem
it solves.

The icons are state, not instruction, and they follow it: the overlay is
transparent, so all three page buttons stay in plain sight while the helm
is locked, and a shackle still hanging open under a locked screen would
simply be wrong. They close and take the accent colour when locked.

**There is no badge.** A `HOLD TO UNLOCK` card used to appear on every
touch of a locked screen. It was one more thing between you and the
instruments, and it was saying what the shut padlock at the foot of the
page already says. Locked reads as an instrument panel now, not as a
padlock you have to look past.

Everything that binds the hold stops propagation as well as preventing
default. These sit on top of the gesture handler, and without it a hold
that wanders a few pixels reads as a swipe - and a locked screen happily
opens panels behind itself, which is what the first version did.

## Alerts

One surface for anything that needs attention, so the next thing to raise
one - anchor drag, low battery, an adapter that vanished - does not have
to invent its own way of saying so.

```js
alertRaise('depth','alarm','SHALLOW · 15 FT','ALARM SET AT 40 FT');
alertClear('depth');
```

Two levels. `alarm` wakes the screensaver, `warn` does not. The banner
shows the worst unacknowledged alert; tapping snoozes it for ten minutes
while the condition stays live underneath and says so again when the
snooze expires.

The shallow alarm is its first customer, and moving it exposed a real bug:
it used to be a class toggle inside the dial's DRAW gate, so it **did not
run at all while the map or the music panel was open** - precisely when
nobody is watching the number. Alerts are evaluated in DATA, which always
runs, and the banner sits above the panels and the screensaver so it is
visible wherever you are.

Alert text carries whole units rather than tenths on purpose: to a tenth
the banner would rewrite itself several times a second for no added
meaning.

## Power

Two tiers, not a list. Three actions that give the panel back in seconds
across the top; a rule; then the two that take the instruments off a
boat which may be moving, in the alarm colour.

**The split is the information.** A list treats all five as equals and
they are not, and the structure is read before the words - which is the
moment it matters. Night mode is a single red hue, so that distinction
cannot rest on colour: the rule and the position under it carry it.

It also fixes what was there before. Five 112 px rows do not fit a 448 px
window, so **Shut down had fallen off the bottom** - behind a pager that
never worked on this sheet, because `▲`/`▼` page `NET.rows`, which is
empty for power actions. Both arrows looked live and did nothing. The
pager is now hidden here outright, and `SCAN` with it: that belongs to
the Wi-Fi and Bluetooth pickers this sheet shares markup with and has
never done anything on this one.

Names are one word (`short`), because the confirm screen every action
already passes through is where the full sentence belongs. The sub line
under each row is gone.

Two things to know if you touch this:

- **The index is into `powerActions()`, not into either tier.** The
  tiles carry it and `netTap()` reads it back, so splitting the render
  without splitting the numbering is exactly how the wrong action fires.
- `#ns-list` takes the `tiers` class here, which drops its fixed 448 px
  height and adds the 26 px of air under the head rule that stops the
  first row of tiles touching it. Without the height change `DONE` sits
  stranded 108 px below the tiles.

The uptime line reads **`DEVICE RUNTIME: 3D 4H`**. It used to say
`UP 3D 4H`, which is `uptime(1)` shorthand on a sheet read by someone
who has never met that command. Both places that draw it go through
`runtimeTxt()`, so they cannot drift apart.


A fourth button sits right of Bluetooth, and it is deliberately never
lit: the radios show a state, this one is a door.

| | |
|---|---|
| Reload the app | the page reloads where it stands; nothing is killed |
| Restart helper | kills `netd.py`; `netd.sh` brings it back |
| Reboot | `systemctl reboot` |
| Shut down | `systemctl poweroff` |

Least destructive first, because the top of a list is where a hurried
finger lands and that should not be the shutdown.

The power sheet has no pager at all. It used to share the radios' fixed
four-row window, which meant a fifth action pushed **Shut down** onto a
second page - and for a while onto a second page with no way to reach
it. Rather than fix the pager, the sheet was rebuilt as two tiers that
size to their contents: the safe actions above, the destructive ones
below a rule, everything visible at once. `renderRows()` hides the
radios' pager whenever it is drawing this sheet.

The radios still use the four-row window and still page, because a scan
can turn up thirty networks and no layout shows those at once.

The first one is a page reload rather than a browser restart, and that is
deliberate twice over. It can only be tapped on a page that is alive, and
a live page needs nothing heavier. And killing Chromium there is actively
wrong when another window owns the browser profile - see below.

This exists mostly for the last one. Cutting power to a running Pi is the
usual way an SD card dies, and the helm has no keyboard - so until now the
only clean shutdown was over SSH, from a phone, over the hotspot the Pi
itself is running.

Every action gets a full confirm screen with CANCEL and CONFIRM, not the
second-tap the hotspot uses. A mis-tap there costs the boat its network; a
mis-tap here costs it every instrument at once.

`poweroff` and `reboot` go through logind, which polkit grants to a local
*active* session without a password - the same reason `netd.py` runs from
the desktop session rather than a systemd unit. Run from SSH they come
back `Interactive authentication required`, and the panel says `NOT
PERMITTED FROM HERE` rather than appearing to work.

Those two run inline rather than deferred, unlike everything else here
that kills the browser mid-request. `systemctl` returns as soon as logind
has accepted the job, and running it inline is the only way a refusal can
be reported at all - deferred, it would look exactly like success. The
flip side is that a *successful* shutdown may take the helper down before
its reply arrives, so silence from those two is treated as `GOING DOWN…`
rather than an error.

**Restart helper only comes back if something is supervising it.** Started
from `~/.config/autostart/`, `netd.sh` relaunches it after five seconds.
Started by hand with `nohup`, nothing does, and the radio controls stay
gone until you start it again.

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

## Boot

The kiosk used to come up on a bare dial: every reading empty until
Signal K connects, which looks identical to a broken panel. `#boot`
covers that with the boat's own name over three currents, which collapse
into a single accent line when the boat starts talking.

It is **in the document, not built by script** — it has to be on the
glass at first paint, which is before any of this file's JavaScript has
run.

**It sits under the veil** (`z-index:85`, veil is 90) rather than above
it. A splash above the veil ignores the brightness setting, so a panel
left at 25% would come up at full brightness at night and cost you your
night vision. Dimming the splash with everything else is the point.

**Nothing under it may paint, not for one frame.** `#stage` carries a
`booting` class and the stylesheet hides every child but the splash and
the veil:

```css
#stage.booting > :not(#boot):not(#veil){visibility:hidden}
```

`z-index` alone is not enough. It settles what is on top *once both
exist*; it says nothing about a frame composited while the parser is
still in the middle of this file, and the dial's markup comes first. The
stylesheet is applied before any body content renders, so the rule holds
from the very first frame regardless of paint timing.

`visibility`, not `display`: the pages still have to lay out and measure
during init — `layoutPages()` reads their widths, and
`getComputedTextLength()` needs real boxes. `#veil` is exempt so the
brightness setting still dims the splash. The class comes off as the
splash begins to fade, so the dial is revealed already drawn.

`#boot` is also the first child of `#stage` rather than the last. That
is belt to the rule's braces, and **only** belt: a flash of the dial
before the splash was reported from the boat, and it could not be
reproduced here even with a screencast of every composited frame and the
document deliberately stalled for 1.2 s mid-parse. Moving it made no
measurable difference in that test. Do not rely on document order.

**It clears on real data, not on a clock.** `bootReady()` is called from
`skMessage()`, bounded both ways:

- `MIN` 1.9 s — the intro needs that long to arrive, and on a warm
  restart data can beat it. Clearing early would be a flash, not a
  sequence.
- `CEIL` 6 s — Signal K might never answer. A splash that waits forever
  for it is a bricked panel.

**Do not hook it to `put()`**, which is the obvious place and the wrong
one: `windDemoTick()` calls `put()` four times a second whether or not
anything is connected, so a splash keyed off `put()` clears itself on a
Pi with no Signal K at all and reports a boat that is not there.

`.bt-wave` needs `transform-box:fill-box`. Without it every `scaleY`
happens about the SVG origin rather than each wave's own centre, and the
three collapse onto the *top* of the panel instead of onto each other.

The waves are generated, not hand-authored — 361 points of path data is
not something to keep by hand, and the three differ by four numbers.
They are drawn across 2160 so a −1080 drift loops seamlessly, which
needs every wavelength to divide 1080 exactly: 360, 540, 270.

### Palette before the first paint

Everything else in this file runs from the bottom of `<body>`, so the
panel used to come up in the **day** palette and snap to dusk or night a
moment later. At the end of a deliberately dark boot chain, that white
frame is the one thing you actually notice.

A short script at the top of `<body>` restores the palette before
anything renders. It reads `helmTheme` — the *resolved* theme, written
by `applyTheme()` on every change — so it is a restore, not a
calculation: no sun tables, no GPS, nothing that could be slow or throw.
Stored separately from `helmPrefs` on purpose, so the pre-paint read is
one `getItem` with no JSON parse.

First boot ever has nothing stored and assumes dusk. Of the two possible
wrong guesses, a dark panel that brightens is the forgivable one.

## The rest of the boot chain

`#boot` is the **last** screen of seven. `boot/` claims the other six:

| Stage | What you saw | Now |
|---|---|---|
| Firmware | the rainbow square | `disable_splash=1` |
| Kernel | four raspberries, console text | `logo.nologo quiet loglevel=3` |
| Plymouth | the raspberry logo and dots | the Confluence theme |
| Session | desktop wallpaper | painted `#0B0C0E` |
| `start-kiosk.sh` | whatever was behind it, waiting for AvNav | same colour behind it |
| Chromium | a white flash | `--default-background-color=FF0B0C0E` |
| **The app** | — | **`#boot`** |

```bash
sudo bash ~/helm/boot/install-boot-chain.sh    # then reboot
sudo bash ~/helm/boot/uninstall-boot-chain.sh  # puts it all back
```

Everything it touches is backed up alongside the original with a
`.confluence-bak` suffix.

**If it boots black, nothing is bricked.** Power off, put the card in
another machine, and on the small FAT partition rename
`cmdline.txt.confluence-bak` back over `cmdline.txt`. That is the whole
recovery — the file is one line of plain text.

### Poppins

The app has always asked for Poppins and the Pi has never had it, so
every reading on that panel has been rendering in DejaVu. The installer
fixes that, which also means the splash and the app are in one face.

The three TTFs in `boot/fonts/` are Google's static files with one
change: they ship with the family name **"Poppins Light"**, which
nothing matches against `font-family:'Poppins'` — installing them
untouched changes nothing at all. The typographic family (name ID 16)
and subfamily (17) have been set so the three group into one weighted
family. `fc-match "Poppins:weight=light"` returning a Poppins file is
the test that it worked.

### The mouse pointer

`boot/cursor/` is a cursor theme whose pointer is a single transparent
pixel, installed as `/usr/share/icons/Confluence-blank`.

A theme rather than `X -nocursor` because **X11 and Wayland both resolve
pointers through Xcursor themes**, and Raspberry Pi OS could be running
either. `-nocursor` is more absolute but exists only under X, so the
installer adds it as a LightDM drop-in *as well* when it detects an X
session, and says which it found.

**Setting `XCURSOR_THEME` is not enough on its own**, and this is the
part that kept the pointer coming back. cage hands wlroots a NULL theme
name, and wlroots resolves NULL to the theme literally called `default`
— it does not consult `XCURSOR_THEME` for that. If no theme called
`default` resolves to something blank, wlroots draws the arrow compiled
into itself, and you get a pointer for the whole gap between Plymouth
quitting and Chromium's first paint. So both routes are set up:
`cage-session.sh` exports `XCURSOR_THEME` (and `XCURSOR_PATH`), and the
installer makes `default` resolve to the blank theme too.

That second half goes through `update-alternatives --set x-cursor-theme`,
because `/usr/share/icons/default/index.theme` is the tail of that chain
on Debian and writing to the path writes *through* the symlinks into a
package-owned file. If the alternative cannot be set — most likely on a
Pi where an earlier version of this script already replaced the link
with a plain file — the installer falls back to writing the file itself
and says so. It used to swallow that refusal and report success.

The theme's `index.theme` carries `Inherits=Confluence-blank`, naming
itself. That looks like a mistake and is not: read through the
alternatives symlink at `/usr/share/icons/default/index.theme` there is
no `cursors/` directory alongside the file, so the `Inherits` line is
the only thing that sends the lookup back to the real theme. Debian's
own DMZ-White does exactly the same.

The theme is installed by **`boot/install-cursor.sh`**, which both
installers call and which is safe to run on its own:

```bash
sudo bash ~/helm/boot/install-cursor.sh      # and reboot
```

It is its own script because both installers need it and neither owns
it. It used to be a step inside `install-boot-chain.sh`, while the thing
that actually depends on it — `cage-session.sh`, which exports
`XCURSOR_THEME=Confluence-blank` — is installed by
`install-cage-kiosk.sh`. So a Pi could have the entire cage kiosk set
up, naming a theme that had never been put on the disk, and the only
symptom was an arrow on the glass at every boot with nothing anywhere
saying why. That is exactly what happened.

**To find out whether the pointer will be drawn:**

```bash
python3 ~/helm/boot/check-cursor.py -v
```

It resolves a theme name the way libxcursor does — same search path,
same `Inherits` chain, same sanity checks on the binary — and reports
whether the cursor it lands on is fully transparent. Exit status 0 means
no pointer. `cage-session.sh` runs it at every start and writes the
answer to `/tmp/cage-session.log`, so a boot that shows a pointer says
why in the log rather than leaving you to guess.

`make-blank-cursor.py` writes the Xcursor binary directly rather than
depending on `xcursorgen` being installed - it is a 16-byte header, a
table of contents, and one 1x1 ARGB pixel per nominal size.

### What is still visible, and why

`start-kiosk.sh` waits for AvNav to answer before it launches Chromium,
and the desktop is what is on screen during that wait. The wait is the
gap, and nothing in this repo shortens it.

What the boot chain does is make that gap unremarkable: the desktop is
painted the same `#0B0C0E` as the splash and there is no pointer, so it
should read as a pause rather than as a different screen. Anything in
`~/Desktop` still shows through - move those to
`~/.local/share/applications` to keep them in the menu without putting
them on the desktop.

Removing the gap outright means not having a desktop session at all.
That is what `boot/install-cage-kiosk.sh` does - see below.

## Cage mode

`boot/install-cage-kiosk.sh` replaces the desktop with a
[cage](https://github.com/cage-kiosk/cage) session, so the Pi goes from
the Plymouth splash straight to the helm app with nothing in between.

```bash
sudo apt install cage
sudo bash ~/helm/boot/install-cage-kiosk.sh     # then reboot
sudo bash ~/helm/boot/uninstall-cage-kiosk.sh   # puts the desktop back
```

**What it gives up.** cage runs one maximized application, so the
windowed copy, the FULL/KIOSK tile and the desktop shortcut all stop
meaning anything.

**What it has to arrange, because cage does not.** Cage reads no
`~/.config/autostart`, so the two things that lived there - `netd.sh`
and `autopull.sh` - would simply never start. `cage-session.sh` starts
them itself.

**Why it is a tty1 login and not a systemd unit.** This is the one that
would be invisible until a new marina. NetworkManager's polkit rules
grant a local *active* session the right to change networking without a
password. A login on tty1 is a real logind session on seat0, and it is
the foreground one, so netd inherits that. Under a system-level unit
there is no session at all, and every join would come back
`Interactive authentication required` - indistinguishable from a dead
dongle. So the installer sets up autologin on tty1 and hooks
`~/.bash_profile`; the hook fires only on tty1 and only when no display
is already running, so ssh and a running desktop are unaffected.

**`cage -s`.** VT switching has to be allowed or the Desktop tile cannot
work - starting a display manager needs another VT to switch to.

### Fitting the desktop's corners into the circle

A square desktop on a round panel loses its four corners: the ends of the
taskbar, the clock, the close buttons. So **Desktop fits them itself** —
there is no separate button, because a desktop you cannot reach the
corners of is not what anyone means by tapping Desktop. Kiosk puts the
screen back before it stops X. The shrink makes the desktop the largest
square that fits *inside* the circle, with black around it.

Nothing is armed on that path: a revert would undo the thing the tile was
tapped for. If a fit ever goes wrong the way back is a reboot, which
brings cage up on a fresh X server, or one line over SSH:

```bash
xrandr --output HDMI-1 --transform none --fb 1080x1080
```

**The largest square inside a circle of diameter D has side D/√2** — about
70.7%. On this 1080 panel that is 762px (rounded even so the margins
match), 159px of margin on every side, and a desktop corner lands at
radius 538.8 against the glass's 540.

The transform maps **output** pixels to **framebuffer** pixels, so
shrinking the desktop means scaling *up*: the output samples a region
larger than itself and the framebuffer lands in the middle of it. With
side `s` and margin `t = (w-s)/2`, output `t` must sample framebuffer `0`
and output `w-t` must sample framebuffer `w`, which gives `a = w/s` and
`c = -a·t`:

```
xrandr --output HDMI-1   --transform 1.417323,0,-225.354,0,1.417323,-225.354,0,0,1   --fb 1080x1080
```

#### `--fb` and `--panning`: the desktop, not just the picture

A transform that shrinks the *picture* makes the output sample a
framebuffer region **larger than itself** — 1080 × 1.417 = 1531 here —
and xrandr sizes the screen to cover that. The letterbox then looks
exactly right while the desktop behind it is half again too wide, so its
right-hand edge, where a taskbar keeps the clock and the tray, is off the
glass. All four corners of the *panel* are visible and the desktop is
still cut off, which is a genuinely confusing thing to look at.

`--panning WxH+0+0` pins the CRTC's area to the panel instead of letting
the transform dictate it. It goes on with `--fb`, and if this xrandr will
not take it the plain `--fb` form is used and the **screen size is read
back and reported** — `oversize` in `/status`, and a log line saying so —
rather than left to be discovered by something going missing off the
right-hand side.

`--fb` pins the desktop to the panel's own size, and it is **not
optional**. Without it xrandr grows the screen to cover the transformed
output's extents and the desktop gets *bigger* rather than smaller: you
see its top-left and bottom-left corners and the other two are off the
glass.

There used to be a fallback that dropped `--fb` when it was refused, and
that was worse than failing — it produced a picture that looks deliberate
and is wrong, with no way to tell from the panel which of the two you
were looking at. A refusal now reverts and says `SCREEN REFUSED`.

`--transform none` carries `--fb` too, and that is not belt and braces:
`none` alone does **not** shrink the screen again. xrandr grew it and
leaves it there, so the next fit starts from a screen half again too big.

#### And the desktop's panel has to be told

lxpanel spans the screen width and does not re-read it, so after a resize
its right-hand end stays wherever the old width put it — the same clock,
missing for a second reason. `lxpanelctl restart` after a fit is cheap,
comes back on its own, and is the difference between a fitted desktop and
a fitted desktop you can read the clock on. A Pi without `lxpanelctl`
just carries on.

#### Read the size from the mode, never from the geometry

```
HDMI-1 connected primary 1531x1531+0+0 ...     <- the CRTC's extent
   1080x1080     59.99*+                       <- the panel
```

Those two are the same number until a transform is applied and different
afterwards. Reading the size off the `connected` line meant a second fit
computed from 1531 instead of 1080 — and a desktop scaled for a panel
half again too big shows you its left-hand corners and hides the other
two. The starred mode line is the panel's real pixel size and never
changes, so that is what is parsed.

**X11 only.** `wlr-randr` has no transform, so on Wayland there is no live
equivalent and netd reports nothing available — neither tile appears
rather than a tile that does nothing.

netd **discovers** the X display rather than reading it: it may have been
started by `cage-session.sh`, which has no `DISPLAY` at all, so it tries
`:0` and `:1` against each home's `.Xauthority` until one answers. Same
approach as the probe below, for the same reason. A negative is cached
briefly too — on a Wayland or cage Pi this would otherwise shell out
twice a second for an answer that is always no.

#### The touchscreen has to move with the picture

`xrandr --transform` moves the **output**. It does not move the **input**:
an absolute device still maps its own [0,1] square onto the whole
framebuffer, so once the desktop is shrunk into the middle of the glass,
every touch lands somewhere it is not — offset *and* scaled. That reads
as "the pointer clicks in the wrong place", and it is the reason this is
done by the same call rather than left as a separate step.

X11's fix is the device's **Coordinate Transformation Matrix**, set to
the same map the output got. A touch at panel pixel `p` should reach
framebuffer `f = a·(p − t)`. The CTM works in *normalised* coordinates,
so X computes `f = w·(m00·(p/w) + m02)`; equating the two gives
`m00 = a` and `m02 = −a·t/w`, which simplifies to `−(w−side)/(2·side)`:

```
xinput set-prop <id> "Coordinate Transformation Matrix"   1.417323 0 -0.208661  0 1.417323 -0.208661  0 0 1
```

**Only absolute devices**, and that is not a detail: the same matrix on a
mouse does not reposition it, it multiplies every movement — so a fitted
desktop would come with a pointer that flies off the screen. `Mode:
absolute` on a valuator is what separates them, and the test asserts that
a relative device is left alone.

If the remap cannot happen — no `xinput`, no touch device — the fit still
applies but the keep sheet **leads with that** rather than the size. A
picture that looks right and answers taps somewhere else is the worst
failure this feature has, because the first tap you would make to fix it
is the one that does not land. `check-display.py` reports every pointer
device, its mode, and its current matrix.

#### Single tap, double tap

```bash
python3 ~/helm/boot/touch-tune.py            # apply
python3 ~/helm/boot/touch-tune.py --show     # what is set now
python3 ~/helm/boot/touch-tune.py --revert   # put it back, exactly
```

GTK decides "that was a double click" from two thresholds: how long
between the taps, and **how far apart they were**. The default distance
is **five pixels** — a sensible number for a mouse, which does not move
at all between clicks, and a hopeless one for a finger on glass. Two
deliberate taps in the same place routinely land 15–25px apart, so GTK
scores them as two separate single clicks and nothing opens. People then
tap harder and faster, which makes the spread worse.

So the distance is the fix and the time is the smaller half: **30px and
500ms**. It writes `~/.config/gtk-3.0/settings.ini` and `~/.gtkrc-2.0`,
keeps a byte-for-byte backup so `--revert` is a restore rather than a
guess at defaults, and takes that backup **once** — a second run must not
record its own first run as the original, which is the same trap
`install-cage-kiosk.sh` documents about the default systemd target.

The keys must land *inside* `[Settings]`. A key appended after some other
section belongs to that section and GTK never sees it, so the writer
rewrites in place and the test checks the position, not just the
presence.

It deliberately does **not** turn on single-click-to-open. That would
make both gestures do the same thing, and the point is to keep them
telling apart: one tap selects, two open.

GTK reads these when an application *starts*, so nothing already running
changes. Tap Desktop then Kiosk, or log out and back in, before judging
it.

#### `fitted` is read back, never remembered

Out of `xrandr --verbose`, every time.
autopull kills netd on every push, and a remembered flag would come back
saying "full size" over a desktop that is still shrunk.

`POST /display/fit {"pct": 70.7}` still exists and still arms a
25-second revert when called by hand — that path has no tile any more,
but it is the right way to try a different size over SSH without being
able to see the result.

### Which display stack is actually driving the panel

```bash
python3 ~/helm/boot/check-display.py      # while the DESKTOP is up
```

Read-only — it starts nothing, stops nothing, changes nothing. It exists
because the two stacks have nothing in common where display geometry is
concerned, and a wrong guess at the helm is a black screen.

It identifies the stack by **which compositor is running**, not by this
shell's environment, and that is the point: over SSH there is no
`WAYLAND_DISPLAY` or `DISPLAY` to read, so an env check alone reports
"neither" on a Pi that is plainly running one. It also reports the panel
as the *kernel* sees it (`/sys/class/drm`, true under either stack), what
`xrandr` or `wlr-randr` can reach, and any `video=` already set in
`cmdline.txt`.

`xrandr` is only ever called with `--query` and `wlr-randr` only with no
arguments — both read-only forms, and the test asserts it.

Two things it will tell you that are easy to get wrong:

- **cage is running** → this is kiosk mode, not desktop mode. The answer
  would be about the wrong thing, so it refuses and tells you to tap
  Desktop first.
- **Xwayland is up** → that is a decoy. It draws *into* the Wayland
  compositor, so `xrandr` against it will not reshape the real output.

### And back to the kiosk

The Desktop tile used to be a **one-way door**: the only way back to the
kiosk was a reboot or SSH, and at the wheel you have neither. So the
power sheet now carries a **Kiosk** tile, and the two are exact mirrors —
netd offers `desktop` when no desktop is running and `cage` when one is,
so there is always exactly one way out of wherever you are and never
both.

Going out is easy; coming back is not, and the asymmetry is the design.
Cage **cannot** simply be launched from the root helper. It has to run in
the login session on tty1, because NetworkManager's polkit rules grant a
local *active* session the right to change networking without a password
— and a cage started from a root helper has no session at all. Every WiFi
and Bluetooth tile would come back dead, which looks exactly like a
broken dongle and is not. (Same trap as the top of `cage-session.sh`,
from the other side.)

What actually gets you back is the mechanism that started cage in the
first place: agetty autologins the owner on tty1, the login shell reads
its profile, and the hook there runs `cage-session.sh`. So
`to-cage.sh` stops the display manager and then **restarts
`getty@tty1`**, which replays exactly that. It also closes the desktop's
windowed app on the way — left running it would still own the browser
profile, and cage's Chromium would sit waiting for a window on a desktop
that no longer exists.

Everything is verified **before** anything is torn down — cage installed,
the tty1 autologin drop-in present, and the launch hook actually in the
owner's profile — because stopping the desktop and *then* discovering the
kiosk cannot start would leave the panel on a bare console. And if cage
does not come up within ten seconds, the display manager is started again
rather than leaving black glass with SSH as the only way in. The tests
drive all five of those paths.

### Getting back to a desktop

A **Desktop** tile appears in the power sheet, and only in cage mode:
netd offers it when a display manager exists *and* nothing graphical is
already running, so on an ordinary desktop it stays hidden rather than
being a button that throws you at a login screen.

**The kiosk has to stop first.** Starting a display manager alongside a
running cage session leaves two things wanting the same seat, and what
you get is a display server with no session on it: **a black screen with
a pointer and no panel**. And the supervisor has to go before the
compositor, or it simply launches another one. `to-desktop.sh` does it
in that order, and checks the display manager unit exists *before*
tearing anything down - killing the kiosk and then failing to start a
desktop would leave the panel on a bare console.

logind hands a local active session `reboot` and `poweroff` for free but
not starting an arbitrary unit, so the tile needs one sudoers line:

```
pi ALL=(root) NOPASSWD: /usr/local/sbin/confluence-to-desktop ""
pi ALL=(root) NOPASSWD: /usr/local/sbin/confluence-to-cage ""
```

Three things about that line. The script is installed **root-owned
outside `$HOME`** - a NOPASSWD grant on a script in the user's own home
is a way to become root by editing it. The trailing `""` restricts the
grant to that command **with no arguments**. And it is written to a temp
file and **checked with `visudo -cf` before installing** - a malformed
sudoers file locks you out of sudo.

`sudo -n` at the call site, so a missing rule fails at once instead of
hanging on a password prompt nobody can answer at the helm; the panel
then says `NOT PERMITTED FROM HERE`.

### The login banner

Between Plymouth and cage, tty1 used to print this:

```
Linux openplotter 6.6.31+rpt-rpi-v8 ... aarch64
The programs included with the Debian GNU/Linux system are free software;
...
Last login: Tue Aug 25 10:42:48 2026
```

**None of that is kernel output**, which is why `quiet` and `loglevel=3`
never touched it. It is the login banner, and it has three separate
sources:

| Line | From | Switch |
|---|---|---|
| the `uname` line, the warranty text | the MOTD | `~/.hushlogin` |
| `Last login:` | `login(1)` | `~/.hushlogin` |
| whatever is in `/etc/issue` | `agetty` | `--noissue` |

`login(1)` checks for `.hushlogin` by name - `HUSHLOGIN_FILE` in
`/etc/login.defs` - and prints neither the MOTD nor the last-login line
when it is there. The installer creates it, and records that it did, so
the uninstaller removes only a file it created and leaves one you wrote
yourself alone.

The installer also moves `console=tty1` to `console=tty3` in
`cmdline.txt`, so whatever the kernel and systemd still have to say goes
to a tty nobody is looking at rather than onto the panel. Reversed by
the uninstaller, and the edit goes through the same guarded python as
the rest: single line, `root=` still present, or it refuses to write.

### If it will not come up

`cage-session.sh` starts the desktop by itself after five failed
launches, so a Pi that cannot run the kiosk lands on a desktop rather
than on nothing. It also tries Chromium **twice**: with
`--ozone-platform=wayland` and, if that exits immediately twice,
without. Being wrong about that flag would otherwise be a black panel
on a boat.

The AvNav wait is bounded (60 s) unlike the desktop version's, because
in cage mode there is nothing behind it to look at - waiting forever
would mean a black screen forever. After the timeout it starts anyway
and the app's own splash covers the retry.

### The Plymouth theme

`boot/theme/` is a `script`-plugin theme. Three wave strips and a
wordmark, drifting on the same periods as `#boot` — no frame sequence,
because a 12-second loop at 1080² would be hundreds of megabytes and the
sprite translate is what the CSS is doing anyway.

Same trick as the app: the strips are 2160 wide with wavelengths that
divide 1080 exactly, so sliding one full 1080 to the left lands on an
identical frame and a single sprite loops seamlessly.

Two things the assets have to match or the handoff shows a jump:

- **`dominant-baseline:middle`.** The app sets it on every `<text>`
  globally, so `y=392` is the type's *middle*, not its baseline. Missing
  it put the splash wordmark 22 px above the app's.
- **The wordmark crop.** `render-assets.mjs` writes a full-panel
  transparent PNG and then crops it to the band the type occupies — a
  1080×1080 transparent image costs 4.7 MB of RAM at boot to hold mostly
  nothing. The crop's top offset and height are hard-coded in
  `confluence.script`; regenerating the assets means updating both.

Verified by reimplementing Plymouth's sprite model in a browser from the
script's own numbers and diffing the composed frame against the app's:
the wordmark comes out pixel-identical and the waves agree to within
antialiasing. That proves the arithmetic, **not the script's syntax** —
Plymouth itself cannot be run anywhere but the Pi.

### What is still not seamless

Plymouth cannot know what the app will resolve to, so the splash is
always the **dusk** palette. Boot into day and there is one dark-to-light
step at the app. Fixing it properly means teaching the installer to
render a day variant and something to choose between them at boot, which
is a lot of machinery for one frame.

## Getting a track onto a phone

The race library is IndexedDB, which is **per origin and per device**. A
phone opening the same page gets its own empty library — none of the
races the kiosk recorded are in it. So exporting on the helm used to
mean a `.gpx` in the Pi's `~/Downloads`, where nothing can reach it.

The track now goes the other way. `⤓` on the track page POSTs the XML to
`netd`, which writes it into `~/avnav/data/user/helm/gpx/` — a folder
**AvNav already serves**, at `/user/helm/gpx/<name>.gpx`. Any device on
the boat WiFi can fetch it; on iOS it lands in Files, and the share sheet
from there reaches SailTies, HealthFit and anything else that eats GPX.

Publishing raises a **QR code** of that URL, because the remaining
problem was never the file — it was getting the phone to the address.
Point the camera at the helm and Safari does the rest.

- `index.json` is rewritten beside the files on every save, so the app
  can list them without a directory listing.
- The library reads that index **from AvNav, not from netd** — netd is
  loopback-only and a phone cannot reach it. Same origin as the app, so
  the same code works in a pocket and at the helm.
- The library shows two sections. *On the boat* rows are plain links: on
  a phone a tap downloads, on the helm a tap raises the QR instead
  (a download there would just land in the Pi's own Downloads).
- With no helper — i.e. on a phone — `⤓` falls back to the old Blob
  download, which is what that device wanted anyway.
- Names are rebuilt from `[A-Za-z0-9._-]` on the way in. A race title is
  typed at the helm and ends up as a path, so no slash survives it.

### Two networks, one code

The Pi usually has two addresses: the hotspot it runs for the boat and
whatever marina network the dongle joined. The code leads with the
**hotspot**, since a phone at the helm is on it — but a phone on the
shore network cannot reach `10.42.0.1` at all, so **tapping the code**
cycles to the other address. Tapping anywhere else puts the sheet away.

### The QR encoder

Written into the file rather than pulled in, because this file has no
dependencies and gets none. Byte mode, error correction **M**, versions
1–10; a URL with a long race name is about 75 bytes, which is version 5.
Past version 10 it returns `null` and the sheet shows the plain URL to
type instead.

Verified by decoding, not by inspection: every version boundary 1–10
plus multibyte UTF-8 round-trips through OpenCV's detector, and the
rendered sheet still decodes shrunk to 190 px, blurred, rotated 45°,
under perspective, and with a specular highlight across one corner.

**`netd`'s POST body cap used to be 4 kB.** Bodies were WiFi passwords
when that number was chosen; a track is a hundred times that, so it
arrived truncated, failed to parse, and reported itself as empty. The
cap now follows `GPX_MAX`.

**A flash in the track page's status line has to hold the slot.**
`paintTrack()` rewrites that text four times a second, so `trkFlash()`
sets a deadline that `paintTrack()` checks rather than just writing into
it.

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
- The panel's empty state - no radios, and the display tile reading
  `FULL / OFF` - is exactly what the release *before* the radios looked
  like. So a slow first `/status` does not read as "waiting", it reads as
  "the old version loaded and then corrected itself". It is worth knowing
  that those two are indistinguishable by eye: the build stamp is the
  test, because it does not change during the flash.

  Two things keep it from happening. The app asks at boot rather than on
  first panel open, so the answer is there before anyone swipes up. And
  `netd.py` serves cached answers while refreshing behind them, rather
  than expiring and making the next poll pay again - `/status` went from
  about two seconds to under ten milliseconds, most of it Bluetooth.
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
