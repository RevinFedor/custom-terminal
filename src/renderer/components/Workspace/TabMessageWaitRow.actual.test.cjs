'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript'), esbuild = require('esbuild');
const icons = require('lucide-react');
function compile(file) { return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText; }
const row = { exports: {} };
new Function('React', 'exports', compile(path.join(__dirname, 'RequestTrackerRow.tsx')))(React, row.exports);
const projection = { exports: {} };
new Function('module', 'exports', esbuild.buildSync({ entryPoints: [path.join(__dirname, '../../utils/tabMessageProjection.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text)(projection, projection.exports);
const file = path.join(__dirname, 'TabMessageTracker.tsx'), source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['DeliveryIcon', 'TabMessageRow', 'TabMessageTracker'].includes(node.name?.text))
  .map(node => node.getText(ast).replace(/^export /, '')).join('\n');
const c = vm.createContext({ React, ...icons, ...row.exports, ...projection.exports,
  TabMessageSourceChip: ({ source, leadingIcon }) => React.createElement('span', {}, leadingIcon, source.sourceTabName) });
vm.runInContext(ts.transpileModule(functions + '\nglobalThis.Row=TabMessageRow; globalThis.Tracker=TabMessageTracker;', {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, fileName: 'row.tsx' }).outputText, c);
const q = { messageId: 'Q', kind: 'question', sourceTabId: 'A', sourceTabName: 'A', targetTabId: 'B', targetTabName: 'B',
  createdAt: 10, updatedAt: 20, deliveryState: 'sent' };
function render(question, reply, tabId = 'A') {
  const index = projection.exports.mergeTabMessages({}, [question, ...(reply ? [reply] : [])]);
  return renderToStaticMarkup(React.createElement(c.Row, { thread: projection.exports.tabMessageThreads(index, tabId)[0],
    tabId, onOpen() {}, onDismiss() {} }));
}
test('actual tracker JSX exposes timeout as a saved outcome, preserves Send/Reply and original cancellation identity', () => {
  const html = render({ ...q, loopWait: { revision: 1, state: 'returning', disposition: 'reply_timeout', notice: { state: 'queued' } } });
  assert.match(html, /Срок ответа истёк/); assert.match(html, /исход сохранён/);
  assert.match(html, /data-tab-message-dismiss="Q"/);
  assert.match(html, /data-tab-question-delivery="sent"/); assert.match(html, />Send</); assert.match(html, />Reply</);
  assert.doesNotMatch(html, /animate-spin/);
});

test('actual live tracker hides a green completed exchange automatically; actual unified History retains it with the same IDs', () => {
  const chipFile = path.join(__dirname, 'OrchestrationStatusChip.tsx');
  const chip = ts.createSourceFile(chipFile, fs.readFileSync(chipFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let history;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(chip) === 'historyEntries') history = node.initializer.arguments[0].getText(chip);
    ts.forEachChild(node, visit);
  }
  visit(chip); assert.ok(history);
  const replies = ['queued', 'unconfirmed', 'failed', 'sent'];
  const actions = [], original = { ...q, replyMessageId: 'R' };
  let index = projection.exports.mergeTabMessages({}, [original]);
  for (let i = 0; i < replies.length; i++) {
    const reply = { ...q, messageId: 'R', kind: 'reply', replyTo: 'Q', sourceTabId: 'B', targetTabId: 'A',
      deliveryState: replies[i], updatedAt: 100 + i, text: 'One exact saved answer' };
    index = projection.exports.mergeTabMessages(index, [reply]);
    for (const tabId of ['A', 'B']) {
      const controller = { threads: projection.exports.tabMessageThreads(index, tabId), actionErrors: {}, listError: '' };
      const live = renderToStaticMarkup(React.createElement(c.Tracker, { tabId, controller,
        onOpen: value => actions.push(value), onDismiss: value => actions.push(value) }));
      if (reply.deliveryState === 'sent') assert.equal(live, '', 'no manual dismiss, final or success-expiry timer is needed');
      else assert.match(live, /data-tab-message-row="Q"/, 'non-success remains in active MCP cards');
      Object.assign(c, { orderedRuns: [], messages: controller, installs: { jobs: [] }, recovery: { targets: [] } });
      const entries = vm.runInContext(ts.transpileModule('(' + history + ')()', {
        compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, c);
      assert.equal(entries.length, 1); assert.equal(entries[0].id, 'message:Q');
      assert.equal(entries[0].thread.reply.messageId, 'R'); assert.equal(entries[0].thread.reply.replyTo, 'Q');
      const saved = renderToStaticMarkup(React.createElement(c.Row, { thread: entries[0].thread, tabId, history: true,
        onOpen: value => actions.push(value) }));
      assert.match(saved, /data-tab-message-history-row="Q"/);
      assert.match(saved, /data-tab-message-open="Q"/);
      if (reply.deliveryState === 'sent') {
        for (const stage of ['send', 'reply']) assert.match(saved.match(new RegExp('<span data-tab-message-stage="' + stage + '"[^>]*>'))?.[0] || '', /color:#4ade80/);
        assert.match(saved, /data-tab-message-status-icon="delivered"/);
      }
    }
  }
  assert.deepEqual(actions, [], 'automatic hiding is pure presentation, not cancel/ack/delete');
  assert.equal(index.Q.sourceDismissedAt, undefined); assert.equal(index.Q.cancelledAt, undefined);
  assert.equal(index.R.text, 'One exact saved answer');
});
test('actual outgoing and incoming rows complete on delivered Reply without a source natural final', () => {
  const reply = { ...q, messageId: 'R', kind: 'reply', replyTo: 'Q', sourceTabId: 'B', targetTabId: 'A' };
  const question = { ...q, replyMessageId: 'R', loopWait: { revision: 2, state: 'returning' } };
  assert.match(render(question, reply), /Ответ доставлен/);
  assert.doesNotMatch(render(question, reply), /ожидает обработки/);
  assert.doesNotMatch(render(question, reply, 'B'), /ожидает обработки/);
  assert.doesNotMatch(render({ ...question, loopWait: { revision: 3, state: 'settled' } }, reply), /ожидает обработки/);
});
test('legacy metadata-only received Reply is delivered, not an error from an obsolete processing proof', () => {
  const html = render({ ...q, replyMessageId: 'R', loopWait: { revision: 4, state: 'returning',
    replyDeliveryState: 'sent', disposition: 'reply_processing_timeout', notice: { state: 'sent' },
    pendingReturn: { kind: 'reply', reason: 'return_source_changed' } } });
  assert.match(html, /data-tab-reply-delivery="sent"/);
  assert.match(html, /Ответ доставлен/);
  assert.match(html, /data-tab-message-status-icon="delivered"/);
  assert.doesNotMatch(html, /Срок ответа истёк|Ожидает ответа/);
});

test('received Reply, header and visibility agree even with a legacy processing timeout', () => {
  const reply = { ...q, messageId: 'R', kind: 'reply', replyTo: 'Q', sourceTabId: 'B', targetTabId: 'A' };
  for (const timedOut of [false, true]) for (const body of [reply, undefined]) {
    const question = { ...q, replyMessageId: 'R', loopWait: { revision: 4, state: 'returning',
      replyDeliveryState: 'sent', ...(timedOut ? { disposition: 'reply_processing_timeout', notice: { state: 'sent' } } : {}) } };
    const html = render(question, body);
    const stage = html.match(/<span data-tab-message-stage="reply"[^>]*>/)?.[0];
    assert.ok(stage); assert.match(stage, /color:#4ade80/); assert.match(stage, /Ответ доставлен/);
    assert.match(html, /data-tab-message-status-icon="delivered"/);
    const thread = projection.exports.tabMessageThreads(projection.exports.mergeTabMessages({}, [question, ...(body ? [body] : [])]), 'A')[0];
    assert.equal(projection.exports.tabMessageVisibleInTracker(thread, 'A'), false, 'delivered exchange is complete');
    assert.equal(projection.exports.tabMessageSuccessAt(thread), body ? 20 : null, 'no timestamp invented for a metadata-only legacy row');
  }
});
