'use strict';
// Real structural source reader/parser/projector; private physical source and
// lineage descriptor. No live History, Main, provider input or Electron.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const crypto = require('node:crypto'), ts = require('typescript');
const { _api } = require('./ipc/codex-data');
const { createCodexResultReader } = require('./codex-result-reader');
const { capturedCodexSubject, readBuildContinueOriginal } = require('./build-continue-proofs');
const { fixture, turn, encode } = require('./fixtures/build-continue-index.cjs');

test('actual Main inspection DTO is captured without assuming its presentation turn is a task registry row', () => {
  const source = fs.readFileSync(require.resolve('./main'), 'utf8');
  const parsed = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const actual = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureTabInspection').getText(parsed);
  const context = { provider: 'codex', sessionId: 'A', turnId: 'own-T', generation: 7, processId: '123' };
  const raw = { known: true, exists: true, toolType: 'codex', sessionId: 'A', busy: true, executionContext: context,
    turn: { active: true, ...context }, revision: 'exact-current-owner' };
  const env = vm.createContext({ captureAgentResponseReadState: () => raw,
    projectCodexRuntimeSnapshotFromEvents: () => ({ status: 'active', liveLifecycle: true }),
    terminalCommandState: new Map(), codexTurnWatchers: new Map(), claudeHookLastEvent: new Map(),
    getTabBackgroundWorkAgents: () => [], getTabBackgroundWorkTasks: () => [], tabBackgroundWorkRevisionByTab: new Map(),
    getTerminalLifecycleGeneration: () => 'launch', projectManager: { db: { db: { prepare: () => ({ get: () => ({ name: 'worker' }) }) } } } });
  vm.runInContext(actual, env); const dto = JSON.parse(JSON.stringify(env.captureTabInspection('T')));
  assert.equal(dto.turn.active, undefined);
  assert.equal(require('./agent-response-observation-reader').currentResponseSubject(dto), null, 'OLD binding RED against actual DTO');
  assert.deepEqual(capturedCodexSubject(dto).targetExecutionContext, context);
});

test('metadata interval has both exact edges/all intermediate users across accepted frozen parent → child', async t => {
  const h = fixture(t, { parent: true, middle: turn('manual', 'manual input between callbacks') });
  assert.equal((await h.interval()).known, false, 'cold is not empty coverage');
  await h.prime(); const bytes = h.reader.stats().bodyBytesRead;
  const result = await h.interval(); assert.equal(result.known, true, JSON.stringify(result));
  assert.equal(result.users.length, 3); assert.deepEqual(result.executions.map(c => c.turnId), ['old', 'manual', 'callback']);
  assert.deepEqual(result.executions.map(c => c.sessionId), ['A', 'B', 'B']);
  assert.equal(result.users[0].aliases[0].sessionId, 'A');
  assert.equal(h.reader.stats().bodyBytesRead, bytes, 'interval reads zero bodies and does not warm source');
  assert.equal((await h.interval({ maxInputs: 2 })).known, false, 'cap cannot claim full coverage');
  h.changeRevision(); assert.equal((await h.interval()).known, false);
});

for (const kind of ['partial tail', 'parse gap', 'append after verified read', 'same-size rewrite']) test(kind + ' cannot prove no intervening input', async t => {
  const h = fixture(t, { malformed: kind === 'parse gap' }); await h.prime();
  if (kind === 'partial tail') {
    fs.appendFileSync(h.file, '{"type":"event_msg"'); await h.reader.loadLatestObservedExecution(h.request);
  }
  if (kind === 'append after verified read') fs.appendFileSync(h.file, encode(turn('new', 'new user')));
  if (kind === 'same-size rewrite') fs.writeFileSync(h.file, fs.readFileSync(h.file, 'utf8').replace('saved callback', 'other callback'));
  assert.equal((await h.interval()).known, false);
});

