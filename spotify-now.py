#!/usr/bin/env python3
"""
Read what is playing on the Spotify ACCOUNT and write nowplaying.json for
the Confluence helm dial.

This does not play anything. The Pi is not a Spotify Connect device and
never streams audio - it only asks the Web API what the account is doing
and writes a small JSON file. Resident size is a few tens of MB against
librespot's hundred-plus, which is the whole point.

Standard library only, so there is nothing to pip install.

Config lives in ~/.config/confluence-spotify.json and holds your own
credentials - it is never sent anywhere except accounts.spotify.com:

    {"client_id": "...", "client_secret": "...", "refresh_token": "..."}

Run spotify-auth.py once to produce that file.
"""
import base64
import json
import os
import sys
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request

CONFIG = os.path.expanduser("~/.config/confluence-spotify.json")
TARGETS = [
    "/home/pi/avnav/data/user/helm/nowplaying.json",   # served over http by AvNav
    "/home/pi/helm/nowplaying.json",                   # the file:// copy
]

POLL_PLAYING = 5        # seconds between polls while something is playing
POLL_IDLE = 20          # back off when nothing is playing
API = "https://api.spotify.com/v1/me/player/currently-playing"
TOKEN_URL = "https://accounts.spotify.com/api/token"

# Spotify's rate limit is generous but not infinite. 5 s while playing is
# 12 requests a minute; idling at 20 s is 3. Both sit far under it.


def log(msg):
    print("[spotify] %s" % msg, file=sys.stderr, flush=True)


def load_config():
    try:
        with open(CONFIG) as f:
            c = json.load(f)
    except FileNotFoundError:
        log("no config at %s - run spotify-auth.py first" % CONFIG)
        sys.exit(1)
    except Exception as e:
        log("config unreadable: %s" % e)
        sys.exit(1)
    for k in ("client_id", "client_secret", "refresh_token"):
        if not c.get(k):
            log("config is missing %r" % k)
            sys.exit(1)
    return c


def post_form(url, fields, headers=None):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, headers=headers or {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


class Token(object):
    """Access tokens last an hour; the refresh token does not expire."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.value = None
        self.expires = 0

    def get(self, force=False):
        if self.value and not force and time.time() < self.expires - 60:
            return self.value
        basic = base64.b64encode(
            ("%s:%s" % (self.cfg["client_id"], self.cfg["client_secret"])).encode()
        ).decode()
        d = post_form(
            TOKEN_URL,
            {"grant_type": "refresh_token", "refresh_token": self.cfg["refresh_token"]},
            {"Authorization": "Basic " + basic,
             "Content-Type": "application/x-www-form-urlencoded"},
        )
        self.value = d["access_token"]
        self.expires = time.time() + int(d.get("expires_in", 3600))
        # Spotify occasionally hands back a rotated refresh token
        if d.get("refresh_token") and d["refresh_token"] != self.cfg["refresh_token"]:
            self.cfg["refresh_token"] = d["refresh_token"]
            save_config(self.cfg)
            log("refresh token rotated and saved")
        log("access token refreshed")
        return self.value


def save_config(cfg):
    d = os.path.dirname(CONFIG)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".spot-")
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG)


def pick_cover(images):
    """Middle size if there is one - 640px art on a 300px circle is waste."""
    if not images:
        return ""
    ordered = sorted(images, key=lambda i: i.get("width") or 0)
    return ordered[len(ordered) // 2].get("url", "")


def fetch_playing(token):
    """Returns (state_dict_or_None, http_status)."""
    req = urllib.request.Request(API, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            if r.status == 204:                 # nothing playing
                return None, 204
            return json.load(r), r.status
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None, 204
        raise


def to_dial(payload):
    """Map Spotify's shape onto what the dial's poller reads."""
    now = int(time.time() * 1000)
    if not payload or not payload.get("item"):
        return {"event": "stopped", "title": "", "artist": "", "cover": "",
                "album": "", "position": 0, "duration": 0, "at": now}
    it = payload["item"]
    album = it.get("album") or {}
    return {
        "event": "playing" if payload.get("is_playing") else "paused",
        "title": it.get("name", ""),
        "artist": ", ".join(a.get("name", "") for a in it.get("artists", [])),
        "album": album.get("name", ""),
        "cover": pick_cover(album.get("images") or []),
        "position": int(payload.get("progress_ms") or 0),
        "duration": int(it.get("duration_ms") or 0),
        "at": now,
    }


def write(state):
    body = json.dumps(state, separators=(",", ":"))
    for target in TARGETS:
        d = os.path.dirname(target)
        if not os.path.isdir(d):
            continue
        try:
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".np-")
            with os.fdopen(fd, "w") as f:
                f.write(body)
            os.replace(tmp, target)   # atomic - the 2 s poller never sees a partial file
        except Exception as e:
            log("write failed for %s: %s" % (target, e))


def main():
    cfg = load_config()
    token = Token(cfg)
    last = None
    backoff = 0

    while True:
        delay = POLL_IDLE
        try:
            payload, status = fetch_playing(token.get())
            state = to_dial(payload)
            # only rewrite when something actually changed, so the file's
            # mtime stays meaningful and the SD card is not churned
            key = (state["event"], state["title"], state["position"] // 5000)
            if key != last:
                write(state)
                last = key
            delay = POLL_PLAYING if state["event"] == "playing" else POLL_IDLE
            backoff = 0
        except urllib.error.HTTPError as e:
            if e.code == 401:
                log("401 - forcing a token refresh")
                try:
                    token.get(force=True)
                    continue
                except Exception as ee:
                    log("refresh failed: %s" % ee)
            elif e.code == 429:
                delay = int(e.headers.get("Retry-After", "10")) + 1
                log("rate limited, waiting %ss" % delay)
            else:
                log("http %s" % e.code)
                backoff = min(backoff * 2 or 5, 300)
                delay = backoff
        except Exception as e:
            # no network is the normal case out on the water, not an error
            backoff = min(backoff * 2 or 5, 300)
            delay = backoff
            log("%s (retry in %ss)" % (e, delay))
        time.sleep(delay)


if __name__ == "__main__":
    main()
