/* The demo sail: that it plays, moves, holds its bearings, and is the
   sail it came from rather than a smooth invention - Confluence's own
   first sail with this helm, 2026-11-06 from 17:05, in that evening's
   wind from Open-Meteo. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const b=await pw.chromium.launch({executablePath:process.env.HELM_CHROME});
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
ok(D.n===529 && Math.abs(D.mins-70.5)<0.1, 'the 70 minutes she sailed',
   D.mins.toFixed(1)+' min');
ok(Math.abs(D.dist-2.72)<0.15, 'two and three-quarter nautical miles, as sailed',
   D.dist.toFixed(2)+' NM');
ok(D.maxKt>4 && D.maxKt<6.5, 'topping out under a 22-footer\'s hull speed', D.maxKt.toFixed(1)+' kt');
ok(D.meanKt>1.8 && D.meanKt<3, 'and averaging what three knots of breeze gives', D.meanKt.toFixed(1)+' kt');
ok(D.latSpan[0]>28.81 && D.latSpan[1]<28.84 && D.lonSpan[0]>-81.29 && D.lonSpan[1]<-81.25,
   'on Lake Monroe, where the marks are', JSON.stringify([D.latSpan,D.lonSpan]));

console.log('\n=== it sails rather than spins ===');
ok(D.maxTurn<=60.5, 'no turn a boat could not make', D.maxTurn.toFixed(0)+' deg per 8 s');
ok(D.bands.length>=2, 'and holds bearings: the bands it spent the race on',
   JSON.stringify(D.bands));
ok(D.bands.some(x=>x>=340||x<=10) && D.bands.some(x=>x>=170&&x<=200),
   'up the lake on 350 to 010, back down on 170 to 200', JSON.stringify(D.bands));

console.log('\n=== the clock starts when she did ===');
const T0=await p.evaluate(()=>({t0:DEMO_T0_MIN,
  end:DEMO_T0_MIN+DEMO_TRACK.dlat.length*DEMO_TRACK.step/60,
  w:DEMO_WIND.map(r=>r[0])}));
ok(Math.abs(T0.t0-5.333)<0.01, 'it opens at 17:05, when she left',
   '17:'+String(Math.floor(T0.t0)).padStart(2,'0')+':'+String(Math.round(T0.t0%1*60)).padStart(2,'0'));
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
ok(DP.start>DP.dock+2, 'the sail starts out of the channel, not in it',
   DP.start.toFixed(1)+' ft');

console.log('\n=== the wind is that evening\'s, and agrees with the track ===');
/* Open-Meteo for the lake: 1-4 kt from the west-north-west, gusting to
   8.6, a lull at 18:00, backing 316 to 290. */
const W=await p.evaluate(()=>{
  const T=DEMO_TRACK, n=T.dlat.length;
  let fr=[], kt=[], twa={}, all=0, ok15=0;
  for(let i=0;i<n;i+=2){
    const t=i*T.step, w=demoWind(t), d=demoTrack(t);
    fr.push(w.from); kt.push(w.kt);
    if(d.sog*1.94384>1.5){
      const a=Math.abs(((d.crs-w.from+540)%360)-180);
      const b=Math.round(a/10)*10; twa[b]=(twa[b]||0)+1; all++;
    }
  }
  const band=(a,z)=>Object.keys(twa).filter(k=>+k>=a&&+k<=z)
                     .reduce((s,k)=>s+twa[k],0);
  /* the table itself, at the quarter hours it gives */
  const at=m=>demoWind((m-DEMO_T0_MIN)*60);
  return {frMin:Math.min(...fr), frMax:Math.max(...fr), ktMin:Math.min(...kt), ktMax:Math.max(...kt),
          all, reach:band(50,130), up:band(0,40), down:band(140,180),
          q30:at(30), q60:at(60)};
});
ok(W.frMin>270 && W.frMax<330, 'from the west-north-west all evening, not the old NNE',
   W.frMin.toFixed(0)+' to '+W.frMax.toFixed(0)+' deg');
ok(W.ktMin>=0.3 && W.ktMax<8.7, 'light air, never past the 8.6 kt gust',
   W.ktMin.toFixed(1)+' - '+W.ktMax.toFixed(1)+' kt');
ok(W.q60.kt < W.q30.kt, 'and the 18:00 lull is in it', W.q30.kt.toFixed(1)+' kt at 17:30, '+W.q60.kt.toFixed(1)+' at 18:00');
/* The real check: up and down the lake in a westerly is a reach both
   ways, and the courses she held say exactly that. */
const share=n=>(100*n/W.all).toFixed(0)+'% of '+W.all;
ok(W.reach/W.all>0.65, 'she reached up the lake and reached back', share(W.reach)+' at 50-130');
ok(W.up/W.all<0.2 && W.down/W.all<0.2, 'with little beating and little running',
   share(W.up)+' under 40, '+share(W.down)+' over 140');

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
