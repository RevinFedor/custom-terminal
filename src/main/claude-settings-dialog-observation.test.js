'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { observeClaudeSettingsDialogWrite, describeClaudeSettingsDialogObservation } = require('./claude-settings-dialog-observation');
const snapshot = rows => ({ success: true, generation: 'mirror', writeSeq: 12,
  lines: rows.map(text => ({ text })) });
const dialog = snapshot(['Switch model?', '❯ 1. Yes, switch to model-x', '2. No, go back']);

test('a complete selected dialog with its settings owner is not a contradiction', () => {
  assert.equal(describeClaudeSettingsDialogObservation({ snapshot: dialog, dialogType: 'ModelDialog',
    operation: { kind: 'claude-settings-send' } }), null);
});

test('quoted title and unrelated PTY writer produce metadata, not a new authorization', () => {
  const quoted = describeClaudeSettingsDialogObservation({
    snapshot: snapshot(['Explain the phrase: Switch model?']), dialogType: 'ModelDialog' });
  assert.equal(quoted.reason, 'fragment-without-complete-selected-dialog');
  assert.equal(JSON.stringify(quoted).includes('Explain the phrase'), false);
  assert.equal(describeClaudeSettingsDialogObservation({ snapshot: dialog, dialogType: 'ModelDialog',
    operation: { kind: 'safe-paste', source: 'user-send' } }).reason, 'competing-pty-write');
});

test('actual confirmation function captures the suspicious frame before its existing Enter', async () => {
  const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
  const start = source.indexOf('function classifyClaudeSettingsDialogText(');
  const end = source.indexOf('const claudeCliActive = new Map()', start);
  const calls = [];
  const term = { write: value => calls.push(['write', value]) };
  const context = {
    console: { log() {} }, terminals: new Map([['tab', term]]),
    getTerminalInputRevision: () => 1, bumpTerminalInputRevision() {},
    flushHeadlessTerminalMirror: async () => ({ success: true }),
    getHeadlessVisibleBufferSnapshot: () => snapshot(['Explain the phrase: Switch model?']),
    claudeConfirmDialogCooldown: new Map(), ptyActiveWriteOperation: new WeakMap(),
    observeClaudeSettingsDialogWrite,
    reportTerminalIncident: (_key, payload) => { calls.push(['capture', payload.context]); return Promise.resolve(); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = await context.confirmClaudeSettingsDialogFromCurrentFrame('tab', 'ModelDialog', 'test');
  assert.equal(result.confirmed, true, 'observation does not silently reclassify legacy behavior');
  assert.deepEqual(calls.map(call => call[0]), ['capture', 'write']);
  assert.equal(calls[0][1].reason, 'fragment-without-complete-selected-dialog');
});

test('diagnostic failures cannot throw into the existing action', async () => {
  const candidate = { snapshot: snapshot(['Switch model?']), dialogType: 'ModelDialog' };
  assert.doesNotThrow(() => observeClaudeSettingsDialogWrite({ ...candidate, capture: () => { throw Error('disk failed'); } }));
  observeClaudeSettingsDialogWrite({ ...candidate, capture: () => Promise.reject(Error('async disk failed')) });
  await new Promise(resolve => setImmediate(resolve));
});
