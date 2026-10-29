'use strict';
// Finite SOURCE only. Reuse the prior two-connection actual-getter harness.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {SQLite,NativeDB,RootDB,fixture,seed,plain,capture,evidence}=require('./timeline-root-annotations.actual.test.cjs');
const schema=require('./timeline-annotation-version-schema');
const {readTimelineAnnotationFreshness:read}=require('./timeline-annotation-freshness');
const {HistoryProjectionArena}=require('./history-projection-arena');
const changed=e=>e.code==='TIMELINE_ANNOTATIONS_CAPTURE_CHANGED';
let semanticsPassed=false;
function setup(t) {
  const f=fixture(t);seed(f);
  // The scalar token is the exact held page-root descriptor, checked against
  // its live lease each time. No constant masquerades as source validation.
  const arena=new HistoryProjectionArena(f.store);
  const heldRoot=arena.step(()=>{arena.state().source=arena.own({sessionId:'physical',text:'finite source Ω'});return arena.publish();});
  arena.close();let currentRoot=heldRoot;
  const token=JSON.stringify(heldRoot.descriptor);
  const options=()=>({...f.captureOptions(),readSourceWitness:()=>{
    assert.equal(currentRoot,heldRoot,'exact heldRoot source authority');void heldRoot.cursor().kind;return token;
  }});
  t.after(()=>heldRoot.release());
  // t.after runs in registration order; release before store cleanup too.
  const close=f.store.close.bind(f.store);f.store.close=()=>{heldRoot.release();return close();};
  return {...f,captureOptions:options,sourceToken:token,invalidateSource:()=>{currentRoot=null;}};
}
async function during(f,mutate,producer=capture) {
  let calls=0;
  return producer({...f.captureOptions(),cooperate:async()=>{if(++calls===1)mutate();await new Promise(resolve=>setImmediate(resolve));}});
}
const versions=f=>read(f.db,'codex','physical');
const foreignUI=f=>f.store.db.exec("UPDATE annotation.app_state SET value=value||'x' WHERE key='unrelated-ui'");
function addUI(f) {
  const source=fs.readFileSync(path.resolve(__dirname,'../../database.js'),'utf8');
  f.db.exec(source.match(/CREATE TABLE IF NOT EXISTS app_state \([\s\S]*?\n\s+\)/)[0]);
  f.db.exec("INSERT INTO app_state(key,value) VALUES('unrelated-ui','visible')");
}
function preCapture() {
  const filename=path.resolve(__dirname,'timeline-root-annotations.js'),m=new Module(filename,module);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(path.join(evidence,'before/src/main/history-root-engine/main/timeline-root-annotations.js'),'utf8'),filename);
  return m.exports.captureTimelineRootAnnotations;
}

test('PRE unrelated actual UI commit refuses; POST exact full getter content/order/frozen roots passes',async t=>{
  const f=setup(t);addUI(f);
  const expected=f.native(f.manager);assert.deepEqual(f.native(f.rootManager),expected);
  const old=await capture(f.captureOptions()),frozen=plain(old),fork=old.fork();
  assert.deepEqual(frozen,expected,'full raw getter equality before freshness assertions');
  assert.deepEqual(frozen.promptSummaries.map(r=>r.entryUuid),['a','middle','z','']);
  assert.deepEqual(frozen.turnActionOverrides.map(r=>r.entryUuid),['a','middle','z','']);
  const before=versions(f),pins=f.pins();assert.equal(before.mode,'scoped');assert.equal(before.versions.length,5);
  let pre;
  await assert.rejects(during(f,()=>foreignUI(f),preCapture()),e=>{pre={code:e.code,reason:e.reason};return changed(e)&&e.reason==='dataVersion';});
  assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);
  const afterPre=versions(f);assert.notEqual(afterPre.dataVersion,before.dataVersion);assert.deepEqual(afterPre.versions,before.versions);
  const audit=afterPre.dataVersion;
  const post=await during(f,()=>foreignUI(f));
  assert.equal(post.captureWitness.dataVersion,audit,'original data_version retained as audit');
  assert.equal(post.captureWitness.sourceRevision,f.sourceToken);assert.equal(post.captureWitness.mode,'scoped');
  assert(Object.isFrozen(post)&&Object.isFrozen(post.captureWitness)&&Object.isFrozen(post.captureWitness.versions));
  assert.deepEqual(plain(post),expected);assert.deepEqual(f.native(f.manager),expected);
  assert.notEqual(versions(f).dataVersion,audit);assert.deepEqual(versions(f).versions,before.versions);
  f.foreign("UPDATE timeline_notes SET content='same timestamp replacement' WHERE entry_uuid='a' AND session_id='physical'");
  const fresh=await capture(f.captureOptions());assert.deepEqual(plain(fresh),f.native(f.manager));assert.notDeepEqual(plain(fresh),expected);
  assert.deepEqual(plain(old),expected);old.release();assert.deepEqual(plain(fork),expected);
  post.release();fresh.release();fork.release();assert.equal(f.pins(),pins-2); // only held source remains
  fs.writeFileSync(path.join(evidence,'PRE-POST.json'),JSON.stringify({pre,post:'PASS same complete content',before,afterPre,
    originalDataVersionAudit:audit,heldSourceToken:f.sourceToken,rawGetterEquality:true,ordering:true,frozen:true},null,2)+'\n');
  semanticsPassed=true;
});

test('all five actual tables: foreign INSERT/UPDATE/DELETE and OLD+NEW scope moves invalidate correct vector',async t=>{
  assert(semanticsPassed,'content before work/freshness assertions');
  const f=setup(t);const baselinePins=f.pins(),receipts=[];
  const updates=["content='foreign same timestamp'","entry_uuid='moved-marker'","summary='foreign same timestamp'",
    "outline_json='{\"changed\":true}'","action_label='foreign same timestamp'"];
  for(const [i,table] of schema.TABLES.entries()) {
    for(const action of ['UPDATE','DELETE','INSERT']) {
      const predicate=table.name==='timeline_outlines'?"tool_type='codex' AND session_id='physical'":
        "entry_uuid='"+(i===1&&action==='DELETE'?'moved-marker':'z')+"' AND session_id='physical'"+(table.provider?" AND tool_type='codex'":'');
      // Restore the seed row without unbounded fixture/loop allocation.
      if(action==='INSERT') f.db.exec('DELETE FROM '+table.name+' WHERE '+predicate);
      const before=versions(f);let sql;
      if(action==='UPDATE') sql='UPDATE '+table.name+' SET '+updates[i]+' WHERE '+predicate;
      else if(action==='DELETE') sql='DELETE FROM '+table.name+' WHERE '+predicate;
      else {
        const values=i===0?"('z','physical','another-tab','insert')":i===1?"('z','physical')":
          i===2?"('codex','physical','z','insert')":i===3?"('codex','physical','h','{}')":"('codex','physical','z','insert')";
        const cols=i===0?'entry_uuid,session_id,tab_id,content':i===1?'entry_uuid,session_id':
          i===2?'tool_type,session_id,entry_uuid,summary':i===3?'tool_type,session_id,source_hash,outline_json':'tool_type,session_id,entry_uuid,action_label';
        sql='INSERT INTO '+table.name+'('+cols+') VALUES'+values;
      }
      await assert.rejects(during(f,()=>f.foreign(sql)),e=>changed(e)&&e.reason==='versions');
      const after=versions(f);assert(after.versions[i]>before.versions[i]);
      after.versions.forEach((v,j)=>{if(j!==i)assert.equal(v,before.versions[j]);});
      assert.equal(after.totalChanges,before.totalChanges);assert.equal(f.pins(),baselinePins);assert.equal(f.store.builders,0);
      receipts.push({table:table.name,action,before:before.versions,after:after.versions});
    }
    const before=versions(f),target=read(f.db,'claude','destination');
    // Move all current target rows: OLD exact session must invalidate too.
    await assert.rejects(during(f,()=>f.foreign('UPDATE '+table.name+" SET session_id='destination'"+
      (table.provider?",tool_type='claude'":'')+" WHERE session_id='physical'"+(table.provider?" AND tool_type='codex'":''))),changed);
    const moved=read(f.db,'claude','destination');
    assert(versions(f).versions[i]>before.versions[i]);assert(moved.versions[i]>target.versions[i]);
    // And NEW scope: a move into the target invalidates a known empty read.
    await assert.rejects(during(f,()=>f.foreign('UPDATE '+table.name+" SET session_id='physical'"+
      (table.provider?",tool_type='codex'":'')+" WHERE session_id='destination'"+(table.provider?" AND tool_type='claude'":''))),changed);
  }
  fs.writeFileSync(path.join(evidence,'RELEVANT-WRITES.json'),JSON.stringify(receipts,null,2)+'\n');
});

test('same-table other sessions/providers stay outside scope; note tab_id is not a scope; own rollback refuses',async t=>{
  assert(semanticsPassed);const f=setup(t),before=f.native(f.manager);
  for(const [i,table] of schema.TABLES.entries()) {
    const scopes=table.provider?[['claude','physical'],['codex','unrelated']]:[['','unrelated']];
    for(const [tool,session] of scopes) {
      const fields=i===0?{entry_uuid:'outside',session_id:session,tab_id:'foreign',content:'outside'}:
        i===1?{entry_uuid:'outside',session_id:session}:
        i===2?{tool_type:tool,session_id:session,entry_uuid:'outside',summary:'outside'}:
        i===3?{tool_type:tool,session_id:session,source_hash:'h',outline_json:'{}'}:
        {tool_type:tool,session_id:session,entry_uuid:'outside',action_label:'outside'};
      f.insert(table.name,fields);
      const scope="session_id='"+session+"'"+(table.provider?" AND tool_type='"+tool+"'":'');
      const prior=read(f.db,tool||'codex',session),target=versions(f);
      const s=await during(f,()=>f.foreign('UPDATE '+table.name+' SET session_id=session_id WHERE '+scope));
      assert.deepEqual(plain(s),before);assert.deepEqual(versions(f).versions,target.versions);
      assert(read(f.db,tool||'codex',session).versions[i]>prior.versions[i],'actual outside row committed');s.release();
    }
  }
  const committedCut=versions(f),prepare=f.db.prepare.bind(f.db);let interleaved=false;
  f.db.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.startsWith('SELECT version FROM main.timeline_annotation_versions'))return statement;
    return {...statement,get(...args){
      const row=statement.get(...args);
      if(!interleaved){interleaved=true;f.store.db.exec('BEGIN');
        try {f.foreign("UPDATE timeline_notes SET content='atomic' WHERE session_id='physical';"+
          "UPDATE timeline_prompt_summaries SET summary='atomic' WHERE tool_type='codex' AND session_id='physical'");f.store.db.exec('COMMIT');}
        catch(error){f.store.db.exec('ROLLBACK');throw error;}}
      return row;
    }};
  };
  try {assert.deepEqual(versions(f).versions,committedCut.versions,'five-vector is one committed snapshot, never a mixed cut');}
  finally {f.db.prepare=prepare;}
  assert(interleaved);assert.notDeepEqual(versions(f).versions,committedCut.versions,'next committed cut sees both writes');
  await assert.rejects(during(f,()=>f.foreign("UPDATE timeline_notes SET tab_id='different-owner' WHERE session_id='physical'")),changed);
  const committed=versions(f);
  await assert.rejects(during(f,()=>{
    f.db.exec('BEGIN');f.db.exec("UPDATE timeline_outlines SET outline_json='{}' WHERE session_id='physical'");f.db.exec('ROLLBACK');
  }),e=>changed(e)&&e.reason==='totalChanges');
  assert.deepEqual(versions(f).versions,committed.versions,'rolled-back trigger counters roll back too');
  assert(versions(f).totalChanges>committed.totalChanges,'connection total_changes retains own rollback');
  const s=await during(f,()=>{
    f.store.db.exec('BEGIN');f.foreign("DELETE FROM timeline_notes WHERE session_id='physical'");f.store.db.exec('ROLLBACK');
  });assert.deepEqual(plain(s),f.native(f.manager));s.release();
  const pins=f.pins();
  await assert.rejects(during(f,()=>f.invalidateSource()),/exact heldRoot source authority/);
  assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);
});

test('unknown/missing/custom DDL remains global-conservative; installer preserves versions and foreign grammar',async t=>{
  assert(semanticsPassed);const f=setup(t);addUI(f);
  const trigger=[...schema.triggerDefinitions().keys()][0];
  const readDDL=()=>f.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger)?.sql;
  const counterRows=()=>f.db.prepare('SELECT * FROM timeline_annotation_versions ORDER BY annotation_table,tool_type,session_id').all();
  const scenarios=[
    ()=>f.db.exec('DROP TRIGGER '+trigger),
    ()=>f.db.exec('CREATE TRIGGER '+trigger+' AFTER INSERT ON timeline_notes BEGIN SELECT 1; END;'),
    ()=>f.db.exec('CREATE TRIGGER custom_annotation AFTER UPDATE ON timeline_outlines BEGIN SELECT 9; END;'),
  ];
  for(const change of scenarios) {
    change();assert.equal(versions(f).mode,'database');const counters=counterRows(),custom=readDDL();
    await assert.rejects(during(f,()=>foreignUI(f)),e=>changed(e)&&e.reason==='dataVersion');
    schema.installTimelineAnnotationVersionSchema(f.db);
    assert.deepEqual(counterRows(),counters,'never reset versions');
    if(custom)assert.equal(readDDL(),custom,'never overwrite custom DDL');
    if(!custom)f.db.exec('DROP TRIGGER '+trigger); // next scenario supplies custom grammar
  }
  // A table with identical columns but custom collation cannot attest scope.
  f.db.exec('DROP TRIGGER custom_annotation');f.db.exec('DROP TRIGGER '+trigger);schema.installTimelineAnnotationVersionSchema(f.db);
  assert.equal(versions(f).mode,'scoped');
  f.db.exec('ALTER TABLE timeline_notes ADD COLUMN unknown TEXT');
  assert.equal(versions(f).mode,'database');
  await assert.rejects(capture(f.captureOptions()),{code:'TIMELINE_ANNOTATIONS_SCHEMA_UNKNOWN'});
  // Fresh schemas remain global conservative when metadata is absent.
  f.db.exec('ALTER TABLE timeline_notes DROP COLUMN unknown');
  f.db.exec('DROP TABLE timeline_annotation_versions');
  assert.equal(versions(f).mode,'database');
  await assert.rejects(during(f,()=>foreignUI(f)),e=>changed(e)&&e.reason==='dataVersion');
  // Restore only owned fixture objects, then prove same-column custom table
  // grammar is not accepted just because table_info would look compatible.
  for(const name of schema.triggerDefinitions().keys()) f.db.exec('DROP TRIGGER '+name);
  f.db.exec('DROP TABLE timeline_notes');
  f.db.exec(schema.TABLES[0].ddl.replace('content TEXT NOT NULL', 'content TEXT COLLATE NOCASE NOT NULL'));
  schema.installTimelineAnnotationVersionSchema(f.db);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='timeline_annotation_versions'").get().n,0,
    'installer does not bless custom source DDL');
  assert.equal(versions(f).mode,'database');
  await assert.rejects(during(f,()=>foreignUI(f)),e=>changed(e)&&e.reason==='dataVersion');
});

test('top/nested installers idempotent, invalid counters and TEMP shadows refuse; existingConnection constructors no DDL',async t=>{
  assert(semanticsPassed);const f=setup(t);
  for(const name of ['timeline-annotation-version-schema.js','timeline-annotation-freshness.js'])
    assert.equal(fs.readFileSync(path.join(__dirname,name),'utf8'),fs.readFileSync(path.resolve(__dirname,'../..',name),'utf8'));
  for(const DB of [NativeDB,RootDB]) {
    const connection={prepare(){throw Error('reader constructor SQL');},exec(){throw Error('reader constructor DDL');}};
    assert.equal(new DB({existingConnection:connection}).db,connection);
    const init=DB.prototype.initTables.toString();assert(init.indexOf("require('./timeline-annotation-version-schema')")>init.indexOf('CREATE TABLE IF NOT EXISTS timeline_rewind_markers'));
  }
  const rows=f.db.prepare('SELECT * FROM timeline_annotation_versions').all(),schemaVersion=versions(f).schemaVersion;
  require('../../timeline-annotation-version-schema').installTimelineAnnotationVersionSchema(f.db);schema.installTimelineAnnotationVersionSchema(f.db);
  assert.equal(versions(f).schemaVersion,schemaVersion);assert.deepEqual(f.db.prepare('SELECT * FROM timeline_annotation_versions').all(),rows);
  f.db.exec("UPDATE timeline_annotation_versions SET version=-1 WHERE annotation_table='timeline_notes'");
  assert.equal(versions(f),null);await assert.rejects(capture(f.captureOptions()),{code:'TIMELINE_ANNOTATIONS_WITNESS_UNKNOWN'});
  f.db.exec("UPDATE timeline_annotation_versions SET version=1 WHERE annotation_table='timeline_notes'");
  f.db.exec('CREATE TEMP TABLE timeline_notes(x)');assert.equal(versions(f).mode,'database');
  f.db.exec('DROP TABLE temp.timeline_notes');assert.equal(versions(f).mode,'scoped');
  const transaction=f.db.transaction;f.db.transaction=fn=>()=>fn();
  try {assert.equal(versions(f),null,'a callback without a real SQLite transaction is not a committed cut');}
  finally {f.db.transaction=transaction;}
  f.db.exec('BEGIN');assert.equal(versions(f),null);f.db.exec('ROLLBACK');
  // A legacy position column appended by actual ALTER is a recognized grammar.
  for(const name of schema.triggerDefinitions().keys()) f.db.exec('DROP TRIGGER '+name);
  f.db.exec('DROP TABLE timeline_notes');
  const ddl=schema.TABLES[0].ddl.replace(/\s*position TEXT DEFAULT 'before',/,'');f.db.exec(ddl);
  f.db.exec("ALTER TABLE timeline_notes ADD COLUMN position TEXT DEFAULT 'before'");
  schema.installTimelineAnnotationVersionSchema(f.db);assert.equal(versions(f).mode,'scoped');
  const s=await capture(f.captureOptions());assert.deepEqual(plain(s),f.native(f.manager));s.release();
});

test('actual top/nested normal initTables installs once; read-only existingConnection consumes without migration',t=>{
  assert(semanticsPassed);const f=fixture(t);
  for(const name of schema.triggerDefinitions().keys())f.db.exec('DROP TRIGGER '+name);
  f.db.exec('DROP TABLE timeline_annotation_versions');
  assert.equal(read(f.db,'codex','physical').mode,'database');
  // Run the actual normal-init method on owned finite SQLite only. No app,
  // constructor default-prompt seeding, native process, or user database.
  NativeDB.prototype.initTables.call(f.manager);
  assert.equal(read(f.db,'codex','physical').mode,'scoped');
  f.db.exec("INSERT INTO timeline_notes(entry_uuid,session_id,tab_id,content) VALUES('u','physical','x','body')");
  const counters=f.db.prepare('SELECT * FROM timeline_annotation_versions').all();
  RootDB.prototype.initTables.call(f.rootManager);
  assert.deepEqual(f.db.prepare('SELECT * FROM timeline_annotation_versions').all(),counters);
  assert.equal(read(f.db,'codex','physical').mode,'scoped');
  // Reuse the second native connection read-only, never exceed two.
  f.store.close();
  const readonly=new SQLite(f.file,{readonly:true});
  try {
    let writes=0;const exec=readonly.exec.bind(readonly);
    readonly.exec=sql=>{if(!/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)){writes++;throw Error('reader DDL/DML');}return exec(sql);};
    for(const DB of [NativeDB,RootDB]) {
      const manager=new DB({existingConnection:readonly});
      assert.equal(read(manager.db,'codex','physical').mode,'scoped');
      assert.deepEqual(manager.getTimelineNotes('physical'),f.manager.getTimelineNotes('physical'));
    }
    assert.equal(writes,0);
  } finally {readonly.close();}
});
