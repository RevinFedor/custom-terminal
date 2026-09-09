#!/usr/bin/env node
// Controlled height changes in the REAL HistoryPanel + Virtuoso. User input
// is trusted CDP wheel/keyboard. This is not a production transcript replay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.argv.find((a) => a.startsWith('--cdp='))?.split('=')[1] || 9226);
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const only = process.argv.find((a) => a.startsWith('--scenario='))?.slice(11);
if (out) fs.mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const results = [];
const logs = [];
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(p.url()));
  assert.ok(page, 'private DEV renderer required');
  assert.equal(await page.evaluate(() => window.require('process').env.NOTED_E2E_TEST), 'true');
  assert.ok(await page.evaluate(() => window.require('process').env.NOTED_USER_DATA_DIR));
  page.on('console', (message) => logs.push(message.text()));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (out) await page.screenshot({ path: path.join(out, 'window-before.png') });
  for (const scenario of ['resize-up', 'resize-down', 'ordinary-return', 'fast-wheel', 'keyboard', 'scrollbar']) {
    if (only && scenario !== only) continue;
    const info = await page.evaluate(async () => {
      const m = await import('/scripts/fixtures/history-preview-reading.tsx');
      const f = window.__seekFixture = m.mountHistoryPreviewFixture();
      return { id: f.id, tabId: f.tabId };
    });
    const host = page.locator(`[data-history-preview-fixture="${info.id}"]`);
    try {
      await host.locator('[data-history-viewport-ready="1"]').waitFor();
      await page.waitForFunction(() => {
        const f = window.__seekFixture;
        const row = f.host.querySelector(`[data-uuid="${f.readerUuid}"][data-history-row-real]`);
        return row && row.getBoundingClientRect().height > 1000 && !f.host.querySelector('[data-history-mount-shell]');
      });
      const scroller = host.locator('[data-virtuoso-scroller]');
      if (scenario === 'fast-wheel' || scenario === 'scrollbar') {
        // Positive control: measured displacement must actually exceed the
        // threshold. Cold resize compensation can cancel most of a fling
        // inside one sample; that is not proof that fast seek was disabled.
        await scroller.press('Home');
        await page.evaluate(async () => {
          const s = window.__seekFixture.host.querySelector('[data-virtuoso-scroller]');
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          s.scrollTop = 0;
          await frame(); await frame();
          for (let i = 0; i < 80; i++) {
            s.scrollTop += 500;
            await frame(); await frame();
            if (s.scrollHeight - s.clientHeight - s.scrollTop <= 2) break;
          }
        });
      }
      await scroller.press('End');
      // Set a mid-list baseline away from physical-bottom and initial restore.
      await page.evaluate(() => {
        const s = window.__seekFixture.host.querySelector('[data-virtuoso-scroller]');
        s.scrollTop = s.scrollHeight - s.clientHeight - 1200;
      });
      await page.waitForFunction(() => {
        const f = window.__seekFixture;
        const slots = [...f.host.querySelectorAll('[data-item-index][data-known-size]')];
        return slots.length > 2 && slots.every((s) => Math.abs(Math.round(s.getBoundingClientRect().height) - Number(s.dataset.knownSize)) <= 1);
      });
      // Frame budget is observation setup, not a substitute for a ready gate.
      await page.evaluate(() => new Promise((resolve) => {
        let n = 0; const tick = () => ++n >= 40 ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
      }));
      if (['ordinary-return', 'fast-wheel', 'scrollbar'].includes(scenario)) {
        await page.evaluate(() => window.__seekFixture.show(false));
        await page.evaluate(() => window.__seekFixture.show(true));
        await host.locator('[data-history-presented="1"]').waitFor();
      }
      const point = await scroller.evaluate((s) => {
        const r = s.getBoundingClientRect();
        return { x: r.left + 300, y: r.top + 350 };
      });
      await page.mouse.move(point.x, point.y);
      const logStart = logs.length;
      await page.evaluate(() => {
        const f = window.__seekFixture;
        const s = f.host.querySelector('[data-virtuoso-scroller]');
        const samples = [];
        window.__seekProof = { samples, done: false, initialHeight: s.scrollHeight };
        const tick = () => {
          const same = s.isConnected && f.host.querySelector('[data-virtuoso-scroller]') === s;
          samples.push({ top: s.scrollTop, height: s.scrollHeight, same,
            rows: s.querySelectorAll('[data-history-row-real]').length,
            seek: s.querySelectorAll('[data-history-seek-placeholder]').length,
            mask: s.hasAttribute('data-history-seek-geometry-settling') });
          // Include the whole existing 120-active-frame anchor settle budget,
          // not just the seek enter/exit interval that starts before it.
          if (samples.length < 240) requestAnimationFrame(tick); else window.__seekProof.done = true;
        };
        requestAnimationFrame(tick);
      });
      if (scenario.startsWith('resize-')) {
        await page.mouse.wheel(0, scenario === 'resize-up' ? -125 : 125);
        await page.evaluate(() => {
          const f = window.__seekFixture;
          const slots = [...f.host.querySelectorAll('[data-item-index][data-known-size]')]
            .filter((s) => Number(s.dataset.itemIndex) > 0).slice(0, 3);
          if (slots.length !== 3) throw new Error('three measured slots required');
          const rules = [];
          window.__seekProof.changedRows = slots.map((slot, i) => {
            const row = slot.querySelector('[data-history-row-real]');
            const delta = [1784, 3051, 843][i];
            const before = slot.getBoundingClientRect().height;
            // The producer must survive virtualization/remount. A one-off
            // style mutation on the old DOM disappeared before the velocity
            // sample and accidentally made the dangerous scenario pass.
            const key = row.getAttribute('data-history-unit-key');
            rules.push(`[data-history-unit-key="${CSS.escape(key)}"] { padding-bottom: ${parseFloat(getComputedStyle(row).paddingBottom) + delta}px !important; }`);
            return { index: Number(slot.dataset.itemIndex), before, delta };
          });
          const style = document.createElement('style');
          style.textContent = rules.join('\n');
          f.host.appendChild(style);
        });
      } else if (scenario === 'fast-wheel') {
        await page.mouse.wheel(0, -4);
        await page.mouse.wheel(0, -4200);
      } else if (scenario === 'keyboard') {
        await scroller.press('Home');
      } else if (scenario === 'scrollbar') {
        const bar = await scroller.evaluate((s) => {
          const r = s.getBoundingClientRect();
          return { x: r.right - 2, y: r.top + s.clientHeight * (s.scrollTop + s.clientHeight / 2) / s.scrollHeight,
            targetY: r.top + 25, gutter: s.offsetWidth - s.clientWidth };
        });
        assert.ok(bar.gutter > 0, 'test target must expose a physical scrollbar gutter');
        await page.mouse.move(bar.x, bar.y);
        await page.mouse.down();
        try { await page.mouse.move(bar.x, bar.targetY, { steps: 5 }); }
        finally { await page.mouse.up(); }
      } else {
        for (const dy of [-4, -25, -40, -50]) await page.mouse.wheel(0, dy);
      }
      await page.waitForFunction(() => window.__seekProof.done);
      const proof = await page.evaluate(() => window.__seekProof);
      const localLogs = logs.slice(logStart).filter((line) => line.includes(info.tabId.slice(-12)));
      const enters = localLogs.filter((line) => line.includes('SCROLL_SEEK_ENTER'));
      const rejected = localLogs.filter((line) => line.includes('SCROLL_SEEK_REJECT'));
      const result = { scenario, samples: proof.samples.length, enters: enters.length, rejected,
        heightDelta: Math.max(...proof.samples.map((s) => s.height)) - proof.initialHeight,
        emptyFrames: proof.samples.filter((s) => s.rows === 0).length,
        maskFrames: proof.samples.filter((s) => s.mask).length,
        sameScroller: proof.samples.every((s) => s.same),
      };
      results.push(result);
      if (out) {
        fs.writeFileSync(path.join(out, `${scenario}.json`), JSON.stringify({ result, proof, logs: localLogs }, null, 2));
        await host.screenshot({ path: path.join(out, `${scenario}.png`) });
      }
      assert.equal(result.sameScroller, true);
      assert.ok(proof.samples.at(-1).rows > 0 && !proof.samples.at(-1).mask, 'real rows must return without another gesture');
      if (scenario === 'resize-up') {
        assert.ok(result.heightDelta >= 5676, 'actual large ResizeObserver change required');
        assert.ok(rejected.length > 0, 'the dangerous measured sample must actually reach the gate');
      }
      if (['resize-up', 'resize-down', 'ordinary-return'].includes(scenario)) {
        assert.equal(result.enters, 0, JSON.stringify(result));
        assert.equal(result.emptyFrames, 0, JSON.stringify(result));
        assert.equal(result.maskFrames, 0, JSON.stringify(result));
      } else if (scenario === 'fast-wheel' || scenario === 'scrollbar') {
        assert.ok(result.enters > 0, 'genuine fast wheel still enables seek');
        assert.ok(proof.samples.at(-1).rows > 0 && !proof.samples.at(-1).mask, 'real rows return');
      }
      console.log(JSON.stringify(result));
    } finally {
      await page.evaluate(() => { window.__seekFixture?.destroy(); delete window.__seekFixture; });
    }
  }
  assert.deepEqual(errors, []);
} finally {
  if (out) {
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(out, 'renderer.log'), logs.join('\n'));
  }
  await browser.close();
}
