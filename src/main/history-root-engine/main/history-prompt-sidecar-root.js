'use strict';
// Frozen prompt-sidecar source cut for semantic root preparation. This does
// not yet apply prompt/authoring/image semantics to canonical History rows.
const { StringDecoder } = require('node:string_decoder');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { isHistoryPagedCursor } = require('./history-paged-store');
const text = require('./history-paged-text');
const fail = code => Object.assign(new Error(code), { code });
const TEXT_COLUMNS = ['session_id', 'audit_timestamp', 'transport_hash', 'entry_uuid', 'chips_json'];
function captureHistoryPromptSidecars(store, manager, { toolType, sessionId, control, chunkBytes = 1024,
  scope = 'session', entries = null } = {}) {
  if (process.env.NOTED_HISTORY_READER_PROCESS !== '1') throw fail('HISTORY_SIDECAR_READER_REQUIRED');
  if (!manager?.db?.prepare || typeof manager.getHistoryPromptPresentationRevision !== 'function'
    || typeof toolType !== 'string' || !toolType || typeof sessionId !== 'string' || !sessionId
    || !Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > 4096) throw fail('HISTORY_SIDECAR_CONFIGURATION');
  if (!['session','entry-uuids'].includes(scope) || scope === 'entry-uuids'
    && (!isHistoryPagedCursor(entries) || entries.kind !== 'array')) throw fail('HISTORY_SIDECAR_CONFIGURATION');
  const db = manager.db, arena = new HistoryProjectionArena(store);
  let root, rows, revision;
  const stats = { sourceRows: 0, retainedRows: 0, sqlChunks: 0, maxSQLChunkBytes: 0,
    completeSemanticSnapshot: false, sqlNativePeakMeasured: false, globalMemoryBounded: false,
    maxNativeUUIDBatch: 0, maxNativeUUIDChars: 0 };
  const queries = new Map(TEXT_COLUMNS.map(column => [column, {
      kind: db.prepare('SELECT typeof('+column+') AS kind,length(CAST('+column+' AS BLOB)) AS byteLength FROM history_prompt_presentations WHERE rowid=?'),
    read: db.prepare('SELECT substr(CAST('+column+' AS BLOB),?,?) AS bytes FROM history_prompt_presentations WHERE rowid=?'),
  }]));
  function loadText(rowid, column) {
    const query = queries.get(column), info = query.kind.get(rowid), kind = info?.kind;
    if (kind === 'null') return null;
    if (kind !== 'text' && (column !== 'chips_json' || kind !== 'blob')) return undefined;
    return text.build(arena,(function*(){
      const decoder = new StringDecoder('utf8'); let offset = 1, first = true;
      const binary = kind === 'blob' && info.byteLength > 0 && !Buffer.isBuffer(query.read.get(1,1,rowid)?.bytes);
      for (;offset <= info.byteLength;) {
        control?.assertCurrent(); const part = query.read.get(offset,chunkBytes,rowid)?.bytes;
        if (!ArrayBuffer.isView(part)) throw fail('HISTORY_SIDECAR_ROW_INVALIDATED');
        stats.sqlChunks++; stats.maxSQLChunkBytes = Math.max(stats.maxSQLChunkBytes,part.byteLength);
        if (!part.byteLength) throw fail('HISTORY_SIDECAR_ROW_INVALIDATED');
        offset += part.byteLength;
        // Match the original JSON.parse(driverValue) coercion for a malformed
        // BLOB column: Buffer is UTF8 text; Node TEST Uint8Array is comma bytes.
        if(binary){for(const byte of part){yield(first?'':',')+String(byte);first=false;}}
        else {const decoded = decoder.write(part); if(decoded)yield decoded;}
      }
      const tail = decoder.end(); if(tail)yield tail;
    })());
  }
  const copy = raw => {
      control?.assertCurrent();stats.sourceRows++;
      arena.step(()=>{
        const body = loadText(raw.rowid,'chips_json');
        const chips = body == null || body === '' ? text.parseJson('[]') : text.isText(body) ? text.parseJson(body) : null;
        if(!Array.isArray(chips)||chips.length===0)return;
        const auditTimestamp=loadText(raw.rowid,'audit_timestamp'),transportHash=loadText(raw.rowid,'transport_hash'),
          entryUuid=loadText(raw.rowid,'entry_uuid');
        if (auditTimestamp===undefined||transportHash===undefined||entryUuid===undefined) throw fail('HISTORY_SIDECAR_COLUMN_TYPE');
        rows.push({toolType,sessionId:loadText(raw.rowid,'session_id'),auditTimestamp,transportHash,entryUuid:entryUuid||null,
          schemaVersion:Number(raw.schema_version||1),chips,
          createdAt:Number(raw.created_at||0),updatedAt:Number(raw.updated_at||0)});
        stats.retainedRows++;
      });
  };
  const capture = () => {
    control?.assertCurrent();
    rows = arena.step(()=>{arena.state().rows=arena.make('array');return arena.state().rows;});
    const columns = 'rowid,schema_version,created_at,updated_at,length(CAST(chips_json AS BLOB)) AS bodyBytes';
    if(scope === 'session') {
      const query = db.prepare('SELECT '+columns+' FROM history_prompt_presentations WHERE tool_type=? AND session_id=? ORDER BY updated_at ASC');
      for(const raw of query.iterate(toolType,sessionId))copy(raw);
    } else {
      const seen = arena.step(()=>{arena.state().seen=arena.make('map');return arena.state().seen;});
      let batch=[]; const queries = new Map();
      const flush = () => {
        if(!batch.length)return;
        let query=queries.get(batch.length);
        if(!query){query=db.prepare('SELECT '+columns+' FROM history_prompt_presentations INDEXED BY idx_history_prompt_presentations_uuid WHERE tool_type=? AND entry_uuid IN ('+batch.map(()=>'?').join(',')+') ORDER BY session_id ASC,entry_uuid ASC,rowid ASC');queries.set(batch.length,query);}
        stats.maxNativeUUIDBatch=Math.max(stats.maxNativeUUIDBatch,batch.length);
        for(const raw of query.iterate(toolType,...batch))copy(raw);
        batch=[];
      };
      for(const entry of entries.rows()) {
        control?.assertCurrent();const cursor=entry.field('uuid');let uuid='';
        if(cursor.kind==='text'){for(const part of cursor.textChunks())uuid+=part;}
        else if(['undefined','scalar','number','scalar-root'].includes(cursor.kind))uuid=String(cursor.scalar()||'');
        else throw fail('HISTORY_SIDECAR_UUID_TYPE');
        uuid=uuid.trim();if(!uuid)continue;
        stats.maxNativeUUIDChars=Math.max(stats.maxNativeUUIDChars,uuid.length);
        if(seen.has(uuid))continue;arena.step(()=>seen.set(uuid,true));batch.push(uuid);if(batch.length===800)flush();
      }
      flush();
    }
    // The exact provider-wide revision and local rows share this read cut.
    revision=manager.getHistoryPromptPresentationRevision(toolType,sessionId);
    control?.assertCurrent();arena.step(()=>{root=arena.publish(rows);});
  };
  try {
    if(db.inTransaction)capture();else db.transaction(capture)();
    control?.assertCurrent();
    let released=false;const cursor=root.cursor(),ownership=arena.inspectOwnership();
    return Object.freeze({root,rows:cursor,revision,stats:Object.freeze({...stats,ownership}),
      release(){if(released)return;released=true;root.release();}});
  }catch(error){try{root?.release();}catch{}throw error;}
  finally{arena.close();}
}
module.exports={captureHistoryPromptSidecars};

