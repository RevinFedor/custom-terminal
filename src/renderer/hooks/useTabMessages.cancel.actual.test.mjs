import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hook = fs.readFileSync(new URL('./useTabMessages.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('hook.ts', hook, ts.ScriptTarget.Latest, true);
let cancel;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'cancel') cancel = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(cancel);
const compiled = ts.transpileModule('const ' + cancel + ';globalThis.runCancel=cancel;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const projection = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../utils/tabMessageProjection.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: projection, require: () => ({ REQUEST_SUCCESS_VISIBLE_MS: 4000 }) });

test('actual controller X requests cancellation and hides only after an exact durable ACK', async () => {
  let response, errors = {}, merged = [];
  const calls = [];
  const ctx = vm.createContext({ tabId: 'A', useCallback: fn => fn,
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return response; } },
    merge: rows => merged.push(...rows), setActionErrors: fn => { errors = fn(errors); } });
  vm.runInContext(compiled, ctx);
  response = { cancelled: true, message: { messageId: 'foreign' } };
  assert.equal(await ctx.runCancel('q'), false); assert.equal(merged.length, 0); assert.ok(errors.q);
  response = { cancelled: true, message: { messageId: 'q', cancelledAt: 30 } };
  assert.equal(await ctx.runCancel('q'), true); assert.equal(merged.length, 1); assert.equal(errors.q, '');
  assert.deepEqual(calls.map(call => call[0]), ['tab-messages:cancel', 'tab-messages:cancel']);
  assert.equal(calls[0][1].tabId, 'A');
});

test('cancel event behind a newer delivery event stays monotonic; saved History remains readable', () => {
  const q = { messageId: 'q', kind: 'question', sourceTabId: 'A', targetTabId: 'B',
    deliveryState: 'queued', createdAt: 1, updatedAt: 50, text: 'immutable original' };
  let state = projection.mergeTabMessages({}, [q]);
  state = projection.mergeTabMessages(state, [{ ...q, updatedAt: 40, cancelledAt: 35, cancelledByTabId: 'A' }]);
  state = projection.mergeTabMessages(state, [{ ...q, updatedAt: 60, cancelledAt: null }]);
  assert.equal(state.q.cancelledAt, 35);
  const [thread] = projection.tabMessageThreads(state, 'B');
  assert.equal(thread.question.text, q.text);
  assert.equal(projection.tabMessageVisibleInTracker(thread, 'A', 80), false);
  assert.equal(projection.tabMessageVisibleInTracker(thread, 'B', 80), false);
  assert.match(projection.tabMessageDelivery(thread.question).label, /не подтверждена/);
  assert.equal(projection.tabMessageQuestionLabel({ ...thread.question, deliveryState: 'sent' }, false), 'Доставлено');
});

test('both existing compact/expanded message surfaces route the unchanged row X to the cancel owner', () => {
  const chip = fs.readFileSync(new URL('../components/Workspace/OrchestrationStatusChip.tsx', import.meta.url), 'utf8');
  const row = fs.readFileSync(new URL('../components/Workspace/TabMessageTracker.tsx', import.meta.url), 'utf8');
  assert.equal((chip.match(/onDismiss=\{cancelMessage\}/g) || []).length, 2);
  assert.match(chip, /await messages\.cancel\(messageId\)/);
  assert.match(row, /onClick=\{\(\) => onDismiss\(question\.messageId\)\}/);
  assert.doesNotMatch(hook, /tab-messages:dismiss/);
});
