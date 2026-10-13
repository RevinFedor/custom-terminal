'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { isAutomaticPromptQueueRequest, hasPromptQueueContextConditionKey } = require('../shared/prompt-queue-send-intent.cjs');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'admitQueuedAgentSend');
assert.ok(node);
function fixture() {
  let root = { ready: true }, status = { status: 'active', inputReady: true, busy: false,
    writerConfirmed: false, writerStatus: 'provisional-source', sessionId: null }, frame = { ready: true };
  const logs = [], calls = [], queue = [];
  const ctx = { console: { log: value => logs.push(value) }, isAutomaticPromptQueueRequest, hasPromptQueueContextConditionKey,
    automaticSendAdmissionDiagnostics: new Map(), bridgeRequest: async () => { calls.push('root'); return root; },
    coherentPublicRuntimeSnapshot: async () => { calls.push('coherent'); return status; },
    resolveAgentSessionInfo: async () => { throw Error('legacy reader must not gate automatic Sends'); },
    readAutomaticSendFrame: (_tab, wake) => { calls.push('frame'); frame.wake = wake; return frame; },
    agentSendQueue: { notifyRuntime: id => queue.push(id) } };
  const admit = vm.runInNewContext(node.getText(ast) + ';admitQueuedAgentSend;', ctx);
  const request = { tabId: 'T', provider: 'codex', source: 'prompt-queue', handoffId: 'H',
    promptQueueIntent: { version: 1, kind: 'queue', itemId: 'I', armedAt: 1, triggerTabId: 'T', conditionKey: '', triggerKey: 'null' } };
  return { ctx, request, logs, calls, queue, admit: () => admit(request),
    root: value => root = value, status: value => status = value, frame: value => frame = value };
}
test('ready same-generation provisional Resume can dispatch without a first user writer row', async () => {
  const f = fixture(); assert.equal(await f.admit(), true); assert.deepEqual(f.calls, ['root', 'coherent', 'frame']);
});
test('incomplete frame parks, records its reason once and wakes only another full admission', async () => {
  const f = fixture(), frame = { ready: false, reason: 'synchronized-output-open' }; f.frame(frame);
  assert.equal(await f.admit(), false); assert.equal(await f.admit(), false); assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /reason=synchronized-output-open/); frame.wake(); assert.deepEqual(f.queue, ['T']);
  f.root({ cancel: true }); assert.equal((await f.admit()).cancel, true, 'Pause after frame wake still cancels');
});
test('Root, busy, Goal, unknown, context-owner and missing-frame guards remain independent', async () => {
  const f = fixture(); f.root({ ready: false, reason: 'editor-locked' }); assert.equal(await f.admit(), false);
  assert.deepEqual(f.calls, ['root']); f.root({ ready: true });
  for (const status of [{ status: 'unknown' }, { status: 'busy', inputReady: true, busy: true },
    { status: 'active', inputReady: true, goalWork: { version: 1, pending: true } }]) {
    f.status(status); assert.equal(await f.admit(), false);
  }
  f.status({ status: 'active', inputReady: true, sessionId: 'other' });
  f.request.promptQueueIntent.conditionKey = 'pct';
  f.request.promptQueueIntent.contextProof = { provider: 'codex', sessionId: 'original' };
  assert.equal(await f.admit(), false);
  f.request.promptQueueIntent.conditionKey = ''; f.ctx.readAutomaticSendFrame = null;
  assert.equal(await f.admit(), false);
});
test('explicit Send-now is not narrowed to automatic idle/frame admission', async () => {
  const f = fixture(); f.request.promptQueueAction = 'send-now';
  assert.equal(await f.admit(), true); assert.deepEqual(f.calls, []);
});
