/* What every probe needs and none of them should carry its own copy of:
   a browser, a booted page, the three things the app talks to, and a way
   to make a gesture the judge believes. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

export const CHROME=process.env.HELM_CHROME
  ||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/* Not `URL` - that shadows the global one these routes parse with. */
export const APP=process.env.HELM_URL
  ||'http://localhost:8080/confluence_helm.html';
export const SHOTS=process.env.HELM_SHOTS||'/tmp/';
export const ORIGIN=new URL(APP).origin;
export const KT=1.94384, DEG=180/Math.PI;

/* ---- the scoreboard -------------------------------------------------- */
export function tally(){
  const t={pass:0, fail:0, errs:[]};
  t.ok=(c,m,x='')=>{ console.log((c?'  PASS  ':'  FAIL  ')+m+(x&&!c?'   '+x:''));
                     c?t.pass++:t.fail++; return !!c; };
  t.head=s=>console.log('\n=== '+s+' ===');
  t.done=async b=>{
    console.log('\n'+(t.errs.length?'PAGE ERRORS: '+t.errs.join(' | '):'no page errors'));
    console.log(t.pass+' passed, '+t.fail+' failed');
    if(b) await b.close();
    process.exit(t.fail||t.errs.length?1:0);
  };
  return t;
}

/* ---- a booted page --------------------------------------------------- */
/* opts: {phone, touch, geo, netd, api, marks, course, prefs, demo, theme} */
export async function open(t, opts={}){
  const b=await pw.chromium.launch({executablePath:CHROME});
  const ctxOpt = opts.phone
    ? {viewport:{width:430,height:932}, isMobile:true, hasTouch:true, deviceScaleFactor:2}
    : {viewport:{width:1080,height:1080}};
  if(opts.geo){ ctxOpt.geolocation=opts.geo; ctxOpt.permissions=['geolocation']; }
  const ctx=await b.newContext(ctxOpt);
  if(opts.geo) await ctx.grantPermissions(['geolocation'],{origin:ORIGIN});
  const p=await ctx.newPage();
  p.on('pageerror',e=>{ t.errs.push(String(e)); });

  /* Three fingers is the paging gesture, and headless reports none. */
  if(opts.touch!==false)
    await p.addInitScript(()=>Object.defineProperty(navigator,'maxTouchPoints',{get:()=>10}));
  for(const [k,v] of Object.entries(opts.storage||{}))
    await p.addInitScript(([k,v])=>localStorage.setItem(k,v), [k,v]);

  /* Signal K is never reachable in a probe: every one of these drives the
     app from its own feed or from a stub, and a socket that half-connects
     is a race nobody wants in a test. */
  await p.route('**/signalk/**', r=>r.abort());

  /* The helper. `netd:false` is a phone - nothing is listening. */
  const posts=[]; p.__posts=posts;
  await p.route('http://127.0.0.1:8091/**', r=>{
    if(opts.netd===false) return r.abort('connectionrefused');
    const path=new URL(r.request().url()).pathname;
    let body={}; try{ body=JSON.parse(r.request().postData()||'{}'); }catch(e){}
    if(path!=='/status') posts.push({path, body});
    const json=o=>r.fulfill({status:200, contentType:'application/json',
                             body:JSON.stringify(o)});
    const st=Object.assign({ok:true,
      wifi:{available:false}, bt:{available:false}, display:{},
      power:{available:false}, backlight:{available:false},
      buzzer:{available:false, mode:'off', why:'OFF'},
      score:{available:false}, gpx:{}, spotify:{}, fit:{}}, opts.status||{});
    if(path==='/status') return json(st);
    const r2=(opts.reply||{})[path];
    return json(typeof r2==='function' ? r2(body) : (r2||{ok:true}));
  });

  /* The club's scorer. */
  const scores=[]; p.__scores=scores;
  await p.route('https://vuduwave.com/**', r=>{
    if(opts.api===false) return r.abort('failed');
    try{ scores.push(JSON.parse(r.request().postData()||'{}')); }catch(e){ scores.push({}); }
    return r.fulfill({status:(opts.apiStatus||200), contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'*'},
      body:JSON.stringify({message:opts.apiMessage||'Time added'})});
  });
  if(opts.routes) for(const [glob,fn] of Object.entries(opts.routes)) await p.route(glob, fn);

  await p.goto(APP);
  await p.waitForTimeout(1600);
  await p.evaluate(()=>bootSettle());
  await p.waitForTimeout(opts.settle===undefined?1200:opts.settle);
  await p.evaluate(th=>{ CFG.theme=th; applyTheme(); }, opts.theme||'day');
  if(opts.demo){ await p.evaluate(()=>demoSet(true)); await p.waitForTimeout(900); }
  /* The demo's shoaling banner sits over half the face. */
  if(opts.quiet!==false)
    await p.evaluate(()=>{ Object.values(ALERTS).forEach(a=>a.ackUntil=Date.now()+9e5);
                           alertPaint(); });
  return {b, ctx, p, posts, scores};
}

/* ---- a gesture the judge believes ------------------------------------
   Synthetic pointers rather than the mouse: the judge wants the whole
   thing inside 700 ms and every CDP round trip counts against that, so a
   real drag passed or failed depending on how warm the page was. sx/sy
   are where on the FACE the finger lands - a phone centres the square in
   a tall viewport, and only what is inside the glass can be touched. */
export async function fling(p,n,dx,dy,sx=480,sy=540,wait=650){
  await p.evaluate(([n,dx,dy,sx,sy])=>{
    const st=document.getElementById('stage'), box=st.getBoundingClientRect();
    sx+=box.x; sy+=box.y;
    const ev=(t,id,x,y)=>st.dispatchEvent(new PointerEvent(t,
      {pointerId:id, clientX:x, clientY:y, bubbles:true, pointerType:'touch'}));
    const ids=[...Array(n).keys()].map(i=>i+1);
    ids.forEach((id,i)=>ev('pointerdown',id, sx+i*36, sy));
    ids.forEach((id,i)=>ev('pointermove',id, sx+i*36+dx, sy+dy));
    ids.forEach((id,i)=>ev('pointerup',  id, sx+i*36+dx, sy+dy));
  },[n,dx,dy,sx,sy]);
  await p.waitForTimeout(wait);
}

/* Where everything is, in one call, so a probe reads as a story. */
export const state=p=>p.evaluate(()=>({
  page:PAGE_I, panel:panel.classList.contains('open'),
  dock:apps.classList.contains('open'), sheet:netsheet.classList.contains('on'),
  app:APP.on?APP.on.id:null, race:tState,
  score:$('score').classList.contains('on'),
  held:$('held').classList.contains('on')}));

/* Drive the app's own clock without waiting for it. */
export const tick=(p,ms)=>p.evaluate(m=>{ tEnd=Date.now()+m; tick(); }, ms);
