'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionTranscriptService } = require('./session-transcript-service');

test('Claude live observer receives exact byte boundary before renderer fan-out', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-live-preview-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-a.jsonl');
  const record = {
    type: 'assistant',
    uuid: 'assistant-a',
    timestamp: '2026-08-07T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'canonical block' }],
    },
  };
  const line = JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath, line);
  const order = [];
  let observed = null;
  let rendered = null;
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (_channel, detail) => {
          order.push('renderer');
          rendered = detail;
        },
      },
    }),
    webBroadcast: null,
    onLiveMessage: (detail) => {
      order.push('observer');
      observed = detail;
    },
    claudeData: null,
    codexData: null,
  });
  await service._broadcastClaudeDelta({
    filePath,
    size: Buffer.byteLength(line),
    offset: 0,
    leftover: '',
    sessionId: 'session-a',
    consumers: new Map([
      ['history:tab-a', { tabId: 'tab-a' }],
    ]),
  }, 0);

  assert.deepEqual(order, ['observer', 'renderer']);
  assert.equal(observed.tabId, 'tab-a');
  assert.equal(observed.recordByteOffset, 0);
  assert.equal(observed.recordEndByteOffset, Buffer.byteLength(line));
  assert.equal(observed.message.uuid, 'assistant-a');
  assert.deepEqual(rendered, observed);
});
