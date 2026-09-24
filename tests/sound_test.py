#!/usr/bin/env python3
"""The sounder, both ways round.

netd decides at import which path this Pi has - the 3.5 mm jack or a
buzzer on a GPIO pin - and everything after that depends on the answer.
So each case here imports it again with a different environment and a
PATH full of pretend tools, which is the only way to test a machine you
are not sitting at.

    python3 tests/sound_test.py
"""
import contextlib, importlib, math, os, shutil, struct, sys
import tempfile, time, unittest, wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

LOG = None                      # where the pretend tools write their argv


@contextlib.contextmanager
def rig(tools=(), **env):
    """netd, imported fresh, with `tools` on the PATH as shell scripts
    that log what they were called with."""
    global LOG
    d = tempfile.mkdtemp(prefix='helm-sound-test-')
    LOG = os.path.join(d, 'calls')
    open(LOG, 'w').close()
    for name in tools:
        p = os.path.join(d, name)
        with open(p, 'w') as f:
            f.write('#!/bin/sh\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> '
                    + LOG + '\nexit 0\n')
        os.chmod(p, 0o755)
    old = dict(os.environ)
    os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
    for k, v in env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    sys.modules.pop('netd', None)
    try:
        yield importlib.import_module('netd')
    finally:
        os.environ.clear()
        os.environ.update(old)
        sys.modules.pop('netd', None)
        shutil.rmtree(d, ignore_errors=True)


def calls():
    """What the pretend tools were asked to do - less `aplay -l`, which
    netd runs once at import to find the jack and is not a signal."""
    with open(LOG) as f:
        return [l.strip() for l in f if l.strip() and l.strip() != 'aplay -l']


def settle(fn, secs=3.0):
    """Wait for a thread netd started, rather than guessing at a sleep."""
    end = time.time() + secs
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.02)
    return False


class Mode(unittest.TestCase):
    """Which path it picks, and what it says when there is none."""

    def test_off_is_off(self):
        with rig(HELM_BUZZER_MODE='off') as n:
            self.assertEqual(n.SOUND['mode'], 'off')
            self.assertFalse(n.buzzer_status()['available'])
            self.assertEqual(n.buzzer_status()['why'], 'OFF')

    def test_audio_when_aplay_is_there(self):
        with rig(('aplay',), HELM_BUZZER_MODE='auto') as n:
            self.assertEqual(n.SOUND['mode'], 'audio')
            st = n.buzzer_status()
            self.assertTrue(st['available'])
            self.assertIn('device', st)

    def test_audio_asked_for_and_missing_says_so(self):
        with rig(HELM_BUZZER_MODE='audio') as n:
            self.assertEqual(n.buzzer_status()['why'], 'NO APLAY')

    def test_auto_falls_back_to_the_pin(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='auto') as n:
            self.assertEqual(n.SOUND['mode'], 'gpio')
            self.assertEqual(n.SOUND['gpio'], 17)

    def test_the_jack_wins_when_both_are_there(self):
        # A boat with a buzzer wired AND a speaker plugged in gets the
        # speaker: it is the one somebody chose today.
        with rig(('aplay', 'pinctrl'), HELM_BUZZER_MODE='auto') as n:
            self.assertEqual(n.SOUND['mode'], 'audio')

    def test_gpio_with_no_tool(self):
        with rig(HELM_BUZZER_MODE='gpio') as n:
            self.assertEqual(n.buzzer_status()['why'], 'NO PINCTRL')

    def test_the_pin_can_be_switched_off_by_name(self):
        for v in ('off', 'none', ''):
            with rig(('pinctrl',), HELM_BUZZER_MODE='gpio',
                     HELM_BUZZER_GPIO=v) as n:
                self.assertIsNone(n.BUZZER_GPIO, v)
                self.assertFalse(n.buzzer_status()['available'], v)

    def test_a_pin_that_does_not_exist_is_refused(self):
        for v in ('99', '-3', 'seventeen'):
            with rig(('pinctrl',), HELM_BUZZER_MODE='gpio',
                     HELM_BUZZER_GPIO=v) as n:
                self.assertIsNone(n.BUZZER_GPIO, v)

    def test_an_unknown_mode_is_auto(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='trumpet') as n:
            self.assertEqual(n.SOUND_MODE, 'auto')
            self.assertEqual(n.SOUND['mode'], 'gpio')


class Tone(unittest.TestCase):
    """The sound itself, which nobody can hear from here - so it is
    measured instead."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = rig(('aplay',), HELM_BUZZER_MODE='audio')
        cls.n = cls.ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def freq(self, buf, hz):
        """How much of `hz` is in there, by Goertzel. Relative numbers:
        all that matters is which candidate wins."""
        n = self.n
        mono = buf[0::2]
        k = 2.0 * math.cos(2 * math.pi * hz / n.AUDIO_RATE)
        s1 = s2 = 0.0
        for v in mono:
            s1, s2 = v + k * s1 - s2, s1
        return math.sqrt(max(0.0, s1 * s1 + s2 * s2 - k * s1 * s2)) / len(mono)

    def test_a_beep_is_the_length_it_was_asked_for(self):
        n = self.n
        b = n._frames('warn', 90)
        self.assertEqual(len(b), 2 * int(n.AUDIO_RATE * 0.090))
        self.assertEqual(b[0], b[1], 'the same in both ears')

    def test_the_warning_and_the_gun_are_different_notes(self):
        n = self.n
        warn, gun = n._frames('warn', 120), n._frames('gun', 120)
        self.assertGreater(self.freq(warn, 2500), self.freq(warn, 420))
        self.assertGreater(self.freq(gun, 420), self.freq(gun, 2500))

    def test_it_fades_in_rather_than_starting_on_a_step(self):
        n = self.n
        b = n._frames('warn', 120)
        self.assertLess(abs(b[0]), 200, 'a step into an amp is a click')
        self.assertLess(abs(b[-1]), 200)
        self.assertGreater(max(abs(v) for v in b), 0.8 * n.AUDIO_PEAK,
                           'and reaches full level in the middle')

    def test_nothing_clips(self):
        n = self.n
        for kind in ('warn', 'gun'):
            b = n._frames(kind, 200)
            self.assertLessEqual(max(abs(v) for v in b), n.AUDIO_PEAK + 1, kind)

    def test_the_true_peak_beats_the_easy_answer(self):
        # Dividing by the sum of the weights is the lazy way and throws
        # away several dB. This is the whole reason _peak_of exists.
        n = self.n
        for harm in (h for _, h in n.AUDIO_VOICE.values()):
            self.assertLess(n._peak_of(harm), sum(harm))
            self.assertGreater(n._peak_of(harm), max(harm))

    def test_the_pattern_is_one_file_with_the_gaps_in_it(self):
        n = self.n
        p = n._audio_wav('warn', 90, 3, 120)
        with contextlib.closing(wave.open(p, 'rb')) as w:
            self.assertEqual(w.getnchannels(), 2)
            self.assertEqual(w.getsampwidth(), 2)
            self.assertEqual(w.getframerate(), n.AUDIO_RATE)
            want = int(n.AUDIO_RATE * 0.090) * 3 + int(n.AUDIO_RATE * 0.120) * 2
            self.assertEqual(w.getnframes(), want,
                             'the gaps come off the sample clock')

    def test_a_rendered_pattern_is_kept(self):
        n = self.n
        a = n._audio_wav('gun', 700, 1, 0)
        b = n._audio_wav('gun', 700, 1, 0)
        self.assertEqual(a, b)
        self.assertTrue(os.path.exists(a))

    def test_the_arming_file_makes_no_sound(self):
        n = self.n
        p = n._audio_wav('quiet', 120, 1, 0)
        with contextlib.closing(wave.open(p, 'rb')) as w:
            raw = w.readframes(w.getnframes())
        self.assertEqual(set(struct.unpack('<%dh' % (len(raw) // 2), raw)), {0})

    def test_no_half_written_file_is_ever_played(self):
        n = self.n
        d = n._audio_dir()
        self.assertEqual([f for f in os.listdir(d) if f.endswith('.part')], [])


class Audio(unittest.TestCase):
    """What actually gets handed to aplay."""

    def test_a_beep_plays_the_file_on_the_named_device(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            r = n.buzz(90, 1, 120)
            self.assertTrue(r['ok'])
            self.assertEqual(r['mode'], 'audio')
            self.assertTrue(settle(lambda: calls()))
            c = calls()[0]
            self.assertTrue(c.startswith('aplay '), c)
            self.assertIn('-D', c)
            self.assertIn('.wav', c)

    def test_arming_opens_the_output_without_a_sound(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            r = n.buzz(None, None, None, arm=True)
            self.assertTrue(r['ok'])
            self.assertTrue(r['armed'])
            self.assertTrue(settle(lambda: calls()))
            self.assertIn('quiet-', calls()[0])
            # And again straight away is not another launch: the DAC is
            # already awake and the countdown asks twice.
            self.assertFalse(n.buzz(None, None, None, arm=True)['armed'])

    def test_a_signal_mid_arm_takes_the_output(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            n.buzz(None, None, None, arm=True)
            self.assertTrue(settle(lambda: calls()))
            r = n.buzz(700, 1, 0, kind='gun')
            self.assertTrue(r['ok'], 'a gun is never dropped for a silence')
            self.assertTrue(settle(lambda: len(calls()) >= 2))
            self.assertIsNone(n._snd['arm_proc'])

    def test_arming_a_buzzer_is_a_no_op_rather_than_an_error(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio') as n:
            r = n.buzz(None, None, None, arm=True)
            self.assertTrue(r['ok'])
            self.assertFalse(r['armed'])
            self.assertEqual(r['mode'], 'gpio')


class Gpio(unittest.TestCase):
    """The wire, for the boats that have one."""

    def test_a_beep_is_high_then_low(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio') as n:
            n.buzz(30, 1, 20)
            self.assertTrue(settle(lambda: len(calls()) >= 2))
            time.sleep(0.2)
            c = calls()
            self.assertEqual(c[0], 'pinctrl set 17 op dh')
            self.assertEqual(c[-1], 'pinctrl set 17 op dl',
                             'a pin left high is a buzzer nobody can stop')

    def test_three_beeps_are_three_beeps(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio') as n:
            n.buzz(20, 3, 20)
            self.assertTrue(settle(lambda: len(calls()) >= 6))
            time.sleep(0.2)
            self.assertEqual(sum(1 for c in calls() if c.endswith('dh')), 3)

    def test_an_inverting_board_is_one_environment_variable(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio',
                 HELM_BUZZER_INVERT='yes') as n:
            n.buzz(30, 1, 20)
            self.assertTrue(settle(lambda: len(calls()) >= 2))
            time.sleep(0.2)
            c = calls()
            self.assertEqual(c[0], 'pinctrl set 17 op dl')
            self.assertEqual(c[-1], 'pinctrl set 17 op dh')

    def test_the_pin_is_driven_quiet_at_startup(self):
        # Until something claims a GPIO it floats, and a floating gate is
        # a sounder that may be howling from boot.
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio') as n:
            n.buzz_quiet()
            self.assertEqual(calls(), ['pinctrl set 17 op dl'])

    def test_and_not_on_a_boat_with_no_pin(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            n.buzz_quiet()
            self.assertEqual(calls(), [])

    def test_raspi_gpio_speaks_the_same_words(self):
        with rig(('raspi-gpio',), HELM_BUZZER_MODE='gpio') as n:
            self.assertEqual(n.buzzer_tool(), ['raspi-gpio'])

    def test_another_pin(self):
        with rig(('pinctrl',), HELM_BUZZER_MODE='gpio',
                 HELM_BUZZER_GPIO='4') as n:
            n.buzz_quiet()
            self.assertEqual(calls(), ['pinctrl set 4 op dl'])


class Pattern(unittest.TestCase):
    """What buzz() accepts, and what it refuses to pass on."""

    def setUp(self):
        self.ctx = rig(('aplay',), HELM_BUZZER_MODE='audio')
        self.n = self.ctx.__enter__()

    def tearDown(self):
        self.ctx.__exit__(None, None, None)

    def test_a_ten_second_blast_is_a_bug_and_is_clamped(self):
        r = self.n.buzz(10000, 99, 9999)
        self.assertEqual((r['ms'], r['n']), (2000, 6))

    def test_and_so_is_nothing_at_all(self):
        r = self.n.buzz(0, 0, 0)
        self.assertEqual((r['ms'], r['n']), (10, 1))

    def test_junk_is_refused_rather_than_guessed_at(self):
        r = self.n.buzz('soon', 1, 120)
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'BAD PATTERN')

    def test_a_bare_length_still_sounds_right(self):
        # `curl -d '{"ms":700}'` should sound like a gun, not a warning.
        self.assertEqual(self.n.buzz(700, 1, 0)['kind'], 'gun')
        self.n._snd['busy'] = False
        self.assertEqual(self.n.buzz(90, 1, 0)['kind'], 'warn')

    def test_the_caller_can_name_the_voice(self):
        self.assertEqual(self.n.buzz(700, 1, 0, kind='warn')['kind'], 'warn')

    def test_one_at_a_time(self):
        self.assertTrue(self.n.buzz(2000, 6, 1000)['ok'])
        r = self.n.buzz(90, 1, 120)
        self.assertFalse(r['ok'])
        self.assertEqual(r['error'], 'BUSY')

    def test_and_nothing_at_all_with_no_sounder(self):
        with rig(HELM_BUZZER_MODE='off') as n:
            r = n.buzz(90, 1, 120)
            self.assertFalse(r['ok'])
            self.assertEqual(r['error'], 'NO BUZZER')


class Route(unittest.TestCase):
    """The way the page actually asks."""

    def test_the_page_can_ask_for_a_beep(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            r = n.route('/buzz', {'ms': 90, 'n': 2, 'gap': 120, 'kind': 'warn'})
            self.assertTrue(r['ok'])
            self.assertEqual(r['kind'], 'warn')

    def test_and_status_says_which_path_it_would_take(self):
        with rig(('aplay',), HELM_BUZZER_MODE='audio') as n:
            st = n.route('/status', {})['buzzer']
            self.assertTrue(st['available'])
            self.assertEqual(st['mode'], 'audio')


if __name__ == '__main__':
    unittest.main(verbosity=2)
