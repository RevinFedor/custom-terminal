'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { createTerminalIncidentReporter, codexStartupDiagnosticGroup,
  codexStartupWaitDiagnosticGroup } = require('./terminal-incident-reporting');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)?.getText(ast);
const registration = ast.statements.find(n => ts.isExpressionStatement(n)
  && n.getText(ast).startsWith("ipcMain.handle('agent:wait-start-ready'"))?.getText(ast);
assert.ok(fn('maybeSurfaceCodexStartupNoStateTimeout') && registration);

async function run({ expected = { launchId: 'L1', lifecycleGeneration: 'G1' },
  observed = { launchId: 'L1', lifecycleGeneration: 'G1' }, watchdog = true } = {}) {
  const captures = [], visible = [], all = [], handlers = new Map();
  const report = createTerminalIncidentReporter({ capture: payload => {
    captures.push(payload); return Promise.resolve({ artifactPath: '/private/' + payload.incidentReason });
  }, notify: result => { all.push(result); if (!result.silent) visible.push(result); } });
  const error = Object.assign(Error('agent did not become ready'), { code: 'agent_ready_timeout', status: observed });
  const ctx = vm.createContext({ reportTerminalIncident: report, codexStartupDiagnosticGroup, codexStartupWaitDiagnosticGroup,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    waitForMainAgentStartReady: async () => { throw error; }, getTerminalLifecycleGeneration: () => 'G1',
    codexRuntimePolicies: null, hasCodexPolicyInitializedComposer: () => false,
    codexTuiReadyLastNotReady: new Map(), codexLastRunCommandPayload: new Map(), codexStartupNoStateTimeoutTabs: new Set(),
    clearCodexLaunchAcceptancePending() {}, clearCodexStartupNoStateTimeoutTimer() {}, _webBroadcast() {},
    getCodexRuntimeSessionId: () => 'S', getCodexPublicWriterFields: () => ({}), emitCodexTuiNotReadyState() {},
    console: { warn() {} } });
  vm.runInContext(fn('maybeSurfaceCodexStartupNoStateTimeout') + '\n' + registration, ctx);
  if (watchdog) ctx.maybeSurfaceCodexStartupNoStateTimeout('T', { launchId: 'L1', reason: 'startup-timeout:no-ready-signal',
    firstSeenAgeMs: 60000, command: 'codex-c', sessionId: 'S' });
  const response = await handlers.get('agent:wait-start-ready')(null, { tabId: 'T', toolType: 'codex', expectedOwner: expected });
  await new Promise(resolve => setImmediate(resolve));
  return { captures, visible, all, response };
}

test('two actual Main reporters keep both artifacts but notify once for the exact same launch', async () => {
  const value = await run();
  assert.equal(value.response.error, 'agent_ready_timeout');
  assert.equal(value.captures.length, 2); assert.equal(value.all.length, 2); assert.equal(value.visible.length, 1);
  assert.notEqual(value.captures[0].incidentReason, value.captures[1].incidentReason);
  assert.equal(value.all.filter(x => x.silent === true).length, 1);
});

test('a different or unproven launch is not coalesced into the old notification', async () => {
  for (const observed of [{ launchId: 'L2', lifecycleGeneration: 'G1' },
    { launchId: 'L1', lifecycleGeneration: 'G2' }, { launchId: 'L1' }]) {
    const value = await run({ observed }); assert.equal(value.captures.length, 2); assert.equal(value.visible.length, 2);
  }
});

test('failed capture remains visible and does not suppress a later successful artifact', async () => {
  const notified = []; let count = 0;
  const report = createTerminalIncidentReporter({ capture: () => ++count === 1 ? Promise.reject(Error('disk'))
    : Promise.resolve({ artifactPath: '/private/second' }), notify: value => { if (!value.silent) notified.push(value); } });
  const group = codexStartupDiagnosticGroup('T', 'L1', 'G1');
  await report('first', { notificationGroup: group }); await report('second', { notificationGroup: group });
  assert.equal(notified.length, 2); assert.equal(notified[0].success, false); assert.equal(notified[1].success, true);
});

test('an unavailable notification surface cannot suppress the later successful report', async () => {
  let attached = false; const delivered = [];
  const report = createTerminalIncidentReporter({ capture: payload => Promise.resolve({ artifactPath: payload.reason }),
    notify: value => { if (!attached || value.silent) return false; delivered.push(value); return true; } });
  const group = codexStartupDiagnosticGroup('T', 'L1', 'G1');
  await report('first', { notificationGroup: group, reason: 'first' });
  attached = true; await report('second', { notificationGroup: group, reason: 'second' });
  assert.equal(delivered.length, 1); assert.equal(delivered[0].reason, 'second');
});
