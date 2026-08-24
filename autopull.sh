#!/bin/bash
# Keep the helm display in step with the repo.
#
# Polls GitHub, and when the app has actually changed, redeploys and
# restarts the kiosk so the new version is on the glass. This is what
# closes the loop for editing from a phone: push from anywhere, and the
# panel picks it up without anyone touching the Pi.
#
# Started from ~/.config/autostart/confluence-autopull.desktop.
#
#   bash ~/helm/autopull.sh [interval-seconds]
#
# Default interval is 300 s. Nothing here is urgent - a tighter loop just
# burns battery and GitHub requests for no benefit.

set -u
REPO="$HOME/helm"
INTERVAL="${1:-300}"
RELOAD="${AUTOPULL_RELOAD:-1}"      # export AUTOPULL_RELOAD=0 to deploy without restarting

log(){ echo "[autopull] $(date '+%H:%M:%S') $*"; }

cd "$REPO" 2>/dev/null || { log "no repo at $REPO"; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log "$REPO is not a git clone"; exit 1; }

log "watching $(git config --get remote.origin.url) every ${INTERVAL}s"

while true; do
  before=$(git rev-parse HEAD 2>/dev/null || echo none)

  # --ff-only on purpose: if the Pi's copy has diverged, stop and say so
  # rather than inventing a merge commit on a boat computer nobody is
  # watching. Local edits are then a deliberate thing to resolve by hand.
  if ! out=$(git pull --ff-only --quiet 2>&1); then
    case "$out" in
      *"Could not resolve host"*|*"unable to access"*|*"Connection"*)
        : ;;                        # offline is the normal case out on the water
      *)
        log "pull refused: $out" ;;
    esac
    sleep "$INTERVAL"; continue
  fi

  after=$(git rev-parse HEAD 2>/dev/null || echo none)

  if [ "$before" != "$after" ]; then
    log "updated $(git log --oneline -1 "$after" 2>/dev/null)"
    if bash "$REPO/deploy.sh"; then
      if [ "$RELOAD" = "1" ]; then
        # start-kiosk.sh runs chromium in a restart loop, so killing it is
        # all it takes - no window-manager tooling, no xdotool. Matches the
        # kiosk instance only, leaving the desktop-shortcut window alone.
        if pkill -f 'chromium-browser --kiosk' 2>/dev/null; then
          log "kiosk restarting with the new version"
        fi
      else
        log "deployed; reload suppressed (AUTOPULL_RELOAD=0)"
      fi
    else
      log "deploy failed - leaving the running version alone"
    fi
  fi

  sleep "$INTERVAL"
done
