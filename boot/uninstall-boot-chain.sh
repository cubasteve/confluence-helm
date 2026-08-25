#!/bin/bash
# Put the Raspberry Pi boot chain back exactly as it was.
#
# Restores every file install-boot-chain.sh backed up, returns Plymouth
# to the stock theme, and removes the Confluence theme. Poppins is left
# installed on purpose - the helm app wants it, and it is not part of
# the boot chain.
#
#   sudo bash ~/helm/boot/uninstall-boot-chain.sh
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

OWNER="${SUDO_USER:-pi}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
if [ -d /boot/firmware ]; then BOOTDIR=/boot/firmware; else BOOTDIR=/boot; fi

restore(){
  if [ -f "$1.confluence-bak" ]; then
    cp -a "$1.confluence-bak" "$1"
    rm -f "$1.confluence-bak"
    echo "   restored $1"
  else
    echo "   no backup for $1 - left alone"
  fi
}

restore "$BOOTDIR/config.txt"
restore "$BOOTDIR/cmdline.txt"
restore "$OWNER_HOME/.config/pcmanfm/LXDE-pi/desktop-items-0.conf"

if command -v plymouth-set-default-theme >/dev/null 2>&1; then
  # pix is the Raspberry Pi OS stock theme; fall back to whatever else
  # is installed if this image does not have it.
  for t in pix spinner text; do
    if [ -d "/usr/share/plymouth/themes/$t" ]; then
      plymouth-set-default-theme -R "$t" >/dev/null 2>&1 ||
      plymouth-set-default-theme "$t"    >/dev/null 2>&1 || true
      echo "   plymouth theme back to $t"
      break
    fi
  done
fi
rm -rf /usr/share/plymouth/themes/confluence
echo "   removed the Confluence theme"
echo
echo "   Poppins left installed - the helm app uses it. To remove it too:"
echo "     sudo rm -rf /usr/local/share/fonts/poppins && sudo fc-cache -f"
echo
echo "   sudo reboot"
