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
/* Read in the SAME turn as the gun. Between two evaluates the render
   loop gets a frame, and a frame is enough for lineWatch to arm the
   line - after which, on a rig with no course set, the finish IS the
   line and markWatch quite correctly reopens the box on it. One in six
   runs caught that and called it a failure. */
v=await p.evaluate(()=>{ startRace(); paintRace();
  return {txt:$('rp-txt').textContent, open:$('rp-box').classList.contains('on')}; });
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

t.head('BURN is the seconds to burn, and only while you are closing');
/* What is left on the clock, less the time it takes to reach the line
   at this speed on this course. POSITIVE is slack - carry on and you
   are at the line early, with that many seconds to burn off. NEGATIVE
   is late: you cannot make the gun from here, which is the one marked
   red. Only the LABEL was ever checked here, which is how it shipped
   with its closing rate inverted - dashes on every approach, and a
   confident number while the boat sailed away from the line. */
const burn=(sogKt,cogDeg,metres,leftMs)=>p.evaluate(([kt,deg,m,left])=>{
  LINE={pin:{lat:28.8000,lon:-81.2700}, boat:{lat:28.8000,lon:-81.2670}}; saveLine();
  /* south of an east-west line, with the wind out of the north, is the
     pre-start side - so `m` metres to go */
  feedPut('pos.lat', 28.8000-m/111320, 't'); feedPut('pos.lon', -81.2685, 't');
  feedPut('environment.wind.directionTrue', 0, 't');
  feedPut('navigation.speedOverGround', kt/1.94384, 't');
  feedPut('navigation.courseOverGroundTrue', deg/DEG, 't');
  tState='countdown'; tEnd=rnow()+left; rpOpen=true;
  const L=lineData(); paintRace();
  return {burn:L.burn, dist:Math.round(L.dist), shown:$('rp-3').textContent,
          bad:$('rp-3').classList.contains('bad')};
},[sogKt,cogDeg,metres,leftMs]);

/* 100 m out at 5 kt is 38.9 s of sailing, against 120 s of clock */
let B=await burn(5, 0, 100, 120000);
t.ok(B.burn===81, 'straight at the line: the clock less the time to reach it',
     B.burn+' s of '+B.dist+' m');
t.ok(B.shown==='+81', 'eighty one seconds to burn off, and it says so with a plus',
     B.shown);
t.ok(!B.bad, 'not marked - slack is the side of this you want to be on');

/* the same everything, sailing the other way */
B=await burn(5, 180, 100, 120000);
t.ok(B.burn===null, 'sailing AWAY from it there is no time to the line',
     String(B.burn));
t.ok(B.shown==='––', 'so it says nothing rather than something', B.shown);

B=await burn(0.05, 0, 100, 120000);
t.ok(B.burn===null, 'and drifting is not closing either', String(B.burn));

/* 100 m at 5 kt is 39 s of sailing with only 20 s of clock: the gun
   goes while you are still 19 s short of the line */
B=await burn(5, 0, 100, 20000);
t.ok(B.burn===-19, 'not enough clock to get there reads negative', String(B.burn));
t.ok(B.shown==='-19' && B.bad, 'and is marked red: you cannot make the gun from here',
     B.shown+(B.bad?' bad':''));

/* half the distance is half the sailing, so more of the clock is slack */
B=await burn(5, 0, 50, 120000);
t.ok(B.burn===101, 'half the distance, half the time to it', String(B.burn));
B=await burn(10, 0, 100, 120000);
t.ok(B.burn===101, 'and twice the speed comes to the same thing', String(B.burn));

/* The box, not the DOM: a closed box is not repainted, so what the old
   text still says is nothing to do with the reading. */
t.ok(await p.evaluate(()=>{ resetAll(); rpOpen=true; paintRace();
       return lineData().burn===null && $('rp-3').textContent==='––'; }),
     'and with no countdown running there is nothing to burn against');
await p.evaluate(()=>{ resetAll(); paintRace(); });

t.head('the pill and the border carry which way to leave the mark');
/* The one thing about a leg you have to have right before you get
   there. raceStatus() is pure; markNear belongs to the render loop, so
   it is set and asked in the same turn - nothing runs in between. */
const side=(sd,near,done)=>p.evaluate(([sd,near,done])=>{
  COURSE.marks=['rum','gosling']; COURSE.next=done?2:0;
  COURSE.side={rum:sd,gosling:sd}; courseSave();
  tState='racing'; markNear=near;
  const r=raceStatus(); paintRace();
  return {g:r.g, txt:r.txt, pill:$('rp-pill').getAttribute('fill'),
          face:$('rp-face').getAttribute('stroke')};
},[sd,near,done]);
let S=await side('P',false,false);
t.ok(S.g==='rp-g-port', 'a port rounding is red, the whole leg', S.g);
t.ok(S.pill==='url(#rp-g-port)' && S.face==='url(#rp-g-port)',
     'on the pill AND on the box border', S.pill+' / '+S.face);
t.ok(S.txt==='RACING', 'and the pill still says what state it is in', S.txt);
S=await side('S',false,false);
t.ok(S.g==='rp-g-stbd', 'a starboard rounding is green', S.g);
t.ok(S.pill==='url(#rp-g-stbd)' && S.face==='url(#rp-g-stbd)', 'both, again');
S=await side('P',true,false);
t.ok(S.g==='rp-g-port' && S.txt==='RUM',
     'close to it the pill names the mark and keeps the colour',
     S.g+' '+S.txt);
t.ok((await side('S',true,false)).g==='rp-g-stbd', 'the other way too');
S=await side('S',false,true);
t.ok(S.g==='rp-g-racing', 'a finish line has no side, so it is the plain racing green',
     S.g);
S=await side('S',true,true);
t.ok(S.g==='rp-g-mark' && S.txt==='FINISH', 'and closing on it is its own thing',
     S.g+' '+S.txt);
const none=await p.evaluate(()=>{ COURSE.marks=[]; COURSE.next=0; courseSave();
  tState='racing'; markNear=false; return raceStatus().g; });
t.ok(none==='rp-g-racing', 'and so is a race with no course set at all', none);

t.head('at night neither of them is a colour');
/* The night theme is one red so an hour of dark adaptation survives
   looking at the screen. A green pill would undo it for a fact the box
   states in words two lines below. */
const dark=await p.evaluate(()=>{
  COURSE.marks=['rum']; COURSE.next=0; COURSE.side={rum:'S'}; courseSave();
  const read=th=>{ CFG.theme=th; applyTheme();
    const g=getComputedStyle(document.body);
    return {p1:g.getPropertyValue('--port-g1').trim(),
            p2:g.getPropertyValue('--port-g2').trim(),
            s1:g.getPropertyValue('--stbd-g1').trim(),
            s2:g.getPropertyValue('--stbd-g2').trim()}; };
  const out={day:read('day'), night:read('night')};
  CFG.theme='day'; applyTheme(); return out;
});
t.ok(dark.day.p1!==dark.day.s1 && dark.day.p2!==dark.day.s2,
     'by day the two are different colours', JSON.stringify(dark.day));
t.ok(dark.night.p1===dark.night.s1 && dark.night.p2===dark.night.s2,
     'at night they are the same one', JSON.stringify(dark.night));
t.ok(!/#(0E7A43|24D17E)/i.test(JSON.stringify(dark.night)),
     'and no green survives into it', JSON.stringify(dark.night));
t.ok((await side('S',false,false)).g==='rp-g-stbd',
     'the gradient is still chosen by side - the theme decides what it looks like');

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
