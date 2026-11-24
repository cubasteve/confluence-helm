/* The dock's row of apps, under a real finger.

   Seven tiles in a 600 px row, so the row scrolls sideways. But under
   #stage nothing has touch-action other than none, and the browser
   scrolls nothing for a finger there: overflow-x:auto alone left GOLDEN
   HOUR half-faded at the end of the row and out of reach on the glass,
   while every synthetic PointerEvent probe stayed green. So this one
   touches it through CDP, the way the digitizer does. */
import {open, tally, state} from './helpers.mjs';
const t=tally();
const {b,ctx,p}=await open(t);
const cdp=await ctx.newCDPSession(p);
await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true, maxTouchPoints:5});

/* A drag along a line, start to end, in `n` steps `ms` apart. */
const drag=async(x0,y0,x1,y1,{n=10,ms=16,wait=500}={})=>{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart', touchPoints:[{x:x0,y:y0}]});
  for(let i=1;i<=n;i++){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',
      touchPoints:[{x:x0+(x1-x0)*i/n, y:y0+(y1-y0)*i/n}]});
    if(ms) await p.waitForTimeout(ms); }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd', touchPoints:[]});
  await p.waitForTimeout(wait); };
const tap=async(x,y)=>{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart', touchPoints:[{x,y}]});
  await p.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd', touchPoints:[]});
  await p.waitForTimeout(600); };
const row=()=>p.evaluate(()=>{ const r=$('app-row'), rb=r.getBoundingClientRect();
  const k=[...r.children], g=k[k.length-1].getBoundingClientRect();
  return {left:r.scrollLeft, room:r.scrollWidth-r.clientWidth,
    a:r.classList.contains('over-a'), z:r.classList.contains('over-z'),
    goldIn:g.left>=rb.left-0.5 && g.right<=rb.right+0.5,
    y:rb.top+rb.height/2, x0:rb.left, x1:rb.right}; });
/* Every frame of the drag, not only where it ended: a dock that closed
   and reopened, or a page that turned and came back, would pass a
   before-and-after check. */
const watch=()=>p.evaluate(()=>{ window.__seen=[];
  const f=()=>{ __seen.push({page:PAGE_I, dock:apps.classList.contains('open'),
                             app:APP.on?APP.on.id:null});
                if(__seen.length<400) requestAnimationFrame(f); };
  requestAnimationFrame(f); });
const seen=()=>p.evaluate(()=>{ const s=__seen; __seen=[]; return s; });

await p.evaluate(()=>openApps()); await p.waitForTimeout(600);
let R=await row(), S0=await state(p);
t.ok(S0.dock && R.room>40 && R.left===0 && !R.a && R.z && !R.goldIn,
     'the dock is up, the row overflows, starts at its first tile, '
     +'fades only at the far end, and GOLDEN HOUR is not all on the glass',
     JSON.stringify(R));

t.head('a finger drags the row left');
await watch();
await drag(R.x1-60, R.y, R.x0+60, R.y);
R=await row(); let F=await seen(), S=await state(p);
t.ok(R.left>=R.room-1 && R.goldIn, 'GOLDEN HOUR comes fully onto the glass',
     JSON.stringify(R));
t.ok(R.a && !R.z, 'and the fade moves to the end that now has something behind it',
     JSON.stringify(R));
t.ok(F.length>5 && F.every(f=>f.dock && f.page===S0.page && f.app===null),
     'the dock stayed up, the page never turned and no app opened, '
     +'on any frame of it', JSON.stringify(F.filter(f=>!f.dock||f.page!==S0.page||f.app)));
t.ok(S.dock && S.page===S0.page && S.app===null && !S.panel,
     'and all still so once the finger is off', JSON.stringify(S));

t.head('and back');
await watch();
await drag(R.x0+60, R.y, R.x1-60, R.y);
R=await row(); F=await seen(); S=await state(p);
t.ok(R.left===0 && !R.a && R.z, 'the row is back at TRACKS, fading at the far end only',
     JSON.stringify(R));
t.ok(F.every(f=>f.dock && f.page===S0.page && f.app===null) && S.dock && S.app===null,
     'with the dock up and nothing opened throughout', JSON.stringify(S));

t.head('a flick coasts, like every other list here');
/* The whole row has only ~96 px of room, so a short stroke: it has to
   leave somewhere to coast to. */
await drag(R.x1-80, R.y, R.x1-120, R.y, {n:4, ms:8, wait:0});
const at0=(await row()).left;
await p.waitForTimeout(700);
const at1=(await row()).left;
t.ok(at1>at0+5, 'the row keeps going after the finger has lifted',
     JSON.stringify({at0, at1}));
await p.evaluate(()=>{ const r=$('app-row'); r.scrollLeft=0; });
await p.waitForTimeout(200);

t.head('a drag that starts on a tile opens nothing');
const tileAt=id=>p.evaluate(id=>{ const i=APPS.findIndex(a=>a.id===id);
  const r=document.querySelector('#app-row [data-app="'+i+'"]').getBoundingClientRect();
  return {x:r.left+r.width/2, y:r.top+r.height/2}; }, id);
let c=await tileAt('course');
await drag(c.x, c.y, c.x-90, c.y+4);
S=await state(p); R=await row();
t.ok(S.app===null && S.dock && R.left>40, 'it scrolled the row and left the dock up',
     JSON.stringify({S,R}));

t.head('a downward swipe on a tile is still the dock\'s own dismiss');
c=await tileAt('radar');
await drag(c.x, c.y-20, c.x+6, c.y+140, {n:6, ms:10});
S=await state(p);
t.ok(!S.dock && S.app===null, 'the dock goes down, nothing opened', JSON.stringify(S));

t.head('a tap still opens what it lands on');
await p.evaluate(()=>openApps()); await p.waitForTimeout(600);
await drag(R.x1-60, R.y, R.x0+60, R.y);
/* A beat before the tap. Straight off a hard flick Chromium itself
   sometimes eats the next tap - the "tap that stops a fling" - and
   delivers pointerdown and pointerup with no click; that is the
   browser's, the same for every list on the glass, and not what this
   is asking. */
await p.waitForTimeout(1500);
c=await tileAt('golden');
await tap(c.x, c.y);
S=await state(p);
t.ok(S.app==='golden', 'a tap on GOLDEN HOUR, scrolled into view, opens it',
     JSON.stringify(S));
await p.evaluate(()=>closeApp()); await p.waitForTimeout(400);
await p.evaluate(()=>openApps()); await p.waitForTimeout(600);
await p.evaluate(()=>{ $('app-row').scrollLeft=0; }); await p.waitForTimeout(100);
c=await tileAt('energy');            /* the sixth: whole on the glass at the start */
await tap(c.x, c.y);
t.ok((await state(p)).app==='energy', 'and one on a tile that never moved opens that');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(400);

await t.done(b);
