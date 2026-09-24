/* The demo sail: that it plays, moves, holds its bearings, and is the
   race it came from rather than a smooth invention. Trimmed to the
   race itself - the 42 minutes before the 18:23 gun are not in it. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const b=await pw.chromium.launch({executablePath:process.env.HELM_CHROME
  ||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage({viewport:{width:1080,height:1080}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.route('**/signalk/**',r=>r.abort());
await p.route('http://127.0.0.1:8091/**',r=>r.abort('connectionrefused'));
await p.goto(process.env.HELM_URL||'http://localhost:8080/confluence_helm.html');
await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle());
let pass=0,fail=0; const ok=(c,m,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+m+(x?'   '+x:''));c?pass++:fail++;};

console.log('\n=== the sail, walked end to end ===');
const D=await p.evaluate(()=>{
  const T=DEMO_TRACK, n=T.dlat.length, out=[];
  for(let i=0;i<=n;i++) out.push(demoTrack(i*T.step));
  const nm=(a,b,c,d)=>{ const R=Math.PI/180,
    x=Math.sin((c-a)*R/2)**2+Math.cos(a*R)*Math.cos(c*R)*Math.sin((d-b)*R/2)**2;
    return 2*3440.065*Math.asin(Math.min(1,Math.sqrt(x))); };
  let dist=0, maxSog=0, sog=0, maxTurn=0;
  for(let i=1;i<out.length;i++){
    dist+=nm(out[i-1].lat,out[i-1].lon,out[i].lat,out[i].lon);
    maxSog=Math.max(maxSog,out[i].sog); sog+=out[i].sog;
    let t=out[i].crs-out[i-1].crs; t=((t+540)%360)-180;
    maxTurn=Math.max(maxTurn,Math.abs(t));
  }
  const la=out.map(o=>o.lat), lo=out.map(o=>o.lon);
  /* which way she was pointing, over the ten-degree bands */
  const H=new Array(36).fill(0);
  out.forEach(o=>{ if(o.sog*1.94384>2.5) H[Math.floor(o.crs/10)%36]++; });
  return {n, mins:n*T.step/60, dist, maxKt:maxSog*1.94384,
          meanKt:sog/(out.length-1)*1.94384, maxTurn,
          latSpan:[Math.min(...la),Math.max(...la)],
          lonSpan:[Math.min(...lo),Math.max(...lo)],
          bands:H.map((v,i)=>[i*10,v]).filter(x=>x[1]>25).map(x=>x[0])};
});
ok(D.n===554 && Math.abs(D.mins-73.9)<0.1, 'the 74 minutes of the race',
   D.mins.toFixed(1)+' min');
ok(Math.abs(D.dist-5.65)<0.15, 'five and a half nautical miles, as sailed',
   D.dist.toFixed(2)+' NM');
ok(D.maxKt>6 && D.maxKt<8, 'topping out where a 22-footer does', D.maxKt.toFixed(1)+' kt');
ok(D.meanKt>4 && D.meanKt<6, 'and averaging a racing speed', D.meanKt.toFixed(1)+' kt');
ok(D.latSpan[0]>28.81 && D.latSpan[1]<28.84 && D.lonSpan[0]>-81.29 && D.lonSpan[1]<-81.25,
   'on Lake Monroe, where the marks are', JSON.stringify([D.latSpan,D.lonSpan]));

console.log('\n=== it sails rather than spins ===');
ok(D.maxTurn<=60.5, 'no turn a boat could not make', D.maxTurn.toFixed(0)+' deg per 8 s');
ok(D.bands.length>=2, 'and holds bearings: the bands it spent the race on',
   JSON.stringify(D.bands));
ok(D.bands.some(x=>x>=290&&x<=360) && D.bands.some(x=>x>=100&&x<=160),
   'up the lake in the 300s, back down through the 120s', JSON.stringify(D.bands));

console.log('\n=== the clock starts at the gun, not at the dock ===');
const T0=await p.evaluate(()=>({t0:DEMO_T0_MIN,
  end:DEMO_T0_MIN+DEMO_TRACK.dlat.length*DEMO_TRACK.step/60,
  w:DEMO_WIND.map(r=>r[0])}));
ok(Math.abs(T0.t0-23.083)<0.01, 'it opens at 18:23, where the race did',
   '18:'+T0.t0.toFixed(2).replace('.',' + .')+' min');
ok(T0.w[0]<=T0.t0 && T0.w[T0.w.length-1]>=T0.end,
   'and the wind table brackets it rather than sitting inside it',
   JSON.stringify(T0.w)+' vs '+T0.t0.toFixed(1)+'-'+T0.end.toFixed(1));

console.log('\n=== the shallow water stayed where the lake put it ===');
/* The channel's depth used to key off the track's first fix, which was
   the marina until the trim moved it 690 m up the lake. */
const DP=await p.evaluate(()=>{
  const at=(la,lo)=>{ const off=Math.hypot((la-DEMO_MARINA.lat)*111320,
                        (lo-DEMO_MARINA.lon)*111320*Math.cos(la/DEG));
                      return 5+4.5*Math.min(1,off/700); };
  return {dock:at(DEMO_MARINA.lat,DEMO_MARINA.lon),
          start:at(DEMO_TRACK.lat0,DEMO_TRACK.lon0),
          lake:at(28.83,-81.27)};
});
ok(Math.abs(DP.dock-5)<0.1, 'five feet at the marina', DP.dock.toFixed(1)+' ft');
ok(DP.lake>9, 'and nine or so out in the lake', DP.lake.toFixed(1)+' ft');
ok(DP.start>DP.dock+2, 'the race starts out of the channel, not in it',
   DP.start.toFixed(1)+' ft');

console.log('\n=== the wind agrees with the track ===');
const W=await p.evaluate(()=>{
  const T=DEMO_TRACK, n=T.dlat.length;
  let lo=999, hi=-999, kt=[], twa={};
  for(let i=0;i<n;i+=2){
    const t=i*T.step, w=demoWind(t), d=demoTrack(t);
    const f=((w.from%360)+360)%360;
    /* unwrapped about 022 so the oscillation reads as a range */
    const rel=((f-22+540)%360)-180;
    lo=Math.min(lo,rel); hi=Math.max(hi,rel); kt.push(w.kt);
    if(d.sog*1.94384>3){
      const a=Math.abs(((d.crs-f+540)%360)-180);
      const b=Math.round(a/10)*10; twa[b]=(twa[b]||0)+1;
    }
  }
  const band=(a,z)=>Object.keys(twa).filter(k=>+k>=a&&+k<=z)
                     .reduce((s,k)=>s+twa[k],0);
  const all=Object.keys(twa).reduce((s,k)=>s+twa[k],0);
  return {lo, hi, min:Math.min(...kt), max:Math.max(...kt), all,
          beat:band(30,50), reach:band(80,110), run:band(150,180),
          between:band(60,70)};
});
ok(Math.abs(W.lo+W.hi)<3 && W.hi<14, 'it oscillates about NNE rather than wandering off',
   W.lo.toFixed(0)+' to +'+W.hi.toFixed(0)+' deg of 022');
ok(W.min>5.5 && W.max<13.1, 'between a lull and the reported gust',
   W.min.toFixed(1)+' - '+W.max.toFixed(1)+' kt');
/* The real check: resolve the courses she held against that wind and a
   boat's three modes should fall out. They do, which is what says the
   wind and the track are the same evening. */
ok(W.beat>W.between*1.5, 'close-hauled is a mode, not a smear',
   W.beat+' steps at 30-50 vs '+W.between+' at 60-70');
/* Shares rather than counts: the track has been trimmed once already
   and absolute step counts were the thing that broke when it was. */
const share=n=>(100*n/W.all).toFixed(0)+'% of '+W.all;
ok(W.reach/W.all>0.15, 'so is reaching', share(W.reach)+' at 80-110');
ok(W.run/W.all>0.15, 'and so is running', share(W.run)+' at 150-180');

console.log('\n=== and the feed plays it ===');
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); demoSet(true); });
await p.waitForTimeout(1500);
const live=await p.evaluate(async ()=>{
  const seen=[];
  for(let i=0;i<8;i++){
    seen.push({la:(S['pos.lat']||{}).v, sog:get('navigation.speedOverGround'),
               crs:get('navigation.courseOverGroundTrue'), tws:get('environment.wind.speedTrue')});
    await new Promise(r=>setTimeout(r,300));
  }
  return seen;
});
ok(new Set(live.map(x=>x.la)).size>=6, 'the boat is moving, not frozen',
   new Set(live.map(x=>x.la)).size+' of 8 distinct');
ok(live.every(x=>x.sog!==null&&x.crs!==null), 'with a speed and a course throughout');
ok(live.every(x=>x.tws!==null), 'and a wind to sail it against');
ok((await p.evaluate(()=>$('spd').textContent))!=='––', 'and the face reads',
   await p.evaluate(()=>$('spd').textContent));

console.log('\n'+(errs.length?'PAGE ERRORS: '+errs.join(' | '):'no page errors'));
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
