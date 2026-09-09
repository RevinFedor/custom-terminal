const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createPendingCodexSettingsProofHandoff } = require('./codex-runtime-contract');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function part(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function harness({ current = true, requestedEffort = 'high', observedProof = 'verified-composer-footer' } = {}) {
  const term = {};
  const pending = new Map();
  const intent = { model: 'gpt-5.6-luna', effort: requestedEffort, revision: 2,
    appliedRevision: 2, appliedOwnerId: 'writer-S', providerState: {} };
  let reconciles = 0;
  let writesNeeded = 0;
  const publication = [];
  const api = vm.runInNewContext([
    part('retireCodexScopedModelEffortIntent'),
    part('confirmCodexIntentFromCurrentLaunchSettings'),
    part('armCodexCurrentLaunchSettingsProof'),
    'armCodexCurrentLaunchSettingsProof',
  ].join('\n'), {
    terminals: new Map([['T', term]]),
    terminalCommandState: new Map([['T', { runSeq: 3, isRunning: true }]]),
    codexLastRunCommandPayload: new Map([['T', { launchId: 'L', terminalToken: term, runSeq: 3, lifecycleGeneration: 'G' }]]),
    getTerminalLifecycleGeneration: () => current ? 'G' : 'new-G',
    getCodexWriterProofSnapshot: () => null,
    getCurrentCodexServiceTierLaunchCandidate: () => null,
    codexPendingSettingsProofHandoffs: pending,
    createPendingCodexSettingsProofHandoff,
    getCodexModelEffortIntentRecord: () => intent,
    markCodexModelEffortIntentApplied: (_tab, accepted, owner, _source, options) => {
      assert.equal(accepted, intent);
      assert.equal(options.publish, false);
      intent.appliedRevision = intent.revision;
      intent.appliedOwnerId = owner;
      return { applied: true, providerState: {} };
    },
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, data) => publication.push({ channel, data }) } },
    broadcastProviderState: () => publication.push({ channel: 'release-pending' }),
    scheduleCodexModelEffortIntentReconcile: () => {
      reconciles++;
      if (intent.appliedOwnerId !== 'launch:L') writesNeeded++;
    },
    console: { log() {} },
  });
  const observe = () => api('T', { model: 'gpt-5.6-luna', effort: 'high', fast: false, proof: observedProof });
  return { observe, intent, publication, reconciles: () => reconciles, writesNeeded: () => writesNeeded };
}

test('a freshly verified same-pair launch footer settles the current intent without another picker', () => {
  const h = harness();
  assert.ok(h.observe());
  assert.equal(h.intent.appliedOwnerId, 'launch:L');
  assert.equal(h.writesNeeded(), 0);
  assert.deepEqual(h.publication.map(event => event.channel), ['codex:model-effort-intent-applied', 'release-pending']);
  h.observe();
  assert.equal(h.publication.length, 2, 'the same frame/pair must not republish completion');
});

test('a different pair still requires the native picker; a launch card or changed generation cannot settle', () => {
  const changed = harness({ requestedEffort: 'medium' });
  assert.ok(changed.observe());
  assert.equal(changed.writesNeeded(), 1);
  assert.equal(changed.publication.length, 0);
  const card = harness({ observedProof: 'verified-launch-card' });
  card.observe();
  assert.equal(card.intent.appliedOwnerId, 'writer-S');
  const stale = harness({ current: false });
  assert.equal(stale.observe(), null);
  assert.equal(stale.publication.length, 0);
});
