'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SessionTranscriptService } = require('./session-transcript-service');

test('Claude bounded History is served by the main-owned loader with bounds intact', async () => {
  const calls = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => null,
    webBroadcast: () => {},
    claudeData: {
      _api: {
        getFullHistory: async (payload, context) => {
          calls.push({ payload, context });
          return {
            success: true,
            entries: [{ uuid: 'tail' }],
            total: 1000,
            dropped: 999,
            truncated: true,
            boundsApplied: true,
          };
        },
      },
    },
    codexData: {},
  });

  const result = await service.getHistory({
    tabId: 'tab-1',
    toolType: 'claude',
    sessionId: 'session-1',
    cwd: '/tmp/project',
    bounds: { last: 1 },
  });

  assert.equal(result.success, true);
  assert.equal(result.boundsApplied, true);
  assert.equal(result.total, 1000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload.bounds, { last: 1 });
  assert.equal(calls[0].context.sender, null);
});

test('Claude last=N projection is bounded while the rich history is built', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
  assert.match(source, /const tailOnlyWindow = requestedTailLimit/);
  assert.match(source, /if \(tailOnlyWindow && entries\.length > requestedTailLimit\) entries\.shift\(\)/);
  assert.match(source, /total: projectedEntryTotal/);
});

test('Claude full History treats popAll as returning queued prompts to the composer', () => {
  const source = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
  const popAllStart = source.indexOf("entry.operation === 'popAll'");
  assert.notEqual(popAllStart, -1);
  const popAllBody = source.slice(popAllStart, popAllStart + 900);
  assert.match(popAllBody, /queued\.queueStatus !== 'queued'/);
  assert.match(popAllBody, /pendingQueueEntries\.splice\(queueIndex, 1\)/);
  assert.match(popAllBody, /entries\.splice\(renderedIdx, 1\)/);
  assert.doesNotMatch(popAllBody, /queued\.queueStatus = 'sent'/);
  assert.doesNotMatch(popAllBody, /queued\.queueStatus = 'cancelled'/);
  assert.doesNotMatch(popAllBody, /promoteAllPendingCompactEntries/);
});
