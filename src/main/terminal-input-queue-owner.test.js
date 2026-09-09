'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const inputRules = require('./pty-input-ownership');
const main = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const slice = (first, end) => {
  const start = main.indexOf(first), stop = main.indexOf(end, start + first.length);
  assert.ok(start >= 0 && stop > start, first);
  return main.slice(start, stop);
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const writes = [], reports = [];
  const A = { pid: 101, write: data => writes.push({ terminal: 'A', data }) };
  const B = { pid: 202, write: data => writes.push({ terminal: 'B', data }) };
  const context = {
    ...inputRules, Buffer, console: { log() {}, warn() {}, error() {} },
    nodePerformance: { now: () => 1 }, terminals: new Map([['T', A]]),
    terminalCommandState: new Map([['T', { isRunning: false, runSeq: 1 }]]),
    codexLateMcpProofPending: new Map(), aiStoppingTabs: new Map(),
    clearCodexLateMcpProofPending() {},
    deferredTerminalInputOwnerIncidents: new WeakSet(),
    resolveAiToolTypeForTab: () => 'claude',
    getTerminalLifecycleGeneration: () => 'generation-A',
    reportTerminalIncident: (key, payload) => { reports.push({ key, payload }); return Promise.resolve({ success: true }); },
  };
  vm.createContext(context);
  // Execute the real shared lock and the complete admission/queue prefix of
  // handleTerminalInput. The unrelated key interpretation tail is represented
  // by its real pass-through write, not a simulated target-selection policy.
  vm.runInContext(slice('const pasteInflight = new WeakMap();', 'function markActivePtySubmit(')
    + '\n' + slice('async function handleTerminalInput(', '  // Revisions describe bytes')
    + '\nterm.write(data);\n}', context);
  const queued = async (data, operation = {}) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const prior = { kind: 'safe-paste', source: 'fixture', submitted: false, ...operation };
    const holding = context.withPtyWriteLock(A, () => gate, prior);
    const pending = context.handleTerminalInput({}, 'T', data, { xtermInputOrigin: 'user' });
    await tick();
    return { prior, pending, release: async () => { release(); await holding; await pending; } };
  };
  return { context, A, B, writes, reports, queued };
}

for (const data of ['queued text', '\x1b', '\x1b[200~large\n\ntext\x1b[201~']) {
  test('queued raw input is never retargeted to a replacement PTY: ' + JSON.stringify(data), async () => {
    const h = harness(), waiting = await h.queued(data);
    assert.deepEqual(h.writes, []);
    h.context.terminals.set('T', h.B);
    await waiting.release();
    assert.deepEqual(h.writes, []);
    assert.equal(h.reports[0]?.payload.incidentReason, 'raw-input-terminal-replaced');
  });
}

test('unchanged physical PTY preserves queued text even when its shell run advances', async () => {
  const h = harness(), waiting = await h.queued('next input');
  h.context.terminalCommandState.get('T').runSeq += 1;
  await waiting.release();
  assert.deepEqual(h.writes, [{ terminal: 'A', data: 'next input' }]);
  assert.deepEqual(h.reports, []);
});

test('ordinary native Escape in the same PTY remains allowed', async () => {
  const h = harness(), waiting = await h.queued('\x1b');
  await waiting.release();
  assert.deepEqual(h.writes, [{ terminal: 'A', data: '\x1b' }]);
});

test('a submitted preceding paste still suppresses a redundant manual Enter', async () => {
  const h = harness(), waiting = await h.queued('\r');
  waiting.prior.submitted = true;
  await waiting.release();
  assert.deepEqual(h.writes, []);
});

test('protocol replies and native picker takeover do not wait behind programmatic input', async () => {
  const h = harness(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const holding = h.context.withPtyWriteLock(h.A, () => gate, { kind: 'picker', manualInputYields: true });
  await tick();
  await h.context.handleTerminalInput({}, 'T', '\x1b[A', { xtermInputOrigin: 'user' });
  await h.context.handleTerminalInput({}, 'T', '\x1b[1;1R', { xtermInputOrigin: 'terminal-response' });
  assert.equal(h.writes.length, 2);
  release(); await holding;
});

test('diagnostic failure cannot redirect or repeat obsolete input', async () => {
  const h = harness(), waiting = await h.queued('not for B');
  h.context.terminals.set('T', h.B);
  h.context.reportTerminalIncident = () => { throw Error('diagnostic unavailable'); };
  await waiting.release();
  assert.deepEqual(h.writes, []);
});
