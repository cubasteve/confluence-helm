/* The course sheet: what a tap on a row means, what the numbers say,
   what EDIT changes, and what the line row is for. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
/* A map needs a track to be a map. The demo only records while a race
   is on, so the probe lays one down itself - a short leg up the lake,
   through the middle of the club's marks. Re-laid wherever something
   clears it: startCountdown() sets the old race aside, and setting a
   race aside takes the track with it. */
const seed=()=>p.evaluate(()=>{ const t0=Date.now()-600e3;
  TRK=[...Array(120).keys()].map(i=>({t:t0+i*5000, la:28.8190+i*0.00012,
    lo:-81.2650-i*0.00004, s:2.6, c:0.3}));
  drawMap(shownTrack()); });
await seed();
await p.waitForTimeout(400);

/* Everything the sheet says, in the sheet's own order. */
const sheet=()=>p.evaluate(()=>[...document.querySelectorAll('#course-list .course-row')]
  .map(r=>({mark:r.dataset.mark||null, line:!!r.dataset.line, gun:!!r.dataset.gun,
            seq:r.querySelector('.seq').textContent.trim(),
            name:r.querySelector('b').textContent,
            sub:r.querySelector('.lib-main span').textContent,
            in:r.classList.contains('in'), next:r.classList.contains('next'),
            side:[...r.querySelectorAll('.sb.on')].map(s=>s.dataset.side)[0]||null,
            del:!!r.querySelector('.del'), undo:!!r.querySelector('.del.undo'),
            grip:!!r.querySelector('.grip')})));
const tap=async(sel)=>{ await p.click(sel); await p.waitForTimeout(250); };
const row=m=>`#course-list .course-row[data-mark="${m}"]`;
const course=()=>p.evaluate(()=>({marks:COURSE.marks.slice(), next:COURSE.next,
                                  side:Object.assign({},COURSE.side||{})}));

t.head('the sheet opens on the course button, and closes on it');
await tap('#trk-course');
let S=await sheet();
t.ok(await p.evaluate(()=>$('t-course').classList.contains('on')), 'it is up');
const marks=x=>x.filter(r=>r.mark), lineOf=x=>x.find(r=>r.line);
t.ok(marks(S).length===10 && S.length===13,
     'the start time, the sequence, the line and all ten club marks',
     String(S.length));
t.ok(/START . FINISH LINE/.test(lineOf(S).name), 'the line has its own row',
     lineOf(S).name);
t.ok(lineOf(S).sub==='FLAG – BALL', 'and says which two marks it is', lineOf(S).sub);
t.ok(/^\d\d \d\d\.\d\d\d[NS] · \d\d\d \d\d\.\d\d\d[EW]$/.test(marks(S)[0].sub),
     'every mark row carries its position', marks(S)[0].sub);
await tap('#course-done');
t.ok(!await p.evaluate(()=>$('t-course').classList.contains('on')),
     'and DONE puts it away');
await tap('#trk-course');

t.head('a tap puts a mark in the course, and the numbers are the order');
await p.evaluate(()=>{ COURSE.marks=[]; COURSE.next=0; COURSE.side={}; courseSave(); renderCourse(); });
await tap(row('rum')); await tap(row('gosling')); await tap(row('cb12'));
S=await sheet();
const seqOf=id=>S.find(r=>r.mark===id).seq;
t.ok(seqOf('rum')==='1'&&seqOf('gosling')==='2'&&seqOf('cb12')==='3',
     'first tapped is first rounded', [seqOf('rum'),seqOf('gosling'),seqOf('cb12')].join(''));
t.ok(S.find(r=>r.mark==='rum').in, 'a mark in the course is marked as in');
t.ok(S.find(r=>r.mark==='ball').seq==='' && !S.find(r=>r.mark==='ball').in,
     'and one that is not carries no number');
let C=await course();
t.ok(C.marks.join()==='rum,gosling,cb12', 'the course itself agrees', C.marks.join());

t.head('and a second tap takes it out, and the rest close up');
await tap(row('rum'));
S=await sheet(); C=await course();
t.ok(C.marks.join()==='gosling,cb12', 'the mark is gone', C.marks.join());
t.ok(S.find(r=>r.mark==='gosling').seq==='1'&&S.find(r=>r.mark==='cb12').seq==='2',
     'and what was second is now first');
t.ok(S.find(r=>r.mark==='rum').seq==='', 'the one taken out has no number');
await tap(row('rum'));                    /* back on the end, not where it was */
C=await course();
t.ok(C.marks.join()==='gosling,cb12,rum', 'it comes back last, not where it was', C.marks.join());

t.head('P or S says which side to leave it, and is not a tap on the row');
S=await sheet();
t.ok(S.find(r=>r.mark==='gosling').side==='P', 'port until told otherwise');
t.ok(S.find(r=>r.mark==='ball').side===null, 'a mark out of the course is asked no side');
await p.click(row('gosling')+' .sb[data-side="S"]'); await p.waitForTimeout(250);
S=await sheet(); C=await course();
t.ok(S.find(r=>r.mark==='gosling').side==='S', 'the S lights');
t.ok(C.side.gosling==='S', 'and is kept with the course', String(C.side.gosling));
t.ok(C.marks.join()==='gosling,cb12,rum', 'and the mark is still in the course', C.marks.join());
await p.evaluate(()=>drawMap(shownTrack())); await p.waitForTimeout(250);
t.ok(await p.evaluate(()=>[...$('t-path').querySelectorAll('text')]
       .some(x=>x.textContent==='S')), 'the map letters it too');

t.head('the mark being sailed to is the one lit');
S=await sheet();
t.ok(S.find(r=>r.mark==='gosling').next, 'the first, before any is rounded');
await p.evaluate(()=>{ courseAdvance(); renderCourse(); }); await p.waitForTimeout(200);
S=await sheet();
t.ok(!S.find(r=>r.mark==='gosling').next && S.find(r=>r.mark==='cb12').next,
     'and the next one once that is behind');
t.ok(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)===3,
     'all three are on the map',
     String(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)));
await p.evaluate(()=>{ COURSE.next=0; courseSave(); renderCourse(); });

t.head('taking out a mark already rounded does not leave the course past its end');
await p.evaluate(()=>{ COURSE.next=3; courseSave(); renderCourse(); });
await tap(row('rum'));
C=await course();
t.ok(C.marks.length===2 && C.next<=2, 'next is pulled back to the end',
     C.next+' of '+C.marks.length);
t.ok(C.side.gosling==='S' && !('rum' in C.side), 'and the side of the one removed goes with it',
     JSON.stringify(C.side));
await p.evaluate(()=>{ COURSE.next=0; courseSave(); renderCourse(); });

t.head('CLEAR empties the course and leaves the marks alone');
await p.evaluate(()=>{ COURSE.marks=['gosling','cb12','rum']; COURSE.next=1;
                       courseSave(); renderCourse(); });
await tap('#course-clr');
C=await course(); S=await sheet();
t.ok(C.marks.length===0 && C.next===0, 'nothing left to sail', C.marks.join()+' @'+C.next);
t.ok(marks(S).length===10 && marks(S).every(r=>r.seq===''),
     'the marks are all still there, unnumbered');
await tap(row('gosling')); await tap(row('cb12'));
await p.evaluate(()=>{ COURSE.side={gosling:'S'}; courseSave(); renderCourse(); });

t.head('EDIT is for the list, not the course');
await tap('#course-edit');
S=await sheet();
t.ok(await p.evaluate(()=>courseEdit), 'edit mode is on');
t.ok(marks(S).every(r=>r.grip), 'every mark gets a grip to drag by');
t.ok(!S.find(r=>r.mark==='cb8').del, 'a club mark nobody has touched gets no button');
await tap(row('cb8'));
t.ok(await p.evaluate(()=>MK&&MK.id==='cb8'), 'a tap opens the mark instead');
t.ok((await course()).marks.join()==='gosling,cb12',
     'and does not add it to the course', (await course()).marks.join());
await p.evaluate(()=>mkClose()); await p.waitForTimeout(250);

t.head('a corrected club mark can be put back');
await p.evaluate(()=>{ MARK_MOVES={cb8:{lat:28.8200,lon:-81.2900}}; markMovesSave();
                       const m=markOf('cb8'); m.lat=28.8200; m.lon=-81.2900; renderCourse(); });
S=await sheet();
t.ok(S.find(r=>r.mark==='cb8').undo, 'it gets the way back to the book');
t.ok(await p.evaluate(()=>document
       .querySelector('#course-list .course-row[data-mark="cb8"] .lib-main span')
       .classList.contains('moved')), 'and its position is marked as corrected');
await p.evaluate(()=>{ MARK_MOVES={}; markMovesSave(); });

t.head('the line row says which line is in force');
await p.evaluate(()=>{ courseEdit=false; $('course-edit').classList.remove('on');
                       LINE={pin:{lat:28.8190,lon:-81.2648},boat:{lat:28.8195,lon:-81.2622}};
                       saveLine(); ['pin','boat'].forEach(k=>$('ping-'+k).classList.add('set'));
                       renderCourse(); });
await p.waitForTimeout(200);
S=await sheet();
t.ok(/PINGED/.test(lineOf(S).sub), 'a pinged line says so', lineOf(S).sub);
t.ok(await p.evaluate(()=>lineEnds().pinged), 'and is the line the readings use');
await tap('#course-list .course-row.line');
S=await sheet();
t.ok(lineOf(S).sub==='FLAG – BALL',
     'tapping it drops the pings and goes back to the club marks', lineOf(S).sub);
t.ok(await p.evaluate(()=>!lineEnds().pinged
       && !$('ping-pin').classList.contains('set')
       && !$('ping-boat').classList.contains('set')),
     'and the ping buttons go out with them');

t.head('the scheduled gun: typed once, and it starts itself');
/* A club race has a time on the sailing instructions. Typing it beats
   watching a clock for the moment to press a button with a boat to
   sail at the same time. */
const gunRow=()=>p.evaluate(()=>{ const r=document.querySelector('.course-row.gun');
  return {b:r.querySelector('b').textContent, sub:r.querySelector('span').textContent,
          set:r.classList.contains('in')}; });
/* Typed on the pad, and the half of the day chosen on its pair - the
   same two taps a thumb makes. */
const type=async (d,mer)=>{ await p.evaluate(()=>gnOpen()); await p.waitForTimeout(250);
  await p.evaluate(([d,mer])=>{ GN.v=''; gnPaint();
    if(mer) $('gn-'+mer).click();
    for(const c of d) document.querySelector('#gn-kb button[data-c="'+c+'"]').click();
  }, [d,mer||null]);
  await p.evaluate(()=>gnSet()); await p.waitForTimeout(250);
  return p.evaluate(()=>({at:GUNAT, msg:$('gn-msg').textContent,
                          open:$('course-gun').style.display!=='none',
                          h:GUNAT===null?null:new Date(GUNAT).getHours(),
                          m:GUNAT===null?null:new Date(GUNAT).getMinutes()})); };
/* a time 40 minutes out, whatever o'clock it is where this runs */
const want=await p.evaluate(()=>{ const d=new Date(Date.now()+40*60000), h=d.getHours();
  return {d:String((h%12)||12)+String(d.getMinutes()).padStart(2,'0'),
          mer:h<12?'am':'pm', hhmm:gunTxt(d.getTime())}; });
await p.evaluate(()=>{ GUNAT=null; gunSave(); renderCourse(); });
let G=await gunRow();
t.ok(/START TIME/.test(G.b) && !G.set, 'unset, the row invites one', G.b);
let r=await type(want.d, want.mer);
t.ok(r.at!==null && !r.open, 'four digits and it is armed', String(r.at));
G=await gunRow();
t.ok(G.b==='GUN AT '+want.hhmm, 'the row says when the gun is', G.b);
t.ok(/COUNTDOWN STARTS/.test(G.sub), 'and when the countdown will start itself', G.sub);
t.ok(await p.evaluate(()=>raceStatus().txt)===want.hhmm,
     'and the pill carries it, so an armed gun shows on the face',
     await p.evaluate(()=>raceStatus().txt));

t.head('what it refuses');
const gone=await p.evaluate(()=>{ const d=new Date(Date.now()-60*60000), h=d.getHours();
  return {d:String((h%12)||12)+String(d.getMinutes()).padStart(2,'0'),
          mer:h<12?'am':'pm'}; });
r=await type(gone.d, gone.mer);
t.ok(/HAS GONE/.test(r.msg) && r.open,
     'a time that has already passed, rather than arming for tomorrow', r.msg);
t.ok(/[AP]M/.test(r.msg), 'and says it back the way it is said', r.msg);
r=await type('1399','pm');
t.ok(/NOT A TIME/.test(r.msg) && r.open, 'and 13:99 on a twelve hour clock', r.msg);
r=await type('099','am');
t.ok(/NOT A TIME/.test(r.msg) && r.open, 'and a zero hour - there is no 0 on a clock face',
     r.msg);
r=await type('18','pm');
t.ok(/THREE OR FOUR DIGITS/.test(r.msg) && r.open, 'and half of one', r.msg);
await p.evaluate(()=>gnClose());

t.head('noon and midnight, which the clock face gets backwards');
/* 12 PM is the middle of the day and 12 AM is the start of it, and
   neither is twelve hours on from the other eleven. */
const at=async (d,mer)=>{ await p.evaluate(()=>{ GUNAT=null; gunSave(); });
  await p.evaluate(()=>gnOpen()); await p.waitForTimeout(200);
  return p.evaluate(([d,mer])=>{ GN.v=d; GN.pm=(mer==='pm'); gnPaint();
    /* the refusal of a time already gone is not what is under test */
    const real=Date.now; Date.now=()=>0;
    gnSet();
    const out = GUNAT===null ? {msg:$('gn-msg').textContent}
              : {h:new Date(GUNAT).getHours(), m:new Date(GUNAT).getMinutes()};
    Date.now=real; GUNAT=null; gunSave(); gnClose(); return out; }, [d,mer]); };
t.ok(JSON.stringify(await at('1225','pm'))==='{"h":12,"m":25}',
     '12:25 PM is twenty five past noon', JSON.stringify(await at('1225','pm')));
t.ok(JSON.stringify(await at('1225','am'))==='{"h":0,"m":25}',
     'and 12:25 AM is twenty five past midnight',
     JSON.stringify(await at('1225','am')));
t.ok(JSON.stringify(await at('625','pm'))==='{"h":18,"m":25}',
     '6:25 PM is eighteen twenty five', JSON.stringify(await at('625','pm')));
t.ok(JSON.stringify(await at('625','am'))==='{"h":6,"m":25}',
     'and 6:25 AM is six twenty five', JSON.stringify(await at('625','am')));
t.ok(JSON.stringify(await at('1125','pm'))==='{"h":23,"m":25}',
     'eleven at night is the last hour, not the thirteenth',
     JSON.stringify(await at('1125','pm')));

t.head('the pad a thumb can hit');
const pad=await p.evaluate(()=>{ gnOpen();
  const k=[...$('gn-kb').querySelectorAll('button')];
  const r=k[0].getBoundingClientRect();
  const out={n:k.length, h:Math.round(r.height), w:Math.round(r.width),
             /* 430 px of phone showing 1080 px of layout */
             onPhone:Math.round(r.height*430/1080),
             set:k.filter(x=>/SET/.test(x.textContent)).length,
             bar:[...document.querySelectorAll('#course-gun .cbtn')]
                   .map(x=>x.textContent)};
  gnClose(); return out; });
t.ok(pad.n===12, 'ten digits, a backspace and a SET', String(pad.n));
t.ok(pad.onPhone>=44, 'and a key is 44 px on a phone, which is the smallest '
     +'thing worth asking a thumb to hit', pad.h+' px -> '+pad.onPhone);
t.ok(pad.set===1, 'ONE set, on the pad where the last digit leaves your thumb',
     String(pad.set));
t.ok(pad.bar.join('|')==='BACK|NO START TIME',
     'and the bar says what it does rather than CLEAR, which is what '
     +'backspace does to a digit', pad.bar.join('|'));

t.head('and what it does when the moment comes');
const fired=await p.evaluate(()=>{
  const real=Date.now;
  const set=t=>{ Date.now=()=>t; rAt=rBase=t; };
  const out={};
  /* armed, and the clock walked up to five minutes before it */
  const at=real()+40*60000; GUNAT=at; gunSave(); resetAll();
  set(at-6*60000); gunWatch(); out.early=tState;
  set(at-CFG.startMins*60000+200); gunWatch();
  out.fired=tState; out.left=Math.round((tEnd-rnow())/1000);
  out.cleared=GUNAT===null;
  /* set INSIDE the window: it starts at once and still ends on the gun */
  resetAll(); GUNAT=at; set(at-90000); gunWatch();
  out.late=tState; out.lateLeft=Math.round((tEnd-rnow())/1000);
  /* and one that has been and gone while the panel was off */
  resetAll(); GUNAT=at; gunSave(); set(at+60000); gunWatch();
  out.missed=tState; out.missedCleared=GUNAT===null;
  /* a countdown started by hand stands a scheduled one down */
  resetAll(); GUNAT=at; gunSave(); startCountdown();
  out.byHand=GUNAT===null;
  Date.now=real; rAt=rBase=Date.now(); resetAll(); GUNAT=null; gunSave();
  return out;
});
t.ok(fired.early==='idle', 'six minutes out it is still idle', fired.early);
t.ok(fired.fired==='countdown', 'five minutes out the countdown starts itself',
     fired.fired);
t.ok(fired.left===300, 'and runs out exactly on the gun', fired.left+' s');
t.ok(fired.cleared, 'one shot - it does not fire into the race it just started');
t.ok(fired.late==='countdown' && fired.lateLeft===90,
     'set inside the window it starts at once, and still ends on the gun',
     fired.lateLeft+' s');
t.ok(fired.missed==='idle' && fired.missedCleared,
     'a gun that went while the panel was off starts nothing, and is dropped');
t.ok(fired.byHand, 'and starting the countdown by hand disarms it');
await p.evaluate(()=>renderCourse());
await seed(); await p.waitForTimeout(300);

t.head('a mark an ocean away is a typo, and the map is not fitted to it');
await p.evaluate(()=>{ COURSE.marks=['gosling']; courseSave(); drawMap(shownTrack()); });
await p.waitForTimeout(300);
const before=await p.evaluate(()=>MAPVIEW.scale);
await p.evaluate(()=>{ const m={id:'typo',name:'TYPO',hdr:'TYPO',lat:48.0,lon:-5.0};
                       USER_MARKS.push(m); MARKS.push(m);
                       COURSE.marks=['gosling','typo']; courseSave(); renderCourse();
                       drawMap(shownTrack()); });
await p.waitForTimeout(300);
const after=await p.evaluate(()=>MAPVIEW.scale);
t.ok(Math.abs(after-before)/before < 0.01, 'the view stays on the lake',
     before.toFixed(0)+' -> '+after.toFixed(0));
t.ok(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)===2,
     'the mark is still drawn - off the edge, where it was typed');

await t.done(b);
