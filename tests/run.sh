#!/bin/bash
# Every probe in here, against a copy of the app served locally.
#
# These lived in a scratch directory and were lost the first time the
# machine they were on went away - which is the whole argument for them
# sitting in the repo beside the thing they test.
#
# The browser probes are .mjs and drive the page; the netd ones are
# _test.py and drive the helper, which has no browser in it at all.
#
#   bash tests/run.sh            the lot
#   bash tests/run.sh markmove   one of them
set -u
cd "$(dirname "$0")/.."
PORT="${HELM_PORT:-8080}"
export HELM_URL="${HELM_URL:-http://localhost:$PORT/confluence_helm.html}"
export HELM_SHOTS="${HELM_SHOTS:-$(mktemp -d)/}"

# Serve the repo ourselves unless something already answers, so a probe
# never quietly tests a stale deployed copy instead of the working tree.
OWN=0
if ! curl -sf -o /dev/null --max-time 2 "$HELM_URL"; then
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  OWN=$!
  sleep 1
fi
trap '[ "$OWN" != 0 ] && kill "$OWN" 2>/dev/null' EXIT

rc=0
for f in tests/${1:-*}.mjs; do
  [ -e "$f" ] || { echo "no such probe: ${1:-}" >&2; exit 2; }
  n=$(basename "$f" .mjs)
  [ "$n" = helpers ] && continue   # shared code, not a probe
  printf '%-12s ' "$n"
  if out=$(node "$f" 2>&1); then
    echo "OK   $(printf '%s' "$out" | tail -1)"
  else
    echo "FAIL"
    printf '%s\n' "$out" | sed 's/^/    /'
    rc=1
  fi
done
# The helper's own tests. No browser, no server - they import netd with
# a PATH full of pretend tools and a stand-in for the club's scoreboard.
for f in tests/${1:-*}_test.py; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .py)
  printf '%-12s ' "$n"
  if out=$(python3 "$f" 2>&1); then
    echo "OK   $(printf '%s' "$out" | grep -E '^Ran ' | tail -1)"
  else
    echo "FAIL"
    printf '%s\n' "$out" | sed 's/^/    /'
    rc=1
  fi
done

echo "shots in $HELM_SHOTS"
exit $rc
