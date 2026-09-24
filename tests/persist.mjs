/* What survives a restart. The kiosk reboots on every deploy, every
   autopull and every crash, so anything you set and it forgets is a
   thing you cannot trust it to be set on. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t);

/* A restart, as the Pi does one. */
const reboot=async()=>{ await p.reload(); await p.waitForTimeout(1500);
  await p.evaluate(()=>bootSettle()); await p.waitForTimeout(900);
  await p.evaluate(()=>{ Object.values(ALERTS).forEach(a=>a.ackUntil=Date.now()+9e5);
                         alertPaint(); }); };
const store=k=>p.evaluate(k=>localStorage.getItem(k), k);

t.head('the preferences');
await p.evaluate(()=>{ CFG.theme='night'; CFG.depthUnit='m'; CFG.depthAlarm=4;
  CFG.depthWarn=8; CFG.dim=55; CFG.windDemo=false; CFG.startMode='window';
  prefsSave(); });
await reboot();
let C=await p.evaluate(()=>({theme:CFG.theme, u:CFG.depthUnit, a:CFG.depthAlarm,
  w:CFG.depthWarn, dim:CFG.dim, wd:CFG.windDemo}));
t.ok(C.theme==='night', 'the theme', C.theme);
t.ok(C.u==='m' && C.a===4, 'the depth unit and the alarm set in it', C.u+' '+C.a);
t.ok(C.w===8, 'the warning, derived from the alarm rather than stored', String(C.w));
t.ok(C.dim===55, 'the brightness', String(C.dim));
t.ok(C.wd===false, 'and the invented wind, off - which is the point of storing it',
     String(C.wd));
t.ok(await p.evaluate(()=>CFG.startMode)==='window',
     'and which club night this is - found out at the gun otherwise',
     await p.evaluate(()=>CFG.startMode));
t.ok(await p.evaluate(()=>$('st-win').classList.contains('on')),
     'with the pill lit to say so');
t.ok(await p.evaluate(()=>document.body.className)==='night',
     'and the theme is actually applied, not just remembered',
     await p.evaluate(()=>document.body.className));
t.ok(await p.evaluate(()=>$('theme-lbl').textContent)==='NIGHT',
     'with the panel saying which one is on');

t.head('a stored value that is nonsense is ignored, not obeyed');
await p.evaluate(()=>localStorage.setItem('helmPrefs', JSON.stringify(
  {theme:'chartreuse', depthUnit:'fathoms', depthAlarm:900, dim:-40,
   windDemo:'yes', phoneGps:1, startMode:'pursuit'})));
await reboot();
C=await p.evaluate(()=>({theme:CFG.theme, u:CFG.depthUnit, a:CFG.depthAlarm,
  dim:CFG.dim, wd:CFG.windDemo, ph:CFG.phoneGps}));
t.ok(C.theme==='auto' && C.u==='ft', 'a value off the list falls back to the default',
     C.theme+' '+C.u);
t.ok(C.a>=1 && C.a<=60, 'a depth alarm out of range is refused', String(C.a));
t.ok(C.dim>=25, 'and so is a brightness that would black the screen', String(C.dim));
t.ok(C.wd===true && C.ph===false, 'a string where a boolean belongs is not a boolean',
     C.wd+' '+C.ph);
t.ok(await p.evaluate(()=>CFG.startMode)==='gun',
     'and a start format nobody wrote falls back to the strict one',
     await p.evaluate(()=>CFG.startMode));
t.ok(t.errs.length===0, 'and none of it throws on the way up',
     t.errs.join(' | '));

t.head('nothing at all in storage is a first boot, not a crash');
await p.evaluate(()=>localStorage.clear());
await reboot();
t.ok(await p.evaluate(()=>CFG.theme==='auto' && CFG.depthUnit==='ft'),
     'it comes up on its defaults');
t.ok(await p.evaluate(()=>TRK.length===0 && COURSE.marks.length>=0),
     'with no track and whatever course it ships with');
t.ok(t.errs.length===0, 'quietly', t.errs.join(' | '));

t.head('the readings you chose, in the places you put them');
await p.evaluate(()=>{ DIAL.slot.c1='twa'; DIAL.slot.c4='hdg'; dialSave();
                       MUS.slot.p='sog'; musSave(); });
await reboot();
const slots=await p.evaluate(()=>({d:Object.assign({},DIAL.slot),
                                   m:Object.assign({},MUS.slot)}));
t.ok(slots.d.c1==='twa' && slots.d.c4==='hdg', "the dial's cells", JSON.stringify(slots.d));
t.ok(slots.m.p==='sog', "and the music page's tiles", JSON.stringify(slots.m));
t.ok(slots.d.c0==='sog' && slots.d.c2==='heel',
     'the ones you did not change are left where they were');

t.head('the course, the sides, and the order of the list');
await p.evaluate(()=>{ COURSE.marks=['cb12','rum','gosling']; COURSE.next=1;
  COURSE.side={rum:'S'}; courseSave();
  MARKS.sort((a,b)=>a.id<b.id?-1:1); markOrderSave(); });
const order=await p.evaluate(()=>MARKS.map(m=>m.id).join());
await reboot();
let K=await p.evaluate(()=>({m:COURSE.marks.join(), n:COURSE.next,
  s:JSON.stringify(COURSE.side||{}), o:MARKS.map(x=>x.id).join()}));
t.ok(K.m==='cb12,rum,gosling', 'the marks, in the order they are rounded', K.m);
t.ok(K.n===1, 'and which one is being sailed to', String(K.n));
t.ok(K.s==='{"rum":"S"}', 'which side to leave it', K.s);
t.ok(K.o===order, 'and the order the list itself was dragged into', K.o);

t.head('a mark of your own, and a club mark corrected');
await p.evaluate(()=>{ USER_MARKS.push({id:'u1',name:'MY MARK',hdr:'MINE',
  lat:28.8300, lon:-81.2700}); marksSave();
  MARK_MOVES={cb8:{lat:28.8301,lon:-81.2701}}; markMovesSave(); });
await reboot();
K=await p.evaluate(()=>({mine:!!markOf('u1'), name:markOf('u1')&&markOf('u1').name,
  user:isUserMark('u1'), moved:isMoved('cb8'),
  la:markOf('cb8').lat, lo:markOf('cb8').lon}));
t.ok(K.mine && K.name==='MY MARK', 'your mark is in the list', String(K.name));
t.ok(K.user, 'and still known to be yours, so it can still be deleted');
t.ok(K.moved, 'the corrected club mark is still marked as corrected');
t.ok(Math.abs(K.la-28.8301)<1e-9 && Math.abs(K.lo+81.2701)<1e-9,
     'and reads at the position you stood at, not the one on the paper',
     K.la+' '+K.lo);
await p.evaluate(()=>{ markRevert('cb8'); }); await p.waitForTimeout(1500);
await p.evaluate(()=>bootSettle()); await p.waitForTimeout(700);
t.ok(await p.evaluate(()=>!isMoved('cb8')
       && Math.abs(markOf('cb8').lat-DM(28,49.881))<1e-9),
     'and putting it back gives the book\'s position again, across a restart too');

t.head('a pinged line outlives the restart it is set before');
await p.evaluate(()=>{ LINE={pin:{lat:28.8191,lon:-81.2649},
                             boat:{lat:28.8196,lon:-81.2621}}; saveLine(); });
await reboot();
K=await p.evaluate(()=>({pinged:lineEnds().pinged, la:lineEnds().pin.lat,
  pin:$('ping-pin').classList.contains('set'),
  boat:$('ping-boat').classList.contains('set')}));
t.ok(K.pinged && Math.abs(K.la-28.8191)<1e-9, 'the line is still the pinged one',
     String(K.la));
t.ok(K.pin && K.boat, 'and both ping buttons come up lit');

t.head('the track, which is the whole reason the buffer exists');
await p.evaluate(()=>{ const t0=Date.now()-300e3;
  TRK=[...Array(200).keys()].map(i=>({t:t0+i*1000, la:28.819+i*1e-4,
    lo:-81.265, s:2.5, c:0.1}));
  trkSave(); });
await reboot();
t.ok(await p.evaluate(()=>TRK.length)===200, 'every fix is still there',
     String(await p.evaluate(()=>TRK.length)));
t.ok(await p.evaluate(()=>TRK[0].la===28.819 && TRK[199].s===2.5),
     'with the speed and course each was recorded with');

t.head('and so does a race waiting to be saved');
/* startRace is what sets the raced flag; heldTake is what puts the
   old race aside when the next countdown starts. */
await p.evaluate(()=>{ startRace(); heldTake(); });
await reboot();
K=await p.evaluate(()=>({raced:trkRaced, held:HELD&&HELD.pts.length,
                         live:TRK.length, saved:trkSavedMark}));
t.ok(K.held===200, 'the race set aside is still whole, all 200 fixes', String(K.held));
t.ok(K.live===0, 'and the track it was taken off is clear, ready for the next one',
     String(K.live));
t.ok(K.raced===false, 'which is a fresh track, not a raced one', String(K.raced));
await p.evaluate(()=>{ TRK=HELD.pts.slice(); trkSave(); startRace(); heldDrop(); });
await reboot();
t.ok(await p.evaluate(()=>trkRaced===true && HELD===null),
     'a raced track is remembered as raced, and a dropped hold stays dropped');
await p.evaluate(()=>{ trkMarkSaved(); });
await reboot();
t.ok(await p.evaluate(()=>trkSavedMark===trkMark(TRK)),
     'once saved, it stays saved - the next countdown does not ask twice');

t.head('storage that has gone away entirely is survivable');
await p.evaluate(()=>{ TRK=[{t:Date.now(),la:28.8,lo:-81.2,s:1,c:0}];
  const real=localStorage.setItem.bind(localStorage);
  localStorage.setItem=()=>{ throw new Error('QuotaExceededError'); };
  window.__real=real; });
const wrote=await p.evaluate(()=>trkSave());
t.ok(wrote===false, 'a failed write says so rather than pretending');
t.ok(await p.evaluate(()=>trkSaveBad===true), 'and is remembered, so the page can show it');
t.ok(t.errs.length===0, 'and nothing throws out of it', t.errs.join(' | '));
await p.evaluate(()=>{ localStorage.setItem=window.__real; });

await t.done(b);
