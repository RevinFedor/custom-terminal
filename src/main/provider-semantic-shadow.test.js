'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_ITEM_TEXT_CHARS,
  createProviderSemanticShadow,
  createSseParser,
  normalizeText,
  textHash,
} = require('./provider-semantic-shadow');
const {
  createTerminalHistoryPreviewController,
} = require('./terminal-history-preview-controller');

function quietLog() {
  return { log() {}, warn() {}, error() {} };
}

function claudeEvent(context, type, payload = {}) {
  context.observeSseEvent({
    event: type,
    data: JSON.stringify({ type, ...payload }),
  });
}

test('SSE parser keeps event boundaries across arbitrary chunks', () => {
  const events = [];
  const parser = createSseParser({ onEvent: (event) => events.push(event) });
  parser.push('event: content_block_del');
  parser.push('ta\ndata: {"type":"content_block_delta",');
  parser.push('\ndata: "delta":{"text":"hello"}}\r\n\r\n');
  parser.push(': ping\n\nevent: message_stop\ndata: {"type":"message_stop"}');
  parser.end();
  assert.deepEqual(events, [
    {
      event: 'content_block_delta',
      data: '{"type":"content_block_delta",\n"delta":{"text":"hello"}}',
    },
    { event: 'message_stop', data: '{"type":"message_stop"}' },
  ]);
});

test('Claude publishes only the exact hook-owned request and its tool continuation', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog(), now: () => 100 });
  shadow.armClaudeTurn({
    tabId: 'tab-claude',
    sessionId: 'session-1',
    turnId: 'claude:7',
    prompt: 'write the exact answer',
  });

  const suggestion = shadow.beginClaudeRequest({
    tabId: 'tab-claude',
    headers: { 'x-claude-code-session-id': 'session-1' },
    body: {
      messages: [{ role: 'user', content: 'write the exact answer' }],
      output_config: { format: { type: 'json_schema' } },
    },
  });
  claudeEvent(suggestion, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  claudeEvent(suggestion, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'suggested prompt' },
  });
  claudeEvent(suggestion, 'message_stop');

  const main = shadow.beginClaudeRequest({
    tabId: 'tab-claude',
    headers: { 'x-claude-code-session-id': 'session-1' },
    body: { messages: [{ role: 'user', content: 'write the exact answer' }] },
  });
  claudeEvent(main, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  claudeEvent(main, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'first block' },
  });
  claudeEvent(main, 'content_block_stop', { index: 0 });
  claudeEvent(main, 'content_block_start', {
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
  });
  claudeEvent(main, 'content_block_stop', { index: 1 });
  claudeEvent(main, 'message_stop');

  const continuation = shadow.beginClaudeRequest({
    tabId: 'tab-claude',
    headers: { 'x-claude-code-session-id': 'session-1' },
    body: {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      }],
    },
  });
  claudeEvent(continuation, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  claudeEvent(continuation, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'final block' },
  });
  claudeEvent(continuation, 'message_stop');

  const [snapshot] = shadow.snapshot('tab-claude');
  const state = snapshot.providers.claude;
  assert.equal(state.mainRequests, 2);
  assert.equal(state.sideRequests, 1);
  assert.equal(state.unknownRequests, 0);
  assert.equal(state.latestMain.head, 'final block');
  assert.equal(state.latestMain.hash, textHash('final block'));
  assert.equal(snapshot.events.some((event) => (
    event.type === 'REQUEST'
    && event.classification === 'side'
    && event.reason === 'structured-output-request'
  )), true);
});

test('Claude subagent and unowned requests are observable but never become main text', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog() });
  const subagent = shadow.beginClaudeRequest({
    tabId: 'tab-claude',
    headers: { 'x-claude-code-agent-id': 'agent-1' },
    body: { messages: [{ role: 'user', content: 'child work' }] },
  });
  claudeEvent(subagent, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  claudeEvent(subagent, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'child answer' },
  });
  claudeEvent(subagent, 'message_stop');

  const unknown = shadow.beginClaudeRequest({
    tabId: 'tab-claude',
    body: { messages: [{ role: 'user', content: 'not armed' }] },
  });
  claudeEvent(unknown, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  claudeEvent(unknown, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text: 'unowned answer' },
  });
  claudeEvent(unknown, 'message_stop');

  const state = shadow.snapshot('tab-claude')[0].providers.claude;
  assert.equal(state.subagentRequests, 1);
  assert.equal(state.unknownRequests, 1);
  assert.equal(state.assistantDeltaEvents, 0);
  assert.equal(state.latestMain, null);
});

test('Codex WebSocket keeps prewarm separate and captures the exact turn', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog(), now: () => 200 });
  const connection = shadow.createCodexConnection({ tabId: 'tab-codex' });

  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    generate: false,
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-c',
        thread_id: 'thread-c',
        turn_id: 'turn-prewarm',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'prewarm-item',
    delta: 'must stay hidden',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.completed',
    response: { id: 'resp-prewarm', output: [] },
  }));

  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-c',
        thread_id: 'thread-c',
        turn_id: 'turn-1',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.created',
    response: { id: 'resp-1' },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    response_id: 'resp-1',
    item_id: 'msg-1',
    delta: 'hello ',
  }));
  const duringStream = shadow.snapshot('tab-codex')[0].providers.codex;
  assert.equal(duringStream.latestDelta.chars, 6);
  assert.equal(duringStream.latestMain, null);
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    response_id: 'resp-1',
    item_id: 'msg-1',
    delta: 'world',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    response_id: 'resp-1',
    item_id: 'msg-1',
    text: 'hello world',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.completed',
    response: { id: 'resp-1', output: [] },
  }));

  const state = shadow.snapshot('tab-codex')[0].providers.codex;
  assert.equal(state.sideRequests, 1);
  assert.equal(state.mainRequests, 1);
  assert.equal(state.latestMain.head, 'hello world');
  assert.equal(state.latestMain.turnId, 'turn-1');
});

test('canonical comparison uses exact normalized network assistant text', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog() });
  const connection = shadow.createCodexConnection({ tabId: 'tab-codex' });
  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session',
        thread_id: 'thread',
        turn_id: 'turn',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    item_id: 'item',
    text: '  exact\r\nanswer  ',
  }));

  assert.equal(shadow.observeCanonical({
    tabId: 'tab-codex',
    provider: 'codex',
    turnId: 'turn',
    text: 'exact\nanswer',
  }), true);
  const state = shadow.snapshot('tab-codex')[0].providers.codex;
  assert.equal(state.canonicalMatches, 1);
  assert.equal(normalizeText(' x\r\n'), 'x');
});

test('shadow text and tab lifetime stay bounded', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog() });
  const connection = shadow.createCodexConnection({ tabId: 'bounded-tab' });
  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ turn_id: 'bounded-turn' }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    item_id: 'large-item',
    text: 'x'.repeat(MAX_ITEM_TEXT_CHARS + 100),
  }));
  const state = shadow.snapshot('bounded-tab')[0].providers.codex;
  assert.equal(state.latestMain.chars, MAX_ITEM_TEXT_CHARS + 100);
  assert.equal(state.latestMain.truncated, true);
  assert.equal(state.latestMain.hash, null);
  assert.equal(shadow.clear('bounded-tab', 'test'), true);
  assert.deepEqual(shadow.snapshot('bounded-tab'), []);
});

test('an incomplete transport cannot claim canonical parity from a partial item', () => {
  const shadow = createProviderSemanticShadow({ log: quietLog() });
  const connection = shadow.createCodexConnection({ tabId: 'gap-tab' });
  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ turn_id: 'gap-turn' }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    item_id: 'gap-item',
    text: 'looks complete but the response never completed',
  }));
  connection.finishAll('upstream-close:1006');
  assert.equal(shadow.observeCanonical({
    tabId: 'gap-tab',
    provider: 'codex',
    turnId: 'gap-turn',
    text: 'looks complete but the response never completed',
  }), false);
  const state = shadow.snapshot('gap-tab')[0].providers.codex;
  assert.equal(state.latestMain.gap, true);
  assert.equal(state.canonicalPending, 1);
});

test('Codex main provider stream publishes exact live events while prewarm stays hidden', () => {
  const live = [];
  const shadow = createProviderSemanticShadow({
    log: quietLog(),
    onCodexSemanticEvent: (event) => live.push(event),
  });
  const connection = shadow.createCodexConnection({
    tabId: 'live-tab',
    transport: 'websocket',
    sourceId: 'launch-1',
  });

  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    generate: false,
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ turn_id: 'prewarm-turn' }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'prewarm-item',
    delta: 'hidden',
  }));
  assert.equal(live.length, 0);

  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: 'session-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'item-1',
    delta: '**live** ',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    item_id: 'item-1',
    text: '**live** answer',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.completed',
    response: { id: 'response-1', output: [] },
  }));

  assert.deepEqual(live.map((detail) => detail.event.type), [
    'turn_started',
    'item_started',
    'assistant_delta',
    'item_completed',
    'turn_completed',
  ]);
  assert.equal(live.every((detail) => detail.sourceId === 'launch-1'), true);
  assert.equal(live[2].event.delta, '**live** ');
  assert.equal(live[3].event.item.text, '**live** answer');
  assert.equal(live[3].event.itemId, 'item-1');
});

test('failed Codex provider request retracts only its request-owned live items', () => {
  const live = [];
  const shadow = createProviderSemanticShadow({
    log: quietLog(),
    onCodexSemanticEvent: (event) => live.push(event),
  });
  const connection = shadow.createCodexConnection({
    tabId: 'retry-tab',
    sourceId: 'launch-retry',
  });
  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ turn_id: 'turn-retry' }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'partial-item',
    delta: 'partial response',
  }));
  connection.finishAll('upstream-close:1006');

  const failed = live.find((detail) => detail.event.type === 'request_failed');
  assert.ok(failed);
  assert.equal(failed.event.turnId, 'turn-retry');
  assert.match(failed.event.requestId, /^codex-/);
  assert.equal(live.some((detail) => detail.event.type === 'turn_completed'), false);
});

test('Codex provider stream reaches History and exact rollout item retires it', () => {
  const tabId = 'integrated-tab';
  const sourceId = 'integrated-launch';
  const terminal = {};
  const mirror = {
    generation: 'mirror-1',
    generationOrdinal: 1,
    terminal: {
      registerMarker() {
        return { line: 0, isDisposed: false, dispose() { this.isDisposed = true; } };
      },
    },
  };
  const emitted = [];
  const timers = [];
  const controller = createTerminalHistoryPreviewController({
    getContext: () => ({ terminal, mirror, lifecycleGeneration: 'lifecycle-1' }),
    readFrame: () => null,
    emit: (event) => emitted.push(event),
    log: quietLog(),
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (callback) => {
      const index = timers.indexOf(callback);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const flush = () => {
    while (timers.length > 0) timers.shift()();
  };
  controller.expectSemanticSource({ tabId });
  controller.activateSemanticSource({ tabId, instanceId: sourceId });

  const shadow = createProviderSemanticShadow({
    log: quietLog(),
    onCodexSemanticEvent: (detail) => controller.observeSemanticEvent({
      tabId: detail.tabId,
      instanceId: detail.sourceId,
      event: detail.event,
    }),
  });
  const connection = shadow.createCodexConnection({ tabId, sourceId });
  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-integrated',
        turn_id: 'turn-integrated',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'item-integrated',
    delta: 'Ответ **из прокси**',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.done',
    item_id: 'item-integrated',
    text: 'Ответ **из прокси**',
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.completed',
    response: { id: 'response-integrated', output: [] },
  }));
  flush();

  assert.equal(emitted.at(-1).preview.text, 'Ответ **из прокси**');
  assert.equal(emitted.at(-1).preview.sourceMode, 'semantic');
  assert.equal(controller._turns.get(tabId).phase, 'streaming',
    'network RESPONSE_END is only a segment boundary');
  assert.equal(controller.observeCanonical({
    tabId,
    provider: 'codex',
    sessionId: 'thread-integrated',
    sourceSequence: 1,
    identity: 'rollout-item-integrated',
    semanticItemId: 'item-integrated',
    canonicalText: 'Ответ **из прокси**',
  }), true);
  assert.equal(emitted.at(-1).action, 'clear');

  connection.observeClientFrame(JSON.stringify({
    type: 'response.create',
    client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'thread-integrated',
        turn_id: 'turn-integrated',
      }),
    },
  }));
  connection.observeServerFrame(JSON.stringify({
    type: 'response.output_text.delta',
    item_id: 'item-after-tool',
    delta: 'Новый блок после tool',
  }));
  flush();
  assert.equal(emitted.at(-1).preview.text, 'Новый блок после tool');
  assert.doesNotMatch(emitted.at(-1).preview.text, /Ответ \*\*из прокси\*\*/);
});
