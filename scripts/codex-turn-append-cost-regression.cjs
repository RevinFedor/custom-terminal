#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createHarness } = require('./lib/codex-turn-append-harness.cjs');

async function writeSyntheticRollout(file, targetBytes = 310 * 1024 * 1024) {
  const fd = await fs.promises.open(file, 'w');
  const hash = createHash('sha256'); let offset = 0, records = 0;
  const append = async record => {
    const line = JSON.stringify(record);
    hash.update(String(offset) + ':' + line + '\n');
    const buffer = Buffer.from(line + '\n');
    await fd.writeFile(buffer); offset += buffer.length; records += 1;
  };
  const evt = (type, message) => ({ type: 'event_msg', payload: { type, message } });
  try {
    await append(evt('task_started'));
    await append({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic fork 🧩' }] } });
    const payload = 'тест🧩'.repeat(43690);
    while (offset < targetBytes) {
      // Include a production-sized physical record, not only many tiny rows.
      await append({ type: 'response_item', payload: { type: 'function_call_output', output: records === 4 ? payload.repeat(40) : payload } });
    }
    await append(evt('user_message', 'Synthetic fork 🧩'));
    await append(evt('task_complete'));
    return { bytes: offset, records, digest: hash.digest('hex') };
  } finally { await fd.close(); }
}

async function measure(file, mainPath) {
  const h = createHarness(file, { mainPath });
  let last = performance.now(), loopMaxMs = 0, ticks = 0, peakHeapBytes = 0;
  const timer = setInterval(() => {
    const now = performance.now(); loopMaxMs = Math.max(loopMaxMs, now - last); last = now; ticks += 1;
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  }, 10);
  const started = performance.now();
  await h.scan(); await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(timer);
  return { elapsedMs: performance.now() - started, loopMaxMs, ticks, peakHeapBytes,
    maxRssKiB: process.resourceUsage().maxRSS, records: h.result.records, digest: h.digest(),
    offset: h.state.offset, maxInputBytes: h.result.maxInputBytes,
    stats: h.result.read?.stats, warnings: h.result.warnings };
}

async function main() {
  if (process.argv[2] === '--child') {
    console.log(JSON.stringify(await measure(process.argv[3], process.argv[4] || undefined))); return;
  }
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-codex-append-cost-'));
  const file = path.join(artifact, 'synthetic.jsonl');
  const expected = await writeSyntheticRollout(file);
  const results = { artifact, expected };
  for (const mode of ['baseline', 'bounded']) {
    const baseline = process.env.NOTED_APPEND_BASELINE_MAIN;
    if (mode === 'baseline' && !baseline) continue;
    const child = spawnSync(process.execPath, ['--max-old-space-size=512', __filename, '--child', file, ...(mode === 'baseline' ? [baseline] : [])],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(artifact, mode + '.log'), child.stdout + child.stderr);
    let output = null; try { output = JSON.parse(child.stdout.trim().split('\n').at(-1)); } catch {}
    results[mode] = { exit: child.status, signal: child.signal, oom: /heap out of memory|FatalProcessOutOfMemory|Allocation failed/i.test(child.stderr), output };
    console.log(mode, JSON.stringify(results[mode]));
  }
  const fixed = results.bounded.output;
  results.pass = !!fixed && fixed.digest === expected.digest && fixed.records === expected.records
    && fixed.offset === expected.bytes && fixed.warnings.length === 0
    && fixed.maxInputBytes <= 22 * 1024 * 1024
    && results.bounded.exit === 0;
  fs.writeFileSync(path.join(artifact, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ pass: results.pass, artifact, bytes: expected.bytes, records: expected.records }));
  if (!results.pass) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { writeSyntheticRollout, measure };
