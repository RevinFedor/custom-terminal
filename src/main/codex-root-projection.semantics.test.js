'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture,user,answer,call,output,legacyRows,smallRows,smallText,hashRoot,api } = require('./test-helpers/codex-root-fixture.cjs');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { HistoryPagedStore } = require('./history-paged-store');
const { CodexRootProjectionOwner } = require('./codex-root-projection-owner');
const { recordCodexProcessActionOwnership,resetCodexProcessActionOwnershipForTests } = require('./codex-process-action-ownership');

const rec = (type,payload) => ({ type,payload,timestamp:'2026-10-22T00:00:00Z' });
const exec = (id,input) => rec('response_item',{ type:'custom_tool_call',name:'exec',call_id:id,input });
const execResult = (id,parts,running=false) => rec('response_item',{ type:'custom_tool_call_output',call_id:id,
  output:[{ type:'input_text',text:running ? 'Script running with cell ID 42\nWall time 1s\nOutput:\n'
    : 'Script completed\nWall time 1s\nOutput:\n' },
  ...parts.map(x => ({ type:'input_text',text: typeof x === 'string' ? x : JSON.stringify(x) }))] });
const settled = (index,value,status='fulfilled') => ({ index,status,[status === 'fulfilled' ? 'value' : 'reason']:value });

const cases = [
  ['late reasoning/output-before-call/old owner',[
    user('first'),rec('response_item',{ type:'reasoning',summary:[{ type:'summary_text',text:'first reasoning' }] }),
    call('old'),user('second'),output('orphan','before-call'),call('orphan'),output('old','late full output'),answer('second answer'),
  ],4],
  ['background exec wait indexed settlements',[
    user('settled'),exec('exec','await stream_settled([tools.exec_command({cmd:"A"}),tools.exec_command({cmd:"B"})],text);'),
    execResult('exec',[settled(1,'B-output')],true),call('wait','wait',{ cell_id:'42' }),
    execResult('wait',[settled(0,'A-output')]),answer('done'),
  ],3],
  ['permuted stream_settled input binding',[
    user('permuted'),exec('exec','const a=tools.exec_command({cmd:"A"});const b=tools.exec_command({cmd:"B"});await stream_settled([b,a],r=>text(r));'),
    execResult('exec',[settled(0,'B-output'),settled(1,'A-output')]),
  ],2],
  ['Map keys and rejected stream_settled result',[
    user('map'),exec('exec','const a=tools.exec_command({cmd:"A"});const b=tools.exec_command({cmd:"B"});await stream_settled(new Map([["b",b],["a",a]]),r=>text(r));'),
    execResult('exec',[settled('b','B failed','rejected'),settled('a','A-output')]),
  ],2],
  ['rollback / aborted reasoning / new owner at reused turn ordinal',[
    user('old'),call('discard'),rec('response_item',{ type:'reasoning',summary:[{ type:'summary_text',text:'discarded thought' }] }),
    rec('event_msg',{ type:'turn_aborted' }),rec('event_msg',{ type:'thread_rolled_back',num_turns:1 }),
    user('new'),output('discard','must not adopt new owner'),answer('new answer'),
  ],4],
  ['settings / compact companion / user alias',[
    rec('response_item',{ type:'message',role:'user',content:[{ type:'input_text',text:'paired' }] }),user('paired'),
    rec('turn_context',{ model:'gpt-5',effort:'high',cwd:'/own-fixture' }),
    rec('event_msg',{ type:'token_count',info:{ total_token_usage:{ total_tokens:123 } } }),
    rec('compacted',{ message:'own compact' }),rec('event_msg',{ type:'context_compacted' }),answer('after compact'),
  ],4],
];

for (const [name,records,split] of cases) test('same actual reducer preserves ' + name + ' through CoW checkpoint/append', async t => {
  const f = fixture(t,{ checkpointEvery:2 }), located = [];
  for (const record of records.slice(0,split)) located.push(f.append(record));
  const before = await f.read({ includeTurnCoordinates:true });
  try {
    const expectedBefore = JSON.parse(JSON.stringify(legacyRows(f.sessionId,located,{ includeTurnCoordinates:true })));
    assert.deepEqual(await smallRows(before),expectedBefore);
    const beforeDigest = await hashRoot(before);
    const checkpoint = f.owner.read(f.sessionId,f.dir,0);
    for (const record of records.slice(split)) located.push(f.append(record));
    let after;
    try { after = await f.read({ includeTurnCoordinates:true,rootCheckpoint:checkpoint }); }
    finally { checkpoint?.release(); }
    try {
      const expected = JSON.parse(JSON.stringify(legacyRows(f.sessionId,located,{ includeTurnCoordinates:true })));
      assert.deepEqual(await smallRows(after),expected);
      if (name.startsWith('rollback')) {
        assert.ok(!JSON.stringify(expected).includes('must not adopt new owner'));
        assert.equal(expected.filter(row => row.role === 'user').length,1);
        assert.equal(expected.find(row => row.role === 'user').content,'new');
      }
      assert.deepEqual(await hashRoot(before),beforeDigest);
      const warm = await f.read({ includeTurnCoordinates:true });
      try { assert.deepEqual(await smallRows(warm),expected); } finally { warm.release(); }
    } finally { after.release(); }
  } finally { before.release(); }
});

test('call-time input snapshot / aliases / sparse own fields / same raw object reused in another feed', async t => {
  const f = fixture(t), arena = new HistoryProjectionArena(f.store);
  const projector = api.createCodexHistoryProjector(f.sessionId,{}, { rooted:arena });
  t.after(() => arena.close());
  const shared = { path:'original' }, sparse = new Array(5); sparse[2] = shared; sparse.extra = shared;
  const args = { one:shared,two:shared,sparse,map:new Map([[shared,shared]]),set:new Set([shared]) };
  Object.defineProperty(args,'__proto__',{ value:shared,enumerable:true });
  args.self = args;
  const input = rec('response_item',{ type:'custom_tool_call',name:'opaque',call_id:'first',input:args });
  projector.feed({ ...user('owner'),__line:0 }); projector.feed({ ...input,__line:1 });
  const frozen = projector.exportRoot();
  try {
    const first = [...frozen.cursor().field('pendingCalls').pairs()][0][1];
    const owned = first.field('args');
    assert.equal(owned.field('one').identity(),owned.field('two').identity());
    assert.equal(owned.field('one').identity(),owned.field('sparse').at(2).identity());
    assert.equal(owned.field('one').identity(),owned.field('sparse').field('extra').identity());
    assert.equal(owned.field('one').identity(),owned.field('__proto__').identity());
    assert.equal(owned.field('sparse').length,5); assert.equal(owned.field('sparse').at(4).kind,'undefined');
    assert.equal(owned.identity(),owned.field('self').identity());
    assert.equal(owned.identity(),first.field('record').field('payload').field('input').identity());
    const [[key,value]] = owned.field('map').pairs(); assert.equal(key.identity(),value.identity());
    assert.equal(key.identity(),owned.field('one').identity());
    shared.path = 'mutated'; sparse.length = 0; args.extra = 'later'; input.payload.call_id = 'second';
    projector.feed({ ...input,__line:2 });
    assert.equal(smallText(owned.field('one').field('path')),'original');
    assert.equal(owned.field('extra').kind,'undefined');
    const next = projector.exportRoot();
    try {
      let count = 0;
      for (const [key,call] of next.cursor().field('pendingCalls').pairs()) {
        assert.equal(smallText(call.field('args').field('one').field('path')),smallText(key) === 'first' ? 'original' : 'mutated'); count++;
      }
      assert.equal(count,2); assert.equal(arena.inspectOwnership().inputIdentitySlots,0);
    } finally { next.release(); }
  } finally { frozen.release(); }
});

test('arena fork/import writes no copied owners; failed feed rolls back root and registers', async t => {
  const f = fixture(t), arena = new HistoryProjectionArena(f.store), p = api.createCodexHistoryProjector(f.sessionId,{}, { rooted:arena });
  t.after(() => arena.close());
  p.feed({ ...user('old'),__line:1 });
  const old = p.exportRoot(), written = f.store.stats().pagesWritten;
  const fork = new HistoryProjectionArena(f.store,old);
  assert.equal(f.store.stats().pagesWritten,written);
  fork.close();
  let fault = true; const write = f.store.setField.bind(f.store);
  const mock = t.mock.method(f.store,'setField',(...args) => { if (fault && args[1] === 'content') { fault = false; throw Error('controlled page fault'); } return write(...args); });
  try {
    assert.throws(() => p.feed({ ...answer('failed'),__line:2 }),/controlled page fault/);
    mock.mock.restore();
    assert.equal(p.getConsumedRecords(),1);
    p.feed({ ...answer('retry'),__line:2 });
    const root = p.finalizeRoot();
    try { assert.equal(root.cursor().length,2); assert.equal(smallText(root.cursor().at(1).field('content')),'retry'); }
    finally { root.release(); }
    assert.equal(old.cursor().field('entries').length,1);
  } finally { old.release(); }
});

test('forced hash collision keeps exact pending keys, alias texts and row identities', async t => {
  const f = fixture(t,{ store:{ textDigestFactory:() => ({ update(){ return this; },digest(){ return '0'.repeat(64); } }) } });
  const records = [user('one'),call('a'),call('b'),user('two'),output('b','result B'),output('a','result A')].map(f.append);
  const actual = await f.read();
  try { assert.deepEqual(await smallRows(actual),JSON.parse(JSON.stringify(legacyRows(f.sessionId,records)))); }
  finally { actual.release(); }
});

test('actual store close/reopen restores durable checkpoint and only feeds append', async t => {
  const f = fixture(t); f.append(user('owner')); f.append(call('late'));
  const first = await f.read(), digest = await hashRoot(first), count = first.fedRecords;
  first.release(); f.owner.close(); f.store.close();
  const store = new HistoryPagedStore({ filename:f.store.filename,indexBytes:0,residentPages:3 });
  const owner = new CodexRootProjectionOwner(store);
  try {
    const warm = await f.read({ rootedOwner:owner });
    try { assert.equal(warm.mode,'unchanged'); assert.equal(warm.fedRecords,0); assert.equal(warm.reusedRecords,count);
      assert.deepEqual(await hashRoot(warm),digest); }
    finally { warm.release(); }
    f.append(output('late','after restart'));
    const next = await f.read({ rootedOwner:owner });
    try { assert.equal(next.mode,'append'); assert.equal(next.fedRecords,1); assert.equal(next.entries.length,2); }
    finally { next.release(); }
  } finally { owner.close(); store.close(); }
});

test('missing canonical page fails at the exact page; it never starts a whole-history rebuild', async t => {
  const f = fixture(t); f.append(user('owner')); f.append(answer('full answer'));
  const first = await f.read();
  const state = first.checkpoint.cursor();
  const missing = Number(state.field('entries').at(1).identity().split(':').pop());
  first.release();
  f.store.cache.clear(); f.store.cacheBytes = 0;
  f.store.sql('DELETE FROM hp_pages WHERE id=?').run(missing);
  let feeds = 0;
  await assert.rejects(f.read({ observeRoot: stats => { if(stats.phase === 'feed') feeds++; } }),{ code:'history_page_missing_or_corrupt' });
  assert.equal(feeds,0);
});

test('actual Task spawn order / own-child completion / exact process identity survive rooted warm publication', async t => {
  resetCodexProcessActionOwnershipForTests(); t.after(resetCodexProcessActionOwnershipForTests);
  const f = fixture(t); f.append(user('spawn'));
  const spawn = (id,args) => { const r = call(id,'spawn_agent',args); r.payload.namespace = 'multi_agent_v1'; return r; };
  const a = f.append(spawn('spawn-a',{ message:'first child',task_name:'a' }));
  f.append(spawn('spawn-b',{ message:'second child',task_name:'b' }));
  const childA = '33333333-3333-4333-8333-333333333333', childB = '44444444-4444-4444-8444-444444444444';
  f.append(output('spawn-b',JSON.stringify({ agent_id:childB,nickname:'B' })));
  f.append(output('spawn-a',JSON.stringify({ agent_id:childA,nickname:'A' })));
  recordCodexProcessActionOwnership({ sessionId:f.sessionId,callId:'spawn-a',sourceByteOffset:a.__byteOffset,lifecycleGeneration:'owned-generation:7' });
  const first = await f.read();
  try {
    const cards = (await smallRows(first)).flatMap(x=>x.actions || []).filter(x=>x.tool === 'Task');
    assert.deepEqual(cards.map(x=>x.toolUseId),['spawn-b','spawn-a']);
    assert.equal(cards[1].processGeneration,'owned-generation:7');
    assert.equal(cards[0].processGeneration,undefined);
    const childFile = path.join(f.dir,'rollout-' + childA + '.jsonl');
    fs.writeFileSync(childFile,JSON.stringify({ type:'event_msg',timestamp:'2026-10-22T00:00:02Z',payload:{ type:'task_complete' } })+'\n');
    const next = await f.read();
    try {
      assert.equal(next.fedRecords,0);
      const after = (await smallRows(next)).flatMap(x=>x.actions || []).filter(x=>x.tool === 'Task');
      assert.equal(after[1].subagentStatus,'completed'); assert.equal(after[1].completionTimingSource,'child');
      assert.equal(after[0].subagentStatus,'running');
      const frozen = (await smallRows(first)).flatMap(x=>x.actions || []).filter(x=>x.tool === 'Task');
      assert.equal(frozen[1].subagentStatus,'running');
    } finally { next.release(); }
  } finally { first.release(); }
});

test('logical cursors retain their own frozen index through ordinal replacement and durable pin', async t => {
  const f = fixture(t), arena = new HistoryProjectionArena(f.store);
  const first = arena.step(() => { arena.state().rows = arena.own([{ content:'A' },{ content:'B' }]); return arena.publish(arena.state().rows); });
  const branch = arena.fork();
  const second = branch.step(() => { branch.state().rows[0].content = 'different revision'; return branch.publish(branch.state().rows); });
  const before = f.store.stats().pagesWritten;
  const changed = f.store.withOrdinal(first.cursor(),1,second.cursor().at(0));
  assert.ok(f.store.stats().pagesWritten - before < 20,'ordinal replacement shares indices, not whole SQL cloning');
  f.store.replacePin('own-durable-view',changed.cursor());
  first.release(); second.release(); changed.release(); arena.close(); branch.close();
  const pinned = f.store.openPin('own-durable-view');
  try {
    assert.equal(smallText(pinned.cursor().at(0).field('content')),'A');
    assert.equal(smallText(pinned.cursor().at(1).field('content')),'different revision');
  } finally { pinned.release(); f.store.removePin('own-durable-view'); }
});

test('rewrite plus growth during finalization cannot publish old prefix as an append', async t => {
  const f = fixture(t); f.append(user('owner')); f.append(answer('BEFORE'));
  const old = await f.read(), digest = await hashRoot(old);
  f.append(answer('next'));
  let changed = false;
  try {
    const current = await f.read({ observeRoot: stats => {
      if (!changed && stats.phase === 'finalization') {
        changed = true;
        const source = fs.readFileSync(f.filePath,'utf8').replace('BEFORE','AFTER!');
        fs.writeFileSync(f.filePath,source + JSON.stringify(answer('grew')) + '\n');
      }
    } });
    try {
      assert.equal(changed,true);
      assert.equal(smallText(current.entries.at(1).field('content')),'AFTER!');
      assert.equal(current.entries.length,4);
      assert.deepEqual(await hashRoot(old),digest);
    } finally { current.release(); }
  } finally { old.release(); }
});

test('publication observer fault and backing commit fault release staged leases and retain prior root', async t => {
  const f = fixture(t); f.append(user('owner')); f.append(answer('valid'));
  const first = await f.read(), digest = await hashRoot(first), leases = f.store.stats().leases;
  try {
    await assert.rejects(f.read({ observeRoot: stats => { if (stats.rootPublished) throw Error('observer publication fault'); } }),/observer publication fault/);
    assert.equal(f.store.stats().leases,leases,'a view published inside a failed callback must release its lease');
    assert.deepEqual(await hashRoot(first),digest);
    const arena = new HistoryProjectionArena(f.store,first.checkpoint);
    try {
      const prior = arena.checkpoint(), priorPage = prior.descriptor.page, count = f.store.stats().leases;
      const fault = t.mock.method(f.store,'checkDisk',() => { throw Object.assign(Error('controlled full backing'),{ code:'HISTORY_BACKING_FULL' }); });
      try { assert.throws(() => arena.step(() => arena.publish(arena.state())),{ code:'HISTORY_BACKING_FULL' }); }
      finally { fault.mock.restore(); }
      assert.equal(f.store.stats().leases,count,'rolled-back public and internal publication leases are both released');
      const current = arena.checkpoint();
      try { assert.equal(current.descriptor.page,priorPage); } finally { current.release(); prior.release(); }
    } finally { arena.close(); }
  } finally { first.release(); }
});

test('both production full-file entry points serialize rooted continuation publication', async t => {
  const f = fixture(t); f.append(user('owner')); f.append(answer('answer'));
  const options = { rootedOwner:f.owner,sessionsDir:f.dir,highWaterMark:64 };
  const [first,second] = await Promise.all([
    api.projectCodexFullHistoryStream(f.sessionId,f.dir,options),
    api.projectCodexFullHistoryFromFile(f.sessionId,f.dir,options),
  ]);
  try {
    assert.equal(first.mode,'rebuild'); assert.equal(second.mode,'unchanged');
    assert.equal(second.fedRecords,0);
    assert.deepEqual(await hashRoot(first),await hashRoot(second));
  } finally { first.release(); second.release(); }
});
