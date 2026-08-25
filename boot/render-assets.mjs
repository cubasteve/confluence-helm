/* =====================================================================
   Regenerate the Plymouth splash assets from the app's own geometry.

     node boot/render-assets.mjs

   Needs Playwright and Poppins installed, so it runs on a workstation,
   not the Pi - the Pi only ever sees the PNGs. Rerun it if #boot's
   layout changes in confluence_helm.html, then update the two numbers
   in theme/confluence.script that the wordmark crop feeds (see the
   README).
   ===================================================================== */
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const OUT='/home/user/confluence-helm/boot/theme';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});

/* The dusk palette, verbatim from confluence_helm.html. Plymouth cannot
   know what the app will resolve to, and of the three a dark splash is
   the one that never blinds anyone. */
const INK='#F2F4F6', LABEL='#6C757C', DIM='#9AA2A9', ACC='#4A9EFF';

/* Identical geometry to #boot: same amplitudes, wavelengths, phases and
   centre lines, so the handoff is the same picture. */
const WAVES=[
  {n:1, amp:30, wl:360, ph:0.0, y:542, col:LABEL, sw:7},
  {n:2, amp:38, wl:540, ph:1.9, y:660, col:ACC,   sw:9},
  {n:3, amp:24, wl:270, ph:3.4, y:778, col:DIM,   sw:7},
];
const sine=(amp,wl,ph,cy)=>{
  let d='';
  for(let x=0;x<=2160;x+=6) d+=(x?'L':'M')+x+' '+(cy+amp*Math.sin((x/wl)*Math.PI*2+ph)).toFixed(1);
  return d;
};
const meta=[];
for(const w of WAVES){
  const h=Math.ceil(2*w.amp+w.sw+4);
  const p=await b.newPage({viewport:{width:2160,height:h}});
  await p.setContent(`<style>html,body{margin:0;background:transparent}</style>
   <svg width="2160" height="${h}" viewBox="0 0 2160 ${h}">
     <path d="${sine(w.amp,w.wl,w.ph,h/2)}" fill="none" stroke="${w.col}"
       stroke-width="${w.sw}" stroke-linecap="round"/></svg>`);
  await p.screenshot({path:`${OUT}/wave${w.n}.png`, omitBackground:true});
  await p.close();
  meta.push({file:`wave${w.n}.png`, w:2160, h, top:w.y-h/2});
  console.log(`  wave${w.n}.png  2160x${h}  centre y ${w.y}  top ${w.y-h/2}`);
}

/* The wordmark at the app's own coordinates in a full-panel canvas, so
   Plymouth places it at 0,0 and needs no arithmetic of its own. */
const p=await b.newPage({viewport:{width:1080,height:1080}});
await p.setContent(`<style>html,body{margin:0;background:transparent}
  /* dominant-baseline:middle, because confluence_helm.html sets it on
     every <text> globally - so its y is the type's middle, not its
     baseline. Without this the splash sits 22 px above the app's. */
  text{font-family:'Poppins',sans-serif;text-anchor:middle;dominant-baseline:middle}
  .m{font-size:82px;font-weight:300;fill:${INK};letter-spacing:.2em}
  .s{font-size:26px;font-weight:500;fill:${LABEL};letter-spacing:.44em}</style>
  <svg width="1080" height="1080" viewBox="0 0 1080 1080">
    <text class="m" x="540" y="392">CONFLUENCE</text>
    <text class="s" x="540" y="462">HELM</text></svg>`);
await p.waitForTimeout(300);
await p.screenshot({path:`${OUT}/wordmark.png`, omitBackground:true});
console.log('  wordmark.png 1080x1080 (transparent, app coordinates)');
await b.close();
