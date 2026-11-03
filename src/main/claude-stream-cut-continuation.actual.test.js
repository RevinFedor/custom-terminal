'use strict';
// Wiring for the automatic continuation after Anthropic cut the response
// stream mid-answer (production 02.11, session be82a19d, record 15ce6c4b).
//
// The decision (Fedor, 02.11) is "always continue, like Codex capacity", so
// this suite does NOT re-test the retry policy — that is the shared
// codex-capacity-retry-policy, already covered by its own tests. What must be
// pinned here is that Claude is plugged into that exact policy, and that the
// send cannot escape the ordinary admission rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const { reduceCodexCapacityRetry } = require('./codex-capacity-retry-policy');
const { claudeStreamCutFromRecord } = require('../shared/claude-stream-cut-retry.cjs');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const decl = (name) => ast.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const quiet = { log() {}, warn() {}, error() {} };

const CUT_RECORD = Object.freeze({
  type: 'assistant', uuid: '15ce6c4b-362e-4fda-941e-d40dc4bad53e',
  isApiErrorMessage: true, error: 'server_error', streamCutCause: 'server_error',
  truncatedAfterOutput: true, sessionId: 'be82a19d-4a26-4263-b32a-e91477e1cd17',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text',
    text: 'API Error: Server error mid-response. The response above may be incomplete.' }] },
});

const ANSWER_RECORD = Object.freeze({
  type: 'assistant', uuid: 'ok-1', sessionId: 'be82a19d-4a26-4263-b32a-e91477e1cd17',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Готово.' }] },
});

// The real observer from main.js, over stubbed collaborators.
function observer({ sessionBinding = 'be82a19d-4a26-4263-b32a-e91477e1cd17' } = {}) {
  const calls = { capacity: [], progress: [] };
  const terminal = {};
  const context = vm.createContext({
    console: quiet, path, srcMainDir: __dirname,
    claudeStreamCutFromRecord,
    terminals: new Map([['T', terminal]]),
    getTerminalLifecycleGeneration: () => 'G1',
    getPersistedAiSessionBindingForShutdown: () => ({ claude_session_id: sessionBinding }),
    aiStoppingTabs: new Set(),
    claudeStreamCutOwners: new Map(),
    getClaudeStreamCutRuntime: () => ({
      capacity: async (owner, event) => { calls.capacity.push({ owner, event }); return {}; },
      progress: (owner, event) => { calls.progress.push({ owner, event }); },
    }),
  });
  vm.runInContext(decl('observeClaudeStreamCutRecord'), context);
  const observe = (record, offset = 100) => context.observeClaudeStreamCutRecord(
    { tabId: 'T', toolType: 'claude', sessionId: 'be82a19d-4a26-4263-b32a-e91477e1cd17',
      recordByteOffset: offset, message: record }, record);
  return { observe, calls, context };
}

test('a stream cut arms the retry with the record as its identity', () => {
  const h = observer();
  h.observe(CUT_RECORD, 48691710);
  assert.equal(h.calls.capacity.length, 1);
  assert.equal(h.calls.capacity[0].event.type, 'capacity');
  assert.equal(h.calls.capacity[0].event.errorId, '15ce6c4b-362e-4fda-941e-d40dc4bad53e');
  assert.equal(h.calls.capacity[0].event.at, 48691710, 'byte offset orders events in one file');
  assert.equal(h.calls.capacity[0].owner.generation, 'G1');
});

test('an ordinary answer only replenishes an existing budget', () => {
  const h = observer();
  // Nothing armed yet: a plain answer must not create tracking state.
  h.observe(ANSWER_RECORD, 10);
  assert.equal(h.calls.progress.length, 0);
  assert.equal(h.calls.capacity.length, 0);
  // After a cut, later real output is progress.
  h.observe(CUT_RECORD, 20);
  h.observe(ANSWER_RECORD, 30);
  assert.equal(h.calls.progress.length, 1);
  assert.equal(h.calls.progress[0].event.type, 'progress');
});

test('the observer ignores a tab with no terminal', () => {
  const h = observer();
  h.context.terminals = new Map();
  h.observe(CUT_RECORD);
  assert.equal(h.calls.capacity.length, 0);
});

test('policy reuse: progress replenishes the budget, exhaustion is reported once', () => {
  // This is the Codex policy, unchanged — the point of the test is that
  // Claude gets exactly these semantics rather than a second implementation.
  const settings = { codexCapacityRetryEnabled: true, codexCapacityRetryLimit: 1,
    codexCapacityRetryDelaysMs: [] };
  let state = null;
  const cut = (id, at) => {
    const result = reduceCodexCapacityRetry(state, { type: 'capacity', scopeKey: 'S', errorId: id, at }, settings);
    state = result.state;
    return result.effect;
  };
  assert.equal(cut('e1', 1)?.type, 'continue', 'first cut continues');
  assert.equal(cut('e2', 2)?.type, 'exhausted', 'budget spent');
  assert.equal(cut('e3', 3), null, 'exhaustion is announced once, not per error');

  state = reduceCodexCapacityRetry(state,
    { type: 'progress', scopeKey: 'S', at: 4, eventId: 'p1' }, settings).state;
  assert.equal(cut('e4', 5)?.type, 'continue', 'real work replenishes the budget');
});

test('policy reuse: the same error never continues twice', () => {
  const settings = { codexCapacityRetryEnabled: true, codexCapacityRetryLimit: 3,
    codexCapacityRetryDelaysMs: [] };
  let state = reduceCodexCapacityRetry(null,
    { type: 'capacity', scopeKey: 'S', errorId: 'same', at: 1 }, settings).state;
  const again = reduceCodexCapacityRetry(state,
    { type: 'capacity', scopeKey: 'S', errorId: 'same', at: 2 }, settings);
  assert.equal(again.effect, null, 'a re-delivered record is not a second cut');
});

test('wired: the observer is called for every live Claude record', () => {
  const body = mainSource.slice(mainSource.indexOf('function observeClaudeBackgroundRawRecord('));
  assert.match(body.slice(0, 600), /observeClaudeStreamCutRecord\(detail, record\)/);
});

test('wired: the retry reuses the Codex policy runtime and its settings', () => {
  const body = mainSource.slice(
    mainSource.indexOf('function getClaudeStreamCutRuntime('),
    mainSource.indexOf('function observeClaudeStreamCutRecord('));
  assert.match(body, /createCodexCapacityRetryRuntime\(/, 'one shared policy, not a second one');
  assert.match(body, /getSettings: \(\) => web\(\)\.getOrchestrationSettings\(\)/,
    'the same user settings as Codex capacity');
  assert.match(body, /claude-stream-cut-retry-state:/, 'its own durable state key');
  // Ownership guards: the retry dies with the terminal, the launch or the session.
  assert.match(body, /terminals\.get\(owner\.tabId\) === owner\.terminal/);
  assert.match(body, /getTerminalLifecycleGeneration\(owner\.tabId\) === owner\.generation/);
  assert.match(body, /claude_session_id === owner\.sessionId/);
  assert.match(body, /!aiStoppingTabs\.has\(owner\.tabId\)/, 'a Stop in flight withdraws it');
  assert.match(body, /cancelSend:/, 'a superseded retry is cancelled, never replayed');
});

test('wired: the continuation is an ordinary guarded project Send', () => {
  const body = webSource.slice(
    webSource.indexOf('async function sendClaudeStreamCutContinuation('),
    webSource.indexOf('async function prepareQueuedBuildContinueInput('));
  assert.match(body, /runAgentSendScenario\(\{/, 'the shared send scenario owns delivery');
  assert.match(body, /provider: 'claude'/);
  assert.match(body, /queue: true/, 'it waits in the ordinary FIFO');
  assert.match(body, /requireLive: true/, 'never starts a stopped tab');
  assert.match(body, /expectedTarget: \{ toolType: 'claude', sessionId, lifecycleGeneration: generation \}/,
    'bound to the exact conversation and launch');
  // Checked twice: at entry and again immediately before the payload.
  assert.equal((body.match(/await isCurrent\(\)/g) || []).length, 2);
  assert.match(body, /claude_stream_cut_cancelled/);
  assert.ok(body.indexOf('prepareSend') < body.indexOf('claude_stream_cut_cancelled', body.indexOf('prepareSend')),
    'the pre-payload recheck refuses rather than sends');
});
