#!/bin/bash
# Publish the helm app to where AvNav serves it.
#
# There are two copies of confluence_helm.html on purpose:
#
#   ~/helm/                        the repo - edit here
#   ~/avnav/data/user/viewer/helm/ what AvNav serves, and what the kiosk loads
#
# viewer/helm and not helm: AvNav 20261102 serves only user/viewer and
# user/images, and answered 404 for user/helm - a black kiosk. user/viewer
# is served by older AvNav too. The first deploy after that change moves
# what lived in the old folder (map tiles, GPX, now-playing) across.
#
# They cannot be a symlink: the sshfs mount this is usually edited over
# does not support creating them. So this script keeps them in step, and
# is the only thing that should ever write the served copy.
#
# The served copy is stamped with the commit it came from, and the panel
# prints it at the foot of the control panel. Without that there is no way to
# tell which of the copies on this Pi you are looking at - and they do
# drift, because a `git pull` by hand moves the repo without deploying.
#
# Usage:  bash ~/helm/deploy.sh            publish
#         bash ~/helm/deploy.sh --check    exit 0 if the served copy is current
set -e

SRC="$HOME/helm/confluence_helm.html"
DST_DIR="$HOME/avnav/data/user/viewer/helm"
DST="$DST_DIR/confluence_helm.html"
OLD_DIR="$HOME/avnav/data/user/helm"

[ -f "$SRC" ] || { echo "no source at $SRC" >&2; exit 1; }
[ -d "$(dirname "$DST_DIR")" ] || { echo "no $(dirname "$DST_DIR") - is AvNav installed?" >&2; exit 1; }
if [ "${1:-}" != "--check" ]; then
  mkdir -p "$DST_DIR"
  # Once: whatever lived beside the page in the old folder comes with it.
  # Never over something already in the new one, and never the page
  # itself, which is written fresh below.
  if [ -d "$OLD_DIR" ]; then
    for x in "$OLD_DIR"/* "$OLD_DIR"/.[!.]*; do
      [ -e "$x" ] || continue
      n=$(basename "$x")
      [ "$n" = confluence_helm.html ] && continue
      [ -e "$DST_DIR/$n" ] || { mv "$x" "$DST_DIR/" && echo "moved $n -> $DST_DIR"; }
    done
  fi
fi

# The repo copy keeps the literal __BUILD__, so a page showing that is a
# page loaded straight from ~/helm over file:// - never a deployed one.
build_id(){
  local b
  b=$(git -C "$HOME/helm" rev-parse --short HEAD 2>/dev/null || echo unknown)
  git -C "$HOME/helm" diff --quiet 2>/dev/null || b="$b+"     # + means uncommitted
  printf '%s' "$b"
}
stamp(){ sed "s/__BUILD__/$(build_id)/" "$SRC"; }

if [ "${1:-}" = "--check" ]; then
  stamp | cmp -s - "$DST" && exit 0 || exit 1
fi

# Write beside the target and rename, never straight over it. `> "$DST"`
# truncates the served copy before sed writes a byte, so a failure part
# way through - a full SD card, a bad block - destroys the good copy and
# THEN reports a problem. And 71% of the app is one <script>, so a
# truncated copy is not a stale panel, it is a dead one: the boot splash
# holds every other layer at visibility:hidden and nothing clears it.
#
# $DST.new is in $DST_DIR, so this is a same-filesystem rename: atomic,
# and AvNav never sees a partial file.
trap 'rm -f "$DST.new"' EXIT
stamp > "$DST.new"

if stamp | cmp -s - "$DST.new"; then
  mv -f "$DST.new" "$DST"
  echo "deployed  $(build_id)  $(wc -c < "$DST") bytes  ->  $DST"
else
  echo "COPY VERIFY FAILED - served copy left untouched" >&2
  exit 1
fi

# A quick liveness check, since a deploy that AvNav cannot serve is not a
# deploy. Non-fatal: AvNav might legitimately be down while you work.
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
    http://localhost:8080/user/viewer/helm/confluence_helm.html || echo 000)
  echo "served check: HTTP $code"
  [ "$code" = "200" ] || echo "  (AvNav not answering - the kiosk will fall back to file://)" >&2
fi

echo "reload the kiosk to pick it up"
