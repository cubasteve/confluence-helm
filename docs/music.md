# Music

Spotify without a Connect daemon: what polls, what it may do, and what it deliberately will not.

[← back to the README](../README.md)

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
