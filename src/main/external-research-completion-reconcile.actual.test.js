'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const webFile = path.join(__dirname, 'web-server.js');
const tree = ts.createSourceFile(webFile, fs.readFileSync(webFile, 'utf8'), ts.ScriptTarget.Latest, true);
const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getExternalCompletionDelivery');
assert(node);
function fixture() {
  let options; const arms = [], reconciled = [];
  const context = vm.createContext({ path, srcMainDir: __dirname, externalCompletionDelivery: null,
    require(file) { assert.equal(file, path.join(__dirname, 'external-research-completion-delivery'));
      return { createExternalCompletionDelivery(value) { options = value; return {}; } }; },
    getOrchestrationRunStore: () => ({}), agentSendReceiptStore: {}, agentSendReceiptStartupReady: Promise.resolve({ ready: true }),
    prepareExternalCompletionRequest() { assert.fail('observation may not prepare new input'); },
    armOrchestrationSourceProof: async (...args) => { arms.push(args); return { success: true }; },
    reconcileOrchestrationSourceFollowup: async (...args) => { reconciled.push(args); return { changed: false, reason: 'owned_observation_only' }; },
  });
  vm.runInContext(node.getText(tree), context); context.getExternalCompletionDelivery();
  return { options, arms, reconciled };
}
for (const target of [null, { toolType: 'codex' }]) test('actual Main factory keeps missing legacy source ' + JSON.stringify(target) + ' observational', async () => {
  const h = fixture(), run = { runId: 'legacy', notificationPromptHash: 'original-hash', externalResearchDelivery: { legacy: true, sourceTarget: target } };
  await h.options.reconcile(run);
  assert.equal(h.arms.length, 0, 'do not invent an execution identity or arm an undefined session');
  assert.equal(h.reconciled.length, 1); assert.equal(h.reconciled[0][0], run);
});
test('actual Main factory restores watcher only for the exact saved source', async () => {
  const h = fixture(), run = { runId: 'legacy', sourceProjectPath: '/owned', notificationPromptHash: 'original-hash',
    externalResearchDelivery: { legacy: true, sourceTarget: { toolType: 'codex', sessionId: 'original-S' } } };
  await h.options.reconcile(run); assert.equal(h.arms.length, 1); assert.equal(h.arms[0][0], run);
  assert.deepEqual(JSON.parse(JSON.stringify(h.arms[0][1])), { toolType: 'codex', sessionId: 'original-S', cwd: '/owned' });
  assert.equal(h.reconciled.length, 1);
});
test('actual Main factory does not rearm a source already canonically confirmed', async () => {
  const h = fixture(), run = { runId: 'legacy', sourceFollowupStartedAt: 1, notificationPromptHash: 'original-hash',
    externalResearchDelivery: { legacy: true, sourceTarget: { toolType: 'codex', sessionId: 'original-S' } } };
  await h.options.reconcile(run); assert.equal(h.arms.length, 0); assert.equal(h.reconciled.length, 1);
});
