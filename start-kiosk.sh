#!/bin/bash
# Launch the Confluence helm display in kiosk mode.
#
# The page is now served by AvNav rather than loaded from file://, which
# means there is a boot race: the desktop session can come up before
# AvNav's HTTP server is listening. If Chromium wins that race it lands
# on a connection-error page and just sits there - it does not exit, so
# a plain restart loop would never notice. So we wait for the URL to
# actually answer before launching anything.
#
# Bounded at ~2 minutes. If AvNav never comes up we launch anyway, so a
# broken server gives you Chromium's error page rather than a black
# screen with no way in.

URL="http://localhost:8080/user/helm/confluence_helm.html"
FALLBACK="file:///home/pi/helm/confluence_helm.html"

n=0
until curl -sf -o /dev/null --max-time 3 "$URL"; do
  n=$((n + 1))
  if [ "$n" -ge 60 ]; then
    echo "helm: $URL never answered after ~2min; falling back to file://" >&2
    URL="$FALLBACK"
    break
  fi
  sleep 2
done

# Restart if Chromium dies - a crash on a boat should self-heal rather
# than leave a blank helm.
#
# Each launch gets a fresh ?v=, because without it Chromium will happily
# paint the copy it already has - you deploy, the kiosk restarts, and the
# old panel appears for a moment before the network catches up. The query
# string does not change the origin, so the chart tiles and the track
# library in browser storage survive it.
while true; do
  chromium-browser --kiosk --noerrdialogs --disable-infobars \
    --disable-session-crashed-bubble --check-for-update-interval=31536000 \
    "$URL?v=$(date +%s)"
  sleep 3
done
