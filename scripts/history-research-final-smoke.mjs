// Real, already-launched DEV only. Finishes the two remaining A checks; no
// renderer replacement, IPC stubs, clipboard, provider or source mutation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const lease = path.resolve(process.argv[2]), attempt = process.argv[3];
assert.equal(attempt, 'research-ui-05');
const receipt = JSON.parse(await fs.readFile(path.join(lease, 'attempts', attempt, 'process-lease.json'), 'utf8'));
assert.equal(receipt.attemptId, attempt);
assert.equal(receipt.buildFingerprint, 'edbd00c7b65054d67db23e01d47a99d1e8890e3d613c5fa84876507fb9a777b9');
assert.equal(receipt.ports.cdp, 9347);
const artifact = path.join(lease, 'artifacts', attempt);
await fs.mkdir(artifact, { recursive: true });
const resultPath = path.join(artifact, 'final-smoke.json');
await fs.access(resultPath).then(() => { throw Error('This attempt already has a result'); }, error => {
  if (error.code !== 'ENOENT') throw error;
});
const deadline = Math.min(Date.parse(receipt.startedAt) + 8 * 60000, Date.now() + 120000);
const guard = () => { if (Date.now() >= deadline) throw Error('Action deadline exceeded'); };
const result = { status: 'RUNNING', startedAt: new Date().toISOString(), receipt, steps: [], cleanup: {} };
let browser, page, originalFont;
const record = (step, data = {}) => result.steps.push({ at: new Date().toISOString(), step, ...data });
try {
  guard();
  browser = await chromium.connectOverCDP('http://127.0.0.1:9347');
  const source = await fs.realpath(path.join(lease, 'source'));
  page = browser.contexts().flatMap(context => context.pages()).find(candidate =>
    decodeURI(candidate.url()).startsWith('file://' + source + '/dist/renderer/'));
  assert.ok(page, 'exact frozen renderer');
  page.setDefaultTimeout(5000);
  await page.screenshot({ path: path.join(artifact, '00-full-window.png') });
  const visibility = await page.evaluate(() => window.require('electron').ipcRenderer.invoke('e2e:window-state'));
  assert.equal(visibility.pid, receipt.pid);
  assert.ok(visibility.windows.some(window => window.visible && window.url === page.url()), 'visible DEV window');
  record('visible-window', { visibility });
  const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pane = page.locator('[data-terminal-pane-wrapper="research-markdown"][data-terminal-surface-presented="1"]');
  const panel = pane.locator('[data-history-main="1"][data-history-presented="1"][data-history-session="a5000000-0000-4000-8000-000000000001"]');
  const click = async (locator, name, requireOwner = true) => {
    guard();
    if (requireOwner) { assert.equal(await pane.count(), 1, 'PRECONDITION: expected selected pane'); assert.equal(await panel.count(), 1); }
    await locator.waitFor({ state: 'visible' });
    await locator.scrollIntoViewIfNeeded();
    const target = await locator.evaluate(element => {
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { rect: r.toJSON(), hit: !!hit && (element === hit || element.contains(hit)),
        owner: element.closest('[data-terminal-pane-wrapper]')?.getAttribute('data-terminal-pane-wrapper') };
    });
    assert.equal(target.hit, true, 'PRECONDITION: target must own its hit point');
    record(name + ':before', target);
    guard(); await locator.click(); await painted(); record(name + ':after');
  };
  await click(page.locator('[data-tab-card="research-markdown"]:visible').first(), 'select-markdown', false);
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-terminal-pane-wrapper="research-markdown"][data-terminal-surface-presented="1"] [data-history-main="1"]')?.getAttribute('data-history-viewport-ready') === '1');
  originalFont = await page.evaluate(() => window.useUIStore.getState().historyFontSize);
  guard(); await page.evaluate(() => window.useUIStore.getState().setHistoryFontSize(20)); await painted();
  record('font20-setup');
  const card = panel.locator('[data-history-research-result]');
  assert.equal(await card.count(), 1);
  // A previously saved UI state may start open. Close via its actual control.
  if (await card.getAttribute('data-research-expanded') === 'true')
    await click(card.getByRole('button', { name: 'Свернуть ответ', exact: true }), 'initial-collapse');
  await page.waitForFunction(() => document.querySelector('[data-terminal-pane-wrapper="research-markdown"][data-terminal-surface-presented="1"] [data-external-research-source]')?.textContent?.includes('6-astra · pro'));
  const geometry = await card.evaluate(element => {
    const preview = element.querySelector('[data-research-preview]'), bubble = element.closest('.cb-user-bubble');
    const ps = getComputedStyle(preview), bs = getComputedStyle(bubble);
    return { font: ps.fontSize, lineHeight: ps.lineHeight, height: preview.getBoundingClientRect().height,
      background: bs.backgroundColor, border: bs.borderColor, width: bubble.getBoundingClientRect().width,
      model: element.querySelector('[data-external-research-source]')?.textContent };
  });
  assert.equal(geometry.font, '20px');
  assert.ok(Math.abs(geometry.height - 3 * parseFloat(geometry.lineHeight)) <= 1);
  assert.equal(geometry.background, 'rgba(114, 90, 159, 0.08)');
  assert.equal(geometry.border, 'rgba(167, 139, 250, 0.2)');
  assert.equal(await panel.locator('.hp-context-update-chip').count(), 1);
  record('font20-preview', geometry);
  await page.screenshot({ path: path.join(artifact, 'A-font20-collapsed.png') });
  for (let cycle = 1; cycle <= 2; cycle++) {
    await click(card.getByRole('button', { name: 'Раскрыть ответ', exact: true }), 'top-open-' + cycle);
    assert.equal(await card.getAttribute('data-research-expanded'), 'true');
    assert.equal(await card.locator('[data-research-full]').count(), 1);
    if (cycle === 1) await page.screenshot({ path: path.join(artifact, 'A-font20-expanded.png') });
    await click(card.getByRole('button', { name: 'Свернуть ответ', exact: true }), 'top-close-' + cycle);
    assert.equal(await card.getAttribute('data-research-expanded'), 'false');
    assert.equal(await card.locator('[data-research-full]').count(), 0);
  }
  const finalGeometry = await card.evaluate(element => ({ width: element.closest('.cb-user-bubble').getBoundingClientRect().width,
    scrollTop: element.closest('.hp-history-transcript').scrollTop }));
  assert.ok(Math.abs(finalGeometry.width - geometry.width) <= 1);
  record('two-cycles-complete', finalGeometry);
  await page.screenshot({ path: path.join(artifact, 'A-font20-final.png') });
  result.status = 'PASS';
} catch (error) {
  result.status = String(error.message).includes('PRECONDITION') ? 'PRECONDITION-NOT-MET' : 'FAIL';
  result.error = String(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
} finally {
  if (page && originalFont !== undefined) {
    await page.evaluate(value => window.useUIStore.getState().setHistoryFontSize(value), originalFont).catch(() => {});
    result.cleanup.fontRestored = true;
  }
  if (browser) { await browser.close(); result.cleanup.cdpDisconnected = true; }
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, artifact, steps: result.steps.length, error: result.error }));
}
