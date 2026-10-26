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
  for(const width of [320,390,768,1280]) for(const signed of [false,true]) {
   const page=await browser.newPage({viewport:{width,height:900}});
   if(signed) await page.route(server.url+'/',r=>r.fulfill({contentType:'text/html',body:home({env:{},url:new URL(server.url)},{isAdmin:true,user:{display_name:'Fixture'}})}));
   await page.goto(server.url);
   const brand=page.locator('header .brand-wordmark');
   assert.equal(await brand.evaluate(e=>getComputedStyle(e).visibility),'hidden');
   assert.equal(await page.locator('.preview').count(),0);
   assert.deepEqual(await page.locator('header nav a').allTextContents(),signed?['Dashboard','Agents','']:['Dashboard','Agents','Sign In','']);
   assert.equal(await page.locator('header nav a[href="/#features"],header nav a[href="/#guide"]').count(),0);
   assert.equal(await page.locator('header nav a[aria-label="Email support"]').getAttribute('href'),'mailto:support@fleetlink.online');
   assert.equal(await page.locator('header').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   const trip=await page.locator('.hero-intro').evaluate(e=>e.getBoundingClientRect().bottom+scrollY);
   await page.evaluate(y=>scrollTo(0,y-2),trip);
   assert.equal(await page.locator('header').evaluate(e=>e.classList.contains('is-scrolled')),false);
   await page.evaluate(y=>scrollTo(0,Math.ceil(y)+2),trip);
   await page.waitForFunction(()=>document.querySelector('header').classList.contains('is-scrolled'));
   assert.equal(await page.locator('header nav .home-dashboard').isVisible(),true);
   assert.equal(await page.locator('header nav .home-extra').first().isVisible(),false);
   assert.equal(await page.locator(signed?'header button':'header a[href="/login"]').isVisible(),true);
   await page.evaluate(()=>scrollTo(0,0));
   await page.waitForFunction(()=>!document.querySelector('header').classList.contains('is-scrolled'));
   const gap=await page.evaluate(()=>document.querySelector('#agents .grid-3').getBoundingClientRect().top-document.querySelector('#agents .split-head > a').getBoundingClientRect().bottom);
   assert.ok(gap>=23,'guide CTA has space before cards');
   assert.equal(await page.locator('#features a[href="/instructions"]').count(),0);
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
 const inputs=[
  ['favicon-light-512.png',readFileSync(new URL('../assets/web/favicon-light-512.png',import.meta.url)),512,1837989444],
  ['apple-touch-icon.png',readFileSync(new URL('../assets/web/apple-touch-icon.png',import.meta.url)),180,4000362361]
 ];
 // Inspect every ICO directory entry explicitly, not a browser-selected frame.
 const ico=readFileSync(new URL('../assets/web/favicon.ico',import.meta.url));
 assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),3);
 const hashes={16:2101515862,32:3509544480,48:978387178};const sizes=[];
 for(let i=0;i<ico.readUInt16LE(4);i++){
  const entry=6+i*16,size=ico[entry]||256;
  assert.equal(ico[entry+1]||256,size);assert.ok(Object.hasOwn(hashes,size));sizes.push(size);
  const offset=ico.readUInt32LE(entry+12),length=ico.readUInt32LE(entry+8);
  assert.ok(offset>=54&&offset+length<=ico.length,'valid frame bounds');
  const png=ico.subarray(offset,offset+length);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  inputs.push(['favicon.ico '+size,png,size,hashes[size]]);
 }
 assert.deepEqual(sizes.sort((a,b)=>a-b),[16,32,48]);
 const browser=await chromium.launch();const page=await browser.newPage();
 try {
  for(const [name,bytes,size,hash] of inputs){
   const decoded=await page.evaluate(async src=>{
    const image=new Image();image.src=src;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    const data=context.getImageData(0,0,canvas.width,canvas.height).data;
    // Hash inside the page so only three numbers cross the browser boundary.
    let hash=2166136261;for(const value of data) hash=Math.imul(hash^value,16777619)>>>0;
    return {width:canvas.width,height:canvas.height,hash};
   },'data:image/png;base64,'+bytes.toString('base64'));
   assert.deepEqual(decoded,{width:size,height:size,hash},name+' standalone pixels');
  }
 } finally {await browser.close();}
});
