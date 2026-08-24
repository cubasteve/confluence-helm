# Confluence Helm

Instrument display for the club racing boat *Confluence*. One self-contained
HTML file, no build step, no dependencies — it runs in Chromium on a
1080×1080 round panel at the helm.

## Layout

```
confluence_helm.html      the whole app: markup, CSS, JS
start-kiosk.sh            what the desktop session launches at boot
deploy.sh                 publishes the app to where AvNav serves it
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
- The Spotify config at `~/.config/confluence-spotify.json` holds a client
  secret and refresh token. It should be `0600`.
- Chart tiles and the track library live in **browser storage**, which is
  per-origin. Moving between `file://` and `http://` starts both empty.
