'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./main.js'), 'utf8');
const start = source.indexOf('async function inspectCodexWriterProcessProofInner(');
const end = source.indexOf('  const descriptorProof = resolveCompleteCodexWriterProof(', start);
assert.ok(start >= 0 && end > start);

async function probe({ slow = true, failure = false, status = 'found' } = {}) {
  let clock = 1000;
  const calls = [], logs = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return clock; } },
    fs: { existsSync: () => true },
    console: { log: line => logs.push(line) },
    terminalCommandState: new Map([['T', { runSeq: 2 }]]),
    AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown', ABSENT: 'absent' },
    inspectAiDescendantProcessesByTab: async () => {
      clock += slow ? 900 : 1;
      return { status, matches: [{ pid: 10 }, { pid: 11 }] };
    },
    codexDescriptorProbeGate: { run: async work => { clock += slow ? 700 : 1; return work(); } },
    execFileAsync: async (command, args, options) => {
      calls.push({ command, args, options });
      clock += slow ? 100 : 1;
      if (failure) throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' });
      return { stdout: 'p' + args[2] };
    },
    isRetryableCodexDescriptorProbeTimeout: () => true,
  });
  // Run the real process/descriptor stage only; no disk/provider proof is mocked
  // into authorization. The added timing must not change its outputs or calls.
  vm.runInContext(source.slice(start, end) + '\nreturn { reports, failures, checked };\n}\n'
    + 'globalThis.probe = inspectCodexWriterProcessProofInner;', context);
  return { result: await context.probe('T'), calls, logs };
}

test('writer diagnostics separate process search, descriptor queue and OS execution', async () => {
  const h = await probe();
  assert.equal(h.result.checked, 2);
  assert.equal(h.result.reports.length, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.timeout, 1500, 'diagnostics do not increase deadlines');
  assert.ok(h.logs[0].includes('lookupMs=900 descriptorQueueMs=1400 descriptorExecMs=200 pids=2 failures=0'));
  assert.ok(!h.logs[0].includes('fixture') && !h.logs[0].includes('stdout'));
});

test('failed descriptor work keeps its failure while the diagnostic still measures it', async () => {
  const h = await probe({ failure: true });
  assert.equal(h.result.failures.length, 2);
  assert.equal(h.result.checked, 0);
  assert.ok(h.logs[0].includes('descriptorExecMs=200 pids=2 failures=2'));
});

test('fast observations and absent processes do not add a hot-path log or descriptor work', async () => {
  assert.equal((await probe({ slow: false })).logs.length, 0);
  const absent = await probe({ status: 'absent' });
  assert.equal(absent.result.status, 'absent');
  assert.equal(absent.calls.length, 0);
});
