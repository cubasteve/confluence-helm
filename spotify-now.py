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
# Same rule as everything else in this repo: resolve the home directory,
# do not assume the account is called pi. Hardcoded, these two paths meant
# the poller wrote where nothing was reading on any other account, and the
# music page simply stayed on "Nothing playing" with no clue why.
_HOME = os.path.expanduser("~")
TARGETS = [
    os.path.join(_HOME, "avnav/data/user/helm/nowplaying.json"),  # served by AvNav
    os.path.join(_HOME, "helm/nowplaying.json"),                  # the file:// copy
]

POLL_PLAYING = 5        # seconds between polls while something is playing
POLL_IDLE = 20          # back off when nothing is playing
API = "https://api.spotify.com/v1/me/player/currently-playing"
TOKEN_URL = "https://accounts.spotify.com/api/token"
# The library, and the reason there are two of these.
#
# Spotify's February 2026 Web API changes replaced every per-type save /
# remove / contains endpoint with one generic pair on /me/library that
# takes Spotify URIs instead of bare IDs. The old ones were not merely
# marked deprecated: for a Development Mode app - which is what a
# personal app like this one is - they answer 403 FORBIDDEN, with a valid
# token and the right scopes. Existing dev-mode apps were migrated onto
# that restriction on 9 March 2026.
#
# That 403 is the whole of the "the heart does not actually like the
# song" bug, and it was also what hid the heart in the first place: the
# contains check failed, the poller wrote liked: null, and the panel drew
# nothing. It reads exactly like a missing scope and is not one - the
# scopes here are unchanged, so nothing needs re-authorising.
#
# LEGACY is still here because a 404 on the new path is a better reason
# to try the old one than to lose the feature on a boat.
LIBRARY = "https://api.spotify.com/v1/me/library"       # like / unlike / contains
LEGACY = "https://api.spotify.com/v1/me/tracks"         # pre-2026, 403 in dev mode
PLAYER = "https://api.spotify.com/v1/me/player"         # transport

# What the panel may ask for, and how. Transport needs an ACTIVE DEVICE -
# this Pi is not one, deliberately, so these drive whatever is really
# playing: the phone feeding the cockpit speakers. With nothing active
# Spotify answers 404, and on a free account 403, and both have to reach
# the panel as words rather than as a button that quietly does nothing.
CONTROLS = {
    "next":  ("POST", PLAYER + "/next"),
    "prev":  ("POST", PLAYER + "/previous"),
    "play":  ("PUT",  PLAYER + "/play"),
    "pause": ("PUT",  PLAYER + "/pause"),
}

# netd drops a like-or-unlike request here and this process carries it out.
#
# It goes through a file rather than netd calling Spotify itself because
# ONE process must own the token. Spotify sometimes hands back a rotated
# refresh token, and whoever receives it writes it to the config - two
# processes refreshing independently means one of them is eventually
# holding a refresh token that has been replaced, and the failure is a
# dead integration hours later with nothing to point at. So netd, which
# has the HTTP listener, writes the request; this loop, which has the
# token, performs it.
CMD = os.environ.get("HELM_SPOTIFY_CMD", "/tmp/confluence-spotify-cmd.json")

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
        try:
            d = post_form(
                TOKEN_URL,
                {"grant_type": "refresh_token",
                 "refresh_token": self.cfg["refresh_token"]},
                {"Authorization": "Basic " + basic,
                 "Content-Type": "application/x-www-form-urlencoded"},
            )
        except urllib.error.HTTPError as e:
            # Spotify answers a bad client secret or a revoked refresh
            # token with a 400 or a 401 and a one-word reason, and
            # "http 400" on its own sends you nowhere. Rotating the
            # client secret in the dashboard is the usual way to get
            # here: the config still holds the old one.
            if e.code in (400, 401):
                why = ""
                try:
                    why = json.load(e).get("error_description") or ""
                except Exception:
                    pass
                log("token refresh REFUSED (%s)%s" % (e.code, ": " + why if why else ""))
                log("  the credentials in %s no longer work." % CONFIG)
                log("  if you rotated the client secret, re-run spotify-auth.py")
            raise
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


def api(token, method, url, timeout=20):
    """A bare request that returns the parsed body, or None for 204/empty.

    Content-Length is set explicitly because the ids travel in the query
    string, so PUT and DELETE here carry no body - and urllib sends no
    Content-Length at all in that case, which some servers refuse. It
    costs nothing to be unambiguous about a request that has no body."""
    head = {"Authorization": "Bearer " + token}
    if method in ("PUT", "POST", "DELETE"):
        head["Content-Length"] = "0"
    req = urllib.request.Request(url, method=method, headers=head)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status == 204:
            return None
        body = r.read()
        return json.loads(body) if body else None


# Which shape of the library API is answering. Only a 404 - the path
# genuinely not being there - moves this; a 403 is a real refusal and is
# reported rather than worked around.
_legacy = {"on": False}


def _q(v):
    """Percent-encode a whole value, colons included: a Spotify URI is
    ONE query value, not a path."""
    return urllib.parse.quote(v, safe="")


def _fell_back(what):
    if not _legacy["on"]:
        log("%s: /me/library answered 404, falling back to the pre-2026 "
            "endpoint. If the heart then stops working, that fallback is "
            "why - the old path answers 403 for Development Mode apps." % what)
        _legacy["on"] = True


def is_saved(token, track_id):
    """Is this track in the library? One request, and the caller is
    expected to ask only when the track ID has actually changed - asking
    every poll would double this process's request rate for an answer
    that cannot change between two polls of the same track."""
    if not track_id:
        return None
    if not _legacy["on"]:
        try:
            got = api(token, "GET",
                      LIBRARY + "/contains?uris=" + _q("spotify:track:" + track_id))
            return bool(got[0]) if isinstance(got, list) and got else None
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            _fell_back("library check")
    got = api(token, "GET", LEGACY + "/contains?ids=" + _q(track_id))
    return bool(got[0]) if isinstance(got, list) and got else None


def set_saved(token, track_id, want):
    """Like (PUT) or unlike (DELETE). Returns the new state.

    Both shapes carry the track in the query string and no body, so the
    only difference is the path and whether it wants a URI or an ID."""
    method = "PUT" if want else "DELETE"
    if not _legacy["on"]:
        try:
            api(token, method,
                LIBRARY + "?uris=" + _q("spotify:track:" + track_id))
            return want
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            _fell_back("like" if want else "unlike")
    api(token, method, LEGACY + "?ids=" + _q(track_id))
    return want


def do_control(token, op):
    """Transport. Raises on refusal - the caller quarantines it."""
    method, url = CONTROLS[op]
    api(token, method, url)


def try_control(token, op):
    """Never raises. Returns '' on success or a short reason to show."""
    try:
        do_control(token.get(), op)
        log("transport: %s" % op)
        return ""
    except urllib.error.HTTPError as e:
        if e.code == 404:
            log("transport %s: no active device" % op)
            return "NO ACTIVE DEVICE"
        if e.code == 403:
            log("transport %s: refused (403) - needs Premium and the "
                "user-modify-playback-state scope" % op)
            return "NOT ALLOWED"
        log("transport %s: http %s" % (op, e.code))
        return "HTTP %s" % e.code
    except Exception as e:
        log("transport %s failed: %s" % (op, e))
        return "NO REPLY"


def take_command():
    """Read and consume netd's request, if there is one."""
    try:
        with open(CMD) as f:
            cmd = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:
        log("bad command file: %s" % e)
        cmd = None
    try:
        os.remove(CMD)
    except OSError:
        pass
    return cmd


# --------------------------------------------------------------------
# The library half, quarantined.
#
# is_saved() used to be called between to_dial() and write(), unwrapped.
# A 403 there - which is precisely what a token without
# user-library-read returns - propagated out of the loop body and the
# write never happened. So an OPTIONAL feature took the whole
# now-playing feed down with it, and the panel just went quiet.
#
# Nothing below may raise. The rule is that the heart can fail; the
# music cannot notice.
_lib = {"warned": False, "until": 0.0}


def library_ready():
    return time.time() >= _lib["until"]


def library_failed(what, e):
    """Record a library failure and stop asking for a while."""
    code = getattr(e, "code", None)
    if code == 403:
        if not _lib["warned"]:
            log("%s refused (403). The heart still shows, dimmed, and says "
                "NOT ALLOWED if you press it. Music is unaffected." % what)
            if _legacy["on"]:
                log("  this went to the PRE-2026 endpoint, which answers 403 "
                    "for Development Mode apps whatever the token says. That "
                    "is the cause, not your scopes.")
            else:
                log("  this went to /me/library, so 403 here really is the "
                    "scope: re-run spotify-auth.py. A refresh token carries "
                    "the scopes it was granted with, so widening them needs "
                    "the consent screen again.")
            _lib["warned"] = True
        _lib["until"] = time.time() + 3600      # do not hammer it
    else:
        log("%s failed: %s" % (what, e))
        _lib["until"] = time.time() + 60


def try_is_saved(token, track_id):
    """The liked state, or None if we could not find out. Never raises."""
    if not library_ready():
        return None
    try:
        return is_saved(token.get(), track_id)
    except Exception as e:
        library_failed("library check", e)
        return None


def try_set_saved(token, cmd):
    """Carry out a like/unlike. '' if it took, else a short reason to
    show on the glass. Never raises.

    It reports the reason rather than just failing because the panel is
    optimistic: the heart fills on the tap. A silent False there means
    the heart quietly un-fills a few seconds later and the boat is told
    nothing about why - which is the same failure the hidden heart was.
    Same shape as try_control() for the same reason.
    """
    want = bool(cmd.get("want"))
    verb = "like" if want else "unlike"
    # Deliberately NOT gated on library_ready(). The backoff exists to
    # stop the POLL loop hammering an endpoint that is refusing it; a
    # press is one request that someone made on purpose, and refusing it
    # locally would mean the panel showing a made-up reason instead of
    # Spotify's real one. If the scope is genuinely missing this comes
    # straight back 403 and says so, which is the useful answer.
    try:
        set_saved(token.get(), cmd["id"], want)
        log("%s %s" % ("liked" if want else "unliked", cmd["id"]))
        # It worked, so whatever the check was backing off from is over.
        _lib["until"] = 0.0
        return ""
    except urllib.error.HTTPError as e:
        library_failed(verb, e)
        return "NOT ALLOWED" if e.code == 403 else "HTTP %s" % e.code
    except Exception as e:
        library_failed(verb, e)
        return "NO REPLY"



def to_dial(payload):
    """Map Spotify's shape onto what the dial's poller reads."""
    now = int(time.time() * 1000)
    if not payload or not payload.get("item"):
        return {"event": "stopped", "title": "", "artist": "", "cover": "",
                "album": "", "id": "", "liked": None, "cmderr": "",
                "position": 0, "duration": 0, "at": now}
    it = payload["item"]
    album = it.get("album") or {}
    return {
        "event": "playing" if payload.get("is_playing") else "paused",
        "title": it.get("name", ""),
        "artist": ", ".join(a.get("name", "") for a in it.get("artists", [])),
        "album": album.get("name", ""),
        "cover": pick_cover(album.get("images") or []),
        # id is what the like button acts on; liked is filled in by the
        # loop, which knows whether it needs to go and ask.
        "id": it.get("id") or "",
        "liked": None,
        "cmderr": "",
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


def sleep_watching(delay):
    """Sleep, but notice a command file promptly. A like that took the
    poll interval to register would feel broken; a stat() twice a second
    costs nothing next to the HTTPS request this is waiting to make."""
    end = time.time() + delay
    while time.time() < end:
        if os.path.exists(CMD):
            return
        time.sleep(min(0.5, max(0.05, end - time.time())))


def main():
    cfg = load_config()
    token = Token(cfg)
    last = None
    backoff = 0
    liked_id, liked = None, None      # the library answer, and what it is for

    while True:
        delay = POLL_IDLE
        try:
            # ---- the core, and nothing optional may come before it ----
            payload, status = fetch_playing(token.get())
            state = to_dial(payload)

            # ---- the library half, which is not allowed to matter ----
            # Every call below is wrapped so that it cannot stop the
            # write. A like that fails costs a heart, not the music.
            cmd = take_command()
            if cmd and cmd.get("op") in CONTROLS:
                # A transport press. Whatever happens it must not cost
                # the feed, so the reason goes into the file the panel is
                # already reading rather than raising out of here.
                err = try_control(token, cmd["op"])
                state["cmderr"] = err
                # Re-read at once: after a skip the old track would
                # otherwise sit on the glass for a whole poll interval.
                if not err:
                    try:
                        payload, status = fetch_playing(token.get())
                        state = to_dial(payload)
                        state["cmderr"] = ""
                    except Exception:
                        pass
                last = None
            elif cmd and cmd.get("id"):
                err = try_set_saved(token, cmd)
                if err:
                    # Say why, in the file the panel is already reading.
                    # Also forget the stored answer: a refused like tells
                    # us nothing about what the library holds, and what
                    # we had was only ever a guess if it came back None.
                    state["cmderr"] = err
                    liked_id = None
                else:
                    liked_id, liked = cmd["id"], bool(cmd.get("want"))
                last = None            # force a rewrite so the panel confirms

            # Only ask the library when the track actually changed. The
            # answer cannot differ between two polls of the same track,
            # and asking every time would double this loop's requests.
            if state["id"] and state["id"] != liked_id:
                liked = try_is_saved(token, state["id"])
                # Remember which track the answer is FOR only when there
                # IS an answer. Recording the id beside a None means
                # "already asked about this track", so a failure that
                # clears in a minute would not be retried until the NEXT
                # track - and on a long album that is the whole side.
                liked_id = state["id"] if liked is not None else None
            elif not state["id"]:
                liked_id, liked = None, None
            state["liked"] = liked if state["id"] else None

            # only rewrite when something actually changed, so the file's
            # mtime stays meaningful and the SD card is not churned
            key = (state["event"], state["title"], state["position"] // 5000,
                   state["liked"], state.get("cmderr"))
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
        sleep_watching(delay)


def check(argv):
    """Prove - against the real API, with the real token - whether the
    heart does what it claims.

        python3 spotify-now.py --check     what is playing, and is it saved
        python3 spotify-now.py --like      save it, then RE-READ to confirm
        python3 spotify-now.py --unlike    remove it, then re-read

    The re-read is the point. A 200 from Spotify only says the request
    was accepted; asking again afterwards is what shows the library
    actually changed."""
    cfg = load_config()
    token = Token(cfg)
    try:
        tok = token.get()
    except Exception as e:
        print("token refresh FAILED: %s" % e)
        print("  the credentials in %s are not working." % CONFIG)
        return 1
    print("token            ok")

    payload, status = fetch_playing(tok)
    state = to_dial(payload)
    if not state["id"]:
        print("playing          nothing (start something and try again)")
        return 1
    print("playing          %s - %s" % (state["title"], state["artist"]))
    print("track id         %s" % state["id"])

    try:
        before = is_saved(tok, state["id"])
    except urllib.error.HTTPError as e:
        where = "the pre-2026 /me/tracks/contains" if _legacy["on"] \
                else "/me/library/contains"
        print("library          NO (%s on %s)" % (e.code, where))
        if e.code == 403 and _legacy["on"]:
            print("  that endpoint answers 403 for Development Mode apps")
            print("  whatever your scopes say. This is not fixed by re-auth.")
        elif e.code == 403:
            print("  no user-library-read scope - re-run spotify-auth.py")
        return 1
    print("library          ok (%s)" %
          ("pre-2026 /me/tracks" if _legacy["on"] else "/me/library"))
    print("saved already    %s" % ("yes" if before else "no"))

    want = None
    if "--like" in argv:
        want = True
    elif "--unlike" in argv:
        want = False
    if want is None:
        print("\nadd --like or --unlike to actually change it.")
        return 0

    print("\nsending %s ..." % ("PUT (save)" if want else "DELETE (remove)"))
    try:
        set_saved(tok, state["id"], want)
    except urllib.error.HTTPError as e:
        print("REFUSED: http %s" % e.code)
        if e.code == 403 and _legacy["on"]:
            print("  the pre-2026 endpoint refuses Development Mode apps.")
        elif e.code == 403:
            print("  no user-library-modify scope - re-run spotify-auth.py")
        return 1
    after = is_saved(tok, state["id"])
    print("re-read from Spotify: saved = %s" % ("yes" if after else "no"))
    if after == want:
        print("\nCONFIRMED: the library really changed.")
        print("  In the Spotify app the heart is now a + button, and a saved")
        print("  track shows a green CHECKMARK rather than a filled heart.")
        print("  If in doubt, look in the Liked Songs playlist itself.")
        return 0
    print("\nAccepted but the library did NOT change. Something is wrong.")
    return 1


if __name__ == "__main__":
    if any(a in sys.argv[1:] for a in ("--check", "--like", "--unlike")):
        sys.exit(check(sys.argv[1:]))
    main()
