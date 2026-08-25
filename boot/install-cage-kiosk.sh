#!/bin/bash
# =====================================================================
# Replace the desktop with a cage session, so the Pi goes from the
# Plymouth splash straight to the helm app with nothing in between.
#
#   sudo bash ~/helm/boot/install-cage-kiosk.sh
#   sudo bash ~/helm/boot/uninstall-cage-kiosk.sh     to put it back
#
# What this gives up, so it is not a surprise later:
#   - the windowed copy and the FULL/KIOSK tile. cage runs one
#     maximized application; there is no windowing to switch to.
#   - the desktop shortcut, and the desktop.
#
# What it has to arrange, because cage does not:
#   - netd and autopull. cage reads no ~/.config/autostart, so
#     cage-session.sh starts them itself.
#   - a session polkit will accept. NetworkManager grants a local
#     ACTIVE session the right to change networking without a password.
#     A login on tty1 is one. A system-level systemd unit is not, and
#     under one every join would fail with "Interactive authentication
#     required" - which looks exactly like a dead dongle.
#
# If it comes up black: ssh in and run the uninstaller. Failing that,
# cage-session.sh starts the desktop by itself after five failed
# launches, so a Pi that cannot run the kiosk lands on a desktop rather
# than on nothing.
# =====================================================================
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OWNER="${SUDO_USER:-pi}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
STATE=/var/lib/confluence-cage
MARK_A='# >>> confluence kiosk >>>'
MARK_B='# <<< confluence kiosk <<<'

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok(){  printf '   %s\n' "$*"; }
die(){ printf '\n   %s\n' "$*" >&2; exit 1; }

mkdir -p "$STATE"

say "1/5  cage"
command -v cage >/dev/null 2>&1 || die "cage is not installed.  sudo apt install cage"
ok "$(command -v cage)"
[ -x "$HERE/cage-session.sh" ] || chmod +x "$HERE/cage-session.sh"
ok "session script: $HERE/cage-session.sh"

say "2/5  the Desktop tile's one privilege"
# logind hands a local active session reboot and poweroff for free, but
# not starting an arbitrary unit - so the tile needs exactly this and
# nothing more. Written to a temp file and checked by visudo BEFORE it
# is installed: a malformed sudoers file locks you out of sudo.
DM=""
for d in lightdm gdm3 sddm; do
  if systemctl list-unit-files "$d.service" 2>/dev/null | grep -q "^$d.service"; then
    DM="$d"; break
  fi
done
if [ -z "$DM" ]; then
  ok "no display manager found - skipping. The Desktop tile will stay hidden."
else
  # Root-owned copy, with the display manager baked in. A NOPASSWD
  # grant on a script inside the user's own home would be a way to
  # become root by editing it.
  sed "s|__DM__|$DM|" "$HERE/to-desktop.sh" > /usr/local/sbin/confluence-to-desktop
  chown root:root /usr/local/sbin/confluence-to-desktop
  chmod 0755 /usr/local/sbin/confluence-to-desktop
  ok "installed /usr/local/sbin/confluence-to-desktop (for $DM)"

  TMP="$(mktemp)"
  # The trailing "" restricts the grant to the command with NO arguments.
  cat > "$TMP" <<'EOT'
# Confluence kiosk: the panel's Desktop tile, and nothing else.
EOT
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/confluence-to-desktop ""\n' "$OWNER" >> "$TMP"
  chmod 0440 "$TMP"
  visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; die "refusing to install a sudoers file visudo rejects"; }
  install -m 0440 "$TMP" /etc/sudoers.d/confluence-desktop
  rm -f "$TMP"
  ok "checked by visudo and installed: $OWNER may run it with no arguments"
fi

say "3/5  tty1 owns the session"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/confluence-autologin.conf <<EOT
# Confluence kiosk: log $OWNER in on tty1 so the helm session is a real,
# active logind session - which is what polkit needs to let netd drive
# NetworkManager without a password.
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $OWNER --noclear %I \$TERM
EOT
ok "autologin for $OWNER on tty1"

PROFILE="$OWNER_HOME/.bash_profile"
touch "$PROFILE"; chown "$OWNER:$OWNER" "$PROFILE"
if ! grep -qF "$MARK_A" "$PROFILE"; then
  cat >> "$PROFILE" <<EOT

$MARK_A
# Not exec: if the session gives up and starts the desktop instead, this
# shell is what you land on rather than a respawn loop.
if [ -z "\${WAYLAND_DISPLAY:-}" ] && [ -z "\${DISPLAY:-}" ] && [ "\$(tty)" = "/dev/tty1" ]; then
  bash "\$HOME/helm/boot/cage-session.sh"
fi
$MARK_B
EOT
  ok "added the launch hook to $PROFILE"
else
  ok "launch hook already in $PROFILE"
fi

say "4/5  stop the desktop starting by itself"
systemctl get-default > "$STATE/default-target" 2>/dev/null || echo graphical.target > "$STATE/default-target"
ok "was: $(cat "$STATE/default-target")"
systemctl set-default multi-user.target >/dev/null 2>&1 && ok "now: multi-user.target" \
  || ok "could not change the default target"
systemctl daemon-reload || true

say "5/5  done"
cat <<EOT
   sudo reboot

   The panel should go Plymouth -> the helm app, with no desktop and no
   pointer in between.

   To get a desktop afterwards: the Desktop tile in the power sheet, or
   from a shell 'sudo systemctl start $DM'. A reboot returns to the kiosk.

   To undo all of it:
     sudo bash ~/helm/boot/uninstall-cage-kiosk.sh
EOT
