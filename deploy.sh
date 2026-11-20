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
# The page left at an old address: it forwards people to the new one,
# and hands the panel what the browser saved there (see the file).
FWD_SRC="$HOME/helm/boot/old-address.html"
fwd_page(){ sed "s/__PORT__/$WWW_PORT/g" "$FWD_SRC"; }
www_up(){ curl -sf -o /dev/null -m 3 "http://localhost:$WWW_PORT/confluence_helm.html"; }
# Each old folder that is still serving something other than the forward.
stale_old(){
  local o
  for o in "${OLD_DIRS[@]}"; do
    [ -f "$o/confluence_helm.html" ] || continue
    fwd_page | cmp -s - "$o/confluence_helm.html" || echo "$o"
  done
}

if [ "${1:-}" != "--check" ]; then
  mkdir -p "$DST_DIR"
  # Once per old folder: whatever lived beside the page comes with it.
  # Never over a file already here, never the page itself (written fresh
  # below), never now-playing (rewritten every few seconds by its poller,
  # so a copy would only be a stale one). Nothing in an old folder may
  # stop the page being published: every step here is allowed to fail,
  # and the folder is only marked done when every step did not.
  for OLD in "${OLD_DIRS[@]}"; do
    [ -d "$OLD" ] || continue
    [ -e "$OLD/.moved-to-helm-www" ] && continue
    if [ ! -w "$OLD" ]; then echo "cannot write $OLD - not moving anything out of it" >&2; continue; fi
    ok=1
    for x in "$OLD"/* "$OLD"/.[!.]*; do
      [ -e "$x" ] || continue
      n=$(basename "$x")
      case "$n" in confluence_helm.html|helm-export.html|nowplaying.json|.moved-to-helm-www|*.new) continue;; esac
      if [ ! -e "$DST_DIR/$n" ]; then
        if mv "$x" "$DST_DIR/"; then echo "moved $n -> $DST_DIR"; else ok=0; fi
      elif [ -d "$x" ] && [ -d "$DST_DIR/$n" ]; then
        # Both had one - two AvNav layouts, two deploys. Merge, never
        # over a file already here. (netd rebuilds gpx/index.json from
        # what is actually there when it starts.)
        if cp -an "$x/." "$DST_DIR/$n/"; then echo "merged $n -> $DST_DIR/$n"; else ok=0; fi
      fi
    done
    if [ "$ok" = 1 ]; then
      : > "$OLD/.moved-to-helm-www" 2>/dev/null || echo "cannot mark $OLD as moved" >&2
    else
      echo "some of $OLD did not move - the next deploy tries again" >&2
    fi
  done
  # The hand-over file at the old address (AvNav's viewer folder, on
  # :8080): the panel on :$WWW_PORT loads it hidden, once, to bring across
  # the races and settings the browser saved while the panel lived there.
  # Its own name, written now, because it replaces nothing - unlike the
  # forward below, which waits for :$WWW_PORT.
  EXP="$HOME/avnav/data/user/viewer/helm"
  if [ -d "$(dirname "$EXP")" ] && [ -f "$FWD_SRC" ] && mkdir -p "$EXP" 2>/dev/null; then
    if ! fwd_page | cmp -s - "$EXP/helm-export.html"; then
      if fwd_page > "$EXP/helm-export.html.new" 2>/dev/null &&
         mv -f "$EXP/helm-export.html.new" "$EXP/helm-export.html"; then
        echo "hand-over page in place: $EXP/helm-export.html"
      else
        rm -f "$EXP/helm-export.html.new"
      fi
    fi
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
  stamp | cmp -s - "$DST" || exit 1
  # Current - unless an old address still serves the old panel while the
  # new server is up to forward to, in which case there is a deploy owed.
  # Only then: with :$WWW_PORT down this would ask for a deploy that can
  # not finish, and autopull would restart the kiosk every interval.
  if [ -n "$(stale_old)" ] && www_up; then exit 1; fi
  exit 0
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

# The old addresses forward to the new one - but only once the new one
# answers. Before that, a forward is a bookmark pointed at a dead port
# and the page AvNav was serving thrown away; the old copy stays, and
# --check owes a deploy until this has happened.
if [ -n "$(stale_old)" ]; then
  if www_up; then
    while IFS= read -r o; do
      if fwd_page > "$o/confluence_helm.html.new" 2>/dev/null &&
         mv -f "$o/confluence_helm.html.new" "$o/confluence_helm.html"; then
        echo "old address forwards: $o"
      else
        rm -f "$o/confluence_helm.html.new"
        echo "could not write the forward in $o" >&2
      fi
    done < <(stale_old)
  else
    echo "  old addresses left as they are until :$WWW_PORT answers" >&2
  fi
fi

echo "reload the kiosk to pick it up"
