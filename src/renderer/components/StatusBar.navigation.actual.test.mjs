import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./StatusBar.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('StatusBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'focusMcpTarget');
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const calls = [];
  const ws = (projectPath, ...tabs) => ({ projectPath, tabs: new Map(tabs.map(id => [id, { id }])), activeTabId: tabs[0] });
  const state = { openProjects: new Map([['home', ws('/home', 'current')], ['target', ws('/target', 'T')]]),
    activeProjectId: 'home', activeSpaceId: 'home-space', splitFocusedIndex: 0,
    splitPanes: [{ projectId: 'home', tabId: 'current', tabs: [{ projectId: 'home', tabId: 'current' }] }],
    spaces: [], openTabById: async (tabId, options) => { calls.push({ kind: 'open-tab', tabId, options }); return true; },
    showWorkspace: id => calls.push({ kind: 'show', id }), setProjectView: (id, view) => calls.push({ kind: 'view', id, view }),
    openProject: async (id, cwd, options) => { calls.push({ kind: 'open', id, cwd, options }); state.openProjects.set(id, ws(cwd, 'T')); } };
  const focus = vm.runInNewContext(code + '\nfocusMcpTarget', {
    useWorkspaceStore: { getState: () => state },
  });
  return { state, calls, focus };
}

test('actual MCP target handler forwards exact tab and legacy hints without deciding placement', async () => {
  const h = harness();
  h.state.spaces = [{ id: 'other-space', layout: { splitPanes: [{ projectId: 'target', tabId: 'T' }] } }];
  assert.equal(await h.focus({ tabId: 'T', targetProjectId: 'stale', targetCwd: '/stale' }),true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].kind, 'open-tab');
  assert.equal(h.calls[0].tabId, 'T');
  assert.equal(h.calls[0].options.projectId, 'stale');
  assert.equal(h.calls[0].options.projectPath, '/stale');
  assert.equal(h.calls[0].options.reason, 'mcp-activity-target');
  assert.equal(h.state.splitPanes[0].tabId, 'current');
});

test('actual MCP target handler waits for root outcome without navigating a fallback project', async () => {
  const h = harness();
  let resolve;
  h.state.openTabById = () => new Promise(done => { resolve = done; });
  let finished = false;
  const opening = h.focus({ tabId: 'missing', targetProjectId: 'target', targetCwd: '/target' })
    .then(opened => { assert.equal(opened,false); finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  resolve(false);
  await opening;
  assert.deepEqual(h.calls, []);
});

test('tab target without project hints still reaches root; project-only navigation is preserved', async () => {
  const h = harness();
  await h.focus({ tabId: 'T' });
  assert.equal(h.calls[0].tabId, 'T');
  h.calls.length = 0;
  await h.focus({ targetCwd: '/target/subdir' });
  assert.deepEqual(h.calls, [{ kind: 'show', id: 'target' }, { kind: 'view', id: 'target', view: 'terminal' }]);
});

test('actual MCP labels show tab and project names, not repeated transport IDs', () => {
  const h = harness();
  h.state.openProjects.get('target').tabs.set('T', { name: 'Fork / Rewind' });
  const declarations = ['mcpPartyLabel', 'targetLabel', 'sourceLabel'].map(name =>
    ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast)).join('\n');
  const labels = vm.runInNewContext(ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    + '\n({targetLabel,sourceLabel})', { useWorkspaceStore: { getState: () => h.state },
    useProjectsStore: { getState: () => ({ projects: { target: { name: 'Noted Terminal' } } }) } });
  assert.equal(labels.targetLabel({ tabId: 'T', targetProjectId: 'stale', targetName: 'Old name' }), 'Fork / Rewind · Noted Terminal');
  assert.equal(labels.sourceLabel({ tabId: 'T', projectId: 'target' }), 'Fork / Rewind · Noted Terminal');
  assert.equal(labels.targetLabel({ targetCwd: '/project/closed' }), 'closed');
});
