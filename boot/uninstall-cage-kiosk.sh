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

rm -f "$OWNER_HOME/.config/autostart/confluence-window.desktop"
echo "   removed the windowed-app autostart entry"

rm -f /etc/systemd/system/getty@tty1.service.d/confluence-autologin.conf
rmdir /etc/systemd/system/getty@tty1.service.d 2>/dev/null || true
echo "   removed the tty1 autologin"

# Whichever file the installer actually appended to - it prefers an
# existing .profile over creating a .bash_profile that would shadow it.
PROFILE="$(cat "$STATE/profile-path" 2>/dev/null || echo "$OWNER_HOME/.bash_profile")"
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
  # If WE created the file and nothing but whitespace is left in it, take
  # it away too. Rewriting it to a single newline - which is what this
  # used to do - leaves a one-byte .bash_profile shadowing ~/.profile for
  # good, long after the kiosk it was created for is gone.
  if [ -f "$STATE/made-bash-profile" ] && [ -z "$(tr -d "[:space:]" < "$PROFILE")" ]; then
    rm -f "$PROFILE" "$STATE/made-bash-profile"
    echo "   removed the .bash_profile we created - ~/.profile is live again"
  fi
fi

if [ -f "$STATE/made-hushlogin" ]; then
  rm -f "$OWNER_HOME/.hushlogin"
  echo "   removed the .hushlogin we created"
fi

if [ -d /boot/firmware ]; then BOOTDIR=/boot/firmware; else BOOTDIR=/boot; fi
if [ -f "$BOOTDIR/cmdline.txt" ] && grep -q console=tty3 "$BOOTDIR/cmdline.txt"; then
  python3 - "$BOOTDIR/cmdline.txt" <<'CMDEDIT'
import sys, os
path = sys.argv[1]
words = [('console=tty1' if w == 'console=tty3' else w) for w in open(path).read().split()]
line = ' '.join(words)
assert '\n' not in line and 'root=' in line
tmp = path + '.confluence-new'
open(tmp, 'w').write(line + '\n')
os.replace(tmp, path)
CMDEDIT
  echo "   console back to tty1"
fi

TARGET="$(cat "$STATE/default-target" 2>/dev/null || echo graphical.target)"
systemctl set-default "$TARGET" >/dev/null 2>&1 && echo "   default target back to $TARGET" \
  || echo "   could not restore the default target - set it with: systemctl set-default graphical.target"
rm -rf "$STATE"
systemctl daemon-reload || true
echo
echo "   sudo reboot"
