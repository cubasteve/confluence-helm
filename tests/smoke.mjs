/* A floor under the app: it boots clean, the surfaces open, and the
   things that cost you a race still work. Not a substitute for the
   per-feature probes - a net for the day one of them is missing. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const URL=process.env.HELM_URL||'http://localhost:8080/confluence_helm.html';
const b=await pw.chromium.launch({executablePath:process.env.HELM_CHROME
  ||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:1080,height:1080},
  geolocation:{latitude:28.8172,longitude:-81.2695,accuracy:5}, permissions:['geolocation']});
const p=await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.addInitScript(()=>Object.defineProperty(navigator,'maxTouchPoints',{get:()=>10}));
await p.route('**/signalk/**',r=>r.abort());
await p.route('http://127.0.0.1:8091/**',r=>r.abort('connectionrefused'));
await p.route('https://vuduwave.com/**',r=>r.fulfill({status:200,
  contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
  body:'{"message":"Time added"}'}));
await p.goto(URL);
await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle()); await p.waitForTimeout(1400);
let pass=0,fail=0; const ok=(c,m,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+m+(x?'   '+x:''));c?pass++:fail++;};
const fling=async(n,dx,dy,sx=480,sy=540)=>{
  await p.evaluate(([n,dx,dy,sx,sy])=>{
    const st=document.getElementById('stage'), box=st.getBoundingClientRect();
    sx+=box.x; sy+=box.y;
    const ev=(t,id,x,y)=>st.dispatchEvent(new PointerEvent(t,
      {pointerId:id,clientX:x,clientY:y,bubbles:true,pointerType:'touch'}));
    const ids=[...Array(n).keys()].map(i=>i+1);
    ids.forEach((id,i)=>ev('pointerdown',id,sx+i*36,sy));
    ids.forEach((id,i)=>ev('pointermove',id,sx+i*36+dx,sy+dy));
    ids.forEach((id,i)=>ev('pointerup',id,sx+i*36+dx,sy+dy));
  },[n,dx,dy,sx,sy]); await p.waitForTimeout(650); };

console.log('\n=== it comes up ===');
ok(!(await p.evaluate(()=>$('stage').classList.contains('booting'))), 'past the splash');
ok(!errs.length, 'with nothing thrown', errs.join(' | '));
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); demoSet(true); });
await p.waitForTimeout(1200);
ok(/\d/.test(await p.evaluate(()=>$('spd').textContent)), 'and a number on the face',
   await p.evaluate(()=>$('spd').textContent));

console.log('\n=== the surfaces open ===');
await fling(1,0,260);  ok(await p.evaluate(()=>panel.classList.contains('open')), 'control panel');
await fling(1,0,-260); ok(!(await p.evaluate(()=>panel.classList.contains('open'))), 'and closes');
await fling(1,0,-260); ok(await p.evaluate(()=>apps.classList.contains('open')), 'app dock');
await fling(1,0,240,480,980);
await fling(3,-260,0); ok((await p.evaluate(()=>PAGE_I))===2, 'the music page');
await fling(3,260,0);  ok((await p.evaluate(()=>PAGE_I))===1, 'and back');
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks'))); await p.waitForTimeout(800);
ok(await p.evaluate(()=>tmap.classList.contains('open')), 'the track map');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(400);
await p.evaluate(()=>openCourse()); await p.waitForTimeout(700);
const rows=await p.$$eval('#course-list .cv-tile',n=>n.length);
ok(rows>=10, 'the course sheet, with every mark on it', String(rows));
await p.evaluate(()=>{ courseEdit=true; renderCourse(); });
ok(/\d+ \d+\.\d+N · \d+ \d+\.\d+W/.test(
   await p.$eval('.cv-tile[data-mark="cb12"] s',e=>e.textContent)),
   'each reading its position back');
await p.evaluate(()=>{ courseEdit=false; renderCourse(); });
/* The way out of an app is a cross on a disc, not the word CLOSE: the
   foot of a circle is the narrowest place there is to spend 190 px of
   type on what the shape already says. */
const X=await p.evaluate(()=>{ const e=$('app-close'), r=e.getBoundingClientRect();
  return {svg:!!e.querySelector('svg'), txt:e.textContent.trim(),
          w:Math.round(r.width), h:Math.round(r.height),
          foot:Math.round(1080-r.bottom)}; });
ok(X.svg && X.txt==='', 'a cross, with no word left on it', JSON.stringify(X));
ok(X.w===76 && X.h===76, 'round, and the height the pill was', X.w+'x'+X.h);
ok(X.foot===38, 'in the same place, so nothing above it moves', String(X.foot));
/* It goes back one step where there is one: the mark form is in front
   of the course, so the first tap takes that and the second the app. */
await p.evaluate(()=>mkOpen()); await p.waitForTimeout(300);
await p.click('#app-close'); await p.waitForTimeout(500);
ok(await p.evaluate(()=>getComputedStyle($('course-add')).display)==='none'
   && await p.evaluate(()=>$('app-run').classList.contains('on')),
   'one tap puts the form away and leaves the app up');
await p.click('#app-close'); await p.waitForTimeout(600);
ok(!await p.evaluate(()=>$('app-run').classList.contains('on')),
   'and the next shuts the app');
await p.evaluate(()=>{ closeLib(); closeApp(); }); await p.waitForTimeout(500);

console.log('\n=== the race runs ===');
const race=await p.evaluate(async ()=>{
  /* A real fix under it. The demo is on - it is on by default - and a
     race an invented boat sailed is one the card will not offer to
     send, which is its own probe in tests/score.mjs. */
  feedPut('pos.lat', 28.8190, 'sk'); feedPut('pos.lon', -81.2650, 'sk');
  startCountdown(); const a=tState;
  tEnd=rnow()+1200; await new Promise(r=>setTimeout(r,2200));
  const b=tState;
  tGun=rnow()-2895000; finishRace();
  return {a, b, fin:tState, card:$('score').classList.contains('on')};
});
ok(race.a==='countdown', 'the countdown starts');
ok(race.b==='racing', 'the gun fires by itself');
ok(race.fin==='finished' && race.card, 'and the finish raises the score card');
await p.click('#sc-no'); await p.waitForTimeout(400);
ok((await p.evaluate(()=>$('sc-big').textContent))==='0.48.15',
   'with the elapsed time in the scorer\'s format',
   await p.evaluate(()=>$('sc-big').textContent));
await p.evaluate(()=>{ scoreHide(); resetAll(); });

console.log('\n=== and the feed is honest ===');
/* There were two feeds that wrote without measuring - the demo sail and
   a phone's own GPS - and this checked that neither invented anything it
   could not know. Phone mode has gone; the demo is the one that is left,
   and it is still held to it. */
await p.evaluate(()=>{ demoSet(false); demoSet(true,'smoke'); });
await p.waitForTimeout(1000);
const feed=await p.evaluate(()=>({pos:get('pos.lat'),
  wind:get('environment.wind.speedTrue'),
  dpt:get('environment.depth.belowTransducer')}));
ok(feed.pos!==null, 'the demo sail has a position', String(feed.pos));
ok(feed.wind!==null && feed.dpt!==null,
   'and the wind and the depth it is simulating', JSON.stringify(feed));
await p.evaluate(()=>demoSet(false,'smoke'));

console.log('\n=== the hull number sits where it was put ===');
/* The watermark is two pinned glyphs rather than one centred run,
   because the 5 is dropped 14 px to read level with the 4: Poppins draws
   its top bar that much higher than the flat top of the 4's stem, at
   every weight the panel installs.

   The invariant is "the split draws each glyph where the centred run
   would have". So the probe puts the centred run BACK and asks it,
   rather than carrying two numbers off a measurement - the pen
   positions move with the face (the 4's lands at -294 in Poppins and
   -167 in DejaVu), and a number carried here is the kind of thing that
   passes on the panel and is wrong everywhere else.

   The reference has to BE this element. The size, the weight and the
   letter-spacing all come off the #mark selector, so a clone with its
   id stripped lays out at a 16 px default and agrees with nothing -
   which is how an earlier version of this probe came to compare 1320 px
   positions against 479,488.

   getStartPositionOfChar, not getBBox. The bbox x is where the INK
   starts, which is inside the advance; pinning the pen there moved the 4
   by 230,000 pixels of a rendered diff, which is how that mistake was
   found. */
const wm=await p.evaluate(async ()=>{
  const t=document.getElementById('mark');
  const sp=[...t.querySelectorAll('tspan')];
  const o={n:sp.length, txt:t.textContent,
           hasX:sp.every(e=>e.hasAttribute('x')),
           pen:[0,1].map(i=>+t.getStartPositionOfChar(i).x.toFixed(1)),
           drop:+(t.getStartPositionOfChar(1).y
                 -t.getStartPositionOfChar(0).y).toFixed(1)};
  const html=t.innerHTML;
  t.setAttribute('x','488'); t.setAttribute('text-anchor','middle');
  t.textContent='45';
  o.want=[0,1].map(i=>+t.getStartPositionOfChar(i).x.toFixed(1));
  t.removeAttribute('x'); t.removeAttribute('text-anchor');
  t.innerHTML=html;
  o.src=(await (await fetch(location.href)).text())
          .split('\n').find(l=>l.includes('<text id="mark"'))||'';
  return o;
});
ok(wm.n===2 && wm.txt==='45', 'two glyphs, still reading 45',
   wm.n+' / '+wm.txt);
ok(wm.hasX, 'each pinned with its own x, so letter-spacing cannot drift '
   +'them apart the way it did when they were tspans in a flow');
ok(Math.abs(wm.pen[0]-wm.want[0])<0.5 && Math.abs(wm.pen[1]-wm.want[1])<0.5,
   'and each sits exactly where the centred run would have drawn it',
   wm.pen.join(',')+' vs '+wm.want.join(','));
ok(wm.drop===14, 'with the 5 dropped 14 px, which is measured off the '
   +'rendered glass and not off measureText - that reports the same ink '
   +'ascent for both digits and is wrong by 14', wm.drop+' px');
/* And the file itself holds no pen position. The pair above would still
   agree on a machine with Poppins if someone wrote the Poppins numbers
   into the markup, so the thing that makes them portable is checked
   directly: the markup is the centred run, and markSplit() does the
   rest. */
ok(!/tspan/.test(wm.src) && /text-anchor="middle"/.test(wm.src),
   'with the markup still one centred run, so no pen position is '
   +'written down where a different face would make it a lie',
   wm.src.trim());

console.log('\n'+(errs.length?'PAGE ERRORS: '+errs.join(' | '):'no page errors'));
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
