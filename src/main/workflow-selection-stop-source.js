'use strict';
const crypto=require('node:crypto');
const META='workflow_selection_stop_source_meta';
const CLOCK='workflow_selection_stop_source_clocks';
const MAX=Number.MAX_SAFE_INTEGER;
// These are the existing Stop execution/source predicates, not UI, model,
// statistics or future-launch preferences. Unknown future source versions fail
// in the selection scope reader; columns are never added to this list by guess.
const SOURCE_COLUMNS=Object.freeze(['id','tab_id','project_id','execution_subject_version','execution_subject_id',
  'execution_namespace','execution_archived','cwd','command_type','restore_placement_id',
  'claude_session_id','codex_session_id','gemini_session_id','tab_type','file_path','parent_tab_id',
  'visual_parent_tab_id','closed_visual_parent_tab_id']);
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const fail=code=>{throw Object.assign(Error(code),{code,statusCode:409});};
const validTab=prefix=>`typeof(${prefix}.tab_id)='text' AND length(${prefix}.tab_id)>0`;
const different=(left,right)=>`${left} IS NOT ${right} COLLATE BINARY`;
const upsert=(prefix,present,where='1')=>`INSERT INTO ${CLOCK}(tab_id,revision,present,storage_id)
  SELECT ${prefix}.tab_id,1,${present},${prefix}.id WHERE ${validTab(prefix)} AND (${where})
  ON CONFLICT(tab_id) DO UPDATE SET revision=CASE WHEN revision>=${MAX}
    THEN RAISE(ABORT,'selection_stop_source_clock_exhausted') ELSE revision+1 END,
    present=excluded.present,storage_id=excluded.storage_id;`;
const TRIGGERS=[
  {name:'workflow_selection_stop_source_insert',sql:`CREATE TRIGGER workflow_selection_stop_source_insert AFTER INSERT ON tabs
    BEGIN ${upsert('NEW','1')} END`},
  {name:'workflow_selection_stop_source_delete',sql:`CREATE TRIGGER workflow_selection_stop_source_delete AFTER DELETE ON tabs
    BEGIN ${upsert('OLD','0')} END`},
  {name:'workflow_selection_stop_source_update',sql:`CREATE TRIGGER workflow_selection_stop_source_update AFTER UPDATE OF ${SOURCE_COLUMNS.map(quote).join(',')} ON tabs
    WHEN ${SOURCE_COLUMNS.map(key=>different('NEW.'+quote(key),'OLD.'+quote(key))).join(' OR ')}
    BEGIN ${upsert('OLD',`CASE WHEN ${different('NEW.tab_id','OLD.tab_id')} THEN 0 ELSE 1 END`)}
      ${upsert('NEW','1',different('NEW.tab_id','OLD.tab_id'))}
      UPDATE ${CLOCK} SET storage_id=NEW.id WHERE tab_id=NEW.tab_id AND ${validTab('NEW')}; END`},
];
const schemaHash=crypto.createHash('sha256').update(JSON.stringify({version:1,columns:SOURCE_COLUMNS,triggers:TRIGGERS})).digest('hex');
const tableSql=`CREATE TABLE ${CLOCK}(tab_id TEXT PRIMARY KEY,revision INTEGER NOT NULL
  CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND ${MAX}),
  present INTEGER NOT NULL CHECK(present IN (0,1)),storage_id INTEGER NOT NULL)`;
const metaSql=`CREATE TABLE ${META}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,
  epoch TEXT NOT NULL,schema_hash TEXT NOT NULL)`;

function createSelectionStopSourceClock(db) {
  let epoch=null,unavailable=null;
  const inspect=()=>{
    const meta=db.prepare(`SELECT * FROM ${META} WHERE singleton=1`).get();
    if(meta?.version!==1||typeof meta.epoch!=='string'||!meta.epoch||meta.schema_hash!==schemaHash
      ||epoch&&meta.epoch!==epoch)fail('selection_stop_source_schema_unknown');
    const table=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(CLOCK);
    const metadata=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(META);
    if(table?.sql!==tableSql||metadata?.sql!==metaSql)fail('selection_stop_source_schema_unknown');
    for(const trigger of TRIGGERS)if(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger.name)?.sql!==trigger.sql)
      fail('selection_stop_source_trigger_unknown');
    return meta;
  };
  try {
    const columns=db.prepare('PRAGMA table_xinfo(tabs)').all().map(row=>row.name);
    if(SOURCE_COLUMNS.some(column=>!columns.includes(column)))fail('selection_stop_source_columns_unknown');
    db.transaction(()=>{
      const meta=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(META);
      if(!meta) {
        if(db.prepare("SELECT sql FROM sqlite_master WHERE name IN (?,?,?,?,?) LIMIT 1")
          .get(CLOCK,...TRIGGERS.map(row=>row.name),META))fail('selection_stop_source_schema_unknown');
        db.exec(metaSql+';'+tableSql+';'+TRIGGERS.map(row=>row.sql).join(';')+';');
        const initialEpoch=crypto.randomUUID();
        db.prepare(`INSERT INTO ${META} VALUES(1,1,?,?)`).run(initialEpoch,schemaHash);
        // This starts CURRENT observation lineage; it never certifies a Stop
        // or retroactively supplies a witness to an old started command.
        db.exec(`INSERT INTO ${CLOCK}(tab_id,revision,present,storage_id)
          SELECT tab_id,1,1,id FROM tabs WHERE typeof(tab_id)='text' AND length(tab_id)>0`);
      }
      epoch=inspect().epoch;
    }).immediate();
  }catch(error){unavailable=error?.code?.startsWith('selection_stop_source_')?error.code:'selection_stop_source_unavailable';}
  return {read(tabId,storageId) {
    if(unavailable)fail(unavailable);
    const meta=inspect(),row=db.prepare(`SELECT * FROM ${CLOCK} WHERE tab_id=?`).get(tabId);
    if(!row||row.present!==1||!Number.isSafeInteger(storageId)||storageId<1||!Number.isSafeInteger(row.storage_id)
      ||row.storage_id!==storageId||!Number.isSafeInteger(row.revision)||row.revision<1)
      fail('selection_stop_source_clock_unknown');
    return {version:1,epoch:meta.epoch,revision:row.revision,storageId:row.storage_id};
  }};
}
module.exports={createSelectionStopSourceClock,SOURCE_COLUMNS};
