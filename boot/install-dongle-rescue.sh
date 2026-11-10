#!/bin/bash
# =====================================================================
# Run dongle-rescue.sh at boot, and every five minutes after it.
#
#   sudo bash ~/helm/boot/install-dongle-rescue.sh
#   sudo bash ~/helm/boot/uninstall-dongle-rescue.sh
#
# Safe to run twice. Installs nothing but two unit files - no packages,
# no DKMS, no driver to rebuild when the kernel moves, which is the
# whole argument for doing it this way rather than with an out-of-tree
# module.
#
# ---- why a timer and not just boot ---------------------------------
#
# The adapter can also go away mid-voyage, and then it is in exactly the
# state this fixes with nobody at the chart table to notice. The script
# never touches an adapter that has a usable interface, so running it on
# a timer costs a directory listing every five minutes and risks
# nothing.
# =====================================================================
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="$HERE/dongle-rescue.sh"
ok(){ printf '   %s\n' "$*"; }

[ -x "$SCRIPT_PATH" ] || chmod +x "$SCRIPT_PATH"

cat > /etc/systemd/system/confluence-dongle.service <<EOT
[Unit]
Description=Rescue a USB wifi adapter whose driver did not initialise it
# After the USB bus has settled, or there is nothing to find yet.
After=systemd-udev-settle.service network-pre.target
Wants=systemd-udev-settle.service

[Service]
Type=oneshot
ExecStart=/bin/bash $SCRIPT_PATH
# Long enough for eight tries with three seconds between them, and then
# some. A rescue that is killed partway can leave the device unbound.
TimeoutStartSec=120
EOT

cat > /etc/systemd/system/confluence-dongle.timer <<'EOT'
[Unit]
Description=Check the USB wifi adapter every five minutes

[Timer]
OnBootSec=25s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOT

systemctl daemon-reload
systemctl enable --now confluence-dongle.timer >/dev/null
ok "installed and started"
ok "it runs now, 25s after each boot, and every 5 minutes"
echo
ok "watch it:    journalctl -u confluence-dongle -f"
ok "run it:      sudo bash $SCRIPT_PATH"
echo
systemctl start confluence-dongle.service || true
journalctl -u confluence-dongle -n 10 --no-pager 2>/dev/null | sed 's/^/   /' || true
