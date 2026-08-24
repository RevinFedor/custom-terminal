'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionTranscriptService } = require('./session-transcript-service');

function line(record) {
  return JSON.stringify(record) + '\n';
}

function tokenCount(used) {
  return {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: used },
        model_context_window: 1000,
      },
    },
  };
}

test('stopped-session observer seeds, invalidates on external compact, then accepts the new count', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-context-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  await fs.promises.writeFile(filePath, line(tokenCount(830)));
  const observations = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: null,
    onCodexContextObservation: (detail) => observations.push(detail),
    claudeData: null,
    codexData: {
      _api: {
        findCodexSessionFile: async () => ({ filePath }),
      },
    },
    idleGraceMs: 0,
  });

  const subscribed = await service.subscribe({
    toolType: 'codex',
    sessionId: 'session-a',
    cwd: dir,
    consumerId: 'main:codex-context:session-a',
  });
  assert.equal(subscribed.success, true);
  assert.equal(observations.at(-1)?.source, 'tail-seed');
  assert.equal(observations.at(-1)?.observation.contextPct, 83);

  const state = [...service.sessions.values()][0];
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  await fs.promises.appendFile(filePath, line({
    type: 'compacted',
    timestamp: '2026-08-23T14:40:59.000Z',
    payload: { replacement_history: [] },
  }));
  await service._readChange(state, 'test-compact');
  assert.equal(observations.at(-1)?.source, 'append');
  assert.equal(observations.at(-1)?.observation.kind, 'invalidated');

  await fs.promises.appendFile(filePath, line(tokenCount(120)));
  await service._readChange(state, 'test-token');
  assert.equal(observations.at(-1)?.observation.kind, 'value');
  assert.equal(observations.at(-1)?.observation.contextPct, 12);

  await service.unsubscribe({ consumerId: 'main:codex-context:session-a' });
});
