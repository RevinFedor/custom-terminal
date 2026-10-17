import assert from 'node:assert/strict';
import path from 'node:path';

export async function runCanonicalContinuationCase(page, { artifact, result }) {
  const state = () => page.evaluate(() => {
    const fixture = window.fixture;
    const scroller = document.querySelector('[data-virtuoso-scroller]');
    const previews = [...document.querySelectorAll('[data-preview-item-id]')].map(node => ({
      id: node.dataset.previewItemId, label: node.querySelector('.cb-message-status')?.textContent,
      spinner: !!node.querySelector('.cb-message-status-spinner'),
    }));
    const rows = [...document.querySelectorAll('[data-history-row-real]')]
      .filter(node => node.textContent.replace(/\s/g, '').includes(fixture.text.replace(/\s/g, '')));
    return { tabId: fixture.tabId, sessionId: fixture.sessionId, identity: fixture.identity,
      previews, canonicalRows: rows.length, canonicalUuids: rows.map(node => node.dataset.uuid),
      bottomGap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      sameScroller: scroller === window.continuationScroller,
      hasFooter: !!document.querySelector('[data-history-terminal-preview]') };
  });
  await page.evaluate(() => { window.continuationScroller = document.querySelector('[data-virtuoso-scroller]');
    window.fixture.live(); });
  await page.waitForFunction(() => document.querySelector('[data-preview-item-id="ITEM"]')
    ?.textContent.replace(/\s/g, '').includes(window.fixture.text.replace(/\s/g, '')));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', {
    detail: { tabId: window.fixture.tabId } })));
  await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]');
    return s.scrollHeight - s.clientHeight - s.scrollTop <= 2; });
  result.live = await state();
  assert.equal(result.live.previews.length, 1); assert.equal(result.live.previews[0].spinner, true);
  await page.screenshot({ path: path.join(artifact, 'continuation-live.png') });
  result.checks.push('actual Main preview starts with null session, exact item visible and spinning');
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => document.querySelector('[data-preview-item-id="ITEM"]')
    ?.textContent.includes('Response · synchronizing view'));
  result.held = await state();
  assert.equal(result.held.canonicalRows, 0); assert.equal(result.held.previews.length, 1);
  assert.equal(result.held.previews[0].spinner, false);
  await page.screenshot({ path: path.join(artifact, 'continuation-held.png') });
  result.checks.push('canonical ACK retains saved text without spinner while public owner is suppressed');
  await page.evaluate(() => window.fixture.release());
  await page.waitForFunction(() => !document.querySelector('[data-history-terminal-preview]'));
  result.final = await state();
  assert.equal(result.final.canonicalRows, 1); assert.equal(result.final.previews.length, 0);
  assert.equal(result.final.sameScroller, true); assert(result.final.bottomGap <= 2);
  await page.screenshot({ path: path.join(artifact, 'continuation-adopted.png') });
  result.checks.push('one exact incremental canonical row replaces Footer during busy turn, same scroller and tail');
  await page.evaluate(() => window.fixture.release());
  const repeat = await state(); assert.equal(repeat.canonicalRows, 1); assert.equal(repeat.previews.length, 0);
  result.checks.push('duplicate transport delivery does not duplicate row or revive Footer');
  await page.evaluate(() => window.fixture.destroy());
  assert.equal(await page.locator('[data-history-preview-fixture]').count(), 0);
  result.rollback = true;
  assert.deepEqual(result.errors, []); result.verdict = 'PASS';
}
