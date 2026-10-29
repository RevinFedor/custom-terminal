import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createHistoryCommitWitnessDiagnostics, createUIActionDiagnostics } from './uiPerformanceDiagnostics.mjs';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';

const owner = { ownerKey: 'own-history', sessionId: 'sid', generation: 3, presentationVisit: 2 };
const row = () => ({ uuid: 'assistant-1', sessionId: 'sid', recordByteOffset: 120 });
function setup(options = {}) {
  let at = 100;
  const reports = [];
  const recorder = createUIActionDiagnostics({ now: () => at, emit: text => reports.push(JSON.parse(text.slice(text.indexOf('{')))) });
  const action = recorder.capture('click', at, {}, false);
  const helper = createHistoryCommitWitnessDiagnostics({ enabled: () => true, now: () => ++at,
    commit: recorder.commitForAction, ...options });
  const attempt = helper.begin(owner, action.id, 'read');
  return { helper, recorder, action, attempt, reports };
}
function adopt(s, sample = row(), source = {}) {
  s.helper.adopt(s.attempt, { revisionToken: 'revision-1', payloadGeneration: 'payload-1', row: sample, ...source });
  return { candidate: s.helper.candidate(), sample };
}

test('exact durable selected-row commit exports captured action/read, without claiming pixels or cache tier', () => {
  const s = setup(); const sample = row();
  const invoke = s.helper.observeRead(s.attempt, (channel, payload) => ({ channel, payload }));
  const payload = { diagnosticReadId: 'hr-1', diagnosticActionId: s.action.id };
  assert.strictEqual(invoke('history', payload).payload, payload);
  const { candidate } = adopt(s, sample);
  assert.equal(s.helper.commit(candidate, owner, sample), true);
  const proof = s.reports[0].historyWitness;
  assert.equal(proof.qualification, 'durable-row-reference');
  assert.equal(proof.revisionToken, 'revision-1'); assert.equal(proof.readId, 'hr-1');
  assert.equal(proof.payloadGeneration, 'payload-1'); assert.equal(proof.uuid, sample.uuid);
  assert.equal(proof.origin, 'read'); assert.equal(proof.cacheTier, 'unknown');
  assert.equal(proof.rowMount, 'unqualified'); assert.equal(proof.browserPresentation, 'unqualified');
  assert.equal(s.helper.present(owner), true);
  assert.ok(s.reports[1].historyWitness.observedAbs >= proof.committedAbs);
  assert.equal(s.reports[1].historyWitness.committedAbs, proof.committedAbs);
});

test('live overlay never inherits durable revision coverage; absent sequence stays unqualified', () => {
  for (const sourceSequence of [undefined, 0, 22]) {
    const s = setup(); const sample = { ...row(), liveProjection: true, sourceIdentity: 'live-source', sourceSequence };
    const { candidate } = adopt(s);
    s.helper.commit(candidate, owner, sample);
    const proof = s.reports[0].historyWitness;
    assert.equal(proof.qualification, sourceSequence === undefined ? 'unqualified-live-version' : 'live-sequence');
    assert.equal(proof.revisionToken, null); assert.equal(proof.baseRevisionToken, 'revision-1');
    assert.equal(proof.sourceSequence, sourceSequence ?? null); assert.equal(proof.sourceIdentity, 'live-source');
  }
});

test('unknown revision is explicit even with snapshot/payload presence', () => {
  const s = setup(); const { candidate, sample } = adopt(s, row(), { revisionToken: null });
  s.helper.commit(candidate, owner, sample);
  assert.equal(s.reports[0].historyWitness.qualification, 'unqualified-revision');
});

test('owner/session/generation/visit mismatch and replacement cannot publish an old witness', () => {
  for (const field of Object.keys(owner)) {
    const s = setup(); const { candidate, sample } = adopt(s);
    assert.equal(s.helper.commit(candidate, { ...owner, [field]: typeof owner[field] === 'number' ? 9 : 'other' }, sample), false);
    assert.equal(s.helper.present(owner), false); assert.equal(s.reports.length, 0);
  }
  const s = setup(); const old = adopt(s);
  adopt(s, row(), { revisionToken: 'replacement' });
  assert.equal(s.helper.commit(old.candidate, owner, old.sample), false);
  assert.equal(s.reports.length, 0);
});

test('a pending old row is not adoption proof; eventual exact committed row remains eligible', () => {
  const s = setup(); const { candidate, sample } = adopt(s);
  assert.equal(s.helper.commit(candidate, owner, { ...sample }), false);
  assert.equal(s.helper.commit(candidate, owner, sample), true);
  assert.ok(s.reports[0].historyWitness.omitted > 0);
});

test('late old action/read never binds new input; eviction is accounted by the existing recorder', async () => {
  const s = setup(); let resolve;
  const invoke = s.helper.observeRead(s.attempt, () => new Promise(done => { resolve = done; }));
  const pending = invoke('history', { diagnosticReadId: 'hr-old', diagnosticActionId: s.action.id });
  const next = s.recorder.capture('click', 102, {}, false);
  resolve('unchanged-result'); assert.equal(await pending, 'unchanged-result');
  const { candidate, sample } = adopt(s); s.helper.commit(candidate, owner, sample);
  assert.equal(s.reports[0].id, s.action.id); assert.equal(next.phases.length, 0);
  assert.equal(s.reports[0].historyWitness.readActionId, s.action.id);
  for (let i = 0; i < 100; i++) s.recorder.capture('click', 103 + i, {}, false);
  assert.equal(s.helper.present(owner), false);
  assert.equal(s.recorder.health().actionCommitsOmitted, 1);
});

test('cache restore and retained focus do not invent a new read, action or presentation', () => {
  const s = setup(); s.attempt = s.helper.begin(owner, s.action.id, 'snapshot-restore');
  const { candidate, sample } = adopt(s); s.helper.commit(candidate, owner, sample); s.helper.present(owner);
  const focus = s.recorder.capture('click', 110, {}, false);
  assert.equal(s.helper.present(owner), false);
  assert.equal(focus.phases.length, 0); assert.equal(s.reports.length, 2);
  assert.equal(s.reports[0].historyWitness.origin, 'snapshot-restore');
  assert.equal(s.reports[0].historyWitness.readId, null);
});

test('disabled helper, throwing metadata and recorder cannot alter invoke results or errors', () => {
  let calls = 0; const result = {};
  const s = setup({ enabled: () => false });
  assert.equal(s.attempt, null);
  const invoke = () => { calls++; return result; };
  assert.strictEqual(s.helper.observeRead(null, invoke), invoke);
  assert.strictEqual(invoke(), result); assert.equal(calls, 1);
  const active = setup({ commit: () => { throw Error('diagnostic emit'); } });
  const { candidate, sample } = adopt(active);
  assert.equal(active.helper.commit(candidate, owner, sample), false);
  assert.ok(active.helper.health().errors > 0);
  const bad = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('bad metadata'); } });
  const wrapped = active.helper.observeRead(active.attempt, () => result);
  assert.strictEqual(wrapped('history', bad), result);
  const error = Error('original invoke');
  assert.throws(() => active.helper.observeRead(active.attempt, () => { throw error; })('history', {}), e => e === error);
});

test('bounded scalar allowlist never reads content, getters, aliases, layout or timers', () => {
  const s = setup(); const sample = { ...row(), uuid: 'x'.repeat(10000),
    get content() { throw Error('body'); }, get sourceIdentityAliases() { throw Error('aliases'); },
    get sourceSequence() { throw Error('accessor'); }, toJSON() { throw Error('serialize row'); } };
  const { candidate } = adopt(s, sample, { revisionToken: 'r'.repeat(10000) });
  s.helper.commit(candidate, owner, sample);
  const proof = s.reports[0].historyWitness;
  assert.equal(proof.uuid, null); assert.equal(proof.revisionToken, null);
  assert.ok(proof.metadataOmitted >= 2); assert.ok(JSON.stringify(proof).length < 3000);
  assert.doesNotMatch(JSON.stringify(proof), /"content":|aliases|xxxx|rrrr/);
});

test('unsafe source counters/offsets are refused, rather than exported as exact versions', () => {
  const s = setup(); const sample = { ...row(), liveProjection: true,
    sourceSequence: Number.MAX_SAFE_INTEGER + 1, recordByteOffset: Infinity };
  const { candidate } = adopt(s);
  s.helper.commit(candidate, owner, sample);
  const proof = s.reports[0].historyWitness;
  assert.equal(proof.qualification, 'unqualified-live-version');
  assert.equal(proof.sourceSequence, null); assert.equal(proof.recordByteOffset, null);
  assert.ok(proof.metadataOmitted >= 2);
});

test('source replacement during an outstanding read rejects the former adoption even within the same owner', () => {
  const s = setup(); const old = s.attempt;
  s.attempt = s.helper.begin(owner, s.action.id, 'read');
  const next = adopt(s);
  assert.equal(s.helper.adopt(old, { revisionToken: 'stale', row: row() }), false);
  assert.equal(s.helper.commit(next.candidate, owner, next.sample), true);
  assert.equal(s.reports[0].historyWitness.revisionToken, 'revision-1');
});

test('live replacement before the surface callback cannot backdate a new UUID/version', () => {
  const s = setup(); const { candidate } = adopt(s);
  const live = { ...row(), liveProjection: true };
  s.helper.commit(candidate, owner, live);
  assert.equal(s.helper.commit(candidate, owner, { ...live, uuid: 'new-version' }), false);
  assert.equal(s.helper.present(owner), false); assert.equal(s.reports.length, 1);
});

// Execute the actual TSX diagnostic seams rather than a second implementation
// of their arguments/ordering. No React mount, filesystem fixture or UI proof.
const hp = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', hp, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
const find = predicate => {
  const node = nodes.find(predicate); assert.ok(node, 'current TSX seam exists'); return node;
};
const diagnosticDeclaration = name => find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name).getText(ast);
const execute = (code, values) => Function(...Object.keys(values),
  ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(values));
const adoption = marker => find(node => ts.isCallExpression(node)
  && node.expression.getText(ast) === 'historyCommitDiagnosticsRef.current?.adopt'
  && node.getText(ast).includes(marker)).getText(ast);
const effect = find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
  && node.arguments[0]?.getText(ast).includes('historyCommitDiagnosticsRef.current?.commit'));

test('actual HP read admission forwards real transport ID and actual adoption→layout→surface seams join it', async () => {
  const s = setup(); const sample = row(); let reads = 0;
  const result = { success: true, entries: [sample], revision: { token: 'actual-revision' } };
  const historyCommitDiagnosticsRef = { current: s.helper };
  const identityRefs = { historyOwnerKey: owner.ownerKey, ownerKeyAtStart: owner.ownerKey,
    generationAtStart: owner.generation, sessionId: owner.sessionId,
    historyPresentationProofRef: { current: { presented: true, visit: owner.presentationVisit } },
    historyCommitDiagnosticsRef, currentUIActionId: () => s.action.id,
    ipcRenderer: { invoke(channel, payload) { reads++; assert.equal(channel, 'claude:get-full-history');
      assert.equal(payload.sessionId, owner.sessionId); return Promise.resolve(result); } } };
  const captured = execute(['historyDiagnosticAttempt','historyInvoke','historyDiagnosticInvoke']
    .map(name => 'const ' + diagnosticDeclaration(name) + ';').join('\n')
    + '\nreturn { attempt: historyDiagnosticAttempt, invoke: historyDiagnosticInvoke };', identityRefs);
  const pending = readHistoryThroughIpc(captured.invoke, 'claude:get-full-history', { sessionId: owner.sessionId });
  const nextAction = s.recorder.capture('click', 105, {}, false);
  assert.strictEqual(await pending, result); assert.equal(reads, 1);
  execute(adoption('nextRevision'), { historyCommitDiagnosticsRef, historyDiagnosticAttempt: captured.attempt,
    nextRevision: result.revision, nextPayloadGeneration: 'actual-payload', rawServerEntries: result.entries });
  const candidate = s.helper.candidate();
  execute('(' + effect.arguments[0].getText(ast) + ')();', {
    historyCommitDiagnosticsRef, historyCommitCandidateAtRender: candidate,
    presentedOwnerKey: owner.ownerKey, historyOwnerKey: owner.ownerKey,
    historyOwnerKeyRef: { current: owner.ownerKey }, historyOwnerGenerationRef: { current: owner.generation },
    historyPresentationProofRef: identityRefs.historyPresentationProofRef, surfaceLoading: false,
    sessionId: owner.sessionId, transcriptEntries: result.entries,
  });
  const presentCall = find(node => ts.isCallExpression(node)
    && node.expression.getText(ast) === 'historyCommitDiagnosticsRef.current?.present');
  execute(presentCall.getText(ast), { historyCommitDiagnosticsRef, ...owner });
  assert.equal(s.reports.length, 2); assert.equal(s.reports[0].id, s.action.id);
  assert.match(s.reports[0].historyWitness.readId, /^hr-/);
  assert.equal(s.reports[0].historyWitness.revisionToken, 'actual-revision');
  assert.equal(s.reports[0].historyWitness.payloadGeneration, 'actual-payload');
  assert.equal(nextAction.phases.length, 0);
});

test('actual HP cache adoption seam restores revision without a new read and live-only commit keeps unknown version', () => {
  const s = setup(); const sample = row(); const historyCommitDiagnosticsRef = { current: s.helper };
  execute(adoption('cachedSnapshot'), { historyCommitDiagnosticsRef, historyOwnerKey: owner.ownerKey,
    sessionId: owner.sessionId, generation: owner.generation,
    historyPresentationProofRef: { current: { visit: owner.presentationVisit } },
    currentUIActionId: () => s.action.id, cachedSnapshot: { revision: { token: 'cache-revision' } },
    cachedPayloadGeneration: 'cache-payload', rawCachedEntries: [sample] });
  const candidate = s.helper.candidate();
  s.helper.commit(candidate, owner, { ...sample, liveProjection: true });
  const proof = s.reports[0].historyWitness;
  assert.equal(proof.origin, 'snapshot-restore'); assert.equal(proof.readId, null);
  assert.equal(proof.revisionToken, null); assert.equal(proof.baseRevisionToken, 'cache-revision');
  assert.equal(proof.qualification, 'unqualified-live-version');
});

test('distinct adoptions under one input retain distinct capped commit identities', () => {
  const s = setup(); const first = adopt(s);
  s.helper.commit(first.candidate, owner, first.sample);
  s.attempt = s.helper.begin(owner, s.action.id, 'read');
  const next = adopt(s); s.helper.commit(next.candidate, owner, next.sample);
  assert.equal(s.reports.length, 2);
  assert.notEqual(s.reports[0].historyWitness.adoptionSequence, s.reports[1].historyWitness.adoptionSequence);
  assert.notEqual(s.reports[0].commitPhase, s.reports[1].commitPhase);
});

test('actual disabled commit seam does not inspect projection or owner and active helper schedules nothing', () => {
  execute('(' + effect.arguments[0].getText(ast) + ')();', { historyCommitDiagnosticsRef: { current: null } });
  const previous = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame };
  const forbidden = () => { throw Error('no diagnostic scheduling'); };
  try {
    Object.assign(globalThis, { setTimeout: forbidden, setInterval: forbidden, requestAnimationFrame: forbidden });
    const s = setup(); const { candidate, sample } = adopt(s);
    assert.equal(s.helper.commit(candidate, owner, sample), true);
    assert.equal(s.helper.present(owner), true);
    assert.equal(s.helper.health().errors, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
