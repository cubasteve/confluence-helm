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
let COURSE=null, ROUTE_STATUS=200, ROUTE_DELAY=0;
const sk=async r=>{
  const u=new URL(r.request().url()); asked.push(u.pathname);
  const json=(o,st=200)=>r.fulfill({status:st, contentType:'application/json',
    headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify(o)});
  if(u.pathname==='/signalk/v2/api/vessels/self/navigation/course')
    return COURSE ? json(COURSE) : json({message:'not found'},404);
  const m=/^\/signalk\/v2\/api\/resources\/routes\/(.+)$/.exec(u.pathname);
  if(m){ const rt=ROUTES[decodeURIComponent(m[1])];
    if(ROUTE_DELAY) await new Promise(res=>setTimeout(res,ROUTE_DELAY));
    return rt && ROUTE_STATUS===200 ? json(rt) : json({message:'No provider for routes'},404); }
  return r.abort();
};
/* NOAA: a picture in the service's day palette with land down its left
   side and water (under 1.8 m) on the right, so the bake has something
   of each to do; a pile; and a corner outside every ENC cell, which the
   service sends as (0,0,0,0). Made by the page itself, so the probe
   carries no binary. OFFLINE turns it into a dead network. */
let OFFLINE=false, noaa=0, PNG=null, INK=null, SOLIDP=null, BLACK=false, SOLID=false,
    noaaUrl='', FLAT=null, FLATP={};
const chartPng=async p=>PNG||(PNG=Buffer.from(await p.evaluate(()=>{
  const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d');
  x.fillStyle='#82BDFF'; x.fillRect(0,0,1024,1024);           /* water */
  x.fillStyle='#CEC58A'; x.fillRect(0,0,560,1024);            /* land  */
  x.fillStyle='#000';    x.fillRect(600,300,24,24);           /* a pile */
  x.clearRect(900,20,100,100);                                /* no cell */
  return c.toDataURL('image/png').split(',')[1];
}),'base64'));
/* and a chart that is ink from edge to edge - drying ground everywhere,
   the darkest band, the worst case for anything that is meant to have
   faded out by a line */
const inkPng=async p=>INK||(INK=Buffer.from(await p.evaluate(()=>{
  const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d'); x.fillStyle='#78B796'; x.fillRect(0,0,1024,1024);
  x.fillStyle='#82BDFF'; x.fillRect(0,0,8,8);
  return c.toDataURL('image/png').split(',')[1];
}),'base64'));
/* and what levels 5 and 6 used to come back as: one flat land */
const solidPng=async p=>SOLIDP||(SOLIDP=Buffer.from(await p.evaluate(()=>{
  const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d'); x.fillStyle='#CEC58A'; x.fillRect(0,0,1024,1024);
  return c.toDataURL('image/png').split(',')[1];
}),'base64'));
/* and one flat fill of any colour: FLAT='#BEDEEB' is the middle of a
   big lake, one depth area wider than the image; 'none' is a lake with
   no ENC cell at all, every pixel (0,0,0,0) */
const flatPng=async(p,col)=>FLATP[col]||(FLATP[col]=Buffer.from(await p.evaluate(col=>{
  const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d'); if(col!=='none'){ x.fillStyle=col; x.fillRect(0,0,1024,1024); }
  return c.toDataURL('image/png').split(',')[1];
},col),'base64'));
let PAGE=null;
const nos=async r=>{
  noaa++; noaaUrl=r.request().url();
  if(OFFLINE) return r.abort('internetdisconnected');
  return r.fulfill({status:200, contentType:'image/png',
    headers:{"Access-Control-Allow-Origin":"*"},
    body:FLAT ? await flatPng(PAGE||r.request().frame().page(), FLAT)
              : await (SOLID?solidPng:BLACK?inkPng:chartPng)(PAGE||r.request().frame().page())});
};
/* FWC: the lake survey, as the real service answers it - GeoJSON lines
   with DEPTHF in negative feet, only those meeting the envelope, at most
   FWC_MAX a page with exceededTransferLimit while more remain. Synthetic
   contours, made below; nothing of FWC's own is in the probe. */
/* FWC_HANG: a link that takes the request and never answers (a hotspot
   with no backhaul) - held until released; FWC_PG: a page after the
   first that fails, 'abort' or 'error' (a 200 with ArcGIS's {error}). */
let FWC_FEATS=[], FWC_MAX=1000, FWC_OFF=false, FWC_HANG=false, FWC_PG=null;
const fwcAsks=[], hung=[];
const fwc=async r=>{
  const u=new URL(r.request().url()), q=u.searchParams;
  fwcAsks.push({g:q.get('geometry'), o:+q.get('resultOffset'), n:+q.get('resultRecordCount'),
                tol:q.get('maxAllowableOffset')});
  if(FWC_OFF) return r.abort('internetdisconnected');
  if(FWC_HANG){ await new Promise(res=>hung.push(res)); return r.abort('timedout').catch(()=>{}); }
  if(FWC_PG && +q.get('resultOffset')>0)
    return FWC_PG==='abort' ? r.abort('connectionreset')
      : r.fulfill({status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
          body:JSON.stringify({error:{code:500, message:'Error performing query operation'}})});
  const [w,s,e,n]=q.get('geometry').split(',').map(Number);
  const hit=FWC_FEATS.filter(f=>f.geometry.coordinates.some(c=>c[0]>=w&&c[0]<=e&&c[1]>=s&&c[1]<=n));
  const o=+q.get('resultOffset')||0, k=Math.min(+q.get('resultRecordCount')||1e9, FWC_MAX);
  const page=hit.slice(o,o+k), more=o+k<hit.length;
  const body={type:'FeatureCollection', features:page};
  if(more){ body.exceededTransferLimit=true; body.properties={exceededTransferLimit:true}; }
  return r.fulfill({status:200, contentType:'application/geo+json',
    headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify(body)});
};

const {b,p}=await open(t,{routes:{
  'http://localhost:3000/signalk/**':sk,
  'https://gis.charttools.noaa.gov/**':nos,
  'https://gis.myfwc.com/**':fwc}});
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
/* The kept charts (and with fwc, the kept survey) gone from IndexedDB,
   and from the page's memory of them. */
const dropCharts=(fwc)=>p.evaluate(fwc=>{ CHI.cur=null; CHI.fail.clear();
  if(fwc){ FWC.mem.clear(); FWC.fail.clear(); }
  return new Promise(res=>{ const r=indexedDB.open('confluence');
    r.onsuccess=e=>{ const db=e.target.result, tx=db.transaction('tilecache','readwrite');
      const st=tx.objectStore('tilecache'); st.getAllKeys().onsuccess=ev=>{
        ev.target.result.filter(k=>/^cht2?\//.test(String(k)) || (fwc && /^fwc1\//.test(String(k))))
          .forEach(k=>st.delete(k)); };
      tx.oncomplete=()=>{ db.close(); res(); }; }; }); }, !!fwc);
/* Decoded pixels of a screenshot, in the page. */
const pixels=`async b=>{ const im=new Image(); im.src='data:image/png;base64,'+b; await im.decode();
  const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
  const x=cv.getContext('2d'); x.drawImage(im,0,0);
  return {w:cv.width, d:x.getImageData(0,0,cv.width,cv.height).data}; }`;
const clearCourse=()=>delta([
  {path:'navigation.course.activeRoute', value:null},
  {path:'navigation.course.nextPoint', value:null},
  {path:'navigation.course.previousPoint', value:null}]);

/* ===================================================================== */
t.head('no route: nothing, and not one pixel of difference');
/* The demo plays the fix in every probe, and the demo has a route of its
   own when there is no real course - so first, its route turned off: a
   boat with no course. */
await p.evaluate(()=>{ CHT.DEMO_ROUTE=false; });
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
/* Not P1.equals(P2), and why. Once the chart has been up, Chromium
   re-rasters the hull number's 5 - the 1320 px watermark at .032, on the
   far side of the dial from the chart - with its edge pixels a few
   levels different: the same at 2 s with no route at all, different
   after one has been shown, and the same whether or not the chart had
   an image. Nothing of the chart's is left on the glass. So: every
   pixel in the chart's half is identical, and outside it nothing has
   moved by more than a watermark's edge can (10 of 255). */
const cmp=await p.evaluate(async([a,c])=>{
  const ld=async b=>{ const im=new Image(); im.src='data:image/png;base64,'+b; await im.decode();
    const cv=document.createElement('canvas'); cv.width=im.width; cv.height=im.height;
    const x=cv.getContext('2d'); x.drawImage(im,0,0); return x.getImageData(0,0,cv.width,cv.height).data; };
  const da=await ld(a), dc=await ld(c); let left=0, mx=0;
  for(let i=0;i<da.length;i+=4){
    const d=Math.max(Math.abs(da[i]-dc[i]),Math.abs(da[i+1]-dc[i+1]),Math.abs(da[i+2]-dc[i+2]));
    if(!d) continue;
    if((i/4)%1080<540) left++; mx=Math.max(mx,d); }
  return {left, mx};
},[P1.toString('base64'),P2.toString('base64')]);
t.ok(came && cmp.left===0 && cmp.mx<=10,
     'and after a route has come and gone, the chart\'s half of the dial is the same '
     +'pixels again', JSON.stringify(cmp));
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
t.ok(s.img && s.imgShown, 'a chart under it, baked and shown');
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
await p.evaluate(()=>chtCourseGet());
await p.waitForFunction(()=>($('cht-ahead').getAttribute('points')||'').split(' ').length===3,
  null, {timeout:8000}).catch(()=>{});
s=await st();
t.ok(s.on && s.ahead.split(' ').length===3, 'course GET with a route: the route, '
     +'without waiting for a delta');

/* ===================================================================== */
t.head('the active route edited in Freeboard-SK, the socket staying up');
/* The server re-reads the route and re-emits the course with the SAME
   href - a waypoint ahead moved, nextPoint unchanged. That delta is the
   only word the panel gets of the edit. The refetch is held back for a
   second so the probe can see the old shape still drawn meanwhile. */
const askR1=()=>asked.filter(x=>x.endsWith('/routes/r1')).length;
const r1n=askR1(), aheadWas=(await st()).ahead;
const A3e=await off(1900,-130);
ROUTES.r1={...ROUTES.r1, feature:{type:'Feature',
  geometry:{type:'LineString', coordinates:[A0,A1,A2,A3e]}}};
ROUTE_DELAY=1500;
await delta([
  {path:'navigation.course.activeRoute', value:{href:'/resources/routes/r1',
    pointIndex:1, pointTotal:4, reverse:false, name:'Evening'}},
  {path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1)}}]);
await settle(1100);
s=await st();
t.ok(s.ahead.split(' ').length===3,
     'while the new shape is on its way, the old one is still drawn - no blink', s.ahead);
await settle(2000);
ROUTE_DELAY=0;
s=await st();
const lastPt=a=>a.split(' ').pop();
t.ok(askR1()===r1n+1, 'the re-emitted course asks for the route again, once',
     (askR1()-r1n)+' asks');
t.ok(s.ahead.split(' ').length===3 && lastPt(s.ahead)!==lastPt(aheadWas),
     'and the route ahead is the edited one', aheadWas+' -> '+s.ahead);
await delta([{path:'navigation.course.nextPoint', value:{type:'RoutePoint', position:pos(A1)}}]);
await settle(1500);
t.ok(askR1()===r1n+1, 'a nextPoint alone does not refetch');

/* ===================================================================== */
t.head('a waypoint off the starboard bow keeps its ring');
/* Heading-up, the boat 30 px from the digits: a waypoint to starboard
   lands to the right of the boat. Its ring must be whole - left of the
   route's inboard fade, off the clock's +, above the rule - so the boat
   steps left and, abeam or astern, the scale comes in. */
const ringFits=async()=>p.evaluate(()=>{
  const cx=+$('cht-wp').getAttribute('cx'), cy=+$('cht-wp').getAttribute('cy');
  const cr=$('cht-clip-r'), right=+cr.getAttribute('x')+ +cr.getAttribute('width');
  const bx=+$('cht-boat').getAttribute('transform').match(/translate\(([-\d.]+)/)[1];
  return {cx, cy, bx, right,
    ok: cx+CHT.WP_R<=right-CHT.RT_FADE+.5 && cx-CHT.WP_R>=100 && cy+CHT.WP_R<=600.5
        && cy-CHT.WP_R>=230 && Math.hypot(cx-356,cy-258)>=54+CHT.WP_R-.5};
});
const bad=[];
for(const rel of [3,10,30,45,90,135,180,-150]){
  await delta([
    {path:'navigation.course.activeRoute', value:null},
    {path:'navigation.course.nextPoint', value:{type:'Location', position:pos(await off(1500,rel))}},
    {path:'navigation.course.previousPoint', value:null}]);
  await p.evaluate(()=>{ chtLastAt=0; }); await settle(400);
  const r=await ringFits(); if(!r.ok) bad.push(rel+': '+JSON.stringify(r));
  if(rel===45) await p.screenshot({path:SHOTS+'chart-stbd.png'});
}
t.ok(bad.length===0, 'at 3, 10, 30, 45, 90, 135 and 180 degrees, and astern to port: '
     +'the ring whole on the glass', bad.join(' | '));
const dead=await (async()=>{
  await delta([{path:'navigation.course.nextPoint', value:{type:'Location',
    position:pos(await off(1500,-8))}}]);
  await p.evaluate(()=>{ chtLastAt=0; }); await settle(400); return ringFits(); })();
t.ok(dead.ok && dead.bx===322, 'a waypoint a little to port leaves the boat where it is',
     JSON.stringify(dead));

/* ===================================================================== */
t.head('every mark loses to every reading, in every theme');
/* Off the glass: the strongest pixel of the ring (with the leg running
   into it), of the boat, against the strongest of the TWS strip - the
   dimmest reading on the dial. Strength is luminance contrast with the
   background, so it means the same by day (dark on light) as at night.
   Over the stand-in chart's land, so the marks have ink under them. */
COURSE.activeRoute={href:'/resources/routes/r1', pointIndex:1, pointTotal:4, reverse:false};
await p.evaluate(()=>chtCourseGet()); await settle(2000);
const glass=[];
for(const th of ['day','dusk','night']){
  await p.evaluate(th=>{ CFG.theme=th; applyTheme(); }, th); await settle(2800);
  const png=await shot();
  const m=await p.evaluate(async([b64,px])=>{
    const {w,d}=await (eval(px))(b64);
    const lin=v=>{ v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; };
    const L=(x,y)=>{ const i=(Math.round(y)*w+Math.round(x))*4;
      return .2126*lin(d[i])+.7152*lin(d[i+1])+.0722*lin(d[i+2]); };
    const bg=L(1000,540);   /* clean glass, right of the bezel numerals... */
    const cs=getComputedStyle(document.body);
    const hex=cs.getPropertyValue('--bg').trim(), bgL=(()=>{ const v=parseInt(hex.slice(1),16);
      return .2126*lin(v>>16&255)+.7152*lin(v>>8&255)+.0722*lin(v&255); })();
    const C=(x,y)=>Math.abs(L(x,y)-bgL);
    const cx=+$('cht-wp').getAttribute('cx'), cy=+$('cht-wp').getAttribute('cy');
    let ring=0; for(let a=0;a<360;a+=5) for(const r of [12,13,14])
      ring=Math.max(ring, C(cx+r*Math.cos(a/57.3), cy+r*Math.sin(a/57.3)));
    const bx=+$('cht-boat').getAttribute('transform').match(/translate\(([-\d.]+) ([-\d.]+)/)[1],
          by=CHT.BY;
    let boat=0; for(const [x,y] of [[0,-8],[0,-4],[0,0],[-3,3],[3,3],[0,-12]])
      boat=Math.max(boat, C(bx+x, by+y));
    const bb=$('p-tws').getBBox();
    let strip=0; for(let y=bb.y;y<bb.y+bb.height;y++) for(let x=bb.x;x<bb.x+bb.width;x++)
      strip=Math.max(strip, C(x,y));
    return {ring:+ring.toFixed(3), boat:+boat.toFixed(3), strip:+strip.toFixed(3), bg:+bg.toFixed(3)};
  },[png.toString('base64'), pixels]);
  glass.push(th+' '+JSON.stringify(m));
  t.ok(m.ring>0.01 && m.boat>0.01 && m.ring<m.strip && m.boat<m.strip,
       th+': the ring and the boat are on the glass, and weaker than the TWS strip',
       JSON.stringify(m));
  if(th==='night') await p.screenshot({path:SHOTS+'chart-night-marks.png'});
}
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); }); await settle(1500);

/* ===================================================================== */
t.head('the wind marks: the chart gives way under each one');
const holes=await p.evaluate(()=>{
  const h=id=>({cx:+$(id).getAttribute('cx'), cy:+$(id).getAttribute('cy'), r:+$(id).getAttribute('r')});
  const out={};
  chtWind(-60,-100); out.port=[h('cht-hole-a'),h('cht-hole-t')];
  chtWind(-61,-100); out.port2=h('cht-hole-a');
  chtWind(45,120);   out.stbd=[h('cht-hole-a'),h('cht-hole-t')];
  chtWind(null,null); out.none=[h('cht-hole-a'),h('cht-hole-t')];
  /* close-hauled and broad on port, the mark is above or below the box:
     a hole there would re-raster the whole chart for nothing */
  chtWind(-12.2,-150); out.out=[h('cht-hole-a'),h('cht-hole-t')];
  /* and it moves in whole degrees: a tenth of one writes nothing */
  chtWind(-60,-100); const w0=$('cht-hole-a').getAttribute('cx');
  const mo=new MutationObserver(()=>{}); mo.observe($('cht-wind'),{attributes:true,subtree:true});
  chtWind(-60.2,-100.2); out.small=mo.takeRecords().length; mo.disconnect();
  out.same=$('cht-hole-a').getAttribute('cx')===w0;
  return out;
});
const at=a=>[540+434*Math.sin(a/57.29578), 540-434*Math.cos(a/57.29578)];
const near2=(h,a)=>Math.abs(h.cx-at(a)[0])<1 && Math.abs(h.cy-at(a)[1])<1 && h.r>0;
t.ok(near2(holes.port[0],-60) && near2(holes.port[1],-100),
     'wind from port: a hole under each mark, at the mark', JSON.stringify(holes.port));
t.ok(near2(holes.port2,-61), 'and it follows the mark round');
t.ok(holes.stbd.every(h=>h.r===0), 'from starboard there is no chart there: no hole');
t.ok(holes.none.every(h=>h.r===0), 'no wind: no hole');
t.ok(holes.out.every(h=>h.r===0),
     'from port but above or below the chart\'s box: no hole, nothing written',
     JSON.stringify(holes.out));
t.ok(holes.small===0 && holes.same, 'a fifth of a degree writes nothing', holes.small+'');
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
const over=live.on && (()=>{ const [hx,hy]=at(Math.round(live.a));
  const ex=Math.max(100-hx,0,hx-(live.edge-3)), ey=Math.max(230-hy,0,hy-600);
  return ex*ex+ey*ey<95*95; })();
if(over)
  t.ok(Math.abs(live.h.cx-at(live.a)[0])<4 && Math.abs(live.h.cy-at(live.a)[1])<4,
       'render() moves the hole with the drawn apparent mark', JSON.stringify(live));
else
  t.ok(live.h.r===0, 'render() parks the hole while the apparent mark is off the chart',
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
/* And the moment it happens. The digits are rewritten every frame, the
   chart once a second - so the frame that first shows 10.0 is the one
   to look at, not one a second later. Caught by an observer on the
   digits, which runs as soon as the frame's script has: what the
   chart's box and boat say then is what that frame paints. */
const cross=[];
for(let i=0;i<3;i++){
  await p.evaluate(()=>{ window.__hs=setInterval(()=>{ const f=window.__fix;
    put('pos.lat',f[0]); put('pos.lon',f[1]); put('navigation.courseOverGroundTrue',f[2]);
    put('navigation.speedOverGround',9.6/MS_TO_KT); put('disp.sog',9.6/MS_TO_KT); },100); });
  await p.waitForFunction(()=>$('spd').textContent==='9.6', null, {timeout:8000}).catch(()=>{});
  await settle(1100+i*330);
  const r=await p.evaluate(()=>new Promise(res=>{
    const mo=new MutationObserver(()=>{ const t=$('spd').textContent;
      if(t.length<4) return;
      mo.disconnect();
      const want=CHT.EDGE+Math.min(0,4*Math.floor((shapeW('8.8')-shapeW(t))/2/4));
      const cr=$('cht-clip-r');
      res({t, want, edge:chtEdgeAt, clipR:+cr.getAttribute('x')+ +cr.getAttribute('width'),
           bx:+$('cht-boat').getAttribute('transform').match(/translate\(([-\d.]+)/)[1]}); });
    mo.observe($('spd'),{subtree:true, childList:true, characterData:true});
    clearInterval(window.__hs);
    window.__hs=setInterval(()=>{ const f=window.__fix;
      put('pos.lat',f[0]); put('pos.lon',f[1]); put('navigation.courseOverGroundTrue',f[2]);
      put('navigation.speedOverGround',10.3/MS_TO_KT); put('disp.sog',10.3/MS_TO_KT); },100);
  }));
  await p.evaluate(()=>clearInterval(window.__hs));
  cross.push(r);
}
t.ok(cross.every(r=>r.edge===r.want && r.clipR===r.want-3 && r.bx<=r.want-33 && r.want<355),
     'the first frame showing a fourth digit already has the chart out of its way',
     JSON.stringify(cross));
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
/* within 6: the canvas keeps its pixels premultiplied, and land is
   baked faint (an alpha of 24 or so at night), so a colour read back
   through it has lost a few levels of every channel */
t.ok(Math.abs(night.px[0]-0xC8)<=6 && Math.abs(night.px[1]-0x34)<=6
     && Math.abs(night.px[2]-0x2E)<=6,
     'in night\'s ink, #C8342E', night.px.join(','));
/* the stand-in's land is baked to the land tone, CHT.LAND of ink, and
   the strength on top of that */
const landA=Math.round(255*(await p.evaluate(()=>CHT.LAND)))/255;
t.ok(night.s==='.58' && Math.abs(night.px[3]-255*landA*.58)<=2,
     'land at its flat tone, at the night strength, .58, painted into the alpha',
     night.px[3]+' vs '+(255*landA*.58).toFixed(1));
const str=await p.evaluate(()=>['','dusk','night'].map(c=>{
  const was=document.body.className; document.body.className=c;
  const v=getComputedStyle(document.body).getPropertyValue('--cht-map').trim();
  document.body.className=was; return v; }));
t.ok(eq(str,['.50','.46','.58']), 'one strength per theme: day .50, dusk .46, night .58',
     str.join(' '));
const fil=await p.evaluate(()=>$('cht').querySelectorAll('[filter]').length
  + document.querySelectorAll('#cht filter, defs filter[id^="cht"]').length);
t.ok(fil===0, 'and no SVG filter anywhere in it - the bake is the filter, once');
/* A theme change that lands while the bake is encoding - the 60 s auto
   dusk-to-night, or a tap - must not leave the old ink filed as the new
   theme, where nothing would ever recolour it. */
await p.evaluate(()=>{ CFG.theme='dusk'; applyTheme(); }); await settle(2600);
const mid=await p.evaluate(async()=>{
  const img=CHI.cur; CHI.busy=true;
  const pr=chtColour(img); setTimeout(()=>{ CFG.theme='night'; applyTheme(); },0);
  await pr; CHI.busy=false;
  return {theme:img.theme, body:document.body.className};
});
await settle(2600);
const midPx=await p.evaluate(()=>{ const img=CHI.cur;
  return {theme:img.theme, px:[...img.c.getContext('2d').getImageData(100,500,1,1).data]}; });
t.ok(mid.theme==='dusk' && mid.body==='night' && midPx.theme==='night'
     && Math.abs(midPx.px[0]-0xC8)<=6 && Math.abs(midPx.px[1]-0x34)<=6,
     'a theme change during the bake: filed under the theme it was baked for, '
     +'and recoloured to the new one at the next check', JSON.stringify([mid, midPx]));

/* Gone by the TWS rule. A chart that is ink everywhere, shot with its
   image shown and hidden: from the rule down, not one pixel differs. */
BLACK=true; await dropCharts();
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20);
  chtSeq++; chtLastAt=0; });
await p.waitForFunction(()=>CHI.cur && CHI.cur.url && $('cht-img').style.display!=='none',
  null, {timeout:8000}).catch(()=>{});
await settle(1200);
const on=await shot();
await p.evaluate(()=>{ $('cht-img').style.display='none'; }); await settle(150);
const offI=await shot();
await p.evaluate(()=>{ $('cht-img').style.display=''; clearInterval(window.__hold); });
const rule=await p.evaluate(async([a,c,px])=>{
  const A=await (eval(px))(a), B=await (eval(px))(c);
  const dif=(y0,y1)=>{ let n=0, mx=0;
    for(let y=y0;y<y1;y++) for(let x=100;x<360;x++){ const i=(y*A.w+x)*4;
      const d=Math.max(Math.abs(A.d[i]-B.d[i]),Math.abs(A.d[i+1]-B.d[i+1]),Math.abs(A.d[i+2]-B.d[i+2]));
      if(d>1){ n++; mx=Math.max(mx,d); } }
    return {n, mx}; };
  return {above:dif(480,560), below:dif(600,680)};
},[on.toString('base64'), offI.toString('base64'), pixels]);
t.ok(rule.above.n>0 && rule.below.n===0,
     'the chart is there in the sector and gone by the TWS rule - nothing of it '
     +'on the rule or the strip under it', JSON.stringify(rule));
BLACK=false; await dropCharts();
await p.evaluate(()=>{ chtSeq++; chtLastAt=0; });
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); }); await settle(2500);

/* ===================================================================== */
t.head('the depth chart: FWC\'s lake survey, baked once per area');
/* The boat held where it is, so every bake below is of the same water.
   First an image with no survey, to learn where it lies; then a survey
   made for it - twelve rings, 1 ft apart, 6 px apart, shoaling to the
   edge like a lake - served the way FWC serves it: GeoJSON, DEPTHF in
   negative feet, five lines a page. */
/* an image on the glass, and the survey's own fetch for it (which runs
   after the image is shown, not before) finished too */
const waitImg=async()=>{ await p.evaluate(()=>{ chtSeq++; chtLastAt=0; });
  await p.waitForFunction(()=>CHI.cur && CHI.cur.url && !CHI.busy && !CHI.cur.fwcBusy, null,
    {timeout:15000}).catch(()=>{}); await settle(600); };
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20); });
FWC_FEATS=[]; await dropCharts(true); await waitImg();
const G=await p.evaluate(()=>({cx:CHI.cur.cx, cy:CHI.cur.cy, L:CHI.cur.L, k:CHI.cur.k}));
const CXP=800, CYP=512, RING=d=>90-6*(d-1);
const pxLL=(x,y)=>{ const R=6378137, mx=G.cx-512*G.L+x*G.L, my=G.cy+512*G.L-y*G.L;
  return [mx/R*180/Math.PI, (2*Math.atan(Math.exp(my/R))-Math.PI/2)*180/Math.PI]; };
const rings=[];
for(let d=1;d<=12;d++){ const cs=[];
  for(let a=0;a<=96;a++){ const th=a/96*2*Math.PI;
    cs.push(pxLL(CXP+RING(d)*Math.cos(th), CYP+RING(d)*Math.sin(th))); }
  rings.push({type:'Feature', properties:{DEPTHF:-d}, geometry:{type:'LineString', coordinates:cs}}); }
FWC_FEATS=rings; FWC_MAX=5; fwcAsks.length=0;
await dropCharts(true); await waitImg();
/* what one run of the bake reads, from 2 px outside the 1 ft ring
   (inside the survey's 150 m reach at every level) in to the middle,
   each run of equal alpha once - from the east by default, or from
   (dx,dy): the nearest-contour fill is two passes, one down and one up,
   and a run from the north or the west is what reads the second */
const ray=(dx=1,dy=0)=>p.evaluate(([cx,cy,dx,dy])=>{ const a=CHI.cur.a, out=[];
  for(let k=Math.round(92/Math.hypot(dx,dy));k>=0;k--){
    const v=a[(cy+k*dy)*1024+cx+k*dx]; if(out[out.length-1]!==v) out.push(v); }
  return out; },[CXP,CYP,dx,dy]);
const BANDS=await p.evaluate(()=>CHT.BAND.map(v=>Math.round(255*v)));
const want=[BANDS[0],255,0,BANDS[1],255,0,BANDS[2],BANDS[3]];
let rr=await ray(), img=await p.evaluate(()=>({fwc:CHI.cur.fwc, k:CHI.cur.k, miss:CHI.cur.fwcMiss}));
t.ok(img.fwc>0 && !img.miss && eq(rr,want),
     'from the shore in: 0-3 ft darkest, the 3 ft line, a clear pixel, 3-6 ft, the 6 ft line, '
     +'a clear pixel, 6-10 ft light, deeper clear - each band between its own contours',
     JSON.stringify({rr, want, img}));
{ const runs={}; for(const [n,dx,dy] of [['N',0,-1],['S',0,1],['W',-1,0],['NE',1,-1],['SW',-1,1]])
    runs[n]=await ray(dx,dy);
  t.ok(Object.values(runs).every(r=>eq(r,want)),
       'and the same from the north, the south, the west and on the diagonals', JSON.stringify(runs));
  /* exactly where each band starts: the pixel one inside each ring is
     that ring's band, all round - a fill that saw the rings from one
     side only puts the edges a ring out on the other */
  const edges=await p.evaluate(([cx,cy,B])=>{ const a=CHI.cur.a, bad=[];
    const R=d=>90-6*(d-1), band=z=>z<3?B[0]:z<6?B[1]:z<10?B[2]:B[3];
    for(let th=0;th<360;th+=15) for(const d of [2,4,5,7,8]){
      const r=R(d)-3, x=Math.round(cx+r*Math.cos(th/57.2958)), y=Math.round(cy+r*Math.sin(th/57.2958));
      const v=a[y*1024+x]; if(v!==band(d+.5)) bad.push([th,d,v]); }
    return bad; },[CXP,CYP,BANDS]);
  t.ok(edges.length===0, 'midway between every pair of rings, all round: the band of the ring outside it',
       JSON.stringify(edges.slice(0,12))); }
/* The contour is a line, not a seam. The 3 ft line is full ink beside
   the 0-3 ft band, so it must stand out from that band by as much as
   the bands stand out from each other - by more than its clear pixel
   alone, or it reads the same as the coast's clear gap. And night,
   the dimmest, still has every water tone ~25 levels of red from the
   next: the 6-10 ft wash is not lost in the dial's soft fades. */
{ const tone=await p.evaluate(()=>{ const was=document.body.className; document.body.className='night';
    const cs=getComputedStyle(document.body), s=parseFloat(cs.getPropertyValue('--cht-map'));
    const ink=parseInt(cs.getPropertyValue('--ink').trim().slice(1),16)>>16&255,
          bg=parseInt(cs.getPropertyValue('--bg').trim().slice(1),16)>>16&255;
    document.body.className=was;
    const lv=a=>bg+(ink-bg)*s*a;
    return {line:lv(1), b:CHT.BAND.map(lv), land:lv(CHT.LAND), bg}; });
  const st=[tone.line, ...tone.b].map(v=>Math.round(v));
  t.ok(st.every((v,i)=>i===0 || st[i-1]-v>=24),
       'night red: 3 ft line, 0-3, 3-6, 6-10, deep - each tone 24 levels or more from the next',
       JSON.stringify({levels:st, land:Math.round(tone.land)}));
  t.ok(tone.land>tone.bg+10 && tone.land<tone.b[2]-8,
       'and land a low flat tone of its own, below the 6-10 ft wash', JSON.stringify(tone)); }
/* every page asked, once: an envelope that meets the rings in n lines
   is asked ceil(n/5) times, at offsets 0, 5, 10; one that meets none,
   once */
const byEnv=new Map(); for(const a of fwcAsks){ if(!byEnv.has(a.g)) byEnv.set(a.g,[]); byEnv.get(a.g).push(a.o); }
const pg=[...byEnv].map(([g,os])=>{ const [w,s,e,n]=g.split(',').map(Number);
  const hits=rings.filter(f=>f.geometry.coordinates.some(c=>c[0]>=w&&c[0]<=e&&c[1]>=s&&c[1]<=n)).length;
  const need=Math.max(1,Math.ceil(hits/5));
  return {hits, os, ok:os.length===need && eq(os,[...Array(need)].map((_,i)=>i*5))}; });
t.ok(pg.length>0 && pg.every(x=>x.ok) && pg.some(x=>x.hits===12 || x.os.length>1),
     'paged: every page of every square asked once, at 5 lines a page', JSON.stringify(pg));
t.ok(fwcAsks.every(a=>+a.tol>0 && +a.tol<1e-4),
     'and generalised by the server to a couple of metres', fwcAsks[0]&&fwcAsks[0].tol);
const keptF=await p.evaluate(()=>tileTx('readonly',st=>st.getAllKeys())
  .then(ks=>Promise.all(ks.filter(k=>/^fwc1\//.test(k)).map(k=>tileGet(k)
    .then(r=>({k, blob:r.b instanceof Blob, t:!!r.t}))))));
t.ok(keptF.length===byEnv.size && keptF.every(r=>r.blob && r.t),
     'every square kept in the tilecache store, as a blob under fwc1/, with the trim\'s timestamp',
     JSON.stringify(keptF));
t.ok(/IntendedUsage/.test(decodeURIComponent(noaaUrl)) && /SafetyContour/.test(decodeURIComponent(noaaUrl)),
     'NOAA asked with IntendedUsage (levels 5-6 draw the lake) and the 1.8 m contour');
/* the pile: one small dot, not a 24 px blob */
const pile=await p.evaluate(()=>{ const a=CHI.cur.a; let n=0;
  for(let y=290;y<340;y++) for(let x=590;x<640;x++) if(a[y*1024+x]>=250) n++; return n; });
t.ok(pile>0 && pile<=9, 'a pile is a 3 px dot of full ink', pile+' px');
/* outside every ENC cell the service sends (0,0,0,0): clear, not ink */
const nocell=await p.evaluate(()=>[CHI.cur.a[70*1024+950], CHI.cur.a[200*1024+950]]);
t.ok(nocell[0]===0 && nocell[1]===BANDS[1],
     'a transparent pixel is clear; the charted water beside it is its band', nocell.join(','));

t.head('baked once, never per frame; the survey asked once, then offline');
const bk0=(await st()).bake; await settle(3000);
t.ok((await st()).bake===bk0, 'three seconds at rest: not one bake', ((await st()).bake-bk0)+'');
const ms=await p.evaluate(()=>CHT.n.bakeMs);
t.ok(ms>0 && ms<3000, 'and one bake, timed in the page, '+ms+' ms here');
let f0=fwcAsks.length;
await p.evaluate(()=>{ CHI.cur=null; FWC.mem.clear(); }); await waitImg();
t.ok(fwcAsks.length===f0 && eq(await ray(),want),
     'baked again (a reload, a new scale): the survey from IndexedDB, not asked again',
     (fwcAsks.length-f0)+' asks');
FWC_OFF=true; OFFLINE=true; f0=fwcAsks.length; const nn=noaa;
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear(); FWC.mem.clear(); FWC.fail.clear(); });
await waitImg();
rr=await ray();
t.ok(eq(rr,want) && fwcAsks.length===f0 && noaa===nn,
     'offline: the same depth chart, from the store alone', JSON.stringify({rr, asks:fwcAsks.length-f0, noaa:noaa-nn}));
FWC_OFF=false; OFFLINE=false;

t.head('no survey: the ENC\'s own depth areas');
FWC_FEATS=[]; await dropCharts(true); await waitImg();
rr=await ray(); img=await p.evaluate(()=>({fwc:CHI.cur.fwc, miss:CHI.cur.fwcMiss}));
t.ok(img.fwc===0 && !img.miss && eq(rr,[BANDS[1]]),
     'FWC answers with nothing here: the ENC\'s under-1.8 m area is the 3-6 ft band',
     JSON.stringify({rr, img}));
/* FWC unreachable, and never seen: the ENC's bands now, and FWC asked
   again a minute later - not every second */
FWC_FEATS=rings; FWC_OFF=true; f0=fwcAsks.length;
await dropCharts(true); await waitImg();
img=await p.evaluate(()=>({fwc:CHI.cur.fwc, miss:CHI.cur.fwcMiss}));
const n1=fwcAsks.length; await settle(3000);
t.ok(img.fwc===0 && img.miss && eq(await ray(),[BANDS[1]]) && fwcAsks.length===n1,
     'FWC unreachable: the ENC\'s bands, and not asked again every second',
     JSON.stringify({img, asks:[n1-f0, fwcAsks.length-n1]}));
FWC_OFF=false;
await p.evaluate(()=>{ CHI.cur.fwcT=0; FWC.fail.clear(); chtLastAt=0; });
await p.waitForFunction(()=>CHI.cur && CHI.cur.fwc>0 && !CHI.busy, null, {timeout:15000}).catch(()=>{});
t.ok(eq(await ray(),want), 'and when it answers, baked again with the survey');

t.head('nothing kept from before, nothing kept that is not a chart');
/* An image cached under the old key (the old parameters: levels 5-6
   flat land, no IntendedUsage) for this very cell is never read. */
const oldK=G.k.replace(/^cht2\//,'cht/');
await dropCharts(true);
await p.evaluate(async k=>{ const c=document.createElement('canvas'); c.width=c.height=1024;
  const x=c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,1024,1024);
  await tilePut(k, await new Promise(r=>c.toBlob(r,'image/png'))); CHI.swept=false; }, oldK);
let ob=noaa; await waitImg();
const old=await p.evaluate(k=>tileGet(k).then(r=>({gone:!r, k:CHI.cur.k, land:CHI.cur.a[500*1024+100]})), oldK);
t.ok(noaa===ob+1 && old.gone && /^cht2\//.test(old.k) && old.land===Math.round(255*(await p.evaluate(()=>CHT.LAND))),
     'an image under the old cht/ key: not read, fetched anew, and the old one deleted',
     JSON.stringify({asks:noaa-ob, ...old}));
/* One flat colour - what levels 5-6 were without IntendedUsage: refused,
   not shown, not kept. */
SOLID=true; await dropCharts(true); ob=noaa;
await p.evaluate(()=>{ chtSeq++; chtLastAt=0; }); await settle(3000);
const solid=await p.evaluate(k=>tileGet(k).then(r=>({kept:!!r, cur:!!CHI.cur, fail:CHI.fail.has(k)})), G.k);
t.ok(noaa>ob && !solid.kept && !solid.cur && solid.fail,
     'an export of one flat colour, no water: refused, and never cached', JSON.stringify(solid));
SOLID=false; FWC_MAX=1000;

/* The sweep of the old cht/ images takes those and nothing else: today's
   charts and surveys kept beside them are what the boat has offline. */
{ await p.evaluate(async()=>{ await tilePut('cht/3/1/1', new Blob(['x']));
    await tilePut('cht2/9/9/9', new Blob(['y']));
    await tilePut('fwc1/0/0', new Blob(['{"v":1,"f":[]}'],{type:'application/json'}));
    CHI.swept=false; CHI.cur=null; CHI.fail.clear(); });
  await waitImg();
  const sw=await p.evaluate(()=>Promise.all(['cht/3/1/1','cht2/9/9/9','fwc1/0/0'].map(k=>tileGet(k)))
    .then(r=>r.map(x=>!!x)));
  t.ok(!sw[0] && sw[1] && sw[2], 'the sweep takes the old cht/ images and only them: a cht2/ chart '
       +'and a fwc1/ survey beside them are kept', JSON.stringify(sw));
  await p.evaluate(()=>Promise.all([tileDel('cht2/9/9/9'), tileDel('fwc1/0/0')])); }

/* A kept survey square that will not parse - cut short by a power cut -
   is thrown away and fetched again, once; not missed on every bake. */
FWC_FEATS=rings; FWC_MAX=5; await dropCharts(true); await waitImg();
{ const ks=await p.evaluate(()=>tileTx('readonly',st=>st.getAllKeys())
    .then(ks=>ks.filter(k=>/^fwc1\//.test(k))));
  const bad=ks[0];
  await p.evaluate(async k=>{ await tilePut(k,new Blob(['{"v":1,"f":[[5,1,2'],{type:'application/json'}));
    FWC.mem.clear(); CHI.cur=null; }, bad);
  const f0=fwcAsks.length; await waitImg();
  const healed=await p.evaluate(k=>tileGet(k).then(async r=>{
    try{ return Array.isArray(JSON.parse(await r.b.text()).f); }catch(e){ return false; } }), bad);
  const f1=fwcAsks.length; rr=await ray();
  t.ok(bad && healed && f1>f0 && eq(rr,want),
       'a kept survey square that will not parse: deleted, fetched again, and the depth chart whole',
       JSON.stringify({bad, healed, asks:f1-f0, rr}));
  await p.evaluate(()=>{ CHI.cur=null; FWC.mem.clear(); }); await waitImg();
  t.ok(fwcAsks.length===f1, 'and the bake after reads it from the store', (fwcAsks.length-f1)+' asks'); }

/* One page of a square failing - not the first - must not leave the
   pages before it kept as the whole square: that is a survey with
   holes, and the water in them shaded by the wrong contour. */
for(const mode of ['abort','error']){
  FWC_PG=mode; await dropCharts(true); fwcAsks.length=0; await waitImg();
  const paged=new Set(fwcAsks.filter(a=>a.o>0).map(a=>a.g));
  const r=await p.evaluate(()=>tileTx('readonly',st=>st.getAllKeys()).then(ks=>({
    kept:ks.filter(k=>/^fwc1\//.test(k)).length, miss:CHI.cur.fwcMiss, fwc:CHI.cur.fwc})));
  t.ok(paged.size>0 && r.miss && r.fwc===0 && r.kept===byEnv.size-paged.size,
       'a later page of a square '+(mode==='abort'?'cut off':'answered with an error')
       +': that square not kept, and the chart the ENC\'s, not half a survey',
       JSON.stringify({...r, squares:byEnv.size, paged:paged.size}));
  FWC_PG=null;
  await p.evaluate(()=>{ FWC.fail.clear(); CHI.cur.fwcT=0; chtLastAt=0; });
  await p.waitForFunction(()=>CHI.cur && CHI.cur.fwc>0 && !CHI.cur.fwcBusy, null, {timeout:15000}).catch(()=>{});
  const k2=await p.evaluate(()=>tileTx('readonly',st=>st.getAllKeys())
    .then(ks=>ks.filter(k=>/^fwc1\//.test(k)).length));
  t.ok(eq(await ray(),want) && k2===byEnv.size,
       'and when it answers in full: every square kept, baked again with the survey', k2+'');
}

/* FWC on a link that takes the request and never answers. The chart
   kept in the store is on the glass at once, in the ENC's bands; every
   square of the survey is being asked at the same time, not one after
   another; and the loader is free for the next image meanwhile. */
{ FWC_MAX=1000; await dropCharts(true); await waitImg();
  await p.evaluate(()=>new Promise(res=>{ const r=indexedDB.open('confluence');
    r.onsuccess=e=>{ const db=e.target.result, tx=db.transaction('tilecache','readwrite');
      const st=tx.objectStore('tilecache'); st.getAllKeys().onsuccess=ev=>{
        ev.target.result.filter(k=>/^fwc1\//.test(String(k))).forEach(k=>st.delete(k)); };
      tx.oncomplete=()=>{ db.close(); res(); }; }; }));
  FWC_HANG=true; const nb=noaa;
  await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear(); FWC.mem.clear(); FWC.fail.clear(); chtSeq++; chtLastAt=0; });
  const t0=Date.now();
  await p.waitForFunction(()=>CHI.cur && CHI.cur.url && $('cht-img').style.display!=='none',
    null, {timeout:10000}).catch(()=>{});
  const dt=Date.now()-t0; await settle(300);
  const h=await p.evaluate(()=>({busy:CHI.busy, miss:!!(CHI.cur&&CHI.cur.fwcMiss),
    asking:!!(CHI.cur&&CHI.cur.fwcBusy), fwc:CHI.cur&&CHI.cur.fwc}));
  t.ok(dt<4000 && noaa===nb && !h.busy && h.miss && h.asking && h.fwc===0 && hung.length===byEnv.size,
       'FWC hanging: the kept chart on the glass in '+dt+' ms, the loader free, every square asked at once',
       JSON.stringify({dt, ...h, hung:hung.length, squares:byEnv.size, noaa:noaa-nb}));
  FWC_HANG=false; hung.splice(0).forEach(r=>r());
  await p.waitForFunction(()=>CHI.cur && !CHI.cur.fwcBusy, null, {timeout:15000}).catch(()=>{});
  await p.evaluate(()=>{ FWC.fail.clear(); CHI.cur.fwcT=0; chtLastAt=0; });
  await p.waitForFunction(()=>CHI.cur && CHI.cur.fwc>0 && !CHI.cur.fwcBusy, null, {timeout:15000}).catch(()=>{});
  t.ok(eq(await ray(),want), 'and once it answers, the survey baked in'); }

/* The middle of a big lake: an export that is one depth area from edge
   to edge. It is water, and a chart - not "one flat colour". */
{ FWC_FEATS=[]; FLAT='#BEDEEB'; await dropCharts(true); await waitImg();
  const fl=await p.evaluate(()=>CHI.cur ? tileGet(CHI.cur.k).then(r=>({kept:!!r,
    v:[CHI.cur.a[0], CHI.cur.a[512*1024+512], CHI.cur.a[1024*1024-1]]})) : {kept:false});
  t.ok(fl.kept && fl.v.every(v=>v===BANDS[2]),
       'one flat depth area, edge to edge: baked (1.8-3 m, the 6-10 ft band) and kept', JSON.stringify(fl)); }

/* A lake FWC surveyed that no ENC cell covers - most of Florida's
   inland lakes: the export is (0,0,0,0) everywhere, and the survey alone
   is the chart. Outside its shallowest ring, a rim of land tone with a
   clear pixel at the water; beyond that, nothing. */
{ FLAT='none'; FWC_FEATS=rings; await dropCharts(true); await waitImg();
  const fo=await p.evaluate(([cx,cy])=>CHI.cur ? tileGet(CHI.cur.k).then(r=>({kept:!!r, fwc:CHI.cur.fwc,
    far:CHI.cur.a[20*1024+20]})) : {kept:false}, [CXP,CYP]);
  const LANDV=Math.round(255*(await p.evaluate(()=>CHT.LAND)));
  rr=await ray();
  t.ok(fo.kept && fo.fwc>0 && fo.far===0 && eq(rr,[LANDV,0,...want]),
       'no ENC cell, a surveyed lake: the survey alone - land-tone rim, clear shore, then the bands',
       JSON.stringify({fo, rr}));
  FWC_FEATS=[]; await dropCharts(true); ob=noaa;
  await p.evaluate(()=>{ chtSeq++; chtLastAt=0; }); await settle(3000);
  const nn2=await p.evaluate(k=>tileGet(k).then(r=>({kept:!!r, cur:!!CHI.cur, fail:CHI.fail.has(k)})), G.k);
  t.ok(noaa>ob && !nn2.kept && !nn2.cur && nn2.fail,
       'and no ENC cell and no survey: nothing to draw, refused and not kept', JSON.stringify(nn2));
  FLAT=null; FWC_FEATS=[]; }

t.head('the bake on its own: where the survey ends, and what is a mark');
/* chtDepthBake straight, on small pictures drawn here in NOAA's day
   palette, 10 m a pixel; FWC rings given in pixels. */
await p.evaluate(()=>{
  window.__bk=(W,H,draw,rings)=>{
    const c=document.createElement('canvas'); c.width=W; c.height=H;
    const x=c.getContext('2d'); draw(x);
    const d=x.getImageData(0,0,W,H).data, L=10;
    const lines=rings.map(([cx,cy,r,z])=>{ const p=[];
      for(let a=0;a<=64;a++){ const th=a/64*2*Math.PI; p.push((cx+r*Math.cos(th))*L, -(cy+r*Math.sin(th))*L); }
      return {z, p:Float64Array.from(p)}; });
    const r=chtDepthBake(d,W,H,lines,{L, ox:0, oy:0, BAND:CHT.BAND, LAND:CHT.LAND, LINES:CHT.LINES,
      DOT:CHT.DOT, REACH:CHT.FWC_REACH, FILL:CHT.FWC_FILL});
    r.at=(X,Y)=>r.a[Y*W+X]; return r; };
});
{ /* half charted water, half outside every ENC cell; a 5 ft ring in
     the water. Not one pixel of the uncharted half is inked - the old
     bake gave it all the 3-6 ft band, the ring's nearest-contour zone
     running straight on across ground no chart covers */
  const r=await p.evaluate(()=>{ const b=__bk(300,200,x=>{ x.fillStyle='#DDF1EE'; x.fillRect(0,0,150,200); },
      [[70,100,30,5]]);
    let n=0; for(let y=0;y<200;y++) for(let x=150;x<300;x++) if(b.at(x,y)) n++;
    return {n, ring:b.at(70,100), far:b.at(260,100)}; });
  t.ok(r.n===0 && r.ring===BANDS[1], 'outside every ENC cell, a kilometre from a 5 ft ring: clear, '
       +'every pixel of it; inside the ring, its band', JSON.stringify(r)); }
{ /* a lake with a ring, and a river across the land from it. The river
     is the ENC's, however deep the contour nearest it in a straight line */
  const r=await p.evaluate(()=>{
    const pic=(river)=>x=>{ x.fillStyle='#CEC58A'; x.fillRect(0,0,400,200);
      x.fillStyle='#82BDFF'; x.fillRect(20,20,120,160); x.fillStyle=river; x.fillRect(300,0,20,200); };
    const a=__bk(400,200,pic('#BEDEEB'),[[80,100,40,5]]), b=__bk(400,200,pic('#82BDFF'),[[80,100,40,12]]);
    return {a:[a.at(310,100), a.at(80,100)], b:[b.at(310,100), b.at(80,100)]}; });
  t.ok(r.a[0]===BANDS[2] && r.a[1]===BANDS[1],
       'a 1.8-3 m river 2 km across land from a 5 ft ring: the ENC\'s 6-10 ft, not the ring\'s 3-6',
       JSON.stringify(r.a));
  t.ok(r.b[0]===BANDS[1] && r.b[1]===BANDS[3],
       'and an under-1.8 m river beside a 12 ft lake: shallow, not clear like the deep water',
       JSON.stringify(r.b)); }
{ /* a diagonal coast, anti-aliased, with specks of pure black stepping
     along it - what the service draws at the finer levels - and one
     real pile out in the water */
  const r=await p.evaluate(()=>{ const b=__bk(240,240,x=>{
      x.fillStyle='#82BDFF'; x.fillRect(0,0,240,240);
      x.fillStyle='#CEC58A'; x.beginPath(); x.moveTo(0,0); x.lineTo(170,0); x.lineTo(0,170); x.fill();
      x.strokeStyle='#3A3F3E'; x.lineWidth=2; x.beginPath(); x.moveTo(170,0); x.lineTo(0,170); x.stroke();
      x.fillStyle='#000';
      for(let s=4;s<166;s+=5){ const k=(s/5|0)%3; x.fillRect(170-s, s, k?1:3, k===1?2:k?1:3); }
      x.fillRect(180,180,6,6); }, []);
    let full=0; for(let i=0;i<b.a.length;i++) if(b.a[i]===255) full++;
    return {dots:b.stat.dots, pile:b.at(183,183), full}; });
  t.ok(r.dots===1 && r.pile===255 && r.full===9,
       'specks of black along a diagonal coast are coast, not hazards: one dot, the real pile',
       JSON.stringify(r)); }
{ /* a black symbol on land (a landmark, a tank): land, not a hazard in
     a hole */
  const r=await p.evaluate(()=>{ const b=__bk(200,160,x=>{
      x.fillStyle='#CEC58A'; x.fillRect(0,0,120,160); x.fillStyle='#82BDFF'; x.fillRect(120,0,80,160);
      x.strokeStyle='#000'; x.lineWidth=2.5;
      for(const [a,rr] of [[0,8],[1,6],[2,9],[3,4]]){ x.beginPath(); x.arc(55+a,70+a%2*3,rr,0,5.5); x.stroke(); } }, []);
    const vals=new Set(); for(let y=55;y<90;y++) for(let x=38;x<75;x++) vals.add(b.at(x,y));
    return {dots:b.stat.dots, vals:[...vals]}; });
  const LANDV=Math.round(255*(await p.evaluate(()=>CHT.LAND)));
  t.ok(r.dots===0 && r.vals.length===1 && r.vals[0]===LANDV,
       'a black symbol on land bakes to land: no dot, no clear hole', JSON.stringify(r)); }
{ /* a symbol's outline broken into a ring of small black pieces, in
     the water; and one pile alone */
  const r=await p.evaluate(()=>{ const b=__bk(200,200,x=>{
      x.fillStyle='#BEDEEB'; x.fillRect(0,0,200,200); x.fillStyle='#000';
      for(let a=0;a<12;a++){ const th=a/12*2*Math.PI;
        x.fillRect(Math.round(70+12*Math.cos(th)), Math.round(70+12*Math.sin(th)), 3, 3); }
      x.fillRect(150,150,5,5); }, []);
    return {dots:b.stat.dots, pile:b.at(152,152), ring:b.at(83,71)}; });
  t.ok(r.dots===1 && r.pile===255 && r.ring===BANDS[2],
       'a dotted outline is not a chain of hazards: one dot, the pile alone', JSON.stringify(r)); }
await p.evaluate(()=>{ CHI.fail.clear(); clearInterval(window.__hold); });
await waitImg();

/* ===================================================================== */
t.head('the chart seen once with a signal is there without one');
/* The boat held where it is, so the same water is asked for twice. */
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20); });
await settle(3000);
const key=await p.evaluate(()=>CHI.cur.k);
const kept=await p.evaluate(k=>tileGet(k).then(r=>!!(r&&r.b&&r.t)), key);
t.ok(/^cht2\/\d+\/-?\d+\/-?\d+$/.test(key) && kept,
     'kept in the tilecache store under its own key, with the trim\'s timestamp', key);
OFFLINE=true;
const n0=noaa;
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear(); chtSeq++; chtLastAt=0; });
await settle(2500);
s=await st();
t.ok(s.img && s.imgShown && await p.evaluate(()=>/^cht2\//.test(CHI.cur.k)),
     'offline, the same water: the chart is back from IndexedDB',
     await p.evaluate(k=>JSON.stringify({k, cur:CHI.cur&&CHI.cur.k, k1:chtView&&1/chtView.k,
       fail:[...CHI.fail.keys()], busy:CHI.busy, demoT}), key));
t.ok(noaa===n0, 'without asking the network', (noaa-n0)+' asks');
/* and new water, offline: no picture, the route on clean glass */
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear();
  return new Promise(res=>{ const r=indexedDB.open('confluence');
    r.onsuccess=e=>{ const db=e.target.result, tx=db.transaction('tilecache','readwrite');
      const st=tx.objectStore('tilecache'); st.getAllKeys().onsuccess=ev=>{
        ev.target.result.filter(k=>String(k).startsWith('cht2/')).forEach(k=>st.delete(k)); };
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

/* A kept image that no longer decodes - a blob lost to a power cut on
   the SD card - must not win the cache every second forever. */
await p.evaluate(()=>{ window.__df=demoT; window.__hold=setInterval(()=>{ demoT=window.__df; },20); });
await settle(1500);
const ck=await p.evaluate(()=>CHI.cur&&CHI.cur.k);
await p.evaluate(k=>tilePut(k,new Blob(['not a png'],{type:'image/png'})), ck);
const nb=noaa, bk=(await st()).bake;
await p.evaluate(()=>{ CHI.cur=null; CHI.fail.clear(); chtSeq++; chtLastAt=0; });
await settle(3500);
const healed=await p.evaluate(k=>tileGet(k).then(r=>({size:r&&r.b?r.b.size:0, cur:CHI.cur&&CHI.cur.k})), ck);
s=await st();
t.ok(s.img && s.imgShown && noaa-nb===1 && s.bake===bk+1 && healed.size>1000,
     'a cached image that will not decode is thrown away and fetched again, once',
     JSON.stringify({ck, ...healed, asks:noaa-nb, bakes:s.bake-bk}));
await p.evaluate(()=>clearInterval(window.__hold));

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
await p.evaluate(()=>{ CHT.DEMO_ROUTE=true; skEver=true; chtLastAt=0; }); await settle(1600);
s=await st();
t.ok(s.on && s.ahead!=='', 'no course, the demo sailing: the demo route - with Signal K '
     +'up too, so the DEMO pill on the boat shows the feature');
{ const far=await off(900,0);
  await delta([{path:'navigation.course.activeRoute', value:null},
    {path:'navigation.course.nextPoint', value:{type:'Location', position:{longitude:far[0], latitude:far[1]}}},
    {path:'navigation.course.previousPoint', value:null}]);
  await p.evaluate(()=>{ chtLastAt=0; }); await settle(1600);
  const r=await p.evaluate(()=>{ const x=chtRoute(); return x&&{demo:!!x.demo, n:x.pts.length}; });
  t.ok(r && !r.demo, 'a real course while the demo plays: the real one is drawn, not the demo\'s',
       JSON.stringify(r));
  await clearCourse(); await p.evaluate(()=>{ chtLastAt=0; }); await settle(1600);
  t.ok((await p.evaluate(()=>{ const x=chtRoute(); return !!(x&&x.demo); })),
       'and cleared, the demo route again'); }
await p.evaluate(()=>{ demoSet(false); chtLastAt=0; }); await settle(1600);
t.ok(!(await st()).on, 'the demo off: the demo route is gone');
await p.evaluate(()=>{ demoSet(true); CHT.DEMO_ROUTE=false; chtLastAt=0; }); await settle(1600);

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
/* the server's minPeriod is a debounce that DROPS what lands inside the
   window - a clear and a new course a moment apart kept only the clear */
t.ok(cs.every(x=>!('minPeriod' in x) && !('period' in x)),
     'and no minPeriod, which would throw away the second of two course changes',
     JSON.stringify(cs));
t.ok(asked.slice(gets).includes('/signalk/v2/api/vessels/self/navigation/course'),
     'the course API asked once the socket is open');
s=await st();
t.ok(s.on && s.ahead.split(' ').length===3,
     'and the route, from the deltas alone, on the dial', s.past+' | '+s.ahead);

await t.done(b);
