'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
let { createBuildContinueOperations, restartReceiptBinding } = require('./build-continue-operation');
if (process.env.BUILD_CONTINUE_PROMPT_PRE) {
  const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
  const name = path.join(__dirname, 'prompt.saved.cjs'), m = new Module(name, module); m.filename = name; m.paths = module.paths;
  m._compile(fs.readFileSync(process.env.BUILD_CONTINUE_PROMPT_PRE, 'utf8'), name);
  ({ createBuildContinueOperations, restartReceiptBinding } = m.exports);
}
const { RESTART_PROMPT } = require('./build-continue-prompt');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const copy = x => JSON.parse(JSON.stringify(x)), hash = s => crypto.createHash('sha256').update(s).digest('hex');
function options(saved) {
  const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 1 };
  return { pid: 11, instanceId: 'source', now: () => 1000, read: saved.read, write: saved.write,
    readRuns: async () => [], captureTabs: () => [{ known: true, tabId: 'T', projectId: 'P', toolType: 'codex', sessionId: 'S',
      busy: true, revision: 'R', executionContext: context,
      subject: { kind: 'codex-execution', targetExecutionContext: context },
      ownBackground: { known: true, agentCount: 1, truncated: false, items: [{ kind: 'agent', id: 'native-agent-A', sessionId: 'child-A' }] } }] };
}
test('capture freezes explicit Russian continuation and original native child metadata; external work is not replayed', async () => {
  let saved;
  const s = createBuildContinueOperations(options({ read: () => saved, write: v => { saved = copy(v); } }));
  const op = await s.capture('prompt-capture-one', 11), target = op.targets[0]; s.dispose();
  assert.equal(typeof target.continuationPrompt, 'string', 'new capture must freeze its continuation text');
  assert(target.continuationPrompt.startsWith(RESTART_PROMPT)); assert.match(target.continuationPrompt, /child-A/);
  assert.equal(target.nativeChildren.items[0].id, 'native-agent-A');
  assert.equal(saved.version, 4); assert.match(RESTART_PROMPT, /^Продолжай/); assert.match(RESTART_PROMPT, /внутренними инструментами/);
  assert.match(RESTART_PROMPT, /запусти их заново/); assert.match(RESTART_PROMPT, /не запускай их повторно/);
  const reopened = createBuildContinueOperations({ read: () => saved, write() {} });
  assert.equal(reopened.get(op.id).targets[0].continuationPrompt, target.continuationPrompt); reopened.dispose();
});
for (const legacy of [false, true]) for (const transport of ['logical', 'prepared']) test(`canonical binding preserves ${legacy ? 'legacy continue' : 'new frozen prompt'} / ${transport}`, () => {
  const logical = legacy ? 'continue' : RESTART_PROMPT, prompt = transport === 'logical' ? logical : '<context>\n' + logical;
  const op = { id: 'prompt-op', capturedAt: 1000 }, target = { source: { tabId: 'T', provider: 'codex', sessionId: 'S' },
    route: { kind: 'local' }, handoffId: 'H', operationKey: 'history:T:H', ...(legacy ? {} : { continuationPrompt: logical }) };
  const request = { tabId: 'T', provider: 'codex', handoffId: 'H', source: 'build-install-continue:prompt-op',
    expectedTarget: { toolType: 'codex', sessionId: 'S' }, prompt };
  const queued = { operation_key: target.operationKey, tab_id: 'T', request_json: JSON.stringify(request), request_hash: fingerprintAgentSendRequest(request) };
  const promptHash = promptAuditFingerprint(prompt), record = { state: 'confirmed', tabId: 'T', provider: 'codex', sessionId: 'S',
    handoffId: 'H', operationKey: target.operationKey, attemptId: 'A', promptHash,
    auditIdentity: { provider: 'codex', sessionId: 'S', attemptId: 'A', promptHash, entryUuid: 'user', auditTimestamp: new Date(2000).toISOString() },
    receipt: { exactAuditConfirmed: true, actualHash: promptHash } };
  const prepared = transport === 'prepared' ? { tab_id: 'T', handoff_id: 'H', status: 'delivered', base_hash: hash(logical),
    prepared_prompt: prompt, payload_hash: promptAuditFingerprint(prompt) } : null;
  const before = copy(record), proof = restartReceiptBinding(op, target, record, queued, prepared);
  assert(proof); assert.equal(proof.logicalHash, hash(logical)); assert.deepEqual(record, before);
  if (!legacy && prepared) assert.equal(restartReceiptBinding(op, target, record, queued, { ...prepared, base_hash: hash('continue') }),
    null, 'old logical hash cannot certify a changed new payload');
});
test('scoped projection never reads provider History or changes the captured input', async () => {
  let saved; const s = createBuildContinueOperations(options({ read: () => saved, write: v => { saved = copy(v); } }));
  await s.capture('prompt-capture-one', 11); const before = copy(saved);
  const view = s.forTab('T'); assert.equal(view.length, 1); assert.equal(view[0].phase, 'captured'); assert.equal(view[0].active, true);
  assert.equal(s.forTab('foreign').length, 0); assert.deepEqual(saved, before); s.dispose();
});
test('bounded finished history cannot hide an older active hold from its request dock', async () => {
  let saved; const s = createBuildContinueOperations(options({ read: () => saved, write: v => { saved = copy(v); } }));
  const original = await s.capture('prompt-capture-one', 11); s.dispose();
  saved.operations.push(...Array.from({ length: 40 }, (_, i) => ({ ...copy(original), id: 'finished-capture-' + i,
    capturedAt: original.capturedAt + i + 1, phase: 'settled', targets: original.targets.map(target => ({ ...copy(target), state: 'confirmed' })) })));
  const reopened = createBuildContinueOperations({ read: () => saved, write() { assert.fail('projection is read-only'); } });
  const rows = reopened.forTab('T'); assert.equal(rows.length, 33);
  assert.equal(rows.filter(target => !target.active).length, 32);
  assert.equal(rows.find(target => target.active)?.operationId, original.id); reopened.dispose();
});
test('status retains only exact related request identities, without treating captured Research status as current', async () => {
  let saved; const opts = options({ read: () => saved, write: v => { saved = copy(v); } });
  opts.readRuns = async () => [
    { runId: 'research-original', runKind: 'external-research', sourceTabId: 'T', status: 'running', externalResearchJobId: 'same-job' },
    { runId: 'foreign-request', runKind: 'external-research', sourceTabId: 'other', status: 'running' },
  ];
  const service = createBuildContinueOperations(opts); await service.capture('prompt-capture-one', 11);
  const before = copy(saved), rows = service.forTab('T');
  assert.deepEqual(rows[0].relatedRequests, [{ runId: 'research-original', runKind: 'external-research', externalResearchJobId: 'same-job' }]);
  assert.equal(rows[0].relatedRequests[0].status, undefined, 'capture-time running cannot override the live request owner');
  assert.deepEqual(saved, before); service.dispose();
});
