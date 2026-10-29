'use strict';

// Existing isolated-reader adapter. It owns no application input/Send, does
// not materialize getHistory and never grants a source writer capability.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { HistoryPagedStore, isHistoryPagedCursor, materializeHistoryCursor } = require('./history-paged-store');
const { HistoryRootReadPlane } = require('./history-root-read-plane');
const { dehydrateHistoryRoot } = require('./history-root-dehydrate');
const { searchHistoryRoot } = require('./history-root-search');
const { buildHistoryRootIndexes } = require('./history-root-indexes');
const { HISTORY_PAYLOAD_RENDER_CAP } = require('../shared/history-payload-limits.cjs');
const { CodexRootProjectionOwner } = require('./codex-root-projection-owner');
const { HistoryInputDocument } = require('./history-input-document');
const { HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES } = require('./history-cache-policy');
const { reserveHistoryRootCacheBudget, configureHistoryRootZeroCache,
  historyRootCacheMemory } = require('./history-root-cache-budget');
const { createReadAdmission, isHistoryReadCancelled, createHistoryGcDiagnostic,
  assertHistoryGcControl } = require('./history-read-control');
const { performance } = require('node:perf_hooks');
const fail = code => Object.assign(new Error(code), { code });
const wireBytes = value => Buffer.byteLength(JSON.stringify(value));
const METHODS = new Set(['openHistoryRoot', 'openHistoryPayload', 'readHistoryRootPage',
  'forkHistoryRootLeaf', 'releaseHistoryRoot', 'historyInputDocument']);
const tick = () => new Promise(resolve => setImmediate(resolve));
const {forkPrimaryHistoryView}=require('./history-primary-semantic-bundle');
const {readCodexRootPhysicalScope}=require('./codex-root-physical-scope');
const { HISTORY_PRESENTATION_POSITION_PROFILE: POSITION_PROFILE,
  HISTORY_PRESENTATION_POSITION_QUERY_ENCODING: POSITION_QUERY_ENCODING } = require('./history-presentation-position');

// The reader's existing console transport adds its AsyncLocalStorage request
// correlation. Fixed scalars only; no source/profile/payload reads or new wire.
// Intervals include awaits/checkpoints, overlap their parent, and are NOT CPU.
let backingDiagnosticId = 0;
function backingPhase(stage, begin = true) {
  const started = performance.now(), id = ++backingDiagnosticId;
  const report = fields => { try { console.log('[HistoryRootBacking] ' + JSON.stringify({
    id, stage, startAbs: performance.timeOrigin + started, timing: 'inclusive-elapsed-wall', ...fields,
  })); } catch {} };
  if (begin) report({ event: 'begin' });
  return (error, fields = {}, quiet = false) => {
    try {
      const ended = performance.now(), elapsedMs = ended - started;
      if (quiet && !error && elapsedMs < 100) return;
      report({ event: 'end', endAbs: performance.timeOrigin + ended, elapsedMs,
        outcome: error ? isHistoryReadCancelled(error) ? 'cancelled' : 'error' : 'success',
        ...(error ? { errorCode: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'OTHER' } : {}), ...fields });
    } catch {} // Even an unusual error/observer cannot change cleanup or ACK.
  };
}

class HistoryRootController {
  constructor({ cache, service, api, Database, sourceSchema, sourceOptions = {},
    store = null, maxDocuments = 32, rootDiskBudgetBytes, maxCachedOwners = 32, onProgress = () => {},
    prepareSemanticResult = null, preparePrimaryResult = null, prepareTimelineResult = null, prepareTimelineViewResult = null,
    forkTimelineViewResult = null, createTimelineDocument = null, diagnosticsDisabled = false }) {
    if (!cache || !service || !api?.projectCodexFullHistoryFromFile) throw fail('HISTORY_ROOT_CONFIGURATION');
    if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 64) throw fail('HISTORY_ROOT_CONFIGURATION');
    if (!Number.isSafeInteger(maxCachedOwners) || maxCachedOwners < 1 || maxCachedOwners > 64) throw fail('HISTORY_ROOT_CONFIGURATION');
    this.cache = cache; this.service = service; this.api = api; this.Database = Database;
    this.sourceSchema = sourceSchema; this.sourceOptions = sourceOptions;
    this.store = store; this.ownsStore = !store; this.plane = null;
    this.documents = new Map(); this.preparing = 0; this.maxDocuments = maxDocuments;
    this.rootDiskBudgetBytes = rootDiskBudgetBytes; this.onProgress = onProgress;
    this.prepareSemanticResult = prepareSemanticResult;
    this.preparePrimaryResult = preparePrimaryResult;
    this.prepareTimelineResult = prepareTimelineResult;
    this.prepareTimelineViewResult = prepareTimelineViewResult;this.forkTimelineViewResult=forkTimelineViewResult;
    this.createTimelineDocument=createTimelineDocument;
    this.closed = false; this.originalCacheBudget = cache.maxBytes;
    this.totalBudget = Number.isSafeInteger(cache.maxBytes) && cache.maxBytes >= 0
      ? cache.maxBytes : HISTORY_PREPARED_CACHE_DISK_BUDGET_BYTES;
    this.rootBudget = rootDiskBudgetBytes ?? Math.floor(this.totalBudget / 2);
    this.namespace = 'codex-canonical-read-plane-v1:' + String(sourceSchema || 'test');
    this.pinPrefix = JSON.stringify([this.namespace]).slice(0, -1) + ',';
    this.maxCachedOwners = maxCachedOwners;
    this.maintenanceAdmission = createReadAdmission();
    this.fullCollectionDepth = 0;
    this.diagnosticsDisabled = diagnosticsDisabled === true;
    this.initializedBacking = false;
    this.maintenanceMetrics = { collections: 0, reclaimedPages: 0, retiredPins: 0,
      evictedOwners: 0, retiredBackingBytes: 0, cleanupErrors: 0 };
    // One fixed reservation from the existing reader index share. Injected
    // stores retain their caller's explicit cache policy (including tiny tests).
    this.cacheMemoryPlan = this.ownsStore ? reserveHistoryRootCacheBudget(cache) : null;
    if (this.ownsStore) {
      this.backingFilename = path.join(cache.baseDirectory, 'paged-read-plane', 'pages.sqlite');
      this.reservedRootBudget = this.rootBudget;
      // Reserve before ANY legacy read, including a restarted reader that
      // never opens a new root. The old SQL family is already on disk.
      if (!Number.isSafeInteger(this.rootBudget) || this.rootBudget < 256 * 1024
        || this.rootBudget > this.totalBudget) {
        this.backingError = fail('HISTORY_ROOT_BACKING_BUDGET');
        this.reservedRootBudget = this.totalBudget;
      } else {
        try {
          const family = this.backingUsage();
          // After an observed old-process exit there are no live capabilities
          // in this owned file. A settings shrink may retire this derived
          // acceleration family; source journals and other caches are untouched.
          if (family.main > Math.floor(this.rootBudget / 2) || family.bytes > this.rootBudget) {
            for (const filename of family.files) fs.unlinkSync(filename);
            this.maintenanceMetrics.retiredBackingBytes = family.bytes;
          }
        } catch (error) {
          this.backingError = error;
          // A partial retirement or unavailable family is not free space.
          // Reserve observed bytes, or the entire setting if unknown, before
          // permitting legacy cache writes. The failure remains explicit.
          try { this.reservedRootBudget = Math.max(this.rootBudget, this.backingUsage().bytes); }
          catch { this.reservedRootBudget = this.totalBudget; }
        }
      }
      cache.maxBytes = Math.max(0, this.totalBudget - this.reservedRootBudget);
      try { cache.prune(); } catch (error) { this.backingError ||= error; }
    }
  }
  handles(method) { return METHODS.has(method); }
  // Routing is not admission or a lifetime pin. Inspect only an already
  // installed native lease; dispatchOwned must authenticate it again later.
  installedCapabilityLane(method, payload) {
    if (!['readHistoryRootPage', 'forkHistoryRootLeaf', 'releaseHistoryRoot'].includes(method)
      || this.closed || this.backingError || !this.plane) return null;
    try {
      const consumerKey = this.consumer(payload);
      const state = this.plane.state(payload, consumerKey);
      // Four slots keep this namespace disjoint from the legacy two-slot key.
      return JSON.stringify(['history-root-lease', this.plane.generation, consumerKey, state.leaseId]);
    } catch { return null; } // Preserve the exact old dispatch/refusal path.
  }
  allocates(method, payload) {
    // Only this authenticated installed v2 position read is actually free of
    // page/pin writes. Keep true allocation classification for registration,
    // canonical/plain forks, malformed/unknown caps and every existing owner.
    // The unchanged worker then retains the exact lease FIFO without adding
    // an unrelated source/null allocation predecessor to a read-only query.
    if (this.installedPositionRead(method, payload)) return false;
    return (method === 'readHistoryRootPage' && (payload.kind === 'primary-agent-catalog-step'
        || Object.hasOwn(payload, 'catalogRequestId') && !this.installedAgentCatalogRead(method, payload)))
      || (method === 'readHistoryRootPage' && payload.kind === POSITION_PROFILE)
      || (method === 'readHistoryRootPage' && payload.kind === 'primary-canonical-metadata')
      || (method === 'readHistoryRootPage' && payload.kind === 'timeline-query'
      && ['measure', 'resize', 'status', 'document', 'retain', 'iteration'].includes(payload.operation))
      || ['openHistoryRoot', 'openHistoryPayload', 'forkHistoryRootLeaf'].includes(method)
      || method === 'historyInputDocument' && ['prepare', 'replace', 'undo', 'redo'].includes(payload?.operation);
  }
  installedPositionRead(method, payload) {
    if (!['readHistoryRootPage', 'forkHistoryRootLeaf'].includes(method)
      || this.closed || this.backingError || !this.plane || !this.store
      || this.plane.store !== this.store || this.store.closed
      || this.store.depth !== 0 || this.store.db.inTransaction !== false) return false;
    try {
      this.plane.assertPositionRead(method, payload, this.consumer(payload));
      return true;
    } catch { return false; }
  }
  installedAgentCatalogRead(method, payload) {
    // Ready generic reads may omit the allocation predecessor ONLY after the
    // installed child, its request ID, exact sequence and no-write phase agree.
    if (method !== 'readHistoryRootPage' || this.closed || this.backingError
      || !this.plane || !this.store || this.plane.store !== this.store || this.store.closed
      || this.store.depth !== 0 || this.store.db.inTransaction !== false) return false;
    try { this.plane.assertAgentCatalogRead(payload, this.consumer(payload)); return true; }
    catch { return false; }
  }
  installedBodyPinFork(method, payload) {
    // Pin allocation remains true; only its unrelated source/null predecessor
    // and maintenance preparation may be omitted. Dispatch rechecks NOW.
    if (method !== 'forkHistoryRootLeaf' || payload?.encoding !== 'history-entry-body-borrow-v1'
      || this.closed || this.backingError || !this.initializedBacking || this.fullCollectionDepth !== 0
      || !this.plane || !this.store || this.plane.store !== this.store || this.store.closed
      || this.store.depth !== 0 || this.store.db.inTransaction !== false) return false;
    try { return this.plane.inspectBodyBorrow(payload, this.consumer(payload)).eligible === true; }
    catch { return false; }
  }
  installedTextPinFork(method, payload) {
    // This is NOT worker allocation classification or source freshness. Only
    // an existing immutable TEXT pin may avoid the long maintenance-prep lane.
    // Never bootstrap backing, borrow a parent-only view or remember a miss.
    if (method !== 'forkHistoryRootLeaf' || this.closed || this.backingError
      || !this.initializedBacking || this.fullCollectionDepth !== 0 || !this.plane || !this.store
      || this.plane.store !== this.store || this.store.closed
      || this.store.depth !== 0 || this.store.db.inTransaction !== false
      || ![undefined, 'plain'].includes(payload?.encoding)) return false;
    try {
      this.plane.assertTextPinFork(payload, this.consumer(payload));
      return true;
    } catch { return false; } // Original exact admission/refusal, no retry.
  }
  backingUsage() {
    if (!this.backingFilename) return { main: 0, bytes: this.store?.diskUsage() || 0, files: [] };
    const directory = path.dirname(this.backingFilename);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('HISTORY_ROOT_BACKING_TYPE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let bytes = 0, main = 0; const files = [];
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const filename = this.backingFilename + suffix;
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile()) throw fail('HISTORY_ROOT_BACKING_TYPE');
        files.push(filename); bytes += stat.size; if (!suffix) main = stat.size;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { main, bytes, files };
  }
  ensurePlane() {
    if (this.closed) throw fail('HISTORY_ROOT_PLANE_CLOSED');
    if (this.backingError) throw this.backingError;
    if (this.plane) return this.plane;
    const end = backingPhase('ensure-plane'); let primary;
    try {
    if (!this.store) {
      try {
        this.cache.prune();
        if ((this.cache.stats().diskBytes || 0) > this.cache.maxBytes) throw fail('HISTORY_BACKING_FULL');
        fs.mkdirSync(path.dirname(this.backingFilename), { recursive: true, mode: 0o700 });
        this.store = new HistoryPagedStore({ filename: this.backingFilename,
          Database: this.Database, ...this.cacheMemoryPlan.storeOptions, diskBytes: this.rootBudget });
        configureHistoryRootZeroCache(this.store, this.cacheMemoryPlan);
      } catch (error) {
        this.store?.close(); this.store = null;
        // Keep the reservation: failed opening does not remove existing bytes.
        throw error;
      }
    }
    this.rootOwner = new CodexRootProjectionOwner(this.store, { namespace: this.namespace });
    if(typeof this.api.projectCodexRootTimelineFromFile==='function')this.timelineOwner=new CodexRootProjectionOwner(this.store,
      {namespace:this.api.CODEX_ROOT_TIMELINE_NAMESPACE});
    this.plane = new HistoryRootReadPlane({ store: this.store, rootedOwner: this.rootOwner,
      projectHistory: this.api.projectCodexFullHistoryFromFile,
      projectTimeline: this.api.projectCodexRootTimelineFromFile,timelineOwner:this.timelineOwner,
      forkTimelineResult:(parent,payload,control,raw)=>{
        if(typeof this.forkTimelineViewResult!=='function')throw fail('TIMELINE_VIEW_FORK_UNAVAILABLE');
        return this.forkTimelineViewResult(parent,payload,control,raw);},
      createTimelineDocument:(parent,request,options)=>{
        if(typeof this.createTimelineDocument!=='function')throw fail('TIMELINE_DOCUMENT_UNAVAILABLE');
        return this.createTimelineDocument(parent,request,options);},
      prepareResult: (result, payload, control) => this.prepareReadRoot(result, payload, control),
      forkPrimaryResult: (parent,payload,control)=>forkPrimaryHistoryView(this.store,parent,{service:this.service,payload,control}) });
    return this.plane;
    } catch (error) { primary = error; throw error; }
    finally { end(primary); }
  }
  async prepareReadRoot(result, payload, control) {
    if(payload.readProfile==='timeline-view-v1'){
      if(typeof this.prepareTimelineViewResult!=='function')throw fail('TIMELINE_VIEW_PREPARATION_UNAVAILABLE');
      return this.prepareTimelineViewResult(result,payload,control);
    }
    if(payload.readProfile==='timeline-primary-v1') {
      if(typeof this.prepareTimelineResult!=='function')throw fail('TIMELINE_PRIMARY_PREPARATION_UNAVAILABLE');
      return this.prepareTimelineResult(result,payload,control);
    }
    if(payload.readProfile === 'history-primary-v1'){
      if(typeof this.preparePrimaryResult!=='function')throw fail('HISTORY_PRIMARY_PREPARATION_UNAVAILABLE');
      const presentation=payload.primaryPresentation || {};
      const primaryPayload={...payload,
        localEntries:presentation.localEntries ?? payload.localEntries ?? [],
        liveEntries:presentation.liveEntries ?? payload.liveEntries ?? [],
        liveToolResults:presentation.liveToolResults ?? payload.liveToolResults ?? [],
        rewindPreview:presentation.rewindPreview ?? payload.rewindPreview ?? null,
        grouping:presentation.grouping ?? payload.grouping,
        captionSelections:presentation.captionSelections ?? payload.captionSelections ?? [],
        settingsPresentationKeys:presentation.settingsPresentationKeys ?? payload.settingsPresentationKeys ?? [],
        suppressions:payload.suppressions || []};
      const primary=await this.preparePrimaryResult(result,primaryPayload,control);
      try{
        if(!primary?.root?.cursor || !primary?.headerCursor || typeof primary.close!=='function'
          || !Number.isSafeInteger(primary.canonicalEntryCount) || typeof primary.semanticRevisionToken!=='string') {
          throw fail('HISTORY_PRIMARY_PREPARATION_CONTRACT');
        }
        let released=false;
        return {...result,root:primary.root,entries:primary.headerCursor,primaryPresentation:primary,
          readProfile:'history-primary-v1',canonicalEntryCount:primary.canonicalEntryCount,
          semanticRevisionToken:primary.semanticRevisionToken,viewRevisionToken:primary.viewRevisionToken,semanticSnapshotComplete:primary.semanticSnapshotComplete===true,
          release(){if(released)return;released=true;let first;try{primary.close();}catch(error){first=error;}
            try{result.release();}catch(error){first ||= error;}if(first)throw first;}};
      }catch(error){try{primary?.close?.();}catch{this.maintenanceMetrics.cleanupErrors++;}throw error;}
    }
    if (!['canonical-index-v1', 'history-semantic-v1'].includes(payload.readProfile)) return;
    let source = result;
    if (payload.readProfile === 'history-semantic-v1') {
      if (typeof this.prepareSemanticResult !== 'function') throw fail('HISTORY_SEMANTIC_PREPARATION_UNAVAILABLE');
      source = await this.prepareSemanticResult(result, payload, control);
      if (!source?.semanticSnapshotComplete || typeof source.release !== 'function') {
        throw fail('HISTORY_SEMANTIC_PREPARATION_CONTRACT');
      }
    }
    let indexes;
    try { indexes = await buildHistoryRootIndexes(this.store, source.root, { control }); }
    catch (error) {
      // The plane owns the original producer result until this hook returns.
      if (source !== result) { try { source.release(); } catch { this.maintenanceMetrics.cleanupErrors++; } }
      throw error;
    }
    let released = false;
    return { ...source, root: indexes.lease, entries: indexes.entries, semanticIndexes: indexes,
      readProfile: payload.readProfile, semanticSnapshotComplete: source.semanticSnapshotComplete === true,
      release() {
        if (released) return; released = true;
        let primary;
        try { source.release(); } catch (error) { primary = error; }
        try { indexes.close(); } catch (error) { primary ||= error; }
        if (primary) throw primary;
      } };
  }
  async checkpoint(control, diagnostic = null) {
    if (!diagnostic) {
      if (control?.checkpoint) await control.checkpoint(); else await tick();
      control?.assertCurrent(); return;
    }
    const started = performance.now(); diagnostic.checkpointOuterCalls++;
    try {
      if (control?.checkpoint) await control.checkpoint(diagnostic);
      else {
        const wait = performance.now(); diagnostic.schedulerCalls++;
        try { await tick(); }
        finally { diagnostic.schedulerWaitMs += performance.now() - wait; }
      }
      assertHistoryGcControl(control, diagnostic);
    } finally { diagnostic.checkpointOuterMs += performance.now() - started; }
  }
  collectBounded(work = 32, diagnosticStage = null, gcDiagnostic = null) {
    const end = diagnosticStage ? backingPhase(diagnosticStage, false) : null;
    let result, primary;
    try {
      if (!this.store || this.store.closed || this.store.builders) return (result = { complete: false, blocked: true });
      result = this.store.collectStep(work, gcDiagnostic);
      this.maintenanceMetrics.reclaimedPages += result.reclaimed || 0;
      if (result.complete) this.maintenanceMetrics.collections++;
      return result;
    } catch (error) { primary = error; throw error; }
    finally { end?.(primary, result); }
  }
  cleanupStep() {
    // Release/Cancel must not wait for a whole store sweep. A subsequent
    // allocation finishes bounded chunks under the same cancellable lane.
    const end = backingPhase('cleanup-step', false);
    let result, error;
    try { result = this.collectBounded(); }
    catch (caught) { error = caught; this.maintenanceMetrics.cleanupErrors++; }
    end(error, result, true);
  }
  async collect(control) {
    const end = backingPhase('collect-full');
    const diagnostic = this.diagnosticsDisabled ? null : createHistoryGcDiagnostic();
    let error, steps = 0, work = 0, reclaimed = 0, result;
    // Full collection yields between bounded transactions. New fast pins
    // would reset its mark at each yield; keep them on original maintenance
    // admission until every active full collector has exited.
    this.fullCollectionDepth++;
    try {
      for (;;) {
        assertHistoryGcControl(control, diagnostic);
        result = this.collectBounded(64, null, diagnostic); steps++;
        work += result.work || 0; reclaimed += result.reclaimed || 0;
        if (result.complete || result.blocked || result.blockedByBuilders) return;
        await this.checkpoint(control, diagnostic);
      }
    } catch (caught) { error = caught; throw caught; }
    finally { this.fullCollectionDepth--; end(error, { steps, work, reclaimed, complete: result?.complete === true,
      blocked: !!(result?.blocked || result?.blockedByBuilders), ...(diagnostic ? { gc: diagnostic } : {}) }); }
  }
  cacheOwner(base, used = 0) {
    this.store.sql('INSERT INTO hp_root_cache_owners(owner_key,namespace,used) VALUES (?,?,?) ON CONFLICT(owner_key) DO UPDATE SET used=MAX(used,excluded.used)')
      .run(base, this.namespace, used);
  }
  async initializeBacking(control) {
    if (this.initializedBacking) return;
    const end = backingPhase('initialize');
    let phase = backingPhase('retire-transient-pins'), error;
    const retiredBefore = this.maintenanceMetrics.retiredPins;
    try {
    // Only this restarted file's transient pins are stale. An injected store
    // may have unrelated live leases, so its owner keeps that authority.
    if (this.ownsStore) {
      for (;;) {
        control?.assertCurrent(); let more = false, retired = 0;
        this.store.transaction(() => {
          for (let n = 0; n < 32; n++) {
            // Default canonical work may have allocated live roots before
            // the first read-plane call initializes its acceleration tables.
            const ownPrefix = this.store.owner + ':';
            const pin = this.store.sql('SELECT name FROM hp_pins WHERE durable=0 AND substr(name,1,?)<>? ORDER BY name LIMIT 1')
              .get(ownPrefix.length, ownPrefix);
            if (!pin) return;
            this.store.sql('DELETE FROM hp_pins WHERE name=? AND durable=0').run(pin.name);
            this.store.sql("UPDATE hp_meta SET value=0 WHERE key='gc_phase'").run();
            retired++; more = true;
          }
        });
        this.maintenanceMetrics.retiredPins += retired;
        if (!more) break; await this.checkpoint(control);
      }
    }
    phase(); phase = backingPhase('retire-parser-namespaces');
    // Old parser namespaces are disposable acceleration, never writer data.
    // Exact prefix + suffix checks avoid touching another owner's durable pin.
    let cursor = '';
    for (;;) {
      control?.assertCurrent(); let more = false, retired = 0;
      this.store.transaction(() => {
        for (let n = 0; n < 32; n++) {
          const pin = this.store.sql('SELECT name FROM hp_pins WHERE durable=1 AND name>? ORDER BY name LIMIT 1').get(cursor);
          if (!pin) return;
          cursor = pin.name; more = true;
          if (pin.name.startsWith('["codex-canonical-read-plane-v1:')
            && !pin.name.startsWith(this.pinPrefix) && /:(?:current|checkpoint:[0-3])$/.test(pin.name)) {
            this.store.removePin(pin.name); retired++;
          }
        }
      });
      this.maintenanceMetrics.retiredPins += retired;
      if (!more) break; await this.checkpoint(control);
    }
    phase(); phase = backingPhase('initial-collection');
    // Keep the full sweep: below-75% SQLite occupancy is not a reservation
    // for the next build while unreachable pages still consume its headroom.
    await this.collect(control);
    phase(); phase = backingPhase('owner-tables');
    this.store.transaction(() => {
      this.store.sql('CREATE TABLE IF NOT EXISTS hp_root_cache_owners(owner_key TEXT PRIMARY KEY,namespace TEXT NOT NULL,used INTEGER NOT NULL)').run();
      this.store.sql('CREATE INDEX IF NOT EXISTS hp_root_cache_lru ON hp_root_cache_owners(namespace,used,owner_key)').run();
      this.store.sql("INSERT OR IGNORE INTO hp_meta(key,value) VALUES ('root_cache_clock',0)").run();
    });
    phase(); phase = backingPhase('restore-cache-owners');
    cursor = '';
    for (;;) {
      control?.assertCurrent(); let more = false;
      this.store.transaction(() => {
        for (let n = 0; n < 32; n++) {
          const pin = this.store.sql('SELECT name FROM hp_pins WHERE durable=1 AND name>? ORDER BY name LIMIT 1').get(cursor);
          if (!pin) return;
          cursor = pin.name; more = true;
          const match = /:(?:current|checkpoint:[0-3])$/.exec(pin.name);
          if ((pin.name.startsWith(this.pinPrefix)||this.timelineOwner && pin.name.startsWith('["'+this.timelineOwner.namespace+'",')) && match)
            this.cacheOwner(pin.name.slice(0, match.index));
        }
      });
      if (!more) break; await this.checkpoint(control);
    }
    phase(); phase = backingPhase('retire-owner-metadata');
    cursor = '';
    for (;;) {
      control?.assertCurrent(); let more = false;
      this.store.transaction(() => {
        for (let n = 0; n < 32; n++) {
          const row = this.store.sql('SELECT owner_key,namespace FROM hp_root_cache_owners WHERE owner_key>? ORDER BY owner_key LIMIT 1').get(cursor);
          if (!row) return;
          cursor = row.owner_key; more = true;
          if (row.namespace !== this.namespace) this.store.sql('DELETE FROM hp_root_cache_owners WHERE owner_key=?').run(row.owner_key);
        }
      });
      if (!more) break; await this.checkpoint(control);
    }
    phase(); phase = backingPhase('evict-excess-owners');
    this.initializedBacking = true;
    await this.evictOwners(control);
    } catch (caught) { error = caught; throw caught; }
    finally { phase(error); end(error, { retiredPins: this.maintenanceMetrics.retiredPins - retiredBefore,
      initialized: this.initializedBacking }); }
  }
  evictOldest(except = '') {
    let removed = false;
    this.store.transaction(() => {
      const oldest = this.store.sql('SELECT owner_key FROM hp_root_cache_owners WHERE namespace=? AND owner_key<>? ORDER BY used,owner_key LIMIT 1').get(this.namespace, except);
      if (!oldest) return;
      // Transient leases still protect any frozen caller roots after a
      // durable acceleration entry loses its LRU slot.
      this.store.removePin(oldest.owner_key + ':current');
      for (let n = 0; n < 4; n++) this.store.removePin(oldest.owner_key + ':checkpoint:' + n);
      this.store.sql('DELETE FROM hp_root_cache_owners WHERE owner_key=?').run(oldest.owner_key);
      this.maintenanceMetrics.evictedOwners++; removed = true;
    });
    return removed;
  }
  async evictOwners(control) {
    for (;;) {
      control?.assertCurrent();
      const count = this.store.sql('SELECT count(*) AS count FROM hp_root_cache_owners WHERE namespace=?').get(this.namespace).count;
      if (count <= this.maxCachedOwners || !this.evictOldest()) return;
      await this.checkpoint(control);
    }
  }
  async makeRoom(method, payload, control) {
    const end = backingPhase('make-room', false);
    let primary, pressure = false;
    try {
    const target = ['openHistoryRoot', 'openHistoryPayload'].includes(method) && payload.readProfile !== POSITION_PROFILE
      ? this.projectionOwner(payload).key(payload.sessionId, payload.cwd) : '';
    if (target && !this.store.sql('SELECT 1 FROM hp_root_cache_owners WHERE owner_key=?').get(target)) {
      const count = this.store.sql('SELECT count(*) AS count FROM hp_root_cache_owners WHERE namespace=?').get(this.namespace).count;
      // New-owner admission frees its LRU slot BEFORE source allocation. A
      // full cache must not depend on a successful over-quota build to evict.
      if (count >= this.maxCachedOwners && this.evictOldest(target)) { pressure = true; await this.collect(control); }
    }
    for (;;) {
      control?.assertCurrent();
      let live = Number(this.store.db.pragma('page_count', { simple: true }))
        - Number(this.store.db.pragma('freelist_count', { simple: true }));
      const limit = Number(this.store.db.pragma('max_page_count', { simple: true }));
      if (live <= Math.floor(limit * 0.75)) return;
      pressure = true;
      // Disposable completed-unit pins belong to their immutable parents.
      // Public documents/Full remain pinned independently during pressure.
      this.plane.releaseGroupDocumentMemos();
      // Reclaim released transient views before evicting durable acceleration.
      // A full mark is pressure work, not a prerequisite for every leaf pin.
      await this.collect(control);
      live = Number(this.store.db.pragma('page_count', { simple: true }))
        - Number(this.store.db.pragma('freelist_count', { simple: true }));
      if (live <= Math.floor(limit * 0.75) || !this.evictOldest(target)) return;
      await this.collect(control);
    }
    } catch (error) { primary = error; throw error; }
    finally { end(primary, { pressure }); }
  }
  async touchOwner(payload, control) {
    const base = this.projectionOwner(payload).key(payload.sessionId, payload.cwd);
    this.store.transaction(() => {
      const value = Number(this.store.sql("SELECT value FROM hp_meta WHERE key='root_cache_clock'").get().value) + 1;
      if (!Number.isSafeInteger(value)) throw fail('HISTORY_ROOT_CACHE_CLOCK');
      this.store.sql("UPDATE hp_meta SET value=? WHERE key='root_cache_clock'").run(value);
      this.cacheOwner(base, value);
    });
    await this.evictOwners(control);
  }
  projectionOwner(payload) {
    const owner=['timeline-primary-v1','timeline-view-v1'].includes(payload.readProfile)?this.timelineOwner:this.rootOwner;
    if(!owner)throw fail('TIMELINE_ROOT_PRODUCER_UNAVAILABLE');
    return owner;
  }
  // Existing physical service sinks use the same canonical producer/backing.
  // Their native DTO/search outputs remain explicitly unbounded compatibility
  // boundaries. They do not open a public capability or capture a legacy DTO.
  async withServiceRoot(sessionId, cwd, options, consume) {
    const control = options._readControl, payload = { sessionId, cwd, toolType: 'codex', tabId: options.tabId };
    const waiting = this.maintenanceAdmission.active;
    const endWait = backingPhase('maintenance-admission', waiting);
    let unlock;
    try { unlock = await this.maintenanceAdmission.acquire(control); }
    catch (error) { endWait(error); throw error; }
    endWait(null, {}, !waiting);
    let result, primary;
    try {
      this.ensurePlane(); await this.initializeBacking(control);
      await this.collect(control);
      await this.makeRoom('openHistoryRoot', payload, control);
      control?.assertCurrent();
      result = await this.api.projectCodexFullHistoryFromFile(sessionId, cwd, {
        ...this.sourceOptions, rootedOwner: this.rootOwner, _readControl: control,
        tabId: options.tabId, includeTurnCoordinates: options.includeTurnCoordinates === true,
        cacheOnly: options.cacheOnly === true,
      });
      control?.assertCurrent();
      if (!result?.success) return result;
      if (result.representation !== 'codex-canonical-root-v1'
        || !isHistoryPagedCursor(result.entries) || typeof result.release !== 'function') {
        throw fail('HISTORY_ROOT_PRODUCER_CONTRACT');
      }
      await this.touchOwner(payload, control);
      const output = await consume(result, control);
      control?.assertCurrent(); return output;
    } catch (error) { primary = error; throw error; }
    finally {
      try { result?.release?.(); }
      catch (error) { if (!primary) throw error; this.maintenanceMetrics.cleanupErrors++; }
      finally { this.cleanupStep(); unlock(); }
    }
  }
  async projectForService(sessionId, cwd, options = {}) {
    return this.withServiceRoot(sessionId, cwd, options, async (result, control) => {
      let presentation;
      const materialization = {}, dehydration = {};
      try {
        if (options.dehydrate === true) presentation = await dehydrateHistoryRoot(this.store, result.root, { control, stats: dehydration });
        const entries = await materializeHistoryCursor(presentation ? presentation.cursor() : result.entries,
          { control, stats: materialization });
        const sessionMeta = await materializeHistoryCursor(result.sessionMeta, { control });
        return { success: true, entries, sessionMeta, filePath: result.filePath,
          sourceSnapshot: result.sourceSnapshot, mode: result.mode,
          fedRecords: result.fedRecords, reusedRecords: result.reusedRecords, readMetrics: result.readMetrics,
          producerBounded: false, completeDefaultReadPlane: false,
          compatibilityMaterialization: materialization, rootedDehydration: dehydration };
      } finally { presentation?.release(); }
    });
  }
  async searchForService(sessionId, cwd, options = {}) {
    return this.withServiceRoot(sessionId, cwd, options, async (result, control) => {
      const stats = {}, searched = await searchHistoryRoot(result.entries, options, { control, stats });
      return { success: true, ...searched, rows: result.entries.length,
        sessionMeta: await materializeHistoryCursor(result.sessionMeta, { control }),
        sourceSnapshot: result.sourceSnapshot, filePath: result.filePath, searchCosts: stats,
        producerBounded: false };
    });
  }
  async payloadPageForService(payload, { control } = {}) {
    const consumerKey = 'physical-service-payload', request = {
      ...payload, toolType: 'codex', _historyRootConsumerKey: consumerKey,
    };
    let opened, primary;
    try {
      opened = await this.dispatch('openHistoryPayload', request, { control });
      if (!opened?.success) return opened;
      const cursor = this.plane.cursor(this.plane.state(opened, consumerKey), opened.payloadDocument.nodeToken);
      const exact = !!payload.expectedContentHash;
      const offset = exact ? (payload.offset ?? 0) : 0;
      const limit = exact ? (payload.limit ?? HISTORY_PAYLOAD_RENDER_CAP) : HISTORY_PAYLOAD_RENDER_CAP;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > cursor.length
        || !Number.isSafeInteger(limit) || limit < 2 || limit > HISTORY_PAYLOAD_RENDER_CAP) {
        throw fail('history_payload_range_invalid');
      }
      const small = (start, count) => { let text = ''; for (const chunk of cursor.textRange(start, count)) text += chunk; return text; };
      if (exact && offset > 0) {
        const boundary = small(offset - 1, 2);
        if (/[\uD800-\uDBFF]/.test(boundary[0] || '') && /[\uDC00-\uDFFF]/.test(boundary[1] || '')) {
          throw fail('history_payload_range_invalid');
        }
      }
      let end = Math.min(cursor.length, offset + limit);
      if (exact && end < cursor.length) {
        const boundary = small(end - 1, 2);
        if (/[\uD800-\uDBFF]/.test(boundary[0] || '') && /[\uDC00-\uDFFF]/.test(boundary[1] || '')) end--;
      }
      let text = '', chunks = 0;
      for (const chunk of cursor.textRange(offset, end - offset)) {
        control?.assertCurrent(); text += chunk;
        if (++chunks % 64 === 0) await this.checkpoint(control);
      }
      control?.assertCurrent();
      return { success: true, source: 'root', payloadId: opened.payloadId,
        payload: text, totalChars: cursor.length,
        ...(exact ? { offset, nextOffset: end < cursor.length ? end : null, truncatedForRender: false }
          : { truncatedForRender: cursor.length > HISTORY_PAYLOAD_RENDER_CAP }),
        producerBounded: false };
    } catch (error) { primary = error; throw error; }
    finally {
      if (opened?.success && opened.leaseId) {
        try { this.plane.release(opened, { consumerKey }); this.cleanupStep(); }
        catch (error) { if (!primary) throw error; this.maintenanceMetrics.cleanupErrors++; }
      }
    }
  }
  async dispatch(method, payload, options = {}) {
    if (options.installedBodyPinRoute && !this.installedBodyPinFork(method, payload)) throw fail('HISTORY_BODY_ROUTE_CHANGED');
    const positionRead = this.installedPositionRead(method, payload);
    const allocation = this.allocates(method, payload);
    if (!allocation) {
      let result;
      try {
        result = await this.dispatchOwned(method, payload, options);
        // Keep the allocating fork's original post-await consumer fence even
        // though its v2 position replacement now allocates no storage.
        if (positionRead) options.control?.assertCurrent();
        return result;
      } catch (error) {
        if (positionRead && method === 'forkHistoryRootLeaf' && result?.success) {
          try {
            const cleanup = this.rootResultCleanups?.get(result);
            if (cleanup) cleanup();
            else this.releaseResult(this.consumer(payload), { ...result, kind: 'root' });
          } catch { this.maintenanceMetrics.cleanupErrors++; }
        }
        throw error;
      }
      finally { if (method === 'releaseHistoryRoot' || payload?.operation === 'release') this.cleanupStep(); }
    }
    const textPin = this.installedTextPinFork(method, payload) || this.installedBodyPinFork(method, payload);
    let unlock;
    if (!textPin) {
      const waiting = this.maintenanceAdmission.active;
      const endWait = backingPhase('maintenance-admission', waiting);
      try { unlock = await this.maintenanceAdmission.acquire(options.control); }
      catch (error) { endWait(error); throw error; }
      endWait(null, {}, !waiting);
    }
    let result;
    try {
      if (!textPin) {
        this.ensurePlane();
        await this.initializeBacking(options.control);
        // A plain text fork pins existing immutable pages and creates no body
        // pages or canonical cache owner. Its independent lifetime must not cost
        // a complete graph traversal. Allocating operations advance the bounded
        // collector; makeRoom finishes it under pressure. Original SQLite/page,
        // journal and transaction quota checks still apply to every mutation.
        const pinOnly = method === 'forkHistoryRootLeaf'
          && [undefined, 'plain'].includes(payload?.encoding);
        if (!pinOnly) {
          this.collectBounded(64, 'allocation-collection');
          await this.makeRoom(method, payload, options.control);
        }
      }
      // No await between the installed proof and normal dispatch: forkLeaf
      // reauthenticates capacity, consumer, parent and signed node, then pins
      // synchronously under the existing SQL/journal quota transaction. The
      // worker retains lease/explicit-source edges. A proven body pin alone
      // can omit unrelated null allocation ordering; its allocation class stays.
      result = await this.dispatchOwned(method, payload, options);
      if (result?.success && ['openHistoryRoot', 'openHistoryPayload'].includes(method) && payload.readProfile !== POSITION_PROFILE) {
        await this.touchOwner(payload, options.control);
      }
      options.control?.assertCurrent(); return result;
    } catch (error) {
      // If metadata/consumer admission fails after creating a new capability,
      // the caller never receives it. Existing edit documents stay owned.
      if (result?.success && (['openHistoryRoot', 'openHistoryPayload', 'forkHistoryRootLeaf'].includes(method)
        || method === 'historyInputDocument' && payload.operation === 'prepare')) {
        const d = result.inputDocument;
        try {
          const cleanup = this.rootResultCleanups?.get(result);
          if (cleanup) cleanup();
          else this.releaseResult(this.consumer(payload), d ? { kind: 'input', ...d } : { ...result, kind: 'root' });
        } catch { this.maintenanceMetrics.cleanupErrors++; }
      }
      // A proven local quota failure is not an UNKNOWN receipt. Retire cold
      // acceleration for future caller admission, but never replay this read
      // or an edit/Send. Held transient roots remain protected by the store.
      if (this.initializedBacking && (error.code === 'HISTORY_BACKING_FULL'
        || error.code === 'SQLITE_FULL' || error.errcode === 13)) {
        try {
          // The exception covers ONLY the leaf-pin transaction. Quota recovery
          // still owns the original maintenance lane before eviction/collection;
          // do not replay the failed request or mask its error on cancellation.
          if (textPin) unlock = await this.maintenanceAdmission.acquire(null);
          if (this.evictOldest()) await this.collect();
        }
        catch { this.maintenanceMetrics.cleanupErrors++; }
      }
      throw error;
    } finally { this.cleanupStep(); unlock?.(); }
  }
  consumer(payload) {
    const key = payload?._historyRootConsumerKey;
    if (typeof key !== 'string' || !key || key.length > 128) throw fail('HISTORY_ROOT_CONSUMER');
    return key;
  }
  async physicalScope(payload, control) {
    control?.assertCurrent();
    if (payload.toolType !== 'codex' || !payload.sessionId) throw fail('HISTORY_ROOT_PROVIDER_UNSUPPORTED');
    // The negotiated reader never asks legacy lineage/recovery to construct
    // its all-events/UUID graph. Ordinary unsupported clients keep that path.
    return readCodexRootPhysicalScope({store:this.store,manager:this.service.sessionHistoryStore||this.service.promptPresentationStore,
      api:this.api,service:this.service,sessionId:payload.sessionId,cwd:payload.cwd,tabId:payload.tabId||null,
      sourceOptions:this.sourceOptions,control});
  }
  remember(retain, cleanup) { if (typeof retain === 'function') retain(cleanup); }
  retainRootCapability(plane, result, consumerKey, retain, control, releaseIdentity = result) {
    let attempted = false;
    const cleanup = () => {
      if (attempted) return; attempted = true;
      try { plane.release(releaseIdentity, { consumerKey }); }
      catch (error) { if (error.code !== 'HISTORY_ROOT_RELEASED') throw error; }
    };
    this.rootResultCleanups ||= new WeakMap();
    this.rootResultCleanups.set(result, cleanup);
    try {
      this.remember(retain, cleanup);
      control?.assertCurrent();
      // A retainer may run cleanup synchronously. Never return its dead cap.
      plane.state(result, consumerKey);
    } catch (error) {
      try { cleanup(); } catch { this.maintenanceMetrics.cleanupErrors++; }
      throw error;
    }
  }
  async dispatchOwned(method, payload, { control, retain, onUnitDiagnostic } = {}) {
    const consumerKey = this.consumer(payload);
    const plane = this.ensurePlane();
    const options = { consumerKey, control, sourceOptions: {...this.sourceOptions,projectionSchema:this.sourceSchema || 'test'}, onUnitDiagnostic };
    control?.assertCurrent();
    if (method === 'openHistoryRoot' && payload.readProfile === POSITION_PROFILE) {
      const result = plane.openPosition(payload, options);
      this.retainRootCapability(plane, result, consumerKey, retain, control);
      return result;
    }
    if (method === 'openHistoryRoot' || method === 'openHistoryPayload') {
      // Authenticate a view request before checking a potentially changed
      // lineage. A valid physical -> composite transition needs the existing
      // source route, while a forged/stale parent must remain an owner error.
      const viewParent = method === 'openHistoryRoot' && payload.primaryRequestClass === 'view'
        ? plane.primaryViewParent(payload, consumerKey) : null;
      if(payload.timelineParentLease)plane.timelineViewParent(payload,consumerKey);
      const scope = await this.physicalScope(payload, control);
      const refusal = scope?.success ? null : scope;
      try{
      if (refusal?.error === 'HISTORY_ROOT_COMPOSITE_NOT_MIGRATED' && viewParent) {
        plane.primaryViewParent(payload, consumerKey);
        return { success: false, error: 'HISTORY_PRIMARY_VIEW_RECOMPOSE_REQUIRED',
          requiredClass: 'source', reason: 'lineage-changed' };
      }
      if (refusal) return refusal;
      const result = method === 'openHistoryRoot' ? await plane.open(payload, {...options,physicalScope:scope})
        : await plane.openPayload(payload, {...options,physicalScope:scope});
      // Canonical-root is explicit: prompt/timing and virtual presentation
      // are not silently asserted to have been migrated by this new endpoint.
      const response = result?.success ? { ...result, presentationLayer:payload.readProfile==='timeline-view-v1'?'timeline-view':'canonical-root',
        completeDefaultReadPlane: false } : result;
      if (response?.success && response.leaseId) this.retainRootCapability(plane, response, consumerKey, retain, control);
      return response;
      }finally{scope?.release?.();}
    }
    if (method === 'readHistoryRootPage') {
      const result=await plane.readPage(payload,options);
      if(payload.kind==='timeline-query'&&['document','retain'].includes(payload.operation)&&result?.success&&result.leaseId!==payload.leaseId)
        this.retainRootCapability(plane,result,consumerKey,retain,control);
      return result;
    }
    if (method === 'releaseHistoryRoot') return plane.release(payload, options);
    if (method === 'forkHistoryRootLeaf') {
      const catalogRequestId = payload.encoding === 'history-primary-agent-catalog-v1' ? payload.catalogRequestId : undefined;
      const bodyRequestId = payload.encoding === 'history-entry-body-borrow-v1' ? payload.bodyRequestId : undefined;
      const result = payload.encoding === 'history-entry-body-borrow-v1'
        ? plane.forkBodyBorrow(payload, options)
        : payload.encoding === 'history-primary-agent-catalog-v1'
        ? await plane.forkAgentCatalog(payload, options)
        : payload.encoding === 'history-primary-prepared-presentation-v1'
        ? await plane.forkPreparedPresentation(payload, options)
        : payload.encoding === POSITION_QUERY_ENCODING
        ? plane.forkPositionQuery(payload, options)
        : payload.encoding === 'history-display-unit-v8-v1'
        ? await plane.forkViewUnit(payload, options)
        : payload.encoding === 'history-canonical-consumer-text-v1'
          ? await plane.forkCanonicalConsumerValue(payload, options) : plane.forkLeaf(payload, options);
      if (bodyRequestId !== undefined) {
        if (result?.kind === 'unsupported') return result;
        const releaseIdentity = Object.freeze({ leaseId: result?.leaseId, ownerKey: result?.ownerKey,
          revision: result?.revision, generation: result?.generation, bodyRequestId });
        this.retainRootCapability(plane, result, consumerKey, retain, control, releaseIdentity);
      } else if (catalogRequestId !== undefined) {
        const releaseIdentity = Object.freeze({ leaseId: result?.leaseId, ownerKey: result?.ownerKey,
          revision: result?.revision, generation: result?.generation, catalogRequestId });
        try {
          if (result?.success !== true || result.catalogRequestId !== catalogRequestId
            || plane.state(result, consumerKey).agentCatalogRequestId !== catalogRequestId) throw fail('HISTORY_AGENT_CATALOG_BINDING');
        } catch (error) {
          // Local producer/refusal cleanup uses the captured allocation ID,
          // never another receipt's ID or optional Input-document field.
          try { plane.release(releaseIdentity, { consumerKey }); }
          catch { this.maintenanceMetrics.cleanupErrors++; }
          throw error;
        }
        this.retainRootCapability(plane, result, consumerKey, retain, control, releaseIdentity);
      } else this.retainRootCapability(plane, result, consumerKey, retain, control);
      return result;
    }
    if (method === 'historyInputDocument') return this.input(payload, { ...options, retain });
    throw fail('HISTORY_ROOT_METHOD');
  }
  document(payload, consumerKey) {
    const reference = payload?.document;
    const item = this.documents.get(reference?.documentId);
    if (!item || item.consumerKey !== consumerKey) throw fail('history_input_owner_mismatch');
    const actual = item.document.descriptor();
    for (const key of ['documentId', 'ownerKey', 'sourceRevision', 'sourceGeneration']) {
      if (actual[key] !== reference[key]) throw fail('history_input_owner_mismatch');
    }
    return item;
  }
  async input(payload, { consumerKey, control, retain }) {
    const plane = this.plane, operation = payload.operation;
    if (operation === 'prepare') {
      if (this.documents.size + this.preparing >= this.maxDocuments) throw fail('history_input_document_limit');
      const source = payload.source;
      const held = plane.forkLeaf(source, { consumerKey, control });
      this.preparing++;
      let document, item, documentId, transferred = false, cleaned = false, heldReleased = false, primary;
      const releaseHeld = () => {
        if (heldReleased) return; heldReleased = true;
        try { plane.release(held, { consumerKey }); }
        catch (error) { if (!['HISTORY_ROOT_RELEASED', 'HISTORY_ROOT_PLANE_CLOSED'].includes(error.code)) throw error; }
      };
      const cleanupDocument = () => {
        if (cleaned) return; cleaned = true;
        if (documentId && this.documents.get(documentId) === item) this.documents.delete(documentId);
        document?.close();
      };
      try {
        const state = plane.state(held, consumerKey), cursor = plane.cursor(state, held.payloadDocument.nodeToken);
        const digest = createHash('sha256');
        function* chunks() {
          for (const chunk of cursor.textChunks()) { digest.update(chunk, 'utf16le'); yield chunk; }
        }
        document = await HistoryInputDocument.prepare(this.store, {
          ownerKey: held.ownerKey, sourceRevision: held.revision, sourceGeneration: held.generation,
          chunks: chunks(), signal: control?.signal,
          assertCurrent: () => { control?.assertCurrent(); plane.state(held, consumerKey); },
          schedule: control?.checkpoint ? () => control.checkpoint() : tick,
          onProgress: progress => this.onProgress({ ...progress, tabId: payload.tabId,
            preparationId: payload.preparationId, totalChars: cursor.length }),
        });
        control?.assertCurrent();
        const descriptor = document.descriptor();
        const inputDigest = { encoding: 'utf16le', sha256: digest.digest('hex'), length: cursor.length };
        control?.assertCurrent();
        documentId = descriptor.documentId; item = { document, consumerKey };
        this.documents.set(documentId, item);
        this.remember(retain, cleanupDocument);
        control?.assertCurrent();
        if (this.documents.get(documentId) !== item) throw fail('history_input_document_released');
        releaseHeld();
        control?.assertCurrent();
        const result = { success: true, inputDocument: descriptor, inputDigest, producerBounded: false };
        transferred = true; return result;
      } catch (error) { primary = error; throw error; }
      finally {
        this.preparing--;
        let cleanupFailure;
        try { releaseHeld(); } catch (error) { cleanupFailure = error; }
        try { if (!transferred) cleanupDocument(); }
        catch (error) {
          if (cleanupFailure) this.maintenanceMetrics.cleanupErrors++;
          else cleanupFailure = error;
        }
        if (cleanupFailure) {
          if (!primary) throw cleanupFailure;
          this.maintenanceMetrics.cleanupErrors++;
        }
      }
    }
    const item = this.document(payload, consumerKey), document = item.document;
    if (operation === 'release') { this.dropDocument(document.descriptor().documentId); return { success: true, released: true }; }
    if (operation === 'read') {
      const credit = payload.creditBytes ?? 3072;
      if (!Number.isSafeInteger(credit) || credit < 512 || credit > 64 * 1024) throw fail('history_input_credit');
      const header = { success: true, ...document.descriptor(), offset: payload.offset || 0,
        nextOffset: payload.offset || 0, done: false, text: '', bytes: 0, creditBytesUsed: credit };
      const available = credit - wireBytes(header) - 48;
      if (available < 6) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
      const limit = Math.min(payload.limit ?? 512, Math.floor(available / 6), this.store.pageBytes / 2);
      const result = { success: true, ...document.read({ offset: payload.offset ?? 0, limit,
        creditBytes: this.store.pageBytes, expectedRevision: payload.document.revision }), creditBytesUsed: 0 };
      for (let i = 0; i < 4; i++) result.creditBytesUsed = wireBytes(result);
      if (result.creditBytesUsed > credit) throw fail('HISTORY_ROOT_CREDIT_TOO_SMALL');
      control?.assertCurrent(); return result;
    }
    const expectedRevision = payload.document.revision;
    if (operation === 'undo' || operation === 'redo') {
      control?.assertCurrent();
      return { success: true, inputDocument: document[operation](expectedRevision) };
    }
    if (operation === 'replace') {
      if (typeof payload.text !== 'string' || payload.text.length > this.store.pageBytes / 2) throw fail('history_input_edit_credit');
      const descriptor = await document.replace({ from: payload.from, to: payload.to,
        chunks: [payload.text], expectedRevision, signal: control?.signal,
        assertCurrent: () => control?.assertCurrent(),
        schedule: control?.checkpoint ? () => control.checkpoint() : tick });
      return { success: true, inputDocument: descriptor };
    }
    throw fail('history_input_operation');
  }
  dropDocument(id) {
    const item = this.documents.get(id);
    if (!item) return;
    this.documents.delete(id); item.document.close();
  }
  releaseConsumer(consumerKey) {
    if (typeof consumerKey !== 'string') return;
    this.plane?.releaseConsumer(consumerKey);
    for (const [id, item] of this.documents) if (item.consumerKey === consumerKey) this.dropDocument(id);
    this.cleanupStep();
  }
  releaseResult(consumerKey, capability) {
    if (typeof consumerKey !== 'string' || !capability) return;
    if (capability.kind === 'root') {
      try { this.plane?.release(capability, { consumerKey }); }
      catch (error) { if (error.code !== 'HISTORY_ROOT_RELEASED') throw error; }
    } else if (capability.kind === 'input') {
      const item = this.documents.get(capability.documentId);
      if (!item || item.consumerKey !== consumerKey) return;
      const d = item.document.descriptor();
      if (['ownerKey', 'sourceRevision', 'sourceGeneration'].every(key => d[key] === capability[key])) {
        this.dropDocument(capability.documentId);
      }
    }
    this.cleanupStep();
  }
  cacheMemoryStats() { return historyRootCacheMemory(this.cache, this.store, this.cacheMemoryPlan); }
  stats() {
    let backingBytes = null;
    try { backingBytes = this.store?.diskUsage() ?? this.backingUsage().bytes; } catch {}
    const root = this.plane?.stats() || null;
    return { root, documents: this.documents.size, preparing: this.preparing, cacheMemory: this.cacheMemoryStats(),
      totalBudgetBytes: this.totalBudget, reservedRootBudgetBytes: this.ownsStore ? this.reservedRootBudget : null,
      accountedBackingBytes: backingBytes === null ? null : (this.cache.stats().diskBytes || 0) + backingBytes,
      backingStatus: this.backingError || backingBytes === null ? 'unavailable' : 'accounted',
      backingAdmissionError: this.backingError?.code || null,
      backingCoverage: 'owned-sqlite-family; SQLite-TEMP-and-existing-staging-excluded',
      maintenance: { ...this.maintenanceMetrics },
      defaultReadPlaneComplete: false, nativeMemoryMeasured: false };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.documents.keys()) this.dropDocument(id);
    this.plane?.close();
    this.rootOwner?.close();this.timelineOwner?.close();
    if (this.ownsStore) this.store?.close();
    // The owned SQL remains on disk; closing this controller does not grant
    // legacy caches that reserved space a second time.
  }
}

module.exports = { HistoryRootController, HISTORY_ROOT_METHODS: METHODS };
