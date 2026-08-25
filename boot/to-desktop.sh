#!/bin/bash
# =====================================================================
# Hand the screen from the cage kiosk back to a desktop.
#
# Installed to /usr/local/sbin/confluence-to-desktop and run by netd's
# Desktop tile through one sudoers line. Root-owned on purpose: a
# NOPASSWD grant on a script inside the user's own home would be a way
# to become root by editing it.
#
# The kiosk has to STOP first. Starting a display manager alongside a
# running cage session leaves two things wanting the same seat, and
# what you get is a display server with no session on it - a black
# screen with a pointer and no panel. And the supervisor has to go
# before the compositor, or it simply launches another one.
# =====================================================================
set -u
DM="__DM__"
log(){ printf '[to-desktop] %s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Check the target exists BEFORE tearing anything down. Killing the
# kiosk and then failing to start a desktop would leave the panel on a
# bare console, which is worse than not having tried.
if ! systemctl cat "$DM.service" >/dev/null 2>&1; then
  log "no $DM.service on this system - not touching the kiosk"
  exit 1
fi

log "stopping the kiosk supervisor"
pkill -f 'cage-session\.sh' 2>/dev/null || true
sleep 0.4

log "stopping cage"
pkill -x cage 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -x cage >/dev/null 2>&1 || break
  sleep 0.3
done
if pgrep -x cage >/dev/null 2>&1; then
  log "cage will not exit - forcing"
  pkill -9 -x cage 2>/dev/null || true
  sleep 0.5
fi

log "starting $DM"
if systemctl start "$DM"; then
  log "done"
  exit 0
fi
log "could not start $DM"
exit 1
