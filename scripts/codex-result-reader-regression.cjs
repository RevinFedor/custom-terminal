#!/usr/bin/env node
'use strict';
// Real byte-volume regression with synthetic rollouts, no app/DB/CLI/renderer.
// A low-priority standalone Node process owns and removes only its fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { _api } = require('../src/main/ipc/codex-data');
const { createCodexResultReader } = require('../src/main/codex-result-reader');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-volume-'));
const result = { artifact: dir, startedAt: new Date().toISOString(), sourceHashes: {}, status: 'running' };
for (const file of ['src/main/codex-result-reader.js', 'src/main/codex-result-text.js', 'src/main/ipc/codex-data.js']) {
  result.sourceHashes[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
}
const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
const message = text => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const line = record => JSON.stringify(record) + '\n';
const sizes = (process.env.NOTED_RESULT_FIXTURE_MIB || '504,275,56').split(',').map(Number);
const iterations = Number(process.env.NOTED_RESULT_BUSY_WAKES || 1000);
const idless = process.env.NOTED_RESULT_IDLESS === '1';
const unbound = idless || process.env.NOTED_RESULT_UNBOUND === '1';
result.proofMode = idless ? 'legacy-idless' : unbound ? 'unbound-bootstrap' : 'known-execution';
const files = new Map();
const reader = createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
  createTimelineProjector: _api.createCodexTimelineProjector, buildResult: _api.buildCodexProviderTurnAssistantResult,
  extractText: _api.extractTextContent, userIdentity: _api.getCodexUserRecordIdentity,
  isCompactPayload: _api.isCompactPayload, extractReasoning: _api.extractReasoning,
  findExecutionContext: _api.findCodexPromptExecutionContext,
  collectLegacy: _api.collectCodexTurnAssistantBlocks, log: { log() {} } });
const resolver = async ({ sessionId }) => {
  const f = files.get(sessionId), stat = await fs.promises.stat(f.file);
  return { success: true, sessionId, revisionKey: f.file,
    sourceSnapshot: { filePath: f.file, sessionId, size: stat.size, mtimeMs: stat.mtimeMs },
    segments: [{ filePath: f.file, physicalSessionId: sessionId, fromByte: 0, toByte: stat.size, startLine: 0, frozen: false }] };
};
const load = (sessionId, options = {}) => {
  const f = files.get(sessionId);
  return reader.load({ sessionId, cwd: dir, resolveSource: resolver, maxChars: 100000,
    proof: { ...(unbound ? {} : { targetExecutionContext: { provider: 'codex', sessionId, turnId: 'target', generation: 7 } }),
      promptUserUuid: `codex-user-${sessionId}-${f.promptLine}` }, ...options });
};
const delay = monitorEventLoopDelay({ resolution: 10 });
let memoryTimer;
async function run() {
  const largeTool = line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture', output: 'X'.repeat(256 * 1024) } });
  for (let i = 0; i < sizes.length; i++) {
    const sessionId = 'fixture-' + i, file = path.join(dir, sessionId + '.jsonl');
    const fd = fs.openSync(file, 'wx');
    let bytes = 0, lines = 0, turn = 0;
    const write = text => { fs.writeSync(fd, text); bytes += Buffer.byteLength(text); lines += text.split('\n').length - 1; };
    while (bytes < sizes[i] * 1024 * 1024) {
      const id = 'old-' + turn++;
      write(line(event('task_started', idless ? {} : { turn_id: id })) + line(event('user_message', { message: 'past ' + id })));
      for (let tool = 0; tool < 4; tool++) write(largeTool);
      write(line(message('old result')) + line(event('task_complete', { ...(idless ? {} : { turn_id: id }), last_agent_message: 'old result' })));
    }
    write(line(event('task_started', idless ? {} : { turn_id: 'target' })));
    const promptLine = lines;
    write(line(event('user_message', { message: 'current work' })) + line(message('working')));
    fs.closeSync(fd); files.set(sessionId, { file, promptLine, bytes });
  }
  result.fixtures = [...files].map(([sessionId, f]) => ({ sessionId, bytes: f.bytes, promptLine: f.promptLine }));
  result.peakHeapBytes = 0;
  memoryTimer = setInterval(() => { result.peakHeapBytes = Math.max(result.peakHeapBytes, process.memoryUsage().heapUsed); }, 20);
  delay.enable();
  const initialAt = performance.now();
  for (const id of files.keys()) {
    const found = await load(id); assert.equal(found.success, true, JSON.stringify(found)); assert.equal(found.complete, false);
  }
  result.bootstrapMs = performance.now() - initialAt;
  const before = reader.stats(), hotAt = performance.now(); let appended = 0;
  const ids = [...files.keys()];
  for (let i = 0; i < iterations; i++) {
    const id = ids[i % ids.length], f = files.get(id);
    const text = line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'new-' + i, output: 'x'.repeat(4096) } });
    fs.appendFileSync(f.file, text); appended += Buffer.byteLength(text);
    const found = await load(id); assert.equal(found.success, true, JSON.stringify(found));
    assert.equal(found.complete, false); assert.equal(found.assistantText, 'working');
  }
  const after = reader.stats();
  result.busy = { iterations, elapsedMs: performance.now() - hotAt, appendedBytes: appended,
    readBytes: after.bytesRead - before.bytesRead, newBootstrapCount: after.bootstraps - before.bootstraps,
    verificationBytes: after.verificationBytes - before.verificationBytes };
  assert.equal(result.busy.readBytes, appended); assert.equal(result.busy.newBootstrapCount, 0);
  assert.equal(result.busy.verificationBytes, 0);
  const finalAt = performance.now();
  for (const id of ids) {
    fs.appendFileSync(files.get(id).file, line(message('final ' + id)) + line(event('task_complete', { ...(idless ? {} : { turn_id: 'target' }), last_agent_message: 'final ' + id })));
    const found = await load(id, { forceFresh: true });
    assert.equal(found.complete, true); assert.equal(found.assistantText, 'working\n\nfinal ' + id);
  }
  result.finalProofMs = performance.now() - finalAt;
  const verified = reader.stats();
  for (let i = 0; i < 10; i++) for (const id of ids) assert.equal((await load(id, { forceFresh: true })).complete, true);
  assert.equal(reader.stats().bytesRead, verified.bytesRead);
  assert.equal(reader.stats().verificationBytes, verified.verificationBytes);
  assert.equal(_api.getCodexJsonlCacheStats().files, 0);
  assert.equal(reader.stats().views, sizes.length);
  result.reader = reader.stats(); result.rawCache = _api.getCodexJsonlCacheStats();
  result.maxEventLoopDelayMs = delay.max / 1e6;
  result.status = 'pass';
}
run().catch(error => { result.status = 'fail'; result.error = error.stack; process.exitCode = 1; }).finally(() => {
  clearInterval(memoryTimer); delay.disable(); result.finishedAt = new Date().toISOString();
  for (const f of files.values()) fs.rmSync(f.file, { force: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
});
