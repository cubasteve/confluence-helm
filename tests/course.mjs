/* The course sheet: what a tap on a mark means, what the strip says,
   what EDIT changes, and what the line chip is for. */
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

/* Every mark this boat knows, as the grid draws it. */
const sheet=()=>p.evaluate(()=>[...document.querySelectorAll('#course-list .cv-tile')]
  .map(r=>({mark:r.dataset.mark,
            /* the tile's place in the course is what its info line says */
            seq:(/IN COURSE . (\d+)/.exec(r.querySelector('s').textContent)||['',''])[1],
            buoy:[...r.querySelector('svg').classList].filter(c=>c!=='bu')[0]||null,
            name:r.querySelector('b').textContent,
            sub:r.querySelector('s').textContent,
            moved:!!r.querySelector('s.moved'),
            in:r.classList.contains('in'), next:r.classList.contains('next'),
            del:!!r.querySelector('.del'), undo:!!r.querySelector('.del.undo'),
            grip:!!r.querySelector('.grip')})));
/* And the course itself, as the strip reads it across the top. */
const strip=()=>p.evaluate(()=>[...document.querySelectorAll('#cv-strip .cv-chip')]
  .map(c=>({mark:c.dataset.chip||null,
            n:(c.querySelector('i')||{textContent:''}).textContent,
            name:[...c.childNodes].filter(n=>n.nodeType===3)
                   .map(n=>n.textContent).join('').trim(),
            side:(c.querySelector('.sd')||{textContent:null}).textContent,
            next:c.classList.contains('next'), ghost:c.classList.contains('ghost'),
            fin:c.classList.contains('fin')})));
/* The four settings, as the row reads them: a label and a value each. */
const rd=id=>p.evaluate(i=>({lbl:$(i).querySelector('s').textContent,
                             val:$(i).querySelector('b').textContent.trim()}), id);
/* And the menu three of them open. */
const menu=()=>p.evaluate(()=>({
  on:$('cv-pick').classList.contains('on'),
  head:$('cv-phd').textContent.trim(),
  rows:[...$('cv-pk').querySelectorAll('.pr')].map(r=>r.querySelector('b').textContent),
  sel:[...$('cv-pk').querySelectorAll('.pr.sel')].map(r=>r.querySelector('b').textContent)[0]||null,
  note:($('cv-pk').querySelector('.prnote')||{textContent:''}).textContent.trim(),
  foot:$('cv-pft').textContent.trim(),
  lit:[...document.querySelectorAll('.cvr.picking')].map(e=>e.id)[0]||null}));
const tap=async(sel)=>{ await p.click(sel); await p.waitForTimeout(250); };
const row=m=>`#course-list .cv-tile[data-mark="${m}"]`;
const chip=m=>`#cv-strip .cv-chip[data-chip="${m}"]`;
const course=()=>p.evaluate(()=>({marks:COURSE.marks.slice(), next:COURSE.next,
                                  side:Object.assign({},COURSE.side||{})}));

t.head('the sheet opens on the course button, and closes on it');
await tap('#trk-course');
let S=await sheet();
t.ok(await p.evaluate(()=>$('t-course').classList.contains('on')), 'it is up');
const marks=x=>x.filter(r=>r.mark);
t.ok(marks(S).length===11, 'all eleven of the club\'s marks, as tiles', String(S.length));
let L=await rd('cv-line');
t.ok(L.lbl==='START LINE', 'the line is one of the five settings', L.lbl);
t.ok(L.val==='FLAG – BALL', 'and says which two marks it runs between', L.val);
/* The buoy each mark actually is, drawn on its tile: the club's
   inflatables are yellow specials, the channel is red, the manatee
   zone's cans are white, and the line's ends are the flag and the
   ball. */
t.ok(S.find(r=>r.mark==='rum').buoy==='y'
     && S.find(r=>r.mark==='gosling').buoy==='y',
     'the club\'s own marks are drawn as yellow specials',
     S.find(r=>r.mark==='rum').buoy);
t.ok(['cb2','cb8','cb10','cb12'].every(id=>S.find(r=>r.mark===id).buoy==='r'),
     'every channel buoy is a red nun');
t.ok(['man1','man2'].every(id=>S.find(r=>r.mark===id).buoy==='w'),
     'the manatee marks are the white regulatory cans');
t.ok(S.find(r=>r.mark==='green').buoy==='g',
     'and the green buoy is the three-stick tripod it is',
     String((S.find(r=>r.mark==='green')||{}).buoy));
t.ok(S.find(r=>r.mark==='flag').buoy==='f' && S.find(r=>r.mark==='ball').buoy==='b',
     'and the line\'s two ends are the white lighted buoy and the grey ball '
     +'they actually are');
t.ok(await p.evaluate(()=>[...document.querySelectorAll('.cv-set .cvr')]
       .map(e=>e.querySelector('s').textContent).join())
     ==='START TIME,COUNTDOWN,SEQUENCE,START LINE,CLUB',
     'the whole evening on one row, the two clock facts together',
     await p.evaluate(()=>[...document.querySelectorAll('.cv-set .cvr')]
       .map(e=>e.querySelector('s').textContent).join()));
await tap('#course-done');
t.ok(!await p.evaluate(()=>$('t-course').classList.contains('on')),
     'and DONE puts it away');
await tap('#trk-course');

t.head('a tap puts a mark in the course, and the strip is the order');
await p.evaluate(()=>{ COURSE.marks=[]; COURSE.next=0; COURSE.side={}; courseSave(); renderCourse(); });
await tap(row('rum')); await tap(row('gosling')); await tap(row('cb12'));
S=await sheet();
let T=await strip();
t.ok(T.map(c=>c.name).join()==='RUM,GOSLING,CB 12,FINISH',
     'first tapped is first rounded, and the line is last',
     T.map(c=>c.name).join());
t.ok(T[2].n==='3' && T[3].fin, 'the chips are numbered and the finish is not a mark');
const seqOf=id=>S.find(r=>r.mark===id).seq;
t.ok(seqOf('rum')==='1'&&seqOf('gosling')==='2'&&seqOf('cb12')==='3',
     'and the tiles say the same places',
     [seqOf('rum'),seqOf('gosling'),seqOf('cb12')].join(''));
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

t.head('a tap on a chip flips which side that mark is left on');
T=await strip();
t.ok(T.find(c=>c.mark==='gosling').side==='P', 'port until told otherwise');
t.ok(T.every(c=>c.fin||c.side), 'every mark in the course carries a side');
await tap(chip('gosling'));
T=await strip(); C=await course();
t.ok(T.find(c=>c.mark==='gosling').side==='S', 'the chip now says S');
t.ok(C.side.gosling==='S', 'and is kept with the course', String(C.side.gosling));
t.ok(C.marks.join()==='gosling,cb12,rum',
     'and flipping a side did not take the mark out of the course', C.marks.join());
await p.evaluate(()=>drawMap(shownTrack())); await p.waitForTimeout(250);
t.ok(await p.evaluate(()=>[...$('t-path').querySelectorAll('text')]
       .some(x=>x.textContent==='S')), 'the map letters it too');

t.head('the mark being sailed to is the one lit');
T=await strip();
t.ok(T.find(c=>c.mark==='gosling').next, 'the first, before any is rounded');
await p.evaluate(()=>{ courseAdvance(); renderCourse(); }); await p.waitForTimeout(200);
T=await strip();
t.ok(!T.find(c=>c.mark==='gosling').next && T.find(c=>c.mark==='cb12').next,
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
t.ok(marks(S).length===11 && marks(S).every(r=>r.seq===''),
     'the marks are all still there, unnumbered');
t.ok((await strip()).length===0, 'and the strip has nothing to show');
await tap(row('gosling')); await tap(row('cb12'));
await p.evaluate(()=>{ COURSE.side={gosling:'S'}; courseSave(); renderCourse(); });

t.head('EDIT is for the list, not the course');
await tap('#course-edit');
S=await sheet();
t.ok(await p.evaluate(()=>courseEdit), 'edit mode is on');
t.ok(marks(S).every(r=>r.grip), 'every mark gets a band to drag by');
t.ok(/^\d\d \d\d\.\d\d\d[NS] · \d\d\d \d\d\.\d\d\d[EW]$/.test(marks(S)[0].sub),
     'and shows its position, which is what edit mode is about', marks(S)[0].sub);
t.ok(!S.find(r=>r.mark==='cb8').del, 'a club mark nobody has touched gets no button');
await tap(row('cb8'));
t.ok(await p.evaluate(()=>MK&&MK.id==='cb8'), 'a tap opens the mark instead');
t.ok((await course()).marks.join()==='gosling,cb12',
     'and does not add it to the course', (await course()).marks.join());
await p.evaluate(()=>mkClose()); await p.waitForTimeout(250);

t.head('and the band along the bottom drags a mark to a new place in the list');
/* The list's order, not the course's - the course is the strip. */
const where=id=>p.evaluate(i=>MARKS.findIndex(m=>m.id===i), id);
const grab=async id=>p.evaluate(i=>{ const e=document.querySelector(
    '.cv-tile[data-mark="'+i+'"]');
  const g=e.querySelector('.grip').getBoundingClientRect();
  const q=e.getBoundingClientRect();
  return {gx:g.left+g.width/2, gy:g.top+g.height/2,
          cx:q.left+q.width/2, cy:q.top+q.height/2}; }, id);
/* Back to the top of the grid: a click earlier in this probe may have
   scrolled a tile into view, and a tile half out of the scroller is not
   a tile a pointer can be put on. */
await p.evaluate(()=>{ $('course-list').scrollTop=0; });
await p.waitForTimeout(150);
const was=await where('flag');
const A=await grab('flag'), B=await grab('rum');
await p.mouse.move(A.gx,A.gy); await p.mouse.down();
await p.mouse.move(B.cx,B.cy,{steps:12}); await p.waitForTimeout(200);
await p.mouse.up(); await p.waitForTimeout(400);
t.ok(await where('flag') > was, 'the mark takes the place it was dragged onto',
     was+' -> '+await where('flag'));
t.ok(/flag/.test(await p.evaluate(()=>localStorage.getItem('markOrder')||'')),
     'and the order is kept');
t.ok((await course()).marks.join()==='gosling,cb12',
     'while the course itself is untouched', (await course()).marks.join());

t.head('a corrected club mark can be put back');
await p.evaluate(()=>{ MARK_MOVES={cb8:{lat:28.8200,lon:-81.2900}}; markMovesSave();
                       const m=markOf('cb8'); m.lat=28.8200; m.lon=-81.2900; renderCourse(); });
S=await sheet();
t.ok(S.find(r=>r.mark==='cb8').undo, 'it gets the way back to the book');
t.ok(S.find(r=>r.mark==='cb8').moved,
     'and its position is marked as corrected', S.find(r=>r.mark==='cb8').sub);
await p.evaluate(()=>{ MARK_MOVES={}; markMovesSave(); });

t.head('the line readout says which line is in force');
await p.evaluate(()=>{ courseEdit=false; $('course-edit').classList.remove('on');
                       LINE={pin:{lat:28.8190,lon:-81.2648},boat:{lat:28.8195,lon:-81.2622}};
                       saveLine(); ['pin','boat'].forEach(k=>$('ping-'+k).classList.add('set'));
                       renderCourse(); });
await p.waitForTimeout(200);
L=await rd('cv-line');
t.ok(L.val==='PINGED', 'a pinged line says so', L.val);
t.ok(await p.evaluate(()=>lineEnds().pinged), 'and is the line the readings use');
await tap('#cv-line');
let M=await menu();
t.ok(M.on && M.lit==='cv-line', 'the readout opens its menu', String(M.lit));
t.ok(M.sel==='PINGED', 'lit on the pinged line', String(M.sel));
/* The way back from a ping taken at the wrong end: choose the marks. */
await tap('#cv-pk .pr[data-line="marks"]');
t.ok(await p.evaluate(()=>!lineEnds().pinged
       && !$('ping-pin').classList.contains('set')
       && !$('ping-boat').classList.contains('set')),
     'choosing the marks drops the pings, and the ping buttons go out with them');
t.ok((await rd('cv-line')).val==='FLAG – BALL', 'back on the club marks',
     (await rd('cv-line')).val);
t.ok(!(await menu()).on, 'and the menu is done');

t.head('and the menu offers the two lines there are');
await tap('#cv-line');
M=await menu();
t.ok(M.rows.join()==='FLAG – BALL,PINGED', 'the club\'s marks, or the one you pinged',
     M.rows.join());
t.ok(M.sel==='FLAG – BALL', 'on the one in force', String(M.sel));
t.ok(/P AND B/.test(await p.evaluate(()=>$('cv-pk').textContent)),
     'and says where a pinged line comes from',
     await p.evaluate(()=>$('cv-pk').textContent.trim()));
t.ok(await p.evaluate(()=>!!$('cv-pk').querySelector('.pr.off')),
     'with the pinged one shown but not available, rather than left out');
await tap('#cv-pk .pr[data-line="marks"]');
t.ok(!(await menu()).on && !await p.evaluate(()=>lineEnds().pinged),
     'choosing the marks when they are already in force changes nothing');

t.head('the sequence is chosen the same way');
await tap('#cv-mode');
M=await menu();
t.ok(M.rows.join()==='GUN,WINDOW' && M.sel==='GUN', 'both, opened on the one in force',
     M.sel+' of '+M.rows.join());
await tap('#cv-pk .pr[data-mode="window"]');
t.ok(await p.evaluate(()=>CFG.startMode)==='window', 'a tap sets it',
     await p.evaluate(()=>CFG.startMode));
t.ok((await menu()).on===false, 'and the menu goes away, because that was the choice');
t.ok((await rd('cv-mode')).val==='WINDOW', 'the readout says which',
     (await rd('cv-mode')).val);
await p.evaluate(()=>startModeSet('gun'));

t.head('the countdown steps rather than opening anything');
/* Three values a thumb can step through beats a menu to open, scroll
   and dismiss. */
t.ok((await rd('cv-mins')).val==='5 MIN', 'five to start with',
     (await rd('cv-mins')).val);
await tap('#cv-mins');
t.ok((await rd('cv-mins')).val==='10 MIN', 'a tap is five more');
await tap('#cv-mins');
t.ok((await rd('cv-mins')).val==='15 MIN' && !(await menu()).on,
     'and fifteen, with no menu in sight');
await tap('#cv-mins');
t.ok((await rd('cv-mins')).val==='5 MIN', 'and round again rather than stopping');
await tap('#cv-mins');
t.ok(await p.evaluate(()=>Math.round(tLeft/60000))===10,
     'the countdown itself is the new length, not the old one at the next reset',
     String(await p.evaluate(()=>Math.round(tLeft/60000))));
t.ok(JSON.parse(await p.evaluate(()=>localStorage.getItem('helmPrefs'))).startMins===10,
     'and it is kept over a restart');
await p.evaluate(()=>{ CFG.startMins=5; prefsSave(); resetAll(); renderCourse(); });

t.head('a tap anywhere else puts the menu away');
await tap('#cv-mode');
t.ok((await menu()).on, 'open');
/* High on the glass, clear of the menu itself - the veil is the whole
   sheet and the menu is on top of the middle of it. */
await p.click('#cv-veil',{position:{x:540,y:120}}); await p.waitForTimeout(250);
t.ok(!(await menu()).on, 'and shut, with nothing changed',
     await p.evaluate(()=>CFG.startMode));

t.head('the scheduled gun: typed once, and it starts itself');
/* A club race has a time on the sailing instructions. Typing it beats
   watching a clock for the moment to press a button with a boat to
   sail at the same time. */
/* The clock is pinned to six in the evening for this section. The times
   below are 'forty minutes out', and forty minutes out from half past
   eleven at night is tomorrow - which the pad is right to refuse, and
   which would otherwise make this probe fail once a day. */
await p.evaluate(()=>{ const d=new Date(); d.setHours(18,0,0,0);
  window.__realNow=Date.now; Date.now=()=>d.getTime(); });
const gunRow=()=>p.evaluate(()=>({b:$('cv-start').querySelector('b').textContent,
  sub:$('cv-mins').querySelector('b').textContent,
  set:$('cv-start').classList.contains('in')}));
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
t.ok(G.b==='NOT SET' && !G.set, 'unset, the readout says so', G.b);
let r=await type(want.d, want.mer);
t.ok(r.at!==null && !r.open, 'four digits and it is armed', String(r.at));
G=await gunRow();
t.ok(G.b===want.hhmm && G.set, 'the readout says when the gun is, and lights', G.b);
t.ok(G.sub==='5 MIN', 'and the one beside it how long the countdown runs, which is '
     +'when it will start itself', G.sub);
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

await p.evaluate(()=>{ Date.now=window.__realNow; rAt=rBase=Date.now(); });

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
