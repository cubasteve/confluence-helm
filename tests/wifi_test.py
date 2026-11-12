#!/usr/bin/env python3
"""The wifi half of netd, against a pretend nmcli.

Three things are held to account here, all of them found on the water.

A name is not a handle. nmcli writes its output in the locale's charset
and puts '?' in place of anything it cannot spell, so an iPhone hotspot -
iOS names them with a curly apostrophe - arrives as "Steven?s iPhone".
The panel sends that back, NetworkManager has never heard of it, and the
row can never be deleted.

A switch is not a join. `device connect` asks NM to ACTIVATE something,
so with nothing saved and in range the switch reported failure and an
idle adapter looked dead.

An adapter NM has not adopted is still an adapter. It used to be dropped
from the list, so a dongle that enumerated after NM started "did not show
up at all" - and the command that adopts it is the one behind the switch
you could not see.

    python3 tests/wifi_test.py
"""
import contextlib, importlib, json, os, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

CURLY = 'Steven\u2019s iPhone'          # what the phone is actually called
MANGLED = 'Steven?s iPhone'             # what an ASCII locale hands over
UU = '11111111-2222-3333-4444-555555555555'
MAC_ON = 'AA:BB:CC:00:00:01'            # the onboard radio
MAC_USB = 'AA:BB:CC:00:00:02'           # the dongle
NM_NO_TARGET = ('Error: Failed to add/activate new connection: '
                '802-11-wireless setting is required if no AP path was given.')
LOG = None

ONBOARD = {'dev': 'wlan0', 'bus': 'onboard', 'mac': MAC_ON,
           'state': '30 (disconnected)', 'con': ''}

# The pretend nmcli. A spec file says what this machine looks like and it
# answers from that - which is the only way to test a radio you are not
# standing next to.
FAKE = r"""#!/usr/bin/env python3
import json, os, sys
spec = json.load(open(os.environ['FAKE_SPEC']))
argv = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write('%s\t%s\n' % (os.environ.get('LC_ALL', ''), ' '.join(argv)))
line = ' '.join(argv)
fields = argv[argv.index('-f') + 1] if '-f' in argv else ''

def show(name):
    return (name.encode('ascii', 'replace').decode()
            if spec.get('mangle') else name)

def emit(s):
    sys.stdout.write(s + '\n')

def die(msg, code=10):
    sys.stderr.write(msg + '\n')
    sys.exit(code)

if 'general' in argv and 'STATE' in fields:
    emit('connected')
elif 'radio' in argv and 'WIFI' in fields:
    emit('enabled')
elif 'device' in argv and 'show' in argv:
    only = argv[-1] if argv[-1] not in ('show',) and '-f' in argv else ''
    for d in spec['devices']:
        if only and d['dev'] != only:
            continue
        emit('GENERAL.DEVICE:' + d['dev'])
        emit('GENERAL.TYPE:wifi')
        emit('GENERAL.STATE:' + d['state'])
        emit('GENERAL.AUTOCONNECT:' + d.get('auto', 'yes'))
        emit('GENERAL.CONNECTION:' + (show(d['con']) or '--'))
        # netd asks for this in the same call, and the remote needs it
        # to know which address to put in the QR.
        if d.get('ip'):
            emit('IP4.ADDRESS[1]:' + d['ip'])
elif 'connection' in argv and 'show' in argv and 'NAME,UUID,TYPE' in fields:
    for c in spec['profiles']:
        emit('%s:%s:802-11-wireless' % (show(c['name']).replace(':', r'\:'),
                                        c['uuid']))
elif 'connection' in argv and 'show' in argv and '802-11-wireless.mode' in fields:
    key = argv[-1]
    for c in spec['profiles']:
        if key in (c['uuid'], show(c['name']), c['name']):
            emit('802-11-wireless.mode:' + ('ap' if c.get('ap') else 'infrastructure'))
            emit('ipv4.method:' + ('shared' if c.get('ap') else 'auto'))
elif 'connection' in argv and 'show' in argv and 'connection.autoconnect' in fields:
    key = argv[-1]
    for c in spec['profiles']:
        if key in (c['uuid'], show(c['name']), c['name']):
            emit('connection.autoconnect:' + c.get('autoconnect', 'no'))
            emit('802-11-wireless.mac-address:' + (c.get('mac') or '--'))
elif 'connection' in argv and 'modify' in argv:
    sys.exit(0)
elif 'connection' in argv and 'delete' in argv and 'uuid' in argv:
    if argv[argv.index('uuid') + 1] in [c['uuid'] for c in spec['profiles']]:
        sys.exit(0)
    die('Error: unknown connection')
elif 'connection' in argv and 'delete' in argv and 'id' in argv:
    die("Error: unknown connection '%s'." % argv[-1])
elif 'device' in argv and 'set' in argv:
    if 'autoconnect' in argv:
        want = argv[argv.index('autoconnect') + 1]
        dev = argv[argv.index('set') + 1]
        for d in spec['devices']:
            # `noset` is a device whose autoconnect write is DROPPED
            # while nmcli still exits 0 - which is what a polkit refusal,
            # or NM busy mid-scan, looks like from here: libnm's setter
            # ignores the return value and gives up after two seconds.
            if d['dev'] == dev and not d.get('noset'):
                d['auto'] = want
        json.dump(spec, open(os.environ['FAKE_SPEC'], 'w'))
    sys.exit(0)
elif 'device' in argv and 'connect' in argv:
    if not spec.get('connectable'):
        die(spec['no_target'], 4)
elif 'device' in argv and 'disconnect' in argv:
    dev = argv[argv.index('disconnect') + 1]
    for d in spec['devices']:
        if d['dev'] == dev and int(d['state'].split()[0]) <= 30:
            die('Error: not active device. This device is not active', 6)
    sys.exit(0)
sys.exit(0)
"""


@contextlib.contextmanager
def rig(profiles, mangle=False, connectable=False, devices=None):
    """netd with a pretend nmcli and a pretend /sys on the PATH.

    `profiles` is a list of (name, uuid) or of dicts for a profile that
    needs more said about it - `ap`, `autoconnect`, `mac`. `devices`
    defaults to one onboard radio; pass your own to add a dongle or to
    make one unmanaged."""
    global LOG
    devices = [dict(ONBOARD)] if devices is None else [dict(d) for d in devices]
    profiles = [p if isinstance(p, dict) else {'name': p[0], 'uuid': p[1]}
                for p in profiles]
    d = tempfile.mkdtemp(prefix='helm-wifi-test-')
    LOG = os.path.join(d, 'calls')
    open(LOG, 'w').close()
    spec = os.path.join(d, 'spec.json')
    # A device marked `hidden` exists in /sys but nmcli never mentions it -
    # which is what a dongle the kernel has and NM has lost looks like.
    with open(spec, 'w') as f:
        json.dump({'profiles': profiles,
                   'devices': [x for x in devices if not x.get('hidden')],
                   'mangle': mangle, 'connectable': connectable,
                   'no_target': NM_NO_TARGET}, f)
    nm = os.path.join(d, 'nmcli')
    with open(nm, 'w') as f:
        f.write(FAKE)
    os.chmod(nm, 0o755)
    # A /sys with those adapters in it: dev_bus() reads the device symlink
    # to tell a dongle from the onboard radio, dev_mac() reads the address.
    for dv in devices:
        n = os.path.join(d, 'sys', 'class', 'net', dv['dev'])
        os.makedirs(n)
        with open(os.path.join(n, 'address'), 'w') as f:
            f.write(dv['mac'] + '\n')
        # What makes a netdev wifi to the kernel, and so to kernel_wifi().
        if dv.get('phy', True):
            os.makedirs(os.path.join(n, 'wireless'))
        bus = os.path.join(d, 'sys', 'bus',
                           'usb' if dv['bus'] == 'usb' else 'sdio', dv['dev'])
        os.makedirs(bus)
        os.symlink(bus, os.path.join(n, 'device'))
    saved = dict(os.environ)
    os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
    os.environ['FAKE_SPEC'] = spec
    os.environ['FAKE_LOG'] = LOG
    os.environ['HELM_SYSFS'] = os.path.join(d, 'sys')
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


class SwitchMeansOn(unittest.TestCase):
    """"I can see the dongle, but I cannot turn it on, it just clicks off
    automatically."

    One field was answering two questions. The SWITCH asks "is this radio
    on"; `up` answered "am I connected", as the substring '(connected)'.
    So a radio that was powered and idle read as OFF: tap the switch,
    netd turns the radio on exactly as asked, the next poll says
    `disconnected`, and the switch flicks itself back. The sheet hides
    the network list behind the same flag, so there was then no way to
    join anything by hand either - the adapter was unreachable from the
    panel entirely.

    The action was fixed in 84d56bd, "the wifi switch turns the radio on;
    it does not join anything". The indicator was left behind, and no
    probe here asserted that a powered idle radio reads as on - only that
    an unmanaged one reads as off. That gap is why it survived.
    """

    IDLE = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
            'state': '30 (disconnected)', 'con': '', 'auto': 'yes'}

    def row(self, netd, dev='wlan1'):
        return [x for x in netd.wifi_devices() if x['dev'] == dev][0]

    def test_a_powered_idle_radio_reads_as_ON(self):
        """The bug itself."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            d = self.row(netd)
        self.assertTrue(d['up'], d)
        self.assertFalse(d['conn'], d)

    def test_a_radio_switched_off_reads_as_OFF(self):
        """The mirror, and the half that makes the fix shippable. Fixing
        the predicate alone would leave a switch that cannot be turned
        off - which on this box is the control that stops the hotspot."""
        off = dict(self.IDLE, auto='no')
        with rig([], devices=[dict(ONBOARD), off]) as netd:
            d = self.row(netd)
        self.assertFalse(d['up'], d)

    def test_off_writes_something_nm_remembers(self):
        """`device disconnect` alone cannot express off: NM refuses it for
        anything at or below `disconnected` - "this device is not active"
        - and records nothing, so switching off an idle radio did nothing
        whatsoever. It only looked like it worked because the tile was
        already dark."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            r = netd.wifi_power('wlan1', False)
            self.assertTrue(r['ok'], r)
            self.assertFalse(self.row(netd)['up'], 'it did not stick')
        argvs = [c[1] for c in calls()]
        self.assertTrue(any('device set wlan1' in a and 'autoconnect no' in a
                            for a in argvs), argvs)

    def test_off_survives_nm_refusing_the_disconnect(self):
        """rc=6 "not active" is not a failure of the switch - there was
        simply no link to drop."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            r = netd.wifi_power('wlan1', False)
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['error'], '')

    def test_off_that_did_not_take_is_reported(self):
        """libnm puts the autoconnect write through a legacy setter whose
        own comment says it "is not cancellable and ignores the return
        value" - it passes NULL for the error and gives up after two
        seconds - so a polkit refusal comes back as success. Read it
        back rather than claim it."""
        stuck = dict(self.IDLE, noset=True)
        with rig([], devices=[dict(ONBOARD), stuck]) as netd:
            r = netd.wifi_power('wlan1', False)
        self.assertFalse(r['ok'], r)
        self.assertEqual(r['error'], 'RADIO WOULD NOT STAY OFF')

    def test_an_assumed_access_point_is_not_read_as_down(self):
        """The substring trap, and the one that could have mattered most.
        NM renders a device it ASSUMED rather than activated as
        "connected (externally)" - which '(connected)' does not match,
        because it needs a close bracket straight after the word. That
        reads the radio carrying SeaWire, and the ssh session, as off."""
        ap = {'dev': 'wlan0', 'bus': 'onboard', 'mac': MAC_ON,
              'state': '100 (connected (externally))', 'con': 'SeaWire'}
        with rig([{'name': 'SeaWire', 'uuid': UU, 'ap': True}],
                 devices=[ap]) as netd:
            d = self.row(netd, 'wlan0')
        self.assertTrue(d['up'], d)
        self.assertTrue(d['conn'], d)
        self.assertTrue(d['ap'], d)
        self.assertEqual(d['state'], 'connected')

    def test_rfkilled_reads_off_however_autoconnect_reads(self):
        """20 is where a wifi device sits under rfkill, and NM gets there
        without touching autoconnect - so a test of `code > 10` would
        report a dead radio as on."""
        blocked = dict(self.IDLE, state='20 (unavailable)', auto='yes')
        with rig([], devices=[dict(ONBOARD), blocked]) as netd:
            d = self.row(netd)
        self.assertFalse(d['up'], d)

    def test_teardown_does_not_flick_the_tile_back_on(self):
        """110 deactivating and 120 failed are >= 100. Reading "in use" as
        `code >= 100` would light the tile during the OFF tap's own
        teardown, which is this bug wearing the other shoe."""
        for st in ('110 (deactivating)', '120 (connection failed)'):
            d = dict(self.IDLE, state=st, auto='no')
            with rig([], devices=[dict(ONBOARD), d]) as netd:
                self.assertFalse(self.row(netd)['up'], st)

    def test_connecting_counts_as_on(self):
        with rig([], devices=[dict(ONBOARD),
                              dict(self.IDLE, state='50 (connecting (configuring))',
                                   auto='no')]) as netd:
            d = self.row(netd)
        self.assertTrue(d['up'], d)
        self.assertFalse(d['conn'], d)
        self.assertEqual(d['state'], 'connecting')

    def test_a_join_clears_an_earlier_off(self):
        """Activating a device clears only NM's INTERNAL autoconnect
        block; the user one survives it. Without this, joining a network
        after switching the radio off leaves a connected adapter still
        flagged no, and the switch snaps off the moment the link drops."""
        with rig([], connectable=True,
                 devices=[dict(ONBOARD), dict(self.IDLE, auto='no')]) as netd:
            netd.wifi_connect('wlan1', 'Marina', 'hunter2')
            self.assertTrue(self.row(netd)['up'], 'the OFF outlived the join')

    def test_signal_is_only_asked_for_when_joined(self):
        """It costs a SCAN, and an unassociated radio has no IN-USE row,
        so the answer is guaranteed to be 0. Under the new predicate `up`
        is true for exactly the idle radios, so leaving the gate on `up`
        would buy a scan per poll per idle dongle - and on an RTL8188EU
        repeated scanning is what makes the next join flaky."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            self.row(netd)
        self.assertFalse([a for _, a in calls() if 'device wifi list' in a],
                         calls())

    def test_a_missing_autoconnect_field_fails_toward_ON(self):
        """An nmcli that does not know a field name fails the WHOLE call
        with empty output, which would blank the panel - access point
        tile and all - looking exactly like NetworkManager being down.
        The fallback field set drops AUTOCONNECT, and what is left has
        to read ON."""
        with rig([], devices=[dict(ONBOARD),
                              {k: v for k, v in self.IDLE.items()
                               if k != 'auto'}]) as netd:
            netd._fields[0] = netd._FIELDS_SAFE      # as the fallback leaves it
            d = self.row(netd)
        self.assertTrue(d['up'], d)

    def test_an_unexpected_autoconnect_value_fails_toward_ON(self):
        """`!= 'no'` and not `== 'yes'`, and the difference is a value
        that is neither - an empty field, a locale that translated it,
        an nmcli that changed its mind. A switch that cannot be turned
        on is a boat with no helm; one that reads on for an idle radio
        is a complaint. Fail toward the complaint."""
        for odd in ('', 'oui', '--'):
            with rig([], devices=[dict(ONBOARD),
                                  dict(self.IDLE, auto=odd)]) as netd:
                self.assertTrue(self.row(netd)['up'], repr(odd))

    def test_the_fallback_does_not_blank_the_panel(self):
        """The failure mode being insured against: wifi_devices() is
        `if rc: return []`, so one unrecognised field name empties the
        list entirely - and an empty list is indistinguishable from
        NetworkManager being down."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            netd._fields[0] = netd._FIELDS_SAFE
            devs = netd.wifi_devices()
        self.assertEqual([d['dev'] for d in devs], ['wlan0', 'wlan1'])

    def test_the_state_label_is_a_word_not_a_fragment(self):
        """It was state.split('(')[-1], which renders the external case as
        the bare word "externally"."""
        with rig([], devices=[dict(ONBOARD), dict(self.IDLE)]) as netd:
            self.assertEqual(self.row(netd)['state'], 'disconnected')
            self.assertEqual(netd.state_name('100 (connected (externally))'),
                             'connected')
            self.assertEqual(netd.state_code('30 (disconnected)'), 30)
            self.assertEqual(netd.state_code('nonsense'), 30)


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


class Unmanaged(unittest.TestCase):
    """A dongle NetworkManager has not adopted.

    That is what a USB adapter looks like when it enumerates after NM has
    started, which is most boots. It used to be filtered out of the list
    entirely - so the panel showed nothing, and "the radio doesn't show
    up at all" was the whole of what you got to work with."""

    DONGLE = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
              'state': '10 (unmanaged)', 'con': ''}

    def test_it_is_on_the_list_at_all(self):
        with rig([], devices=[dict(ONBOARD), dict(self.DONGLE)]) as netd:
            devs = netd.wifi_devices()
        self.assertEqual([d['dev'] for d in devs], ['wlan0', 'wlan1'])

    def test_it_reads_as_down_and_unmanaged(self):
        with rig([], devices=[dict(ONBOARD), dict(self.DONGLE)]) as netd:
            d = [x for x in netd.wifi_devices() if x['dev'] == 'wlan1'][0]
        self.assertFalse(d['up'])
        self.assertFalse(d['managed'])
        self.assertEqual(d['ssid'], '')

    def test_an_adopted_one_still_reads_as_managed(self):
        with rig([], devices=[dict(ONBOARD)]) as netd:
            d = netd.wifi_devices()[0]
        self.assertTrue(d['managed'])

    def test_the_switch_adopts_it(self):
        """The command that takes it over is the one behind the switch,
        which is why hiding the row was the whole problem."""
        with rig([], devices=[dict(ONBOARD), dict(self.DONGLE)]) as netd:
            r = netd.wifi_power('wlan1', True)
        self.assertTrue(r['ok'], r)
        self.assertTrue(any('device set wlan1' in c[1] and 'managed yes' in c[1]
                            for c in calls()), [c[1] for c in calls()])


AP = {'name': 'Seawire', 'uuid': 'ap-uuid-0001', 'ap': True}
DONGLE = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
          'state': '30 (disconnected)', 'con': ''}


def mods():
    return [c[1] for c in calls() if 'connection modify' in c[1]]


class Hotspot(unittest.TestCase):
    """The boat's own hotspot, coming up without being asked.

    It did not: a profile made by `nmcli device wifi hotspot` has
    autoconnect off, so the network everything aboard joins came up only
    when somebody tapped it up on the panel - which is reached over the
    hotspot."""

    def test_autoconnect_is_turned_on(self):
        with rig([dict(AP, autoconnect='no')]) as netd:
            netd.hotspot_pin()
        self.assertEqual(len(mods()), 1, mods())
        self.assertIn('connection.autoconnect yes', mods()[0])

    def test_it_is_pinned_to_the_onboard_radio(self):
        """Not to wlan0, which can swap between boots, and not to the
        dongle, whose job is the opposite one."""
        with rig([dict(AP, autoconnect='no')],
                 devices=[dict(ONBOARD), dict(DONGLE)]) as netd:
            netd.hotspot_pin()
        self.assertIn(MAC_ON, mods()[0])
        self.assertNotIn(MAC_USB, mods()[0])

    def test_a_pin_somebody_set_is_not_moved(self):
        with rig([dict(AP, autoconnect='no', mac=MAC_USB)]) as netd:
            msg = netd.hotspot_pin()
        self.assertNotIn(MAC_ON, mods()[0])
        self.assertIn('left as found', msg)

    def test_nothing_to_do_changes_nothing(self):
        with rig([dict(AP, autoconnect='yes', mac=MAC_ON)]) as netd:
            msg = netd.hotspot_pin()
        self.assertEqual(mods(), [])
        self.assertIn('already', msg)

    def test_it_never_invents_a_hotspot(self):
        with rig([(CURLY, UU)]) as netd:
            msg = netd.hotspot_pin()
        self.assertEqual(mods(), [])
        self.assertIn('no hotspot profile', msg)

    def test_two_hotspots_are_left_alone(self):
        """Picking one would be guessing which network the boat runs on."""
        with rig([dict(AP, autoconnect='no'),
                  dict(AP, name='Seawire 5G', uuid='ap-uuid-0002',
                       autoconnect='no')]) as netd:
            msg = netd.hotspot_pin()
        self.assertEqual(mods(), [])
        self.assertIn('more than one', msg)

    def test_a_client_profile_is_never_touched(self):
        with rig([dict(AP, autoconnect='no'), (CURLY, UU)]) as netd:
            netd.hotspot_pin()
        self.assertEqual(len(mods()), 1, mods())
        self.assertIn('ap-uuid-0001', mods()[0])
        self.assertNotIn(UU, mods()[0])


class Kernel(unittest.TestCase):
    """Telling "not plugged in" from "plugged in and lost".

    From the helm those are the same thing: the row is missing. One is a
    cable or a power budget, the other is the stack above it, and nothing
    on the panel said which."""

    LOST = {'dev': 'wlan1', 'bus': 'usb', 'mac': MAC_USB,
            'state': '30 (disconnected)', 'con': '', 'hidden': True}

    def test_nothing_missing_is_the_normal_case(self):
        with rig([], devices=[dict(ONBOARD)]) as netd:
            self.assertEqual(netd.wifi_status()['unseen'], [])

    def test_an_adapter_nm_never_mentions_is_named(self):
        with rig([], devices=[dict(ONBOARD), dict(self.LOST)]) as netd:
            st = netd.wifi_status()
        self.assertEqual([d['dev'] for d in st['devices']], ['wlan0'])
        self.assertEqual(st['unseen'], ['wlan1'])

    def test_an_unmanaged_one_is_not_called_missing(self):
        """It is on the list, reading as down. That is a different
        problem with a different answer, and conflating them would undo
        the point of this."""
        un = dict(self.LOST, hidden=False, state='10 (unmanaged)')
        with rig([], devices=[dict(ONBOARD), un]) as netd:
            st = netd.wifi_status()
        self.assertEqual(st['unseen'], [])
        self.assertEqual([d['dev'] for d in st['devices']], ['wlan0', 'wlan1'])

    def test_a_netdev_that_is_not_wifi_is_not_counted(self):
        eth = {'dev': 'eth0', 'bus': 'onboard', 'mac': 'AA:BB:CC:00:00:09',
               'state': '100 (connected)', 'con': '', 'hidden': True,
               'phy': False}
        with rig([], devices=[dict(ONBOARD), eth]) as netd:
            self.assertEqual(netd.wifi_status()['unseen'], [])


if __name__ == '__main__':
    unittest.main(verbosity=1)
