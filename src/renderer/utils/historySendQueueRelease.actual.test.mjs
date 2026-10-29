import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
import React from 'react';
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
const button = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'HistorySendQueueReleaseAction');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
let callback;
const visit = n => { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'releaseSendQueue') callback = n.initializer.getText(ast);
  ts.forEachChild(n, visit); }; visit(ast);

test('actual queue recovery button serializes double clicks and clears loader on refusal; success removes only its action', async () => {
  assert.ok(button); const slots = []; let cursor = 0, calls = 0, finish;
  const c = { React, Tooltip: props => props.children,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; } };
  const render = vm.runInNewContext(compile(button.getText(ast)) + ';HistorySendQueueReleaseAction;', c);
  const onRelease = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const paint = () => { cursor = 0; return render({ onRelease }); };
  const first = paint().props.children, event = { preventDefault() {}, stopPropagation() {} };
  assert.equal(first.props.children, 'Продолжить очередь');
  assert.equal(first.props.style.cursor, 'default');
  assert.equal(first.props.style.flex, '0 0 auto', 'text action must not inherit the icon-only fixed flex basis');
  assert.equal(first.props.style.lineHeight, 1);
  let prevented = 0, stopped = 0;
  first.props.onMouseDown({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const pending = first.props.onClick(event); await first.props.onClick(event);
  assert.equal(calls, 1); assert.equal(paint().props.children.props.disabled, true);
  finish(false); await pending; assert.equal(paint().props.children.props.disabled, false);
  const again = paint().props.children.props.onClick(event); finish(true); await again;
  assert.equal(paint(), null); assert.equal(calls, 2);
});

function harness() {
  let current = { handoffId: 'H', sendOperationKey: 'history:T:H', sendAttemptId: 'A' };
  const calls = [], updates = [], toasts = [], reply = [];
  const c = { tabId: 'T', historyOwnerKey: 'owner', historyOwnerKeyRef: { current: 'owner' },
    historyOwnerGenerationRef: { current: 1 }, updateLocalPromptEntry: (...args) => updates.push(args),
    settleHistoryPromptHandoff: (...args) => updates.push(args), historyServicePromptFingerprint: sha,
    getHistoryPromptHandoffsSnapshot: () => [current], useCallback: fn => fn,
    presentationEntriesRef: { current: [] }, isLocalPromptEntry: () => true,
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return typeof reply[0] === 'function' ? reply.shift()() : reply.shift(); } },
    useUIStore: { getState: () => ({ showToast: (...args) => toasts.push(args) }) },
  };
  const run = vm.runInNewContext(compile('const action = ' + callback + ';') + ';action;', c);
  return { c, calls, updates, toasts, reply, run, entry: { ...current }, change: value => { current = value; } };
}
test('actual History caller never resends; unknown reply retries stable exact H/O/A request and stale owner cannot project', async () => {
  const h = harness(); h.reply.push({ success: false, code: 'lost-ack' }, { success: true, released: true });
  assert.equal(await h.run(h.entry), false); assert.equal(h.updates.length, 0);
  assert.equal(await h.run(h.entry), true);
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.calls[0][0], 'agent:release-send-queue-head');
  assert.equal(h.calls[0][1].attemptId, 'A'); assert.equal(h.calls[0][1].operationKey, 'history:T:H');
  assert.equal(h.updates.length, 2);
  h.change({ ...h.entry, sendAttemptId: 'foreign' });
  assert.equal(await h.run(h.entry), false); assert.equal(h.calls.length, 2);
  const late = harness(); let resolve;
  late.reply.push(() => new Promise(done => { resolve = done; }));
  const pending = late.run(late.entry); late.c.historyOwnerGenerationRef.current++;
  resolve({ success: true, released: true }); await pending;
  assert.equal(late.updates.length, 0); assert.equal(late.toasts.length, 0);
  for (const patch of [{ sendAttemptId: 'B' }, { queueStatus: 'sent' }]) {
    const changed = harness(); let finish;
    changed.reply.push(() => new Promise(done => { finish = done; }));
    const pending = changed.run(changed.entry);
    changed.change({ ...changed.entry, ...patch });
    finish({ success: true, released: true }); await pending;
    assert.equal(changed.updates.length, 0, 'late release cannot downgrade SENT or replace an attempt');
  }
});

test('actual render wiring offers recovery only for a typed entered Codex application item, separately from X and Return', () => {
  const at = source.indexOf('<HistorySendQueueReleaseAction key=');
  assert.ok(at > 0);
  const guard = source.slice(at - 460, at);
  for (const expected of ["toolType === 'codex'", 'entry.applicationQueueId', 'entry.sendOperationKey',
    'entry.sendAttemptId', "'durable-input-slot-retired'"]) assert.ok(guard.includes(expected), expected);
  assert.ok(source.includes('onReleaseSendQueue={!previewMode ? releaseSendQueue : undefined}'));
  assert.ok(source.includes('onReleaseSendQueue={onReleaseSendQueue}'));
});
