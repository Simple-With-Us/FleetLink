import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {readFileSync,readdirSync} from 'node:fs';
import {makeEnv} from '../test/helpers/harness.mjs';
import {serve} from '../test/helpers/server.mjs';
import {home} from '../worker/lib/pages/marketing.mjs';

test('landing branding, playback and safe policy fallbacks on signed-in/out mobile and desktop',async()=>{
 const env=await makeEnv();
 const media=new URL('../assets/web/media/',import.meta.url);
 for(const n of readdirSync(media)) await env.FLEET_SHARES.put('site/media/'+n,readFileSync(new URL(n,media)));
 const server=await serve(env);const browser=await chromium.launch();
 try {
  for(const width of [390,1280]) for(const signed of [false,true]) {
   const page=await browser.newPage({viewport:{width,height:900}});
   if(signed) await page.route(server.url+'/',r=>r.fulfill({contentType:'text/html',body:home({env:{},url:new URL(server.url)},{isAdmin:true,user:{display_name:'Fixture'}})}));
   await page.goto(server.url);
   const brand=page.locator('header .brand-wordmark');
   assert.equal(await brand.evaluate(e=>getComputedStyle(e).visibility),'hidden');
   assert.equal(await page.locator('.preview').count(),0);
   assert.match(await page.locator('footer .brand img').getAttribute('src'),/fleetlink-wordmark.png/);
   await page.waitForFunction(()=>{const v=document.querySelector('.hero-intro video');return !v.paused&&v.currentTime>0.1;});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
   await page.evaluate(()=>scrollTo(0,650));
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('header .brand-wordmark')).visibility==='visible');
   const noOverlap=await page.evaluate(()=>{
    const b=document.querySelector('header .brand').getBoundingClientRect();
    return [...document.querySelectorAll('header nav a,header nav button')].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0).every(e=>{const r=e.getBoundingClientRect();return r.left>=b.right||r.top>=b.bottom||r.bottom<=b.top;});
   });
   assert.ok(noOverlap,'wordmark and navigation do not overlap');
   await page.close();
  }
  const reduced=await browser.newPage({reducedMotion:'reduce'});
  const reducedRequests=[];
  reduced.on('request',r=>{if(r.url().endsWith('.mp4')) reducedRequests.push(r.url());});
  await reduced.goto(server.url);
  assert.equal(reducedRequests.length,0,'reduced motion does not download the video');
  assert.equal(await reduced.locator('.hero-intro video').isVisible(),false);
  assert.match(await reduced.locator('.hero-intro picture img').getAttribute('src'),/\.jpg$/);
  await reduced.close();
  const denied=await browser.newPage();
  await denied.addInitScript(()=>{HTMLMediaElement.prototype.play=()=>Promise.reject(new DOMException('Playback denied','NotAllowedError'));});
  await denied.goto(server.url);
  await denied.waitForFunction(()=>document.querySelector('.hero-intro video').hidden);
  assert.equal(await denied.locator('.hero-intro picture').isVisible(),true);
  await denied.close();
  const missing=await browser.newPage();
  await missing.route('**/*.mp4',r=>r.abort());
  await missing.goto(server.url);
  await missing.waitForFunction(()=>document.querySelector('.hero-intro video').hidden);
  assert.equal(await missing.locator('.hero-intro picture').isVisible(),true);
  await missing.close();
 } finally {await browser.close();await server.close();}
});

test('standalone browser icon pixels stay correct independent of container encoding',async()=>{
 const {createHash}=await import('node:crypto');
 const browser=await chromium.launch();const page=await browser.newPage();
 try {
  // Pin decoded RGBA pixels from the independently inspected standalone art.
  const cases=[
   ['favicon-light-512.png',512,512,'1ce7489400b6aa3497120dce0aba7a7f3d9cdb1dfdf8c634e896679b4b5bc45b'],
   ['favicon.ico',48,48,'9bf1ec20fcfad2893f5ed3c6640892955197fed877e5e7012249d11cf1b8634c'],
   ['apple-touch-icon.png',180,180,'5500e939ae0feea8b127bb2cf3bf4d23dd78ca8b7396e5143820bc2bcc8a09ac']
  ];
  for(const [name,width,height,hash] of cases){
   const mime=name.endsWith('.ico')?'image/x-icon':'image/png';
   const src='data:'+mime+';base64,'+readFileSync(new URL('../assets/web/'+name,import.meta.url)).toString('base64');
   const decoded=await page.evaluate(async src=>{
    const image=new Image();image.src=src;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    return {width:canvas.width,height:canvas.height,pixels:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
   },src);
   assert.equal(decoded.width,width,name);assert.equal(decoded.height,height,name);
   assert.equal(createHash('sha256').update(Buffer.from(decoded.pixels)).digest('hex'),hash,name+' standalone pixels');
  }
 } finally {await browser.close();}
});
