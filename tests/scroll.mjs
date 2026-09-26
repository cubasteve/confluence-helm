/* What a box does when it has more in it than it can show: no native
   scrollbar anywhere, a fade at the edge the content is crossing, and
   the arc out on the rim while you are moving. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);

const bar=sel=>p.evaluate(s=>{ const el=document.querySelector(s);
  return {gutter:el.offsetWidth-el.clientWidth,
          hidden:getComputedStyle(el).scrollbarWidth==='none'}; }, sel);
const arc=()=>p.evaluate(()=>({
  lit:$('arc').classList.contains('lit'),
  on:$('arc').classList.contains('on'),
  trk:$('arc-t').getAttribute('d'), thm:$('arc-h').getAttribute('d')}));
/* The two ends of a path, as the numbers actually written into it. */
const ends=d=>{ const m=/^M([\d.]+) ([\d.]+)A[\d ]+ [01] [01] ([\d.]+) ([\d.]+)$/.exec(d);
  return m?{y0:+m[2], y1:+m[4], x0:+m[1], x1:+m[3]}:null; };
const grid=()=>p.evaluate(()=>{ const el=$('course-list'),
  s=$('stage').getBoundingClientRect(), r=el.getBoundingClientRect();
  return {over:el.classList.contains('over'), masked:!!getComputedStyle(el)
            .webkitMaskImage.match(/gradient/),
          top:r.top-s.top, bottom:r.bottom-s.top,
          scroll:el.scrollHeight, client:el.clientHeight}; });
const scrollTo=n=>p.evaluate(v=>{ const el=$('course-list');
  el.scrollTop=v; el.dispatchEvent(new Event('scroll')); }, n);

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
let G=await grid();
t.ok(!G.over, 'eleven marks fit, so no fade', G.scroll+' in '+G.client);
t.ok(!G.masked, 'and nothing is masked');
await scrollTo(0);
t.ok(!(await arc()).lit, 'and there is no arc to draw');
t.ok(await p.evaluate(()=>![...$('course-list').children]
       .some(k=>k.style.transform)),
     'and the grid is flat - nothing turns that has nothing to turn');

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
t.ok(!E.a && E.z, 'at the top only the bottom fades - nothing is above it',
     JSON.stringify(E));
await scrollTo(60); await p.waitForTimeout(120);
E=await edges();
t.ok(E.a && E.z, 'in the middle both edges do', JSON.stringify(E));
await scrollTo(9999); await p.waitForTimeout(120);
E=await edges();
t.ok(E.a && !E.z, 'and at the end only the top', JSON.stringify(E));

t.head('the rows sit on a drum, and only when there is a drum to sit on');
/* Each tile's rotateX in degrees, read back off the matrix, with the
   opacity it was dimmed to. Grouped by row: four tiles across share a y,
   so they must share an angle or they are not one surface. */
const rows=()=>p.evaluate(()=>{
  const out={};
  for(const k of $('course-list').children){
    const m=k.style.transform.match(/rotateX\(([-\d.]+)deg\)/);
    const y=k.offsetTop;
    (out[y]=out[y]||[]).push({a:m?+m[1]:null, o:+(k.style.opacity||1)});
  }
  return Object.keys(out).map(Number).sort((a,b)=>a-b).map(y=>out[y]);
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
t.ok(T && H, 'both paths are arcs', A.trk+' / '+A.thm);
t.ok(Math.abs(T.y0-G.top)<2 && Math.abs(T.y1-G.bottom)<2,
     "the track's ends sit beside the box's own top and bottom",
     [T.y0,T.y1].join()+' vs '+[G.top,G.bottom].join());
t.ok(H.y0>=T.y0-0.5 && H.y1<=T.y1+0.5, 'and the thumb is inside the track',
     [H.y0,H.y1].join()+' in '+[T.y0,T.y1].join());
t.ok(T.x0>900 && T.x1>900, 'out on the rim, not over the list',
     [T.x0,T.x1].join());

t.head('and it moves with the scroll');
const at=async n=>{ await scrollTo(n); await p.waitForTimeout(120);
                    return ends((await arc()).thm); };
const a1=await at(0), a2=await at(120), a3=await at(9999);
t.ok(a1.y0<a2.y0 && a2.y0<a3.y0, 'the thumb walks down as the list does',
     [a1.y0,a2.y0,a3.y0].map(Math.round).join(' '));
t.ok(Math.abs(a1.y0-(await grid()).top)<2, 'at the top it starts at the top',
     a1.y0+' vs '+(await grid()).top);
t.ok(Math.abs(a3.y1-(await grid()).bottom)<3, 'and at the bottom it ends at the end',
     a3.y1+' vs '+(await grid()).bottom);

t.head('a very long list still gets a thumb you can see');
await p.evaluate(()=>{ for(let i=0;i<120;i++)
    MARKS.push({id:'q'+i, name:'MARK '+i, hdr:'M'+i, buoy:'o',
                lat:28.82, lon:-81.265});
  renderCourse(); });
await p.waitForTimeout(300);
await scrollTo(200); await p.waitForTimeout(150);
const L=ends((await arc()).thm), LT=ends((await arc()).trk);
t.ok(L.y1-L.y0>6, 'not a dot', String((L.y1-L.y0).toFixed(1)));
t.ok(L.y0>=LT.y0-0.5 && L.y1<=LT.y1+0.5, 'and still inside the track',
     [L.y0,L.y1].join()+' in '+[LT.y0,LT.y1].join());

t.head('the thumb goes away when you stop, and the track does not');
t.ok((await arc()).on, 'the thumb is up while moving');
await p.waitForTimeout(1200);
let A2=await arc();
t.ok(!A2.on, 'and down a beat after the last scroll');
t.ok(A2.lit, 'but the track stays lit while the list is still longer than the box');
t.ok((await grid()).over, 'and so does the fade');

t.head('and the whole thing goes down with the sheet');
await p.evaluate(()=>closeLib());
await p.waitForTimeout(250);
t.ok(!(await arc()).lit, 'nothing is being scrolled, so there is no arc');

await t.done(b);
