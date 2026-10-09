'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCausalContext, safeFields, boundedCallerToken } = require('./perf-causal-context');
const { createCausalJournal } = require('./perf-causal-journal');
const { createThreadCpuReader, createThreadMetrics } = require('./perf-thread-metrics');

test('sync prologue, pending Promise and post-await projection have separate causal spans', async () => {
  let time = 100, release;
  const packets = [], c = createCausalContext({ now: () => time, boot: 'test', pid: 1 });
  c.configure({ enabled: true, sink: p => { packets.push(p); return true; } });
  const value = c.run('ipc:read', { actionId: 'ui-test-1', sessionId: 'session' }, async () => {
    time += 3;
    await new Promise(resolve => { release = resolve; });
    return c.run('project-turns', { snapshotRecords: 88888 }, () => { time += 40; return 7; });
  });
  const awaiting = c.snapshot().active[0];
  assert.equal(awaiting.state, 'awaiting'); assert.equal(awaiting.syncMs, 3);
  time = 1000; release(); assert.equal(await value, 7);
  const child = packets.find(p => p.name === 'project-turns' && p.phase === 'enter');
  assert.equal(child.parentSpanId, awaiting.spanId); assert.equal(child.actionId, 'ui-test-1');
  const end = packets.find(p => p.name === 'ipc:read' && p.phase === 'settle');
  assert.equal(end.syncMs, 3); assert.equal(end.lifetimeMs, 940); assert.equal(c.snapshot().active.length, 0);
});

test('throw, rejection, returned values and disabled operation preserve caller semantics', async () => {
  const c = createCausalContext(); let calls = 0;
  assert.equal(c.run('disabled', {}, () => ++calls), 1);
  c.configure({ enabled: true, sink: () => { throw Error('broken diagnostics'); } });
  const error = new Error('private payload');
  assert.throws(() => c.run('sync', {}, () => { throw error; }), e => e === error);
  await assert.rejects(c.run('async', {}, async () => { throw error; }), e => e === error);
  assert.equal(c.snapshot().active.length, 0); assert.ok(c.snapshot().losses.transport > 0);
  assert.ok(!JSON.stringify(c.snapshot()).includes('private payload'));
});

test('malformed cloneable IDs and diagnostic metric failures cannot prevent the product callback', () => {
  const c = createCausalContext(); let calls = 0;
  c.configure({ enabled: true, sink: () => true, metrics: { read() { throw Error('observer failure'); } } });
  const fields = { actionId: { toString: 0 }, requestId: { toString() { throw Error('do not coerce'); } } };
  Object.defineProperty(fields, 'sessionId', { enumerable: true, get() { throw Error('do not read getter'); } });
  assert.equal(c.run('actual-work', fields, () => ++calls), 1);
  assert.equal(calls, 1); assert.equal(c.snapshot().active.length, 0);
  assert.ok(c.snapshot().losses.unavailable > 0);
});

test('metadata excludes input text, raw path, arbitrary payload and prototype fields', () => {
  const fields = safeFields({ fileIdentity: '/private/secret/session.jsonl', sessionId: 'sid', recordsAfter: 5,
    prompt: 'SECRET', text: 'SECRET', value: 'SECRET', content: { text: 'SECRET' }, path: '/private/secret' });
  assert.equal(fields.recordsAfter, 5); assert.match(fields.fileIdentity, /^sha256:/);
  assert.ok(!JSON.stringify(fields).includes('secret')); assert.ok(!JSON.stringify(fields).includes('SECRET'));
  assert.ok(!boundedCallerToken().includes('/'));
});

test('active/recent metadata is bounded and discarded packets are counted', async () => {
  const c = createCausalContext({ maxActive: 2, maxRecent: 2 });
  c.configure({ enabled: true, sink: () => false });
  const releases = [];
  const work = Array.from({ length: 5 }, () => c.run('test', {}, () => new Promise(resolve => releases.push(resolve))));
  assert.equal(c.snapshot().active.length, 2); assert.equal(c.snapshot().losses.active, 3);
  releases.forEach(resolve => resolve()); await Promise.all(work);
  assert.equal(c.snapshot().recent.length, 2); assert.equal(c.snapshot().losses.recent, 3);
});

test('thin journal keeps chronology and causal context despite rate pressure; reports actual loss', () => {
  let now = 5000; const writes = [];
  const j = createCausalJournal({ now: () => now, maxPerMinute: 1,
    artifacts: { write: (name, lines) => writes.push({ name, lines }) } });
  const origin = { pid: 5, kind: 'main' };
  const packet = { kind: 'span', phase: 'enter', spanId: 's', sourceBoot: 'boot', sourceSeq: 1, emittedAbs: 1000 };
  assert.equal(j.record(packet, origin), true);
  assert.equal(j.record({ ...packet, spanId: 'newer', sourceSeq: 3, emittedAbs: 1010 }, origin), false);
  assert.equal(j.snapshot().counts.sequenceGaps, 1); assert.equal(j.snapshot().counts.droppedRate, 1);
  assert.equal(j.snapshot().active.length, 2, 'last live owner evidence survives persistent rate cap');
  assert.equal(j.record({ ...packet, kind: 'stall', sourceSeq: 4 }, origin, { critical: true }), true);
  now += 400; j.flush();
  assert.equal(writes.length, 1);
  const rows = writes[0].lines.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].emittedAbs, 1000); assert.equal(rows[0].watchdogReceivedAbs, 5000);
  assert.equal(j.snapshot().flushLagMs, 400);
});

test('thin journal limits bytes/queue, excludes unknown fields and exposes disk failures', () => {
  const j = createCausalJournal({ maxQueued: 1, artifacts: { write() { throw Error('disk'); } } });
  const p = { kind: 'ui-action', sourceBoot: 'r', emittedAbs: 50, value: 'SECRET', key: 'password' };
  assert.ok(j.record(p, { pid: 1, kind: 'renderer' }));
  assert.equal(j.record(p, { pid: 1, kind: 'renderer' }), false);
  assert.equal(j.snapshot().counts.droppedQueue, 1);
  assert.ok(!JSON.stringify(j.snapshot()).includes('SECRET'));
  j.flush(true); assert.equal(j.snapshot().counts.diskErrors, 1);
});

test('heartbeat settles a dropped completion; truncated absence remains unknown, not running or completed', () => {
  const j = createCausalJournal({ artifacts: { write() {} }, now: () => 300 });
  const origin = { pid: 3, kind: 'main' };
  for (const id of ['done', 'missing', 'still']) j.record({ kind: 'span', phase: 'sync-return', state: 'awaiting',
    spanId: id, sourceBoot: 'b', emittedAbs: 100 }, origin);
  j.reconcile({ sourceBoot: 'b', emittedAbs: 250,
    recent: [{ spanId: 'done', phase: 'settle', state: 'settled', settledAbs: 200 }],
    active: [{ spanId: 'still', state: 'awaiting', enteredAbs: 100 }] }, origin);
  assert.equal(j.snapshot().active.some(r => r.spanId === 'done'), false);
  assert.equal(j.snapshot().active.find(r => r.spanId === 'missing').state, 'unknown');
  assert.equal(j.snapshot().active.find(r => r.spanId === 'still').state, 'awaiting');
  assert.equal(j.snapshot().counts.reconciledSettlements, 1);
  j.reconcile({ sourceBoot: 'b', emittedAbs: 50, recent: [], active: [] }, origin);
  assert.equal(j.snapshot().active.find(r => r.spanId === 'still').state, 'awaiting', 'late older heartbeat cannot roll state back');
});

test('watchdog per-PID sequences do not invent drops when two process stalls interleave', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'perf-watchdog.js'), 'utf8');
  const start = source.indexOf('const causalSourceSequences = '), end = source.indexOf('const watchdogAbs = ', start);
  const next = vm.runInNewContext(source.slice(start, end) + '\nnextCausalSourceSeq;', { Map });
  const j = createCausalJournal({ artifacts: { write() {} } });
  for (const pid of [1, 2, 1, 2]) j.record({ kind: 'stall', sourceBoot: 'watchdog', sourceSeq: next(pid), emittedAbs: 100 }, { pid, kind: 'main' });
  assert.equal(j.snapshot().counts.sequenceGaps, 0);
});

test('thread metric unsupported/reset are unknown, never zero; GC is explicitly delivered-only', () => {
  assert.equal(createThreadCpuReader({ runtime: { platform: 'other' } }).read(), null);
  let at = 100, usage = 10;
  class Observer { constructor(fn) { this.fn = fn; } observe() {} takeRecords() { return []; } disconnect() {} }
  const m = createThreadMetrics({ now: () => at, reader: { source: 'test', read: () => usage }, cpu: () => ({ user: 0, system: 0 }), Observer });
  const before = m.read(); at = 300; usage = 30;
  assert.equal(m.between(before).threadCpuMs, .02);
  usage = 1; assert.equal(m.between(before).threadCpuMs, null);
  assert.match(m.between(before).gcCoverage, /delivered-entries-only/); m.close();
});

test('renderer heartbeat and incident sequence share one loss ledger without fake heartbeat gaps', () => {
  const j = createCausalJournal({ artifacts: { write() {} } });
  const origin = { pid: 12, kind: 'renderer' };
  const p = { sourceBoot: 'r', emittedAbs: 100, kind: 'ui-action' };
  j.observeSequence({ ...p, sourceSeq: 1 }, origin);
  j.record({ ...p, sourceSeq: 2 }, origin);
  j.observeSequence({ ...p, sourceSeq: 3 }, origin);
  j.observeSequence({ ...p, sourceSeq: 4 }, origin); // filtered incident
  j.record({ ...p, sourceSeq: 5 }, origin);
  assert.equal(j.snapshot().counts.sequenceGaps, 0);
  assert.equal(j.snapshot().counts.received, 2, 'heartbeat does not consume persisted action quota');
  j.record({ ...p, sourceSeq: 7 }, origin);
  assert.equal(j.snapshot().counts.sequenceGaps, 1, 'a genuinely missing packet remains visible');
});

test('actual watchdog ingress preserves a slow Main gap after ordinary GC rate allowance is exhausted', () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, 'perf-watchdog.js'), 'utf8');
  const start = source.indexOf("  if (m.t === 'causal') {");
  const end = source.indexOf("  if (m.t === 'hb'", start);
  assert.ok(start>0 && end>start);
  const writes=[], journal=createCausalJournal({maxPerMinute:1,artifacts:{write:(_name,lines)=>writes.push(lines)}});
  const feed=vm.runInNewContext('(m)=>{'+source.slice(start,end)+'}',{causalJournal:journal,MAIN_PID:99,Number});
  const base={sourceBoot:'main',emittedAbs:100};
  for(let i=0;i<10;i++)feed({t:'causal',record:{...base,sourceSeq:i+1,kind:'gc',durationMs:1}});
  feed({t:'causal',record:{...base,sourceSeq:11,kind:'main-gap',durationMs:2310,threadCpuMs:2200}});
  journal.flush(true);
  const rows=writes.join('').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,2);assert.equal(rows[1].kind,'main-gap');assert.equal(rows[1].threadCpuMs,2200);
  assert.equal(journal.snapshot().counts.droppedRate,9);
});
