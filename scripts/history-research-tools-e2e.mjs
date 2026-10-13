// Trusted CDP in an already-launched, visible full DEV. No mocked executors.
// Seeded data is isolated; the one source-arrow check opens an existing SC job.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Read-only test admission. A retained owner's viewport proof does not mean
// that a later resize transaction has released its input lock.
function historyReadiness(root) {
  const state = {
    presented: root.getAttribute('data-history-presented'),
    viewportReady: root.getAttribute('data-history-viewport-ready'),
    resizeLock: root.getAttribute('data-history-resize-locked'),
    loader: !!root.querySelector('[data-history-viewport-loader]'),
    stale: !!root.querySelector('[data-history-stale-curtain]'),
    inert: !!root.closest('[inert]'),
  };
  return { ...state, ready: state.presented === '1' && state.viewportReady === '1'
    && state.resizeLock === null && !state.loader && !state.stale && !state.inert };
}

function captureHitPoint(n, position) {
  const r = n.getBoundingClientRect();
  const point = position === 'empty-right' ? { x: r.width - 4, y: r.height / 2 }
    : position === 'group-empty-right' ? { x: r.width - 32, y: r.height / 2 }
      : position || { x: r.width / 2, y: r.height / 2 };
  const hit = document.elementFromPoint(r.x + point.x, r.y + point.y);
  const describe = el => el ? { tag: el.tagName, class: el.getAttribute('class'),
    uuid: el.closest('[data-uuid]')?.getAttribute('data-uuid'),
    pane: el.closest('[data-terminal-pane-wrapper]')?.getAttribute('data-terminal-pane-wrapper'),
    pointerEvents: getComputedStyle(el).pointerEvents, visibility: getComputedStyle(el).visibility } : null;
  return { rect: r.toJSON(), hit: !!hit && (n === hit || n.contains(hit)), point,
    hitNode: describe(hit), hitParent: describe(hit?.parentElement), target: describe(n),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    owner: n.closest('[data-terminal-pane-wrapper]')?.getAttribute('data-terminal-pane-wrapper') };
}

const [leaseArg, attempt, expectedBuild] = process.argv.slice(2);
const lease = await fs.realpath(leaseArg);
assert.match(attempt, /^research-tools-\d+$/);
const manifest = JSON.parse(await fs.readFile(path.join(lease, 'manifest.json'), 'utf8'));
// The client may be frozen separately from product source for a harness-only
// retake. Resolve its dependency from the exact product lease, not another app.
const { chromium } = createRequire(path.join(manifest.source, 'package.json'))('playwright');
const fixture = JSON.parse(await fs.readFile(path.join(lease, 'research-fixture.json'), 'utf8'));
const receipt = JSON.parse(await fs.readFile(path.join(lease, 'attempts', attempt, 'process-lease.json'), 'utf8'));
assert.equal(receipt.attemptId, attempt);
assert.equal(receipt.buildFingerprint, expectedBuild);
assert.equal(receipt.ports.cdp, Number(manifest.env.NOTED_CDP_PORT));
assert.equal(receipt.ports.api, Number(manifest.env.NOTED_WEB_PORT));
const artifact = path.join(lease, 'artifacts', attempt);
await fs.mkdir(artifact, { recursive: true });
const resultFile = path.join(artifact, 'RESULT.json');
await fs.access(resultFile).then(() => { throw Error('Attempt already has a result'); }, e => { if (e.code !== 'ENOENT') throw e; });
const deadline = Math.min(Date.parse(receipt.startedAt) + 8 * 60000, Date.now() + 6 * 60000);
let actions = 0, browser, page, cdp, originalFont, originalViewport;
const result = { attempt, artifact, status: 'RUNNING', startedAt: new Date().toISOString(), receipt,
  scenarios: {}, steps: [], cleanup: {}, boundaries: 'Real visible Electron/Main/store/SQLite/History, trusted CDP. Copied and explicitly synthetic data; viewport emulation, not OS window resizing. No provider generation or OS clipboard. SC arrow uses one existing live saved job; no SC data mutation.' };
const sha = text => createHash('sha256').update(text).digest('hex');
const mark = (step, data = {}) => result.steps.push({ step, utc: new Date().toISOString(), ...data });
const guard = () => { assert.ok(Date.now() < deadline, 'UI deadline exceeded'); assert.ok(actions < 90, 'UI action limit exceeded'); };
const before = new Map();
const token = (await fs.readFile(path.join(manifest.env.NOTED_DISCOVERY_DIR, 'web-token.txt'), 'utf8')).trim();
async function readHistory(tab, phase) {
  const response = await fetch(`http://127.0.0.1:${receipt.ports.api}/api/terminal-tabs/${encodeURIComponent(tab.tabId)}/history?view=history`,
    { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const data = await response.json();
  await fs.writeFile(path.join(artifact, `api-${phase}-${tab.tabId}.json`), JSON.stringify(data, null, 2));
  assert.equal(data.readSessionId, tab.sessionId);
  assert.ok(Array.isArray(data.entries));
  const records = tab.expected.map(expected => {
    const hits = data.entries.filter(e => e.semanticTags?.some(t => t.runId === expected.runId));
    assert.equal(hits.length, 1, 'one exact result record per fixture run');
    assert.equal(sha(hits[0].content), expected.rawHash, 'source body stays exact');
    assert.equal(hits[0].semanticTags.find(t => t.runId === expected.runId).phase, expected.phase);
    return { uuid: hits[0].uuid, hash: expected.rawHash, runId: expected.runId, phase: expected.phase };
  });
  return { data, records };
}
try {
  guard();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${receipt.ports.cdp}`);
  const source = await fs.realpath(manifest.source);
  page = browser.contexts().flatMap(c => c.pages()).find(p => decodeURI(p.url()).startsWith('file://' + source + '/dist/renderer/'));
  assert.ok(page, 'exact frozen renderer'); page.setDefaultTimeout(5000);
  await page.screenshot({ path: path.join(artifact, '00-full-window.png') });
  const visible = await page.evaluate(() => window.require('electron').ipcRenderer.invoke('e2e:window-state'));
  assert.equal(visible.pid, receipt.pid);
  assert.ok(visible.windows.some(w => w.visible && w.url === page.url()), 'native window must be visible');
  mark('visible-native-window', { visible });
  const pageErrors = []; result.pageErrors = pageErrors; page.on('pageerror', e => pageErrors.push(String(e)));
  for (const tab of fixture.tabs) before.set(tab.tabId, await readHistory(tab, 'before'));
  originalFont = await page.evaluate(() => window.useUIStore.getState().historyFontSize);
  originalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));
  cdp = await page.context().newCDPSession(page);
  const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let active;
  const pane = () => page.locator(`[data-terminal-pane-wrapper="${active.tabId}"][data-terminal-surface-presented="1"]`);
  const panel = () => pane().locator(`[data-history-main="1"][data-history-presented="1"][data-history-session="${active.sessionId}"]`);
  const waitHistoryReady = async step => {
    guard();
    await panel().waitFor({ state: 'visible' });
    const initial = await panel().evaluate(historyReadiness);
    if (!initial.ready) {
      mark(step + ':presentation-wait', initial);
      try {
        // Mutation-driven observation of the actual owner; no fixed sleep,
        // handler calls, forced input unlock, or fallback to a different pane.
        await panel().evaluate((root, timeout) => new Promise((resolve, reject) => {
          const ready = () => root.getAttribute('data-history-presented') === '1'
            && root.getAttribute('data-history-viewport-ready') === '1'
            && !root.hasAttribute('data-history-resize-locked') && !root.closest('[inert]')
            && !root.querySelector('[data-history-viewport-loader], [data-history-stale-curtain]');
          let timer;
          const finish = error => { observer.disconnect(); clearTimeout(timer); error ? reject(error) : resolve(); };
          const observer = new MutationObserver(() => { if (ready()) finish(); });
          observer.observe(root.closest('[data-terminal-pane-wrapper]') || root,
            { attributes: true, childList: true, subtree: true });
          timer = setTimeout(() => finish(Error('History presentation did not become ready')), timeout);
          if (ready()) finish();
        }), Math.min(10000, Math.max(1, deadline - Date.now())));
      } catch (error) {
        mark(step + ':presentation-timeout', await panel().evaluate(historyReadiness).catch(() => ({ ownerMissing: true })));
        throw Error('PRECONDITION: ' + error.message);
      }
    }
    const current = await panel().evaluate(historyReadiness);
    mark(step + ':presentation-ready', current);
    assert.ok(current.ready, 'PRECONDITION: exact History presentation must be ready');
  };
  const click = async (target, step, position, owner = true) => {
    guard();
    if (owner) { assert.equal(await pane().count(), 1); assert.equal(await panel().count(), 1); await waitHistoryReady(step); }
    await target.waitFor({ state: 'visible' }); await target.scrollIntoViewIfNeeded();
    if (owner) { await painted(); await waitHistoryReady(step + ':post-scroll'); }
    const actual = await target.evaluate(captureHitPoint, position);
    // Persist the rejected point too. A screenshot after an assertion is not
    // enough to distinguish a wrong locator, stale geometry and product overlay.
    mark(step + ':before', actual);
    assert.ok(actual.hit, 'PRECONDITION: current target must own its hit point');
    if (owner) assert.equal(actual.owner, active.tabId);
    guard(); actions++;
    await target.click({ position: actual.point }); await painted(); mark(step + ':after');
  };
  const select = async id => {
    active = fixture.tabs.find(t => t.tabId === id); assert.ok(active);
    await click(page.locator(`[data-tab-card="${id}"]:visible`).first(), 'select-' + id, undefined, false);
    await waitHistoryReady('select-' + id);
  };
  const setSize = async (width, font) => {
    guard(); const current = await panel().evaluate(n => ({ width: n.getBoundingClientRect().width, viewport: innerWidth }));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.round(current.viewport - current.width + width),
      height: originalViewport.height, deviceScaleFactor: originalViewport.deviceScaleFactor, mobile: false });
    await page.evaluate(value => window.useUIStore.getState().setHistoryFontSize(value), font); await painted();
    await waitHistoryReady('layout-' + width + '-' + font);
    const actual = await panel().evaluate(n => n.getBoundingClientRect().width);
    assert.ok(Math.abs(actual - width) < 2, 'fixture History width'); mark('layout-setup', { width, actual, font });
  };
  const resetSize = async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...originalViewport, mobile: false });
    await cdp.send('Emulation.clearDeviceMetricsOverride'); await painted();
    await waitHistoryReady('layout-reset');
  };
  const sameHeader = (a, b) => { for (const key of ['x', 'y', 'width']) assert.ok(Math.abs(a[key] - b[key]) < 1.5, 'stationary header ' + key); };
  const groupHeader = () => panel().locator('.hp-history-research-group-toggle');
  const collapseGroup = async () => { if (await groupHeader().getAttribute('aria-expanded') === 'true') await click(groupHeader(), 'group-close'); };

  await select('research-group');
  const groupRows = before.get(active.tabId).records;
  for (const width of [650, 300]) for (const font of [13, 20]) {
    await collapseGroup(); await setSize(width, font);
    assert.equal(await groupHeader().textContent(), 'Research ×5');
    assert.equal(await panel().locator('[data-history-research-result]').count(), 0);
    const start = await groupHeader().boundingBox();
    await click(groupHeader(), 'group-empty-header-open', 'group-empty-right');
    await panel().locator('[data-history-research-result]').nth(4).waitFor();
    sameHeader(start, await groupHeader().boundingBox());
    const layout = await panel().evaluate(root => ({ width: root.clientWidth, scrollWidth: root.scrollWidth,
      rows: [...root.querySelectorAll('[data-history-research-result]')].map(n => ({
        rect: n.getBoundingClientRect().toJSON(), bg: getComputedStyle(n.closest('.cb-user-bubble')).backgroundColor,
        border: getComputedStyle(n.closest('.cb-user-bubble')).borderTopWidth,
        model: n.querySelector('.hp-research-result-model')?.textContent?.replace(/^·\s*/, ''),
        title: n.querySelector('.hp-research-result-toggle')?.getAttribute('aria-label'),
        visibleTechnicalTitle: !!n.querySelector('.hp-research-result-title'),
        excerpt: n.querySelector('[data-research-preview]')?.textContent,
      })), rails: [...root.querySelectorAll('.hp-history-group-member--research')].map(n => ({ left: getComputedStyle(n).borderLeftWidth, right: getComputedStyle(n).borderRightWidth })) }));
    assert.ok(layout.scrollWidth <= layout.width + 1, 'no horizontal overflow');
    assert.equal(layout.rows.length, 5);
    layout.rows.forEach((r, i) => { assert.equal(r.bg, 'rgba(0, 0, 0, 0)'); assert.equal(r.border, '0px');
      assert.equal(r.model, '6 · xhigh'); assert.ok(r.title?.includes(active.expected[i].label));
      assert.equal(r.visibleTechnicalTitle, false); assert.ok(r.excerpt?.length > 10);
      assert.ok(Math.abs(r.rect.width - layout.rows[0].rect.width) < 1); });
    layout.rails.forEach(r => { assert.equal(r.left, '1px'); assert.equal(r.right, '0px'); });
    mark('group-layout', { width, font, layout });
    await page.screenshot({ path: path.join(artifact, `group-${width}-${font}.png`) });
    await collapseGroup(); sameHeader(start, await groupHeader().boundingBox());
  }
  await resetSize(); await setSize(650, 13); await click(groupHeader(), 'group-open-for-content');
  for (const [index, record] of groupRows.entries()) {
    const row = panel().locator(`[data-uuid="${record.uuid}"] [data-history-research-result]`);
    const header = row.locator('.hp-research-result-toggle');
    await click(header, 'answer-open-' + index, 'empty-right');
    const body = row.locator('[data-research-full]'); await body.waitFor();
    const metrics = await body.evaluate(n => ({ height: n.getBoundingClientRect().height, overflow: getComputedStyle(n).overflowY,
      code: n.querySelector('pre')?.textContent, size: n.querySelector('pre') ? getComputedStyle(n.querySelector('pre')).fontSize : null }));
    assert.ok(metrics.height <= 180.1); assert.equal(metrics.overflow, 'auto');
    const original = before.get('research-group').data.entries.find(e => e.uuid === record.uuid), tag = original.semanticTags.find(t => t.runId === record.runId);
    const raw = original.content.slice(tag.bodyStart, tag.bodyEnd).trim();
    const unwrapped = raw.startsWith('<escape>') ? raw.slice(8, -9)
      : raw.replace(/^<CodeBlock\s+language="json"\s+editable=\{false\}>/, '').replace(/<\/CodeBlock>$/, '');
    assert.deepEqual(JSON.parse(metrics.code), JSON.parse(unwrapped), 'display preserves every JSON value');
    assert.ok(parseFloat(metrics.size) < 13, 'same smaller tool output scale');
    mark('answer-code-' + index, { height: metrics.height, codeHash: sha(metrics.code), fontSize: metrics.size });
    if (index === 0) await page.screenshot({ path: path.join(artifact, 'answer-bounded-code.png') });
    await click(row.locator('[data-research-disclosure]'), 'answer-close-' + index);
  }
  await click(panel().locator('[data-history-group-rail]').first(), 'left-rail-collapse');
  assert.equal(await groupHeader().getAttribute('aria-expanded'), 'false');
  await click(groupHeader(), 'group-reopen');
  await click(panel().locator('[data-history-group-foot]'), 'left-foot-collapse');
  assert.equal(await groupHeader().getAttribute('aria-expanded'), 'false');
  result.scenarios.group = 'PASS';

  await resetSize(); await select('research-markdown'); await setSize(650, 20);
  const markdown = panel().locator('[data-history-research-result]');
  assert.equal(await markdown.count(), 1); assert.equal(await groupHeader().count(), 0);
  assert.equal(await panel().locator('.hp-context-update-chip').count(), 1);
  for (let i = 0; i < 2; i++) {
    const header = markdown.locator('.hp-research-result-toggle'); const a = await header.boundingBox();
    await click(header, 'markdown-open-' + i, 'empty-right');
    assert.equal(await markdown.getAttribute('data-research-expanded'), 'true');
    sameHeader(a, await header.boundingBox());
    if (i === 0) await page.screenshot({ path: path.join(artifact, 'markdown-open-font20.png') });
    await click(markdown.locator('[data-research-disclosure]'), 'markdown-close-' + i);
    sameHeader(a, await header.boundingBox());
  }
  await click(markdown.locator('.hp-research-result-toggle'), 'markdown-open-for-reading');
  const body = markdown.locator('[data-research-full]');
  const bodyBox = await body.boundingBox(); guard(); actions++;
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2); await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector('[data-terminal-pane-wrapper="research-markdown"][data-terminal-surface-presented="1"] [data-research-full]')?.scrollTop > 0);
  const reading = await body.evaluate(n => n.scrollTop);
  mark('bounded-body-wheel', { scrollTop: reading });
  await select('research-group'); await select('research-markdown');
  assert.equal(await panel().locator('[data-research-full]').evaluate(n => n.scrollTop), reading);
  result.scenarios.markdown = 'PASS';

  await resetSize(); await select('research-outcomes'); await setSize(650, 13);
  assert.match(await groupHeader().textContent(), /Research ×2.*1 failed/);
  await click(groupHeader(), 'outcomes-open');
  assert.equal(await panel().locator('[data-research-failed="true"]').count(), 1);
  const outcomeRows = before.get(active.tabId).records;
  const complete = panel().locator(`[data-uuid="${outcomeRows[0].uuid}"] [data-history-research-result]`);
  assert.equal(await complete.getAttribute('data-research-failed'), null, 'negative verdict is not an operation failure');
  await click(complete.locator('.hp-research-result-toggle'), 'jsonl-open');
  assert.equal((await complete.locator('pre').textContent()).split('\n').length, 100);
  assert.ok((await complete.locator('[data-research-full]').boundingBox()).height <= 180.1);
  const reference = before.get(active.tabId).data.entries.find(e => e.actions?.some(a => a.rawTool?.toolUseId === 'fixture-reference-mcp'));
  assert.ok(reference, 'PRECONDITION: seeded real MCP reference row must be parsed');
  const referenceRow = panel().locator(`[data-uuid="${reference.uuid}"]`);
  await click(referenceRow.locator('.cb-tool-head-inner'), 'reference-MCP-open');
  const style = n => { const s = getComputedStyle(n); return { size: s.fontSize, family: s.fontFamily, color: s.color }; };
  const researchCodeStyle = await complete.locator('pre').evaluate(style);
  const mcpCodeStyle = await referenceRow.locator('.cb-mcp-result .cb-generic-out').evaluate(style);
  assert.deepEqual(researchCodeStyle, mcpCodeStyle, 'Research code matches actual MCP output typography');
  mark('MCP-output-typography-parity', { researchCodeStyle, mcpCodeStyle });
  await page.screenshot({ path: path.join(artifact, 'outcomes-failure-and-jsonl.png') });
  result.scenarios.outcomes = 'PASS';

  // Explicit read-only source navigation: no result GET, Start, Send or provider.
  await resetSize(); await select('research-group');
  if (await groupHeader().getAttribute('aria-expanded') !== 'true') await click(groupHeader(), 'group-open-for-source');
  const sc = panel().locator(`[data-external-research-source="${active.expected[0].runId}"]`);
  await click(sc, 'source-arrow-to-existing-SC-job');
  await page.waitForFunction(runId => {
    const n = document.querySelector(`[data-terminal-pane-wrapper="research-group"][data-terminal-surface-presented="1"] [data-external-research-source="${runId}"]`);
    return ['opened', 'failed'].includes(n?.getAttribute('data-external-research-open-state'));
  }, active.expected[0].runId, { timeout: 25000 });
  const scState = { state: await sc.getAttribute('data-external-research-open-state'), jobId: await sc.getAttribute('data-external-research-opened-job') };
  mark('SC-rendered-ack', scState);
  assert.equal(scState.state, 'opened', 'EXTERNAL-PRECONDITION: live saved SC job must be available');
  assert.equal(scState.jobId, active.expected[0].jobId);
  assert.equal(await panel().locator('[data-research-full]').count(), 0, 'source arrow never toggles a result');
  result.scenarios.source = 'PASS';
  assert.deepEqual(pageErrors, []);
  result.status = 'PASS';
} catch (error) {
  result.status = String(error.message).includes('PRECONDITION') ? 'PRECONDITION-NOT-MET' : 'FAIL';
  result.error = String(error.stack); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(artifact, 'failure-full.png') }).catch(() => {});
} finally {
  for (const tab of fixture.tabs) if (before.has(tab.tabId)) {
    try { const after = await readHistory(tab, 'after'); assert.deepEqual(after.records, before.get(tab.tabId).records); }
    catch (e) { result.integrityError = String(e); result.status = 'FAIL'; process.exitCode = 1; }
  }
  if (page && originalFont !== undefined) await page.evaluate(x => window.useUIStore.getState().setHistoryFontSize(x), originalFont)
    .then(() => { result.cleanup.fontRestored = true; }).catch(() => {});
  if (cdp && originalViewport) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...originalViewport, mobile: false }).catch(() => {});
    await cdp.send('Emulation.clearDeviceMetricsOverride').then(() => { result.cleanup.viewportRestored = true; }).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  if (browser) { await browser.close(); result.cleanup.cdpDisconnected = true; }
  result.actions = actions; result.finishedAt = new Date().toISOString();
  await fs.writeFile(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, actions, scenarios: result.scenarios, error: result.error, cleanup: result.cleanup }));
}
