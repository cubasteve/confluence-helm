/* The RACE pill and the box it opens into: what it says at each point of
   a race, and what the two faces carry. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});

const pill=()=>p.evaluate(()=>({txt:$('rp-txt').textContent,
  open:$('rp-box').classList.contains('on'),
  r2l:$('rp-r2-l').textContent, r2:$('rp-r2').textContent,
  /* each slot is a header, a value and a unit */
  c0:[$('rp-c0-l').textContent, $('rp-c0').textContent],
  s2:[$('rp-2-l').textContent,  $('rp-2').textContent, $('rp-2-u').textContent],
  s3:[$('rp-3-l').textContent,  $('rp-3').textContent]}));

t.head('it says where in the race you are');
await p.evaluate(()=>{ LINE={pin:{lat:28.8000,lon:-81.2700},
  boat:{lat:28.8000,lon:-81.2670}}; saveLine();
  COURSE.marks=[]; COURSE.next=0; courseSave();
  put('pos.lat',28.7990); put('pos.lon',-81.2685);
  put('environment.wind.directionTrue',0);
  resetAll(); paintRace(); });
t.ok((await pill()).txt==='RACE', 'idle', (await pill()).txt);
await p.evaluate(()=>{ startCountdown(); paintRace(); });
let v=await pill();
t.ok(v.txt==='COUNTDOWN', 'the countdown', v.txt);
t.ok(v.open, 'which opens the box by itself');
t.ok(/LINE BIAS/.test(v.r2l), 'onto the line face', v.r2l);
t.ok(v.s2[0]==='LINE' && /^\d+$/.test(v.s2[1]), 'with the range to it',
     JSON.stringify(v.s2));
t.ok(v.s3[0]==='BURN', 'and the seconds in hand beside it', JSON.stringify(v.s3));
t.ok(/^[\d.]+$/.test(v.c0[1]), 'and the reading the box covered, carried along',
     JSON.stringify(v.c0));
await p.evaluate(()=>{ startRace(); paintRace(); });
v=await pill();
t.ok(v.txt==='RACING', 'after the gun', v.txt);
t.ok(!v.open, 'and the gun closes the box - the numbers are the face again');

t.head('on a leg it carries the mark');
await p.evaluate(()=>{ COURSE.marks=['rum','gosling']; COURSE.next=0; courseSave();
  COURSE.side={rum:'S'}; rpOpen=true; paintRace(); });
v=await pill();
t.ok(/MARK 1 OF 2/.test(v.r2l), 'which mark of how many', v.r2l);
t.ok(/STBD/.test(v.r2l), 'and which side to leave it', v.r2l);
t.ok(/RUM/.test(v.r2), 'named', v.r2);
t.ok(/GOSLING/.test(v.r2), 'with what follows it', v.r2);
await p.evaluate(()=>{ COURSE.next=2; paintRace(); });
v=await pill();
t.ok(/LAST LEG/.test(v.r2l)&&/FINISH LINE/.test(v.r2), 'the last leg is the line',
     v.r2l+' / '+v.r2);

t.head('closing on a mark it says so, and lets go again');
const near=await p.evaluate(()=>{
  const m=markOf('rum');
  COURSE.marks=['rum']; COURSE.next=0; courseSave(); markNear=false; markNearIdx=-1;
  tState='racing'; tGun=Date.now()-60000;
  const at=d=>{ put('pos.lat', m.lat-d/111320); put('pos.lon', m.lon); };
  const out={};
  at(500); markWatch(); paintRace(); out.far=$('rp-txt').textContent;
  at(200); markWatch(); paintRace(); out.close=$('rp-txt').textContent;
  out.opened=rpOpen;
  at(500); markWatch(); paintRace(); out.away=$('rp-txt').textContent;
  tState='idle'; return out;
});
t.ok(near.far==='RACING', 'well off it, just racing', near.far);
t.ok(near.close==='RUM', 'inside 300 m it becomes the mark', near.close);
t.ok(near.opened, 'and the box opens to meet you');
t.ok(near.away==='RACING', 'back outside 350 m it lets go - no flapping',
     near.away);

t.head('and the finish');
await p.evaluate(()=>{ tState='finished'; tFinal=2895000; paintRace(); });
t.ok((await pill()).txt==='FINISHED', 'once it is over', (await pill()).txt);

t.head('the pill is a button in every state');
/* Pointer events, not a click: the pill claims the gesture on
   pointerdown so the judge cannot also read the tap as a swipe. */
const tap=await p.evaluate(()=>{
  const hit=()=>{ const el=$('rp-btn');
    el.dispatchEvent(new PointerEvent('pointerdown',
      {pointerId:1, clientX:540, clientY:170, bubbles:true, pointerType:'touch'}));
    el.dispatchEvent(new PointerEvent('pointerup',
      {pointerId:1, clientX:540, clientY:170, bubbles:true, pointerType:'touch'})); };
  resetAll(); paintRace(); const was=rpOpen;
  hit(); const a=rpOpen;
  hit(); return {was, a, b:rpOpen};
});
t.ok(tap.a!==tap.was && tap.b===tap.was, 'tap opens it, tap closes it',
     JSON.stringify(tap));

await t.done(b);
