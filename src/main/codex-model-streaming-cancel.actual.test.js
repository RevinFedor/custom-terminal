'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const { fixture, tick } = require('./fixtures/model-preparation.cjs');
const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};

test('while a model turn streams, cancelling the exact actual picker stops its input without stopping the turn', async t => {
  const h = fixture(t, { holdModelMenu: true });
  const state = { type: 'anthropic', codexSettingsIntentModel: h.requested.model,
    codexSettingsIntentEffort: h.requested.effort, codexSettingsIntentRevision: 21,
    codexSettingsIntentActionSequence: 8, codexSettingsIntentStateVersion: 6 };
  const db = h.store.db;
  db.exec('CREATE TABLE tabs(project_id TEXT,execution_namespace TEXT,tab_id TEXT,provider_state TEXT)');
  db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run('P', null, 'T', JSON.stringify(state));
  const states = new Map([['T', state]]);
  Object.assign(h.ctx, { providerStates: states, projectManager: { db: { db } },
    terminalLifecycleEpochs: new WeakMap([[h.term, 'physical-T']]),
    resolveAuthoritativeTabProjectId: () => 'P', setProviderState: (id, value) => states.set(id, value),
    broadcastProviderState: () => h.notifyFrame(), hasCodexPromptOrTurnInFlight: () => true,
  });
  vm.runInContext(['captureCodexSettingsCancelScope', 'getCodexModelEffortIntentRecord',
    'createCodexModelEffortIntentWriteGuard', 'cancelCodexModelEffortIntent'].map(declaration).join('\n'), h.ctx);
  const guard = h.ctx.createCodexModelEffortIntentWriteGuard('T', h.ctx.getCodexModelEffortIntentRecord('T'));
  const pending = h.ctx.executeCodexSelectModelEffortRequest(null, { tabId: 'T', ...h.requested,
    allowTurnBusy: true, expectedWriterSessionId: 'S', settingsWriteGuard: guard });
  await tick(160); h.frame('/model'); await tick(160);
  assert.equal(h.serviceEnters, 1, h.logs.join('\n'));
  const active = h.ctx.agentSettingsActivity.read('T');
  assert.equal(active.busy, true);
  const cancelled = h.ctx.cancelCodexModelEffortIntent({ tabId: 'T', ...active.cancelTarget,
    scope: h.ctx.captureCodexSettingsCancelScope('T') });
  assert.equal(cancelled.success, true); h.notifyFrame();
  const result = await pending;
  assert.equal(result.success, false); assert.equal(result.error, 'codex_settings_intent_cancelled');
  assert.equal(h.ctx.agentSettingsActivity.read('T').busy, false);
  assert.equal(h.writes.filter(bytes => bytes === '\r').length, 1, 'only the owned /model Enter crossed input');
  assert.equal(h.writes.some(bytes => bytes === '\x03'), false, 'the streaming user turn is not interrupted');
  assert.equal(h.promptCalls, 0); assert.equal(states.get('T').codexSettingsIntentCancelled.revision, 21);
});
