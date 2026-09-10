'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}

function harness() {
  const tabId = 'claude-tab';
  const terminalToken = {};
  const launch = { generation: 'launch-1', launchMode: 'resume', sessionIdHint: 'source-A', pid: 123 };
  const command = { runSeq: 7 };
  const lifecycle = { generation: 'terminal-1:7' };
  const context = vm.createContext({
    console: { log() {} },
    claudeLaunchGenerationByTab: new Map([[tabId, launch]]),
    terminals: new Map([[tabId, terminalToken]]),
    terminalCommandState: new Map([[tabId, command]]),
    bridgePidCache: new Map([[123, tabId]]),
    bridgeKnownSessions: new Map([[tabId, 'source-A']]),
    getTerminalLifecycleGeneration: () => lifecycle.generation,
  });
  vm.runInContext(declaration('captureClaudeFirstAcceptedBridge')
    + '\n' + declaration('pinClaudeFirstAcceptedBridge'), context);
  return { tabId, terminalToken, launch, command, lifecycle, context,
    capture: () => context.captureClaudeFirstAcceptedBridge(tabId, 123, true),
    pin: (sessionId, scope) => context.pinClaudeFirstAcceptedBridge(tabId, sessionId, scope),
  };
}

test('accepted Resume pins one exact first bridge without changing live session or lifecycle', () => {
  const h = harness();
  const scope = h.capture();
  assert.equal(h.pin('writer-B', scope), true);
  const proof = h.launch.firstAcceptedBridge;
  assert.deepEqual(Object.keys(proof).sort(), [
    'generation', 'lifecycleGeneration', 'pid', 'runSeq', 'sessionId', 'terminalToken',
  ]);
  assert.equal(proof.sessionId, 'writer-B');
  assert.equal(proof.pid, 123);
  assert.equal(proof.terminalToken, h.terminalToken);
  assert.equal(proof.runSeq, 7);
  assert.equal(proof.lifecycleGeneration, 'terminal-1:7');
  assert.equal(proof.generation, 'launch-1');
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(h.context.bridgeKnownSessions.get(h.tabId), 'source-A');
  assert.equal(h.launch.sessionIdHint, 'source-A');
  assert.equal(h.command.runSeq, 7);
});

test('same-session first bridge is pinned before the ordinary heartbeat early return', () => {
  const h = harness();
  assert.equal(h.pin('source-A', h.capture()), true);
  assert.equal(h.launch.firstAcceptedBridge.sessionId, 'source-A');
});

test('native Resume later in the same PID cannot replace the first accepted writer', () => {
  const h = harness();
  const first = h.capture();
  h.pin('writer-B', first);
  const proof = h.launch.firstAcceptedBridge;
  h.context.bridgeKnownSessions.set(h.tabId, 'unrelated-C');
  const later = h.context.captureClaudeFirstAcceptedBridge(h.tabId, 123, false);
  assert.equal(later, null);
  assert.equal(h.pin('unrelated-C', later), false);
  assert.equal(h.pin('unrelated-C', first), false);
  assert.equal(h.launch.firstAcceptedBridge, proof);
  assert.equal(proof.sessionId, 'writer-B');
});

test('a later same-PID observer overtaking async first-bridge persistence cannot gain the pin', () => {
  const h = harness();
  const first = h.capture();
  const later = h.context.captureClaudeFirstAcceptedBridge(h.tabId, 123, false);
  h.context.bridgeKnownSessions.set(h.tabId, 'unrelated-C');
  assert.equal(h.pin('unrelated-C', later), false);
  assert.equal(h.pin('writer-B', first), false, 'the first observation is no longer current');
  assert.equal(h.launch.firstAcceptedBridge, undefined);
});

test('a same-writer heartbeat during first-bridge IO does not invent a different writer', () => {
  const h = harness();
  const first = h.capture();
  h.context.bridgeKnownSessions.set(h.tabId, 'writer-B');
  assert.equal(h.pin('writer-B', first), true);
  assert.equal(h.launch.firstAcceptedBridge.sessionId, 'writer-B');
});

test('capture requires the first routed process observation of an accepted Resume', () => {
  for (const change of [
    h => { h.launch.launchMode = 'fresh'; },
    h => { h.launch.launchMode = 'unknown'; },
    h => { h.launch.sessionIdHint = null; },
    h => { h.launch.generation = null; },
    h => { h.launch.pid = 124; },
    h => { h.command.runSeq = 0; },
    h => { h.lifecycle.generation = null; },
    h => { h.context.terminals.delete(h.tabId); },
    h => { h.context.bridgePidCache.set(123, 'other-tab'); },
  ]) {
    const h = harness();
    change(h);
    assert.equal(h.capture(), null);
    assert.equal(h.launch.firstAcceptedBridge, undefined);
  }
  const h = harness();
  assert.equal(h.context.captureClaudeFirstAcceptedBridge(h.tabId, 123, false), null);
});

test('all causal boundaries are rechecked after the bridge await', () => {
  for (const change of [
    h => { h.context.claudeLaunchGenerationByTab.set(h.tabId, { ...h.launch }); },
    h => { h.launch.generation = 'launch-2'; },
    h => { h.launch.pid = 124; },
    h => { h.context.terminals.set(h.tabId, {}); },
    h => { h.command.runSeq += 1; },
    h => { h.lifecycle.generation = 'terminal-2:7'; },
    h => { h.context.bridgePidCache.delete(123); },
    h => { h.context.bridgeKnownSessions.set(h.tabId, 'unrelated-C'); },
  ]) {
    const h = harness();
    const scope = h.capture();
    change(h);
    assert.equal(h.pin('writer-B', scope), false);
    assert.equal(h.launch.firstAcceptedBridge, undefined);
  }
});

test('bridge wiring captures before CwdGuard and commits after quota IO, before session/heartbeat commit', () => {
  const bridge = declaration('startSessionBridge');
  const ensureAt = bridge.indexOf('ensureClaudeLaunchGeneration(tabId, data.ppid');
  const captureAt = bridge.indexOf('captureClaudeFirstAcceptedBridge(tabId, data.ppid, isFreshProcess)');
  const cwdAt = bridge.indexOf('if (data.cwd && tabCwd && data.cwd !== tabCwd)');
  const quotaAt = bridge.indexOf("await require(path.join(srcMainDir, 'ipc', 'claude-usage')).recordStatuslineUsage(data)");
  const pinAt = bridge.indexOf('pinClaudeFirstAcceptedBridge(tabId, data.session_id, firstAcceptedBridgeScope)');
  const heartbeatAt = bridge.indexOf('if (oldSessionId === data.session_id)');
  const liveCommitAt = bridge.indexOf('bridgeKnownSessions.set(tabId, data.session_id)');
  assert.ok(ensureAt >= 0 && ensureAt < captureAt);
  assert.ok(captureAt < cwdAt && cwdAt < quotaAt && quotaAt < pinAt);
  assert.ok(pinAt < heartbeatAt && heartbeatAt < liveCommitAt);
  assert.match(bridge.slice(cwdAt, quotaAt), /await resolveDirectoryRelation\(data\.cwd, tabCwd\)/);
  assert.match(bridge.slice(cwdAt, quotaAt), /if \(!relation\.related\)[\s\S]*?return;/,
    'an unrelated CWD must return without issuing a first-writer pin');
});
