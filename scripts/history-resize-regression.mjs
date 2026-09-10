#!/usr/bin/env node
// Real History + SplitDividerLayer in a private DEV instance. No global input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const port = Number(process.argv.find((s) => s.startsWith('--cdp='))?.slice(6) || 9226);
const out = process.argv.find((s) => s.startsWith('--out='))?.slice(6);
const only = process.argv.find((s) => s.startsWith('--case='))?.slice(7);
if (out) fs.mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const results = [], logs = [];
try {
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(p.url()));
  assert.ok(page);
  assert.equal(await page.evaluate(() => window.require('process').env.NOTED_E2E_TEST), 'true');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => logs.push(m.text()));
  const cdp = await page.context().newCDPSession(page);
  if (out) await page.screenshot({ path: path.join(out, 'window.png') });
  for (const scenario of ['width', 'height', 'corner', 'tail', 'container-width', 'window', 'click', 'reset', 'repeat']) {
    if (only && scenario !== only) continue;
    const count = await page.evaluate(async (scenario) => {
      const m = await import('/scripts/fixtures/history-resize.tsx?run=' + Date.now());
      window.__resizeFixture = m.mountHistoryResizeFixture(scenario === 'corner' ? 'corner' : scenario === 'height');
      if (scenario === 'window') window.__resizeFixture.host.style.width = 'calc(100vw - 200px)';
      if (scenario === 'reset') {
        const { useWorkspaceStore } = await import('/src/renderer/store/useWorkspaceStore.ts');
        useWorkspaceStore.getState().commitSplitSizes({ cols: [0.35, 0.65], rows: [[1], [1]] });
      }
      return window.__resizeFixture.histories.length;
    }, scenario);
    try {
      await page.waitForFunction(() => window.__resizeFixture.histories.every((f) => {
        const row = f.host.querySelector(`[data-uuid="${f.readerUuid}"]`);
        return row && row.getBoundingClientRect().height > 1000 && f.host.querySelector('[data-history-viewport-ready="1"]');
      }));
      const frames = async (count) => page.evaluate((count) => new Promise((resolve) => {
        let i = 0; const tick = () => ++i >= count ? resolve() : requestAnimationFrame(tick); requestAnimationFrame(tick);
      }), count);
      // Setup uses a known location in one long wrapping paragraph, NOT the
      // card top. All actual gestures under test below use trusted CDP input.
      await page.evaluate(() => window.__resizeFixture.histories.forEach((f, i) => {
        const s = f.host.querySelector('[data-virtuoso-scroller]');
        const row = f.host.querySelector(`[data-uuid="${f.readerUuid}"]`);
        s.scrollTop += row.getBoundingClientRect().top - s.getBoundingClientRect().top + 700 + i * 300;
      }));
      for (let i = 0; i < count; i++) {
        const point = await page.evaluate((i) => {
          const r = window.__resizeFixture.histories[i].host.querySelector('[data-virtuoso-scroller]').getBoundingClientRect();
          return { x: r.left + 80, y: r.top + 60 };
        }, i);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -4 });
      }
      if (scenario === 'tail') {
        await page.locator('[data-history-resize-fixture] [data-virtuoso-scroller]').first().press('End');
      }
      await frames(35);
      await page.evaluate(() => {
        const f = window.__resizeFixture;
        // Independent oracle: Blink's caret hit-test identifies the first
        // visible text, rather than calling the production anchor helper.
        f.points = f.histories.map((h) => {
          const s = h.host.querySelector('[data-virtuoso-scroller]');
          const row = h.host.querySelector(`[data-uuid="${h.readerUuid}"]`);
          const p = row.querySelector('p'), r = s.getBoundingClientRect();
          const hit = document.caretRangeFromPoint(p.getBoundingClientRect().left + 1, r.top + 8);
          if (!hit || hit.startContainer.nodeType !== Node.TEXT_NODE || !row.contains(hit.startContainer)) throw new Error('caret must hit the intended paragraph');
          const range = document.createRange(); range.setStart(hit.startContainer, hit.startOffset); range.setEnd(hit.startContainer, hit.startOffset + 1);
          return { uuid: h.readerUuid, text: hit.startContainer.textContent, offset: hit.startOffset, top: range.getBoundingClientRect().top - r.top };
        });
        f.measure = () => f.histories.map((h, i) => {
          const s = h.host.querySelector('[data-virtuoso-scroller]');
          const row = h.host.querySelector(`[data-uuid="${f.points[i].uuid}"]`);
          let top = null;
          if (row) {
            const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n;
            while ((n = walk.nextNode())) if (n.textContent === f.points[i].text) {
              const range = document.createRange(); range.setStart(n, f.points[i].offset); range.setEnd(n, f.points[i].offset + 1);
              top = range.getBoundingClientRect().top - s.getBoundingClientRect().top; break;
            }
          }
          return { top, gap: s ? s.scrollHeight - s.clientHeight - s.scrollTop : null,
            locked: !!h.host.querySelector('[data-history-resize-locked]'),
            loader: !!h.host.querySelector('[data-history-viewport-loader]'),
            scrollTop: s?.scrollTop, width: s?.clientWidth };
        });
      });
      const baseline = await page.evaluate(() => window.__resizeFixture.measure());
      await page.evaluate(() => {
        const f = window.__resizeFixture;
        f.samples = []; f.recording = true;
        const tick = () => {
          if (!f.recording || f.samples.length >= 480) return;
          f.samples.push({ phase: 'raf', panes: f.measure() });
          setTimeout(() => { if (f.recording) f.samples.push({ phase: 'post-paint', panes: f.measure() }); }, 0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const startLog = logs.length;
      if (scenario === 'container-width') {
        await page.evaluate(() => { window.__resizeFixture.host.style.width = '930px'; });
      } else if (scenario === 'window') {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 1120, deviceScaleFactor: 1, mobile: false });
      } else if (scenario === 'reset') {
        await page.locator('[data-history-resize-fixture] [data-split-divider]').first().dblclick();
      } else {
        for (const dx of scenario === 'repeat' ? [-155, 155, -80] : [-155]) {
        const selector = scenario === 'corner' ? '[data-split-corner]' : '[data-split-divider]';
        const divider = page.locator('[data-history-resize-fixture] ' + selector).first();
        const box = await divider.boundingBox(); assert.ok(box);
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        assert.equal(await page.evaluate(({ x, y, selector }) => !!document.elementFromPoint(x, y)?.closest(selector), { x, y, selector }), true, 'hit-test must reach the actual divider');
        await page.mouse.move(x, y); await page.mouse.down();
        try {
          if (scenario !== 'click') await page.mouse.move(x + (scenario === 'height' ? 0 : dx), y + (['height', 'corner'].includes(scenario) ? -110 : 0), { steps: 8 });
          const beforeWheel = await page.evaluate(() => window.__resizeFixture.measure());
          assert.ok(beforeWheel.every((v) => v.locked), 'both pane scrolls lock during resize');
          const point = await page.evaluate(() => {
            const r = window.__resizeFixture.histories[0].host.querySelector('[data-virtuoso-scroller]').getBoundingClientRect();
            return { x: r.left + 50, y: r.top + 50 };
          });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 180, buttons: 1 });
          await frames(3);
          const blocked = await page.evaluate(() => window.__resizeFixture.measure());
          assert.equal(blocked[0].scrollTop, beforeWheel[0].scrollTop, 'wheel cannot overwrite the frozen reading point');
        } finally { await page.mouse.up(); }
        if (scenario === 'repeat') {
          await page.waitForFunction(() => window.__resizeFixture.histories.every((h) => !h.host.querySelector('[data-history-resize-locked]') && !h.host.querySelector('[data-history-viewport-loader]')));
          await frames(15); // No scroll reset or fixture remount between gestures.
        }
        }
      }
      if (scenario !== 'click') {
        // Try to interrupt the real restoration too, not only the frozen drag.
        const point = await page.evaluate(() => {
          const f = window.__resizeFixture.histories[0];
          if (!f.host.querySelector('[data-history-resize-locked]')) return null;
          const r = f.host.querySelector('[data-history-content-stage]').getBoundingClientRect();
          return { x: r.left + 50, y: r.top + 50 };
        });
        if (point) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 90 });
      }
      await page.waitForFunction(() => window.__resizeFixture.histories.every((h) => !h.host.querySelector('[data-history-resize-locked]') && !h.host.querySelector('[data-history-viewport-loader]')));
      await frames(20);
      const after = await page.evaluate(() => window.__resizeFixture.measure());
      const drift = after.map((v, i) => scenario === 'tail' && i === 0 ? Math.abs(v.gap) : v.top === null ? Infinity : Math.abs(v.top - baseline[i].top));
      const samples = await page.evaluate(() => { const f = window.__resizeFixture; f.recording = false; return f.samples; });
      const paintedDrift = samples.filter((frame) => frame.phase === 'post-paint').flatMap((frame) => frame.panes.flatMap((v, i) => v.loader ? []
        : [scenario === 'tail' && i === 0 ? Math.abs(v.gap) : v.top === null ? Infinity : Math.abs(v.top - baseline[i].top)]));
      const maxPaintedDrift = Math.max(0, ...paintedDrift);
      const result = { scenario, baseline, after, drift, maxPaintedDrift, samples, logs: logs.slice(startLog).filter((s) => /RESIZE_|SplitResize|SCROLL_RESTORE/.test(s)) };
      results.push(result);
      if (out) { fs.writeFileSync(path.join(out, `${scenario}.json`), JSON.stringify(result, null, 2)); await page.locator('[data-history-resize-fixture]').screenshot({ path: path.join(out, `${scenario}.png`) }); }
      console.log(JSON.stringify({ scenario, drift, maxPaintedDrift, frames: samples.length }));
      assert.ok(drift.every((d) => d <= 2), JSON.stringify({ scenario, baseline, after, drift, logs: result.logs }));
      assert.ok(maxPaintedDrift <= 2, 'uncovered text must not jump between correct endpoints');
    } finally {
      await page.evaluate(() => { if (window.__resizeFixture) { window.__resizeFixture.recording = false; window.__resizeFixture.destroy(); } delete window.__resizeFixture; });
      if (scenario === 'window') await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
  }
  assert.deepEqual(errors, []);
} finally {
  if (out) { fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2)); fs.writeFileSync(path.join(out, 'renderer.log'), logs.join('\n')); }
  await browser.close();
}
