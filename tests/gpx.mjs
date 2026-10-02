/* The file: what the GPX says, where the button sends it, and the
   library it lands in - which is two lists, and the difference matters. */
import {open, tally, ORIGIN} from './helpers.mjs';
const t=tally();

/* A short track to make a file out of, laid down by hand: a probe that
   waits for the demo to sail an hour is a probe nobody runs. */
const seed=`(()=>{ const t0=Date.UTC(2026,8,23,17,40,0);
  TRK=[...Array(90).keys()].map(i=>({t:t0+i*1000, la:+(28.8190+i*0.00015).toFixed(7),
    lo:+(-81.2650-i*0.00005).toFixed(7), s:2.4+0.6*Math.sin(i/9), c:0.9}));
  trkDirty=true; drawMap(shownTrack()); })()`;

/* The boat's folder, as AvNav serves it. */
const INDEX=[{name:'Confluence-2026-09-23-1740.gpx', size:41213, at:1758648000},
             {name:'Confluence-2026-09-16-1802.gpx', size:38004, at:1758043320}];

const {b,p,posts}=await open(t,{
  status:{gpx:{available:true, dir:'/home/pi/avnav/user/gpx'}},
  reply:{'/gpx/save':body=>({ok:true, name:body.name+'.gpx',
                             url:'gpx/'+body.name+'.gpx'}),
         '/gpx/delete':{ok:true}},
  routes:{[ORIGIN+'/gpx/index.json*']:r=>r.fulfill({status:200,
            contentType:'application/json', body:JSON.stringify(INDEX)})}});
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
await p.evaluate(seed);
await p.waitForTimeout(400);

t.head('the file is a GPX a chartplotter will read');
const xml=await p.evaluate(()=>buildGPX(TRK));
t.ok(/^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(xml), 'it declares itself');
t.ok(/<gpx version="1\.1" creator="Confluence Helm"/.test(xml), 'version 1.1');
t.ok(/xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/.test(xml), 'in the GPX namespace');
t.ok(/xmlns:gpxtpx="http:\/\/www\.garmin\.com\/xmlschemas\/TrackPointExtension\/v1"/.test(xml),
     "and Garmin's, for the speed and course");
t.ok((xml.match(/<trkpt /g)||[]).length===90, 'every fix is a point',
     String((xml.match(/<trkpt /g)||[]).length));
t.ok(/<trkpt lat="28\.819" lon="-81\.265">/.test(xml), 'the first is where the track starts');
t.ok(/<time>2026-09-23T17:40:00\.000Z<\/time>/.test(xml), 'times are UTC, as GPX wants');
t.ok(/<gpxtpx:course>51\.6<\/gpxtpx:course>/.test(xml),
     'the course is written in degrees, not the radians it is held in');
t.ok(/<\/trkseg><\/trk>\n<\/gpx>\n$/.test(xml.replace(/\n <\/trkseg>/,'</trkseg>')),
     'and it is closed');
const wf=await p.evaluate(x=>{ const d=new DOMParser().parseFromString(x,'application/xml');
  return d.querySelector('parsererror')?'parse error'
    :d.getElementsByTagName('trkpt').length+' pts'; }, xml);
t.ok(wf==='90 pts', 'a parser agrees it is well formed', wf);

/* The name is stamped in the clock the Pi is set to, whatever that is:
   the probe asks the page rather than assuming a timezone. */
const STAMP=await p.evaluate(()=>{ const d=new Date(TRK[0].t), z=n=>String(n).padStart(2,'0');
  return `Confluence-${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`
        +`-${z(d.getHours())}${z(d.getMinutes())}`; });

t.head('with a helper on the boat, GPX sends the file there');
await p.click('#trk-exp'); await p.waitForTimeout(700);
const sent=posts.find(o=>o.path==='/gpx/save');
t.ok(!!sent, 'it went to the helper, not to this browser');
t.ok(sent && sent.body.name===STAMP,
     "named for when the race started, in the boat's own clock", sent&&sent.body.name);
t.ok(sent && sent.body.xml.indexOf('<trkpt')>0, 'with the track in it');
t.ok(await p.evaluate(()=>$('qr-sheet').classList.contains('on')),
     'and the QR code comes up for the phone to shoot');
t.ok((await p.evaluate(()=>$('qr-name').textContent))===STAMP,
     'showing the file just sent');
t.ok((await p.evaluate(()=>$('qr-url').textContent)).endsWith('/gpx/'+STAMP+'.gpx'),
     'at the address the phone can fetch', await p.evaluate(()=>$('qr-url').textContent));
await p.click('#qr-sheet'); await p.waitForTimeout(300);
t.ok(!await p.evaluate(()=>$('qr-sheet').classList.contains('on')),
     'a tap anywhere but the code puts it away');

t.head('a QR code is only ever raised over the map that asked for it');
await p.evaluate(()=>closeApp()); await p.waitForTimeout(500);
t.ok(await p.evaluate(()=>showQR('X','gpx/x.gpx'))===false,
     'with Tracks shut it is refused rather than stranded behind it');
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(600);

t.head('with no helper it is a download instead');
await p.evaluate(()=>{ NET.st.gpx={available:false}; });
const dl=p.waitForEvent('download',{timeout:5000}).catch(()=>null);
await p.click('#trk-exp');
const f=await dl;
t.ok(!!f, 'the browser is handed the file');
t.ok(f && f.suggestedFilename()===STAMP+'.gpx',
     'under the same name', f&&f.suggestedFilename());
t.ok(posts.filter(o=>o.path==='/gpx/save').length===1,
     'and nothing more was sent to the boat');
await p.evaluate(()=>{ NET.st.gpx={available:true}; });

t.head('an empty track has no file in it');
await p.evaluate(()=>{ TRK=[]; VIEWTRK=null; drawMap(shownTrack()); });
await p.waitForTimeout(300);
await p.click('#trk-exp'); await p.waitForTimeout(400);
t.ok(posts.filter(o=>o.path==='/gpx/save').length===1, 'nothing is sent');
t.ok(/no track to send/.test(await p.evaluate(()=>$('trk-n').textContent)),
     'and it says so', await p.evaluate(()=>$('trk-n').textContent));
await p.evaluate(seed); await p.waitForTimeout(300);

t.head('SAVE puts the race in the library on this device');
await p.click('#trk-save'); await p.waitForTimeout(800);
const rows=await p.evaluate(()=>dbAll());
t.ok(rows.length===1, 'one race saved', String(rows.length));
t.ok(rows[0] && rows[0].n===90 && rows[0].pts.length===90, 'with all its fixes');
t.ok(rows[0] && rows[0].nm>0.1 && rows[0].nm<1, 'and the distance it covered',
     rows[0]&&String(rows[0].nm));
t.ok(await p.evaluate(()=>trkSavedMark===trkMark(TRK)),
     'and the track is marked as saved, so the next countdown does not ask again');

t.head('RACES shows both lists, and says which is which');
await p.click('#trk-lib'); await p.waitForTimeout(1200);
const lib=await p.evaluate(()=>({
  heads:[...document.querySelectorAll('#lib-list .lib-head')].map(h=>h.textContent),
  boat:[...document.querySelectorAll('#lib-list .lib-link')]
         .map(r=>({title:r.dataset.title, href:r.dataset.href,
                   sub:r.querySelector('.lib-sub').textContent})),
  here:[...document.querySelectorAll('#lib-list .lib-row[data-id]')]
         .map(r=>r.querySelector('.lib-name').textContent)}));
t.ok(lib.heads.join('|')==='On the boat|Saved here',
     'the boat first, then this device', lib.heads.join('|'));
t.ok(lib.boat.length===2, "both of the boat's files", String(lib.boat.length));
t.ok(lib.boat[0].href==='gpx/Confluence-2026-09-23-1740.gpx',
     'each a link a phone can just tap', lib.boat[0].href);
t.ok(!/\.gpx/.test(lib.boat[0].title), 'named without the extension', lib.boat[0].title);
t.ok(/^40\.2 kB · /.test(lib.boat[0].sub), 'with its size', lib.boat[0].sub);
t.ok(lib.here.length===1, 'and the one saved here', String(lib.here.length));

t.head('on the helm a boat row is a QR code, not a download');
const dl2=p.waitForEvent('download',{timeout:2500}).catch(()=>null);
await p.click('#lib-list .lib-link'); await p.waitForTimeout(500);
t.ok(await p.evaluate(()=>$('qr-sheet').classList.contains('on')), 'the code comes up');
t.ok(await dl2===null, 'and nothing lands in the Pi\'s own downloads');
await p.click('#qr-sheet'); await p.waitForTimeout(300);

t.head('deleting off the boat takes two taps, because it does not come back');
await p.click('#lib-list .bin'); await p.waitForTimeout(300);
t.ok(await p.evaluate(()=>document.querySelector('#lib-list .bin').textContent)==='SURE?',
     'the first arms it and says so');
t.ok(!posts.some(o=>o.path==='/gpx/delete'), 'and asks the helper for nothing yet');
await p.click('#lib-list .bin'); await p.waitForTimeout(700);
const del=posts.find(o=>o.path==='/gpx/delete');
t.ok(!!del && del.body.name==='Confluence-2026-09-23-1740.gpx',
     'the second does it, by name', del&&del.body.name);

t.head('loading a saved race shows it without touching the live track');
await p.click('#lib-list .lib-row[data-id]'); await p.waitForTimeout(800);
t.ok(await p.evaluate(()=>VIEWTRK&&VIEWTRK.length===90), 'the saved one is what is drawn');
t.ok(await p.evaluate(()=>TRK.length===90), 'and the live track is untouched');
t.ok(!await p.evaluate(()=>$('t-lib').classList.contains('on')), 'the library closes behind it');
t.ok(/^2026-09-23 /.test(await p.evaluate(()=>VIEWNAME)),
     'and the race name is remembered - off the glass, because the heading '
     +'that used to show it came off to give the chart the room, and the '
     +'export is the only thing that ever needed it',
     await p.evaluate(()=>VIEWNAME));
t.ok(!await p.evaluate(()=>!!document.getElementById('t-title')),
     'there is no heading left to read it back out of');
await p.click('#trk-clr'); await p.waitForTimeout(500);
t.ok(await p.evaluate(()=>VIEWTRK===null && TRK.length===90),
     'CLEAR on a loaded race just puts it back down again');

t.head('the chart is a sideways circle, and a wider one than the round was');
/* A round 456 threw away the widest part of round glass: at the height of
   the chart the panel is nearly 800 px across. An oval reaches further
   sideways than the rounded oblong this briefly was, because its widest
   point sits on the centre line rather than at a corner. */
const geo=await p.evaluate(()=>{
  const e=document.querySelector('#t-clip ellipse');
  return {ell:e&&{cx:+e.getAttribute('cx'), cy:+e.getAttribute('cy'),
                  rx:+e.getAttribute('rx'), ry:+e.getAttribute('ry')},
          rect:!!document.querySelector('#t-clip rect'),
          circle:!!document.querySelector('#t-clip circle'),
          CX:MAP_CX, CY:MAP_CY, RX:MAP_RX, RY:MAP_RY,
          HW:MAP_HW, HH:MAP_HH, FIT:MAP_FIT};
});
t.ok(!!geo.ell && !geo.rect && !geo.circle,
     'the clip is an ellipse - not a circle, and not the oblong either',
     JSON.stringify(geo));
t.ok(geo.ell.rx===geo.RX && geo.ell.ry===geo.RY && geo.ell.cx===geo.CX
     && geo.ell.cy===geo.CY,
     'and the drawing agrees with the arithmetic', JSON.stringify(geo.ell));
t.ok(geo.ell.rx*2===840 && geo.ell.ry*2===460,
     'it is 840 by 460 - wider than the 776 oblong and 1.84x the round 456',
     JSON.stringify(geo.ell));
t.ok(geo.HW===geo.RX+4 && geo.HH===geo.RY+4,
     'with the tile box 4 px proud of the curve, so there is something '
     +'behind it - as MAP_R 232 stood proud of r 228');
t.ok(geo.ell.cy-geo.ell.ry===120 && geo.ell.cy+geo.ell.ry===580,
     'and it sits higher than the circle did - 120 to 580 against 176 to '
     +'636 - because the race title that stood at y=112 has gone',
     JSON.stringify(geo.ell));

t.head('and it sits inside the glass with an even margin');
/* Taken to its limit the oval reaches 972 across before the curve meets
   the rim - and stops looking like a viewport. The margin is the point. */
const edge=await p.evaluate(()=>{
  const e=document.querySelector('#t-clip ellipse');
  const cx=+e.getAttribute('cx'), cy=+e.getAttribute('cy');
  const rx=+e.getAttribute('rx'), ry=+e.getAttribute('ry');
  let worst=0, near=1e9;
  for(let i=0;i<2000;i++){ const t=2*Math.PI*i/2000;
    const d=Math.hypot(cx+rx*Math.cos(t)-540, cy+ry*Math.sin(t)-540);
    worst=Math.max(worst,d); near=Math.min(near,d); }
  return {worst, near};
});
t.ok(edge.worst<=540, 'no part of it leaves the glass',
     edge.worst.toFixed(1)+' of 540');
t.ok(edge.worst/540<=0.95, 'and it keeps the 95% the rest of the page keeps',
     (100*edge.worst/540).toFixed(1)+'%');
t.ok(edge.worst/540<=0.90,
     'with room to spare, because an oval that nearly touches the rim reads '
     +'as a letterbox rather than a viewport',
     (100*edge.worst/540).toFixed(1)+'%');

const band=await p.evaluate(()=>{
  const sg=document.getElementById('stage').getBoundingClientRect();
  const r=e=>{ const q=document.getElementById(e); if(!q) return null;
    const b=q.getBoundingClientRect();
    return {top:b.top-sg.top, bot:b.bottom-sg.top}; };
  const st=document.querySelector('.t-stats').getBoundingClientRect();
  return {pill:r('app-name'),
          stats:{top:st.top-sg.top, bot:st.bottom-sg.top}};
});
t.ok(band.pill.bot < 120, 'the name pill is clear above it, and it is the '
     +'only thing up there now', JSON.stringify(band.pill));
t.ok(120-band.pill.bot >= 24, 'with room to read as a gap rather than a '
     +'collision', (120-band.pill.bot)+' px');
t.ok(band.stats.top >= 580, 'the stats row is clear below it - the chart ran '
     +'into those numbers once already, which is why there is still more '
     +'room at that end', JSON.stringify(band.stats));

t.head('the zoom is exactly what it was');
/* The ask was a wider view at the SAME zoom, and those pull against each
   other: a fit measured against the new shape would put a track's widest
   reach at 420 px instead of 232 and zoom in on every course. MAP_FIT is
   what stops that, and this is the probe that would catch someone
   "tidying" it into MAP_RX. */
t.ok(geo.FIT===232, 'the fit still measures against the old 232', 'MAP_FIT '+geo.FIT);
t.ok(Math.min(geo.RX,geo.RY) > 232*0.90,
     'and the oval\'s inscribed circle is bigger than the fit, so a fitted '
     +'track can never touch the curve however it is shaped',
     Math.min(geo.RX,geo.RY)+' > '+(232*0.90).toFixed(1));
const fit=await p.evaluate(()=>{
  const P=shownTrack(); if(!P||!P.length) return null;
  const v=fitView(P);
  let x0=1,x1=0,y0=1,y1=0;
  for(const q of P){ const m=merc(q.la,q.lo);
    if(m.x<x0)x0=m.x; if(m.x>x1)x1=m.x;
    if(m.y<y0)y0=m.y; if(m.y>y1)y1=m.y; }
  const mx=(x0+x1)/2, my=(y0+y1)/2;
  let r=1e-6;
  for(const q of P){ const m=merc(q.la,q.lo);
    r=Math.max(r, Math.hypot(m.x-mx, m.y-my)); }
  return {scale:v.scale, want:(232*0.90)/r};
});
t.ok(fit && Math.abs(fit.scale-fit.want)/fit.want < 1e-9,
     'and a real track fits at the scale the round chart gave it',
     fit && (fit.scale.toFixed(1)+' vs '+fit.want.toFixed(1)));

t.head('and the track it draws lands inside the oval');
await p.evaluate(()=>{ MAPVIEW=null; tileKey=''; drawMap(shownTrack()); });
await p.waitForTimeout(600);
const inside=await p.evaluate(()=>{
  const P=shownTrack(), v=MAPVIEW;
  if(!P||!v) return null;
  let worst=0, ox=0;
  for(const q of P){ const m=merc(q.la,q.lo);
    const ex=(projX(v,m)-MAP_CX)/MAP_RX, ey=(projY(v,m)-MAP_CY)/MAP_RY;
    worst=Math.max(worst, Math.hypot(ex,ey));
    ox=Math.max(ox, Math.abs(projX(v,m)-MAP_CX)); }
  return {worst, ox, RX:MAP_RX};
});
t.ok(inside && inside.worst<=1, 'no fix is clipped by the curve',
     JSON.stringify(inside));
t.ok(inside && inside.ox < inside.RX*0.75,
     'and there is real water either side of it now, which is the whole point',
     'widest fix at '+Math.round(100*inside.ox/inside.RX)+'% of the half-width');
t.ok(!await p.evaluate(()=>outOfView(MAPVIEW, shownTrack())),
     'so the view does not immediately ask to be refitted');

await t.done(b);
