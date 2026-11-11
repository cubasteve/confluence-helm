#!/usr/bin/env python3
"""Stopping NetworkManager randomising the dongle's MAC while it scans.

One file under /etc/NetworkManager/conf.d and a config reload. The whole
risk is in the blast radius: wlan0 carries the SeaWire access point and
is the only way onto this boat, so the fix has to land on the dongle and
nowhere else - and it has to fail toward "did nothing" rather than
toward "changed the AP".

Driven against a pretend /sys and a pretend nmcli, because a script that
edits the network config of a boat is not one to ship unexercised.

    python3 tests/wifimac_test.py
"""
import os, shutil, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL = os.path.join(ROOT, 'boot', 'install-wifi-mac.sh')
UNINSTALL = os.path.join(ROOT, 'boot', 'uninstall-wifi-mac.sh')


class Rig:
    """Two radios: an internal one on SDIO carrying the AP, and a USB
    dongle. `drivers` maps interface -> what nmcli reports, which is the
    string the script has to pick up and write.
    """

    def __init__(self, drivers=None, usb=('wlan1',), macs=None,
                 print_config_ok=True, with_nmcli=True):
        self.d = tempfile.mkdtemp(prefix='helm-wifimac-')
        self.drivers = drivers or {'wlan0': 'brcmfmac', 'wlan1': 'rtl8xxxu'}
        self.macs = macs or {'wlan0': 'b8:27:eb:11:22:33',
                             'wlan1': 'e8:de:27:0d:f5:58'}
        self.conf = os.path.join(self.d, 'etc/NetworkManager/conf.d',
                                 '80-confluence-wifi.conf')
        for dev in self.drivers:
            nd = os.path.join(self.d, 'class/net', dev)
            os.makedirs(os.path.join(nd, 'phy80211'))
            with open(os.path.join(nd, 'address'), 'w') as f:
                f.write(self.macs[dev] + '\n')
            # The bus the device hangs off, which is how a dongle is
            # told from the Pi's own SDIO radio - the same test netd
            # uses.
            bus = 'bus/usb/devices/1-1.4' if dev in usb else 'bus/sdio/0001'
            real = os.path.join(self.d, bus)
            os.makedirs(real, exist_ok=True)
            os.symlink(real, os.path.join(nd, 'device'))
        self.calls = os.path.join(self.d, 'calls')
        open(self.calls, 'w').close()
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self._tools(print_config_ok, with_nmcli)

    def _tools(self, print_config_ok, with_nmcli):
        tools = {}
        if with_nmcli:
            cases = '\n'.join(
                "    *'GENERAL.DRIVER device show %s'*) echo 'GENERAL.DRIVER:%s';;"
                % (dev, drv) for dev, drv in self.drivers.items())
            tools['nmcli'] = (
                'echo "nmcli $@" >> %s\ncase "$*" in\n%s\nesac\nexit 0\n'
                % (self.calls, cases))
        # Reads the written file back, the way the real one reads disk.
        tools['NetworkManager'] = (
            'echo "NetworkManager $@" >> %s\n%s\n'
            % (self.calls,
               'cat %s 2>/dev/null' % self.conf if print_config_ok else 'true'))
        # Present so the probe can assert it is NEVER called.
        tools['systemctl'] = 'echo "systemctl $@" >> %s\nexit 0\n' % self.calls
        for name, body in tools.items():
            p = os.path.join(self.bin, name)
            with open(p, 'w') as f:
                f.write('#!/bin/sh\n' + body)
            os.chmod(p, 0o755)

    def run(self, script=INSTALL):
        env = dict(os.environ)
        env['WIFIMAC_SYSFS'] = self.d
        env['WIFIMAC_CONF'] = self.conf
        env['PATH'] = self.bin + ':/usr/bin:/bin'
        p = subprocess.run(['bash', script], env=env, capture_output=True,
                           text=True)
        return p.stdout + p.stderr, p.returncode

    def written(self):
        try:
            with open(self.conf) as f:
                return f.read()
        except OSError:
            return None

    def ran(self):
        with open(self.calls) as f:
            return [l.strip() for l in f if l.strip()]

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class WifiMac(unittest.TestCase):

    def test_it_writes_the_driver_it_read_off_the_box(self):
        """The research said "confirm the DRIVER string by hand, byte for
        byte, before writing the file". That is a step to be skipped at
        2 a.m., and skipping it produces a file that looks applied and
        is not - an unmatched spec is not an error and is not logged.
        So it is not a step: the script reads it and writes what it
        read."""
        r = Rig(drivers={'wlan0': 'brcmfmac', 'wlan1': 'r8188eu'})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('match-device=driver:r8188eu', r.written())
            self.assertNotIn('rtl8xxxu', r.written())
        finally:
            r.close()

    def test_it_scopes_to_the_dongle_and_never_the_ap(self):
        r = Rig()
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            w = r.written()
            self.assertIn('match-device=driver:rtl8xxxu', w)
            self.assertNotIn('brcmfmac', w)
            self.assertIn('leaving wlan0 alone', out)
        finally:
            r.close()

    def test_the_match_line_carries_neither_trap(self):
        """Two ways to widen this onto the AP by accident, both verified
        against NetworkManager 1.42 source: commas in match-device are
        OR and not AND, so a second spec widens rather than narrows; and
        a match-device made only of "except:" specs inverts and matches
        every device there is."""
        r = Rig()
        try:
            r.run()
            line = [l for l in r.written().splitlines()
                    if l.startswith('match-device=')]
            self.assertEqual(len(line), 1, r.written())
            self.assertNotIn(',', line[0])
            self.assertNotIn('except:', line[0])
            self.assertEqual(line[0], 'match-device=driver:rtl8xxxu')
        finally:
            r.close()

    def test_it_refuses_when_both_radios_share_a_driver(self):
        """Scoping by driver only helps if the other radio does not share
        it. If it does, this would quietly change the adapter carrying
        the hotspot - the one outcome worth refusing over."""
        r = Rig(drivers={'wlan0': 'rtl8xxxu', 'wlan1': 'rtl8xxxu'})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('REFUSING', out)
            self.assertIsNone(r.written(), 'it wrote the file anyway')
        finally:
            r.close()

    def test_it_refuses_when_there_is_no_dongle(self):
        r = Rig(drivers={'wlan0': 'brcmfmac'}, usb=(),
                macs={'wlan0': 'b8:27:eb:11:22:33'})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('No USB wifi adapter', out)
            self.assertIsNone(r.written())
        finally:
            r.close()

    def test_it_refuses_an_empty_driver_string(self):
        """A match-device for an empty string matches nothing and looks
        exactly like a fix that worked."""
        r = Rig(drivers={'wlan0': 'brcmfmac', 'wlan1': ''})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('does not report a driver', out)
            self.assertIsNone(r.written())
        finally:
            r.close()

    def test_it_never_restarts_networkmanager(self):
        """The single action here that can drop the access point, and
        therefore the only way onto this boat. Reload, never restart."""
        r = Rig()
        try:
            out, _ = r.run()
            for c in r.ran():
                self.assertFalse(c.startswith('systemctl'), c)
                self.assertNotIn('restart', c)
            self.assertTrue(any(c == 'nmcli general reload conf'
                                for c in r.ran()), r.ran())
        finally:
            r.close()

    def test_it_checks_the_file_parses_before_touching_the_daemon(self):
        """--print-config reads from disk, so it is free and it catches a
        drop-in sorting after 80- that would override this one. If it
        does not come back, the daemon is left alone."""
        r = Rig(print_config_ok=False)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('did not come back from --print-config', out)
            self.assertFalse(any('reload' in c for c in r.ran()),
                             'it reloaded anyway: %s' % r.ran())
        finally:
            r.close()
        r = Rig(print_config_ok=True)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertTrue(any('--print-config' in c for c in r.ran()))
            # and the check must come BEFORE the reload
            seq = [c for c in r.ran()
                   if '--print-config' in c or 'reload conf' in c]
            self.assertIn('--print-config', seq[0], seq)
        finally:
            r.close()

    def test_it_says_the_ap_did_not_move(self):
        r = Rig()
        try:
            out, _ = r.run()
            self.assertIn('wlan0 is still b8:27:eb:11:22:33', out)
        finally:
            r.close()

    def test_running_it_twice_is_the_same_as_once(self):
        r = Rig()
        try:
            r.run()
            first = r.written()
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertEqual(r.written(), first)
        finally:
            r.close()

    def test_the_uninstaller_removes_it_and_reloads(self):
        r = Rig()
        try:
            r.run()
            self.assertIsNotNone(r.written())
            out, rc = r.run(UNINSTALL)
            self.assertEqual(rc, 0, out)
            self.assertIsNone(r.written())
            self.assertTrue(any(c == 'nmcli general reload conf'
                                for c in r.ran()), r.ran())
            # and twice is fine
            out, rc = r.run(UNINSTALL)
            self.assertEqual(rc, 0, out)
            self.assertIn('nothing to remove', out)
        finally:
            r.close()

    def test_it_does_nothing_without_nmcli(self):
        r = Rig(with_nmcli=False)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIsNone(r.written())
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
