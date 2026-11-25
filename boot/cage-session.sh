#!/bin/bash
# =====================================================================
# The whole graphical session, when the Pi runs cage instead of a
# desktop.
#
# Started from the login shell on tty1, and that is not incidental:
# NetworkManager's polkit rules grant a local ACTIVE session the right
# to change networking without a password. A login on tty1 is a real
# logind session on seat0 and it is the foreground one, so netd
# inherits that. The same script under a system-level systemd unit has
# no session at all, and every attempt to join a network would come
# back "Interactive authentication required" - which looks exactly like
# a dead WiFi dongle and is not.
#
# It also has to do by hand what the desktop session used to do for
# free: cage reads no ~/.config/autostart, so netd, autopull and the
# now-playing poller are started here or not at all. Every feature whose
# starter lives in an autostart entry is invisible to cage, and each one
# that has been forgotten failed the same way - silently, looking like
# the feature simply had nothing to show.
# =====================================================================
set -u

REPO="${REPO:-$HOME/helm}"
URL="${URL:-http://localhost:8090/confluence_helm.html}"
LOG="${LOG:-/tmp/cage-session.log}"
DM="${DM:-lightdm}"
GOOD_RUN="${GOOD_RUN:-20}"            # a session shorter than this is a failure
WAIT_AVNAV="${WAIT_AVNAV:-60}"        # seconds before starting anyway
: "${CAGE:=cage}" "${SYSTEMCTL:=systemctl}"
# Raspberry Pi OS names the browser chromium-browser; Debian, and a
# fresh Trixie image, name it chromium - the same lookup as
# start-kiosk.sh. Still overridable from the environment.
if [ -z "${CHROME:-}" ]; then
  for c in chromium-browser chromium; do
    command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
  done
  : "${CHROME:=chromium-browser}"   # keep the old name so the failure log says what was tried
fi

log(){ printf '[cage] %s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }

# The blank pointer theme, so cage draws no cursor either.
#
# XCURSOR_THEME is what cage's man page tells you to set, and it is set
# here - but it is NOT sufficient on its own and must not be relied on:
# cage hands wlroots a NULL theme name, and wlroots resolves NULL to the
# theme literally called "default" rather than consulting this variable.
# That is why install-boot-chain.sh also makes "default" resolve to the
# blank theme, and why it verifies that it did.
#
# XCURSOR_PATH is set explicitly so resolution cannot depend on which
# default libxcursor happened to be compiled with.
export XCURSOR_THEME="${XCURSOR_THEME:-Confluence-blank}"
export XCURSOR_SIZE="${XCURSOR_SIZE:-24}"
export XCURSOR_PATH="${XCURSOR_PATH:-$HOME/.local/share/icons:$HOME/.icons:/usr/share/icons:/usr/share/pixmaps}"

# ---- and the pointer CHROMIUM draws ---------------------------------
# The arrow in the middle of the glass after the November 2026 update
# was not cage's at all. cage 0.2.0 offers no cursor-shape protocol, so
# Chromium draws its own pointer and attaches it as a surface - and it
# picks the theme for that from GTK's setting
# org.gnome.desktop.interface cursor-theme (Adwaita unless the desktop
# changed it), NOT from XCURSOR_THEME. cage's own cursor was blank the
# whole time, which is why the line in this log said "hidden".
#
# Every theme NAME anything here can ask for is therefore made to mean
# the blank theme, in a directory of symlinks put first on XCURSOR_PATH:
#   - whatever GTK reports for this user (gsettings), and Adwaita, its
#     default - what Chromium asks for;
#   - "default" - what cage asks for (see above);
#   - "left_ptr" - cage 0.2.0 names its Xwayland cursor THEME "left_ptr"
#     (wlr_xcursor_manager_create(DEFAULT_XCURSOR, ...)), which no theme
#     is called, so wlroots used its built-in arrow for X11 windows.
# libwayland-cursor (Chromium) and wlroots (cage) both read XCURSOR_PATH,
# and cage passes its environment on to Chromium. The directory is in
# the runtime dir: rebuilt every session, gone at power-off, touches
# nothing the desktop session reads - its own pointer is left alone.
#
# Not by changing the setting itself: `gsettings set` would hide the
# pointer on the desktop too, where a mouse may be the way in.
CURSOR_ALIASES="${CURSOR_ALIASES:-${XDG_RUNTIME_DIR:-$HOME/.cache}/confluence-cursors}"
gtk_cursor_names(){
  local n
  if command -v gsettings >/dev/null 2>&1; then
    # Bounded: this runs before cage, and a gsettings that hangs (no
    # session bus yet, a wedged dconf) must not hold the kiosk back.
    if command -v timeout >/dev/null 2>&1; then
      n=$(timeout 5 gsettings get org.gnome.desktop.interface cursor-theme 2>/dev/null)
    else
      n=$(gsettings get org.gnome.desktop.interface cursor-theme 2>/dev/null)
    fi
    n=${n//\'/}; [ -n "$n" ] && echo "$n"
  fi
  for f in "${XDG_CONFIG_HOME:-$HOME/.config}"/gtk-{3,4}.0/settings.ini; do
    [ -r "$f" ] || continue
    sed -n 's/^[[:space:]]*gtk-cursor-theme-name[[:space:]]*=[[:space:]]*//p' "$f" |
      tr -d '"' | head -1
  done
  echo Adwaita
}
alias_cursor_themes(){
  local blank="" d n
  local IFS=:
  for d in $XCURSOR_PATH; do
    [ "$d" = "$CURSOR_ALIASES" ] && continue
    [ -d "$d/$XCURSOR_THEME/cursors" ] && { blank="$d/$XCURSOR_THEME"; break; }
  done
  unset IFS
  if [ -z "$blank" ]; then
    log "no $XCURSOR_THEME theme on XCURSOR_PATH - cannot alias the pointer away"
    return 1
  fi
  # Links only, and never recursively: a stale alias from the last
  # session goes, and a CURSOR_ALIASES pointed somewhere by mistake
  # loses nothing but symlinks.
  mkdir -p "$CURSOR_ALIASES" &&
    find "$CURSOR_ALIASES" -mindepth 1 -maxdepth 1 -type l -delete || {
    log "could not set up $CURSOR_ALIASES - the pointer may be drawn"; return 1; }
  { gtk_cursor_names; echo default; echo left_ptr; } | sort -u |
  while IFS= read -r n; do
    # A theme name is one path component; anything else is ignored.
    case "$n" in ''|.*|*/*|"$XCURSOR_THEME") continue;; esac
    ln -s "$blank" "$CURSOR_ALIASES/$n"
  done
  case ":$XCURSOR_PATH:" in
    *":$CURSOR_ALIASES:"*) ;;
    *) export XCURSOR_PATH="$CURSOR_ALIASES:$XCURSOR_PATH";;
  esac
  log "pointer: theme names aliased to $blank: $(ls "$CURSOR_ALIASES" | tr '\n' ' ')"
}

# The installer's ONLY sudoers grant is the helper below - it is written
# with the display manager already baked in, and it is root-owned so that
# a NOPASSWD grant is not also a way to become root by editing a file in
# $HOME. So try that first. `sudo -n systemctl start lightdm` was never
# covered by any grant the installer writes and worked, when it worked at
# all, only by accident of a stock image's blanket nopasswd rule - and it
# hardcodes lightdm, while the installer probes gdm3 and sddm precisely
# because it may not be.
TO_DESKTOP="${TO_DESKTOP:-/usr/local/sbin/confluence-to-desktop}"
fall_back_to_desktop(){
  log "falling back to the desktop: $*"
  if [ -x "$TO_DESKTOP" ] && sudo -n "$TO_DESKTOP" 2>>"$LOG"; then
    log "handed the screen to the desktop"
  elif sudo -n "$SYSTEMCTL" start "$DM" 2>>"$LOG"; then
    log "started $DM"
  else
    log "could NOT reach a desktop - you have a shell on tty1"
    log "  from here: sudo systemctl start $DM"
  fi
}

# ---- the helpers the desktop session used to autostart --------------
start_helpers(){
  if ! pgrep -f '^python3 .*netd\.py' >/dev/null 2>&1; then
    log "starting netd"
    ( bash "$REPO/netd.sh" >>"$LOG" 2>&1 & ) 
  fi
  if ! pgrep -f 'autopull\.sh' >/dev/null 2>&1; then
    log "starting autopull"
    ( bash "$REPO/autopull.sh" 300 >>"$LOG" 2>&1 & )
  fi

  # The now-playing poller. Same trap the cursor theme fell into: there
  # IS an autostart entry for it, and cage reads no ~/.config/autostart,
  # so under cage it is started here or not at all. Nothing said so - the
  # music page just sat on "Nothing playing", which is also what a real
  # idle Spotify looks like.
  #
  # It needs credentials, and without them it exits at once with a log
  # line. Checking here rather than letting it fail means the reason and
  # the fix both end up in this log instead of scrolling past in its own.
  if [ ! -f "$HOME/.config/confluence-spotify.json" ]; then
    log "no Spotify credentials - the music page will say NOT SET UP"
    log "  once, to fix: python3 $REPO/spotify-auth.py"
  elif ! pgrep -f '^python3 .*spotify-now\.py' >/dev/null 2>&1; then
    log "starting the now-playing poller"
    # Anchored on the executable, the same rule netd's probe above uses
    # and for the same reason: an unanchored -f matches any process whose
    # command line merely MENTIONS the name - a grep, an editor, the very
    # shell you are debugging from. A false positive here does not start
    # something twice, it never starts it at all, which is the failure
    # being fixed. (Caught exactly this way while testing it.)
    #
    # A restart loop, because nothing else supervises it and a poller
    # that dies quietly puts the page back to looking merely idle.
    ( while true; do
        python3 "$REPO/spotify-now.py" >>"$LOG" 2>&1
        sleep 30
      done & )
  fi
}

# ---- the page server ------------------------------------------------
# netd's own page server on :8090 (see "www" in netd.py), started by
# start_helpers above, normally answers within a couple of seconds.
# Bounded, unlike the desktop version: there is nothing behind this to
# look at, so waiting forever means a black screen forever.
#
# A 404 is a different answer from silence: something is up and does not
# have the page - which is what an AvNav update did when AvNav was the
# server. Opening that URL anyway drew the browser's background and
# nothing else: a black panel. So a steady 404 gives up early, and either
# way main() loads the panel from its file.
NOT_FOUND_AFTER="${NOT_FOUND_AFTER:-10}"
SERVED_URL="$URL"
wait_for_page(){
  local n=0 code limit="${1:-$WAIT_AVNAV}"
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$SERVED_URL" 2>/dev/null)
    [ "$code" = 200 ] && { log "page server answered after ${n}s"; return 0; }
    n=$((n+1))
    if [ "$code" = 404 ] && [ "$n" -ge "$NOT_FOUND_AFTER" ]; then
      log "the server is up but has no $SERVED_URL (404 for ${n}s) - run deploy.sh"; return 1; fi
    [ "$n" -ge "$limit" ] && { log "page server still quiet after ${n}s (last answer: ${code:-none})"; return 1; }
    sleep 1
  done
}
# The panel straight off the disk. Everything it needs it asks for by
# address - Signal K on :3000, netd on :8091 - so it works from file://;
# what it cannot have is what sits BESIDE the served copy: map tiles and
# now-playing. Phones cannot reach a file on the Pi at all.
FILE_URL="${FILE_URL:-file://$REPO/confluence_helm.html}"

# Which of the two to open, asked before EVERY launch and not only at
# boot. The page server lives in netd now, and netd restarts - autopull
# does it on every push that touches it, then kills the kiosk. Asked only
# once, the relaunch would land on a server still starting and sit on
# the browser's connection-error page, which does not exit, for good.
choose_url(){
  if wait_for_page "${1:-$WAIT_AVNAV}"; then
    URL="$SERVED_URL"
  elif [ -r "${FILE_URL#file://}" ]; then
    URL="$FILE_URL"
    log "loading the panel from its file instead: $URL"
  else
    URL="$SERVED_URL"
    log "and there is no ${FILE_URL#file://} either - opening $URL anyway"
  fi
}
RELAUNCH_WAIT="${RELAUNCH_WAIT:-20}"

# ---- the kiosk ------------------------------------------------------
# Two flag sets, tried in order. Chromium on this image may want the
# Wayland backend named explicitly or may pick it up itself, and being
# wrong means a black panel on a boat. So if the first exits at once,
# the second is tried before anything is declared broken.
#
# --password-store=basic: the November 2026 system update brought a
# keyring with Chromium, and with one present Chromium stops before the
# page to ask for a "default keyring" password - a dialog cage shows
# full-screen, square, with a pointer, which looks exactly like the
# desktop coming back. The panel stores no passwords, so it has no use
# for a keyring: basic keeps Chromium from ever asking.
#
# The rest is about the 20 s of white between Chromium's window and the
# panel, measured on the Pi after the same update. Each flag here only
# turns something off that a one-page kiosk has no use for, and none of
# them can make Chromium refuse to start - an unknown switch, or an
# unknown name inside --disable-features, is ignored, not an error.
#
# --force-dark-mode: until the first frame of a page, Chromium fills its
#   window with the browser theme's web-contents background - WHITE in
#   light mode. This turns that dark grey. (--default-background-color,
#   which used to be here, is a headless-only switch and did nothing.)
#   The panel has no prefers-color-scheme rules, so it is unaffected.
# --disable-renderer-accessibility: /etc/chromium.d on Raspberry Pi OS
#   adds --force-renderer-accessibility, which makes every renderer
#   build a full accessibility tree. This one is checked first and wins.
#   Nothing in cage can read that tree: no screen reader, no other app.
# --disable-features=PreloadTopChromeWebUI: the "--top-chrome-webui"
#   renderer that burnt 40% of a core for 10 s during the page load is
#   Chromium preloading its Tab Search UI, which a kiosk never shows.
#   Translate, MediaRouter and OptimizationHints go in the same list
#   because Chromium honours only ONE --disable-features: keep them all
#   here, never in a second switch.
# --no-first-run, --disable-component-update,
# --disable-background-networking: no first-run work, no component
#   downloads (no Widevine is wanted), no Safe Browsing list or variations
#   fetches - all of it extra start-up work for a page on localhost.
KIOSK_FLAGS=(--kiosk --noerrdialogs --disable-infobars
         --disable-session-crashed-bubble --check-for-update-interval=31536000
         --password-store=basic
         --force-dark-mode
         --disable-renderer-accessibility
         --disable-features=PreloadTopChromeWebUI,Translate,MediaRouter,OptimizationHints
         --no-first-run --disable-component-update
         --disable-background-networking)
FLAGS_A=(--ozone-platform=wayland "${KIOSK_FLAGS[@]}")
FLAGS_B=("${KIOSK_FLAGS[@]}")

# A dark page that does nothing but go to the real one. The white was
# Chromium's EMPTY window shown while the first http navigation was still
# pending; a local file has a frame to show almost at once, and once it
# has, Chromium keeps showing it until the panel itself paints. So the
# screen goes Plymouth -> black -> the panel, never white. It is only a
# springboard: the panel still loads from the page server, with its
# origin, storage and tiles exactly as before. Used only for an http(s)
# URL - FILE_URL already is a local file.
LAUNCH="${LAUNCH:-$REPO/boot/launch.html}"
launch_url(){
  local target="$1"
  case "$target" in
    http://*|https://*) [ -r "$LAUNCH" ] && { echo "file://$LAUNCH#$target"; return; };;
  esac
  echo "$target"
}

uptime_s(){ cut -d' ' -f1 /proc/uptime 2>/dev/null || echo '?'; }

run_kiosk(){
  local -n flags=$1
  local open; open="$(launch_url "$URL?v=$(date +%s)")"
  # Timestamped, and with the uptime, so a slow boot can be laid against
  # the rest of it. netd logs the first page request it serves the same
  # way ("www: page requested"), which is the other end of the gap.
  log "chromium launched (uptime $(uptime_s)s, $1): $open"
  # -s allows VT switching. Without it the Desktop tile cannot work:
  # starting a display manager needs another VT to switch to.
  "$CAGE" -s -- "$CHROME" "${flags[@]}" "$open" >>"$LOG" 2>&1
}

main(){
  # tty prints "not a tty" on stdout when there isn't one, so test the
  # shape of the answer rather than the exit code.
  local on; on="$(tty 2>/dev/null || true)"
  case "$on" in /dev/*) ;; *) on='no tty';; esac
  log "session starting on $on"
  # Whether the pointer will be visible, answered in the log rather than
  # on the glass. It has silently come back three times; several things
  # have to line up and none of them announces itself when it is wrong.
  # The names checked are the ones actually asked for: cage's "default",
  # Xwayland's "left_ptr", XCURSOR_THEME, and (--gtk) the one GTK
  # reports, which is what Chromium draws its own pointer from.
  alias_cursor_themes
  if [ -r "$REPO/boot/check-cursor.py" ]; then
    local out rc
    out=$(python3 "$REPO/boot/check-cursor.py" --gtk --all \
            default left_ptr "$XCURSOR_THEME" 2>&1); rc=$?
    case "$rc" in
      0) log "pointer: hidden (all blank: ${out##*checked: })";;
      2) log "pointer: hidden, but the installed theme is out of date - run: sudo bash $REPO/boot/install-cursor.sh";;
      *) log "pointer: WILL BE DRAWN - run: sudo bash $REPO/boot/install-cursor.sh";;
    esac
    [ "$rc" = 0 ] || printf '%s\n' "$out" | while IFS= read -r l; do log "  $l"; done
  fi
  command -v "$CAGE" >/dev/null 2>&1 || {
    fall_back_to_desktop "cage is not installed"; return 1; }

  start_helpers
  choose_url "$WAIT_AVNAV"

  local quick=0 which=FLAGS_A started ran first=1
  while true; do
    [ "$first" = 1 ] || choose_url "$RELAUNCH_WAIT"
    first=0
    started=$(date +%s)
    run_kiosk "$which"
    ran=$(( $(date +%s) - started ))

    if [ "$ran" -ge "$GOOD_RUN" ]; then
      quick=0                                  # it ran; an ordinary restart
      log "kiosk exited after ${ran}s - restarting"
    else
      quick=$((quick+1))
      log "kiosk exited after ${ran}s (${quick} quick exits in a row)"
      if [ "$quick" -eq 2 ] && [ "$which" = FLAGS_A ]; then
        which=FLAGS_B
        log "retrying without --ozone-platform=wayland"
        continue
      fi
      if [ "$quick" -ge 5 ]; then
        fall_back_to_desktop "the kiosk would not stay up"
        return 1
      fi
      sleep 3
    fi
  done
}

main "$@"
