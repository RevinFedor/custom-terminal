'use strict';

// Isolated ~620 MiB replay, no CLI, app, account, database or real session I/O.
// Run: nice -n 19 node src/main/codex-resume-source.volume.cjs
// Baseline and projected reader get separate processes/heaps and the same file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const SID = '62000000-0000-4000-8000-000000000000';
const MiB = 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function measure(mode, filePath) {
  const api = require('./ipc/codex-data')._api;
  const { createCodexResumeSourceReader } = require('./codex-resume-source');
  const { resolveCodexSourceSettingsProof } = require('./codex-source-settings');
  const stat = fs.statSync(filePath);
  const lag = monitorEventLoopDelay({ resolution: 5 });
  let heapPeak = 0, rssPeak = 0, bytesRead = 0;
  const sample = () => {
    const mem = process.memoryUsage();
    heapPeak = Math.max(heapPeak, mem.heapUsed); rssPeak = Math.max(rssPeak, mem.rss);
  };
  global.gc?.(); sample();
  const heapBefore = process.memoryUsage().heapUsed;
  const timer = setInterval(sample, 5);
  lag.enable(); await delay(20);
  const started = performance.now();
  let proof, materialization, warmMs = null, warmBytes = null;
  if (mode === 'baseline') {
    // Exact old Resume preparation after source discovery, with the same
    // readJsonlRange used by loadSessionRecords's cold records cache.
    const raw = await api.readJsonlRange(filePath, 0, stat.size - 1, {
      onChunk: chunk => { bytesRead += chunk.length; sample(); },
    });
    proof = resolveCodexSourceSettingsProof(raw.records, SID);
    materialization = api.inspectConversationMaterialization(raw.records, SID);
    sample();
  } else {
    const reader = createCodexResumeSourceReader({
      findSessionFile: async () => ({ filePath }), readJsonlRange: api.readJsonlRange,
      createTimelineProjector: api.createCodexTimelineProjector, log: {},
    });
    const result = await reader.load(SID, path.dirname(filePath));
    assert.equal(result.success, true, result.error);
    proof = result.sourceSettingsProof; materialization = result.sourceMaterialization;
    bytesRead = reader.stats().bytesRead; sample();
    const warmStart = performance.now();
    await reader.load(SID, path.dirname(filePath));
    warmMs = performance.now() - warmStart;
    warmBytes = reader.stats().bytesRead - bytesRead;
  }
  const elapsedMs = performance.now() - started;
  sample(); await delay(20); clearInterval(timer); lag.disable();
  const retained = process.memoryUsage().heapUsed;
  return { mode, fileBytes: stat.size, bytesRead, elapsedMs: +elapsedMs.toFixed(1),
    heapBeforeMiB: +(heapBefore / MiB).toFixed(1), heapPeakMiB: +(heapPeak / MiB).toFixed(1),
    heapAfterMiB: +(retained / MiB).toFixed(1), rssPeakMiB: +(rssPeak / MiB).toFixed(1),
    eventLoopMaxMs: +(lag.max / 1e6).toFixed(1), eventLoopP99Ms: +(lag.percentile(99) / 1e6).toFixed(1),
    warmMs: warmMs === null ? null : +warmMs.toFixed(3), warmBytes, proof, materialization };
}

function fixture(filePath) {
  const fd = fs.openSync(filePath, 'wx');
  const write = text => fs.writeSync(fd, text);
  const row = value => write(JSON.stringify(value) + '\n');
  const padding = 'x'.repeat(MiB);
  try {
    row({ type: 'session_meta', payload: { id: SID, cwd: path.dirname(filePath) } });
    row({ type: 'turn_context', payload: { model: 'gpt-5.6-luna', effort: 'max' } });
    // Thousands of genuine paired carriers, plus technical rows. No generated
    // file is sparse; every huge payload is real UTF-8 bytes on disk.
    for (let index = 0; index < 1000; index++) {
      row({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't-' + index } });
      row({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture-' + index }] } });
      row({ type: 'event_msg', payload: { type: 'user_message', message: 'fixture-' + index } });
      row({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't-' + index } });
    }
    for (let index = 0; index < 28000; index++) row({ type: 'event_msg', payload: { type: 'token_count', info: {} } });
    // The latest valid settings are >600 MiB away from EOF, followed by large
    // compaction, tool and assistant payloads in arbitrary key order.
    for (let index = 0; index < 32; index++) {
      write('{"payload":{"replacement_history":[{"type":"message","content":"');
      for (let chunk = 0; chunk < 8; chunk++) write(padding);
      write('"}]},"type":"compacted"}\n');
    }
    for (let index = 0; index < 300; index++) {
      write('{"type":"response_item","payload":{"type":"function_call_output","output":"');
      write(padding); write('"}}\n');
    }
    for (let index = 0; index < 64; index++) {
      write('{"payload":{"content":[{"text":"'); write(padding);
      write('"}],"role":"assistant","type":"message"},"type":"response_item"}\n');
    }
  } finally { fs.closeSync(fd); }
}

async function main() {
  if (process.argv[2] === '--measure') {
    console.log(JSON.stringify(await measure(process.argv[3], process.argv[4]))); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-resume-volume-'));
  const filePath = path.join(root, 'fixture.jsonl');
  try {
    fixture(filePath);
    const results = [];
    for (const mode of ['baseline', 'projected']) {
      const child = spawnSync(process.execPath, ['--expose-gc',
        '--max-old-space-size=' + (mode === 'baseline' ? '3072' : '256'),
        __filename, '--measure', mode, filePath], { encoding: 'utf8', maxBuffer: MiB, timeout: 120000 });
      if (child.status !== 0) throw Error(mode + ' failed: ' + (child.stderr || child.error || child.stdout));
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
      results.push(result); console.log(JSON.stringify(result));
    }
    assert.deepEqual(results[1].proof, results[0].proof);
    assert.deepEqual(results[1].materialization, results[0].materialization);
    assert.equal(results[1].warmBytes, 0);
    console.log(JSON.stringify({ parity: 'PASS', fixtureRemoved: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
