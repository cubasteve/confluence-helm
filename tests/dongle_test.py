#!/usr/bin/env python3
"""The rescue for a dongle whose driver will not initialise it.

The boat's RTL8188EU enumerates, binds rtl8xxxu, loads firmware and
then sometimes fails a register write and never makes an interface.
Rebinding runs init afresh and a few goes gets there - measured on the
water, including the part that makes this worth testing: the FIRST
rebind made wlan1 and the adapter still would not come up. A script
that stopped at "an interface exists" would have called that done.

Driven against a pretend /sys and pretend ip/iw on the PATH, because a
script whose job is to yank the boat's network adapter is not one to
ship unexercised.

    python3 tests/dongle_test.py
"""
import os, shutil, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESCUE = os.path.join(ROOT, 'boot', 'dongle-rescue.sh')


class Rig:
    """A pretend /sys with one USB device on it, and pretend ip/iw.

    Two shapes, because the boat produced both. `bound` builds the
    device with one of its interfaces attached to a wifi driver, which
    is the ordinary case. Without it, the device sits there with NO
    driver symlink anywhere - which is what rtl8xxxu leaves behind when
    its init fails, and what the first version of this script walked
    straight past while reporting nothing plugged in.

    `netdev_at` / `up_at` are which bind finally yields an interface and
    which finally yields a usable one. 1 means it was fine all along,
    0 means never.
    """
    VID, PID = '0bda', '8179'                    # the boat's RTL8188EU

    def __init__(self, driver='rtl8xxxu', netdev_at=1, up_at=1,
                 bound=True, vid=None, pid=None, port='1-1.4',
                 with_iw=True, writable=True):
        self.d = tempfile.mkdtemp(prefix='helm-dongle-')
        self.port, self.driver, self.bound = port, driver, bound
        self.dev = os.path.join(self.d, 'bus/usb/devices', port)
        self.iface = self.dev + ':1.0'
        os.makedirs(self.dev); os.makedirs(self.iface)
        for name, val in (('idVendor', vid or self.VID),
                          ('idProduct', pid or self.PID),
                          ('product', '802.11n NIC')):
            with open(os.path.join(self.dev, name), 'w') as f:
                f.write(val + '\n')
        # Every driver the script might write to, including the usb one
        # it uses for a device-level reset.
        for drv in (driver, 'usb'):
            p = os.path.join(self.d, 'bus/usb/drivers', drv)
            os.makedirs(p, exist_ok=True)
            for name in ('bind', 'unbind'):
                open(os.path.join(p, name), 'w').close()
        if bound:
            os.symlink(os.path.join(self.d, 'bus/usb/drivers', driver),
                       os.path.join(self.iface, 'driver'))
        self.state = os.path.join(self.d, 'state')
        with open(self.state, 'w') as f:
            f.write('0 %d %d\n' % (netdev_at, up_at))
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self.iplog = os.path.join(self.d, 'ip-calls')
        open(self.iplog, 'w').close()
        self.with_iw = with_iw
        self._tools()
        if not writable:
            # A directory where the attribute should be. chmod would not
            # do it: these run as root, and root writes a 0444 file
            # quite happily - which is how the first version of this
            # test passed while proving nothing.
            for drv in (driver, 'usb'):
                for name in ('bind', 'unbind'):
                    f = os.path.join(self.d, 'bus/usb/drivers', drv, name)
                    os.remove(f); os.makedirs(f)

    def _tools(self):
        """ip and iw answer from the state file, and `up` only succeeds
        once the pretend device says it is ready."""
        helper = os.path.join(self.bin, '_state.sh')
        with open(helper, 'w') as f:
            f.write('STATE=%s\n' % self.state)
        # ip records every call and does nothing else: the script must
        # never touch link state, and silence in this file is the proof.
        tools = [('ip', 'echo "$@" >> %s\nexit 0\n' % self.iplog)]
        if self.with_iw:
            tools.append(
                ('iw', 'read n netdev_at up_at < "$STATE"\n'
                       '[ "$n" -ge "$up_at" ] && [ "$up_at" != 0 ] && exit 0\n'
                       'exit 1\n'))
        for name, body in tools:
            p = os.path.join(self.bin, name)
            with open(p, 'w') as f:
                f.write('#!/bin/sh\n. %s\n%s' % (helper, body))
            os.chmod(p, 0o755)

    def bump(self):
        """What a real bind does: count it, and make the netdev once the
        device has had enough goes."""
        with open(self.state) as f: n, netdev_at, up_at = f.read().split()
        n = int(n) + 1
        with open(self.state, 'w') as f:
            f.write('%d %s %s\n' % (n, netdev_at, up_at))
        if int(netdev_at) and n >= int(netdev_at):
            os.makedirs(os.path.join(self.iface, 'net', 'wlan1'), exist_ok=True)

    def run(self, tries=4):
        """The script, with this standing in for the kernel: every
        'rebinding' it logs is a bind that happened.

        Driven off the log and not off the bind file, because a sysfs
        attribute is written with `>` - which truncates - so the file
        never accumulates anything to count. That is correct for the
        real kernel and useless as a record."""
        with open(self.state) as f:
            n, netdev_at, up_at = (int(x) for x in f.read().split())
        if netdev_at == 1:
            os.makedirs(os.path.join(self.iface, 'net', 'wlan1'), exist_ok=True)
        if up_at == 1:
            with open(self.state, 'w') as f:
                f.write('1 %d %d\n' % (netdev_at, up_at))
        env = dict(os.environ)
        env['DONGLE_SYSFS'] = self.d
        # Only the pretend tools. Nothing here has a real ip, iw or
        # rfkill, so leaving them off the PATH is how `iw` goes missing.
        env['PATH'] = self.bin + ':/usr/bin:/bin'
        proc = subprocess.Popen(['bash', RESCUE, str(tries), '0'],
                                env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        out, self.rebinds = [], 0
        with proc.stdout as pipe:
            for line in pipe:
                out.append(line)
                if 'rebinding' in line:
                    self.rebinds += 1
                    self.bump()
        proc.wait()
        return ''.join(out), self.rebinds

    def ip_calls(self):
        with open(self.iplog) as f:
            return [l.strip() for l in f if l.strip()]

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Rescue(unittest.TestCase):
    def test_a_working_adapter_is_left_alone(self):
        """The one that matters for running this on a timer: an adapter
        that is up must never be yanked."""
        r = Rig(netdev_at=1, up_at=1)
        try:
            out, _ = r.run()
            self.assertEqual(r.rebinds, 0, out)
            self.assertEqual(r.rebinds, 0, out)
        finally:
            r.close()

    def test_it_rebinds_a_dead_one(self):
        r = Rig(netdev_at=2, up_at=2)
        try:
            out, _ = r.run()
            self.assertGreaterEqual(r.rebinds, 1, out)
            self.assertIn('rebinding', out)
        finally:
            r.close()

    def test_an_interface_that_will_not_come_up_is_not_success(self):
        """The failure measured on the water: wlan1 appeared on the first
        rebind and the adapter still would not come up. Stopping there
        leaves a dead row on the panel."""
        r = Rig(netdev_at=2, up_at=3)
        try:
            out, _ = r.run()
            self.assertGreaterEqual(r.rebinds, 2,
                'stopped as soon as a netdev existed:\n' + out)
            self.assertIn('try 2', out)
        finally:
            r.close()

    def test_it_gives_up_and_says_so(self):
        r = Rig(netdev_at=0, up_at=0)
        try:
            out, _ = r.run(tries=3)
            self.assertIn('past what a rebind can fix', out)
            self.assertEqual(r.rebinds, 2, out)   # tries-1: the last says so
        finally:
            r.close()

    def test_something_that_is_not_wifi_is_not_touched(self):
        """A rebind is a real interruption, so a device that is neither
        on a wifi driver nor a wifi id is left alone - not yanked on the
        off chance."""
        r = Rig(driver='usb_storage', vid='0781', pid='5583',
                netdev_at=0, up_at=0)
        try:
            out, _ = r.run()
            self.assertEqual(r.rebinds, 0, out)
            self.assertIn('no USB wifi adapter found', out)
        finally:
            r.close()

    def test_an_unknown_driver_on_a_known_adapter_is_still_rescued(self):
        """The driver name is one way in, not the only one. A dongle we
        recognise by id is rescued whatever is or is not bound to it."""
        r = Rig(driver='some_out_of_tree_thing', netdev_at=2, up_at=2)
        try:
            out, _ = r.run()
            self.assertGreaterEqual(r.rebinds, 1, out)
        finally:
            r.close()


class Unbound(unittest.TestCase):
    """The case that sent this round the houses.

    rtl8xxxu failed on the boat and left the device with NO driver
    symlink at all. The first version of this script looked only for
    interfaces bound to a known wifi driver, found nothing, and said
    'no USB wifi adapter is plugged in' about a dongle that was plugged
    in. There is nothing to unbind an interface FROM in that state, so
    the whole USB device is reset instead and every driver re-probes."""

    def test_it_is_found_with_no_driver_bound(self):
        r = Rig(bound=False, netdev_at=2, up_at=2)
        try:
            out, _ = r.run()
            self.assertNotIn('no USB wifi adapter', out)
            self.assertIn('no driver bound', out)
            self.assertGreaterEqual(r.rebinds, 1, out)
        finally:
            r.close()

    def test_it_resets_the_device_not_an_interface(self):
        """There is no interface driver to unbind from, so the reset goes
        through the usb driver with the DEVICE name - 1-1.4, not
        1-1.4:1.0."""
        r = Rig(bound=False, netdev_at=2, up_at=2)
        try:
            r.run()
            with open(os.path.join(r.d, 'bus/usb/drivers/usb/unbind')) as f:
                wrote = f.read().strip()
            self.assertEqual(wrote, '1-1.4', 'reset by device name')
        finally:
            r.close()

    def test_an_unplaceable_device_is_named_in_the_log(self):
        """Saying 'nothing plugged in' and stopping is what cost a round
        trip. If nothing matches, the journal lists what IS on the bus so
        it says which id to add."""
        r = Rig(bound=False, vid='1234', pid='abcd', netdev_at=0, up_at=0)
        try:
            out, _ = r.run()
            self.assertEqual(r.rebinds, 0, out)
            self.assertIn('1234:abcd', out)
            self.assertIn('802.11n NIC', out)
            self.assertIn('is_wifi_id', out)
        finally:
            r.close()


class LeavesTheLinkAlone(unittest.TestCase):
    """It used to begin `ip link set DEV up`, which was wrong twice.

    It fought the panel - the helm's switch turns an adapter off on
    purpose, and a five-minute timer put it back up for ever. And it
    called a healthy adapter dead, because `ip link set up` fails with
    "Operation not possible due to RF-kill" whenever the radio is soft
    blocked, which is the Pi OS default until a country is set. rfkill
    is global on this hardware, so one block made every adapter look
    dead and the timer rebound a working dongle seven times every five
    minutes - a machine for turning working into broken."""

    def test_it_never_touches_link_state(self):
        r = Rig(netdev_at=1, up_at=1)
        try:
            out, _ = r.run()
            self.assertEqual(r.ip_calls(), [],
                             'ran ip: ' + ' | '.join(r.ip_calls()) + out)
        finally:
            r.close()

    def test_not_even_while_rescuing(self):
        r = Rig(bound=False, netdev_at=2, up_at=2)
        try:
            out, _ = r.run()
            self.assertGreaterEqual(r.rebinds, 1, out)
            self.assertEqual(r.ip_calls(), [], out)
        finally:
            r.close()


class WithoutIw(unittest.TestCase):
    """No iw, no way to ask the driver anything - and looping on a
    question that cannot be put is the same failure in another coat.
    An interface existing is the weaker test and the honest one."""

    def test_an_existing_interface_is_accepted(self):
        r = Rig(with_iw=False, netdev_at=1, up_at=99)
        try:
            out, _ = r.run()
            self.assertEqual(r.rebinds, 0,
                             'rebound a working adapter with no way to '
                             'check it:\n' + out)
        finally:
            r.close()

    def test_a_missing_interface_is_still_rescued(self):
        r = Rig(with_iw=False, netdev_at=2, up_at=99)
        try:
            out, _ = r.run()
            self.assertGreaterEqual(r.rebinds, 1, out)
        finally:
            r.close()


class TheJournalIsHonest(unittest.TestCase):
    """Every sysfs write was `> file 2>/dev/null` with no test, so a run
    that could not write a thing logged "rebinding (try 1 ... 7)" and
    read exactly like one that was trying. The journal is the only thing
    anybody has to go on out there."""

    def test_a_write_that_fails_says_so(self):
        r = Rig(bound=False, netdev_at=0, up_at=0, writable=False)
        try:
            out, _ = r.run()
            self.assertIn('failed', out)
            self.assertIn('unbind', out)
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
