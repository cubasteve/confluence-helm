#!/bin/bash
# =====================================================================
# Bring up a USB wifi adapter whose driver failed to initialise it.
#
#   sudo bash ~/helm/boot/dongle-rescue.sh [tries] [gap-seconds]
#
# Installed to run at boot and every few minutes by
# install-dongle-rescue.sh. Safe to run by hand at any time, and safe
# to run while everything is working: it touches nothing that already
# has a usable interface.
#
# ---- what it is for -------------------------------------------------
#
# The boat's dongle is a Realtek RTL8188EU (0bda:8179) on the in-kernel
# rtl8xxxu driver. It enumerates, binds, loads its firmware - and then
# sometimes fails a register write partway through init:
#
#   usb 1-1.4: rtl8xxxu: Loading firmware rtlwifi/rtl8188eufw.bin
#   usb 1-1.4: Firmware revision 28.0 (signature 0x88e1)
#   usb 1-1.4: rtl8xxxu_writeN: Failed to write block at addr: 1e80 ...
#
# and never creates a network interface. From the helm that is "the
# radio did not show up at all", with nothing on the panel to tap,
# because there is genuinely no adapter for NetworkManager to manage.
#
# SOMETIMES is the word that makes this worth doing. The init is not
# impossible, it is unreliable - so unbinding the device from its
# driver and binding it again runs init afresh, and a few goes gets
# there. That is the whole of this script.
#
# ---- "a netdev exists" is NOT success -------------------------------
#
# Measured on the boat: the first rebind created wlan1 and the adapter
# still would not come up; a second rebind was what made it work. So a
# half-initialised device can present an interface that cannot be
# brought up, and a script that stopped at the first wlanN would hand
# you a dead row on the panel and call it done. The test here is that
# the interface goes UP, which is the thing that was actually failing.
# =====================================================================
set -u

# Overridable so this can be tested against a pretend /sys with pretend
# tools on the PATH, which is the only way to exercise a script whose
# whole job is to yank the boat's network adapter. tests/dongle_test.py
# drives it. Unset, they are the real thing and the root check applies.
SYS="${DONGLE_SYSFS:-/sys}"
if [ "$SYS" = "/sys" ]; then
  [ "$(id -u)" = "0" ] || { echo "run me with sudo" >&2; exit 1; }
fi

TRIES="${1:-8}"
GAP="${2:-3}"

log(){ printf '[dongle-rescue] %s\n' "$*"; }

# The drivers worth rescuing: USB wifi, nothing else. A rebind is a real
# interruption, so this never guesses - an unknown driver is left alone
# and said so, rather than being yanked on the off chance.
is_wifi_driver(){
  case "$1" in
    rtl8xxxu|r8188eu|8188eu|rtl8188eu|rtw88_8821au|rtw88_8812au) return 0;;
    mt76x0u|mt76x2u|mt7601u|mt7921u|mt7921au)                    return 0;;
    ath9k_htc|carl9170|rt2800usb|rtl8192cu|rtl8187)              return 0;;
    *) return 1;;
  esac
}

# Can this interface actually be used? Not "does it exist" - see above.
usable(){
  local dev="$1"
  ip link set "$dev" up 2>/dev/null || return 1
  # operstate on a wifi station sits at "down" or "dormant" until it
  # associates, which is fine and is not what we are asking. What we are
  # asking is whether the driver will answer for it at all.
  iw dev "$dev" info >/dev/null 2>&1
}

# Every USB interface bound to one of those drivers, as "<path> <driver>".
wifi_usb_ifaces(){
  local i d
  for i in "$SYS"/bus/usb/devices/*:*; do
    [ -L "$i/driver" ] || continue
    d=$(basename "$(readlink -f "$i/driver")")
    is_wifi_driver "$d" || continue
    printf '%s %s\n' "$i" "$d"
  done
}

# The network interface this USB interface made, if it made one.
netdev_of(){
  local n
  for n in "$1"/net/*; do [ -d "$n" ] && { basename "$n"; return 0; }; done
  return 1
}

rescued=0 looked=0
while read -r path drv; do
  [ -n "${path:-}" ] || continue
  looked=$((looked+1))
  port=$(basename "$path")

  for try in $(seq 1 "$TRIES"); do
    if dev=$(netdev_of "$path") && usable "$dev"; then
      [ "$try" = 1 ] || log "$port came up as $dev on try $try"
      break
    fi
    if [ "$try" = "$TRIES" ]; then
      log "$port ($drv) still has no usable interface after $TRIES tries - "\
"this is past what a rebind can fix"
      break
    fi
    # Unbind and bind by the interface's own name, which is what the
    # driver's bind/unbind files take.
    log "$port ($drv) has no usable interface - rebinding (try $try)"
    echo "$port" > "$SYS/bus/usb/drivers/$drv/unbind" 2>/dev/null
    sleep 1
    echo "$port" > "$SYS/bus/usb/drivers/$drv/bind"   2>/dev/null
    rescued=1
    sleep "$GAP"
  done
done <<EOF
$(wifi_usb_ifaces)
EOF

[ "$looked" = 0 ] && log "no USB wifi adapter is plugged in"
exit 0
