'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const recovery = require('./codex-reserve-recovery');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const quiet = { log() {}, warn() {} };

test('actual usage-dialog capture persists the last normal pair and a failed disk write cannot block usage handling', () => {
  for (const fail of [false, true]) {
    const states = new Map(), writes = [], term = {};
    const ctx = vm.createContext({ ...recovery, console: quiet, providerStates: states,
      captureCodexPolicyOwner: () => ({ live: true, terminal: term, sessionId: 'S' }),
      codexLastRunCommandPayload: new Map(), getCodexModelEffortIntentRecord: () => null,
      codexLiveSettingsObserver: { read: () => ({ model: 'gpt-6-astra', effort: 'max', sessionId: 'S' }) },
      setProviderState: (id, value) => states.set(id, value), broadcastProviderState() {},
      projectManager: { db: { updateTabProviderState: (_id, value) => { if (fail) throw Error('disk'); writes.push(value); } } },
    });
    vm.runInContext(fn('rememberCodexReserveReturnPreference').getText(ast), ctx);
    ctx.rememberCodexReserveReturnPreference('T');
    assert.equal(states.get('T').codexReserveReturnPreference.model, 'gpt-6-astra');
    assert.equal(writes.length, fail ? 0 : 1);
    ctx.rememberCodexReserveReturnPreference('T');
    assert.equal(writes.length, fail ? 0 : 1, 'repeated dialog frames do not rewrite preference');
  }
});

const runner = fn('runCodexCommandFromPayloadInner');
let boundary;
function find(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'withPtyWriteLock'
    && node.getText(ast).includes('returnChoiceCurrent')) boundary = node.arguments[1];
  ts.forEachChild(node, find);
}
find(runner); assert.ok(boundary, 'actual launch write boundary');
for (const scenario of ['current', 'account-changed', 'choice-changed']) {
  test('actual launch boundary after asynchronous shell proof: ' + scenario, async () => {
    const writes = [], term = {}, payload = { launchId: 'L', model: 'gpt-6-sol', effort: 'max' };
    const candidate = { ...payload };
    const choice = { model: 'gpt-6-sol', effort: 'max', revision: 3, actionSequence: 4, sessionId: 'S', source: 'user-choice' };
    const guards = new WeakMap();
    const ctx = vm.createContext({ ...recovery, console: quiet, Date, term, tabId: 'T', sessionId: 'S',
      launchId: 'L', launchRunSeq: 2, normalizedCommand: 'codex-c', termCwd: '/fixture',
      profile: null, developerInstructions: null, providerProxyBaseUrl: null, codexAuthProfileRoute: null,
      payload: {}, ownsMcpStartupRecoveryHandoff: false, startedAt: 0,
      effectiveModel: 'gpt-6-sol', effectiveEffort: 'max',
      sourceSettingsProof: { model: 'gpt-reserve', effort: 'max' },
      reserveReturn: { restore: true, choice, home: 'home', availability: {} },
      assertCurrent() {},
      // This suite owns Reserve model/effort, not the separately-tested Fast intent.
      ensureCodexFastLaunchIntent: () => ({ desiredFast: false, revision: 1 }),
      proveIdleShellForAgentLaunch: async () => ({ allowed: true }),
      readCodexReserveReturnChoice: () => scenario === 'choice-changed' ? { ...choice, actionSequence: 5 } : choice,
      getCodexReserveAvailabilityProbe: () => ({ current: () => scenario !== 'account-changed' }),
      codexLastRunCommandPayload: new Map([['T', payload]]),
      codexServiceTierLaunchCandidates: new Map([['T', candidate]]),
      codexReserveResumeGuards: guards, getTerminalLifecycleGeneration: () => 'G',
      shellQuote: value => JSON.stringify(value), tomlString: JSON.stringify,
      rebaseCodexLaunchObservationAtWrite() {}, disarmCodexProviderSemanticSource() {},
      writeAgentLaunchCommandToIdleShell: (_term, request) => writes.push(request.command),
    });
    vm.runInContext(fn('buildCodexCommand').getText(ast) + '\nvar boundary = ' + boundary.getText(ast), ctx);
    const result = await ctx.boundary();
    assert.equal(result.written, true); assert.equal(writes.length, 1);
    assert.match(writes[0], scenario === 'current' ? /--model "gpt-6-sol"/ : /--model "gpt-reserve"/);
    if (scenario !== 'current') {
      assert.equal(payload.model, 'gpt-reserve'); assert.equal(candidate.requestedModel, 'gpt-reserve');
    }
    assert.equal(guards.has(term), scenario !== 'choice-changed', 'new explicit selection cannot be suppressed by an old launch');
  });
}
