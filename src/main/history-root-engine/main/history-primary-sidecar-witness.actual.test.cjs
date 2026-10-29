'use strict';
// Finite SOURCE only: two owned SQLite connections, one attached sidecar file.
// node:sqlite substitutes the Electron ABI, never application/provider state.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const evidence = process.env.NOTED_WITNESS_EVIDENCE;
assert(evidence && path.isAbsolute(evidence), 'explicit owned evidence directory');
const BaseSQLite = require(process.env.NOTED_WITNESS_SQLITE_ADAPTER);
let liveConnections=0, peakConnections=0, peakFixtureBytes=0;
class SQLite extends BaseSQLite {
  constructor(...args) { super(...args);liveConnections++;peakConnections=Math.max(peakConnections,liveConnections);assert(liveConnections<=2); }
  close() { super.close();liveConnections--; }
}
const load = Module._load;
Module._load = function(id, parent, main) { return id === 'better-sqlite3' ? SQLite : load.call(this,id,parent,main); };
const DB = require('./database');
const TopDB = require('../../database');
const { HistoryPagedStore, materializeHistoryCursorSync: mat } = require('./history-paged-store');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { readPrimarySidecarWitness: witness } = require('./history-primary-sidecar-witness');
const { capturePrimaryDependencies, comparePrimaryDependencies } = require('./history-primary-dependencies');
const { decorateHistoryPromptPresentations: decorate } = require('./history-prompt-presentations');
const { captureHistoryPromptSidecars } = require('./history-prompt-sidecar-root');
const { applyRootResponseTimings } = require('./history-root-response-timings');
const promptSchema = require('./history-prompt-version-schema');
const freshness = require('./history-freshness-metadata');
function original(relative) {
  const filename=path.resolve(__dirname,relative), m=new Module(filename,module);
  m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(path.join(evidence,'before','src/main/history-root-engine/main',relative),'utf8'),filename);
  return m.exports;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(evidence,'fixture-')), file = path.join(dir,'sidecars.sqlite');
  let r = new SQLite(file); r.pragma('journal_mode = WAL'); r.pragma('max_page_count = 8192');
  r.exec(`CREATE TABLE history_prompt_presentations(tool_type TEXT NOT NULL, session_id TEXT NOT NULL,
    audit_timestamp TEXT NOT NULL, transport_hash TEXT NOT NULL, entry_uuid TEXT, schema_version INTEGER NOT NULL DEFAULT 1,
    chips_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
    PRIMARY KEY(tool_type,session_id,audit_timestamp,transport_hash));
    CREATE INDEX idx_history_prompt_presentations_uuid ON history_prompt_presentations(tool_type,entry_uuid);
    CREATE TABLE history_response_timings(interval_id INTEGER PRIMARY KEY,tool_type,tab_id,session_id,entry_uuid,source_identity,updated_at);
    CREATE TABLE history_response_timing_aliases(interval_id,tool_type,session_id,entry_uuid,source_identity,updated_at,
      PRIMARY KEY(interval_id,tool_type,session_id),UNIQUE(tool_type,session_id,entry_uuid));
    CREATE TABLE agent_activity_intervals(id INTEGER PRIMARY KEY,start_ts,end_ts,duration_ms);
    CREATE TABLE session_history_events(session_id,source_session_id,child_session_id,event_type);
    CREATE TABLE session_links(parent_session_id,child_session_id);
    CREATE TABLE app_state(key PRIMARY KEY,value);`);
  if (promptSchema.installHistoryPromptVersionSchema) promptSchema.installHistoryPromptVersionSchema(r);
  else r.exec(promptSchema.HISTORY_PROMPT_VERSION_SCHEMA);
  freshness.installHistoryFreshnessMetadata(r);
  const manager = new DB({existingConnection:r}); manager.getSessionHistoryContext = () => null;
  const top = Object.create(TopDB.prototype); top.db = r;
  const store = new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:16*1024**2});
  const w = store.db;
  w.prepare('ATTACH DATABASE ? AS sidecar').run(file); w.pragma('sidecar.max_page_count = 8192');
  const service = {promptPresentationStore:manager};
  const read = () => witness(r,['captured','ancestor'],'OWN');
  const deps = () => capturePrimaryDependencies(service,{},['captured','ancestor'],{tabId:'OWN'});
  const change = sql => w.exec(sql.replace(/\b(history_prompt_presentations|history_response_timings|history_response_timing_aliases|agent_activity_intervals|session_history_events|session_links|app_state)\b/g,'sidecar.$1'));
  const reopen = () => { r.close(); r = new SQLite(file,{readonly:true}); manager.db=r;top.db=r; };
  t.after(() => {
    const bytes=fs.readdirSync(dir).reduce((sum,name)=>sum+fs.statSync(path.join(dir,name)).size,0);
    peakFixtureBytes=Math.max(peakFixtureBytes,bytes);assert(bytes<=128*1024**2);
    store.close();r.close(); fs.rmSync(dir,{recursive:true,force:true});
  });
  return {get r(){return r;},w,manager,top,store,read,deps,change,reopen};
}

test('prompt updated_at-only upsert changes actual winner and both revision APIs across a foreign commit', t => {
  const f=fixture(t);
  const save=(audit,text)=>f.manager.saveHistoryPromptPresentation({toolType:'codex',sessionId:'captured',
    auditTimestamp:audit,transportHash:audit,entryUuid:'same-user',chips:[{kind:'prompt',id:text,label:text,text}]});
  save('a','A');save('b','B');
  f.change("UPDATE history_prompt_presentations SET updated_at=CASE audit_timestamp WHEN 'a' THEN 10 ELSE 20 END");
  const entries=[{uuid:'same-user',sessionId:'captured',role:'user',content:'owned',timestamp:'2026-10-25T00:00:00Z'}];
  const prep=()=>decorate(f.manager,{toolType:'codex',sessionId:'captured',entries});
  const before=prep(), proof=f.read(), revision=f.manager.getHistoryPromptPresentationRevision('codex'), legacy=f.top.getHistoryPromptPresentationRevision('codex');
  assert.equal(proof.mode,'scoped'); assert.equal(before[0].promptChips[0].text,'B');
  const captured=captureHistoryPromptSidecars(f.store,f.manager,{toolType:'codex',sessionId:'captured'});
  assert.deepEqual(mat(captured.rows).map(x=>x.chips[0].text),['A','B']); captured.release();
  const changes=f.r.prepare('SELECT total_changes() n').get().n;
  // Exact legal upsert effect of saveHistoryPromptPresentation, only the
  // foreign writer's clock differs. Duplicate entry UUIDs are schema-valid.
  f.change(`INSERT INTO history_prompt_presentations SELECT tool_type,session_id,audit_timestamp,transport_hash,
    entry_uuid,schema_version,chips_json,created_at,30 FROM history_prompt_presentations WHERE audit_timestamp='a'
    ON CONFLICT(tool_type,session_id,audit_timestamp,transport_hash) DO UPDATE SET updated_at=excluded.updated_at`);
  const after=prep(); assert.equal(after[0].promptChips[0].text,'A');
  assert.equal(f.r.prepare('SELECT total_changes() n').get().n,changes);
  t.diagnostic(JSON.stringify({before:before[0].promptChips,after:after[0].promptChips,beforeWitness:proof,afterWitness:f.read()}));
  assert.notDeepEqual(f.read(),proof,'changed prompt ordering must invalidate the witness');
  assert.notEqual(f.manager.getHistoryPromptPresentationRevision('codex'),revision);
  assert.notEqual(f.top.getHistoryPromptPresentationRevision('codex'),legacy);
});

test('UUID-wide actual captureBound sees foreign primary and new alias candidates beyond captured owners', async t => {
  const f=fixture(t);
  f.change(`INSERT INTO agent_activity_intervals VALUES(1,10,20,10);
    INSERT INTO history_response_timings VALUES(1,'codex','OWN','captured','same-assistant',NULL,1)`);
  const arena=new HistoryProjectionArena(f.store);
  const root=arena.step(()=>{
    arena.state().entries=arena.own([{uuid:'same-assistant',sessionId:'captured',role:'assistant',content:'full Ω\r\n\0',timestamp:'2026-10-25T00:00:00Z'}]);
    return arena.publish(arena.state().entries);
  });arena.close();
  t.after(()=>root.release());
  const prep=()=>applyRootResponseTimings(f.store,root,{db:f.manager,toolType:'codex',sessionId:'captured',tabId:'OWN'});
  const old=await prep(), frozen=mat(old.entries), before=f.read();
  assert.equal(before.mode,'scoped');assert.equal(frozen[0].responseTiming.intervalId,1);
  const revision=old.revision;
  f.change(`INSERT INTO agent_activity_intervals VALUES(2,30,50,20);
    INSERT INTO history_response_timings VALUES(2,'codex','FOREIGN','foreign','same-assistant',NULL,2)`);
  const primary=await prep(); assert.equal(mat(primary.entries)[0].responseTiming.intervalId,2);
  const primaryRevision=primary.revision;primary.release();
  const primaryProof=f.read();
  f.change(`INSERT INTO agent_activity_intervals VALUES(3,60,90,30);
    INSERT INTO history_response_timings VALUES(3,'claude','FOREIGN','other-provider','different',NULL,3);
    INSERT INTO history_response_timing_aliases VALUES(3,'codex','foreign-alias','same-assistant',NULL,3)`);
  const alias=await prep();assert.equal(mat(alias.entries)[0].responseTiming.intervalId,3);alias.release();
  t.diagnostic(JSON.stringify({beforeWitness:before,primaryWitness:primaryProof,aliasWitness:f.read(),frozenTiming:frozen[0].responseTiming}));
  assert.notDeepEqual(primaryProof,before,'foreign primary appearance must invalidate');
  assert.notDeepEqual(f.read(),primaryProof,'foreign alias appearance must invalidate');
  assert.notEqual(primaryRevision,revision,'timing revision must cover the UUID-wide candidate');
  async function step(sql,intervalId,durationMs) {
    const proof=f.read();f.change(sql);assert.notDeepEqual(f.read(),proof);
    const current=await prep(), row=mat(current.entries)[0];
    assert.equal(row.responseTiming?.intervalId,intervalId);
    if(durationMs!==undefined)assert.equal(row.responseTiming.durationMs,durationMs);
    assert.equal(current.revision,f.manager.getHistoryResponseTimingRevision('codex','captured','OWN'));
    assert.equal(current.revision,f.top.getHistoryResponseTimingRevision('codex','captured','OWN'));
    current.release();assert.deepEqual(mat(old.entries),frozen,'old frozen root never changes');
  }
  // Fixed joined-dependency sequence, including dangling rows becoming visible.
  await step("UPDATE history_response_timing_aliases SET entry_uuid='away' WHERE interval_id=3",2,20);
  await step("UPDATE history_response_timing_aliases SET entry_uuid='same-assistant' WHERE interval_id=3",3,30);
  await step('UPDATE agent_activity_intervals SET start_ts=61,end_ts=99,duration_ms=38 WHERE id=3',3,38);
  await step("UPDATE history_response_timings SET tab_id='FOREIGN2',source_identity='new' WHERE interval_id=3",3,38);
  await step('DELETE FROM agent_activity_intervals WHERE id=3',2,20);
  await step('INSERT INTO agent_activity_intervals VALUES(3,60,100,40)',3,40);
  await step('DELETE FROM history_response_timings WHERE interval_id=3',2,20);
  await step("INSERT INTO history_response_timings VALUES(3,'claude','FOREIGN','other-provider','different',NULL,3)",3,40);
  await step('DELETE FROM history_response_timing_aliases WHERE interval_id=3',2,20);
  await step("UPDATE history_response_timings SET tool_type='claude' WHERE interval_id=2",1,10);
  await step('DELETE FROM history_response_timings WHERE interval_id=1',undefined);
  assert.deepEqual(mat(old.entries),frozen);old.release();
});

test('unrelated foreign UI commit hits; own writes, rollback, captured ancestor and connection replacement remain guarded', t => {
  const f=fixture(t), before=f.deps(), originalProof=f.read();
  f.change("INSERT INTO app_state VALUES('UI','saved')");
  assert.deepEqual(f.read(),originalProof);assert.deepEqual(comparePrimaryDependencies(before,f.deps()),{ok:true});
  f.change(`INSERT INTO history_prompt_presentations VALUES('codex','ancestor','a','hash','copied-uuid',1,'[{"kind":"prompt","text":"ancestor A"}]',0,1)`);
  const copied=[{uuid:'copied-uuid',role:'user',sessionId:'captured',content:'copied body'}];
  const decorated=()=>decorate(f.manager,{toolType:'codex',sessionId:'captured',entries:copied});
  assert.equal(decorated()[0].promptChips[0].text,'ancestor A');
  let ancestor=f.read();
  f.change(`UPDATE history_prompt_presentations SET chips_json='[{"kind":"prompt","text":"ancestor B"}]'`);
  assert.notDeepEqual(f.read(),ancestor);assert.equal(decorated()[0].promptChips[0].text,'ancestor B');
  ancestor=f.read();f.change('DELETE FROM history_prompt_presentations');assert.notDeepEqual(f.read(),ancestor);
  assert.equal(decorated()[0].promptChips,undefined);
  const foreignCommitted=f.read();
  assert.throws(()=>f.w.transaction(()=>{
    f.change("INSERT INTO app_state VALUES('rolled-back-foreign','x')");throw Error('foreign rollback');
  })(),/foreign rollback/);
  assert.deepEqual(f.read(),foreignCommitted,'foreign rollback publishes no committed version');
  f.r.exec("INSERT INTO app_state VALUES('own','saved')");
  assert.notDeepEqual(f.read(),originalProof,'own writes keep total_changes boundary');
  const committed=f.deps();
  assert.throws(()=>f.r.transaction(()=>{
    f.r.exec("UPDATE app_state SET value='aborted' WHERE key='own'");
    assert.equal(f.read(),null,'uncommitted state is never a reusable witness');
    throw Error('owned rollback');
  })(),/owned rollback/);
  assert.equal(comparePrimaryDependencies(committed,f.deps()).ok,false,'rollback still changes own total_changes');
  let proof=f.read();
  f.change("INSERT INTO session_history_events VALUES('ancestor','grandparent','child','fork')");
  assert.notDeepEqual(f.read(),proof);proof=f.read();
  f.change("UPDATE session_history_events SET source_session_id='new-parent' WHERE session_id='ancestor'");
  assert.notDeepEqual(f.read(),proof);proof=f.read();
  f.change("DELETE FROM session_history_events WHERE session_id='ancestor'");
  assert.notDeepEqual(f.read(),proof);proof=f.read();
  f.change("INSERT INTO session_links VALUES('ancestor','child')");assert.notDeepEqual(f.read(),proof);proof=f.read();
  f.change("UPDATE session_links SET parent_session_id='captured' WHERE child_session_id='child'");assert.notDeepEqual(f.read(),proof);proof=f.read();
  f.change("DELETE FROM session_links");assert.notDeepEqual(f.read(),proof);
  const previous=f.deps();f.reopen();
  assert.equal(f.read().mode,'scoped','Source read-only connection needs no DDL');
  assert.equal(comparePrimaryDependencies(previous,f.deps()).reason,'sidecar-owner-changed');
  const prepare=f.r.prepare.bind(f.r);let writes=0;
  f.r.prepare=sql=>{if(!/^(SELECT|PRAGMA)/.test(sql)){writes++;throw Error('unexpected DDL');}return prepare(sql);};
  assert.equal(new DB({existingConnection:f.r}).db,f.r,'read-only Source manager skips Main boot migration');
  assert.equal(f.read().mode,'scoped');assert.equal(writes,0);
});

test('Main upgrades only exact owned legacy triggers; strict attestation rejects missing/custom/invalid versions', t => {
  const f=fixture(t), oldPrompt=original('history-prompt-version-schema.js'), oldFresh=original('history-freshness-metadata.js');
  const triggers=()=>f.r.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  for(const {name} of triggers())f.r.exec('DROP TRIGGER '+name);
  f.r.exec(oldPrompt.HISTORY_PROMPT_VERSION_SCHEMA);oldFresh.installHistoryFreshnessMetadata(f.r);
  assert.equal(f.read().mode,'database','legacy DDL cannot attest provider-wide coverage');
  f.r.exec("INSERT INTO history_prompt_presentations VALUES('codex','ancestor','a','hash','u',1,'[]',0,1)");
  const rows=f.r.prepare('SELECT * FROM history_prompt_presentations').all(), version=f.r.prepare('SELECT * FROM history_prompt_revision_versions').all();
  require('../../history-prompt-version-schema').installHistoryPromptVersionSchema(f.r);
  require('../../history-freshness-metadata').installHistoryFreshnessMetadata(f.r);
  assert.deepEqual(f.r.prepare('SELECT * FROM history_prompt_presentations').all(),rows);
  assert.deepEqual(f.r.prepare('SELECT * FROM history_prompt_revision_versions').all(),version,'no reset or invented baseline');
  assert.equal(f.read().mode,'scoped');
  const schema=f.r.pragma('schema_version',{simple:true}), installed=triggers();
  promptSchema.installHistoryPromptVersionSchema(f.r);freshness.installHistoryFreshnessMetadata(f.r);
  assert.equal(f.r.pragma('schema_version',{simple:true}),schema,'idempotent boot leaves schema stable');
  assert.deepEqual(triggers(),installed);
  const proof=f.read();f.change("UPDATE history_prompt_presentations SET updated_at=2");assert.notDeepEqual(f.read(),proof);
  // Installer leaves an unknown trigger untouched; fallback sees foreign DML.
  f.r.exec(`DROP TRIGGER history_prompt_revision_update;
    CREATE TRIGGER history_prompt_revision_update AFTER UPDATE ON history_prompt_presentations BEGIN SELECT 7; END;`);
  const custom=triggers().find(x=>x.name==='history_prompt_revision_update').sql;
  promptSchema.installHistoryPromptVersionSchema(f.r);
  assert.equal(triggers().find(x=>x.name==='history_prompt_revision_update').sql,custom);
  assert.equal(f.read().mode,'database');
  const unknown=f.read();f.change("UPDATE history_prompt_presentations SET updated_at=3");assert.notDeepEqual(f.read(),unknown);
  f.r.exec('DROP TRIGGER history_prompt_revision_update');assert.equal(f.read().mode,'database');
  promptSchema.installHistoryPromptVersionSchema(f.r);assert.equal(f.read().mode,'scoped');
  f.r.exec("INSERT INTO history_freshness_versions VALUES('timing-provider','codex','*',-1)");
  assert.equal(f.read(),null,'invalid counter never becomes guessed zero');
  f.r.exec("DELETE FROM history_freshness_versions WHERE domain='timing-provider'");
  f.r.exec(`DROP TRIGGER freshness_agent_activity_intervals_update;
    CREATE TRIGGER freshness_agent_activity_intervals_update AFTER UPDATE ON agent_activity_intervals BEGIN SELECT 99; END;`);
  const customFresh=triggers().find(x=>x.name==='freshness_agent_activity_intervals_update').sql;
  freshness.installHistoryFreshnessMetadata(f.r);
  assert.equal(triggers().find(x=>x.name==='freshness_agent_activity_intervals_update').sql,customFresh);
  assert.equal(f.read().mode,'database');
  f.r.exec('DROP TABLE history_prompt_revision_versions');assert.equal(f.read().mode,'database');
});

test('top and isolated schema vocabulary stays identical; cold streaming digest equals legacy digest', t => {
  const f=fixture(t);
  for(const name of ['history-prompt-version-schema.js','history-freshness-metadata.js'])
    assert.equal(fs.readFileSync(path.join(__dirname,name),'utf8'),fs.readFileSync(path.resolve(__dirname,'../..',name),'utf8'));
  f.r.exec(`INSERT INTO history_prompt_presentations VALUES('codex','ancestor','a','hash','u',1,'[{"text":"Ω🙂"}]',0,19)`);
  assert.equal(f.manager.getHistoryPromptPresentationRevision('codex'),f.top.getHistoryPromptPresentationRevision('codex'));
  const prior=f.manager.getHistoryPromptPresentationRevision('codex');
  f.r.transaction(()=>{
    f.r.exec('UPDATE history_prompt_presentations SET updated_at=25');
    assert.notEqual(f.manager.getHistoryPromptPresentationRevision('codex'),prior);
    assert.equal(f.manager.getHistoryPromptPresentationRevision('codex'),f.top.getHistoryPromptPresentationRevision('codex'));
  })();
  assert.notEqual(f.manager.getHistoryPromptPresentationRevision('codex'),prior);
});

test.after(t=>{
  assert.equal(liveConnections,0);assert.equal(peakConnections,2);
  const maxRSSKiB=process.resourceUsage().maxRSS;assert(maxRSSKiB<=128*1024);
  t.diagnostic(JSON.stringify({peakConnections,peakFixtureBytes,maxRSSKiB,allOwnedFixturesRemoved:true}));
});
