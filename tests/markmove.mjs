/* Correcting a club mark from the boat, and putting the book back. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const OUT=process.env.HELM_SHOTS||'/tmp/';
const b=await pw.chromium.launch({executablePath:process.env.HELM_CHROME||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:1080,height:1080},
  geolocation:{latitude:28.8215,longitude:-81.2740,accuracy:4}, permissions:['geolocation']});
await ctx.grantPermissions(['geolocation'],{origin:new URL(process.env.HELM_URL||'http://localhost:8080/').origin});
const p=await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.route('**/signalk/**',r=>r.abort());
await p.route('http://127.0.0.1:8091/**',r=>r.abort('connectionrefused'));
await p.addInitScript(()=>localStorage.setItem('marks', JSON.stringify(
  [{id:'u1abc', name:'GREEN BUOY', hdr:'GREEN BU', lat:28.8172, lon:-81.2695}])));
await p.goto(process.env.HELM_URL||'http://localhost:8080/confluence_helm.html');
await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle());
await p.evaluate(()=>{ CFG.theme='day'; applyTheme(); phoneSet(true,'test'); });
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
await p.evaluate(()=>openCourse()); await p.waitForTimeout(600);
let pass=0,fail=0; const ok=(c,m,x='')=>{console.log((c?'  PASS  ':'  FAIL  ')+m+(x?'   '+x:''));c?pass++:fail++;};
const row=id=>p.evaluate(i=>{ const r=document.querySelector('.course-row[data-mark="'+i+'"]');
  return { sub:r.querySelector('span').textContent,
           moved:r.querySelector('span').classList.contains('moved'),
           undo:!!r.querySelector('.undo'), del:!!r.querySelector('.del:not(.undo)') }; }, id);
const mark=id=>p.evaluate(i=>{ const m=markOf(i);
  return {lat:m.lat, lon:m.lon, name:m.name, hdr:m.hdr,
          moved:isMoved(i), stored:JSON.parse(localStorage.getItem('markMoves')||'{}')[i]}; }, id);

console.log('\n=== the book, to start with ===');
let v=await mark('cb12');
ok(Math.abs(v.lat-(28+49.284/60))<1e-9, 'CB 12 is where the sheet says', String(v.lat));
ok(!v.moved, 'and nothing has been corrected');
ok((await row('cb12')).undo===false, 'so there is nothing to put back');

console.log('\n=== a club mark opens in EDIT now ===');
await p.click('#course-edit'); await p.waitForTimeout(400);
await p.click('.course-row[data-mark="cb12"] .lib-main'); await p.waitForTimeout(500);
let f=await p.evaluate(()=>({open:$('course-add').style.display!=='none',
  title:$('course-title').textContent, id:MK&&MK.id,
  name:$('mk-name').textContent, lat:$('mk-lat').textContent, lon:$('mk-lon').textContent}));
ok(f.open && f.id==='cb12', 'it opens on the mark you tapped', JSON.stringify(f));
ok(f.title==='Correct mark', 'and calls it a correction, not an edit', f.title);
ok(f.lat==='28 49.284' && f.lon==='-81 16.508', 'prefilled from the book',
   f.lat+' / '+f.lon);
await p.screenshot({path:OUT+'mark-correct.png'});

console.log('\n=== HERE takes it off the GPS ===');
await p.click('#mk-here'); await p.waitForTimeout(400);
f=await p.evaluate(()=>({lat:$('mk-lat').textContent, lon:$('mk-lon').textContent,
                         msg:$('mk-msg').textContent}));
ok(f.lat==='28 49.290' && f.lon==='-81 16.440',
   'the position the boat is actually standing at', f.lat+' / '+f.lon);
ok(f.msg==='', 'no complaint', f.msg);
await p.click('#mk-save'); await p.waitForTimeout(600);

console.log('\n=== and the correction sticks over the book ===');
v=await mark('cb12');
ok(v.moved, 'the mark is marked as corrected');
ok(Math.abs(v.lon-(-(81+16.440/60)))<1e-6, 'and reads the new position', String(v.lon));
ok(v.stored && Math.abs(v.stored.lon-v.lon)<1e-9, 'which is on disk', JSON.stringify(v.stored));
ok(!v.stored.name, 'with no name stored, because you did not change it',
   JSON.stringify(v.stored));
ok(v.name==='CHANNEL BUOY 12', 'so it is still the club\'s name', v.name);
let r=await row('cb12');
ok(/16\.440W/.test(r.sub), 'the row says the new number', r.sub);
ok(r.moved, 'in the accent, so you know it is not the book any more');
ok(r.undo && !r.del, 'and offers the way back rather than a bin',
   JSON.stringify(r));
await p.screenshot({path:OUT+'mark-moved.png'});

console.log('\n=== everything downstream follows it ===');
/* HERE put the mark exactly where the boat is, so the leg to the
   CORRECTED position is ~0 - and the leg to the book's would be the
   110 m the correction moved it. One number tells both. */
const geo=await p.evaluate(()=>{ COURSE.marks=['cb12']; COURSE.next=0; courseSave();
  const g=markGeo();
  const book=seaNm(get('pos.lat'),get('pos.lon'),28+49.284/60,-(81+16.508/60))*1852;
  return {hdr:g.n.hdr, dist:Math.round(g.dist), toBook:Math.round(book)}; });
ok(geo.hdr==='CB 12', 'the leg is to CB 12', JSON.stringify(geo));
ok(geo.toBook>80, 'the book put it a hundred metres from here', geo.toBook+' m');
ok(geo.dist<5, 'and the leg says we are standing on it, so it followed the correction',
   JSON.stringify(geo));

console.log('\n=== a mark of your own is still edited, not overridden ===');
await p.click('.course-row[data-mark="u1abc"] .lib-main'); await p.waitForTimeout(500);
ok((await p.evaluate(()=>$('course-title').textContent))==='Edit mark',
   'and called what it is');
await p.evaluate(()=>{ MK.f='lat'; MK.lat='28 50.000'; mkPaint(); });
await p.click('#mk-save'); await p.waitForTimeout(500);
v=await mark('u1abc');
ok(!v.moved, 'it goes nowhere near markMoves', JSON.stringify(v.moved));
ok(Math.abs(v.lat-(28+50/60))<1e-9, 'it just moves', String(v.lat));
ok((await row('u1abc')).del, 'and keeps its bin');

console.log('\n=== the book is one tap away ===');
await p.click('.course-row[data-mark="cb12"] .undo');
await p.waitForTimeout(2600);                     /* markRevert reloads */
await p.evaluate(()=>bootSettle());
await p.evaluate(()=>{ openApp(APPS.find(a=>a.id==='tracks')); openCourse(); });
await p.waitForTimeout(700);
v=await mark('cb12');
ok(!v.moved, 'the correction is gone');
ok(Math.abs(v.lat-(28+49.284/60))<1e-9 && Math.abs(v.lon-(-(81+16.508/60)))<1e-9,
   'and the sheet\'s number is back', v.lat+', '+v.lon);
ok((await p.evaluate(()=>JSON.parse(localStorage.getItem('markMoves')||'{}')))
     .cb12===undefined, 'off disk too');
ok((await mark('u1abc')).lat>28.83 === false, 'and your own mark is untouched',
   String((await mark('u1abc')).lat));

console.log('\n=== a correction survives a reload ===');
await p.evaluate(()=>{ MARK_MOVES['rum']={lat:28.9,lon:-81.3}; markMovesSave(); });
await p.reload(); await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle());
v=await mark('rum');
ok(v.moved && Math.abs(v.lat-28.9)<1e-9, 'it is applied at boot', JSON.stringify(v.lat));
console.log('\n=== a stored id the file no longer has is kept, not crashed on ===');
await p.evaluate(()=>{ const o=JSON.parse(localStorage.getItem('markMoves'));
  o.retired={lat:28.8,lon:-81.2}; localStorage.setItem('markMoves',JSON.stringify(o)); });
await p.reload(); await p.waitForTimeout(1600); await p.evaluate(()=>bootSettle());
ok(await p.evaluate(()=>isMoved('retired')), 'kept - the club may bring it back');
ok(await p.evaluate(()=>isMoved('rum')), 'and the real one still applies');
await p.evaluate(()=>{ MARK_MOVES={}; markMovesSave(); });

console.log('\n'+(errs.length?'PAGE ERRORS: '+errs.join(' | '):'no page errors'));
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
