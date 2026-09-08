#!/usr/bin/env node
// Runs on a separately owned DEV instance. It only toggles an existing group;
// it never sends a prompt or changes the transcript. The caller prepares the
// pane width/font and pins the exact source session via the DEV application API.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  return [arg.slice(0, at).replace(/^--/, ''), arg.slice(at + 1)];
}));
assert.ok(options.session && options.group, '--session=<uuid> and --group=<exact-key> are required');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.cdp || '9224'}`);
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(candidate.url()));
  assert.ok(page, 'expected a DEV renderer, not a packaged production page');
  const target = { session: options.session, group: options.group };
  const panel = page.locator(`[data-history-session="${target.session}"][data-history-presented="1"]`);
  assert.equal(await panel.count(), 1, 'one presented owner must match the requested session');
  const button = panel.locator(`[data-history-group="${target.group}"] [aria-expanded]`).first();
  const before = await panel.locator('[data-virtuoso-scroller]').evaluate((node) => ({
    scrollTop: node.scrollTop, width: node.clientWidth, height: node.clientHeight,
  }));
  const goToTail = () => panel.locator('[data-virtuoso-scroller]').evaluate((node) => new Promise((resolve, reject) => {
    let previousHeight = -1;
    let stable = 0;
    let frames = 0;
    const step = () => {
      node.scrollTop = node.scrollHeight;
      const rows = Array.from(node.querySelectorAll('[data-index][data-known-size]'));
      const measured = rows.length > 0 && rows.every((row) => (
        Math.abs(Math.round(row.getBoundingClientRect().height) - Number(row.getAttribute('data-known-size'))) <= 1
      ));
      stable = measured && node.scrollHeight === previousHeight ? stable + 1 : 0;
      previousHeight = node.scrollHeight;
      if (stable >= 4) { resolve(); return; }
      if (++frames >= 120) { reject(new Error('DEV tail did not finish measuring during setup')); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }));
  await goToTail();
  await button.waitFor({ state: 'visible' });
  const initiallyExpanded = await button.getAttribute('aria-expanded') === 'true';
  const results = [];
  try {
    if (initiallyExpanded) await button.click();
    for (let cycle = 0; cycle < Number(options.cycles || 5); cycle += 1) {
      // Scrolling to the tail is setup. The tested input is a trusted click.
      await goToTail();
      await page.waitForFunction(({ session }) => {
        const p = document.querySelector(`[data-history-session="${session}"][data-history-presented="1"]`);
        const s = p?.querySelector('[data-virtuoso-scroller]');
        return s && s.scrollHeight - s.clientHeight - s.scrollTop <= 1
          && !s.querySelector('[data-history-reveal-extent]');
      }, target);
      for (const action of ['expand', 'collapse']) {
        await page.evaluate(({ session, group }) => {
          const p = document.querySelector(`[data-history-session="${session}"][data-history-presented="1"]`);
          const s = p.querySelector('[data-virtuoso-scroller]');
          const header = () => Array.from(s.querySelectorAll('[data-history-group]'))
            .find((node) => node.getAttribute('data-history-group') === group);
          const samples = [];
          let frames = 0;
          const sample = (phase) => {
            const h = header();
            const list = s.querySelector('[data-testid="virtuoso-item-list"]');
            samples.push({
              phase, time: performance.now(), connected: s.isConnected,
              top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight,
              headerTop: h ? h.getBoundingClientRect().top - s.getBoundingClientRect().top : null,
              guard: !!s.querySelector('[data-history-reveal-extent]'),
              rows: list?.children.length || 0,
              placeholders: s.querySelectorAll('[data-history-mount-shell], [data-history-seek-placeholder]').length,
            });
          };
          window.__historyRevealAcceptance = { samples, done: false };
          document.addEventListener('pointerdown', () => sample('before'), { once: true, capture: true });
          document.addEventListener('click', () => {
            sample('click');
            const tick = () => {
              sample('raf');
              setTimeout(() => {
                sample('post-paint');
                if (frames >= 60) window.__historyRevealAcceptance.done = true;
              }, 0);
              if (++frames < 60) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }, { once: true, capture: true });
        }, target);
        await button.click();
        await page.waitForFunction(() => window.__historyRevealAcceptance?.done === true);
        const samples = await page.evaluate(() => window.__historyRevealAcceptance.samples);
        const first = samples[0];
        if (action === 'expand') {
          assert.ok(first.height - first.client - first.top <= 1, 'the actual click must start at the physical tail');
        }
        const maxDrift = Math.max(...samples.map((sample) => Math.abs(sample.headerTop - first.headerTop)));
        const row = {
          cycle, action, samples: samples.length, maxDrift,
          startHeight: first.height, minHeight: Math.min(...samples.map((sample) => sample.height)),
          endHeight: samples.at(-1).height,
          remainingGuard: samples.at(-1).guard,
        };
        results.push(row);
        assert.ok(samples.length >= 100, 'must observe the entire transition, including post-paint samples');
        assert.ok(samples.every((sample) => sample.connected && sample.rows > 0 && sample.headerTop !== null),
          'the same scroller and real header must stay mounted throughout the click');
        assert.ok(maxDrift <= Number(options['max-drift'] || 1), JSON.stringify(row));
        if (action === 'expand') {
          assert.ok(row.minHeight >= row.startHeight - 1, 'expansion must not shrink the scroll range');
        }
        assert.equal(row.remainingGuard, false, 'a measured group must not leave temporary scroll extent behind');
        assert.equal(await button.getAttribute('aria-expanded'), action === 'expand' ? 'true' : 'false');
      }
    }
  } finally {
    if (await button.isVisible()) {
      const expanded = await button.getAttribute('aria-expanded') === 'true';
      if (expanded !== initiallyExpanded) await button.click();
    }
    await panel.locator('[data-virtuoso-scroller]').evaluate((node, top) => { node.scrollTop = top; }, before.scrollTop);
    await page.evaluate(() => { delete window.__historyRevealAcceptance; });
    console.log(JSON.stringify({ target, viewport: before, results }, null, 2));
  }
} finally {
  await browser.close(); // disconnect CDP; the separately owned DEV stays alive
}
