/* The hand-over from the panel's old address.

   The panel lived at :8080 (AvNav) and lives at :8090 now, and a browser
   keeps saved data per address, port included - so without a hand-over
   the races, marks and settings saved at :8080 vanish from view. This
   drives both addresses in one browser, with nothing listening on either:
   every request is answered here, so the probe owns both origins.

     * what was saved at the old address arrives at the new one
     * races are added, never replaced, and the page reloads to show them
     * a NEW address takes the old values; one used for a while only has
       its gaps filled - AvNav coming back must not undo new marks
     * nothing from any other origin is taken, and no hand-over page means
       no "done" flag, so it asks again next time
     * the old address sends a person on to the new one                  */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {tally, CHROME} from './helpers.mjs';
const t = tally();
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PANEL = fs.readFileSync(path.join(ROOT, 'confluence_helm.html'), 'utf8');
const NEW = 8095;                       // stands in for :8090
const OLDPAGE = fs.readFileSync(path.join(ROOT, 'boot/old-address.html'), 'utf8')
  .replace(/__PORT__/g, String(NEW));
const b = await pw.chromium.launch({executablePath: CHROME});

async function ctx({exporter = true} = {}) {
  const c = await b.newContext({viewport: {width: 1080, height: 1080}});
  const html = s => ({status: 200, contentType: 'text/html', body: s});
  await c.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname === 'localhost' && u.port === String(NEW)) {
      if (u.pathname === '/confluence_helm.html') return r.fulfill(html(PANEL));
      if (u.pathname === '/blank') return r.fulfill(html('<!doctype html>'));
      return r.fulfill({status: 404, body: ''});
    }
    if (u.hostname === 'localhost' && u.port === '8080') {
      if (u.pathname === '/user/viewer/helm/helm-export.html' && exporter)
        return r.fulfill(html(OLDPAGE));
      if (u.pathname === '/blank') return r.fulfill(html('<!doctype html>'));
      return r.fulfill({status: 404, body: ''});
    }
    return r.abort();                   // Signal K, netd, fonts: not here
  });
  return c;
}
/* Save into one origin the way the panel does: localStorage, and races in
   IndexedDB 'confluence', store 'tracks', keyed by id. */
async function seed(p, port, ls, tracks = []) {
  await p.goto(`http://localhost:${port}/blank`);
  await p.evaluate(async ([ls, tracks]) => {
    for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
    if (!tracks.length) return;
    await new Promise((res, rej) => {
      const r = indexedDB.open('confluence', 3);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        db.createObjectStore('tracks', {keyPath: 'id'}).createIndex('t', 't');
        db.createObjectStore('tilecache', {keyPath: 'k'}).createIndex('t', 't');
      };
      r.onsuccess = e => {
        const db = e.target.result, tx = db.transaction('tracks', 'readwrite');
        tracks.forEach(x => tx.objectStore('tracks').put(x));
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = rej;
      };
      r.onerror = rej;
    });
  }, [ls, tracks]);
}
const state = p => p.evaluate(async () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const tracks = await new Promise(res => {
    const r = indexedDB.open('confluence');
    r.onsuccess = e => { const db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) { db.close(); return res([]); }
      const q = db.transaction('tracks').objectStore('tracks').getAll();
      q.onsuccess = () => { db.close(); res(q.result.map(x => x.id)); }; };
    r.onerror = () => res([]);
  });
  return {ls, tracks};
});
const openPanel = async p => {
  await p.goto(`http://localhost:${NEW}/confluence_helm.html`);
  await p.waitForTimeout(9000);         // the 2.5 s start, the hand-over, the reload
};

t.head('what was saved at the old address arrives at the new one');
{
  const c = await ctx(), p = await c.newPage();
  let reloads = 0;
  p.on('framenavigated', f => { if (f === p.mainFrame()) reloads++; });
  await seed(p, 8080, {marks: '["old mark"]', helmPrefs: '{"theme":"night"}'},
             [{id: 'r1', t: 1, name: 'Saturday race'}, {id: 'r2', t: 2, name: 'Sunday race'}]);
  await seed(p, NEW, {}, [{id: 'r2', t: 2, name: 'already here'}]);
  reloads = 0;
  await openPanel(p);
  const s = await state(p);
  t.ok(s.ls.marks === '["old mark"]', 'the marks', s.ls.marks);
  t.ok(s.ls.helmPrefs === '{"theme":"night"}', 'the settings', s.ls.helmPrefs);
  t.ok(s.tracks.includes('r1') && s.tracks.includes('r2'), 'the races', JSON.stringify(s.tracks));
  t.ok(!!s.ls['helm.moved8080'], 'and it is marked done', s.ls['helm.moved8080']);
  t.ok(reloads >= 2, 'the page reloaded to show them', String(reloads));
  const r2 = await p.evaluate(() => new Promise(res => {
    const r = indexedDB.open('confluence');
    r.onsuccess = e => { const q = e.target.result.transaction('tracks').objectStore('tracks').get('r2');
      q.onsuccess = () => res(q.result && q.result.name); }; }));
  t.ok(r2 === 'already here', 'a race already here is not replaced', r2);
  let asked = 0;
  p.on('request', q => { if (q.url().includes('helm-export')) asked++; });
  await p.reload(); await p.waitForTimeout(4000);
  t.ok(asked === 0, 'and the next load does not ask again', String(asked));
  await c.close();
}

t.head('a panel used here for a while only has its gaps filled');
{
  const c = await ctx(), p = await c.newPage();
  await seed(p, 8080, {marks: '["old mark"]', course: '"old course"'});
  await seed(p, NEW, {marks: '["new mark"]', 'helm.born': String(Date.now() - 3600e3)});
  await openPanel(p);
  const s = await state(p);
  t.ok(s.ls.marks === '["new mark"]', 'marks set here are kept', s.ls.marks);
  t.ok(s.ls.course === '"old course"', 'what was missing is filled in', s.ls.course);
  await c.close();
}

t.head('only the old address is listened to, and silence is not "done"');
{
  const c = await ctx({exporter: false}), p = await c.newPage();
  await seed(p, 8080, {marks: '["old mark"]'});
  await p.goto(`http://localhost:${NEW}/confluence_helm.html`);
  await p.waitForTimeout(3500);
  await p.evaluate(() => window.postMessage(
    {kind: 'helm-export', v: 1, ls: {marks: '["forged"]'}, tracks: []}, '*'));
  await p.waitForTimeout(800);
  const s = await state(p);
  t.ok(s.ls.marks !== '["forged"]', 'a message from this page itself is ignored', s.ls.marks);
  t.ok(!s.ls['helm.moved8080'], 'and with no hand-over page it is not marked done',
       s.ls['helm.moved8080']);
  /* Polled rather than slept: MOVED_WAIT_MS counts from when the panel
     started asking, which under a busy suite is later than it looks. */
  let gone=false;
  for(let i=0;i<40 && !gone;i++){
    gone=await p.evaluate(() => !document.querySelector('iframe[src*="helm-export"]'));
    if(!gone) await p.waitForTimeout(1000);
  }
  t.ok(gone, 'and the hidden frame goes when it gives up');
  await c.close();
}

t.head('a person at the old address is sent on');
{
  const c = await ctx(), p = await c.newPage();
  await p.goto('http://localhost:8080/user/viewer/helm/helm-export.html');
  await p.waitForTimeout(1500);
  t.ok(p.url() === `http://localhost:${NEW}/confluence_helm.html`,
       'to the new port, on the same host', p.url());
  await c.close();
}

await t.done(b);
