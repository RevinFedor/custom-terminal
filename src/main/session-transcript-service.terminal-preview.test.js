'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionTranscriptService } = require('./session-transcript-service');
const claudeData = require('./ipc/claude-data');
const {
  CLAUDE_HISTORY_CONTEXT_ACK_MODEL,
  CLAUDE_HISTORY_CONTEXT_ACK_TEXT,
} = require('./agent-history-context-injection');

test('Claude history-only boundary reaches lifecycle observers but never the live History renderer', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-live-history-context-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-context.jsonl');
  const record = {
    type: 'assistant',
    uuid: 'history-context-boundary',
    timestamp: '2026-08-19T00:00:00.000Z',
    message: {
      role: 'assistant',
      model: CLAUDE_HISTORY_CONTEXT_ACK_MODEL,
      content: [{ type: 'text', text: CLAUDE_HISTORY_CONTEXT_ACK_TEXT }],
      stop_reason: 'end_turn',
    },
  };
  const line = JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath, line);
  const raw = [];
  const live = [];
  const rendered = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => rendered.push(args) },
    }),
    webBroadcast: null,
    onRawRecord: (detail) => raw.push(detail),
    onLiveMessage: (detail) => live.push(detail),
    claudeData,
    codexData: null,
  });

  await service._broadcastClaudeDelta({
    filePath,
    size: Buffer.byteLength(line),
    offset: 0,
    leftover: '',
    sessionId: 'session-context',
    consumers: new Map([['history:tab-context', { tabId: 'tab-context' }]]),
  }, 0);

  assert.equal(raw.length, 1, 'main lifecycle still observes the provider record');
  assert.deepEqual(live, []);
  assert.deepEqual(rendered, []);
});

test('Claude compact summary reaches lifecycle but never becomes a second live user row', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-live-compact-summary-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-compact.jsonl');
  const record = {
    type: 'user',
    uuid: 'compact-summary',
    isCompactSummary: true,
    timestamp: '2026-08-20T13:42:37.544Z',
    message: {
      role: 'user',
      content: 'This session is being continued from a previous conversation...',
    },
  };
  const line = JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath, line);
  const raw = [];
  const live = [];
  const rendered = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => rendered.push(args) },
    }),
    onRawRecord: (detail) => raw.push(detail),
    onLiveMessage: (detail) => live.push(detail),
    claudeData: null,
    codexData: null,
  });

  await service._broadcastClaudeDelta({
    filePath,
    size: Buffer.byteLength(line),
    offset: 0,
    leftover: '',
    sessionId: 'session-compact',
    consumers: new Map([['history:tab-compact', { tabId: 'tab-compact' }]]),
  }, 0);

  assert.equal(raw.length, 1, 'compact lifecycle still sees the exact provider record');
  assert.equal(raw[0].message.uuid, 'compact-summary');
  assert.deepEqual(live, []);
  assert.deepEqual(rendered, []);
});

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

test('Claude raw observer receives hidden task notifications once per tab', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-raw-notification-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session-a.jsonl');
  const record = {
    type: 'attachment',
    uuid: 'notification-a',
    sessionId: 'session-a',
    attachment: {
      type: 'task_notification',
      prompt: '<task-notification><tool-use-id>toolu_a</tool-use-id><status>completed</status></task-notification>',
    },
  };
  const line = JSON.stringify(record) + '\n';
  await fs.promises.writeFile(filePath, line);
  const raw = [];
  const rendered = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => rendered.push(args) },
    }),
    onRawRecord: (detail) => raw.push(detail),
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
      ['timeline:tab-a', { tabId: 'tab-a' }],
    ]),
  }, 0);

  assert.equal(raw.length, 1);
  assert.equal(raw[0].tabId, 'tab-a');
  assert.equal(raw[0].message.uuid, 'notification-a');
  assert.equal(raw[0].recordByteOffset, 0);
  assert.deepEqual(rendered, [], 'service-only notification stays hidden from renderer live rows');
});

test('Codex raw observer receives exact canonical and tool boundaries without a second live row', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-preview-boundary-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'rollout.jsonl');
  const records = [
    {
      type: 'event_msg',
      timestamp: '2026-08-29T18:14:51.695Z',
      payload: {
        type: 'agent_message',
        message: 'canonical answer',
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-08-29T18:14:51.697Z',
      payload: {
        type: 'message',
        role: 'assistant',
        id: 'item-exact',
        content: [{ type: 'output_text', text: 'canonical answer' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-08-29T18:14:55.611Z',
      payload: {
        type: 'custom_tool_call',
        id: 'call-exact',
        name: 'apply_patch',
        input: { patch: '*** Begin Patch' },
      },
    },
  ];
  const agentLine = JSON.stringify(records[0]) + '\n';
  const assistantLine = JSON.stringify(records[1]) + '\n';
  const text = agentLine + assistantLine + JSON.stringify(records[2]) + '\n';
  await fs.promises.writeFile(filePath, text);
  const raw = [];
  const live = [];
  const rendered = [];
  const service = new SessionTranscriptService({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => rendered.push(args) },
    }),
    onRawRecord: (detail) => raw.push(detail),
    onLiveMessage: (detail) => live.push(detail),
    claudeData: null,
    codexData: null,
  });

  await service._broadcastCodexDelta({
    filePath,
    size: Buffer.byteLength(text),
    offset: 0,
    leftover: '',
    sessionId: 'rollout-owner',
    consumers: new Map([
      ['history:tab-a', { tabId: 'tab-a' }],
      ['timeline:tab-a', { tabId: 'tab-a' }],
    ]),
  }, 0);

  assert.equal(raw.length, 3, 'one raw boundary per physical record and tab');
  assert.equal(raw[0].toolType, 'codex');
  assert.equal(raw[0].sessionId, 'rollout-owner');
  assert.equal(raw[0].recordByteOffset, 0);
  assert.equal(raw[0].recordEndByteOffset, Buffer.byteLength(agentLine));
  assert.equal(raw[1].recordByteOffset, Buffer.byteLength(agentLine));
  assert.equal(raw[2].recordByteOffset, Buffer.byteLength(agentLine + assistantLine));
  assert.deepEqual(live, [], 'CodexTurn remains the only live-row publisher');
  assert.deepEqual(rendered, [], 'raw preview receipts never become renderer live rows');
});

test('Codex raw tickets come from complete actual FD bytes, including short reads and split UTF-8', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-raw-ticket-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'synthetic.jsonl');
  const text = 'complete 😀 canonical';
  const bytes = Buffer.from(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', id: 'I', content: [{ type: 'output_text', text }],
  } }) + '\n');
  const split = bytes.indexOf(Buffer.from('😀')) + 2;
  await fs.promises.writeFile(filePath, bytes.subarray(0, split));
  const observed = [];
  const service = new SessionTranscriptService({ onRawRecord: d => observed.push(d), claudeData: null, codexData: null });
  const stat = await fs.promises.stat(filePath);
  const state = { key: 'fixture', filePath, size: split, offset: 0, leftover: '',
    fileIdentity: `${stat.dev}:${stat.ino}`, sourceRewriteVersion: 0, sessionId: 'physical',
    consumers: new Map([['test', { tabId: 'T' }]]) };
  service.sessions.set(state.key, state);
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const fd = await originalOpen(...args);
    return { stat: () => fd.stat(), close: () => fd.close(),
      read: (buffer, offset, length, position) => fd.read(buffer, offset, Math.min(3, length), position) };
  };
  try {
    await service._broadcastCodexDelta(state, 0);
    assert.equal(observed.length, 0);
    await fs.promises.appendFile(filePath, bytes.subarray(split)); state.size = bytes.length;
    await service._broadcastCodexDelta(state, split);
  } finally { fs.promises.open = originalOpen; }
  assert.equal(observed.length, 1);
  assert.equal(observed[0].message.payload.content[0].text, text);
  assert.equal(observed[0].sourceTicket.start, 0);
  assert.equal(observed[0].sourceTicket.end, bytes.length);
  assert.equal(observed[0].sourceTicket.isCurrent(), true);
  state.sourceRewriteVersion++;
  assert.equal(observed[0].sourceTicket.isCurrent(), false);
  assert.equal(state.offset, bytes.length);
});
