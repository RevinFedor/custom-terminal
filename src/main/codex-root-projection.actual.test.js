'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture,user,answer,call,output,digestRows,hashRoot,intervalAudit,legacyRows,smallRows,smallText,api } = require('./test-helpers/codex-root-fixture.cjs');

for (const indexBytes of [0,2048]) for (const count of [1,10,100]) {
  test(`ROOT-CANONICAL-${count}/index${indexBytes}: actual file cold/warm, full ordered content and interval ownership`, async t => {
    const f = fixture(t,{ indexBytes }), expected = digestRows(), audit = intervalAudit(indexBytes);
    for (let i = 0; i < count; i++) {
      const u = f.append(user('user-' + i)), a = f.append(answer('answer-' + i + ' Русский 😀'));
      // A two-record oracle is released on every iteration; no second history.
      for (const row of legacyRows(f.sessionId,[u,a])) expected.add(row);
    }
    const digest = expected.finish();
    const first = await f.read({ observeRoot: stats => audit.observe(stats) });
    try {
      assert.equal(first.mode,'rebuild'); assert.equal(first.entries.length,count * 2);
      assert.deepEqual(await hashRoot(first),digest);
      assert.equal(first.readMetrics.maxCollectedRecords,0); assert.equal(first.readMetrics.maxConsumerRecords,1);
      assert.equal(first.readMetrics.chunks,Math.ceil(fs.statSync(f.filePath).size / 64));
      assert.equal(first.rootStats.store.forkPagesWritten,0);
      assert.equal(first.rootStats.inputIdentitySlots,0);
      assert.ok(first.rootStats.ownerCountOnDisk > count,'real owner index must carry the data on disk');
      const warm = await f.read({ observeRoot: stats => audit.observe(stats) });
      try {
        assert.equal(warm.mode,'unchanged'); assert.equal(warm.fedRecords,0);
        assert.equal(warm.readMetrics.bytes,0);
        assert.equal(warm.readMetrics.verificationBytes,fs.statSync(f.filePath).size);
        assert.equal(warm.rootStats.ownerCountOnDisk,first.rootStats.ownerCountOnDisk,
          'warm presentation must not accumulate another owner graph in continuation');
        assert.deepEqual(await hashRoot(warm),digest);
        assert.deepEqual(await hashRoot(first),digest,'published old root stays immutable');
      } finally { warm.release(); }
      assert.ok(audit.phases.feed >= count * 2); assert.ok(audit.phases.finalization > count * 2);
      if (count >= 10) assert.ok(audit.phases.checkpoint > 0);
      t.diagnostic(JSON.stringify({ gate:'canonical',count,indexBytes,digest,interval:audit,
        rootStats:first.rootStats,scope:'Source JS ownership; leaf/native/RSS limits are not inferred from these counters' }));
    } finally { first.release(); }
  });
}

for (const indexBytes of [0,2048]) for (const count of [1,10,100]) {
  test(`ROOT-PENDING-${count}/index${indexBytes}: actual pending checkpoint, reverse late outputs and immutable view`, async t => {
    const f = fixture(t,{ indexBytes }), audit = intervalAudit(indexBytes), expected = digestRows();
    const u = f.append(user('owner'));
    expected.add(legacyRows(f.sessionId,[u])[0]);
    const start = f.offset, line = f.line;
    const record = i => call('call-' + String(i).padStart(3,'0'));
    const width = Buffer.byteLength(JSON.stringify(record(0)) + '\n');
    const located = i => ({ ...record(i),__line: line + i,__byteOffset: start + i * width });
    for (let i = 0; i < count; i++) {
      const c = f.append(record(i)); assert.equal(c.__byteOffset,located(i).__byteOffset);
      expected.add(legacyRows(f.sessionId,[u,c])[1]);
    }
    const pendingDigest = expected.finish();
    const pending = await f.read({ observeRoot: stats => audit.observe(stats) });
    try {
      assert.equal(pending.entries.length,count + 1);
      assert.deepEqual(await hashRoot(pending),pendingDigest);
      let owners = 0;
      for (const [_key,value] of pending.checkpoint.cursor().field('pendingCalls').pairs()) {
        owners++; assert.equal(value.field('record').kind,'object');
        assert.equal(value.field('args').kind,'object');
      }
      assert.equal(owners,count,'all raw call-time owners are addressable on disk');
      const after = digestRows(); after.add(legacyRows(f.sessionId,[u])[0]);
      for (let i = count - 1; i >= 0; i--) {
        const result = f.append(output('call-' + String(i).padStart(3,'0'),'full-result-' + i));
        after.add(legacyRows(f.sessionId,[u,located(i),result])[1]);
      }
      const completedDigest = after.finish();
      const completed = await f.read({ observeRoot: stats => audit.observe(stats) });
      try {
        assert.equal(completed.mode,'append'); assert.equal(completed.fedRecords,count);
        assert.deepEqual(await hashRoot(completed),completedDigest);
        assert.equal([...completed.checkpoint.cursor().field('pendingCalls').pairs()].length,0);
        assert.deepEqual(await hashRoot(pending),pendingDigest);
        t.diagnostic(JSON.stringify({ gate:'pending',count,indexBytes,pendingDigest,completedDigest,
          interval:audit,rootStats:completed.rootStats }));
      } finally { completed.release(); }
    } finally { pending.release(); }
  });
}

test('actual file partial tail / restart checkpoint / same-size replacement / truncate preserve old roots', async t => {
  const f = fixture(t,{ checkpointEvery:2 });
  const firstUser = f.append(user('user')), firstAnswer = f.append(answer('AAAA'));
  const original = await f.read();
  const digest = await hashRoot(original);
  const checkpoint = f.owner.read(f.sessionId,f.dir,0);
  assert.ok(checkpoint);
  try {
    const fromCheckpoint = await f.read({ rootCheckpoint:checkpoint });
    try { assert.deepEqual(await hashRoot(fromCheckpoint),digest); assert.ok(fromCheckpoint.reusedRecords > 0); }
    finally { fromCheckpoint.release(); }
    const tail = JSON.stringify(answer('partial-tail'));
    fs.appendFileSync(f.filePath,tail.slice(0,35));
    const partial = await f.read();
    try { assert.equal(partial.mode,'append'); assert.equal(partial.fedRecords,0); assert.deepEqual(await hashRoot(partial),digest); }
    finally { partial.release(); }
    fs.appendFileSync(f.filePath,tail.slice(35) + '\n');
    const complete = await f.read();
    try { assert.equal(complete.mode,'append'); assert.equal(complete.fedRecords,1); assert.equal(complete.entries.length,3); }
    finally { complete.release(); }
    const before = fs.readFileSync(f.filePath,'utf8');
    fs.writeFileSync(f.filePath,before.replace('AAAA','BBBB'));
    const rewrite = await f.read();
    try {
      assert.equal(rewrite.mode,'rebuild'); assert.equal(smallText(rewrite.entries.at(1).field('content')),'BBBB');
      assert.deepEqual(await hashRoot(original),digest);
    } finally { rewrite.release(); }
    fs.truncateSync(f.filePath,firstAnswer.__byteOffset);
    const truncated = await f.read();
    try { assert.equal(truncated.mode,'rebuild'); assert.equal(truncated.entries.length,1); }
    finally { truncated.release(); }
    assert.equal(firstUser.__line,1);
  } finally { checkpoint.release(); original.release(); }
});

test('actual canceled publication retains current pin; pinned roots outlive cache eviction', async t => {
  const f = fixture(t); f.append(user('user')); f.append(answer('safe'));
  const old = await f.read(), expected = await hashRoot(old);
  const before = f.owner.read(f.sessionId,f.dir); const page = before.descriptor.page; before.release();
  f.append(answer('staged'));
  let canceled = false;
  try {
    await assert.rejects(f.read({ observeRoot: stats => { if(stats.phase === 'finalization') canceled = true; },
      assertCurrent: () => { if (canceled) throw Object.assign(Error('owned-fixture-cancel'),{ code:'HISTORY_READ_CANCELLED' }); } }),
    { code:'HISTORY_READ_CANCELLED' });
    const retained = f.owner.read(f.sessionId,f.dir);
    try { assert.equal(retained.descriptor.page,page); } finally { retained.release(); }
    assert.deepEqual(await hashRoot(old),expected);
    const next = await f.read();
    try {
      assert.equal(next.mode,'append'); assert.equal(next.fedRecords,1);
      const extra = old.root.fork();
      try { f.owner.evict(f.sessionId,f.dir); assert.equal(f.owner.read(f.sessionId,f.dir),null);
        assert.deepEqual(await hashRoot(old),expected); assert.equal(extra.cursor().length,2); }
      finally { extra.release(); }
    } finally { next.release(); }
  } finally { old.release(); }
});

test('actual frozen header and ancestor/child source metadata survive append and checkpoint import', async t => {
  const f = fixture(t,{ header:{ forked_from_id:'parent',forked_from_ordinal_exclusive:7,history_mode:'fork',history_base:{ sessionId:'parent',ordinal:7 } },checkpointEvery:2 });
  f.append(user('parent-context'));
  const first = await f.read();
  try {
    assert.equal(smallText(first.sessionMeta.field('id')),f.sessionId);
    assert.equal(smallText(first.sessionMeta.field('forked_from_id')),'parent');
    assert.equal(first.sessionMeta.field('forked_from_ordinal_exclusive').scalar(),7);
    f.append({ type:'session_meta',payload:{ id:'later-header',cwd:'/new',forked_from_id:'wrong' } });
    f.append(answer('child-answer'));
    const next = await f.read();
    try {
      assert.equal(smallText(next.sessionMeta.field('id')),f.sessionId);
      assert.equal(smallText(next.sessionMeta.field('forked_from_id')),'parent');
      assert.equal(next.entries.length,2); assert.equal(first.entries.length,1);
    } finally { next.release(); }
  } finally { first.release(); }
});
