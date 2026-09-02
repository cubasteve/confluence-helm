# Internals

How the app is put together, where its data lives, and the traps that have caught this codebase before.

[← back to the README](../README.md)

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
