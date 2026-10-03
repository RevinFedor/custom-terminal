'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const api = require('./ipc/codex-data')._api;
const { projectCodexLiveSettingsHistory } = require('./codex-settings-history');
const { applyHistoryRowWindow } = require('./history-entry-window');
const sid = 'settings-session';
const setting = (line, model, effort = 'max') => ({ __line: line, __byteOffset: line * 100,
  timestamp: `2026-09-30T15:00:${String(line).padStart(2, '0')}.000Z`, type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort } } });
const initial = setting(1, 'gpt-6-astra');
const change = setting(2, 'gpt-6.1-sol');
const second = setting(3, 'gpt-6.1-sol', 'high');
const envelope = entry => ({ type: 'history_entry', toolType: 'codex', sessionId: sid, entry,
  recordByteOffset: entry.recordByteOffset });

test('actual canonical parser and immediate short-record projection agree, unchanged pair members do not duplicate', async () => {
  const { reduceHistoryLiveProjection, buildHistoryLivePresentation, reconcileCommittedHistoryLiveProjection,
    historyLivePresentationKey } = await import('../renderer/utils/historyLiveProjection.mjs');
  const state = { sessionId: sid };
  const rows = projectCodexLiveSettingsHistory(state, change);
  assert.deepEqual(rows.map(row => row.content), ['/model gpt-6.1-sol', '/effort max']);
  const live = rows.reduce((all, row) => reduceHistoryLiveProjection(all, envelope(row)), []);
  const baseline = api.buildCodexFullHistory([initial], sid);
  const before = buildHistoryLivePresentation(baseline, live);
  assert.deepEqual(before.map(row => row.content), ['/model gpt-6-astra', '/effort max', '/model gpt-6.1-sol']);
  assert.equal(projectCodexLiveSettingsHistory(state, change).length, 0, 'same raw source replay');
  assert.equal(projectCodexLiveSettingsHistory(state, setting(3, 'gpt-6.1-sol')).length, 0, 'native repeats complete pair');
  const durable = api.buildCodexFullHistory([initial, change, setting(3, 'gpt-6.1-sol')], sid);
  assert.deepEqual(buildHistoryLivePresentation(durable, live).map(row => row.content), before.map(row => row.content));
  assert.equal(historyLivePresentationKey(before.at(-1)), historyLivePresentationKey(durable.at(-1)));
  assert.equal(reconcileCommittedHistoryLiveProjection(live, durable).entries.length, 0);
});

test('model then effort and later model-back keep causal order and exact identities rather than deduping prompt text', async () => {
  const { reduceHistoryLiveProjection, buildHistoryLivePresentation, reconcileCommittedHistoryLiveProjection } = await import('../renderer/utils/historyLiveProjection.mjs');
  const state = { sessionId: sid };
  const records = [change, second, setting(4, 'gpt-6-astra', 'high')];
  const live = records.flatMap(record => projectCodexLiveSettingsHistory(state, record))
    .reduce((all, row) => reduceHistoryLiveProjection(all, envelope(row)), []);
  const canonical = api.buildCodexFullHistory([initial, ...records], sid);
  assert.deepEqual(buildHistoryLivePresentation(api.buildCodexFullHistory([initial], sid), live).map(e => e.content),
    canonical.map(e => e.content));
  assert.equal(reconcileCommittedHistoryLiveProjection(live, canonical).entries.length, 0);
});

test('canonical primary may precede the first visible live alias; presentation key survives live retirement', async () => {
  const { buildHistoryLivePresentation, historyLivePresentationKey, reconcileCommittedHistoryLiveProjection } =
    await import('../renderer/utils/historyLiveProjection.mjs');
  const repeated = setting(3, 'gpt-6.1-sol');
  const live = projectCodexLiveSettingsHistory({ sessionId: sid }, repeated);
  const options = { settingsPresentationKeys: new Map() };
  const baseline = api.buildCodexFullHistory([initial], sid);
  const early = buildHistoryLivePresentation(baseline, live, options).at(-1);
  const canonical = api.buildCodexFullHistory([initial, change, repeated], sid);
  const adopted = buildHistoryLivePresentation(canonical, live, options).at(-1);
  assert.notEqual(early.sourceIdentity, adopted.sourceIdentity, 'actual live/primary alias handoff');
  assert.equal(historyLivePresentationKey(early), historyLivePresentationKey(adopted));
  const retired = reconcileCommittedHistoryLiveProjection(live, canonical).entries;
  assert.equal(retired.length, 0);
  assert.equal(historyLivePresentationKey(buildHistoryLivePresentation(canonical, retired, options).at(-1)),
    historyLivePresentationKey(early));
});

test('canonical contradiction for the SAME settings record stays beside that row; missing/different operation is not error', async () => {
  const { buildHistoryLivePresentation, reconcileCommittedHistoryLiveProjection } = await import('../renderer/utils/historyLiveProjection.mjs');
  const live = projectCodexLiveSettingsHistory({ sessionId: sid }, change);
  assert.ok(buildHistoryLivePresentation([], live).every(e => !e.settingsProjectionError));
  const durable = api.buildCodexFullHistory([change], sid);
  const wrong = durable.map(row => row.settingsFact.kind === 'model'
    ? { ...row, content: '/model wrong', settingsFact: { ...row.settingsFact, value: 'wrong' } } : row);
  const visible = buildHistoryLivePresentation(wrong, live);
  assert.equal(visible.length, 2);
  assert.match(visible[0].settingsProjectionError, /gpt-6.1-sol.*wrong/);
  assert.equal(reconcileCommittedHistoryLiveProjection(live, wrong).entries.length, 1, 'retain contradictory proof until resolved');
  assert.equal(reconcileCommittedHistoryLiveProjection(live, durable).entries.length, 0);
  const later = api.buildCodexFullHistory([setting(5, 'other-model')], sid);
  assert.ok(buildHistoryLivePresentation(later, live).every(e => !e.settingsProjectionError), 'later model change is another source');
});

test('main publisher reuses one parsed provider record for desktop and SSE with no transcript read or model execution', () => {
  const source = fs.readFileSync(require.resolve('./main'), 'utf8');
  const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'emitCodexHistoryLiveSettings');
  const desktop = [], sse = [];
  const context = vm.createContext({ projectCodexLiveSettingsHistory,
    console: { log() {} }, mainWindow: { isDestroyed: () => false, webContents: { send: (_name, event) => desktop.push(event) } },
    _webBroadcast: (_tab, event) => sse.push(event) });
  vm.runInContext(node.getText(ast), context);
  const state = { sessionId: sid, tabId: 'test-tab' };
  context.emitCodexHistoryLiveSettings(state, change);
  assert.deepEqual(desktop, sse); assert.equal(desktop.length, 2);
  assert.equal(desktop[0].entry.sourceIdentity, `codex-model-source-${sid}-200`);
  context.emitCodexHistoryLiveSettings(state, { type: 'event_msg', __byteOffset: 300,
    timestamp: '2026-09-30T15:00:03.000Z', payload: { type: 'thread_rolled_back', num_turns: 1 } });
  assert.deepEqual(desktop, sse);
  assert.equal(desktop[2].type, 'history_settings_reset');
  assert.equal(desktop[2].recordByteOffset, 300);
  assert.equal(desktop[2].sessionId, sid);
  assert.equal(state.historySettingsProjection, undefined);
  context.emitCodexHistoryLiveSettings(state, { type: 'event_msg', payload: { type: 'thread_rolled_back' } });
  assert.equal(desktop.length, 3, 'no physical source offset means no fabricated public reset');
  assert.match(source, /if \(!suppressPublications && \(event === 'thread_settings_applied' \|\| event === 'thread_rolled_back'\)\) \{\s+emitCodexHistoryLiveSettings\(state, record\)/);
});

test('full projector continuation and unhydrated row metadata preserve exact settings aliases', () => {
  const p = api.createCodexHistoryProjector(sid); p.feed(initial);
  const v8 = require('node:v8');
  const resumed = api.createCodexHistoryProjector(sid, v8.deserialize(v8.serialize(p.exportState())));
  resumed.feed(change); resumed.feed(second);
  assert.deepEqual(resumed.finalize(), api.buildCodexFullHistory([initial, change, second], sid));
  // The real row-window function retains settingsFact on offscreen stubs.
  const window = applyHistoryRowWindow(resumed.finalize(), { centerUuid: 'absent', radius: 1, alwaysHydrateTail: 1 });
  assert.ok(window.entries.every(row => row.settingsFact));
});

test('unrelated/partial/conflicting records and old offsets never fabricate applied settings', () => {
  for (const record of [{ ...change, __byteOffset: null }, { ...change, type: 'response_item' },
    { ...change, payload: { type: 'user_message', message: '/model fake' } },
    { ...change, payload: { type: 'thread_settings_applied', thread_settings: { model: 'fake' } } },
    { ...change, payload: { type: 'thread_settings_applied', thread_settings: { model: 'fake', effort: 'low', reasoning_effort: 'max' } } }]) {
    assert.deepEqual(projectCodexLiveSettingsHistory({ sessionId: sid }, record), []);
  }
  const state = { sessionId: sid }; projectCodexLiveSettingsHistory(state, second);
  assert.deepEqual(projectCodexLiveSettingsHistory(state, change), []);
});

test('rollback retires the removed display baseline; reapplying that pair produces its new exact setting record', async () => {
  const rollback = { type: 'event_msg', __line: 6, __byteOffset: 600, payload: { type: 'thread_rolled_back', num_turns: 1 } };
  const user = (line, message) => ({ type: 'event_msg', __line: line, __byteOffset: line * 100,
    payload: { type: 'user_message', message } });
  const before = [initial, user(2, 'first'), setting(3, 'gpt-6.1-sol'), user(4, 'second')];
  const later = setting(7, 'gpt-6.1-sol');
  const after = api.buildCodexFullHistory([...before, rollback, later], sid);
  assert.ok(after.some(row => row.sourceIdentity === `codex-model-source-${sid}-700`));
  const state = { sessionId: sid }; projectCodexLiveSettingsHistory(state, setting(3, 'gpt-6.1-sol'));
  projectCodexLiveSettingsHistory(state, rollback);
  assert.ok(projectCodexLiveSettingsHistory(state, later).some(row => row.settingsFact.kind === 'model'));
});
