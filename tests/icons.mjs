/* The home screen: the mark, the manifest, and the promise that the
   single file still works on its own when none of the rest is there. */
import {open, tally, APP} from './helpers.mjs';
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const t=tally();
const {b,p}=await open(t);
const root=new URL('..',import.meta.url).pathname;

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

t.head('and the phone is told how to keep it');
const head=await p.evaluate(()=>({
  touch:(document.querySelector('link[rel="apple-touch-icon"]')||{}).getAttribute
        ? document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href') : null,
  man:document.querySelector('link[rel=manifest]').getAttribute('href'),
  cap:(document.querySelector('meta[name="apple-mobile-web-app-capable"]')||{}).content,
  cap2:(document.querySelector('meta[name="mobile-web-app-capable"]')||{}).content,
  title:(document.querySelector('meta[name="apple-mobile-web-app-title"]')||{}).content,
  bar:(document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')||{}).content,
  theme:(document.querySelector('meta[name="theme-color"]')||{}).content}));
t.ok(head.touch==='icon-180.png',
     'a real PNG for Apple, which will not take a data URI', String(head.touch));
t.ok(head.man==='manifest.webmanifest', 'a manifest', String(head.man));
t.ok(head.cap==='yes' && head.cap2==='yes',
     'it opens without the browser around it, on both phones');
t.ok(head.title==='Helm', 'and is called Helm under the icon', String(head.title));
t.ok(head.bar==='black-translucent',
     'the page goes under the status bar, which is what a round face wants');
t.ok(head.theme==='#0B0C0E', 'and the notch is painted to match', String(head.theme));

t.head('the manifest says the same things, in its own words');
const M=JSON.parse(readFileSync(root+'manifest.webmanifest','utf8'));
t.ok(M.name==='Confluence Helm' && M.short_name==='Helm', 'the name and the short one',
     M.name+' / '+M.short_name);
t.ok(M.display==='standalone', 'standalone: no address bar sliding over the dial',
     M.display);
t.ok(M.start_url==='confluence_helm.html', 'and it opens the page itself', M.start_url);
t.ok(M.background_color===M.theme_color && M.theme_color==='#0B0C0E',
     'on the page\'s own black, so the splash does not flash white');
t.ok(M.icons.length===3, 'three icons', String(M.icons.length));
t.ok(M.icons.some(i=>i.sizes==='192x192') && M.icons.some(i=>i.sizes==='512x512'),
     'the two sizes Android asks for');
t.ok(M.icons.some(i=>i.purpose==='maskable'),
     'and one maskable, for the launchers that crop it round');
t.ok(M.icons.every(i=>i.type==='image/png'), 'all of them PNG');

t.head('and the files those names promise are actually there');
const png=f=>{ const p=root+f; if(!existsSync(p)) return null;
  const buf=readFileSync(p);
  if(buf.slice(0,8).toString('hex')!=='89504e470d0a1a0a') return {bad:'not a PNG'};
  return {w:buf.readUInt32BE(16), h:buf.readUInt32BE(20), bytes:buf.length}; };
for(const [f,size] of [['icon-180.png',180],['icon-192.png',192],
                       ['icon-512.png',512],['icon-maskable-512.png',512]]){
  const i=png(f);
  t.ok(i && i.w===size && i.h===size, f+' is a square '+size+' PNG',
       i?JSON.stringify(i):'missing');
}
t.ok(existsSync(root+'icon.svg'), 'and the drawing they were all rendered from is kept');
const src=readFileSync(root+'icon.svg','utf8');
t.ok(/#4A9EFF/i.test(src) && /#0B0C0E/i.test(src),
     'in the same two colours as the favicon');

t.head('the mark is the waves, not a screenshot');
/* Corners black, the middle carrying the accent: enough to catch a
   rendering that came out empty or inverted, which is the failure that
   actually happens. */
const px=await p.evaluate(async src=>{
  const img=new Image(); img.src=src;
  await img.decode();
  const c=document.createElement('canvas'); c.width=c.height=img.width;
  const x=c.getContext('2d'); x.drawImage(img,0,0);
  const at=(u,v)=>{ const d=x.getImageData(Math.round(u*img.width),
                                           Math.round(v*img.height),1,1).data;
                    return [d[0],d[1],d[2]]; };
  /* Down the middle rather than at one point: the accent wave is a
     stroke a few pixels thick and the exact centre of the square falls
     between two of them as often as on one. */
  let best=[0,0,0];
  for(let v=0.2; v<0.8; v+=0.01){ const q=at(0.5,v);
    if(q[2]-q[0] > best[2]-best[0]) best=q; }
  return {size:img.width, tl:at(0.04,0.04), br:at(0.96,0.96), mid:best};
}, new URL('icon-192.png', APP).href);
t.ok(px.size===192, 'the file the manifest names loads as an image', String(px.size));
t.ok(px.tl.every(v=>v<40) && px.br.every(v=>v<40),
     'the corners are the page\'s black', px.tl.join(',')+' / '+px.br.join(','));
t.ok(px.mid[2]>px.mid[0]+40, 'and the wave through the middle is the blue one',
     px.mid.join(','));

t.head('deploy puts the whole set on the boat, not just the page');
const dep=readFileSync(root+'deploy.sh','utf8');
for(const f of ['icon-180.png','icon-192.png','icon-512.png',
                'icon-maskable-512.png','manifest.webmanifest'])
  t.ok(dep.indexOf(f)>0, f+' is copied across');

t.head('and none of it is needed for the page to work');
/* The single file, mailed to yourself and opened on its own: no
   manifest, no PNGs, nothing but the HTML. */
const {b:b2,p:p2}=await open(t,{routes:{'**/icon-*.png':r=>r.abort(),
                                        '**/manifest.webmanifest':r=>r.abort()}});
t.ok(await p2.evaluate(()=>!!$('svg')), 'it still comes up');
t.ok(await p2.evaluate(()=>document.querySelector('link[rel=icon]').href.indexOf('data:')===0),
     'still with its own icon in the tab');
t.ok(await p2.evaluate(()=>!!$('dpt') && $('svg').querySelectorAll('text').length>10),
     'and the dial is drawn');
await b2.close();

await t.done(b);
