// Run After must not stay latched forever on a FAILED Claude startup setting.
//
// Production 2026-10-31: Run After was armed with a 48-minute first delay on
// four Claude tabs. The timer expired at 16:10 and each owner validated its
// cold start. Only c41a18522055 got `claude-startup-defaults-ready` and fired;
// d1718b66, 52fbe588 and 9b9b7a35 never did — their `/model` startup step
// never completed, so the queue treated them as "not ready" indefinitely.
// The user saw: "the timer finished, and Run After never activated".
//
// A PENDING transaction still holds the queue (settings must land before the
// first prompt). A FAILED one is terminal: reported, not enforced — the same
// decision the Send guard now follows. Live presence still decides readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./usePromptQueueRunner.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('usePromptQueueRunner.ts', source, ts.ScriptTarget.Latest, true);
const fn = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name + ' must exist');
  return ts.transpileModule(node.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
};

function readiness({ gateStatus, latched = false, presence }) {
  const ctx = vm.createContext({
    console: { warn() {}, log() {} },
    claudeQueueStartupPending: new Set(latched ? ['T'] : []),
    getPromptQueueAgent: () => 'claude',
    getClaudeStartupDefaultsGateSnapshot: () => (gateStatus ? { status: gateStatus } : null),
    findProjectIdForTab: () => 'P',
    getHistoryAgentRuntime: () => ({ getPresence: async () => presence }),
  });
  vm.runInContext(fn('readQueueOwnerReadiness'), ctx);
  return ctx.readQueueOwnerReadiness('T');
}

const LIVE = { status: 'active', inputReady: true, isBusy: false };

test('a failed startup setting no longer blocks a ready owner', async () => {
  const result = await readiness({ gateStatus: 'failed', presence: LIVE });
  assert.equal(result.ready, true, 'the setting is not applied; the tab still takes the queued prompt');
  assert.equal(result.reason, 'input-ready');
});

test('a pending startup transaction still holds the queue', async () => {
  for (const [label, options] of [
    ['gate pending', { gateStatus: 'pending', presence: LIVE }],
    ['latched by the tui-ready edge', { gateStatus: null, latched: true, presence: LIVE }],
  ]) {
    const result = await readiness(options);
    assert.equal(result.ready, false, label);
    assert.match(result.reason, /^claude-startup-defaults-/, label);
  }
});

test('a failed setting does not invent readiness: live presence still decides', async () => {
  for (const [label, presence] of [
    ['busy', { status: 'busy', inputReady: true, isBusy: true }],
    ['no composer', { status: 'active', inputReady: false, isBusy: false }],
    ['stopped', { status: 'inactive', inputReady: false, isBusy: false }],
  ]) {
    const result = await readiness({ gateStatus: 'failed', presence });
    assert.equal(result.ready, false, label);
    assert.equal(result.reason, 'runtime-not-ready', label);
  }
});

test('the gate event releases the latch and wakes the owner on a failed outcome', () => {
  const handler = source.slice(source.indexOf('const claudeStartupGateHandler'),
    source.indexOf("ipcRenderer.on('claude:busy-state', claudeHandler);"));
  assert.ok(handler.includes("if (detail.status === 'pending') {"),
    'only pending latches the owner');
  assert.match(handler, /detail\.status === 'failed'\) \{[\s\S]*?claudeQueueStartupPending\.delete\(detail\.tabId\);[\s\S]*?signalQueueOwnerReadiness\(detail\.tabId, 'claude-startup-defaults-failed'\);/,
    'a failed outcome releases the latch and wakes the waiting owner');
});
