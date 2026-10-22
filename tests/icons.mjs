/* The mark in the tab, and the promise that the single file works on
   its own with nothing beside it.
   This was the home-screen probe: the manifest, the apple-touch icon and
   the four rendered PNGs. Those went with phone mode - the helm is a
   panel app now and nothing installs it to a phone - so what is left is
   the favicon, which is inline and therefore travels inside the file. */
import {open, tally} from './helpers.mjs';
const t=tally();
const {b,p}=await open(t);

t.head('the tab is right even with nothing beside the file');
const ico=await p.evaluate(()=>{ const l=document.querySelector('link[rel=icon]');
  return l?l.href:''; });
t.ok(/^data:image\/svg\+xml,/.test(ico), 'the favicon is inline, not a fetch', ico.slice(0,32));
t.ok(/%3Csvg/.test(ico) && /viewBox='0 0 32 32'/.test(decodeURIComponent(ico)),
     'and is an SVG that scales to whatever the tab wants');
const svg=decodeURIComponent(ico.replace(/^data:image\/svg\+xml,/,''));
t.ok((svg.match(/<path /g)||[]).length===3, 'three waves',
     String((svg.match(/<path /g)||[]).length));
t.ok(/#4A9EFF/i.test(svg), 'the middle one in the accent colour');
t.ok(/#0B0C0E/i.test(svg), 'on the same black the page comes up in');
const parsed=await p.evaluate(s=>{ const d=new DOMParser().parseFromString(s,'image/svg+xml');
  return d.querySelector('parsererror')?'parse error':'ok'; }, svg);
t.ok(parsed==='ok', 'and it is well formed', parsed);

t.head('and the page needs nothing beside it');
/* It never needed the home-screen set, and now there is not one: the
   manifest, the apple-touch icon and the four PNGs went with phone mode,
   along with the meta tags that told a phone how to keep the page. What
   is left is the single file - mail it to yourself, open it anywhere. */
t.ok(await p.evaluate(()=>!document.querySelector('link[rel=manifest]')
       && !document.querySelector('link[rel="apple-touch-icon"]')),
     'no manifest and no touch icon to fetch');
t.ok(await p.evaluate(()=>![...document.querySelectorAll('meta')]
       .some(m=>/web-app/.test(m.name||''))),
     'and none of the add-to-home-screen meta tags');
t.ok(await p.evaluate(()=>document.querySelector('meta[name="theme-color"]').content
       ==='#0B0C0E'),
     'theme-color stays - it paints the browser chrome anywhere, not just '
     +'on a phone');
t.ok(await p.evaluate(()=>!!$('svg')), 'it still comes up');
t.ok(await p.evaluate(()=>document.querySelector('link[rel=icon]').href.indexOf('data:')===0),
     'still with its own icon in the tab');
t.ok(await p.evaluate(()=>!!$('dpt') && $('svg').querySelectorAll('text').length>10),
     'and the dial is drawn');

await t.done(b);
