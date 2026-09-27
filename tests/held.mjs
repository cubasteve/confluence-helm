/* The race the last countdown left behind: set aside rather than
   cleared, and never lost without being asked. */
import {open, tally, fling} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});

const card=()=>p.evaluate(()=>({on:$('held').classList.contains('on'),
  done:$('held').classList.contains('done'), t:$('held-t').textContent,
  s:$('held-s').textContent, no:$('held-no').textContent,
  held:!!HELD, trk:TRK.length,
  disk:!!localStorage.getItem('racetrack.held')}));
/* a track that looks like a race, and a gun to say it carried one */
const seed=(n,raced)=>p.evaluate(([n,raced])=>{
  const t0=Date.parse('2026-09-23T21:40:00Z');
  TRK=[]; for(let i=0;i<n;i++) TRK.push({t:t0+i*1000, la:28.8+i*0.00012,
    lo:-81.27, s:3.0, c:0});
  localStorage.setItem('racetrack',JSON.stringify(TRK));
  if(raced) startRace();
  tState='idle';
}, [n,raced]);

t.head('an aborted start is cleared without a question');
await p.evaluate(()=>{ heldDrop(); trackClear(); });
await seed(400,false);
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(400);
let v=await card();
t.ok(!v.on && v.trk<=1, 'no card, and the track is gone', JSON.stringify(v));
await p.evaluate(()=>resetAll());

t.head('a track that carried a race is held instead');
await seed(600,true);
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(400);
v=await card();
t.ok(v.on && v.held, 'the card is up', JSON.stringify(v));
t.ok(v.trk<=1, 'and the new countdown starts on a clean track', JSON.stringify(v));
t.ok(v.disk, 'the held race is on disk, so a reload does not lose it');
t.ok(/NM · .*:/.test(v.s), 'the card says what it is holding', v.s);
t.ok((await p.evaluate(()=>tState))==='countdown', 'with the clock running behind it');

t.head('discard is armed');
await p.evaluate(()=>$('held-no').click()); await p.waitForTimeout(200);
v=await card();
t.ok(v.no==='SURE?' && v.held, 'one tap arms it and keeps the race', v.no);
await p.evaluate(()=>$('held-no').click()); await p.waitForTimeout(250);
v=await card();
t.ok(!v.held && !v.disk && v.done, 'the second discards it', JSON.stringify(v));
await p.waitForTimeout(2800);
t.ok(!(await card()).on, 'and the card leaves by itself');

t.head('save puts it in the library, whole');
await p.evaluate(()=>{ resetAll(); heldDrop(); });
await seed(600,true);
const before=await p.evaluate(()=>dbAll().then(r=>r.length));
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(400);
await p.evaluate(()=>$('held-yes').click()); await p.waitForTimeout(900);
v=await card();
const after=await p.evaluate(()=>dbAll().then(r=>r.map(x=>({n:x.n,nm:x.nm,secs:x.secs}))));
t.ok(!v.held && !v.disk, 'the hold is released', JSON.stringify(v));
t.ok(after.length===before+1, 'one more race in the library', before+' -> '+after.length);
t.ok(after.some(r=>r.n===600), 'and it is the held one, every point of it',
     JSON.stringify(after));
t.ok(/^SAVED · /.test(v.t), 'the card says so', v.t);

t.head('a race already saved is not asked about');
await p.waitForTimeout(2800);
await p.evaluate(()=>{ resetAll(); heldDrop(); });
await seed(600,true);
await p.evaluate(()=>saveRace()); await p.waitForTimeout(500);
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(400);
v=await card();
t.ok(!v.on && !v.held, 'saved from the map, so the countdown just clears',
     JSON.stringify(v));

t.head('but the points added after that save are');
await p.evaluate(()=>{ resetAll(); heldDrop(); });
await seed(600,true);
await p.evaluate(()=>saveRace()); await p.waitForTimeout(500);
await p.evaluate(()=>{ const t=TRK[TRK.length-1].t;
  for(let i=1;i<=50;i++) TRK.push({t:t+i*1000, la:28.9+i*0.0001, lo:-81.27, s:3, c:0}); });
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(400);
t.ok((await card()).held, 'sailing on after a save counts as unsaved again');

t.head('and it survives a reload');
await p.reload(); await p.waitForTimeout(1600);
await p.evaluate(()=>bootSettle()); await p.waitForTimeout(600);
v=await card();
t.ok(v.on && v.held, 'the card is back up', JSON.stringify(v));
await p.evaluate(()=>{ heldDrop(); heldPaint(); });

t.head('a locked helm does not move, and only the hold unlocks it');
/* The lock was an overlay and nothing else: a transparent box on top of
   the page, which stops anything bound to an element underneath it. The
   judge is bound to WINDOW in the capture phase, so it never saw the
   overlay and every swipe went straight through. */
await p.evaluate(()=>{ heldDrop(); heldPaint(); PAGE_I=1; layoutPages();
                       closePanel(); closeApps(); lockOn(); });
await p.waitForTimeout(400);
const where=()=>p.evaluate(()=>({page:PAGE_I,
  panel:panel.classList.contains('open'), dock:apps.classList.contains('open'),
  locked:$('lock').classList.contains('on')}));
t.ok((await where()).locked, 'locked');
for(const [n,dx,dy,sx,sy,what] of [
      [3,-260,0,480,540,'three fingers sideways does not page'],
      [1,0,260,480,540,'a pull down does not bring the panel'],
      [1,0,260,480,70,'nor does one from the very top edge'],
      [1,0,-260,480,540,'a pull up does not bring the dock']]){
  await fling(p,n,dx,dy,sx,sy);
  const w=await where();
  t.ok(w.page===1 && !w.panel && !w.dock, what, JSON.stringify(w));
}
/* and the one gesture that must still work */
const c=await p.evaluate(()=>{ const r=$('stage').getBoundingClientRect();
  return {x:r.x+540, y:r.y+540}; });
await p.mouse.move(c.x,c.y); await p.mouse.down();
await p.waitForTimeout(2400); await p.mouse.up(); await p.waitForTimeout(400);
t.ok(!(await where()).locked, 'two seconds anywhere on it unlocks');
await fling(p,3,-260,0);
t.ok((await where()).page===2, 'and the helm moves again', String((await where()).page));
await p.evaluate(()=>{ PAGE_I=1; layoutPages(); });

await t.done(b);
