/* The phone, as a phone sees it.

   This is the half the owner actually touches - the panel's remote half
   is tests/remote.mjs and netd's is tests/remote_test.py, and between
   them they covered everything except the page a person looks at. The
   page builds its rows as strings in JS, so the only honest way to
   check them is to open it in a browser and tap. */
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
const p0=await b0.newPage();
await p0.goto('http://localhost:8080/confluence_helm.html');
await p0.waitForTimeout(1200);
const cat=await p0.evaluate(()=>remoteCat());
await b0.close();
/* One name is doctored. Everything this page draws arrived over a
   network from a panel that is trusted - and the page builds its rows
   as strings, so the day that trust is misplaced is the day nobody
   remembers that. */
cat.names['dial:c3']='<b id="pwned">RIGHT</b>';
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
const rows=()=>p.$$eval('#main .row',es=>es.map(e=>({
  lab:e.querySelector('b').textContent, val:e.querySelector('s').textContent,
  p:e.dataset.p, s:e.dataset.s})));

await open();

t.head('it says what each cell is, not what the code calls it');
const r=await rows();
t.ok(r.length===8, 'a row per slot', String(r.length));
t.ok(r[0].lab==='APEX' && r[0].val==='HEADING',
     'the music page by its positions', JSON.stringify(r[0]));
const big=r.find(x=>x.s==='c0');
t.ok(big.lab==='THE BIG NUMBER' && big.val==='BOAT SPEED',
     'and the dial by what you would point at - not C0',
     JSON.stringify(big));
t.ok(!(await p.content()).includes('>C0<'),
     'the slot ids do not reach the screen at all');
const heads=await p.$$eval('#main h1',es=>es.map(e=>e.textContent));
t.ok(heads.includes('THE MUSIC PAGE') && heads.includes('THE DIAL'),
     'the pages are named by the panel, not by netd', JSON.stringify(heads));

t.head('the theme row shows which one is on');
const th=await p.$$eval('.th button',es=>es.map(e=>
  e.textContent+(e.className==='on'?'*':'')));
t.ok(JSON.stringify(th)===JSON.stringify(['AUTO*','DAY','DUSK','NIGHT']),
     'four, with the live one lit', JSON.stringify(th));

t.head('the picker opens on what is already set');
/* c2 holds HEEL, which is twelfth of nineteen and well below the fold.
   This section used to open c0 - BOAT SPEED, the first row in the list
   - so "scrolled to it" was true at scrollTop 0 and the assertion could
   not fail. */
await p.click('[data-s="c2"]'); await p.waitForTimeout(350);
t.ok(await p.isVisible('#list'), 'the list is up');
t.ok((await p.textContent('#list h1'))==='MIDDLE',
     'headed with the cell you tapped');
const sel=await p.$$eval('#list .row.sel',es=>es.map(e=>e.textContent));
t.ok(sel.length===1 && /HEEL/.test(sel[0]),
     'the reading in that cell is marked, and only it', JSON.stringify(sel));
t.ok(await p.evaluate(()=>{
       const e=document.querySelector('#list .sel'), r=e.getBoundingClientRect();
       return r.top>0 && r.bottom<innerHeight; }),
     'and the list is opened ON it rather than at the top');

t.head('and lets you leave without choosing');
/* Without this the only way off the list is to set something, so
   opening it by accident means changing a cell you did not touch. */
await p.click('[data-back]'); await p.waitForTimeout(300);
t.ok(!(await p.isVisible('#list')), 'BACK closes it');
t.ok(Object.keys((await peek()).pend).length===0,
     'having asked the boat for nothing', JSON.stringify((await peek()).pend));
t.ok((await rows()).find(x=>x.s==='c2').val==='HEEL',
     'and the cell is as it was');

t.head('a tap on a reading is a command, and the row follows it');
await p.click('[data-s="c0"]'); await p.waitForTimeout(350);
await p.click('#list .row[data-k="vmg"]'); await p.waitForTimeout(400);
const q=(await peek()).pend;
t.ok(JSON.stringify(q['slot:dial:c0'])===
     JSON.stringify({kind:'slot',page:'dial',slot:'c0',reading:'vmg'}),
     'queued for the panel to collect', JSON.stringify(q));
t.ok(!(await p.isVisible('#list')), 'the list closes itself');
t.ok((await rows()).find(x=>x.s==='c0').val==='VMG',
     'and the row says VMG without waiting for the panel to confirm');

t.head('so is a tap on a theme');
await p.click('[data-t="night"]'); await p.waitForTimeout(400);
t.ok(JSON.stringify((await peek()).pend['theme'])===
     JSON.stringify({kind:'theme',theme:'night'}), 'queued',
     JSON.stringify((await peek()).pend));
const th2=await p.$$eval('.th button',es=>es.map(e=>
  e.textContent+(e.className==='on'?'*':'')));
t.ok(th2[3]==='NIGHT*' && th2[0]==='AUTO', 'and the lit one moves',
     JSON.stringify(th2));

t.head('a wrong token gets the page and nothing else');
await open('?t=nope');
t.ok((await rows()).length===0, 'no rows');
t.ok(await p.isVisible('#msg'), 'and it says so rather than sitting blank');
t.ok(/TOKEN/i.test(await p.textContent('#msg')),
     'naming the reason', await p.textContent('#msg'));

t.head('markup in a name is text, not markup');
await open();
t.ok((await p.$$('#pwned')).length===0,
     'the tag the catalogue carried did not become an element');
t.ok((await rows()).find(x=>x.s==='c3').lab==='<b id="pwned">RIGHT</b>',
     'it is on the screen as the characters it is',
     (await rows()).find(x=>x.s==='c3').lab);

t.ok(errs.length===0, 'and the page threw nothing throughout',
     errs.join(' | '));

await b.close();
rig.kill();
rmSync(tmp,{recursive:true,force:true});
t.done();
