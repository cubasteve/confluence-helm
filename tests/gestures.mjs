/* Getting about the panel: the two drawers, paging, and the radio
   picker that hangs off the control panel. */
import {open, tally, fling, state} from './helpers.mjs';
const t=tally();
const NETS=[
  {ssid:'Confluence',   secure:true, saved:true,  active:true,  signal:99},
  {ssid:'Marina Guest', secure:true, saved:false, active:false, signal:64},
  {ssid:'Steve iPhone', secure:true, saved:true,  active:false, signal:81}];
const {b,p,posts}=await open(t,{demo:true,
  /* A boat with everything wired, which is also the panel that does not
     fit the glass - see the scrolling checks at the foot of this file. */
  status:{wifi:{available:true, devices:[{dev:'wlan0',up:true,ap:true,ssid:'Confluence'}]},
          bt:{available:true,powered:true}, power:{available:true},
          buzzer:{available:true, mode:'audio',
                  device:'plughw:CARD=Headphones,DEV=0', pinned:false,
                  outs:[{dev:'plughw:CARD=Headphones,DEV=0',name:'3.5 MM JACK'},
                        {dev:'pulse',name:'PIPEWIRE / PULSE'}]}},
  reply:{'/wifi/list':{ok:true, up:true, ap:true, nets:NETS}}});

t.head('the drawers');
let s=await state(p);
t.ok(!s.panel&&!s.dock&&s.page===1, 'the dial, with nothing over it', JSON.stringify(s));
await fling(p,1,0,-260);
t.ok((await state(p)).dock, 'one finger UP pulls the app dock off the bottom');
await fling(p,1,0,240);
t.ok((await state(p)).dock, 'a DOWN flick out on the dial leaves it - not its glass');
await fling(p,1,0,240,480,980);
t.ok(!(await state(p)).dock, 'one on the dock itself sends it back');
await fling(p,1,0,260);
t.ok((await state(p)).panel, 'one finger DOWN pulls the control panel off the top');
await fling(p,1,0,-260);
t.ok(!(await state(p)).panel, 'and UP puts it away');

t.head('the control panel comes down over a running app');
/* The panel is brightness, the sounder, the radios and the theme. None
   of those is a thing you should have to leave the radar to reach. */
const app=()=>p.evaluate(()=>({app:!!APP.on,
  up:$('app-run').classList.contains('on'),
  panel:panel.classList.contains('open')}));
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(900);
t.ok((await app()).up, 'the tracks app is running');
await fling(p,1,0,200,480,70);                 /* from the very top */
let A=await app();
t.ok(A.panel, 'a pull from the very top brings the panel down over it');
t.ok(A.up, 'and the app is still there underneath', JSON.stringify(A));
await fling(p,1,0,-260);
A=await app();
t.ok(!A.panel && A.up, 'up puts the panel away and leaves the app', JSON.stringify(A));
await fling(p,1,0,240,480,600);                /* low down: the app's */
A=await app();
t.ok(!A.panel, 'a down flick below the top band is not the panel\'s');
t.ok(A.up, 'and it does NOT close the app - a flick that shuts the page '
     +'you are reading is the wrong control for the job. The cross at the '
     +'foot closes an app, and only the cross', JSON.stringify(A));
/* the radar's chart fills the glass and claims every touch on it, so
   the top band has to be released by the canvas itself */
await p.evaluate(()=>{ closeApp(); });
await p.waitForTimeout(400);
const rad=await p.evaluate(()=>!!APPS.find(a=>a.id==='radar'));
if(rad){
  await p.evaluate(()=>openApp(APPS.find(a=>a.id==='radar')));
  await p.waitForTimeout(1400);
  const box=await p.evaluate(()=>{ const r=$('stage').getBoundingClientRect();
    return {x:r.x,y:r.y}; });
  await p.mouse.move(box.x+540, box.y+70); await p.mouse.down();
  for(let i=1;i<=6;i++) await p.mouse.move(box.x+540, box.y+70+200*i/6);
  await p.mouse.up(); await p.waitForTimeout(700);
  A=await app();
  t.ok(A.panel, 'the radar chart lets the top band go, so the pull works there too',
       JSON.stringify(A));
  t.ok(A.up, 'and the chart is still up behind it');
  await fling(p,1,0,-260); await p.waitForTimeout(300);
}
await p.evaluate(()=>{ closeApp(); }); await p.waitForTimeout(500);
t.ok(!(await app()).up, 'and closeApp is what actually shuts one');

t.head('paging wants three fingers');
await fling(p,1,-260,0);
t.ok((await state(p)).page===1, 'one finger sideways does not page');
await fling(p,3,-260,0);
t.ok((await state(p)).page===2, 'three reach the music page');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'and come back');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'stopping there rather than wrapping');

t.head('four apps, one head');
/* They opened with three sizes at three heights - 23, 28 and 44 px at
   y111, y112 and y118 - which reads as four apps built by four people.
   One block, one format; only the ink differs, because two of them sit
   on a photograph and two on the panel. */
const head=async id=>{
  if(await p.evaluate(()=>!!APP.on)){ await p.evaluate(()=>closeApp()); await p.waitForTimeout(400); }
  await p.evaluate(i=>openApp(APPS.find(a=>a.id===i)), id);
  await p.waitForTimeout(1100);
  return p.evaluate(()=>{
    const m=e=>{ const s=getComputedStyle(e), r=e.getBoundingClientRect();
      return {y:Math.round(r.top), fs:s.fontSize, w:s.fontWeight, ls:s.letterSpacing}; };
    const h1=document.querySelector('#app-run .a-h1'),
          h2=document.querySelector('#app-run .a-h2'),
          pill=$('app-name');
    return {h1:h1&&m(h1), h2:h2&&m(h2), t1:h1&&h1.textContent.trim(),
            t2:h2&&h2.textContent.trim(), pill:pill.textContent,
            pillY:Math.round(pill.getBoundingClientRect().top),
            /* painted, not merely present: #tmap carries z-index:1 from
               when it was a page, and that used to bury the pill */
            over:getComputedStyle(pill).zIndex};
  });
};
const H={};
for(const id of ['radar','course','tracks','golden']) H[id]=await head(id);
const ids=Object.keys(H);
t.ok(ids.every(k=>H[k].h1 && H[k].h2),
     'every one of the four opens with a line and a line under it',
     ids.map(k=>k+':'+(H[k].t1||'—')).join(' · '));
t.ok(new Set(ids.map(k=>H[k].h1.y)).size===1,
     'all four headlines on the same pixel',
     ids.map(k=>k+' '+H[k].h1.y).join(' · '));
t.ok(new Set(ids.map(k=>H[k].h2.y)).size===1,
     'and all four sublines on the same one under it',
     ids.map(k=>k+' '+H[k].h2.y).join(' · '));
t.ok(new Set(ids.map(k=>H[k].h1.fs+H[k].h1.w+H[k].h1.ls)).size===1,
     'one size, one weight, one tracking',
     ids.map(k=>k+' '+H[k].h1.fs+'/'+H[k].h1.ls).join(' · '));
t.ok(new Set(ids.map(k=>H[k].h2.fs+H[k].h2.w+H[k].h2.ls)).size===1,
     'the sublines too', ids.map(k=>k+' '+H[k].h2.fs).join(' · '));
t.ok(H.tracks.t1==='Tracks' && /ESRI/.test(H.tracks.t2),
     'the map says TRACKS, not RACE TRACK, over the credit Esri asks for',
     H.tracks.t1+' / '+H.tracks.t2);
t.ok(/NM|NO COURSE/i.test(H.course.t1) && /MARK|LINE/i.test(H.course.t2),
     'the course says how far round it is and what makes it',
     H.course.t1+' / '+H.course.t2);
t.ok(new Set(ids.map(k=>H[k].pillY)).size===1 &&
     ids.every(k=>H[k].over==='3'),
     'and the name pill is on the same line in all four, painted over '
     +'whatever the app put in the body rather than under the map',
     ids.map(k=>k+' '+H[k].pillY+'/'+H[k].over).join(' · '));
await p.evaluate(()=>closeApp()); await p.waitForTimeout(400);

t.head('the radios');
await fling(p,1,0,260);
const tiles=await p.$$eval('#conn-sec .cbtn', n=>n.map(e=>e.dataset.k));
t.ok(tiles.includes('wifi')&&tiles.includes('bt')&&tiles.includes('power'),
     "the helper's three tiles", JSON.stringify(tiles));
await p.click('#conn-sec .cbtn[data-k="wifi"]'); await p.waitForTimeout(1000);
t.ok((await state(p)).sheet, 'the wifi tile opens the picker');
const rows=await p.$$eval('.ns-row .ns-name', n=>n.map(e=>e.textContent));
t.ok(rows.join()==='Confluence,Marina Guest,Steve iPhone', 'all three', JSON.stringify(rows));
const subs=await p.$$eval('.ns-row .ns-sub', n=>n.map(e=>e.textContent));
t.ok(/^HOTSPOT/.test(subs[0]), 'the running hotspot says so', subs[0]);
t.ok(subs[1]==='SECURED · 64%', 'an unsaved secured one', subs[1]);
t.ok(subs[2]==='SAVED · SECURED · 81%', 'a saved one', subs[2]);
const forgets=await p.$$eval('.ns-row [data-forget]',
  n=>n.map(e=>e.closest('.ns-row').querySelector('.ns-name').textContent));
t.ok(forgets.join()==='Steve iPhone',
     'a forget only on what it remembers, never on the hotspot it is running',
     JSON.stringify(forgets));

t.head('the picker is a pop-out over the panel, not a page in front of it');
/* It was an opaque sheet filling the glass, so picking a network hid
   the panel you were picking it from for the ten seconds a scan takes. */
const card=()=>p.evaluate(()=>{
  const s=$('stage').getBoundingClientRect(),
        c=$('ns-list-view').getBoundingClientRect(), l=$('ns-list');
  return {w:Math.round(c.width), h:Math.round(c.height),
          scrim:getComputedStyle($('netsheet')).backgroundColor,
          panelSeen:getComputedStyle($('p-sheet')).display!=='none',
          rows:l.querySelectorAll('.ns-row').length,
          scrolls:l.scrollHeight>l.clientHeight,
          fade:l.classList.contains('over'),
          count:$('ns-count').textContent,
          arrows:!!document.getElementById('ns-up')}; });
let K=await card();
t.ok(K.w<=700 && K.h<1080, 'a card, not the whole glass', K.w+'x'+K.h);
t.ok(/rgba\(0, 0, 0/.test(K.scrim), 'on a scrim that dims what is behind, '
     +'so nothing back there looks tappable while it is up', K.scrim);
t.ok(K.panelSeen, 'and the panel it came from is still there underneath');
t.ok(!K.arrows, 'the up and down arrows are gone - two controls a card '
     +'this size cannot spare');
t.ok(K.rows===3, 'every network is rendered rather than a page of them',
     String(K.rows));
t.ok(/3 NETWORKS/.test(K.count), 'and the count says how many there are, '
     +'which is what 2 / 3 never told you', K.count);
/* a list long enough to need it scrolls, and says so at its edge */
await p.evaluate(()=>{ NET.rows=[...Array(9).keys()].map(i=>({ssid:'N'+i,
  secure:true, saved:false, active:false, signal:80-i*5})); renderRows(); });
await p.waitForTimeout(300);
K=await card();
t.ok(K.rows===9 && K.scrolls, 'nine of them and the box scrolls',
     K.rows+' rows, scrolls '+K.scrolls);
t.ok(K.fade, 'with its edge faded rather than cut');
/* The drum used to come with the scroll wiring, and this box has no
   perspective of its own - so a rotateX on it was not a cylinder, it
   was a vertical squash. Two clean lines of type went short and grey
   the moment you touched them, which is a change reading as damage. */
await p.evaluate(()=>{ const l=$('ns-list'); l.scrollTop=160;
  l.dispatchEvent(new Event('scroll')); });
await p.waitForTimeout(400);
t.ok(await p.evaluate(()=>[...document.querySelectorAll('#ns-list .ns-row')]
       .every(r=>!r.style.transform && !r.style.opacity)),
     'and the rows are the same size and weight scrolled as they are at '
     +'rest - the drum belongs to the two boxes drawn for it',
     await p.evaluate(()=>{ const r=document.querySelector('#ns-list .ns-row');
       return (r.style.transform||'none')+' / '+(r.style.opacity||'1'); }));
await p.evaluate(()=>{ const l=$('ns-list'); l.scrollTop=0;
  l.dispatchEvent(new Event('scroll')); });
t.ok(await p.evaluate(()=>{ const l=$('ns-list');
       return getComputedStyle(l).scrollbarWidth==='none'; }),
     'and no scrollbar of the browser\'s own, the same as every other '
     +'list here');
/* the scrim is the way out, as it is on the start time pad */
await p.evaluate(()=>{ const s=$('stage').getBoundingClientRect();
  $('netsheet').dispatchEvent(new MouseEvent('click',
    {bubbles:true, clientX:s.x+40, clientY:s.y+540})); });
await p.waitForTimeout(400);
t.ok(!await p.evaluate(()=>$('netsheet').classList.contains('on')),
     'a tap on the scrim puts it away');
await p.evaluate(()=>openNet('wifi','wlan0')); await p.waitForTimeout(800);

t.head('joining takes two taps');
posts.length=0;
await p.click('.ns-row[data-i="2"]'); await p.waitForTimeout(250);
t.ok(/TAP AGAIN/.test(await p.textContent('#ns-msg')),
     'the first warns this drops the hotspot', await p.textContent('#ns-msg'));
t.ok(!posts.length, 'and asks the helper nothing', JSON.stringify(posts));
await p.click('.ns-row[data-i="2"]'); await p.waitForTimeout(900);
const join=posts.find(x=>x.path==='/wifi/connect');
t.ok(join&&join.body.ssid==='Steve iPhone', 'the second joins it', JSON.stringify(posts));
t.ok(!(await p.$eval('#ns-pw-view', e=>e.style.display!=='none')),
     'a saved profile carries its own key, so no keyboard');

t.head('an unsaved one wants the keyboard');
await p.click('.ns-row[data-i="1"]'); await p.waitForTimeout(250);
await p.click('.ns-row[data-i="1"]'); await p.waitForTimeout(500);
t.ok(await p.$eval('#ns-pw-view', e=>e.style.display!=='none'), 'it is up');
t.ok((await p.textContent('#pw-for')).includes('Marina Guest'), 'and says which network');
posts.length=0;
await p.click('.kk[data-a="go"]'); await p.waitForTimeout(400);
t.ok(/8/.test(await p.textContent('#pw-msg')),
     'an empty key is refused here, not at the Pi', await p.textContent('#pw-msg'));
t.ok(!posts.length, 'so the helper is never asked', JSON.stringify(posts));
await p.click('.kk[data-a="sym"]'); await p.waitForTimeout(250);
t.ok((await p.$$eval('.kk[data-c]', n=>n.map(e=>e.dataset.c))).includes('@'),
     'the symbol layer has symbols on it');
await p.click('#pw-cancel'); await p.waitForTimeout(400);
t.ok(!(await p.$eval('#ns-pw-view', e=>e.style.display!=='none')), 'cancel puts it away');

t.head('and out again');
await p.click('#ns-done'); await p.waitForTimeout(500);
s=await state(p);
t.ok(!s.sheet && s.panel, 'DONE closes the picker, not the panel', JSON.stringify(s));
await fling(p,1,0,-260);
t.ok(!(await state(p)).panel, 'and the dial is back');

t.head('a slow pair says so on the row it is happening to');
/* netd allows a pair 35 seconds and the connect after it 30. All of
   that used to pass with the row still reading AVAILABLE and the only
   sign of life a line under the SCAN and DONE buttons - nowhere near
   the finger that started it. */
let release=null;
await p.evaluate(()=>{ closeNet(); }); await p.waitForTimeout(300);
await p.route('http://127.0.0.1:8091/bt/list', r=>r.fulfill({status:200,
  contentType:'application/json', body:JSON.stringify({ok:true, powered:true,
  devices:[{mac:'AA:BB:CC:DD:EE:01', name:'JBL Flip 6', paired:false, connected:false},
           {mac:'AA:BB:CC:DD:EE:02', name:'Cockpit Bar', paired:true, connected:false}]})}));
await p.route('http://127.0.0.1:8091/bt/connect', r=>{ release=r; });
await p.evaluate(()=>openNet('bt')); await p.waitForTimeout(1000);
const btRows=()=>p.evaluate(()=>[...document.querySelectorAll('#ns-list .ns-row')]
  .map(r=>({name:r.querySelector('.ns-name').textContent,
            sub:r.querySelector('.ns-sub').textContent,
            work:r.classList.contains('working'),
            bin:!!r.querySelector('[data-forget]')})));
let R=await btRows();
t.ok(R[0].sub==='AVAILABLE' && R[1].sub==='PAIRED',
     'a device says where it stands before you touch it',
     R.map(x=>x.sub).join(' | '));
await p.evaluate(()=>document.querySelectorAll('#ns-list .ns-row')[0].click());
await p.waitForTimeout(700);
R=await btRows();
t.ok(/^PAIRING/.test(R[0].sub) && R[0].work,
     'and AVAILABLE becomes PAIRING the moment it is tapped', R[0].sub);
t.ok(await p.evaluate(()=>$('ns-msg').textContent)==='',
     'with nothing repeating it under the buttons',
     await p.evaluate(()=>$('ns-msg').textContent));
t.ok(R[1].sub==='PAIRED' && !R[1].work, 'and the rest of the list left alone');
/* Sampled across a whole cycle rather than at two points: the dots
   turn over every three ticks, and two samples a cycle apart are the
   same two dots. */
const seen=new Set();
for(let i=0;i<8;i++){ seen.add((await btRows())[0].sub);
                      await p.waitForTimeout(200); }
t.ok(seen.size>=3, 'the line moves, because one that never does reads as a hang',
     [...seen].join(' '));
await p.waitForTimeout(5400);
t.ok(/^CONNECTING/.test((await btRows())[0].sub),
     'and a pair is followed by a connect, which is what netd is doing',
     (await btRows())[0].sub);
t.ok(!(await btRows())[0].bin, 'the unpair bin is out of reach while it works');
if(release) release.fulfill({status:200, contentType:'application/json',
  body:JSON.stringify({ok:false, error:'CONNECT FAILED'})});
await p.waitForTimeout(1200);
R=await btRows();
t.ok(!R[0].work && R[0].sub==='AVAILABLE',
     'when it is over the row goes back to what it is', R[0].sub);
t.ok(/FAILED/.test(await p.evaluate(()=>$('ns-msg').textContent)),
     'and the line under the buttons is left for what went wrong',
     await p.evaluate(()=>$('ns-msg').textContent));
await p.unroute('http://127.0.0.1:8091/bt/connect');
await p.unroute('http://127.0.0.1:8091/bt/list');
await p.evaluate(()=>closeNet()); await p.waitForTimeout(400);

t.head('the two that end the day are a slide, not a tap');
/* A tap is one event, and a round panel takes plenty it was never
   offered - a sleeve on the rim, a wave, a knuckle on the way past. The
   tiles used to open a confirm screen whose CONFIRM sat a thumb's width
   from the tile you had just hit, and on the other side of it is every
   instrument aboard going dark. There is no second screen now: a tile
   arms, and DONE becomes the bar that does it. */
await p.evaluate(()=>{ openPanel(); openNet('power'); }); await p.waitForTimeout(900);
const acts=await p.$$eval('.pw-tile b', n=>n.map(e=>e.textContent));
t.ok(acts.join()==='Reload,Helper,Reboot,Shut down',
     'the helper\'s actions, the two heavy ones last', JSON.stringify(acts));
const pw=()=>p.evaluate(()=>{
  const c=$('ns-list-view').getBoundingClientRect(), bar=$('ns-slide');
  return {foot:getComputedStyle($('ns-foot')).display!=='none',
          bar:getComputedStyle(bar).display!=='none',
          word:$('sl-word').textContent,
          line:getComputedStyle($('ns-msg')).display!=='none',
          msg:$('ns-msg').textContent, red:bar.classList.contains('danger'),
          armed:[...document.querySelectorAll('.pw-tile.armed b')].map(e=>e.textContent),
          knob:Math.round($('sl-knob').getBoundingClientRect().left
                          -bar.getBoundingClientRect().left),
          foot_y:Math.round($('ns-foot').getBoundingClientRect().top),
          bar_y:Math.round(bar.getBoundingClientRect().top),
          out:[[c.left,c.top],[c.right,c.top],[c.left,c.bottom],[c.right,c.bottom]]
            .filter(([x,y])=>Math.hypot(x-540,y-540)>534).length}; });
const tap=name=>p.evaluate(n=>{ [...document.querySelectorAll('.pw-tile')]
  .find(e=>e.textContent.trim().startsWith(n)).click(); }, name);
/* Dispatched on the bar, because that is what a thumb lands on. The
   moves go to the window: a finger that leaves an 86 px bar mid-drag is
   the normal case, not an abort. */
const slide=(frac,drop)=>p.evaluate(([f,drop])=>{
  const bar=$('ns-slide'), k=$('sl-knob').getBoundingClientRect();
  const span=bar.clientWidth-$('sl-knob').offsetWidth-10;
  const x0=k.left+k.width/2, y=k.top+k.height/2;
  const ev=(ty,x,el)=>(el||bar).dispatchEvent(new PointerEvent(ty,
    {pointerId:9, clientX:x, clientY:y, bubbles:true, pointerType:'touch'}));
  ev('pointerdown',x0);
  for(let i=1;i<=10;i++) ev('pointermove', x0+span*f*i/10, window);
  if(drop!==false) ev('pointerup', x0+span*f, window);
}, [frac,drop]);
let P=await pw();
const idleFoot=P.foot_y;
t.ok(P.foot && !P.bar, 'with nothing armed the foot is DONE, which is how you '
     +'leave without touching anything', JSON.stringify(P));
posts.length=0;
await tap('Shut down'); await p.waitForTimeout(400);
P=await pw();
t.ok(!posts.length, 'a tap on the tile asks the helper nothing', JSON.stringify(posts));
t.ok(P.armed.join()==='Shut down', 'it arms the tile instead', JSON.stringify(P.armed));
t.ok(P.bar && !P.foot, 'and DONE is replaced by the bar, in the same place',
     'bar at '+P.bar_y+', DONE was at '+idleFoot);
t.ok(Math.abs(P.bar_y-idleFoot)<160, 'which is the foot of the sheet, not a '
     +'new screen on top of it', P.bar_y+' vs '+idleFoot);
t.ok(P.word==='SLIDE TO SHUT DOWN', 'the bar says what it would do', P.word);
t.ok(!(await p.$('#ns-say')),
     'and nothing above it explains the tile you just touched - a tile '
     +'called Shut down does not need a paragraph under it');
t.ok(P.red, 'in the alarm red the tile is drawn in');
t.ok(!P.line, 'and there is no line under the bar at all - four tiles and '
     +'a bar that names what it does are the whole sheet');
t.ok(P.out===0, 'and the sheet is inside the glass at every corner, armed '
     +'or not - arming changes nothing about its size');
/* a tap on the bar is a drag of nothing */
await slide(0); await p.waitForTimeout(300);
t.ok(!posts.length, 'a tap on the bar shuts down nothing', JSON.stringify(posts));
/* Travel is measured from where the finger lands, so a grab at the far
   end could only be finished by dragging off the edge of the glass. */
await p.evaluate(()=>{ const bar=$('ns-slide'), r=bar.getBoundingClientRect();
  const y=r.top+r.height/2, x=r.right-30;
  const ev=(t,el)=>(el||bar).dispatchEvent(new PointerEvent(t,
    {pointerId:8, clientX:t==='pointerdown'?x:x+600, clientY:y,
     bubbles:true, pointerType:'touch'}));
  ev('pointerdown'); ev('pointermove',window); ev('pointerup',window); });
await p.waitForTimeout(300);
t.ok(!posts.length && (await pw()).knob<=7,
     'and the far end of it is not a handle - a drag begun there would '
     +'have to finish off the edge of the glass', JSON.stringify(posts));
await slide(0.5); await p.waitForTimeout(400);
P=await pw();
t.ok(!posts.length, 'nor does half a slide', JSON.stringify(posts));
t.ok(P.knob<=7, 'which springs back, so letting go early is how you change '
     +'your mind with your hand already on it', P.knob+' px along');
/* the clock behind the sheet repaints it every six seconds */
await slide(0.6,false); await p.waitForTimeout(200);
const held=(await pw()).knob;
await p.evaluate(()=>renderRows()); await p.waitForTimeout(150);
t.ok((await pw()).knob===held, 'a repaint mid-drag does not snatch the knob '
     +'back from under the thumb', held+' -> '+(await pw()).knob);
await p.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',
  {pointerId:9, clientX:0, clientY:0, bubbles:true, pointerType:'touch'})));
await p.waitForTimeout(300);
t.ok(!posts.length, 'and letting go there is still not a shutdown',
     JSON.stringify(posts));
await tap('Shut down'); await p.waitForTimeout(400);
P=await pw();
t.ok(!P.armed.length && P.foot && !P.bar,
     'the same tile again disarms it and DONE comes back', JSON.stringify(P));
await tap('Shut down'); await p.waitForTimeout(300);
await slide(1); await p.waitForTimeout(700);
const down=posts.find(x=>x.path==='/power/do');
t.ok(down && down.body.action==='poweroff', 'carrying it the whole way is '
     +'what shuts the Pi down', JSON.stringify(posts));
t.ok((await pw()).knob>400 && !(await pw()).line,
     'and nothing is said about it - the screen going black is the report',
     JSON.stringify(await pw()));

t.head('a slide the helper refuses comes back');
/* Nothing on this sheet reports, so a bar left at the far end with the
   panel still up is the one state here that reads as a hang. */
await p.route('http://127.0.0.1:8091/power/do', r=>r.fulfill({status:200,
  contentType:'application/json',
  body:JSON.stringify({ok:false, error:'NOT PERMITTED FROM HERE'})}));
await p.evaluate(()=>{ NET.busy=''; armSet(null); }); await p.waitForTimeout(200);
await tap('Reboot'); await p.waitForTimeout(300);
await slide(1); await p.waitForTimeout(800);
P=await pw();
t.ok(P.knob<=7, 'the bar springs home rather than sitting at the end',
     P.knob+' px along');
t.ok(P.armed.join()==='Reboot', 'with the tile still armed, so the same '
     +'slide is there to try again', JSON.stringify(P.armed));
await p.unroute('http://127.0.0.1:8091/power/do');

t.head('the same bar, without the red, for the ones you can undo');
await p.evaluate(()=>{ NET.busy=''; armSet(null); }); await p.waitForTimeout(200);
await tap('Helper'); await p.waitForTimeout(400);
P=await pw();
t.ok(P.bar && !P.red, 'restarting netd is not an alarm', JSON.stringify(P));
t.ok(P.word==='SLIDE TO RESTART THE HELPER', 'and the bar names that one',
     P.word);
t.ok(P.knob<=7, 'starting at its own end, not wherever the last one left it',
     P.knob+' px along');
posts.length=0;
await slide(1); await p.waitForTimeout(600);
t.ok(posts.some(x=>x.path==='/power/do'&&x.body.action==='helper'),
     'and it restarts the helper', JSON.stringify(posts));
await p.waitForTimeout(1600);
P=await pw();
t.ok(!P.armed.length && P.foot, 'then disarms itself, because the sheet you '
     +'are left looking at should be the one you can leave', JSON.stringify(P));

t.head('and the widest of them still fits the glass');
/* Desktop only exists in cage mode, and it is the tile that makes the
   safe tier three across - the widest this sheet ever gets. */
await p.evaluate(()=>{ NET.st.power.desktop=true; renderRows(); });
await p.waitForTimeout(300);
await tap('Desktop'); await p.waitForTimeout(400);
P=await pw();
t.ok(P.armed.join()==='Desktop' && P.out===0,
     'three tiles across, armed, and no corner out in the black',
     JSON.stringify(P.armed));
await p.evaluate(()=>{ armSet(null); NET.st.power.desktop=false; renderRows(); });
await p.evaluate(()=>closeNet()); await p.waitForTimeout(400);

t.head('the sounder says where it comes out, and can be pointed elsewhere');
/* aplay only addresses ALSA, so a Bluetooth speaker is reached through
   whatever sits in front of it - which is why this is a list and not a
   jack-or-nothing.
   Painted and read in ONE turn: the /status poll owns this row and
   repaints it from the stub a few times a second, so anything set by
   hand and asked about later is a race with it. */
await p.evaluate(()=>openPanel()); await p.waitForTimeout(400);
const who=st=>p.evaluate(st=>{ paintSounder(st);
  return {txt:$('snd-who').textContent, pick:$('snd-who').classList.contains('pick'),
          off:$('snd-who').disabled}; }, st);
const OUT2=[{dev:'plughw:CARD=Headphones,DEV=0',name:'3.5 MM JACK'},
            {dev:'pulse',name:'PIPEWIRE / PULSE'}];
let W=await who({available:true, mode:'audio', pinned:false, outs:OUT2,
                 device:'plughw:CARD=Headphones,DEV=0'});
t.ok(/3\.5 MM JACK/.test(W.txt), 'it says where in words, not in an ALSA name', W.txt);
t.ok(/TAP/.test(W.txt) && W.pick, 'and offers the others', W.txt);
posts.length=0;
await p.evaluate(()=>$('snd-who').click()); await p.waitForTimeout(700);
t.ok(posts.some(o=>o.path==='/buzz/out' && o.body.dev==='pulse'),
     'a tap asks netd for the next one',
     JSON.stringify(posts.filter(o=>o.path==='/buzz/out').map(o=>o.body)));

t.head('and offers nothing when there is nothing to offer');
W=await who({available:true, mode:'audio', device:'pulse', pinned:true, outs:OUT2});
t.ok(/PINNED/.test(W.txt) && W.off,
     'a HELM_AUDIO_DEV in the environment is shown and not tappable', W.txt);
W=await who({available:true, mode:'audio', pinned:false,
             device:'plughw:CARD=Headphones,DEV=0', outs:[OUT2[0]]});
t.ok(!/TAP/.test(W.txt) && W.off, 'and one output is not a choice', W.txt);
W=await who({available:true, mode:'gpio', gpio:17});
t.ok(W.txt==='GPIO 17' && W.off, 'a wire on a pin has no output to pick', W.txt);

t.head('the horn and the glass share one box');
/* They were two cards, two headings and two thirds of a row of the
   panel spent on saying 'sound' twice. */
const snd=st=>p.evaluate(st=>{ paintSounder(st);
  return {card:!!$('snd-slab').offsetHeight,
          slab:$('snd-slab').querySelector('.slab').textContent,
          labels:[...$('snd-slab').querySelectorAll('.sndlbl')]
                   .filter(k=>k.offsetHeight).map(k=>k.textContent).join(),
          horn:getComputedStyle($('snd-row')).display!=='none',
          who:getComputedStyle($('snd-who')).display!=='none',
          voice:!!$('clk-voice').offsetHeight}; }, st);
let N=await snd({available:true, mode:'audio', pinned:false, outs:OUT2,
                 device:'pulse'});
t.ok(N.slab==='Sound', 'one box, named for what it is about', N.slab);
t.ok(N.labels==='Horn,Touch', 'with the two noises named down the left, '
     +'because two headings inside one box is the two boxes back again',
     N.labels);
t.ok(N.horn && N.who && N.voice, 'all of it on a boat with a sounder',
     JSON.stringify(N));
N=await snd({available:false});
t.ok(N.card && N.voice, 'and on a boat with none the box stays and the '
     +'touch sound with it - it comes out of whatever is playing the page, '
     +'so it works where there is no helper to ask', JSON.stringify(N));
t.ok(!N.horn && !N.who, 'while the horn and its output go, rather than '
     +'standing there meaning nothing');
t.ok(N.labels==='Touch', 'leaving one label, which is now the only thing '
     +'saying which noise it is', N.labels);
await p.evaluate(()=>paintSounder({available:true, mode:'audio', pinned:false,
  outs:[{dev:'pulse',name:'PIPEWIRE / PULSE'}], device:'pulse'}));

t.head('the panel fits the glass');
/* It stopped fitting once it was a single 600 px column of sections -
   600 px wide on a circle of radius 540 is only lit between y=91 and
   y=989, and the sheet had passed 1140. Two cards across is the fix;
   the scrolling below is what catches it if it ever grows again. */
await p.evaluate(()=>openPanel()); await p.waitForTimeout(700);
const sh=()=>p.evaluate(()=>{ const e=$('p-sheet'), r=e.getBoundingClientRect();
  /* every corner of every card, against the circle */
  const out=[];
  e.querySelectorAll('.card,.senrow,.conn').forEach(k=>{
    const q=k.getBoundingClientRect(); if(!q.height) return;
    [[q.left,q.top],[q.right,q.top],[q.left,q.bottom],[q.right,q.bottom]]
      .forEach(([x,y])=>{ if(Math.hypot(x-540,y-540)>534) out.push(k.className); }); });
  return {over:e.classList.contains('over'), top:Math.round(e.scrollTop),
          room:e.scrollHeight-e.clientHeight, h:Math.round(r.height),
          cards:[...e.querySelectorAll('.card')].filter(k=>k.offsetHeight).length,
          outside:[...new Set(out)]}; });
let S=await sh();
/* and the merged one is the same size as the others, which is the only
   reason it is not out past the rim: it sits in the lower left where
   the glass is running out, and at 256 tall its bottom corner was three
   pixels off it. */
t.ok(await p.evaluate(()=>{
       const h=[...$('p-sheet').querySelectorAll('.card')].filter(k=>k.offsetHeight)
         .map(k=>Math.round(k.getBoundingClientRect().height));
       return Math.max(...h)-Math.min(...h) <= 4; }),
     'every card the same height, the sound box included',
     await p.evaluate(()=>[...$('p-sheet').querySelectorAll('.card')]
       .filter(k=>k.offsetHeight)
       .map(k=>Math.round(k.getBoundingClientRect().height)).join()));
t.ok(S.cards===3, 'three cards - display, the shallow alarm, and sound, '
     +'which is the horn and the glass in one box. The start is not among '
     +'them: it moved to the course sheet with the rest of the start',
     String(S.cards));
t.ok(S.room===0, 'and all of it inside the glass at once', S.h+' px tall');
t.ok(!S.over, 'so nothing is faded off an edge');
t.ok(S.outside.length===0, 'and no card corner is out in the black',
     S.outside.join(' '));
/* A row of two reads as one row only if it IS one row. */
const row=await p.evaluate(()=>{
  const h=[...document.querySelectorAll('#p-sheet .card')]
    .filter(k=>k.offsetHeight).map(k=>Math.round(k.getBoundingClientRect().height));
  const mid=el=>{ const q=el.getBoundingClientRect(); return Math.round(q.top+q.height/2); };
  const card=$('dim').closest('.card').getBoundingClientRect();
  const tr=$('dim').getBoundingClientRect();
  return {h, slider:mid($('dim')), stepper:mid($('d-down')),
          thumbClear:Math.round(card.bottom-(tr.top+tr.height/2+38))}; });
/* Cards two at a time: a row of two is one height. An odd last card
   has no pair and is simply its own. */
const pairs=row.h.reduce((a,_,i)=>i%2?a.concat([row.h.slice(i-1,i+1)]):a,[]);
t.ok(pairs.every(([a,b])=>a===b), 'a row of two is one height, not two',
     JSON.stringify(row.h));
t.ok(Math.abs(row.slider-row.stepper)<=1,
     'the brightness slider sits on the depth steppers\' line',
     row.slider+' vs '+row.stepper);
t.ok(row.thumbClear>0,
     'and its thumb, which stands 31 px proud of a 14 px track, clears the border',
     row.thumbClear+' px');

t.head('and scrolls if it ever stops fitting');
/* The backstop. Forced here rather than waited for: the layout above
   is what stops it happening, and the day a section is added is not
   the day to find out this was never wired. */
await p.evaluate(()=>{ $('p-sheet').style.maxHeight='520px'; sheetFit(); });
await p.waitForTimeout(300);
const pull=(y0,y1)=>p.evaluate(([y0,y1])=>{ const el=$('p-sheet');
  const ev=(t,y)=>el.dispatchEvent(new PointerEvent(t,{pointerId:1,clientX:540,
    clientY:y,bubbles:true,pointerType:'touch'}));
  ev('pointerdown',y0);
  const st=y1>y0?40:-40;
  for(let y=y0; y1>y0?y<=y1:y>=y1; y+=st) ev('pointermove',y);
  ev('pointermove',y1); ev('pointerup',y1); },[y0,y1]);
S=await sh();
t.ok(S.room>0 && S.over, 'it knows, and fades its edges rather than cutting off',
     S.room+' px over');
await pull(660,380); await p.waitForTimeout(400);
S=await sh();
t.ok(S.top>100, 'a drag up scrolls it', S.top+' px down');
t.ok((await state(p)).panel, 'and does NOT close the panel under the finger');
/* Until it runs out, not a fixed count: one drag past the end is the
   drag that gets handed back, and that one closes the panel. */
for(let i=0;i<8;i++){ const q=await sh();
  if(q.room-q.top<2) break;
  await pull(660,380); await p.waitForTimeout(250); }
S=await sh();
t.ok(S.room-S.top<2, 'repeated drags take it to the end', S.top+' of '+S.room);
t.ok((await state(p)).panel, 'and not one of them closes the panel');
await pull(660,380); await p.waitForTimeout(700);
t.ok(!(await state(p)).panel,
     'and at the end the drag is handed back, so the same swipe closes it');
await p.evaluate(()=>{ $('p-sheet').style.maxHeight=''; sheetFit(); });

await t.done(b);
