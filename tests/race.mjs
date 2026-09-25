/* The race clock: the committee's signal schedule, the flash, what goes
   to the sounder, and the two things the line does on its own. */
import {open, tally, state} from './helpers.mjs';
const t=tally();
const {b,p,posts}=await open(t,{demo:true, status:{buzzer:{available:true,mode:'audio'}}});

t.head('the schedule is the one a committee sounds');
const S=await p.evaluate(()=>{ const o={};
  [301,300,299,241,240,180,120,61,60,45,31,30,20,11,10,9,6,5,4,3,2,1,0,-1]
    .forEach(s=>o[s]=sigFor(s)); return o; });
t.ok([300,240,180,120,60].every(s=>S[s]==='long'), 'a long signal at every whole minute');
t.ok([30,20,10].every(s=>S[s]==='short'), 'short at thirty, twenty and ten');
t.ok([5,4,3,2,1].every(s=>S[s]==='short'), 'short through the last five');
t.ok(S[0]==='gun'&&S[-1]==='gun', 'the gun at zero');
t.ok([301,299,241,45,31,11,9,6].every(s=>S[s]===null),
     'and silence on the seconds between', JSON.stringify(S));

t.head('each one flashes and sounds');
posts.length=0;
for(const k of ['long','short','gun']){
  await p.evaluate(x=>signal(x), k); await p.waitForTimeout(120);
}
const sent=posts.filter(x=>x.path==='/buzz'&&!x.body.arm).map(x=>x.body);
t.ok(sent.length===3, 'three signals, three posts', JSON.stringify(sent));
t.ok(sent[0].kind==='warn'&&sent[1].kind==='warn'&&sent[2].kind==='gun',
     'the gun has its own voice', JSON.stringify(sent.map(x=>x.kind)));
t.ok(sent[2].ms>sent[0].ms, 'and is the longest', sent.map(x=>x.ms).join(','));
const fl=await p.evaluate(()=>{ signal('gun');
  const c=getComputedStyle($('flash'));
  return {on:$('flash').classList.contains('on'), z:+c.zIndex, bg:c.backgroundColor}; });
t.ok(fl.on, 'the face washes with it');
t.ok(fl.z>=100, 'over everything, so a start reaches you through the panel', String(fl.z));

t.head('a countdown walks it, once per second');
const run=await p.evaluate(()=>{
  const realNow=Date.now; let now=realNow.call(Date); Date.now=()=>now;
  const got=[], arms=[], realSig=window.signal, realApi=window.netApi;
  window.signal=k=>{ got.push(k); };
  window.netApi=(path,body)=>{ if(path==='/buzz'&&(body||{}).arm) arms.push(1);
                               return Promise.resolve({ok:true}); };
  tState='idle'; tLeft=180000; sigArmed=false; sigSec=null; tick();
  const t0=now; tEnd=now+180000; tState='countdown';
  for(let ms=180000; ms>=-400; ms-=125){ now=t0+(180000-ms); tick(); }
  Date.now=realNow; window.signal=realSig; window.netApi=realApi;
  return {got, arms:arms.length, state:tState};
});
t.ok(run.got.filter(k=>k==='long').length===3, 'three minutes, three longs',
     run.got.join(','));
t.ok(run.got.filter(k=>k==='short').length===8, 'and eight shorts: 30, 20, 10 and the last five',
     run.got.join(','));
t.ok(run.got.filter(k=>k==='gun').length===1, 'one gun', run.got.join(','));
t.ok(run.state==='racing', 'which starts the race clock');
t.ok(run.arms===1, 'the output is armed once, ahead of the gun', String(run.arms));

t.head('the clock sitting still does not fire twice');
const twice=await p.evaluate(()=>{
  const realNow=Date.now; let now=realNow.call(Date); Date.now=()=>now;
  const got=[]; const realSig=window.signal; window.signal=k=>got.push(k);
  tState='countdown'; sigSec=null; tEnd=now+9600;   /* ceils to 0:10 */
  for(let i=0;i<8;i++) tick();              /* eight ticks on the same second */
  Date.now=realNow; window.signal=realSig; tState='idle';
  return got;
});
t.ok(twice.length===1, 'eight ticks on 0:10 sound once', JSON.stringify(twice));

t.head('after the gun, what a crossing is worth depends on the night');
const start=await p.evaluate(()=>{
  LINE={pin:{lat:28.8000,lon:-81.2700}, boat:{lat:28.8000,lon:-81.2670}}; saveLine();
  COURSE.marks=[]; COURSE.next=0; courseSave();
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  /* Positive distance is the PRE-START side, so south-then-north is the
     direction that counts as starting; the other way is turning back. */
  const S=[28.79975,-81.2690], N=[28.80025,-81.2690];
  const run=(mode, from, to)=>{
    CFG.startMode=mode;
    tState='racing'; tGun=rnow()-60000; lineArmed=false; lineWas=null;
    feed(from[0],from[1]); lineWatch();
    feed(to[0],to[1]);     lineWatch();
    return {since:Math.round((rnow()-tGun)/1000), state:tState};
  };
  const out={ win:run('window',S,N), winBack:run('window',N,S),
              gun:run('gun',S,N) };
  CFG.startMode='gun'; return out;
});
t.ok(start.win.state==='racing', 'crossing does not finish it');
t.ok(start.win.since<5,
     'WINDOW: your crossing is your start, so the clock moves to it',
     start.win.since+' s since the gun');
t.ok(start.winBack.since===60, 'but only onto the course side, not back off it',
     start.winBack.since+' s since the gun');
t.ok(start.gun.since===60,
     'GUN: the gun stands, and crossing a minute late is a minute lost',
     start.gun.since+' s since the gun');

t.head('the race clock, wound on for testing');
/* A five minute sequence and a seventy four minute race is most of an
   evening, and the parts worth watching are minutes apart. The clock is
   stubbed here rather than waited on - what matters is the arithmetic,
   not that a wall clock really ticked. */
const fast=await p.evaluate(()=>{
  const real=Date.now; let T=1e12; Date.now=()=>T;
  const out={};
  raceRate(1);
  let a=rnow(); T+=1000; out.oneX=rnow()-a;
  /* the seam: changing rate must not move a gun that already went */
  const before=rnow(); raceRate(3); out.seam=rnow()-before;
  a=rnow(); T+=1000; out.threeX=rnow()-a;
  /* a countdown burns three times as fast */
  resetAll(); tLeft=60000; startCountdown();
  T+=10000; out.left=Math.round((tEnd-rnow())/1000);
  /* and the gun, once it goes, is a fixed point */
  startRace(); const gun=tGun; T+=5000; out.elapsed=Math.round((rnow()-tGun)/1000);
  raceRate(1); out.gunHeld = tGun===gun;
  T+=5000; out.thenReal=Math.round((rnow()-tGun)/1000);
  /* the demo boat is wound on by the same amount, not a different one */
  /* Nothing else aboard: with a foreign fix in the store the tick would
     stand the fast clock down on its first pass, which is its job. */
  CFG.windDemo=true; delete S['pos.lat']; delete S['pos.lon'];
  raceRate(1); demoT=0; for(let i=0;i<25;i++) windDemoTick(); out.boat1=+demoT.toFixed(3);
  raceRate(3); demoT=0; for(let i=0;i<25;i++) windDemoTick(); out.boat3=+demoT.toFixed(3);
  raceRate(1); CFG.windDemo=false; resetAll();
  /* At rate 1 rnow() advances with Date.now() one for one, so a clock
     that JUMPS - a Pi that boots with no network and then gets NTP -
     carries the race with it rather than leaving it hours behind.
     It does not track Date.now() absolutely: time gained at 3x stays
     gained, which is the same property that keeps a gun where it went.
     Nothing compares the two, so the offset costs nothing and a reload
     clears it. */
  const was=rnow(); T+=7*3600*1000; out.ntp=(rnow()-was)-7*3600*1000;
  /* Put the clock back on the real epoch: it was rebased against a
     stub, and everything after this reads it. */
  Date.now=real; rAt=rBase=Date.now();   /* one read: two leaves a ms of skew */
  return out;
});
t.ok(fast.oneX===1000, 'a second is a second at 1x', fast.oneX+' ms');
t.ok(fast.threeX===3000, 'and three at 3x', fast.threeX+' ms');
t.ok(fast.seam===0, 'changing the rate does not step the clock', fast.seam+' ms');
t.ok(fast.left===30, 'ten seconds of the world is thirty of a 3x countdown',
     fast.left+' s left of 60');
t.ok(fast.elapsed===15, 'and the race clock runs on at the same rate',
     fast.elapsed+' s after 5');
t.ok(fast.gunHeld, 'dropping back to real time leaves the gun where it was');
t.ok(fast.thenReal===20, 'and the clock carries on from there, at one second a second',
     fast.thenReal+' s');
t.ok(Math.abs(fast.boat3-fast.boat1*3)<1e-6,
     'the demo boat sails three times as far, not some other far',
     fast.boat1+' -> '+fast.boat3);
t.ok(fast.ntp===0, 'and a clock correction moves it by exactly as much - a Pi '
     +'that gets NTP hours after boot carries the race with it',
     fast.ntp+' ms of slip');

t.head('the DEMO pill is the speed: off, then three');
const cyc=await p.evaluate(()=>{
  const read=()=>({on:CFG.windDemo, x:RACE_RATE,
    lit:[...$('demo-ff').children].filter(a=>a.classList.contains('on')).length,
    arrows:getComputedStyle($('demo-ff')).display!=='none'});
  demoSet(false); drawDemo();     /* the section above set the flag by hand */
  const out=[read()];
  for(let i=0;i<4;i++){ demoCycle(); out.push(read()); }
  out.push({stored:/rate|fast|speed/i.test(localStorage.getItem('helmPrefs')||'')});
  return out;
});
t.ok(cyc[0].on===false && !cyc[0].arrows, 'off, and no arrows at all',
     JSON.stringify(cyc[0]));
t.ok(cyc[1].on && cyc[1].x===1 && cyc[1].lit===1, 'one tap: on, one arrow',
     JSON.stringify(cyc[1]));
t.ok(cyc[2].x===2 && cyc[2].lit===2, 'two: two', JSON.stringify(cyc[2]));
t.ok(cyc[3].x===3 && cyc[3].lit===3, 'three: three', JSON.stringify(cyc[3]));
t.ok(cyc[4].on===false && cyc[4].x===1,
     'and the fourth is off again, at real time', JSON.stringify(cyc[4]));
t.ok(!cyc[5].stored, 'the speed is never remembered - a panel that came up at 3x '
     +'would hand you a third of the time you sailed');

t.head('and it cannot follow you onto the water');
/* The demo is ON by default, on a real boat too, where it only fills
   what nothing else publishes. So "the demo is on" cannot be what makes
   a fast clock safe; owning the FIX is. */
const safe=await p.evaluate(()=>{
  demoSet(false); demoCycle(); demoCycle(); demoCycle();   /* on, at 3x */
  const before=RACE_RATE;
  /* a real boat starts publishing */
  feedPut('pos.lat', 28.8190, 'sk'); feedPut('pos.lon', -81.2650, 'sk');
  windDemoTick();
  const after=RACE_RATE;
  const lit=[...$('demo-ff').children].filter(a=>a.classList.contains('on')).length;
  demoSet(false); delete S['pos.lat']; delete S['pos.lon'];
  return {before, after, lit, still:CFG.windDemo};
});
t.ok(safe.before===3, 'wound on to 3x with nothing but the demo aboard',
     String(safe.before));
t.ok(safe.after===1, 'and the first real fix puts the clock back to real time',
     String(safe.after));
t.ok(safe.lit===1, 'the pill says so, without being asked', safe.lit+' arrow');

t.head('the two kinds of start, which only a setting tells apart');
/* Saturday's line is shut until zero; Wednesday's is open from the off.
   The SAME crossing, at the same place and moment, means opposite
   things - so the probe runs one fixture through both modes. */
const both=await p.evaluate(()=>{
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  const guns=[]; const realSig=window.signal;
  window.signal=k=>{ guns.push(k); };
  /* south of this line is the pre-start side, north the course side */
  const S=[28.79975,-81.2690], N=[28.80025,-81.2690];
  const run=(mode, left, from, to)=>{
    CFG.startMode=mode;
    tState='countdown'; tEnd=rnow()+left; lineArmed=false; lineWas=null;
    guns.length=0;
    feed(from[0],from[1]); lineWatch();
    feed(to[0],to[1]);     lineWatch();
    return {state:tState, since:rnow()-tGun, guns:guns.slice(),
            armed:lineArmed, left:Math.round((tEnd-rnow())/1000)};
  };
  const out={
    /* a window start, taken early and taken late */
    winEarly: run('window', 240000, S, N),
    winLate:  run('window',  20000, S, N),
    winBack:  run('window',  20000, N, S),
    /* the same crossings on a gun night */
    gunFour:  run('gun',    240000, S, N),
    gunLate:  run('gun',     20000, S, N) };
  /* and with no countdown running, neither mode starts anything */
  CFG.startMode='window'; tState='idle'; lineWas=null;
  feed(S[0],S[1]); lineWatch(); feed(N[0],N[1]); lineWatch();
  out.idle=tState;
  window.signal=realSig; CFG.startMode='gun'; tState='idle';
  return out;
});
t.ok(both.winEarly.state==='racing',
     'WINDOW: crossing with four minutes left is a start - the window is open',
     both.winEarly.state+' with '+both.winEarly.left+' s left');
t.ok(both.winEarly.since>=0 && both.winEarly.since<2000,
     'and the clock runs from the crossing, not from the window\'s end',
     both.winEarly.since+' ms elapsed');
t.ok(both.winEarly.guns.join()==='gun', 'your own gun goes with it',
     JSON.stringify(both.winEarly.guns));
t.ok(both.winEarly.armed===false,
     'and the line is not armed, so the next crossing is not a finish');
t.ok(both.winLate.state==='racing', 'WINDOW: and so is one with twenty seconds left',
     both.winLate.state);
t.ok(both.winBack.state==='countdown',
     'WINDOW: turning back across the line is not a start', both.winBack.state);
t.ok(both.winBack.guns.length===0, 'and sounds nothing');
t.ok(both.gunFour.state==='countdown',
     'GUN: the identical crossing is being over early, and starts nothing',
     both.gunFour.state);
t.ok(both.gunLate.state==='countdown',
     'GUN: still nothing at twenty seconds - the line is shut until zero',
     both.gunLate.state);
t.ok(both.gunLate.guns.length===0, 'and the gun is the clock\'s to fire, not the line\'s');
t.ok(both.idle==='idle', 'and with no countdown running, neither mode starts anything');

t.head('either way, zero starts the race and the line then moves it');
const zero=await p.evaluate(()=>{
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  const S=[28.79975,-81.2690], N=[28.80025,-81.2690];
  const out={};
  const realSig=window.signal; window.signal=()=>{};
  for(const mode of ['gun','window']){
    CFG.startMode=mode;
    tState='countdown'; tEnd=rnow()-1; lineWas=null;
    tick();                                   /* the clock reaches zero */
    out[mode]=tState;
    /* and a crossing a minute later still moves the gun to it */
    tGun=rnow()-60000; lineArmed=false; lineWas=null;
    feed(S[0],S[1]); lineWatch(); feed(N[0],N[1]); lineWatch();
    out[mode+'Moved']=Math.round((rnow()-tGun)/1000);
  }
  window.signal=realSig; CFG.startMode='gun'; tState='idle'; return out;
});
t.ok(zero.gun==='racing' && zero.window==='racing',
     'a countdown that runs out starts the race in both', JSON.stringify(zero));
t.ok(zero.windowMoved<5,
     'WINDOW: the crossing after it is still your start, so the clock moves to it',
     zero.windowMoved+' s since the gun');
t.ok(zero.gunMoved===60,
     'GUN: the gun stands, and crossing a minute late is a minute of lost time',
     zero.gunMoved+' s since the gun');

t.head('the pair says which, on the course sheet with the rest of the start');
/* It lived on the control panel until the start time arrived; the two
   belong together, and the panel is where the boat is set up rather
   than where a race is. */
const pills=await p.evaluate(()=>{
  startModeSet('gun'); renderCourse();
  const r=()=>{ const row=document.querySelector('#course-list .course-row.mode');
    return {title:row.querySelector('b').textContent,
            sub:row.querySelector('span').textContent,
            lit:[...row.querySelectorAll('.sb.on')].map(x=>x.textContent).join()}; };
  const tap=m=>{ document.querySelector(
    '#course-list .sb[data-mode="'+m+'"]').click(); };
  const out={start:r()};
  tap('window'); out.win=r();
  out.stored=JSON.parse(localStorage.getItem('helmPrefs')).startMode;
  /* anywhere on the row is the other one, because a row that only
     answers a 12 mm word is a row you miss in a seaway */
  document.querySelector('#course-list .course-row.mode .lib-main').click();
  out.row=r();
  out.panel=!document.getElementById('st-gun');
  return out;
});
t.ok(pills.start.lit==='GUN', 'a gun start until told otherwise', pills.start.lit);
t.ok(pills.start.title==='SEQUENCE',
     'headed SEQUENCE, not START - the rows either side of it are the start '
     +'time and the start line', pills.start.title);
t.ok(pills.win.lit==='WINDOW', 'tapping WINDOW lights it and puts GUN out',
     pills.win.lit);
t.ok(/OPEN THROUGHOUT/.test(pills.win.sub) && /OPENS AT ZERO/.test(pills.start.sub),
     'and the row says what it does to the line',
     pills.start.sub+' | '+pills.win.sub);
t.ok(pills.stored==='window', 'it is remembered across a restart', String(pills.stored));
t.ok(pills.row.lit==='GUN', 'a tap anywhere on the row is the other one', pills.row.lit);
t.ok(pills.panel, 'and it is gone from the control panel');

t.head('and finishes it, but only when the course is sailed');
const fin=await p.evaluate(()=>{
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  const cross=()=>{ lineWas=null; feed(28.80025,-81.2690); lineWatch();
                    feed(28.79975,-81.2690); lineWatch(); };
  const out={};
  COURSE.marks=['rum','gosling']; COURSE.next=0; courseSave();
  tState='racing'; tGun=rnow()-600000; lineArmed=true; cross();
  out.midRace=tState;
  COURSE.next=2; tState='racing'; lineArmed=true; cross();
  out.done=tState;
  COURSE.marks=[]; COURSE.next=0; courseSave();
  tState='racing'; tGun=rnow()-600000; lineArmed=false; cross();
  out.unarmed=tState;
  tState='idle'; return out;
});
t.ok(fin.midRace==='racing', 'two marks to go, so it is not a finish', JSON.stringify(fin));
t.ok(fin.done==='finished', 'course sailed, and the same crossing finishes it');
t.ok(fin.unarmed==='racing', 'never been clear of the line, so the gun is not a finish');

t.head('rounding advances the course on its own');
const round=await p.evaluate(()=>{
  const m=markOf('rum');
  COURSE.marks=['rum','gosling']; COURSE.next=0; courseSave(); courseReset();
  const at=(dn,de)=>{ put('pos.lat', m.lat+dn/111320);
                      put('pos.lon', m.lon+de/(111320*Math.cos(m.lat/DEG))); };
  tState='racing';
  const out={};
  at(-300,0); courseWatch(); out.far=COURSE.next;      /* outside the arm */
  at(-150,0); courseWatch();                            /* arms */
  at(-30,0);  courseWatch(); out.close=COURSE.next;     /* closest */
  at(-60,0);  courseWatch(); out.backed=COURSE.next;    /* backed off the SAME way */
  at(100,150); courseWatch(); out.past=COURSE.next;     /* well past, and by */
  tState='idle'; return out;
});
t.ok(round.far===0 && round.close===0, 'closing on it is not rounding it',
     JSON.stringify(round));
t.ok(round.backed===0, 'nor is backing off the way you came', JSON.stringify(round));
t.ok(round.past===1, 'going past it is - the range opened AND the bearing swung',
     JSON.stringify(round));

await t.done(b);
