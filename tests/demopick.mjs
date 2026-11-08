/* A race of your own as the demo: the star in the library, what it
   plays, that it survives a reload, that a second tap gives the built-in
   sail back, and that a file off the boat stars as well as one saved
   here. Synthetic races only - this repository is public. */
import {open, tally, ORIGIN} from './helpers.mjs';

const t=tally();

/* A ten-minute sail out of the marina: three minutes tied up, then a
   beat with two tacks, at 1 Hz with a metre of GPS wander. */
let seed=11; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647-0.5; };
const T0=Date.UTC(2026,10,6,22,0,0), M=111320, LAT=28.8183, LON=-81.2620, CK=Math.cos(LAT*Math.PI/180);
const pts=[]; let x=0,y=0;
for(let i=0;i<780;i++){
  if(i>=180){ const leg=Math.floor((i-180)/200), c=(leg%2? 300:30)*Math.PI/180, v=3/1.94384;
              x+=v*Math.sin(c); y+=v*Math.cos(c); }
  pts.push({t:T0+i*1000, la:LAT+(y+rnd())/M, lo:LON+(x+rnd())/(M*CK), s:0, c:0});
}
const gpx='<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>\n'
  +pts.map(q=>`<trkpt lat="${q.la.toFixed(7)}" lon="${q.lo.toFixed(7)}"><time>${new Date(q.t).toISOString()}</time></trkpt>`).join('\n')
  +'\n</trkseg></trk></gpx>';
const INDEX=[{name:'Practice-2026-11-06.gpx', size:gpx.length, at:T0/1000}];

const {b,ctx,p}=await open(t,{status:{gpx:{available:true}},
  routes:{[ORIGIN+'/gpx/index.json*']:r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(INDEX)}),
          [ORIGIN+'/gpx/Practice-2026-11-06.gpx']:r=>r.fulfill({status:200,contentType:'application/gpx+xml',body:gpx})}});
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks'))); await p.waitForTimeout(600);
await p.evaluate(P=>saveRace(P), pts); await p.waitForTimeout(300);

t.head('the library: compact, and it says which sail the demo plays');
await p.click('#trk-lib'); await p.waitForTimeout(1200);
const L=await p.evaluate(()=>({
  h:[...document.querySelectorAll('#lib-list .lib-row')].map(r=>r.offsetHeight),
  stars:[...document.querySelectorAll('#lib-list .star')].map(s=>s.textContent).join(''),
  demo:document.querySelector('#lib-list .lib-demo').textContent}));
t.ok(L.h.length===2 && L.h.every(h=>h<=76), 'a race is one 72 px row now, not 112', L.h.join());
t.ok(L.stars==='☆☆', 'every row has a star, none filled yet', L.stars);
t.ok(/BUILT-IN RACE/.test(L.demo), 'and the built-in race is named as the demo', L.demo);

t.head('star a race saved here');
await p.click('#lib-list .lib-row[data-id] .star'); await p.waitForTimeout(600);
const A=await p.evaluate(()=>{ const D=demoCur(), n=D.dlat.length, out=[];
  for(let i=0;i<=n;i++) out.push(demoTrack(i*D.step));
  let turn=0; for(let i=1;i<out.length;i++) turn=Math.max(turn, Math.abs(wrap180(out[i].crs-out[i-1].crs)));
  return {key:DEMO_PICK&&DEMO_PICK.key, mins:demoLen()/60, first:out[0], last:out[out.length-1], turn,
          stars:[...document.querySelectorAll('#lib-list .star')].map(s=>s.textContent).join(''),
          demo:document.querySelector('#lib-list .lib-demo').textContent}; });
t.ok(/^db:/.test(A.key||''), 'it is the demo now', A.key);
t.ok(A.stars.indexOf('★')>=0 && /2026-11-06/.test(A.demo), 'the star fills and the top line names it', A.stars+' '+A.demo);
t.ok(A.mins>9 && A.mins<10.5, 'the three minutes at the dock are trimmed off', A.mins.toFixed(1)+' min');
const dEnd=Math.hypot((A.last.lat-pts[779].la)*M,(A.last.lon-pts[779].lo)*M*CK);
t.ok(dEnd<15, 'and it ends where the race ended', dEnd.toFixed(1)+' m');
t.ok(A.turn<=60, 'the course never swings more than 60 degrees in a step', A.turn.toFixed(0)+'°');

t.head('the demo plays it');
await p.evaluate(()=>{ closeLib(); demoSet(true); }); await p.waitForTimeout(1200);
const P=await p.evaluate(()=>({la:get('pos.lat'), lo:get('pos.lon'), kt:get('navigation.speedOverGround')*1.94384}));
const dStart=Math.hypot((P.la-pts[180].la)*M,(P.lo-pts[180].lo)*M*CK);
t.ok(dStart<25, 'the boat is where this race started, not on last season\'s course', dStart.toFixed(1)+' m');
t.ok(P.kt>2 && P.kt<4, 'at the speed it sailed', P.kt.toFixed(1)+' kt');

t.head('it is remembered');
await p.reload(); await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle());
t.ok(await p.evaluate(()=>!!DEMO_PICK && /^db:/.test(DEMO_PICK.key) && demoCur()!==DEMO_TRACK),
     'after a reload the starred race is still the demo');

t.head('a file off the boat, and back to the built-in');
await p.evaluate(()=>{ openApp(APPS.find(a=>a.id==='tracks')); }); await p.waitForTimeout(600);
await p.click('#trk-lib'); await p.waitForTimeout(1200);
const qr=()=>p.evaluate(()=>$('qr-sheet').classList.contains('on'));
await p.click('#lib-list .lib-link .star'); await p.waitForTimeout(1200);
t.ok(await p.evaluate(()=>DEMO_PICK && DEMO_PICK.key==='file:Practice-2026-11-06.gpx'),
     'starring the boat\'s file fetches it and makes it the demo');
t.ok(!await qr(), 'without opening the QR code a tap on that row would');
t.ok(await p.evaluate(()=>[...document.querySelectorAll('#lib-list .star.on')].length===1),
     'one star at a time');
await p.click('#lib-list .lib-link .star'); await p.waitForTimeout(600);
t.ok(await p.evaluate(()=>DEMO_PICK===null && demoCur()===DEMO_TRACK && !localStorage.getItem('demoPick')),
     'a second tap on the filled star puts the built-in race back');

t.head('what is not a sail');
t.ok(await p.evaluate(P=>demoEncode(P.slice(0,60))===null, pts), 'a minute of track is refused');
t.ok(await p.evaluate(()=>gpxPoints('<gpx><trk><trkseg><trkpt lat="28.8" lon="-81.2"><time>2026-11-06T22:00:00Z</time></trkpt></trkseg></trk></gpx>').length===1),
     'the GPX reader takes a point with its time');

await t.done(b);
