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

t.head('the theme row still works, and the mirror wears the panel\'s colours');
const bg=await p.evaluate(()=>getComputedStyle(document.body).backgroundColor);
t.ok(bg==='rgb(244, 246, 247)',
     'the day palette came down the wire and was applied', bg);
await p.click('[data-t="night"]'); await p.waitForTimeout(400);
t.ok(JSON.stringify((await peek()).pend['theme'])===
     JSON.stringify({kind:'theme',theme:'night'}), 'and a theme tap is queued',
     JSON.stringify((await peek()).pend));

t.head('everything clears the glass of a real phone');
/* Headless reports no safe-area insets at all, so measuring here
   measures a phone that does not exist. Pushed in by hand: 47 at the
   top and 34 at the bottom is an iPhone with a notch and a home
   indicator, which is the phone this is for. The eight-row list this
   replaced ran past the bottom of the glass and nobody had measured
   it, because nothing here could. */
await p.addStyleTag({content:'body{padding-top:47px;padding-bottom:34px}'});
await p.waitForTimeout(250);
const foot=await p.$eval('#foot .th',e=>e.getBoundingClientRect().bottom);
t.ok(foot<=844-34, 'the theme row is above the home indicator',
     String(Math.round(foot)));
t.ok((await faceBox()).y>=47, 'and the face below the notch',
     String(Math.round((await faceBox()).y)));
t.ok((await faceBox()).b<=844-34,
     'and the whole face is on the glass', String(Math.round((await faceBox()).b)));

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
