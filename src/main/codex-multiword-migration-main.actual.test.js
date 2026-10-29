'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), Module = require('node:module');
const path = require('node:path');
const filename = require.resolve('./main');
const source = fs.readFileSync(process.env.MIGRATION_MAIN_SOURCE || filename, 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'tryCommitCodexModelMigrationAcknowledgement');
const armDeclaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'armCodexModelMigrationAcknowledgement');
assert.ok(declaration && armDeclaration, 'actual Main migration owner');
function picker() {
  if (!process.env.MIGRATION_PICKER_SOURCE) return require('./codex-model-picker');
  const file = require.resolve('./codex-model-picker'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(process.env.MIGRATION_PICKER_SOURCE, 'utf8'), file); return loaded.exports;
}
function fixture({ catalog = [{ id: 'gpt-7.2-artemis', label: 'GPT-7.2 Artemis' }], changed = null } = {}) {
  const term = {}, target = 'gpt-7.2-artemis', configPath = '/private/fixture.toml';
  const state = { term, output: '', runSeq: 1, launchId: 'L1', inputRevision: 4,
    targetModel: target, sourceModel: 'gpt-old', configPath, enteredAt: 100,
    configProofKey: ['gpt-old', target, target, 'high', configPath].join('\u0000'), configProof: { matches: true } };
  const pending = new Map([['T', state]]), writes = [], launch = { launchId: 'L1', modelMigrationPending: true };
  const ctx = vm.createContext({ ...picker(), codexPendingModelMigrations: pending,
    codexLastRunCommandPayload: new Map([['T', launch]]), codexStartupAutoEnter: new Map(),
    terminals: new Map([['T', changed === 'terminal' ? {} : term]]),
    terminalCommandState: new Map([['T', { runSeq: changed === 'run' ? 2 : 1 }]]),
    getTerminalInputRevision: () => 4, getCodexModelIdentityCatalog: () => catalog,
    clearCodexPendingModelMigration: id => pending.delete(id), getCodexWriterProofSnapshot: () => ({ launchId: 'L1', sessionId: 'S1' }),
    resolveAuthoritativeTabProjectId: () => 'P', projectManager: { db: { commitTabCodexModelMigration: (project, tab, value) => {
      writes.push({ project, tab, value }); return { success: true }; } } },
    codexTuiReadyLastNotReady: new Map(), codexPendingSettingsProofHandoffs: new Map(), mainWindow: null,
    console: { log() {}, warn() {} } });
  const commit = vm.runInContext(declaration.getText(ast) + '\ntryCommitCodexModelMigrationAcknowledgement', ctx);
  return { commit, pending, writes, launch, state };
}

test('actual Main migration owner binds a unique display ACK to the same launch and exact config proof', () => {
  const h = fixture();
  assert.equal(h.commit('T', '• Model changed to GPT-7.2 Artemis high'), true);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].value.model, 'gpt-7.2-artemis');
  assert.equal(h.writes[0].value.proofSessionId, 'S1'); assert.equal(h.pending.has('T'), false);
});

test('foreign, missing or ambiguous model identity cannot commit a migration', () => {
  for (const options of [{ changed: 'terminal' }, { changed: 'run' }, { catalog: [] },
    { catalog: [{ id: 'gpt-7.2-artemis', label: 'GPT-7.2 Artemis' }, { id: 'gpt-7.2-other', label: 'GPT-7.2 Artemis' }] }]) {
    const h = fixture(options); assert.equal(h.commit('T', '• Model changed to GPT-7.2 Artemis high'), false);
    assert.equal(h.writes.length, 0);
  }
});

test('actual durable migration arm records the catalog ID rather than a guessed display slug', () => {
  const catalog = [{ id: 'gpt-experimental-id', label: 'GPT-7.2 Artemis' }], begun = [], pending = new Map();
  const ctx = vm.createContext({ ...picker(), getCodexModelIdentityCatalog: () => catalog,
    isTrustedCodexConfigPath: () => true, fs: { statSync: () => ({ isFile: () => true, size: 0 }), readFileSync: () => '' },
    hashCodexConfigSnapshot: () => 'fixture', clearCodexPendingModelMigration() {}, resolveAuthoritativeTabProjectId: () => 'P',
    projectManager: { db: { beginTabCodexModelMigration: (_project, _tab, input) => { begun.push(input); return { success: true }; } } },
    codexPendingModelMigrations: pending, codexLastRunCommandPayload: new Map(), mainWindow: null,
    console: { warn() {}, log() {} } });
  const arm = vm.runInContext(armDeclaration.getText(ast) + '\narmCodexModelMigrationAcknowledgement', ctx);
  const request = { term: {}, runSeq: 1, launchId: 'L1', inputRevision: 4,
    sourceModel: 'gpt-old', targetModel: 'GPT-7.2 Artemis', configPath: '/private/fixture.toml' };
  assert.equal(arm('T', request)?.targetModel, 'gpt-experimental-id');
  assert.equal(begun[0].targetModel, 'gpt-experimental-id');
  catalog.push({ id: 'gpt-other', label: 'GPT-7.2 Artemis' });
  assert.equal(arm('T', request), null); assert.equal(begun.length, 1, 'ambiguous model must not begin a durable migration');
});
