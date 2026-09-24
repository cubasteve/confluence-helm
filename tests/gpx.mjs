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

await t.done(b);
