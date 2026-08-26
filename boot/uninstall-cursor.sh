#!/bin/bash
# Put the mouse pointer back.
#   sudo bash ~/helm/boot/uninstall-cursor.sh
#
# Called by both uninstall-boot-chain.sh and uninstall-cage-kiosk.sh.
# Both, deliberately: whichever one you run, you are heading back to a
# desktop, and a desktop with an invisible pointer is worse than the
# boot flash this ever existed to prevent.
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

CURSOR_THEME=/usr/share/icons/Confluence-blank
DEFAULT_INDEX=/usr/share/icons/default/index.theme

# Withdraw the alternative BEFORE deleting the theme it points at, or the
# chain is left aimed at a directory that no longer exists.
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove x-cursor-theme "$CURSOR_THEME/index.theme" \
    >/dev/null 2>&1 || true
fi

if [ -f "$DEFAULT_INDEX.confluence-bak" ]; then
  cp -a "$DEFAULT_INDEX.confluence-bak" "$DEFAULT_INDEX"
  rm -f "$DEFAULT_INDEX.confluence-bak"
  echo "   restored $DEFAULT_INDEX"
fi

# ...and if we created that file where there had been nothing, take it
# away rather than leaving a theme behind that inherits one we are about
# to delete.
if [ -f "$DEFAULT_INDEX.confluence-new" ]; then
  rm -f "$DEFAULT_INDEX" "$DEFAULT_INDEX.confluence-new"
  rmdir /usr/share/icons/default 2>/dev/null || true
  echo "   removed the default cursor index we created"
fi

rm -rf "$CURSOR_THEME"
rm -f /etc/lightdm/lightdm.conf.d/10-confluence-nocursor.conf
echo "   pointer back to normal (log out and in, or reboot)"
