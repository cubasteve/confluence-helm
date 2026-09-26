/* The menu: one box, three things that open it. What it holds to
   account is the shared part - where it goes on a round glass, opening
   on the row in force, the tap that chooses, the veil, and the tap on
   the control next door that moves it rather than dismissing it. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t,{demo:true});
await p.waitForTimeout(400);

const box=()=>p.evaluate(()=>{ const e=$('pick'), q=e.getBoundingClientRect();
  return {on:e.classList.contains('on'),
          x:Math.round(q.left), y:Math.round(q.top),
          w:Math.round(q.width), h:Math.round(q.height),
          /* every corner inside the glass */
          out:[[q.left,q.top],[q.right,q.top],[q.left,q.bottom],[q.right,q.bottom]]
              .filter(([x,y])=>Math.hypot(x-540,y-540)>539).length,
          rows:[...$('pick-pk').querySelectorAll('.pkrow,.pkset')].length,
          sel:($('pick-pk').querySelector('.sel .pkrow i, .sel i, .sel b')||{})
                .textContent||null}; });
/* A finger, not a click on an element: the veil is over everything while
   the menu is open, and the point of several of these is what the veil
   does with the tap. */
const tapAt=async sel=>{ const r=await p.evaluate(s=>{
    const q=document.querySelector(s).getBoundingClientRect();
    return {x:q.left+q.width/2, y:q.top+q.height/2}; }, sel);
  await p.mouse.click(r.x, r.y); await p.waitForTimeout(300); };
const slots=()=>p.evaluate(()=>({dial:Object.assign({},DIAL.slot),
                                 mus:Object.assign({},MUS.slot),
                                 disk:JSON.parse(localStorage.getItem('dialSlots')||'{}')}));

t.head('a dial cell opens it, on the reading that cell is showing');
await tapAt('.dcell[data-slot="c1"]');
let B=await box();
t.ok(B.on, 'the menu is up');
t.ok(B.rows>=13, 'every reading in the catalogue is in it', String(B.rows));
t.ok(B.out===0, 'and all four of its corners are on the glass', JSON.stringify(B));
t.ok(await p.evaluate(()=>$('pick-pk').querySelector('.pkrow.sel').dataset.k)
     === await p.evaluate(()=>DIAL.slot.c1),
     'opened on the reading already in the cell',
     await p.evaluate(()=>DIAL.slot.c1));
t.ok(await p.evaluate(()=>{ const sv=$('svg');
       return sv.classList.contains('picking-c1'); }),
     'and the cell itself says it is the one being changed');

t.head('a tap on a row is the choice');
await p.click('#pick-pk .pkrow[data-k="twa"]'); await p.waitForTimeout(300);
let S=await slots();
t.ok(S.dial.c1==='twa', 'the cell takes the reading tapped', S.dial.c1);
t.ok(S.disk.c1==='twa', 'and it is kept over a restart', String(S.disk.c1));
t.ok(!(await box()).on, 'the menu goes away, because that was the choice');
t.ok(!await p.evaluate(()=>$('svg').classList.contains('picking-c1')),
     'and the cell stops saying it is being changed');

t.head('a reading already in another slot of the same group swaps');
const was=await slots();
await tapAt('.dcell[data-slot="c2"]');
await p.click('#pick-pk .pkrow[data-k="twa"]'); await p.waitForTimeout(300);
S=await slots();
t.ok(S.dial.c2==='twa', 'the one you asked for lands where you asked');
t.ok(S.dial.c1===was.dial.c2,
     'and the two trade places rather than showing the same number twice',
     S.dial.c1+' / '+S.dial.c2);

t.head('the same cell again puts it away');
await tapAt('.dcell[data-slot="c0"]');
t.ok((await box()).on, 'open');
await tapAt('.dcell[data-slot="c0"]');
t.ok(!(await box()).on, 'and shut');

t.head('the veil dismisses it, and swallows the tap that does');
await tapAt('.dcell[data-slot="c0"]');
const before=await slots();
await p.mouse.click(540, 60);            /* the rim, well clear of the menu */
await p.waitForTimeout(300);
t.ok(!(await box()).on, 'a tap outside closes it');
t.ok(JSON.stringify(await slots())===JSON.stringify(before),
     'and changed nothing on the way');

t.head('a tap on the cell next door MOVES it');
await tapAt('.dcell[data-slot="c0"]');
t.ok(await p.evaluate(()=>$('svg').classList.contains('picking-c0')), 'on c0');
await tapAt('.dcell[data-slot="c3"]');
t.ok(await p.evaluate(()=>$('svg').classList.contains('picking-c3'))
     && !await p.evaluate(()=>$('svg').classList.contains('picking-c0')),
     'now on c3, in one tap rather than two');
t.ok((await box()).on, 'and it is still open');
await p.mouse.click(540, 60); await p.waitForTimeout(250);

t.head('the course sheet opens the same box');
await p.evaluate(()=>openApp(APPS.find(a=>a.id==='tracks')));
await p.waitForTimeout(700);
await p.evaluate(()=>openCourse()); await p.waitForTimeout(300);
await tapAt('#cv-mode');
B=await box();
t.ok(B.on && B.rows===2, 'the sequence menu is the menu', JSON.stringify(B.rows));
t.ok(B.out===0, 'inside the glass down there too', JSON.stringify(B));
t.ok(B.w===330, 'at the width that caller asked for', String(B.w));
/* The row is a hundred px off the bottom and has the sheet's own bar
   under it, so this one opens upward. */
const rd=await p.evaluate(()=>Math.round($('cv-mode').getBoundingClientRect().top));
t.ok(B.y+B.h <= rd, 'and above its readout, not over the bar below it',
     B.y+B.h+' vs '+rd);
const main=await p.evaluate(()=>{ const q=$('course-main').getBoundingClientRect();
  return [Math.round(q.left), Math.round(q.right)]; });
t.ok(B.x>=main[0]-1 && B.x+B.w<=main[1]+1,
     'held inside the sheet rather than hanging over the rim beside it',
     B.x+'..'+(B.x+B.w)+' in '+main.join('..'));
await tapAt('#cv-sync');
t.ok((await box()).on && await p.evaluate(()=>$('cv-sync').classList.contains('picking')),
     'and the readout next along takes it in one tap, the same as a cell');

await t.done(b);
