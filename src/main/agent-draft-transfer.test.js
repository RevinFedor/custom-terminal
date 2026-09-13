const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const test = require('node:test');
const {
  AgentInputCaptureProtocol, buildAgentDraftTransfer, operationMatches, readOutcome,
} = require('./agent-input-capture-protocol');
const { runCaptureHelper } = require('./noted-code-grab-v2');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf("        if (event === 'GrabInput') {");
const end = source.indexOf('\n        const hookRoute =', start);
assert.ok(start >= 0 && end > start);
const hookBody = 'async function hook(msg, sock) { for (const event of [msg.event]) { const eventSeq=1; const acknowledgeHookEnvelope=()=>{};\n'
  + source.slice(start, end) + '\n} }\nhook';

async function exercise(t, { ready = true, changeIdentityOnReturn = false, assetError = false, resolverError = false, mode = 'grab', successorAtPrepare = false, successorBeforeCommit = false } = {}) {
  const directory = fs.mkdtempSync('/tmp/noted-transfer-test-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'draft.md');
  const original = 'FULL DRAFT\nKEEP THE TAIL [Image #1]\n';
  fs.writeFileSync(file, original);
  const protocol = new AgentInputCaptureProtocol({ directory, ownerId: 'main-owner' });
  const socketPath = path.join(directory, 'hook.sock');
  const intent = protocol.arm({ tabId: 'T', terminalId: 'terminal-A', agent: 'claude', mode,
    pids: [process.pid], sock: socketPath, generation: { run: 1 } });
  let settle;
  const resultPromise = new Promise(resolve => { settle = resolve; });
  let helperFinished;
  const helperDone = new Promise(resolve => { helperFinished = resolve; });
  let stable = true;
  let successorActive = successorAtPrepare;
  const pending = { agent: 'claude', mode, captureOperation: intent, captureRequestId: 'logical-owner',
    recoveryTurnActive: () => successorActive,
    captureIdentity: { terminalToken: {}, inputRevision: 1 }, resolve: settle,
    timer: setTimeout(() => settle({ error: 'test-deadline' }), 3000) };
  t.after(() => clearTimeout(pending.timer));
  const pendingMap = new Map([['T', pending]]);
  let stagingSawOriginal = false;
  const hook = vm.runInNewContext(hookBody, {
    console: { log() {}, warn() {}, error() {} }, clearTimeout,
    grabInputPending: pendingMap, agentInputCaptureProtocol: protocol,
    aiBoundaryTestGate: { enabled: false },
    buildAgentDraftTransfer, readCaptureOutcome: readOutcome, captureOperationMatches: operationMatches,
    validateAgentInputIdentity: () => stable,
    validateAgentExactCaptureInputTransition: () => false,
    waitForNextPtySynchronizedFrame: () => Promise.resolve({ ready: true }),
    waitForNextPtyOutput: () => Promise.resolve({ ready: true }),
    waitForAgentEditorReturnReady: async () => {
      await helperDone;
      if (changeIdentityOnReturn) stable = false;
      return { ready, reason: ready ? 'frame' : 'timeout' };
    },
    bridgeKnownSessions: new Map([['T', 'session']]),
    resolveGrabbedImagePaths: () => {
      if (resolverError) throw new Error('image resolver failed');
      return [{ id: 1, path: '/source/image.png', mediaType: 'image/png', size: 5 }];
    },
    promptQueueAssetStore: { materializeRefs: async refs => {
      stagingSawOriginal = fs.readFileSync(file, 'utf8') === original;
      if (assetError) throw new Error('disk full');
      if (successorBeforeCommit) successorActive = true;
      return refs.map(ref => ({ ...ref, path: '/durable/image.png', assetId: 'stable-image', availability: 'available' }));
    } },
    logAgentDraftProofContradiction: () => null,
    logAgentDraftProofContradictionAfterReturn() {},
    publicAgentInputIdentity: (_identity, current) => ({ terminalIdentityStable: current }),
    releaseAgentInputCapturePending: (tabId, capture, proof) => {
      const released = protocol.release(capture.captureOperation, proof);
      if (released && pendingMap.get(tabId) === capture) pendingMap.delete(tabId);
      return released;
    },
  });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const msg = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      void hook(msg, socket).catch(error => settle({ error: error.message }));
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const helper = await runCaptureHelper({ file, directory, ppid: process.pid, pid: 900001,
    env: { NOTED_GRAB_OWNER_ID: protocol.ownerId, NOTED_GRAB_TERMINAL_ID: 'terminal-A' } });
  helperFinished();
  const result = await resultPromise;
  return { result, helper, intent, original, text: fs.readFileSync(file, 'utf8'), stagingSawOriginal };
}

for (const option of ['successorAtPrepare', 'successorBeforeCommit']) {
  test('interrupt recovery preserves native draft when a successor starts at ' + option, async t => {
    const h = await exercise(t, { [option]: true });
    assert.equal(h.result.success, false);
    assert.equal(h.text, h.original);
    assert.ok(!h.result.draftTransfer, 'no ownership transfer or synthetic recovery text');
  });
}

test('actual main hook stages full assets before clear and retains transferred draft on editor-return failure', async t => {
  const run = await exercise(t, { ready: false });
  assert.equal(run.stagingSawOriginal, true);
  assert.equal(run.helper.applied, true);
  assert.equal(run.text, '');
  assert.equal(run.result.success, false);
  assert.equal(run.result.editorReturnReady, false);
  assert.equal(run.result.draftTransfer.id, run.intent.operationId);
  assert.equal(run.result.draftTransfer.text, run.original.slice(0, -1));
  assert.equal(run.result.draftTransfer.imagePaths[0].assetId, 'stable-image');
  assert.equal(run.result.captureRequestId, 'logical-owner');
});

test('actual main hook preserves acquired draft even if generation changes after helper commit', async t => {
  const run = await exercise(t, { changeIdentityOnReturn: true });
  assert.equal(run.result.success, false);
  assert.equal(run.result.terminalIdentityStable, false);
  assert.equal(run.result.draftTransfer.tabId, 'T');
  assert.equal(run.result.draftTransfer.imagePaths[0].path, '/durable/image.png');
  assert.equal(run.text, '');
});

for (const kind of ['assetError', 'resolverError']) {
  test('actual main hook ' + kind + ' cancels before grant and preserves native text', async t => {
    const run = await exercise(t, { [kind]: true });
    assert.equal(run.helper.applied, false);
    assert.equal(run.text, run.original);
    assert.equal(run.result.success, false);
    assert.equal(run.result.error, 'image_materialization_failed');
    assert.equal(run.result.draftTransfer, null);
    assert.equal(run.result.draftPreserved, true);
    assert.equal(run.result.text, run.original.slice(0, -1));
  });
}

test('non-destructive copy never claims transferred ownership', async t => {
  const run = await exercise(t, { mode: 'copy', ready: false });
  assert.equal(run.text, run.original);
  assert.equal(run.result.draftTransfer, null);
  assert.equal(run.result.text, run.original.slice(0, -1));
  assert.equal(run.result.imagePaths[0].assetId, 'stable-image');
});
