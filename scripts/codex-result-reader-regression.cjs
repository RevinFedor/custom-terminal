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
const { createCodexResultSourceResolver } = require('../src/main/codex-result-source');
const { buildCodexForkLineageManifest } = require('../src/main/session-history-events');
const { hashFileSegment } = require('../src/main/codex-virtual-transcript');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-volume-'));
const result = { artifact: dir, startedAt: new Date().toISOString(), sourceHashes: {}, status: 'running' };
for (const file of ['src/main/codex-result-reader.js', 'src/main/codex-result-text.js',
  'src/main/codex-result-source.js', 'src/main/codex-result-bootstrap.js',
  'src/main/codex-legacy-result-adapter.js', 'src/main/ipc/codex-data.js']) {
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
const lineages = new Map();
const sourceResolver = createCodexResultSourceResolver({ codexApi: {
  findCodexSessionFile: async sessionId => files.has(sessionId) ? { filePath: files.get(sessionId).file } : null,
} });
const reader = createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
  createTimelineProjector: _api.createCodexTimelineProjector, buildResult: _api.buildCodexProviderTurnAssistantResult,
  extractText: _api.extractTextContent, userIdentity: _api.getCodexUserRecordIdentity,
  isCompactPayload: _api.isCompactPayload, extractReasoning: _api.extractReasoning,
  findExecutionContext: _api.findCodexPromptExecutionContext,
  collectLegacy: _api.collectCodexTurnAssistantBlocks, log: { log() {} } });
const resolver = request => sourceResolver.resolve({ ...request,
  lineage: lineages.get(request.sessionId) || { kind: 'physical' } });
const append = (file, text) => {
  fs.appendFileSync(file.file, text); file.lines += text.split('\n').length - 1;
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
    fs.closeSync(fd); files.set(sessionId, { file, promptLine, bytes, lines });
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
    append(f, text); appended += Buffer.byteLength(text);
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
    append(files.get(id), line(message('final ' + id)) + line(event('task_complete', { ...(idless ? {} : { turn_id: 'target' }), last_agent_message: 'final ' + id })));
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

  for (const id of ids) append(files.get(id), line(event('task_started', idless ? {} : { turn_id: 'unrelated-B' }))
    + line(event('user_message', { message: 'unrelated task B' })));
  const waitingBefore = reader.stats(), waitingAt = performance.now();
  for (let i = 0; i < iterations; i++) {
    const id = ids[i % ids.length];
    append(files.get(id), line({ type: 'response_item', payload: { type: 'function_call_output', output: 'b'.repeat(4096) } }));
    const observed = await load(id, { resultReadMode: 'observe' });
    assert.equal(observed.complete, true); assert.equal(observed.sourceVerified, false);
  }
  const waitingAfter = reader.stats();
  result.waitingDescendants = { iterations, elapsedMs: performance.now() - waitingAt,
    readBytes: waitingAfter.bytesRead - waitingBefore.bytesRead,
    verificationBytes: waitingAfter.verificationBytes - waitingBefore.verificationBytes,
    sourceVerificationBytes: waitingAfter.sourceVerificationBytes - waitingBefore.sourceVerificationBytes,
    newBootstrapCount: waitingAfter.bootstraps - waitingBefore.bootstraps };
  assert.equal(result.waitingDescendants.verificationBytes, 0);
  assert.equal(result.waitingDescendants.sourceVerificationBytes, 0);
  assert.equal(result.waitingDescendants.newBootstrapCount, 0);
  for (const id of ids) {
    const settled = await load(id);
    assert.equal(settled.complete, true); assert.equal(settled.sourceVerified, true);
  }

  // Actual virtual resolver: parent growth outside a large frozen range must
  // not hash that range for pending child observations. Final proof still must.
  const parentId = ids[0], parent = files.get(parentId), childId = 'virtual-child';
  const frozenBytes = fs.statSync(parent.file).size;
  const frozenHash = await hashFileSegment(parent.file, 0, frozenBytes);
  const header = line({ type: 'session_meta', payload: { id: childId, forked_from_id: parentId } });
  const child = { file: path.join(dir, childId + '.jsonl'), promptLine: 2, lines: 4 };
  fs.writeFileSync(child.file, header + line(event('task_started', { turn_id: 'child-target' }))
    + line(event('user_message', { message: 'child task' })) + line(message('child working')));
  files.set(childId, child);
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: parentId, childSessionId: childId,
    sourceSegments: [{ physicalSessionId: parentId, fromByte: 0, toByte: frozenBytes,
      startLine: 0, endLine: parent.lines, prefixDigest: frozenHash.sha256 }],
    childTailStart: { byteOffset: Buffer.byteLength(header), line: 1,
      prefixDigest: createHash('sha256').update(header).digest('hex') } });
  assert.ok(manifest);
  lineages.set(childId, { kind: 'virtual', descriptor: { viewOwnerSessionId: childId,
    eventKey: 'volume-child-fork', manifest } });
  const childProof = { targetExecutionContext: { provider: 'codex', sessionId: childId,
    turnId: 'child-target', generation: 9 }, promptUserUuid: 'codex-user-' + childId + '-2' };
  const loadChild = () => reader.load({ sessionId: childId, cwd: dir,
    proof: childProof, resolveSource: resolver, maxChars: 100000 });
  assert.equal((await loadChild()).complete, false);
  const virtualBefore = reader.stats(), virtualAt = performance.now();
  for (let i = 0; i < iterations; i++) {
    append(parent, line({ type: 'response_item', payload: { type: 'function_call_output', output: 'parent append' } }));
    append(child, line({ type: 'response_item', payload: { type: 'function_call_output', output: 'child append' } }));
    assert.equal((await loadChild()).complete, false);
  }
  const virtualAfter = reader.stats();
  result.virtualPending = { ancestorBytes: frozenBytes, iterations,
    elapsedMs: performance.now() - virtualAt,
    verificationBytes: virtualAfter.verificationBytes - virtualBefore.verificationBytes,
    sourceVerificationBytes: virtualAfter.sourceVerificationBytes - virtualBefore.sourceVerificationBytes,
    newBootstrapCount: virtualAfter.bootstraps - virtualBefore.bootstraps };
  assert.equal(result.virtualPending.verificationBytes, 0);
  assert.equal(result.virtualPending.sourceVerificationBytes, 0);
  assert.equal(result.virtualPending.newBootstrapCount, 0);
  append(child, line(event('task_complete', { turn_id: 'child-target', last_agent_message: 'child final' })));
  assert.equal((await loadChild()).sourceVerified, true);
  const finalVirtual = reader.stats();
  assert.ok(finalVirtual.sourceVerificationBytes > virtualAfter.sourceVerificationBytes);
  await loadChild();
  assert.equal(reader.stats().sourceVerificationBytes, finalVirtual.sourceVerificationBytes);
  assert.equal(reader.stats().verificationBytes, finalVirtual.verificationBytes);
  const fd = fs.openSync(parent.file, 'r+'), head = Buffer.alloc(16384);
  fs.readSync(fd, head, 0, head.length, 0);
  const at = head.indexOf('"output":"') + '"output":"'.length;
  assert.ok(at > 10); fs.writeSync(fd, Buffer.from('Y'), 0, 1, at); fs.closeSync(fd);
  const corrupt = await loadChild();
  assert.equal(corrupt.success, false); assert.notEqual(corrupt.sourceVerified, true);
  assert.ok(reader.stats().sourceVerificationBytes > finalVirtual.sourceVerificationBytes);
  result.virtualCorruptionBlocked = true;
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
