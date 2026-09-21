'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareHistoryRowWindow, applyHistoryRowWindow } = require('./history-entry-window');

const fixture = () => Array.from({ length: 640 }, (_, index) => ({
  uuid: 'row-' + index, sessionId: 'fixture', role: 'assistant',
  actions: [{ tool: '__raw__', rawTool: {
    toolUseId: 'call-' + index, toolName: 'Bash', family: 'bash',
    args: { command: 'node -e "' + 'x'.repeat(300) + '"' }, result: 'done',
  } }],
}));

test('cold preparation yields and preserves every window/stub field and hydrated identity', async () => {
  for (const centerUuid of [null, 'row-200', 'missing']) {
    const rows = fixture();
    rows[1].actions[0].rawTool.backgroundStatus = 'running';
    delete rows[2].actions[0].rawTool.result;
    rows[3].sourceIdentityAliases = ['previous-physical-source'];
    const hydrate = { centerUuid, radius: 30, alwaysHydrateTail: 12 };
    const expected = applyHistoryRowWindow(structuredClone(rows), hydrate);
    let beats = 0;
    const prepared = await prepareHistoryRowWindow(rows, hydrate, {
      yieldToMain: () => new Promise(resolve => setImmediate(() => { beats++; resolve(); })),
    });
    assert.ok(beats >= 5, 'other main tasks run before preparation returns');
    assert.equal(prepared.yields, beats);
    const actual = applyHistoryRowWindow(rows, hydrate);
    assert.deepEqual(actual, expected);
    assert.equal(actual.entries[1], rows[1], 'live work remains hydrated');
    assert.equal(actual.entries[2], rows[2], 'pending output remains hydrated');
    assert.equal(actual.entries.at(-1), rows.at(-1), 'tail object is not cloned');
  }
});

test('a later result or argument mutation invalidates warmed labels normally', async () => {
  const rows = fixture(); const hydrate = { radius: 3, alwaysHydrateTail: 1 };
  await prepareHistoryRowWindow(rows, hydrate);
  rows[0].actions[0].rawTool.args.command = 'rg changed src/main';
  rows[0].actions[0].rawTool.isError = true;
  rows[0].sourceIdentityAliases = ['exact-other-source'];
  rows[1].actions[0].rawTool.backgroundStatus = 'running';
  assert.deepEqual(applyHistoryRowWindow(rows, hydrate),
    applyHistoryRowWindow(structuredClone(rows), hydrate));
});

test('full consumers, empty input and structured/accessor args keep the original contract', async () => {
  let yields = 0;
  await prepareHistoryRowWindow(fixture(), null, { yieldToMain: async () => { yields++; } });
  await prepareHistoryRowWindow([], { radius: 1 }, { yieldToMain: async () => { yields++; } });
  assert.equal(yields, 0);
  const rows = fixture(); let value = '/repo/a.md'; let gets = 0;
  rows[0].actions[0].rawTool.args = { get file_path() { gets++; return value; } };
  rows[0].actions[0].rawTool.toolName = 'Read';
  rows[1].actions[0].rawTool.args = { command: 'node x', extra: { mode: 1 } };
  const hydrate = { radius: 1, alwaysHydrateTail: 1 };
  await prepareHistoryRowWindow(rows, hydrate);
  assert.equal(gets, 0, 'unmemoizable fields are not eagerly read in preparation');
  value = '/repo/b.md'; rows[1].actions[0].rawTool.args.extra.mode = 2;
  assert.deepEqual(applyHistoryRowWindow(rows, hydrate),
    applyHistoryRowWindow(structuredClone(rows), hydrate));
});
