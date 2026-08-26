#!/usr/bin/env python3
"""
One-time Spotify authorisation for the Confluence helm dial.

Run this once. It walks you through Spotify's consent screen, catches the
redirect on a tiny local server, swaps the code for a refresh token, and
writes ~/.config/confluence-spotify.json with 0600 permissions.

Everything stays on this machine. Your client secret and tokens are sent
only to accounts.spotify.com and written only to that local file.

Before running, create an app at https://developer.spotify.com/dashboard
and add this exact redirect URI to it:

    http://127.0.0.1:8888/callback

Spotify no longer accepts "localhost" for loopback redirects - it has to
be the literal 127.0.0.1, and the port has to match.

Scopes requested are user-read-currently-playing, user-library-read and
user-library-modify. The first two are read-only; the third is what lets
the panel's heart add and remove the current track. Nothing here can
control playback. It
cannot skip, pause, or change anything on your account.
"""
import base64
import json
import os
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CONFIG = os.path.expanduser("~/.config/confluence-spotify.json")
REDIRECT = "http://127.0.0.1:8888/callback"
# Read what is playing, plus the two the like button needs. Deliberately
# no playback-control scope: this token sits on a boat, and being able to
# modify the library is a smaller thing to hand over than being able to
# drive playback. Re-run this script after changing the list - an existing
# refresh token carries the scopes it was granted with, so a widened SCOPE
# does nothing until the consent screen is answered again.
SCOPE = "user-read-currently-playing user-library-read user-library-modify"
PORT = 8888

_result = {}


class Catcher(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        _result.update({k: v[0] for k, v in q.items()})
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        ok = "code" in _result
        self.wfile.write(
            ("<html><body style='font-family:system-ui;padding:3em;text-align:center'>"
             "<h2>%s</h2><p>%s</p></body></html>"
             % ("Confluence is authorised" if ok else "Authorisation failed",
                "You can close this tab and go back to the terminal."
                if ok else _result.get("error", "no code returned"))).encode()
        )

    def log_message(self, *a):
        pass          # keep the console clean


def main():
    print(__doc__)
    client_id = input("Client ID     : ").strip()
    client_secret = input("Client Secret : ").strip()
    if not client_id or not client_secret:
        print("both are required."); sys.exit(1)

    url = "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": REDIRECT,
        "scope": SCOPE,
    })

    print("\nOpen this in a browser on THIS machine and approve:\n\n  %s\n" % url)
    try:
        webbrowser.open(url)
    except Exception:
        pass

    print("waiting for the redirect on %s ..." % REDIRECT)
    srv = HTTPServer(("127.0.0.1", PORT), Catcher)
    srv.handle_request()
    srv.server_close()

    if "code" not in _result:
        print("\nno authorisation code received: %s" % _result.get("error", "unknown"))
        sys.exit(1)

    basic = base64.b64encode(("%s:%s" % (client_id, client_secret)).encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": _result["code"],
        "redirect_uri": REDIRECT,
    }).encode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token", data=body,
        headers={"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        tok = json.load(r)

    if "refresh_token" not in tok:
        print("\nno refresh token in the response: %s" % tok)
        sys.exit(1)

    cfg = {"client_id": client_id,
           "client_secret": client_secret,
           "refresh_token": tok["refresh_token"]}

    d = os.path.dirname(CONFIG)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".spot-")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=1)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)      # 0600 - it holds a secret
    os.replace(tmp, CONFIG)

    print("\nwrote %s (0600)" % CONFIG)
    print("now start the poller:  python3 /home/pi/helm/spotify-now.py")


if __name__ == "__main__":
    main()
