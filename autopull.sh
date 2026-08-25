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

# git will open /dev/tty directly for a credential prompt - stdin being
# /dev/null does not stop it. Under cage the controlling terminal is
# tty1, which is in graphics mode: the prompt reaches nobody, the pull
# blocks forever, the loop never reaches its sleep, and the lock below
# stays held so nothing else takes over. A remote that needs auth should
# fail fast and be visible in the log instead.
export GIT_TERMINAL_PROMPT=0

REPO="$HOME/helm"
INTERVAL="${1:-300}"
RELOAD="${AUTOPULL_RELOAD:-1}"      # export AUTOPULL_RELOAD=0 to deploy without restarting

log(){ echo "[autopull] $(date '+%H:%M:%S') $*"; }

# Same two-places problem as netd.sh: cage-session.sh starts one, and the
# desktop's autostart starts another when you tap Desktop. Two of these
# racing on the same clone is a torn checkout waiting to happen, so the
# second one exits rather than joining in.
#
# Per-uid path, because a fixed name in world-writable /tmp is a foot-gun:
# one `sudo bash ~/helm/autopull.sh` while debugging leaves a root-owned
# file the pi user can neither open for write nor unlink, and autopull is
# then dead every boot after.
#
# The two failures have to be told apart. bash does NOT abort on a failed
# `exec` redirection here - it carries on with fd 9 unopened, and flock
# then fails with "Bad file descriptor", which looks exactly like losing
# the race. Reporting a duplicate that does not exist sends you hunting
# the wrong thing for an hour. So: check that the fd opened, and if it
# did not, carry on WITHOUT the lock. Two copies racing the clone is
# recoverable; an update path that is dead and lying about why is not.
LOCK="/tmp/confluence-autopull.$(id -u).lock"
if exec 9>"$LOCK"; then
  if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
    log "another autopull already has the repo - leaving it to that one"
    exit 0
  fi
else
  log "cannot open $LOCK - carrying on unlocked"
fi

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

  # Two reasons to publish, not one. The obvious one is that the pull
  # brought something new. The other is drift: a `git pull` run by hand
  # moves the repo without deploying, and a commit-only test then sees
  # before == after for ever and never notices that what AvNav is serving
  # is a different vintage from what is checked out. That is how a Pi ends
  # up running three versions of this app at once.
  if [ "$before" != "$after" ]; then
    log "updated $(git log --oneline -1 "$after" 2>/dev/null)"
  elif ! bash "$REPO/deploy.sh" --check 2>/dev/null; then
    log "served copy is stale - redeploying"
  else
    sleep "$INTERVAL"; continue
  fi

  # The radio helper runs from the repo, so a pushed change to it would
  # otherwise sit there until the next session restart. Killing the python
  # process is enough: netd.sh's loop brings the new one back. Anchored on
  # python3 so the supervising loop itself survives.
  if [ "$before" != "$after" ] &&
     git diff --name-only "$before" "$after" 2>/dev/null | grep -q '^netd\.py$'; then
    pkill -f '^python3 .*netd\.py' 2>/dev/null && log "radio helper restarting"
  fi

  if bash "$REPO/deploy.sh"; then
    if [ "$RELOAD" = "1" ]; then
      # Both supervisors run chromium in a restart loop, so killing it is
      # all it takes - no window-manager tooling, no xdotool. Under cage,
      # chromium dying takes cage with it and cage-session.sh relaunches
      # with a fresh ?v=, which is the same self-heal.
      #
      # The pattern is netd.py's KIOSK_PAT, and it has to be. The old one
      # was 'chromium-browser --kiosk', which requires the two to be
      # adjacent - true for start-kiosk.sh, false for cage-session.sh's
      # FLAGS_A ('chromium-browser --ozone-platform=wayland --kiosk'),
      # which is the set that wins on a healthy Pi. So in cage mode every
      # push deployed and none of them ever reached the glass. The ^ also
      # keeps it off `cage -s -- chromium...`, which must not be killed
      # directly - the supervisor is what restarts it.
      #
      # The log line is deliberately OUTSIDE the condition: with it
      # inside, a miss printed nothing at all, and the loop reported
      # "updated <sha>" and then went quiet.
      if pkill -f '^[^ ]*chromium[^ ]* .*--kiosk' 2>/dev/null; then
        log "kiosk restarting with the new version"
      else
        log "deployed, but no kiosk process matched - panel still on the old version"
      fi
    else
      log "deployed; reload suppressed (AUTOPULL_RELOAD=0)"
    fi
  else
    log "deploy failed - leaving the running version alone"
  fi

  sleep "$INTERVAL"
done
