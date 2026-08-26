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
import errno
import subprocess
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
# Overridable, but only usefully so if you also change the redirect URI
# registered in the Spotify dashboard - Spotify matches it exactly.
PORT_ENV = int(os.environ.get("CONFLUENCE_AUTH_PORT") or 0)
REDIRECT = "http://127.0.0.1:%d/callback"
# Read what is playing, plus the two the like button needs. Deliberately
# no playback-control scope: this token sits on a boat, and being able to
# modify the library is a smaller thing to hand over than being able to
# drive playback. Re-run this script after changing the list - an existing
# refresh token carries the scopes it was granted with, so a widened SCOPE
# does nothing until the consent screen is answered again.
SCOPE = "user-read-currently-playing user-library-read user-library-modify"
PORT = PORT_ENV or 8888
REDIRECT = REDIRECT % PORT

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


def port_holder(port):
    """Best effort at naming whatever already has the port, because
    "Address already in use" on its own sends you nowhere."""
    for cmd in (["ss", "-lptn", "sport = :%d" % port],
                ["lsof", "-nP", "-i", ":%d" % port]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=4).stdout.strip()
            if len(out.splitlines()) > 1:
                return out
        except Exception:
            pass
    return ""


def try_bind():
    """Claim the callback port, or explain why we could not.

    Deliberately the FIRST thing main() does. It used to happen after the
    credentials had been typed in and the consent screen approved, so a
    busy port threw away all of that and left a traceback."""
    try:
        return HTTPServer(("127.0.0.1", PORT), Catcher)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
    print("\n  Port %d is already in use, so the callback cannot be caught\n"
          "  here. Almost always that is an earlier run of this same script\n"
          "  still waiting for a redirect that never arrived.\n" % PORT)
    who = port_holder(PORT)
    if who:
        print("  What has it:\n")
        for line in who.splitlines():
            print("    " + line)
        print()
    print("  To clear it:    pkill -f spotify-auth\n"
          "  Then run this again. Or carry on below and paste the code by\n"
          "  hand - that works too, and does not need the port at all.\n")
    return None


def manual_code():
    """The paste-it-in path.

    Worth having for more than a busy port: the redirect goes to
    127.0.0.1, so the browser has to be ON the Pi for it to be caught
    automatically - and a boat Pi is usually driven over SSH with no
    browser to open. Approve on a laptop instead, and the browser lands
    on a page that will not load whose ADDRESS BAR holds the code."""
    print("  After approving, your browser will try to reach 127.0.0.1 and\n"
          "  most likely fail to connect. That is expected. Copy the whole\n"
          "  address out of the bar - it looks like\n"
          "    http://127.0.0.1:%d/callback?code=AQD...\n" % PORT)
    raw = input("Paste that address (or just the code): ").strip()
    if not raw:
        return ""
    if "code=" in raw:
        q = urllib.parse.urlparse(raw).query or raw.split("?", 1)[-1]
        got = urllib.parse.parse_qs(q).get("code") or []
        return got[0].strip() if got else ""
    return raw


def main():
    print(__doc__)
    # Before anything is typed: a failure here should cost nothing.
    srv = try_bind()
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

    print("\nOpen this in a browser and approve:\n\n  %s\n" % url)
    # Only when there is a desktop of our own to open it on. Over SSH
    # there is nothing to open, and under the cage kiosk the one browser
    # on the machine is the helm display itself - handing it this URL
    # would replace the instruments with a Spotify consent screen,
    # because Chromium is single-instance per profile.
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        try:
            webbrowser.open(url)
        except Exception:
            pass

    if srv is not None:
        print("waiting for the redirect on %s ..." % REDIRECT)
        srv.handle_request()
        srv.server_close()
        code = _result.get("code", "")
        if not code:
            print("\nno authorisation code received: %s"
                  % _result.get("error", "unknown"))
            sys.exit(1)
    else:
        code = manual_code()
        if not code:
            print("\nno code given - nothing written.")
            sys.exit(1)

    basic = base64.b64encode(("%s:%s" % (client_id, client_secret)).encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
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
    print("\nRestart the helm session and the poller starts with it.")
    print("Or right now, by hand:  python3 %s"
          % os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "spotify-now.py"))


if __name__ == "__main__":
    main()
