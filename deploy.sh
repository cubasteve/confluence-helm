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
# Usage:  bash ~/helm/deploy.sh
set -e

SRC="$HOME/helm/confluence_helm.html"
DST_DIR="$HOME/avnav/data/user/helm"
DST="$DST_DIR/confluence_helm.html"

[ -f "$SRC" ] || { echo "no source at $SRC" >&2; exit 1; }
[ -d "$DST_DIR" ] || { echo "no served dir at $DST_DIR - is AvNav installed?" >&2; exit 1; }

cp "$SRC" "$DST"

if cmp -s "$SRC" "$DST"; then
  echo "deployed  $(wc -c < "$DST") bytes  ->  $DST"
else
  echo "COPY VERIFY FAILED - served copy does not match source" >&2
  exit 1
fi

# A quick liveness check, since a deploy that AvNav cannot serve is not a
# deploy. Non-fatal: AvNav might legitimately be down while you work.
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
    http://localhost:8080/user/helm/confluence_helm.html || echo 000)
  echo "served check: HTTP $code"
  [ "$code" = "200" ] || echo "  (AvNav not answering - the kiosk will fall back to file://)" >&2
fi

echo "reload the kiosk to pick it up"
