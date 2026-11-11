#!/usr/bin/env python3
"""Is NetworkManager randomising a wifi MAC while it scans?

This probe exists to pin down a conclusion that cost a push to find:
Raspberry Pi OS has already disabled scan-time MAC randomisation, in
its own rebuild of network-manager, globally, since the image was
built. Verified against the actual arm64 package rather than docs -
network-manager 1.42.4-1+rpt1+deb12u1 ships
/etc/NetworkManager/NetworkManager.conf as a dpkg conffile with a bare
[device] section setting it to no, and its changelog says exactly that
and nothing else.

Two consequences, and the script is built around both. It was already
off while the dongle was failing, so it cannot have been the cause. And
layering another file on top would be worse than useless: every config
file merges into ONE keyfile group by group, so a second bare [device]
section is a footgun for whoever reads it next, and a conf.d file NM
cannot parse is fatal at STARTUP rather than at reload - no hotspot, no
ssh, at the next power cycle.

So the script writes nothing. These tests mostly check that it tells
the truth about three states, and that it stays read-only.

    python3 tests/wifimac_test.py
"""
import hashlib, os, shutil, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHECK = os.path.join(ROOT, 'boot', 'check-wifi-mac.sh')

# Byte for byte what network-manager 1.42.4-1+rpt1+deb12u1 ships.
STOCK = ('[main]\n'
         'plugins=ifupdown,keyfile\n'
         '\n'
         '[ifupdown]\n'
         'managed=false\n'
         '\n'
         '[device]\n'
         'wifi.scan-rand-mac-address=no\n')


class Rig:
    def __init__(self, conf=STOCK, dropins=None, merged='no', with_nm=True):
        self.d = tempfile.mkdtemp(prefix='helm-wifimac-')
        self.etc = os.path.join(self.d, 'etc/NetworkManager')
        self.lib = os.path.join(self.d, 'usr/lib/NetworkManager/conf.d')
        self.rundir = os.path.join(self.d, 'run/NetworkManager/conf.d')
        for p in (self.etc, self.lib, self.rundir,
                  os.path.join(self.etc, 'conf.d')):
            os.makedirs(p, exist_ok=True)
        if conf is not None:
            with open(os.path.join(self.etc, 'NetworkManager.conf'), 'w') as f:
                f.write(conf)
        for name, body in (dropins or {}).items():
            with open(os.path.join(self.etc, 'conf.d', name), 'w') as f:
                f.write(body)
        self.bin = os.path.join(self.d, 'bin')
        os.makedirs(self.bin)
        if with_nm:
            # --print-config merges every file in precedence order. The
            # pretend one just states the answer the rig was built for.
            line = ('  wifi.scan-rand-mac-address=%s' % merged
                    if merged else '')
            with open(os.path.join(self.bin, 'NetworkManager'), 'w') as f:
                f.write('#!/bin/sh\necho "[device]"\n%s\n'
                        % ('echo "%s"' % line if line else 'true'))
            os.chmod(os.path.join(self.bin, 'NetworkManager'), 0o755)
        self.before = self._snapshot()

    def _snapshot(self):
        out = {}
        for root, _, files in os.walk(self.d):
            if root.startswith(self.bin):
                continue
            for n in files:
                p = os.path.join(root, n)
                with open(p, 'rb') as f:
                    out[p] = hashlib.md5(f.read()).hexdigest()
        return out

    def run(self):
        env = dict(os.environ)
        env['WIFIMAC_ETC'] = self.etc
        env['WIFIMAC_LIB'] = self.lib
        env['WIFIMAC_RUN'] = self.rundir
        env['PATH'] = self.bin + ':/usr/bin:/bin'
        p = subprocess.run(['bash', CHECK], env=env, capture_output=True,
                           text=True)
        return p.stdout + p.stderr, p.returncode

    def unchanged(self):
        return self._snapshot() == self.before

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class WifiMac(unittest.TestCase):

    def test_the_stock_pi_is_recognised_and_left_alone(self):
        """The whole finding: this is already done, so there is nothing
        to apply and nothing this setting could have caused."""
        r = Rig()
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('byte-for-byte the Raspberry Pi OS original', out)
            self.assertIn('Scan randomisation is OFF', out)
            self.assertIn('nothing this setting could have caused', out)
        finally:
            r.close()

    def test_the_stock_md5_in_the_script_is_the_real_one(self):
        """If the constant drifts from the package, the script starts
        telling people their conffile was edited when it was not."""
        want = hashlib.md5(STOCK.encode()).hexdigest()
        with open(CHECK) as f:
            self.assertIn(want, f.read(),
                          'the md5 in check-wifi-mac.sh is not the stock one')

    def test_it_writes_nothing_at_all(self):
        """It replaced a script that DID write, and the reason it no
        longer does is that a conf.d file NetworkManager cannot parse
        stops it starting at the next boot - no hotspot, no ssh, on a
        boat. Read-only is the feature."""
        for rig in (Rig(), Rig(conf=None, merged='yes'),
                    Rig(conf='[main]\nplugins=keyfile\n', merged='yes')):
            try:
                rig.run()
                self.assertTrue(rig.unchanged(),
                                'it modified something under /etc')
            finally:
                rig.close()

    def test_an_edited_conffile_is_reported_but_the_value_decides(self):
        """A conffile is preserved across upgrades, so it can have been
        edited on purpose. Say that it differs; let the merged value say
        whether it matters."""
        edited = STOCK + '\n[logging]\nlevel=INFO\n'
        r = Rig(conf=edited, merged='no')
        try:
            out, rc = r.run()
            self.assertIn('differs from the shipped original', out)
            self.assertIn('Scan randomisation is OFF', out)
            self.assertIn('level=INFO', out, 'it should show what differs')
        finally:
            r.close()

    def test_randomisation_actually_on_gets_the_restore_advice(self):
        r = Rig(conf='[main]\nplugins=keyfile\n', merged='yes')
        try:
            out, rc = r.run()
            self.assertIn('Scan randomisation is ON', out)
            self.assertIn('--reinstall network-manager', out)
            self.assertIn('Never', out)
            self.assertIn('drops the hotspot', out)
        finally:
            r.close()

    def test_absent_from_the_merged_config_counts_as_on(self):
        """NetworkManager's own default is yes, so missing is not
        neutral."""
        r = Rig(conf='[main]\nplugins=keyfile\n', merged=None)
        try:
            out, _ = r.run()
            self.assertIn("default of YES applies", out)
            self.assertIn('Scan randomisation is ON', out)
        finally:
            r.close()

    def test_it_does_not_guess_when_it_cannot_merge(self):
        """Without the binary it cannot see precedence. An answer of "it
        is on" would send someone reinstalling a package over the very
        link that may be at fault."""
        r = Rig(with_nm=False)
        try:
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('cannot', out)
            self.assertIn('Could not determine it', out)
            self.assertNotIn('Scan randomisation is ON', out)
        finally:
            r.close()

    def test_it_finds_a_drop_in_that_sets_it(self):
        r = Rig(dropins={'99-other.conf':
                         '[device]\nwifi.scan-rand-mac-address=yes\n'},
                merged='yes')
        try:
            out, _ = r.run()
            self.assertIn('99-other.conf', out)
            self.assertIn('Scan randomisation is ON', out)
        finally:
            r.close()

    def test_nothing_anywhere_is_reported_as_the_default(self):
        r = Rig(conf='[main]\nplugins=keyfile\n', merged=None)
        try:
            out, _ = r.run()
            self.assertIn("nowhere - which means it is at NetworkManager's "
                          "default of YES", out)
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
