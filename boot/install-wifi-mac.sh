#!/bin/bash
# =====================================================================
# Stop NetworkManager randomising the USB wifi dongle's MAC while it
# scans.
#
#   sudo bash ~/helm/boot/install-wifi-mac.sh
#   sudo bash ~/helm/boot/uninstall-wifi-mac.sh
#
# Safe to run twice. Writes one file and reloads config - it does NOT
# restart NetworkManager, which is the only thing here that could drop
# the hotspot this is probably being typed over.
#
# ---- what this is, honestly -----------------------------------------
#
# Several Realtek 8188-family adapters fail to apply a randomised MAC,
# after which NetworkManager retries in a loop and the adapter
# authenticates but never associates. Debian ships a file for exactly
# this - /usr/lib/NetworkManager/conf.d/no-mac-addr-change.conf - but it
# matches only driver:eagle_sdio and driver:wl, so rtl8xxxu is not
# covered and randomisation is ON here.
#
# It is INSURANCE, not a diagnosis. The dated evidence tying 8188eu to
# this is from 2017 and kernel 4.9, its root cause was traced to
# wpa_supplicant and fixed long before Bookworm's wpa 2.10, and the
# documented signature is "authenticates but will not associate" - not
# "present but will not turn on, cleared by a USB reset", which is what
# this boat saw. Applied because it is one reversible file and costs
# nothing, not because it is known to be the fault.
#
# ---- why it is scoped by DRIVER -------------------------------------
#
# wlan0 carries the SeaWire access point and is the only way onto this
# boat. Scoping keeps it at stock behaviour, and the scoping fails the
# right way: an unrecognised match-device spec is not an error and is
# not logged - the section simply never matches, the key is never read,
# and randomisation stays ON for the dongle. A typo means "the fix did
# not apply", never "wlan0 changed behaviour".
#
# By driver and not by interface name, because wlan0/wlan1 here are
# kernel-assigned and systemd documents those as not fixed across boots
# - and a USB re-enumeration of this dongle can bring it back as wlan2.
#
# Two traps, both avoided below and both asserted by the probe:
#   - commas in match-device are OR, not AND. "driver:x,type:wifi" would
#     WIDEN this to both radios.
#   - a match-device made only of "except:" specs INVERTS and matches
#     every device, wlan0 included.
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

# ---- find the dongle, and read its driver off the box ----------------
#
# The research for this said "confirm the DRIVER string by hand before
# writing the file, byte for byte". That is a step to be skipped at 2
# a.m., and skipping it produces a file that looks applied and is not.
# So it is not a step: the script reads the string and writes what it
# read. The 8188eu family is served by rtl8xxxu in-tree, r8188eu in
# staging and 8188eu out-of-tree, and the value is compared exactly,
# with no globbing.
usb_wifi(){
  local d p
  for d in "$SYS"/class/net/*; do
    [ -e "$d/phy80211" ] || continue
    p=$(readlink -f "$d/device" 2>/dev/null) || continue
    case "$p" in */usb*) basename "$d"; return 0;; esac
  done
  return 1
}
driver_of(){ nmcli -t -f GENERAL.DRIVER device show "$1" 2>/dev/null \
               | cut -d: -f2- | head -1; }

DEV=$(usb_wifi) || {
  say "No USB wifi adapter is present."
  say "This configures the DONGLE and nothing else, so there is nothing"
  say "to do until it is plugged in and enumerating. Nothing was changed."
  exit 1; }
DRV=$(driver_of "$DEV")
[ -n "$DRV" ] || {
  say "NetworkManager does not report a driver for $DEV."
  say "Writing a match-device for an empty string would match nothing and"
  say "look like it had worked. Nothing was changed."
  exit 1; }

say "the dongle is $DEV, driver $DRV"

# Scoping by driver only helps if the OTHER radio does not share it. If
# it does, this would quietly change the adapter carrying the hotspot,
# which is the one outcome worth refusing over.
for d in "$SYS"/class/net/*; do
  [ -e "$d/phy80211" ] || continue
  n=$(basename "$d"); [ "$n" = "$DEV" ] && continue
  if [ "$(driver_of "$n")" = "$DRV" ]; then
    say ""
    say "REFUSING: $n also uses $DRV."
    say "Scoping by driver would catch it too, and $n may be the radio"
    say "carrying the hotspot. Nothing was changed."
    exit 1
  fi
done

# ---- a baseline for the one thing that must not move -----------------
AP=''; APMAC=''
for d in "$SYS"/class/net/*; do
  [ -e "$d/phy80211" ] || continue
  n=$(basename "$d"); [ "$n" = "$DEV" ] && continue
  AP=$n; APMAC=$(cat "$d/address" 2>/dev/null); break
done
[ -n "$AP" ] && ok "leaving $AP alone (currently $APMAC)"

# ---- write it --------------------------------------------------------
mkdir -p "$(dirname "$CONF")"
cat > "$CONF" <<EOT
# Written by confluence-helm boot/install-wifi-mac.sh - do not hand-edit.
# Remove with boot/uninstall-wifi-mac.sh.
#
# Stops NetworkManager randomising the MAC of the USB wifi dongle while
# it scans. Several Realtek 8188-family adapters fail to apply the
# randomised address and then never associate.
#
# Scoped to the dongle's driver so the radio carrying the hotspot keeps
# stock behaviour. ONE positive spec on purpose: commas here mean OR,
# so adding another would widen this to every matching device, and an
# "except:"-only list inverts and matches everything.
#
# Debian's own /usr/lib/NetworkManager/conf.d/no-mac-addr-change.conf
# covers only driver:eagle_sdio and driver:wl, which is why this exists.
# /etc/NetworkManager/conf.d is read after /usr/lib, so this wins.
[device-confluence-no-scan-mac-rand]
match-device=driver:$DRV
wifi.scan-rand-mac-address=no
EOT
chmod 0644 "$CONF"
ok "wrote $CONF"

# ---- prove it parses BEFORE touching the running daemon --------------
# --print-config reads from DISK, so this is safe and proves the file
# parses and survives precedence. It does NOT prove the daemon reloaded
# it, and nothing anywhere proves the match matched - NetworkManager
# exposes no effective per-device value. The only real proof is
# behavioural, which is what the last step looks for.
if NetworkManager --print-config 2>/dev/null \
     | grep -q 'device-confluence-no-scan-mac-rand'; then
  ok "it parses, and nothing later in conf.d overrode it"
else
  say ""
  say "WARNING: the section did not come back from --print-config."
  say "Something in conf.d may sort after 80- and override it. The file"
  say "is written; config was NOT reloaded. Check with:"
  say "   sudo NetworkManager --print-config | grep -i scan-rand"
  exit 1
fi

# ---- apply -----------------------------------------------------------
# reload conf, NEVER `systemctl restart NetworkManager`. A restart is
# the one action here that can take the access point down, and the
# access point is the way onto this boat.
nmcli general reload conf 2>/dev/null
ok "config reloaded (not restarted - the hotspot never moved)"

# ---- and check that it did not ---------------------------------------
if [ -n "$AP" ]; then
  NOW=$(cat "$SYS/class/net/$AP/address" 2>/dev/null)
  if [ "$NOW" = "$APMAC" ]; then
    ok "$AP is still $NOW"
  else
    say ""
    say "WARNING: $AP's MAC changed from $APMAC to $NOW."
    say "Undo with: sudo bash $(dirname "$0")/uninstall-wifi-mac.sh"
  fi
fi

say ""
say "Done. It takes effect on the next scan, not on the reload. To see it:"
say "   sudo nmcli device wifi rescan ifname $DEV"
say "   cat $SYS/class/net/$DEV/address"
say "A randomised address has the 02 bit set in its first octet (02:, 06:,"
say "0a:, 0e:) and rotates; the permanent one does not move."
exit 0
