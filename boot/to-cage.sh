#!/bin/bash
# =====================================================================
# Hand the screen back from the desktop to the cage kiosk.
#
# Installed to /usr/local/sbin/confluence-to-cage and run by netd's
# Kiosk tile through one sudoers line. Root-owned outside $HOME for the
# same reason its opposite number is: a NOPASSWD grant on a script in
# the user's own home would be a way to become root by editing it.
#
# This is to-desktop.sh backwards, but it is NOT symmetrical, and the
# asymmetry is the whole design.
#
# Going out is easy: stop cage, start a display manager. Coming back is
# not, because cage cannot simply be launched from here. It has to run
# in the login session on tty1 - NetworkManager's polkit rules grant a
# local ACTIVE session the right to change networking without a
# password, and a cage started from a root helper has no session at all.
# Every WiFi and Bluetooth tile would come back dead, which looks
# exactly like a broken dongle and is not. That trap is documented at
# the top of cage-session.sh; this is the same one from the other side.
#
# What actually gets us back is the mechanism that started cage in the
# first place: agetty autologins the owner on tty1, the login shell
# reads its profile, and the hook there runs cage-session.sh. Restarting
# getty@tty1 replays exactly that. So this script's job is to stop the
# display manager and then ask for a fresh login on tty1 - no more.
# =====================================================================
set -u
DM="__DM__"
OWNER="__OWNER__"
log(){ printf '[to-cage] %s %s\n' "$(date '+%H:%M:%S')" "$*"; }

# Everything is checked BEFORE anything is torn down. Stopping the
# desktop and then discovering cage is not installed would leave the
# panel on a bare console, which is worse than not having tried - and on
# a boat "worse" means no instruments and no way to ask for them back.
if ! command -v cage >/dev/null 2>&1; then
  log "cage is not installed - not touching the desktop"
  exit 1
fi
if [ ! -r /etc/systemd/system/getty@tty1.service.d/confluence-autologin.conf ]; then
  log "no tty1 autologin - a fresh login there would sit at a prompt"
  log "  run: sudo bash ~/helm/boot/install-cage-kiosk.sh"
  exit 1
fi
HOME_DIR="$(getent passwd "$OWNER" | cut -d: -f6)"
HOOK=""
for f in "$HOME_DIR/.bash_profile" "$HOME_DIR/.profile"; do
  [ -f "$f" ] && grep -qF '>>> confluence kiosk >>>' "$f" && { HOOK="$f"; break; }
done
if [ -z "$HOOK" ]; then
  log "no launch hook in $OWNER's profile - the login would stop at a shell"
  log "  run: sudo bash ~/helm/boot/install-cage-kiosk.sh"
  exit 1
fi
log "cage, autologin and the hook in $(basename "$HOOK") are all present"

# The desktop first. A display manager and cage both wanting seat0 is
# the same collision to-desktop.sh avoids in the other direction, and
# it produces the same thing: a display server with no session on it.
if [ -n "$DM" ] && systemctl is-active --quiet "$DM.service"; then
  log "stopping $DM"
  systemctl stop "$DM" || { log "could not stop $DM - nothing changed"; exit 1; }
  sleep 0.6
fi

# The windowed app is the desktop's, not cage's. Left running it would
# still own the browser profile, and start-kiosk.sh and cage's Chromium
# would both sit waiting for a window on a desktop that no longer
# exists. Anchored on the executable - an unanchored -f matches any
# process merely MENTIONING the flag, this script included.
pkill -f '^[^ ]*chromium[^ ]* .*--app=' 2>/dev/null || true
pkill -f '^[^ ]*chromium[^ ]* .*--start-maximized' 2>/dev/null || true
pkill -f 'start-kiosk\.sh' 2>/dev/null || true

log "asking for a fresh login on tty1"
if ! systemctl restart getty@tty1; then
  log "could not restart getty@tty1 - putting the desktop back"
  [ -n "$DM" ] && systemctl start "$DM"
  exit 1
fi

# Wait for it, and put the desktop back if it never arrives. Never
# strand the helm: black glass with SSH as the only way in is the one
# outcome this whole boot chain exists to avoid.
for _ in $(seq 1 20); do
  if pgrep -x cage >/dev/null 2>&1; then
    log "cage is up - done"
    exit 0
  fi
  sleep 0.5
done
log "cage did not come up within 10s - putting the desktop back"
if [ -n "$DM" ] && systemctl start "$DM"; then
  log "the desktop is back; the panel is where you left it"
else
  log "could NOT get either back - there is a shell on tty1"
fi
exit 1
