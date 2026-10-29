'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { waitForAgentReadyTransition } = require('./agent-ready-wait');
const file = require.resolve('./main');
const source = fs.readFileSync(process.env.CODEX_READY_MAIN_SOURCE || file, 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}
function readinessModule() {
  if (!process.env.CODEX_READY_MODULE_SOURCE) return require('./codex-tui-readiness');
  const filename = require.resolve('./codex-tui-readiness'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(require('node:path').dirname(filename));
  loaded._compile(fs.readFileSync(process.env.CODEX_READY_MODULE_SOURCE, 'utf8'), filename); return loaded.exports;
}
function mainAdapter() {
  const ready = readinessModule();
  const ctx = vm.createContext({ ...require('./codex-model-picker'), ...require('./codex-resume-goal-prompt'),
    ...require('./codex-usage-prompt'), ...require('./codex-update-prompt'), ...ready,
    getCodexModelIdentityCatalog: () => [], CODEX_SYNC_MARKER: '\x1b[?2026l' });
  const names = ['inspectCodexAuthRequiredPrompt', 'inspectCodexStartupBlockersText',
    'inspectCodexInputReadyText', 'inspectCodexInputReadyVisibleText'];
  return vm.runInContext(names.map(declaration).join('\n') + '\ninspectCodexInputReadyVisibleText', ctx);
}

test('actual Main visible-frame adapter wakes the existing Resume waiter on the saved Terra frame', async () => {
  const inspect = mainAdapter(), events = new EventEmitter(); let frame = ['› Ask Codex to do anything', '? for shortcuts'];
  const status = async () => ({ tabId: 'T', toolType: 'codex', status: 'active', launchId: 'L1', lifecycleGeneration: 'G1',
    inputReady: inspect('', 'test-main', { lines: frame.map(text => ({ text })) }).ready });
  const waiting = waitForAgentReadyTransition({ tabId: 'T', readStatus: status, eventBus: events,
    timeoutMs: 1000, expectedOwner: { launchId: 'L1', lifecycleGeneration: 'G1' } });
  await new Promise(resolve => setImmediate(resolve));
  frame = ['› Ask Codex to do anything', 'GPT-6.1 Terra max fast · Context 27% used ⚠ 1 warning · f2 to view'];
  events.emit('agent:readiness-changed-internal', null, { tabId: 'T', status: 'ready' });
  assert.equal((await waiting).inputReady, true);
  assert.equal(events.listenerCount('agent:readiness-changed-internal'), 0);
});

test('same Main adapter does not treat the startup draft or paused Goal as ready', () => {
  const inspect = mainAdapter(), frame = text => inspect('', 'test-main', { lines: text.split('\n').map(value => ({ text: value })) });
  assert.equal(frame('› Ask Codex to do anything\n? for shortcuts').ready, false);
  const goal = 'Resume paused goal?\nGoal: private fixture\n› 1. Resume goal Mark it active and continue when idle\n'
    + '  2. Leave paused Keep it paused; use /goal resume later\nenter select · esc back';
  assert.equal(frame(goal).ready, false);
});
