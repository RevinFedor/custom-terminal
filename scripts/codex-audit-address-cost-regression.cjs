'use strict';
// Real ~630 MiB synthetic rollout, separate baseline/current heaps. No app,
// production sessions, SQLite, provider command, renderer or account is used.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const MiB = 1024 * 1024, SID = 'volume-audit-session';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(file) {
  const fd = fs.openSync(file, 'wx'); let offset = 0, lines = 0;
  const write = text => { offset += fs.writeSync(fd, text); lines++; };
  try {
    write(JSON.stringify({ type: 'session_meta', payload: { id: SID } }) + '\n');
    // Tens of thousands of real large payloads, not a sparse extent. They
    // force the old caller to allocate its full raw cache merely for __line.
    const body = 'x'.repeat(10 * 1024);
    for (let i = 0; i < 64000; i++) write(JSON.stringify({ type: 'response_item', payload: {
      type: i % 2 ? 'function_call_output' : 'message', role: 'assistant', output: body } }) + '\n');
    const recordByteOffset = offset, physicalLine = lines;
    const record = { type: 'event_msg', timestamp: '2026-09-19T16:47:17.123Z', payload: { type: 'user_message', message: 'exact final prompt 🦉' } };
    write(JSON.stringify(record) + '\n');
    return { file, recordByteOffset, physicalLine, record };
  } finally { fs.closeSync(fd); }
}

async function measure(mode, meta) {
  const api = require('../src/main/ipc/codex-data')._api;
  const { createCodexAuditAddressReader } = require('../src/main/codex-audit-address-reader');
  const { resolveCodexAuditAddress } = require('../src/main/codex-audit-address');
  const { promptAuditFingerprint: hashText } = require('../src/main/prompt-audit-fingerprint');
  const audit = { sourceIdentity: `codex-user-source-${SID}-${meta.recordByteOffset}`, recordByteOffset: meta.recordByteOffset,
    auditTimestamp: meta.record.timestamp, actualHash: hashText(meta.record.payload.message), actualLen: meta.record.payload.message.length };
  let peakHeap = 0, peakRss = 0;
  const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
  global.gc?.(); sample(); const beforeHeap = process.memoryUsage().heapUsed;
  const timer = setInterval(sample, 5), lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable(); await delay(20); const start = performance.now();
  let result, counters, coldMs, warm = null, append = null;
  if (mode === 'baseline') {
    const rows = await api.parseJsonlFile(meta.file);
    const target = rows.find(row => row.__byteOffset === meta.recordByteOffset);
    assert.equal(rows.find(row => row.type === 'session_meta').payload.id, SID);
    assert.equal(hashText(target.payload.message), audit.actualHash);
    result = { entryUuid: `codex-user-${SID}-${target.__line}`, sourceIdentity: audit.sourceIdentity, recordByteOffset: meta.recordByteOffset };
    counters = { scanBytes: fs.statSync(meta.file).size, bodyBytes: 0, recordsParsed: rows.length };
    coldMs = performance.now() - start;
  } else {
    const reader = createCodexAuditAddressReader({ readJsonlRange: api.readJsonlRange, log: {} });
    const args = { filePath: meta.file, sessionId: SID, audit, readAddress: reader.read, hashText };
    result = await resolveCodexAuditAddress(args); counters = reader.stats(); sample();
    coldMs = performance.now() - start;
    const ws = performance.now(); assert.deepEqual(await resolveCodexAuditAddress(args), result);
    const next = reader.stats();
    warm = { ms: performance.now() - ws, scanBytes: next.scanBytes - counters.scanBytes,
      bodyBytes: next.bodyBytes - counters.bodyBytes, verificationBytes: next.verificationBytes - counters.verificationBytes };
    // A changed source is not assumed append-only. Recount bytes cheaply;
    // keep the original exact source address, with no heavy raw records.
    fs.appendFileSync(meta.file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
    const as = performance.now(); assert.deepEqual(await resolveCodexAuditAddress(args), result);
    const last = reader.stats(); append = { ms: performance.now() - as,
      scanBytes: last.scanBytes - next.scanBytes, bodyBytes: last.bodyBytes - next.bodyBytes,
      recordsParsed: last.recordsParsed - next.recordsParsed };
  }
  sample(); const elapsedMs = performance.now() - start;
  await delay(20); sample(); clearInterval(timer); lag.disable();
  return { mode, result, counters, coldMs, elapsedMs, warm, append,
    heapBeforeMiB: beforeHeap / MiB, heapPeakMiB: peakHeap / MiB, rssPeakMiB: peakRss / MiB,
    eventLoopMaxMs: lag.max / 1e6, eventLoopP99Ms: lag.percentile(99) / 1e6,
    rawCacheBytes: api.getCodexJsonlCacheStats().rawBytes };
}

if (process.argv[2] === '--child') {
  measure(process.argv[3], JSON.parse(fs.readFileSync(process.argv[4], 'utf8')))
    .then(result => console.log('RESULT ' + JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-audit-cost-'));
  const meta = fixture(path.join(dir, 'rollout.jsonl')), metaFile = path.join(dir, 'fixture.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  const report = { artifacts: dir, fileBytes: fs.statSync(meta.file).size, physicalLine: meta.physicalLine, runtime: process.versions, runs: [] };
  try {
    for (const mode of ['baseline', 'current']) {
      const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', mode, metaFile], { encoding: 'utf8', maxBuffer: 4 * MiB });
      fs.writeFileSync(path.join(dir, mode + '.log'), child.stdout + child.stderr);
      assert.equal(child.status, 0, child.stderr);
      report.runs.push(JSON.parse(child.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7)));
    }
    assert.deepEqual(report.runs[0].result, report.runs[1].result);
    assert.equal(report.runs[1].rawCacheBytes, 0);
    assert.equal(report.runs[1].counters.recordsParsed, 1);
    assert.equal(report.runs[1].warm.scanBytes, 0);
    assert.ok(report.runs[1].warm.bodyBytes < 4096);
    assert.ok(report.runs[1].heapPeakMiB < report.runs[0].heapPeakMiB / 4);
    report.status = 'pass';
  } catch (error) { report.status = 'fail'; report.error = error.stack; process.exitCode = 1; }
  finally { fs.unlinkSync(meta.file); fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
}
