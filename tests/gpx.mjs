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
t.ok(/^2026-09-23 /.test(await p.evaluate(()=>$('t-title').textContent)),
     'and the title says which race', await p.evaluate(()=>$('t-title').textContent));
await p.click('#trk-clr'); await p.waitForTimeout(500);
t.ok(await p.evaluate(()=>VIEWTRK===null && TRK.length===90),
     'CLEAR on a loaded race just puts it back down again');

t.head('the chart is an oblong, and a wider one than the circle was');
/* A circle 456 across threw away the widest part of round glass: at the
   height of the chart the panel is nearly 800 px wide. The edges are
   chosen - top and bottom where the circle's were, so no water was given
   up to gain the width. */
const geo=await p.evaluate(()=>{
  const c=document.querySelector('#t-clip rect');
  const r=c&&{x:+c.getAttribute('x'), y:+c.getAttribute('y'),
              w:+c.getAttribute('width'), h:+c.getAttribute('height'),
              rx:+c.getAttribute('rx')};
  return {rect:r, circle:!!document.querySelector('#t-clip circle'),
          CX:MAP_CX, CY:MAP_CY, HW:MAP_HW, HH:MAP_HH, FIT:MAP_FIT};
});
t.ok(!geo.circle && !!geo.rect, 'the clip is a rect, not a circle',
     JSON.stringify(geo));
t.ok(geo.rect.rx>=40, 'with its corners taken off, so it reads as an oblong '
     +'rather than a box dropped on round glass', 'rx '+geo.rect.rx);
t.ok(geo.rect.w===776 && geo.rect.h===460,
     'it is 776 by 460 - 1.70x the width of the 456 circle and 2.19x the area',
     JSON.stringify(geo.rect));
t.ok(geo.rect.y===176 && geo.rect.y+geo.rect.h===636,
     'top and bottom within 4 px of the circle it replaced, so the width is '
     +'a gain rather than a trade', JSON.stringify(geo.rect));

t.head('and it still fits on round glass');
/* The rail and the second stats row sit near 94% of the radius, which the
   file calls a margin rather than a coincidence. The corners of the
   oblong are held to the same. */
const worst=await p.evaluate(()=>{
  const c=document.querySelector('#t-clip rect');
  const x=+c.getAttribute('x'), y=+c.getAttribute('y');
  const w=+c.getAttribute('width'), h=+c.getAttribute('height');
  const rx=+c.getAttribute('rx');
  let d=0;
  for(const ax of [x+rx, x+w-rx]) for(const ay of [y+rx, y+h-rx])
    d=Math.max(d, Math.hypot(ax-540, ay-540)+rx);
  return d;
});
t.ok(worst<=540, 'no corner leaves the glass', worst.toFixed(1)+' of 540');
t.ok(worst/540<=0.95, 'and each is inside the 95% the rest of the page keeps',
     (100*worst/540).toFixed(1)+'%');

const band=await p.evaluate(()=>{
  const r=e=>{ const q=document.getElementById(e); if(!q) return null;
    const b=q.getBoundingClientRect(), s=document.getElementById('stage')
      .getBoundingClientRect();
    return {top:b.top-s.top, bot:b.bottom-s.top}; };
  const st=document.querySelector('.t-stats').getBoundingClientRect();
  const sg=document.getElementById('stage').getBoundingClientRect();
  return {pill:r('app-name'), title:r('t-title'),
          stats:{top:st.top-sg.top, bot:st.bottom-sg.top}};
});
t.ok(band.pill.bot < 176, 'the name pill is clear above it',
     JSON.stringify(band.pill));
t.ok(band.title.bot <= 176, 'and so is the race title, which is the line that '
     +'appears only once a race is loaded', JSON.stringify(band.title));
t.ok(band.stats.top >= 636, 'the stats row is clear below it - the chart ran '
     +'into those numbers once already', JSON.stringify(band.stats));

t.head('the zoom is exactly what it was');
/* The ask was a wider view at the SAME zoom, and those pull against each
   other: a fit measured against the new box would put the track's widest
   reach at 392 px instead of 232 and zoom in on every course. MAP_FIT is
   what stops that, and this is the probe that would catch someone
   "tidying" it to MAP_HW. */
t.ok(geo.FIT===232, 'the fit still measures against the old 232', 'MAP_FIT '+geo.FIT);
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
     'and a real track fits at the scale the circle gave it',
     fit && (fit.scale.toFixed(1)+' vs '+fit.want.toFixed(1)));

t.head('and the track it draws lands inside the oblong');
await p.evaluate(()=>{ MAPVIEW=null; tileKey=''; drawMap(shownTrack()); });
await p.waitForTimeout(600);
const inside=await p.evaluate(()=>{
  const P=shownTrack(), v=MAPVIEW;
  if(!P||!v) return null;
  let ox=0, oy=0;
  for(const q of P){ const m=merc(q.la,q.lo);
    ox=Math.max(ox, Math.abs(projX(v,m)-MAP_CX));
    oy=Math.max(oy, Math.abs(projY(v,m)-MAP_CY)); }
  return {ox, oy, HW:MAP_HW, HH:MAP_HH};
});
t.ok(inside && inside.ox<=inside.HW && inside.oy<=inside.HH,
     'no fix is clipped', JSON.stringify(inside));
t.ok(inside && inside.ox < inside.HW*0.75,
     'and there is real water either side of it now, which is the whole point',
     'widest fix at '+Math.round(100*inside.ox/inside.HW)+'% of the half-width');
t.ok(!await p.evaluate(()=>outOfView(MAPVIEW, shownTrack())),
     'so the view does not immediately ask to be refitted');

await t.done(b);
