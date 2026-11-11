#!/bin/bash
# =====================================================================
# Stop NetworkManager randomising a wifi MAC while it scans.
#
#   sudo bash ~/helm/boot/install-wifi-mac.sh
#   sudo bash ~/helm/boot/uninstall-wifi-mac.sh
#
# Safe to run twice. Writes one file and reloads config - it does NOT
# restart NetworkManager, which is the only thing here that could drop
# the hotspot this is probably being typed over.
#
# ---- what it is for -------------------------------------------------
#
# With wifi.scan-rand-mac-address at its default of yes, NetworkManager
# gives a wifi device a fresh random MAC every five minutes for as long
# as it is NOT associated - and setting a wifi MAC means taking the
# interface administratively DOWN and back up, because wpa_supplicant
# needs that to notice the change. So an adapter that is failing to
# associate gets downed and re-upped every five minutes, for ever.
#
# On a flaky RTL8188EU that is a mechanism, not a theory: it is exactly
# the kind of repeated USB-level churn that wedges this chip, and a USB
# device reset is exactly what clears it. It is still not a DIAGNOSIS -
# the dated reports tying 8188eu to this are from 2017 and kernel 4.9,
# and their root cause was traced to wpa_supplicant and fixed long
# before Bookworm's wpa 2.10. Plausible and cheap and reversible, which
# is the whole argument for it.
#
# Debian ships a file for this already -
# /usr/lib/NetworkManager/conf.d/no-mac-addr-change.conf - but it
# matches only driver:eagle_sdio and driver:wl, so neither radio here is
# covered and randomisation is on for both.
#
# ---- why this covers BOTH radios ------------------------------------
#
# The first version scoped it to the dongle's driver, to keep the radio
# carrying the hotspot at stock behaviour. That is backwards, for two
# reasons that are both in NetworkManager's own source:
#
#   Scan randomisation cannot touch an ACTIVATED device at all -
#   _hw_addr_set_scanning() returns immediately when the device is
#   activating or activated. So while wlan0 is serving SeaWire, the
#   setting is a no-op for it either way, and the "risk" of covering it
#   is not a risk.
#
#   And if SeaWire ever drops, wlan0 becomes a scanning candidate -
#   which means NM would start taking the one radio that must come back
#   down and up every five minutes, on a driver NM's own comments flag
#   for MAC-set defects: "either due to a driver issue (brcmfmac,
#   bgo#770456, rh#1374023)", noting it "can block NetworkManager for
#   500 msec while taking down the device".
#
# So covering everything is the conservative choice, not the bold one,
# and it avoids the other trap entirely: driver: matching is exact with
# no globbing, so a driver-scoped file silently does nothing the day the
# adapter comes up on r8188eu or an out-of-tree 8188eu instead.
#
# ---- the lockout this is careful about ------------------------------
#
# A malformed file in /etc/NetworkManager/conf.d is NOT tolerated with a
# warning. nm-config.c read_config() returns FALSE on any key-file parse
# error and main.c then prints "Failed to read configuration" and
# exit(1) - so a syntax error means NetworkManager does not start at the
# next BOOT. No hotspot, no ssh, on a boat. The reload is the safe part;
# a bad file left on disk is a mine with a timer on it.
#
# Hence: parse-check before reloading, and REMOVE the file if it does
# not parse rather than leaving it to detonate later.
# =====================================================================
set -u
CONF="${WIFIMAC_CONF:-/etc/NetworkManager/conf.d/80-confluence-wifi.conf}"
SYS="${WIFIMAC_SYSFS:-/sys}"
if [ "$SYS" = "/sys" ]; then
  [ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }
fi
say(){ printf '%s\n' "$*"; }
ok(){ printf '   %s\n' "$*"; }

command -v nmcli >/dev/null 2>&1 || { say "no nmcli - nothing to configure"; exit 1; }

# ---- what is here, for the report and for the baseline ---------------
radios(){ local d; for d in "$SYS"/class/net/*; do
  [ -e "$d/phy80211" ] && basename "$d"; done; }
is_usb(){ case "$(readlink -f "$SYS/class/net/$1/device" 2>/dev/null)" in
  */usb*) return 0;; *) return 1;; esac; }
driver_of(){ nmcli -t -f GENERAL.DRIVER device show "$1" 2>/dev/null \
               | cut -d: -f2- | head -1; }

FOUND=0
for n in $(radios); do
  FOUND=1
  ok "$n  $(driver_of "$n")  $(is_usb "$n" && echo dongle || echo onboard)"
done
[ "$FOUND" = 1 ] || { say "no wifi radios at all - nothing to configure"; exit 1; }

# The MACs either side of the reload. Not scoped to one radio, because
# the file is not either: anything that moves here is worth saying.
BEFORE=$(for n in $(radios); do
  printf '%s=%s\n' "$n" "$(cat "$SYS/class/net/$n/address" 2>/dev/null)"; done)

# ---- write it --------------------------------------------------------
# Keep any previous copy, so a parse failure can put back exactly what
# was working rather than just deleting and hoping.
PREV=''
[ -f "$CONF" ] && { PREV="$CONF.prev.$$"; cp -p "$CONF" "$PREV"; }
mkdir -p "$(dirname "$CONF")"
cat > "$CONF" <<'EOT'
# Written by confluence-helm boot/install-wifi-mac.sh - do not hand-edit.
# Remove with boot/uninstall-wifi-mac.sh.
#
# Stops NetworkManager randomising a wifi MAC while it scans. Setting a
# wifi MAC means taking the interface administratively down and back up,
# and NM does it every five minutes to any device that is not
# associated - which is repeated USB churn on an adapter that is already
# struggling to associate.
#
# Covers every device on purpose. Scan randomisation already skips any
# ACTIVATED device, so this is a no-op for a radio serving an access
# point; and if that access point ever drops, this is what stops NM
# cycling it every five minutes on a driver with known MAC-set defects.
#
# Debian's /usr/lib/NetworkManager/conf.d/no-mac-addr-change.conf covers
# only driver:eagle_sdio and driver:wl. /etc is read after /usr/lib, so
# this wins.
#
# Association-time randomisation is NOT set here: wifi.cloned-mac-address
# already defaults to "preserve" (NM >= 1.6) and a global default would
# not beat a profile that sets it anyway - check the profiles instead.
# wifi.mac-address-randomization is deprecated since NM 1.4 and writing
# it would be a dead setting.
[device]
wifi.scan-rand-mac-address=no
EOT
chmod 0644 "$CONF"
ok "wrote $CONF"

# ---- prove it parses BEFORE touching the running daemon --------------
#
# --print-config reads from DISK through the same nm_config_setup() path
# the daemon uses, so it fails the same way the daemon would - which is
# the whole point, because the daemon's way of failing is to not start.
# It is safe to run beside a running NM: main.c handles the flag and
# exits before the single-instance check.
#
# It proves the file PARSES and survives precedence. It does not prove
# the daemon reloaded it, and nothing proves the setting took - NM
# exposes no effective per-device value. The journal is the only witness.
if NetworkManager --print-config 2>/dev/null | grep -q 'scan-rand-mac-address'; then
  ok "it parses, and nothing later in conf.d overrode it"
else
  rm -f "$CONF"
  if [ -n "$PREV" ]; then mv -f "$PREV" "$CONF"; ok "put the previous file back"; fi
  say ""
  say "The file did not come back from --print-config, so it has been"
  say "REMOVED. That is deliberate: a conf.d file NetworkManager cannot"
  say "parse stops it starting at the next boot, and on this boat that is"
  say "the hotspot and the ssh session with it. Nothing was reloaded."
  say "Look at:  sudo NetworkManager --print-config"
  exit 1
fi
[ -n "$PREV" ] && rm -f "$PREV"

# ---- apply -----------------------------------------------------------
# reload conf, NEVER `systemctl restart NetworkManager`. Wi-Fi devices
# are always taken down on quit - nm-device-wifi.c unmanaged_on_quit()
# is explicit about it - so a restart definitely drops the AP.
nmcli general reload conf 2>/dev/null
ok "config reloaded (not restarted - the hotspot never moved)"

# A reload REPORTS SUCCESS even when the new file failed to parse:
# nm_config_reload() logs the error, keeps the old config and returns
# void, and the D-Bus call succeeds anyway. So the exit status above is
# worth nothing and the journal is the only witness there is.
if journalctl -u NetworkManager -n 50 --no-pager 2>/dev/null \
     | grep -q 'Failed to reload the configuration'; then
  say ""
  say "WARNING: NetworkManager logged a reload failure. It is still"
  say "running on its OLD config. Remove the file before rebooting:"
  say "   sudo bash $(dirname "$0")/uninstall-wifi-mac.sh"
  exit 1
fi
ok "and the journal has no reload failure in it"

# ---- and check that nothing moved ------------------------------------
AFTER=$(for n in $(radios); do
  printf '%s=%s\n' "$n" "$(cat "$SYS/class/net/$n/address" 2>/dev/null)"; done)
if [ "$BEFORE" = "$AFTER" ]; then
  ok "every radio is on the MAC it had before"
else
  say ""
  say "WARNING: a MAC changed across the reload."
  say "before: $(echo "$BEFORE" | tr '\n' ' ')"
  say "after : $(echo "$AFTER" | tr '\n' ' ')"
fi

say ""
say "Done. It takes effect at the next SCAN, not at the reload."
say ""
say "And watch for the right thing: switching randomisation off does NOT"
say "put the old MAC back. _hw_addr_set_scanning() runs with do_reset"
say "false, so an adapter keeps whatever random MAC it last had until it"
say "next activates or deactivates. Success is the MAC no longer CHANGING"
say "across rescans - not it reverting to the one on the label."
say ""
say "   for i in 1 2 3; do nmcli device wifi rescan >/dev/null 2>&1;"
say "     sleep 20; cat $SYS/class/net/*/address | tr '\\n' ' '; echo; done"
exit 0
