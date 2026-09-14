'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const codexData = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { codexProviderErrorEntry, codexProviderErrorMessage } = require('./codex-provider-error');
const { classifyCodexTurnEvent } = require('./codex-turn-outcome');
const sid = 'f2e0fd24-0b79-4532-8e45-2af4eba1914b';
// Text read through the isolated Terminal OUTPUT API, not a fabricated reply.
// Protocol fields/positions below are a minimal contract fixture, NOT a raw
// JSONL export of the incident (the old API does not expose that carrier).
const authError = 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
const event = (line, type, fields = {}) => ({ type: 'event_msg', __line: line, __byteOffset: line * 100,
  timestamp: '2026-09-13T22:49:33.457Z', payload: { type, turn_id: 'turn-1', ...fields } });
const failed = event(9, 'task_complete', { error: { message: authError, codex_error_info: 'other' } });
const records = [event(6, 'task_started'), event(8, 'user_message', { message: 'one prompt' }), failed];
const declaration = (source, name) => {
  const ast = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true);
  return ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
};

test('generic terminal failure is one canonical error row; delivery/completion and quote semantics remain distinct', () => {
  const history = codexData._api.buildCodexFullHistory(records, sid);
  const row = history.find(entry => entry.role === 'provider-error');
  assert.ok(row); assert.equal(row.providerError.message, authError);
  assert.match(row.content, /Войдите/); assert.equal(row.providerError.turnId, 'turn-1');
  assert.equal(history.filter(entry => entry.role === 'user').length, 1);
  assert.equal(history.some(entry => entry.role === 'assistant'), false);
  assert.equal(classifyCodexTurnEvent('task_complete', failed.payload).reason, 'provider_error');
  assert.equal(classifyCodexTurnEvent('task_complete', failed.payload).hasFinalResult, false);
  const transientAuth = codexProviderErrorEntry(event(9, 'task_complete', {
    error: { message: 'Your access token could not be refreshed: connection unavailable', codex_error_info: 'other' },
  }), sid);
  assert.doesNotMatch(transientAuth.content, /Войдите/, 'a connection failure is not proof that login was revoked');
  assert.equal(codexData._api.buildCodexTimeline(records, sid).filter(entry => entry.type === 'user').length, 1);
  for (const record of [event(1, 'user_message', { message: authError }),
    event(1, 'error', { error: failed.payload.error }), event(1, 'task_complete', { last_agent_message: authError }),
    { ...failed, type: 'response_item' }, event(1, 'task_complete', { error: authError })]) {
    assert.equal(codexProviderErrorEntry(record, sid), null);
  }
});

test('usage-limit keeps its existing identity; physical source and rollback do not move the error to another turn', () => {
  const limited = event(9, 'task_complete', { error: { message: 'limit', codex_error_info: 'usage_limit_exceeded' } });
  const row = codexProviderErrorEntry(limited, sid);
  assert.equal(row.uuid, 'codex-usage-limit-' + sid + '-9');
  assert.equal(row.content, 'Usage limit reached');
  const physical = codexProviderErrorEntry({ ...failed, __physicalSessionId: 'parent' }, 'child');
  assert.equal(physical.sessionId, 'parent'); assert.match(physical.sourceIdentity, /parent-900$/);
  const later = [event(10, 'task_started', { turn_id: 'turn-2' }),
    event(11, 'user_message', { turn_id: 'turn-2', message: 'second' }),
    event(12, 'task_complete', { turn_id: 'turn-2', last_agent_message: 'done' })];
  const history = codexData._api.buildCodexFullHistory([...records, ...later], sid);
  assert.equal(history.filter(entry => entry.role === 'provider-error').length, 1);
  assert.ok(history.findIndex(entry => entry.role === 'provider-error') < history.findIndex(entry => entry.content === 'second'));
  const rolled = codexData._api.buildCodexFullHistory([...records, event(10, 'thread_rolled_back', { num_turns: 1 })], sid);
  assert.equal(rolled.some(entry => entry.role === 'provider-error'), false);
});

test('actual main live builder→public projection→History reducer preserves exact error identity once', async () => {
  const main = fs.readFileSync(require.resolve('./main'), 'utf8');
  const context = vm.createContext({ path, srcMainDir: __dirname, require,
    codexKnownSessions: new Map(), codexEventType: record => record.payload?.type });
  vm.runInContext(declaration(main, 'buildCodexLiveRawMessage'), context);
  const raw = context.buildCodexLiveRawMessage({ sessionId: sid }, failed);
  assert.deepEqual(raw, codexProviderErrorMessage(failed, sid));
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  vm.runInContext(['streamMessageBlocks', 'deriveMessageProjection', 'withMessageProjection'].map(name => declaration(web, name)).join('\n'), context);
  const envelope = context.withMessageProjection({ type: 'message', toolType: 'codex', sessionId: sid, message: raw });
  assert.equal(envelope.projection.kind, 'provider-error');
  assert.equal(envelope.projection.transcript, true);
  assert.equal(envelope.projection.timeline, false);
  assert.equal(envelope.projection.ephemeral, false);
  const { reduceHistoryLiveProjection, reconcileCommittedHistoryLiveProjection } = await import('../renderer/utils/historyLiveProjection.mjs');
  const first = reduceHistoryLiveProjection([], envelope);
  assert.equal(first.length, 1); assert.equal(first[0].role, 'provider-error');
  assert.equal(reduceHistoryLiveProjection(first, envelope).length, 1);
  const durable = codexData._api.buildCodexFullHistory(records, sid);
  assert.equal(first[0].uuid, durable.find(entry => entry.role === 'provider-error').uuid);
  assert.equal(reconcileCommittedHistoryLiveProjection(first, durable).entries.length, 0);
});

test('actual snapshot service returns the error in both History and messages and preserves conditional revision', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-error-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.jsonl'); fs.writeFileSync(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const stat = fs.statSync(filePath);
  const api = { ...codexData._api,
    loadSessionRecords: async () => ({ success: true, records, filePath, sourceSnapshot: { filePath,
      size: stat.size, mtimeMs: stat.mtimeMs, sessionId: sid, linkKind: 'end' } }),
    findCodexSessionFile: async () => ({ filePath }),
  };
  const service = new SessionTranscriptService({ codexData: { _api: api }, claudeData: null, getMainWindow: () => null });
  const payload = { toolType: 'codex', sessionId: sid, cwd: dir, tabId: 'T' };
  const history = await service.getHistory(payload);
  const messages = await service.getMessages(payload);
  const row = history.entries.find(entry => entry.role === 'provider-error');
  const message = messages.messages.find(entry => entry.type === 'provider-error');
  assert.ok(row); assert.ok(message); assert.equal(row.uuid, message.uuid);
  assert.equal(row.providerError.message, message.providerError.message);
  assert.equal(row.responseTiming, undefined);
  const same = await service.getHistory({ ...payload, ifRevision: history.revision });
  assert.equal(same.unchanged, true);
  const reopened = new SessionTranscriptService({ codexData: { _api: api }, claudeData: null, getMainWindow: () => null });
  const again = await reopened.getHistory(payload);
  assert.equal(again.entries.find(entry => entry.role === 'provider-error').uuid, row.uuid);
});
