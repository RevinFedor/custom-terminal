'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shell = require('./ai-shell-launch');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const extract = (start, end) => {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset + start.length);
  assert.ok(offset >= 0 && limit > offset);
  return source.slice(offset, limit);
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function harness() {
  let revision = 0;
  const writes = [];
  const term = { pid: 123, write: data => writes.push(data) };
  const context = {
    historyMutationInput: require('./history-mutation-input').createHistoryMutationInputGate(),
    ...shell,
    console: { log() {}, warn() {} },
    terminals: new Map([['tab', term]]),
    terminalCommandState: new Map([['tab', { runSeq: 1, isRunning: false }]]),
    terminalInputLineBuffers: new Map(), terminalInputEscapeStates: new Map(),
    aiStoppingTabs: new Map(), hasClaimedAiLifecycle: () => false,
    // This fixture supplies an admitted shell; registry publication is a port,
    // while the real generation/input checks and final writer execute below.
    terminalShellReadiness: { snapshot: () => ({ ready: true }), markAgentLaunchWrite: () => true },
    reconcileShellDraftProofForLaunch: async () => ({ status: 'empty', reason: 'same-empty-prompt-frame' }),
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    invalidateAiProcessLookupCache() {},
    inspectAiDescendantProcessesByTab: async () => ({ status: 'absent', matches: [] }),
    getTerminalInputRevision: () => revision,
    getTerminalLifecycleGeneration: () => 'generation-1',
  };
  vm.createContext(context);
  vm.runInContext(extract('async function proveIdleShellForAgentLaunch(', 'function markClaudeShellLaunchStarted('), context);
  const type = text => {
    revision++;
    context.terminalInputLineBuffers.set('tab', text);
    term.write(text);
  };
  const prove = () => context.proveIdleShellForAgentLaunch('tab', 'claude', { expectedTerm: term, expectedRunSeq: 1 });
  const launch = admission => context.writeAgentLaunchCommandToIdleShell(term, {
    tabId: 'tab', toolType: 'claude', command: 'claude --resume S1', admission,
  });
  return { context, term, writes, type, prove, launch };
}

test('NAI-06: native draft typed during process lookup is preserved and no launch is admitted', async () => {
  const h = harness();
  const entered = deferred();
  const lookup = deferred();
  h.context.inspectAiDescendantProcessesByTab = async () => { entered.resolve(); return lookup.promise; };
  const pending = h.prove();
  await entered.promise;
  h.type('my new native draft');
  lookup.resolve({ status: 'absent', matches: [] });
  const admission = await pending;
  assert.equal(admission.allowed, false);
  assert.match(admission.reason, /input/);
  assert.equal(h.context.terminalInputLineBuffers.get('tab'), 'my new native draft');
  assert.deepEqual(h.writes, ['my new native draft']);
});

test('NAI-06: draft arriving after admission cannot be cleared by the final synchronous write', async () => {
  const h = harness();
  const admission = await h.prove();
  assert.equal(admission.allowed, true);
  h.type('late draft');
  assert.throws(() => h.launch(admission), /input.*changed/);
  assert.equal(h.context.terminalInputLineBuffers.get('tab'), 'late draft');
  assert.deepEqual(h.writes, ['late draft']);
});

test('unchanged idle shell launches once with its admitted input and run', async () => {
  const h = harness();
  h.launch(await h.prove());
  assert.deepEqual(h.writes, ['\x03claude --resume S1\r']);
});

test('admitted shell proof cannot launch into a replaced command generation', async () => {
  const h = harness();
  const admission = await h.prove();
  h.context.terminalCommandState.set('tab', { runSeq: 2, isRunning: true });
  assert.throws(() => h.launch(admission), /generation_changed/);
  assert.deepEqual(h.writes, []);
});

test('reconciling an old empty frame cannot delete input received while the mirror was flushing', async () => {
  const h = harness();
  const flushed = deferred();
  const began = deferred();
  h.context.terminalShellReadiness.promptFrameSnapshot = () => ({ id: 'shell-prompt' });
  h.context.flushHeadlessTerminalMirror = async () => { began.resolve(); await flushed.promise; };
  h.context.readHeadlessShellPromptFrame = () => ({ id: 'old-empty-frame' });
  h.context.classifyTerminalShellDraftProof = () => ({ status: 'empty', reason: 'same-empty-prompt-frame' });
  h.type('old tracked text');
  vm.runInContext(extract('async function reconcileShellDraftProofForLaunch(', 'async function proveIdleShellForAgentLaunch('), h.context);
  const pending = h.context.reconcileShellDraftProofForLaunch('tab', h.term);
  await began.promise;
  h.type('new user draft');
  flushed.resolve();
  const result = await pending;
  assert.notEqual(result.status, 'empty');
  assert.equal(h.context.terminalInputLineBuffers.get('tab'), 'new user draft');
});
