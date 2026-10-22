'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { buildOrchestrationCompletionContent } = require('./orchestration-completion-content');
test('actual desktop presentation distinguishes blocked preparation and recovery from model work', () => {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/OrchestrationStatusChip.tsx'), 'utf8');
  const ast = ts.createSourceFile('chip.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(x => ts.isFunctionDeclaration(x) && x.name?.text === 'runPresentation');
  const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ ACTIVE: new Set(['starting', 'running']),
    isOrchestrationResultProofPending: () => false, hasSourceNotificationError: () => false,
    hasPendingSourceHandoff: () => false, isPaused: () => false });
  vm.runInContext(js, context);
  const base = { runKind: 'external-research', status: 'starting', externalResearchUiState: { attention: true, sendState: 'not_attempted' } };
  assert.equal(context.runPresentation(base, 'source').label, 'Подготовка остановлена — не отправлено');
  assert.equal(context.runPresentation(base, 'source').spinning, false);
  assert.equal(context.runPresentation({ ...base, status: 'running', externalResearchUiState: {
    sendState: 'accepted', recoveryStatus: 'waiting_retry' } }, 'source').label, 'Ждёт кнопку «Повторить»');
});
async function fixture(t) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/chatgpt-ui-recovery-20261021-uHmQJX');
  const root = fs.mkdtempSync(path.join(parent, 'noted-ui-test-'));
  const file = path.join(root, 'runs.json'), store = new OrchestrationRunStore(file);
  await store.reserveOrGet({ runId: 'own', runKind: 'external-research', requestFingerprint: 'same', sourceTabId: 'source',
    sourceSessionId: 'S', sourceSendTarget: { toolType: 'codex', sessionId: 'S' }, externalResearchJobId: 'noted_own',
    notifySource: true, externalResearchIntent: { provider: 'chatgpt', prompt: 'test', options: {}, files: [] } });
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshot = (patch = {}) => ({ id: 'noted_own', status: 'queued', stage: 'configuring', execution: {
    version: 1, controlEpoch: 'epoch', controlRevision: 3, send: { state: 'not_attempted' }, turn: { quality: 'unbound' },
    attention: null, ...patch } });
  return { store, file, snapshot };
}
test('blocked preparation presentation survives restart without fabricating Send or terminal failure', async t => {
  const f = await fixture(t), snapshot = f.snapshot({ authorPark: { state: 'parked' }, attention: { state: 'open' } });
  await f.store.applyExternalResearchSnapshot('own', snapshot); await f.store.flush();
  const restored = new OrchestrationRunStore(f.file), run = await restored.get('own'); await restored.flush();
  assert.equal(run.status, 'starting'); assert.equal(run.externalResearchUiState.sendState, 'not_attempted');
  assert.equal(run.externalResearchUiState.parked, true); assert.equal(run.externalResearchUiState.attention, true);
  assert.equal(run.resultComplete, false); assert.equal(run.resultAvailable, false);
});
test('maximum-length hint survives success and is outside unchanged exact answer bytes', async t => {
  const f = await fixture(t), answer = '  exact final\nwith whitespace\n';
  await f.store.applyExternalResearchSnapshot('own', { id: 'noted_own', status: 'done', result: {
    text: answer, continuation_hint: 'new_chat_required' } });
  const run = await f.store.get('own');
  const content = buildOrchestrationCompletionContent(run, { ready: true, complete: true, success: true, assistantText: answer });
  assert.equal(run.status, 'completed'); assert.equal(content.mode, 'inline');
  assert.equal(content.prompt.slice(content.bodyStart, content.bodyEnd), answer);
  assert.match(content.prompt.slice(0, content.bodyStart), /следующий вопрос отправляй в новый чат/);
  assert.equal(content.metadata.continuationHint, 'new_chat_required');
});
test('one recovery-exhausted operational notice carries attempt count and does not call it an expert answer', async t => {
  const f = await fixture(t), at = Date.now();
  const snapshot = f.snapshot({ send: { state: 'accepted' }, turn: { quality: 'native', conversationId: 'cid', userMessageId: 'user' },
    uiRecovery: { version: 1, status: 'exhausted', outcome: 'ui_recovery_exhausted', reportedAt: at,
      attempts: [{ state: 'confirmed' }, { state: 'confirmed' }] },
    attention: { version: 2, jobId: 'noted_own', controlEpoch: 'epoch', episodeId: 'episode', phase: 'observing',
      reason: 'observation_unavailable', updateSeq: 1, wakeSeq: 1, state: 'open', wakeModel: true,
      terminal: false, audience: ['source_agent'] },
    operation: { phase: 'observing', blocker: { code: 'ui_recovery_exhausted' } } });
  await f.store.applyExternalResearchSnapshot('own', snapshot);
  snapshot.execution.controlRevision++; snapshot.execution.attention.updateSeq++;
  await f.store.applyExternalResearchSnapshot('own', snapshot);
  const run = await f.store.getInternal('own'), notices = Object.values(run.externalResearchOperational.notices);
  assert.equal(notices.length, 1); assert.match(notices[0].body, /Лимит двух попыток/);
  assert.match(notices[0].body, /"attempts":2/); assert.match(notices[0].body, /Это не экспертное заключение/);
  assert.equal(run.resultAvailable, false);
});
