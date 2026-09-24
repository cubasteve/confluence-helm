/* Getting about the panel: the two drawers, paging, and the radio
   picker that hangs off the control panel. */
import {open, tally, fling, state} from './helpers.mjs';
const t=tally();
const NETS=[
  {ssid:'Confluence',   secure:true, saved:true,  active:true,  signal:99},
  {ssid:'Marina Guest', secure:true, saved:false, active:false, signal:64},
  {ssid:'Steve iPhone', secure:true, saved:true,  active:false, signal:81}];
const {b,p,posts}=await open(t,{demo:true,
  status:{wifi:{available:true, devices:[{dev:'wlan0',up:true,ap:true,ssid:'Confluence'}]},
          bt:{available:true,powered:true}, power:{available:true}},
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

t.head('paging wants three fingers');
await fling(p,1,-260,0);
t.ok((await state(p)).page===1, 'one finger sideways does not page');
await fling(p,3,-260,0);
t.ok((await state(p)).page===2, 'three reach the music page');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'and come back');
await fling(p,3,260,0);
t.ok((await state(p)).page===1, 'stopping there rather than wrapping');

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

await t.done(b);
