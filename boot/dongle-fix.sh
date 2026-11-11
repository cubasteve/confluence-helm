#!/bin/bash
# =====================================================================
# Diagnose and revive the USB wifi dongle, with NO INTERNET and
# nothing installed. Run it by hand:
#
#     sudo bash dongle-fix.sh          # look, then fix
#     sudo bash dongle-fix.sh --look   # look only, change nothing
#
# ---- why this exists alongside dongle-rescue.sh ---------------------
#
# dongle-rescue.sh is the TIMER. It is deliberately timid: it runs
# unattended every five minutes and must never yank an adapter that is
# working, so it asks one question and leaves if the answer is good.
# That is what made it useless in the state reported off the boat -
# "I do see it, and it will not turn on" - because a half-initialised
# RTL8188EU answers that question perfectly well. It broke out of the
# loop on the first try and, because the log line for try 1 is
# suppressed, printed NOTHING on the way out. From the helm that is a
# script that does not work.
#
# This one is the HAMMER. It is run by a person who has already decided
# the adapter is broken, so it does not have to be careful about that
# judgement - it only has to be careful not to cut the branch it is
# sitting on. It escalates until something works and says what it did.
#
# ---- the one thing it must not do -----------------------------------
#
# The boat SSHes in over the hotspot on the INTERNAL radio. Everything
# here is scoped to one USB device. It never touches `nmcli radio`,
# never unloads brcmfmac, and never resets a device that is not the
# dongle - because locking the owner out of the box is a worse outcome
# than a dongle that stays dead.
# =====================================================================
set -u
LOOK=0; [ "${1:-}" = "--look" ] && LOOK=1
# Overridable for the same reason dongle-rescue.sh overrides it: the only
# way to exercise a script whose job is to yank the boat's network adapter
# is to point it at a pretend /sys with pretend tools on the PATH.
# tests/donglefix_test.py drives it. Unset, it is the real thing and the
# root check applies.
SYS="${DONGLE_SYSFS:-/sys}"
ROUNDS="${DONGLE_ROUNDS:-3}"
SETTLE="${DONGLE_SETTLE:-4}"   # after a rung, for NM to catch up
NAP="${DONGLE_NAP:-2}"         # inside a rung, between unbind and bind
if [ "$SYS" = "/sys" ]; then
  [ "$LOOK" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run me with sudo (or --look)" >&2; exit 1; }
fi

say(){ printf '%s\n' "$*"; }
# A reset needs the kernel to notice, re-enumerate and let NetworkManager
# catch up, which is seconds and not milliseconds. The pretend kernel in
# tests/donglefix_test.py needs none of it, and a probe that waited the
# real time would take minutes.
nap(){ sleep "$NAP"; }
hr(){ printf '\n== %s ==\n' "$*"; }

# ---- find it ---------------------------------------------------------
# By USB id, not by driver: the whole point is that the driver may have
# given up and left no symlink behind to find it by.
WIFI_IDS='0bda:8179 0bda:8176 0bda:8178 0bda:f179 0bda:b812 0bda:c812
0bda:8812 0bda:881a 0bda:b711 2357:010c 2357:0109 0846:9052 7392:7811'
PORT=''; VIDPID=''
for d in "$SYS"/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  id="$(cat "$d/idVendor"):$(cat "$d/idProduct")"
  case " $WIFI_IDS " in *" $id "*) PORT=$(basename "$d"); VIDPID=$id; break;; esac
done

hr "what is on the USB bus"
for d in "$SYS"/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  printf '  %-8s %s:%s  %s\n' "$(basename "$d")" \
    "$(cat "$d/idVendor")" "$(cat "$d/idProduct")" \
    "$(cat "$d/product" 2>/dev/null)"
done
if [ -z "$PORT" ]; then
  say ""
  say "  NO KNOWN WIFI DONGLE ON THE BUS."
  say "  If one of the lines above IS the adapter, its id belongs in WIFI_IDS."
  say "  If none of them is, the Pi is not seeing the device at all - that is a"
  say "  cable, a port or a dead dongle, and no amount of software will help."
  exit 1
fi
say ""
say "  the dongle is $PORT ($VIDPID)"

# ---- what state is it in --------------------------------------------
iface_of(){ for i in "$SYS"/bus/usb/devices/"$PORT":*; do
    [ -d "$i" ] && { basename "$i"; return 0; }; done; return 1; }
netdev_of(){ for i in "$SYS"/bus/usb/devices/"$PORT":*; do
    for n in "$i"/net/*; do [ -d "$n" ] && { basename "$n"; return 0; }; done
  done; return 1; }
drv_of(){ for i in "$SYS"/bus/usb/devices/"$PORT":*; do
    [ -L "$i/driver" ] && { basename "$(readlink -f "$i/driver")"; return 0; }
  done; return 1; }

nm_state(){ command -v nmcli >/dev/null 2>&1 || { echo '(no nmcli)'; return; }
  nmcli -t -f DEVICE,STATE device status 2>/dev/null \
    | awk -F: -v d="$1" '$1==d{print $2; f=1} END{if(!f) print "(not listed)"}'; }
nm_reason(){ command -v nmcli >/dev/null 2>&1 || return
  nmcli -t -f GENERAL.REASON device show "$1" 2>/dev/null | cut -d: -f2-; }
# Soft or hard rfkill, straight out of sysfs - no rfkill binary, no root.
blocked(){ local r v
  for r in "$SYS"/class/net/"$1"/phy80211/rfkill*; do
    [ -d "$r" ] || continue
    for v in soft hard; do
      [ -r "$r/$v" ] && [ "$(cat "$r/$v" 2>/dev/null)" = 1 ] && { echo "$v"; return 0; }
    done
  done; return 1; }

report(){
  local dev drv b
  drv=$(drv_of || echo 'NONE - the driver gave up and let go of it')
  dev=$(netdev_of || echo '')
  say "  driver bound : $drv"
  if [ -z "$dev" ]; then
    say "  interface    : NONE - init never got far enough to make one"
  else
    say "  interface    : $dev"
    b=$(blocked "$dev" || true)
    say "  rfkill       : ${b:+$b-BLOCKED (something turned this radio OFF)}${b:-not blocked}"
    say "  NM state     : $(nm_state "$dev")"
    say "  NM reason    : $(nm_reason "$dev")"
  fi
}

hr "what state the dongle is in"
report

# ---- is the other driver even an option -----------------------------
# The decisive no-internet question. If r8188eu is on disk, swapping to
# it is a real fix and costs no download. If it is not, every "just use
# r8188eu" answer on the internet needs a download first, and saying so
# here saves an evening of looking for it.
hr "is the other driver on this box"
say "  kernel       : $(uname -r)"
if modinfo r8188eu >/dev/null 2>&1; then
  say "  r8188eu      : PRESENT - $(modinfo -n r8188eu 2>/dev/null)"
  say "                 swapping to it is possible with no download."
else
  say "  r8188eu      : not on this kernel"
  say "                 (removed from mainline staging in 6.7; rtl8xxxu is all"
  say "                  there is here unless something is installed, and"
  say "                  installing needs the internet this adapter was for)"
fi
say "  rtl8xxxu     : $(modinfo -n rtl8xxxu 2>/dev/null || echo 'not found?')"
say "  firmware     : $(ls /lib/firmware/rtlwifi/rtl8188eufw.bin 2>/dev/null || echo MISSING)"

hr "what the kernel said about it"
dmesg 2>/dev/null | grep -iE 'rtl8|8188|usb 1-|insufficient' | tail -14 \
  | sed 's/^/  /' || say "  (dmesg needs sudo)"

hr "power"
say "  throttled    : $(vcgencmd get_throttled 2>/dev/null || echo '(no vcgencmd)')"
say "  bMaxPower    : $(cat "$SYS"/bus/usb/devices/"$PORT"/bMaxPower 2>/dev/null)"
say "  speed        : $(cat "$SYS"/bus/usb/devices/"$PORT"/speed 2>/dev/null) Mb/s"

[ "$LOOK" = 1 ] && { say ""; say "(--look: nothing was changed)"; exit 0; }

# ---- is it actually broken ------------------------------------------
# One question, asked properly. An interface EXISTING is not the test -
# that is the mistake the timer makes. Nor is the link being down: that
# is what the panel's own off switch leaves behind, and what rfkill
# leaves behind, and neither is a fault. The test is whether the stack
# will USE it.
working(){
  local dev st
  dev=$(netdev_of) || return 1
  blocked "$dev" >/dev/null && return 0        # off on purpose, not broken
  st=$(nm_state "$dev")
  case "$st" in
    unavailable|failed|'(not listed)') return 1 ;;
    *) return 0 ;;
  esac
}

hr "fixing it"
if working; then
  dev=$(netdev_of)
  say "  $dev is in a state NetworkManager will use ($(nm_state "$dev"))."
  say "  Nothing here is broken in the way this script fixes. If the panel's"
  say "  switch still does nothing, the fault is above the driver - say so and"
  say "  send the block above."
  exit 0
fi

# The ladder, gentlest first. Each rung is re-tested, because the rung
# that works tells you what was actually wrong.
try_rung(){                   # <name> <command...>
  say ""
  say "  -> $1"
  shift
  "$@" >/dev/null 2>&1
  sleep "$SETTLE"
  if working; then
    say "     WORKED. $(netdev_of) is $(nm_state "$(netdev_of)")."
    return 0
  fi
  say "     no change ($(netdev_of || echo 'still no interface'))"
  return 1
}

rung_driver_cycle(){
  local i drv
  drv=$(drv_of) || return 1
  for i in "$SYS"/bus/usb/devices/"$PORT":*; do
    [ -L "$i/driver" ] || continue
    printf '%s' "$(basename "$i")" > "$SYS/bus/usb/drivers/$drv/unbind" 2>/dev/null
    nap
    printf '%s' "$(basename "$i")" > "$SYS/bus/usb/drivers/$drv/bind" 2>/dev/null
  done
}
rung_device_reset(){
  printf '%s' "$PORT" > "$SYS"/bus/usb/drivers/usb/unbind 2>/dev/null
  nap
  printf '%s' "$PORT" > "$SYS"/bus/usb/drivers/usb/bind 2>/dev/null
}
rung_authorized(){
  printf '0' > "$SYS"/bus/usb/devices/"$PORT"/authorized 2>/dev/null
  nap
  printf '1' > "$SYS"/bus/usb/devices/"$PORT"/authorized 2>/dev/null
}
rung_module(){
  # Scoped deliberately: rtl8xxxu only. brcmfmac is the internal radio,
  # which is carrying the hotspot this session is running over.
  modprobe -r rtl8xxxu 2>/dev/null
  nap
  modprobe rtl8xxxu 2>/dev/null
}
rung_nm(){
  local dev; dev=$(netdev_of) || return 1
  nmcli device set "$dev" managed yes 2>/dev/null
  nmcli device set "$dev" autoconnect yes 2>/dev/null
}

for round in $(seq 1 "$ROUNDS"); do
  say ""
  say "  --- round $round of $ROUNDS ---"
  try_rung "hand it back to NetworkManager"        rung_nm            && exit 0
  try_rung "rebind the interface to its driver"    rung_driver_cycle  && exit 0
  try_rung "reset the whole USB device"            rung_device_reset  && exit 0
  try_rung "de-authorise and re-authorise it"      rung_authorized    && exit 0
  try_rung "unload and reload rtl8xxxu"            rung_module        && exit 0
done

say ""
say "  $ROUNDS rounds of everything software can do, and it is still"
say "  $(nm_state "$(netdev_of || echo wlan1)")."
say ""
say "  That is past what a reset can fix. In order of how likely they are:"
say "    1. Move the dongle to one of the BLACK (USB 2.0) ports, or onto a"
say "       powered hub, and reboot. A Realtek that enumerates and then fails"
say "       a register write is the classic marginal-power symptom."
say "    2. Unplug it, wait ten seconds, plug it back in. A cold start does"
say "       things a soft reset cannot."
say "    3. Reboot the Pi."
say "    4. Suspect the dongle. It worked once and does not now."
exit 1
