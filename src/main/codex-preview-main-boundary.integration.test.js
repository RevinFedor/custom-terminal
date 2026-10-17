'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createProviderSemanticShadow } = require('./provider-semantic-shadow');
const { createTerminalHistoryPreviewController } = require('./terminal-history-preview-controller');
const { codexProviderPreviewOwnerVerdict } = require('./codex-provider-preview');

const mainFile = path.join(__dirname, 'main.js');
const tree = ts.createSourceFile(mainFile, fs.readFileSync(mainFile, 'utf8'), ts.ScriptTarget.Latest, true);
const handlerNode = tree.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'handleCodexProviderSemanticEvent');
assert.ok(handlerNode, 'test the current Main handler, not a copied implementation');

function harness() {
  const tabId = 'preview-main-boundary-fixture';
  const sourceId = 'codex-provider:fixture-launch';
  const terminal = {};
  const mirror = { generation: 'fixture-mirror', generationOrdinal: 1 };
  const owner = { sourceId, terminalToken: terminal, launchId: 'fixture-launch',
    runSeq: 1, lifecycleGeneration: 'fixture-generation', turnActive: false };
  let current = { ...owner };
  const activity = [], events = [], emissions = [], forwarded = [], logs = [], timers = new Map();
  let timerId = 0;
  const log = { log: message => logs.push(message), warn: message => logs.push(message) };
  const controller = createTerminalHistoryPreviewController({
    getContext: () => ({ terminal: current.terminalToken, mirror,
      lifecycleGeneration: current.lifecycleGeneration }),
    readFrame: () => ({ status: 'unknown' }),
    emit: detail => emissions.push(detail), log,
    setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id),
  });
  controller.activateSemanticSource({ tabId, instanceId: sourceId });
  // No PTY, send, launch, Stop, or readiness API is available in this VM.
  const context = vm.createContext({
    codexCanonicalPresentation: null,
    console: log, codexProviderSemanticSources: new Map([[tabId, owner]]),
    codexProviderPreviewOwnerVerdict,
    currentCodexProviderSemanticOwnerContext: () => current,
    publishCodexProviderTurnActivity: detail => {
      activity.push(detail);
      owner.turnActive = detail.active;
      owner.turnId = detail.turnId;
    },
    terminalHistoryPreviewController: {
      observeSemanticEvent: detail => { forwarded.push(detail); return controller.observeSemanticEvent(detail); },
    },
  });
  vm.runInContext(handlerNode.getText(tree), context);
  const shadow = createProviderSemanticShadow({ log,
    onCodexSemanticEvent: detail => {
      events.push(detail.event);
      context.handleCodexProviderSemanticEvent(detail);
    },
  });
  const connection = shadow.createCodexConnection({ tabId, sourceId });
  const flush = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  const frame = payload => connection.observeServerFrame(JSON.stringify(payload));
  const completeItem = () => {
    connection.beginRequest({ turn_id: 'fixture-turn', thread_id: 'fixture-thread' });
    frame({ type: 'response.created', response: { id: 'fixture-response' } });
    frame({ type: 'response.output_text.done', response_id: 'fixture-response',
      item_id: 'fixture-item', text: 'Complete but unconfirmed response.' });
    frame({ type: 'response.completed', response: { id: 'fixture-response', output: [] } });
    flush();
  };
  return { tabId, owner, controller, activity, events, emissions, forwarded, logs, connection, completeItem, flush,
    replaceOwner: change => { current = { ...current, ...change }; } };
}

test('actual Main handler keeps completed-request/unknown-delivery separate from turn activity and launch/Stop', () => {
  const h = harness(); h.completeItem();
  assert.equal(h.activity.length, 1);
  assert.equal(h.activity[0].active, true, 'only the request start publishes activity');
  assert.equal(h.owner.turnActive, true, 'response.completed does not finish the whole turn');
  const activityBefore = h.activity.slice();
  h.connection.finishAll('client-close:1006'); h.flush();
  assert.equal(h.events.filter(event => event.type === 'request_delivery_unknown').length, 1);
  assert.deepEqual(h.activity, activityBefore, 'uncertain delivery is a preview event, not a new lifecycle edge');
  assert.equal(h.owner.turnActive, true);
  assert.equal(h.controller.get(h.tabId).responseSegments[0].phase, 'settled');
  assert.equal(h.controller.get(h.tabId).responseSegments[0].deliveryState, 'unknown');
});

test('a close after canonical turn completion cannot restart busy or make a settled response live', () => {
  const h = harness(); h.completeItem();
  h.controller.finish({ tabId: h.tabId, provider: 'codex', turnId: 'fixture-turn', reason: 'task_complete' });
  h.owner.turnActive = false;
  const activityCount = h.activity.length;
  h.connection.finishAll('client-close:1006'); h.flush();
  assert.equal(h.owner.turnActive, false);
  assert.equal(h.activity.length, activityCount);
  const preview = h.controller.get(h.tabId);
  assert.equal(preview.phase, 'settled');
  assert.equal(preview.responseSegments[0].phase, 'settled');
  assert.equal(preview.responseSegments[0].deliveryState, 'unknown');
  assert.equal(preview.text, 'Complete but unconfirmed response.');
});

test('Main rejects the old provider source after a Stop/replacement boundary before updating preview or activity', () => {
  for (const replacement of [
    { terminalToken: null }, { runSeq: 2 },
    { lifecycleGeneration: 'replacement-generation' }, { launchId: 'replacement-launch' },
  ]) {
    const h = harness(); h.completeItem();
    assert.ok(h.controller.get(h.tabId));
    const activityCount = h.activity.length, emissionCount = h.emissions.length, forwardedCount = h.forwarded.length;
    h.replaceOwner(replacement);
    h.connection.finishAll('client-close:1006'); h.flush();
    assert.equal(h.events.filter(event => event.type === 'request_delivery_unknown').length, 1);
    assert.equal(h.forwarded.length, forwardedCount, 'the stale event never reaches the preview controller');
    assert.equal(h.activity.length, activityCount);
    assert.equal(h.emissions.length, emissionCount);
    assert.match(h.logs.join('\n'), /\[CodexProviderSemantic\] STALE/);
  }
});

test('native incomplete retracts only open response text through actual Main without ending the turn', () => {
  const h = harness();
  h.connection.beginRequest({ turn_id: 'fixture-turn', thread_id: 'fixture-thread' });
  const frame = payload => h.connection.observeServerFrame(JSON.stringify(payload));
  frame({ type: 'response.created', response: { id: 'steered-response' } });
  frame({ type: 'response.output_text.delta', response_id: 'steered-response', item_id: 'partial',
    delta: 'Скачок после сворачивания исправлен в исходнике:' }); h.flush();
  assert.equal(h.controller.get(h.tabId).text.length, 48);
  const activityBefore = h.activity.slice();
  assert.equal(frame({ type: 'response.incomplete', response: { id: 'steered-response',
    incomplete_details: { reason: 'interrupted' } } }), true); h.flush();
  assert.equal(h.controller.get(h.tabId), null);
  assert.deepEqual(h.activity, activityBefore);
  assert.equal(h.owner.turnActive, true);
  assert.equal(h.forwarded.at(-1).event.type, 'request_failed');
  assert.equal(h.forwarded.at(-1).event.reason, 'response-incomplete:interrupted');
});

test('a late incomplete segment cannot cross Main replacement run or touch preview', () => {
  const h = harness();
  h.connection.beginRequest({ turn_id: 'fixture-turn', thread_id: 'fixture-thread' });
  const frame = payload => h.connection.observeServerFrame(JSON.stringify(payload));
  frame({ type: 'response.created', response: { id: 'old-response' } });
  frame({ type: 'response.output_text.delta', response_id: 'old-response', item_id: 'partial', delta: 'old' });
  h.flush();
  const before = h.controller.get(h.tabId), forwarded = h.forwarded.length, activity = h.activity.length;
  h.replaceOwner({ runSeq: 2 });
  frame({ type: 'response.incomplete', response: { id: 'old-response', incomplete_details: { reason: 'interrupted' } } });
  h.flush();
  assert.deepEqual(h.controller.get(h.tabId), before);
  assert.equal(h.forwarded.length, forwarded);
  assert.equal(h.activity.length, activity);
  assert.match(h.logs.join('\n'), /\[CodexProviderSemantic\] STALE/);
});
