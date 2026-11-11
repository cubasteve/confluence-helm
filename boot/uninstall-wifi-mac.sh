#!/bin/bash
# Undo install-wifi-mac.sh. One file, and a config reload - never a
# restart, for the same reason the installer never restarts.
set -u
CONF="${WIFIMAC_CONF:-/etc/NetworkManager/conf.d/80-confluence-wifi.conf}"
SYS="${WIFIMAC_SYSFS:-/sys}"
if [ "$SYS" = "/sys" ]; then
  [ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }
fi
if [ -f "$CONF" ]; then
  rm -f "$CONF"
  echo "   removed $CONF"
  command -v nmcli >/dev/null 2>&1 && nmcli general reload conf 2>/dev/null
  echo "   config reloaded - scan randomisation is back to NetworkManager's default"
else
  echo "   $CONF is not there; nothing to remove"
fi
exit 0
