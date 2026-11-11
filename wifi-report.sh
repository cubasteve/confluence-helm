#!/bin/bash
# What happened to the dongle.
#
# "The radio did not show up" has three different causes that look
# identical from the helm, and this says which one it was:
#
#   the kernel does not have it     a cable, a power budget, a driver
#   the kernel has it, NM does not  the stack above the hardware
#   NM has it, unmanaged            one command, and the panel's switch
#                                   is that command
#
# Read-only. It changes nothing, needs no sudo for the parts that matter,
# and is meant to be run over SSH from a phone on the hotspot:
#
#     bash ~/helm/wifi-report.sh
#
set -u
line() { printf '\n== %s ==\n' "$1"; }

line "what the kernel has"
for d in /sys/class/net/*; do
  n=$(basename "$d")
  [ -e "$d/phy80211" ] || [ -d "$d/wireless" ] || continue
  printf '  %-8s %s  %s\n' "$n" \
    "$(cat "$d/address" 2>/dev/null)" \
    "$(case "$(readlink -f "$d/device" 2>/dev/null)" in */usb*) echo USB;; *) echo onboard;; esac)"
done
[ -n "$(ls -d /sys/class/net/*/phy80211 2>/dev/null)" ] || echo "  none"

line "what NetworkManager reports"
# STATE and REASON together, because the pair is the whole diagnosis.
# `unavailable` says the stack will not use this adapter; the reason
# says whether that is the radio being switched off, which is fine, or
# the driver having given up on it, which is not - and those two look
# identical from the helm, where the switch simply does not take.
nmcli -t -f GENERAL.DEVICE,GENERAL.TYPE,GENERAL.STATE,GENERAL.REASON \
      device show 2>/dev/null \
  | awk -F: '/GENERAL.DEVICE/{d=$2} /GENERAL.TYPE/{t=$2}
             /GENERAL.STATE/{s=substr($0,index($0,":")+1)}
             /GENERAL.REASON/{if(t=="wifi") printf "  %-8s %-28s %s\n", d, s, substr($0,index($0,":")+1)}'

line "switched off, or given up on"
# Straight out of sysfs, so it needs no rfkill binary and no sudo. An
# adapter that is BLOCKED is one somebody turned off and there is
# nothing to fix. An adapter that is unavailable and NOT blocked is one
# the driver enumerated and then failed - which is the case where the
# panel shows the radio, the switch does nothing, and re-seating the
# device is the only thing that helps.
for d in /sys/class/net/*; do
  n=$(basename "$d"); [ -e "$d/phy80211" ] || continue
  soft='-'; hard='-'
  for r in "$d"/phy80211/rfkill*; do
    [ -r "$r/soft" ] && soft=$(cat "$r/soft" 2>/dev/null)
    [ -r "$r/hard" ] && hard=$(cat "$r/hard" 2>/dev/null)
  done
  printf '  %-8s soft=%s hard=%s\n' "$n" "$soft" "$hard"
done
[ -n "$(ls -d /sys/class/net/*/phy80211 2>/dev/null)" ] || echo "  no phy at all"

line "is the rescue installed, and has it run"
if systemctl list-unit-files 2>/dev/null | grep -q '^dongle-rescue'; then
  systemctl is-enabled dongle-rescue.timer 2>/dev/null \
    | sed 's/^/  timer: /'
  systemctl list-timers dongle-rescue.timer --no-pager 2>/dev/null | sed -n '2p;3p' \
    | sed 's/^/  /'
  journalctl -u dongle-rescue --since '30 min ago' --no-pager 2>/dev/null \
    | tail -12 | sed 's/^/  /' || echo "  (journal needs sudo)"
else
  echo "  NOT INSTALLED - sudo bash ~/helm/boot/install-dongle-rescue.sh"
fi

line "what netd is serving the panel"
curl -sf --max-time 3 http://127.0.0.1:8091/status \
  | python3 -c 'import json,sys
s=json.load(sys.stdin).get("wifi",{})
for d in s.get("devices",[]):
    print("  %-8s up=%-5s managed=%-5s %s" % (d["dev"], d["up"], d.get("managed"), d.get("ssid") or ""))
print("  NOT REPORTED BY NM:", ", ".join(s.get("unseen") or []) or "none")' 2>/dev/null \
  || echo "  netd is not answering on 127.0.0.1:8091"

line "USB, this boot"
dmesg 2>/dev/null | grep -iE 'usb|80211|wlan' | tail -25 \
  || echo "  dmesg needs sudo here: sudo dmesg | grep -i usb"

line "NetworkManager, last 10 minutes"
journalctl -u NetworkManager --since '10 min ago' --no-pager 2>/dev/null | tail -25 \
  || echo "  journalctl needs sudo here"

line "power saving"
for d in /sys/class/net/*; do
  n=$(basename "$d")
  [ -e "$d/phy80211" ] || continue
  printf '  %-8s %s\n' "$n" "$(iw dev "$n" get power_save 2>/dev/null || echo '?')"
done
