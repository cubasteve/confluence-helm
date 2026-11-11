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
                 print_config_ok=True, with_nmcli=True, reload_fails=False,
                 mac_moves=False, preexisting=None):
        self.d = tempfile.mkdtemp(prefix='helm-wifimac-')
        # `is None`, not `or`: an empty dict is falsy, and a rig with
        # NO radios is exactly the case one of the probes needs.
        self.drivers = ({'wlan0': 'brcmfmac', 'wlan1': 'rtl8xxxu'}
                        if drivers is None else drivers)
        self.macs = ({'wlan0': 'b8:27:eb:11:22:33',
                      'wlan1': 'e8:de:27:0d:f5:58'} if macs is None else macs)
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
        if preexisting is not None:
            os.makedirs(os.path.dirname(self.conf), exist_ok=True)
            with open(self.conf, 'w') as f:
                f.write(preexisting)
        self.calls = os.path.join(self.d, 'calls')
        open(self.calls, 'w').close()
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self.reload_fails = reload_fails
        self.mac_moves = mac_moves
        self._tools(print_config_ok, with_nmcli)

    def _tools(self, print_config_ok, with_nmcli):
        tools = {}
        if with_nmcli:
            cases = '\n'.join(
                "    *'GENERAL.DRIVER device show %s'*) echo 'GENERAL.DRIVER:%s';;"
                % (dev, drv) for dev, drv in self.drivers.items())
            # A reload that moves a MAC, to prove the before/after check
            # is a check and not decoration.
            moved = ('''    *'reload conf'*) printf '%s' > %s/class/net/wlan1/address;;\n'''
                     % ('aa:bb:cc:dd:ee:ff', self.d)) if self.mac_moves else ''
            tools['nmcli'] = (
                'echo "nmcli $@" >> %s\ncase "$*" in\n%s%s\nesac\nexit 0\n'
                % (self.calls, moved, cases))
        # nm_config_reload() logs the failure, keeps the OLD config and
        # returns void - the D-Bus call succeeds regardless. So the
        # journal is the only witness, and the probe needs one.
        tools['journalctl'] = (
            'echo "journalctl $@" >> %s\n%s\n'
            % (self.calls,
               "echo 'Failed to reload the configuration: bad'"
               if self.reload_fails else "echo 'NetworkManager is fine'"))
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

    def test_it_covers_every_radio_and_matches_on_nothing(self):
        """The first version scoped this to the dongle's driver to keep
        the AP at stock behaviour. That is backwards, and NetworkManager's
        own source says why twice over:

        _hw_addr_set_scanning() returns immediately for an activating or
        activated device, so while wlan0 serves SeaWire this setting is a
        no-op for it either way - the "risk" of covering it is not one.
        And if SeaWire ever drops, wlan0 becomes a scanning candidate,
        and NM would take the one radio that must come back down and up
        every five minutes on a driver its own comments flag for MAC-set
        defects (brcmfmac, bgo#770456, rh#1374023).

        A bare [device] section also sidesteps the exact-match trap:
        driver: does not glob, so a scoped file silently does nothing the
        day the adapter comes up on r8188eu instead."""
        r = Rig(drivers={'wlan0': 'brcmfmac', 'wlan1': 'r8188eu'})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            w = r.written()
            self.assertIn('[device]', w)
            self.assertIn('wifi.scan-rand-mac-address=no', w)
            self.assertNotIn('match-device', w)
            self.assertNotIn('r8188eu', w)
        finally:
            r.close()

    def test_it_reports_both_radios_and_which_is_the_dongle(self):
        r = Rig()
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('wlan0  brcmfmac  onboard', out)
            self.assertIn('wlan1  rtl8xxxu  dongle', out)
        finally:
            r.close()

    def test_a_file_that_will_not_parse_is_REMOVED(self):
        """The lockout, and the one thing here that could strand someone
        on a boat. A malformed file in conf.d is not tolerated with a
        warning: nm-config.c read_config() returns FALSE on any key-file
        parse error and main.c then prints "Failed to read configuration"
        and exit(1). So NetworkManager does not start at the next BOOT -
        no hotspot, no ssh. A bad file left on disk is a mine with a
        timer on it, and the first version of this script left it."""
        r = Rig(print_config_ok=False)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIsNone(r.written(), 'it left the file to detonate')
            self.assertIn('REMOVED', out)
            self.assertFalse(any('reload' in c for c in r.ran()),
                             'it reloaded anyway: %s' % r.ran())
        finally:
            r.close()

    def test_a_previous_good_file_is_put_back(self):
        """Removing the bad file is right; restoring the one that was
        working is better. Otherwise a second run of this script turns a
        box that was configured into one that is not, quietly."""
        OLD = '[device]\nwifi.scan-rand-mac-address=no\n# the old one\n'
        r = Rig(print_config_ok=False, preexisting=OLD)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertEqual(r.written(), OLD,
                             'it did not put the working file back')
            self.assertIn('put the previous file back', out)
        finally:
            r.close()

    def test_a_reload_that_failed_is_not_believed(self):
        """nm_config_reload() logs the error, keeps the OLD config and
        returns void - the D-Bus call succeeds anyway. So "the reload
        worked" is not evidence of anything and the journal is the only
        witness."""
        r = Rig(reload_fails=True)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('logged a reload failure', out)
            self.assertIn('Remove the file before rebooting', out)
        finally:
            r.close()

    def test_no_dongle_is_not_a_reason_to_refuse(self):
        """It was, when the file was scoped to the dongle's driver. A
        bare [device] section is about every radio, so it installs with
        the dongle unplugged - which is also when you would want to set
        it, before plugging the thing back in."""
        r = Rig(drivers={'wlan0': 'brcmfmac'}, usb=(),
                macs={'wlan0': 'b8:27:eb:11:22:33'})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('wifi.scan-rand-mac-address=no', r.written())
        finally:
            r.close()

    def test_it_refuses_with_no_wifi_at_all(self):
        r = Rig(drivers={}, usb=(), macs={})
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('no wifi radios at all', out)
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
        """--print-config goes through the same nm_config_setup() path the
        daemon uses, so it fails the same way the daemon would - which is
        the point, because the daemon's way of failing is to not start."""
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

    def test_it_notices_a_mac_moving_across_the_reload(self):
        r = Rig()
        try:
            out, _ = r.run()
            self.assertIn('every radio is on the MAC it had before', out)
        finally:
            r.close()
        r = Rig(mac_moves=True)
        try:
            out, _ = r.run()
            self.assertIn('a MAC changed across the reload', out)
        finally:
            r.close()

    def test_it_does_not_promise_the_mac_reverts(self):
        """The success criterion the first version printed was wrong. At
        scan kickoff _hw_addr_set_scanning() runs with do_reset false, so
        switching randomisation off only stops the next change - the
        adapter keeps whatever random MAC it last had until it next
        activates. Success is the MAC no longer CHANGING, not it going
        back to the one on the label."""
        r = Rig()
        try:
            out, _ = r.run()
            self.assertIn('no longer CHANGING', out)
            self.assertIn('does NOT', out)
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
