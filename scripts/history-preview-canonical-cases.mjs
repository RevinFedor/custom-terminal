import assert from 'node:assert/strict';
import path from 'node:path';

export async function runCanonicalPreviewCases(page, { artifact, result, logs, scenario = 'hidden-rebind' }) {
  result.scenario = scenario;
  if (scenario === 'preview-reader') {
    await page.evaluate(() => { window.fixture.host.style.height = '300px'; });
    await page.waitForFunction(() => document.querySelector('[data-virtuoso-scroller]').clientHeight < 300);
  }
  await page.evaluate(() => window.fixture.preview());
  await page.locator('[data-preview-item-id="item-617"]').waitFor();
  await page.locator('[data-virtuoso-scroller]').press('End');
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-virtuoso-scroller]');
    return s.scrollHeight - s.clientHeight - s.scrollTop <= 2;
  });
  await page.screenshot({ path: path.join(artifact, 'canonical-streaming.png') });
  if (scenario === 'mid-reader' || scenario === 'preview-reader') {
    // User intent is real CDP wheel input; fixture actions only deliver data.
    const coordinates = await page.evaluate(scenario => {
      const f = window.fixture, s = f.host.querySelector('[data-virtuoso-scroller]');
      const target = scenario === 'mid-reader' ? f.host.querySelector(`[data-uuid="${f.readerUuid}"]`)
        : f.host.querySelector('[data-history-terminal-preview]');
      s.scrollTop += target.getBoundingClientRect().top - s.getBoundingClientRect().top
        - (scenario === 'mid-reader' ? 140 : -40);
      const r = s.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 240), y: r.y + Math.min(r.height / 2, 350) };
    }, scenario);
    await page.mouse.move(coordinates.x, coordinates.y);
    const quiet = page.waitForEvent('console', { predicate: m => m.text().includes('SCROLL_GESTURE_END'), timeout: 5000 });
    await page.mouse.wheel(0, -4);
    await quiet;
    result.beforeReader = await page.evaluate(scenario => {
      const f = window.fixture, s = f.host.querySelector('[data-virtuoso-scroller]');
      const n = scenario === 'mid-reader' ? f.host.querySelector(`[data-uuid="${f.readerUuid}"]`)
        : f.host.querySelector('[data-history-terminal-preview]');
      return { top: n.getBoundingClientRect().top - s.getBoundingClientRect().top };
    }, scenario);
    result.checks.push(`${scenario}: trusted reading gesture settled before the receipt`);
    await page.evaluate(() => window.fixture.receipt());
    await page.evaluate(() => window.fixture.canonical());
    await page.evaluate(() => window.fixture.responseEnd());
    await page.evaluate(() => window.fixture.taskComplete());
    await page.waitForFunction(() => !document.querySelector('[data-history-terminal-preview]'));
    await page.waitForFunction(() => !!document.querySelector('[data-history-viewport-ready="1"]'));
    result.afterReader = await page.evaluate(scenario => {
      const f = window.fixture, s = f.host.querySelector('[data-virtuoso-scroller]');
      const n = f.host.querySelector(`[data-uuid="${scenario === 'mid-reader' ? f.readerUuid : f.id + '-live-617'}"]`);
      return { top: n.getBoundingClientRect().top - s.getBoundingClientRect().top };
    }, scenario);
    assert(Math.abs(result.afterReader.top - result.beforeReader.top) <= 2,
      JSON.stringify({ before: result.beforeReader, after: result.afterReader }));
    await page.screenshot({ path: path.join(artifact, 'canonical-reader.png') });
    result.checks.push(`${scenario}: canonical-before-end/complete preserves exact viewport offset`);
    await page.evaluate(() => window.fixture.destroy()); result.rollback = true;
    assert.deepEqual(result.errors, []); result.verdict = 'PASS'; return;
  }
  await page.evaluate(() => window.fixture.show(false));
  await page.evaluate(() => window.fixture.receipt());
  await page.waitForFunction(() => document.querySelector('[data-history-terminal-preview]')?.textContent.includes('synchronizing view'));
  if (scenario === 'wrong-hash') await page.evaluate(() => window.fixture.wrongCanonicalBody());
  if (scenario === 'unrelated-items') await page.evaluate(() => window.fixture.unrelatedItems());
  await page.evaluate(() => window.fixture.canonical());
  await page.evaluate(() => window.fixture.responseEnd());
  await page.evaluate(() => window.fixture.taskComplete());
  const ownerRefresh = page.waitForEvent('console', { predicate: message =>
    message.text().includes('SURFACE_OWNER ') && message.text().includes('generation=3'), timeout: 4000 });
  await page.evaluate(() => window.fixture.durable());
  await ownerRefresh;
  result.hiddenCheckpoint = await page.evaluate(() => ({
    previewPresent: !!document.querySelector('[data-history-terminal-preview]'),
    presented: document.querySelector('[data-history-owner]').getAttribute('data-history-presented'),
    trace: [...window.fixture.trace],
  }));
  // This regression must exercise the real owner refresh, not mutate a ref.
  result.ownerEvents = logs.filter(l => l.includes('SURFACE_OWNER'));
  assert(result.ownerEvents.some(l => l.includes('generation=3')));
  result.checks.push('exact617 canonical proof survived a real hidden source-generation refresh, owner1→3');
  const canonicalBeforeReturn = await page.locator('[data-history-row-real]').filter({ hasText: 'Это наш баг, а не реальная смена чата.' }).elementHandle();
  await page.evaluate(() => window.fixture.show(true));
  if (scenario === 'wrong-hash') {
    assert(logs.some(l => l.includes('reason=waiting-canonical-integrity'))
      || await page.waitForEvent('console', { predicate: m => m.text().includes('reason=waiting-canonical-integrity'), timeout: 4000 }));
    assert.equal(await page.locator('[data-history-terminal-preview]').count(), 1,
      'same offset but wrong body must not consume the receipt');
    await page.screenshot({ path: path.join(artifact, 'canonical-wrong-body-held.png') });
    await page.evaluate(() => { window.fixture.correctCanonicalBody(); window.fixture.canonical(); });
    await page.evaluate(() => window.fixture.durable());
    result.checks.push('same positional identity with wrong full-record hash holds until exact canonical body returns');
  }
  if (scenario === 'unrelated-items') {
    await page.waitForFunction(() => document.querySelectorAll('[data-preview-item-id]').length === 2);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('[data-preview-item-id]'))
      .map(n => ({ id: n.getAttribute('data-preview-item-id'), text: n.textContent,
        phase: n.getAttribute('data-response-phase') })));
    assert.deepEqual(items.map(n => n.id), ['unconfirmed-245', 'new-live']);
    assert(items[0].text.includes('history not confirmed') && items[1].text.includes('Live response'));
    await page.screenshot({ path: path.join(artifact, 'canonical-unrelated-items-retained.png') });
    result.items = items;
    result.checks.push('old canonical617 handoff cannot retire newer live or unconfirmed items of the same turn');
    await page.evaluate(() => window.fixture.destroy()); result.rollback = true;
    assert.deepEqual(result.errors, []); result.verdict = 'PASS'; return;
  }
  try {
    await page.waitForFunction(() => !document.querySelector('[data-history-terminal-preview]'), null, { timeout: 4000 });
    await page.waitForFunction(() => !!document.querySelector('[data-history-viewport-ready="1"]'));
  } finally {
    await page.screenshot({ path: path.join(artifact, 'canonical-return.png') });
    result.returnCheckpoint = await page.evaluate(() => {
      const s = document.querySelector('[data-virtuoso-scroller]');
      const canonical = Array.from(document.querySelectorAll('[data-history-row-real]'))
        .filter(n => n.getAttribute('data-uuid') === window.fixture.canonicalUuid);
      return { canonicalRows: canonical.length, previewRows: document.querySelectorAll('[data-history-terminal-preview]').length,
        canonicalChars: canonical[0]?.textContent.length, bottomGap: s.scrollHeight - s.clientHeight - s.scrollTop };
    });
  }
  assert.equal(result.returnCheckpoint.canonicalRows, 1);
  assert.equal(result.returnCheckpoint.previewRows, 0);
  assert(result.returnCheckpoint.bottomGap <= 2);
  if (canonicalBeforeReturn && scenario !== 'wrong-hash') {
    assert(await canonicalBeforeReturn.evaluate(n => n.isConnected), 'the canonical handoff must not remount its already mounted replacement');
    result.canonicalNodeRetained = true;
  }
  assert.equal(await page.evaluate(() => window.fixture.text.length), 617);
  const trace = result.hiddenCheckpoint.trace;
  assert(trace.indexOf('canonical-receipt') < trace.indexOf('response-end'));
  assert(trace.indexOf('response-end') < trace.indexOf('task-complete'));
  result.checks.push('canonical617 receipt precedes response end/task completion; hidden durable owner refresh → return adopts exact row once');
  await page.evaluate(() => window.fixture.destroy());
  result.rollback = true;
  assert.deepEqual(result.errors, []);
  result.verdict = 'PASS';
}
