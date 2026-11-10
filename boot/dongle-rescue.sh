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

# ---- finding it ------------------------------------------------------
#
# Two ways, because the interesting case has neither a driver nor an
# interface. Measured on the boat: with rtl8xxxu having failed, the
# device sat there with NO driver symlink at all, and a first version of
# this script - which looked only for interfaces bound to a known wifi
# driver - reported "no USB wifi adapter is plugged in" about a dongle
# that was plugged in. It found nothing because there was nothing bound
# to find.
#
#   iface:<driver>  an interface IS bound to a wifi driver. Rebind that
#                   interface on that driver, which is the move proved by
#                   hand on the water.
#   id              nothing is bound, but we recognise the device. Reset
#                   the whole USB device instead and let every driver
#                   re-probe it, which is the stronger reset and the only
#                   one available when there is no driver to unbind from.

is_wifi_driver(){
  case "$1" in
    rtl8xxxu|r8188eu|8188eu|rtl8188eu|rtw88_8821au|rtw88_8812au) return 0;;
    mt76x0u|mt76x2u|mt7601u|mt7921u|mt7921au)                    return 0;;
    ath9k_htc|carl9170|rt2800usb|rtl8192cu|rtl8187)              return 0;;
    *) return 1;;
  esac
}

# Only consulted when nothing is bound. The log names any USB device it
# could not place, so adding one here is a line and the journal says
# which line to add.
is_wifi_id(){
  case "$1" in
    0bda:8179|0bda:8176|0bda:8178|0bda:f179) return 0;;   # Realtek 8188/8192
    0bda:b812|0bda:b82c|0bda:c811)           return 0;;   # Realtek 88x2
    148f:5370|148f:5372|148f:3070)           return 0;;   # Ralink
    0e8d:7610|0e8d:7612|0e8d:7961)           return 0;;   # MediaTek
    0cf3:9271|0cf3:1006)                     return 0;;   # Atheros
    *) return 1;;
  esac
}

usb_id(){ printf '%s:%s' "$(cat "$1/idVendor" 2>/dev/null)" \
                         "$(cat "$1/idProduct" 2>/dev/null)"; }

# USB device directories: 1-1.4 and not 1-1.4:1.0, and not usb1.
usb_devices(){
  local dev
  for dev in "$SYS"/bus/usb/devices/*; do
    [ -d "$dev" ] || continue
    case "$(basename "$dev")" in *:*|usb*) continue;; esac
    [ -f "$dev/idVendor" ] || continue
    printf '%s\n' "$dev"
  done
}

# "<devpath> iface:<driver>" or "<devpath> id", for each one worth it.
candidates(){
  local dev i d how
  while read -r dev; do
    [ -n "${dev:-}" ] || continue
    how=''
    for i in "$dev":*; do
      [ -L "$i/driver" ] || continue
      d=$(basename "$(readlink -f "$i/driver")")
      if is_wifi_driver "$d"; then how="iface:$d"; break; fi
    done
    [ -n "$how" ] || { is_wifi_id "$(usb_id "$dev")" && how='id'; }
    [ -n "$how" ] && printf '%s %s\n' "$dev" "$how"
  done <<EOT
$(usb_devices)
EOT
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

# The network interface this DEVICE made, through any of its interfaces.
netdev_of(){
  local i n
  for i in "$1":*; do
    [ -d "$i/net" ] || continue
    for n in "$i"/net/*; do [ -d "$n" ] && { basename "$n"; return 0; }; done
  done
  return 1
}

rebind(){               # <devpath> <how>
  local dev="$1" how="$2" drv i port
  port=$(basename "$dev")
  if [ "${how#iface:}" != "$how" ]; then
    drv="${how#iface:}"
    for i in "$dev":*; do
      [ -L "$i/driver" ] || continue
      echo "$(basename "$i")" > "$SYS/bus/usb/drivers/$drv/unbind" 2>/dev/null
      sleep 1
      echo "$(basename "$i")" > "$SYS/bus/usb/drivers/$drv/bind"   2>/dev/null
    done
  else
    # Nothing to unbind an interface FROM, so reset the device itself.
    echo "$port" > "$SYS/bus/usb/drivers/usb/unbind" 2>/dev/null
    sleep 1
    echo "$port" > "$SYS/bus/usb/drivers/usb/bind"   2>/dev/null
  fi
}

rescued=0 looked=0
while read -r path how; do
  [ -n "${path:-}" ] || continue
  looked=$((looked+1))
  port=$(basename "$path")
  [ "$how" = id ] && log "$port ($(usb_id "$path")) is plugged in with no "\
"driver bound - resetting the device itself"

  for try in $(seq 1 "$TRIES"); do
    if dev=$(netdev_of "$path") && usable "$dev"; then
      [ "$try" = 1 ] || log "$port came up as $dev on try $try"
      break
    fi
    if [ "$try" = "$TRIES" ]; then
      log "$port still has no usable interface after $TRIES tries - "\
"this is past what a rebind can fix"
      break
    fi
    log "$port has no usable interface - rebinding (try $try)"
    rebind "$path" "$how"
    rescued=1
    sleep "$GAP"
  done
done <<EOF
$(candidates)
EOF

# Saying "nothing plugged in" and stopping is what sent this round the
# houses once already. If nothing matched, name every USB device that is
# there, so the journal itself says which id to add to is_wifi_id().
if [ "$looked" = 0 ]; then
  log "no USB wifi adapter found. What is on the bus:"
  while read -r dev; do
    [ -n "${dev:-}" ] || continue
    log "   $(basename "$dev")  $(usb_id "$dev")  $(cat "$dev/product" 2>/dev/null)"
  done <<EOT
$(usb_devices)
EOT
  log "if one of those is the adapter, its id belongs in is_wifi_id()"
fi
exit 0
