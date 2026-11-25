#!/bin/bash
# =====================================================================
# Keep the Confluence splash through apt upgrades.
#
# A Raspberry Pi OS full-upgrade reset Plymouth's default theme to
# 'pix' and the boat booted to raspberries. This installs a guard that
# apt runs after every dpkg run, which puts the theme back (and rebuilds
# the initramfs) only when something has changed it.
#
#   sudo bash ~/helm/boot/install-splash-guard.sh
#
# install-boot-chain.sh runs this too; it is its own script so the
# guard can go on without re-running the whole chain. Safe to run twice.
# uninstall-boot-chain.sh removes it.
#
# The guard is COPIED to /usr/local/sbin, root-owned, rather than run
# from ~/helm: apt runs it as root, so it must not be a file the
# desktop user can edit.
# =====================================================================
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD=/usr/local/sbin/confluence-splash-guard
HOOK=/etc/apt/apt.conf.d/99confluence-splash
ok(){ printf '   %s\n' "$*"; }

install -D -o root -g root -m 0755 "$HERE/splash-guard.sh" "$GUARD"
ok "installed $GUARD"

# Check the snippet parses before apt has to: a broken file in
# apt.conf.d stops every apt command until it is removed.
if command -v apt-config >/dev/null 2>&1 &&
   ! APT_CONFIG="$HERE/99confluence-splash" apt-config dump >/dev/null 2>&1; then
  echo "   ERROR: $HERE/99confluence-splash does not parse - hook NOT installed" >&2
  exit 1
fi
install -o root -g root -m 0644 "$HERE/99confluence-splash" "$HOOK"
ok "installed $HOOK"

# Once now, so a theme already lost to an earlier upgrade comes back
# without waiting for the next one. Silent if all is well.
"$GUARD"
if command -v plymouth-set-default-theme >/dev/null 2>&1; then
  ok "plymouth default is: $(plymouth-set-default-theme 2>/dev/null || echo '?')"
else
  ok "plymouth is not installed - the guard will do nothing until it is"
fi
