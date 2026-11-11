#!/usr/bin/env python3
"""The hammer: dongle-fix.sh, run by hand when the timer has given up.

dongle-rescue.sh is deliberately timid - it runs unattended and must
never yank a working adapter. That timidity is exactly what made it
useless in the state reported off the boat ("I do see it, and it will
not turn on"): a half-initialised RTL8188EU answers `iw dev info`
perfectly well, so the timer broke out on try 1 and printed nothing.

This script is the other half. A person has already decided the adapter
is broken, so it escalates until something works. What it must still
never do is cut the branch it is sitting on - the owner is SSHed in over
a hotspot running on the OTHER radio, and a script that takes that down
has done more harm than the dead dongle.

Driven against a pretend /sys with pretend nmcli, modinfo and friends on
the PATH, for the same reason dongle_test.py is.

    python3 tests/donglefix_test.py
"""
import os, shutil, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, 'boot', 'dongle-fix.sh')

# The rung headings, in the order the script tries them. The rig watches
# stdout for these and advances the pretend kernel, which is how a
# "comes good on the third reset" device is modelled.
RUNGS = ['hand it back', 'rebind the interface', 'reset the whole USB device',
         'de-authorise', 'unload and reload']


class Rig:
    """One USB device on a pretend bus, plus whatever else is plugged in.

    nm_states is the sequence NetworkManager reports: the pretend nmcli
    returns nm_states[min(resets, len-1)], so ['unavailable',
    'unavailable', 'disconnected'] is a device that comes good on the
    second reset. A one-element list never changes.
    """
    VID, PID = '0bda', '8179'

    def __init__(self, nm_states=('disconnected',), port='1-1.4',
                 netdev='wlan1', bound='rtl8xxxu', rfkill=None,
                 r8188eu=False, vid=None, pid=None, others=(),
                 with_nmcli=True, dmesg='race'):
        self.d = tempfile.mkdtemp(prefix='helm-fix-')
        self.port, self.netdev = port, netdev
        self.dev = os.path.join(self.d, 'bus/usb/devices', port)
        self.iface = self.dev + ':1.0'
        os.makedirs(self.dev)
        os.makedirs(self.iface)
        self._attrs(self.dev, vid or self.VID, pid or self.PID, '802.11n NIC')
        # Anything else on the bus, to prove the script picks the right one.
        for i, (p, v, pr, name) in enumerate(others):
            o = os.path.join(self.d, 'bus/usb/devices', p)
            os.makedirs(o)
            self._attrs(o, v, pr, name)
        for drv in (bound or 'rtl8xxxu', 'usb'):
            dp = os.path.join(self.d, 'bus/usb/drivers', drv)
            os.makedirs(dp, exist_ok=True)
            for n in ('bind', 'unbind'):
                open(os.path.join(dp, n), 'w').close()
        if bound:
            os.symlink(os.path.join(self.d, 'bus/usb/drivers', bound),
                       os.path.join(self.iface, 'driver'))
        if netdev:
            os.makedirs(os.path.join(self.iface, 'net', netdev))
            nd = os.path.join(self.d, 'class/net', netdev)
            os.makedirs(nd)
            if rfkill is not None:
                rk = os.path.join(nd, 'phy80211/rfkill0')
                os.makedirs(rk)
                for v in ('soft', 'hard'):
                    with open(os.path.join(rk, v), 'w') as f:
                        f.write(('1' if rfkill == v else '0') + '\n')
        self.counter = os.path.join(self.d, 'resets')
        with open(self.counter, 'w') as f:
            f.write('0\n')
        self.states = os.path.join(self.d, 'nm_states')
        with open(self.states, 'w') as f:
            f.write('\n'.join(nm_states) + '\n')
        self.calls = os.path.join(self.d, 'calls')
        open(self.calls, 'w').close()
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        self._tools(r8188eu, with_nmcli, dmesg)

    def _attrs(self, d, vid, pid, product):
        for name, val in (('idVendor', vid), ('idProduct', pid),
                          ('product', product), ('bMaxPower', '500mA'),
                          ('speed', '480'), ('authorized', '1')):
            with open(os.path.join(d, name), 'w') as f:
                f.write(val + '\n')

    # The two kernel logs that mean completely different things, which is
    # the whole reason the script branches. 'race' is a probe that never
    # finished, so there can be no interface; 'ok' is a chip that loaded
    # its firmware, so a reset is cargo cult.
    DMESG = {
        'race': ('rtl8xxxu_writeN: Failed to write block at addr: 1e80 size: 0080\n'
                 'rtl8xxxu: probe of 1-1.4:1.0 failed with error -11'),
        'ok': ('usb 1-1.4: Firmware revision 11.1 (signature 0x88e1)\n'
               'rtl8xxxu 1-1.4:1.0 wlan1: renamed from wlan%d'),
        'silent': 'usb 1-1.4: new high-speed USB device',
    }

    def _tools(self, r8188eu, with_nmcli, dmesg):
        tools = {
            # Every call recorded, so a probe can assert what was NOT run -
            # `nmcli radio` and anything touching brcmfmac would take the
            # hotspot down and lock the owner out.
            'modprobe': 'echo "modprobe $@" >> %s\nexit 0\n' % self.calls,
            'dmesg': 'cat <<\'D\'\n%s\nD\n' % self.DMESG[dmesg],
            'vcgencmd': 'echo throttled=0x0\n',
            'uname': 'echo 6.6.51+rpt-rpi-v8\n',
            'modinfo': ('echo "modinfo $@" >> %s\n'
                        'case "$*" in *r8188eu*) %s;; esac\n'
                        'echo /lib/modules/x/rtl8xxxu.ko\nexit 0\n'
                        % (self.calls,
                           'echo /lib/modules/x/r8188eu.ko; exit 0'
                           if r8188eu else 'exit 1')),
        }
        if with_nmcli:
            tools['nmcli'] = (
                'echo "nmcli $@" >> %s\n'
                'read n < %s\n'
                'tot=$(wc -l < %s); i=$((n+1));'
                ' [ "$i" -gt "$tot" ] && i=$tot\n'
                'st=$(sed -n "${i}p" %s)\n'
                'case "$*" in\n'
                '  *"DEVICE,STATE"*) echo "%s:$st";;\n'
                '  *REASON*) echo "GENERAL.REASON:0 (No reason given)";;\n'
                'esac\nexit 0\n'
                % (self.calls, self.counter, self.states, self.states,
                   self.netdev))
        for name, body in tools.items():
            p = os.path.join(self.bin, name)
            with open(p, 'w') as f:
                f.write('#!/bin/sh\n' + body)
            os.chmod(p, 0o755)

    def run(self, *args, rounds=3, attempts=4):
        env = dict(os.environ)
        env['DONGLE_SYSFS'] = self.d
        # Small but REAL. The rig advances the pretend kernel when it
        # reads a rung heading off the pipe, so the script must pause
        # after printing one or it can ask nmcli before the parent has
        # moved the state along - a probe that passes or fails on who
        # wins a race is not a probe.
        env['DONGLE_SETTLE'] = '0.3'
        env['DONGLE_NAP'] = '0.05'
        env['DONGLE_ROUNDS'] = str(rounds)
        env['DONGLE_ATTEMPTS'] = str(attempts)
        env['PATH'] = self.bin + ':/usr/bin:/bin'
        proc = subprocess.Popen(['bash', FIX] + list(args), env=env,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        out, self.resets = [], 0
        with proc.stdout as pipe:
            for line in pipe:
                out.append(line)
                t = line.strip()
                if t.startswith('->') or t.startswith('try '):
                    # A rung ran. The pretend kernel counts it, which is
                    # what moves nmcli along its state list.
                    self.resets += 1
                    with open(self.counter, 'w') as f:
                        f.write('%d\n' % self.resets)
        proc.wait()
        return ''.join(out), proc.returncode

    def ran(self):
        with open(self.calls) as f:
            return [l.strip() for l in f if l.strip()]

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Fix(unittest.TestCase):

    def test_a_healthy_adapter_is_not_touched(self):
        r = Rig(nm_states=('disconnected',), rfkill='none')
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertEqual(r.resets, 0, out)
            self.assertIn('Nothing here is broken', out)
        finally:
            r.close()

    def test_a_switched_off_radio_is_not_yanked(self):
        """The one that must never regress. netd turns a radio off with
        `device disconnect`, and the global switch rfkills the lot - and
        an earlier version of the TIMER read both as "dead" and rebound
        healthy dongles seven times in five minutes. A hammer that does
        the same thing on demand is worse, not better."""
        for kind in ('soft', 'hard'):
            r = Rig(nm_states=('unavailable',), rfkill=kind)
            try:
                out, rc = r.run()
                self.assertEqual(r.resets, 0, '%s: %s' % (kind, out))
                self.assertEqual(rc, 0, out)
            finally:
                r.close()

    def test_the_reported_state_is_rescued(self):
        """"I do see it. When I try to turn it on, it doesn't turn on."
        An interface exists, iw would answer about it happily, and
        NetworkManager will not use it. The timer walks past this."""
        r = Rig(nm_states=('unavailable', 'unavailable', 'disconnected'),
                rfkill='none')
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertGreaterEqual(r.resets, 2, out)
            self.assertIn('UP.', out)
            self.assertIn('coin flip', out)
        finally:
            r.close()

    def test_a_device_with_no_interface_at_all_is_rescued(self):
        """The other shape rtl8xxxu leaves behind: no netdev, and no
        driver symlink to find the device by either."""
        r = Rig(nm_states=('unavailable',), netdev=None, bound=None)
        try:
            out, rc = r.run()
            self.assertGreaterEqual(r.resets, 1, out)
            self.assertIn('NONE - init never got far enough', out)
            self.assertIn('The probe is what is failing', out)
        finally:
            r.close()

    def test_look_changes_nothing(self):
        r = Rig(nm_states=('unavailable',), rfkill='none')
        try:
            out, rc = r.run('--look')
            self.assertEqual(rc, 0, out)
            self.assertEqual(r.resets, 0, out)
            self.assertIn('nothing was changed', out)
        finally:
            r.close()

    def test_it_never_touches_the_other_radio(self):
        """The hotspot on the internal radio is the session this is being
        typed into. Unloading brcmfmac, or hitting the global `nmcli
        radio` switch, locks the owner out of the boat. Checked on BOTH
        branches, because they run different commands."""
        for log in ('race', 'ok'):
            r = Rig(nm_states=('unavailable',), rfkill='none', dmesg=log)
            try:
                out, _ = r.run(attempts=3)
                for call in r.ran():
                    self.assertNotIn('brcmfmac', call, '%s: %s' % (log, out))
                    self.assertFalse(call.startswith('nmcli radio'), call)
            finally:
                r.close()

    def test_a_failed_probe_is_rolled_again_not_reasoned_with(self):
        """The firmware push is a transient USB EPROTO, so each probe is an
        independent dice roll - upstream's own fix in 6.15 is a six-attempt
        retry loop, and this kernel has not got it. Nothing above the
        driver can help, because there is no driver state to help: probe
        never finished. So the answer is MANY fresh probes, and the
        script must not waste them on nmcli."""
        r = Rig(nm_states=('unavailable', 'unavailable', 'unavailable',
                           'disconnected'),
                rfkill='none', dmesg='race')
        try:
            out, rc = r.run(attempts=8)
            self.assertEqual(rc, 0, out)
            self.assertIn('The probe is what is failing', out)
            self.assertIn('UP', out)
            self.assertTrue(any('modprobe' in c for c in r.ran()) or r.resets >= 3,
                            out)
            self.assertFalse(any('nmcli device set' in c for c in r.ran()),
                             'nmcli cannot help a probe that never ran: %s' % out)
        finally:
            r.close()

    def test_a_loaded_chip_is_not_reset_at_it(self):
        """The other side of probe(). The firmware loaded, so the adapter
        is there and working as far as the driver is concerned - yanking
        the USB device brings it back in exactly the same state. The
        problem is above the driver and so is the remedy."""
        r = Rig(nm_states=('unavailable',), rfkill='none', dmesg='ok')
        try:
            out, rc = r.run(rounds=1)
            self.assertIn('not the reset-it-until-it-works case', out)
            self.assertTrue(any('nmcli device set' in c for c in r.ran()), out)
            self.assertIn('scan-rand-mac-address', out)
            self.assertNotIn('The probe is what is failing', out)
        finally:
            r.close()

    def test_the_mac_randomisation_remedy_is_offered_not_applied(self):
        """A reset is transient; an edit under /etc is not. Which of those
        to make is the owner's call, not a script's - so it prints the
        command and does not run it."""
        r = Rig(nm_states=('unavailable',), rfkill='none', dmesg='ok')
        try:
            out, _ = r.run(rounds=1)
            self.assertIn('80-wifi.conf', out)
            self.assertIn('nmcli general reload conf', out)
            self.assertFalse(any('general reload' in c for c in r.ran()),
                             'it printed it AND ran it: %s' % r.ran())
        finally:
            r.close()

    def test_it_picks_the_wifi_device_off_a_busy_bus(self):
        r = Rig(nm_states=('disconnected',), rfkill='none',
                others=[('1-1.1', '1d6b', '0002', 'xHCI Host Controller'),
                        ('1-1.2', '046d', 'c52b', 'Unifying Receiver'),
                        ('1-1.3', '0403', '6001', 'FT232 USB-Serial')])
        try:
            out, rc = r.run()
            self.assertIn('the dongle is 1-1.4 (0bda:8179)', out)
            self.assertEqual(rc, 0, out)
        finally:
            r.close()

    def test_an_unknown_device_is_named_not_guessed_at(self):
        """A bus with no adapter it recognises must say which ids ARE
        there rather than reporting nothing plugged in - that is how the
        rescue went round the houses the first time."""
        r = Rig(nm_states=('disconnected',), vid='1234', pid='5678')
        try:
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('NO KNOWN WIFI DONGLE', out)
            self.assertIn('1234:5678', out)
            self.assertEqual(r.resets, 0, out)
        finally:
            r.close()

    def test_it_says_whether_the_other_driver_is_even_an_option(self):
        """The decisive no-internet question. Every "just use r8188eu"
        answer on the internet needs a download first, and this box has
        no internet - which is the whole reason the dongle matters."""
        r = Rig(nm_states=('disconnected',), rfkill='none', r8188eu=False)
        try:
            out, _ = r.run()
            self.assertIn('absent, and necessarily so', out)
            self.assertIn('deleted in 6.3', out)
            self.assertIn('not the\n                 consolation prize', out)
        finally:
            r.close()
        r = Rig(nm_states=('disconnected',), rfkill='none', r8188eu=True)
        try:
            out, _ = r.run()
            self.assertIn('PRESENT', out)
        finally:
            r.close()

    def test_it_gives_up_and_says_what_to_do_with_your_hands(self):
        r = Rig(nm_states=('unavailable',), rfkill='none', dmesg='race')
        try:
            out, rc = r.run(attempts=3)
            self.assertEqual(rc, 1, out)
            self.assertIn('different USB port', out)
            self.assertIn('NOT for power', out)
            self.assertIn('6.12', out)
            self.assertNotIn('marginal', out)
            self.assertNotIn('powered hub', out)
        finally:
            r.close()

    def test_without_nmcli_it_does_not_pretend_to_know(self):
        r = Rig(nm_states=('unavailable',), rfkill='none', with_nmcli=False)
        try:
            out, _ = r.run(rounds=1)
            self.assertIn('(no nmcli)', out)
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
