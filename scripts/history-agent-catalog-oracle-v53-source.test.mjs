// V53 old-contract SOURCE controls. Frozen literal preimage oracle + actual
// live merge/liveness/rewind and sparse publication owner. This file alone does
// not qualify the new paged catalog, UI painting, native latency, or global RAM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { isHistoryTaskChipLive } from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import { isHistoryBackgroundTaskLive, foldHistoryAgentProcessLiveness } from '../src/renderer/utils/historyProcessLiveness.mjs';
import { buildHistoryLivePresentation } from '../src/renderer/utils/historyLiveProjection.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import { agentRow, taskAction, catalogScope, literalCatalog, farHistoryFixture,
  duplicateLiveFixture, fullNativeFixture, nativeGrammarFixture, fixtureEpoch } from './test-support/history-agent-catalog-fixtures.mjs';
const require = createRequire(import.meta.url);
const { sourcePins, createHistoryAgentCatalogOracle } = require('./test-support/history-agent-catalog-oracle.cjs');
const { projectNativeRewindPreview } = require('../src/main/history-root-engine/main/history-primary-compat/src/renderer/utils/historyRewindPreviewOwner.ts.cjs');
const oracle = createHistoryAgentCatalogOracle({ isHistoryTaskChipLive, isHistoryBackgroundTaskLive, projectNativeRewindPreview });
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime old-space64/semi-space2 fixture limit');

test('frozen literal oracle records exact full source and finite fragment provenance', () => {
  assert.equal(sourcePins.sourceSHA256, '9b61ffee0592c8148e285600a72aedb4205220b6cbb7b673e124709898a1f994');
  assert.equal(sourcePins.sourceBytes, 1332531);
  assert.equal(sourcePins.fragments.collectors.bytes, 13836);
  assert.equal(sourcePins.fragments.collectors.sha256, '96c1802050a6c8bc04996dacc21a122a39a539052662a504ff6158c54b6c408b');
});

test('completed and interrupted records outside any viewport remain exact inventory', () => {
  const result = literalCatalog(oracle, farHistoryFixture());
  assert.equal(result.background.length, 0);
  assert.equal(result.agents.length, 901);
  assert.equal(result.agents.filter(value => value.status === 'completed').length, 451);
  assert.equal(result.agents.filter(value => value.status === 'interrupted').length, 450);
  assert.equal(result.agents[0].key, 'task:agent-900');
  assert.equal(result.agents.at(-1).key, 'task:agent-0');
});

test('only the first duplicate consumes live; final duplicate owns status and fallback chains', () => {
  const fixture = duplicateLiveFixture();
  const result = oracle.collectHistoryAgentChips(fixture.entries, fixture.live);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'interrupted');
  assert.equal(result[0].startedAt, 20);
  assert.equal(result[0].entryUuid, 'second');
  assert.equal(result[0].label, 'last row');
  assert.equal(result[0].taskHistory, fixture.first.actions[0].history);
  assert.equal(result[0].taskResult, 'retained result');
  assert.equal(result[0].taskPrompt, 'first prompt');
  assert.equal(result[0].agentId, 'current-id');
});

test('stable ties retain first-key insertion position while duplicate updates last value', () => {
  const rows = [agentRow('a1', [taskAction('a', { startedAt: 5, result: 'first' })]),
    agentRow('b', [taskAction('b', { startedAt: 5, result: '' })]),
    agentRow('a2', [taskAction('a', { startedAt: 5, result: 0 })])];
  const result = literalCatalog(oracle, rows).agents;
  assert.deepEqual(result.map(value => value.key), ['task:a', 'task:b']);
  assert.equal(result[0].taskResult, 0);
  assert.equal(result[1].taskResult, '');
  assert.equal(result[0].entryUuid, 'a2');
});

test('background duplicate sort occurs before liveByKey overwrite and roster dedup', () => {
  const rows = [agentRow('new', [taskAction('dup', { startedAt: 30 })]),
    agentRow('old', [taskAction('dup', { startedAt: 10 })])];
  const scope = catalogScope({ isTurnBusy: true, agentProcessAlive: true });
  const background = literalCatalog(oracle, rows, scope).background;
  assert.equal(background.length, 2, 'strip count counts both records');
  assert.deepEqual(background.map(value => value.startedAt), [30, 10]);
  const onlyLive = oracle.collectHistoryAgentChips([], background);
  assert.equal(onlyLive.length, 1);
  assert.equal(onlyLive[0].startedAt, 10, 'last sorted duplicate wins the native Map value');
});

test('hydrated Task actions suppress all summary reads; empty hydrated Tasks permits summary', () => {
  const row = agentRow('hydrated', [undefined, 'noise', taskAction('real', { result: '' })]);
  Object.defineProperty(row, 'actionSummary', { get() { throw Error('SUMMARY_MUST_NOT_BE_READ'); } });
  assert.deepEqual(literalCatalog(oracle, [row]).agents.map(value => value.key), ['task:real']);
  const summary = agentRow('thin', ['noise'], { actionSummary: [
    { toolName: 'Task', toolUseId: 'summary', description: '', result: 'NOT_COPIED', history: ['NOT_COPIED'] },
    { family: 'task', toolUseId: 'family', description: 'family', completedAt: 10 },
  ] });
  const result = literalCatalog(oracle, [summary]).agents;
  assert.equal(result.find(value => value.key === 'task:summary').taskResult, undefined);
  assert.equal(result.find(value => value.key === 'task:summary').taskHistory, undefined);
  assert.equal(result.find(value => value.key === 'task:summary').label, 'Agent');
  assert.equal(result.find(value => value.key === 'task:summary').status, 'interrupted');
});

test('native key grammar and only terminal canonical suffix stripping are preserved', () => {
  assert.equal(oracle.historyAgentKey({ toolUseId: 'call', agentSessionId: 'session', agentId: 'id' }, 'row'), 'task:call');
  assert.equal(oracle.historyAgentKey({ toolUseId: '', agentSessionId: 'session', agentId: 'id' }, 'row'), 'task:session');
  assert.equal(oracle.historyAgentKey({ toolUseId: 0, agentSessionId: null, agentId: 'id' }, 'row'), 'task:id');
  assert.equal(oracle.historyAgentKey({}, 'row'), 'task:row');
  assert.equal(oracle.historySubagentCallIdentity('a:canonical:12'), 'a');
  assert.equal(oracle.historySubagentCallIdentity('a:canonical:12:tail'), 'a:canonical:12:tail');
  assert.equal(oracle.historySubagentCallIdentity('a:canonical:12:canonical:3'), 'a:canonical:12');
});

test('inherited Task fields, sparse actions and native Number/default coercion stay observable', () => {
  const fixture = nativeGrammarFixture();
  const result = literalCatalog(oracle, fixture.entries).agents;
  assert.equal(result.length, 1);
  assert.equal(result[0].key, 'task:native-key');
  assert.equal(result[0].startedAt, 5);
  assert.equal(result[0].taskResult, false);
  assert.equal(result[0].taskHistory, fixture.history);
  assert.equal(result[0].label, 'inherited');
  assert(fixture.coercions.includes('id:default'));
  assert(!fixture.coercions.includes('id:string'), 'absent optional terminalFacts skips call-identity coercion');
  assert(fixture.coercions.includes('start'));
  const withTerminalMap = nativeGrammarFixture();
  literalCatalog(oracle, withTerminalMap.entries, catalogScope(), new Map());
  assert(withTerminalMap.coercions.includes('id:string'), 'present empty map evaluates the original call identity');
});

test('undefined summary values and native coercion errors are not silently normalized away', () => {
  assert.throws(() => literalCatalog(oracle, [agentRow('bad', [], { actionSummary: [undefined] })]), TypeError);
  assert.throws(() => literalCatalog(oracle, [agentRow('bad', [taskAction('x', { startedAt: Symbol('native') })])]), TypeError);
  const action = taskAction('x');
  Object.defineProperty(action, 'description', { get() { throw Error('ORIGINAL_GETTER'); } });
  assert.throws(() => literalCatalog(oracle, [agentRow('bad', [action])]), /ORIGINAL_GETTER/);
  const sparse = new Array(2); sparse[1] = { toolName: 'Task', toolUseId: 'sparse-summary' };
  assert.equal(literalCatalog(oracle, [agentRow('ok', [], { actionSummary: sparse })]).agents.length, 1);
});

test('full selected UTF16/NUL/typed native payload survives; only old visible label formatting truncates', () => {
  const fixture = fullNativeFixture();
  const result = literalCatalog(oracle, fixture.entries).agents[0];
  assert.equal(result.taskPrompt, fixture.full);
  assert.equal(result.taskResult, fixture.full);
  assert.equal(result.taskHistory, fixture.history);
  assert.equal(result.agentSessionId, fixture.full);
  assert.equal(result.agentId, fixture.full);
  assert.equal(result.entryUuid, fixture.row.uuid);
  assert.equal(result.launchSettings, fixture.launchSettings);
  assert.equal(result.label, fixture.full.slice(0, 120));
  assert(result.taskResult.endsWith('EXACT-END'));
});

test('statusless last-turn tasks follow busy until exact Main process activity takes over', () => {
  const old = agentRow('old', [taskAction('old')]);
  const user = agentRow('user', [], { role: 'user' });
  const current = agentRow('current', [taskAction('current')]);
  const rows = [old, user, current];
  let scope = catalogScope({ isTurnBusy: true });
  assert.deepEqual(literalCatalog(oracle, rows, scope).background.map(value => value.key), ['task:current']);
  scope = catalogScope({ agentProcessAlive: true });
  assert.equal(literalCatalog(oracle, rows, scope).background.length, 0);
  scope = catalogScope({ agentProcessAlive: true,
    exactActiveSubagents: new Map([['old', { provider: 'codex', startedAt: 25 }]]) });
  assert.deepEqual(literalCatalog(oracle, rows, scope).background.map(value => value.key), ['task:old']);
  scope.exactActiveSubagents = new Map([['old', { provider: 'claude' }]]);
  assert.equal(literalCatalog(oracle, rows, scope).background.length, 0);
  scope.exactActiveSubagents = new Map([['old', { provider: 'codex' }]]);
  scope.agentProcessAlive = false;
  assert.equal(literalCatalog(oracle, rows, scope).background.length, 0);
});

test('durable running alone is historical; exact process proof and terminal facts have distinct roles', () => {
  const row = agentRow('r', [taskAction('call:canonical:7', {
    subagentStatus: 'running', processGeneration: 'old-generation', startedAt: 10 })]);
  const scope = catalogScope({ agentProcessAlive: true });
  assert.equal(literalCatalog(oracle, [row], scope).background.length, 0);
  assert.equal(literalCatalog(oracle, [row], scope).agents[0].status, 'interrupted');
  const terminal = new Map([['call', { status: 'completed', startedAt: 20, completedAt: 30 }]]);
  const result = literalCatalog(oracle, [row], scope, terminal).agents[0];
  assert.equal(result.status, 'completed'); assert.equal(result.durationMs, 10);
  scope.exactActiveSubagents = new Map([['call', { provider: 'codex', startedAt: 40 }]]);
  assert.equal(literalCatalog(oracle, [row], scope, terminal).agents[0].status, 'running');
  assert.equal(foldHistoryAgentProcessLiveness('unknown', true), true);
  assert.equal(foldHistoryAgentProcessLiveness('idle', true), false);
});

test('orphan exact background tasks appear immediately and terminal tombstone wins', () => {
  const scope = catalogScope({ chipToolType: 'claude', agentProcessAlive: true,
    exactActiveBackgroundTasks: new Map([['shell', { toolUseId: 'shell', kind: 'bash', command: 'original command', startedAt: 50 }]]) });
  const result = literalCatalog(oracle, [], scope);
  assert.equal(result.background[0].key, 'bash:shell');
  assert.equal(result.background[0].backgroundCommand, 'original command');
  scope.terminalBackgroundTaskCalls = new Set(['shell']);
  assert.equal(literalCatalog(oracle, [], scope).background.length, 0);
});

test('raw-live chip fold differs from final Rewind display without losing historical agents', () => {
  const before = agentRow('before', [taskAction('before', { result: 'done' })]);
  const target = agentRow('target', [], { role: 'user' });
  const future = agentRow('future', [taskAction('future', { result: 'done' })]);
  const live = agentRow('live', [taskAction('live')], { timestamp: new Date(fixtureEpoch + 5000).toISOString() });
  const chipRows = buildHistoryLivePresentation([before, target, future], [live]);
  const display = oracle.buildRewindPreviewEntries(chipRows,
    { targetUuid: 'target', opId: 'rewind', startedAt: fixtureEpoch + 5000 }).entries;
  assert.deepEqual(chipRows.map(value => value.uuid), ['before', 'target', 'future', 'live']);
  assert.deepEqual(display.map(value => value.uuid), ['before', 'live']);
  assert(literalCatalog(oracle, chipRows).agents.some(value => value.key === 'task:future'));
  assert(!literalCatalog(oracle, display).agents.some(value => value.key === 'task:future'));
});

test('durable thin actionSummary wins matching raw-live source identity, even if live body is richer', () => {
  const durable = agentRow('durable', [], { rowStub: true, sourceIdentity: 'same', actionSummary: [
    { toolName: 'Task', toolUseId: 'joined', description: 'thin', taskPrompt: 'full prompt' },
  ] });
  const live = agentRow('live', [taskAction('joined', { result: 'RICHER RESULT MUST NOT APPEAR' })], { sourceIdentity: 'same' });
  const joined = buildHistoryLivePresentation([durable], [live]);
  assert.equal(joined[0], durable); assert.equal(joined.length, 1);
  assert.equal(literalCatalog(oracle, joined).agents[0].taskResult, undefined);
});

test('same-owner sparse recipe remains original while actual current local publication changes', async () => {
  const owner = createHistoryPrimarySparsePublicationOwner({ isLocal: oracle.isLocalPromptEntry });
  const scope = { ownerKey: 'A', generation: 1 };
  const first = agentRow('local-prompt-one', [], { role: 'queued', queueStatus: 'sending' });
  const second = { ...first, queueStatus: 'sent' };
  const header = {}, dataSubject = {};
  let closes = 0;
  const held = { header, receiptDataSubject: dataSubject, closed: false, retain() { return held; }, close() { closes++; } };
  const sparse = { header, dataSubject, insertions: [first], currentLocals: [first], replacements: [], exclusions: [] };
  owner.adopt({ prepared: held, publication: sparse, isCurrent: () => true }, [first], scope);
  const updated = owner.publishCompatibility([second], scope);
  assert.equal(updated.prepared, held);
  assert.equal(updated.sparse, sparse);
  assert.equal(updated.sparse.insertions[0], first, 'original sparse recipe is not refreshed CURRENT');
  assert.equal(updated.rows[0], second, 'actual current local refs changed synchronously');
  const removed = owner.publishCompatibility([], scope);
  assert.equal(removed.sparse.insertions[0], first);
  assert.equal(removed.rows.length, 0, 'removal must be represented in catalog composition');
  owner.close(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closes, 1);
});

console.log('V53_LITERAL_ORACLE_BOUNDARIES ' + JSON.stringify({ node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit, source: sourcePins.sourceSHA256,
  scope: 'frozen literal old collectors, actual live merge/liveness/rewind and sparse owner; synthetic native objects',
  notProven: ['new catalog differential integration', 'actual dock/Inspector React mount', 'native acceptance', 'global-memory savings'] }));
