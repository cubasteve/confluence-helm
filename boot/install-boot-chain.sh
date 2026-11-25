#!/bin/bash
# =====================================================================
# Make the whole power-on look like one thing.
#
# A cold start shows seven screens, and the helm app only owns the last
# one. This claims the other six:
#
#   firmware   rainbow test square       -> disable_splash=1
#   kernel     four raspberries, console -> logo.nologo quiet loglevel=3
#   plymouth   raspberry logo and dots   -> the Confluence theme,
#                                           kept there through apt upgrades
#   session    desktop wallpaper         -> painted #0B0C0E
#   session    a mouse pointer           -> a transparent cursor theme
#   kiosk      waiting for AvNav         -> same colour behind it
#   chromium   a white window            -> boot/launch.html, --force-dark-mode
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

say "1/9  Poppins"
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

say "2/9  Plymouth theme"
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
  # -R rebuilds the initramfs. Bookworm boots one (auto_initramfs=1:
  # initramfs8 for a Pi 4, initramfs_2712 for a Pi 5) and plymouth runs
  # from it, so a theme that is not in there is not the one shown. Try
  # the loud form, and if only the plain one works, say the splash did
  # not reach the startup image rather than reporting plain success.
  if plymouth-set-default-theme -R confluence >/dev/null 2>&1; then
    ok "set as default (initramfs rebuilt)"
  elif plymouth-set-default-theme confluence >/dev/null 2>&1; then
    ok "set as default - but the initramfs was NOT rebuilt; run: sudo update-initramfs -u -k all"
  else
    echo "   WARNING: could not set the default theme" >&2
  fi
  ok "now default: $(plymouth-set-default-theme 2>/dev/null || echo '?')"
fi

say "3/9  keep the splash through updates"
# A Raspberry Pi OS full-upgrade has reset the default theme to pix
# while leaving ours installed. An apt hook puts it back after every
# dpkg run - see install-splash-guard.sh, which is also how to add just
# this to a Pi that already has the rest.
bash "$HERE/install-splash-guard.sh" || ok "the splash guard step failed - see above"

say "4/9  firmware splash"
backup "$CONFIG"
if grep -qE '^\s*disable_splash=' "$CONFIG"; then
  sed -i 's/^\s*disable_splash=.*/disable_splash=1/' "$CONFIG"
else
  printf '\n# no rainbow square on the way up - Confluence boot chain\ndisable_splash=1\n' >> "$CONFIG"
fi
ok "disable_splash=1"

say "5/9  kernel messages"
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

say "6/9  desktop background"
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

say "7/9  the mouse pointer"
# Its own script, because install-cage-kiosk.sh needs exactly the same
# thing and neither installer owns it. See install-cursor.sh for why a
# theme, and why "default" has to be one of them.
bash "$HERE/install-cursor.sh" || ok "the pointer step failed - see above"

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

say "8/9  the gap before Chromium"
ok "start-kiosk.sh waits for AvNav to answer before it launches, and the"
ok "desktop is what is on screen during that wait. It is now the same"
ok "colour as the splash with no pointer, so it should read as a pause"
ok "rather than as a different screen. Anything in ~/Desktop still shows"
ok "through - move those to ~/.local/share/applications to keep them in"
ok "the menu without putting them on the desktop."

say "9/9  Chromium"
ok "start-kiosk.sh opens the dark boot/launch.html first and passes"
ok "--force-dark-mode, so the browser is dark rather than white while"
ok "the page loads. Nothing to install."

say "Done - reboot to see it"
cat <<'EOT'
   sudo reboot

   If it comes up black and stays there, nothing is bricked: power off,
   put the card in another machine, and on the small FAT partition
   rename cmdline.txt.confluence-bak back over cmdline.txt.

   To put everything back:
     sudo bash ~/helm/boot/uninstall-boot-chain.sh
EOT
