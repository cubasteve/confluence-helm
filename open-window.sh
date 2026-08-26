#!/bin/bash
# Open the helm app in its own window, sharing the kiosk's browser profile
# so saved races and cached chart tiles are the same ones.
#
# This exists rather than putting chromium straight into the .desktop
# Exec= line because Exec is not parsed by a shell: there is no way to
# spell $(date +%s) in it, and without a fresh ?v= Chromium will happily
# render the copy it already has. That is precisely why this window used
# to sit a version behind the kiosk - same URL, same origin, older bytes.
#
#   bash ~/helm/open-window.sh            open it, unless it is already open
#   bash ~/helm/open-window.sh --force    open another anyway
#
# --app                    no tabs and no address bar; it is an
#                          instrument, not a browser.
# --window-size=1080,1080  a square viewport, which is what keeps the dial
#                          round - fitStage() squares it off otherwise.
#
# Deliberately not --kiosk and not --start-maximized: those are the two
# flags netd.py matches on, and this window is meant to be left alone
# when the panel switches the kiosk between modes.
#
# ---- why this refuses to open a second one --------------------------
#
# Because two things launch it in the same moment and neither knows about
# the other. Tapping Desktop stops the cage kiosk and starts a display
# manager; the desktop session that comes up runs EVERY entry in
# ~/.config/autostart, and one of those is this script. If anything else
# on that Pi also puts the app on screen at login - a start-kiosk entry
# left over from before cage mode, say - you get two Confluences.
#
# netd.sh and autopull.sh already carry a guard for exactly this, in
# almost these words: "the desktop's autostart entry starts another one
# the moment you tap Desktop". This one did not, and --app is the worst
# case for it: a plain `chromium <url>` hands the URL to the running
# instance and exits, which looks like nothing happened, but --app always
# opens a NEW window. So the duplicate is guaranteed rather than likely.
set -u

URL="${HELM_URL:-http://localhost:8080/user/helm/confluence_helm.html}"

# Anchored on the executable. An unanchored -f matches any process whose
# command line merely MENTIONS the string - a grep, an editor, the very
# shell you are debugging from - and this repo has been bitten by that
# three times. --type= excludes Chromium's renderer and GPU children,
# which inherit the parent's flags and would each look like a browser.
HELM_PAT='^[^ ]*chromium[^ ]* .*(--app=|--kiosk|--start-maximized)'

showing(){ pgrep -af "$HELM_PAT" 2>/dev/null | grep -v -- '--type=' | head -1; }

# Best effort, and only that: a Pi with neither tool still gets the thing
# that matters, which is not launching a second window.
raise(){
  if command -v wmctrl >/dev/null 2>&1; then
    wmctrl -a 'CONFLUENCE' 2>/dev/null && return 0
  fi
  if command -v xdotool >/dev/null 2>&1; then
    xdotool search --name 'CONFLUENCE' windowactivate 2>/dev/null && return 0
  fi
  return 1
}

if [ "${1:-}" = "--force" ]; then
  shift
else
  up="$(showing)"
  if [ -n "$up" ]; then
    echo "[open-window] the helm app is already on screen - not opening a second"
    echo "[open-window]   $up"
    raise || echo "[open-window]   no wmctrl or xdotool here, so it stays where it is"
    exit 0
  fi
fi

exec chromium-browser --app="$URL?v=$(date +%s)" --window-size=1080,1080 "$@"
