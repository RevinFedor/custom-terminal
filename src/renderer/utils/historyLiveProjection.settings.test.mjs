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
