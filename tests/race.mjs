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

t.head('the line starts the race');
const start=await p.evaluate(()=>{
  LINE={pin:{lat:28.8000,lon:-81.2700}, boat:{lat:28.8000,lon:-81.2670}}; saveLine();
  COURSE.marks=[]; COURSE.next=0; courseSave();
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  /* Onto the course side, a minute after the gun. Positive distance is
     the PRE-START side, so this is the direction that counts as
     starting - the other way is coming back for a recall. */
  tState='racing'; tGun=Date.now()-60000; lineArmed=false; lineWas=null;
  feed(28.79975,-81.2690); lineWatch();
  feed(28.80025,-81.2690); lineWatch();
  const moved=Math.round((Date.now()-tGun)/1000);
  /* the same two fixes the other way round: back over the line is a
     boat returning, not one starting */
  tState='racing'; tGun=Date.now()-60000; lineArmed=false; lineWas=null;
  feed(28.80025,-81.2690); lineWatch();
  feed(28.79975,-81.2690); lineWatch();
  return {gunMovedBy:moved, back:Math.round((Date.now()-tGun)/1000), state:tState};
});
t.ok(start.state==='racing', 'crossing does not finish it');
t.ok(start.gunMovedBy<5, 'it moves the gun to the crossing - a recall costs you nothing',
     start.gunMovedBy+' s since the gun');
t.ok(start.back===60, 'and crossing back the other way does not',
     start.back+' s since the gun');

t.head('and finishes it, but only when the course is sailed');
const fin=await p.evaluate(()=>{
  const feed=(la,lo)=>{ put('pos.lat',la); put('pos.lon',lo);
                        put('environment.wind.directionTrue',0); };
  const cross=()=>{ lineWas=null; feed(28.80025,-81.2690); lineWatch();
                    feed(28.79975,-81.2690); lineWatch(); };
  const out={};
  COURSE.marks=['rum','gosling']; COURSE.next=0; courseSave();
  tState='racing'; tGun=Date.now()-600000; lineArmed=true; cross();
  out.midRace=tState;
  COURSE.next=2; tState='racing'; lineArmed=true; cross();
  out.done=tState;
  COURSE.marks=[]; COURSE.next=0; courseSave();
  tState='racing'; tGun=Date.now()-600000; lineArmed=false; cross();
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
