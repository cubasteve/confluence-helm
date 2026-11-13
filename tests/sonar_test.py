#!/usr/bin/env python3
"""The sonar reader: Open Echo's frames, and the picture netd makes of
them.

There is no transducer on the machine that runs this, and there never
will be. What there is, is a frame format with no length field, no
timestamp and no sequence number - so everything that could go wrong
goes wrong in arithmetic, and arithmetic is exactly what a probe can
hold. The device end is deliberately the thinnest part of that file:
two functions that read bytes and hand them here.

The ones worth their line count, which is to say the ones that fail
when the code is wrong rather than merely different:

  * the frame is little-endian and the checksum skips the header, so a
    frame built to the project's spec has to come back field for field
  * a squeeze to 256 columns takes the LOUDEST sample in each bucket;
    average them and a real bottom return at one sample in seven comes
    back a seventh as bright, which is to say invisible
  * a resync steps ONE byte past a bad candidate. 0xAA is an ordinary
    loud echo, so stepping a whole frame walks over the true header
    sitting two bytes further in and the stream never recovers

    python3 tests/sonar_test.py
"""
import fcntl, importlib, os, pty, struct, sys, threading, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def load(**env):
    """netd, imported fresh, with HELM_SONAR* set the way a boat would."""
    for k in ('HELM_SONAR', 'HELM_SONAR_SAMPLES', 'HELM_SONAR_BINS',
              'HELM_SONAR_KEEP', 'HELM_SONAR_US', 'HELM_SONAR_C',
              'HELM_SONAR_VTIME', 'HELM_DEV'):
        os.environ.pop(k, None)
    os.environ.update({k: str(v) for k, v in env.items()})
    return importlib.reload(importlib.import_module('netd'))


def frame(samples, idx=0, temp=0.0, vdrv=0):
    """A ping the way the board sends one: little-endian, and the XOR
    over everything after the 0xAA. Built here from the project's spec
    rather than from netd's reader, so the two can disagree."""
    t = int(round(temp * 100)) & 0xFFFF
    body = bytes([idx & 0xFF, (idx >> 8) & 0xFF, t & 0xFF, (t >> 8) & 0xFF,
                  vdrv & 0xFF, (vdrv >> 8) & 0xFF]) + bytes(samples)
    x = 0
    for b in body:
        x ^= b
    return b'\xaa' + body + bytes([x])


class Frames(unittest.TestCase):

    def setUp(self):
        self.n = load()

    def test_round_trip(self):
        # Asymmetric on purpose: 0x0123 read the other way round is
        # 0x2301, so a big-endian reader cannot pass this by accident.
        f = frame([7, 8, 9], idx=0x0123, temp=21.5, vdrv=0x0456)
        p = self.n.sonar_parse(f)
        self.assertIsNotNone(p)
        self.assertEqual(p['idx'], 0x0123)
        self.assertEqual(p['vdrv'], 0x0456)
        self.assertAlmostEqual(p['temp'], 21.5, places=2)
        self.assertEqual(bytes(p['samples']), bytes([7, 8, 9]))

    def test_cold_water(self):
        # i16 and not u16. Lake Monroe does not freeze often, but a
        # board reading -1.5 would otherwise report 654 degrees.
        p = self.n.sonar_parse(frame([1], temp=-1.5))
        self.assertAlmostEqual(p['temp'], -1.5, places=2)

    def test_length_is_samples_plus_eight(self):
        # One header, two idx, two temp, two vdrv, the samples, one sum.
        self.assertEqual(len(frame([0] * 1800)), 1808)

    def test_a_flipped_byte_is_refused(self):
        f = bytearray(frame([5] * 40))
        f[20] ^= 0x01
        self.assertIsNone(self.n.sonar_parse(bytes(f)))

    def test_a_frame_that_does_not_start_with_aa_is_refused(self):
        f = bytearray(frame([5] * 40))
        f[0] = 0xAB
        self.assertIsNone(self.n.sonar_parse(bytes(f)))

    def test_the_parser_does_not_consult_the_configured_length(self):
        # The design claim behind the UDP path: a datagram IS a frame,
        # so its own edge stands in for the length field the format
        # lacks. A parser that checked against NUM_SAMPLES would make
        # that false, and would reject every board flashed with a
        # different build.
        self.assertIsNotNone(self.n.sonar_parse(frame([3] * 97)))
        self.assertEqual(self.n.SONAR_SAMPLES, 1800)


class Squeeze(unittest.TestCase):

    def setUp(self):
        self.n = load()

    def test_the_echo_survives_the_squeeze(self):
        # The one that fails on a mean. 1800 into 256 is seven samples
        # a bucket, so an averaged bottom return comes back at 44 out
        # of 250 - a bottom you cannot see is a sounder you do not
        # have.
        s = bytearray([10] * 1800)
        s[900] = 250
        b = self.n.sonar_bins(s, 256)
        self.assertEqual(len(b), 256)
        self.assertEqual(max(b), 250)

    def test_the_echo_stays_where_it_was(self):
        # Halfway down the column stays halfway down the column. The
        # index arithmetic reads the same forwards and backwards and
        # this is the probe that notices when it is the wrong way up.
        s = bytearray([10] * 1800)
        s[900] = 250
        b = self.n.sonar_bins(s, 256)
        self.assertEqual(b.index(250), 900 * 256 // 1800)

    def test_two_echoes_stay_two(self):
        s = bytearray([0] * 1800)
        s[100], s[1700] = 200, 240
        b = self.n.sonar_bins(s, 256)
        self.assertEqual(b[100 * 256 // 1800], 200)
        self.assertEqual(b[1700 * 256 // 1800], 240)

    def test_nothing_to_squeeze_is_left_alone(self):
        self.assertEqual(self.n.sonar_bins(bytearray([1, 2, 3]), 256),
                         bytes([1, 2, 3]))

    def test_an_empty_ping_squeezes_to_nothing(self):
        self.assertEqual(self.n.sonar_bins(bytearray(), 256), b'')


class Stream(unittest.TestCase):
    """The serial path, where there are no edges to read."""

    def setUp(self):
        self.n = load(HELM_SONAR_SAMPLES=40)

    def test_a_whole_frame_in_one_chunk(self):
        st = {'buf': b''}
        out = self.n.sonar_feed(st, frame([1] * 40, idx=11))
        self.assertEqual([p['idx'] for p in out], [11])
        self.assertEqual(st['buf'], b'')

    def test_a_frame_split_across_two_reads(self):
        f = frame([2] * 40, idx=12)
        st = {'buf': b''}
        self.assertEqual(self.n.sonar_feed(st, f[:17]), [])
        self.assertEqual([p['idx'] for p in self.n.sonar_feed(st, f[17:])], [12])

    def test_leading_rubbish_is_stepped_over(self):
        st = {'buf': b''}
        out = self.n.sonar_feed(st, b'\x00\x01\x02' + frame([3] * 40, idx=13))
        self.assertEqual([p['idx'] for p in out], [13])

    def test_a_false_header_two_bytes_early(self):
        # The resync probe. A loud echo of 0xAA sits two bytes before a
        # real header; stepping a whole frame's worth past the failed
        # candidate walks straight over the real one and the stream
        # never resynchronises.
        st = {'buf': b''}
        out = self.n.sonar_feed(st, b'\xaa\x00' + frame([4] * 40, idx=14))
        self.assertEqual([p['idx'] for p in out], [14])

    def test_a_dropped_byte_costs_one_frame_and_no_more(self):
        # The real loss on this path. USB on a boat browns out when the
        # engine turns over and the stream comes back a byte short;
        # every frame after it is then read at the wrong offset. One
        # ping is the right price. A reader that could not resynchronise
        # would pay every ping until netd was restarted - and the panel
        # would show a frozen picture rather than an empty one, which is
        # the worse of the two failures because it looks like water.
        st = {'buf': b''}
        a, b, c = (frame([i + 1] * 40, idx=i) for i in (1, 2, 3))
        out = self.n.sonar_feed(st, a + b[:20] + b[21:] + c)
        self.assertEqual([p['idx'] for p in out], [1, 3])

    def test_back_to_back_frames(self):
        st = {'buf': b''}
        out = self.n.sonar_feed(st, frame([5] * 40, idx=1) + frame([6] * 40, idx=2))
        self.assertEqual([p['idx'] for p in out], [1, 2])

    def test_rubbish_with_no_candidate_is_not_hoarded(self):
        # Nothing in it can begin a frame, so none of it is kept. A
        # buffer that grew on a board sending noise would be a leak
        # that only showed up after an afternoon on the water.
        st = {'buf': b''}
        self.n.sonar_feed(st, b'\x01\x02\x03' * 4000)
        self.assertEqual(st['buf'], b'')

    def test_a_partial_frame_is_kept_but_bounded(self):
        st = {'buf': b''}
        self.n.sonar_feed(st, b'\xaa' * 4000)
        self.assertLess(len(st['buf']), 48 + 4)      # one frame's worth, no more


class Ring(unittest.TestCase):

    def setUp(self):
        self.n = load(HELM_SONAR='udp:5005', HELM_SONAR_KEEP=5,
                      HELM_SONAR_BINS=4)

    def push(self, k, idx=0):
        for i in range(k):
            self.n._sonar_push(self.n.sonar_parse(frame([9] * 8, idx=idx + i)), 8)

    def test_it_keeps_the_last_few_and_counts_them_all(self):
        self.push(12)
        r = self.n.sonar_read(0)
        self.assertEqual(r['seq'], 12)
        self.assertEqual([p['n'] for p in r['pings']], [8, 9, 10, 11, 12])

    def test_an_asker_gets_only_what_it_has_not_seen(self):
        self.push(12)
        self.assertEqual([p['n'] for p in self.n.sonar_read(10)['pings']], [11, 12])
        self.assertEqual(self.n.sonar_read(12)['pings'], [])

    def test_a_sequence_ahead_of_ours_hands_back_the_ring(self):
        # netd restarted under an open app and the count began again.
        # Answering "nothing new" would leave the waterfall frozen for
        # as long as it took to climb back past where it had been.
        self.push(3)
        self.assertEqual(len(self.n.sonar_read(900)['pings']), 3)

    def test_rubbish_for_a_sequence_is_read_as_the_beginning(self):
        self.push(3)
        self.assertEqual(len(self.n.sonar_read('fish')['pings']), 3)

    def test_the_picture_crosses_as_bytes_and_not_as_numbers(self):
        import base64
        self.push(1)
        p = self.n.sonar_read(0)['pings'][0]
        self.assertEqual(len(base64.b64decode(p['b'])), 4)
        self.assertEqual(p['ns'], 8)

    def test_a_boat_with_no_pings_yet_says_so_without_lying(self):
        r = self.n.sonar_read(0)
        self.assertTrue(r['on'])            # configured
        self.assertEqual(r['pings'], [])
        self.assertIsNone(r['age'])         # and nothing has ever arrived


class Scale(unittest.TestCase):

    def test_a_sample_is_about_a_centimetre(self):
        n = load()
        # 13.2 us there and back through 1500 m/s of water.
        self.assertAlmostEqual(n.sonar_read(0)['mps'], 0.0099, places=5)

    def test_a_default_column_reaches_about_eighteen_metres(self):
        n = load()
        self.assertAlmostEqual(n.sonar_read(0)['mps'] * n.SONAR_SAMPLES,
                               17.82, places=2)

    def test_a_boat_with_no_sounder_says_it_is_off(self):
        n = load()
        self.assertFalse(n.sonar_read(0)['on'])


class Spec(unittest.TestCase):
    """What HELM_SONAR may say. Read here rather than where the socket
    is opened, so a typo in the unit file is something this file can be
    asked about instead of something only a boat could discover."""

    def setUp(self):
        self.n = load()

    def test_udp_on_every_interface(self):
        self.assertEqual(self.n.sonar_spec('udp:5005'),
                         {'kind': 'udp', 'host': '0.0.0.0', 'port': 5005})

    def test_udp_pinned_to_one(self):
        self.assertEqual(self.n.sonar_spec('udp:192.168.8.1:5005'),
                         {'kind': 'udp', 'host': '192.168.8.1', 'port': 5005})

    def test_serial_with_a_baud(self):
        self.assertEqual(self.n.sonar_spec('serial:/dev/ttyACM0:250000'),
                         {'kind': 'serial', 'dev': '/dev/ttyACM0', 'baud': 250000})

    def test_serial_without_one_takes_the_boards_own(self):
        self.assertEqual(self.n.sonar_spec('serial:/dev/ttyACM0')['baud'], 250000)

    def test_what_it_refuses(self):
        for bad in ('', '  ', 'udp', 'udp:', 'udp:no', 'udp:0', 'udp:70000',
                    'serial', 'serial:', 'serial:/dev/x:no', 'tcp:1234',
                    'udp:1:2:3:4'):
            self.assertIsNone(self.n.sonar_spec(bad), bad)


class Wire(unittest.TestCase):
    """The serial path, end to end, over a pty.

    This is the probe that was missing, and the bug it would have
    caught is the only one on this page that mattered. The first
    version of _sonar_serial shelled out to

        stty -F /dev/ttyACM0 raw -echo 250000

    with a comment saying stty could reach a speed termios cannot
    name. It cannot. GNU coreutils maps a speed through its own table
    of Bxxxx constants and refuses anything else before it opens the
    device at all - and Linux names 230400 and then jumps to 460800,
    so 250000 is exactly the gap. The one transport the one board has
    was the one that could not have opened, and nothing here would
    have said so until somebody was standing on a boat.
    """

    def tty(self):
        """A pty, with the slave closed so it is opened by name the way
        a real device is."""
        m, sl = pty.openpty()
        dev = os.ttyname(sl)
        os.close(sl)
        self.addCleanup(lambda: os.close(m))
        return m, dev

    def test_a_speed_termios_cannot_name(self):
        n = load()
        m, dev = self.tty()
        fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        self.addCleanup(lambda: os.close(fd))
        n.sonar_baud(fd, 250000)
        back = struct.unpack(n.TERMIOS2, fcntl.ioctl(
            fd, n.TCGETS2, b'\0' * struct.calcsize(n.TERMIOS2)))
        self.assertEqual(back[6], 250000, 'input speed')
        self.assertEqual(back[7], 250000, 'output speed')
        self.assertEqual(back[2] & n.CBAUD, n.BOTHER,
                         'and reached through BOTHER, not a named constant')

    def test_the_struct_and_the_ioctls_agree(self):
        # The size is encoded in bits 16-29 of the ioctl number itself,
        # so a struct that drifts from it is a silently wrong read.
        n = load()
        for name, num in (('TCGETS2', n.TCGETS2), ('TCSETS2', n.TCSETS2)):
            self.assertEqual((num >> 16) & 0x3FFF, struct.calcsize(n.TERMIOS2),
                             name)

    def test_it_is_raw_and_it_times_out(self):
        n = load()
        m, dev = self.tty()
        fd = os.open(dev, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        self.addCleanup(lambda: os.close(fd))
        n.sonar_baud(fd, 250000)
        import termios as T
        i, o, c, l, _line, cc, _, _ = struct.unpack(n.TERMIOS2, fcntl.ioctl(
            fd, n.TCGETS2, b'\0' * struct.calcsize(n.TERMIOS2)))
        self.assertEqual((i, o, l), (0, 0, 0),
                         'nothing translated, nothing echoed, no line discipline')
        self.assertTrue(c & T.CS8 and c & T.CREAD and c & T.CLOCAL)
        self.assertFalse(c & T.PARENB or c & T.CSTOPB)
        self.assertEqual(cc[T.VMIN], 0)
        self.assertEqual(cc[T.VTIME], n.SONAR_VTIME, 'a read that comes back')

    def test_frames_off_a_real_wire(self):
        # Samples chosen to be the bytes a line discipline EATS: 0x0A
        # and 0x0D are what ONLCR and ICRNL rewrite, 0x11 and 0x13 are
        # XON and XOFF and vanish under IXON. A reader that forgot raw
        # mode decodes none of these frames, and the checksum is what
        # says so. 0xAA is in there too, so the resync has a false
        # header to walk past.
        n = load(HELM_SONAR_SAMPLES=40, HELM_SONAR_BINS=8, HELM_SONAR_VTIME=1)
        m, dev = self.tty()
        err = []

        def read():
            try:
                n._sonar_serial(dev, 250000)
            except Exception as e:      # noqa: BLE001 - it is the assertion
                err.append(e)

        th = threading.Thread(target=read, daemon=True)
        th.start()
        time.sleep(0.4)                       # opened and configured
        nasty = [0x0A, 0x0D, 0x11, 0x13, 0xAA, 0x00, 0xFF, 0x1A] * 5
        for k in (1, 2, 3):
            os.write(m, frame(nasty, idx=k))
        time.sleep(0.5)
        got = n.sonar_read(0)
        self.assertEqual([p['idx'] for p in got['pings']], [1, 2, 3],
                         'three frames in, three frames out')
        self.assertEqual(got['bad'], 0)
        # And then the board stops talking, which is a thing boats do.
        th.join(4)
        self.assertFalse(th.is_alive(),
                         'the reader gives up on a device that has gone quiet')
        self.assertTrue(err and 'went quiet' in str(err[0]), str(err))


class Missing(unittest.TestCase):
    """The device that is not where the config says.

    Which name a board takes belongs to its USB-serial bridge, not to
    the board: a CH340 or CP2102 is ttyUSB0 and an ATmega16U2 is
    ttyACM0. A config carried from one Pi to the next is wrong half
    the time, and "no such file" is a dead end at a chart table.
    """

    def dev(self, *names):
        import tempfile
        d = tempfile.mkdtemp(prefix='helm-tty-')
        for n in names:
            open(os.path.join(d, n), 'w').close()
        return d

    def test_it_names_what_is_actually_there(self):
        d = self.dev('ttyUSB0', 'ttyACM0', 'null', 'sda1')
        n = load(HELM_DEV=d)
        self.assertEqual([os.path.basename(x) for x in n.sonar_ttys()],
                         ['ttyACM0', 'ttyUSB0'])

    def test_the_error_hands_you_the_answer(self):
        d = self.dev('ttyUSB0')
        n = load(HELM_DEV=d)
        with self.assertRaises(OSError) as e:
            n._sonar_serial(os.path.join(d, 'ttyACM0'), 250000)
        self.assertIn('ttyUSB0', str(e.exception),
                      'the one it HAS, not just the one it wants')

    def test_and_says_so_plainly_when_there_is_nothing(self):
        d = self.dev()
        n = load(HELM_DEV=d)
        with self.assertRaises(OSError) as e:
            n._sonar_serial(os.path.join(d, 'ttyUSB0'), 250000)
        self.assertIn('neither is any other', str(e.exception))

    def test_a_missing_device_does_not_kill_the_supervisor(self):
        # sonar_run swallows it into the status and tries again, so a
        # board plugged in after netd started still comes up.
        d = self.dev()
        n = load(HELM_DEV=d, HELM_SONAR='serial:%s/ttyUSB0' % d)
        n._sonar['err'] = ''
        try:
            n._sonar_serial(os.path.join(d, 'ttyUSB0'), 250000)
        except OSError as e:
            n._sonar['err'] = str(e)[:120]
        self.assertIn('not there', n.sonar_read(0)['error'])
        self.assertTrue(n.sonar_read(0)['on'])


class Door(unittest.TestCase):

    def setUp(self):
        self.n = load(HELM_SONAR='udp:5005')

    def test_the_route_answers(self):
        self.n._sonar_push(self.n.sonar_parse(frame([9] * 8, idx=3)), 8)
        r = self.n.route('/sonar', {'after': 0})
        self.assertTrue(r['ok'])
        self.assertEqual(len(r['pings']), 1)

    def test_no_after_is_the_beginning(self):
        self.n._sonar_push(self.n.sonar_parse(frame([9] * 8)), 8)
        self.assertEqual(len(self.n.route('/sonar', {})['pings']), 1)

    def test_it_is_post_only(self):
        # GET_OK is an allowlist exactly so that a route added later is
        # POST-only until somebody decides otherwise. This is that
        # decision, written down where it can fail.
        self.assertNotIn('/sonar', self.n.GET_OK)

    def test_it_changes_nothing_so_it_busts_no_cache(self):
        self.assertNotIn('/sonar', self.n.MUTATING)


if __name__ == '__main__':
    unittest.main(verbosity=1)
