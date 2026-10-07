'use strict';

const crypto = require('node:crypto');
const revive = (_key,value) => value?.type === 'Buffer' && Array.isArray(value.data) ? Buffer.from(value.data) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => {throw Object.assign(new Error(code),{code,statusCode:409});};

/** Full typed file-only subtree, tied to one exact owner archive entry. */
class ArchivedFileLinks {
  constructor(database) {
    this.database = database;this.db = database.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_archived_file_links (
      history_id INTEGER PRIMARY KEY,version INTEGER NOT NULL,owner_tab_id TEXT NOT NULL,
      owner_namespace TEXT NOT NULL,manifest_hash TEXT NOT NULL,manifest_json TEXT NOT NULL,
      restored_owner_id TEXT,restored_at INTEGER);`);
  }
  capture(historyId,namespace,ownerTabId) {
    if (!this.db.inTransaction) fail('file_manifest_transaction_required');
    if (!ownerTabId || !Number.isSafeInteger(historyId)) return;
    const rows = this.db.prepare("SELECT * FROM tabs WHERE tab_type='file'").all();
    const selected=[],seen=new Set([ownerTabId]),queue=[ownerTabId];
    for (let index=0;index<queue.length;index++) for (const row of rows) {
      const parent=row.visual_parent_tab_id || row.parent_tab_id;
      if (parent !== queue[index] || seen.has(row.tab_id) || row.execution_archived === 1) continue;
      seen.add(row.tab_id);queue.push(row.tab_id);selected.push(row);
    }
    const writable = new Set(this.db.prepare('PRAGMA table_xinfo(tabs)').all().filter(column=>!column.hidden).map(column=>column.name));
    const manifest={version:1,ownerTabId,namespace,files:selected.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>writable.has(key))))};
    const json=JSON.stringify(manifest),signature=hash(manifest);
    const old=this.db.prepare('SELECT * FROM workflow_archived_file_links WHERE history_id=?').get(historyId);
    if (old) {if(old.version!==1)fail('file_manifest_forward_version');if(old.manifest_hash!==signature) fail('file_manifest_conflict');return;}
    this.db.prepare(`INSERT INTO workflow_archived_file_links(history_id,version,owner_tab_id,owner_namespace,manifest_hash,manifest_json)
      VALUES(?,1,?,?,?,?)`).run(historyId,ownerTabId,namespace,signature,json);
  }
  read(historyId) {
    const row=this.db.prepare('SELECT * FROM workflow_archived_file_links WHERE history_id=?').get(historyId);
    if(!row)return null;
    if(row.version!==1)fail('file_manifest_forward_version');
    const manifest=JSON.parse(row.manifest_json,revive);
    if(hash(manifest)!==row.manifest_hash)fail('file_manifest_corrupt');
    return {...manifest,hash:row.manifest_hash,restoredOwnerId:row.restored_owner_id};
  }
  restore({historyId,namespace,ownerTabId,manifestHash}) {
    const run=() => {
      const manifest=this.read(historyId);
      if(!manifest)return {restoredFileIds:[]};
      if(manifest.hash!==manifestHash || manifest.namespace!==namespace
        || manifest.restoredOwnerId && manifest.restoredOwnerId!==ownerTabId)fail('file_manifest_owner_changed');
      const owner=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(ownerTabId);
      if(!owner || (owner.execution_namespace || owner.project_id)!==namespace || owner.execution_archived===1)fail('file_manifest_owner_not_restored');
      const columns=new Set(this.db.prepare('PRAGMA table_xinfo(tabs)').all().filter(column=>!column.hidden).map(column=>column.name));
      const restored=[];
      const rebound=manifest.files.map(file=>({...file,
        visual_parent_tab_id:file.visual_parent_tab_id===manifest.ownerTabId?ownerTabId:file.visual_parent_tab_id,
        parent_tab_id:file.parent_tab_id===manifest.ownerTabId?ownerTabId:file.parent_tab_id}));
      // Validate the entire family before materializing any record.
      for(let index=0;index<rebound.length;index++) {
        const file=rebound[index],original=manifest.files[index];
        if(file.tab_type!=='file' || !file.tab_id)fail('file_manifest_type_changed');
        if(Object.keys(file).some(key=>!columns.has(key)))fail('file_manifest_schema_changed');
        const current=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(file.tab_id);
        if(current && (current.tab_type!=='file' || current.file_path!==file.file_path
          || current.execution_subject_version===2 && current.id!==file.id
          || current.visual_parent_tab_id!==file.visual_parent_tab_id && current.visual_parent_tab_id!==original.visual_parent_tab_id
          || current.parent_tab_id!==file.parent_tab_id && current.parent_tab_id!==original.parent_tab_id
          || (current.execution_namespace || current.project_id)!==(file.execution_namespace || file.project_id)
          || current.execution_subject_id!==file.execution_subject_id))fail('file_manifest_target_changed');
      }
      for(const file of rebound) {
        const current=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(file.tab_id);
        if(current) {
          if(current.execution_subject_version===2)this.db.prepare('UPDATE tabs SET execution_archived=0,visual_parent_tab_id=?,parent_tab_id=? WHERE tab_id=?')
            .run(file.visual_parent_tab_id,file.parent_tab_id,file.tab_id);
          else this.db.prepare('UPDATE tabs SET visual_parent_tab_id=?,parent_tab_id=? WHERE tab_id=?')
            .run(file.visual_parent_tab_id,file.parent_tab_id,file.tab_id);
        } else {
          const values={...file};
          // Legacy saves already reassign integer storage IDs. The opaque ID,
          // exact namespace and relation remain the archival identity.
          if(this.db.prepare('SELECT 1 FROM tabs WHERE id=?').get(values.id)) {
            if(file.execution_subject_version===2)fail('file_manifest_storage_identity_conflict');
            delete values.id;
          }
          if(Object.hasOwn(values,'execution_archived'))values.execution_archived=0;
          const keys=Object.keys(values);
          this.db.prepare(`INSERT INTO tabs(${keys.map(key=> '"'+key+'"').join(',')}) VALUES(${keys.map(()=>'?').join(',')})`)
            .run(...keys.map(key=>values[key]));
        }
        restored.push(file.tab_id);
      }
      this.db.prepare('UPDATE workflow_archived_file_links SET restored_owner_id=?,restored_at=? WHERE history_id=?')
        .run(ownerTabId,Date.now(),historyId);
      return {restoredFileIds:restored};
    };
    return this.db.inTransaction?run():this.db.transaction(run).immediate();
  }
  assertRestored(historyId,namespace) {
    const manifest=this.read(historyId);
    if(!manifest || !manifest.files.length)return;
    if(manifest.namespace!==namespace || !manifest.restoredOwnerId)fail('file_manifest_restore_incomplete');
    const owner=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(manifest.restoredOwnerId);
    if(!owner || (owner.execution_namespace || owner.project_id)!==namespace || owner.execution_archived===1)fail('file_manifest_restore_incomplete');
    for(const file of manifest.files) {
      const row=this.db.prepare('SELECT * FROM tabs WHERE tab_id=?').get(file.tab_id);
      if(!row || row.execution_archived===1 || row.tab_type!=='file' || row.file_path!==file.file_path
        || row.visual_parent_tab_id!==(file.visual_parent_tab_id===manifest.ownerTabId?manifest.restoredOwnerId:file.visual_parent_tab_id)
        || row.parent_tab_id!==(file.parent_tab_id===manifest.ownerTabId?manifest.restoredOwnerId:file.parent_tab_id)
        || (row.execution_namespace || row.project_id)!==(file.execution_namespace || file.project_id)
        || row.execution_subject_id!==file.execution_subject_id)fail('file_manifest_restore_incomplete');
    }
  }
}
module.exports={ArchivedFileLinks};
