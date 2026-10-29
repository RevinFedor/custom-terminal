'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const picker = require('./codex-model-picker');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['armCodexModelMigrationAcknowledgement', 'tryHandleManualCodexModelMigrationEnter'];
const declarations = names.map(name => {
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}).join('\n');

function fixture({ conflict = false, existingSelected = false } = {}) {
  const actions = [], term = { write: value => actions.push(['write', value]) }, startup = new Map([['T', { configPath: '/private/config', armedAt: 20 }]]);
  const catalog = [{ id: 'gpt-special-a', label: 'GPT-7.2 Artemis' },
    { id: 'gpt-special-b', label: 'GPT-7.2-Artemis' }];
  const target2 = conflict ? 'GPT-7.2-Artemis' : 'GPT-7.2 Artemis';
  const text = 'Codex now uses GPT-7.2 Artemis in place of gpt-old. Switch to ' + target2 + ' to continue.\n'
    + "Choose how you'd like Codex to proceed.\n" + (existingSelected ? '  1. Try new model\n› 2. Use existing model\n'
      : '› 1. Try new model\n  2. Use existing model\n') + 'Press enter to confirm';
  const ctx = vm.createContext({ ...picker, getCodexModelIdentityCatalog: () => catalog,
    isTrustedCodexConfigPath: () => true, fs: { statSync: () => ({ isFile: () => true, size: 0 }), readFileSync: () => '' },
    hashCodexConfigSnapshot: () => 'fixture', clearCodexPendingModelMigration() {}, resolveAuthoritativeTabProjectId: () => 'P',
    projectManager: { db: { beginTabCodexModelMigration: (_p, _t, value) => { actions.push(['begin', value.targetModel]); return { success: true }; } } },
    codexPendingModelMigrations: new Map(), codexLastRunCommandPayload: new Map(), mainWindow: null,
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { isRunning: true, runSeq: 1 }]]),
    codexStartupAutoEnter: startup, codexTuiReadyBuffers: new Map(), getTerminalInputRevision: () => 4,
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, lines: text.split('\n').map(row => ({ text: row })) }),
    clearCodexStartupAutoEnter: id => startup.delete(id), queueTerminalCommandMeta() {}, resetCodexTuiReadyDetection() {},
    console: { warn() {}, log() {} } });
  const handler = vm.runInContext(declarations + '\ntryHandleManualCodexModelMigrationEnter', ctx);
  return { actions, invoke: () => handler('T', term, '\r') };
}

test('manual migration preserves durable-before-Enter ordering with a non-derived catalog ID', () => {
  const h = fixture(), result = h.invoke();
  assert.equal(result.submitted, true); assert.deepEqual(h.actions, [['begin', 'gpt-special-a'], ['write', '\r']]);
});

test('conflicting target labels do not write; the explicit existing-model choice still works', () => {
  const conflicting = fixture({ conflict: true });
  assert.equal(conflicting.invoke().submitted, false); assert.deepEqual(conflicting.actions, []);
  const keepExisting = fixture({ conflict: true, existingSelected: true });
  assert.equal(keepExisting.invoke().submitted, true); assert.deepEqual(keepExisting.actions, [['write', '\r']]);
});
