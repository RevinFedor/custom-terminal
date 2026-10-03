import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHistoryDisplayUnits, isCaptionForNext } from './historyDisplayUnits.mjs';
import { HISTORY_CAPTION_MAX_CHARS } from '../../shared/history-action-grammar.mjs';

const require = createRequire(import.meta.url);
const { applyHistoryRowWindow, makeHistoryRowStub } = require('../../main/history-entry-window.js');
const row = (uuid, content, extra = {}) => ({ uuid, role: 'assistant', content,
  sessionId: 'synthetic', timestamp: '2026-10-02T17:50:00Z', ...extra });
const call = (uuid) => row(uuid, '', { actions: [{ tool: '__raw__', rawTool: {
  toolUseId: 'call-' + uuid, toolName: 'Read', family: 'read', args: { file_path: '/synthetic/a.ts' }, result: 'done',
} }] });
const rows = [row('prompt', 'Question', { role: 'user' }),
  ...Array.from({ length: 12 }, (_, i) => [row('caption-' + i, 'Checking the requested code. ',
    { textPhase: 'commentary' }), call('read-' + i), call('other-' + i)]).flat(),
  row('answer', 'The answer being read. '.repeat(80), { textPhase: 'final_answer' }),
  row('later-prompt', 'Next question', { role: 'user' }), row('later-answer', 'Following answer. '.repeat(60)),
];
const topology = (units) => units.map(unit => ({ kind: unit.kind, key: unit.key,
  uuid: unit.entry?.uuid, members: unit.entries?.map(e => e.uuid), caption: unit.captionEntry?.uuid,
  parent: unit.parentGroup?.key }));

test('actual row-window keeps caption decisions without shipping their text', () => {
  for (const [text, phase, expected] of [
    ['  short headline  ', 'commentary', true],
    ['x'.repeat(HISTORY_CAPTION_MAX_CHARS), 'commentary', true],
    ['x'.repeat(HISTORY_CAPTION_MAX_CHARS + 1), 'commentary', false],
    ['short final', 'final_answer', false], ['', 'commentary', false], [' \n\t ', 'commentary', false],
  ]) {
    const full = row('caption', text, { textPhase: phase });
    const stub = makeHistoryRowStub(full);
    assert.equal(isCaptionForNext(full, call('next')), expected);
    assert.equal(isCaptionForNext(stub, call('next')), expected, JSON.stringify({ length: text.length, phase }));
    assert.equal(stub.content, undefined, 'off-screen text stays out of RAM payload');
    assert.equal(stub.contentLength, text.trim().length);
    assert.equal(makeHistoryRowStub(stub), stub, 'SSD stub is idempotent');
  }
});

test('moving the actual hydration window cannot change display units or the reading index', () => {
  const full = buildHistoryDisplayUnits(rows);
  const expandedKeys = new Set(full.filter(u => u.kind === 'group').map(u => u.key));
  for (const options of [{}, { expandedKeys }]) {
    const expected = topology(buildHistoryDisplayUnits(rows, options));
    for (const centerUuid of [undefined, 'prompt', 'caption-4', 'read-7', 'answer']) {
      const window = applyHistoryRowWindow(rows, { centerUuid, radius: 4, alwaysHydrateTail: 2 });
      assert.ok(window.stubbedCount > 0);
      assert.deepEqual(topology(buildHistoryDisplayUnits(window.entries, options)), expected,
        'only payload presence may change: centre=' + centerUuid);
    }
  }
});

test('completion refresh preserves the list that previously combined cached prefix and live tail', () => {
  const prefix = rows.slice(0, -3), tail = rows.slice(-3);
  const before = [...applyHistoryRowWindow(prefix, { radius: 10, alwaysHydrateTail: 2 }).entries, ...tail];
  const after = applyHistoryRowWindow(rows, { radius: 10, alwaysHydrateTail: 2 }).entries;
  assert.deepEqual(topology(buildHistoryDisplayUnits(before)), topology(buildHistoryDisplayUnits(after)));
});

test('unknown legacy or invalid stub lengths never invent a caption', () => {
  for (const contentLength of [undefined, null, -1, Infinity, NaN, '4']) {
    assert.equal(isCaptionForNext({ uuid: 'legacy', role: 'assistant', rowStub: true,
      hasContent: true, contentLength }, call('next')), false);
  }
});
