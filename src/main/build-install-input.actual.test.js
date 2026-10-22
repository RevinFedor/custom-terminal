'use strict';
// Actual Main aggregation and history-input gate. Only runtime reads/PTY leaves
// are controlled; no Electron app, physical input or provider is started.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'computeInstallInputBlockers');
assert.ok(fn);
function harness({ ai = ['753'], read = async () => ({ coherent: true, status: 'active', processStatus: 'found', inputReady: true }) } = {}) {
  const terminals = new Map([['753', {}], ['shell', {}]]), pasteInflight = new Set();
  const historyMutationInput = createHistoryMutationInputGate();
  const context = vm.createContext({ terminals, pasteInflight, historyMutationInput,
    resolveAiToolTypeForTab: tabId => ai.includes(tabId) ? 'codex' : 'terminal', readMainPublicRuntimeSnapshot: read });
  vm.runInContext(fn.getText(ast) + ';globalThis.read = computeInstallInputBlockers;', context);
  return { terminals, pasteInflight, gate: historyMutationInput, read: () => context.read() };
}
const delayed = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const active = { coherent: true, status: 'active', processStatus: 'found', inputReady: true };

test('actual Main allows ready idle and proved absent AI, including the source tab', async () => {
  for (const snapshot of [active, { coherent: true, status: 'inactive', processStatus: 'absent', inputReady: false }]) {
    assert.equal((await harness({ read: async () => snapshot }).read()).length, 0);
  }
});

test('actual Main retains source starting/stopping/busy, unknown and not-ready input guards', async () => {
  for (const patch of [{ status: 'starting' }, { status: 'stopping' }, { status: 'busy' },
    { coherent: false }, { processStatus: 'unknown' }, { inputReady: false }, { status: 'unrecognized' }]) {
    const rows = await harness({ read: async () => ({ ...active, ...patch }) }).read();
    assert.ok(rows.some(row => row.tabId === '753'), JSON.stringify(patch));
  }
  assert.ok((await harness({ read: async () => { throw Error('lookup failed'); } }).read()).some(row => row.status === 'runtime-unknown'));
});

test('actual Main preserves a real history/send gate even when its tab has no current PTY', async () => {
  const h = harness(), release = h.gate.claimSend('restored-source');
  assert.ok((await h.read()).some(row => row.tabId === 'restored-source' && row.status === 'history-input-reservation'));
  release(); assert.equal((await h.read()).length, 0);
});

test('actual Main sees shell paste that begins while another tab runtime read is awaiting', async () => {
  const pending = delayed(); const h = harness({ read: () => pending.promise });
  const work = h.read(); h.pasteInflight.add(h.terminals.get('shell')); pending.resolve(active);
  assert.ok((await work).some(row => row.tabId === 'shell' && row.status === 'physical-input'),
    'final aggregate check must cover ALL physical slots after the last await');
});

test('actual Main treats a replaced same-key PTY during another read as a changed cohort', async () => {
  const pending = delayed(); const h = harness({ read: () => pending.promise });
  const work = h.read(); h.terminals.set('shell', {}); pending.resolve(active);
  assert.ok((await work).some(row => row.status === 'runtime-membership-changed'),
    'equal key/count does not prove the same physical terminals');
});
