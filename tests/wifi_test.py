#!/usr/bin/env python3
"""The name on a wifi row is not a handle, and this is why.

nmcli writes its output in the locale's charset and puts '?' in place of
anything it cannot spell. A Pi that comes up without a locale gets ASCII,
so an iPhone hotspot - iOS names them with a curly apostrophe - arrives
as "Steven?s iPhone". Everything downstream then asks NetworkManager
about a connection by a name that was never its name, and the X on the
row fails for ever with "unknown connection".

Two things are held to account here: that the children are given a UTF-8
locale so this stops happening, and that anything acting on a connection
goes by uuid so the one already on the glass can still be removed.

    python3 tests/wifi_test.py
"""
import contextlib, importlib, os, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

CURLY = 'Steven’s iPhone'          # what the phone is actually called
MANGLED = 'Steven?s iPhone'             # what an ASCII locale hands over
UU = '11111111-2222-3333-4444-555555555555'
LOG = None


NM_NO_TARGET = ('Error: Failed to add/activate new connection: '
                '802-11-wireless setting is required if no AP path was given.')


@contextlib.contextmanager
def rig(profiles, mangle=False, connectable=False):
    """netd with a pretend nmcli on the PATH.

    `profiles` is [(name, uuid)]. With mangle, the fake prints names the
    way nmcli does under a locale it cannot spell them in - which is the
    bug, reproduced rather than described. Without `connectable`,
    `device connect` fails the way NetworkManager really does when there
    is nothing saved and in range to activate."""
    global LOG
    d = tempfile.mkdtemp(prefix='helm-wifi-test-')
    LOG = os.path.join(d, 'calls')
    open(LOG, 'w').close()
    rows = []
    for n, u in profiles:
        rows.append('%s:%s:802-11-wireless' % (
            (n.encode('ascii', 'replace').decode() if mangle else n), u))
    known = ' '.join(u for _, u in profiles)
    body = (
        '#!/bin/sh\n'
        'printf "%s\\t%s\\n" "$LC_ALL" "$*" >> ' + LOG + '\n'
        'case "$*" in\n'
        '  *"-f NAME,UUID,TYPE connection show"*)\n'
        + ''.join("    printf '%s\\n'\n" % r.replace("'", "'\\''") for r in rows) +
        '    exit 0;;\n'
        '  *"connection delete uuid "*)\n'
        '    for k in ' + known + '; do\n'
        '      case "$*" in *"$k"*) exit 0;; esac\n'
        '    done\n'
        '    echo "Error: unknown connection" >&2; exit 10;;\n'
        '  *"connection delete id "*)\n'
        '    echo "Error: unknown connection" >&2; exit 10;;\n'
        '  *"-f STATE general"*) echo "connected"; exit 0;;\n'
        '  *"-f WIFI radio"*) echo "enabled"; exit 0;;\n'
        '  *"device show"*)\n'
        '    printf "GENERAL.DEVICE:wlan0\\n"\n'
        '    printf "GENERAL.TYPE:wifi\\n"\n'
        '    printf "GENERAL.STATE:30 (disconnected)\\n"\n'
        '    printf "GENERAL.CONNECTION:--\\n"\n'
        '    exit 0;;\n'
        '  *"device set "*) exit 0;;\n'
        '  *"device connect "*)\n'
        + ('    exit 0;;\n' if connectable else
           '    echo "' + NM_NO_TARGET + '" >&2; exit 4;;\n') +
        '  *"device disconnect "*) exit 0;;\n'
        'esac\n'
        'exit 0\n')
    p = os.path.join(d, 'nmcli')
    with open(p, 'w') as f:
        f.write(body)
    os.chmod(p, 0o755)
    saved = dict(os.environ)
    os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
    sys.modules.pop('netd', None)
    try:
        yield importlib.import_module('netd')
    finally:
        os.environ.clear()
        os.environ.update(saved)
        sys.modules.pop('netd', None)


def calls():
    with open(LOG) as f:
        return [l.rstrip('\n').split('\t', 1) for l in f if l.strip()]


def deletes():
    return [c[1] for c in calls() if 'connection delete' in c[1]]


class Locale(unittest.TestCase):
    def test_children_get_utf8(self):
        """The fix at the root: every child is told what charset to use.

        Without this nmcli is entitled to hand back '?' and there is no
        way to get the real name afterwards - it is gone before netd ever
        sees it."""
        with rig([(CURLY, UU)]) as netd:
            netd.wifi_conns()
        self.assertTrue(calls(), 'nmcli was never called')
        for env, argv in calls():
            self.assertEqual(env, 'C.UTF-8', 'child ran under %r for: %s'
                             % (env, argv))

    def test_a_curly_apostrophe_survives(self):
        with rig([(CURLY, UU)]) as netd:
            self.assertEqual(netd.wifi_conns(), [(CURLY, UU)])
            self.assertIn(CURLY, netd.saved_wifi())

    def test_the_bug_itself(self):
        """With the locale lost, the name really does arrive mangled -
        so the recovery below is answering something real."""
        with rig([(CURLY, UU)], mangle=True) as netd:
            self.assertEqual(netd.wifi_conns(), [(MANGLED, UU)])


class Uuid(unittest.TestCase):
    def test_exact_name_resolves(self):
        with rig([(CURLY, UU)]) as netd:
            self.assertEqual(netd.wifi_uuid(CURLY), UU)

    def test_mangled_name_still_resolves(self):
        """The row already on the glass. '?' stands for the character
        nmcli could not spell."""
        with rig([(CURLY, UU)]) as netd:
            self.assertEqual(netd.wifi_uuid(MANGLED), UU)

    def test_unknown_name_resolves_to_nothing(self):
        with rig([(CURLY, UU)]) as netd:
            self.assertEqual(netd.wifi_uuid('Somebody else'), '')

    def test_ambiguity_is_refused_not_guessed(self):
        """Two hotspots differing only at the position '?' stands for.
        Deleting the wrong one is worse than refusing.

        They have to be the same length to collide: nmcli substitutes one
        '?' per character it cannot spell, so the wildcard matches a
        character that was replaced, not one that is missing. The first
        try at this test used "Stevens iPhone", a character shorter,
        which never matched at all - the test failed and the code was
        right."""
        with rig([('Steven’s iPhone', UU),
                  ('Steven-s iPhone', 'aaaa-bbbb')]) as netd:
            self.assertEqual(netd.wifi_uuid('Steven?s iPhone'), '')

    def test_exact_wins_over_wildcard(self):
        with rig([('a?c', 'exact-one'), ('abc', 'wild-one')]) as netd:
            self.assertEqual(netd.wifi_uuid('a?c'), 'exact-one')


class Forget(unittest.TestCase):
    def test_forget_goes_out_by_uuid(self):
        with rig([(CURLY, UU)]) as netd:
            r = netd.route('/wifi/forget', {'ssid': MANGLED})
        self.assertTrue(r['ok'], r)
        self.assertEqual(len(deletes()), 1, deletes())
        self.assertIn('uuid ' + UU, deletes()[0])
        self.assertNotIn('delete id', deletes()[0])

    def test_forget_an_unknown_network_runs_no_delete(self):
        """It says so rather than firing a delete off into the dark."""
        with rig([(CURLY, UU)]) as netd:
            r = netd.route('/wifi/forget', {'ssid': 'never seen'})
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'NOT SAVED')
        self.assertEqual(deletes(), [])


class Radio(unittest.TestCase):
    """The switch on the wifi row, which was not switching the radio on.

    `nmcli device connect` asks NetworkManager to ACTIVATE something on
    an adapter. With nothing saved and in range there is nothing to pick,
    and it fails - so tapping ON reported failure and the adapter looked
    dead when it was only idle. Worse, `device disconnect` leaves the
    device with autoconnect off and nothing lifts that on its own, so an
    adapter dropped once stayed down."""

    def test_on_does_not_fail_when_there_is_nothing_to_join(self):
        with rig([]) as netd:
            r = netd.wifi_power('wlan0', True)
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['error'], '')

    def test_on_hands_the_device_back_to_autoconnect(self):
        """The half that was missing, and the half that actually turns it
        back on. It has to happen before the connect is attempted."""
        with rig([]) as netd:
            netd.wifi_power('wlan0', True)
        argvs = [c[1] for c in calls()]
        sets = [i for i, a in enumerate(argvs) if 'device set wlan0' in a]
        cons = [i for i, a in enumerate(argvs) if 'device connect wlan0' in a]
        self.assertTrue(sets, argvs)
        self.assertIn('autoconnect yes', argvs[sets[0]])
        self.assertIn('managed yes', argvs[sets[0]])
        self.assertTrue(cons and sets[0] < cons[0], argvs)

    def test_a_real_failure_still_reports(self):
        """Not a blanket ok: only NM's "you did not say what to join" is
        forgiven."""
        with rig([]) as netd:
            self.assertFalse(netd.no_target('Error: device is strictly unmanaged'))
            self.assertTrue(netd.no_target(NM_NO_TARGET))

    def test_off_is_still_a_disconnect(self):
        with rig([]) as netd:
            r = netd.wifi_power('wlan0', False)
        self.assertTrue(r['ok'], r)
        self.assertTrue(any('device disconnect wlan0' in c[1] for c in calls()))

    def test_the_sentence_never_reaches_a_tile(self):
        """Seventy characters of NetworkManager internals on a tile two
        words wide is how this looked from the helm."""
        with rig([]) as netd:
            self.assertEqual(netd.wifi_error(NM_NO_TARGET), 'NOTHING TO JOIN')


if __name__ == '__main__':
    unittest.main(verbosity=1)
