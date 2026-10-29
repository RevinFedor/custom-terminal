'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const causalModule = require('./perf-causal-context');
const { cleanCausalRecord } = require('./perf-causal-journal');
const { createReadControl } = require('./history-read-control');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('cold init phases separate joined admission/tail waits, preserve source guards and stay scalar', async t => {
  // One finite Source control, no Electron, profiler, native sampler or real
  // decompressor. Fake clock/thread counters make await-vs-CPU assertions causal.
  let abs = 1000, threadMs = 0;
  const packets = [];
  const causal = causalModule.createCausalContext({ now: () => abs, boot: 'init-test', pid: 1 });
  causal.configure({ enabled: true, sink: packet => { packets.push(packet); return true; }, metrics: {
    read: () => threadMs,
    between: before => ({ threadCpuMs: threadMs - before, threadCpuSource: 'test-thread-clock' }),
  } });
  const originalCausal = causalModule.causal;
  causalModule.causal = causal;
  const { SessionTranscriptService } = require('./session-transcript-service');
  const { CodexRolloutReadViews } = require('./codex-rollout-read-views');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'source-init-phase-'));
  const source = path.join(root, 'rollout-private-source.jsonl.zst');
  const originalBytes = Buffer.from('encoded-fixture');
  const decoded = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { total_tokens: 140 }, model_context_window: 1000 } } }) + '\n'
    + JSON.stringify({ privateText: 'NEVER_LOG_THIS_CONTENT' }) + '\n');
  await fs.promises.writeFile(source, originalBytes);
  const admitted = deferred(), allowAdmission = deferred(), tailEntered = deferred(), allowTail = deferred();
  const cancelEntered = deferred();
  let admits = 0, decodes = 0, finds = 0, tailOpens = 0;
  const views = new CodexRolloutReadViews({ tempRoot: root, diskFloorBytes: 0,
    freeBytes: async () => 64 * 1024 * 1024,
    admitRead: async () => {
      if (++admits === 1) { admitted.resolve(); await allowAdmission.promise; }
    },
    decoder: async (physical, target, { signal }) => {
      decodes++;
      if (physical.includes('cancel-source')) {
        cancelEntered.resolve();
        await new Promise((_, reject) => signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('cancelled'), { code: 'HISTORY_READ_CONSUMER_REVOKED' })), { once: true }));
      }
      await fs.promises.writeFile(target, decoded);
      if (physical.includes('changed-source')) await fs.promises.writeFile(physical, 'changed-source-witness');
      abs += 80; threadMs += 2;
      return decoded.length;
    },
  });
  const control = createReadControl();
  const originalOpen = fs.promises.open;
  fs.promises.open = async function(filePath, ...args) {
    if (args[0] === 'r' && typeof filePath === 'string' && filePath.startsWith(views.ownedRoot + path.sep)) {
      if (++tailOpens === 1) { tailEntered.resolve(); await allowTail.promise; }
    }
    return originalOpen.call(this, filePath, ...args);
  };
  t.after(async () => {
    fs.promises.open = originalOpen;
    causalModule.causal = originalCausal;
    allowAdmission.resolve(); allowTail.resolve(); control.finish();
    await views.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const observed = [];
  const serviceFor = (find, observer = null) => new SessionTranscriptService({ getMainWindow: () => null,
    webBroadcast: null, claudeData: null, codexData: { _api: { findCodexSessionFile: find } },
    onCodexContextObservation: observer, idleGraceMs: 0 });
  const service = serviceFor(async () => { finds++; return views.prepare(source, { control }); }, detail => {
    observed.push(detail); abs += 60; threadMs += 3;
  });
  const input = { key: 'codex:session-a', toolType: 'codex', sessionId: 'session-a', cwd: root };
  const owner = causal.run('ipc:subscribe-owner', {
    actionId: 'action-owner', requestId: 'request-owner', readId: 'read-owner', fileIdentity: 'physical-owner',
  }, () => service._ensureState(input));
  await admitted.promise;
  assert.equal(decodes, 0, 'decode has not started while admission is held');
  const pendingAdmission = causal.snapshot().active.find(x => x.name === 'codex.readview.admit-read');
  assert.equal(pendingAdmission?.state, 'awaiting');
  const attempt = pendingAdmission.initAttemptId;
  assert.ok(attempt);
  assert.equal(pendingAdmission.requestId, 'request-owner');
  assert.equal(pendingAdmission.readId, 'read-owner');
  const joined = causal.run('ipc:subscribe-joined', {
    actionId: 'action-joined', requestId: 'request-joined', readId: 'read-joined', fileIdentity: 'physical-joined',
  }, () => service._ensureState(input));
  const pendingJoin = causal.snapshot().active.find(x => x.name === 'transcript.init.join');
  assert.equal(pendingJoin.initAttemptId, attempt);
  assert.equal(pendingJoin.requestId, 'request-joined');
  assert.equal(pendingJoin.readId, 'read-joined');
  assert.equal(pendingJoin.fileIdentity, 'physical-joined');
  assert.equal(pendingJoin.actionId, 'action-joined', 'a joined waiter keeps its own caller');
  abs += 539000; threadMs += 7000; // Other thread work during the elapsed wait.
  allowAdmission.resolve();
  await tailEntered.promise;
  assert.equal(finds, 1); assert.equal(decodes, 1);
  assert.equal(causal.snapshot().active.find(x => x.name === 'transcript.init.context-tail')?.state, 'awaiting');
  const published = service.sessions.get(input.key);
  assert.ok(published, 'the original publish-before-seed order remains intact');
  assert.equal(await service._ensureState(input), published, 'existing-state lookup does not start/join new work');
  abs += 60000;
  allowTail.resolve();
  const state = await owner;
  assert.equal(await joined, state);
  assert.equal(state, published); assert.equal(state.offset, decoded.length);
  assert.equal(observed.length, 1); assert.ok(Math.abs(observed[0].observation.contextPct - 14) < 1e-10);
  assert.equal(tailOpens, 1); assert.equal(service.sessionInitInflight.size, 0);
  assert.deepEqual(await fs.promises.readFile(source), originalBytes);
  const settle = name => packets.find(p => p.name === name && p.phase === 'settle');
  assert.equal(settle('codex.readview.admit-read').lifetimeMs, 539000);
  assert.equal(settle('codex.readview.decode').lifetimeMs, 80);
  assert.equal(settle('codex.readview.decode').mode, 'zstd-injected');
  assert.equal(settle('transcript.init.context-tail').lifetimeMs, 60000);
  assert.equal(settle('transcript.init.context-tail').framingCopiedBytes, 0);
  assert.equal(settle('transcript.init.context-tail').framingMaxCarryBlocks, 0);
  for (const name of ['codex.readview.admit-read', 'codex.readview.decode', 'transcript.init.context-tail']) {
    const span = settle(name);
    assert.equal(span.syncMs, 0); assert.equal(span.returnedPromise, true);
    assert.equal(Object.hasOwn(span, 'threadCpuMs'), false, 'await-only phases do not claim CPU');
    assert.equal(span.initAttemptId, attempt); assert.equal(span.sessionId, 'session-a');
    assert.equal(span.requestId, 'request-owner'); assert.equal(span.readId, 'read-owner');
    assert.equal(span.caller, 'transcript.init.codex');
    assert.equal(span.cwdHash, 'sha256:' + createHash('sha256').update(root).digest('hex').slice(0, 24));
    assert.equal(span.fileIdentity, 'physical-owner');
  }
  assert.equal(settle('transcript.init.resolve').mode, 'zstd-readview');
  assert.equal(settle('codex.readview.prepare').sourceBytes, originalBytes.length);
  assert.equal(settle('codex.readview.prepare').bytes, decoded.length);
  assert.equal(settle('codex.readview.prepare').recordsBefore, 0);
  assert.equal(settle('codex.readview.prepare').recordsAfter, 1);
  assert.equal(settle('transcript.init.context-seed').bytes, decoded.length);
  const publication = causal.snapshot().completedWork.find(x => x.siteId === 'transcript.init.context-publish');
  assert.equal(publication.wallMs, 60); assert.equal(publication.threadCpuMs, 3);
  assert.equal(publication.context.initAttemptId, attempt);
  assert.equal(publication.context.requestId, 'request-owner');
  assert.equal(publication.context.readId, 'read-owner');
  assert.equal(publication.context.fileIdentity, 'physical-owner');
  assert.equal(publication.context.cwdHash, 'sha256:' + createHash('sha256').update(root).digest('hex').slice(0, 24));
  assert.match(settle('transcript.init').cpuCoverage, /async lifetime is not exclusive CPU/);

  // Ordinary read-view consumers do not acquire another diagnostic scope.
  const beforeUnscoped = packets.length;
  await views.prepare(source, { control });
  assert.equal(packets.length, beforeUnscoped); assert.equal(decodes, 1);
  // A reused service path remains an access-only memo hit, not a rediscovery.
  service.sessions.delete(input.key);
  await service._ensureState(input);
  assert.equal(finds, 1); assert.equal(decodes, 1); assert.equal(observed.length, 2);

  const unavailable = Object.assign(new Error('private unavailable detail'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  const failed = serviceFor(async () => { throw unavailable; });
  await assert.rejects(failed._ensureState({ ...input, key: 'failed', sessionId: 'failed' }), error => error === unavailable);
  assert.equal(failed.sessionInitInflight.size, 0); assert.equal(failed.sessions.size, 0);
  const changingSource = path.join(root, 'rollout-changed-source.jsonl.zst');
  await fs.promises.writeFile(changingSource, originalBytes);
  const changed = serviceFor(() => views.prepare(changingSource, { control }));
  await assert.rejects(changed._ensureState({ ...input, key: 'changed', sessionId: 'changed' }), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  assert.equal(changed.sessions.size, 0); assert.equal(changed.sessionInitInflight.size, 0);
  assert.equal(await fs.promises.readFile(changingSource, 'utf8'), 'changed-source-witness');

  const cancelSource = path.join(root, 'rollout-cancel-source.jsonl.zst');
  await fs.promises.writeFile(cancelSource, originalBytes);
  const abort = new AbortController(), cancellingControl = createReadControl({ signal: abort.signal });
  const cancelled = serviceFor(() => views.prepare(cancelSource, { control: cancellingControl }));
  const cancellation = assert.rejects(cancelled._ensureState({ ...input, key: 'cancelled', sessionId: 'cancelled' }),
    { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  await cancelEntered.promise; abort.abort(); await cancellation;
  await views.admission.acquire().then(release => release());
  cancellingControl.finish();
  assert.equal(cancelled.sessions.size, 0); assert.equal(cancelled.sessionInitInflight.size, 0);
  assert.deepEqual(await fs.promises.readFile(cancelSource), originalBytes);
  assert.equal(decodes, 3, 'one real factory attempt per source, no diagnostic retry/decode');

  const unknownFile = path.join(root, 'unknown.jsonl');
  await fs.promises.writeFile(unknownFile, '{"unrelated":true}\n');
  let unknownPublished = 0;
  const unknown = serviceFor(async () => ({ filePath: unknownFile, representation: 'jsonl' }), () => { unknownPublished++; });
  await unknown._ensureState({ ...input, key: 'unknown', sessionId: 'unknown' });
  assert.equal(unknownPublished, 0, 'an unknown bounded tail still does not publish a value');
  causal.configure({ enabled: false });
  const count = packets.length;
  const disabled = serviceFor(async () => ({ filePath: unknownFile, representation: 'jsonl' }));
  assert.equal((await disabled._ensureState({ ...input, key: 'disabled' })).filePath, unknownFile);
  assert.equal(packets.length, count);
  assert.equal(causal.snapshot().active.length, 0);

  for (const packet of packets) {
    const cleaned = cleanCausalRecord(packet, { pid: 1, kind: 'main' }, abs);
    assert.ok(cleaned); assert.ok(Buffer.byteLength(JSON.stringify(cleaned)) <= 2048);
    if (packet.initAttemptId) assert.equal(cleaned.initAttemptId, packet.initAttemptId);
    if (packet.cwdHash) assert.equal(cleaned.cwdHash, packet.cwdHash);
    if (packet.framingCopiedBytes !== undefined) assert.equal(cleaned.framingCopiedBytes, packet.framingCopiedBytes);
    assert.ok(!JSON.stringify(cleaned).includes(root));
    assert.ok(!JSON.stringify(cleaned).includes('NEVER_LOG_THIS_CONTENT'));
    assert.ok(!JSON.stringify(cleaned).includes('private unavailable detail'));
  }
});
