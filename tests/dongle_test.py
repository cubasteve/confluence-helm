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
    """A pretend /sys with one USB interface on it, and pretend ip/iw.

    `comes_up_on` is which rebind finally yields a usable interface:
    1 means it was fine all along, 2 means one rebind, 0 means never.
    """
    def __init__(self, driver='rtl8xxxu', netdev_at=1, up_at=1, port='1-1.4:1.0'):
        self.d = tempfile.mkdtemp(prefix='helm-dongle-')
        self.port, self.driver = port, driver
        self.iface = os.path.join(self.d, 'bus/usb/devices', port)
        os.makedirs(self.iface)
        drv = os.path.join(self.d, 'bus/usb/drivers', driver)
        os.makedirs(drv)
        os.symlink(drv, os.path.join(self.iface, 'driver'))
        self.state = os.path.join(self.d, 'state')
        # binds-so-far, when a netdev appears, when it becomes usable
        with open(self.state, 'w') as f:
            f.write('0 %d %d\n' % (netdev_at, up_at))
        self.log = os.path.join(self.d, 'calls')
        open(self.log, 'w').close()
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        # bind/unbind are files the script writes a port name into; a
        # real driver reacts, so here a helper does.
        for name in ('bind', 'unbind'):
            open(os.path.join(drv, name), 'w').close()
        self._tools()

    def _tools(self):
        """ip and iw answer from the state file, and `up` only succeeds
        once the pretend device says it is ready."""
        helper = os.path.join(self.bin, '_state.sh')
        with open(helper, 'w') as f:
            f.write('STATE=%s\nIFACE=%s\n' % (self.state, self.iface))
        for name, body in (
            ('ip', 'read n netdev_at up_at < "$STATE"\n'
                   'if [ "$1 $2" = "link set" ]; then\n'
                   '  [ "$n" -ge "$up_at" ] && [ "$up_at" != 0 ] && exit 0\n'
                   '  exit 1\nfi\nexit 0\n'),
            ('iw',  'read n netdev_at up_at < "$STATE"\n'
                    '[ "$n" -ge "$up_at" ] && [ "$up_at" != 0 ] && exit 0\n'
                    'exit 1\n')):
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
        env['PATH'] = self.bin + os.pathsep + env['PATH']
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

    def test_a_driver_it_does_not_know_is_not_touched(self):
        """A rebind is a real interruption, so an unknown driver is left
        alone rather than yanked on the off chance."""
        r = Rig(driver='some_nic', netdev_at=0, up_at=0)
        try:
            out, _ = r.run()
            self.assertEqual(r.rebinds, 0, out)
            self.assertIn('no USB wifi adapter', out)
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
