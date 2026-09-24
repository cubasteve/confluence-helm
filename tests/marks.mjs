/* Marks of your own: what the form accepts, what it refuses, and what
   happens to the course when one goes or comes back. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true, geo:{latitude:28.8215,longitude:-81.2740,accuracy:4}});
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
await p.evaluate(()=>openCourse()); await p.waitForTimeout(500);

/* Type into the form the way the on-screen keyboard does. */
const type=(field,txt)=>p.evaluate(([f,s])=>{ MK.f=f; MK[f]=s; mkPaint(); },[field,txt]);
const save=async()=>{ await p.click('#mk-save'); await p.waitForTimeout(400);
  return p.evaluate(()=>({msg:$('mk-msg').textContent,
                          open:$('course-add').style.display!=='none',
                          n:USER_MARKS.length})); };

t.head('a position reads as the sailing instructions write it');
const parse=await p.evaluate(()=>({
  dm:      parseDM('28 49.03 N'),
  dmW:     parseDM('081 16.17 W'),
  chart:   parseDM("28°49.03'N"),
  minus:   parseDM('-81 16.17'),
  trailing:parseDM('81 16.17 W'),
  dec:     parseDM('28.8172'),
  dms:     parseDM('28 49 03'),
  junk:    parseDM('over there')}));
t.ok(Math.abs(parse.dm-(28+49.03/60))<1e-9, 'degrees and decimal minutes', String(parse.dm));
t.ok(Math.abs(parse.dmW+(81+16.17/60))<1e-9, 'west is negative', String(parse.dmW));
t.ok(Math.abs(parse.chart-parse.dm)<1e-9, "a chart's degree and minute marks", String(parse.chart));
t.ok(Math.abs(parse.minus-parse.dmW)<1e-9, 'or a minus instead of the letter');
t.ok(Math.abs(parse.trailing-parse.dmW)<1e-9, 'the letter at either end');
t.ok(Math.abs(parse.dec-28.8172)<1e-9, 'and decimal degrees', String(parse.dec));
t.ok(parse.dms===null, 'three parts is degrees-minutes-SECONDS and is refused',
     String(parse.dms));
t.ok(parse.junk===null, 'as is a phrase', String(parse.junk));

t.head('the form refuses what it should');
await p.evaluate(()=>mkOpen()); await p.waitForTimeout(300);
await type('name','BAD ONE'); await type('lat','28 49.03'); await type('lon','nonsense');
let r=await save();
t.ok(/CHECK THE POSITION/.test(r.msg) && r.open, 'a position it cannot read', r.msg);
await type('lon','81 16.17');          /* east, so half a world away */
r=await save();
t.ok(/AWAY/.test(r.msg) && /MINUS/.test(r.msg),
     'and one in Asia, with the reason: the west minus', r.msg);
t.ok(r.open && r.n===0, 'nothing saved either time', JSON.stringify(r));

t.head('HERE takes it off the GPS');
/* Whatever is feeding the boat is what HERE means - a GPS on the water,
   the demo sail here. The demo is stood down first and one position put
   in its place, because a moving boat moves between the tap and the
   read and the test would be racing it. */
await p.evaluate(()=>{ demoSet(false);
  feedPut('pos.lat', 28+49.290/60, 'test');
  feedPut('pos.lon', -(81+16.440/60), 'test'); });
await p.click('#mk-here'); await p.waitForTimeout(400);
const here=await p.evaluate(()=>({lat:$('mk-lat').textContent, lon:$('mk-lon').textContent,
  want:[fmtDM(get('pos.lat')), fmtDM(get('pos.lon'))]}));
t.ok(here.lat===here.want[0] && here.lon===here.want[1],
     'the position the boat is standing at', JSON.stringify(here));
t.ok(here.lat==='28 49.290' && here.lon==='-81 16.440',
     'written the way the form reads it back', JSON.stringify(here));
await type('name','GREEN BUOY');
r=await save();
t.ok(!r.open && r.n===1, 'and it saves', JSON.stringify(r));

t.head('a saved mark is a mark like any other');
const m=await p.evaluate(()=>{ const u=USER_MARKS[0];
  return {id:u.id, name:u.name, hdr:u.hdr, inMarks:!!markOf(u.id),
          inCourse:COURSE.marks.includes(u.id), user:isUserMark(u.id),
          onSheet:!!document.querySelector('.course-row[data-mark="'+u.id+'"]'),
          disk:JSON.parse(localStorage.getItem('marks')||'[]').length}; });
t.ok(m.name==='GREEN BUOY', 'named as typed', m.name);
t.ok(m.hdr==='GREEN BU', 'with a short name a 32 px header can carry', m.hdr);
t.ok(m.inMarks && m.onSheet, 'on the sheet beside the club\'s');
t.ok(m.inCourse, 'and added to the course, which is why you made it');
t.ok(m.disk===1, 'kept for good', String(m.disk));

t.head('a nameless one still gets a name');
await p.evaluate(()=>mkOpen()); await p.waitForTimeout(250);
await p.click('#mk-here'); await p.waitForTimeout(300);
await save();
t.ok(/^MARK \d+$/.test(await p.evaluate(()=>USER_MARKS[1].name)),
     'numbered rather than blank', await p.evaluate(()=>USER_MARKS[1].name));

t.head('and deleting one takes it out of everything');
const del=await p.evaluate(()=>{ const id=USER_MARKS[1].id;
  markDelete(id);
  return {left:USER_MARKS.length, inMarks:!!markOf(id),
          inCourse:COURSE.marks.includes(id),
          onSheet:!!document.querySelector('.course-row[data-mark="'+id+'"]'),
          disk:JSON.parse(localStorage.getItem('marks')||'[]').length}; });
t.ok(del.left===1 && del.disk===1, 'gone from storage', JSON.stringify(del));
t.ok(!del.inMarks && !del.onSheet, 'and off the sheet', JSON.stringify(del));
t.ok(!del.inCourse, 'and out of the course, rather than left as a hole',
     JSON.stringify(del));

t.head("but a club mark cannot be deleted");
const club=await p.evaluate(()=>{ markDelete('cb12'); return !!markOf('cb12'); });
t.ok(club, 'markDelete refuses one it did not create');

await t.done(b);
