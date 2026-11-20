#!/bin/bash
# Publish the helm app to where netd's page server serves it.
#
# There are two copies of confluence_helm.html on purpose:
#
#   ~/helm/                        the repo - edit here
#   ~/helm-www/                    what netd serves on :8090, and what the kiosk loads
#
# Its own folder and its own server, not AvNav's. It used to live in
# AvNav's data and be served by AvNav, until an AvNav update (20261102)
# stopped serving that folder and the kiosk came up black. The first
# deploy after the move brings what lived beside the page in either old
# AvNav folder (map tiles, GPX, now-playing) across, and leaves a page at
# the old addresses that forwards to the new one, so bookmarks still work.
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
DST_DIR="${HELM_WWW_DIR:-$HOME/helm-www}"
DST="$DST_DIR/confluence_helm.html"
WWW_PORT="${HELM_WWW_PORT:-8090}"
# Where AvNav used to serve it, newest first. Read from, never written to,
# except for the forwarding page below.
OLD_DIRS=("$HOME/avnav/data/user/viewer/helm" "$HOME/avnav/data/user/helm")

[ -f "$SRC" ] || { echo "no source at $SRC" >&2; exit 1; }
if [ "${1:-}" != "--check" ]; then
  mkdir -p "$DST_DIR"
  # Once: whatever lived beside the page in an old folder comes with it.
  # Never over something already here, and never the page itself, which
  # is written fresh below.
  for OLD in "${OLD_DIRS[@]}"; do
    [ -d "$OLD" ] || continue
    if [ ! -e "$OLD/.moved-to-helm-www" ]; then
      for x in "$OLD"/* "$OLD"/.[!.]*; do
        [ -e "$x" ] || continue
        n=$(basename "$x")
        case "$n" in confluence_helm.html|.moved-to-helm-www) continue;; esac
        if [ ! -e "$DST_DIR/$n" ]; then
          mv "$x" "$DST_DIR/" && echo "moved $n -> $DST_DIR"
        elif [ -d "$x" ] && [ -d "$DST_DIR/$n" ]; then
          # Both folders had one - two AvNav layouts, two deploys. Merge,
          # and never over a file that is already here.
          cp -an "$x/." "$DST_DIR/$n/" && echo "merged $n -> $DST_DIR/$n"
        fi
      done
      # Once per old folder: a tile cache is thousands of files, and
      # nobody wants them walked on every deploy for ever.
      : > "$OLD/.moved-to-helm-www"
    fi
    # The old address forwards to the new one, keeping whatever host the
    # phone used to reach it - a bookmark, a home-screen icon.
    printf '%s\n' '<!doctype html><meta charset="utf-8"><title>Confluence Helm</title>' \
      "<script>location.replace(location.protocol+'//'+location.hostname+':$WWW_PORT/confluence_helm.html')</script>" \
      "<p>The panel moved: port $WWW_PORT.</p>" > "$OLD/confluence_helm.html.new" \
      && mv -f "$OLD/confluence_helm.html.new" "$OLD/confluence_helm.html"
  done
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
    "http://localhost:$WWW_PORT/confluence_helm.html" || echo 000)
  echo "served check: HTTP $code"
  [ "$code" = "200" ] || echo "  (netd's page server not answering - is netd running? the kiosk falls back to file://)" >&2
fi

echo "reload the kiosk to pick it up"
