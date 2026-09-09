#!/usr/bin/env node
// Bounded private Electron DEV regression. No provider process, CLI, or JSONL
// file is used: only the real renderer and controlled fixture IPC are exercised.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.argv.find((arg) => arg.startsWith('--cdp='))?.split('=')[1] || 9226);
const evidenceDir = path.resolve(process.argv.find((arg) => arg.startsWith('--evidence='))?.split('=')[1]
  || `/tmp/custom-terminal-history-rewrite-prefix-${Date.now()}`);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] || 'full';
assert.ok(['full', 'delta', 'deltaVisible', 'visible', 'metadata', 'inPlace'].includes(mode), `unsupported mode: ${mode}`);
await fs.mkdir(evidenceDir, { recursive: true });

const logLines = [];
const log = (message, value = '') => {
  const line = `${new Date().toISOString()} ${message}${value ? ` ${value}` : ''}`;
  logLines.push(line);
  console.log(line);
};
const artifact = (name) => path.join(evidenceDir, name);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const results = { status: 'FAIL', maxDriftPx: null, samples: 0, evidenceDir, cases: [] };
let page;
let fixtureId;
let fixtureStateBeforeDestroy;
const pageErrors = [];
const consoleErrors = [];
const baselineConsoleErrors = [];
let collectScenarioErrors = false;
class ScenarioCompleted extends Error {}
const expectedConsoleErrorPrefixes = [
  'Accessing element.ref was removed in React 19.',
];

function assertRevisionShape(revision, expectedSessionId, cwd) {
  assert.equal(typeof revision?.token, 'string', 'revision.token must be present');
  assert.equal(revision.sessionId, expectedSessionId, 'revision.sessionId');
  assert.equal(revision.cwd, cwd, 'revision.cwd');
  assert.equal(typeof revision.context, 'string', 'revision.context must be serialized transport context');
  const context = JSON.parse(revision.context);
  assert.ok(context.rowWindowRequest, 'revision.context.rowWindowRequest');
  assert.ok(Number.isInteger(context.rowWindowRequest.radius), 'rowWindowRequest.radius');
}

function assertReceipt(receipt, sourceSessionId, sessionId) {
  assert.equal(receipt?.schema, 'codex-rewrite-prefix-v1', 'rewriteReceipt.schema');
  assert.equal(receipt.sourceSessionId, sourceSessionId, 'rewriteReceipt.sourceSessionId');
  assert.equal(receipt.sessionId, sessionId, 'rewriteReceipt.sessionId');
  assert.equal(receipt.records.length, 18, 'rewriteReceipt retained prefix length');
  receipt.records.forEach((record, index) => {
    assert.deepEqual(record.source, { __line: index, __byteOffset: record.source.__byteOffset });
    assert.deepEqual(record.target, { __line: index, __byteOffset: record.target.__byteOffset });
    if (index > 0) {
      const previous = receipt.records[index - 1];
      assert.equal(record.source.__line, previous.source.__line + 1, 'source lines contiguous');
      assert.equal(record.target.__line, previous.target.__line + 1, 'target lines contiguous');
      assert.equal(record.source.__byteOffset, previous.source.__byteOffset + 1000, 'source offsets contiguous');
      assert.equal(record.target.__byteOffset, previous.target.__byteOffset + 1000, 'target offsets contiguous');
    }
  });
}

try {
  page = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(candidate.url()));
  assert.ok(page, 'expected a separately owned DEV renderer');
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      (collectScenarioErrors ? consoleErrors : baselineConsoleErrors).push(message.text());
    }
  });

  // Full viewport baseline before mounting the fixture or any test gesture.
  await page.screenshot({ path: artifact('baseline-full-surface.png') });
  log('BASELINE_SCREENSHOT', artifact('baseline-full-surface.png'));

  collectScenarioErrors = true;
  const mount = await page.evaluate(async (runMode) => {
    const module = await import('/scripts/fixtures/history-rewrite-prefix.tsx');
    const fixture = module.mountHistoryRewritePrefixFixture({ mode: runMode });
    window.__rewritePrefixFixture = fixture;
    return { id: fixture.id };
  }, mode);
  fixtureId = mount.id;
  const host = page.locator(`[data-rewrite-prefix-fixture="${fixtureId}"]`);
  const controls = page.locator(`[data-rewrite-prefix-controls="${fixtureId}"]`);
  await host.waitFor();
  await host.locator('[data-history-viewport-ready="1"]').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const fixture = window.__rewritePrefixFixture;
    const row = fixture?.host?.querySelector('[data-history-row-real]');
    const scroller = fixture?.host?.querySelector('[data-virtuoso-scroller]');
    return row && scroller && row.getBoundingClientRect().height > 0;
  }, { timeout: 15000 });
  await page.screenshot({ path: artifact('baseline-fixture-full-surface.png') });
  log('FIXTURE_BASELINE_SCREENSHOT', artifact('baseline-fixture-full-surface.png'));

  const info = await page.evaluate(() => {
    const fixture = window.__rewritePrefixFixture;
    return {
      id: fixture.id,
      sourceSessionId: fixture.sourceSessionId,
      childSessionId: fixture.childSessionId,
      grandchildSessionId: fixture.grandchildSessionId,
      readerUuid: fixture.readerUuid(fixture.sourceSessionId),
      state: fixture.state(),
    };
  });
  assertRevisionShape(info.state.sourceRevision, info.sourceSessionId, info.state.sourceRevision.cwd);
  assert.equal(info.state.rowShape.sourceSessionId, false, 'plain assistant DTO must not carry sourceSessionId');
  assertReceipt(info.state.childReceipt, info.sourceSessionId, info.childSessionId);
  assertReceipt(info.state.grandchildReceipt, info.childSessionId, info.grandchildSessionId);
  log('FIXTURE_PROTOCOL_BASELINE', `mode=${mode} source=${info.sourceSessionId} child=${info.childSessionId} grandchild=${info.grandchildSessionId}`);
  if (mode === 'delta' || mode === 'deltaVisible') assert.equal(info.state.deltaRequests.length, 0, 'delta requests must start empty');

  // Position the real reader row, then apply a slow trusted wheel over that
  // readable prefix. The wheel is setup, not the owner-switch trigger.
  await page.evaluate(() => {
    const fixture = window.__rewritePrefixFixture;
    const scroller = fixture.host.querySelector('[data-virtuoso-scroller]');
    if (!scroller) throw new Error('virtuoso scroller missing before reader setup');
    scroller.scrollTop = 0;
  });
  await page.waitForFunction((readerUuid) => {
    const fixture = window.__rewritePrefixFixture;
    return !!fixture.host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
  }, info.readerUuid, { timeout: 15000 });
  await page.evaluate((readerUuid) => {
    const fixture = window.__rewritePrefixFixture;
    const scroller = fixture.host.querySelector('[data-virtuoso-scroller]');
    const row = fixture.host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
    if (!scroller || !row) throw new Error('reader row/scroller missing before wheel');
    const sr = scroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    scroller.scrollTop += rr.top - sr.top - sr.height * 0.34;
  }, info.readerUuid);
  const wheelPoint = await page.evaluate((readerUuid) => {
    const fixture = window.__rewritePrefixFixture;
    const row = fixture.host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
    const rect = row.getBoundingClientRect();
    return { x: rect.left + Math.min(240, rect.width / 2), y: rect.top + Math.min(180, rect.height / 2) };
  }, info.readerUuid);
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  for (let index = 0; index < 5; index += 1) {
    await page.mouse.wheel(0, index % 2 ? -18 : 12);
    await page.waitForTimeout(45);
  }
  await page.waitForFunction((readerUuid) => {
    const fixture = window.__rewritePrefixFixture;
    const row = fixture.host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
    return row && row.textContent.includes(fixture.readerMarker);
  }, info.readerUuid);
  log('TRUSTED_SLOW_WHEEL', 'reader prefix remained readable');

  const preAction = await page.evaluate((readerUuid) => {
    const fixture = window.__rewritePrefixFixture;
    const scroller = fixture.host.querySelector('[data-virtuoso-scroller]');
    const row = fixture.host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
    const owner = fixture.host.querySelector('[data-history-owner]');
    if (!scroller || !row || !owner) throw new Error('baseline reader identity missing');
    const textNodes = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    const text = textNodes.map((item) => item.textContent || '').join('');
    const first = textNodes.find((item) => (item.textContent || '').length > 40);
    if (!first) throw new Error('no readable text node for allowed Range setup');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(first, Math.min(48, (first.textContent || '').length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rowRect = row.getBoundingClientRect();
    const button = fixture.controls.querySelector('[data-rewrite-prefix-action]');
    return {
      selection: selection.toString(),
      textPrefix: text.slice(0, 120),
      textLength: text.length,
      scrollTop: scroller.scrollTop,
      rowTop: rowRect.top - scroller.getBoundingClientRect().top,
      sourceOwner: row.getAttribute('data-history-row-owner'),
      panelOwner: owner.getAttribute('data-history-owner'),
      buttonRect: button.getBoundingClientRect().toJSON(),
    };
  }, info.readerUuid);
  assert.ok(preAction.selection.length >= 20, 'allowed Range selection must be established');
  assert.ok(preAction.textPrefix.includes('ПРЕФИКС-ЧИТАЕМЫЙ-РЯД'), 'readable prefix text');
  assert.equal(preAction.rowTop, preAction.rowTop, 'baseline geometry sampled');

  await page.evaluate(({ readerUuid, expectedSelection, expectedTextPrefix }) => {
    const fixture = window.__rewritePrefixFixture;
    const host = fixture.host;
    const scroller = host.querySelector('[data-virtuoso-scroller]');
    const row = host.querySelector(`[data-uuid="${readerUuid}"][data-history-row-real]`);
    const samples = [];
    if (!scroller || !row) throw new Error('sampler baseline row/scroller missing');
    const refs = { scroller, row };
    let stopRequested = false;
    let done = false;
    const acceptance = {
      samples,
      done,
      expectedSelection,
      expectedTextPrefix,
      requestStop() { stopRequested = true; },
    };
    window.__rewritePrefixAcceptance = acceptance;
    const sample = (phase) => {
      const currentSessionId = fixture.getCurrentSession();
      const currentRow = [...host.querySelectorAll('[data-history-row-real]')]
        .find((candidate) => candidate.textContent.includes(fixture.readerMarker));
      const selected = window.getSelection()?.toString() || '';
      const scrollerRect = scroller.getBoundingClientRect();
      const rowRect = currentRow?.getBoundingClientRect();
      samples.push({
        phase,
        time: performance.now(),
        currentSessionId,
        presented: fixture.presented,
        scrollTop: scroller.scrollTop,
        anchor: rowRect ? rowRect.top - scrollerRect.top : null,
        rowConnected: !!currentRow?.isConnected,
        sameRow: currentRow === refs.row,
        sameScroller: host.querySelector('[data-virtuoso-scroller]') === refs.scroller,
        uuid: currentRow?.getAttribute('data-uuid') || null,
        owner: currentRow?.getAttribute('data-history-row-owner') || null,
        durableSource: currentRow?.getAttribute('data-history-durable-source') || null,
        rowReal: !!currentRow?.matches('[data-history-row-real]'),
        rowShell: !!currentRow?.matches('[data-history-mount-shell]'),
        viewportLoader: !!host.querySelector('[data-history-viewport-loader]'),
        viewportReady: host.querySelector('[data-history-owner]')?.getAttribute('data-history-viewport-ready') === '1',
        textSample: currentRow?.textContent?.slice(0, 180) || '',
        textPrefix: currentRow?.textContent?.slice(0, expectedTextPrefix.length) || '',
        textLength: currentRow?.textContent?.length || 0,
        selection: selected,
        selectionMatches: selected === expectedSelection,
      });
    };
    const tick = () => {
      const phase = `${fixture.getCurrentSession()}:${fixture.presented ? 'shown' : 'hidden'}`;
      sample(phase);
      if (stopRequested && samples.length > 12) {
        done = true;
        acceptance.done = true;
        return;
      }
      requestAnimationFrame(tick);
      acceptance.done = false;
    };
    requestAnimationFrame(tick);
  }, { readerUuid: info.readerUuid, expectedSelection: preAction.selection, expectedTextPrefix: preAction.textPrefix });

  if (mode === 'inPlace') {
    const action = controls.locator('[data-rewrite-prefix-action]');
    const buttonBefore = await action.boundingBox();
    assert.ok(buttonBefore, 'fixed inPlace button must be visible');
    await action.click();
    await page.waitForFunction(() => {
      const state = window.__rewritePrefixFixture.state();
      return state.inPlaceTriggered === true && state.inPlaceActions.length === 1;
    }, { timeout: 15000 });
    await page.waitForFunction(() => {
      const state = window.__rewritePrefixFixture.state();
      return state.historyRequests.some((request) => (
        request.sessionId === state.currentSessionId
        && request.payloadGeneration === 'file:ino-new'
        && !request.hasRewriteFrom
      ));
    }, { timeout: 15000 });
    await page.waitForFunction((marker) => {
      const fixture = window.__rewritePrefixFixture;
      const row = [...fixture.host.querySelectorAll('[data-history-row-real]')]
        .find((candidate) => candidate.textContent.includes(marker));
      return !!row;
    }, 'INPLACE-NEW', { timeout: 15000 });
    await page.waitForTimeout(700);
    const buttonAfter = await action.boundingBox();
    assert.ok(buttonAfter, 'fixed inPlace button must remain visible');
    assert.ok(Math.abs(buttonAfter.x - buttonBefore.x) <= 0.5 && Math.abs(buttonAfter.y - buttonBefore.y) <= 0.5,
      `fixed inPlace button moved: before=${JSON.stringify(buttonBefore)} after=${JSON.stringify(buttonAfter)}`);
    await page.evaluate(() => window.__rewritePrefixAcceptance.requestStop());
    await page.waitForFunction(() => window.__rewritePrefixAcceptance?.done, { timeout: 5000 });
    const acceptance = await page.evaluate(() => window.__rewritePrefixAcceptance);
    results.samples = acceptance.samples.length;
    const oldSamples = acceptance.samples.filter((sample) => !sample.textSample.includes('INPLACE-NEW'));
    const newSamples = acceptance.samples.filter((sample) => sample.textSample.includes('INPLACE-NEW'));
    assert.ok(oldSamples.length > 0, 'inPlace needs pre-generation samples');
    assert.ok(newSamples.length > 0, 'inPlace new payload was not painted');
    assert.ok(newSamples.some((sample) => !sample.sameRow || !sample.sameScroller),
      'inPlace payload generation did not cause an honest physical remount');
    const readySamples = newSamples.filter((sample) => sample.viewportReady);
    assert.ok(readySamples.length > 0, 'inPlace target never became viewport-ready');
    assert.ok(readySamples.every((sample) => !sample.viewportLoader && sample.rowConnected && sample.rowReal),
      'inPlace target remained behind loader/blank after ready');
    const inPlaceState = await page.evaluate(() => window.__rewritePrefixFixture.state());
    const newGenerationRequests = inPlaceState.historyRequests.filter((request) => request.payloadGeneration === 'file:ino-new');
    assert.ok(newGenerationRequests.length >= 1, 'expected a controlled same-session new-generation load');
    assert.ok(inPlaceState.historyRequests.every((request) => !request.hasRewriteFrom), 'inPlace must not use a prefix receipt');
    results.cases.push({
      status: 'PASS', mode, samples: acceptance.samples.length,
      oldSamples: oldSamples.length, newSamples: newSamples.length,
      remounted: newSamples.some((sample) => !sample.sameRow || !sample.sameScroller),
      payloadGeneration: 'file:ino-old→file:ino-new',
      newGenerationRequests: newGenerationRequests.length,
    });
    await fs.writeFile(artifact('acceptance-samples.json'), JSON.stringify(acceptance, null, 2));
    await page.screenshot({ path: artifact('final-full-surface.png') });
    log('INPLACE_ASSERTIONS_PASS', `samples=${acceptance.samples.length} newGenerationRequests=${newGenerationRequests.length}`);
    fixtureStateBeforeDestroy = inPlaceState;
    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => (
      !expectedConsoleErrorPrefixes.some((prefix) => message.startsWith(prefix))
    ));
    results.expectedConsoleErrors = consoleErrors.filter((message) => (
      expectedConsoleErrorPrefixes.some((prefix) => message.startsWith(prefix))
    ));
    results.unexpectedConsoleErrors = unexpectedConsoleErrors;
    assert.deepEqual(unexpectedConsoleErrors, [], `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
    results.status = 'PASS';
    throw new ScenarioCompleted();
  }

  const action = controls.locator('[data-rewrite-prefix-action]');
  const buttonBefore = await action.boundingBox();
  assert.ok(buttonBefore, 'fixed rewrite button must be visible');
  await action.click();
  await page.waitForFunction((childId) => {
    const fixture = window.__rewritePrefixFixture;
    return fixture.getCurrentSession() === childId
      && fixture.state().bindingAcks.length >= 1
      && fixture.state().buttonActions.length >= 1;
  }, info.childSessionId, { timeout: 15000 });
  await page.waitForTimeout(700);
  const childState = await page.evaluate(() => window.__rewritePrefixFixture.state());
  assert.equal(childState.bindingAcks[0].expectedSessionId, info.sourceSessionId, 'source→child CAS expected id');
  assert.equal(childState.bindingAcks[0].sessionId, info.childSessionId, 'source→child CAS target id');
  assert.equal(childState.bindingAcks[0].reason, 'deleteRange', 'source→child reason');
  log('VISIBLE_HANDOFF_CHILD', `ack=${childState.bindingAcks[0].fixtureAck} session=${info.childSessionId}`);

  const hiddenOwnerChange = mode === 'full' || mode === 'delta';
  const metadataOwnerChange = mode === 'metadata';
  // Required existing hidden-owner contract: a hidden owner change is allowed
  // a bounded two-rAF paint gate for the target owner. The loader must not be
  // removed merely to make the handoff look continuous; after the target
  // owner reports data-history-viewport-ready=1, no loader/blank is allowed.
  if (hiddenOwnerChange) {
    await page.evaluate(() => window.__rewritePrefixFixture.show(false));
    assert.equal(await page.evaluate(() => window.__rewritePrefixFixture.state().presented), false);
  }
  await action.click();
  await page.waitForFunction((grandchildId) => {
    const fixture = window.__rewritePrefixFixture;
    return fixture.getCurrentSession() === grandchildId
      && fixture.state().bindingAcks.length >= 2
      && fixture.state().buttonActions.length >= 2;
  }, info.grandchildSessionId, { timeout: 15000 });
  await page.waitForTimeout(300);
  const grandchildState = await page.evaluate(() => window.__rewritePrefixFixture.state());
  assert.equal(grandchildState.bindingAcks[1].expectedSessionId, info.childSessionId, 'child→grandchild CAS expected id');
  assert.equal(grandchildState.bindingAcks[1].sessionId, info.grandchildSessionId, 'child→grandchild CAS target id');
  assert.equal(grandchildState.bindingAcks[1].reason, 'editRange', 'child→grandchild reason');
  if (mode === 'delta' || mode === 'deltaVisible') {
    assert.equal(grandchildState.deltaRequests.length, 2, 'delta prepare response for both rewrites');
    assert.ok(grandchildState.deltaRequests.every((request) => request.hasEntries === false), 'delta must omit full entries');
    assert.ok(grandchildState.deltaRequests.every((request) => request.carriedEntries === 18 && request.changedEntries === 1 && request.order === 19),
      'delta prefix/tail shape');
  }
  await page.waitForFunction((grandchildId) => {
    const fixture = window.__rewritePrefixFixture;
    return fixture.state().historyRequests.some((request) => (
      request.sessionId === grandchildId && !request.hasRewriteFrom
    ));
  }, info.grandchildSessionId, { timeout: 15000 });
  const requestCountBeforePresentation = await page.evaluate(() => window.__rewritePrefixFixture.state().historyRequests.length);
  log(hiddenOwnerChange ? 'HIDDEN_HANDOFF_GRANDCHILD' : 'VISIBLE_REPEAT',
    `ack=${grandchildState.bindingAcks[1].fixtureAck} session=${info.grandchildSessionId}`);
  if (hiddenOwnerChange) await page.evaluate(() => window.__rewritePrefixFixture.show(true));
  // The acceptance sampler below is the authoritative post-show proof. A
  // fixed settle keeps this handoff bounded without duplicating its identity
  // assertions before the first visible rAF sample.
  await page.waitForTimeout(700);
  const requestCountAfterPresentation = await page.evaluate(() => window.__rewritePrefixFixture.state().historyRequests.length);
  if (hiddenOwnerChange) {
    assert.equal(requestCountAfterPresentation, requestCountBeforePresentation, 'show must not trigger an extra source fetch');
    log('PRESENTATION_RESHOWN', `hidden rewrite completed with the same presentation channel requests=${requestCountBeforePresentation}`);
  }

  const buttonAfter = await action.boundingBox();
  assert.ok(buttonAfter, 'fixed rewrite button must remain visible');
  assert.ok(Math.abs(buttonAfter.x - buttonBefore.x) <= 0.5 && Math.abs(buttonAfter.y - buttonBefore.y) <= 0.5,
    `fixed button moved: before=${JSON.stringify(buttonBefore)} after=${JSON.stringify(buttonAfter)}`);

  await page.evaluate(() => window.__rewritePrefixAcceptance.requestStop());
  await page.waitForFunction(() => window.__rewritePrefixAcceptance?.done, { timeout: 5000 });
  const acceptance = await page.evaluate(() => window.__rewritePrefixAcceptance);
  results.samples = acceptance.samples.length;
  assert.ok(acceptance.samples.length >= 60, `continuous rAF sample count too small: ${acceptance.samples.length}`);
  const visibleSamples = acceptance.samples.filter((sample) => sample.presented);
  assert.ok(visibleSamples.length >= 30, 'must have visible samples before and after handoffs');
  const maxDrift = Math.max(...visibleSamples.map((sample) => Math.abs(sample.anchor - visibleSamples[0].anchor)));
  results.maxDriftPx = maxDrift;
  const sourceVisible = visibleSamples.filter((sample) => sample.currentSessionId === info.sourceSessionId);
  const childVisible = visibleSamples.filter((sample) => sample.currentSessionId === info.childSessionId);
  const grandchildVisible = visibleSamples.filter((sample) => sample.currentSessionId === info.grandchildSessionId);
  assert.ok(sourceVisible.length > 0, 'pre-adoption visible rAF samples');
  assert.ok(childVisible.length > 0, 'child visible rAF samples');
  assert.ok(grandchildVisible.length > 0, 'grandchild visible rAF samples');
  assert.ok(maxDrift <= 2, `anchor drift ${maxDrift}px exceeds 2px`);
  assert.ok(visibleSamples.every((sample) => sample.sameScroller), 'scroller DOM object changed');
  assert.ok(visibleSamples.every((sample) => sample.sameRow), 'readable prefix row DOM object changed');
  assert.ok(visibleSamples.every((sample) => sample.rowConnected && sample.rowReal && !sample.rowShell),
    'painted readable row became disconnected or loader shell');
  assert.ok(visibleSamples.every((sample) => sample.textPrefix === acceptance.expectedTextPrefix),
    'readable prefix text changed or disappeared');
  assert.ok(visibleSamples.every((sample) => sample.textLength >= acceptance.expectedTextPrefix.length),
    'readable row text became empty');
  assert.ok(visibleSamples.every((sample) => sample.selectionMatches), 'selection did not survive owner adoption');
  const sourceChildVisible = visibleSamples.filter((sample) => (
    sample.currentSessionId === info.sourceSessionId || sample.currentSessionId === info.childSessionId
  ));
  assert.ok(sourceChildVisible.every((sample) => !sample.viewportLoader),
    'visible source→child adoption must not show a viewport loader');
  const grandchildShown = grandchildVisible.filter((sample) => sample.presented);
  if (!hiddenOwnerChange && !metadataOwnerChange) {
    assert.ok(visibleSamples.every((sample) => !sample.viewportLoader),
      'visible repeat must not show a viewport loader');
    assert.ok(grandchildShown.every((sample) => sample.rowConnected && sample.rowReal && sample.textLength > 0),
      'visible repeat must not show blank content');
    results.hiddenWakePaintGateFrames = 0;
    results.hiddenWakeLoaderFrames = 0;
  } else if (metadataOwnerChange) {
    const firstGrandchildReady = grandchildShown.findIndex((sample) => sample.viewportReady);
    assert.ok(firstGrandchildReady >= 0, 'metadata target owner never became viewport-ready');
    const metadataGate = grandchildShown.slice(0, firstGrandchildReady);
    results.hiddenWakePaintGateFrames = metadataGate.length;
    results.hiddenWakeLoaderFrames = metadataGate.filter((sample) => sample.viewportLoader).length;
    assert.ok(metadataGate.length <= 2, `metadata paint gate exceeded 2 rAF: ${metadataGate.length}`);
    const metadataAfterReady = grandchildShown.slice(firstGrandchildReady);
    assert.ok(metadataAfterReady.length > 0, 'no metadata samples after viewport-ready');
    assert.ok(metadataAfterReady.every((sample) => !sample.viewportLoader && sample.rowConnected && sample.rowReal && sample.textLength > 0),
      'metadata repeat has loader/blank after viewport-ready');
    assert.ok(metadataAfterReady.every((sample) => sample.sameRow && sample.sameScroller && sample.selectionMatches),
      'metadata repeat lost same DOM/selection proof');
  } else {
    const firstGrandchildReady = grandchildShown.findIndex((sample) => sample.viewportReady);
    assert.ok(firstGrandchildReady >= 0, 'grandchild target owner never became viewport-ready');
    const hiddenWakeGate = grandchildShown.slice(0, firstGrandchildReady);
    results.hiddenWakePaintGateFrames = hiddenWakeGate.length;
    results.hiddenWakeLoaderFrames = hiddenWakeGate.filter((sample) => sample.viewportLoader).length;
    assert.ok(hiddenWakeGate.length <= 2, `hidden target paint gate exceeded 2 rAF: ${hiddenWakeGate.length}`);
    const grandchildAfterReady = grandchildShown.slice(firstGrandchildReady);
    assert.ok(grandchildAfterReady.length > 0, 'no grandchild samples after viewport-ready');
    assert.ok(grandchildAfterReady.every((sample) => !sample.viewportLoader),
      'target owner must have no viewport loader after viewport-ready');
    assert.ok(grandchildAfterReady.every((sample) => sample.rowConnected && sample.rowReal && sample.textLength > 0),
      'target owner must not show blank after viewport-ready');
    assert.ok(grandchildAfterReady.every((sample) => sample.sameRow && sample.sameScroller && sample.selectionMatches),
      'target owner paint proof lost row/scroller/selection');
  }
  assert.ok(childVisible.some((sample) => sample.uuid?.includes(info.childSessionId) && sample.owner !== preAction.sourceOwner),
    'child row uuid/owner was not adopted');
  assert.ok(grandchildVisible.some((sample) => sample.uuid?.includes(info.grandchildSessionId)),
    'grandchild row uuid was not adopted after hidden handoff');
  assert.ok(grandchildVisible.some((sample) => sample.durableSource.includes(info.grandchildSessionId)),
    'grandchild durable source identity was not updated');
  results.cases.push({
    status: 'PASS',
    samples: acceptance.samples.length,
    visibleSamples: visibleSamples.length,
    maxDriftPx: maxDrift,
    sourceVisible: sourceVisible.length,
    childVisible: childVisible.length,
    grandchildVisible: grandchildVisible.length,
    sameScroller: visibleSamples.every((sample) => sample.sameScroller),
    sameRow: visibleSamples.every((sample) => sample.sameRow),
    hiddenWakePaintGateFrames: results.hiddenWakePaintGateFrames,
    hiddenWakeLoaderFrames: results.hiddenWakeLoaderFrames,
    requestCountBeforePresentation,
    requestCountAfterPresentation,
    mode,
  });
  await fs.writeFile(artifact('acceptance-samples.json'), JSON.stringify(acceptance, null, 2));
  await page.screenshot({ path: artifact('final-full-surface.png') });
  log('ASSERTIONS_PASS', `samples=${acceptance.samples.length} maxDriftPx=${maxDrift}`);
  fixtureStateBeforeDestroy = await page.evaluate(() => window.__rewritePrefixFixture.state());
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
  const unexpectedConsoleErrors = consoleErrors.filter((message) => (
    !expectedConsoleErrorPrefixes.some((prefix) => message.startsWith(prefix))
  ));
  results.expectedConsoleErrors = consoleErrors.filter((message) => (
    expectedConsoleErrorPrefixes.some((prefix) => message.startsWith(prefix))
  ));
  results.unexpectedConsoleErrors = unexpectedConsoleErrors;
  assert.deepEqual(unexpectedConsoleErrors, [], `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
  results.status = 'PASS';
} catch (error) {
  if (error instanceof ScenarioCompleted) {
    // The inPlace branch finalized its assertions; finally still owns rollback.
  } else {
  results.status = 'FAIL';
  results.failure = { message: error?.message || String(error), stack: error?.stack || null };
  log('ASSERTIONS_FAIL', results.failure.message);
  if (page) {
    try { await page.screenshot({ path: artifact('failure-full-surface.png') }); } catch {}
    try {
      const diagnostic = await page.evaluate(() => ({
        fixture: window.__rewritePrefixFixture?.state?.() || null,
        acceptance: window.__rewritePrefixAcceptance || null,
        bodyText: document.body.innerText.slice(0, 2000),
      }));
      await fs.writeFile(artifact('failure-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    } catch {}
  }
  }
} finally {
  if (page && fixtureId) {
    try {
      fixtureStateBeforeDestroy = fixtureStateBeforeDestroy || await page.evaluate(() => window.__rewritePrefixFixture?.state?.());
      await page.evaluate(() => window.__rewritePrefixFixture?.destroy());
      const rollback = await page.evaluate((id) => ({
        fixtureGone: !document.querySelector(`[data-rewrite-prefix-fixture="${id}"]`),
        controlsGone: !document.querySelector(`[data-rewrite-prefix-controls="${id}"]`),
        projectGone: !window.__rewritePrefixFixture?.hasProject?.(),
      }), fixtureId);
      results.rollback = { ...rollback, inMemoryMutations: fixtureStateBeforeDestroy?.bindingAcks?.length || 0 };
      log('ROLLBACK_PROOF', JSON.stringify(results.rollback));
      await fs.writeFile(artifact('rollback.json'), JSON.stringify(results.rollback, null, 2));
    } catch (error) {
      results.rollback = { status: 'FAIL', error: error?.message || String(error) };
      log('ROLLBACK_FAIL', results.rollback.error);
    }
  }
  results.baselineConsoleErrors = baselineConsoleErrors;
  await fs.writeFile(artifact('result.json'), JSON.stringify({
    ...results, pageErrors, consoleErrors, baselineConsoleErrors,
  }, null, 2));
  await fs.writeFile(artifact('run.log'), `${logLines.join('\n')}\n`);
  console.log(JSON.stringify({ ...results, pageErrors, consoleErrors, baselineConsoleErrors }, null, 2));
  await browser.close();
}

process.exitCode = results.status === 'PASS' && results.rollback?.fixtureGone ? 0 : 1;
