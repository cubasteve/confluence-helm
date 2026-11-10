#!/bin/bash
# Take the dongle rescue back off. See install-dongle-rescue.sh.
#   sudo bash ~/helm/boot/uninstall-dongle-rescue.sh
set -u
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }
systemctl disable --now confluence-dongle.timer 2>/dev/null
systemctl stop confluence-dongle.service 2>/dev/null
rm -f /etc/systemd/system/confluence-dongle.service \
      /etc/systemd/system/confluence-dongle.timer
systemctl daemon-reload
echo "   removed - the adapter is on its own again"
