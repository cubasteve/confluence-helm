#!/bin/bash
# Publish the helm app to where AvNav serves it.
#
# There are two copies of confluence_helm.html on purpose:
#
#   ~/helm/                        the repo - edit here
#   ~/avnav/data/user/helm/        what AvNav serves, and what the kiosk loads
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
DST_DIR="$HOME/avnav/data/user/helm"
DST="$DST_DIR/confluence_helm.html"

[ -f "$SRC" ] || { echo "no source at $SRC" >&2; exit 1; }
[ -d "$DST_DIR" ] || { echo "no served dir at $DST_DIR - is AvNav installed?" >&2; exit 1; }

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

# ---- the app drawer's apps ------------------------------------------
# The drawer launches things AvNav serves out of this same directory, and
# they live in their own repos - sail-weather.html belongs to keel-app.
# This COPIES; it never edits, and keel-app stays the one place that file
# is written. If the clone is not on this Pi nothing happens here and the
# tile says so when you tap it, which is a better failure than a blank
# frame.
APPS_SRC="${KEEL_APP:-$HOME/keel-app}"
for app in sail-weather.html; do
  if [ -f "$APPS_SRC/$app" ]; then
    # Beside the target and renamed, for the same reason the main copy is.
    cp "$APPS_SRC/$app" "$DST_DIR/$app.new"
    mv -f "$DST_DIR/$app.new" "$DST_DIR/$app"
    echo "published $app  $(wc -c < "$DST_DIR/$app") bytes  <-  $APPS_SRC"
  else
    echo "no $APPS_SRC/$app - the drawer's tile will say it is not here"
  fi
done

# A quick liveness check, since a deploy that AvNav cannot serve is not a
# deploy. Non-fatal: AvNav might legitimately be down while you work.
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
    http://localhost:8080/user/helm/confluence_helm.html || echo 000)
  echo "served check: HTTP $code"
  [ "$code" = "200" ] || echo "  (AvNav not answering - the kiosk will fall back to file://)" >&2
fi

echo "reload the kiosk to pick it up"
