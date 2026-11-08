/* The GPS conditioning: that a noisy 1 Hz receiver on a heeled boat
   reaches the dial calm, that a tack still shows, that a spike is held
   rather than followed, and that the recorder logs each fix once.

   The track is synthetic, with the noise the first sail measured once the
   boat heeled (6 Nov: ~1 m position scatter, SOG flicker to 1.8 kn): a
   real track is somebody's afternoon, and this repository is public. */
import {open, tally} from './helpers.mjs';

const t=tally();
const {b,p}=await open(t);

/* ---- the sail ------------------------------------------------------ */
let seed=7; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
const gauss=()=>{ let u=0,v=0; while(!u)u=rnd(); while(!v)v=rnd();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
const R=Math.PI/180, KT=1.94384, BASE=Date.parse('2026-11-06T22:05:00Z');
const LAT0=28.8183, LON0=-81.2620, M=111320, CK=Math.cos(LAT0*R);
const legs=[ {secs:200, kt:3.0, crs:30},     // close hauled
             {secs:6,   kt:2.0, turn:90},     // the tack
             {secs:200, kt:3.0, crs:120},
             {secs:100, kt:0.3, crs:120},     // drifting
             {secs:100, kt:3.0, crs:120} ];
const truth=[]; let x=0,y=0,c=30;
for(const L of legs) for(let i=0;i<L.secs;i++){
  if(L.turn!==undefined) c+=L.turn/L.secs; else c=L.crs;
  const v=L.kt/KT; x+=v*Math.sin(c*R); y+=v*Math.cos(c*R);
  truth.push({x,y,v,c:(c+360)%360});
}
const SPIKE=300;                                 /* one fix 40 m off, east */
const fixes=truth.map((q,i)=>{
  const vx=q.v*Math.sin(q.c*R)+0.35*gauss(), vy=q.v*Math.cos(q.c*R)+0.35*gauss();
  const px=q.x+1.0*gauss()+(i===SPIKE?40:0), py=q.y+1.0*gauss();
  return {i, ts:new Date(BASE+i*1000).toISOString(),
          sog:Math.hypot(vx,vy), cog:(Math.atan2(vx,vy)+2*Math.PI)%(2*Math.PI),
          lat:LAT0+py/M, lon:LON0+px/(M*CK), rx:px, ry:py};
});

/* Each fix is sent four times, as the 'fixed' 250 ms subscription
   resends it, in the order a receiver's RMC lands: speed, course, fix. */
const out=await p.evaluate(([F,LAT0,LON0,M,CK])=>{
  trackClear(); localArmed=true;
  const res=[];
  F.forEach(f=>{
    const msg=JSON.stringify({updates:[{timestamp:f.ts, values:[
      {path:'navigation.speedOverGround', value:f.sog},
      {path:'navigation.courseOverGroundTrue', value:f.cog},
      {path:'navigation.position', value:{latitude:f.lat, longitude:f.lon}}]}]});
    for(let k=0;k<4;k++){ skMessage(msg); trackSample(); }
    const la=get('pos.lat'), lo=get('pos.lon');
    res.push({sog:get('navigation.speedOverGround'), cog:get('navigation.courseOverGroundTrue'),
              x:(lo-LON0)*M*CK, y:(la-LAT0)*M});
  });
  return {res, trk:TRK.map(q=>({t:q.t, la:q.la, lo:q.lo})), seq:GPS.seq,
          raw:get('raw.sog')!==null && get('raw.lat')!==null};
}, [fixes, LAT0, LON0, M, CK]);
const res=out.res;
const deg=a=>Math.abs(((a+540)%360)-180);
const pct=(a,q)=>{ const s=[...a].sort((m,n)=>m-n); return s[Math.floor(q*(s.length-1))]; };
const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);

t.head('a resend is not a fix');
t.ok(out.seq===fixes.length-1, 'every fix taken once, four sends each, the spike held',
     out.seq+' of '+fixes.length);
t.ok(out.trk.length===out.seq, 'the recorder logged one point per fix', out.trk.length+' points');
const steps=out.trk.slice(1).map((q,i)=>Math.hypot((q.lo-out.trk[i].lo)*M*CK,(q.la-out.trk[i].la)*M));
t.ok(steps.filter(s=>s<0.01).length===0, 'no point logged twice in the same place');
t.ok(out.trk[0].t===BASE, 'and on the fix\'s own time, not the page clock',
     new Date(out.trk[0].t).toISOString());
t.ok(out.trk.slice(1).every((q,i)=>q.t-out.trk[i].t>=900), 'one second apart, give or take the spike');
t.ok(out.raw, 'raw.sog and raw.lat kept beside the conditioned values');

t.head('speed: the flicker is gone');
const moving=fixes.map((f,i)=>i).filter(i=>i>15 && truth[i].v>1 && !(i>=200&&i<215));
const sErrRaw=moving.map(i=>(fixes[i].sog-truth[i].v)*KT);
const sErrF  =moving.map(i=>(res[i].sog-truth[i].v)*KT);
t.ok(rms(sErrF)<0.5*rms(sErrRaw), 'SOG error less than half the raw',
     rms(sErrF).toFixed(2)+' kn vs '+rms(sErrRaw).toFixed(2));
const jRaw=pct(moving.slice(1).map(i=>Math.abs(fixes[i].sog-fixes[i-1].sog)*KT),0.95);
const jF  =pct(moving.slice(1).map(i=>Math.abs(res[i].sog-res[i-1].sog)*KT),0.95);
t.ok(jF<0.35*jRaw, 'second-to-second change cut to a third', jF.toFixed(2)+' kn vs '+jRaw.toFixed(2));

t.head('course: steady on a leg, and a tack still shows');
const cErrRaw=moving.map(i=>deg(fixes[i].cog*180/Math.PI-truth[i].c));
const cErrF  =moving.map(i=>deg(res[i].cog*180/Math.PI-truth[i].c));
t.ok(pct(cErrF,0.95)<0.5*pct(cErrRaw,0.95), 'COG error (95th pct) under half the raw',
     pct(cErrF,0.95).toFixed(1)+'° vs '+pct(cErrRaw,0.95).toFixed(1)+'°');
const after=res[214].cog*180/Math.PI;
t.ok(deg(after-120)<15, 'within 15° of the new course 8 s after the tack', after.toFixed(0)+'°');
const drift=[...Array(90).keys()].map(k=>k+411);
const dRaw=pct(drift.map(i=>deg((fixes[i].cog-fixes[i-1].cog)*180/Math.PI)),0.95);
const dF  =pct(drift.map(i=>deg((res[i].cog-res[i-1].cog)*180/Math.PI)),0.95);
t.ok(dF<dRaw/3, 'drifting at 0.3 kn the course no longer spins', dF.toFixed(0)+'°/s vs '+dRaw.toFixed(0)+'°/s');

t.head('position: calmer, not behind, and a spike held');
const pIdx=moving.filter(i=>i!==SPIKE&&i!==SPIKE+1);
const pRaw=pIdx.map(i=>Math.hypot(fixes[i].rx-truth[i].x, fixes[i].ry-truth[i].y));
const pF  =pIdx.map(i=>Math.hypot(res[i].x-truth[i].x, res[i].y-truth[i].y));
t.ok(rms(pF)<0.8*rms(pRaw), 'position error below the raw', rms(pF).toFixed(2)+' m vs '+rms(pRaw).toFixed(2));
const leg=[...Array(150).keys()].map(k=>k+40);
const along=leg.map(i=>{ const c=truth[i].c*R;
  return (res[i].x-truth[i].x)*Math.sin(c)+(res[i].y-truth[i].y)*Math.cos(c); });
const bias=along.reduce((s,v)=>s+v,0)/along.length;
t.ok(Math.abs(bias)<0.6, 'no lag on a straight leg (mean along-track error)', bias.toFixed(2)+' m');
const sp=Math.hypot(res[SPIKE].x-truth[SPIKE].x, res[SPIKE].y-truth[SPIKE].y);
t.ok(sp<3, 'the 40 m spike moved the boat less than 3 m', sp.toFixed(1)+' m');

t.head('the dial\'s averaging, chosen from the panel');
/* Feed a steady 2 kn then a steady 4 kn: a 30 s average must sit at the
   mean of what it has seen, a 1 s one at the last fix, and neither may
   move what the calculations read. */
const avg=await p.evaluate(()=>{
  const base=Date.parse('2026-11-07T15:00:00Z'), kn=1/1.94384, r={};
  const feed=(i,sog)=>skMessage(JSON.stringify({updates:[{timestamp:new Date(base+i*1000).toISOString(),
    values:[{path:'navigation.speedOverGround',value:sog},{path:'navigation.courseOverGroundTrue',value:Math.PI/2}]}]}));
  for(let i=0;i<20;i++) feed(i,2*kn);
  for(let i=20;i<30;i++) feed(i,4*kn);
  const k=()=>get('disp.sog')*1.94384;
  CFG.sogAvg=30; gpsDisplay(); r.s30=k();
  CFG.sogAvg=1;  gpsDisplay(); r.s1=k();
  r.nav=get('navigation.speedOverGround')*1.94384;
  CFG.sogAvg=30; gpsDisplay(); r.nav30=get('navigation.speedOverGround')*1.94384;
  r.cog=bearing(dispDeg());
  /* the button: 3 steps on to 5, and it is saved */
  CFG.sogAvg=3; avgPaint(); document.getElementById('avg-sog').click();
  r.btn=document.getElementById('avg-sog').textContent; r.saved=JSON.parse(localStorage.getItem(PREFS_KEY)).sogAvg;
  r.coglist=COG_AVGS.join(',');
  return r; });
t.ok(Math.abs(avg.s30-(20*2+10*4)/30)<0.05, '30 s reads the mean of the last thirty fixes', avg.s30.toFixed(2)+' kn');
t.ok(Math.abs(avg.s1-4)<0.05, '1 s reads the last fix', avg.s1.toFixed(2)+' kn');
t.ok(Math.abs(avg.nav-avg.nav30)<1e-9, 'and the setting does not move what VMG and the line read', avg.nav.toFixed(2)+' kn');
/* the number on the glass eases to a new value over a few frames */
await p.evaluate(()=>{ CFG.sogAvg=30; gpsDisplay(); }); await p.waitForTimeout(2500);
/* readNum eases a step per call - once per millisecond - and a cell not
   on the dial is not being called, so call it the way the frames would */
const cell=await p.evaluate(async ()=>{ let v;
  for(let i=0;i<120;i++){ tickSmoothing(); v=musCell('sog').v(); await new Promise(r=>setTimeout(r,20)); }
  return v; });
t.ok(cell==='2.7', 'the SOG reading on the dial shows the averaged speed', cell);
t.ok(avg.cog==='090°', 'COG reads the averaged course', avg.cog);
t.ok(avg.btn==='5 SEC' && avg.saved===5, 'the panel button steps 3 to 5 and remembers it', avg.btn+' / '+avg.saved);

await t.done(b);
