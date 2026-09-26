/* A mark of your own that this file has since grown a copy of. The Green
   Buoy was surveyed from the boat and kept in storage for a season; it is
   on the club's list now, and is compiled in. What happens to the copy
   you already had is the whole of this probe: the position you stood at
   is not thrown away, and the row stops being two things at once. */
import {open, tally} from './helpers.mjs';
const t=tally();

/* Storage as a Pi that has been carrying its own green mark would have
   it, a boat length west of where the club later published it. */
const MINE={id:'green', name:'GREEN BUOY', hdr:'GREEN',
            lat:28+49.030/60, lon:-(81+16.182/60)};

const {b,p}=await open(t,{demo:true, storage:{marks:JSON.stringify([MINE])}});

const state=()=>p.evaluate(()=>({
  compiled:!!markOf('green'),
  user:USER_MARKS.map(m=>m.id),
  stored:JSON.parse(localStorage.getItem('marks')||'[]').map(m=>m.id),
  moves:JSON.parse(localStorage.getItem('markMoves')||'{}'),
  isUser:isUserMark('green'),
  moved:isMoved('green'),
  at:{lat:markOf('green').lat, lon:markOf('green').lon},
}));

t.head('the club list carries it now');
let S=await state();
t.ok(S.compiled, 'green is a mark this file knows without storage');

t.head('and the copy you were carrying is absorbed, not duplicated');
t.ok(!S.user.includes('green'), 'out of your own marks', S.user.join()||'(none)');
t.ok(!S.stored.includes('green'), 'and out of storage, so it stays gone',
     S.stored.join()||'(none)');
t.ok(!S.isUser, 'so no bin on its row in EDIT');

t.head('but the position you stood at wins');
t.ok(!!S.moves.green, 'it became an override', JSON.stringify(S.moves));
t.ok(Math.abs(S.at.lon-MINE.lon)<1e-9, 'and that is where the mark is',
     String(S.at.lon)+' vs '+String(MINE.lon));
t.ok(S.moved, 'shown as moved, with the book underneath to go back to');

t.head('a survey that agrees with the book leaves nothing behind');
const {b:b2,p:p2}=await open(t,{demo:true, storage:{marks:JSON.stringify(
  [{id:'green', name:'GREEN BUOY', hdr:'GREEN', lat:28+49.030/60, lon:-(81+16.170/60)}])}});
const S2=await p2.evaluate(()=>({
  stored:JSON.parse(localStorage.getItem('marks')||'[]').map(m=>m.id),
  moves:Object.keys(JSON.parse(localStorage.getItem('markMoves')||'{}')),
  compiled:!!markOf('green')}));
t.ok(S2.compiled && !S2.stored.includes('green'), 'the copy still goes');
t.ok(!S2.moves.includes('green'), 'and no override for a number that matches',
     S2.moves.join()||'(none)');
await b2.close();

t.head('a mark of your own the club has NOT published is left alone');
const {b:b3,p:p3}=await open(t,{demo:true, storage:{marks:JSON.stringify(
  [{id:'crab', name:'CRAB POT', hdr:'CRAB', lat:28.8300, lon:-81.2600}])}});
const S3=await p3.evaluate(()=>({user:USER_MARKS.map(m=>m.id),
  stored:JSON.parse(localStorage.getItem('marks')||'[]').map(m=>m.id),
  onList:!!markOf('crab')}));
t.ok(S3.user.includes('crab') && S3.stored.includes('crab') && S3.onList,
     'still yours, still stored, still on the sheet', JSON.stringify(S3));
await b3.close();

await t.done(b);
