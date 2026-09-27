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
/* The marks, not the tile that makes one - that has no buoy on it. */
const sheet=()=>p.evaluate(()=>[...document.querySelectorAll('#course-list .cv-tile[data-mark]')]
  .map(r=>({mark:r.dataset.mark,
            /* the tile's place in the course is what its info line says */
            seq:(/IN COURSE . ([\d,]+)/.exec(r.querySelector('s').textContent)||['',''])[1],
            buoy:[...r.querySelector('svg').classList].filter(c=>c!=='bu')[0]||null,
            name:r.querySelector('b').textContent,
            sub:r.querySelector('s').textContent,
            moved:!!r.querySelector('s.moved'),
            in:r.classList.contains('in'), next:r.classList.contains('next'),
            del:!!r.querySelector('.del'), undo:!!r.querySelector('.del.undo'),
            grip:!!r.querySelector('.grip')})));
/* And the course itself, as the strip reads it across the top. */
const strip=()=>p.evaluate(()=>[...document.querySelectorAll('#cv-strip .cv-chip')]
  .map(c=>({at:c.dataset.chip||null,
            n:(c.querySelector('i')||{textContent:''}).textContent,
            name:[...c.childNodes].filter(n=>n.nodeType===3)
                   .map(n=>n.textContent).join('').trim(),
            side:(c.querySelector('.sd')||{textContent:null}).textContent,
            next:c.classList.contains('next'), ghost:c.classList.contains('ghost'),
            fin:c.classList.contains('fin')})));
/* The four settings, as the row reads them: a label and a value each. */
const rd=id=>p.evaluate(i=>({lbl:$(i).querySelector('s').textContent,
                             val:$(i).querySelector('b').textContent.trim()}), id);
/* The line is not one of the settings any more - it is the first thing
   in the route, in line with it, with the line drawn on it. */
const line=()=>p.evaluate(()=>({val:$('cv-line').querySelector('b').textContent.trim(),
  glyph:!!$('cv-line').querySelector('svg'),
  first:$('cv-strip').firstElementChild===$('cv-line'),
  /* and it is not rebuilt under its own open menu */
  survives:(()=>{ const n=$('cv-line'); renderCourse(); return $('cv-line')===n; })(),
  inStrip:!!$('cv-line').closest('#cv-strip')}));
/* And the menu three of them open. */
const menu=()=>p.evaluate(()=>({
  on:$('pick').classList.contains('on'),
  head:$('pick-hd').textContent.trim(),
  rows:[...$('pick-pk').querySelectorAll('.pkset')].map(r=>r.querySelector('b').textContent),
  sel:[...$('pick-pk').querySelectorAll('.pkset.sel')].map(r=>r.querySelector('b').textContent)[0]||null,
  note:($('pick-pk').querySelector('.pknote')||{textContent:''}).textContent.trim(),
  foot:$('pick-ft').textContent.trim(),
  lit:[...document.querySelectorAll('.cvr.picking')].map(e=>e.id)[0]||null}));
const tap=async(sel)=>{ await p.click(sel); await p.waitForTimeout(250); };
const row=m=>`#course-list .cv-tile[data-mark="${m}"]`;
const chip=i=>`#cv-strip .cv-chip[data-chip="${i}"]`;   /* by PLACE, not by mark */
const chipNo=i=>chip(i)+' i';                          /* its number: the way out */
const course=()=>p.evaluate(()=>({marks:COURSE.marks.slice(), next:COURSE.next,
                                  side:(COURSE.side||[]).slice()}));

t.head('the course is its own app, off the dock beside the radar');
/* It was a third sheet inside the map, which meant satellite tiles and
   800 path segments decoded first, ten minutes before a gun, for a
   sheet that reads none of it. */
await p.evaluate(()=>{ closeApp(); }); await p.waitForTimeout(400);
await p.evaluate(()=>openApps()); await p.waitForTimeout(500);
t.ok(await p.evaluate(()=>APPS.map(a=>a.id).join())==='radar,course,tracks,golden',
     'second on the dock, right off the radar',
     await p.evaluate(()=>APPS.map(a=>a.id).join()));
t.ok(await p.evaluate(()=>{ const r=$('app-row');
       return r.scrollWidth<=r.clientWidth; }),
     'and four tiles still fit the 600 px row without it scrolling',
     await p.evaluate(()=>$('app-row').scrollWidth+' of '+$('app-row').clientWidth));
t.ok(!await p.evaluate(()=>!!document.getElementById('trk-course')),
     'with nothing left on the track rail to reach it by');
await p.evaluate(()=>{ const i=APPS.findIndex(a=>a.id==='course');
  document.querySelector('#app-row [data-app="'+i+'"]').click(); });
await p.waitForTimeout(800);
let S=await sheet();
t.ok(await p.evaluate(()=>$('t-course').classList.contains('on')), 'it is up');
t.ok(await p.evaluate(()=>$('t-course').parentElement.id)==='app-body',
     'in the app frame, not over the map',
     await p.evaluate(()=>$('t-course').parentElement.id));
t.ok(await p.evaluate(()=>!tmap.classList.contains('open')),
     'and the map is not running behind it - no tiles, no track');
t.ok(await p.evaluate(()=>$('app-name').textContent)==='Course',
     'the app pill is the sheet\'s title now, rather than a second one '
     +'under it saying COURSE twice',
     await p.evaluate(()=>$('app-name').textContent));
const marks=x=>x.filter(r=>r.mark);
t.ok(marks(S).length===11, 'all eleven of the club\'s marks, as tiles', String(S.length));
let L=await line();
t.ok(L.inStrip && L.first, 'the line leads the route, in line with it - you '
     +'start on it, and the FINISH at the other end is it come home to',
     JSON.stringify({inStrip:L.inStrip, first:L.first}));
t.ok(L.val==='FLAG – BALL', 'and says which two marks it runs between', L.val);
t.ok(L.glyph, 'drawn as a line between two ends, the way the map draws it');
t.ok(L.survives, 'and it is the same node after a repaint - a menu is '
     +'anchored to it, and a rebuilt node would close the menu over it');
t.ok(await p.evaluate(()=>$('course-clr').closest('.cv-hd')
       .querySelector('span').textContent.trim())==='Route',
     'CLEAR is on the route it clears');
t.ok(await p.evaluate(()=>$('course-edit').closest('.cv-hd')
       .querySelector('span').textContent.trim())==='Marks',
     'and EDIT on the list it edits');
t.ok(await p.evaluate(()=>!document.querySelector('#course-main .course-bar')),
     'and the row of four buttons across the foot is gone');
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
t.ok(await p.evaluate(()=>[...document.querySelector('.cv').children]
       .map(k=>k.id||k.className.split(' ')[0]).join(' '))
     ==='cv-set cv-hd cv-strip cv-hd course-list',
     'the evening first, then the route, then the marks - the thing you '
     +'set once above the two you work at all evening',
     await p.evaluate(()=>[...document.querySelector('.cv').children]
       .map(k=>k.id||k.className.split(' ')[0]).join(' ')));
/* and the menus fall INTO the sheet now, not off the top of the glass:
   they asked to open upward when the row was across the foot with the
   sheet's own button bar under it, and both of those are gone */
for(const k of ['mode','club']){
  await p.evaluate(x=>{ pickClose(); cvpOpen(x); }, k);
  await p.waitForTimeout(300);
  const m=await p.evaluate(x=>{ const s=$('stage').getBoundingClientRect(),
      a=$('cv-'+(x==='club'?'sync':x)).getBoundingClientRect(),
      b=$('pick').getBoundingClientRect();
    return {below:b.top>=a.bottom-2, top:b.top-s.top, bot:b.bottom-s.top}; }, k);
  t.ok(m.below && m.top>0 && m.bot<1080,
       'the '+k+' menu drops below its readout and stays on the glass',
       JSON.stringify(m));
}
await p.evaluate(()=>pickClose()); await p.waitForTimeout(200);
t.ok(await p.evaluate(()=>[...document.querySelectorAll('.cv-set .cvr')]
       .map(e=>e.querySelector('s').textContent).join())
     ==='START TIME,COUNTDOWN,SEQUENCE,CLUB',
     'the evening on one row, the two clock facts together and the line '
     +'gone up to the route',
     await p.evaluate(()=>[...document.querySelectorAll('.cv-set .cvr')]
       .map(e=>e.querySelector('s').textContent).join()));
t.ok(await p.evaluate(()=>{const t=document.querySelector('.cv-tile.add');
       return !!t && t===$('course-list').lastElementChild;}),
     'and a mark is added from the END of the grid, where the new one '
     +'will appear');
t.ok(!await p.evaluate(()=>$('course-done')),
     'there is no DONE beside the heading - the cross at the foot is the '
     +'one way out, and it goes back one step');
/* The cross still goes back one step - there is just one fewer step to
   go back through now that the sheet is the app rather than a thing
   over one. */
await p.evaluate(()=>mkOpen()); await p.waitForTimeout(300);
await tap('#app-close');
t.ok(await p.evaluate(()=>getComputedStyle($('course-add')).display)==='none'
     && await p.evaluate(()=>$('app-run').classList.contains('on')),
     'the first tap leaves the mark form, not the app');
await tap('#app-close');
t.ok(!await p.evaluate(()=>$('app-run').classList.contains('on')),
     'and with nothing in front of it, the cross closes the app');
t.ok(await p.evaluate(()=>$('t-course').parentElement.id)==='stage',
     'the sheet going home before the app frame is wiped',
     await p.evaluate(()=>$('t-course').parentElement.id));
await p.evaluate(()=>openCourse());
await p.waitForTimeout(700);

t.head('a tap puts a mark in the course, and the strip is the order');
await p.evaluate(()=>{ COURSE.marks=[]; COURSE.next=0; COURSE.side=[]; courseSave(); renderCourse(); });
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

t.head('and another tap rounds the same mark a second time');
await tap(row('rum'));
S=await sheet(); C=await course(); T=await strip();
t.ok(C.marks.join()==='rum,gosling,cb12,rum', 'the course has it twice', C.marks.join());
t.ok(T.map(c=>c.name).join()==='RUM,GOSLING,CB 12,RUM,FINISH',
     'and the strip sails past it twice', T.map(c=>c.name).join());
t.ok(seqOf('rum')==='1,4', 'the tile owns both places', seqOf('rum'));
t.ok(S.find(r=>r.mark==='rum').in, 'and is still marked as in the course');

t.head('the number on a chip takes THAT rounding out, and no other');
await tap(chipNo(3));
C=await course(); T=await strip();
t.ok(C.marks.join()==='rum,gosling,cb12', 'the second rounding is gone', C.marks.join());
t.ok((await sheet()).find(r=>r.mark==='rum').seq==='1',
     'and the first is untouched', (await sheet()).find(r=>r.mark==='rum').seq);
await tap(chipNo(0));
C=await course();
t.ok(C.marks.join()==='gosling,cb12', 'the first goes the same way', C.marks.join());
t.ok(!(await sheet()).find(r=>r.mark==='rum').in, 'and the tile is out of the course');
await tap(row('rum'));                    /* back on the end, not where it was */
C=await course();
t.ok(C.marks.join()==='gosling,cb12,rum', 'it comes back last, not where it was', C.marks.join());

t.head('a tap on a chip flips which side that rounding is left on');
T=await strip();
t.ok(T.find(c=>c.name==='GOSLING').side==='P', 'port until told otherwise');
t.ok(T.every(c=>c.fin||c.side), 'every mark in the course carries a side');
await tap(chip(0));
T=await strip(); C=await course();
t.ok(T.find(c=>c.name==='GOSLING').side==='S', 'the chip now says S');
t.ok(C.side[0]==='S', 'and is kept with the course', String(C.side[0]));
t.ok(C.marks.join()==='gosling,cb12,rum',
     'and flipping a side did not take the mark out of the course', C.marks.join());
await p.evaluate(()=>drawMap(shownTrack())); await p.waitForTimeout(250);
t.ok(await p.evaluate(()=>[...$('t-path').querySelectorAll('text')]
       .some(x=>x.textContent==='S')), 'the map letters it too');

t.head('the mark being sailed to is the one lit');
T=await strip();
t.ok(T.find(c=>c.name==='GOSLING').next, 'the first, before any is rounded');
await p.evaluate(()=>{ courseAdvance(); renderCourse(); }); await p.waitForTimeout(200);
T=await strip();
t.ok(!T.find(c=>c.name==='GOSLING').next && T.find(c=>c.name==='CB 12').next,
     'and the next one once that is behind');
t.ok(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)===3,
     'all three are on the map',
     String(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)));
await p.evaluate(()=>{ COURSE.next=0; courseSave(); renderCourse(); });

t.head('the two roundings of one mark keep their own sides');
await p.evaluate(()=>{ COURSE.marks=['rum','gosling','rum']; COURSE.next=0;
                       COURSE.side=['P','P','P']; courseSave(); renderCourse(); });
await tap(chip(2));
T=await strip(); C=await course();
t.ok(C.side.join()==='P,P,S', 'only the rounding tapped flipped', C.side.join());
t.ok(T[0].side==='P' && T[2].side==='S',
     'out to port and back to starboard, on one buoy', T[0].side+T[2].side);
await p.evaluate(()=>drawMap(shownTrack())); await p.waitForTimeout(250);
t.ok(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)===2,
     'the map draws one circle per buoy, not one per rounding',
     String(await p.evaluate(()=>$('t-path').querySelectorAll('.t-mark').length)));
t.ok(await p.evaluate(()=>[...$('t-path').querySelectorAll('text')]
       .some(x=>x.textContent==='1,3')), 'carrying both its numbers');

t.head('taking out a mark already rounded does not leave the course past its end');
await p.evaluate(()=>{ COURSE.marks=['gosling','cb12','rum']; COURSE.next=3;
                       COURSE.side=['S','P','P']; courseSave(); renderCourse(); });
await tap(chipNo(2));
C=await course();
t.ok(C.marks.length===2 && C.next<=2, 'next is pulled back to the end',
     C.next+' of '+C.marks.length);
t.ok(C.side.join()==='S,P', 'and the side of the one removed goes with it',
     C.side.join());
await p.evaluate(()=>{ COURSE.next=0; courseSave(); renderCourse(); });

t.head('CLEAR empties the course and leaves the marks alone');
await p.evaluate(()=>{ COURSE.marks=['gosling','cb12','rum']; COURSE.next=1;
                       courseSave(); renderCourse(); });
await tap('#course-clr');
C=await course(); S=await sheet();
t.ok(C.marks.length===0 && C.next===0, 'nothing left to sail', C.marks.join()+' @'+C.next);
t.ok(marks(S).length===11 && marks(S).every(r=>r.seq===''),
     'the marks are all still there, unnumbered');
/* An empty route is the line and the finish - start here, come back
   here, which is what a race with no course between them is. It used to
   say NOTHING YET · TAP A MARK BELOW, OR SYNC THE CLUB'S, a sentence
   about the two things directly under it. */
const T0=await strip();
t.ok(T0.length===1 && T0[0].fin, 'the strip is the finish and nothing else',
     T0.map(c=>c.name).join()||'(empty)');
t.ok(!await p.evaluate(()=>$('cv-strip').textContent.match(/NOTHING YET|TAP A MARK/)),
     'with no sentence telling you what to do about it',
     await p.evaluate(()=>$('cv-strip').textContent.trim()));
t.ok(await p.evaluate(()=>!!$('cv-line')),
     'and the line still leading it, because that much is always true');
await tap(row('gosling')); await tap(row('cb12'));
await p.evaluate(()=>{ COURSE.side=['S','P']; courseSave(); renderCourse(); });

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
L=await line();
t.ok(L.val==='PINGED', 'a pinged line says so', L.val);
t.ok(await p.evaluate(()=>lineEnds().pinged), 'and is the line the readings use');
await tap('#cv-line');
let M=await menu();
t.ok(M.on, 'the control opens its menu');
t.ok(await p.evaluate(()=>$('cv-line').classList.contains('picking')),
     'and is lit while it is open');
t.ok(M.sel==='PINGED', 'lit on the pinged line', String(M.sel));
/* The way back from a ping taken at the wrong end: choose the marks. */
await tap('#pick-pk .pkset[data-line="marks"]');
t.ok(await p.evaluate(()=>!lineEnds().pinged
       && !$('ping-pin').classList.contains('set')
       && !$('ping-boat').classList.contains('set')),
     'choosing the marks drops the pings, and the ping buttons go out with them');
t.ok((await line()).val==='FLAG – BALL', 'back on the club marks',
     (await line()).val);
t.ok(!(await menu()).on, 'and the menu is done');

t.head('and the menu offers the two lines there are');
await tap('#cv-line');
M=await menu();
t.ok(M.rows.join()==='FLAG – BALL,PINGED', 'the club\'s marks, or the one you pinged',
     M.rows.join());
t.ok(M.sel==='FLAG – BALL', 'on the one in force', String(M.sel));
t.ok(/P AND B/.test(await p.evaluate(()=>$('pick-pk').textContent)),
     'and says where a pinged line comes from',
     await p.evaluate(()=>$('pick-pk').textContent.trim()));
t.ok(await p.evaluate(()=>!!$('pick-pk').querySelector('.pkset.off')),
     'with the pinged one shown but not available, rather than left out');
await tap('#pick-pk .pkset[data-line="marks"]');
t.ok(!(await menu()).on && !await p.evaluate(()=>lineEnds().pinged),
     'choosing the marks when they are already in force changes nothing');

t.head('the sequence is chosen the same way');
await tap('#cv-mode');
M=await menu();
t.ok(M.rows.join()==='GUN,WINDOW' && M.sel==='GUN', 'both, opened on the one in force',
     M.sel+' of '+M.rows.join());
await tap('#pick-pk .pkset[data-mode="window"]');
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
t.ok((await rd('cv-mins')).val==='OFF',
     'and then OFF - a countdown of nothing, written as the absence of '
     +'the thing rather than as 0 MIN, which reads as a broken number',
     (await rd('cv-mins')).val);
t.ok(await p.evaluate(()=>CFG.startMins)===0, 'which is nought minutes',
     String(await p.evaluate(()=>CFG.startMins)));
await tap('#cv-mins');
t.ok((await rd('cv-mins')).val==='5 MIN', 'and round again rather than stopping');
await tap('#cv-mins');
t.ok(await p.evaluate(()=>Math.round(tLeft/60000))===10,
     'the countdown itself is the new length, not the old one at the next reset',
     String(await p.evaluate(()=>Math.round(tLeft/60000))));

t.head('OFF starts the race where a countdown would have begun');
await p.evaluate(()=>{ resetAll(); CFG.startMins=0; prefsSave();
  tLeft=0; renderCourse();
  feedPut('pos.lat',28.8190,'sk'); feedPut('pos.lon',-81.2650,'sk'); });
await p.waitForTimeout(200);
t.ok(await p.evaluate(()=>tState)==='idle' && await p.evaluate(()=>tLeft)===0,
     'idle, with nothing to count');
await p.evaluate(()=>startCountdown()); await p.waitForTimeout(700);
t.ok(await p.evaluate(()=>tState)==='racing',
     'START and the gun has gone - no sequence to sit through',
     await p.evaluate(()=>tState));
/* Put back what the section below this one is about to read. Surviving
   a reload is persist.mjs's question, not this file's. */
await p.evaluate(()=>{ resetAll(); CFG.startMins=10; prefsSave();
                       tLeft=10*60000; renderCourse(); });
await p.waitForTimeout(200);
t.ok(JSON.parse(await p.evaluate(()=>localStorage.getItem('helmPrefs'))).startMins===10,
     'and it is kept over a restart');
await p.evaluate(()=>{ CFG.startMins=5; prefsSave(); resetAll(); renderCourse(); });

t.head('a tap anywhere else puts the menu away');
await tap('#cv-mode');
t.ok((await menu()).on, 'open');
/* High on the glass, clear of the menu itself - the veil is the whole
   sheet and the menu is on top of the middle of it. */
await p.click('#pick-veil',{position:{x:540,y:120}}); await p.waitForTimeout(250);
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
                          /* a class now, not an inline display: the pad
                             comes up OVER the sheet rather than in place
                             of it, so the sheet's own display never moves */
                          open:$('course-gun').classList.contains('on'),
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
t.ok(await p.evaluate(()=>{ gnOpen();
       const over=getComputedStyle($('course-main')).display!=='none'
              && $('gn-veil').classList.contains('on');
       gnClose(); return over; }),
     'the pad comes up OVER the sheet, not in place of it - the course '
     +'you are setting a time for is the one thing worth seeing while '
     +'you set it');
t.ok(await p.evaluate(()=>{ gnOpen(); const r=$('course-gun').getBoundingClientRect();
       gnClose(); return r.width<1080 && r.height<1080 && r.width<=700; }),
     'and it is a pop-out, not a page');
/* The dim is not decoration. The one thing behind it that is a real
   hazard is the app's cross, which closes the whole app - so the veil
   has to be over THAT, not merely over the sheet. */
const veil=await p.evaluate(()=>{ gnOpen();
  const g=getComputedStyle($('gn-veil'));
  const r=$('app-close').getBoundingClientRect(), s=$('stage').getBoundingClientRect();
  const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
  const out={op:+g.opacity, vis:g.visibility, bg:g.backgroundColor,
             overCross: hit===$('gn-veil') || $('gn-veil').contains(hit),
             arc:$('arc').classList.contains('lit')};
  gnClose(); return out; });
t.ok(veil.op>0.3 && veil.vis==='visible', 'the page behind it is dimmed',
     JSON.stringify(veil));
t.ok(veil.overCross, 'including the app\'s own cross - a tap where it is '
     +'lands on the veil, which puts the pad away rather than shutting '
     +'the app out from under you');
t.ok(!veil.arc, 'and no scroll track is left drawn over a modal');
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

t.head('and the course, drawn');
/* The strip says what the course IS, in order. It cannot say what it
   looks like - which of the two marks off the point is the third one,
   whether leg two is a beat or a reach. This is that, off the same
   positions the dial steers to. */
await p.evaluate(()=>{ COURSE.marks=['gosling','cb12','rum']; COURSE.next=1;
  COURSE.side=['P','S','P']; courseSave(); renderCourse(); });
await p.waitForTimeout(250);
const prev=()=>p.evaluate(()=>{
  const c=$('.cp'?'cp-svg':'cp-svg'), card=document.querySelector('.cp'),
        q=card.getBoundingClientRect();
  const d=[...c.querySelectorAll('.leg')].map(e=>e.getAttribute('d')||'straight');
  return {on:$('cprev').classList.contains('on'),
          legs:c.querySelectorAll('.leg').length,
          arrows:c.querySelectorAll('.arw').length,
          marks:c.querySelectorAll('.mk').length,
          lit:c.querySelectorAll('.mk.on').length,
          nums:[...c.querySelectorAll('text.n')].map(e=>e.textContent),
          foot:$('cp-foot').textContent, bowed:d.filter(x=>x!=='straight').length,
          me:c.querySelectorAll('.me').length,
          scrim:getComputedStyle($('cprev')).backgroundColor,
          out:[[q.left,q.top],[q.right,q.top],[q.left,q.bottom],[q.right,q.bottom]]
            .filter(([x,y])=>Math.hypot(x-540,y-540)>534).length}; });
await tap('#course-prev'); await p.waitForTimeout(400);
let V=await prev();
t.ok(V.on, 'PREVIEW puts it up');
t.ok(/rgba\(0, 0, 0/.test(V.scrim), 'on a scrim, because what is behind it is '
     +'the thing it is a picture of', V.scrim);
t.ok(V.out===0, 'and every corner of the card is on the glass');
t.ok(V.legs===4 && V.arrows===4,
     'three marks is four legs - out to each and home to the line - and '
     +'every one of them says which way round it goes',
     V.legs+' legs, '+V.arrows+' arrows');
t.ok(V.marks===3 && V.nums.join()==='1,2,3', 'the marks numbered in the '
     +'order they are rounded', V.nums.join());
t.ok(V.lit===1, 'with the one being sailed to filled in, the same as the strip');
t.ok(/3 LEGS|4 LEGS/.test(V.foot) && /\d\.\d\d NM/.test(V.foot),
     'and the whole course measured at the foot', V.foot);
t.ok(V.bowed===0, 'nothing bows when no leg is sailed twice', String(V.bowed));

t.head('a mark rounded twice is one circle, and the legs bow apart');
/* A windward-leeward is two marks sailed twice. Drawn straight, the way
   back lies exactly on the way out: one line, one arrow, and no way to
   tell a four-leg course from a two. */
await p.evaluate(()=>{ COURSE.marks=['rum','gosling','rum']; COURSE.next=0;
  COURSE.side=['P','S','S']; courseSave(); renderCourse(); prevDraw(); });
await p.waitForTimeout(300);
V=await prev();
t.ok(V.marks===2 && V.nums.join()==='1,3,2',
     'one circle per buoy, carrying both its numbers', V.nums.join());
t.ok(V.legs===4 && V.bowed===4,
     'and all four legs bowed off their pair, so out and back are two '
     +'lines rather than one drawn twice', V.bowed+' of '+V.legs);
t.ok(await p.evaluate(()=>{
       const d=[...document.querySelectorAll('#cp-svg .leg')].map(e=>e.getAttribute('d'));
       return new Set(d).size===d.length; }),
     'each on its own side, not two curves on top of each other');

t.head('an empty course is the line and nothing else');
await p.evaluate(()=>{ COURSE.marks=[]; COURSE.side=[]; courseSave();
                       renderCourse(); prevDraw(); });
await p.waitForTimeout(250);
V=await prev();
t.ok(V.legs===0 && V.marks===0, 'no legs to draw', V.legs+'/'+V.marks);
t.ok(/NO COURSE SET/.test(V.foot), 'and it says so rather than measuring '
     +'nothing at all', V.foot);

t.head('and the ways out of it');
await p.evaluate(()=>{ const s=$('stage').getBoundingClientRect();
  $('cprev').dispatchEvent(new MouseEvent('click',
    {bubbles:true, clientX:s.x+40, clientY:s.y+540})); });
await p.waitForTimeout(400);
t.ok(!(await prev()).on, 'a tap on the scrim puts it away');
await tap('#course-prev'); await p.waitForTimeout(300);
/* The scrim is the only way out, and deliberately: it dims the app's
   cross along with the sheet, the same as the start pad and the radio
   picker do, so the lit thing is the card. A cross you can see but not
   press is worse than no cross. */
t.ok(await p.evaluate(()=>{
       const x=$('app-close').getBoundingClientRect();
       return document.elementFromPoint(x.left+x.width/2, x.top+x.height/2)
              ===$('cprev'); }),
     'the cross under it belongs to the scrim while the picture is up');
await p.evaluate(()=>prevClose()); await p.waitForTimeout(300);
t.ok(await p.evaluate(()=>$('app-run').classList.contains('on')),
     'and closing the picture leaves the app standing');
await p.evaluate(()=>{ COURSE.marks=['gosling','cb12','rum']; COURSE.next=0;
  COURSE.side=['P','P','P']; courseSave(); renderCourse(); });
await p.waitForTimeout(200);

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
