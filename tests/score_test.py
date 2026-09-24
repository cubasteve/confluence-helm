#!/usr/bin/env python3
"""Submitting a time to the club's scoreboard.

This is the fallback path. The page posts to Vudu Wave itself - the
server reflects any Origin, so a browser can - and comes here only when
that fails, which on the boat is usually a phone or a proxy in the way.

It is still somebody else's small server on the other end, so the rules
that matter are the ones about not pointing a loop at it: one race, one
submission, and only ever because a hand on the glass said yes.

    python3 tests/score_test.py
"""
import contextlib, importlib, json, os, sys, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class Scorer(BaseHTTPRequestHandler):
    """A stand-in for vuduwave.com that writes down what it was sent."""
    posts = []
    status = 200
    body = '{"message":"Time added"}'
    delay = 0.0

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n)
        try:
            data = json.loads(raw or b'{}')
        except ValueError:
            data = {'_raw': raw.decode('utf-8', 'replace')}
        Scorer.posts.append({'path': self.path, 'body': data,
                             'ctype': self.headers.get('Content-Type')})
        if Scorer.delay:
            time.sleep(Scorer.delay)
        out = Scorer.body.encode()
        self.send_response(Scorer.status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


@contextlib.contextmanager
def rig(**env):
    """netd imported fresh, pointed at the stand-in rather than the club."""
    srv = ThreadingHTTPServer(('127.0.0.1', 0), Scorer)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    Scorer.posts = []
    Scorer.status, Scorer.body, Scorer.delay = 200, '{"message":"Time added"}', 0.0
    url = 'http://127.0.0.1:%d/api/add_scratch_time' % srv.server_address[1]
    old = dict(os.environ)
    os.environ.update({'HELM_SCORE_URL': url, 'HELM_SCORE_GAP': '0',
                       'HELM_SCORE_SAME': '0', 'HELM_BUZZER_MODE': 'off'})
    for k, v in env.items():
        os.environ[k] = v
    sys.modules.pop('netd', None)
    try:
        yield importlib.import_module('netd')
    finally:
        os.environ.clear()
        os.environ.update(old)
        sys.modules.pop('netd', None)
        srv.shutdown()
        srv.server_close()


class Accepts(unittest.TestCase):
    """The times the club's form takes, checked here rather than found
    out from a round trip."""

    def setUp(self):
        self.ctx = rig()
        self.n = self.ctx.__enter__()

    def tearDown(self):
        self.ctx.__exit__(None, None, None)

    def ok(self, t):
        Scorer.posts = []
        r = self.n.score_submit(201, t)
        self.assertTrue(r['ok'], '%s -> %s' % (t, r))
        return Scorer.posts[-1]['body']

    def bad(self, t):
        Scorer.posts = []
        r = self.n.score_submit(201, t)
        self.assertFalse(r['ok'], t)
        self.assertEqual(r['error'], 'BAD TIME', t)
        self.assertEqual(Scorer.posts, [], 'and nothing left the boat')

    def test_an_hour_and_a_bit(self):
        self.assertEqual(self.ok('1.42.17')['elapsed_time'], '1.42.17')

    def test_a_short_race(self):
        self.ok('42.17')

    def test_a_dot_a_colon_or_a_comma(self):
        for t in ('1:42:17', '1,42,17', '42:17', '42,17'):
            self.ok(t)

    def test_a_retirement(self):
        for t in ('DNF', 'dns', 'DSQ'):
            self.ok(t)

    def test_sixty_minutes_is_not_a_time(self):
        self.bad('1.60.17')
        self.bad('42.60')

    def test_nor_is_a_word(self):
        self.bad('about an hour')

    def test_nor_is_nothing(self):
        self.bad('')
        self.bad(None)

    def test_nor_is_a_bare_number(self):
        # 4217 could be anything, and guessing at somebody else's
        # scoreboard is not this program's business.
        self.bad('4217')

    def test_spaces_round_it_are_forgiven(self):
        self.ok('  42.17  ')

    def test_the_racer_has_to_be_a_number(self):
        for rid in ('steven', None, ''):
            r = self.n.score_submit(rid, '42.17')
            self.assertFalse(r['ok'], repr(rid))
            self.assertEqual(r['error'], 'BAD RACER')
        self.assertEqual(Scorer.posts, [])

    def test_a_number_written_as_text_is_still_a_number(self):
        self.assertEqual(self.ok('42.17')['racer_id'], 201)
        r = self.n.score_submit('200', '42.18')
        self.assertTrue(r['ok'])
        self.assertEqual(Scorer.posts[-1]['body']['racer_id'], 200)


class Sends(unittest.TestCase):
    """What actually goes over the wire."""

    def test_the_two_fields_the_form_posts_and_nothing_else(self):
        with rig() as n:
            n.score_submit(201, '42.17')
            p = Scorer.posts[-1]
            self.assertEqual(p['body'], {'elapsed_time': '42.17',
                                         'racer_id': 201})
            self.assertEqual(p['ctype'], 'application/json')

    def test_no_captcha_token_is_invented(self):
        # The entry form runs an invisible reCAPTCHA. This has no way to
        # produce a token and no business faking one.
        with rig() as n:
            n.score_submit(201, '42.17')
            keys = set(Scorer.posts[-1]['body'])
            self.assertFalse([k for k in keys if 'captcha' in k.lower()])

    def test_the_class_is_the_racer_id_and_nothing_is_added_to_it(self):
        with rig() as n:
            n.score_submit(200, 'DNF')
            self.assertEqual(Scorer.posts[-1]['body'],
                             {'elapsed_time': 'DNF', 'racer_id': 200})


class Answers(unittest.TestCase):
    """What comes back, which the panel shows verbatim."""

    def test_the_server_s_own_words(self):
        with rig() as n:
            Scorer.body = '{"message":"Time added for Steven Artau"}'
            r = n.score_submit(201, '42.17')
            self.assertTrue(r['ok'])
            self.assertEqual(r['status'], 200)
            self.assertEqual(r['message'], 'Time added for Steven Artau')

    def test_refused_is_refused(self):
        with rig() as n:
            Scorer.status = 422
            Scorer.body = '{"message":"Racer not found"}'
            r = n.score_submit(201, '42.17')
            self.assertFalse(r['ok'])
            self.assertEqual(r['status'], 422)
            self.assertEqual(r['error'], 'REFUSED 422')
            self.assertEqual(r['message'], 'Racer not found',
                             'and the reason is passed on, not swallowed')

    def test_an_answer_that_is_not_json_still_says_something(self):
        with rig() as n:
            Scorer.body = '<html><body>Gateway Timeout</body></html>'
            r = n.score_submit(201, '42.17')
            self.assertIn('Gateway', r['message'])

    def test_a_long_answer_is_cut_rather_than_shown_whole(self):
        with rig() as n:
            Scorer.body = json.dumps({'message': 'x' * 500})
            r = n.score_submit(201, '42.17')
            self.assertLessEqual(len(r['message']), 160)

    def test_no_internet_is_reported_rather_than_dressed_up(self):
        with rig(HELM_SCORE_URL='http://127.0.0.1:9/nope') as n:
            r = n.score_submit(201, '42.17')
            self.assertFalse(r['ok'])
            self.assertTrue(r['error'], 'the fallback is a QR and a phone')

    def test_scoring_can_be_switched_off(self):
        with rig(HELM_SCORE_URL='') as n:
            self.assertFalse(n.score_status()['available'])
            r = n.score_submit(201, '42.17')
            self.assertEqual(r['error'], 'SCORING OFF')
            self.assertEqual(Scorer.posts, [])


class Limits(unittest.TestCase):
    """Not for this boat's benefit. A bug in a loop here would be a bug
    in a loop pointed at somebody else's server."""

    def test_two_in_a_row_is_too_soon(self):
        with rig(HELM_SCORE_GAP='30') as n:
            self.assertTrue(n.score_submit(201, '42.17')['ok'])
            r = n.score_submit(201, '43.00')
            self.assertFalse(r['ok'])
            self.assertEqual(r['error'], 'TOO SOON')
            self.assertEqual(len(Scorer.posts), 1)

    def test_the_same_one_twice_is_a_double_tap(self):
        with rig(HELM_SCORE_SAME='300') as n:
            self.assertTrue(n.score_submit(201, '42.17')['ok'])
            r = n.score_submit(201, '42.17')
            self.assertFalse(r['ok'])
            self.assertEqual(r['error'], 'ALREADY SENT')
            self.assertEqual(len(Scorer.posts), 1)

    def test_but_a_corrected_time_goes_through(self):
        # The club's form says an incorrect time can be resubmitted, so
        # the guard is against a double tap and not against you.
        with rig(HELM_SCORE_SAME='300') as n:
            self.assertTrue(n.score_submit(201, '42.17')['ok'])
            self.assertTrue(n.score_submit(201, '42.19')['ok'])
            self.assertEqual(len(Scorer.posts), 2)

    def test_a_refused_one_does_not_count_as_sent(self):
        with rig(HELM_SCORE_SAME='300') as n:
            Scorer.status = 500
            self.assertFalse(n.score_submit(201, '42.17')['ok'])
            Scorer.status = 200
            self.assertTrue(n.score_submit(201, '42.17')['ok'],
                            'so you can try again when the server comes back')

    def test_a_bad_time_does_not_start_the_clock(self):
        with rig(HELM_SCORE_GAP='30') as n:
            n.score_submit(201, 'nonsense')
            self.assertTrue(n.score_submit(201, '42.17')['ok'],
                            'a typo must not lock the sender out for 30 s')

    def test_the_limits_hold_against_a_racing_pair_of_taps(self):
        with rig(HELM_SCORE_GAP='30') as n:
            out = []
            def go():
                out.append(n.score_submit(201, '42.17'))
            ts = [threading.Thread(target=go) for _ in range(6)]
            [t.start() for t in ts]
            [t.join() for t in ts]
            self.assertEqual(sum(1 for r in out if r['ok']), 1, out)
            self.assertEqual(len(Scorer.posts), 1)

    def test_the_real_defaults_are_the_cautious_ones(self):
        with rig(HELM_SCORE_GAP='', HELM_SCORE_SAME='') as n:
            self.assertEqual(n.SCORE_GAP, 10.0)
            self.assertEqual(n.SCORE_SAME, 300.0)

    def test_and_nonsense_in_the_environment_does_not_remove_them(self):
        with rig(HELM_SCORE_GAP='soon', HELM_SCORE_SAME='-5') as n:
            self.assertEqual(n.SCORE_GAP, 10.0)
            self.assertEqual(n.SCORE_SAME, 0.0)


class Route(unittest.TestCase):
    """The way the page actually asks."""

    def test_the_page_can_submit(self):
        with rig() as n:
            r = n.route('/score', {'racer_id': 201, 'elapsed_time': '42.17'})
            self.assertTrue(r['ok'])
            self.assertEqual(Scorer.posts[-1]['body']['racer_id'], 201)

    def test_the_body_is_the_one_the_page_sends(self):
        # The page posts {elapsed_time, racer_id} straight through,
        # same shape to netd as to the club - so the route reads that
        # name and not a shorter one.
        with rig() as n:
            r = n.route('/score', {'racer_id': 201, 'elapsed': '42.17'})
            self.assertFalse(r['ok'])
            self.assertEqual(r['error'], 'BAD TIME')

    def test_status_says_whether_it_can(self):
        with rig() as n:
            self.assertTrue(n.route('/status', {})['score']['available'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
