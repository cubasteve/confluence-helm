# Kiosk, boot and power

How the Pi gets from cold to a helm display, and what keeps it there.

[← back to the README](../README.md)

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
