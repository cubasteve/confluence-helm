/* CLUB SYNC: what it asks for, what it says it found, and the second
   tap that is the only thing allowed to replace a course. */
import {open, tally} from './helpers.mjs';
const t=tally();

/* What the members' site would answer, swapped per case. The shape is
   the one /api/race/helm serves: ids already translated to this boat's,
   sides as P and S, and what it could not translate named rather than
   dropped. */
let reply={status:200, body:{date:'2026-09-30', course:{
  marks:['cb10','gosling','rum'], side:{cb10:'P', gosling:'S', rum:'P'},
  note:null, posted:1790289195830, line:{pin:'flag',boat:'ball'},
  startsOnLine:true, finishesOnLine:true, unknown:[]}}};

const {b,p}=await open(t,{demo:true, routes:{'https://lmsa.pages.dev/**': r=>
  reply==='dead' ? r.abort('failed')
  : r.fulfill({status:reply.status, contentType:'application/json',
               headers:{'Access-Control-Allow-Origin':'*'},
               body:JSON.stringify(reply.body)})}});

const tap=async(sel)=>{ await p.click(sel); await p.waitForTimeout(400); };
const CLUB='#cv-sync';
/* The readout says what it has; its menu says where it came from and
   carries the LOAD; and what it FOUND is the strip, in dashed outline,
   drawn where the course it would replace is. */
const said=()=>p.evaluate(()=>({
  head:$('cv-sync').querySelector('b').textContent.trim(),
  sub:($('cv-pk').textContent+' '+$('cv-say').textContent).trim(),
  menu:$('cv-pick').classList.contains('on'),
  foot:$('cv-pft').textContent.trim(),
  count:$('cv-count').textContent,
  ghost:[...document.querySelectorAll('#cv-strip .cv-chip.ghost')]
          .map(c=>[...c.childNodes].filter(n=>n.nodeType===3)
                .map(n=>n.textContent).join('').trim()).join(' · '),
  bad:$('cv-say').classList.contains('bad')}));
/* A fresh ask, whatever the menu is doing: the readout opens it and
   fetches, and tapping it while it is open is how you put it away. */
const ask=async()=>{ await p.evaluate(()=>cvpClose()); await tap(CLUB); };
/* The second tap is the LOAD in the menu, not the readout again. */
const load=async()=>{ await p.click('#cv-pft .prfoot'); await p.waitForTimeout(400); };
const course=()=>p.evaluate(()=>({marks:COURSE.marks.slice(), next:COURSE.next,
                                  side:Object.assign({},COURSE.side||{})}));
const clear=()=>p.evaluate(()=>{ COURSE={marks:[],next:0,side:{}}; courseSave();
                                 CLUB={step:'idle',got:null,say:'',bad:false};
                                 cvpClose(); renderCourse(); });

/* The course sheet hangs off the tracks app, as it does for the probe
   next door. */
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
await tap('#trk-course');

t.head('the readout is on the sheet and says what it is for');
let S=await said();
t.ok(/SYNC/.test(S.head), 'it is there', S.head);
t.ok(!S.menu, 'with its menu shut until it is asked', String(S.menu));
t.ok(!S.ghost, 'and no course previewed in the strip');

t.head('the first tap fetches, and changes nothing');
await tap(CLUB);
S=await said();
t.ok(/3 MARKS\?/.test(S.head), 'it says what it found', S.head);
t.ok(S.menu && /LOAD 3 MARKS/.test(S.foot),
     'and opens on the one thing that would load it', S.foot);
t.ok(S.ghost==='CB 10 · GOSLING · RUM',
     'and draws them in the strip, in this sheet\'s own words', S.ghost);
t.ok(/CLUB COURSE . 3 MARKS/.test(S.count),
     'the heading says whose course the strip is showing', S.count);
t.ok(/POSTED \d/.test(S.sub) && /DASHED IN THE STRIP/.test(S.sub),
     'and where it came from, and where to look at it', S.sub);
let C=await course();
t.ok(C.marks.length===0, 'the course is still untouched', JSON.stringify(C.marks));

t.head('the second tap is the one that loads it');
await load();
C=await course();
t.ok(C.marks.join()==='cb10,gosling,rum', 'the marks, in order', C.marks.join());
t.ok(C.side.cb10==='P' && C.side.gosling==='S' && C.side.rum==='P',
     'and the side each is left on', JSON.stringify(C.side));
t.ok(C.next===0, 'starting at the first one', String(C.next));
S=await said();
t.ok(/SYNC/.test(S.head) && /LOADED/.test(S.sub), 'and it says so', S.sub);
t.ok(!S.ghost && !S.menu,
     'with the menu shut and nothing left previewed - the strip is yours again');

t.head('a course three marks in is not replaced by one tap');
await p.evaluate(()=>{ COURSE.next=2; courseSave(); renderCourse(); });
await tap(CLUB);
C=await course();
t.ok(C.next===2, 'the first tap left the boat where it was', String(C.next));
await load();
t.ok((await course()).next===0, 'the LOAD in the menu started the course over');

t.head('nothing posted yet');
await clear();
reply={status:200, body:{date:'2026-10-07', course:null}};
await tap(CLUB);
S=await said();
t.ok(/NOTHING POSTED/.test(S.sub), 'it says so rather than emptying the course', S.sub);
t.ok(S.bad, 'in the colour of something that did not work');
t.ok((await course()).marks.length===0, 'and nothing was loaded');

t.head('no wifi');
/* From a menu already open on the last answer, ASK THE CLUB in its foot
   is the retry - tapping the readout again is how you put the menu
   away. */
reply='dead';
await load();
S=await said();
t.ok(/NO ANSWER/.test(S.sub), 'the line under the button says why', S.sub);

t.head('a course with a mark this boat has not got');
reply={status:200, body:{date:'2026-09-30', course:{
  marks:['cb10','rum'], side:{}, note:null, posted:1, line:{pin:'flag',boat:'ball'},
  startsOnLine:true, finishesOnLine:true, unknown:['green']}}};
await ask(); await load();
C=await course();
t.ok(C.marks.join()==='cb10,rum', 'what it does have is loaded', C.marks.join());
S=await said();
t.ok(/1 MISSING/.test(S.sub), 'and it is told, not left to be found at the mark', S.sub);

t.head('a course that does not start on the line');
await clear();
reply={status:200, body:{date:'2026-09-30', course:{
  marks:['rum','gosling'], side:{}, note:null, posted:1, line:{pin:'flag',boat:'ball'},
  startsOnLine:false, finishesOnLine:false, unknown:[]}}};
await tap(CLUB); await load();
S=await said();
t.ok(/NOT OFF THE LINE/.test(S.sub), 'which this sheet cannot draw a start for', S.sub);

await t.done(b);
