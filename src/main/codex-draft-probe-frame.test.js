const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const authority = require('./codex-draft-authority');
const { createCodexDraftRequestHarness, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, 'main.js'), 'utf8');

function harness({ replacement = false, realDraft = false, flushFailure = false,
  frameBlocker = null, rendererHasDraft = true,
  rendererFrame = { generation: 'pty-a', writeSeq: 41 } } = {}) {
  let rendererRead = false, mainReads = 0, flushes = 0;
  const readMain = () => {
    mainReads++;
    return frameBlocker
      ? { success: true, hasDraft: null, source: 'headless-main:frame-not-authoritative', frameBlocker,
        frameState: { generation: 'pty-a', writeSeq: 100, flushedSeq: 99,
          synchronizedOutputOpen: frameBlocker === 'synchronized-output-open', pendingResizeWriteSeq: null } }
      : { success: true, hasDraft: rendererRead && realDraft,
        source: 'headless-main:cursor:1016:dim-hint',
        frameIdentity: { generation: 'pty-a', writeSeq: mainReads + 41 } };
  };
  const h = createCodexDraftRequestHarness({
    mirror: { generation: 'pty-a', generationOrdinal: 1, complete: true,
      synchronizedFrameWaiters: new Set() },
    getDraft: readMain,
    flush: async () => { flushes++; return { success: !flushFailure || !rendererRead }; },
  });
  return {
    read: async (options = {}) => {
      const pending = h.read('codex-pre-submit-before-paste', {
        waitFor: false, waitTimeoutMs: 100, waitOnUnknownOnly: true,
        mergeRendererPositive: true, ...options,
      }, undefined, 50);
      await drainMicrotasks();
      if (h.rendererRequest) {
        rendererRead = true;
        if (replacement) h.setCurrentMirror({ generation: 'other-pty', generationOrdinal: 2,
          complete: true, synchronizedFrameWaiters: new Set() });
        h.replyRenderer({
          success: true, hasDraft: rendererHasDraft,
          preview: '5. More reasoning…   Max and Ultra consume usage limits', source: 'tail:1024',
          frameIdentity: rendererFrame,
        });
      }
      await drainMicrotasks();
      let resolved = false;
      const tracked = pending.then(value => { resolved = true; return value; });
      await drainMicrotasks();
      if (!resolved) { h.clock.advanceToNext(); await drainMicrotasks(); }
      return tracked;
    },
    stats: () => ({ mainReads, flushes }), incidents: h.reports, logs: h.logs,
  };
}

for (const frameBlocker of ['synchronized-output-open', 'frame-not-flushed', 'post-resize-frame-not-observed']) {
  test('actual main captures unresolved preflight frame without granting renderer-negative admission: ' + frameBlocker, async () => {
    const h = harness({ frameBlocker, rendererHasDraft: false });
    const state = await h.read({ waitFor: false, waitOnUnknownOnly: true });
    assert.equal(state.hasDraft, null);
    assert.equal(state.proofOutcome, 'unknown');
    assert.equal(state.observation.status, 'expired');
    assert.equal(state.frameBlocker, frameBlocker);
    assert.equal(h.incidents.length, 1);
    assert.equal(h.incidents[0].key, 'draft-frame:T:pty-a:' + frameBlocker);
    assert.equal(h.incidents[0].payload.incidentReason, 'draft-frame-unresolved');
    assert.equal(h.incidents[0].payload.context.mainProof.frameState.writeSeq, 100);
  });
}

test('actual main request catches up after renderer reply and rejects its older positive frame', async () => {
  const h = harness();
  const state = await h.read();
  assert.equal(state.hasDraft, false);
  assert.equal(state.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.deepEqual(h.stats(), { mainReads: 2, flushes: 2 });
  assert.equal(h.incidents.length, 0, 'expected stale frame creates neither full capture nor notification');
  assert.ok(h.logs.some(line => line.includes('renderer-frame-behind')), 'ordinary log remains');
});

test('tab34: unknown main → older renderer hint → fresh empty stays routine even without positive merging', async () => {
  let reads = 0;
  const h = createCodexDraftRequestHarness({
    mirror: { generation: 'tab34-generation', generationOrdinal: 2, complete: true,
      synchronizedFrameWaiters: new Set() },
    getDraft: () => ++reads === 1
      ? { success: true, hasDraft: null, frameBlocker: 'synchronized-output-open', source: 'headless-main:partial' }
      : { success: true, hasDraft: false, preview: 'Ask Codex to do anything',
        source: 'headless-main:cursor:1034:dim-hint',
        frameIdentity: { generation: 'tab34-generation', writeSeq: 141 } },
  });
  // Same options as codex:get-draft-state: inner read never promotes positive
  // hints. It can still ask for one while its first main read is unknown.
  const pending = h.read('agent-send-preflight:history-panel', {});
  await drainMicrotasks();
  assert.ok(h.rendererRequest);
  h.replyRenderer({ success: true, hasDraft: true, preview: '› Ask Codex to do anything',
    source: 'cursor:664:multiline-draft-row-667',
    frameIdentity: { generation: 'tab34-generation', writeSeq: 100 } });
  const result = await pending;
  assert.equal(result.hasDraft, false);
  assert.equal(result.observation.status, 'settled');
  assert.equal(result.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.equal(h.reports.length, 0, 'no incident or user notification for frames100→141');
  assert.equal(reads, 2, 'no extra waiting or PTY action');
});

for (const rendererFrame of [null, { generation: 'other-pty', writeSeq: 41 },
  { generation: 'pty-a', writeSeq: 43 }, { generation: 'pty-a', writeSeq: 44 }]) {
  test('actual main preserves incident capture for a conflict not resolved as an older same-process frame: '
    + JSON.stringify(rendererFrame), async () => {
    const h = harness({ rendererFrame });
    await h.read();
    assert.equal(h.incidents.length, 1);
    assert.notEqual(h.incidents[0].payload.context.decision, 'renderer-frame-behind');
  });
}

test('actual main request preserves a genuine draft arriving during the asynchronous probe', async () => {
  const h = harness({ realDraft: true });
  assert.equal((await h.read()).hasDraft, true);
});

test('mirror replacement while awaiting renderer cannot authorize input in another process', async () => {
  assert.equal((await harness({ replacement: true }).read()).hasDraft, null);
});

test('failed final flush never reuses earlier empty proof; conservative positive fallback still protects input', async () => {
  assert.equal((await harness({ flushFailure: true }).read()).hasDraft, true);
});

for (const [rendererSeq, mainSeq] of [[125, 148], [45, 93], [86, 95]])
test(`renderer caller → real IPC handler logs frame ${rendererSeq} → ${mainSeq} without capturing an incident`, async () => {
  const { readCodexDraftAuthority } = await import('../renderer/utils/codexDraftAuthority.mjs');
  const start = source.indexOf("ipcMain.handle('codex:get-draft-state'");
  const end = source.indexOf("ipcMain.handle('claude:get-draft-state'", start);
  const reports = [], logs = [], handlers = new Map();
  const mainState = { success: true, hasDraft: false, source: 'headless-main',
    frameIdentity: { generation: 'G', writeSeq: mainSeq } };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, mainWindow: null,
    requestTerminalCodexDraftState: async () => mainState,
    decorateAgentDraftProofIdentity: (_tabId, result) => result,
    mergeCodexDraftAuthority: authority.mergeCodexDraftAuthority,
    isExpectedStaleCodexDraftObservation: authority.isExpectedStaleCodexDraftObservation,
    reportTerminalIncident: (...args) => reports.push(args),
    console: { log: message => logs.push(message) },
  });
  const result = await readCodexDraftAuthority({ tabId: 'T',
    visualState: { hasDraft: true, preview: 'old menu', source: 'renderer',
      frameIdentity: { generation: 'G', writeSeq: rendererSeq } },
    invoke: (name, ...args) => handlers.get(name)(null, ...args),
  });
  assert.equal(result.hasDraft, false);
  assert.equal(result.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.equal(reports.length, 0);
  assert.ok(logs.some(line => line.includes('renderer-frame-behind')));
});

for (const frameIdentity of [null, { generation: 'other-process', writeSeq: 125 }])
test('real IPC retains its full diagnostic when the caller sample has unknown or different ownership: '
  + JSON.stringify(frameIdentity), async () => {
  const start = source.indexOf("ipcMain.handle('codex:get-draft-state'");
  const end = source.indexOf("ipcMain.handle('claude:get-draft-state'", start);
  const reports = [], handlers = new Map();
  const mainState = { success: true, hasDraft: false,
    frameIdentity: { generation: 'G', writeSeq: 148 } };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, mainWindow: null,
    requestTerminalCodexDraftState: async () => mainState,
    decorateAgentDraftProofIdentity: (_tabId, result) => result,
    ...authority,
    reportTerminalIncident: (...args) => reports.push(args),
    console: { log() {} },
  });
  const result = await handlers.get('codex:get-draft-state')(null, 'T', {
    visualState: { hasDraft: true, frameIdentity },
  });
  assert.equal(result, mainState, 'observation policy does not rewrite input proof');
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].incidentReason, 'draft-state-contradiction');
});
