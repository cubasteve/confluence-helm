#!/bin/bash
# Open the helm app in its own window, sharing the kiosk's browser profile
# so saved races and cached chart tiles are the same ones.
#
# This exists rather than putting chromium straight into the .desktop
# Exec= line because Exec is not parsed by a shell: there is no way to
# spell $(date +%s) in it, and without a fresh ?v= Chromium will happily
# render the copy it already has. That is precisely why this window used
# to sit a version behind the kiosk - same URL, same origin, older bytes.
#
#   bash ~/helm/open-window.sh
#
# --app                    no tabs and no address bar; it is an
#                          instrument, not a browser.
# --window-size=1080,1080  a square viewport, which is what keeps the dial
#                          round - fitStage() squares it off otherwise.
#
# Deliberately not --kiosk and not --start-maximized: those are the two
# flags netd.py matches on, and this window is meant to be left alone
# when the panel switches the kiosk between modes.

URL="http://localhost:8080/user/helm/confluence_helm.html"

exec chromium-browser --app="$URL?v=$(date +%s)" --window-size=1080,1080 "$@"
