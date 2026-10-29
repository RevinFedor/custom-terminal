'use strict';
// Additive read-freshness counters. TabWorkContext remains the sole owner of
// links/content and their delivery; these hooks grant no authoring authority.
const FILE_TABLE_DDL=`CREATE TABLE IF NOT EXISTS tab_context_files (
 tab_id TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', hash TEXT,
 error TEXT, PRIMARY KEY(tab_id, path)
)`;
const VERSION_TABLE='timeline_working_file_versions';
const VERSION_DDL=`CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (tab_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0)`;
const normalize=sql=>sql.replace(/\bIF NOT EXISTS\b/gi,'').replace(/\s+/g,' ').replace(/;\s*$/,'').trim();
const bump=owner=>`INSERT INTO ${VERSION_TABLE}(tab_id,version) VALUES(${owner}.tab_id,1)
 ON CONFLICT(tab_id) DO UPDATE SET version=version+1;`;
function triggerDefinitions(){return new Map([
 ['timeline_working_file_insert',`CREATE TRIGGER IF NOT EXISTS timeline_working_file_insert AFTER INSERT ON tab_context_files BEGIN ${bump('NEW')} END;`],
 ['timeline_working_file_delete',`CREATE TRIGGER IF NOT EXISTS timeline_working_file_delete AFTER DELETE ON tab_context_files BEGIN ${bump('OLD')} END;`],
 ['timeline_working_file_update',`CREATE TRIGGER IF NOT EXISTS timeline_working_file_update AFTER UPDATE OF tab_id,path ON tab_context_files
 WHEN OLD.tab_id IS NOT NEW.tab_id OR OLD.path IS NOT NEW.path BEGIN ${bump('OLD')} ${bump('NEW')} END;`],
]);}
function installTimelineWorkingFileVersions(db){
 db.exec(VERSION_DDL);for(const sql of triggerDefinitions().values())db.exec(sql);
}
module.exports={FILE_TABLE_DDL,VERSION_TABLE,VERSION_DDL,normalize,triggerDefinitions,installTimelineWorkingFileVersions};
