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
  sub:$('pick-pk').textContent.trim(),
  menu:$('pick').classList.contains('on'),
  foot:$('pick-ft').textContent.trim(),
  ghost:[...document.querySelectorAll('#cv-strip .cv-chip.ghost')]
          .map(c=>[...c.childNodes].filter(n=>n.nodeType===3)
                .map(n=>n.textContent).join('').trim()).join(' · ')}));
/* A fresh ask, whatever the menu is doing: the readout opens it and
   fetches, and tapping it while it is open is how you put it away. */
const ask=async()=>{ await p.evaluate(()=>pickClose()); await tap(CLUB); };
/* The second tap is the LOAD in the menu, not the readout again. */
const load=async()=>{ await p.click('#pick-ft .pkfoot'); await p.waitForTimeout(400); };
const course=()=>p.evaluate(()=>({marks:COURSE.marks.slice(), next:COURSE.next,
                                  side:Object.assign({},COURSE.side||{})}));
const clear=()=>p.evaluate(()=>{ COURSE={marks:[],next:0,side:{}}; courseSave();
                                 CLUB={step:'idle',got:null,say:''};
                                 pickClose(); renderCourse(); });

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
t.ok(/POSTED \d/.test(S.sub), 'and when the club posted it', S.sub);
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
t.ok(/SYNC/.test(S.head), 'the readout goes back to offering a sync', S.head);
t.ok(!S.ghost && !S.menu,
     'with the menu shut and nothing left previewed - the strip is yours again');
t.ok(!await p.evaluate(()=>CLUB.say),
     'and nothing is said about it afterwards: what was wrong with the '
     +'course was on the menu you loaded it from'); 

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
t.ok(S.menu && !S.foot, 'in the menu, with nothing to load', S.foot);
t.ok((await course()).marks.length===0, 'and nothing was loaded');

t.head('no wifi');
/* Asking again is tapping CLUB again - there is no button in the menu
   for it, because the readout IS the button. */
reply='dead';
await ask();
S=await said();
t.ok(/NO ANSWER/.test(S.sub), 'the line under the button says why', S.sub);

t.head('a course with a mark this boat has not got');
reply={status:200, body:{date:'2026-09-30', course:{
  marks:['cb10','rum'], side:{}, note:null, posted:1, line:{pin:'flag',boat:'ball'},
  startsOnLine:true, finishesOnLine:true, unknown:['green']}}};
await ask();
S=await said();
/* Before the load, not after it: that is the moment it could still
   change your mind. */
t.ok(/1 MARK THIS BOAT HAS NOT GOT/.test(S.sub),
     'it is told, not left to be found at the mark', S.sub);
await load();
C=await course();
t.ok(C.marks.join()==='cb10,rum', 'and what it does have is loaded', C.marks.join());

t.head('a mark the site thinks we have and we have not');
/* The two lists are kept in step by hand - the site's HELM_MARKS and
   the table in this file - so they can drift. When they do, the site
   reports nothing wrong and the course quietly arrives a leg short.
   That is the one this boat has to notice by itself. */
await clear();
reply={status:200, body:{date:'2026-09-30', course:{
  marks:['rum','notamark','cb10'], side:{}, note:null, posted:1,
  line:{pin:'flag',boat:'ball'},
  startsOnLine:true, finishesOnLine:true, unknown:[]}}};
await ask();
S=await said();
t.ok(/2 MARKS\?/.test(S.head), 'it offers only what it can actually sail', S.head);
t.ok(/1 MARK THIS BOAT HAS NOT GOT/.test(S.sub),
     'and says the third one did not come, though the site claimed all three',
     S.sub);
await load();
C=await course();
t.ok(C.marks.join()==='rum,cb10', 'the two it has are loaded', C.marks.join());

t.head('a course that does not start on the line');
await clear();
reply={status:200, body:{date:'2026-09-30', course:{
  marks:['rum','gosling'], side:{}, note:null, posted:1, line:{pin:'flag',boat:'ball'},
  startsOnLine:false, finishesOnLine:false, unknown:[]}}};
await ask();
S=await said();
t.ok(/IT DOES NOT START ON THE LINE/.test(S.sub),
     'which this sheet cannot draw a start for, and says so before you take it',
     S.sub);

await t.done(b);
