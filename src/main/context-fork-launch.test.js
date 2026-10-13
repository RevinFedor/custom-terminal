'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { prepareContextForkLaunch } = require('./context-fork-launch');
const { createAgentLaunchPreparationRegistry } = require('./agent-launch-preparation');
const { runKeyedExclusive } = require('./codex-writer-ownership');
const { classifyCodexLaunchPreparationResult } = require('./codex-runtime-contract');

function fixture(provider = 'codex', compact = true) {
  const events = [], terminal = {}, source = { sessionId: 'S', cwd: '/project', terminal };
  let cancelled = false;
  const payload = { tabId: 'T', command: provider + '-f', [provider === 'codex' ? 'sessionId' : 'forkSessionId']: 'S',
    launchFence: { stopRevision: 0, terminalInstanceId: 'T0' }, contextFork: { sourceTabId: 'P', sourceSessionId: 'S', fromLatestCompact: compact } };
  const deps = { payload, toolType: provider, assertCurrent() { if (cancelled) throw Error('agent_launch_cancelled'); },
    captureSource: () => ({ ...source }),
    readSource: async () => { events.push('proof'); return { allowed: true }; },
    materializeCompact: async () => { events.push('copy'); return { success: true, newSessionId: 'C' }; },
    commitReadBinding: id => events.push('bind:' + id), onPhase: phase => events.push('phase:' + phase) };
  return { deps, events, source, stop: () => { cancelled = true; } };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: compact prepares one child and keeps the launch fence; full keeps native fork`, async () => {
    const f = fixture(provider), p = await prepareContextForkLaunch(f.deps);
    assert.equal(p.command, provider + '-c'); assert.equal(p.sessionId, 'C');
    assert.equal(p.launchFence, f.deps.payload.launchFence); assert.equal(p.contextForkBinding.committed, true);
    assert.deepEqual(f.events, ['phase:forking-history', 'proof', 'copy', 'bind:C', 'phase:repairing-history']);
    const full = fixture(provider, false);
    assert.equal(await prepareContextForkLaunch(full.deps), full.deps.payload);
    assert.deepEqual(full.events, ['phase:forking-history', 'proof']);
  });
  for (const stage of ['readSource', 'materializeCompact']) {
    test(`${provider}: Stop during ${stage} forbids binding/launch`, async () => {
      const f = fixture(provider), original = f.deps[stage];
      f.deps[stage] = async (...args) => { const result = await original(...args); f.stop(); return result; };
      await assert.rejects(prepareContextForkLaunch(f.deps), /agent_launch_cancelled/);
      assert.equal(f.events.some(e => e.startsWith('bind:')), false);
    });
  }
  test(`${provider}: replacement/no-compact refuse without binding or full-fork fallback`, async () => {
    const f = fixture(provider);
    f.deps.readSource = async () => { f.source.sessionId = 'foreign'; return { allowed: true }; };
    await assert.rejects(prepareContextForkLaunch(f.deps), /source_changed/);
    assert.equal(f.events.includes('copy'), false);
    const g = fixture(provider); g.deps.materializeCompact = async () => ({ success: false, reason: 'no-compact' });
    await assert.rejects(prepareContextForkLaunch(g.deps), /no-compact/);
    assert.equal(g.events.some(e => e.startsWith('bind:')), false);
  });
}

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['captureAgentLaunchFence', 'withAgentLaunchFence', 'assertAgentSendLaunchCurrent', 'returnAgentSendLaunchRefusal',
  'runCodexCommandAfterLifecycleAdmission', 'runClaudeCommandSerialized'];
const code = names.map(name => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(tree);
}).join('\n');

for (const provider of ['claude', 'codex']) {
  function mainFixture() {
    const f = fixture(provider), terminal = {}, writes = [];
    let revision = 0;
    const ctx = vm.createContext({ console, crypto: require('node:crypto'),
      terminals: new Map([['T', terminal]]), terminalLifecycleEpochs: new WeakMap([[terminal, 'T0']]),
      getTerminalStopRevision: () => revision, agentLaunchPreparations: createAgentLaunchPreparationRegistry(),
      aiLifecycleActionInflight: new Map(), claudeResumePreparationInflight: new Map(), runKeyedExclusive,
      admitAiLifecycleLaunch: async () => ({ allowed: true }), validateClaudeSavedHistoryLaunch() {},
      classifyCodexLaunchPreparationResult,
      prepareTabContextForkLaunch: async (payload, toolType, assertCurrent) => prepareContextForkLaunch({ ...f.deps, payload, toolType, assertCurrent }),
      prepareClaudeJsonlBeforeResume: async () => ({ success: true }), terminalProjects: new Map([['T', '/project']]),
      runCodexCommandFromPayloadInner: async (_sender, payload, current) => { current(); writes.push(payload); return { success: true, accepted: null, acceptancePending: true }; },
      runClaudeCommandFromPayload: async (_sender, payload, options) => { options.assertSendLaunchCurrent(); writes.push(payload); return { success: true, accepted: true }; },
    });
    vm.runInContext(code, ctx);
    const run = () => provider === 'codex' ? ctx.runCodexCommandAfterLifecycleAdmission({}, f.deps.payload)
      : ctx.runClaudeCommandSerialized({}, f.deps.payload);
    return { ...f, ctx, run, writes, stop: () => { revision++; } };
  }
  test(`${provider}: actual Main wrapper includes compact read binding in accepted result`, async () => {
    const f = mainFixture(), result = await f.run();
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].sessionId, 'C');
    assert.equal(result.contextForkBinding.sessionId, 'C');
  });
  test(`${provider}: actual Stop fence revokes pre-shell-ready and mid-copy launches`, async () => {
    const first = mainFixture(); first.stop();
    if (provider === 'claude') assert.equal((await first.run()).code, 'agent_launch_cancelled');
    else await assert.rejects(first.run(), /agent_launch_cancelled/);
    assert.equal(first.writes.length, 0);
    const f = mainFixture(); f.deps.materializeCompact = async () => { f.stop(); return { success: true, newSessionId: 'C' }; };
    if (provider === 'claude') assert.equal((await f.run()).code, 'agent_launch_cancelled');
    else await assert.rejects(f.run(), /agent_launch_cancelled/);
    assert.equal(f.writes.length, 0);
  });
  test(`${provider}: later rejection keeps the already committed child readable`, async () => {
    const f = mainFixture(), reject = async () => { throw Error('shell_not_idle'); };
    f.ctx.runCodexCommandFromPayloadInner = reject; f.ctx.runClaudeCommandFromPayload = reject;
    const result = await f.run();
    assert.equal(result.success, false); assert.equal(result.contextForkBinding.sessionId, 'C');
    assert.equal(result.contextForkBinding.committed, true); assert.equal(f.writes.length, 0);
    assert.equal(result.submitted, undefined);
  });
}
