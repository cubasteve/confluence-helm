/* The demo sail: that it plays, moves, holds its bearings, and is the
   race it came from rather than a smooth invention. */
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
ok(D.n===870 && Math.abs(D.mins-116)<0.1, '116 minutes of it', D.mins.toFixed(1)+' min');
ok(Math.abs(D.dist-9.0)<0.15, 'nine nautical miles, as sailed', D.dist.toFixed(2)+' NM');
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
