#!/usr/bin/env python3
"""The backlight, and the floor under it.

netd is the only thing that can actually change how much light a panel
puts out - a browser can paint pixels black and the backlight stays lit
behind them. So the brightness slider goes through here.

It is floored at 5% and never 0, because a helm you cannot see is a helm
where you cannot find the slider to turn it back up. A screensaver that
put the display out briefly lifted that floor; it came off again, on the
panel this runs on there is no backlight device to write to at all, and
the display's own power button does the real thing while leaving the Pi
running. The floor is the interesting part and it is what is tested.

These are the first tests this code has had, which is why they stayed
when the thing that prompted them did not.

    python3 tests/backlight_test.py
"""
import importlib, os, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def rig(maxb=255, cur=255, writable=True):
    """netd, imported fresh, pointed at a pretend /sys with one panel."""
    d = tempfile.mkdtemp(prefix='helm-bl-test-')
    bl = os.path.join(d, 'class', 'backlight', 'rpi_backlight')
    os.makedirs(bl)
    with open(os.path.join(bl, 'max_brightness'), 'w') as f:
        f.write(str(maxb))
    p = os.path.join(bl, 'brightness')
    with open(p, 'w') as f:
        f.write(str(cur))
    if not writable:
        os.chmod(p, 0o444)
    os.environ['HELM_SYSFS'] = d
    netd = importlib.reload(importlib.import_module('netd'))
    return netd, p


def raw(path):
    with open(path) as f:
        return int(f.read().strip())


class Floor(unittest.TestCase):
    def test_the_slider_cannot_go_dark(self):
        netd, p = rig()
        netd.backlight_set(0)
        self.assertEqual(netd.backlight_set(0)['pct'], 5)
        self.assertGreater(raw(p), 0, 'a slider at nought still lights')

    def test_nor_by_a_negative(self):
        netd, p = rig()
        self.assertEqual(netd.backlight_set(-40)['pct'], 5)
        self.assertGreater(raw(p), 0)

    def test_and_the_ceiling_holds_too(self):
        netd, p = rig()
        self.assertEqual(netd.backlight_set(140)['pct'], 100)
        self.assertEqual(raw(p), 255)


class Levels(unittest.TestCase):
    def test_a_percentage_is_a_percentage(self):
        netd, p = rig(maxb=100)
        netd.backlight_set(60)
        self.assertEqual(raw(p), 60)

    def test_it_scales_to_whatever_the_panel_counts_in(self):
        netd, p = rig(maxb=1023)
        netd.backlight_set(50)
        self.assertEqual(raw(p), 512)

    def test_a_low_setting_never_rounds_to_off_by_accident(self):
        """5% of a panel that counts to 10 is 0.5, and round() takes that
        to nought - which is the one number the slider must never reach."""
        netd, p = rig(maxb=10)
        netd.backlight_set(5)
        self.assertEqual(raw(p), 1)


class Reported(unittest.TestCase):
    def test_a_panel_that_is_there_and_writable(self):
        netd, _ = rig()
        st = netd.backlight_status()
        self.assertTrue(st['available'])
        self.assertEqual(st['pct'], 100)
        self.assertEqual(st['dev'], 'rpi_backlight')

    @unittest.skipIf(os.geteuid() == 0,
                     'root may write a read-only file, so the mode says '
                     'nothing about what access() will answer')
    def test_readable_but_not_writable_is_not_available(self):
        """A real and confusing state, and the one the udev rules exist to
        prevent: the panel has to know it cannot dim, so it can fall back
        to the veil and say so rather than appearing to do nothing."""
        netd, _ = rig(writable=False)
        self.assertFalse(netd.backlight_status()['available'])

    def test_no_panel_at_all(self):
        d = tempfile.mkdtemp(prefix='helm-bl-none-')
        os.makedirs(os.path.join(d, 'class'))
        os.environ['HELM_SYSFS'] = d
        netd = importlib.reload(importlib.import_module('netd'))
        self.assertFalse(netd.backlight_status()['available'])
        self.assertFalse(netd.backlight_set(50)['ok'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
