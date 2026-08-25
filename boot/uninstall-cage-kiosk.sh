#!/bin/bash
# Put the desktop back exactly as it was before install-cage-kiosk.sh.
#   sudo bash ~/helm/boot/uninstall-cage-kiosk.sh
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }
OWNER="${SUDO_USER:-pi}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
STATE=/var/lib/confluence-cage
MARK_A='# >>> confluence kiosk >>>'
MARK_B='# <<< confluence kiosk <<<'

rm -f /etc/sudoers.d/confluence-desktop /usr/local/sbin/confluence-to-desktop
echo "   removed the Desktop tile's sudoers rule and helper"

rm -f /etc/systemd/system/getty@tty1.service.d/confluence-autologin.conf
rmdir /etc/systemd/system/getty@tty1.service.d 2>/dev/null || true
echo "   removed the tty1 autologin"

PROFILE="$OWNER_HOME/.bash_profile"
if [ -f "$PROFILE" ] && grep -qF "$MARK_A" "$PROFILE"; then
  python3 - "$PROFILE" "$MARK_A" "$MARK_B" <<'PY'
import sys
path, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().split('\n')
out, skip = [], False
for ln in lines:
    if ln.strip() == a: skip = True; continue
    if ln.strip() == b: skip = False; continue
    if not skip: out.append(ln)
open(path, 'w').write('\n'.join(out).rstrip('\n') + '\n')
PY
  echo "   removed the launch hook from $PROFILE"
fi

TARGET="$(cat "$STATE/default-target" 2>/dev/null || echo graphical.target)"
systemctl set-default "$TARGET" >/dev/null 2>&1 && echo "   default target back to $TARGET" \
  || echo "   could not restore the default target - set it with: systemctl set-default graphical.target"
rm -rf "$STATE"
systemctl daemon-reload || true
echo
echo "   sudo reboot"
