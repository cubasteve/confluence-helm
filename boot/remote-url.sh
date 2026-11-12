#!/bin/bash
# Where to point the phone, once.
#
# The remote is always on and its token is kept in a file, so this is a
# one-time errand: run it over ssh, type the URL into the phone, and use
# Add to Home Screen. The URL does not change again - not at a reboot,
# not when the hotspot hands out a different lease, as long as you save
# the NAME and not the number.
#
#   bash boot/remote-url.sh
#
# Read-only. It asks netd what it is serving and looks up an address; it
# changes nothing.
set -u

API=${HELM_NETD:-http://127.0.0.1:8091}

say() { printf '%s\n' "$*"; }

J=$(python3 -I - "$API" <<'PY' 2>/dev/null
import json, sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1] + '/remote/status', timeout=5) as f:
        d = json.load(f)
except Exception:
    sys.exit(1)
if not d.get('ok'):
    sys.exit(1)
# One field per line, so bash can read it without a JSON parser of
# its own. NOT tab separated: tab is IFS whitespace, so bash collapses
# a run of them and drops a leading one, and an empty token - the one
# case this script exists to refuse - would shift every field left and
# have it print the port as the token.
for v in (d.get('token', ''), d.get('port', ''), d.get('dev', ''),
          d.get('how', ''), 'yes' if d.get('armed') else 'no'):
    print(v)
PY
) || {
  say "netd is not answering on $API."
  say ''
  say 'It is what serves the remote, so nothing is listening for the phone'
  say 'either. Check it with:'
  say '    systemctl --user status confluence-netd   # or however it is run'
  exit 1
}

{ IFS= read -r TOKEN; IFS= read -r PORT; IFS= read -r DEV
  IFS= read -r HOW;   IFS= read -r ARMED; } <<<"$J"

if [ -z "$TOKEN" ]; then
  say 'netd is up but has no token yet, which should not happen - it mints'
  say 'one at startup. Restart it and run this again.'
  exit 1
fi

HOST=$(hostname 2>/dev/null || echo openplotter)
IP=$(ip -4 -o addr show "$DEV" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)

say ''
say '  THE REMOTE'
say ''
say "  Save this one. It is a name, so it survives the hotspot giving the"
say "  Pi a different address - which it will, every time you reconnect."
say ''
say "      http://$HOST.local:$PORT/r?t=$TOKEN"
say ''
if [ -n "$IP" ]; then
  say "  If the phone cannot resolve that name - some Android hotspots will"
  say "  not - use the number instead, and run this again if it stops"
  say "  working:"
  say ''
  say "      http://$IP:$PORT/r?t=$TOKEN"
  say ''
else
  say "  $DEV has no address at the moment, so there is no number to fall"
  say "  back on and nothing can reach the panel yet. Join the hotspot"
  say "  first."
  say ''
fi
say "  Open it on the phone, then Add to Home Screen. It installs as an"
say "  app: no browser bars, and it remembers the token."
say ''
say "  door: $( [ "$ARMED" = yes ] && echo open || echo shut )   interface: $DEV   kept to: ${HOW:-nothing yet}"
say ''
if [ "$ARMED" != yes ]; then
  say '  The door is shut, which means the dongle had no address when netd'
  say '  last looked. It reopens by itself within thirty seconds of the'
  say '  dongle getting one.'
  say ''
fi
