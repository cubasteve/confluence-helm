#!/bin/bash
# =====================================================================
# Make the whole power-on look like one thing.
#
# A cold start shows seven screens, and the helm app only owns the last
# one. This claims the other six:
#
#   firmware   rainbow test square       -> disable_splash=1
#   kernel     four raspberries, console -> logo.nologo quiet loglevel=3
#   plymouth   raspberry logo and dots   -> the Confluence theme
#   session    desktop wallpaper         -> painted #0B0C0E
#   session    a mouse pointer           -> a transparent cursor theme
#   kiosk      waiting for AvNav         -> same colour behind it
#   chromium   a white flash             -> --default-background-color
#
# Everything it touches is backed up next to the original with a
# .confluence-bak suffix, and uninstall-boot-chain.sh puts it all back.
#
#   sudo bash ~/helm/boot/install-boot-chain.sh
#
# NOTHING here can be tested anywhere but on this Pi, and a broken
# cmdline.txt boots to a black screen. If that happens: power off, put
# the card in another machine, and on the small FAT partition rename
# cmdline.txt.confluence-bak back over cmdline.txt. That is the whole
# recovery - the file is one line of plain text.
# =====================================================================
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THEME_DIR=/usr/share/plymouth/themes/confluence
FONT_DIR=/usr/local/share/fonts/poppins
BG='#0B0C0E'
# The user who owns the desktop session - not root, who is running this.
OWNER="${SUDO_USER:-pi}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"

# Bookworm moved the firmware partition. Older images still use /boot.
if [ -d /boot/firmware ]; then BOOTDIR=/boot/firmware; else BOOTDIR=/boot; fi
CONFIG="$BOOTDIR/config.txt"
CMDLINE="$BOOTDIR/cmdline.txt"

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok(){  printf '   %s\n' "$*"; }

# Back up once and only once: re-running must not overwrite the pristine
# copy with an already-modified one.
backup(){
  [ -f "$1" ] || return 0
  if [ ! -f "$1.confluence-bak" ]; then
    cp -a "$1" "$1.confluence-bak"
    ok "backed up $1 -> $1.confluence-bak"
  else
    ok "backup of $1 already exists, keeping it"
  fi
}

say "1/8  Poppins"
# The app has always asked for Poppins and the Pi has never had it, so
# every reading you have ever seen has been DejaVu. The splash images
# are rendered in Poppins, so without this the boot chain and the app
# would be in two different faces.
#
# These are Google's static TTFs with one change: they ship with the
# family name "Poppins Light", which no browser matches against
# font-family:'Poppins'. The typographic family/subfamily names have
# been set so the three files group into one weighted family.
mkdir -p "$FONT_DIR"
cp "$HERE/fonts/Poppins-300.ttf" "$HERE/fonts/Poppins-500.ttf" \
   "$HERE/fonts/Poppins-600.ttf" "$HERE/fonts/OFL.txt" "$FONT_DIR/"
fc-cache -f >/dev/null 2>&1 || true
if fc-match "Poppins:weight=light" | grep -qi poppins; then
  ok "installed and matching: $(fc-match 'Poppins:weight=light')"
else
  echo "   WARNING: fontconfig still does not match Poppins" >&2
fi

say "2/8  Plymouth theme"
if ! command -v plymouth-set-default-theme >/dev/null 2>&1; then
  echo "   plymouth is not installed - skipping the theme." >&2
  echo "   sudo apt install plymouth plymouth-themes, then re-run." >&2
else
  mkdir -p "$THEME_DIR"
  cp "$HERE/theme/confluence.script" "$HERE/theme/wave1.png" \
     "$HERE/theme/wave2.png" "$HERE/theme/wave3.png" \
     "$HERE/theme/wordmark.png" "$THEME_DIR/"
  cp "$HERE/theme/confluence.plymouth" "$THEME_DIR/"
  ok "installed to $THEME_DIR"
  # -R rebuilds the initramfs. Raspberry Pi OS usually has no initramfs
  # to rebuild, and the plain form is enough there - so try the loud one
  # and fall back rather than failing the whole install on it.
  if plymouth-set-default-theme -R confluence >/dev/null 2>&1; then
    ok "set as default (initramfs rebuilt)"
  elif plymouth-set-default-theme confluence >/dev/null 2>&1; then
    ok "set as default"
  else
    echo "   WARNING: could not set the default theme" >&2
  fi
  ok "now default: $(plymouth-set-default-theme 2>/dev/null || echo '?')"
fi

say "3/8  firmware splash"
backup "$CONFIG"
if grep -qE '^\s*disable_splash=' "$CONFIG"; then
  sed -i 's/^\s*disable_splash=.*/disable_splash=1/' "$CONFIG"
else
  printf '\n# no rainbow square on the way up - Confluence boot chain\ndisable_splash=1\n' >> "$CONFIG"
fi
ok "disable_splash=1"

say "4/8  kernel messages"
backup "$CMDLINE"
# cmdline.txt MUST stay a single line. sed on a file with no trailing
# newline is the classic way to break that, so this goes through python
# and the result is checked before it is written back.
python3 - "$CMDLINE" <<'PY'
import sys, os
path = sys.argv[1]
raw = open(path).read()
words = raw.split()                       # collapses any newline already there

WANT = ['quiet', 'splash', 'logo.nologo', 'loglevel=3',
        'vt.global_cursor_default=0', 'plymouth.ignore-serial-consoles']
for w in WANT:
    key = w.split('=')[0]
    if not any(x == w or x.startswith(key + '=') for x in words):
        words.append(w)

line = ' '.join(words)
assert '\n' not in line, 'refusing to write a multi-line cmdline.txt'
assert 'root=' in line, 'refusing to write a cmdline.txt with no root='
tmp = path + '.confluence-new'
with open(tmp, 'w') as f:
    f.write(line + '\n')
os.replace(tmp, path)
print('   ' + line)
PY

say "5/8  desktop background"
# Only when there is a desktop config to edit. On a Wayland session
# (labwc or wayfire) this file is not what paints the screen, so say so
# rather than writing something that does nothing.
DESKTOP_CONF="$OWNER_HOME/.config/pcmanfm/LXDE-pi/desktop-items-0.conf"
if [ -f "$DESKTOP_CONF" ]; then
  backup "$DESKTOP_CONF"
  python3 - "$DESKTOP_CONF" "$BG" <<'PY'
import sys, re
path, bg = sys.argv[1], sys.argv[2]
txt = open(path).read()
def setkey(t, k, v):
    if re.search(r'(?m)^%s=' % k, t):
        return re.sub(r'(?m)^%s=.*' % k, '%s=%s' % (k, v), t)
    return t.rstrip('\n') + '\n%s=%s\n' % (k, v)
txt = setkey(txt, 'wallpaper_mode', 'color')
txt = setkey(txt, 'desktop_bg', bg)
open(path, 'w').write(txt)
print('   %s -> solid %s' % (path, bg))
PY
  chown "$OWNER:$OWNER" "$DESKTOP_CONF"
else
  ok "no pcmanfm desktop config - this is probably a Wayland session."
  ok "set the background to $BG by hand in Appearance Settings."
fi

say "6/8  the mouse pointer"
# X11 and Wayland both resolve pointers through Xcursor themes, so one
# transparent theme covers whichever this Pi is running. `X -nocursor`
# is more absolute but exists only under X, so it goes on as well when
# the session is X - belt and braces.
CURSOR_THEME=/usr/share/icons/Confluence-blank
rm -rf "$CURSOR_THEME"
mkdir -p "$CURSOR_THEME"
cp -r "$HERE/cursor/." "$CURSOR_THEME/"
ok "installed $CURSOR_THEME"

# /usr/share/icons/default/index.theme is what both stacks consult
# first, and on Debian it is NOT an ordinary file: it is the tail of the
# x-cursor-theme update-alternatives chain, so writing to that path
# writes THROUGH the symlinks into a package-owned file. backup() could
# not save us from that either - `cp -a` implies -d, so it copied the
# symlink and not the file about to be clobbered, and the uninstaller
# then restored a link pointing at a theme it had just deleted. The
# packaged theme was left inheriting something that no longer existed,
# and only reinstalling the cursor package put it right.
#
# update-alternatives is the supported way to say "prefer mine": it adds
# a candidate at a high priority and can be withdrawn cleanly, leaving
# whatever the system had before to win again on its own.
CURSOR_ALT=/usr/share/icons/Confluence-blank/index.theme
cat > "$CURSOR_ALT" <<'EOT'
[Icon Theme]
Name=Confluence-blank
Comment=Transparent pointer for the helm kiosk
Inherits=Confluence-blank
EOT
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install /usr/share/icons/default/index.theme \
    x-cursor-theme "$CURSOR_ALT" 155 >/dev/null 2>&1 &&
    update-alternatives --set x-cursor-theme "$CURSOR_ALT" >/dev/null 2>&1 &&
    ok "registered as the x-cursor-theme alternative (priority 155)" ||
    ok "update-alternatives would not take it - pointer theme unchanged"
else
  # No update-alternatives: then it really is a plain file, and the
  # ordinary backup/restore pair is correct after all.
  mkdir -p /usr/share/icons/default
  backup /usr/share/icons/default/index.theme
  cat > /usr/share/icons/default/index.theme <<'EOT'
[Icon Theme]
Name=Default
Comment=Default cursor theme
Inherits=Confluence-blank
EOT
  ok "made it the system default cursor theme"
fi

# Every one of these is allowed to fail. set -e is on, and a missing or
# unhappy loginctl must not abort an installer that edits boot files.
SID="$(loginctl 2>/dev/null | awk -v u="$OWNER" '$3==u{print $1; exit}' || true)"
SESSION=""
[ -n "$SID" ] && SESSION="$(loginctl show-session "$SID" -p Type --value 2>/dev/null || true)"
[ -n "$SESSION" ] || SESSION="${XDG_SESSION_TYPE:-unknown}"
ok "desktop session looks like: $SESSION"
if [ "$SESSION" = "x11" ] && [ -d /etc/lightdm ]; then
  mkdir -p /etc/lightdm/lightdm.conf.d
  cat > /etc/lightdm/lightdm.conf.d/10-confluence-nocursor.conf <<'EOT'
# Confluence boot chain: no pointer between the splash and the kiosk.
[Seat:*]
xserver-command=X -nocursor
EOT
  ok "and told the X server to draw no cursor at all"
elif [ "$SESSION" = "wayland" ]; then
  ok "Wayland: the transparent theme is the whole fix - there is no"
  ok "-nocursor equivalent. It takes effect on the next login."
else
  ok "could not identify the session; the theme applies either way."
fi

say "7/8  the gap before Chromium"
ok "start-kiosk.sh waits for AvNav to answer before it launches, and the"
ok "desktop is what is on screen during that wait. It is now the same"
ok "colour as the splash with no pointer, so it should read as a pause"
ok "rather than as a different screen. Anything in ~/Desktop still shows"
ok "through - move those to ~/.local/share/applications to keep them in"
ok "the menu without putting them on the desktop."

say "8/8  Chromium"
ok "start-kiosk.sh already passes --default-background-color, so the"
ok "browser paints $BG instead of white while the page loads."

say "Done - reboot to see it"
cat <<'EOT'
   sudo reboot

   If it comes up black and stays there, nothing is bricked: power off,
   put the card in another machine, and on the small FAT partition
   rename cmdline.txt.confluence-bak back over cmdline.txt.

   To put everything back:
     sudo bash ~/helm/boot/uninstall-boot-chain.sh
EOT
