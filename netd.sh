#!/bin/bash
# Keep netd.py running.
#
# Same reasoning as start-kiosk.sh's restart loop: something that dies on a
# boat should come back on its own rather than wait for someone to notice.
# It is also the seam autopull uses - it kills the python process and this
# loop brings the new version back, so a pushed change to netd.py reaches
# the Pi without a session restart.
#
# Started from ~/.config/autostart/confluence-netd.desktop.

# In cage mode this loop is started by cage-session.sh, and the desktop's
# autostart entry starts another one the moment you tap Desktop. Two
# pythons cannot both hold 127.0.0.1:8091, and the loser would respawn
# every five seconds for ever. So don't launch while someone is already
# answering - and keep looping, so this copy takes over the moment the
# other one stops.
while true; do
  if ! curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8091/status; then
    python3 "$HOME/helm/netd.py" "$@"
  fi
  sleep 5
done
