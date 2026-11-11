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
ATTEMPTS="${DONGLE_ATTEMPTS:-20}"  # fresh probes to roll at a firmware race
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
# There is no driver CHOICE to make here, which is worth saying because
# every answer on the internet about this chip assumes there is. Mainline
# deleted drivers/staging/r8188eu and added RTL8188EU to rtl8xxxu in the
# SAME release - 6.3 - so the two never ship together. A kernel whose
# rtl8xxxu claims 0bda:8179 is by definition one with no r8188eu on it,
# and Debian packages none. Checked anyway, because being told "not an
# option" beats spending an evening looking for it.
hr "is there another driver to fall back to"
say "  kernel       : $(uname -r)"
if modinfo r8188eu >/dev/null 2>&1; then
  say "  r8188eu      : PRESENT - $(modinfo -n r8188eu 2>/dev/null)"
else
  say "  r8188eu      : absent, and necessarily so - staging r8188eu was"
  say "                 deleted in 6.3, the same release that taught"
  say "                 rtl8xxxu this chip. No fallback exists and none is"
  say "                 packaged. rtl8xxxu is the right driver, not the"
  say "                 consolation prize."
fi
say "  rtl8xxxu     : $(modinfo -n rtl8xxxu 2>/dev/null || echo 'not found?')"
say "  firmware     : $(ls /lib/firmware/rtlwifi/rtl8188eufw.bin 2>/dev/null || echo MISSING)"

hr "what the kernel said about it"
dmesg 2>/dev/null | grep -iE 'rtl8|8188|usb 1-|insufficient' | tail -14 \
  | sed 's/^/  /' || say "  (dmesg needs sudo)"

# The one line that decides which of two completely different problems
# this is, and the reason the rest of this script branches.
#
# The firmware push happens inside rtl8xxxu_init_device() at probe time,
# and ieee80211_register_hw() runs only after it. So if the firmware
# write fails there is NO wlan interface at all - "Failed to write block"
# and "I can see wlan1" are mutually exclusive, and if you have both, the
# writeN line is stale from an earlier boot and is not tonight's problem.
#
# What that write failure actually is: a USB control transfer returning
# -71/EPROTO partway through pushing the firmware image into the chip.
# The address is meaningless - 0x1e80 is just chunk 29 of 32 of a 4 KB
# page starting at REG_FW_START_ADDRESS 0x1000. The SIZE is the
# interesting field: `size: 0080` is 128 bytes, the block size upstream
# raised to 196 (0x00c4) in 6.14 precisely because 128 loses this race.
# A kernel printing 0080 has neither that fix nor the six-attempt retry
# loop added in 6.15, so one unlucky EPROTO kills the probe outright.
# dmesg is a RING BUFFER, not a status register. It holds every attempt
# this boot, successful and not, and the first version of this read it
# with a bare grep -q: one stale `-11` from an hour ago outvoted an
# adapter that was connected right now. Caught on the boat - the script
# announced a failed firmware upload about a wlan1 sitting in `connected`.
#
# Two rules, and the first is the one that cannot be argued with.
#
#   An interface existing PROVES this incarnation's firmware push
#   succeeded. The push happens inside rtl8xxxu_init_device() at probe
#   time and ieee80211_register_hw() runs only after it returns, so a
#   failed upload leaves no netdev at all. "Failed to write block" and
#   "I can see wlan1" are mutually exclusive in the same incarnation,
#   and if you have both, the write failure is from an earlier one.
#
#   Otherwise, go by which came LAST. grep -n numbers the buffer in
#   time order, so comparing the line of the last failure against the
#   line of the last "Firmware revision" says which way the most recent
#   attempt went.
#
# Getting this wrong is not cosmetic: fwrace sends the ladder below into
# twenty USB resets, and doing that to a working adapter is exactly the
# harm the rfkill guard exists to prevent.
VERDICT=unknown; STALE=0
LAST_FAIL=$(dmesg 2>/dev/null | grep -n 'probe of .* failed with error -11' \
            | tail -1 | cut -d: -f1)
LAST_OK=$(dmesg 2>/dev/null | grep -n 'Firmware revision' | tail -1 | cut -d: -f1)
if netdev_of >/dev/null; then
  VERDICT=fwok
  [ -n "${LAST_FAIL:-}" ] && STALE=1
elif [ "${LAST_FAIL:-0}" -gt "${LAST_OK:-0}" ] 2>/dev/null; then
  VERDICT=fwrace
elif [ -n "${LAST_OK:-}" ]; then
  VERDICT=fwok
fi
say ""
case $VERDICT in
  fwrace) say "  VERDICT: the firmware upload lost a race and probe FAILED (-11),"
          say "           with no interface to show for it. Each probe is an"
          say "           independent dice roll, so the answer is to roll it many"
          say "           times. That is what this script does."
          # Read off the CURRENT failure, not any failure: this only
          # prints on the branch where the last thing that happened was
          # that failure.
          BS=$(dmesg 2>/dev/null | grep -o 'size: [0-9a-f]*' | tail -1 | awk '{print $2}')
          [ -n "${BS:-}" ] && say "           block size $BS$([ "$BS" = 0080 ] && echo ' - 128, the unfixed path: no retry' || echo '')" ;;
  fwok)   say "  VERDICT: the chip has its firmware and registered an interface."
          say "           Anything wrong is ABOVE the driver - rfkill,"
          say "           NetworkManager, or association."
          [ "$STALE" = 1 ] && {
            say "           (there IS a failed probe further back in the buffer."
            say "            It is from an earlier attempt - a failed upload"
            say "            leaves no interface at all, and there is one.)"; } ;;
  *)      say "  VERDICT: no firmware evidence either way in the ring buffer." ;;
esac

hr "power"
# 0x0 means the Pi's own 5V INPUT never sagged past threshold since
# boot. It says nothing about a droop across the USB connector, a thin
# extension lead or a corroded contact - which is where this class of
# fault actually lives. There is no per-port USB current telemetry on a
# Pi 4, and its downstream budget is about 1.1 A SHARED across all four
# sockets. bMaxPower below is a declared descriptor figure, not a
# measurement.
say "  throttled    : $(vcgencmd get_throttled 2>/dev/null || echo '(no vcgencmd)')  (0x0 = the Pi's own 5V input was fine; says nothing about the socket)"
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

# Which ladder, and the answer is not "both". The two failures live on
# opposite sides of probe():
#
#   no interface, or probe failed with -11
#     The firmware push lost its race and the driver never registered a
#     netdev. Nothing above the driver can help, and nothing below it is
#     broken. Each fresh probe is an independent dice roll against a
#     transient EPROTO, so the fix is to roll it a lot - which is
#     literally what upstream did in 6.15, a six-attempt retry loop
#     around this exact download. This supplies that from userspace, on
#     a kernel that has not got it.
#
#   an interface exists and NetworkManager will not use it
#     The chip loaded fine. Resetting it is cargo cult - it will come
#     back in exactly the same state. The problem is above the driver.
if [ "$VERDICT" = fwrace ] || ! netdev_of >/dev/null; then
  say "  The probe is what is failing, so the only thing that helps is more"
  say "  probes. $ATTEMPTS of them, about $((ATTEMPTS * 9)) seconds."
  i=0
  while [ "$i" -lt "$ATTEMPTS" ]; do
    i=$((i+1))
    # Mostly the device-level reset, because that re-runs enumeration
    # AND the firmware load, which is the part that has to win. Every
    # sixth go, cycle the module instead - a different code path into
    # the same probe, and free to try.
    # Announced BEFORE the attempt, not after. Each roll is about nine
    # seconds of silence otherwise, and a script that prints nothing for
    # three minutes is one you kill halfway through.
    say "  try $i of $ATTEMPTS ..."
    if [ $((i % 6)) = 0 ]; then rung_module; else rung_device_reset; fi
    sleep "$SETTLE"
    if working; then
      say "       UP. $(netdev_of) is $(nm_state "$(netdev_of)")."
      say ""
      say "  It took $i $([ "$i" = 1 ] && echo try || echo tries), which is the whole story: the firmware"
      say "  upload is a coin flip on this kernel and nothing is wrong with"
      say "  the adapter. Expect this again after a reboot."
      exit 0
    fi
    say "       $(netdev_of || echo 'still no interface')"
  done
else
  say "  There IS an interface and the chip loaded its firmware, so this is"
  say "  not the reset-it-until-it-works case. Trying the things above the"
  say "  driver instead."
  for round in $(seq 1 "$ROUNDS"); do
    try_rung "hand it back to NetworkManager"     rung_nm           && exit 0
    try_rung "rebind the interface to its driver" rung_driver_cycle && exit 0
    try_rung "reset the whole USB device"         rung_device_reset && exit 0
  done
  # Documented for this adapter family and fixable with no internet:
  # NetworkManager randomises the MAC while scanning and the 8188EU does
  # not support it, so the device never gets anywhere. Not applied
  # automatically - a reset is transient and an edit under /etc is not,
  # and that difference is the owner's to make, not this script's.
  say ""
  # NOT the MAC-randomisation fix that used to be printed here.
  # Raspberry Pi OS turns scan-time randomisation off in its own rebuild
  # of network-manager, globally, in a conffile - so it was already off
  # while this adapter was failing and cannot be the cause. See
  # boot/check-wifi-mac.sh, which proves it rather than assuming it.
  say "  Scan-time MAC randomisation is the usual suspect here and it is"
  say "  NOT this: Raspberry Pi OS disables it in its own build, so it was"
  say "  already off while this was failing. Confirm with"
  say "  check-wifi-mac.sh rather than taking my word for it."
  say ""
  say "  What is left to look at: whether something ran"
  say "  'nmcli device disconnect' on it, which also blocks autoconnect"
  say "  until something clears it; the connection profile's own"
  say "  cloned-mac-address; and the journal around the moment it stopped."
  say ""
  say "    nmcli -f GENERAL.STATE,GENERAL.REASON device show $(netdev_of)"
  say "    journalctl -u NetworkManager -b | tail -40"
  say ""
fi

say ""
say "  That is past what a reset can fix from here. In order:"
say "    1. Move it to a different USB port and take other USB devices off"
say "       the bus. NOT for power - the failure is a timing race on a"
say "       control transfer, and the detailed reports of it have the"
say "       dongle sharing a bus with something busy. Worth trying because"
say "       it is free, not because it is known to work: all four of the"
say "       Pi 4's ports are on the one VL805 controller, so changing"
say "       ports changes less than it sounds like it does."
say "    2. Unplug it, wait ten seconds, plug it back in. A cold start"
say "       does things a soft reset cannot."
say "    3. Reboot."
say "    4. Move to a 6.12 kernel, which carries upstream's own"
say "       six-attempt retry around this exact failure. Note that"
say "       upgrading WITHIN 6.6 buys nothing: rpi-6.6.y stops at"
say "       6.6.78 and the retry landed upstream at 6.6.93. 6.18 also"
say "       has the block-size fix, which removes the race rather than"
say "       surviving it."
say "       Not on passage: a kernel upgrade interrupted half way, on a"
say "       box whose only way in is a hotspot it serves itself, can"
say "       lose you both radios. At anchor, with a card image, and"
say "       with a screen and keyboard you can actually reach."
exit 1
