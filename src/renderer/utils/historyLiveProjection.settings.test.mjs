import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryLivePresentation, reduceHistoryLiveProjection,
  reconcileCommittedHistoryLiveProjection } from './historyLiveProjection.mjs';
import { slashCommandDisplayFromText } from '../../shared/claude-slash-display.mjs';
import { projectTimelineLiveUserMessage } from './timelineTranscriptRefresh.mjs';

const setting = (uuid, name, args, offset, extra = {}) => ({ toolType: 'claude', sessionId: 'claude-a',
  timestamp: `2026-09-12T12:23:${offset === 100 ? '14' : '15'}.000Z`, recordByteOffset: offset,
  message: { type: 'user', uuid, sessionId: 'claude-a', isMeta: true,
    message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } },
  ...extra,
});

test('Run after model/effort rows precede the submitted prompt while full refresh stays pending', () => {
  let live = reduceHistoryLiveProjection([], setting('model-row', 'model', 'claude-fable-5[1m]', 100));
  live = reduceHistoryLiveProjection(live, setting('effort-row', 'effort', 'max', 200));
  assert.deepEqual(live.map(row => [row.role, row.content]), [
    ['slash', '/model claude-fable-5[1m]'], ['slash', '/effort max'],
  ]);
  const prompt = { uuid: 'local-prompt', role: 'queued', queueStatus: 'sent', sessionId: 'claude-a', recordByteOffset: 300 };
  assert.deepEqual(buildHistoryLivePresentation([prompt], live).map(row => row.uuid),
    ['model-row', 'effort-row', 'local-prompt']);
  const settled = reduceHistoryLiveProjection(live, { type: 'turn_boundary', boundary: 'turn_settled', sessionId: 'claude-a' });
  assert.deepEqual(settled.map(row => row.uuid), ['model-row', 'effort-row']);
});
test('same UUID is idempotent and canonical apply adopts the row without a duplicate', () => {
  const msg = setting('model-row', 'model', 'claude-fable-5[1m]', 100);
  const first = reduceHistoryLiveProjection([], msg);
  const twice = reduceHistoryLiveProjection(first, msg);
  assert.equal(twice.length, 1);
  const durable = [{ ...first[0] }];
  assert.equal(buildHistoryLivePresentation(durable, twice).length, 1);
  assert.equal(reconcileCommittedHistoryLiveProjection(twice, durable).entries.length, 0);
  assert.equal(first[0].content, slashCommandDisplayFromText(msg.message.message.content).content);
});
test('ordinary prompt, stdout, compact and Codex do not become Claude settings rows', () => {
  for (const msg of [
    setting('codex', 'model', 'x', 100, { toolType: 'codex' }),
    setting('compact', 'compact', '', 100),
    setting('stdout', 'model', 'x', 100, { message: { type: 'user', uuid: 'stdout', isMeta: true,
      message: { role: 'user', content: '<local-command-stdout>Set model to x</local-command-stdout>' } } }),
  ]) assert.ok(!reduceHistoryLiveProjection([], msg).some(row => row.role === 'slash'));
  const service = setting('service', 'model', 'x', 100);
  service.message.serviceCarrier = 'local-setting';
  service.message.message.content = [{ type: 'text', text: '/model x' }];
  assert.equal(projectTimelineLiveUserMessage(service, { toolType: 'claude', sessionId: 'claude-a' }), null);
});

test('same text with a different physical UUID is a separate setting, not deduplicated by value', () => {
  const first = reduceHistoryLiveProjection([], setting('first', 'model', 'fable', 100));
  const second = reduceHistoryLiveProjection([], setting('second', 'model', 'fable', 200));
  assert.equal(buildHistoryLivePresentation(first, second).length, 2);
  assert.equal(reconcileCommittedHistoryLiveProjection(second, first).entries.length, 1);
  const foreign = [{ ...first[0], sessionId: 'claude-b' }];
  assert.equal(reconcileCommittedHistoryLiveProjection(first, foreign).entries.length, 1);
  const prompt = [{ ...first[0], role: 'user' }];
  assert.equal(reconcileCommittedHistoryLiveProjection(first, prompt).entries.length, 1);
});

test('canonical picker outcome replaces the same bare slash row even when its display text changes', () => {
  const live = reduceHistoryLiveProjection([], setting('picker', 'model', '', 100));
  const durable = [{ ...live[0], content: '/model claude-fable-5[1m]' }];
  assert.strictEqual(buildHistoryLivePresentation(durable, live), durable);
  assert.equal(reconcileCommittedHistoryLiveProjection(live, durable).entries.length, 0);
});

test('compact → settings → queued prompt remains one pair through repeated late full refreshes', () => {
  const compact = { uuid: 'compact', role: 'compact', sessionId: 'claude-a', recordByteOffset: 50 };
  const messages = [setting('model', 'model', 'claude-fable-5[1m]', 100), setting('effort', 'effort', 'max', 200)];
  let live = messages.reduce((rows, event) => reduceHistoryLiveProjection(rows, event), []);
  const exactSettings = live.slice();
  const prompt = { uuid: 'prompt', role: 'queued', queueStatus: 'sent', sessionId: 'claude-a', recordByteOffset: 300 };
  const latePartial = [compact, exactSettings[0], prompt];
  assert.deepEqual(buildHistoryLivePresentation(latePartial, live).map(row => row.uuid), ['compact', 'model', 'effort', 'prompt']);
  for (let i = 0; i < 30; i++) {
    live = messages.reduce((rows, event) => reduceHistoryLiveProjection(rows, event), live);
    const durable = [compact, ...exactSettings, { ...prompt, role: 'user' }];
    const projection = buildHistoryLivePresentation(durable, live);
    assert.deepEqual(projection.map(row => row.uuid), ['compact', 'model', 'effort', 'prompt']);
    assert.equal(new Set(projection.map(row => row.uuid)).size, projection.length);
    live = reconcileCommittedHistoryLiveProjection(live, durable).entries;
    assert.equal(live.length, 0);
  }
});
