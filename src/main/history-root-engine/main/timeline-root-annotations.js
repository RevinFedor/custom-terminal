'use strict';

// Exact physical-session annotation cut. No ancestor/fork expansion: the five
// DatabaseManager getters below have no such dependency. This producer does
// not change Timeline entry eligibility, generated labels, actions or clients.
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { createPagedJsonProjection } = require('./history-paged-json');
const { isHistoryPagedCursor, historyPagedCursorAddress } = require('./history-paged-store');
const text = require('./history-paged-text');
const { readTimelineAnnotationFreshness } = require('./timeline-annotation-freshness');
const fail = code => Object.assign(new Error(code), { code });
const prefix = 'TIMELINE_ANNOTATIONS_';
const common = ['tool_type','session_id'];
const usage = ['prompt_tokens','candidate_tokens','thought_tokens','total_tokens'];
const provenance = ['source_hash','model','prompt_id','thinking_level'];
const tables = Object.freeze({
  notes: { name:'timeline_notes', columns:['id','entry_uuid','session_id','tab_id','content','position','created_at','updated_at'],
    fields:['entry_uuid','content','position'] },
  rewindMarkers: { name:'timeline_rewind_markers', columns:['id','entry_uuid','session_id','created_at'], fields:['entry_uuid'] },
  promptSummaries: { name:'timeline_prompt_summaries', columns:[...common,'entry_uuid','summary',...provenance,...usage,'updated_at'], ordered:true },
  outline: { name:'timeline_outlines', columns:[...common,'schema_version','source_hash','source_uuids_json','source_entry_count',
    'source_last_uuid','outline_json','model','prompt_id','thinking_level',...usage,'source_chars','updated_at'] },
  turnActionOverrides: { name:'timeline_turn_action_overrides', columns:[...common,'entry_uuid','action_label',...provenance,'updated_at'], ordered:true },
});
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const cooperateDefault = () => new Promise(resolve => setImmediate(resolve));
const isTruthy = value => text.isPagedText(value) ? value.length !== 0 : !!value;
const or = (value, fallback) => isTruthy(value) ? value : fallback;

// Number(value) without a long JS string. The existing paged-number adapter
// implements the same StringNumericLiteral conversion used by the reducer.
const number = value => require('./history-paged-number').numericValue(value,text);

/**
 * captureTimelineRootAnnotations({store, manager, sessionId, readSourceWitness,
 *   control?, cooperate?, chunkBytes=1024}) -> Promise<frozen snapshot>
 *
 * manager.db is the supplied live read connection; store is the caller's
 * existing HistoryPagedStore. readSourceWitness MUST synchronously return an
 * exact bounded source revision token and throw if its source is no longer
 * current. We require an autocommit connection, never borrow an old transaction.
 * All five tables/columns must be known, even for an empty target session.
 * No retry, userDB writes, long userDB transaction, new store or global owner.
 */
async function captureTimelineRootAnnotations({ store, manager, sessionId, readSourceWitness,
  control, cooperate = cooperateDefault, chunkBytes = 1024 } = {}) {
  if (!store || store.closed || !manager?.db?.prepare || typeof sessionId !== 'string' || !sessionId || sessionId.length>4096
    || typeof readSourceWitness !== 'function' || typeof cooperate !== 'function'
    || !Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > 4096)
    throw fail(prefix+'CONFIGURATION');
  const db = manager.db;
  if (db === store.db || typeof db.name !== 'string' || !db.name || db.name === ':memory:')
    throw fail(prefix+'READ_CONNECTION_REQUIRED');
  const dbPath = db.name;
  const stats = { rows:0, sqlChunks:0, maxSQLChunkBytes:0, parserWrites:0, maxParserWriteBytes:0,
    checkpoints:0, nativeRowBatch:1, wholeJSONParses:0, sqlNativeMemoryBounded:false,
    globalMemoryBounded:false, forkMetadataScope:'none' };
  function witness() {
    control?.assertCurrent();
    if (manager.db !== db || db.name !== dbPath || db.inTransaction !== false) throw fail(prefix+'CONNECTION_CHANGED');
    const sourceRevision = readSourceWitness();
    if (typeof sourceRevision !== 'string' || sourceRevision.length > 4096 || !sourceRevision)
      throw fail(prefix+'SOURCE_WITNESS_REQUIRED');
    const physical = fs.statSync(dbPath, { bigint:true });
    const freshness = readTimelineAnnotationFreshness(db,'codex',sessionId);
    if (!freshness) throw fail(prefix+'WITNESS_UNKNOWN');
    return { sourceRevision, dbPath, device:String(physical.dev), inode:String(physical.ino), ...freshness };
  }
  const before = witness();
  function guard() {
    const current = witness();
    for (const key of Object.keys(before)) {
      // The original data_version stays in captureWitness as audit. Only an
      // exact currently attested scoped cut can replace global invalidation.
      if (key === 'dataVersion' && before.mode === 'scoped' && current.mode === 'scoped') continue;
      const equal = key === 'versions' && before.versions && current.versions
        ? before.versions.length === 5 && current.versions.length === 5
          && before.versions.every((value,i) => value === current.versions[i])
        : current[key] === before[key];
      if (!equal) throw Object.assign(fail(prefix+'CAPTURE_CHANGED'),{reason:key});
    }
  }
  async function checkpoint() { guard(); await cooperate(); stats.checkpoints++; guard(); }

  let arena, root, endBuild;
  try {
    // Fixed vocabulary only. Inspect scalar columns one at a time; no schema
    // .all(), large sqlite_master SQL strings, or inferred missing == empty.
    for (const [key,spec] of Object.entries(tables)) {
      let ordinal = 0, mask = 0;
      for (const row of db.prepare('SELECT cid,substr(name,1,128) AS name,substr(type,1,32) AS type,pk FROM pragma_table_info(?) ORDER BY cid').iterate(spec.name)) {
        const index=spec.columns.indexOf(row.name);
        const numeric=['id','schema_version','source_entry_count',...usage,'source_chars','created_at','updated_at'].includes(row.name);
        const pk=row.name==='id'?1:['notes','rewindMarkers'].includes(key)?0
          :common.includes(row.name)?common.indexOf(row.name)+1:row.name==='entry_uuid'?3:0;
        if (row.cid!==ordinal++ || index<0 || mask & (1<<index) || row.type!==(numeric?'INTEGER':'TEXT') || row.pk!==pk)
          throw fail(prefix+'SCHEMA_UNKNOWN');
        mask |= 1<<index;
      }
      if (ordinal !== spec.columns.length) throw fail(prefix+'SCHEMA_UNKNOWN');
      // WITHOUT ROWID, views and missing/renamed fields cannot pass as empty.
      if (!db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(spec.name))
        throw fail(prefix+'SCHEMA_UNKNOWN');
      db.prepare('SELECT rowid FROM '+spec.name+' LIMIT 0').get();
    }
    guard();
    endBuild = store.beginBuild();
    arena = new HistoryProjectionArena(store);
    arena.step(() => {
      const state = arena.state();
      for (const key of Object.keys(tables)) {
        state[key] = key === 'outline' ? null : arena.make('array');
        if (key !== 'outline') state[key+'Index'] = arena.make('map');
      }
      state.outlineSourceIndex = arena.make('map');
      state.summaryCount = 0;
    });

    // Reads exactly one scalar or <=chunkBytes raw bytes. Using CAST AS BLOB
    // preserves embedded NULs and avoids SQLite text character slicing costs.
    // Text decoding matches the native driver's UTF8 strings. Unexpected BLOBs
    // outside JSON columns are explicit refusal, never fabricated strings.
    async function load(spec, rowid, column, jsonColumn = false) {
      guard();
      const info = db.prepare('SELECT typeof('+column+') AS kind,length(CAST('+column+' AS BLOB)) AS bytes FROM '+spec.name+' WHERE rowid=?').get(rowid);
      if (!info) throw fail(prefix+'ROW_CHANGED');
      if (info.kind === 'null') return null;
      if (info.kind === 'integer' || info.kind === 'real') {
        const value = db.prepare('SELECT '+column+' AS value FROM '+spec.name+' WHERE rowid=?').get(rowid)?.value;
        if (typeof value !== 'number') throw fail(prefix+'COLUMN_TYPE');
        return value;
      }
      if (info.kind !== 'text' && !(jsonColumn && info.kind === 'blob')) throw fail(prefix+'COLUMN_TYPE');
      if (!Number.isSafeInteger(info.bytes) || info.bytes<0) throw fail(prefix+'ROW_CHANGED');
      const read = db.prepare('SELECT substr(CAST('+column+' AS BLOB),?,?) AS bytes FROM '+spec.name+' WHERE rowid=?');
      const decoder = new StringDecoder('utf8'), writer = store.leafWriter();
      for (let offset = 1; offset <= info.bytes;) {
        guard();
        const part = read.get(offset, chunkBytes, rowid)?.bytes;
        if (!ArrayBuffer.isView(part) || !part.byteLength || part.byteLength > chunkBytes) throw fail(prefix+'ROW_CHANGED');
        // Actual DatabaseManager uses better-sqlite3: JSON.parse(Buffer)
        // performs UTF8 decoding, including malformed-sequence replacement.
        stats.sqlChunks++; stats.maxSQLChunkBytes = Math.max(stats.maxSQLChunkBytes,part.byteLength);
        store.transaction(() => writer.write(decoder.write(part)));
        offset += part.byteLength;
        await checkpoint();
      }
      let ref;
      store.transaction(() => { writer.write(decoder.end()); ref = writer.finish(); });
      return text.fromRef(arena,ref);
    }

    async function parse(value, fallbackArray = false) {
      if (fallbackArray && !isTruthy(value)) value = '[]';
      if (!text.isText(value)) value = String(value); // native JSON.parse coercion of null/numbers
      const parser = createPagedJsonProjection(store, { selectedTokenBytes:64, jsonWhitespaceOnly:true });
      let quoted=false, escaped=false, offset=0, result;
      try {
        // Preserve JSON UTF16 semantics (including escaped/lone surrogates).
        // Each parser write is finite, depth and child graphs live on pages.
        for (const part of text.chunks(value)) {
          let encoded='';
          const flush=() => { if (!encoded) return; const bytes=Buffer.from(encoded,'utf8');
            stats.parserWrites++;stats.maxParserWriteBytes=Math.max(stats.maxParserWriteBytes,bytes.length);
            parser.write(bytes,offset);offset+=bytes.length;encoded=''; };
          for (let i=0;i<part.length;i++) {
            const char=part[i], unit=part.charCodeAt(i);
            const piece=quoted&&!escaped&&unit>=128?'\\u'+unit.toString(16).padStart(4,'0'):char;
            if (encoded.length+piece.length>128) flush();
            encoded+=piece;
            if (quoted) { if (escaped) escaped=false; else if (char==='\\') escaped=true; else if (char==='"') quoted=false; }
            else if (char==='"') quoted=true;
          }
          flush(); await checkpoint();
        }
        result=parser.finish(offset);
        if (!result.valid) return { valid:false };
        return { valid:true, value:arena.step(() => arena.own(result.lease.cursor())) };
      } finally { result?.lease?.release(); parser.abort(); }
    }

    for (const [key,spec] of Object.entries(tables)) {
      const scoped = key === 'notes' || key === 'rewindMarkers';
      const where = scoped ? 'session_id=?' : 'tool_type=? AND session_id=?';
      const params = scoped ? [sessionId] : ['codex',sessionId];
      // The exact native getter ordering (including SQLite's existing tie
      // order), without retaining its iterator/read snapshot over an await.
      // Reference the native getter's exact column set, returning only typeof
      // scalars. Otherwise notes' table scan can silently become a covering
      // UNIQUE(entry_uuid,session_id) scan with a different observable order.
      const scalarProjection=(spec.fields||spec.columns).map(column=>'typeof('+column+') AS kind_'+column).join(',');
      const next = db.prepare('SELECT rowid AS capture_rowid,'+scalarProjection+' FROM '+spec.name+' WHERE '+where
        +(spec.ordered?' ORDER BY updated_at DESC':'')+' LIMIT 1 OFFSET ?');
      for (let ordinal=0;;ordinal++) {
        guard(); const raw=next.get(...params,ordinal); if (!raw) break;
        const values={};
        for (const column of spec.fields || spec.columns) {
          values[column]=await load(spec,raw.capture_rowid,column,column==='source_uuids_json'||column==='outline_json');
        }
        let parsedSource, parsedOutline;
        if (key==='outline') {
          parsedSource=await parse(values.source_uuids_json,true);
          parsedOutline=await parse(values.outline_json);
        }
        arena.step(() => {
          const state=arena.state(); let row;
          if (scoped) row=arena.record(values);
          else if (key==='promptSummaries') {
            const fields={};for (const column of spec.columns) fields[camel(column)]=values[column];
            for (const column of [...usage,'updated_at']) fields[camel(column)]=or(values[column],0);
            row=arena.record(fields);
          } else if (key==='turnActionOverrides') {
            const fields={};for (const column of spec.columns) fields[camel(column)]=values[column];
            for (const column of provenance) fields[camel(column)]=or(values[column],null);
            fields.updatedAt=number(or(values.updated_at,0));row=arena.record(fields);
          } else {
            if (!parsedSource.valid || !parsedOutline.valid) { state.outline=null; return; }
            const fields={};for (const column of spec.columns) {
              if (!['source_uuids_json','outline_json'].includes(column)) fields[camel(column)]=values[column];
            }
            fields.sourceUuids=parsedSource.value;fields.outline=parsedOutline.value;
            for (const column of ['schema_version','source_entry_count',...usage,'source_chars','updated_at'])
              fields[camel(column)]=number(or(values[column],column==='schema_version'?1:0));
            for (const column of ['source_last_uuid','model','prompt_id','thinking_level']) fields[camel(column)]=or(values[column],null);
            row=arena.record(fields);state.outline=row;
          }
          if (key!=='outline') {
            const rows=state[key], index=state[key+'Index'], uuid=scoped?row.entry_uuid:row.entryUuid;
            index.set(uuid,rows.length);rows.push(row);
            if (key==='promptSummaries' && isTruthy(row.toolType) && isTruthy(row.sessionId) && isTruthy(uuid) && isTruthy(row.summary))
              state.summaryCount++;
          }
        });
        stats.rows++; await checkpoint();
        if (key==='outline') break; // getTimelineOutline LIMIT 1
      }
    }
    // Membership has exact parsed array semantics, not a claim about current
    // canonical entry eligibility. Caller supplies its eligible UUID cursor to
    // countOutlineNew; it keeps the existing Timeline entry predicate.
    const sourceUuids=arena.state().outline?.sourceUuids;
    if (Array.isArray(sourceUuids)) for (const uuid of sourceUuids) {
      arena.step(() => arena.state().outlineSourceIndex.set(uuid,true)); await checkpoint();
    }
    arena.step(() => { arena.state().outlineSourceUniqueCount=Array.isArray(sourceUuids)?arena.state().outlineSourceIndex.size:null; });
    guard();root=arena.step(() => arena.publish());guard();
    const captureWitness=Object.freeze({ captureId:randomUUID(),toolType:'codex',sessionId,...before });
    const revision=createHash('sha256').update(JSON.stringify(captureWitness)).digest('hex');
    const metrics=Object.freeze({...stats,ownership:Object.freeze(arena.inspectOwnership()),arena:Object.freeze({...arena.metrics})});
    return snapshot(store,root,captureWitness,revision,metrics);
  } catch (error) { root?.release(); throw error; }
  finally { arena?.close();endBuild?.(); }
}

function snapshot(store,root,captureWitness,revision,stats) {
  const cursor=root.cursor();let released=false;
  function indexValue(name,uuid) {
    // Reopen only the frozen arena's page index, never userDB or a native UUID
    // Map. The temporary pin is closed before returning an ordinal/scalar.
    void cursor.kind; // assert the owning lease before opening an independent view
    const view=new HistoryProjectionArena(store,root);
    try { return view.state()[name].get(uuid); } finally { view.close(); }
  }
  function lookup(name,uuid) {
    const ordinal=indexValue(name+'Index',uuid);
    return ordinal===undefined?undefined:cursor.field(name).at(ordinal);
  }
  const outline=cursor.field('outline');
  const source=outline.kind==='object'?outline.field('sourceUuids'):null;
  function summaryPresent(row) {
    if (!row) return false;
    for (const key of ['toolType','sessionId','entryUuid','summary']) {
      const field=row.field(key);if (!(field.kind==='text'?field.length:field.scalar())) return false;
    }
    return true;
  }
  async function count(eligibleUuids,kind,{control,cooperate=cooperateDefault}={}) {
    if (!isHistoryPagedCursor(eligibleUuids)||eligibleUuids.kind!=='array') throw fail(prefix+'ELIGIBLE_CURSOR_REQUIRED');
    void cursor.kind;
    // Validate same-store ownership using the existing capability boundary.
    // This may write a fixed owner-context wrapper in the supplied page store,
    // never a new DB, a userDB write, or a collection of request UUIDs.
    store.transaction(() => store.referenceForCursor(eligibleUuids));
    if (kind==='outline' && outline.kind!=='object') return 0;
    if (kind==='outline' && source?.kind!=='array') throw fail(prefix+'OUTLINE_MEMBERSHIP_UNKNOWN');
    const view=new HistoryProjectionArena(store,root);let count=0,steps=0;
    try {
      const index=view.state()[kind==='outline'?'outlineSourceIndex':'promptSummariesIndex'];
      for (const uuid of eligibleUuids.rows()) {
        control?.assertCurrent();void cursor.kind;
        // Resolved leaf address, not referenceForCursor's owner-root wrapper.
        const value=uuid.kind==='text'?text.fromRef(view,historyPagedCursorAddress(uuid).ref):uuid.scalar();
        if (kind==='outline') { if (!index.has(value)) count++; }
        else { const ordinal=index.get(value);if (ordinal!==undefined && summaryPresent(cursor.field('promptSummaries').at(ordinal))) count++; }
        if (++steps%32===0) { await cooperate();control?.assertCurrent();void cursor.kind; }
      }
      control?.assertCurrent();void cursor.kind;return count;
    } finally { view.close(); }
  }
  return Object.freeze({ root,captureWitness,revision,stats,
    notes:cursor.field('notes'),rewindMarkers:cursor.field('rewindMarkers'),promptSummaries:cursor.field('promptSummaries'),
    outline,turnActionOverrides:cursor.field('turnActionOverrides'),
    lookupNote:uuid=>lookup('notes',uuid),hasRewindMarker:uuid=>indexValue('rewindMarkersIndex',uuid)!==undefined,
    lookupSummary:uuid=>lookup('promptSummaries',uuid),lookupTurnActionOverride:uuid=>lookup('turnActionOverrides',uuid),
    noteCount:cursor.field('notes').length,rewindMarkerCount:cursor.field('rewindMarkers').length,
    promptSummaryCount:cursor.field('promptSummaries').length,summaryCount:cursor.field('summaryCount').scalar(),
    turnActionOverrideCount:cursor.field('turnActionOverrides').length,
    hasSummary:uuid=>summaryPresent(lookup('promptSummaries',uuid)),
    countSummaries:(eligibleUuids,options)=>count(eligibleUuids,'summary',options),
    outlineSourceCount:source?.kind==='array'?source.length:null,
    outlineSourceUniqueCount:cursor.field('outlineSourceUniqueCount').scalar(),
    hasOutlineSource:uuid=>indexValue('outlineSourceIndex',uuid)===true,
    countOutlineNew:(eligibleUuids,options)=>count(eligibleUuids,'outline',options),
    fork(){return snapshot(store,root.fork(),captureWitness,revision,stats);},
    release(){if (released)return;released=true;root.release();},
  });
}

module.exports={captureTimelineRootAnnotations};
