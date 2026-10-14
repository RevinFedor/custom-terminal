'use strict';

// Plain Node and private tempFS only. Clock steps are logical; no app, native
// process sampler, clipboard, production store, or renderer is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCausalJournal, cleanCausalRecord } = require('./perf-causal-journal');
const { createArtifactStore } = require('./perf-flight-recorder');
const { CAUSAL_SCHEMA_VERSION } = require('../shared/perf-causal-schema.cjs');
const MiB = 1024 * 1024, DAY = 86400000;
const START = Date.UTC(2026, 9, 13, 5);
const origin = { pid: 313, kind: 'main' };
const bucket = at => 'causal-' + new Date(at).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
const summary = (id, extra = {}) => ({ summaryId: id, revision: 1, siteId: 'private.reader',
  parentSpanId: 'ipc-parent', startAbs: START, endAbs: START + 25000, threadCpuMs: 135, outcome: 'success',
  counts: [1, 0, 4096, 0], sqlMs: [1, 0, 125, 0], sqlMaxMs: 2, sqlErrors: 0,
  sites: [], counters: { rows: 4096 }, overflow: { operations: 0, ms: 0, maxMs: 0 }, ...extra });
const envelope = (id, extra = {}) => ({ kind: 'work-summary', summaryId: id, revision: 1,
  sourceBoot: 'main-boot', sourceSeq: 2, sourcePid: origin.pid, emittedAbs: START + 25000,
  workSummary: summary(id), ...extra });
const detail = (id, extra = {}) => ({ kind: 'ui-action', actionId: 'action-' + id,
  sourceBoot: 'main-boot', emittedAbs: START, ...extra });

test('malformed work measurement has no zero/success substitute and never receives persistence ACK', () => {
  const acks=[],writes=[],j=createCausalJournal({now:()=>START,artifacts:{write:(...v)=>writes.push(v)},onPersisted:a=>acks.push(a)});
  for(const extra of [{outcome:undefined},{outcome:'unknown'},{counts:undefined},{counts:[1,0,0]},
    {counts:[0,-1,0,0]},{counts:[0,.5,0,0]},{sqlMs:[0,NaN,0,0]},{sqlErrors:undefined}]){
    assert.equal(j.record(envelope('invalid',{workSummary:summary('invalid',extra)}),origin),false);
  }
  j.flush(true);assert.deepEqual(acks,[]);assert.deepEqual(writes,[]);
  assert.equal(j.snapshot().counts.droppedMalformed,8);
});

test('observed Git child identity and outcome survive allowlisting without argv/body data', () => {
  const row=cleanCausalRecord({kind:'git-child',phase:'exit-observed',sourceBoot:'main-boot',
    emittedAbs:START,readId:'git-command:313:1',childPid:612,exitCode:7,argv:['SECRET'],stdout:'SECRET'},origin,START);
  assert.equal(row.childPid,612);assert.equal(row.exitCode,7);assert.equal(row.phase,'exit-observed');
  assert.doesNotMatch(JSON.stringify(row),/SECRET|argv|stdout/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-causal25-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createArtifactStore(directory);
  const rows = () => store.entries().filter(e => e.name.startsWith('causal-')).sort((a,b) => a.name.localeCompare(b.name))
    .flatMap(e => fs.readFileSync(store.file(e.name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  const sparse = (name, bytes, at = START - 180000) => {
    const fd = store.openExclusive(name);
    try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
    fs.utimesSync(store.file(name), new Date(at), new Date(at));
  };
  return { directory, store, rows, sparse };
}

test('ACK follows actual append and fresh read; exact duplicate re-ACKs without enqueue or another append', t => {
  const { store, rows } = fixture(t), acks = [];
  const j = createCausalJournal({ artifacts: store, now: () => START + 30000, onPersisted: ack => {
    assert.equal(rows().filter(r => r.summaryId === ack.summaryId).length, 1, 'ACK sees bytes in a new file read');
    acks.push(ack);
  } });
  const packet = envelope('work-one');
  assert.equal(j.record(packet, origin), true);
  assert.equal(j.record({ ...packet, sourceSeq: 99 }, origin), true);
  assert.equal(acks.length, 0); assert.equal(j.snapshot().queued, 1);
  j.flush(true);
  assert.deepEqual(acks, [{ sourcePid: 313, sourceBoot: 'main-boot', summaryId: 'work-one', revision: 1 }]);
  assert.equal(rows()[0].schema, CAUSAL_SCHEMA_VERSION);
  assert.equal(j.record({ ...packet, sourceSeq: 999 }, origin), true);
  assert.equal(acks.length, 2); assert.equal(j.snapshot().queued, 0);
  assert.equal(j.snapshot().counts.duplicatePending, 1); assert.equal(j.snapshot().counts.duplicatePersisted, 1);
  assert.equal(rows().length, 1); assert.equal('maxSequence' in acks[0], false);
});

test('unavailable ACK is counted without undoing the actual append; exact duplicate can ACK after transport recovers', t => {
  const { store, rows } = fixture(t), acks = [];
  let available = false, attempts = 0;
  const j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: ack => {
    attempts++;
    if (!available) return false;
    acks.push(ack); return true;
  } });
  const packet = envelope('ack-unavailable');
  j.record(packet, origin); assert.equal(attempts, 0);
  j.flush(true);
  assert.equal(rows().length, 1); assert.equal(j.snapshot().counts.written, 1);
  assert.equal(j.snapshot().persistedSummaries, 1); assert.equal(j.snapshot().queued, 0);
  assert.equal(j.snapshot().counts.ackErrors, 1); assert.equal(j.snapshot().counts.diskErrors, 0);
  assert.deepEqual(acks, []);
  j.record(packet, origin);
  assert.equal(j.snapshot().counts.ackErrors, 2); assert.deepEqual(acks, []);
  available = true; j.record(packet, origin); j.flush(true);
  assert.deepEqual(acks, [{ sourcePid: 313, sourceBoot: 'main-boot', summaryId: 'ack-unavailable', revision: 1 }]);
  assert.equal(attempts, 3); assert.equal(j.snapshot().counts.ackErrors, 2);
  assert.equal(rows().length, 1); assert.equal(j.snapshot().counts.written, 1);
  assert.equal(j.snapshot().queued, 0); assert.equal(j.snapshot().counts.duplicatePersisted, 2);
});

test('summary removes only the exact source active enter; late heartbeat preserves whole SQL totals with no enter', t => {
  const { store, rows } = fixture(t), acks = [];
  const j = createCausalJournal({ artifacts: store, now: () => START + 70000, onPersisted: a => acks.push(a) });
  for (const pid of [313, 314]) j.record({ kind: 'span', phase: 'enter', spanId: 'work-live',
    sourceBoot: 'main-boot', emittedAbs: START, sourceSeq: 1 }, { ...origin, pid });
  j.record(envelope('work-live'), origin);
  assert.equal(j.snapshot().active.length, 1); assert.equal(j.snapshot().active[0].sourcePid, 314);
  const snapshot = { sourceBoot: 'main-boot', emittedAbs: START + 65000,
    completedWork: [summary('late-unseen', { startAbs: START + 1000, endAbs: START + 55000 })], recent: [], active: [] };
  j.reconcile(snapshot, origin); j.reconcile(snapshot, origin);
  assert.equal(acks.length, 0); j.flush(true);
  const late = rows().find(r => r.summaryId === 'late-unseen');
  assert.equal(late.enteredRecordMissing, true);
  assert.equal(late.workSummary.startAbs, START + 1000); assert.equal(late.workSummary.endAbs, START + 55000);
  assert.deepEqual(late.workSummary.counts, [1, 0, 4096, 0]); assert.deepEqual(late.workSummary.sqlMs, [1, 0, 125, 0]);
  assert.equal(rows().find(r => r.summaryId === 'work-live').enteredRecordMissing, false);
  j.reconcile(snapshot, origin);
  assert.equal(rows().filter(r => r.summaryId === 'late-unseen').length, 1);
  assert.equal(j.snapshot().counts.reconciledWork, 1); assert.equal(acks.length, 3);
});

test('malformed envelope identity cannot ACK; duplicate key includes PID, boot, ID and revision', t => {
  const { store, rows } = fixture(t), acks = [];
  const j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: a => acks.push(a) });
  for (const change of [ { summaryId: 'different' }, { revision: 2 }, { sourcePid: 314 },
    { sourceBoot: 'boot\n' }, { sourceBoot: 'x'.repeat(101) }, { workSummary: summary('same', { revision: 2 }) } ]) {
    assert.equal(j.record(envelope('same', change), origin), false);
  }
  assert.equal(acks.length, 0);
  for (const [pid, sourceBoot] of [[313, 'a:b'], [313, 'a'], [314, 'a:b']]) {
    assert.equal(j.record(envelope('same', { sourcePid: pid, sourceBoot }), { ...origin, pid }), true);
  }
  j.flush(true); assert.equal(rows().length, 3); assert.equal(acks.length, 3);
  assert.equal(j.snapshot().counts.droppedMalformed, 6);
});

test('default minute quotas retain 32 work, 8 health, 20 detail plus 12 critical; every category loss is explicit', t => {
  const { store, rows } = fixture(t); let at = START;
  const j = createCausalJournal({ artifacts: store, now: () => at });
  for (let i = 0; i < 20; i++) assert.equal(j.record(detail(i), origin), true);
  assert.equal(j.record(detail('overflow'), origin), false);
  for (let i = 0; i < 8; i++) assert.equal(j.record(detail(i, { kind: 'gc-summary', gcEntries: 100, gcMaxMs: 17 }), origin), true);
  assert.equal(j.record(detail('overflow', { kind: 'gc-summary' }), origin), false);
  for (let i = 0; i < 32; i++) assert.equal(j.record(envelope('work-' + i), origin), true);
  assert.equal(j.record(envelope('work-overflow'), origin), false);
  j.flush(true);
  for (let i = 0; i < 12; i++) assert.equal(j.record(detail(i, { kind: 'main-gap' }), origin, { critical: true }), true);
  assert.equal(j.record(detail('overflow', { kind: 'main-gap' }), origin, { critical: true }), false);
  j.flush(true);
  assert.equal(rows().length, 72);
  assert.ok(rows().filter(r => r.kind === 'gc-summary').every(r => r.gcMaxMs === 17));
  for (const category of ['work', 'health', 'detail', 'critical']) assert.equal(j.snapshot().counts.losses[category].rate, 1);
  at += 60000; assert.equal(j.record(envelope('next-minute'), origin), true);
  assert.deepEqual(j.snapshot().normalLimits, { work: 32, health: 8, detail: 20 });
});

test('full queue evicts only strictly lower priority; critical cannot replace critical and loss is assigned to victim', t => {
  const { store, rows } = fixture(t);
  const j = createCausalJournal({ artifacts: store, now: () => START, maxQueued: 2 });
  j.record(detail('critical-old', { kind: 'main-gap' }), origin, { critical: true });
  j.record(detail('detail'), origin);
  assert.equal(j.record(envelope('work'), origin), true);
  assert.equal(j.record(detail('health', { kind: 'health' }), origin), false);
  assert.equal(j.record(detail('critical-new', { kind: 'main-gap' }), origin, { critical: true }), true);
  assert.equal(j.record(detail('critical-overflow', { kind: 'main-gap' }), origin, { critical: true }), false);
  assert.equal(j.snapshot().queued, 2);
  const loss = j.snapshot().counts.losses;
  assert.equal(loss.detail.evicted, 1); assert.equal(loss.work.evicted, 1);
  assert.equal(loss.health.queue, 1); assert.equal(loss.critical.queue, 1); assert.equal(loss.critical.evicted, 0);
  j.flush(true);
  assert.deepEqual(rows().map(r => r.actionId), ['action-critical-old', 'action-critical-new']);
});

test('when several lower-priority candidates exist, a critical arrival preserves work ahead of detail', t => {
  const { store, rows } = fixture(t);
  const j = createCausalJournal({ artifacts: store, now: () => START, maxQueued: 3 });
  j.record(envelope('keep-work'), origin);
  j.record(detail('keep-health', { kind: 'health' }), origin);
  j.record(detail('drop-detail'), origin);
  j.record(detail('critical', { kind: 'main-gap' }), origin, { critical: true }); j.flush(true);
  assert.deepEqual(rows().map(r => r.kind), ['work-summary', 'health', 'main-gap']);
  assert.equal(j.snapshot().counts.losses.detail.evicted, 1); assert.equal(j.snapshot().counts.losses.work.evicted, 0);
});

test('shared fitting preserves bounded core, whole-work totals and capsule while omitting metadata; secrets are excluded', t => {
  const { store, rows } = fixture(t);
  const rich = summary('work-rich', { sites: Array.from({ length: 16 }, (_, i) => ({ siteId: 'sql.' + i + 'x'.repeat(55),
    counts: [1,2,3,4], ms: [1,2,3,4], maxMs: 3, errors: 1 })),
    counters: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['counter' + i + 'x'.repeat(30), 9])),
    context: { tabId: 't'.repeat(100), sessionId: 's'.repeat(100), actionId: 'a'.repeat(100) },
    text: 'SECRET_SQL', bindings: ['SECRET_BINDINGS'] });
  const j = createCausalJournal({ artifacts: store, now: () => START + 30000 });
  assert.equal(j.record(envelope('work-rich', { workSummary: rich, caller: 'c'.repeat(100), prompt: 'SECRET_PROMPT' }), origin), true);
  assert.equal(j.record(detail('gap', { kind: 'main-gap', durationMs: 500, threadCpuMs: 300,
    workCapsule: { version: 1, fromAbs: START + 10, toAbs: START + 20,
      items: [rich, { ...rich, summaryId: 'second' }], omitted: 0, retainedEvictions: 3 } }), origin, { critical: true }), true);
  j.flush(true);
  for (const r of rows()) {
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 2048);
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  }
  const work = rows()[0].workSummary;
  assert.equal(work.omittedSites, 16); assert.deepEqual(work.counts, rich.counts); assert.deepEqual(work.sqlMs, rich.sqlMs);
  const gap = rows()[1]; assert.equal(gap.durationMs, 500); assert.equal(gap.threadCpuMs, 300);
  assert.ok(gap.workCapsule.items.length > 0);
  assert.deepEqual(gap.workCapsule.items[0].counts, rich.counts, 'a 10ms overlap does not scale whole-work totals');
  assert.equal(gap.workCapsule.retainedEvictions, 3);
  const tiny = createCausalJournal({ artifacts: store, now: () => START, maxRecordBytes: 32 });
  assert.equal(tiny.record(envelope('too-large-core'), origin), false);
  assert.equal(tiny.snapshot().counts.losses.work.bytes, 1);
});

test('actual write failure has no ACK, rolls back torn append, and identical summary can later persist', t => {
  const { store, rows } = fixture(t), acks = [];
  const j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: a => acks.push(a) });
  const write = fs.writeFileSync;
  j.record(envelope('retry'), origin);
  fs.writeFileSync = (fd, data, ...rest) => {
    if (typeof fd === 'number') { fs.writeSync(fd, String(data).slice(0, 15)); throw Object.assign(Error('injected disk full'), { code: 'ENOSPC' }); }
    return write(fd, data, ...rest);
  };
  try { j.flush(true); } finally { fs.writeFileSync = write; }
  assert.equal(acks.length, 0); assert.equal(fs.statSync(store.file(bucket(START))).size, 0);
  assert.equal(j.snapshot().counts.losses.work.disk, 1);
  assert.equal(j.record(envelope('retry'), origin), true); j.flush(true);
  assert.equal(rows().length, 1); assert.equal(acks.length, 1);
});

test('failed rollback keeps a torn hour unacknowledged across retries and a fresh store; the next hour works', t => {
  const {store,directory}=fixture(t),acks=[],logs=[];let at=START;
  const j=createCausalJournal({artifacts:store,now:()=>at,onPersisted:a=>acks.push(a),log:line=>logs.push(line)});
  const name=bucket(at),prefix=Buffer.from('{"incomplete":');
  const write=fs.writeFileSync,truncate=fs.ftruncateSync;
  j.record(envelope('torn-retry'),origin);
  fs.writeFileSync=(fd,data,...rest)=>{
    if(typeof fd==='number'){
      fs.writeSync(fd,prefix);throw Object.assign(new Error('injected write error'),{code:'EIO'});
    }
    return write(fd,data,...rest);
  };
  fs.ftruncateSync=()=>{throw Object.assign(new Error('injected rollback error'),{code:'EIO'});};
  try{j.flush(true);}finally{fs.writeFileSync=write;fs.ftruncateSync=truncate;}
  assert.deepEqual(acks,[]);assert.deepEqual(fs.readFileSync(store.file(name)),prefix);
  at+=31001;j.record(envelope('torn-retry'),origin);j.flush(true);
  const retried=fs.readFileSync(store.file(name),'utf8');let readableRecords=0;
  for(const line of retried.split('\n').filter(Boolean))try{JSON.parse(line);readableRecords++;}catch{}
  t.diagnostic(JSON.stringify({persistenceAcks:acks.length,readableRecords,bytes:Buffer.byteLength(retried)}));
  assert.deepEqual(acks,[],'metadata retry must not ACK a record joined to an undecodable prefix');
  assert.equal(j.snapshot().counts.tornBucketRecords,1,'tail refusal remains counted even when error logging is throttled');
  assert.deepEqual(fs.readFileSync(store.file(name)),prefix,'ambiguous bytes are not repaired or replaced');
  assert.ok(logs.some(line=>line.includes('reason=incomplete-hour-tail')));
  const fresh=createArtifactStore(directory);
  assert.throws(()=>fresh.writeCausal(name,'{}\n',{essential:true}),e=>e.code==='CAUSAL_TORN_BUCKET');
  assert.deepEqual(fs.readFileSync(fresh.file(name)),prefix,'restart cannot forget the physical torn boundary');
  at=START+3600000;
  j.record(envelope('healthy-hour',{emittedAbs:at+50,
    workSummary:summary('healthy-hour',{startAbs:at,endAbs:at+50})}),origin);j.flush(true);
  const saved=fs.readFileSync(store.file(bucket(at)),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(saved.length,1);assert.equal(saved[0].summaryId,'healthy-hour');
  assert.deepEqual(acks.map(a=>a.summaryId),['healthy-hour']);
});

test('an enqueue-like or missing append receipt is not persistence proof', t => {
  const { store } = fixture(t); const acks = [];
  const j = createCausalJournal({ artifacts: { ...store, writeCausal: () => true }, now: () => START, onPersisted: a => acks.push(a) });
  j.record(envelope('unproven'), origin); j.flush(true);
  assert.deepEqual(acks, []); assert.equal(j.snapshot().counts.diskErrors, 1);
});

test('global hourly 2MiB normal / 4MiB total limits survive fresh store and preserve bytes on rejected append', t => {
  const { store, directory } = fixture(t), name = bucket(START);
  const normal = 'n'.repeat(2 * MiB - 1) + '\n';
  const receipt = store.writeCausal(name, normal);
  assert.deepEqual(receipt, { name, appended: true, bytes: 2 * MiB, fromBytes: 0, toBytes: 2 * MiB, essential: false });
  const fresh = createArtifactStore(directory);
  assert.throws(() => fresh.writeCausal(name, '{}\n'), /bucket full/);
  const essential = 'e'.repeat(2 * MiB - 1) + '\n';
  assert.equal(fresh.writeCausal(name, essential, { essential: true }).toBytes, 4 * MiB);
  assert.throws(() => store.writeCausal(name, '{}\n', { essential: true }), /bucket full/);
  assert.equal(fs.readFileSync(store.file(name), 'utf8'), normal + essential);
  assert.equal(fresh.writeCausal(bucket(START + 3600000), '{}\n').bytes, 3);
});

test('ordinary bucket rejection cannot suppress critical evidence in the same flush', t => {
  const { store } = fixture(t); store.writeCausal(bucket(START), 'x'.repeat(2 * MiB - 1) + '\n');
  const acks = [], j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: a => acks.push(a) });
  j.record(detail('cannot-fit'), origin);
  j.record(detail('essential', { kind: 'main-gap', durationMs: 1000 }), origin, { critical: true });
  j.flush(true);
  const last = fs.readFileSync(store.file(bucket(START)), 'utf8').trim().split('\n').at(-1);
  assert.equal(JSON.parse(last).actionId, 'action-essential');
  assert.equal(acks.length, 0); assert.equal(j.snapshot().counts.written, 1);
  assert.equal(j.snapshot().counts.losses.detail.bucket, 1); assert.equal(j.snapshot().counts.losses.critical.bucket, 0);
  assert.equal(j.snapshot().counts.droppedBucket, 1); assert.equal(j.snapshot().counts.diskErrors, 0);
});

test('important work uses the essential reserve after normal2MiB; total4MiB rejects a new summary without ACK', t => {
  const { store } = fixture(t), name = bucket(START), acks = [];
  store.writeCausal(name, 'x'.repeat(2 * MiB - 1) + '\n');
  const j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: ack => { acks.push(ack); return true; } });
  assert.equal(j.record(envelope('important-after-normal-cap'), origin), true);
  assert.equal(acks.length, 0); j.flush(true);
  const size = fs.statSync(store.file(name)).size;
  assert.ok(size > 2 * MiB && size < 4 * MiB);
  const row = JSON.parse(fs.readFileSync(store.file(name)).subarray(2 * MiB).toString('utf8'));
  assert.equal(row.kind, 'work-summary'); assert.equal(row.summaryId, 'important-after-normal-cap');
  assert.deepEqual(row.workSummary.counts, [1, 0, 4096, 0]);
  assert.deepEqual(acks, [{ sourcePid: 313, sourceBoot: 'main-boot', summaryId: row.summaryId, revision: 1 }]);
  assert.equal(j.snapshot().counts.written, 1); assert.equal(j.snapshot().counts.droppedBucket, 0);
  store.writeCausal(name, 'f'.repeat(4 * MiB - size - 1) + '\n', { essential: true });
  assert.equal(fs.statSync(store.file(name)).size, 4 * MiB);
  assert.equal(j.record(envelope('cannot-fit-total-cap'), origin), true); j.flush(true);
  assert.equal(fs.statSync(store.file(name)).size, 4 * MiB);
  assert.equal(acks.length, 1); assert.equal(j.snapshot().counts.written, 1);
  assert.equal(j.snapshot().persistedSummaries, 1); assert.equal(j.snapshot().counts.losses.work.bucket, 1);
  assert.equal(j.snapshot().counts.droppedBucket, 1); assert.equal(j.snapshot().counts.diskErrors, 0);
  assert.deepEqual(j.snapshot().normalLimits, { work: 32, health: 8, detail: 20 });
  assert.equal(j.snapshot().limits.maxPerMinute, 60); assert.equal(j.snapshot().limits.criticalPerMinute, 12);
});

test('causal append performs no directory scan; later prune failure cannot revoke an append ACK', t => {
  const { store, rows } = fixture(t), acks = [];
  const j = createCausalJournal({ artifacts: store, now: () => START, onPersisted: a => acks.push(a) });
  j.record(envelope('no-prune'), origin);
  const scan = fs.readdirSync; let scans = 0;
  fs.readdirSync = () => { scans++; throw Error('injected prune scan failure'); };
  try { j.flush(true); assert.equal(scans, 0); assert.throws(() => store.prune(START), /scan failure/); }
  finally { fs.readdirSync = scan; }
  assert.equal(acks.length, 1); assert.equal(rows().length, 1); assert.equal(j.snapshot().counts.diskErrors, 0);
});

test('nofollow, hardlink and inode replacement guards preserve unrelated files and cannot produce ACK', t => {
  const { directory, store } = fixture(t), name = bucket(START);
  const unrelated = path.join(directory, 'unrelated'); fs.writeFileSync(unrelated, 'keep');
  fs.symlinkSync(unrelated, store.file(name));
  assert.throws(() => store.writeCausal(name, '{}\n'));
  fs.unlinkSync(store.file(name)); fs.linkSync(unrelated, store.file(name));
  assert.throws(() => store.writeCausal(name, '{}\n'), /inode/);
  assert.throws(() => store.read(name), /read/);
  fs.unlinkSync(store.file(name)); store.writeCausal(name, '{}\n');
  const lstat = fs.lstatSync; let changed = false;
  fs.lstatSync = (target, ...rest) => {
    if (target === store.file(name) && !changed) {
      changed = true; fs.renameSync(target, path.join(directory, 'original-inode'));
      fs.writeFileSync(target, 'replacement');
    }
    return lstat(target, ...rest);
  };
  try { assert.throws(() => store.writeCausal(name, '{}\n'), /inode/); }
  finally { fs.lstatSync = lstat; }
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(store.file(name), 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(path.join(directory, 'original-inode'), 'utf8'), '{}\n');
});

test('retention ledger persists latest32 real removals, omitted count and source hour within16KiB', t => {
  const { store, sparse, directory } = fixture(t);
  for (let i = 0; i < 40; i++) sparse(bucket(START - (200 + i) * 3600000), 123 + i, START - (200 + i) * 3600000);
  const unrelated = path.join(directory, 'unrelated'); fs.writeFileSync(unrelated, 'keep');
  fs.symlinkSync(unrelated, store.file('causal-2020010100.ndjson'));
  store.prune(START);
  const ledger = createArtifactStore(directory).retentionLedger();
  assert.equal(ledger.entries.length, 32); assert.equal(ledger.omitted, 8);
  assert.ok(fs.statSync(store.file('retention-ledger.json')).size <= 16384);
  for (const e of ledger.entries) {
    assert.equal(fs.existsSync(store.file(e.file)), false); assert.equal(e.reason, 'retention-expired');
    assert.equal(e.sourceHour, /causal-(\d{10})/.exec(e.file)[1]); assert.ok(e.bytes >= 123); assert.equal(e.removedAt, START);
  }
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(store.file('causal-2020010100.ndjson')).isSymbolicLink(), true);
  const before = fs.readFileSync(store.file('retention-ledger.json'), 'utf8'); store.prune(START);
  assert.equal(fs.readFileSync(store.file('retention-ledger.json'), 'utf8'), before);
});

test('unlink failure or changed inode is not a retained-loss receipt; previous successful removals survive a later failure', t => {
  const { store, sparse } = fixture(t);
  const first = bucket(START - 220 * 3600000), second = bucket(START - 210 * 3600000), third = bucket(START - 200 * 3600000);
  for (const [i, name] of [first, second, third].entries()) sparse(name, 100, START - (220 - i * 10) * 3600000);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = target => { if (target === store.file(second)) throw Object.assign(Error('injected unlink denial'), { code: 'EACCES' }); return unlink(target); };
  try { assert.throws(() => store.prune(START), /unlink denial/); } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(store.retentionLedger().entries.map(e => e.file), [first]);
  assert.equal(fs.existsSync(store.file(second)), true); assert.equal(fs.existsSync(store.file(third)), true);
  const lstat = fs.lstatSync; let observations = 0;
  fs.lstatSync = (target, ...rest) => {
    if (target === store.file(second) && ++observations === 2) { // after inventory, before unlink
      fs.renameSync(target, path.join(store.directory, 'old-inode')); fs.writeFileSync(target, 'new-evidence');
    }
    return lstat(target, ...rest);
  };
  try { store.prune(START); } finally { fs.lstatSync = lstat; }
  assert.equal(fs.readFileSync(store.file(second), 'utf8'), 'new-evidence');
  assert.deepEqual(store.retentionLedger().entries.map(e => e.file), [first, third]);
});

test('ledger counts inside5GiB; native and heavy quota receipts survive budget pressure with a fresh store', t => {
  const { store, sparse, directory } = fixture(t);
  const native = 'stall-' + (START - 1000) + '-123-1.sample-capture.json';
  store.writeExclusive(native, { version: 1, request: 'quota' });
  fs.utimesSync(store.file(native), new Date(START - 8 * DAY), new Date(START - 8 * DAY));
  for (let i = 0; i < 4; i++) {
    const name = 'incident-' + (START - 7200000 + i * 700000) + '-1.capture.json';
    store.write(name, { group: 'responsiveness' });
    fs.utimesSync(store.file(name), new Date(START - 7200000 + i * 700000), new Date(START - 7200000 + i * 700000));
  }
  sparse('incident-1-1.cpuprofile', 5 * 1024 * MiB, START - 180000);
  const result = store.prune(START), ledgerBytes = fs.statSync(store.file('retention-ledger.json')).size;
  assert.equal(result.bytes, store.entries().reduce((sum, e) => sum + e.size, 0) + ledgerBytes);
  assert.ok(result.bytes < 5 * 1024 * MiB); assert.equal(fs.existsSync(store.file(native)), true);
  assert.equal(store.retentionLedger().entries[0].reason, 'artifact-budget');
  const fresh = createArtifactStore(directory);
  assert.equal(fresh.entries().filter(e => e.name.endsWith('.capture.json')).length, 4);
  assert.equal(fresh.reserveCaptureDetails('incident-' + START + '-2', START).reason, 'rolling-quota-exhausted');
});

test('hard bounds cannot be raised by callers and persisted tuple cache is bounded without a short age timeout', t => {
  const { store, rows } = fixture(t); let at = START;
  const j = createCausalJournal({ artifacts: store, now: () => at, maxPerMinute: 1000, maxQueued: 1000, maxRecordBytes: 9000 });
  assert.deepEqual(j.snapshot().limits, { maxPerMinute: 60, criticalPerMinute: 12, maxQueued: 64, maxRecordBytes: 2048 });
  for (let group = 0; group < 17; group++) {
    for (let i = 0; i < 32; i++) j.record(envelope('cached-' + group + '-' + i), origin);
    j.flush(true); at += 60000;
  }
  assert.equal(j.snapshot().persistedSummaries, 512); assert.equal(j.snapshot().counts.persistedEvictions, 32);
  const before = rows().length;
  j.record(envelope('cached-1-0'), origin); j.flush(true);
  assert.equal(rows().length, before, 'known exact summary remains deduped after sixteen logical minutes');
});
