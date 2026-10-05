import test from 'node:test';
import assert from 'node:assert/strict';
import { queuedRewindLabel, findRewindIteration, createRewindLabelReader } from './queuedRewindLabel.mjs';

test('Rewind chip contains only the selected ordinal, never text or markup', () => {
  const action = { targetText: '<saved_prompt name="huge title">' + 'x'.repeat(1000) };
  assert.equal(queuedRewindLabel({ ...action, targetIteration: 42 }), 'Rewind: 42');
  assert.equal(queuedRewindLabel(action, 12), 'Rewind: 12');
  assert.equal(queuedRewindLabel(action), 'Rewind');
  for (const targetIteration of [0, -1, 2.5, '42', NaN]) assert.equal(queuedRewindLabel({ ...action, targetIteration }), 'Rewind');
});

test('ordinal counts actual user turns, not compact/docs structural points', () => {
  const entries = [{ uuid: 'a', type: 'user' }, { uuid: 'b', type: 'compact' },
    { uuid: 'summary', type: 'user', isCompactSummary: true }, { uuid: 'docs', type: 'docs_edit' }, { uuid: 'target', type: 'user' }];
  assert.equal(findRewindIteration(entries, 'target'), 2);
  assert.equal(findRewindIteration(entries, 'summary'), null);
  assert.equal(findRewindIteration(entries, 'gone'), null);
});

test('legacy local/global copies share one read; exact owners do not share cached labels; payload stays untouched', async () => {
  const calls = [];
  const read = createRewindLabelReader(async request => { calls.push(request); return { success: true,
    entries: [{ uuid: 'first', type: 'user' }, { uuid: 'target', type: 'user' }] }; });
  const action = { toolType: 'codex', sourceSessionId: 's', targetUuid: 'target', targetText: 'original payload' };
  const before = JSON.stringify(action), context = { tabId: 'owner', cwd: '/project' };
  assert.deepEqual(await Promise.all([read(action, context), read(action, context)]), [2, 2]); assert.equal(calls.length, 1);
  assert.equal(await read(action, context), 2); assert.equal(calls.length, 1);
  await read(action, { ...context, tabId: 'other' }); assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(action), before); assert.ok(calls.every(call => !('targetText' in call)));
  assert.equal(await read({ ...action, targetIteration: 9 }, context), 9); assert.equal(calls.length, 2);
});

test('missing/failed history does not invent an ordinal or poison a later retry', async () => {
  let calls = 0;
  const read = createRewindLabelReader(async () => { if (++calls === 1) throw Error('temporarily unavailable');
    return { success: true, entries: [{ uuid: 'target', type: 'user' }] }; });
  const action = { toolType: 'claude', sourceSessionId: 's', targetUuid: 'target' };
  await assert.rejects(read(action, { tabId: 'owner' }));
  assert.equal(await read(action, { tabId: 'owner' }), 1);
});
