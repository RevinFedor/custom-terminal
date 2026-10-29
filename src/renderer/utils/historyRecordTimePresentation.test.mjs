import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import recordTimes from '../../shared/history-record-time.cjs';
import { historyEntryRecordTime, historyGroupRecordTimeAttributes, historyRecordTimeAttributes,
  historyRecordTimeLabel, historyRecordTimeRangeLabel, placeHistoryRecordTime } from './historyRecordTimePresentation.mjs';
import { reduceHistoryLiveProjection } from './historyLiveProjection.mjs';
const at = '2026-10-07T07:46:18.647Z';
const time = { version: 1, timestamp: at, kind: 'tool-call', scope: 'record' };

test('local MCP/SC/question handoff uses saved submission time, then exact audit, never a generic timestamp', () => {
  const entry = { uuid: 'local-prompt-tab-handoff', role: 'queued', handoffId: 'handoff',
    optimisticAt: Date.parse(at), timestamp: '2099-01-01T00:00:00Z', statusChangedAt: Date.now() };
  assert.equal(historyEntryRecordTime(entry).timestamp, at);
  assert.equal(historyEntryRecordTime({ ...entry, auditTimestamp: '2026-10-07T07:47:00Z',
    auditEntryUuid: 'exact-canonical' }).timestamp, '2026-10-07T07:47:00Z');
  assert.equal(historyEntryRecordTime({ ...entry, recordTime: time }).timestamp, at);
  for (const changed of [{ optimisticAt: undefined }, { optimisticAt: NaN }, { optimisticAt: 0 },
    { optimisticAt: Infinity }, { optimisticAt: 9e15 }, { handoffId: undefined },
    { role: 'user' }, { uuid: 'ordinary-user' }]) assert.equal(historyEntryRecordTime({ ...entry, ...changed }), undefined);
  assert.equal(historyEntryRecordTime({ role: 'user', timestamp: at }), undefined);
  assert.equal(historyEntryRecordTime({ ...entry, optimisticAt: undefined, auditTimestamp: at }), undefined,
    'an unowned audit-looking timestamp is not canonical proof');
});

test('group range uses only its own published records/calls, not Worked or selected-caption state', () => {
  const later = { ...time, timestamp: '2026-10-07T07:49:00Z' };
  const entries = [{ uuid: 'A', recordTime: time, actions: [{ rawTool: { recordTime: later,
    get args() { assert.fail('time aggregation must not scan payload'); } } }] },
  { uuid: 'B', recordTime: { ...later, timestamp: '2026-10-07T07:51:00Z' }, responseTiming: { endTs: Date.now() } }];
  const result = historyGroupRecordTimeAttributes(entries, 'group');
  assert.equal(result['data-history-time-at'], at);
  assert.equal(result['data-history-time-end-at'], '2026-10-07T07:51:00Z');
  assert.equal(result['data-history-time-kind'], 'group');
  assert.deepEqual(historyGroupRecordTimeAttributes([...entries, { uuid: 'unknown', timestamp: at }], 'group'), {});
  assert.deepEqual(historyGroupRecordTimeAttributes([], 'group'), {});
  assert.deepEqual(historyGroupRecordTimeAttributes(entries, ''), {});
});

test('group time formatting shares the day once, preserves midnight boundaries and rejects reversed/unknown ranges', () => {
  const date = (day, hours, minutes) => new Date(2026, 9, day, hours, minutes).toISOString();
  const source = timestamp => ({ version: 1, timestamp, kind: 'message', scope: 'record' });
  const now = Date.parse(date(23, 8, 0));
  assert.equal(historyRecordTimeRangeLabel(source(date(23, 7, 26)), source(date(23, 7, 29)), now), '| сегодня, 07:26 — 07:29');
  assert.equal(historyRecordTimeRangeLabel(source(date(22, 23, 58)), source(date(23, 0, 1)), now), '| вчера, 23:58 — сегодня, 00:01');
  assert.equal(historyRecordTimeRangeLabel(source(date(23, 7, 26)), source(date(23, 7, 26)), now), '| сегодня, 07:26');
  assert.equal(historyRecordTimeRangeLabel(source(date(23, 7, 29)), source(date(23, 7, 26)), now), '');
  assert.equal(historyRecordTimeRangeLabel({}, source(date(23, 7, 29)), now), '');
});

test('actual History stable-row comparison notices time-only enrichment but reuses equivalent metadata', () => {
  const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['isRawAction', 'isTaskAction', 'isFileAction', 'historyActionPresentationEqual',
    'historySourceIdentityAliasesEqual', 'historyEntryPresentationEqual', 'retainStableHistoryEntryReferences'];
  const context = vm.createContext({ recordTimes, haveSameComposerChips: () => true, haveSamePromptImageRefs: () => true });
  const declarations = names.map(name => ast.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name))?.getText(ast));
  assert.ok(declarations.every(Boolean));
  const js = ts.transpileModule(declarations.join('\n') + '\n globalThis.equal = historyEntryPresentationEqual; globalThis.retain = retainStableHistoryEntryReferences;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(js, context);
  const plain = { uuid: 'A', role: 'assistant', timestamp: at, content: 'same', sessionId: 'S' };
  const dated = { ...plain, recordTime: { ...time, kind: 'message' } };
  assert.equal(context.equal(plain, dated), false);
  assert.equal(context.equal(dated, { ...dated, recordTime: { ...dated.recordTime } }), true);
  assert.equal(context.retain([plain], [dated])[0], dated);
  const action = { tool: '__raw__', rawTool: { toolUseId: 'call', toolName: 'Read', args: {}, recordTime: time } };
  const before = { ...dated, actions: [action] };
  const changed = { ...dated, actions: [{ ...action, rawTool: { ...action.rawTool, recordTime: { ...time, scope: 'container' } } }] };
  assert.equal(context.equal(before, changed), false);
});

test('Cmd-hover labels only consume proven metadata, not existing timestamps or Worked', () => {
  assert.deepEqual(historyRecordTimeAttributes(undefined, 'key', 'text'), {});
  assert.equal(historyRecordTimeLabel({ timestamp: at }), '');
  assert.equal(historyRecordTimeAttributes(time, 'call', 'tool')['data-history-time-at'], at);
  assert.ok(historyRecordTimeLabel(time, Date.parse(at)).startsWith('| сегодня,'));
});

test('live tools retain call time after result arrival; user/assistant keep source time', () => {
  const raw = { uuid: 'A', type: 'assistant', recordTime: { ...time, kind: 'message' }, message: { role: 'assistant', content: [
    { type: 'text', text: 'source text' }, { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'pwd' }, recordTime: { ...time, scope: 'container' } },
  ] } };
  const first = reduceHistoryLiveProjection([], { toolType: 'codex', sessionId: 'S', timestamp: '2026-10-07T07:46:23.699Z', message: raw });
  assert.deepEqual(first[0].recordTime, raw.recordTime);
  assert.deepEqual(first[0].actions[0].rawTool.recordTime, raw.message.content[1].recordTime);
  const done = reduceHistoryLiveProjection(first, { toolType: 'codex', sessionId: 'S', timestamp: '2026-10-07T07:46:24.000Z',
    message: { uuid: 'R', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] } } });
  assert.deepEqual(done[0].actions[0].rawTool.recordTime, first[0].actions[0].rawTool.recordTime);
  const user = reduceHistoryLiveProjection([], { toolType: 'claude', sessionId: 'S', recordTime: { ...time, kind: 'message' },
    message: { uuid: 'U', type: 'user', message: { role: 'user', content: 'canonical user' } } }, { includeUserText: true });
  assert.deepEqual(user[0].recordTime, { ...time, kind: 'message' });
  const unknown = reduceHistoryLiveProjection([], { toolType: 'claude', sessionId: 'S', timestamp: at,
    message: { uuid: 'X', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'unknown time' }] } } });
  assert.equal(unknown[0].recordTime, undefined);
});

test('inline/fallback geometry remains inside pane and outside existing controls', () => {
  const pane = { left: 0, top: 0, right: 350, bottom: 700 };
  const clip = { ...pane, bottom: 570 };
  const size = { width: 160, height: 18 };
  const chrome = [{ left: 10, top: 580, right: 340, bottom: 700 }];
  const p = anchor => placeHistoryRecordTime({ anchor, pane, clip, size, obstacles: chrome, safeTop: 580 });
  assert.equal(p({ left: 20, top: 80, right: 80, bottom: 100 }).placement, 'inline');
  const fallback = p({ left: 20, top: 80, right: 300, bottom: 100 });
  assert.equal(fallback.placement, 'fallback');
  assert.ok(fallback.bottom < 580 && fallback.right <= 350);
  assert.equal(placeHistoryRecordTime({ anchor: null, pane, clip, size: { width: 600, height: 18 }, safeTop: 580 }), null);
});

test('actual SDK parser preserves per-record part dates across merged turns, without borrowing generated sort time', async () => {
  const bundle = await build({ entryPoints: [new URL('../components/Workspace/ClaudeSDK/sdkHistoryParser.ts', import.meta.url).pathname], bundle: true,
    platform: 'node', format: 'esm', write: false });
  const sdk = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const messages = sdk.parseSubagentMessages([
    { type: 'user', uuid: 'U', timestamp: at, message: { content: 'user' } },
    { type: 'assistant', uuid: 'A', timestamp: at, message: { content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'a' } }] } },
    { type: 'assistant', uuid: 'B', timestamp: '2026-10-07T07:47:01.000Z', message: { content: [{ type: 'text', text: 'later text' }] } },
  ]);
  assert.equal(messages[0].recordTime.timestamp, at);
  assert.equal(messages[1].recordTime, undefined, 'merged turn has several source records');
  assert.equal(messages[1].parts[0].recordTime.timestamp, at);
  assert.equal(messages[1].parts[1].recordTime.timestamp, '2026-10-07T07:47:01.000Z');
  assert.equal(messages[1].toolCalls[0].recordTime.timestamp, at);
  const unknown = sdk.parseSubagentMessages([{ type: 'assistant', message: { content: 'legacy source without timestamp' } }]);
  assert.equal(unknown[0].parts[0].recordTime, undefined);
});
