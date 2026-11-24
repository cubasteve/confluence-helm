/* The chart: Freeboard, laid out for the circle by the
   signalk-round-freeboard webapp on the Signal K server, in a frame.

   The webapp itself is not under test here - it has its own rig. What
   is, is the panel's half of the bargain: the frame goes to the right
   server with the right theme, hears about every theme change and no
   other, listens to that page and nobody else, goes entirely on close,
   never leaves a blank circle when the server or the webapp is not
   there, and does not take the cross or the top-edge pull with it.

   The server is a stub at the address the panel would use for Signal K
   (localhost:3000 here, the page being on localhost): a page at the
   webapp's path that records what it is told and says what the test
   wants it to say.

       python3 -m http.server 8080   (run.sh does this)
       node tests/chart.mjs
*/
import {open, tally, SHOTS} from './helpers.mjs';
const t=tally();

const SK='http://localhost:3000';
const PATH='/signalk-round-freeboard/';
/* What the stub does on the next load: 'round' | 'square' | 'error' |
   'silent' (loads, says nothing) | 'refused' | '404' | 'hang' |
   'nocors' (round, but no Access-Control-Allow-Origin: a server whose
   allowedCorsOrigins leaves the panel out). */
let MODE='round';
const stub=mode=>`<!doctype html><html><body style="margin:0;background:#123">
<div id="me" style="color:#fff;font:40px sans-serif;padding:300px 200px">STUB CHART</div>
<script>
  window.got=[];
  addEventListener('message',e=>{
    if(e.data&&e.data.type==='rfb-theme') got.push(e.data.theme); });
  window.theme=new URLSearchParams(location.search).get('theme');
  window.act=()=>parent.postMessage({type:'rfb-activity'},'*');
  if(${JSON.stringify(mode)}!=='silent') setTimeout(()=>parent.postMessage(
    {type:'rfb-status', mode:${JSON.stringify(mode)},
     reason:${JSON.stringify(mode==='error'?'Freeboard-SK is not installed':'')},
     version:'3.4.1'},'*'), 150);
</script></body></html>`;
const hung=[];
const {b,ctx,p}=await open(t,{routes:{
  [SK+PATH+'**']:r=>{
    if(MODE==='refused') return r.abort('connectionrefused');
    if(MODE==='hang'){ hung.push(r); return; }
    if(MODE==='404') return r.fulfill({status:404, contentType:'text/html',
      headers:{'Access-Control-Allow-Origin':'*'},
      body:'<pre>Cannot GET '+PATH+'</pre>'});
    if(MODE==='nocors') return r.fulfill({status:200, contentType:'text/html',
      body:stub('silent')});
    return r.fulfill({status:200, contentType:'text/html',
      headers:{'Access-Control-Allow-Origin':'*'}, body:stub(MODE)});
  }}});

const frame=()=>p.frames().find(f=>f.url().startsWith(SK+PATH));
const look=()=>p.evaluate(()=>{ const f=$('ch-frame');
  return {on:APP.on?APP.on.id:null, frame:!!f, src:f?f.src:null,
          inBody:!!f && f.parentElement===$('app-body'),
          top:!!$('ch-top'), held:CH!==null,
          failed:$('app-run').classList.contains('failed'),
          msg:$('app-msg').textContent}; });
const openChart=async(ms=900)=>{
  await p.evaluate(()=>openApp(APPS.find(a=>a.id==='chart')));
  await p.waitForTimeout(ms); };
const closeChart=async()=>{ await p.evaluate(()=>closeApp()); await p.waitForTimeout(300); };

t.head('it is on the dock');
await p.evaluate(()=>{ drawApps(); openApps(); }); await p.waitForTimeout(500);
const tiles=await p.evaluate(()=>[...document.querySelectorAll('#app-row [data-app]')]
  .map(e=>e.querySelector('span').textContent));
t.ok(tiles.includes('CHART'), 'a CHART tile', tiles.join('|'));
await p.screenshot({path:SHOTS+'chart-dock.png'});
await p.evaluate(()=>{ const i=APPS.findIndex(a=>a.id==='chart');
  document.querySelector('#app-row [data-app="'+i+'"]').click(); });
await p.waitForTimeout(900);

t.head('the frame: the Signal K host, the webapp, the panel\'s theme');
let L=await look();
t.ok(L.on==='chart' && L.inBody, 'a tap on the tile opens it, the frame in the app body',
     JSON.stringify(L));
t.ok(L.src===SK+PATH+'?theme=day', 'on the host the socket uses, in day', L.src);
t.ok(await p.evaluate(()=>{ const r=$('ch-frame').getBoundingClientRect(),
       s=$('stage').getBoundingClientRect();
       return Math.abs(r.width-s.width)<1 && Math.abs(r.height-s.height)<1; }),
     'filling the body');
t.ok(!L.failed, 'and the page said round, so nothing failed', L.msg);
t.ok(await frame()?.evaluate(()=>window.theme)==='day', 'the page read day');
await p.screenshot({path:SHOTS+'chart-open.png'});

t.head('a theme change is sent to the page, once, at its origin');
await p.evaluate(()=>{ CFG.theme='dusk'; applyTheme(); }); await p.waitForTimeout(200);
await p.evaluate(()=>{ CFG.theme='night'; applyTheme(); }); await p.waitForTimeout(200);
await p.evaluate(()=>applyTheme()); await p.waitForTimeout(200);   /* the minute tick */
let got=await frame().evaluate(()=>window.got.slice());
/* The first one is the page's own load: a message posted while the frame
   still held its empty document is lost, so it is told once more. */
t.ok(JSON.stringify(got.slice(-2))==='["dusk","night"]',
     'dusk then night, and nothing for a tick that changed nothing', JSON.stringify(got));
t.ok(got.filter(x=>x==='night').length===1, 'night said once');
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); }); await p.waitForTimeout(200);

t.head('it hears only that page');
/* An rfb-status from anywhere else - here the panel's own origin - is
   not the chart's, and an error from it must not tear the chart down. */
await p.evaluate(()=>window.postMessage({type:'rfb-status', mode:'error',
  reason:'forged'}, '*'));
await p.waitForTimeout(300);
L=await look();
t.ok(L.frame && !L.failed, 'an error from another origin is ignored', JSON.stringify(L));

t.head('the cross and the name stay the panel\'s');
const z=await p.evaluate(()=>{
  const c=$('app-close').getBoundingClientRect();
  const at=document.elementFromPoint(c.left+c.width/2, c.top+c.height/2);
  const n=$('app-name'); n.style.pointerEvents='auto';
  const nb=n.getBoundingClientRect();
  const atN=document.elementFromPoint(nb.left+nb.width/2, nb.top+nb.height/2);
  n.style.pointerEvents='';
  return {close:!!at && !!at.closest('#app-close'), name:atN===n,
          cy:[Math.round(c.top),Math.round(c.bottom)],
          ny:[Math.round(nb.top),Math.round(nb.bottom)]}; });
t.ok(z.close, 'the cross is above the frame', JSON.stringify(z));
t.ok(z.name, 'and so is the name pill', JSON.stringify(z));

t.head('the top edge is still the control panel\'s pull');
/* Real touches, through CDP: a frame swallows every event that lands on
   it, so a synthetic PointerEvent dispatched at the stage would prove
   nothing. A touch belongs to the element it started on for its whole
   travel, which is what #ch-top is counting on. */
const cdp=await ctx.newCDPSession(p);
await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true, maxTouchPoints:5});
const drag=async(x,y0,y1)=>{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart', touchPoints:[{x,y:y0}]});
  for(let i=1;i<=6;i++) await cdp.send('Input.dispatchTouchEvent',
    {type:'touchMove', touchPoints:[{x, y:y0+(y1-y0)*i/6}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd', touchPoints:[]});
  await p.waitForTimeout(600); };
await frame().evaluate(()=>document.body.focus());
await drag(540, 60, 330);
t.ok(await p.evaluate(()=>panel.classList.contains('open')),
     'a pull from the top cap brings the panel down over the chart');
await p.evaluate(()=>closePanel()); await p.waitForTimeout(600);
await drag(540, 420, 690);
t.ok(!await p.evaluate(()=>panel.classList.contains('open')),
     'and one that starts on the chart is the chart\'s (the frame has it)');
t.ok((await look()).on==='chart', 'the chart still up through both');

t.head('the cross closes it, and the frame goes');
await frame().evaluate(()=>document.body.focus());
const cb=await p.evaluate(()=>{ const r=$('app-close').getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2}; });
await p.mouse.click(cb.x, cb.y); await p.waitForTimeout(400);
L=await look();
t.ok(L.on===null && !L.frame && !L.top && !L.held,
     'a click on the cross with the frame focused closes it, frame and all',
     JSON.stringify(L));
t.ok(!frame(), 'and no frame of it is left in the page',
     p.frames().map(f=>f.url()).join(' '));

t.head('opens in the panel\'s current theme');
await p.evaluate(()=>{ CFG.theme='night'; applyTheme(); });
await openChart();
L=await look();
t.ok(L.src===SK+PATH+'?theme=night', 'night', L.src);
await closeChart();
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); });

t.head('never a blank circle');
MODE='error';
await openChart();
L=await look();
t.ok(L.failed && /^Chart not available — Freeboard-SK is not installed/.test(L.msg),
     'the page says error: its reason, on the panel\'s own failure line',
     JSON.stringify(L));
t.ok(!L.frame && !L.top, 'and the frame is gone', JSON.stringify(L));
await p.screenshot({path:SHOTS+'chart-error.png'});
await closeChart();
t.ok(!(await look()).failed, 'the cross still closes it, and clears the line');

MODE='refused';
const t0=Date.now();
await openChart(1200);
L=await look();
t.ok(L.failed && L.msg==='Chart not available — is Signal K running on localhost:3000?',
     'no server: said at once, not after the wait', L.msg+' ('+(Date.now()-t0)+' ms)');
t.ok(!L.frame, 'with no frame left behind');
await closeChart();

MODE='404';
await openChart();
L=await look();
t.ok(L.failed && /not installed on localhost:3000/.test(L.msg),
     'a server without the webapp: says which', L.msg);
await closeChart();

MODE='hang';
await openChart(300);
t.ok(!(await look()).failed, 'a server that does not answer is given its time');
await p.waitForTimeout(15200);
t.ok(!(await look()).failed,
     'not cut short at fifteen seconds: the page itself waits 30 for Freeboard');
await p.waitForTimeout(20000);
L=await look();
t.ok(L.failed && /is Signal K running on localhost:3000\?$/.test(L.msg),
     'and after thirty-five seconds it is told so', L.msg);
t.ok(!L.frame && !L.held, 'with the frame gone and nothing held');
await closeChart();
hung.forEach(r=>r.abort().catch(()=>{}));

MODE='hang';
await openChart(300);
await p.evaluate(()=>closeApp()); await p.waitForTimeout(100);
await p.waitForTimeout(35200);
L=await look();
t.ok(!L.failed && L.on===null && !L.held,
     'closed before the wait ran out: no failure line appears later on an empty frame',
     JSON.stringify(L));
hung.forEach(r=>r.abort().catch(()=>{}));

t.head('a server that answers but not to CORS');
MODE='nocors';
await openChart(1500);
L=await look();
const ok=await p.evaluate(()=>CH&&CH.ok);
t.ok(!L.failed && L.frame && ok===true,
     'the plain answer counts as a server that is up: the wait cannot tear down a chart that is still booting',
     JSON.stringify({...L, ok}));
await closeChart();

t.head('the screensaver and the chart');
/* A touch on the chart lands in the frame and never reaches the
   panel's pointerdown, so the page says rfb-activity and that is the
   touch. The 10 s delay, the idle clock wound back past it. */
MODE='round';
await p.evaluate(()=>{ ssStep=1; });
await openChart();
await p.evaluate(()=>{ lastTouch=Date.now()-20000; });
await p.waitForTimeout(1200);
let S=await p.evaluate(()=>({ss:ssOn, act:CH.act}));
t.ok(!S.ss && !S.act,
     'a page that has not spoken of activity holds the saver off (one from before 0.3.1)',
     JSON.stringify(S));
await frame().evaluate(()=>act());
await p.waitForTimeout(200);
S=await p.evaluate(()=>({ss:ssOn, act:CH.act, idle:Date.now()-lastTouch}));
t.ok(!S.ss && S.act && S.idle<1000, 'rfb-activity from the page counts as a touch',
     JSON.stringify(S));
await p.evaluate(()=>{ lastTouch=Date.now()-20000; postMessage({type:'rfb-activity'},'*'); });
await p.waitForTimeout(1200);
S=await p.evaluate(()=>({ss:ssOn, on:APP.on&&APP.on.id}));
t.ok(S.ss, 'once it speaks, real idle on the chart still brings the saver (and a forged message from elsewhere does not hold it)',
     JSON.stringify(S));
await p.evaluate(()=>{ ssStop(); });
/* used: activity every ~1.2 s for 13 s, longer than the 10 s delay */
for(let i=0;i<11;i++){ await frame().evaluate(()=>act()); await p.waitForTimeout(1200); }
S=await p.evaluate(()=>({ss:ssOn, idle:Date.now()-lastTouch}));
t.ok(!S.ss, 'a chart in use for longer than the delay never gets the saver',
     JSON.stringify(S));
await p.evaluate(()=>{ ssStep=0; ssStop(); });
await closeChart();
S=await p.evaluate(()=>chartHoldsSaver());
t.ok(S===false, 'and with the chart closed nothing holds the saver');

await t.done(b);
