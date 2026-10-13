import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('./Terminal.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('terminal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found; function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(tree) === name) found = n; ts.forEachChild(n, visit); }
  visit(tree); assert.ok(found, name); return `const ${found.getText(tree)};`;
}
const code = ts.transpileModule(['invokePtyAgentLaunch', 'launchPendingAgentAction'].map(declaration).join('\n')
  + ';module.exports={invokePtyAgentLaunch,launchPendingAgentAction};', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const contextFork = { sourceTabId: 'source', sourceSessionId: 'S', fromLatestCompact: true };
  const tab = { id: 'target', name: 'Моя ветка', nameSetManually: true,
    pendingOperation: 'Создание форка…', pendingAction: { type: 'codex-fork', contextFork } };
  const tabs = new Map([['target', tab]]), calls = [], toasts = [], restores = [];
  const state = { openProjects: new Map([['p', { tabs }]]),
    setCodexSessionId: async (id, sid) => { calls.push(['adopt', id, sid]); tab.codexSessionId = sid; },
    restoreRejectedAiLaunchSnapshot: (...args) => restores.push(args),
    setTabPendingOperation: (_p, id, value) => { calls.push(['pending', id, value]); tab.pendingOperation = value; },
  };
  let reply = { success: true, accepted: true }, release;
  const gate = new Promise(r => release = r);
  const module = { exports: {} };
  vm.runInNewContext(code, { module, console: { warn() {} }, ptyAgentLaunchAttemptSeq: new Map(), pendingAgentActionLaunches: new Set(),
    useWorkspaceStore: { getState: () => state }, useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) },
    clearPendingResume() {}, clearTabPendingAction: () => { tab.pendingAction = undefined; },
    ipcRenderer: { invoke: async () => { calls.push(['invoke']); await gate; return reply; } },
  });
  return { ...module.exports, tab, tabs, calls, toasts, restores,
    payload: { tabId: 'target', command: 'codex-f', sessionId: 'S', contextFork },
    release: value => { reply = value; release(); }, binding: { committed: true, tabId: 'target', toolType: 'codex', sessionId: 'C', sourceSessionId: 'S' } };
}
test('one actual pending launcher adopts committed compact read identity, retains manual name, clears preparation', async () => {
  const f = fixture();
  const first = f.launchPendingAgentAction('target', 'codex-fork', 'codex:run-command', f.payload);
  await f.launchPendingAgentAction('target', 'codex-fork', 'codex:run-command', f.payload);
  assert.equal(f.calls.length, 1); assert.equal(f.tab.pendingOperation, 'Создание форка…');
  f.release({ success: true, accepted: true, contextForkBinding: f.binding }); await first;
  assert.equal(f.tab.codexSessionId, 'C'); assert.equal(f.tab.name, 'Моя ветка');
  assert.equal(f.tab.pendingAction, undefined); assert.equal(f.tab.pendingOperation, null);
  assert.equal(f.toasts.length, 0);
});
for (const replacement of ['closed', 'new-binding', 'new-operation']) test(`late compact reply does not adopt into ${replacement}`, async () => {
  const f = fixture(), work = f.invokePtyAgentLaunch('codex:run-command', f.payload);
  if (replacement === 'closed') f.tabs.clear();
  else if (replacement === 'new-binding') f.tab.codexSessionId = 'other';
  else f.tab.pendingAction = { contextFork: { ...f.payload.contextFork } };
  f.release({ success: true, accepted: true, contextForkBinding: f.binding }); await work;
  assert.equal(f.calls.some(call => call[0] === 'adopt'), false);
});
test('explicit Stop is not an error notification; a real failure has exact copyable origin', async () => {
  const stopped = fixture(), stopping = stopped.invokePtyAgentLaunch('codex:run-command', stopped.payload);
  stopped.release({ success: false, accepted: false, code: 'agent_launch_cancelled' }); await stopping;
  assert.equal(stopped.toasts.length, 0);
  const failed = fixture(), work = failed.invokePtyAgentLaunch('codex:run-command', failed.payload);
  failed.release({ success: false, accepted: false, error: 'no compact', code: 'no-compact' }); await work;
  assert.equal(failed.toasts.length, 1);
  assert.equal(failed.toasts[0][3], true);
  assert.match(failed.toasts[0][4], /Tab ID: target\nProvider: codex\nSource tab: source\nSource session: S/);
});

test('actual runtime intent predicate applies only to the unbound pending fork target', () => {
  const source = fs.readFileSync(new URL('../../utils/historyAgentRuntimes.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'hasPendingContextForkLaunch');
  assert.ok(node);
  const tab = { pendingAction: { contextFork: { sourceTabId: 'source' } } };
  const code = ts.transpileModule(node.getText(tree) + ';hasPendingContextForkLaunch;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = vm.runInNewContext(code, { findTabRuntimeContext: id => id === 'target' ? { tab } : null });
  assert.equal(pending('source'), false); assert.equal(pending('target'), true);
  tab.codexSessionId = 'C'; assert.equal(pending('target'), false);
  delete tab.codexSessionId; tab.pendingAction = undefined; assert.equal(pending('target'), false);
});
