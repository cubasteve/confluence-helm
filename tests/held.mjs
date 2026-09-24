/* The race the last countdown left behind: set aside rather than
   cleared, and never lost without being asked. */
import {open, tally} from './helpers.mjs';
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

await t.done(b);
