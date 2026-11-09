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

/* One minute up the lake at 2 kn, as a file with nothing in it but
   where and when - no extensions, default namespace. */
const BOATGPX='<?xml version="1.0"?>\n'
  +'<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">'
  +'<trk><name>dropped in by hand</name><trkseg>'
  +Array.from({length:61},(_,i)=>
      `<trkpt lat="${(28.8100+i*9e-5).toFixed(6)}" lon="-81.2500">`
      +`<time>2026-09-16T18:02:${String(i%60).padStart(2,'0')}`
      +(i===60?'':'')+'Z</time></trkpt>').slice(0,60).join('')
  +'</trkseg></trk></gpx>';

const {b,p,posts}=await open(t,{
  status:{gpx:{available:true, dir:'/home/pi/avnav/user/gpx'}},
  reply:{'/gpx/save':body=>({ok:true, name:body.name+'.gpx',
                             url:'gpx/'+body.name+'.gpx'}),
         /* Stateful, because the library is re-read after a delete and a
            mock that kept handing the file back would make "it is gone"
            unprovable - and would have hidden the one thing this
            section is for: the row stands for the race, so deleting it
            takes the boat's copy too. */
         '/gpx/delete':body=>{
           const i=INDEX.findIndex(f=>f.name===body.name);
           if(i<0) return {ok:false, error:'no such file'};
           INDEX.splice(i,1); return {ok:true};
         }},
  routes:{[ORIGIN+'/gpx/index.json*']:r=>r.fulfill({status:200,
            contentType:'application/json', body:JSON.stringify(INDEX)}),
          /* The second file is served for real, because a race that is
             only on the boat is now loaded by reading it back - so the
             probe has to have something to read. Deliberately a plain
             GPX with no speed or course in it: that is what a track
             dropped in by hand looks like, and the reader has to work
             them out from the fixes. */
          [ORIGIN+'/gpx/Confluence-2026-09-16-1802.gpx']:r=>r.fulfill({
            status:200, contentType:'application/gpx+xml', body:BOATGPX})}});
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

t.head('the library is ONE list, and says where each race lives');
/* It was two - "On the boat" and "Saved here" - for one reason: the app
   could write GPX and not read it, so the copy on the boat could be
   handed to a phone and never put on the chart. Two sections of
   identically-shaped, identically-dated rows where a tap did opposite
   things, which is exactly how it was reported: "I press a previous race
   and it just pulls up a QR code." readGPX removes the reason, so the
   split goes too. */
await p.click('#trk-lib'); await p.waitForTimeout(1200);
const lib=await p.evaluate(()=>({
  heads:document.querySelectorAll('#lib-list .lib-head').length,
  links:document.querySelectorAll('#lib-list .lib-link').length,
  rows:[...document.querySelectorAll('#lib-list .lib-row')].map(r=>({
    key:r.dataset.key,
    name:r.querySelector('.lib-name').textContent,
    where:r.querySelector('.lib-where').textContent,
    sub:r.querySelector('.lib-sub').textContent,
    share:!!r.querySelector('[data-share]'),
    kill:!!r.querySelector('[data-kill]')})),
  hint:$('lib-hint').textContent}));
t.ok(lib.heads===0 && lib.links===0,
     'no section headings and no link rows left - there is one kind of row',
     lib.heads+' heads / '+lib.links+' links');
t.ok(lib.rows.length===2,
     'the boat\'s two files and this device\'s one race come to two rows, '
     +'because one of the files IS that race', String(lib.rows.length));
t.ok(lib.rows.every(r=>r.share && r.kill),
     'every row shares and deletes the same way');
t.ok(/TAP TO LOAD/.test(lib.hint),
     'and the hint is true of all of them again', lib.hint);

t.head('the two copies of one race are one row');
/* They find each other by the minute the race started: the published
   name carries it - Confluence-2026-09-23-1740 - and so does the record
   saved here, which is keyed off the first fix. */
const both=lib.rows.find(r=>r.where==='HERE+BOAT');
t.ok(!!both, 'the race that is in both places says so once',
     lib.rows.map(r=>r.where).join('|'));
t.ok(both && /^t:/.test(both.key),
     'keyed by its start minute, which is what let the two find each other',
     both&&both.key);
t.ok(both && /NM · /.test(both.sub),
     'and it reads its real figures, from the copy that knows them',
     both&&both.sub);
const boatOnly=lib.rows.find(r=>r.where==='BOAT');
t.ok(!!boatOnly && /^f:/.test(boatOnly.key),
     'a file with no race behind it is its own row, keyed by its name so '
     +'it cannot collide with anything', boatOnly&&boatOnly.key);
t.ok(boatOnly && / kB · /.test(boatOnly.sub),
     'saying what IS known about it - reading every file in the folder to '
     +'fill in a list nobody has opened yet is a scan of the whole folder',
     boatOnly&&boatOnly.sub);

t.head('a race that is only on the boat still loads onto the chart');
/* The whole point. This file was never saved on this device - it is
   read back off the boat through readGPX. */
await p.evaluate(()=>{ VIEWTRK=null; VIEWNAME=''; });
const boatKey=await p.evaluate(()=>
  (LIBRACES.find(r=>!r.here)||{}).key||'');
await p.click(`#lib-list .lib-row[data-key="${boatKey}"]`);
await p.waitForTimeout(1500);
t.ok(await p.evaluate(()=>!!VIEWTRK && VIEWTRK.length>1),
     'it is on the chart', String(await p.evaluate(()=>VIEWTRK&&VIEWTRK.length)));
t.ok(!await p.evaluate(()=>$('qr-sheet').classList.contains('on')),
     'and no QR code came up, which is the bug this was reported as');
t.ok(await p.evaluate(()=>VIEWTRK.every(x=>isFinite(x.la)&&isFinite(x.lo)
                                         &&isFinite(x.t)&&isFinite(x.s)&&isFinite(x.c))),
     'every fix complete - a file with no speed or course in it gets them '
     +'worked out from the fixes themselves');
t.ok(await p.evaluate(()=>TRK.length===90), 'and the live track is untouched');
await p.evaluate(()=>{ unloadRace(); }); await p.waitForTimeout(300);

t.head('the reader is the writer, backwards');
const trip=await p.evaluate(()=>{
  const t0=Date.UTC(2026,8,23,17,40,0), src=[];
  for(let i=0;i<60;i++) src.push({la:28.81+i*1e-4, lo:-81.25+i*5e-5,
    t:t0+i*1000, s:1.5+Math.sin(i/6), c:(i%360)*Math.PI/180});
  const back=readGPX(buildGPX(src));
  const near=(a,b,e)=>Math.abs(a-b)<e;
  return {n:back.length,
          same:back.every((q,i)=>near(q.la,src[i].la,1e-9)
                              && near(q.lo,src[i].lo,1e-9)
                              && q.t===src[i].t
                              && near(q.s,src[i].s,1e-6)),
          nm:+trackStats(back).nm.toFixed(4)===+trackStats(src).nm.toFixed(4),
          secs:trackStats(back).secs===trackStats(src).secs};
});
t.ok(trip.n===60 && trip.same,
     'every fix comes back out of a file the app wrote', JSON.stringify(trip));
t.ok(trip.nm && trip.secs,
     'and the distance and the elapsed are the same numbers afterwards');

t.head('and it reads a file the app did not write');
/* A track dropped into the gpx folder by hand carries a position and a
   time and nothing else. The namespace is the trap: GPX lives in the
   topografix namespace and nobody writes a prefix, so a prefixed
   selector matches nothing at all. */
const alien=await p.evaluate(()=>{
  const f=readGPX(`<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="28.8100" lon="-81.2500"><time>2026-09-23T17:40:00Z</time></trkpt>
<trkpt lat="28.8110" lon="-81.2500"><time>2026-09-23T17:40:30Z</time></trkpt>
<trkpt lat="28.8120" lon="-81.2500"><time>2026-09-23T17:41:00Z</time></trkpt>
</trkseg></trk></gpx>`);
  return {n:f.length, s:f.map(x=>+x.s.toFixed(2)),
          cDeg:f.map(x=>+(x.c*180/Math.PI).toFixed(0)),
          secs:trackStats(f).secs, nm:+trackStats(f).nm.toFixed(3),
          junk:readGPX('not xml at all <<<').length,
          untimed:readGPX('<?xml version="1.0"?><gpx xmlns='
            +'"http://www.topografix.com/GPX/1/1"><trk><trkseg>'
            +'<trkpt lat="28.81" lon="-81.25"/></trkseg></trk></gpx>').length};
});
t.ok(alien.n===3, 'all three fixes, through the default namespace',
     String(alien.n));
t.ok(alien.s.every(v=>v>3.6 && v<3.8),
     'with a speed worked out from the fixes - 111 m in 30 s is 3.7 m/s',
     alien.s.join());
t.ok(alien.cDeg.every(v=>v===0), 'and a course: due north, which is where '
     +'it went', alien.cDeg.join());
t.ok(alien.secs===60 && alien.nm>0.11 && alien.nm<0.13,
     'and it measures the same as anything else', alien.secs+'s '+alien.nm+'nm');
t.ok(alien.junk===0, 'rubbish in is nothing out, not a thrown page',
     String(alien.junk));
t.ok(alien.untimed===0,
     'and a fix with no time is dropped - everything downstream of a track '
     +'here is time-based, so inventing one would put a made-up duration on '
     +'the glass beside real ones', String(alien.untimed));

t.head('deleting takes two taps, for every row now');
/* It used to be two for a file on the boat and ONE for a race saved
   here, which was backwards: the boat's copy can be sent again off the
   panel and this one usually cannot be got back at all. */
await p.click('#trk-lib'); await p.waitForTimeout(1000);
const hereKey=await p.evaluate(()=>
  (LIBRACES.find(r=>r.here&&!r.file)||LIBRACES.find(r=>r.here)||{}).key||'');
await p.click(`#lib-list .lib-row[data-key="${hereKey}"] [data-kill]`);
await p.waitForTimeout(300);
t.ok(await p.evaluate(k=>document.querySelector(
       `#lib-list .lib-row[data-key="${k}"] [data-kill]`).textContent, hereKey)==='SURE?',
     'the first tap arms it and says so, on a race saved here too');
t.ok((await p.evaluate(()=>dbAll())).length===1,
     'and nothing is gone yet', String((await p.evaluate(()=>dbAll())).length));
await p.click(`#lib-list .lib-row[data-key="${hereKey}"] [data-kill]`);
await p.waitForTimeout(900);
t.ok((await p.evaluate(()=>dbAll())).length===0,
     'the second does it', String((await p.evaluate(()=>dbAll())).length));
const killed=posts.find(o=>o.path==='/gpx/delete');
t.ok(!!killed && killed.body.name==='Confluence-2026-09-23-1740.gpx',
     'and because the row stood for the race, the boat\'s copy goes with it '
     +'- which is what HERE+BOAT on the row was telling you',
     killed&&killed.body.name);

t.head('with the races gone the list says so, rather than showing nothing');
await p.waitForTimeout(400);
await p.locator('#stage').screenshot({path:(process.env.HELM_SHOTS||'/tmp/')+'lib-merged.png'});
const left=await p.evaluate(()=>({
  rows:document.querySelectorAll('#lib-list .lib-row').length,
  empty:[...document.querySelectorAll('#lib-list .lib-empty')].map(e=>e.textContent)}));
t.ok(left.rows===1,
     'one row left - the other file, which was never that race',
     String(left.rows));
t.ok(!INDEX.some(f=>f.name==='Confluence-2026-09-23-1740.gpx'),
     'and the boat really has lost its copy, not just the panel',
     INDEX.map(f=>f.name).join());

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
t.ok(geo.ell.rx*2===840 && geo.ell.ry*2===520,
     'it is 840 by 520 - 1.84x the round 456 across and 1.14x down it',
     JSON.stringify(geo.ell));
t.ok(geo.HW===geo.RX+4 && geo.HH===geo.RY+4,
     'with the tile box 4 px proud of the curve, so there is something '
     +'behind it - as MAP_R 232 stood proud of r 228');
t.ok(geo.ell.cy-geo.ell.ry===110 && geo.ell.cy+geo.ell.ry===630,
     'and it runs 110 to 630 against the circle\'s 176 to 632 - higher at '
     +'the top, because the race title that stood at y=112 has gone, and '
     +'deeper at the bottom', JSON.stringify(geo.ell));

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
t.ok(band.pill.bot < 110, 'the name pill is clear above it, and it is the '
     +'only thing up there now', JSON.stringify(band.pill));
t.ok(110-band.pill.bot >= 20, 'with room to read as a gap rather than a '
     +'collision', (110-band.pill.bot)+' px');
t.ok(band.stats.top >= 630, 'the stats row is clear below it - the chart ran '
     +'into those numbers once already', JSON.stringify(band.stats));
t.ok(band.stats.top-630 >= 20, 'by a gap, not by a pixel',
     (band.stats.top-630)+' px');
/* 520 of the 577 px between the pill and the numbers. There is not much
   left to take, which is the point of measuring it rather than eyeballing. */
t.ok((geo.ell.ry*2)/(band.stats.top-band.pill.bot) > 0.88,
     'and it uses most of the band there is between them',
     Math.round(100*(geo.ell.ry*2)/(band.stats.top-band.pill.bot))+'%');

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
