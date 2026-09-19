'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { readInboxResult } = require('./inbox-result-reader');
const { _api: api } = require('./ipc/codex-data');
const { SessionTranscriptService } = require('./session-transcript-service');
const { dehydrateHistoryEntries, historyPayloadStash } = require('./history-payload-dehydrate');
const web = ts.createSourceFile('web-server.js', fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const plain = (value) => JSON.parse(JSON.stringify(value));
let fixtureId = 0;

function fixture({ end = 'task_complete', twoTurns = false } = {}) {
  const sessionId = `inbox-result-reader-fixture-${++fixtureId}`;
  const records = [];
  const add = (type, payload) => records.push({ type, payload, __line: records.length + 1,
    __byteOffset: (records.length + 1) * 100, timestamp: '2026-09-07T00:00:00.000Z' });
  const event = (type, fields) => add('event_msg', { type, ...fields });
  const turn = (id, ending) => {
    event('task_started', { turn_id: id }); event('user_message', { message: `question ${id}` });
    add('response_item', { type: 'reasoning', summary: [{ text: `full thinking ${id}` }] });
    add('response_item', { type: 'function_call', call_id: `call-${id}`, name: 'mcp__test__lookup', arguments: '{}' });
    add('response_item', { type: 'function_call_output', call_id: `call-${id}`, output: `full tool result ${id}` });
    add('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', turn_id: id,
      content: [{ type: 'output_text', text: `answer ${id}` }] });
    if (ending) event(ending, { turn_id: id, last_agent_message: `answer ${id}` });
  };
  turn('A', end);
  if (twoTurns) turn('B', 'task_complete');
  const projector = api.createCodexHistoryProjector(sessionId); records.forEach(projector.feed);
  const entries = projector.finalize({ includeTurnCoordinates: true });
  const user = entries.find((entry) => entry.role === 'user');
  const record = { surface: 'inbox', runId: 'run-A', provider: 'codex', state: 'confirmed', tabId: 'tab-reused',
    handoffId: 'handoff-A', attemptId: 'attempt-A', sessionId: 'older-live-session',
    auditIdentity: { provider: 'codex', attemptId: 'attempt-A', sessionId, entryUuid: user.uuid, sourceIdentity: user.sourceIdentity } };
  const calls = [];
  const sourceSnapshot = { filePath: '/test/audit-rollout.jsonl', size: 1000, mtimeMs: 10 };
  const options = {
    runId: 'run-A', record, cwd: '/test/project', api,
    liveRun: { runId: 'run-A', sessionId: 'new-live-writer', tabId: 'tab-reused' },
    loadRecords: async (sid, cwd) => { calls.push(['load', sid, cwd]); return { success: true, records, filePath: sourceSnapshot.filePath, sourceSnapshot }; },
    projectHistory: async (sid, cwd, projectionOptions) => { calls.push(['project', sid, cwd, projectionOptions]); return { success: true, entries, filePath: sourceSnapshot.filePath, sourceSnapshot }; },
  };
  return { options, record, records, entries, sessionId, calls, sourceSnapshot };
}

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}
function routeNode(lastSegment) {
  const assignment = find(web, (node) => ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
    && node.expression.left.getText(web) === 'm' && ts.isCallExpression(node.expression.right)
    && node.expression.right.arguments[0]?.kind === ts.SyntaxKind.RegularExpressionLiteral
    && ['inbox', 'runs', lastSegment].every((part) => node.expression.right.arguments[0].getText(web).includes(part)));
  assert.ok(assignment, `Inbox ${lastSegment} route exists`);
  return assignment.parent.statements[assignment.parent.statements.indexOf(assignment) + 1];
}
async function routeGet(f, { hydratePayload } = {}) {
  const keys = [];
  const context = vm.createContext({
    m: ['route', 'run-A'], req: { method: 'GET' }, res: {}, decId: decodeURIComponent,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: { get: (key) => { keys.push(key); return f.record; } },
    // A reused tab points elsewhere; the durable run key must still choose A.
    externalRuns: new Map([['run-A', f.options.liveRun], ['new-run-on-tab', { tabId: 'tab-reused', sessionId: 'new-live-writer' }]]),
    externalRunByTabId: new Map([['tab-reused', 'new-run-on-tab']]),
    findOrchestrationTabDescriptor: () => ({ cwd: '/test/project', sessionId: 'new-live-writer' }),
    findRestorableAgentTabDescriptor: () => null,
    readInboxResult, loadCodexSessionRecords: f.options.loadRecords,
    codexDataApi: { ...api, projectCodexFullHistoryFromFile: f.options.projectHistory },
    transcriptService: hydratePayload ? { getToolPayload: hydratePayload } : null,
    sendJson: (_res, statusCode, body) => ({ statusCode, body }),
  });
  const getter = web.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getInboxResultResponse');
  assert.ok(getter, 'actual durable result getter exists');
  vm.runInContext(getter.getText(web), context);
  vm.runInContext(`globalThis.getResult = async () => { ${routeNode('result').getText(web)} };`, context);
  return { result: await context.getResult(), keys };
}

test('absent receipt is 404, but a known live run waits with 202 without loading history', async () => {
  const f = fixture();
  const absent = await readInboxResult({ ...f.options, record: null, liveRun: null });
  assert.equal(absent.statusCode, 404);
  const known = await readInboxResult({ ...f.options, record: null });
  assert.equal(known.statusCode, 202);
  assert.equal(known.body.stage, 'awaiting-receipt');
  assert.deepEqual(f.calls, []);
});

test('unconfirmed receipt returns 202 and never loads or projects a transcript', async () => {
  for (const state of ['audit-pending', 'enter-armed', 'in-flight']) {
    const f = fixture();
    const result = await readInboxResult({ ...f.options, record: { ...f.record, state } });
    assert.equal(result.statusCode, 202);
    assert.equal(result.body.stage, 'awaiting-exact-audit');
    assert.deepEqual(f.calls, []);
  }
});

test('wrong receipt provider/run and audit provider/attempt fail before reading', async () => {
  const patches = [
    (record) => ({ ...record, provider: 'claude' }),
    (record) => ({ ...record, runId: 'another-run' }),
    (record) => ({ ...record, surface: 'project' }),
    (record) => ({ ...record, auditIdentity: { ...record.auditIdentity, attemptId: 'another-attempt' } }),
    (record) => ({ ...record, auditIdentity: { ...record.auditIdentity, provider: 'claude' } }),
    (record) => ({ ...record, auditIdentity: { ...record.auditIdentity, provider: undefined } }),
  ];
  for (const patch of patches) {
    const f = fixture(); const record = patch(f.record);
    const result = await readInboxResult({ ...f.options, record });
    assert.equal(result.statusCode, 409, JSON.stringify({ provider: record.provider, runId: record.runId, audit: record.auditIdentity }));
    assert.deepEqual(f.calls, []);
  }
});

test('completed, aborted and pending results use historical audit SID instead of the live writer', async () => {
  for (const [end, statusCode, success] of [['task_complete', 200, true], ['turn_aborted', 200, false], [null, 202, null]]) {
    const f = fixture({ end });
    const result = await readInboxResult(f.options);
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.body.sessionId, f.sessionId);
    assert.equal(result.body.terminal.success, success);
    assert.equal(result.body.pending, end == null);
    assert.deepEqual(f.calls.map(([kind, sid]) => [kind, sid]), [['load', f.sessionId], ['project', f.sessionId]]);
    assert.equal(f.calls[1][3].includeTurnCoordinates, true);
  }
});

test('trusted explicit interruption ends only the matching pending historical session and provider turn', async () => {
  for (const reason of ['interrupt', 'turn_aborted', 'manual-stop', 'terminal-kill']) {
    const f = fixture({ end: null });
    const result = await readInboxResult({ ...f.options, liveRun: { ...f.options.liveRun,
      observedTerminal: { type: 'done', reason, sessionId: f.sessionId, turnId: 'A' } } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.terminal.ended, true);
    assert.equal(result.body.terminal.success, false);
    assert.equal(result.body.terminal.proofSource, 'main-terminal-event');
  }
  for (const patch of [
    { sessionId: 'other-session' }, { sessionId: undefined }, { turnId: 'other-turn' }, { turnId: undefined },
    { capacitySurfaceOnly: true }, { reason: 'model_capacity' }, { reason: 'snapshot-replay' }, { reason: 'task_complete' },
  ]) {
    const f = fixture({ end: null });
    const result = await readInboxResult({ ...f.options, liveRun: { ...f.options.liveRun,
      observedTerminal: { type: 'done', reason: 'interrupt', sessionId: f.sessionId, turnId: 'A', ...patch } } });
    assert.equal(result.statusCode, 202, JSON.stringify(patch));
    assert.equal(result.body.terminal.ended, false);
  }
});

test('a later process stop cannot rewrite a canonically completed successful answer', async () => {
  const f = fixture();
  const result = await readInboxResult({ ...f.options, liveRun: { ...f.options.liveRun,
    observedTerminal: { reason: 'terminal-kill', sessionId: f.sessionId, turnId: 'A' } } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.terminal.reason, 'task_complete');
  assert.equal(result.body.terminal.success, true);
});

test('completion-only reads skip heavy hydration while preserving exact terminal proof', async () => {
  const f = fixture();
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: f.sessionId, entries: f.entries, threshold: 8 });
  let hydrated = 0;
  const result = await readInboxResult({ ...f.options, includeEntries: false,
    hydratePayload: async () => { hydrated++; throw new Error('must not hydrate completion check'); } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.terminal.ended, true);
  assert.deepEqual(result.body.entries, []);
  assert.equal(hydrated, 0);
});

test('selected-turn thinking and raw tool refs hydrate through the real getToolPayload without mutating cached rows', async (t) => {
  const f = fixture({ twoTurns: true });
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: f.sessionId, entries: f.entries, stash: historyPayloadStash, threshold: 8 });
  t.after(() => {
    for (const [key, item] of historyPayloadStash.records) if (key.startsWith(`codex:${f.sessionId}:`)) {
      historyPayloadStash.records.delete(key); historyPayloadStash.totalBytes -= item.bytes;
    }
  });
  const cached = JSON.stringify(f.entries);
  const hydrated = [];
  const result = await readInboxResult({ ...f.options, hydratePayload: async (request) => {
    hydrated.push(request);
    return SessionTranscriptService.prototype.getToolPayload.call({}, request);
  } });
  assert.equal(result.statusCode, 200);
  assert.equal(hydrated.length, 2, 'only A thinking and A tool result are hydrated');
  assert.ok(hydrated.every((request) => request.sessionId === f.sessionId && request.toolType === 'codex'));
  assert.equal(result.body.entries.find((entry) => entry.thinking).thinking, 'full thinking A');
  const rawTool = result.body.entries.flatMap((entry) => entry.actions || []).find((action) => action.rawTool).rawTool;
  assert.equal(rawTool.result, 'full tool result A');
  assert.equal(rawTool.resultRef, undefined);
  assert.equal(result.body.entries.some((entry) => entry.thinkingRef), false);
  assert.equal(JSON.stringify(f.entries), cached);
  assert.ok(f.entries.some((entry) => entry.turnIndex === 1 && entry.thinkingRef), 'B remains a cached preview');
});

test('missing heavy payload is explicit failure and the actual GET route cannot silently return its preview', async () => {
  const f = fixture();
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: f.sessionId, entries: f.entries, threshold: 8 });
  const hydratePayload = async () => ({ success: false, error: 'test payload missing' });
  await assert.rejects(() => readInboxResult({ ...f.options, hydratePayload }), /test payload missing/);
  const { result } = await routeGet(f, { hydratePayload });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'inbox_result_read_failed');
  assert.equal(result.body.entries, undefined);
});

test('unavailable, changed or missing file paths cannot prove a completed result', async () => {
  for (const variant of ['unavailable', 'changed', 'both-missing']) {
    const f = fixture();
    const filePath = variant === 'both-missing' ? undefined : '/test/source-A';
    const result = await readInboxResult({ ...f.options,
      loadRecords: async () => variant === 'unavailable' ? { success: false } : { success: true, records: f.records, filePath },
      projectHistory: async () => ({ success: true, entries: f.entries, filePath: variant === 'changed' ? '/test/source-B' : filePath }),
    });
    assert.equal(result.statusCode, 503, variant);
    assert.equal(result.body.ok, false);
  }
});

test('HTTP result getter resolves the durable inbox:runId key even when a tab now belongs to another run', async () => {
  const f = fixture();
  const { result, keys } = await routeGet(f);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(keys, ['inbox:run-A']);
  assert.equal(result.body.sessionId, f.sessionId);
  assert.equal(result.body.runId, 'run-A');
});

test('every admission response object and idempotent replay advertises its encoded result URL', () => {
  const admission = find(web, (node) => ts.isIfStatement(node) && node.expression.getText(web).includes("parsed.pathname === '/api/inbox/runs'"));
  assert.ok(admission, 'actual Inbox admission route exists');
  const responses = [];
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const name = call.expression.getText(web);
      const body = call.arguments[2];
      if (body && ts.isObjectLiteralExpression(body) && body.properties.some((property) => property.name?.getText(web) === 'runId')
        && (['sendDeliveryUnknown', 'sendAuditPending'].includes(name)
          || (name === 'sendJson' && ['200', '202'].includes(call.arguments[1]?.getText(web))))) responses.push(body);
    }
    ts.forEachChild(node, visit);
  };
  visit(admission);
  assert.ok(responses.length >= 5, 'all known accepted/pending admission branches are exercised');
  const context = vm.createContext({ runId: 'run A/1', provider: 'codex', tabId: 'tab', sessionId: 'session', source: 'voice',
    run: { handoffId: 'handoff', auditSessionId: 'audit' }, conversationKey: 'chat', autoStopMs: 0, autoCloseMs: 0, reused: false, sendResult: {},
    sendPayload: { attachments: [] } });
  for (const body of responses) {
    const response = vm.runInContext(`(${body.getText(web)})`, context);
    assert.equal(response.resultUrl, '/api/inbox/runs/run%20A%2F1/result');
  }
  context.agentSendReceiptStore = null;
  for (const name of ['inboxSetupOutcome', 'externalRunResponseFields', 'replayExternalRunResponse']) {
    const fn = web.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    vm.runInContext(fn.getText(web), context);
  }
  context.sendJson = (_res, _status, body) => body;
  context.sendDeliveryUnknown = context.sendAuditPending = context.sendSendFailure = (_res, _data, body) => body;
  for (const status of ['delivery_unknown', 'audit_pending', 'reserving', 'starting', 'sending', 'running', 'done', 'stopped', 'send_failed']) {
    const response = context.replayExternalRunResponse({}, { runId: 'run A/1', status });
    assert.equal(response.resultUrl, '/api/inbox/runs/run%20A%2F1/result', status);
  }
});
