import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { openHistoryOperationOwner } from './historyOperationActivity.mjs';

function parse(relative) {
  return ts.createSourceFile(relative, fs.readFileSync(new URL(relative, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(ast, predicate) {
  let result;
  const visit = node => {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(result, 'actual handler must exist');
  return result;
}
function callback(relative, name, ambient) {
  const ast = parse(relative);
  const declaration = find(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name);
  const node = ts.isCallExpression(declaration.initializer)
    ? declaration.initializer.arguments[0] : declaration.initializer;
  return evaluate(node.getText(ast), ambient);
}
function evaluate(expression, ambient) {
  const code = ts.transpileModule('const handler = ' + expression, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return vm.runInNewContext(code + '\nhandler', ambient);
}
function boundary() {
  const calls = [];
  let resolve;
  const store = { openTabById: (tabId, options) => {
    calls.push({ tabId, options });
    return new Promise(done => { resolve = done; });
  } };
  return { calls, useWorkspaceStore: { getState: () => store }, finish: value => resolve(value) };
}

test('actual orchestration link awaits successful navigation before ACK and passes both legacy hints', async () => {
  for (const result of [false, true]) {
    const h = boundary();
    const acknowledgements = [];
    const open = callback('../components/Workspace/OrchestrationStatusChip.tsx', 'openLinkedTab', {
      ...h, tabId: 'source', setHistoryOpen() {}, closeMessage() {},
      ipcRenderer: { invoke: async (...args) => acknowledgements.push(args) },
    });
    const pending = open({ sourceTabId: 'source', targetTabId: 'target', targetProjectId: 'stale',
      targetProjectPath: '/legacy', runId: 'run' });
    assert.equal(h.calls[0].tabId, 'target');
    assert.equal(h.calls[0].options.projectId, 'stale');
    assert.equal(h.calls[0].options.projectPath, '/legacy');
    assert.deepEqual(acknowledgements, []);
    h.finish(result);
    await pending;
    assert.equal(acknowledgements.length, result ? 1 : 0);
    if (result) assert.equal(acknowledgements[0][0], 'orchestration:acknowledge');
  }
});

test('actual orchestration incoming link supports stable source ID without project and skips external-research target', async () => {
  const h = boundary();
  const open = callback('../components/Workspace/OrchestrationStatusChip.tsx', 'openLinkedTab', {
    ...h, tabId: 'target', setHistoryOpen() {}, closeMessage() {},
    ipcRenderer: { invoke: async () => {} },
  });
  const pending = open({ sourceTabId: 'source', targetTabId: 'target' });
  assert.equal(h.calls[0].tabId, 'source');
  h.finish(false);
  await pending;
  await open({ sourceTabId: 'target', runKind: 'external-research' });
  assert.equal(h.calls.length, 1);
});

test('actual message source handler keeps preview on false and waits before onNavigate on true', async () => {
  for (const result of [false, true]) {
    const h = boundary();
    const errors = [], opening = [];
    let navigated = 0;
    let cancelled = 0;
    const navigate = callback('../components/Workspace/TabMessageSourceChip.tsx', 'navigate', {
      ...h, opening: false, source: { sourceTabId: 'source', sourceProjectId: 'old' },
      setError: error => errors.push(error), setOpening: value => opening.push(value),
      onNavigate: () => navigated++,
      cancelTabMessageSourceJump: () => cancelled++,
    });
    const pending = navigate();
    assert.equal(h.calls[0].tabId, 'source');
    assert.equal(cancelled, 1);
    assert.equal(h.calls[0].options.projectId, 'old');
    assert.equal(navigated, 0);
    assert.deepEqual(opening, [true]);
    h.finish(result);
    await pending;
    assert.equal(navigated, result ? 1 : 0);
    assert.deepEqual(opening, [true, false]);
    assert.equal(Boolean(errors.at(-1)), !result);
  }
});

test('actual context source callback requests input focus only after successful navigation', async () => {
  const h = boundary();
  const effects = [];
  const navigate = callback('../components/Workspace/TabContextUpdates.tsx', 'navigate', {
    ...h, tabExists: true, projectId: 'live-owner', source: { tabId: 'source', projectId: 'legacy' },
    requestTabPrimaryInputFocus: (...args) => effects.push(args), onNavigate: () => effects.push('close'),
  });
  const first = navigate();
  assert.deepEqual(effects, []);
  h.finish(false);
  await first;
  assert.deepEqual(effects, []);
  const second = navigate();
  h.finish(true);
  await second;
  assert.deepEqual(effects, [['source', 'context-source-tab-click'], 'close']);
});

test('actual Rewind-ready toast callback passes captured tab ID to root', async () => {
  const ast = parse('../components/Workspace/Timeline.tsx');
  const toast = find(ast, n => ts.isCallExpression(n) && n.arguments[0]
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'Rewind готов — ');
  const h = boundary();
  const click = evaluate(toast.arguments.at(-1).getText(ast), {
    ...h, targetTabId: 'original-tab', targetProjectId: 'old-owner',
  });
  click();
  assert.equal(h.calls[0].tabId, 'original-tab');
  assert.equal(h.calls[0].options.projectId, 'old-owner');
  h.finish(false);
  await Promise.resolve();
});

test('actual recording navigation forwards owner hint and never opens a fallback project', async () => {
  const h = boundary();
  let stopped = false;
  const click = callback('../components/UI/Toast.tsx', 'goToOwnerTab', {
    ...h, ownerTabId: 'recording-owner', dictation: { owner: { projectId: 'legacy' } }, openHistoryOperationOwner,
  });
  const pending = click({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(h.calls[0].tabId, 'recording-owner');
  assert.equal(h.calls[0].options.projectId, 'legacy');
  h.finish(false);
  await pending;
});

test('actual dictation owner bridge replies with resolved boolean instead of a Promise', async () => {
  const ast = parse('../App.tsx');
  const branch = find(ast, n => ts.isIfStatement(n) && n.expression.getText(ast) === "action === 'dictationChipOpenOwner'");
  for (const result of [false, true]) {
    const h = boundary();
    const replies = [];
    const handler = evaluate('async () => ' + branch.thenStatement.getText(ast), {
      ...h, openHistoryOperationOwner, payload: { tabId: 'owner' }, console: { log() {} },
      reply: (_ok, data) => replies.push(data),
    });
    const pending = handler();
    assert.deepEqual(replies, []);
    h.finish(result);
    await pending;
    assert.equal(replies[0].opened, result);
  }
});
