#!/usr/bin/env python3
"""Digging deleted marks of your own out of Chromium's old storage.

A mark of your own IS its position - there is nothing underneath it to
go back to, the way a club mark has the book's number under a
correction. markDelete rewrites localStorage['marks'] without it and
that is the end of it as far as the app is concerned.

But LevelDB does not overwrite in place: the old record sits in the
write-ahead log until a compaction gets to it. That window is what this
reads, and the thing it must never do is write to the window it is
reading.

    python3 tests/markrecover_test.py
"""
import json, os, shutil, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(ROOT, 'boot', 'mark-recover.py')

RUM = {"id": "u1abc", "name": "RUM.2", "hdr": "RUM.2", "buoy": "y",
       "lat": 28.835016, "lon": -81.263912}
GOS = {"id": "u1def", "name": "GOSLING.2", "hdr": "GOSLING", "buoy": "y",
       "lat": 28.8307, "lon": -81.252233}


def value(marks):
    """What marksSave() writes: JSON.stringify, which has no spaces."""
    return json.dumps(marks, separators=(',', ':'))


class Rig:
    def __init__(self):
        self.d = tempfile.mkdtemp(prefix='helm-recover-')

    def log(self, name, marks, utf16=False):
        """One LevelDB file with a localStorage record in it. Chromium
        prefixes the value with 0x01 for Latin-1 and 0x00 for UTF-16LE,
        and which you get depends on the characters - so the same key is
        written one way today and the other tomorrow."""
        v = value(marks)
        body = (b'\x00' + v.encode('utf-16-le')) if utf16 \
            else (b'\x01' + v.encode('latin-1'))
        with open(os.path.join(self.d, name), 'wb') as f:
            f.write(b'\x01\x00\x15junk\x00_https://x\x00\x01marks' + body
                    + b'\x00\x00trailing binary\xff\xfe')

    def raw(self, name, data):
        with open(os.path.join(self.d, name), 'wb') as f:
            f.write(data)

    def run(self, path=None):
        p = subprocess.run([sys.executable, '-I', TOOL, path or self.d],
                           capture_output=True, text=True)
        return p.stdout + p.stderr, p.returncode

    def snapshot(self):
        out = {}
        for n in sorted(os.listdir(self.d)):
            with open(os.path.join(self.d, n), 'rb') as f:
                out[n] = f.read()
        return out

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)


class Recover(unittest.TestCase):

    def test_it_finds_a_deleted_mark_in_latin1(self):
        r = Rig()
        try:
            r.log('000003.log', [RUM, GOS])
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('RUM.2', out)
            self.assertIn('GOSLING.2', out)
        finally:
            r.close()

    def test_it_finds_one_in_utf16_too(self):
        """Searching only the obvious encoding finds nothing and says
        "they are gone", which is the worst answer this can give."""
        r = Rig()
        try:
            r.log('000003.log', [RUM], utf16=True)
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('RUM.2', out)
        finally:
            r.close()

    def test_the_same_mark_twice_is_listed_once(self):
        """Every save rewrites the whole array, so a mark that survived
        several saves is in the log several times."""
        r = Rig()
        try:
            r.log('000003.log', [RUM, GOS])
            r.log('000004.log', [RUM, GOS])
            r.log('000005.ldb', [RUM], utf16=True)
            out, _ = r.run()
            self.assertEqual(out.count('name RUM.2'), 1, out)
        finally:
            r.close()

    def test_it_writes_nothing(self):
        """It reads the only copy of something irreplaceable. Writing
        into that directory could trigger the very compaction that
        destroys what is being recovered."""
        r = Rig()
        try:
            r.log('000003.log', [RUM, GOS])
            before = r.snapshot()
            r.run()
            self.assertEqual(r.snapshot(), before)
            self.assertEqual(sorted(os.listdir(r.d)), ['000003.log'])
        finally:
            r.close()

    def test_nothing_found_says_so_honestly(self):
        """And does not leave anyone thinking the club marks went too."""
        r = Rig()
        try:
            r.raw('000003.log', b'\x01\x00nothing of interest here\xff')
            out, rc = r.run()
            self.assertEqual(rc, 1, out)
            self.assertIn('No marks of your own found', out)
            self.assertIn('compaction', out)
            self.assertIn('club marks are untouched', out)
        finally:
            r.close()

    def test_a_missing_directory_says_where_to_look(self):
        r = Rig()
        try:
            out, rc = r.run(os.path.join(r.d, 'nope'))
            self.assertEqual(rc, 1, out)
            self.assertIn('No Chromium storage', out)
            self.assertIn('another user', out)
        finally:
            r.close()

    def test_a_half_written_record_does_not_stop_the_rest(self):
        """A log cut off mid-write is the normal state of a live
        LevelDB, and the tail of it is exactly where the newest - most
        recently deleted - records are."""
        r = Rig()
        try:
            r.raw('000003.log',
                  b'\x01marks\x01' + value([RUM]).encode()
                  + b'\x00\x01marks\x01[{"id":"u9zzz","name":"CUT OFF","lat":28.5')
            out, rc = r.run()
            self.assertEqual(rc, 0, out)
            self.assertIn('RUM.2', out)
            self.assertNotIn('CUT OFF', out)
        finally:
            r.close()

    def test_an_object_with_no_position_is_skipped(self):
        r = Rig()
        try:
            r.log('000003.log', [{"id": "u1xyz", "name": "NO FIX"}, RUM])
            out, _ = r.run()
            self.assertNotIn('NO FIX', out)
            self.assertIn('RUM.2', out)
        finally:
            r.close()

    def test_the_numbers_match_what_the_app_writes(self):
        """Printed two ways on purpose: as the mark sheet shows it, so it
        can be compared with the glass, and as the NEW MARK form wants it
        typed. Both have to be exactly fmtDM and hemDM or the recovery
        puts the buoy somewhere it never was.

            fmtDM = v => (v<0?'-':'') + floor(|v|) + ' ' + ((|v|-floor)*60).toFixed(3)
            hemDM = pad(floor,w) + ' ' + minutes.toFixed(3) + hemisphere
        """
        r = Rig()
        try:
            r.log('000003.log', [RUM])
            out, _ = r.run()
            # 28.835016 -> 28 50.101 ; -81.263912 -> 081 15.835W
            self.assertIn('28 50.101N', out)
            self.assertIn('081 15.835W', out)
            self.assertIn('lat 28 50.101', out)
            self.assertIn('lon -81 15.835', out)       # a minus, as typed
        finally:
            r.close()

    def test_a_southern_or_eastern_mark_keeps_its_sign(self):
        """Not this lake, but the formatter is the app's and must not
        quietly drop a hemisphere."""
        r = Rig()
        try:
            r.log('000003.log', [{"id": "u1s", "name": "SOUTH",
                                  "lat": -33.5, "lon": 151.25}])
            out, _ = r.run()
            self.assertIn('33 30.000S', out)
            self.assertIn('151 15.000E', out)
            self.assertIn('lat -33 30.000', out)
            self.assertIn('lon 151 15.000', out)
        finally:
            r.close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
