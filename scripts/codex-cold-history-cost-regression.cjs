'use strict';
// Isolated A/B of the actual cold projector and row-window. The negative
// control restores raw-array collection and the unsliced first metadata pass
// in a private module instance. No app, user rollout or production settings.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const rootPath = path.resolve(__dirname, '..');
const modulePath = path.join(rootPath, 'src/main/ipc/codex-data.js');
const sid = '92aa1221-560c-499a-aebe-f74a32980b01';

async function child(control, directory) {
  let source = fs.readFileSync(modulePath, 'utf8');
  if (control === 'before') {
    const original = source;
    source = source.replace("const { prepareHistoryRowWindow } = require('../history-entry-window');",
      'const prepareHistoryRowWindow = async () => undefined;');
    const streamed = `const result = await readJsonlRange(filePath, 0, stat.size - 1, {
        collectRecords: false,
        onRecord: record => feedCodexProjection(cached, [record]),
      });`;
    assert.ok(source.includes(streamed), 'negative control must restore the actual reader path');
    source = source.replace(streamed, `const result = await readJsonlRange(filePath, 0, stat.size - 1);
      await feedCodexProjection(cached, result.records);`);
    assert.notEqual(source, original);
  }
  const loaded = new Module(modulePath, module);
  loaded.filename = modulePath; loaded.paths = Module._nodeModulePaths(path.dirname(modulePath));
  loaded._compile(source, modulePath);
  const api = loaded.exports._api;
  const { dehydrateHistoryEntries } = require('../src/main/history-payload-dehydrate');
  const { applyHistoryRowWindow } = require('../src/main/history-entry-window');
  api.setCodexHistoryProjectorBudgetMb(2048);
  let peakHeap = 0, peakRss = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss);
  };
  const timer = setInterval(sample, 5);
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  await new Promise(resolve => setTimeout(resolve, 10));
  const started = performance.now();
  const hydrate = { radius: 750, alwaysHydrateTail: 200 };
  const result = await api.projectCodexFullHistoryFromFile(sid, '/fixture', { sessionsDir: directory, hydrate });
  assert.equal(result.success, true, result.error);
  const projectedMs = performance.now() - started;
  sample();
  const windowStarted = performance.now();
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: sid, entries: result.entries });
  const window = applyHistoryRowWindow(result.entries, hydrate);
  const windowMs = performance.now() - windowStarted;
  const totalMs = performance.now() - started;
  sample(); await new Promise(resolve => setTimeout(resolve, 10));
  clearInterval(timer); loop.disable();
  const timeline = await api.projectCodexTimelineFromFile(sid, '/fixture', { sessionsDir: directory });
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const sourceHashes = Object.fromEntries([
    'src/main/ipc/codex-data.js', 'src/main/history-entry-window.js',
    'src/main/codex-projection-checkpoint.js', 'src/main/history-payload-dehydrate.js',
    'src/shared/history-action-grammar.cjs',
  ].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(rootPath, file))).digest('hex')]));
  const report = { control, entries: result.entries.length, stubs: window.stubbedCount,
    readBytes: fs.statSync(result.filePath).size, fedRecords: result.fedRecords,
    projectedMs, windowMs, totalMs, loopMaxMs: loop.max / 1e6, loopP99Ms: loop.percentile(99) / 1e6,
    peakHeapMiB: peakHeap / 1024 / 1024, peakRssMiB: peakRss / 1024 / 1024,
    historyHash: hash(window), timelineHash: hash({ entries: timeline.entries, sessionMeta: timeline.sessionMeta }),
    budgetBytes: api.getCodexHistoryProjectorStats().budgetBytes, sourceHashes };
  fs.writeFileSync(path.join(directory, control + '.json'), JSON.stringify(report, null, 2));
}

async function main() {
  if (process.argv[2] === '--child') return child(process.argv[3], process.argv[4]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-cold-history-cost-'));
  const file = path.join(directory, `rollout-2026-09-20T19-00-00-${sid}.jsonl`);
  const fd = fs.openSync(file, 'wx'); let records = 0;
  const write = (type, payload) => {
    fs.writeSync(fd, JSON.stringify({ timestamp: '2026-09-20T19:00:00.000Z', type, payload }) + '\n');
    records++;
  };
  try {
    write('session_meta', { id: sid, cwd: '/fixture' });
    for (let turn = 0; turn < 2000; turn++) {
      write('event_msg', { type: 'user_message', message: 'prompt ' + turn });
      for (let j = 0; j < 3; j++) {
        const call_id = `call-${turn}-${j}`;
        write('response_item', { type: 'function_call', call_id, name: 'exec_command',
          arguments: JSON.stringify({ command: 'node -e "' + 'x'.repeat(2000) + '"' }) });
        write('response_item', { type: 'function_call_output', call_id,
          output: `result ${turn}:${j}\n` + 'z'.repeat(48 * 1024) });
      }
      write('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer ' + turn }] });
      for (let j = 0; j < 8; j++) write('event_msg', {
        type: 'token_count', info: { total_token_usage: { total_tokens: turn * 100 + j } },
      });
    }
  } finally { fs.closeSync(fd); }
  const fileBytes = fs.statSync(file).size;
  try {
    for (const control of ['before', 'after']) {
      const out = fs.openSync(path.join(directory, control + '.log'), 'w');
      let result;
      try { result = spawnSync(process.execPath, [__filename, '--child', control, directory], { stdio: ['ignore', out, out], timeout: 60000 }); }
      finally { fs.closeSync(out); }
      assert.equal(result.status, 0, control + ': ' + (result.error?.message || 'read ' + path.join(directory, control + '.log')));
    }
    const before = JSON.parse(fs.readFileSync(path.join(directory, 'before.json')));
    const after = JSON.parse(fs.readFileSync(path.join(directory, 'after.json')));
    for (const field of ['historyHash', 'timelineHash', 'readBytes', 'fedRecords', 'entries', 'stubs', 'budgetBytes']) {
      assert.equal(after[field], before[field], 'preserve ' + field);
    }
    assert.deepEqual(after.sourceHashes, before.sourceHashes, 'shared source must not change between A/B children');
    assert.ok(after.loopMaxMs < before.loopMaxMs / 4, 'remove the long unsliced first pass');
    const report = { proof: 'isolated-node-cold-history-not-native-input', directory, fileBytes, records, before, after };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { fs.unlinkSync(file); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
