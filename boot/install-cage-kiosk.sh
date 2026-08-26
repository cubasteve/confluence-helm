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
if [ -d /boot/firmware ]; then BOOTDIR=/boot/firmware; else BOOTDIR=/boot; fi
CMDLINE="$BOOTDIR/cmdline.txt"
MARK_A='# >>> confluence kiosk >>>'
MARK_B='# <<< confluence kiosk <<<'

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
backup(){ [ -f "$1" ] || return 0
  if [ ! -f "$1.confluence-bak" ]; then cp -a "$1" "$1.confluence-bak"
    printf '   backed up %s\n' "$1"
  fi; }
ok(){  printf '   %s\n' "$*"; }
die(){ printf '\n   %s\n' "$*" >&2; exit 1; }

mkdir -p "$STATE"

say "1/8  cage"
command -v cage >/dev/null 2>&1 || die "cage is not installed.  sudo apt install cage"
ok "$(command -v cage)"
[ -x "$HERE/cage-session.sh" ] || chmod +x "$HERE/cage-session.sh"
ok "session script: $HERE/cage-session.sh"

say "2/8  the mouse pointer"
# cage-session.sh exports XCURSOR_THEME=Confluence-blank, and until now
# nothing in THIS installer put that theme on the disk - it was a step
# inside install-boot-chain.sh, a different script you might reasonably
# never have run. A cage kiosk naming a theme that does not exist gets
# wlroots' built-in arrow for the whole gap between Plymouth quitting and
# Chromium's first paint, with nothing anywhere saying why. So the cage
# installer installs it too now, and both are idempotent.
bash "$HERE/install-cursor.sh" || ok "the pointer step failed - see above"

say "3/8  the Desktop tile's one privilege"
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

say "4/8  tty1 owns the session"
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/confluence-autologin.conf <<EOT
# Confluence kiosk: log $OWNER in on tty1 so the helm session is a real,
# active logind session - which is what polkit needs to let netd drive
# NetworkManager without a password.
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $OWNER --noclear --noissue %I \$TERM
EOT
ok "autologin for $OWNER on tty1"

# WHICH file matters. bash reads ~/.bash_profile for a login shell and
# falls back to ~/.profile only when that does not exist - so creating an
# empty .bash_profile on a stock image (which ships .profile and no
# .bash_profile) permanently shadows it. Every login shell afterwards
# skips the `. ~/.bashrc` source and the ~/.local/bin PATH prepend, and
# the uninstaller rewrites the file rather than unlinking it, so a
# one-byte .bash_profile goes on shadowing long after the kiosk is gone.
# That outlives its cause and bites a human at a keyboard, not the panel.
#
# So: append to whichever login file already exists, and only create one
# when there is nothing to shadow. The state note is what lets the
# uninstaller remove a file we created without touching one we did not.
if [ -f "$OWNER_HOME/.bash_profile" ]; then
  PROFILE="$OWNER_HOME/.bash_profile"
elif [ -f "$OWNER_HOME/.profile" ]; then
  PROFILE="$OWNER_HOME/.profile"
else
  PROFILE="$OWNER_HOME/.bash_profile"
  touch "$PROFILE"; chown "$OWNER:$OWNER" "$PROFILE"
  touch "$STATE/made-bash-profile"
fi
echo "$PROFILE" > "$STATE/profile-path"
ok "login hook goes in $(basename "$PROFILE")"
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

say "5/8  what Desktop means"
# The Desktop tile stops the kiosk and starts a desktop session. What you
# want on the other side is the helm app still in front of you - as a
# window this time, since that is what a desktop is for. The desktop's
# own autostart is the right hook: in cage mode a desktop only ever
# starts because the tile asked for one.
AUTOSTART="$OWNER_HOME/.config/autostart"
mkdir -p "$AUTOSTART"
# A plain copy now: the entry resolves $HOME itself through `bash -c`,
# so there is nothing left to rewrite. It used to be sed'd, and only
# this one of the three was - which is why netd and autopull never
# started under any account but pi.
install -m 0644 "$HERE/../autostart/confluence-window.desktop" \
  "$AUTOSTART/confluence-window.desktop"
chown -R "$OWNER:$OWNER" "$AUTOSTART"
ok "tapping Desktop will open the helm app windowed on it"

say "6/8  stop the desktop starting by itself"
# Write-once, the same rule backup() applies at :41. Unconditional, this
# was a trap: a SECOND installer run - which is the only way to pick up a
# later commit - reads back the multi-user.target the FIRST run set and
# records it as "what it was before". The uninstaller then restores that,
# removes the tty1 autologin and the profile hook, and the Pi comes up on
# a text console with nothing to start a GUI. The escape hatch produced
# the outcome it exists to prevent.
#
# Deliberately no coercion of a captured multi-user.target to graphical:
# on a genuinely headless Pi that is the correct value to restore, and
# the write-once guard is the only thing that tells the two cases apart.
if [ ! -f "$STATE/default-target" ]; then
  systemctl get-default > "$STATE/default-target" 2>/dev/null \
    || echo graphical.target > "$STATE/default-target"
  ok "was: $(cat "$STATE/default-target")"
else
  ok "already recorded: $(cat "$STATE/default-target") - not overwriting"
fi
systemctl set-default multi-user.target >/dev/null 2>&1 && ok "now: multi-user.target" \
  || ok "could not change the default target"
systemctl daemon-reload || true

say "7/8  the login banner"
# What lands on tty1 between Plymouth and cage is not kernel output, it
# is the login banner: the uname line and the Debian warranty text come
# from the MOTD, "Last login" from login(1), and /etc/issue from agetty.
#
# .hushlogin is the switch for the first two - login(1) checks for it by
# name (HUSHLOGIN_FILE in /etc/login.defs) and prints neither. agetty
# got --noissue above for the third.
HUSH="$OWNER_HOME/.hushlogin"
if [ ! -e "$HUSH" ]; then
  touch "$HUSH"; chown "$OWNER:$OWNER" "$HUSH"
  touch "$STATE/made-hushlogin"          # so uninstall only removes ours
  ok "created $HUSH - no MOTD, no last-login line"
else
  ok "$HUSH already exists"
fi

# And send whatever the kernel and systemd still say to a tty nobody is
# looking at. quiet and loglevel=3 already suppress most of it; this
# takes the rest off the panel's own console.
backup "$CMDLINE"
python3 - "$CMDLINE" <<'CMDEDIT'
import sys, os
path = sys.argv[1]
words = open(path).read().split()
moved = False
for i, w in enumerate(words):
    if w == 'console=tty1':
        words[i] = 'console=tty3'; moved = True
line = ' '.join(words)
assert '\n' not in line, 'refusing to write a multi-line cmdline.txt'
assert 'root=' in line, 'refusing to write a cmdline.txt with no root='
tmp = path + '.confluence-new'
open(tmp, 'w').write(line + '\n')
os.replace(tmp, path)
print('   console moved to tty3' if moved else '   no console=tty1 to move')
CMDEDIT

say "8/8  done"
cat <<EOT
   sudo reboot

   The panel should go Plymouth -> the helm app, with no desktop and no
   pointer in between.

   To get a desktop afterwards: the Desktop tile in the power sheet, or
   from a shell 'sudo systemctl start $DM'. A reboot returns to the kiosk.

   To undo all of it:
     sudo bash ~/helm/boot/uninstall-cage-kiosk.sh
EOT
