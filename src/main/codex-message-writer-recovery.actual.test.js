'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { runtimeSnapshotCompletionFixture } = require('./test-helpers/runtime-snapshot-completion');
const { messageRuntimeIdentity, identityUnavailable } = require('./agent-message-identity');

const mainSource = process.env.CODEX_MESSAGE_RECOVERY_INSTALLED_ASAR
  ? require('@electron/asar').extractFile(process.env.CODEX_MESSAGE_RECOVERY_INSTALLED_ASAR, 'dist/main/main.js').toString()
  : fs.readFileSync(require.resolve('./main'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const webSource = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const webAst = ts.createSourceFile('web-server.js', webSource, ts.ScriptTarget.Latest, true);
function declaration(ast, name) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}

function fixture() {
  const h = runtimeSnapshotCompletionFixture({ tabId: 'source', sessionId: 'saved-source' });
  vm.runInContext(declaration(mainAst, 'readMainPublicRuntimeSnapshot'), h.context);
  h.adopt(); h.cleanupLaunch(); h.state.writer = null; h.state.busy = true;
  h.state.reconciles = 0;
  h.state.recovery = 'adopt';
  h.context.getCodexRuntimeSessionSnapshot = async (_id, options) => {
    h.state.reconciles++;
    assert.equal(options.reason, 'public-runtime-unconfirmed-writer');
    assert.equal(options.forceWriterReconcile, true);
    await h.state.onReconcile?.();
    if (h.state.recovery === 'throw') throw Object.assign(new Error('controlled unavailable proof'), { code: 'EIO' });
    if (h.state.recovery === 'adopt') h.adopt();
    return { sessionStatus: 'busy', liveLifecycle: true, inputReady: true,
      sessionId: h.state.writer?.sessionId || null, savedSessionId: h.state.sessionId,
      writerConfirmed: !!h.state.writer, writerUsableForMutation: !!h.state.writer };
  };
  const descriptor = { tabId: 'source', tabType: 'terminal', toolType: 'codex',
    projectId: 'P', sessionId: 'stale-descriptor' };
  const web = vm.createContext({
    console: { warn() {} }, messageRuntimeIdentity, identityUnavailable,
    findOrchestrationTabDescriptor: () => descriptor, tabMessageSdkSessions: new Map(),
    readAgentRuntimeSnapshot: () => h.snapshot(),
  });
  vm.runInContext(['resolveTabMessageIdentity', 'captureOrchestrationSourceTarget']
    .map(name => declaration(webAst, name)).join('\n'), web);
  return { ...h, descriptor, web,
    sourceTarget: () => web.captureOrchestrationSourceTarget(descriptor, null,
      { provider: 'codex', sessionId: 'saved-source' }) };
}

test('actual research source admission recovers the same live writer after a transient process-proof loss', async () => {
  const h = fixture();
  const target = await h.sourceTarget();
  assert.equal(target.sessionId, 'saved-source');
  assert.equal(h.state.reconciles, 1);
  assert.equal(h.state.lookups, 1, 'same-owner proof publication refreshes semantics without a second physical read');
  assert.equal(h.context.codexLastRunCommandPayload.size, 0, 'recovery never creates a launch');
  assert.equal(h.command.runSeq, 1);
});

test('warm writer does not run additional canonical recovery', async () => {
  const h = fixture(); h.adopt();
  assert.equal((await h.sourceTarget()).sessionId, 'saved-source');
  assert.equal(h.state.reconciles, 0);
  assert.equal(h.state.lookups, 1);
});

test('unknown physical observation cannot authorize writer recovery or borrow the saved SID', async () => {
  const h = fixture(); h.state.process = 'unknown';
  await assert.rejects(h.sourceTarget, { code: 'message_runtime_identity_unavailable' });
  assert.equal(h.state.reconciles, 0);
});

test('unproven canonical result stays unavailable without a retry loop', async () => {
  const h = fixture(); h.state.recovery = 'unknown';
  await assert.rejects(h.sourceTarget, { code: 'message_runtime_identity_unavailable' });
  assert.equal(h.state.reconciles, 1);
  assert.equal(h.state.lookups, 1);
});

test('canonical reader error is propagated without a saved-session fallback', async () => {
  const h = fixture(); h.state.recovery = 'throw';
  await assert.rejects(h.sourceTarget, { code: 'EIO' });
  assert.equal(h.state.reconciles, 1);
});

test('a different canonical conversation cannot become the original research recipient', async () => {
  const h = fixture();
  h.state.onReconcile = () => { h.state.sessionId = 'replacement'; h.state.owner++; };
  await assert.rejects(h.sourceTarget, { code: 'orchestration_source_changed_during_reservation' });
  assert.equal(h.state.reconciles, 1);
});

for (const axis of ['stop', 'input', 'terminal', 'run', 'lifecycle', 'owner', 'binding']) {
  test('continual ' + axis + ' changes during recovery never publish a mixed snapshot', async () => {
    const h = fixture(); h.state.recovery = 'unknown';
    h.state.onReconcile = () => {
      if (axis === 'stop') h.state.stop++;
      if (axis === 'input') h.state.input++;
      if (axis === 'terminal') h.context.terminals.set('source', { pid: 101 });
      if (axis === 'run') h.command.runSeq++;
      if (axis === 'lifecycle') h.state.generation += 'x';
      if (axis === 'owner') h.state.owner++;
      if (axis === 'binding') h.state.sessionId += 'x';
    };
    await assert.rejects(h.sourceTarget, { code: 'runtime_snapshot_unstable' });
    assert.equal(h.state.reconciles, 2);
  });
}

test('existing research reservation retains its original recipient without reread or new work', async () => {
  const h = fixture();
  const target = { toolType: 'codex', sessionId: 'old-original' };
  assert.equal(await h.web.captureOrchestrationSourceTarget(h.descriptor,
    { sourceSendTarget: target }), target);
  assert.equal(h.state.lookups, 0);
  assert.equal(h.state.reconciles, 0);
});

test('actual writer reconciliation restores the retained launch only after fresh physical proof', async () => {
  // Reuse the established actual Main writer harness, without registering its
  // tests. Process/file/SQLite leaves stay controlled; adoption is real code.
  const harnessFile = path.join(__dirname, 'codex-submission-observation.integration.test.js');
  const harnessAst = ts.createSourceFile(harnessFile, fs.readFileSync(harnessFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const host = vm.createContext({ assert, fs, vm, ts, require, setImmediate,
    ast: mainAst, source: mainSource, quiet: { log() {}, warn() {}, error() {} } });
  vm.runInContext(declaration(harnessAst, 'harness'), host);
  const writer = host.harness({ tabId: 'source', sessionId: 'saved-source' });
  writer.context.codexLastRunCommandPayload.clear();
  const retained = writer.context.codexWriterProofs.get('source');
  retained.valid = false; retained.invalidatedReason = 'process-proof-unknown';
  const h = fixture();
  h.state.onReconcile = async () => {
    const result = await writer.context.reconcileCodexWriterFromProcess('source', {
      reason: 'public-runtime-unconfirmed-writer' });
    assert.equal(result.status, 'adopted');
    const proof = writer.context.getCodexWriterProofSnapshot('source');
    assert.equal(proof.sessionId, 'saved-source');
    assert.equal(proof.launchId, 'fixture-launch');
    assert.ok(proof.valid);
  };
  assert.equal((await h.sourceTarget()).sessionId, 'saved-source');
  assert.equal(h.state.reconciles, 1);
  assert.equal(writer.events.some(event => event.startsWith('write:') || event === 'start-discovery'), false);
});
