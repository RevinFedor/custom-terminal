'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { nextCodexModelEffortIntent, planCodexModelEffortIntentReconcile } = require('./codex-model-effort-intent');
const text = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', text, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ensureCodexContextForkSettingsIntent');
assert.ok(fn);
for (const command of ['codex-f', 'codex-c']) test(command + ': inherited desired B survives source A proof, explicit child C wins before/after slow preparation', () => {
  let current = null, writes = 0, cancelled = false;
  const set = (model, effort) => { const next = nextCodexModelEffortIntent({ currentModel: current?.model,
    currentEffort: current?.effort, currentRevision: current?.revision, model, effort });
    current = { model: next.model, effort: next.effort, revision: next.revision }; writes++; return { success: true }; };
  const actual = vm.runInNewContext('(' + fn.getText(tree) + ')', {
    getCodexModelEffortIntentRecord: () => current, persistCodexModelEffortIntent: (_id, model, effort) => set(model, effort),
  });
  const payload = { command, contextFork: { sourceTabId: 'source', sourceSessionId: 'S', initialSettings: { model: 'B', effort: 'high' } } };
  const check = () => { if (cancelled) throw Error('agent_launch_cancelled'); };
  const proof = { status: 'found', model: 'A', effort: 'max' };
  actual('child', payload, proof, check); assert.equal(current.model, 'B');
  assert.equal(planCodexModelEffortIntentReconcile({ ...current, processRunning: false }).action, 'queue');
  assert.equal(planCodexModelEffortIntentReconcile({ ...current, processRunning: true, tuiReady: true, writerOwnerId: 'launch:child' }).action, 'apply');
  set('C', 'medium'); actual('child', payload, proof, check);
  assert.equal(current.model, 'C'); assert.equal(writes, 2, 'late source preparation never writes initial B over child C');
  current = null; cancelled = true;
  assert.throws(() => actual('child', payload, proof, check), /agent_launch_cancelled/); assert.equal(current, null);
  actual('child', { command }, proof, check); assert.equal(current, null, 'unrelated Resume remains unchanged');
});

test('same source pair needs no redundant intent/picker; hook is after source validation and before launch', () => {
  let writes = 0;
  const actual = vm.runInNewContext('(' + fn.getText(tree) + ')', { getCodexModelEffortIntentRecord: () => null,
    persistCodexModelEffortIntent: () => { writes++; } });
  actual('T', { command: 'codex-f', contextFork: { initialSettings: { model: 'A', effort: 'max' } } },
    { status: 'found', model: 'A', effort: 'max' }, () => {});
  assert.equal(writes, 0);
  const run = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runCodexCommandFromPayloadInner').getText(tree);
  assert.ok(run.indexOf('ensureCodexContextForkSettingsIntent(') > run.indexOf('if (!commandSettings.allowed)'));
  assert.ok(run.indexOf('ensureCodexContextForkSettingsIntent(') < run.indexOf('codexLastRunCommandPayload.set('));
});
