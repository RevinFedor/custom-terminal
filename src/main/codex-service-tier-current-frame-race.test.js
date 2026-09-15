'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { codexServiceTierProofIdentityMatches } = require('./codex-runtime-contract');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual main declaration ' + name);
  return node.getText(ast);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function identity(ownerId, generation = 'G1', runSeq = 2, extra = {}) {
  return { success: true, ownerId, terminalToken: extra.terminalToken || 'TERM',
    terminalLifecycleGeneration: generation, terminalRunSeq: runSeq,
    generationMode: extra.launchId ? 'launch' : 'terminal-run',
    generationId: extra.launchId || generation, launchId: extra.launchId || null };
}

function harness(initialIdentity) {
  let current = initialIdentity;
  let writer = null;
  const entered = deferred();
  const release = deferred();
  const ctx = vm.createContext({
    codexServiceTierProofIdentityMatches,
    getCurrentCodexServiceTierProofIdentity: () => current,
    getCodexWriterProofSnapshot: () => writer,
    inspectCurrentCodexMcpStartupScreen: async () => {
      entered.resolve();
      await release.promise;
      return { success: true, currentFrameText: 'gpt-6-astra max · Fast mode',
        inspected: { ready: true, blockers: [] } };
    },
  });
  vm.runInContext(declaration('resolveCodexServiceTierResultIdentity'), ctx);
  vm.runInContext(declaration('inspectCurrentCodexMcpStartupScreenWithTierIdentity'), ctx);
  return { ctx, entered, release,
    read: () => ctx.inspectCurrentCodexMcpStartupScreenWithTierIdentity('T', 'fixture'),
    setCurrent(value) { current = value; },
    setWriter(value) { writer = value; } };
}

test('current-frame service-tier read keeps the stable writer identity', async () => {
  const sourceIdentity = identity('writer-A');
  const h = harness(sourceIdentity);
  const pending = h.read();
  await h.entered.promise;
  h.release.resolve();
  const result = await pending;
  assert.equal(result.serviceTierObservationSuperseded, false);
  assert.deepEqual(result.serviceTierSourceIdentity, sourceIdentity);
  assert.deepEqual(result.serviceTierResultIdentity, sourceIdentity);
});

test('delayed G1 footer cannot acquire the replacement G2 writer identity', async () => {
  const h = harness(identity('writer-A', 'G1', 2));
  const pending = h.read();
  await h.entered.promise;
  h.setCurrent(identity('writer-B', 'G2', 3));
  h.release.resolve();
  const result = await pending;
  assert.equal(result.success, true, 'the old frame remains available only for diagnostics');
  assert.equal(result.serviceTierObservationSuperseded, true);
  assert.equal(result.serviceTierSourceIdentity.ownerId, 'writer-A');
  assert.equal(result.serviceTierResultIdentity, null);
});

test('same terminal/run launch may strengthen only to its exact first writer', async () => {
  const launch = identity('launch:L', 'G1', 2, { launchId: 'L' });
  const writerIdentity = identity('writer-A', 'G1', 2);
  const h = harness(launch);
  const pending = h.read();
  await h.entered.promise;
  h.setWriter({ sessionId: 'writer-A', launchId: 'L', terminalToken: 'TERM',
    lifecycleGeneration: 'G1', runSeq: 2 });
  h.setCurrent(writerIdentity);
  h.release.resolve();
  const result = await pending;
  assert.equal(result.serviceTierObservationSuperseded, false);
  assert.deepEqual(result.serviceTierResultIdentity, writerIdentity);
});

test('launch handoff rejects a foreign first writer even on the same terminal/run', async () => {
  const launch = identity('launch:L', 'G1', 2, { launchId: 'L' });
  const h = harness(launch);
  const pending = h.read();
  await h.entered.promise;
  h.setWriter({ sessionId: 'writer-B', launchId: 'FOREIGN', terminalToken: 'TERM',
    lifecycleGeneration: 'G1', runSeq: 2 });
  h.setCurrent(identity('writer-B', 'G1', 2));
  h.release.resolve();
  const result = await pending;
  assert.equal(result.serviceTierObservationSuperseded, true);
  assert.equal(result.serviceTierResultIdentity, null);
});
