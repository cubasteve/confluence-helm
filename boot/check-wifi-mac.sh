#!/bin/bash
# =====================================================================
# Is NetworkManager randomising a wifi MAC while it scans?
#
#   bash ~/helm/boot/check-wifi-mac.sh
#
# READ-ONLY. It writes nothing and reloads nothing, on purpose - see
# below. Needs no sudo for the part that matters.
#
# ---- why this is a check and not a fix ------------------------------
#
# It started out as install-wifi-mac.sh, which wrote
# /etc/NetworkManager/conf.d/80-confluence-wifi.conf with
# wifi.scan-rand-mac-address=no. That file was a no-op, because
# Raspberry Pi OS has already done it - and finding that out killed the
# theory behind it.
#
# Raspberry Pi does not ship Debian's network-manager. It ships its own
# rebuild, and the ONLY thing the rebuild changes is this:
#
#   network-manager (1.42.4-1+rpt1+deb12u1) bookworm; urgency=medium
#     * NetworkManager.conf: disable MAC randomization feature
#    -- Serge Schneider <serge@raspberrypi.com>  Mon, 07 Apr 2025
#
# The binary ships /etc/NetworkManager/NetworkManager.conf as a dpkg
# CONFFILE, and it reads, in full:
#
#   [main]
#   plugins=ifupdown,keyfile
#   [ifupdown]
#   managed=false
#   [device]
#   wifi.scan-rand-mac-address=no
#
# A bare [device] section, so it covers every radio, and it has been
# there since the image was built. Two things follow.
#
# ONE: scan-time MAC randomisation was already OFF while the dongle was
# failing, so it cannot have been the cause. Whatever wedged that
# adapter, it was not this. Keep looking.
#
# TWO: writing another file would have been worse than useless. Every
# config file merges into ONE keyfile, group by group, so a second bare
# [device] section merges into the distro's. Today that writes the same
# key with the same value and changes nothing - but it leaves a section
# sitting there that anyone adding a match-device to would silently
# NARROW the distro's global setting, re-enabling five-minutely
# down/up MAC churn on the radio carrying the hotspot. And a conf.d
# file NetworkManager cannot parse is fatal at STARTUP, not at reload:
# no hotspot, no ssh, at the next power cycle.
#
# So: no file. The conffile can still be edited by hand or by an image
# builder, which is the one thing worth checking, and that is all this
# does.
# =====================================================================
set -u
ETC="${WIFIMAC_ETC:-/etc/NetworkManager}"
LIB="${WIFIMAC_LIB:-/usr/lib/NetworkManager/conf.d}"
RUN="${WIFIMAC_RUN:-/run/NetworkManager/conf.d}"
say(){ printf '%s\n' "$*"; }
ok(){ printf '   %s\n' "$*"; }

say ""
say "== where scan randomisation is set =="
HITS=$(grep -rn 'scan-rand-mac-address' "$ETC" "$LIB" "$RUN" 2>/dev/null)
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" | sed 's/^/   /'
else
  ok "nowhere - which means it is at NetworkManager's default of YES"
fi

say ""
say "== what the merged config actually says =="
# --print-config reads from disk through the same path the daemon uses
# and merges every file in precedence order - so this, and not the grep
# above, is what NM will act on. Safe to run beside a running daemon.
VERDICT=unknown
if command -v NetworkManager >/dev/null 2>&1; then
  MERGED=$(NetworkManager --print-config 2>/dev/null \
           | grep 'scan-rand-mac-address' | head -1 | tr -d ' ')
  case "$MERGED" in
    *=no)  VERDICT=off; ok "scan-rand-mac-address=no" ;;
    *=yes) VERDICT=on;  ok "scan-rand-mac-address=yes" ;;
    *)     VERDICT=on
           ok "not in the merged config at all, so NetworkManager's own"
           ok "default of YES applies" ;;
  esac
else
  # No binary to ask, so the grep above is all there is - and it cannot
  # see precedence. Say that rather than guessing: an answer of "it is
  # on" would send someone reinstalling a package over a link that may
  # be the thing at fault.
  ok "no NetworkManager binary here to merge the files, so this cannot"
  ok "be answered properly - the grep above is the best there is"
fi

say ""
say "== has the distro conffile been changed =="
CONF="$ETC/NetworkManager.conf"
STOCK=ff117aea5e8fc25e075df0f18a5f7b45     # 1.42.4-1+rpt1+deb12u1, arm64
if [ -r "$CONF" ]; then
  NOW=$(md5sum "$CONF" 2>/dev/null | cut -d' ' -f1)
  if [ "$NOW" = "$STOCK" ]; then
    ok "$CONF is byte-for-byte the Raspberry Pi OS original"
  else
    ok "$CONF differs from the shipped original (md5 $NOW)"
    ok "which is fine if it was deliberate - the merged value above is"
    ok "what decides it"
    sed 's/^/     | /' "$CONF"
  fi
else
  ok "no $CONF at all - not a stock Raspberry Pi OS box"
fi

say ""
case "$VERDICT" in
  off) say "Scan randomisation is OFF, as Raspberry Pi OS ships it. Nothing"
       say "to do - and nothing this setting could have caused." ;;
  on)  say "Scan randomisation is ON, which is NOT the Raspberry Pi OS"
       say "default. Restore it rather than layering another file on top -"
       say "every config file merges into one keyfile, so a second [device]"
       say "section is a footgun for whoever reads it next:"
       say "   sudo apt install --reinstall network-manager"
       say "   sudo nmcli general reload conf"
       say "Never 'systemctl restart NetworkManager' - wifi devices are"
       say "always taken down on quit, and that drops the hotspot." ;;
  *)   say "Could not determine it. Run this on the Pi itself." ;;
esac
exit 0
