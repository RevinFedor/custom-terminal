#!/usr/bin/env node
// Private Electron DEV only. User scroll is trusted CDP input; transcript
// completion is a controlled incoming protocol event, not a real AI request.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const port = Number(process.argv.find((arg) => arg.startsWith('--cdp='))?.split('=')[1] || 9226);
const onlyScenario = process.argv.find((arg) => arg.startsWith('--scenario='))?.split('=')[1];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const results = [];
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(candidate.url()));
  assert.ok(page, 'expected a separately owned DEV renderer');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => { window.__handoffFixture?.destroy(); });
  const cases = [
    ['codex', 'above'], ['codex', 'preview'], ['codex', 'tail'],
    ['codex', 'clear-first'], ['codex', 'hidden'], ['codex', 'move-while-waiting'],
    ['claude', 'above'], ['claude', 'preview'], ['claude', 'tail'],
  ];
  for (const [provider, scenario] of cases) {
    if (onlyScenario && scenario !== onlyScenario) continue;
    const info = await page.evaluate(async (provider) => {
      const module = await import('/scripts/fixtures/history-preview-reading.tsx');
      window.__handoffFixture = module.mountHistoryPreviewFixture({ provider });
      return { id: window.__handoffFixture.id };
    }, provider);
    const host = page.locator(`[data-history-preview-fixture="${info.id}"]`);
    try {
      await host.locator('[data-history-viewport-ready="1"]').waitFor();
      // A painted viewport may still be a cold mount wave. This scenario is
      // reading a loaded answer, so wait for that exact real row and sizes.
      await page.waitForFunction(() => {
        const f = window.__handoffFixture;
        const row = f.host.querySelector(`[data-uuid="${f.readerUuid}"][data-history-row-real]`);
        const slots = Array.from(f.host.querySelectorAll('[data-item-index][data-known-size]'));
        return row && row.getBoundingClientRect().height > 1000
          && !f.host.querySelector('[data-history-mount-shell]')
          && slots.every((node) => Math.abs(Math.round(node.getBoundingClientRect().height)
            - Number(node.getAttribute('data-known-size'))) <= 1);
      });
      await page.evaluate(() => window.__handoffFixture.preview());
      await host.locator('[data-history-terminal-preview]').waitFor();
      // Establish the user's starting intent explicitly. Cold mount/previous
      // cases are not evidence that this panel currently follows its tail.
      await host.locator('[data-virtuoso-scroller]').press('End');
      await page.waitForFunction(() => {
        const s = window.__handoffFixture.host.querySelector('[data-virtuoso-scroller]');
        return s && s.scrollHeight - s.clientHeight - s.scrollTop <= 2;
      });
      const position = async (mode) => {
        const coords = await page.evaluate((mode) => {
          const f = window.__handoffFixture;
          const s = f.host.querySelector('[data-virtuoso-scroller]');
          const preview = f.host.querySelector('[data-history-terminal-preview]');
          const rect = s.getBoundingClientRect();
          if (mode === 'tail') s.scrollTop = s.scrollHeight;
          else s.scrollTop += preview.getBoundingClientRect().top - rect.top - (mode === 'preview' ? -200 : 1619);
          return { x: rect.left + 200, y: rect.top + 350 };
        }, mode);
        await page.mouse.move(coords.x, coords.y);
        const quiet = mode === 'tail' ? null : page.waitForEvent('console', { predicate: (message) =>
          message.text().includes('SCROLL_GESTURE_END') && message.text().includes(info.id.slice(-8) + '-tab'),
        });
        await page.mouse.wheel(0, mode === 'tail' ? 4 : -4);
        try { await page.waitForFunction((mode) => {
          const f = window.__handoffFixture;
          const s = f.host.querySelector('[data-virtuoso-scroller]');
          const p = f.host.querySelector('[data-history-terminal-preview]');
          const top = p.getBoundingClientRect().top - s.getBoundingClientRect().top;
          return mode === 'tail' ? s.scrollHeight - s.clientHeight - s.scrollTop <= 2
            : mode === 'preview' ? top < 0 && top + p.getBoundingClientRect().height > s.clientHeight / 2
              : top > s.clientHeight;
        }, mode); } catch (error) {
          console.log('setup', await page.evaluate(() => {
            const f = window.__handoffFixture, s = f.host.querySelector('[data-virtuoso-scroller]');
            const p = f.host.querySelector('[data-history-terminal-preview]');
            return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight,
              previewTop: p.getBoundingClientRect().top - s.getBoundingClientRect().top,
              previewHeight: p.getBoundingClientRect().height, active: document.activeElement?.tagName };
          }));
          throw error;
        }
        if (quiet) await quiet;
      };
      await position(scenario === 'tail' ? 'tail' : ['preview', 'move-while-waiting'].includes(scenario) ? 'preview' : 'above');
      if (scenario === 'move-while-waiting') {
        await page.evaluate(() => window.__handoffFixture.clear());
        await position('above');
      }
      await page.evaluate((scenario) => {
        const f = window.__handoffFixture;
        const s = f.host.querySelector('[data-virtuoso-scroller]');
        const readingPreview = scenario === 'preview';
        const oldReader = f.host.querySelector(`[data-uuid="${f.readerUuid}"]`);
        const samples = [];
        if (!readingPreview && scenario !== 'tail' && oldReader) {
          const text = Array.from(oldReader.querySelectorAll('p')).find((p) => p.firstChild?.nodeType === Node.TEXT_NODE)?.firstChild;
          if (text) {
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, Math.min(20, text.textContent.length));
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
          }
        }
        const expectedSelection = window.getSelection().toString();
        const sample = (phase) => {
          const p = f.host.querySelector('[data-history-terminal-preview]');
          const node = readingPreview ? p || f.host.querySelector(`[data-uuid="${f.canonicalUuid}"]`) : oldReader;
          samples.push({
            phase, time: performance.now(), top: s.scrollTop,
            gap: s.scrollHeight - s.clientHeight - s.scrollTop,
            anchor: node ? node.getBoundingClientRect().top - s.getBoundingClientRect().top : null,
            sameScroller: s.isConnected && f.host.querySelector('[data-virtuoso-scroller]') === s,
            preview: !!p, presented: f.host.querySelector('[data-history-presented]')?.getAttribute('data-history-presented'),
            selection: window.getSelection().toString(),
          });
        };
        window.__handoffAcceptance = { samples, expectedSelection, done: false };
        sample('before');
        let frame = 0;
        const tick = () => {
          sample('raf');
          setTimeout(() => { sample('post-paint'); if (frame >= 90) window.__handoffAcceptance.done = true; }, 0);
          if (++frame < 90) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }, scenario);
      await page.evaluate((scenario) => {
        const f = window.__handoffFixture;
        if (scenario === 'hidden') f.show(false);
        if (scenario === 'clear-first') { f.clear(); f.canonical(); }
        else { f.canonical(); if (scenario !== 'move-while-waiting') f.clear(); }
      }, scenario);
      if (scenario === 'hidden') {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await host.locator('[data-history-terminal-preview]').count(), 1, 'hidden handoff waits for its presentation visit');
        await page.evaluate(() => window.__handoffFixture.show(true));
      }
      await page.waitForFunction(() => window.__handoffAcceptance?.done);
      const evidence = await page.evaluate(() => window.__handoffAcceptance);
      const visible = evidence.samples.filter((sample) => sample.presented === '1');
      const first = visible[0];
      const maxDrift = Math.max(...visible.map((sample) => scenario === 'tail'
        ? Math.abs(sample.gap) : sample.anchor === null ? Infinity : Math.abs(sample.anchor - first.anchor)));
      const result = { provider, scenario, samples: evidence.samples.length, maxDrift,
        previewRemaining: await host.locator('[data-history-terminal-preview]').count(),
        sameScroller: evidence.samples.every((sample) => sample.sameScroller) };
      if (maxDrift > 2) result.changes = visible.filter((sample, index) => index === 0
        || sample.anchor !== visible[index - 1].anchor || sample.top !== visible[index - 1].top
        || sample.preview !== visible[index - 1].preview).slice(0, 12);
      results.push(result);
      assert.equal(result.previewRemaining, 0, JSON.stringify(result));
      assert.equal(result.sameScroller, true, JSON.stringify(result));
      assert.ok(maxDrift <= 2, JSON.stringify(result));
      if (evidence.expectedSelection) {
        assert.ok(visible.every((sample) => sample.selection === evidence.expectedSelection), 'older text selection must survive canonical adoption');
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.evaluate(() => {
        window.__handoffFixture?.destroy();
        window.getSelection().removeAllRanges();
        delete window.__handoffAcceptance;
      });
    }
  }
} finally {
  console.log(JSON.stringify({ results }, null, 2));
  await browser.close();
}
