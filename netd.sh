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

while true; do
  python3 "$HOME/helm/netd.py" "$@"
  sleep 5
done
