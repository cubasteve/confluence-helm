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
await p.evaluate(()=>openCourse()); await p.waitForTimeout(600);
const rows=await p.$$eval('#course-list .course-row',n=>n.length);
ok(rows>=11, 'the course sheet, with every mark on it', String(rows));
ok(/\d+ \d+\.\d+N · \d+ \d+\.\d+W/.test(
   await p.$eval('.course-row[data-mark="cb12"] span',e=>e.textContent)),
   'each reading its position back');
await p.evaluate(()=>{ closeLib(); closeApp(); }); await p.waitForTimeout(500);

console.log('\n=== the race runs ===');
const race=await p.evaluate(async ()=>{
  startCountdown(); const a=tState;
  tEnd=Date.now()+1200; await new Promise(r=>setTimeout(r,2200));
  const b=tState;
  tGun=Date.now()-2895000; finishRace();
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

console.log('\n=== and the two feeds are honest ===');
await p.evaluate(()=>{ demoSet(false); phoneSet(true,'smoke'); });
await p.waitForTimeout(1000);
const feed=await p.evaluate(()=>({pos:get('pos.lat'), wind:get('environment.wind.speedTrue'),
  dpt:get('environment.depth.belowTransducer'), roll:get('att.roll')}));
ok(feed.pos!==null, 'phone mode has a position', String(feed.pos));
ok(feed.wind===null && feed.dpt===null && feed.roll===null,
   'and invents no wind, no depth and no heel', JSON.stringify(feed));
await p.evaluate(()=>phoneSet(false,'smoke'));

console.log('\n'+(errs.length?'PAGE ERRORS: '+errs.join(' | '):'no page errors'));
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
