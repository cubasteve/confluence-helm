/* The route chart, in the left of the dial.

   A route planned in Freeboard-SK and activated through Signal K's
   course API, drawn faint in the empty sector between the bezel and the
   SOG digits, over a NOAA chart baked down to the theme's ink. Nothing
   here touches the network: Signal K's socket, its REST API and the
   NOAA export are all stand-ins below.

   The things that would be quietly wrong on the water and silent here
   without a probe:

     * with no route the dial is EXACTLY what it was - not "looks the
       same", the same pixels - and that holds after a route has come
       and gone
     * there are no words on it. A name or a distance on this side of
       the glass is one more reading to tell apart from the real ones
     * a wide speed (12.4) pushes the chart out of the digits' way
       rather than running it under the 1
     * the course API's index counts along the order the boat SAILS, so
       a reversed route is read from the end
     * a server without the resources plugin, or one that 404s, is not
       an error and not a stream of retries
     * a chart seen once with a signal is there next time without one
     * it costs nothing while the dial is covered                       */
import {open, tally, SHOTS} from './helpers.mjs';
const t=tally();

/* ---- the stand-ins --------------------------------------------------- */
/* Signal K's REST side. ROUTES by id; COURSE is what the course API's
   GET answers, null for a 404 (a server older than the v2 API). */
const ROUTES={}, asked=[];
let COURSE=null, ROUTE_STATUS=200;
const sk=async r=>{
  const u=new URL(r.request().url()); asked.push(u.pathname);
  const json=(o,st=200)=>r.fulfill({status:st, contentType:'application/json',
    headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify(o)});
  if(u.pathname==='/signalk/v2/api/vessels/self/navigation/course')
    return COURSE ? json(COURSE) : json({message:'not found'},404);
  const m=/^\/signalk\/v2\/api\/resources\/routes\/(.+)$/.exec(u.pathname);
  if(m){ const rt=ROUTES[decodeURIComponent(m[1])];
    return rt && ROUTE_STATUS===200 ? json(rt) : json({message:'No provider for routes'},404); }
  return r.abort();
};
/* NOAA: a picture with land down its left side and water on the right,
   so the bake has something of each to do. Made by the page itself, so
   the probe carries no binary. OFFLINE turns it into a dead network. */
let OFFLINE=false, noaa=0, PNG=null;
const chartPng=async p=>PNG||(PNG=Buffer.from(await p.evaluate(()=>{
  const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d');
  x.fillStyle='#82BEFF'; x.fillRect(0,0,1024,1024);           /* water */
  x.fillStyle='#CFC48C'; x.fillRect(0,0,560,1024);            /* land  */
  x.fillStyle='#000';    x.fillRect(600,300,24,24);           /* a mark */
  return c.toDataURL('image/png').split(',')[1];
}),'base64'));
let PAGE=null;
const nos=async r=>{
  noaa++;
  if(OFFLINE) return r.abort('internetdisconnected');
  return r.fulfill({status:200, contentType:'image/png',
    headers:{"Access-Control-Allow-Origin":"*"}, body:await chartPng(PAGE||r.request().frame().page())});
};

const {b,p}=await open(t,{routes:{
  'http://localhost:3000/signalk/**':sk,
  'https://gis.charttools.noaa.gov/**':nos}});
PAGE=p;
const logs=[]; p.on('console',m=>logs.push(m.type()+': '+m.text()));

/* ---- helpers ------------------------------------------------------------ */
const st=()=>p.evaluate(()=>{
  const g=$('cht');
  return {on:g.style.display!=='none', ticks:CHT.n.tick, paints:CHT.n.paint,
          fetch:CHT.n.fetch, bake:CHT.n.bake, img:!!(CHI.cur&&CHI.cur.url),
          imgShown:$('cht-img').style.display!=='none',
          past:$('cht-past').getAttribute('points')||'',
          ahead:$('cht-ahead').getAttribute('points')||'',
          next:$('cht-next').getAttribute('points')||'',
          wp:[+$('cht-wp').getAttribute('cx'),+$('cht-wp').getAttribute('cy')],
          act:['x1','y1','x2','y2'].map(a=>+$('cht-act').getAttribute(a)),
          boat:$('cht-boat').getAttribute('transform')||''};
});
/* A delta, the way the socket would hand it over. */
const delta=vals=>p.evaluate(v=>skMessage(JSON.stringify({context:'vessels.self',
  updates:[{values:v}]})), vals);
/* A point d metres from the boat at a bearing rel degrees off its course. */
const off=(d,rel)=>p.evaluate(([d,rel])=>{
  const la=get('pos.lat'), lo=get('pos.lon'),
        c=(get('navigation.courseOverGroundTrue')||0)*DEG+rel;
  return [lo+d*Math.sin(c/DEG)/(111320*Math.cos(la/DEG)), la+d*Math.cos(c/DEG)/110540];
},[d,rel]);
const settle=(ms=1400)=>p.waitForTimeout(ms);
const shot=(clip)=>p.screenshot({clip:clip||{x:0,y:0,width:1080,height:1080}});
const clearCourse=()=>delta([
  {path:'navigation.course.activeRoute', value:null},
  {path:'navigation.course.nextPoint', value:null},
  {path:'navigation.course.previousPoint', value:null}]);

/* ===================================================================== */
t.head('no route: nothing, and not one pixel of difference');
/* The demo plays the fix in every probe, and the demo has a route of its
   own for a desktop with no Signal K - so first, a boat whose Signal K
   has answered and has no course. */
await p.evaluate(()=>{ skEver=true; });
await settle();
let s0=await st();
await settle(2500);
let s=await st();
t.ok(!s.on, 'Signal K up, no course: the chart is display:none');
t.ok(s.paints===s0.paints && s.fetch===s0.fetch,
     'and from then on it paints and fetches nothing', JSON.stringify([s0,s]));

/* Pixels. The demo off so nothing on the dial moves between shots; the
   chart's markup then taken OUT of the page entirely, which is the dial
   as it was before this feature existed. */
await p.evaluate(()=>demoSet(false)); await settle(900);
const A=await shot();
const removed=await p.evaluate(()=>{
  const g=$('cht'), d=$('cht-fade-g').closest('defs');
  /* and anything of the chart's that is not inside those two - a stray
     element outside its group is exactly what this is here to catch */
  const stray=[...document.querySelectorAll('[id^="cht"]')]
    .filter(e=>!g.contains(e) && !d.contains(e));
  window.__cht=[g, g.nextSibling, d, d.nextSibling];
  g.remove(); d.remove(); return stray.length===0; });
await settle(300);
const B=await shot();
t.ok(removed && A.equals(B),
     'the dial with the chart in the markup and no route is pixel-identical '
     +'to the dial without it', A.length+' vs '+B.length);
await p.evaluate(()=>{ const [g,gn,d,dn]=window.__cht;
  dn.parentNode.insertBefore(d,dn); gn.parentNode.insertBefore(g,gn); });
/* A route comes and goes on that same still dial. A fix is put in by
   hand (the demo is off) for both shots, so the one thing that differs
   between them is that the chart has been and gone. */
await p.evaluate(()=>{ put('pos.lat',28.83); put('pos.lon',-81.27); });
await settle(500);
const P1=await shot();
const came=await p.evaluate(async()=>{
  const la=28.83, lo=-81.27;
  skMessage(JSON.stringify({updates:[{values:[
    {path:'navigation.course.activeRoute', value:null},
    {path:'navigation.course.nextPoint', value:{type:'Location', position:{latitude:la+.01, longitude:lo}}},
    {path:'navigation.course.previousPoint', value:{type:'VesselPosition', position:{latitude:la-.002, longitude:lo}}}]}]}));
  chtLastAt=0; await new Promise(r=>setTimeout(r,800));
  const on=$('cht').style.display!=='none';
  skMessage(JSON.stringify({updates:[{values:[
    {path:'navigation.course.nextPoint', value:null},
    {path:'navigation.course.previousPoint', value:null}]}]}));
  chtLastAt=0; await new Promise(r=>setTimeout(r,800));
  return on && $('cht').style.display==='none';
});
await settle(300);
const P2=await shot();
t.ok(came && P1.equals(P2), 'and after a route has come and gone, the same pixels again');
if(!P1.equals(P2)) console.log('DIFF', await p.evaluate(async([a,c])=>{
  const ld=async b=>{ const im=new Image(); im.src='data:image/png;base64,'+b; await im.decode();
    const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
    const x=cv.getContext('2d'); x.drawImage(im,0,0); return x.getImageData(0,0,cv.width,cv.height).data; };
  const da=await ld(a), dc=await ld(c); let x0=1e9,y0=1e9,x1=-1,y1=-1,n=0;
  for(let i=0;i<da.length;i+=4) if(da[i]!==dc[i]||da[i+1]!==dc[i+1]||da[i+2]!==dc[i+2]){
    const k=i/4, x=k%1080, y=(k/1080)|0; n++; x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y); }
  return JSON.stringify({n,x0,y0,x1,y1}); },[P1.toString('base64'),P2.toString('base64')]));
await p.evaluate(()=>{ delete S['pos.lat']; delete S['pos.lon']; });
for(const th of ['night','dusk']){
  await p.evaluate(th=>{ CFG.theme=th; applyTheme(); }, th); await settle(500);
  const a=await shot();
  await p.evaluate(()=>{ $('cht').remove(); });
  await settle(200);
  const bb=await shot();
  await p.evaluate(()=>{ const [g,gn]=window.__cht; gn.parentNode.insertBefore(g,gn); });
  t.ok(a.equals(bb), 'and the same at '+th);
}
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); demoSet(true); });
await settle(1500);

/* ===================================================================== */
t.head('the course API: what the index means');
/* Pure: chtCourse() reads CHK, chtLegs() orders the points. */
const legs=await p.evaluate(()=>{
  const C=[[-81.30,28.80],[-81.29,28.81],[-81.28,28.82],[-81.27,28.83]];
  const P=i=>[C[i][1],C[i][0]], V=[28.799,-81.301];
  const r={};
  const run=(K)=>{ const save=JSON.stringify(CHK);
    Object.assign(CHK,{v2:{},v1:{},seen2:false},K);
    const c=chtCourse(), L=chtLegs(c, c&&c.href?C:null);
    Object.assign(CHK, JSON.parse(save)); return {c, L}; };
  r.fwd=run({seen2:true, v2:{route:{href:'/resources/routes/x',pointIndex:2,reverse:false},
                              next:P(2), prev:P(1)}});
  r.rev=run({seen2:true, v2:{route:{href:'/resources/routes/x',pointIndex:1,reverse:true},
                              next:P(2), prev:P(3)}});
  r.first=run({seen2:true, v2:{route:{href:'/resources/routes/x',pointIndex:0,reverse:false},
                                next:P(0), prev:V}});
  r.stale=run({seen2:true, v2:{route:{href:'/resources/routes/x',pointIndex:1,reverse:false},
                                next:P(2), prev:P(1)}});
  r.v1fwd=run({v1:{href:'/resources/routes/x', next:P(2), prev:P(1)}});
  r.v1rev=run({v1:{href:'/resources/routes/x', next:P(1), prev:P(2)}});
  r.goto=run({seen2:true, v2:{route:null, next:[28.85,-81.25], prev:V}});
  r.gotoNoPrev=run({seen2:true, v2:{route:null, next:[28.85,-81.25]}});
  r.none=run({seen2:true, v2:{route:null, next:null, prev:null}});
  r.P=[0,1,2,3].map(P);
  return r;
});
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const L=legs.P;
t.ok(legs.fwd.L.n===2 && eq(legs.fwd.L.pts, L),
     'pointIndex 2 forward: the route as drawn, the third point next');
t.ok(legs.rev.L.n===1 && eq(legs.rev.L.pts, [L[3],L[2],L[1],L[0]]),
     'reverse: read from the END, and the index counts along that order '
     +'(the server\'s getRoutePoint)', JSON.stringify(legs.rev.L));
t.ok(legs.first.L.n===1 && legs.first.L.pts.length===5
     && eq(legs.first.L.pts[0],[28.799,-81.301]),
     'pointIndex 0: the leg runs from where the boat was when it started, '
     +'which is not a point of the route');
t.ok(legs.stale.L.n===2, 'an index that does not match the next point '
     +'(an edit a moment old) is found again by position');
t.ok(legs.v1fwd.c.idx===null && legs.v1fwd.L.n===2 && eq(legs.v1fwd.L.pts,L),
     'v1 only (courseGreatCircle, no index): found by position');
t.ok(legs.v1rev.L.n===2 && eq(legs.v1rev.L.pts,[L[3],L[2],L[1],L[0]]),
     'and its direction from where the previous point is');
t.ok(legs.goto.L.n===1 && legs.goto.L.pts.length===2,
     'go to waypoint: no route, one leg from the previous point');
t.ok(legs.gotoNoPrev.L.n===0 && legs.gotoNoPrev.L.pts.length===1,
     'and with no previous point, a line from the boat');
t.ok(legs.none.c===null && legs.none.L===null, 'no next point: no course');

/* ===================================================================== */
t.head('a route activated in Freeboard-SK, over the socket');
const [A0,A1,A2,A3]=[await off(400,180), await off(900,-6), await off(1500,-40),
                     await off(1900,-90)];
ROUTES.r1={name:'Evening', feature:{type:'Feature',
  geometry:{type:'LineString', coordinates:[A0,A1,A2,A3]},
  properties:{coordinatesMeta:[{name:'MARINA'},{name:'RUM'},{name:'GOSLING'},{name:'STORMY'}]}}};
const pos=c=>({latitude:c[1], longitude:c[0]});
const bake0=await p.evaluate(()=>CHT.n.bake);
const CHT_P=['navigation.course.activeRoute','navigation.course.nextPoint',
  'navigation.course.previousPoint','navigation.courseGreatCircle.activeRoute.href',
  'navigation.courseGreatCircle.nextPoint.position',
  'navigation.courseGreatCircle.previousPoint.position'];
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/r1',
    pointIndex:1, pointTotal:4, reverse:false, name:'Evening'}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1), name:'RUM'}},
  {path:'navigation.course.previousPoint', value:{type:'RoutePoint', position:pos(A0)}}]);
await settle(2500);
s=await st();
t.ok(s.on, 'the chart comes up');
t.ok(asked.filter(x=>x.endsWith('/routes/r1')).length===1,
     'the route\'s shape asked for once, from the resources API', asked.join(' '));
t.ok(s.past.split(' ').length===2 && s.ahead.split(' ').length===3,
     'the leg behind, and the rest of the route ahead (faint)', s.past+' | '+s.ahead);
t.ok(s.next==='', 'no stub of the next leg - the turn is 900 m away');
t.ok(s.img && s.imgShown && s.bake>bake0, 'a chart fetched, baked, shown');
const txt=await p.evaluate(()=>({n:$('cht').querySelectorAll('text,tspan,foreignObject').length,
  s:$('cht').textContent.trim()}));
t.ok(txt.n===0 && txt.s==='', 'and not a word on it: no text elements, no text',
     JSON.stringify(txt));
/* Heading-up: the next point is 6 degrees off the bow, so it is above the
   boat, a little left, about FIT px out. */
const g=await p.evaluate(()=>({BX:+$('cht-boat').getAttribute('transform').match(/translate\(([-\d.]+)/)[1],
                               BY:CHT.BY, FIT:CHT.FIT}));
const dx=s.wp[0]-g.BX, dy=s.wp[1]-g.BY, r=Math.hypot(dx,dy);
t.ok(dy<0 && dx<0 && Math.abs(r-g.FIT)<12,
     'heading-up: the next waypoint ahead of the boat and a touch to port, '
     +'about '+g.FIT+' px out', `${dx.toFixed(0)},${dy.toFixed(0)} r ${r.toFixed(0)}`);

t.head('it repaints at most once a second, and only when something moved');
const pa=(await st()).paints;
await settle(3200);
const pb=(await st()).paints;
t.ok(pb-pa<=4, 'four paints at most in three seconds', (pb-pa)+'');
/* a frozen fix: nothing moves, nothing paints */
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20); });
await settle(1500);
const pc=(await st()).paints; await settle(2500); const pd=(await st()).paints;
t.ok(pd===pc, 'a boat at rest with the same course paints nothing', pc+' -> '+pd);
await p.evaluate(()=>clearInterval(window.__hold));

t.head('near a turn: the next leg\'s stub, the mark brought in');
const A1n=await off(220,-4);
ROUTES.r2={name:'Close', feature:{type:'Feature',
  geometry:{type:'LineString', coordinates:[A0,A1n,A2,A3]}}};
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/r2',
    pointIndex:1, pointTotal:4, reverse:false}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1n)}}]);
await settle(2500);
s=await st();
const rn=Math.hypot(s.wp[0]-g.BX, s.wp[1]-g.BY);
t.ok(s.next.split(' ').length===2, 'the stub of the next leg is drawn', s.next);
t.ok(rn<g.FIT-10, 'and the waypoint sits closer than on a leg', rn.toFixed(0));

t.head('reversed, over the socket');
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/r1',
    pointIndex:2, pointTotal:4, reverse:true}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1)}},
  {path:'navigation.course.previousPoint', value:{type:'RoutePoint', position:pos(A2)}}]);
await settle(1500);
s=await st();
t.ok(s.on && s.past.split(' ').length===3 && s.ahead.split(' ').length===2,
     'two behind (STORMY, GOSLING) and one ahead after RUM (MARINA)',
     s.past+' | '+s.ahead);

t.head('go to waypoint');
await delta([
  {path:'navigation.course.activeRoute', value:null},
  {path:'navigation.course.nextPoint', value:{type:'Location', position:pos(await off(700,20))}},
  {path:'navigation.course.previousPoint', value:{type:'VesselPosition', position:pos(A0)}}]);
await settle(1500);
s=await st();
t.ok(s.on && s.ahead==='' && s.past.split(' ').length===2, 'one leg, nothing ahead of it',
     s.past+' | '+s.ahead);

t.head('the old v1 paths alone (a server before the v2 API)');
await p.evaluate(()=>{ CHK.v2={}; CHK.seen2=false; chtSeq++; });
await delta([
  {path:'navigation.courseGreatCircle.activeRoute.href', value:'/resources/routes/r1'},
  {path:'navigation.courseGreatCircle.nextPoint.position', value:pos(A2)},
  {path:'navigation.courseGreatCircle.previousPoint.position', value:pos(A1)}]);
await settle(1500);
s=await st();
t.ok(s.on && s.past.split(' ').length===3 && s.ahead.split(' ').length===2,
     'the route, its next point found by position', s.past+' | '+s.ahead);
await delta([{path:'navigation.courseGreatCircle.nextPoint.position', value:null}]);
await settle(1500);
t.ok(!(await st()).on, 'and cleared with it');

/* ===================================================================== */
t.head('no resources plugin, a 404, no course: hidden or a bare leg, never an error');
logs.length=0;
const before=asked.length;
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/gone',
    pointIndex:1, pointTotal:3, reverse:false}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1)}},
  {path:'navigation.course.previousPoint', value:{type:'RoutePoint', position:pos(A0)}}]);
await settle(3500);
s=await st();
const gone=asked.slice(before).filter(x=>x.endsWith('/gone')).length;
t.ok(gone===1, 'a 404 is asked once, not once a second', gone+' asks');
t.ok(s.on && s.ahead==='' && s.past.split(' ').length===2,
     'and what the course API itself says - the leg being steered - still draws');
t.ok(!logs.some(l=>/^(log|warning|info):/.test(l)), 'nothing logged by the page',
     logs.join(' | '));
await clearCourse(); await settle(1500);
t.ok(!(await st()).on, 'course cleared: hidden again');
/* malformed: a route with no geometry, a next point with no position */
ROUTES.bad={name:'x', feature:{geometry:{type:'LineString', coordinates:'nope'}}};
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/bad', pointIndex:0}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:{latitude:'x'}}}]);
await settle(1500);
t.ok(!(await st()).on, 'a next point that is not a position: hidden, no throw');
await clearCourse();
/* the GET on (re)connect: 404 is a server without the v2 API */
COURSE=null;
await p.evaluate(()=>chtCourseGet()); await settle(1500);
t.ok(!(await st()).on, 'course GET 404: hidden');
COURSE={startTime:null, targetArrivalTime:null, arrivalCircle:50,
  activeRoute:{href:'/resources/routes/r1', pointIndex:1, pointTotal:4, reverse:false, name:'Evening'},
  nextPoint:{type:'RoutePoint', position:pos(A1)},
  previousPoint:{type:'RoutePoint', position:pos(A0)}};
await p.evaluate(()=>chtCourseGet()); await settle(2000);
s=await st();
t.ok(s.on && s.ahead.split(' ').length===3, 'course GET with a route: the route, '
     +'without waiting for a delta');

/* ===================================================================== */
t.head('the wind marks: the chart gives way under each one');
const holes=await p.evaluate(()=>{
  const h=id=>({cx:+$(id).getAttribute('cx'), cy:+$(id).getAttribute('cy'), r:+$(id).getAttribute('r')});
  const out={};
  chtWind(-60,-100); out.port=[h('cht-hole-a'),h('cht-hole-t')];
  chtWind(-61,-100); out.port2=h('cht-hole-a');
  chtWind(45,120);   out.stbd=[h('cht-hole-a'),h('cht-hole-t')];
  chtWind(null,null); out.none=[h('cht-hole-a'),h('cht-hole-t')];
  return out;
});
const at=a=>[540+434*Math.sin(a/57.29578), 540-434*Math.cos(a/57.29578)];
const near2=(h,a)=>Math.abs(h.cx-at(a)[0])<1 && Math.abs(h.cy-at(a)[1])<1 && h.r>0;
t.ok(near2(holes.port[0],-60) && near2(holes.port[1],-100),
     'wind from port: a hole under each mark, at the mark', JSON.stringify(holes.port));
t.ok(near2(holes.port2,-61), 'and it follows the mark round');
t.ok(holes.stbd.every(h=>h.r===0), 'from starboard there is no chart there: no hole');
t.ok(holes.none.every(h=>h.r===0), 'no wind: no hole');
/* and live: the dial's own render loop, following the drawn mark. The
   demo's sail at 17 minutes has the apparent wind on the port bow. */
await p.evaluate(()=>{ demoT=1020; for(const k in CHW) delete CHW[k]; });
await settle(3000);
const live=await p.evaluate(()=>{
  const m=/rotate\(([-\d.e]+)/.exec($('awa-mark').getAttribute('transform')||'');
  return {a:m?+m[1]:null, on:+$('awa-mark').getAttribute('opacity')>0, edge:chtEdgeAt,
          h:{cx:+$('cht-hole-a').getAttribute('cx'), cy:+$('cht-hole-a').getAttribute('cy'),
             r:+$('cht-hole-a').getAttribute('r')}};
});
/* on where the mark is over the chart's side: left of the digits' edge
   by less than a hole's radius - the same test chtWind makes */
const over=live.on && 540+434*Math.sin(live.a/57.29578) < live.edge+95;
if(over)
  t.ok(Math.abs(live.h.cx-at(live.a)[0])<4 && Math.abs(live.h.cy-at(live.a)[1])<4,
       'render() moves the hole with the drawn apparent mark', JSON.stringify(live));
else
  t.ok(live.h.r===0, 'render() parks the hole while the apparent mark is to starboard',
       JSON.stringify(live));

/* ===================================================================== */
t.head('wide speeds: the chart gets out of the digits\' way');
/* The digits' ink, off the glass: the leftmost dark pixel of the band
   they sit in, with the chart hidden so it cannot be the chart. */
const inkLeft=async()=>{
  await p.evaluate(()=>{ $('cht').style.display='none'; }); await settle(150);
  const png=await shot({x:150,y:400,width:400,height:180});
  await p.evaluate(()=>{ $('cht').style.display=''; });
  return p.evaluate(async b64=>{
    const im=new Image(); im.src='data:image/png;base64,'+b64; await im.decode();
    const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
    const x=c.getContext('2d'); x.drawImage(im,0,0);
    const d=x.getImageData(0,0,c.width,c.height).data, bg=[d[0],d[1],d[2]];
    for(let col=0;col<c.width;col++) for(let row=0;row<c.height;row++){
      const i=(row*c.width+col)*4;
      if(Math.abs(d[i]-bg[0])+Math.abs(d[i+1]-bg[1])+Math.abs(d[i+2]-bg[2])>240) return 150+col; }
    return null;
  }, png.toString('base64'));
};
/* A boat of our own, held still at that speed: the demo stood down so
   it cannot write a speed of its own over it. */
await p.evaluate(()=>{ window.__fix=[get('pos.lat'),get('pos.lon'),
  get('navigation.courseOverGroundTrue')]; demoSet(false); });
for(const v of ['2.7','12.4','10.0']){
  await p.evaluate(v=>{ window.__hs=setInterval(()=>{ const f=window.__fix;
    put('pos.lat',f[0]); put('pos.lon',f[1]); put('navigation.courseOverGroundTrue',f[2]);
    put('navigation.speedOverGround',(+v)/MS_TO_KT); put('disp.sog',(+v)/MS_TO_KT); },100); }, v);
  await p.waitForFunction(v=>$('spd').textContent===v, v, {timeout:8000}).catch(()=>{});
  await settle(1300);
  const ink=await inkLeft();
  const geo=await p.evaluate(()=>{
    const bx=+$('cht-boat').getAttribute('transform').match(/translate\(([-\d.]+)/)[1];
    const cr=$('cht-clip-r'); return {bx, clipR:+cr.getAttribute('x')+ +cr.getAttribute('width'),
      txt:$('spd').textContent, edge:chtEdgeAt};
  });
  await p.evaluate(()=>clearInterval(window.__hs));
  if(v==='12.4') await p.screenshot({path:SHOTS+'chart-wide.png'});
  t.ok(geo.txt===v && ink!==null && geo.clipR<=ink-2 && geo.bx+10<=ink-12,
       `${v}: everything the chart can paint ends left of the digits' ink, `
       +'and the boat stands clear of it', JSON.stringify({ink, ...geo}));
}
await p.evaluate(()=>demoSet(true)); await settle(1500);

/* ===================================================================== */
t.head('night is red: the chart is baked in the theme\'s ink');
await p.evaluate(()=>{ CFG.theme='night'; applyTheme(); }); await settle(2600);
const night=await p.evaluate(()=>{
  const img=CHI.cur, x=img.c.getContext('2d'), d=x.getImageData(100,500,1,1).data;
  const cs=getComputedStyle(document.body);
  return {theme:img.theme, px:[...d], ink:cs.getPropertyValue('--ink').trim(),
          s:cs.getPropertyValue('--cht-map').trim(), href:$('cht-img').getAttribute('href')===img.url};
});
t.ok(night.theme==='night' && night.href, 'recoloured on the theme change, and shown');
/* within 3: the canvas keeps its pixels premultiplied, so a colour read
   back through a .2 alpha has lost a bit or two of every channel */
t.ok(Math.abs(night.px[0]-0xC8)<=3 && Math.abs(night.px[1]-0x34)<=3
     && Math.abs(night.px[2]-0x2E)<=3,
     'in night\'s ink, #C8342E', night.px.join(','));
/* the stand-in's land is #CFC48C: .095 R - 1.048 B + 1 = .50 of ink,
   and the strength on top of that */
const landA=(.095*0xCF-1.048*0x8C)/255+1;
t.ok(night.s==='.44' && Math.abs(night.px[3]-255*landA*.44)<=2,
     'at the night strength, .44, painted into the alpha',
     night.px[3]+' vs '+(255*landA*.44).toFixed(1));
const str=await p.evaluate(()=>['','dusk','night'].map(c=>{
  const was=document.body.className; document.body.className=c;
  const v=getComputedStyle(document.body).getPropertyValue('--cht-map').trim();
  document.body.className=was; return v; }));
t.ok(eq(str,['.40','.38','.44']), 'one strength per theme: day .40, dusk .38, night .44',
     str.join(' '));
const fil=await p.evaluate(()=>$('cht').querySelectorAll('[filter]').length
  + document.querySelectorAll('#cht filter, defs filter[id^="cht"]').length);
t.ok(fil===0, 'and no SVG filter anywhere in it - the bake is the filter, once');
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); }); await settle(1500);

/* ===================================================================== */
t.head('the chart seen once with a signal is there without one');
/* The boat held where it is, so the same water is asked for twice. */
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20); });
await settle(3000);
const key=await p.evaluate(()=>CHI.cur.k);
const kept=await p.evaluate(k=>tileGet(k).then(r=>!!(r&&r.b&&r.t)), key);
t.ok(/^cht\/\d+\/-?\d+\/-?\d+$/.test(key) && kept,
     'kept in the tilecache store under its own key, with the trim\'s timestamp', key);
OFFLINE=true;
const n0=noaa;
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear(); chtSeq++; chtLastAt=0; });
await settle(2500);
s=await st();
t.ok(s.img && s.imgShown && await p.evaluate(()=>/^cht\//.test(CHI.cur.k)),
     'offline, the same water: the chart is back from IndexedDB',
     await p.evaluate(k=>JSON.stringify({k, cur:CHI.cur&&CHI.cur.k, k1:chtView&&1/chtView.k,
       fail:[...CHI.fail.keys()], busy:CHI.busy, demoT}), key));
t.ok(noaa===n0, 'without asking the network', (noaa-n0)+' asks');
/* and new water, offline: no picture, the route on clean glass */
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear();
  return new Promise(res=>{ const r=indexedDB.open('confluence');
    r.onsuccess=e=>{ const db=e.target.result, tx=db.transaction('tilecache','readwrite');
      const st=tx.objectStore('tilecache'); st.getAllKeys().onsuccess=ev=>{
        ev.target.result.filter(k=>String(k).startsWith('cht/')).forEach(k=>st.delete(k)); };
      tx.oncomplete=()=>{ db.close(); res(); }; }; }); });
await p.evaluate(()=>{ chtSeq++; chtLastAt=0; });
await settle(2500);
s=await st();
t.ok(s.on && !s.imgShown && s.past!=='', 'never here and no signal: the route on clean glass');
await settle(2000);
const asks=noaa;
await settle(2500);
t.ok(noaa-asks<=1, 'and the dead network is not asked again every second',
     (noaa-asks)+' asks in 2.5 s');
OFFLINE=false;
await p.evaluate(()=>{ clearInterval(window.__hold); CHI.fail.clear(); chtLastAt=0; });
await settle(2500);

/* ===================================================================== */
t.head('covered, it does nothing at all');
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='energy'))); await settle(800);
const c0=await st(); await settle(2500); const c1=await st();
t.ok(c1.ticks===c0.ticks && c1.paints===c0.paints && c1.fetch===c0.fetch,
     'an app over the dial: not a tick, not a paint, not a fetch',
     JSON.stringify([c0.ticks,c1.ticks,c0.paints,c1.paints]));
await p.evaluate(()=>closeApp&&closeApp()); await settle(800);

/* ===================================================================== */
t.head('the demo has a route of its own, and only the demo');
await clearCourse();
await p.evaluate(()=>{ skEver=false; chtLastAt=0; }); await settle(1600);
s=await st();
t.ok(s.on && s.ahead!=='', 'no Signal K ever, the demo sailing: the demo route, so a '
     +'desktop shows the feature');
await p.evaluate(()=>{ skEver=true; chtLastAt=0; }); await settle(1600);
t.ok(!(await st()).on, 'Signal K has answered once: the demo route is gone for good');

t.head('it is separate from the race course');
const sep=await p.evaluate(()=>({mk:typeof MARKS==='undefined'?null:JSON.stringify(MARKS).length}));
t.ok(!(await p.evaluate(()=>/chtFeed|chtRoute|CHT\./.test(
  [typeof renderCourse==='function'?renderCourse.toString():'',
   typeof courseWatch==='function'?courseWatch.toString():'',
   typeof markWatch==='function'?markWatch.toString():''].join('')))),
     'the race course code never reads the route chart', JSON.stringify(sep));

/* ===================================================================== */
t.head('the socket: the course paths subscribed, the course arriving on it');
/* A Signal K of our own on the socket. Playwright mocks a WebSocket by
   patching the page's constructor, which only a new document gets - so
   the route goes in and the page comes up again under it. The route
   arrives the way Freeboard-SK's "activate route" sends it: deltas from
   the course API, with the course GET answering 404 so it can only have
   come over the socket. */
const subs=[];
COURSE=null;
const fromSk=JSON.stringify({context:'vessels.self', updates:[{values:[
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/r1',
    pointIndex:1, pointTotal:4, reverse:false, name:'Evening'}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1)}},
  {path:'navigation.course.previousPoint', value:{type:'RoutePoint', position:pos(A0)}}]}]});
await p.routeWebSocket(/\/signalk\/v1\/stream/, ws=>{
  ws.onMessage(m=>{ try{ const j=JSON.parse(m);
    if(j.subscribe){ subs.push(...j.subscribe); ws.send(fromSk); } }catch(e){} });
});
const gets=asked.length;
await p.reload();
await p.waitForFunction(()=>typeof skEver!=='undefined' && skEver===true, null, {timeout:20000})
  .catch(()=>{});
await settle(3000);
const cs=subs.filter(x=>CHT_P.includes(x.path));
t.ok(cs.length===6 && cs.every(x=>x.policy==='instant'),
     'six course paths, instant rather than the readings\' fixed 4 Hz',
     JSON.stringify(cs.map(x=>x.path+':'+x.policy)));
t.ok(asked.slice(gets).includes('/signalk/v2/api/vessels/self/navigation/course'),
     'the course API asked once the socket is open');
s=await st();
t.ok(s.on && s.ahead.split(' ').length===3,
     'and the route, from the deltas alone, on the dial', s.past+' | '+s.ahead);

await t.done(b);
