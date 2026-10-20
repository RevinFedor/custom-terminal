'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const processPresence = require('./ai-process-liveness');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const actual = name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};

function harness(action = null, at = 'process') {
  let generation = 'G1', inputRevision = 1, control = null, fired = false;
  const proof = { ownerId: 'S', serviceTier: 'priority', source: 'old-proof', terminalLifecycleGeneration: 'G1' };
  const command = { isRunning: true, runSeq: 1 };
  const ctx = vm.createContext({ console: { log() {}, warn() {} },
    terminals: new Map([['T', {}]]), terminalCommandState: new Map([['T', command]]),
    terminalProjectIds: new Map([['T', 'P']]), terminalProjects: new Map([['T', '/fixture']]),
    claudeLaunchGenerationByTab: new Map(), codexLastRunCommandPayload: new Map(), aiStoppingTabs: new Map(),
    getTerminalLifecycleGeneration: () => generation, getTerminalInputRevision: () => inputRevision,
    getTerminalStopRevision: () => 0,
    observeCurrentCodexStartupGoalFrame() {}, codexLateMcpProofPending: new Set(),
    codexTuiReadyTabs: new Set(['T']), codexTuiReadyMeta: new Map([['T', { serviceTierProof: proof }]]),
    codexManualActionRequired: new Map(), codexTuiReadyLastNotReady: new Map(), codexLifecycleWarnings: new Map(),
    codexRuntimePolicies: null, getCodexMcpStartupStatus: () => null,
    getCodexLiveInputControl: () => control,
    isCodexOperationalInputReady: () => command.isRunning && !control,
    projectCodexPolicyRuntime: value => value,
    inspectCodexStartupBlockersText: () => [], resolveCodexVerifiedCurrentFrameSettings: () => null,
    reconcileCodexMcpStartupWatchdogFromCurrentScreen() {},
    probeCodexReadyFromVisibleBuffer: async () => ({ ready: false }),
    probeCodexStartupFromRawBuffer: () => ({ ready: false }),
    getCodexStartupNoStateTimeout: () => null,
    resolveProcessPresence: processPresence.resolveProcessPresence,
  });
  const change = () => {
    if (fired) return; fired = true;
    if (action === 'stop') { command.isRunning = false; ctx.codexTuiReadyTabs.clear(); ctx.codexTuiReadyMeta.clear(); }
    if (action === 'replace') { ctx.terminals.set('T', {}); generation = 'G2'; command.runSeq++;
      ctx.codexTuiReadyTabs.clear(); ctx.codexTuiReadyMeta.clear(); }
    if (action === 'input') inputRevision++;
    if (action === 'control') control = { type: 'model-picker' };
  };
  ctx.inspectCurrentCodexMcpStartupScreen = async () => { if (at === 'screen') change(); return { success: true, inspected: { blockers: [] } }; };
  ctx.inspectCurrentCodexMcpStartupScreenWithTierIdentity = async (...args) => {
    const screen = await ctx.inspectCurrentCodexMcpStartupScreen(...args);
    const tier = ctx.codexTuiReadyMeta.get('T')?.serviceTierProof || null;
    return { ...screen, serviceTierResultIdentity: tier ? {
      success: true, ownerId: tier.ownerId, terminalToken: ctx.terminals.get('T'),
      terminalLifecycleGeneration: generation, terminalRunSeq: command.runSeq,
      generationMode: 'terminal-run', generationId: generation, launchId: null,
    } : null };
  };
  ctx.inspectAiDescendantProcessesByTabCached = async () => {
    if (at === 'process') change();
    return action === 'empty' ? processPresence.knownProcessLookup([])
      : action === 'stable' ? processPresence.knownProcessLookup([{ pid: 10 }])
      : processPresence.unknownProcessLookup(new Error('lookup unavailable'));
  };
  for (const name of ['captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
    'isCodexTuiEffectivelyReady', 'getCodexTuiReadyState']) vm.runInContext(actual(name), ctx);
  return { ctx, proof, read: () => ctx.getCodexTuiReadyState('T') };
}

test('unchanged established TUI keeps readiness on a genuinely unknown process lookup', async () => {
  const h = harness(); const result = await h.read();
  assert.equal(result.inputReady, true); assert.equal(result.processLookupUnknown, true);
  assert.equal(result.readyMeta.serviceTierProof.ownerId, 'S');
});

test('successful absent lookup overrides old turn readiness even before a Stop event arrives', async () => {
  const h = harness('empty'); const result = await h.read();
  assert.equal(result.processReady, false); assert.equal(result.processLookupUnknown, false);
  assert.equal(result.inputReady, false); assert.equal(result.readyMeta, null);
});

test('stable found process keeps real ready proof', async () => {
  const result = await harness('stable').read();
  assert.equal(result.inputReady, true); assert.equal(result.processLookupUnknown, false);
  assert.equal(result.readyMeta.serviceTierProof.ownerId, 'S');
});

for (const edge of ['screen', 'process']) for (const action of ['stop', 'replace', 'input']) {
  test('actual readiness read refuses stale owner/proof after ' + action + ' during ' + edge, async () => {
    const h = harness(action, edge); const result = await h.read();
    assert.equal(result.inputReady, false);
    assert.equal(result.readyMeta, null);
    assert.equal(result.code, 'codex_readiness_observation_superseded');
  });
}

test('same owner with a new input control recomputes readiness after lookup', async () => {
  const h = harness('control'); const result = await h.read();
  assert.equal(result.textReady, false); assert.equal(result.inputReady, false);
});

test('actual ControlBar callback ignores superseded read and late proof after main clear; stable reply still applies', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../renderer/components/Workspace/ClaudeControlBar.tsx'), 'utf8');
  const tree = ts.createSourceFile('control.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let refresh, proofEffect;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'refreshCodexFastMode') refresh = node.initializer.arguments[0].getText(tree);
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('const supersedeFastRead')) proofEffect = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(refresh); assert.ok(proofEffect);
  const compile = code => ts.transpileModule('(()=>{const callback=' + code + ';return callback;})()', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let resolve; const writes = [], listeners = new Map();
  const env = vm.createContext({ isCodex: true, isCommandRunning: true, tabId: 'T',
    codexFastModeRequestRef: { current: 0 }, console: { log() {}, warn() {} },
    ipcRenderer: { invoke: () => new Promise(done => { resolve = done; }),
      on: (event, fn) => listeners.set(event, fn), removeListener: event => listeners.delete(event) },
    useWorkspaceStore: { getState: () => ({ updateCodexLiveServiceTier: (_tab, value) => writes.push(value) }) },
  });
  const invoke = vm.runInContext(compile(refresh), env);
  const effect = vm.runInNewContext(compile(proofEffect), env); const cleanup = effect();
  let pending = invoke('stable'); resolve({ success: true, inputReady: true,
    readyMeta: { serviceTierProof: { ownerId: 'S', serviceTier: 'priority' } } }); await pending;
  assert.equal(writes.length, 1);
  pending = invoke('stop'); listeners.get('codex:service-tier-proof')({}, { tabId: 'T', cleared: true });
  resolve({ success: true, inputReady: true, readyMeta: { serviceTierProof: { ownerId: 'S', serviceTier: 'priority' } } });
  await pending; assert.equal(writes.length, 1);
  pending = invoke('superseded'); resolve({ success: false, inputReady: false, code: 'codex_readiness_observation_superseded' });
  await pending; assert.equal(writes.length, 1);
  pending = invoke('inactive'); env.isCommandRunning = false; await invoke('inactive-new');
  resolve({ success: true, inputReady: true, readyMeta: { serviceTierProof: { ownerId: 'S', serviceTier: 'priority' } } });
  await pending; assert.equal(writes.length, 1);
  cleanup(); assert.equal(listeners.size, 0);
});
