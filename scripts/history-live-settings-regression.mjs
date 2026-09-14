#!/usr/bin/env node
// Real History/Virtuoso, controlled incoming transcript records, trusted wheel.
// Never sends a command to an AI process or connects to production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const arg = (name) => process.argv.find((s) => s.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const out = arg('out');
if (out) fs.mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${arg('cdp') || 9226}`);
const results = [], logs = [], errors = [];
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(p.url()));
  assert.ok(page);
  assert.equal(await page.evaluate(() => window.require('process').env.NOTED_E2E_TEST), 'true');
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  if (out) await page.screenshot({ path: path.join(out, 'window.png') });
  const frames = (n) => page.evaluate((n) => new Promise((resolve) => {
    let i=0; const tick=()=>++i>=n?resolve():requestAnimationFrame(tick); requestAnimationFrame(tick);
  }), n);
  for (const scenario of ['tail', 'reading', 'hidden']) {
    if (arg('case') && arg('case') !== scenario) continue;
    await page.evaluate(async () => {
      const { mountHistoryPreviewFixture } = await import('/scripts/fixtures/history-preview-reading.tsx');
      const f = window.__settingsFixture = mountHistoryPreviewFixture({ provider: 'claude' });
      f.modelUuid = f.id + '-model'; f.effortUuid = f.id + '-effort'; f.promptUuid = f.id + '-prompt';
      f.services = [
        { uuid: f.modelUuid, name: 'model', args: 'claude-fable-5[1m]', offset: 100 },
        { uuid: f.effortUuid, name: 'effort', args: 'max', offset: 200 },
      ].map((x) => ({ ...x, timestamp: new Date(1_800_000_000_000 + x.offset).toISOString() }));
      f.sendServices = () => f.services.forEach((x) => f.emitLiveRecord({ type: 'user', uuid: x.uuid,
        isMeta: true, serviceCarrier: 'local-setting', timestamp: x.timestamp,
        message: { role: 'user', content: `<command-name>/${x.name}</command-name>\n<command-args>${x.args}</command-args>` },
      }, x.offset));
      f.durableServices = f.services.map((x) => ({ uuid:x.uuid, role:'slash', content:`/${x.name} ${x.args}`,
        timestamp:x.timestamp, recordByteOffset:x.offset }));
      f.prompt = { uuid: f.promptUuid, role:'user', content:'Проверка после compact и смены модели',
        timestamp:new Date(1_800_000_000_300).toISOString(), recordByteOffset:300 };
    });
    try {
      await page.waitForFunction(() => {
        const f=window.__settingsFixture, row=f.host.querySelector(`[data-uuid="${f.readerUuid}"][data-history-row-real]`);
        return row && row.getBoundingClientRect().height>1000 && !f.host.querySelector('[data-history-mount-shell]');
      });
      await page.evaluate(async () => {
        const f=window.__settingsFixture;
        await f.appendDurable([{uuid:f.id+'-compact',role:'compact',content:'COMPACTED',recordByteOffset:50,
          timestamp:new Date(1_800_000_000_050).toISOString()}]);
      });
      await page.waitForFunction(() => !!window.__settingsFixture.host.querySelector(`[data-uuid="${window.__settingsFixture.id}-compact"][data-history-row-real]`));
      await page.evaluate(() => {
        const f=window.__settingsFixture; f.setBusy(true); f.sendServices();
        f.emitLiveRecord({type:'user',uuid:f.promptUuid,timestamp:f.prompt.timestamp,message:{role:'user',content:f.prompt.content}},300);
      });
      await page.waitForFunction(() => !!window.__settingsFixture.host.querySelector(`[data-uuid="${window.__settingsFixture.promptUuid}"][data-history-row-real]`));
      await frames(10);
      await page.evaluate(() => {
        const f=window.__settingsFixture;
        f.scroller=f.host.querySelector('[data-virtuoso-scroller]');
        f.samples=[]; f.recording=true;
        f.measure=()=>({ top:f.scroller.scrollTop, height:f.scroller.scrollHeight,
          gap:f.scroller.scrollHeight-f.scroller.clientHeight-f.scroller.scrollTop,
          model:f.host.querySelectorAll(`[data-uuid="${f.modelUuid}"][data-history-row-real]`).length,
          effort:f.host.querySelectorAll(`[data-uuid="${f.effortUuid}"][data-history-row-real]`).length,
          sameScroller:f.scroller===f.host.querySelector('[data-virtuoso-scroller]'),
          readerTop:f.host.querySelector(`[data-uuid="${f.readerUuid}"][data-history-row-real]`)?.getBoundingClientRect().top,
        });
        const tick=()=>{if(!f.recording)return; f.samples.push(f.measure());requestAnimationFrame(tick)};
        requestAnimationFrame(tick);
      });
      const initial = await page.evaluate(() => window.__settingsFixture.measure());
      assert.equal(initial.model,1); assert.equal(initial.effort,1);
      if (scenario === 'hidden') await page.evaluate(() => window.__settingsFixture.show(false));
      await page.evaluate(async () => { const f=window.__settingsFixture; await f.appendDurable([...f.durableServices, f.prompt,
        {uuid:f.id+'-commit-proof',role:'assistant',content:'Полная история применена',recordByteOffset:310,
          timestamp:new Date(1_800_000_000_310).toISOString()}]); });
      if (scenario === 'hidden') await page.evaluate(() => window.__settingsFixture.show(true));
      await page.waitForFunction(() => !!window.__settingsFixture.host.querySelector(`[data-uuid="${window.__settingsFixture.id}-commit-proof"][data-history-row-real]`));
      await frames(15);
      if (scenario === 'reading') {
        const pos = await page.evaluate(() => {
          const f=window.__settingsFixture,r=f.scroller.getBoundingClientRect();
          return {x:r.left+100,y:r.top+200};
        });
        await page.mouse.move(pos.x,pos.y); await page.mouse.wheel(0,-240); await frames(25);
      }
      const readingStart = await page.evaluate(() => window.__settingsFixture.measure());
      const stableStart = await page.evaluate(() => window.__settingsFixture.samples.length);
      if(scenario==='reading') assert.ok(Number.isFinite(readingStart.readerTop),'read anchor must exist before updates');
      await page.evaluate(() => window.__settingsFixture.setBusy(true));
      for(let i=0;i<18;i++) {
        await page.evaluate((i)=>{
          const f=window.__settingsFixture; f.sendServices();
          // A new assistant frame makes React reconcile the same retained list.
          f.emitLiveRecord({type:'assistant',uuid:f.id+'-working',timestamp:new Date(1_800_000_000_400).toISOString(),
            message:{role:'assistant',content:[{type:'text',text:'Working '+i+'. Проверяем обновление после настройки.'}]}},400);
        },i);
        await frames(3);
        if (scenario === 'tail' && i % 3 === 2) {
          const rect = await page.evaluate(() => {
            const r=window.__settingsFixture.scroller.getBoundingClientRect(); return {x:r.left+100,y:r.top+150};
          });
          await page.mouse.move(rect.x,rect.y);
          await page.mouse.wheel(0,-1100); await frames(15);
          await page.mouse.wheel(0,1100); await frames(20);
        }
      }
      await frames(15);
      const end = await page.evaluate(() => {const f=window.__settingsFixture; f.recording=false;return {after:f.measure(),samples:f.samples}});
      const maxCopies = Math.max(...end.samples.map((s)=>Math.max(s.model,s.effort)));
      const result={scenario,initial,readingStart,after:end.after,maxCopies,samples:end.samples};
      results.push(result);
      if(out) { fs.writeFileSync(path.join(out,scenario+'.json'),JSON.stringify(result,null,2)); await page.screenshot({path:path.join(out,scenario+'.png')}); }
      console.log(JSON.stringify({scenario,maxCopies,after:end.after}));
      assert.equal(maxCopies,1,'one physical setting must never produce duplicate DOM rows');
      assert.ok(end.samples.every(s=>s.sameScroller),'canonical adoption must retain the list');
      if(scenario==='reading') assert.ok(end.samples.slice(stableStart).every(s=>Number.isFinite(s.readerTop)
        && Math.abs(s.readerTop-readingStart.readerTop)<=2),'new records below viewport must not move read text in any frame');
      else assert.ok(end.after.gap<=2,'tail stays at the physical bottom');
      assert.ok(!logs.some(s=>/same key/.test(s)), 'no duplicate React keys');
      assert.deepEqual(errors,[]);
    } finally {
      await page.evaluate(()=>{if(window.__settingsFixture){window.__settingsFixture.recording=false;window.__settingsFixture.destroy();delete window.__settingsFixture}});
    }
  }
} finally {
  if(out) {fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(results,null,2));fs.writeFileSync(path.join(out,'renderer.log'),logs.join('\n'));}
  await browser.close();
}
