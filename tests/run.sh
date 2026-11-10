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

# The panel runs Poppins - boot/install-boot-chain.sh puts these three
# weights on the Pi - and a probe that measures a layout in whatever face
# the machine happens to have is measuring the wrong thing. This went
# unnoticed for a long time because the failures are quiet: a box 11 px
# short, two ovals 10 px apart, numbers that are wrong only on the boat.
#
# So point fontconfig at the repo's own copies for the length of the run.
# Not install them: a probe should not leave fonts on the machine that
# ran it, and a workstation's own font list is not ours to edit. The
# system faces are still found - this adds a directory, it does not
# replace the search path.
FONTS=$(mktemp -d)
mkdir -p "$FONTS/fonts"
cp boot/fonts/Poppins-*.ttf "$FONTS/fonts/" 2>/dev/null
export XDG_DATA_HOME="$FONTS" XDG_CACHE_HOME="$FONTS/cache"

# Serve the repo ourselves unless something already answers, so a probe
# never quietly tests a stale deployed copy instead of the working tree.
OWN=0
if ! curl -sf -o /dev/null --max-time 2 "$HELM_URL"; then
  python3 -m http.server "$PORT" >/dev/null 2>&1 &
  OWN=$!
  sleep 1
fi
trap '[ "$OWN" != 0 ] && kill "$OWN" 2>/dev/null; rm -rf "$FONTS"' EXIT

# `ran` and not an early exit on the first glob. Naming a probe that has
# no .mjs used to bail here before the python loop below was ever
# reached - so `run.sh sound`, which tests/README documents as "the netd
# one of that name", answered "no such probe: sound" about a probe
# sitting right there. A typo still gets told, at the end, once both
# globs have had their turn.
rc=0 ran=0
for f in tests/${1:-*}.mjs; do
  [ -e "$f" ] || break
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
  ran=$((ran+1))
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
  ran=$((ran+1))
done

[ "$ran" = 0 ] && { echo "no such probe: ${1:-}" >&2; exit 2; }

echo "shots in $HELM_SHOTS"
exit $rc
