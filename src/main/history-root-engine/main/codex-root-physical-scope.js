'use strict';

// Negotiated root reads ONLY. In particular, never call the legacy lineage
// getter/recovery here: even a physical parent can have N forward children.
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { createPagedJsonProjection } = require('./history-paged-json');
const { matchesRootedSessionHead } = require('./codex-root-jsonl');
const { appendRootSourceProof, verifyRootSourcePrefix, CodexRootProjectionOwner } = require('./codex-root-projection-owner');
const { historyPagedJsonEvents } = require('./history-paged-store');
const { quote } = require('./history-paged-stringify');
const text = require('./history-paged-text');
const {readTimelineForkPresentationFreshness}=require('./timeline-fork-presentation-freshness');
// codex-fork-lineage-v2's existing grammar (session-history-events.js).
const CODEX_FORK_MAX_SOURCE_SEGMENTS = 16;

const failure = (code, reason = code) => Object.assign(new Error(code), { code, reason });
const tick = () => new Promise(resolve => setImmediate(resolve));
const invalidated = () => failure('CODEX_SOURCE_READ_INVALIDATED');
const refused = (error, reason, extra = {}) => Object.freeze({ success: false, kind: 'unresolved',
  error, reason, lineageReason: reason, bounded: true, ...extra });
const truth = v => text.isText(v) ? v.length !== 0 : !!v;
const equal = (a,b) => text.isText(a) && text.isText(b) ? text.equal(a,b) : a === b;
const or = (v,fallback) => truth(v) ? v : fallback;

/** Uses the caller's existing page store and the existing source API. No DDL,
 * application writes, native event DTOs, recovery, or additional connection.
 * Physical success owns a frozen metadata root + source ticket; release it.
 * Compatibility results are read-scope refusals, NEVER legacy DTO fallbacks.
 */
async function readCodexRootPhysicalScope({ store, manager, api, service, sessionId, cwd, tabId = null,
  control, sourceOptions = {} } = {}) {
  api ||= service?.codexData?._api;
  manager ||= service?.sessionHistoryStore;
  if (!store || store.closed || !api?.findCodexSessionFile || !api.beginCodexSourceRead
    || !api.assertCodexSourceRead || !api.assertCodexSourceReadCurrent || !api.finishCodexSourceRead
    || typeof sessionId !== 'string' || !sessionId) throw failure('HISTORY_ROOT_SCOPE_CONFIGURATION');
  const db = manager?.db;
  const metrics = { sourceBytes: 0, verificationBytes: 0, sqlChunks: 0, maxSQLChunkBytes: 0,
    lineageRows: 0, headerRecords: 0, wholeLineStrings: 0, nativeEventDTOs: 0, maxParserFrames: 0 };
  let arena, root, parser, handle, source, before, dbFile, primary, unregister, released = false;
  let firstNonMetadata = null, metadataFound = false, headerComplete = false, published = false;
  const clean = v => arena.step(() => text.isText(v) ? text.trim(v) : '');
  const primitive = (v,field) => {
    if(v!==null&&typeof v==='object'&&!text.isText(v))throw failure('HISTORY_ROOT_METADATA_COERCION_NOT_MIGRATED',field);
    return v;
  };
  const numeric = (v,field) => arena.step(()=>text.number(primitive(v,field)));
  const stringValue = (v,field) => arena.step(()=>text.coerce(primitive(v,field)));
  const checkDemand = () => control?.assertCurrent();
  const sql = statement => {
    const unknown = error => failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN','sqlite-read-failed:'+(error.code||'unknown'));
    let prepared;try{prepared=db.prepare(statement);}catch(error){throw unknown(error);}
    return {get(...args){try{return prepared.get(...args);}catch(error){throw unknown(error);}}};
  };
  function dbWitness() {
    if (!db?.prepare || manager.db !== db || db.inTransaction !== false) throw failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN', 'connection-or-transaction-unknown');
    const witness=readTimelineForkPresentationFreshness(db);
    if(!witness)throw failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN','version-unknown');
    const physical = dbFile ? fs.statSync(dbFile, { bigint: true }) : null;
    // Only the exactly attested complete event/link grammar may ignore a
    // foreign UI commit. Local changes/rollback retain the original fence.
    return [witness.schemaVersion,witness.tempSchemaVersion,witness.totalChanges,
      physical ? String(physical.dev)+':'+physical.ino : null,witness.mode,
      witness.mode==='scoped'?witness.version:witness.dataVersion];
  }
  function guard() {
    checkDemand();
    if (released) throw failure('HISTORY_ROOT_SCOPE_RELEASED');
    if (source) api.assertCodexSourceReadCurrent(source);
    if (before) {
      const now = dbWitness();
      if (now.some((v,i) => v !== before[i])) throw failure('HISTORY_ROOT_LINEAGE_CHANGED');
    }
  }
  async function checkpoint() { guard(); if (control?.checkpoint) await control.checkpoint(); else await tick(); guard(); }
  function release() {
    if (released) return; released = true; unregister?.();
    try { root?.release(); } finally {
      try { arena?.close(); } finally { if (source?.ticket) api.finishCodexSourceRead(source); }
    }
  }
  async function verify() {
    guard(); await api.assertCodexSourceRead(source); guard();
  }
  // Exact JSON digest of a small-shape normalized manifest, with unbounded
  // strings still on pages (including correct surrogate escaping at seams).
  async function digest(value) {
    let lease;
    try {
      lease = arena.step(() => arena.publish(value));
      const hash = createHash('sha256'); let n = 0;
      for (const event of historyPagedJsonEvents(lease.cursor(), { assertCurrent: guard })) {
        const parts = typeof event === 'string' ? [event] : event.text ? quote(event.text.textChunks()) : [JSON.stringify(event.scalar)];
        for (const part of parts) { hash.update(part); if (++n % 32 === 0) await checkpoint(); }
      }
      return hash.digest('hex');
    } finally { lease?.release(); }
  }
  // Same normalized v2 manifest grammar/digest as session-history-events.
  // The 16-segment maximum is that EXISTING contract, not a new data limit.
  async function exactManifest(value, expectedSource) {
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || !equal(value.schema,'codex-fork-lineage-v2') || !equal(value.mode,'direct-virtual')) return false;
    const sourceId = clean(value.sourceSessionId), childId = clean(value.childSessionId), segments = value.sourceSegments;
    if (!truth(sourceId) || !equal(childId,sessionId) || equal(sourceId,childId)
      || truth(clean(expectedSource)) && !equal(sourceId,clean(expectedSource))
      || !Array.isArray(segments) || !segments.length || segments.length > CODEX_FORK_MAX_SOURCE_SEGMENTS) return false;
    const nonnegative = v => { const n = numeric(v,'manifest-non-scalar-number'); return Number.isInteger(n) && n >= 0 ? n : null; };
    const sha = v => {
      const s = clean(v); if (s.length !== 64) return null;
      const native = text.small(s,64).toLowerCase(); return /^[a-f0-9]{64}$/.test(native) ? native : null;
    };
    const normalized = arena.step(() => arena.make('array'));
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i], physicalSessionId = clean(or(s?.physicalSessionId,s?.sessionId));
      const fromByte=nonnegative(s?.fromByte),toByte=nonnegative(s?.toByte),startLine=nonnegative(s?.startLine),endLine=nonnegative(s?.endLine);
      const prefixDigest=sha(or(s?.prefixDigest,s?.sha256));
      if (!truth(physicalSessionId) || equal(physicalSessionId,childId) || fromByte===null || toByte===null || toByte<fromByte
        || startLine===null || endLine===null || endLine<startLine || !prefixDigest) return false;
      let segmentId=clean(s?.segmentId);
      if (!truth(segmentId)) segmentId=(await digest(arena.step(()=>arena.own([physicalSessionId,fromByte,toByte,startLine,endLine,prefixDigest])))).slice(0,24);
      for(let j=0;j<i;j++)if(equal(normalized[j].physicalSessionId,physicalSessionId)||equal(normalized[j].segmentId,segmentId))return false;
      arena.step(()=>normalized.push({segmentId,physicalSessionId,fromByte,toByte,startLine,endLine,prefixDigest}));
      await checkpoint();
    }
    const byteOffset=nonnegative(value.childTailStart?.byteOffset),line=nonnegative(value.childTailStart?.line),prefixDigest=sha(value.childTailStart?.prefixDigest);
    if(byteOffset===null||line===null||!prefixDigest)return false;
    const normalizedDigest=await digest(arena.step(()=>arena.own({schema:'codex-fork-lineage-v2',mode:'direct-virtual',sourceSessionId:sourceId,
      childSessionId:childId,sourceSegments:normalized,childTailStart:{physicalSessionId:childId,byteOffset,line,prefixDigest}})));
    return normalizedDigest===sha(value.manifestDigest);
  }
  const columns = new Set(['source_session_id','fork_mode','origin','snapshot_complete','entry_uuids_json','lineage_manifest_json','boundary_entry_uuid']);
  async function load(id, column, json = false) {
    guard(); if (!columns.has(column)) throw failure('HISTORY_ROOT_SCOPE_CONFIGURATION');
    const info=sql(`SELECT typeof(${column}) AS kind,length(CAST(${column} AS BLOB)) AS bytes FROM main.session_history_events WHERE id=?`).get(id);
    if(!info)throw failure('HISTORY_ROOT_LINEAGE_CHANGED');
    if(info.kind==='null')return null;
    if(info.kind==='integer'||info.kind==='real')return json?null:sql(`SELECT ${column} AS value FROM main.session_history_events WHERE id=?`).get(id).value;
    if(info.kind!=='text')throw failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN','column-type-'+column);
    if(!Number.isSafeInteger(info.bytes)||info.bytes<0)throw failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN','column-length-unknown');
    const read=sql(`SELECT substr(CAST(${column} AS BLOB),?,?) AS bytes FROM main.session_history_events WHERE id=?`);
    let p,lease,writer,decoder,endBuild;
    try {
      if(json)p=createPagedJsonProjection(store,{selectedTokenBytes:64,jsonWhitespaceOnly:true});
      else {endBuild=store.beginBuild();writer=store.leafWriter();decoder=new StringDecoder('utf8');}
      for(let at=0;at<info.bytes;){
        guard();const part=read.get(at+1,1024,id)?.bytes;
        if(!ArrayBuffer.isView(part)||!part.byteLength||part.byteLength>1024)throw failure('HISTORY_ROOT_LINEAGE_CHANGED');
        const bytes=Buffer.from(part.buffer,part.byteOffset,part.byteLength);
        if(p)p.write(bytes,at);else store.transaction(()=>writer.write(decoder.write(bytes)));
        at+=part.byteLength;metrics.sqlChunks++;metrics.maxSQLChunkBytes=Math.max(metrics.maxSQLChunkBytes,part.byteLength);await checkpoint();
      }
      if(p){const parsed=p.finish(info.bytes);lease=parsed.lease;return parsed.valid?arena.step(()=>arena.own(lease.cursor())):null;}
      return arena.step(()=>{writer.write(decoder.end());return text.fromRef(arena,writer.finish());});
    }finally{lease?.release();p?.abort();endBuild?.();}
  }
  async function members(id) {
    const raw=await load(id,'entry_uuids_json',true),ids=arena.step(()=>arena.make('array')),seen=arena.step(()=>arena.make('set'));
    if(Array.isArray(raw))for(let i=0;i<raw.length;i++){
      arena.step(()=>{const v=clean(raw[i]);if(truth(v)&&!seen.has(v)){seen.add(v);ids.push(v);}});
      if(i%32===31)await checkpoint();
    }
    return ids;
  }
  async function hasMembers(id) {
    // Recovery needs only the normalized emptiness predicate. Do not build a
    // second UUID membership/index merely to answer it.
    const raw=await load(id,'entry_uuids_json',true);
    if(Array.isArray(raw))for(let i=0;i<raw.length;i++){
      // Native normalization ignores non-strings and trims whitespace. This
      // predicate needs neither a trimmed copy nor a UUID-sized synchronous
      // walk: a non-whitespace code unit is sufficient.
      if(text.isText(raw[i])){let chunks=0;for(const part of text.chunks(raw[i])){
        if(/\S/u.test(part))return true;if(++chunks%32===0)await checkpoint();
      }}
      if(i%32===31)await checkpoint();
    }
    return false;
  }
  async function scanHeader(filePath) {
    handle=await fs.promises.open(filePath,'r');guard();
    const expected=source.snapshot;
    const assertStat = stat => {
      if(stat.dev+':'+stat.ino!==expected.fileIdentity || stat.size!==expected.size
        || stat.mtimeMs!==expected.mtimeMs || stat.ctimeMs!==expected.ctimeMs)throw invalidated();
    };
    assertStat(await handle.stat());guard();
    let offset=0,start=0,done=false;
    async function record(end,committed) {
      const parsed=parser.finish(end);parser=null;
      try {
        if(!parsed.valid){if(!parsed.empty)throw failure('HISTORY_ROOT_METADATA_UNRESOLVED',committed?'invalid-header-record':'partial-header-record');return;}
        const value=parsed.lease.cursor();
        const isMeta=value.kind==='object'&&value.field('type').kind==='text'&&equalCursor(value.field('type'),'session_meta');
        if(isMeta){metrics.headerRecords++;if(!metadataFound){metadataFound=true;
          arena.step(()=>{arena.state().metadata=arena.own(value.field('payload'));});}}
        else if(metadataFound){
          firstNonMetadata=value.kind==='object'&&value.field('type').kind==='text'&&equalCursor(value.field('type'),'compacted')?'compacted':'other';
          done=true;headerComplete=true;
        }
      }finally{parsed.lease?.release();}
    }
    const bytes=Buffer.alloc(Math.min(store.pageBytes,1024));
    while(offset<expected.size&&!done){
      guard();const result=await handle.read(bytes,0,Math.min(bytes.length,expected.size-offset),offset);guard();
      if(!result.bytesRead)throw invalidated();
      const part=bytes.subarray(0,result.bytesRead);appendRootSourceProof(arena,part);metrics.sourceBytes+=part.length;
      let at=0;
      while(at<part.length&&!done){parser ||= createPagedJsonProjection(store,{selectedTokenBytes:64});
        const nl=part.indexOf(10,at),end=nl<0?part.length:nl;parser.write(part.subarray(at,end),offset+at);
        metrics.maxParserFrames=Math.max(metrics.maxParserFrames,parser.stats().maxParserFrames||0);
        if(nl<0)break;await record(offset+end,true);start=offset+end+1;at=end+1;
      }
      offset+=part.length;await checkpoint();
    }
    if(!done&&parser){await record(offset,false);start=offset;}
    if(!done&&start<=offset)headerComplete=true;
    assertStat(await handle.stat());assertStat(await fs.promises.stat(filePath));guard();
    await handle.close();handle=null;
    if(!metadataFound||!headerComplete)throw failure('HISTORY_ROOT_METADATA_UNRESOLVED','root-metadata-missing');
    const proof=await verifyRootSourcePrefix(arena,filePath,metrics.sourceBytes,
      {dev:Number(expected.fileIdentity.split(':')[0]),ino:Number(expected.fileIdentity.split(':')[1]),size:expected.size,mtimeMs:expected.mtimeMs,ctimeMs:expected.ctimeMs},
      {assertCurrent:guard,schedule:checkpoint});
    metrics.verificationBytes+=proof.bytes;if(!proof.valid)throw invalidated();
  }
  function equalCursor(cursor, expected) {
    if(cursor.kind!=='text'||cursor.length!==expected.length)return false;
    let at=0;for(const part of cursor.textChunks()){if(expected.slice(at,at+part.length)!==part)return false;at+=part.length;}return at===expected.length;
  }
  async function materializedCompact(legacy, meta) {
    if(!equal(legacy.mode,'latest_compact')||!['app','terminal-mcp','orchestration'].some(v=>equal(legacy.origin,v))
      ||legacy.complete!==true||!equal(legacy.parent,meta.forked_from_id)||firstNonMetadata!=='compacted')return false;
    const ids=await members(legacy.id);if(!ids.length)return false;
    if(!api.projectCodexRootTimelineFromFile)throw failure('HISTORY_ROOT_MATERIALIZED_PROOF_NOT_MIGRATED','rooted-timeline-unavailable');
    const owner=new CodexRootProjectionOwner(store,{namespace:api.CODEX_ROOT_TIMELINE_NAMESPACE||'codex-timeline-v1'});
    // The producer requires its Timeline namespace. Give this temporary proof
    // a disjoint key shape so cleanup cannot evict an existing caller's root.
    const nonce=randomUUID();owner.key=(id,directory)=>{owner.assertOpen();return JSON.stringify([owner.namespace,'physical-scope-proof',nonce,id,directory||'']);};
    let result;
    try {
      result=await api.projectCodexRootTimelineFromFile(sessionId,cwd,{...sourceOptions,rootedOwner:owner,_readControl:control,tabId});guard();
      if(!result?.success||!result.entries?.at)throw failure('HISTORY_ROOT_MATERIALIZED_PROOF_NOT_MIGRATED','rooted-timeline-proof-unavailable');
      for(const key of ['filePath','fileIdentity','sourceGeneration','size','mtimeMs','ctimeMs'])if(result.sourceSnapshot?.[key]!==source.snapshot[key])throw invalidated();
      if(result.entries.length<ids.length)return false;
      for(let i=0;i<ids.length;i++){
        const uuid=result.entries.at(i).field('uuid'),expected=ids[i];
        if(uuid.kind!=='text'||uuid.length!==expected.length)return false;
        let offset=0;for(const part of uuid.textChunks()){
          if(!equal(arena.step(()=>text.slice(expected,offset,offset+part.length)),part))return false;
          offset+=part.length;
        }
        if(i%32===31)await checkpoint();
      }
      return !truth(legacy.boundary)||equal(ids[ids.length-1],legacy.boundary);
    }finally{try{result?.release();}finally{owner.evict(sessionId,cwd);owner.close();}}
  }
  try {
    checkDemand();arena=new HistoryProjectionArena(store);arena.step(()=>{arena.state().metadata=null;});
    const found=await api.findCodexSessionFile(sessionId,cwd,{...sourceOptions,
      rootedIdentity:filePath=>matchesRootedSessionHead(filePath,sessionId,store,{control})});checkDemand();
    if(!found?.filePath)throw failure('HISTORY_ROOT_SOURCE_UNAVAILABLE','session-file-missing');
    source=await api.beginCodexSourceRead(found.filePath,sessionId);checkDemand();
    const s=source?.snapshot;
    if(!source?.ticket||s?.filePath!==found.filePath||s.sessionId!==sessionId||!s.fileIdentity||!s.sourceGeneration
      ||!Number.isSafeInteger(s.size)||s.size<0||!['mtimeMs','ctimeMs'].every(k=>Number.isFinite(s[k])))throw failure('HISTORY_ROOT_SOURCE_UNAVAILABLE','source-proof-unknown');
    guard();
    await scanHeader(found.filePath);await verify();
    const meta=arena.state().metadata;
    if(!meta||!equal(meta.id,sessionId))throw failure('HISTORY_ROOT_METADATA_UNRESOLVED','root-session-mismatch');
    if(typeof db?.name==='string'&&db.name!==':memory:')dbFile=db.name;
    before=dbWitness();guard();
    const where=`(session_id=? OR source_session_id=?) AND event_type='fork' AND provider='codex'
      AND COALESCE(NULLIF(child_session_id,''),session_id)=? AND is_direct=1`;
    const first=sql(`SELECT id FROM main.session_history_events WHERE ${where} ORDER BY COALESCE(occurred_at,created_at),id LIMIT 1`).get(sessionId,sessionId,sessionId);
    const next=sql(`SELECT id FROM main.session_history_events WHERE ${where} AND (? IS NULL OR id>?) ORDER BY id LIMIT 1`);
    let at=null,exactParent=null,multiple=false;
    for(;;){guard();const row=next.get(sessionId,sessionId,sessionId,at,at);if(!row)break;
      if(!Number.isSafeInteger(row.id)||at!==null&&row.id<=at)throw failure('HISTORY_ROOT_LINEAGE_SQL_UNKNOWN','row-id-unknown');at=row.id;metrics.lineageRows++;
      const manifest=await load(at,'lineage_manifest_json',true);
      if(manifest&&await load(at,'snapshot_complete')!==0){const parent=await load(at,'source_session_id');
        if(await exactManifest(manifest,parent)){const id=clean(manifest.sourceSessionId);if(exactParent!==null&&!equal(id,exactParent))multiple=true;exactParent=id;}}
      await checkpoint();
    }
    if(multiple){await verify();return refused('lineage_unresolved','multiple-exact-parent-events',{legacyKind:'unresolved',
      requiredRecovery:equal(meta.history_mode,'paginated')&&!!meta.history_base&&typeof meta.history_base==='object'});}
    if(exactParent!==null){await verify();return refused('HISTORY_ROOT_COMPOSITE_NOT_MIGRATED','exact-virtual-lineage',{kind:'compatibility',capability:'legacy-composite',legacyKind:'virtual',requiredRecovery:true});}
    let legacy=null;
    if(first){legacy={id:first.id,parent:await load(first.id,'source_session_id'),mode:await load(first.id,'fork_mode'),origin:await load(first.id,'origin'),
      complete:await load(first.id,'snapshot_complete')!==0,boundary:await load(first.id,'boundary_entry_uuid')};}
    if(legacy&&equal(meta.history_mode,'paginated')&&await materializedCompact(legacy,meta)){
      // Existing app-materialized compact proof wins over the inherited header.
    }else if(equal(meta.history_mode,'paginated')&&meta.history_base&&typeof meta.history_base==='object'){
      const parent=clean(stringValue(or(meta.forked_from_id,''),'history-base-parent')),base=meta.history_base;
      const offset=numeric(base.end_byte_offset,'history-base-end-byte'),ordinal=numeric(base.end_ordinal_exclusive,'history-base-ordinal'),forkOrdinal=numeric(meta.forked_from_ordinal_exclusive,'fork-ordinal');
      const invalid=!truth(parent)||!equal(clean(stringValue(or(base.thread_id,''),'history-base-thread')),parent)||!Number.isSafeInteger(offset)||offset<=0
        ||!Number.isSafeInteger(ordinal)||ordinal<0||Number.isSafeInteger(forkOrdinal)&&forkOrdinal!==ordinal;
      await verify();
      if(invalid)return refused('lineage_unresolved','provider-history-base-invalid',{legacyKind:'physical',requiredRecovery:true});
      if(truth(legacy?.parent)&&!equal(legacy.parent,parent))return refused('lineage_unresolved','provider-history-base-parent-mismatch',{legacyKind:'physical',requiredRecovery:true});
      return refused('HISTORY_ROOT_COMPOSITE_NOT_MIGRATED','provider-history-base-recovery-required',
        {kind:'compatibility',capability:'legacy-composite',legacyKind:'physical',requiredRecovery:true});
    }else if(legacy&&(!truth(legacy.mode)||equal(legacy.mode,'unknown'))&&!await hasMembers(legacy.id)){
      await verify();return refused('lineage_unresolved','provider-history-base-absent',{legacyKind:'physical',requiredRecovery:true});
    }
    await verify();root=arena.step(()=>arena.publish(arena.state()));guard();
    unregister=control?.onSettled?.(release);guard();published=true;
    return Object.freeze({success:true,kind:'physical',legacyKind:'physical',requiredRecovery:false,bounded:true,
      sourceAuthority:Object.freeze({...source.snapshot,externalVersion:source.ticket.externalVersion??null}),
      metadata:root.cursor().field('metadata'),root,metrics:Object.freeze({...metrics}),assertCurrent:guard,verify,release});
  }catch(error){
    primary=error;
    if(error.code==='CODEX_SOURCE_READ_INVALIDATED'||error.code==='HISTORY_READ_CANCELLED'
      ||/^HISTORY_READER_/.test(error.code||'')||error.code==='HISTORY_ROOT_LINEAGE_CHANGED')throw error;
    if(/^HISTORY_ROOT_(?:LINEAGE_SQL_UNKNOWN|METADATA_UNRESOLVED|SOURCE_UNAVAILABLE|MATERIALIZED_PROOF_NOT_MIGRATED|METADATA_COERCION_NOT_MIGRATED)$/.test(error.code||'')){
      checkDemand();if(source?.ticket&&error.reason!=='source-proof-unknown'){await api.assertCodexSourceRead(source);checkDemand();api.assertCodexSourceReadCurrent(source);}
      return refused(error.code,error.reason,{legacyKind:'unknown',requiredRecovery:null});
    }
    throw error;
  }finally{
    parser?.abort();try{await handle?.close();}catch(error){if(!primary)throw error;}
    finally{if(!published)release();}
  }
}

module.exports={readCodexRootPhysicalScope};
