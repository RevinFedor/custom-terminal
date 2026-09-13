'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderSemanticShadow, createSseParser } = require('./provider-semantic-shadow');
const { createTerminalHistoryPreviewController } = require('./terminal-history-preview-controller');

function harness() {
  const emitted = [], events = [], timers = new Map(), logs = [];
  const log = {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
  };
  const mirror = { generation: 'mirror', generationOrdinal: 1, terminal: {
    registerMarker: () => ({ line: 0, dispose() {} }),
  } };
  let context = { terminal: {}, mirror, lifecycleGeneration: 'launch:1' };
  let timerId = 0, turnId, sourceId;
  const controller = createTerminalHistoryPreviewController({
    getContext: () => context,
    readFrame: () => { throw Error('semantic Claude must not parse the terminal'); },
    emit: e => emitted.push(e), log,
    setTimer: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  const shadow = createProviderSemanticShadow({ log, onClaudeSemanticEvent: detail => {
    events.push(detail.event);
    return controller.observeSemanticEvent({ ...detail, instanceId: detail.sourceId });
  } });
  function arm(id = 'claude:1') {
    turnId = id;
    sourceId = context.lifecycleGeneration + ':' + id;
    controller.activateSemanticSource({ tabId: 'tab', provider: 'claude', instanceId: sourceId });
    shadow.armClaudeTurn({ tabId: 'tab', sessionId: 'session', turnId, sourceId, prompt: 'Do the task' });
    controller.begin({ tabId: 'tab', provider: 'claude', sessionId: 'session', turnId, sourceBoundary: 10 });
  }
  function request({ messageId = 'msg-1', headers = {}, body = {}, ...other } = {}) {
    const req = shadow.beginClaudeRequest({ tabId: 'tab',
      headers: { 'x-claude-code-session-id': 'session', ...headers },
      body: { messages: [{ role: 'user', content: 'Do the task' }], ...body }, ...other,
    });
    send(req, 'message_start', { message: { id: messageId } });
    return req;
  }
  function canonical(messageId, text, identity = 'uuid-1', offset = 20) {
    return controller.observeCanonical({ tabId: 'tab', provider: 'claude', sessionId: 'session',
      sourceEndOffset: offset, identity, semanticMessageId: messageId,
      canonicalText: Array.isArray(text) ? text.join('\n') : text,
      canonicalTexts: Array.isArray(text) ? text : [text],
    });
  }
  const flush = () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } };
  arm();
  return { shadow, controller, mirror, emitted, events, logs, arm, request, canonical, flush,
    get text() { return controller.get('tab')?.text || ''; },
    get state() { return controller._turns.get('tab'); },
    replaceLaunch() { context = { ...context, terminal: {}, lifecycleGeneration: 'launch:2' }; },
  };
}
function send(req, type, fields = {}) { return req.observeSseEvent({ event: type, data: { type, ...fields } }); }
function textBlock(req, text, index = 0, complete = true) {
  send(req, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
  send(req, 'content_block_delta', { index, delta: { type: 'text_delta', text } });
  if (complete) send(req, 'content_block_stop', { index });
}
function toolBlock(req, id = 'tool-1', index = 1) {
  send(req, 'content_block_start', { index, content_block: { type: 'tool_use', id, name: 'Bash' } });
  send(req, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } });
  send(req, 'content_block_stop', { index });
}

test('Claude streams main text, settles exact JSONL, continues tools and waits for Stop', () => {
  const h = harness(), req = h.request();
  send(req, 'content_block_start', { index: 0, content_block: { type: 'thinking' } });
  send(req, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'clamping. · summarized' } });
  assert.equal(h.text, '');
  textBlock(req, 'First **live** answer.', 1);
  h.flush();
  assert.equal(h.controller.get('tab').sourceMode, 'semantic');
  assert.equal(h.text, 'First **live** answer.');
  assert.equal(h.canonical('msg-1', h.text), true);
  assert.equal(h.text, '');
  assert.equal(h.emitted.at(-1).canonicalIdentity, 'uuid-1');
  toolBlock(req, 'tool-1', 2);
  send(req, 'message_stop');
  assert.equal(h.state.phase, 'streaming');
  const next = h.request({ messageId: 'msg-2', body: { messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
  ] }] } });
  assert.equal(next.classification, 'main');
  textBlock(next, 'Final answer.');
  h.flush();
  send(next, 'message_stop');
  assert.equal(h.text, 'Final answer.');
  assert.equal(h.state.canonicalMaterialized, false);
  h.shadow.finishClaudeTurn({ tabId: 'tab' });
  h.controller.finish({ tabId: 'tab', provider: 'claude', turnId: 'claude:1', reason: 'stop' });
  assert.equal(h.state.phase, 'settled');
  assert.equal(h.text, 'Final answer.');
  assert.equal(h.canonical('msg-2', 'Final answer.', 'uuid-2', 30), true);
  assert.equal(h.text, '');
  assert.equal(h.emitted.at(-1).canonicalIdentity, 'uuid-2');
});

test('screen redraw, summarized thinking and tool receipts cannot enter or erase network prose', () => {
  const h = harness(), req = h.request();
  h.controller.observeFrame('tab', h.mirror, { authoritativeFrameCommitted: true,
    mirrorGeneration: 'mirror', committedFrameGeneration: 1, writeSeq: 1,
    lines: [{ row: 1, text: 'clamping. · summarized' }],
  });
  assert.equal(h.text, '');
  textBlock(req, 'clamping. · summarized'); // legitimate text delta is not blacklisted
  h.flush();
  h.controller.observeBoundary({ tabId: 'tab', provider: 'claude', sessionId: 'session',
    kind: 'thinking', structuredTexts: ['clamping. · summarized'], sourceEndOffset: 25 });
  assert.equal(h.text, 'clamping. · summarized');
});

test('side requests, subagents, wrong sessions and unarmed requests never feed History', () => {
  const h = harness();
  for (const options of [
    { body: { output_config: { format: { type: 'json_schema' } } } },
    { headers: { 'x-claude-code-agent-id': 'child' } },
    { headers: { 'x-claude-code-session-id': 'other' } },
    { body: { messages: [{ role: 'user', content: 'Suggest something unrelated' }] } },
  ]) { const req = h.request(options); textBlock(req, 'NOT A MAIN ANSWER'); send(req, 'message_stop'); }
  assert.equal(h.text, '');
  assert.equal(h.events.length, 0);
  h.shadow.finishClaudeTurn({ tabId: 'tab' });
  textBlock(h.request(), 'late unarmed text');
  assert.equal(h.text, '');
});

test('exact message identity and ordered full blocks settle repeated prose without cross-message matching', () => {
  const h = harness(), req = h.request();
  textBlock(req, 'Same words.', 0);
  textBlock(req, 'Same words.', 1);
  h.flush();
  h.canonical('foreign-message', 'Same words.', 'wrong', 20);
  assert.equal(h.text, 'Same words.\n\nSame words.');
  h.canonical('msg-1', 'Same words.', 'first-row', 30);
  assert.equal(h.text, 'Same words.');
  h.canonical('msg-1', 'Same words.', 'first-row', 40); // replay of same UUID
  assert.equal(h.text, 'Same words.');
  h.canonical('msg-1', 'Same words.', 'second-row', 50);
  assert.equal(h.text, '');
});

test('one canonical row may settle multiple text blocks and leaves the next message untouched', () => {
  const h = harness(), req = h.request();
  textBlock(req, 'One', 0); textBlock(req, 'Two', 1); toolBlock(req, 'tool-1', 2);
  send(req, 'message_stop');
  const next = h.request({ messageId: 'msg-2', body: { messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
  ] }] } });
  textBlock(next, 'Three'); h.flush();
  h.canonical('msg-1', ['One', 'Two']);
  assert.equal(h.text, 'Three');
});

test('JSONL before item completion uses exact message proof and emits one anchor-preserving clear', () => {
  const h = harness(), req = h.request();
  textBlock(req, 'The whole answer.', 0, false); h.flush();
  h.canonical('msg-1', 'The whole answer.', 'exact-canonical-row');
  send(req, 'content_block_stop', { index: 0 });
  assert.equal(h.text, '');
  assert.equal(h.emitted.at(-1).reason, 'canonical-materialized');
  assert.equal(h.emitted.at(-1).canonicalIdentity, 'exact-canonical-row');
  send(req, 'content_block_stop', { index: 0 });
  send(req, 'message_stop');
  assert.equal(h.text, '');
  assert.equal(h.emitted.filter(e => e.action === 'clear').length, 1);
});

test('exact canonical message retires a settled prefix when Stop revoked the late network completion', () => {
  const h = harness(), req = h.request({ messageId: 'msg-production-race' });
  const prefix = 'P'.repeat(1891);
  const canonical = prefix + 'T'.repeat(107);
  textBlock(req, prefix, 0, false);
  h.flush();
  h.shadow.finishClaudeTurn({ tabId: 'tab', reason: 'stop' });
  h.controller.finish({ tabId: 'tab', provider: 'claude', turnId: 'claude:1', reason: 'stop' });
  assert.equal(h.text.length, 1891);
  const beforeCanonical = h.controller.getDiagnosticState('tab', 'claude');
  assert.equal(beforeCanonical.phase, 'settled');
  assert.equal(beforeCanonical.previewChars, 1891);
  assert.equal(beforeCanonical.semanticItems[0].chars, 1891);
  assert.equal(beforeCanonical.semanticItems[0].completed, false);
  assert.equal(JSON.stringify(beforeCanonical).includes(prefix), false,
    'diagnostic metadata must not duplicate assistant prose');
  const eventsAfterStop = h.events.length;
  send(req, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STALE' } });
  send(req, 'content_block_stop', { index: 0 });
  assert.equal(h.events.length, eventsAfterStop, 'revoked network source stays unable to write');
  assert.equal(h.text, prefix);

  assert.equal(h.canonical('msg-production-race', canonical, 'canonical-production'), true);
  assert.equal(h.text, '');
  assert.equal(h.emitted.at(-1).reason, 'canonical-materialized');
  assert.match(h.logs.join('\n'), /SEMANTIC_CANONICAL_ACK .*match=message-id-and-canonical-prefix/);

  h.arm('claude:2');
  const foreign = h.request({ messageId: 'msg-foreign' });
  textBlock(foreign, prefix, 0, false);
  h.flush();
  h.controller.finish({ tabId: 'tab', provider: 'claude', turnId: 'claude:2', reason: 'stop' });
  assert.equal(h.canonical('another-message', canonical, 'foreign-canonical'), false);
  assert.equal(h.text, prefix, 'text similarity without exact message identity cannot clear preview');
});

test('new turn, Stop and replacement process reject old decoded events', () => {
  const h = harness(), old = h.request();
  textBlock(old, 'Old'); h.flush();
  h.arm('claude:2');
  assert.equal(h.emitted.at(-1).action, 'clear', 'replacing authority must also clear the old renderer projection');
  assert.equal(h.emitted.at(-1).reason, 'semantic-authority-established');
  send(old, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STALE' } });
  assert.equal(h.text, '');
  const current = h.request({ messageId: 'new' });
  textBlock(current, 'Current'); h.flush();
  h.replaceLaunch();
  send(current, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STALE' } });
  assert.equal(h.state.text, 'Current');
  assert.equal(h.canonical('new', 'Current'), false);
  h.arm('claude:3');
  const stopped = h.request({ messageId: 'last' });
  h.shadow.finishClaudeTurn({ tabId: 'tab' });
  textBlock(stopped, 'after Stop');
  assert.equal(h.text, '');
});

test('broken response retracts only its own provisional text; retry is a new main response', () => {
  const h = harness(), req = h.request();
  textBlock(req, 'Partial', 0, false); h.flush();
  req.markGap('connection-reset'); req.finish('forward-error');
  assert.equal(h.text, '');
  const retry = h.request({ messageId: 'retry' });
  textBlock(retry, 'Recovered'); h.flush();
  assert.equal(h.text, 'Recovered');
  send(req, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'late' } });
  assert.equal(h.text, 'Recovered');
});

test('SSE UTF-8 is preserved even when every byte arrives separately', () => {
  const found = [], parser = createSseParser({ onEvent: e => found.push(JSON.parse(e.data)) });
  const text = 'Русский ответ 🟠';
  const bytes = Buffer.from('data: ' + JSON.stringify({ text }) + '\n\n');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(found, [{ text }]);
});

test('native Claude disconnect cancels the live tap even while upstream buffers keep delivering', () => {
  const { EventEmitter } = require('node:events');
  const h = harness(), req = h.request();
  const downstream = new EventEmitter();
  downstream.writableEnded = false;
  req.bindDownstream(downstream);
  textBlock(req, 'Saved partial answer', 0, false); h.flush();
  h.canonical('msg-1', 'Saved partial answer', 'interrupted-partial');
  downstream.emit('close');
  assert.equal(req.finished, true);
  assert.equal(h.text, '');
  const eventCount = h.events.length;
  for (let i = 0; i < 50; i++) send(req, 'content_block_delta', {
    index: 0, delta: { type: 'text_delta', text: 'NOT ACCEPTED BY CLAUDE' },
  });
  assert.equal(h.events.length, eventCount);
  assert.equal(h.text, '');
  h.shadow.finishClaudeTurn({ tabId: 'tab', reason: 'interrupt-jsonl' });
  h.controller.finish({ tabId: 'tab', provider: 'claude', turnId: 'claude:1', reason: 'interrupt-jsonl' });
  h.arm('claude:2');
  const next = h.request({ messageId: 'msg-new' }); textBlock(next, 'NEW-TURN-OK'); h.flush();
  assert.equal(h.text, 'NEW-TURN-OK');
  h.canonical('msg-new', 'NEW-TURN-OK', 'new-canonical');
  assert.equal(h.text, '');
});

test('normal completed downstream does not retract a successfully received Claude response', () => {
  const { EventEmitter } = require('node:events');
  const h = harness(), req = h.request(), downstream = new EventEmitter();
  req.bindDownstream(downstream);
  textBlock(req, 'Complete response.'); send(req, 'message_stop'); h.flush();
  downstream.writableEnded = true;
  downstream.emit('close');
  assert.equal(h.text, 'Complete response.');
  assert.equal(downstream.listenerCount('close'), 0);
});

test('shared Claude user-text parser recognizes both native interruption carriers, not assistant prose', () => {
  const { claudeUserRecordText } = require('./ipc/claude-data')._api;
  const marker = '[Request interrupted by user]';
  for (const content of [marker, [{ type: 'text', text: marker }]]) {
    assert.equal(claudeUserRecordText({ type: 'user', message: { content } }), marker);
    assert.equal(claudeUserRecordText({ type: 'assistant', message: { content } }), '');
  }
});

test('a failing History callback cannot interrupt delivery to the CLI', () => {
  const shadow = createProviderSemanticShadow({ log: { log() {}, warn() {} },
    onClaudeSemanticEvent() { throw Error('renderer unavailable'); },
  });
  shadow.armClaudeTurn({ tabId: 'tab', turnId: 'turn', sourceId: 'launch', prompt: 'task' });
  const req = shadow.beginClaudeRequest({ tabId: 'tab', body: { messages: [{ role: 'user', content: 'task' }] } });
  assert.doesNotThrow(() => {
    send(req, 'message_start', { message: { id: 'msg' } }); textBlock(req, 'Answer'); send(req, 'message_stop');
  });
  assert.equal(req.finished, true);
});

test('late first-session subscription catches up the first answer without replaying History or lifecycle', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { SessionTranscriptService } = require('./session-transcript-service');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-preview-first-subscribe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl');
  const prefix = JSON.stringify({ type: 'user', message: { content: 'Do the task' } }) + '\n';
  const row = { type: 'assistant', uuid: 'first-canonical', message: {
    id: 'msg-1', content: [{ type: 'text', text: 'Already saved first answer.' }],
  } };
  const line = JSON.stringify(row) + '\n';
  await fs.writeFile(filePath, prefix + line);
  const h = harness(), req = h.request();
  textBlock(req, 'Already saved first answer.'); toolBlock(req); send(req, 'message_stop'); h.flush();
  const raw = [], rendered = [];
  const service = new SessionTranscriptService({
    claudeData: { findSessionFile: () => ({ filePath }) }, codexData: null,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: e => rendered.push(e) } }),
    onRawRecord: e => raw.push(e),
    onLiveMessage: e => h.canonical(e.message.message.id,
      e.message.message.content[0].text, e.message.uuid, e.recordEndByteOffset),
  });
  t.after(() => {
    for (const state of service.sessions.values()) service._closeState(state, 'test-cleanup');
  });
  const consumerId = 'main:preview:tab';
  await service.subscribe({ toolType: 'claude', sessionId: 'session', cwd: dir, tabId: 'tab', consumerId });
  assert.equal(h.text, 'Already saved first answer.', 'watcher starts AFTER this row, as in the physical failure');
  const state = [...service.sessions.values()][0];
  const liveOffset = state.offset;
  await service.replayClaudePreview({ consumerId, fromByteOffset: Buffer.byteLength(prefix), isCurrent: () => true });
  assert.equal(h.text, '');
  assert.equal(h.emitted.at(-1).canonicalIdentity, 'first-canonical');
  assert.equal(state.offset, liveOffset, 'catch-up must not rewind the shared live cursor');
  assert.deepEqual(raw, [], 'no duplicate prompt/receipt/lifecycle side effects');
  assert.deepEqual(rendered, [], 'durable History owns already-saved rows');
  h.arm('claude:2');
  const fresh = h.request({ messageId: 'msg-1' }); textBlock(fresh, 'Already saved first answer.'); h.flush();
  await service.replayClaudePreview({ consumerId, fromByteOffset: Buffer.byteLength(prefix), isCurrent: () => false });
  assert.equal(h.text, 'Already saved first answer.', 'old asynchronous catch-up cannot write into replacement turn');
});

test('late exact catch-up may settle an earlier item after the newer live record', () => {
  const h = harness(), first = h.request();
  textBlock(first, 'First'); toolBlock(first); send(first, 'message_stop');
  const second = h.request({ messageId: 'msg-2', body: { messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
  ] }] } });
  textBlock(second, 'Second'); h.flush();
  h.canonical('msg-2', 'Second', 'newer', 200);
  assert.equal(h.text, 'First');
  h.canonical('msg-1', 'First', 'earlier', 100);
  assert.equal(h.text, '');
  assert.equal(h.state.sourceBoundary, 200);
  assert.equal(h.controller.getCanonicalCatchupScope('tab').fromByteOffset, 10);
});
