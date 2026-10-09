'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const moduleRoot = process.env.COMPACT_PHASE_BASELINE || __dirname;
const source = fs.readFileSync(path.join(moduleRoot, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const { createProviderSemanticShadow } = require(path.join(moduleRoot, 'provider-semantic-shadow.js'));
const contract = require(path.join(moduleRoot, 'compact-operation-state.js'));
const { codexProviderPreviewOwnerVerdict } = require('./codex-provider-preview');

function fixture() {
  let now = 1000, session = 'S', generation = 'G';
  const term = {}, publications = [], busy = [], previews = [];
  const registry = contract.createCompactOperationRegistry({ now: () => now, publish: op => publications.push(op) });
  const owner = { sourceId: 'source', launchId: 'L', terminalToken: term, runSeq: 1, lifecycleGeneration: 'G' };
  const watcher = { sessionId: 'S', processGeneration: 'G', offset: 100, eventSequence: 2 };
  const context = vm.createContext({ console: { log() {}, warn() {} }, Date,
    codexProviderSemanticSources: new Map([['T', owner]]), codexTurnWatchers: new Map([['T', watcher]]),
    codexPromptGeneration: new Map([['T', 1]]), compactOperations: registry, codexProviderPreviewOwnerVerdict,
    currentCodexProviderSemanticOwnerContext: () => ({ terminalToken: term, runSeq: 1, lifecycleGeneration: generation, launchId: 'L' }),
    getCodexWriterProofSnapshot: () => ({ sessionId: session }),
    captureCodexManualCompactBoundary: (_tab, o) => ({ tabId: 'T', sessionId: o.sessionId, generation: o.generation, sourceByteOffset: 100 }),
    publishCodexProviderTurnActivity: detail => { busy.push(detail); owner.turnActive = detail.active; },
    terminalHistoryPreviewController: { observeSemanticEvent: detail => { previews.push(detail); return true; } },
  });
  const handler = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleCodexProviderSemanticEvent');
  assert.ok(handler); vm.runInContext(handler.getText(ast), context);
  const shadow = createProviderSemanticShadow({ now: () => now, log: { log() {}, warn() {} },
    authorizeCodexMainRequest: () => ({ allowed: true, reason: 'fixture-exact-causal-writer' }),
    onCodexSemanticEvent: context.handleCodexProviderSemanticEvent });
  const connection = shadow.createCodexConnection({ tabId: 'T', sourceId: 'source' });
  const request = (kind = 'compaction', id = 'R', sid = 'S') => connection.beginRequest({
    type: 'response.create', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
      session_id: sid, thread_id: sid, turn_id: 'TURN', request_kind: kind,
    }) },
  }, id);
  return { registry, request, connection, publications, busy, owner, watcher, previews,
    now: value => { now = value; }, writer: value => { session = value; }, generation: value => { generation = value; },
    event: event => context.handleCodexProviderSemanticEvent({ tabId: 'T', sourceId: 'source', event }) };
}

test('actual provider tap → Main event → existing registry publishes native phase without a fabricated /compact Send', () => {
  const h = fixture(); h.request();
  const active = h.registry.snapshot('T', 'codex').active;
  assert.ok(active, 'native compact must not disappear as generic Working');
  assert.equal(active.phase, 'compacting'); assert.equal(active.source, 'provider-compaction');
  assert.equal(active.startedAt, 1000); assert.equal(active.command, null);
  assert.equal(active.handoffId, null); assert.equal(active.sendOperationKey, null); assert.equal(active.sendAttemptId, null);
  assert.equal(h.busy[0].phase, 'compacting'); assert.equal(h.busy[0].active, true);
});

test('network response end does not settle compact or idle; canonical post-request compacted does, without whole-turn end', () => {
  const h = fixture(); const request = h.request();
  h.connection.observeServerFrame(JSON.stringify({ type: 'response.completed', response: { id: 'response-A', output: [] } }));
  let active = h.registry.getActive('T', 'codex'); assert.ok(active);
  assert.equal(h.busy.length, 1); assert.equal(h.owner.turnActive, true);
  const fields = { tabId: 'T', provider: 'codex', operationId: active.operationId, sessionId: 'S', generation: 'G' };
  assert.equal(h.registry.observeCodexEvidence({ ...fields, kind: 'compacted', rolloutOffset: 99 }), null);
  assert.equal(h.registry.observeCodexEvidence({ ...fields, sessionId: 'foreign', kind: 'compacted', rolloutOffset: 110 }), null);
  h.now(4000);
  h.registry.observeCodexEvidence({ ...fields, kind: 'compacted', rolloutOffset: 100, eventSequence: 3, proof: 'exact-current-rollout' });
  assert.equal(h.registry.getActive('T', 'codex'), null);
  const settled = h.registry.snapshot('T').settled[0];
  assert.equal(settled.outcome, 'completed'); assert.equal(settled.endedAt, 4000);
  assert.equal(h.owner.turnActive, true, 'the ordinary turn continues after native compact');
  h.event({ type: 'turn_completed', requestId: request.requestId, requestKind: 'compaction' });
  assert.equal(h.publications.at(-1).active, false);
});

test('explicit /compact retains its original causal start, handoff and completion policy', () => {
  const h = fixture();
  h.registry.begin({ tabId: 'T', provider: 'codex', command: '/compact', operationId: 'explicit', sessionId: 'S', generation: 'G',
    handoffId: 'H', sourceByteOffset: 90, acceptedAt: 500 });
  h.request(); const active = h.registry.getActive('T');
  assert.equal(active.operationId, 'explicit'); assert.equal(active.handoffId, 'H'); assert.equal(active.startedAt, 500);
  h.registry.observeCodexEvidence({ tabId: 'T', operationId: 'explicit', kind: 'compacted', rolloutOffset: 110 });
  assert.ok(h.registry.getActive('T'), 'explicit command still waits for canonical task completion');
});

test('side/prewarm/ordinary traffic and unproven/replaced writers cannot invent a compact phase', () => {
  for (const kind of ['turn', 'prewarm', 'recap']) { const h = fixture(); h.request(kind); assert.equal(h.registry.getActive('T'), null); }
  for (const changed of ['session', 'generation']) {
    const h = fixture(); if (changed === 'session') h.writer('foreign'); else h.generation('G2');
    h.request(); assert.equal(h.registry.getActive('T'), null);
  }
});

test('pending explicit intent is not promoted by transport metadata; native phase is not rehydrated after restart', () => {
  const h = fixture(); h.registry.armPending({ tabId: 'T', provider: 'codex', command: '/compact', operationId: 'pending', sessionId: 'S', generation: 'G' });
  h.request(); assert.equal(h.registry.getActive('T'), null); assert.equal(h.registry.getPending('T').operationId, 'pending');
  assert.equal(contract.createCompactOperationRegistry().snapshot('T').active, null);
});

test('native observed start requires actual exclusive EOF, not an unread watcher offset after stat failure', () => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'captureCodexManualCompactBoundary');
  let fails = true;
  const c = vm.createContext({ codexTurnWatchers: new Map([['T', { filePath: '/synthetic', offset: 10 }]]),
    fs: { statSync() { if (fails) throw Error('unreadable'); return { size: 100 }; } } });
  vm.runInContext(node.getText(ast), c);
  const owner = { sessionId: 'S', generation: 'G' };
  assert.equal(c.captureCodexManualCompactBoundary('T', owner, { requireFileBoundary: true }), null);
  assert.equal(c.captureCodexManualCompactBoundary('T', owner).sourceByteOffset, 10, 'explicit legacy boundary policy unchanged');
  fails = false;
  assert.equal(c.captureCodexManualCompactBoundary('T', owner, { requireFileBoundary: true }).sourceByteOffset, 100);
});
