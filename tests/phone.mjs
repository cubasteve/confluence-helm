/* The phone, as a phone sees it.

   This is the half the owner actually touches - the panel's remote half
   is tests/remote.mjs and netd's is tests/remote_test.py, and between
   them they covered everything except the page a person looks at. The
   page builds its face as SVG strings in JS, so the only honest way to
   check it is to open it in a browser and tap.

   What it is now: a small picture of the glass, with every complication
   where the glass puts it, and a card that drops from the face's feet
   when you tap one. It replaced eight rows - which was the owner's
   complaint, and is why most of the assertions here are about WHERE
   things are rather than what they say. */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
import {tally} from './helpers.mjs';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const t=tally();
const tmp=mkdtempSync(join(tmpdir(),'helm-phone-'));

/* The catalogue the PANEL would register, taken from the panel rather
   than written out here - a copy in this file would drift the first
   time a reading was added, which is the whole reason netd keeps none
   of its own. */
const b0=await pw.chromium.launch();
const p0=await b0.newPage({viewport:{width:1080,height:1080}});
await p0.goto('http://localhost:8080/confluence_helm.html');
await p0.waitForTimeout(1400);
/* The panel picks its own palette off the clock, so a catalogue taken
   in the evening carries the dusk one and one taken at noon the day
   one. Pinned here, because the assertion further down is that the
   mirror wears whatever the panel sent - which can only be checked
   against a known answer. */
await p0.evaluate(()=>{ CFG.theme='day'; applyTheme(); });
const cat=await p0.evaluate(()=>remoteCat());
/* Where the GLASS actually draws its hull number, in panel units.
   Not 672: that is the y, and dominant-baseline:middle centres on the
   x-height while a digit sits above it, so the ink lands well north of
   it. The number that matters is not the one in the markup, it is
   where the thing ends up - and the only way to know is to measure the
   panel and then measure the mirror. */
const glassMark=await p0.evaluate(()=>{
  const e=document.getElementById('mark'), st=document.getElementById('stage');
  const r=e.getBoundingClientRect(), s=st.getBoundingClientRect();
  const k=1080/s.width;
  return {mid:((r.top+r.bottom)/2-s.top)*k, h:r.height*k};
});
await b0.close();
/* One name and one tag doctored. Everything this page draws arrived
   over a network from a panel that is trusted - and the page builds its
   markup as strings, so the day that trust is misplaced is the day
   nobody remembers that. */
cat.names['dial:c3']='<b id="pwned">RIGHT</b>';
cat.tags.vmg='<i id="pwned2">V</i>';
const catFile=join(tmp,'cat.json');
writeFileSync(catFile, JSON.stringify(cat));

const rig=spawn('python3',['-I','tests/phone_rig.py',catFile,tmp]);
const port=await new Promise((res,rej)=>{
  let buf=''; const die=setTimeout(()=>rej(new Error('rig never spoke: '+buf)),20000);
  rig.stdout.on('data',d=>{ buf+=d; const m=buf.match(/(\d+)/);
    if(m){ clearTimeout(die); res(m[1]); } });
  rig.stderr.on('data',d=>{ buf+=d; });
});
const base='http://127.0.0.1:'+port;
const peek=async()=>(await (await fetch(base+'/peek')).json());

const b=await pw.chromium.launch();
const ctx=await b.newContext({viewport:{width:390,height:844},
                              deviceScaleFactor:2, hasTouch:true});
const p=await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
const open=async(q='?t=T0KEN')=>{ await p.goto(base+'/r'+q);
                                  await p.waitForTimeout(500); };

/* Every zone on the face as the browser has laid it out: which slot, the
   tag's rendered centre, and the lane that takes the tap. */
const cells=()=>p.$$eval('#main .fv g.z',gs=>gs.map(g=>{
  /* A tag too long for its lane is broken onto two lines, so a zone
     holds one text element or two - WIND SPEED / · AUTO. Read as one
     word again here, and measured over the pair, because what the
     assertions below are about is where the TAG sits and the pair
     straddles the anchor the single line would have sat on. */
  const ts=[...g.querySelectorAll('text')];
  const bs=ts.map(t=>t.getBoundingClientRect());
  const L=Math.min(...bs.map(r=>r.left)), R=Math.max(...bs.map(r=>r.right));
  const T=Math.min(...bs.map(r=>r.top)), B=Math.max(...bs.map(r=>r.bottom));
  const r=g.querySelector('rect').getBoundingClientRect();
  return {p:g.dataset.p, s:g.dataset.s,
          tag:ts.map(t=>t.textContent).join(' '), lines:ts.length,
          cx:(L+R)/2, cy:(T+B)/2,
          lane:{x:r.left, y:r.top, w:r.width, h:r.height},
          on:g.classList.contains('on')};
}));
const faceBox=()=>p.$eval('#main .fv',e=>{
  const r=e.getBoundingClientRect();
  return {x:r.left, y:r.top, w:r.width, h:r.height, b:r.bottom};
});
const cellOf=async s=>(await cells()).find(c=>c.s===s);
/* The header fades under the dim with the rest of the page, so the way
   to the other sheet is out of this one first. */
const sheet=async id=>{
  if(await p.isVisible('#sheet.on')){
    await p.click('[data-shx]'); await p.waitForTimeout(350);
  }
  await p.click(id); await p.waitForTimeout(400);
};

await open();

t.head('a zone per complication, and the catalogue says how many');
let cs=await cells();
t.ok(cs.length===cat.slots.dial.length,
     'the dial shows its five', String(cs.length));
await p.click('[data-f="mus"]'); await p.waitForTimeout(350);
t.ok((await cells()).length===cat.slots.mus.length,
     'and the music page its three', String((await cells()).length));
await p.click('[data-f="dial"]'); await p.waitForTimeout(350);

t.head('the picture says WHERE each one is, which a list never did');
/* The old probe asserted the first row said the word APEX. That tests
   that the phone can spell, not that it knows where the apex is - and
   it passed whatever the geometry said. */
await p.click('[data-f="mus"]'); await p.waitForTimeout(350);
const fm=await faceBox(), m=await cells();
const ap=m.find(c=>c.s==='a'), po=m.find(c=>c.s==='p'), st=m.find(c=>c.s==='s');
t.ok(Math.abs(ap.cx-(fm.x+fm.w/2))<2,
     'the apex is on the face\'s centre line', String(Math.round(ap.cx-(fm.x+fm.w/2))));
t.ok(ap.cy<po.cy && ap.cy<st.cy, 'and above both flanks');
t.ok(po.cx<ap.cx && ap.cx<st.cx, 'port to the left of starboard, as on the glass');
await p.click('[data-f="dial"]'); await p.waitForTimeout(350);
cs=await cells();
const c1=cs.find(c=>c.s==='c1'), c2=cs.find(c=>c.s==='c2'), c3=cs.find(c=>c.s==='c3');
t.ok(c1.cx<c2.cx && c2.cx<c3.cx, 'the three cells run left to right');
t.ok(cs.find(c=>c.s==='c0').cy < c1.cy, 'the big number sits above them');

t.head('and each tag is drawn on the glass\'s anchor, not in the middle of its box');
/* c0's rect runs 270..890 and centres at 580; #spd is at 540. Centring
   in the box puts the word thirteen pixels off the line the strip and
   the middle cell are hung from - and ONLY c0 shows it, because for the
   others the anchor is the box centre. */
const f=await faceBox(), k=f.w/1080;
for(const sl of ['c0','c1','c2','c3','c4']){
  const c=cs.find(x=>x.s===sl), a=cat.geom.dial.a[sl];
  t.ok(Math.abs(c.cx-(f.x+a[0]*k))<1.5,
       sl+' is drawn on x='+a[0], String(Math.round(c.cx-(f.x+a[0]*k))));
}

t.head('the lanes tile, and no lane claims another slot\'s anchor');
const lanes=cs.map(c=>({s:c.s, ...c.lane}));
for(const sl of ['c0','c1','c2','c3','c4']){
  const a=cat.geom.dial.a[sl], ax=f.x+a[0]*k, ay=f.y+a[1]*k;
  const own=lanes.filter(L=>ax>=L.x-0.5 && ax<=L.x+L.w+0.5 &&
                            ay>=L.y-0.5 && ay<=L.y+L.h+0.5);
  t.ok(own.length===1 && own[0].s===sl,
       sl+'\'s anchor is inside its own lane and no other',
       own.map(x=>x.s).join(','));
}
let overlap=0;
for(let i=0;i<lanes.length;i++) for(let j=i+1;j<lanes.length;j++){
  const A=lanes[i], B=lanes[j];
  if(A.x<B.x+B.w-0.5 && B.x<A.x+A.w-0.5 &&
     A.y<B.y+B.h-0.5 && B.y<A.y+A.h-0.5) overlap++;
}
t.ok(overlap===0, 'and no two lanes overlap', String(overlap));
/* The strip is 60 units - twenty pixels on a 362px face - and nothing
   about care or aim finds it. It takes what it needs from the big
   number, which has it to give. */
t.ok(cs.find(c=>c.s==='c4').lane.h>=28,
     'the strip\'s lane is grown to something a thumb can hit',
     String(Math.round(cs.find(c=>c.s==='c4').lane.h)));

t.head('it says what it is, and says it once');
const top=await p.$eval('.top',e=>({
  txt:e.textContent.trim(),
  rule:getComputedStyle(e).borderBottomWidth,
  bottom:e.getBoundingClientRect().bottom}));
t.ok(top.txt==='CONFLUENCE HELM', 'the name is the boat and the thing',
     top.txt);
t.ok(!/45/.test(top.txt), 'and the hull number is not in it twice - it is '
     +'already on the face behind everything', top.txt);
t.ok(parseFloat(top.rule)>=2,
     'with a rule under it, which is what the number used to do '
     +'structurally', top.rule);
/* And the switch sits under the rule rather than on it. */
const pg=await p.$eval('.pg',e=>e.getBoundingClientRect().top);
t.ok(pg>=top.bottom-1, 'and nothing crowds it', Math.round(pg)+' vs '
     +Math.round(top.bottom));

t.head('the start clock came over, and it runs on the phone');
/* The one reading that crosses, and it crosses because it is not
   really a reading: it is a control you are holding, wanted exactly
   when you are on the rail with both hands full. */
const clock=()=>p.$eval('#main .fv .tm',e=>e.textContent);
const btns=()=>p.$$eval('#main .fv .tb',gs=>gs.map(g=>({
  by:+g.dataset.by, off:g.classList.contains('off'),
  grab:+g.querySelector('.grab').getAttribute('r'),
  r:+g.querySelector('circle').getAttribute('r')})));
t.ok((await clock())==='5:00', 'it shows what the glass shows', await clock());
const B0=await btns();
t.ok(B0.length===2 && B0.map(x=>x.by).sort((a,b)=>a-b).join()==='-60,60',
     'with a button each way, a minute at a time',
     JSON.stringify(B0.map(x=>x.by)));
t.ok(B0.every(x=>x.grab>x.r),
     'each taking a bigger tap than it draws - 46 units is thirty-one '
     +'pixels here, which is drawn right and impossible to hit',
     JSON.stringify(B0.map(x=>[x.r,x.grab])));

t.head('a nudge moves the clock before the boat has answered');
await p.click('#main .fv .tb[data-by="60"]'); await p.waitForTimeout(350);
t.ok((await clock())==='6:00', 'the phone shows it at once - a clock that '
     +'waits a second and a half to admit a press is a clock you press '
     +'twice', await clock());
t.ok(JSON.stringify((await peek()).pend['timer'])===
     JSON.stringify({kind:'timer', by:60}), 'and the boat is told',
     JSON.stringify((await peek()).pend['timer']));
/* Three taps before the panel polls are three minutes. Latest-wins
   would quietly drop two of them, which is the one place in this app
   where that is the wrong rule. */
await p.click('#main .fv .tb[data-by="60"]'); await p.waitForTimeout(250);
await p.click('#main .fv .tb[data-by="60"]'); await p.waitForTimeout(250);
t.ok((await peek()).pend['timer'].by===180, 'and taps add up rather than '
     +'replacing each other', String((await peek()).pend['timer'].by));
t.ok((await clock())==='8:00', 'with the face agreeing', await clock());
await p.click('#main .fv .tb[data-by="-60"]'); await p.waitForTimeout(250);
t.ok((await peek()).pend['timer'].by===120 && (await clock())==='7:00',
     'and the other way takes it back off again',
     (await peek()).pend['timer'].by+' / '+(await clock()));

t.head('and it counts down between polls rather than stepping');
/* A poll arrives every second and a half. A clock that only moved then
   would read a second and a half wrong most of the time, so the phone
   is given the remaining milliseconds and runs its own. */
await p.evaluate(()=>{ TM={ms:65000, st:'countdown', at:performance.now()};
                       draw(); tmRun(); });
await p.waitForTimeout(150);
const tk1=await clock();
await p.waitForTimeout(1300);
const tk2=await clock();
t.ok(tk1!==tk2, 'it moves with no poll at all', tk1+' -> '+tk2);
t.ok(/^1:0[0-5]$/.test(tk2), 'and by about the time that passed', tk2);
t.ok(await p.$eval('#main .fv .tm',e=>!e.classList.contains('idle')),
     'and stops being the grey it is while nothing is running');

t.head('once the gun has gone the buttons go with it');
/* The glass dims them at the same moment: a nudge to a race that has
   started is not a nudge, it is a different race. */
await p.evaluate(()=>{ TM={ms:12000, st:'racing', at:performance.now()};
                       draw(); tmRun(); });
await p.waitForTimeout(200);
t.ok((await btns()).every(x=>x.off), 'both are out');
const wasQ2=JSON.stringify((await peek()).pend['timer']);
await p.evaluate(()=>{ const g=document.querySelector('.fv .tb');
                       g && g.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await p.waitForTimeout(250);
t.ok(JSON.stringify((await peek()).pend['timer'])===wasQ2,
     'and a press on one sends nothing');
const r1=await clock();
await p.waitForTimeout(900);
t.ok(r1!==(await clock()), 'while a race clock counts UP rather than down',
     r1+' -> '+(await clock()));
await p.evaluate(()=>{ TM={ms:300000, st:'idle', at:performance.now()};
                       draw(); tmRun(); });
await p.waitForTimeout(200);

t.head('the tab turns the glass as well as the phone');
/* A phone showing the music page while the panel shows the dial is a
   mirror of something nobody is looking at. */
await p.click('[data-f="mus"]'); await p.waitForTimeout(350);
t.ok(JSON.stringify((await peek()).pend['page'])===
     JSON.stringify({kind:'page', page:'mus'}), 'the boat is told which page',
     JSON.stringify((await peek()).pend['page']));
t.ok((await cells()).length===cat.slots.mus.length,
     'and the phone switched too, without waiting to be told back');
/* Nothing on the music page has a clock on it, because nothing on the
   music page has one on the glass. */
t.ok((await p.$$('#main .fv .tm')).length===0,
     'the music page carries no clock, because the glass has none there');
await p.click('[data-f="dial"]'); await p.waitForTimeout(350);
t.ok((await peek()).pend['page'].page==='dial', 'and back again',
     JSON.stringify((await peek()).pend['page']));

t.head('the clock takes the glass\'s own three gestures');
/* The owner asked for these by describing the glass: press to start,
   double to stop, hold to reset. What crosses is the GESTURE and never
   the transition - the phone's idea of the state is up to four seconds
   old, and from a stale one it would sometimes ask for the wrong
   thing. */
const zb=await p.$eval('.tmz',e=>{const r=e.getBoundingClientRect();
  return {x:r.left,y:r.top,w:r.width,h:r.height};});
/* Pressed near the TOP of the zone, not in the middle of it. The
   middle is the digits, which hit-test on their own - a probe that
   pressed there passed with no grab at all. The ink of 5:00 is about
   two thirds of the zone's height and none of its corners, and a thumb
   does not land on ink. */
const tx=await p.$eval('.fv .tm',e=>{const r=e.getBoundingClientRect();
  return {y:r.top, h:r.height};});
t.ok(zb.h > tx.h+8, 'the zone is taller than the ink standing in it',
     Math.round(zb.h)+' vs '+Math.round(tx.h));
const mid={x:zb.x+zb.w/2, y:zb.y+5};
const press=async(ms)=>{ await p.mouse.move(mid.x,mid.y); await p.mouse.down();
  await p.waitForTimeout(ms||40); await p.mouse.up(); };
const seq=async()=>((await peek()).pend.clock||{}).seq;
/* Bounded by the two buttons' own tap circles. A finger reaching for +
   that lands a little low must nudge a minute, not reset the race. */
const gy=cat.geom.dial, kz=(await faceBox()).w/1080;
t.ok(zb.w>40 && zb.h>40, 'it is a target you can hit without looking',
     Math.round(zb.w)+'x'+Math.round(zb.h));
t.ok(zb.x >= (await faceBox()).x + (gy.btn.up[0]+68)*kz - 1 &&
     zb.x+zb.w <= (await faceBox()).x + (gy.btn.dn[0]-68)*kz + 1,
     'and it stops short of both buttons, so + is never a reset',
     Math.round(zb.x)+'..'+Math.round(zb.x+zb.w));

await press(); await p.waitForTimeout(420);
t.ok(JSON.stringify(await seq())===JSON.stringify(['tap']),
     'one press is a tap', JSON.stringify(await seq()));
/* Checked here, with one gesture in flight and nothing else. The mark
   is cleared by the answer landing, which is the point of it - so a
   later check would be racing the reply it is waiting for. */
t.ok(await p.$eval('.fv .tm',e=>e.classList.contains('wait')),
     'and the clock says it is waiting rather than guessing what it did');
/* The single action waits out one double-tap window, so the first half
   of a double never fires it - the glass waits the same 320 ms. */
await press(); await p.waitForTimeout(90); await press();
await p.waitForTimeout(420);
t.ok(JSON.stringify(await seq())===JSON.stringify(['tap','double']),
     'two quick ones are a double and NOT two taps',
     JSON.stringify(await seq()));
await press(900); await p.waitForTimeout(350);
t.ok(JSON.stringify(await seq())===JSON.stringify(['tap','double','hold']),
     'and a long press is a hold', JSON.stringify(await seq()));
/* Letting go after the hold has already gone must not also be a tap.
   On the glass that would reset the race and then start a countdown. */
t.ok((await seq()).length===3, 'with no tap trailing it',
     JSON.stringify(await seq()));
/* Four is more than a finger makes inside one poll of the panel's. */
for(let i=0;i<3;i++){ await press(); await p.waitForTimeout(420); }
t.ok((await seq()).length===4, 'and the queue is capped',
     JSON.stringify(await seq()));

t.head('and the two buttons are still a nudge, not a gesture');
/* They sit inside the clock's own third of the face. Before the grab
   was bounded, a press on + was a press on the numerals too.
   A delta rather than a figure: the queue is drained by the panel and
   there is no panel here, so the total is whatever the sections above
   left in it. */
const wasBy=((await peek()).pend['timer']||{}).by||0;
await p.click('#main .fv .tb[data-by="60"]'); await p.waitForTimeout(400);
t.ok(((await peek()).pend['timer']||{}).by === wasBy+60,
     'the + nudges a minute',
     wasBy+' -> '+((await peek()).pend['timer']||{}).by);
t.ok((await seq()).length===4, 'and asks the clock for nothing',
     JSON.stringify(await seq()));
/* Every gesture asks again just past the panel's next poll. Let the
   last of those land before the sections below, or it arrives in the
   middle of one and snaps the page back to the one the glass is on -
   which is the app working, in the wrong place. */
await p.waitForTimeout(2000);

t.head('and the clock\'s zone does not reach into anybody\'s lane');
/* It runs down to exactly where the lanes begin, and the lanes begin
   where it ends - one number, read from the same place. A zone that
   grew past it would take taps meant for the big number's picker and
   turn them into a gesture on the race clock, which is the worst
   direction for that mistake to go. */
for(const c of await cells()){
  const L=c.lane;
  const over = !(zb.x+zb.w<=L.x+1 || L.x+L.w<=zb.x+1 ||
                 zb.y+zb.h<=L.y+1 || L.y+L.h<=zb.y+1);
  t.ok(!over, 'the clock\'s zone is clear of '+c.s+"'s lane",
       JSON.stringify([Math.round(zb.y+zb.h), Math.round(L.y)]));
}

t.head('and no lane sits on top of the two buttons');
/* The whole tap circle, not its centre. The buttons sit just ABOVE the
   top of the big number's box, so a probe that checked the middle
   passed with no guard at all - and a finger does not land in the
   middle. What the owner actually does is press the lower half of the +
   and open the picker instead, which is the half that overlaps. */
const tfb=await faceBox(), kb=tfb.w/1080;
const grab=await p.$eval('#main .fv .tb .grab',e=>+e.getAttribute('r'));
for(const btk of [['up','+'],['dn','minus']]){
  const bb=cat.geom.dial.btn[btk[0]];
  const bx=tfb.x+bb[0]*kb, by=tfb.y+bb[1]*kb, br=grab*kb;
  for(const c of await cells()){
    const L=c.lane;
    /* The nearest point of the lane to the button's centre, against the
       tap radius: a circle overlapping a rectangle. */
    const dx=Math.max(L.x-bx, 0, bx-(L.x+L.w));
    const dy=Math.max(L.y-by, 0, by-(L.y+L.h));
    t.ok(Math.hypot(dx,dy)>=br-1,
         'nothing you can press on the '+btk[1]+' is in '+c.s+"'s lane",
         Math.round(Math.hypot(dx,dy))+' of '+Math.round(br));
  }
}

t.head('the app does not draw under the status bar');
/* black-translucent makes a saved app extend behind the clock, and on
   a phone with a notch the first line of it is simply gone - the
   owner's words were "the top gets cut off". default keeps the bar
   opaque and starts the page below it. */
/* Read off the element, not out of the page text: the first version of
   this grepped the source and tripped over the comment explaining why
   the value is not the one it was grepping for. */
const bar=await p.getAttribute(
  'meta[name="apple-mobile-web-app-status-bar-style"]','content');
t.ok(bar==='default', 'the status bar is left to the system', String(bar));
const topPad=await p.evaluate(()=>getComputedStyle(document.body).paddingTop);
t.ok(parseFloat(topPad)>=10,
     'and the page keeps its own margin above the name even where the '
     +'browser reports no inset at all', topPad);

t.head('nothing claims the album art, and nothing runs off its lane');
await p.click('[data-f="mus"]'); await p.waitForTimeout(350);
const art=cat.geom.mus.art;
const fm2=await faceBox(), k2=fm2.w/1080;
const box=r=>({x:fm2.x+r[0]*k2, y:fm2.y+r[1]*k2, w:r[2]*k2, h:r[3]*k2});
const A=box(art);
/* The two flanks grow toward each other across a page with nothing
   between them, so each took half the gap and both ran through the
   middle of the square: a tap on the artwork set the port or starboard
   reading depending on which side of centre it landed on. */
for(const c of await cells()){
  const L=c.lane;
  const over = L.x < A.x+A.w-1 && A.x < L.x+L.w-1 &&
               L.y < A.y+A.h-1 && A.y < L.y+L.h-1;
  t.ok(!over, c.s+"'s lane stops at the artwork",
       JSON.stringify([Math.round(L.x),Math.round(L.x+L.w)])
       +' vs art '+JSON.stringify([Math.round(A.x),Math.round(A.x+A.w)]));
}

t.head('a tag too long for its lane goes onto two lines');
/* WIND SPEED · AUTO in a cell the glass only ever prints four
   characters into. Shrinking alone ran out of room; shrinking
   everything to fit the worst one would have cost the short tags. */
await p.evaluate(()=>{ S.now.slots['mus:p']='ws'; draw(); });
await p.waitForTimeout(250);
const long=(await cells()).find(c=>c.s==='p');
t.ok(long.lines===2, 'it is two lines', String(long.lines));
t.ok(long.tag==='WIND SPEED · AUTO', 'and still the whole name', long.tag);
const wide=await p.$$eval('#main .fv g.z[data-s="p"] text',
  es=>Math.max(...es.map(e=>e.getBoundingClientRect().width)));
t.ok(wide <= long.lane.w+1, 'and inside its lane',
     Math.round(wide)+' in '+Math.round(long.lane.w));
/* And one that FITS is left on one line, even though it is two words
   - a single-word tag could not tell "wraps when it must" from "wraps
   whenever it sees a space". MARK RANGE in the big number's lane has
   room to spare. */
await p.click('[data-f="dial"]'); await p.waitForTimeout(300);
await p.evaluate(()=>{ S.now.slots['dial:c0']='mkd'; draw(); });
await p.waitForTimeout(250);
const roomy=(await cells()).find(c=>c.s==='c0');
t.ok(roomy.tag==='MARK RANGE' && roomy.lines===1,
     'while two words that fit stay on one line',
     roomy.tag+' / '+roomy.lines);
await p.evaluate(()=>{ S.now.slots['dial:c0']='sog'; draw(); });
await p.click('[data-f="mus"]'); await p.waitForTimeout(300);
await p.evaluate(()=>{ S.now.slots['mus:p']='aws'; draw(); });
await p.click('[data-f="dial"]'); await p.waitForTimeout(350);

t.head('the hull number sits where the glass puts it');
/* The glass sets dominant-baseline:middle on every text it draws, so
   its y=672 is a MIDDLE. Taken as a baseline here it rode most of a
   line high - which on a numeral 1320 units tall is not a nudge. */
const mk=await p.$eval('#main .fv .mk',e=>{
  const r=e.getBoundingClientRect(); return {mid:(r.top+r.bottom)/2}; });
const f3=await faceBox();
const mine=(mk.mid-f3.y)/(f3.w/1080);
/* A generous tolerance on purpose: the glass sets this in Poppins and
   the phone has no Poppins to set it in, so the two fonts put the ink
   of a 1320-unit numeral in slightly different places. Forty units is
   three percent of the face - close enough to be the same picture,
   tight enough to catch a baseline read as a middle, which was most of
   a line out. */
t.ok(Math.abs(mine-glassMark.mid) < 40,
     'the mirror puts it where the panel does',
     Math.round(mine)+' vs the glass at '+Math.round(glassMark.mid));

t.head('the lanes are bounded by the rules you can see');
/* The big number's own rect runs 270 to 890 and centres on 580, not
   540 - the face's middle, where its anchor and both rules are. On the
   glass that rect is a transparent tap target and nobody ever sees it;
   here the lane is DRAWN when its card is open, and the forty units
   showed up as a block sitting right of everything above and below. */
await p.click('[data-f="dial"]'); await p.waitForTimeout(300);
const span=cat.geom.dial.cut.filter(c=>c[1]===c[3]);
const lo=Math.min(...span.map(c=>c[0])), hi=Math.max(...span.map(c=>c[2]));
const fd=await faceBox(), kd=fd.w/1080;
for(const c of await cells()){
  const x0=(c.lane.x-fd.x)/kd, x1=x0+c.lane.w/kd;
  t.ok(x0>=lo-1 && x1<=hi+1, c.s+"'s lane stays inside the rules",
       Math.round(x0)+'..'+Math.round(x1)+' in '+lo+'..'+hi);
}
for(const sl of ['c0','c4']){
  const c=(await cells()).find(x=>x.s===sl);
  const mid=(c.lane.x+c.lane.w/2-fd.x)/kd;
  t.ok(Math.abs(mid-540)<1.5, sl+' is centred on the face, not on its own rect',
       String(Math.round(mid)));
  t.ok(Math.abs((c.lane.x-fd.x)/kd-lo)<1.5 &&
       Math.abs((c.lane.x+c.lane.w-fd.x)/kd-hi)<1.5,
       '...and spans the whole ruled width, being alone on its row');
}

t.head('a new icon is a new address');
/* The picture is served with a week of max-age, which is right for
   something that never changes and exactly wrong if the address stays
   the same when it does - the new icon then sits behind the old one on
   the phone until the cache lets go. */
const href=await p.getAttribute('link[rel=apple-touch-icon]','href');
t.ok(/^\/r\/icon\.png\?v=[0-9a-f]{8}$/.test(href),
     'the icon is asked for by a stamp of its own bytes', href);
const man=await (await fetch(base+'/r/manifest.webmanifest?t=T0KEN')).json();
t.ok(man.icons[0].src===href,
     'and the manifest asks for exactly the same one', man.icons[0].src);

t.head('tapping a zone drops a card that never covers the face');
await p.click('g.z[data-s="c0"]'); await p.waitForTimeout(400);
t.ok(await p.isVisible('#list'), 'the card is up');
const lb=await p.$eval('#list',e=>e.getBoundingClientRect().top);
t.ok(lb >= (await faceBox()).b - 1,
     'and its top is at or below the face\'s feet', String(Math.round(lb)));
t.ok((await p.textContent('#list .hd b'))==='THE BIG NUMBER',
     'headed with the cell you tapped');

t.head('and the zone it belongs to is lit, the way the glass lights it');
cs=await cells();
t.ok(cs.filter(c=>c.on).length===1 && cs.find(c=>c.on).s==='c0',
     'exactly one, and it is the one tapped',
     cs.filter(c=>c.on).map(c=>c.s).join(','));
/* The list opens on what is set: the face is still visible, so the
   answer to "what is in here" is already on screen - but the list is
   nineteen rows and the one in force should not be hunted for. */
t.ok(await p.evaluate(()=>{const e=document.querySelector('#list .sel');
  if(!e) return false; const r=e.getBoundingClientRect(),
  l=document.getElementById('roll').getBoundingClientRect();
  return r.top>=l.top-1 && r.bottom<=l.bottom+1;}),
  'and scrolled to the reading that is in that slot');

t.head('choosing one sends it, and the face says so without waiting');
await p.click('#list .row[data-k="vmg"]'); await p.waitForTimeout(450);
const q=(await peek()).pend;
t.ok(JSON.stringify(q['slot:dial:c0'])===
     JSON.stringify({kind:'slot',page:'dial',slot:'c0',reading:'vmg'}),
     'queued for the panel to collect', JSON.stringify(q));
t.ok(!(await p.isVisible('#list')), 'the card closes itself');
t.ok((await cellOf('c0')).tag==='<i id="pwned2">V</i>',
     'and the big number shows the new reading at once - a mirror that '
     +'waits for the panel is a mirror that is wrong for a second and a half',
     (await cellOf('c0')).tag);
t.ok((await cells()).every(c=>!c.on), 'nothing is left lit');

t.head('a tag the catalogue made of markup is characters, not markup');
t.ok((await p.$$('#pwned2')).length===0, 'the tag did not become an element');
await p.click('g.z[data-s="c3"]'); await p.waitForTimeout(400);
t.ok((await p.textContent('#list .hd b'))==='<b id="pwned">RIGHT</b>',
     'nor did the slot name in the card\'s head');
t.ok((await p.$$('#pwned')).length===0, 'neither of them');
/* What is already queued from the section above - the drain is the
   panel's job and nothing here collects it, so "nothing" has to mean
   nothing NEW. */
const wasQ=JSON.stringify((await peek()).pend);
await p.click('[data-back]'); await p.waitForTimeout(300);
t.ok(!(await p.isVisible('#list')), 'CLOSE leaves without choosing');
t.ok(JSON.stringify((await peek()).pend)===wasQ,
     'having asked the boat for nothing', JSON.stringify((await peek()).pend));

t.head('the power sheet is a glyph in the corner, and the glass\'s own list');
/* What the two buttons LOOK like is asserted further down, where both
   of them are. This section is about the sheet behind this one. */
await sheet('#pwb');
/* The list is the GLASS's, filtered by what this Pi can do. netd
   resolves `need` against power_status() exactly as the glass resolves
   it against /status, and the rig says a desktop is startable and the
   kiosk is not - so one of that pair is here and the other is not. */
const prows=await p.$$eval('.ptile',gs=>gs.map(g=>g.dataset.pa));
t.ok(prows.join()==='reload,helper,desktop,reboot,poweroff',
     'the glass\'s own actions, in the glass\'s own order - least '
     +'destructive first, because the top of a list is where a hurried '
     +'thumb lands', prows.join());
/* Tiles, as the glass's own power sheet has them: an icon and the one
   word that fits under it. A list of sentences is a list you read; a
   grid of glyphs is one you aim at, and this is the sheet you reach
   for with one hand on something else. */
const ptl=await p.$$eval('.ptile',gs=>gs.map(g=>({
  a:g.dataset.pa, svg:g.querySelectorAll('svg').length,
  word:(g.querySelector('b')||{}).textContent||'',
  tier:g.parentElement.className})));
t.ok(ptl.every(x=>x.svg===1 && x.word),
     'a glyph and a word on each', JSON.stringify(ptl.map(x=>x.word)));
t.ok(ptl.every(x=>x.word.split(' ').length<=2),
     'and the word is the short one the glass puts under its own tile',
     JSON.stringify(ptl.map(x=>x.word)));
/* Two tiers, as the glass has them. Night is a single red hue, so the
   separation cannot rest on colour - the rule between them carries it. */
t.ok(ptl.filter(x=>/low/.test(x.tier)).map(x=>x.a).join()==='reboot,poweroff',
     'with the two that take the boat down under a rule of their own',
     ptl.filter(x=>/low/.test(x.tier)).map(x=>x.a).join());
t.ok(!prows.includes('cage'),
     'and the one this device cannot do is simply not on it');
t.ok(/3d 4h/.test(await p.textContent('#sheet .hd b')),
     'with how long it has been up', await p.textContent('#sheet .hd b'));

t.head('and nothing on it happens because you touched it once');
/* Two steps, like the glass: arm the row, then a gesture a stray touch
   does not finish. */
const did=async()=>(await peek()).did;
t.ok((await did()).length===0, 'nothing has been asked for yet',
     JSON.stringify(await did()));
await p.click('.ptile[data-pa="poweroff"]'); await p.waitForTimeout(250);
t.ok((await did()).length===0, 'and arming it is not doing it',
     JSON.stringify(await did()));
t.ok(await p.$eval('.ptile[data-pa="poweroff"]',e=>e.classList.contains('arm')),
     'the tile is lit, the way the glass lights an armed one');
t.ok(/HOLD TO SHUT DOWN/.test(await p.textContent('#hold b')),
     'and the bar says what it would do, in the glass\'s own words',
     await p.textContent('#hold b'));
/* Tapping the armed one again is the way out without doing anything -
   which is why neither this nor the glass needs a caption saying so. */
await p.click('.ptile[data-pa="poweroff"]'); await p.waitForTimeout(250);
t.ok(!(await p.isVisible('#hold.on')), 'touching it again puts it away');
t.ok((await did()).length===0, 'having asked the device for nothing',
     JSON.stringify(await did()));

t.head('and a hold you let go of early is a hold you changed your mind about');
await p.click('.ptile[data-pa="reboot"]'); await p.waitForTimeout(250);
/* Measured each time rather than once: the bar moves with the sheet,
   and a press at where it used to be is a press on the face. */
const holdFor=async ms=>{
  const r=await p.$eval('#hold',e=>{const b=e.getBoundingClientRect();
    return {x:b.left+b.width/2, y:b.top+b.height/2};});
  await p.mouse.move(r.x,r.y); await p.mouse.down();
  await p.waitForTimeout(ms); await p.mouse.up();
  await p.waitForTimeout(300);
};
await holdFor(400);
t.ok((await did()).length===0, 'four hundred milliseconds is not a hold',
     JSON.stringify(await did()));
await holdFor(1100);
t.ok(JSON.stringify(await did())===JSON.stringify(['reboot']),
     'and a full one is', JSON.stringify(await did()));
/* reload is the one that does NOT go to the device: the thing being
   reloaded is the panel's page, and netd cannot reload a browser
   without killing it. */
await p.waitForTimeout(1500);
/* The button toggles, and a reboot is heavy so the sheet stays up to
   say so - pressing it here would put the sheet away rather than
   bring it back. */
if(!(await p.isVisible('#sheet.on'))){
  await sheet('#pwb'); }
await p.click('.ptile[data-pa="reload"]'); await p.waitForTimeout(250);
await holdFor(1100);
t.ok(JSON.stringify(await did())===JSON.stringify(['reboot']),
     'a reload is not asked of the device', JSON.stringify(await did()));
t.ok(JSON.stringify((await peek()).pend['power'])===
     JSON.stringify({kind:'power', action:'reload'}),
     'it is queued for the panel, which is the thing being reloaded',
     JSON.stringify((await peek()).pend['power']));
/* The word about what just happened is fixed to the bottom of the
   glass, and so is the sheet - so it sat straight on the bar that does
   the next thing, and for the two and a half seconds it was there,
   pressing that bar pressed the message. */
const over=await p.evaluate(()=>{
  const m=document.getElementById('msg');
  const h=document.getElementById('hold');
  if(!m || !h || m.style.display==='none') return null;
  const a=m.getBoundingClientRect(), b=h.getBoundingClientRect();
  return !(a.bottom<=b.top || b.bottom<=a.top);
});
t.ok(over===false, 'and the word about it is not sitting on the bar',
     String(over));
await p.click('[data-shx]'); await p.waitForTimeout(250);
t.ok(!(await p.isVisible('#sheet.on')), 'and CLOSE leaves the sheet');
/* A finished action puts the sheet away after a beat, and that beat
   outlives the sheet. Close it yourself and open the other one inside
   the second and a half and the old timer shut the new one in your
   face - which is exactly what a hurried hand does. */
await sheet('#thb');
await p.waitForTimeout(1600);
t.ok(await p.isVisible('#sheet.on'),
     'and a sheet opened straight after one is not shut by its timer');
await p.click('[data-shx]'); await p.waitForTimeout(250);

t.head('the theme is behind the gear, beside the power button');
/* It was four buttons along the bottom. The owner wanted it in the
   header with the other one, and the room that frees goes to the face,
   which is the thing this app is. */
const hdb=await p.$$eval('.top .hb',gs=>gs.map(g=>{
  const r=g.getBoundingClientRect();
  return {id:g.id, x:r.left, y:r.top, w:r.width, h:r.height,
          txt:g.textContent.trim(), svg:g.querySelectorAll('svg').length,
          ring:getComputedStyle(g).borderTopColor,
          ink:(g.querySelector('svg')||{getBoundingClientRect:()=>({width:0})})
                .getBoundingClientRect().width,
          dia:r.width-2*(parseFloat(getComputedStyle(g).paddingLeft)||0),
          /* The colour on its own is not the ring: a zero-width border
             still reports one, so a button with no ring at all read as
             ringed. The width is the ring. */
          ringW:parseFloat(getComputedStyle(g).borderTopWidth)||0};}));
t.ok(hdb.length===2 && hdb.map(x=>x.id).join()==='thb,pwb',
     'two of them, the gear to the LEFT of the power button',
     hdb.map(x=>x.id).join());
t.ok(hdb.length===2 && hdb[1].x+hdb[1].w > 390-40 && hdb.every(x=>x.y<120),
     'in the top right, above the face rather than under it',
     JSON.stringify(hdb.map(x=>Math.round(x.x)+','+Math.round(x.y))));
t.ok(hdb.every(x=>x.txt==='' && x.svg===1),
     'a glyph each and no word beside either');
t.ok(hdb.length===2 && hdb.every(x=>x.w>=44 && x.h>=44),
     'with a target bigger than the ring that draws it - 44 is the '
     +'smallest thing a thumb finds without looking',
     JSON.stringify(hdb.map(x=>Math.round(x.w)+'x'+Math.round(x.h))));
/* Circled, because a bare glyph on a header reads as a label rather
   than a thing you press - and the power one in its own colour,
   because it is the one here that can take the instruments down. */
t.ok(hdb.length===2 && hdb.every(x=>x.ringW>=1
                                  && x.ring && x.ring!=='rgba(0, 0, 0, 0)'),
     'both are ringed, so they read as buttons rather than as labels',
     JSON.stringify(hdb.map(x=>x.ringW+' '+x.ring)));
t.ok(hdb.length===2 && hdb[1].ring!==hdb[0].ring,
     'and the power one wears a colour of its own',
     JSON.stringify(hdb.map(x=>x.ring)));
/* The ring came in around the glyph and the glyph stayed where it
   was. Shrinking both together is the easy mistake, and it undoes the
   thing the owner asked for: the glyph is what you are looking for and
   the circle is only what says it can be pressed. */
t.ok(hdb.every(x=>Math.abs(x.ink-19)<1),
     'the glyph is the size it was before the ring came in',
     JSON.stringify(hdb.map(x=>Math.round(x.ink))));
t.ok(hdb.every(x=>x.dia<=36 && x.dia-x.ink<=18),
     'and the ring sits close around it rather than enclosing a tile',
     JSON.stringify(hdb.map(x=>Math.round(x.dia))));
t.ok((await p.$$('#foot .th')).length===0,
     'and nothing is left of the row along the bottom');

t.head('a sheet comes to the middle, over a dim, not up from the edge');
/* The glass does exactly this with its own control panel - a dim over
   everything and the box in the centre of it - and the owner asked for
   the mirror to match. The middle is also where you are looking, and
   not under your own thumb. */
await sheet('#thb');
const ctr=await p.evaluate(()=>{
  const sc=document.getElementById('scrim');
  const sh=document.getElementById('sheet');
  const r=sh.getBoundingClientRect(), s=getComputedStyle(sc);
  return {y:(r.top+r.bottom)/2, h:r.height, vis:s.visibility,
          dim:s.backgroundColor, bottom:r.bottom, top:r.top,
          scrimTop:sc.getBoundingClientRect().top,
          scrimBot:sc.getBoundingClientRect().bottom};
});
t.ok(Math.abs(ctr.y-844/2) < 90,
     'the box sits about the middle of the glass, not on its bottom edge',
     Math.round(ctr.y)+' of 422');
/* Equally inset top and bottom, which is what centred means and what
   a drawer pinned to one edge never is. Measured rather than the gap
   below it, because a sheet with enough on it fills the height that is
   going - and is still a window. */
t.ok(Math.abs(ctr.top-(844-ctr.bottom))<10,
     'equally clear of the top and the bottom, which a drawer is not',
     Math.round(ctr.top)+' / '+Math.round(844-ctr.bottom));
t.ok(/^rgba\(0, 0, 0, 0\.\d+\)$/.test(ctr.dim),
     'and the page behind it is dimmed rather than left lit', ctr.dim);
/* It arrives from somewhere rather than replacing what you were
   looking at, which is the whole job of the movement. A transition
   cannot be caught mid-flight without racing it, but what CAN be
   checked is that the box is asked to move at all - which is the thing
   that would be lost. */
const anim=await p.evaluate(()=>{
  for(const sh of document.styleSheets)
    for(const r of sh.cssRules)
      if(r.selectorText==='#sheet')
        return {tr:r.style.transition, tf:r.style.transform};
  return {};
});
t.ok(/transform/.test(anim.tr||'') && /translate|scale/.test(anim.tf||''),
     'and it moves into place rather than appearing in it',
     JSON.stringify(anim));
const dimOf=async()=>await p.$eval('#scrim',
  e=>+(getComputedStyle(e).backgroundColor.match(/[\d.]+\)$/)||[0])[0]
      .replace(')',''));
const dimTh=await dimOf();
/* The owner asked for the power one to stand further forward, which is
   right: what is on it is further-reaching than a palette. */
await sheet('#pwb');
const dimPw=await dimOf();
t.ok(dimPw>dimTh, 'and the power sheet stands further forward than the theme',
     dimTh+' -> '+dimPw);

t.head('and the header goes back with the rest of the page');
/* It stood in front of the dim for a while so the two buttons stayed
   pressable - the owner wants the whole page to go back, so the way
   out of a sheet is CLOSE or a tap on the dim, and the way to the
   other one is through there. */
const zs=await p.evaluate(()=>{
  const t=document.querySelector('.top'), sc=document.getElementById('scrim');
  const z=getComputedStyle(t).zIndex;
  const r=t.getBoundingClientRect(), b=sc.getBoundingClientRect();
  return {z:z, covered:(b.top<=r.top && b.bottom>=r.bottom)};
});
t.ok(zs.z==='auto' || +zs.z < 8,
     'it does not stand in front of the dim', String(zs.z));
t.ok(zs.covered, 'and the dim reaches over it');
/* Playwright refuses to click what another element covers, so a
   timeout here IS the assertion. */
let through=false;
try{ await p.click('#thb',{timeout:1200}); through=true; }catch(e){}
t.ok(!through, 'so the header cannot be pressed through it',
     String(through));

t.head('and a tap on the dim puts it away');
/* The gesture a thumb makes before it finds CLOSE. Only on the dim
   ITSELF - a tap that lands on the box is a tap on the box. */
await p.mouse.click(195, 800); await p.waitForTimeout(400);
t.ok(!(await p.isVisible('#sheet.on')), 'it closes');
t.ok(await p.$$eval('.top .hb',gs=>gs.every(g=>!g.classList.contains('on'))),
     'and the header goes dark with it');
await sheet('#thb');
const inBox=await p.$eval('#sheet .hd b',e=>{const r=e.getBoundingClientRect();
  return {x:r.left+2, y:(r.top+r.bottom)/2};});
await p.mouse.click(inBox.x, inBox.y); await p.waitForTimeout(350);
t.ok(await p.isVisible('#sheet.on'),
     'while a tap inside the box leaves it alone');
await p.click('[data-shx]'); await p.waitForTimeout(400);

t.head('the radios are a status and nothing you can do to them');
/* The owner asked to see them and nothing more. The picker stays on
   the glass: its content IS the readings, and a scan is ten seconds of
   the hotspot stuttering for every device on it - the asking phone
   included. */
await sheet('#thb');
await p.waitForTimeout(500);                 /* the fetch is its own */
const rad=await p.$$eval('#sheet .srow.ro',gs=>gs.map(g=>({
  tag:g.tagName, name:g.querySelector('s').textContent,
  sub:(g.querySelector('s em')||{}).textContent||'',
  val:g.querySelector('b').textContent,
  off:g.classList.contains('off'),
  sk:g.dataset.sk||'' })));
t.ok(rad.length===4, 'a row per adapter and one for bluetooth',
     String(rad.length));
t.ok(rad.every(r=>r.tag==='DIV' && !r.sk),
     'none of them is a button, and none carries a setting key',
     JSON.stringify(rad.map(r=>r.tag)));
t.ok(rad[0].val==='HOTSPOT · CONFLUENCE',
     'the one running the hotspot says so', rad[0].val);
t.ok(rad[1].val==='MARINA-GUEST  72%',
     'the one reaching out says what it is on and how strong',
     rad[1].val);
t.ok(rad[2].val==='OFF' && rad[2].off,
     'an adapter that is down says OFF and is dimmed',
     rad[2].val+' / '+rad[2].off);
t.ok(rad[3].val==='JBL FLIP', 'and bluetooth says what is on it',
     rad[3].val);
t.ok(rad[0].sub==='wlan0' && rad[1].sub==='wlan1',
     'with the interface under the name rather than beside it',
     rad[0].sub+','+rad[1].sub);
/* Accent on this sheet means "you can change this". */
const cols=await p.evaluate(()=>{
  const ro=document.querySelector('#sheet .srow.ro b');
  const rw=document.querySelector('#sheet .srow[data-sk] b');
  return {ro:getComputedStyle(ro).color, rw:getComputedStyle(rw).color};
});
t.ok(cols.ro!==cols.rw,
     'and they are not drawn in the colour the settings are',
     JSON.stringify(cols));
/* The whole point: nothing on them does anything. */
const wasQ3=JSON.stringify((await peek()).pend);
await p.click('#sheet .srow.ro'); await p.waitForTimeout(350);
t.ok(JSON.stringify((await peek()).pend)===wasQ3,
     'and pressing one asks the boat for nothing',
     JSON.stringify((await peek()).pend));
/* They come down their own door. /r/state is fetched on every poll of
   the start clock and this costs a handful of subprocesses, so the two
   are deliberately not the same door. */
t.ok((await p.evaluate(()=>S.wifi||S.bt||S.radios))===undefined,
     'they are not on /r/state, which the clock polls every four seconds');

t.head('the gear is the glass\'s own settings, in the glass\'s own cards');
await sheet('#thb');
const rows=()=>p.$$eval('#sheet .sgrp,#sheet .srow',gs=>gs.map(g=>
  g.classList.contains('sgrp')
    ? {grp:g.textContent}
    : {k:g.dataset.sk, kind:g.className,
       val:(g.querySelector('b')||{}).textContent||'',
       on:g.classList.contains('on'),
       slider:!!g.querySelector('input[type=range]')}));
const R=await rows();
const heads=R.filter(x=>x.grp).map(x=>x.grp);
const want=[...new Set(cat.settings.map(x=>x.g))];
t.ok(heads.slice(-want.length).join()===want.join(),
     'a heading per card, in the panel\'s order', heads.join());
/* The radios first, because they are what you open this to check -
   and they are the only cards on it the panel does not register. */
t.ok(heads.slice(0,heads.length-want.length).join()==='WIFI,BLUETOOTH',
     'under the radios, which come first and are not settings at all',
     heads.join());
t.ok(R.filter(x=>x.k).map(x=>x.k).join()===cat.settings.map(x=>x.k).join(),
     'and every setting the panel registered, in its order, and no others',
     R.filter(x=>x.k).map(x=>x.k).join());
/* The phone writes down no settings of its own. Add one to the glass
   and it shows up here with its words, its card and its values. */
t.ok(cat.settings.every(d=>['range','cycle','toggle','action']
                           .indexOf(d.kind)>=0),
     'each one says what SHAPE it is, so the phone draws it without a list');
t.ok(R.find(x=>x.k==='dim').slider && R.find(x=>x.k==='depthAlarm').slider,
     'a range is a slider');
t.ok(R.find(x=>x.k==='keepAwake').on===true,
     'a toggle is a switch that is on when the setting is');
/* Its unit is the OTHER setting's value. A second unit field would say
   FT while the glass said M, and the alarm would be silently
   redefined - the threshold is held in whatever is showing. */
t.ok(/\s(FT|M)$/.test(R.find(x=>x.k==='depthAlarm').val),
     'and the alarm carries the unit the units row is set to',
     R.find(x=>x.k==='depthAlarm').val);
const bg=await p.evaluate(()=>getComputedStyle(document.body).backgroundColor);
t.ok(bg==='rgb(244, 246, 247)',
     'the day palette came down the wire and was applied', bg);

t.head('and a tap on one sends it, showing it before the boat answers');
/* A cycle goes round the panel's own list and back to the start. */
const themeRow=()=>p.$eval('.srow[data-sk="theme"] b',e=>e.textContent);
const was=await themeRow();
await p.click('.srow[data-sk="theme"]'); await p.waitForTimeout(400);
t.ok((await themeRow())!==was, 'the value moves at once',
     was+' -> '+(await themeRow()));
t.ok(JSON.stringify((await peek()).pend['theme'])===
     JSON.stringify({kind:'theme',
       theme:cat.themes[(cat.themes.indexOf(cat.now.theme)+1)%cat.themes.length]}),
     'and the boat is told - the theme keeps its own command kind, '
     +'which netd checks against the themes the panel registered',
     JSON.stringify((await peek()).pend['theme']));
/* On auto the mode and the outcome are two different facts and you
   want both; only the panel knows what the clock has chosen. */
await p.evaluate(()=>{ S.now.set.theme='auto'; S.now.eff='dusk'; shPaint(); });
t.ok(/AUTO \u00b7 DUSK/.test(await themeRow()),
     'and AUTO says what the clock has actually chosen right now',
     await themeRow());
/* Everything else goes as one command kind, checked against the
   catalogue the panel itself registered. */
await p.click('.srow[data-sk="keepAwake"]'); await p.waitForTimeout(400);
t.ok(JSON.stringify((await peek()).pend['set:keepAwake'])===
     JSON.stringify({kind:'set', k:'keepAwake', v:!cat.now.set.keepAwake}),
     'a switch sends the other way round',
     JSON.stringify((await peek()).pend['set:keepAwake']));
t.ok(await p.$eval('.srow[data-sk="keepAwake"]',
                   e=>e.classList.contains('on'))!==cat.now.set.keepAwake,
     'and flips under the finger rather than waiting');
await p.click('.srow[data-sk="horn"]'); await p.waitForTimeout(400);
t.ok(JSON.stringify((await peek()).pend['set:horn'])===
     JSON.stringify({kind:'set', k:'horn', v:null}),
     'and an action carries no value at all',
     JSON.stringify((await peek()).pend['set:horn']));
/* The slider reports all the way along and that would be a command a
   frame, so only the value you let go of is sent. */
const slid=await p.$eval('.srow[data-sk="dim"] input',e=>{
  const r=e.getBoundingClientRect(); return {x:r.left, y:r.top+r.height/2,
                                             w:r.width};});
const dimTxt=()=>p.$eval('.srow[data-sk="dim"] b',e=>e.textContent);
const dim0=await dimTxt();
await p.mouse.move(slid.x+slid.w*0.5, slid.y);
await p.mouse.down(); await p.mouse.move(slid.x+slid.w*0.2, slid.y);
await p.waitForTimeout(150);
t.ok((await peek()).pend['set:dim']===undefined,
     'nothing is sent while the thumb is still down',
     JSON.stringify((await peek()).pend['set:dim']));
const dim1=await dimTxt();
t.ok(dim1!==dim0 && /^\d+%$/.test(dim1) && +dim1.slice(0,-1)<+dim0.slice(0,-1),
     'while the number follows the thumb, because a slider whose '
     +'readout waits for the boat is one you cannot aim',
     dim0+' -> '+dim1);
await p.mouse.up(); await p.waitForTimeout(400);
t.ok((await peek()).pend['set:dim'] &&
     (await peek()).pend['set:dim'].v>=25 &&
     (await peek()).pend['set:dim'].v<=100,
     'and the one you let go of is', JSON.stringify((await peek()).pend['set:dim']));
/* Pressing the OTHER one swaps the sheet rather than closing it,
   which is what a header of buttons should do. */
await sheet('#pwb');
t.ok(/DEVICE/.test(await p.textContent('#sheet .hd b')),
     'the power button swaps the sheet rather than stacking a second one',
     await p.textContent('#sheet .hd b'));
t.ok((await p.$$('.prow[data-th]')).length===0, 'with the themes gone');
await p.click('[data-shx]'); await p.waitForTimeout(400);
t.ok(!(await p.isVisible('#sheet.on')), 'and CLOSE puts it away');

t.head('everything clears the glass of a real phone');
/* Headless reports no safe-area insets at all, so measuring here
   measures a phone that does not exist. Pushed in by hand: 47 at the
   top and 34 at the bottom is an iPhone with a notch and a home
   indicator, which is the phone this is for. The eight-row list this
   replaced ran past the bottom of the glass and nobody had measured
   it, because nothing here could. */
await p.addStyleTag({content:'body{padding-top:47px;padding-bottom:34px}'});
await p.waitForTimeout(250);
/* The header is what is nearest the notch now that the theme row has
   gone from the foot - and it holds two things you press. */
const hbt=await p.$eval('#pwb',e=>e.getBoundingClientRect().top);
t.ok(hbt>=47, 'the header buttons are below the notch',
     String(Math.round(hbt)));
/* The sheet is position:fixed, so the padding pushed in above does
   not move it and there is no way to measure this headless - Chromium
   reports no safe-area insets at all. What CAN be checked is that the
   rule asks for one, which is the thing that would be lost. */
const shRule=await p.evaluate(()=>{
  for(const sh of document.styleSheets)
    for(const r of sh.cssRules)
      if(r.selectorText==='#scrim') return r.style.padding;
  return '';
});
t.ok(/safe-area-inset-bottom/.test(shRule) &&
     /safe-area-inset-top/.test(shRule),
     'and the dim keeps its sheet off the notch and the home indicator',
     shRule);
t.ok((await faceBox()).y>=47, 'and the face below the notch',
     String(Math.round((await faceBox()).y)));
t.ok((await faceBox()).b<=844-34,
     'and the whole face is on the glass', String(Math.round((await faceBox()).b)));

t.head('the app opens on the page the glass is already on');
/* Someone has swiped the glass to the music page since the app was
   last open. now.page carries the panel's own PAGE_I, and without
   reading it the mirror opens on the dial and shows a page nobody is
   looking at. */
await fetch(base+'/poke?page=2');
await open();
t.ok((await cells()).length===cat.slots.mus.length,
     'the music page comes up with nothing tapped',
     String((await cells()).length));
t.ok(await p.$eval('[data-f="mus"]',e=>e.classList.contains('on')),
     'and it is the music tab that is lit');
await fetch(base+'/poke?page=1');
await open();

t.head('a page the panel could not measure is still reachable');
/* The music overlay is only measurable on a 1080 glass, so a kiosk
   window someone resized leaves it out - and three complications with
   no picture must not become three complications with no way to
   change them. */
await p.evaluate(()=>{ delete S.geom.mus; draw(); });
await p.waitForTimeout(250);
await p.click('[data-f="mus"]'); await p.waitForTimeout(350);
t.ok((await p.$$('#main .fv')).length===0, 'no face is drawn for it');
const fb=await p.$$eval('#main .fbr',es=>es.map(e=>e.dataset.s));
t.ok(fb.length===3 && fb.join()==='a,p,s',
     'but all three slots are there as rows', fb.join());
t.ok(/NOT AT ITS FULL SIZE/.test(await p.textContent('#main .fb p')),
     'and it says why the picture is missing');
await p.click('.fbr[data-s="p"]'); await p.waitForTimeout(350);
t.ok(await p.isVisible('#list'), 'and they open the same card');
/* This page has no face for the card to drop from, so it kept
   whatever the last face measured - and the header is an opaque bar in
   front of the page now, so the card was up there underneath it with a
   CLOSE nobody could press. */
const cardTop=await p.$eval('#list',e=>e.getBoundingClientRect().top);
const hedBot=await p.$eval('.top',e=>e.getBoundingClientRect().bottom);
t.ok(cardTop>=hedBot,
     'and it hangs below the header rather than under it',
     Math.round(cardTop)+' vs '+Math.round(hedBot));
await p.click('[data-back]'); await p.waitForTimeout(250);

t.head('a wrong token says so rather than sitting blank');
/* Two more lines stood here - that no face and no zones are drawn -
   and they came out because nothing could make them fail. Every route
   to an empty instrument on the screen goes through draw(), and draw()
   throws on the missing catalogue long before it reaches the face: it
   took three separate edits to get a bare rim onto the glass, which is
   not a regression anyone ships. What actually protects that outcome
   is the early return in load() and the no-page-errors line at the
   end, and a single change does break both of those. */
await open('?t=nope');
t.ok(await p.isVisible('#msg'), 'it says so rather than sitting blank');
t.ok(/TOKEN/i.test(await p.textContent('#msg')),
     'naming the reason', await p.textContent('#msg'));

t.ok(errs.length===0, 'and the page threw nothing throughout',
     errs.join(' | '));

await b.close();
rig.kill();
rmSync(tmp,{recursive:true,force:true});
t.done();
