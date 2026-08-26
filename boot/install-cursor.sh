#!/bin/bash
# =====================================================================
# Install the transparent pointer theme, and prove it took.
#
#   sudo bash ~/helm/boot/install-cursor.sh
#   sudo bash ~/helm/boot/uninstall-cursor.sh     to put the pointer back
#
# Its own script because BOTH installers need it and neither owns it.
# It used to live inside install-boot-chain.sh, while the thing that
# actually depends on it - cage-session.sh, which exports
# XCURSOR_THEME=Confluence-blank - is installed by install-cage-kiosk.sh.
# So a Pi could have the whole cage kiosk set up, naming a theme that had
# never been installed, and the only symptom was an arrow on the glass
# for a few seconds at every boot with nothing anywhere saying why.
#
# Safe to run on its own and safe to run twice.
#
# ---- why a theme, and why two of them ------------------------------
#
# X11 and Wayland both resolve pointers through Xcursor themes, so one
# transparent theme covers whichever this Pi is running. `X -nocursor`
# is more absolute but exists only under X.
#
# Setting XCURSOR_THEME is NOT sufficient on its own, and that is the
# part that kept the pointer coming back. cage hands wlroots a NULL
# theme name, and wlroots resolves NULL to the theme literally called
# "default" - it does not consult XCURSOR_THEME for that. If nothing
# called "default" resolves to something blank, wlroots draws the arrow
# compiled into itself for the whole gap between Plymouth quitting and
# Chromium's first paint. So this script sets up both: the named theme,
# and "default" pointing at it.
# =====================================================================
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURSOR_THEME=/usr/share/icons/Confluence-blank
DEFAULT_INDEX=/usr/share/icons/default/index.theme

ok(){ printf '   %s\n' "$*"; }
backup(){ [ -f "$1" ] || return 0
  if [ ! -f "$1.confluence-bak" ]; then cp -a "$1" "$1.confluence-bak"
    printf '   backed up %s\n' "$1"
  fi; }

[ -d "$HERE/cursor/cursors" ] || {
  echo "no cursor theme at $HERE/cursor - run make-blank-cursor.py first" >&2
  exit 1; }

printf '\n\033[1m== the mouse pointer\033[0m\n'

rm -rf "$CURSOR_THEME"
mkdir -p "$CURSOR_THEME"
cp -r "$HERE/cursor/." "$CURSOR_THEME/"
ok "installed $CURSOR_THEME"

mkdir -p /usr/share/icons/default
cursor_ok(){ python3 "$HERE/check-cursor.py" default Confluence-blank >/dev/null 2>&1; }

# /usr/share/icons/default/index.theme is where "default" lives, and on
# Debian it is NOT an ordinary file: it is the tail of the x-cursor-theme
# update-alternatives chain, so writing to that path writes THROUGH the
# symlinks into a package-owned file. backup() cannot save us from that
# either - cp -a implies -d, so it copies the symlink and not the file
# about to be clobbered.
#
# So: update-alternatives first, because that is the supported way to say
# "prefer mine" and the only one that can be withdrawn cleanly. It can
# legitimately refuse - most likely on a Pi where an older version of
# this code already replaced the link with a plain file - and a refusal
# used to be swallowed and reported as success. Now it escalates.
USED=""
if command -v update-alternatives >/dev/null 2>&1; then
  # Points at the theme's OWN index.theme, which is the Debian
  # convention - DMZ-White and friends are registered exactly this way,
  # self-inheriting Inherits= line and all. That line is what makes it
  # work: read through the symlink at icons/default/index.theme there is
  # no cursors/ directory alongside, so the Inherits is the only thing
  # sending the lookup back here. make-blank-cursor.py writes it.
  if update-alternatives --install "$DEFAULT_INDEX" x-cursor-theme \
       "$CURSOR_THEME/index.theme" 155 >/dev/null 2>&1 &&
     update-alternatives --set x-cursor-theme "$CURSOR_THEME/index.theme" \
       >/dev/null 2>&1 && cursor_ok; then
    USED="update-alternatives"
    ok "registered as the x-cursor-theme alternative (priority 155)"
  else
    ok "update-alternatives would not take it - falling back to a plain file"
  fi
fi

if [ -z "$USED" ]; then
  backup "$DEFAULT_INDEX"
  # backup() is a no-op when there was nothing there, so leave a marker
  # of our own as well: without it the uninstaller cannot tell a file it
  # should delete from one it should merely leave alone.
  [ -f "$DEFAULT_INDEX.confluence-bak" ] || touch "$DEFAULT_INDEX.confluence-new"
  rm -f "$DEFAULT_INDEX"
  cat > "$DEFAULT_INDEX" <<'EOT'
[Icon Theme]
Name=Default
Comment=Default cursor theme
Inherits=Confluence-blank
EOT
  if cursor_ok; then
    USED="a plain index.theme"
    ok "wrote $DEFAULT_INDEX inheriting the blank theme"
  fi
fi

# Say plainly whether the pointer is actually gone. This is the whole
# point of the script, it has silently not worked before, and the only
# other place the answer shows up is on the panel at the next boot.
if [ -n "$USED" ]; then
  ok "verified: no pointer is drawn for theme 'default' or 'Confluence-blank' ($USED)"
  printf '\n   Takes effect at the next session start - reboot, or restart cage.\n\n'
else
  printf '\n   POINTER NOT HIDDEN. The details:\n\n'
  python3 "$HERE/check-cursor.py" default Confluence-blank 2>&1 | sed 's/^/   /'
  printf '\n'
  exit 1
fi
