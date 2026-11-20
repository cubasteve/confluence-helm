#!/bin/bash
# Flash the Open Echo board with the RAW-PING firmware netd reads.
#
#   bash ~/helm/boat/sonar/flash-open-echo.sh 200      # transducer kHz: 40, 150 or 200
#
# Why: the board can run one of two sketches. NMEA_DBT_OUT sends plain
# depth sentences at 9600 - depth only, nothing to draw. TUSS4470_arduino
# sends every ping (0xAA, depth index, temperature, drive voltage, 1800
# samples, XOR checksum) at 250000, which is what the Sonar app draws and
# what netd turns into depth for Signal K. netd's parser is written
# against exactly that frame, so this flashes exactly that sketch, at the
# commit it was checked against.
#
# What it does, in order, and nothing else:
#   1. pauses netd, which holds the sounder's port open
#   2. installs arduino-cli into ~/.local/bin from Arduino's own release
#      tarball, if it is not already there, and the AVR core
#   3. fetches github.com/Neumi/open_echo into ~/open_echo at OE_COMMIT
#   4. copies the sketch to ~/open_echo-build and sets the drive and
#      band-pass frequency for the transducer you named
#   5. builds for an Uno-compatible ATmega328P and uploads over the
#      sounder's own fixed USB name (never ttyUSB0, which may be the GPS)
#   6. restarts netd and reports whether pings are arriving
#
# Undo: flash NMEA_DBT_OUT the same way from the Arduino IDE, or ask.
set -euo pipefail

FREQ="${1:-}"
DEV="${OE_DEV:-/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0}"
FQBN="${OE_FQBN:-arduino:avr:uno}"
OE_COMMIT="${OE_COMMIT:-0c4e6e7}"
CLI_VER="1.1.1"
SRC="$HOME/open_echo"
BUILD="$HOME/open_echo-build"
BIN="$HOME/.local/bin"

say(){ printf '\n== %s\n' "$*"; }
die(){ printf '\nSTOPPED: %s\n' "$*" >&2; restart_netd; exit 1; }
restart_netd(){
  if ! pgrep -f 'helm/netd.sh' >/dev/null 2>&1; then
    setsid nohup bash "$HOME/helm/netd.sh" >/dev/null 2>&1 < /dev/null &
    echo "netd restarted"
  fi
}

# Drive frequency, and the TUSS4470 band-pass register nearest to it
# (datasheet table 7.1, as listed in the sketch's settings.h).
case "$FREQ" in
  40)  DRIVE=40000;  FILT=0x00 ;;
  150) DRIVE=150000; FILT=0x18 ;;
  200) DRIVE=200000; FILT=0x1E ;;
  *) echo "usage: $0 40|150|200   (your transducer's frequency in kHz)" >&2; exit 2 ;;
esac

[ -e "$DEV" ] || { echo "The sounder is not plugged in: $DEV is missing." >&2; exit 1; }

say "1/6  pausing netd (it holds the sounder's port)"
pkill -f 'helm/netd.sh' 2>/dev/null || true
pkill -f 'helm/netd.py' 2>/dev/null || true
sleep 2

say "2/6  arduino-cli"
export PATH="$BIN:$PATH"
if ! command -v arduino-cli >/dev/null 2>&1; then
  case "$(dpkg --print-architecture)" in
    arm64) ARCH=ARM64 ;; armhf) ARCH=ARMv7 ;; amd64) ARCH=64bit ;;
    *) die "unknown architecture $(dpkg --print-architecture)" ;;
  esac
  mkdir -p "$BIN"
  T=$(mktemp -d)
  curl -fL --retry 3 -o "$T/cli.tgz" \
    "https://downloads.arduino.cc/arduino-cli/arduino-cli_${CLI_VER}_Linux_${ARCH}.tar.gz" \
    || die "could not download arduino-cli - is the Pi online?"
  tar -xzf "$T/cli.tgz" -C "$T" arduino-cli && install -m 755 "$T/arduino-cli" "$BIN/" \
    || die "could not unpack arduino-cli"
  rm -rf "$T"
fi
arduino-cli version
arduino-cli core update-index >/dev/null || die "could not reach Arduino's board index - is the Pi online?"
arduino-cli core list | grep -q '^arduino:avr ' || arduino-cli core install arduino:avr \
  || die "could not install the AVR core"

say "3/6  Open Echo sources at $OE_COMMIT"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin || die "could not fetch open_echo"
else
  git clone -q https://github.com/Neumi/open_echo "$SRC" || die "could not clone open_echo"
fi
git -C "$SRC" checkout -q "$OE_COMMIT" || die "commit $OE_COMMIT not found"

say "4/6  sketch for a ${FREQ} kHz transducer"
rm -rf "$BUILD"; mkdir -p "$BUILD"
cp -r "$SRC/TUSS4470_shield_002/arduino/TUSS4470_arduino" "$BUILD/"
H="$BUILD/TUSS4470_arduino/settings.h"
sed -i -E "s/^#define DRIVE_FREQUENCY [0-9]+/#define DRIVE_FREQUENCY $DRIVE/" "$H"
sed -i -E "s/^#define FILTER_FREQUENCY_REGISTER 0x[0-9A-Fa-f]+/#define FILTER_FREQUENCY_REGISTER $FILT/" "$H"
grep -E '^#define (DRIVE_FREQUENCY|FILTER_FREQUENCY_REGISTER|NUM_SAMPLES) ' "$H"
grep -q "^#define DRIVE_FREQUENCY $DRIVE\$" "$H" && grep -q "^#define FILTER_FREQUENCY_REGISTER $FILT" "$H" \
  && grep -q '^#define NUM_SAMPLES 1800' "$H" || die "settings.h did not take the changes"

say "5/6  build and upload to $DEV"
arduino-cli compile --fqbn "$FQBN" "$BUILD/TUSS4470_arduino" || die "the sketch did not build"
arduino-cli upload -p "$DEV" --fqbn "$FQBN" "$BUILD/TUSS4470_arduino" \
  || die "upload failed - see the note on bootloaders in the walkthrough"

say "6/6  restarting netd, then listening for pings"
restart_netd
sleep 12
curl -s -X POST -H 'Content-Type: application/json' -d '{"after":0}' \
  http://127.0.0.1:8091/sonar | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('netd sees:', {k:d.get(k) for k in ('on','good','bad','error','sent')})
print('PINGS ARRIVING - open the Sonar app' if d.get('good') else
      'no pings yet: check ~/.config/confluence-helm.env says serial:...:250000, then reboot')"
