/*
  What does the panel itself receive? Runs a hidden Chromium on the Pi,
  loads the helm page the way the kiosk does, counts the battery messages
  that arrive on its Signal K socket, opens Energy and reads the screen.
  Three runs, to tell the causes apart:
    A  clean profile,        http://localhost:8080   (the kiosk's address)
    B  clean profile,        http://<this Pi's name>:8080 (a laptop's address)
    C  copy of the kiosk's own profile, localhost    (its cookies and storage)
  It only reads. The copy of the profile is made in /tmp and deleted after.

      node panel-probe.js            # all three
      node panel-probe.js A          # just one
*/
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let WS = globalThis.WebSocket;
if (!WS) {
  const r = execSync('npm root -g').toString().trim();
  WS = require(require.resolve('ws', { paths: [r + '/signalk-server', r + '/signalk-server/node_modules', r] }));
}
const CHROME = process.env.CHROME || ['chromium-browser', 'chromium'].find((c) => {
  try { execSync('command -v ' + c, { stdio: 'ignore', shell: '/bin/bash' }); return true; } catch (e) { return false; } });
const PAGE = process.env.PAGE_PATH || '/user/helm/confluence_helm.html';
const HOST = process.env.LAN_HOST || os.hostname() + '.local';

// Installed before the page's own script: counts what the socket delivers.
const HOOK = `(() => { const W = window.WebSocket;
  window.__probe = { opened: [], msgs: 0, bat: 0, closes: [], errors: 0, firstBat: null, sent: [] };
  function P(u, pr) { const w = pr ? new W(u, pr) : new W(u); __probe.opened.push(String(u));
    const send = w.send.bind(w); w.send = (d) => { __probe.sent.push(String(d).slice(0, 160)); return send(d); };
    w.addEventListener('message', (e) => { __probe.msgs++; const s = String(e.data);
      if (s.indexOf('electrical.batteries') >= 0) { __probe.bat++; if (!__probe.firstBat) __probe.firstBat = s.slice(0, 240); } });
    w.addEventListener('close', (e) => __probe.closes.push(e.code));
    w.addEventListener('error', () => __probe.errors++);
    return w; }
  P.prototype = W.prototype; P.CONNECTING = 0; P.OPEN = 1; P.CLOSING = 2; P.CLOSED = 3;
  window.WebSocket = P; })();`;

const READ = `(async () => {
  const bp = (k) => 'electrical.batteries.house.' + k;
  const out = { href: location.href, host: (typeof CFG !== 'undefined') ? CFG.host : '?',
    windDemo: (typeof CFG !== 'undefined') ? CFG.windDemo : '?',
    socket: (typeof ws !== 'undefined' && ws) ? ['CONNECTING','OPEN','CLOSING','CLOSED'][ws.readyState] : 'none',
    probe: window.__probe,
    stored: (typeof S !== 'undefined') ? Object.keys(S).filter((k) => k.indexOf('batteries') >= 0).length : '?',
    voltage: (typeof get === 'function') ? get(bp('voltage')) : '?',
    voltageAgeMs: (typeof S !== 'undefined' && S[bp('voltage')]) ? Date.now() - S[bp('voltage')].t : null };
  try { openApp(APPS.find((a) => a.id === 'energy')); await new Promise((r) => setTimeout(r, 2500));
    out.energy = { pct: (document.getElementById('en-pct') || {}).textContent, sub: (document.getElementById('en-sub') || {}).textContent };
  } catch (e) { out.energy = 'could not open: ' + e.message; }
  if (out.probe) out.probe.sent = out.probe.sent.length + ' sent, first: ' + (out.probe.sent[0] || '');
  return out; })()`;

async function run(label, url, profile, port) {
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, '--window-size=1080,1080', 'about:blank'];
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  const ch = spawn(CHROME, args, { stdio: 'ignore' });
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      try { page = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).find((t) => t.type === 'page'); }
      catch (e) {}
      if (!page) await sleep(200);
    }
    if (!page) throw new Error('headless Chromium did not start');
    const cdp = new WS(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { cdp.onopen = res; cdp.onerror = () => rej(new Error('devtools socket failed')); });
    let id = 0; const wait = {};
    cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; wait[i] = res; cdp.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await send('Page.navigate', { url });
    await sleep(15000);
    const r = await send('Runtime.evaluate', { expression: READ, awaitPromise: true, returnByValue: true });
    console.log('\n== ' + label + '  ' + url);
    console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : r, null, 1));
    cdp.close();
  } catch (e) { console.log('\n== ' + label + ' FAILED: ' + e.message); }
  finally { ch.kill(); await sleep(800); }
}

(async () => {
  if (!CHROME) { console.log('no chromium found'); process.exit(1); }
  const want = process.argv[2] || 'ABC';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-probe-'));
  try {
    if (want.includes('A')) await run('A clean profile, localhost', 'http://localhost:8080' + PAGE, path.join(tmp, 'a'), 9341);
    if (want.includes('B')) await run('B clean profile, ' + HOST, 'http://' + HOST + ':8080' + PAGE, path.join(tmp, 'b'), 9342);
    if (want.includes('C')) {
      const src = [process.env.KIOSK_PROFILE, path.join(os.homedir(), '.config/chromium'), path.join(os.homedir(), '.config/chromium-browser')]
        .filter(Boolean).find((d) => fs.existsSync(d));
      if (!src) console.log('\n== C skipped: no kiosk profile found');
      else {
        const skip = /(^|\/)(Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|Service Worker|Crashpad|Singleton[^/]*)(\/|$)/;
        fs.cpSync(src, path.join(tmp, 'c'), { recursive: true, filter: (s) => !skip.test(s.slice(src.length)) });
        await run('C kiosk profile copy (' + src + '), localhost', 'http://localhost:8080' + PAGE, path.join(tmp, 'c'), 9343);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(0);
})();
