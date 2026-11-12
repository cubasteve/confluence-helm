/* What a box does when it has more in it than it can show: no native
   scrollbar anywhere, a fade at the edge the content is crossing, and
   the arc out on the rim while you are moving. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});
await p.evaluate(()=>openCourse());
await p.waitForTimeout(700);

const bar=sel=>p.evaluate(s=>{ const el=document.querySelector(s);
  return {gutter:el.offsetWidth-el.clientWidth,
          hidden:getComputedStyle(el).scrollbarWidth==='none'}; }, sel);
const arc=()=>p.evaluate(()=>({
  lit:$('arc').classList.contains('lit'),
  on:$('arc').classList.contains('on'),
  trk:$('arc-t').getAttribute('d'), thm:$('arc-h').getAttribute('d')}));
/* The two ends of a path, as the numbers actually written into it. */
/* The indicator is a filled ribbon lying on the drum, not an arc of the
   glass: a polygon of x y pairs. What a probe wants off it is where it
   starts and ends down the box, how far out it stands, and whether it
   bulges in the middle the way the rows beside it do. */
const ends=d=>{
  const pts=[...d.matchAll(/([\d.]+) ([\d.]+)/g)].map(m=>({x:+m[1], y:+m[2]}));
  if(pts.length<4) return null;
  const ys=pts.map(q=>q.y), xs=pts.map(q=>q.x);
  /* the outer edge at the top, at the middle, and at the foot */
  const at=f=>{ const y0=Math.min(...ys), y1=Math.max(...ys), y=y0+(y1-y0)*f;
    let best=null;
    for(const q of pts) if(Math.abs(q.y-y)<(y1-y0)/12+1)
      if(!best||q.x>best) best=q.x;
    return best; };
  return {y0:Math.min(...ys), y1:Math.max(...ys),
          x0:Math.min(...xs), x1:Math.max(...xs),
          top:at(0), mid:at(0.5), foot:at(1)};
};
const grid=()=>p.evaluate(()=>{ const el=$('course-list'),
  s=$('stage').getBoundingClientRect(), r=el.getBoundingClientRect();
  return {over:el.classList.contains('over'), masked:!!getComputedStyle(el)
            .webkitMaskImage.match(/gradient/),
          top:r.top-s.top, bottom:r.bottom-s.top, right:r.right-s.left,
          scroll:el.scrollHeight, client:el.clientHeight}; });
/* The marks grid turns rather than scrolls, so "scroll it to n" means
   "put the wheel n pixels round". Behind the one helper, so every call
   site below reads the same as it did. */
const scrollTo=n=>p.evaluate(v=>{ const el=$('course-list'), w=WHEEL.get(el);
  if(w&&w.on&&w.cyc){ w.off=((v%w.cyc)+w.cyc)%w.cyc;
                      drumPaint(el); rimDraw(el,true); }
  else el.scrollTop=v;
  el.dispatchEvent(new Event('scroll')); }, n);
const cyc=()=>p.evaluate(()=>{ const w=WHEEL.get($('course-list'));
  return w&&w.on?w.cyc:0; });

t.head('no box on the glass shows the browser its own scrollbar');
await p.evaluate(()=>{ COURSE.marks=[]; COURSE.next=0; COURSE.side=[];
  courseSave(); openCourse(); });
await p.waitForTimeout(400);
for(const [sel,what] of [['#course-list','the marks grid'],
                         ['#lib-list','the race library'],
                         ['#app-row',"the dock's row of apps"],
                         ['.sheet','the settings sheet']]){
  const v=await bar(sel);
  t.ok(v.hidden, 'nor does '+what, JSON.stringify(v));
  t.ok(v.gutter===0, 'and '+what+' keeps the width the bar would have taken',
       String(v.gutter));
}

t.head('a box that fits says nothing at all');
/* The book is twelve now - eleven surveyed buoys and the committee's
   drop - and twelve tiles plus NEW MARK is a fourth row, so the real
   grid no longer fits and this section has to build something that does.
   That is a true thing about the page rather than a probe working around
   itself: the stock mark grid scrolls, which is why the drum and the
   fade exist. The case below still has to be tested, because a box that
   fits must stay silent. */
const SPARE=await p.evaluate(()=>MARKS.splice(MARKS.length-3,3));
await p.evaluate(()=>renderCourse()); await p.waitForTimeout(250);
let G=await grid();
t.ok(!G.over, 'nine marks fit, so no fade', G.scroll+' in '+G.client);
t.ok(!G.masked, 'and nothing is masked');
await scrollTo(0);
t.ok(!(await arc()).lit, 'and there is no arc to draw');
await p.evaluate(sp=>{ MARKS.push(...sp); renderCourse(); }, SPARE);
await p.waitForTimeout(250);
t.ok((await grid()).over, 'and the twelve the boat actually carries do NOT '
     +'fit - the committee\'s mark is the one that tipped the grid into a '
     +'fourth row', (await grid()).scroll+' in '+(await grid()).client);
t.ok(await p.evaluate(()=>[...$('course-list').children]
       .every(k=>/rotateX/.test(k.style.transform))),
     'and the grid still turns - a drum is what this list IS, not a '
     +'thing that happens to it once it gets long');

t.head('a box that does not fit fades at the edge the content crosses');
await p.evaluate(()=>{
  ['NORTH PIN','SOUTH PIN','DOCK','SPOIL','WEED BED','TOWER'].forEach((n,i)=>{
    MARKS.push({id:'z'+i, name:n, hdr:n.split(' ')[0], buoy:'o',
                lat:28.82+i*0.001, lon:-81.265}); });
  renderCourse(); });
await p.waitForTimeout(300);
G=await grid();
t.ok(G.over, 'seventeen do not, so the fade goes on', G.scroll+' in '+G.client);
t.ok(G.masked, 'and it is a gradient, not a cut');
t.ok((await arc()).lit, 'and the track is up BEFORE anything is touched - '
     +'that is what says the list goes on');
t.ok(!(await arc()).on, 'with no thumb yet: where you are is a question '
     +'you ask by scrolling');
const edges=()=>p.evaluate(()=>{ const c=$('course-list').classList;
  return {a:c.contains('over-a'), z:c.contains('over-z')}; });
let E=await edges();
/* This used to read "at the top only the bottom fades - nothing is
   above it", and then the mirror of it at the end. Neither is true of a
   wheel and neither should be: there is no top to be at. Both edges
   have something behind them at every angle, which is the honest
   picture of a surface that goes round, and the thing that would be
   WRONG now is a grid that faded only one way - that is a list sitting
   on its first row, which this is not. */
t.ok(E.a && E.z, 'both edges fade at rest, because a wheel has no ends',
     JSON.stringify(E));
await scrollTo(60); await p.waitForTimeout(120);
E=await edges();
t.ok(E.a && E.z, 'and both of them a little way round', JSON.stringify(E));
await scrollTo(9999); await p.waitForTimeout(120);
E=await edges();
t.ok(E.a && E.z, 'and both wherever else you stop it', JSON.stringify(E));

t.head('the rows sit on a drum, and only when there is a drum to sit on');
/* Each tile's rotateX in degrees, read back off the matrix, with the
   opacity it was dimmed to. Grouped by row: four tiles across share a y,
   so they must share an angle or they are not one surface. */
const rows=()=>p.evaluate(()=>{
  const out={}, seen={};
  for(const k of $('course-list').children){
    const m=k.style.transform.match(/rotateX\(([-\d.]+)deg\)/);
    const y=k.offsetTop;
    (out[y]=out[y]||[]).push({a:m?+m[1]:null, o:+(k.style.opacity||1)});
    /* Grouped by where the GRID put them, which is exact, but ordered
       by where they are ON THE GLASS - on a wheel a row that has gone
       round sits at the top while its offsetTop still says it is the
       last one. Sorting by layout read the surface in the wrong order
       and called a perfectly good drum crooked. */
    seen[y]=k.getBoundingClientRect().top;
  }
  return Object.keys(out).sort((a,b)=>seen[a]-seen[b]).map(y=>out[y]);
});
await scrollTo(0); await p.waitForTimeout(250);
let R=await rows();
t.ok(R.length>=3, 'with seventeen there are rows to curve', String(R.length));
t.ok(R.every(r=>r.every(k=>k.a===r[0].a)),
     'the four tiles across a row share one angle - it is a surface, '
     +'not four tilted tiles');
const ang=R.map(r=>r[0].a), op=R.map(r=>r[0].o);
t.ok(ang[0]>0 && ang[ang.length-1]<0,
     'the top tips one way and the bottom the other', ang.join(' '));
t.ok(ang.every((a,i)=>i===0||a<ang[i-1]),
     'and every row between them is further round than the last',
     ang.join(' '));
/* Whichever row is square on is the one facing you, wherever the scroll
   has put it - so the probe finds it rather than assuming the middle. */
const face=ang.indexOf(ang.reduce((m,a)=>Math.abs(a)<Math.abs(m)?a:m));
t.ok(op[face]===Math.max(...op),
     'the row nearest square on is the brightest', op.join(' ')+' @'+face);
t.ok(op.every((o,i)=>i===face || o<op[face]),
     'and every row going round is dimmer than it', op.join(' '));

t.head('and the drum turns under the scroll');
const before=(await rows()).map(r=>r[0].a);
await scrollTo(92); await p.waitForTimeout(250);
const after=(await rows()).map(r=>r[0].a);
t.ok(before.join()!==after.join(), 'the angles are re-laid as it moves',
     before.join(' ')+' -> '+after.join(' '));
await scrollTo(0); await p.waitForTimeout(200);

t.head('the arc spans the rows the box is a window onto');
await scrollTo(90);
await p.waitForTimeout(150);
let A=await arc();
t.ok(A.on, 'the scroll brings it up');
const T=ends(A.trk), H=ends(A.thm);
t.ok(T && H, 'both are ribbons', A.trk.slice(0,40)+' / '+A.thm.slice(0,40));
t.ok(Math.abs(T.y0-G.top)<2 && Math.abs(T.y1-G.bottom)<2,
     "the track's ends sit beside the box's own top and bottom",
     [T.y0,T.y1].join()+' vs '+[G.top,G.bottom].join());
t.ok(H.y0>=T.y0-0.5 && H.y1<=T.y1+0.5, 'and the thumb is inside the track',
     [H.y0,H.y1].join()+' in '+[T.y0,T.y1].join());
/* Clear of the ROWS, which is the honest test: the track pulls in at
   the ends, and so do they - measuring it against the box's own
   untransformed edge would only say the drum is working. */
t.ok(await p.evaluate(()=>{
       const s=$('stage').getBoundingClientRect();
       const pts=[...$('arc-t').getAttribute('d').matchAll(/([\d.]+) ([\d.]+)/g)]
         .map(m=>({x:+m[1], y:+m[2]}));
       for(const k of $('course-list').children){
         const r=k.getBoundingClientRect();
         const right=r.right-s.left, mid=(r.top+r.bottom)/2-s.top;
         for(const q of pts) if(Math.abs(q.y-mid)<r.height/2 && q.x<right+4)
           return false;
       }
       return true; }),
     'beside the list and never over a row, at any height - it pulls in '
     +'at the ends because the rows do');
/* the whole point of the change: it lies on the drum, so it bulges
   about the middle of the BOX - not about the middle of the glass,
   which is where an arc of the rim put it, and which a list is hardly
   ever centred on */
t.ok(T.mid>T.top+12 && T.mid>T.foot+12,
     'and bulges out at the middle the way the rows beside it do',
     [T.top,T.mid,T.foot].map(Math.round).join(' '));
t.ok(Math.abs(T.top-T.foot)<6,
     'symmetrically - both ends pull in by the same amount, because the '
     +'drum is centred on the list and not on the glass',
     [T.top,T.foot].map(Math.round).join(' '));

t.head('and it goes round with the wheel');
/* The thumb is 69% of the track here - the box is a window onto most of
   one turn - so for most of a turn it runs off the foot and comes round
   the top, and is drawn as two pieces. What walks is its LEADING EDGE,
   which is the thing "where am I" means; ends() over the whole path
   would hand back the union of both pieces and say it covers
   everything. */
const lead=d=>ends(d.slice(0, d.indexOf('Z')+1));
const at=async n=>{ await scrollTo(n); await p.waitForTimeout(120);
                    return (await arc()).thm; };
const C=await cyc();
const a1=lead(await at(0)), a2=lead(await at(C*0.1)), a3=lead(await at(C*0.2));
t.ok(a1.y0<a2.y0 && a2.y0<a3.y0, 'the thumb walks down as the wheel turns',
     [a1.y0,a2.y0,a3.y0].map(Math.round).join(' '));
t.ok(Math.abs(a1.y0-(await grid()).top)<2,
     'from the top of the track at the top of the turn',
     a1.y0+' vs '+(await grid()).top);
/* The whole point of the thing: one more turn and you are back where
   you started, rather than stopped against an end. */
const round=lead(await at(C));
t.ok(Math.abs(round.y0-a1.y0)<1,
     'and a full turn brings it back to where it began',
     [round.y0,a1.y0].map(Math.round).join(' vs '));
const two=await at(C*0.5);
t.ok((two.match(/M/g)||[]).length===2,
     'half way round it is in two pieces - running off the foot and '
     +'coming back over the top, which is what a wheel does',
     String((two.match(/M/g)||[]).length));

t.head('a very long list still gets a thumb you can see');
await p.evaluate(()=>{ for(let i=0;i<120;i++)
    MARKS.push({id:'q'+i, name:'MARK '+i, hdr:'M'+i, buoy:'o',
                lat:28.82, lon:-81.265});
  renderCourse(); });
await p.waitForTimeout(300);
await scrollTo(200); await p.waitForTimeout(150);
const L=ends((await arc()).thm), LT=ends((await arc()).trk);
t.ok(L.y1-L.y0>20, 'not a dot', String((L.y1-L.y0).toFixed(1)));
t.ok(L.y0>=LT.y0-0.5 && L.y1<=LT.y1+0.5, 'and still inside the track',
     [L.y0,L.y1].join()+' in '+[LT.y0,LT.y1].join());

t.head('the thumb goes away when you stop, and the track does not');
t.ok((await arc()).on, 'the thumb is up while moving');
await p.waitForTimeout(1200);
let A2=await arc();
t.ok(!A2.on, 'and down a beat after the last scroll');
t.ok(A2.lit, 'but the track stays lit while the list is still longer than the box');
t.ok((await grid()).over, 'and so does the fade');

t.head('the marks grid is a wheel, and a wheel has no end to stop at');
/* What it was: twelve marks and NEW MARK make four rows in a box that
   shows three and a half, so a flick had 47 pixels to run and hit the
   bottom in about a seventh of a second. It was drawn as a drum and
   behaved like a drawer. */
const wheel=()=>p.evaluate(()=>{ const w=WHEEL.get($('course-list'));
  return w?{on:w.on, off:Math.round(w.off), cyc:w.cyc,
            scrollTop:$('course-list').scrollTop}:null; });
const tops=()=>p.evaluate(()=>[...$('course-list').children]
  .map(k=>Math.round(k.getBoundingClientRect().top)));
const marks=()=>p.evaluate(()=>({
  tiles:document.querySelectorAll('#course-list .cv-tile[data-mark]').length,
  book:MARKS.length}));

/* The section above pushed a hundred and twenty marks to get a thumb
   worth measuring. Take them back out: seventeen is five rows, which is
   a wheel with something to say and still a book you can read. */
await p.evaluate(()=>{ for(let i=MARKS.length-1;i>=0;i--)
    if(/^q\d+$/.test(MARKS[i].id)) MARKS.splice(i,1);
  renderCourse(); });
await p.waitForTimeout(250);
let W=await wheel();
t.ok(W.on && W.cyc>0, 'with more marks than fit, it turns', JSON.stringify(W));
t.ok(W.cyc%101===0, 'one turn is a whole number of rows', String(W.cyc));

/* A grid with nowhere to go should not turn for the sake of it - the
   same rule the fades keep two sections up. */
/* Down to eleven exactly: twelve tiles is three rows, and three rows
   fit. Counted rather than trimmed by a fixed number, because what is
   in MARKS here is whatever the sections above left behind. */
const FEW=await p.evaluate(()=>MARKS.splice(11));
await p.evaluate(()=>renderCourse()); await p.waitForTimeout(250);
t.ok(!(await wheel()).on, 'and a book that already fits does not turn at all',
     JSON.stringify(await wheel()));
t.ok(!(await p.evaluate(()=>$('course-list').classList.contains('wheel'))),
     'so the box keeps its ordinary scroll');
await p.evaluate(f=>{ MARKS.push(...f); renderCourse(); }, FEW);
await p.waitForTimeout(250);

t.head('a row that leaves the bottom is the same row coming round the top');
await scrollTo(0); await p.waitForTimeout(150);
t.ok(await p.evaluate(()=>{ const ks=[...$('course-list').children];
       return ks[ks.length-1].getBoundingClientRect().top
            < ks[0].getBoundingClientRect().top; }),
     'the last row in the grid is drawn above the first - it has gone '
     +'round, which is the whole of what a wheel is');
/* MOVED, not copied. Two tiles carrying the same data-mark would make
   querySelector a coin toss for the reorder drag, for the delete path
   and for every probe here that finds a mark by its id - and the cost
   of a clone strip is paid in exactly those places, silently. */
let M=await marks();
t.ok(M.tiles===M.book, 'and there is still one tile per mark, not two',
     JSON.stringify(M));
const home=await tops();
const C2=await cyc();
await scrollTo(C2*0.37); await p.waitForTimeout(150);
t.ok((await tops()).join()!==home.join(), 'turning it moves the rows');
M=await marks();
t.ok(M.tiles===M.book, 'still one each, part way round', JSON.stringify(M));
t.ok((await wheel()).scrollTop===0,
     'and nothing is scrolling underneath it - the whole thing is drawn, '
     +'so the native scroll has nothing to fight the finger for');
/* Anything that scrolls the box would slide the picture sideways of
   the wheel: the rows are placed by transform about the middle of the
   box, and a container that has scrolled is a different middle. */
const held=await tops();
await p.evaluate(()=>{ $('course-list').scrollTop=60; });
await p.waitForTimeout(120);
t.ok((await tops()).join()===held.join(),
     'and scrolling the box cannot move it either', (await tops()).join(' '));
await scrollTo(C2); await p.waitForTimeout(150);
t.ok((await tops()).join()===home.join(),
     'a full turn is exactly where it started', (await tops()).join(' '));
await scrollTo(C2*4); await p.waitForTimeout(150);
t.ok((await tops()).join()===home.join(), 'and so is four of them');
/* And at every angle in between there is something to look at. The
   rows are hung about the middle of the BOX; hung about the scroll
   instead - which is the obvious way to write it, and the way I wrote
   it first - they drift out of the clip a few degrees in and the grid
   empties while it turns. */
let thin='';
for(let f=0; f<1; f+=0.125){
  await scrollTo(C2*f); await p.waitForTimeout(60);
  const n=await p.evaluate(()=>{ const el=$('course-list'),
    b=el.getBoundingClientRect();
    return [...el.children].filter(k=>{ const r=k.getBoundingClientRect();
      return r.bottom>b.top+4 && r.top<b.bottom-4; }).length; });
  if(n<6) thin+=f.toFixed(3)+':'+n+' ';
}
t.ok(!thin, 'and the glass is never nearly empty part way round', thin);

t.head('let go of it and it runs on, the way a wheel does');
const flick=(dy,n)=>p.evaluate(async([dy,n])=>{
  const el=$('course-list');
  const ev=(ty,y)=>{ const e=new PointerEvent(ty,{pointerId:21,clientX:540,
    clientY:y,bubbles:true,pointerType:'touch',buttons:ty==='pointerup'?0:1});
    (ty==='pointerdown'?el:window).dispatchEvent(e); };
  let y=700; ev('pointerdown',y);
  for(let i=0;i<n;i++){ y-=dy; ev('pointermove',y);
    await new Promise(r=>setTimeout(r,16)); }
  ev('pointerup',y);
}, [dy,n]);
await scrollTo(0); await p.waitForTimeout(100);
await flick(24,6);
/* Sampled at a second and a half, which is where the two frictions part
   company: at 0.9985 the wheel still has a quarter of its speed, and at
   the list's own 0.994 it stopped a second ago. Comparing "did it move
   at all since release" could not tell them apart. */
await p.waitForTimeout(1200);
const w0=(await wheel()).off;
await p.waitForTimeout(300);
const w1=(await wheel()).off;
t.ok(w1!==w0, 'it is still turning a second and a half after the finger left',
     w0+' -> '+w1);
await p.waitForTimeout(2600);
const w2=(await wheel()).off;
await p.waitForTimeout(400);
t.ok((await wheel()).off===w2, 'and it does stop', String(w2));

t.head('the speed it is let go at is the stroke, not the last twitch');
/* Called directly rather than flicked at: a synthetic gesture in a
   headless browser cannot hold its own timing to the ten milliseconds
   this window is measured in, and the first version of this probe
   turned out to be measuring setTimeout rather than the rule. The rule
   is a function of its arguments, so it is asked. */
const vel=(ms,ys)=>p.evaluate(([ms,ys])=>{
  const s=ms.map((t,i)=>({t:t, y:ys[i]}));
  return +wheelV(s, ms[ms.length-1], ys[ys.length-1]).toFixed(4);
},[ms,ys]);
/* A hand moving a steady 2px/ms that stalls for the last frame. The
   last pair says 0.19; the stroke says about 1.8. */
const slowLift=await vel([0,16,32,48,64,80],[700,668,636,604,572,569]);
t.ok(slowLift>1.2,
     'a stroke that eases off at the end is still handed over as a stroke',
     String(slowLift));
const lastPair=(569-572)/16;
t.ok(slowLift>Math.abs(lastPair)*4,
     'and not as its last frame, which here is nearly nothing',
     slowLift+' vs '+Math.abs(lastPair).toFixed(3));
/* Nothing older than the window is allowed to speak: a finger that
   rested, then moved, is moving. */
const afterAPause=await vel([0,400,416],[700,700,684]);
t.ok(afterAPause>0.5,
     'and a long rest before the stroke is not averaged into it',
     String(afterAPause));

t.head('EDIT changes the shape of the turn, so the turn is re-measured');
/* Four columns become three, so thirteen tiles become five rows
   instead of four and one revolution gets longer. A remembered cycle
   is a seam you can see. */
const four=(await wheel()).cyc;
await p.evaluate(()=>{ courseEdit=true; renderCourse(); });
await p.waitForTimeout(300);
const three=(await wheel()).cyc;
t.ok(three>four, 'three columns is a longer turn than four',
     four+' -> '+three);
await p.evaluate(()=>{ courseEdit=false; renderCourse(); });
await p.waitForTimeout(300);
t.ok((await wheel()).cyc===four, 'and it comes back when EDIT does',
     String((await wheel()).cyc));

t.head('and anything else you touch stops it');
/* stop() was reached only by a finger landing on the list itself, so
   EDIT, CLEAR, a chip in the route and the cross at the foot were all
   pressed over a grid still turning under them. */
await flick(24,6);
await p.waitForTimeout(60);
await p.evaluate(()=>$('course-edit').dispatchEvent(
  new PointerEvent('pointerdown',{pointerId:22,clientX:0,clientY:0,bubbles:true})));
const s0=(await wheel()).off;
await p.waitForTimeout(400);
t.ok((await wheel()).off===s0, 'a hand on EDIT holds the wheel still',
     s0+' -> '+(await wheel()).off);

t.head('and the whole thing goes down with the sheet');
await p.evaluate(()=>closeLib());
await p.waitForTimeout(250);
t.ok(!(await arc()).lit, 'nothing is being scrolled, so there is no arc');

await t.done(b);
