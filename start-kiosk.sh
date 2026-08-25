#!/bin/bash
# Launch the Confluence helm display in kiosk mode.
#
# The page is now served by AvNav rather than loaded from file://, which
# means there is a boot race: the desktop session can come up before
# AvNav's HTTP server is listening. If Chromium wins that race it lands
# on a connection-error page and just sits there - it does not exit, so
# a plain restart loop would never notice. So we wait for the URL to
# actually answer before launching anything.
#
# Bounded at ~2 minutes. If AvNav never comes up we launch anyway, so a
# broken server gives you Chromium's error page rather than a black
# screen with no way in.

URL="http://localhost:8080/user/helm/confluence_helm.html"
FALLBACK="file://$HOME/helm/confluence_helm.html"

# Debian ships the browser as `chromium`; Raspberry Pi OS ships it as
# `chromium-browser`. This script used to name only the second, so on an
# image with the first it looped forever at the 30 s cap writing "command
# not found" to a log nobody reads, and the desktop shortcut was dead for
# the same reason. netd.py has always resolved it both ways - this is the
# same lookup.
CHROME=""
for c in chromium-browser chromium; do
  command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
done
if [ -z "$CHROME" ]; then
  echo "helm: neither chromium-browser nor chromium is installed" >&2
  echo "      sudo apt install chromium-browser" >&2
  exit 1
fi

n=0
until curl -sf -o /dev/null --max-time 3 "$URL"; do
  n=$((n + 1))
  if [ "$n" -ge 60 ]; then
    echo "helm: $URL never answered after ~2min; falling back to file://" >&2
    URL="$FALLBACK"
    break
  fi
  sleep 2
done

# Restart if Chromium dies - a crash on a boat should self-heal rather
# than leave a blank helm.
#
# Each launch gets a fresh ?v=, because without it Chromium will happily
# paint the copy it already has - you deploy, the kiosk restarts, and the
# old panel appears for a moment before the network catches up. The query
# string does not change the origin, so the chart tiles and the track
# library in browser storage survive it.
#
# The immediate-exit case is not a crash and must not be treated as one.
# Chromium is single-instance per profile: if another window already owns
# it - the desktop shortcut, or the windowed browser the panel can start -
# a second launch hands that window the URL and quits at once. Relaunching
# three seconds later just does it again, forever, poking the existing
# window into reloading every time. That is a restart loop, not recovery.
#
# So an exit inside five seconds means "someone else has the profile", and
# the right response is to wait for that window to close rather than
# spin. The kiosk takes the screen back the moment it does.
# Anchored on the executable. An unanchored -f pattern also matches any
# shell whose command line merely mentions these flags, and a false
# positive here would wait for ever - the worst outcome available.
owned_by_another(){
  pgrep -f '^[^ ]*chromium[^ ]* .*--app=' >/dev/null 2>&1 ||
  pgrep -f '^[^ ]*chromium[^ ]* .*--start-maximized' >/dev/null 2>&1
}

quick=0
while true; do
  started=$(date +%s)
  # --default-background-color is what the browser paints before the page
  # has anything to show. Left alone it is white, which after a whole
  # boot chain deliberately kept dark is the one frame you notice. The
  # value is ARGB and matches the dusk palette's --bg (#0B0C0E), the
  # same colour Plymouth and the desktop are set to.
  "$CHROME" --kiosk --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --check-for-update-interval=31536000 \
    --default-background-color=FF0B0C0E \
    "$URL?v=$(date +%s)"

  if [ $(( $(date +%s) - started )) -ge 5 ]; then
    quick=0                                   # it ran; an ordinary restart
  elif owned_by_another; then
    quick=0
    echo "helm: chromium exited at once - another window owns the browser" >&2
    echo "      profile. Waiting for it to close instead of relaunching." >&2
    while owned_by_another; do sleep 5; done
    echo "helm: it closed - taking the screen back" >&2
  else
    # Instant exit with nothing else holding the profile means Chromium
    # itself is unhappy. Back off rather than hammering a broken browser
    # every three seconds for the rest of the voyage.
    quick=$(( quick + 1 ))
    back=$(( quick * 5 )); [ "$back" -gt 30 ] && back=30
    echo "helm: chromium exited immediately ($quick in a row) - retrying in ${back}s" >&2
    sleep "$back"
  fi

  sleep 3
done
