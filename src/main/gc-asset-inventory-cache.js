'use strict';

// Connection-local witnesses for the two GC inventories. The temporary
// triggers never modify the user's schema or data. A failed setup falls back to
// the original scan; a failed read never supplies a cached answer.
const crypto = require('node:crypto');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const { causal } = require('./perf-causal-context');
const trackers = new WeakMap();
const logWindows = new Map();
const sourceBoot = causal.snapshot().sourceBoot;
let diagnosticSequence = 0;
const specs = Object.freeze({
  history: { table: 'history_prompt_presentations' },
  queue: { table: 'agent_send_queue', updateWhen:
    'OLD.state IS NOT NEW.state OR OLD.asset_transfer_ids_json IS NOT NEW.asset_transfer_ids_json' +
    ' OR OLD.operation_key IS NOT NEW.operation_key OR OLD.id IS NOT NEW.id' },
});

function prepareTracker(db, kind) {
  if (db.inTransaction || !specs[kind]) return null;
  let states = trackers.get(db);
  if (!states) { states = new Map(); trackers.set(db, states); }
  if (states.has(kind)) return states.get(kind);
  const state = { disabled: false, epoch: 0, overflow: false, cached: null, probing: false, probeCalls: 0 };
  states.set(kind, state);
  const spec = specs[kind];
  // The name cannot collide with existing registered functions or temp schema.
  const prefix = '__noted_gc_' + kind + '_' + crypto.randomBytes(12).toString('hex');
  const functionName = prefix + '_dirty';
  const challenge = crypto.randomBytes(24).toString('hex');
  const proof = crypto.randomBytes(24).toString('hex');
  state.names = ['insert', 'update', 'delete'].map(event => prefix + '_' + event);
  state.probe = () => {
    const previous = state.probeCalls;
    state.probing = true;
    try {
      // SQLite may register different implementations for different arities.
      // Test the exact zero-argument call used by the trigger as well as the
      // private one-argument proof; the check itself is not a mutation.
      const zero = db.prepare('SELECT ' + functionName + '() AS proof').get()?.proof;
      return zero === 0 && state.probeCalls === previous + 1
        && db.prepare('SELECT ' + functionName + '(?) AS proof').get(challenge)?.proof === proof;
    } finally { state.probing = false; }
  };
  try {
    db.function(functionName, { varargs: true }, (...args) => {
      if (args.length === 1) return args[0] === challenge ? proof : null;
      if (args.length !== 0) return null;
      if (state.probing) { state.probeCalls++; return 0; }
      // No I/O or SQLite writes in a user statement. Even a later rollback
      // invalidates this witness, which is conservative.
      if (state.epoch < Number.MAX_SAFE_INTEGER) state.epoch++;
      else state.overflow = true;
      return 0;
    });
    db.transaction(() => {
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const name = prefix + '_' + event.toLowerCase();
        const condition = event === 'UPDATE' && spec.updateWhen ? ' WHEN ' + spec.updateWhen : '';
        db.exec('CREATE TEMP TRIGGER ' + name + ' AFTER ' + event + ' ON main.' + spec.table
          + condition + ' BEGIN SELECT ' + functionName + '(); END');
      }
    })();
    state.definitions = state.names.map(name =>
      db.prepare("SELECT sql FROM sqlite_temp_master WHERE type='trigger' AND name=?").get(name)?.sql || null);
    if (state.definitions.some(sql => !sql) || !state.probe()) throw new Error('gc_asset_witness_setup');
    state.tempSchema = db.pragma('temp.schema_version', { simple: true });
  } catch {
    state.disabled = true;
    for (const name of state.names) {
      try { db.exec('DROP TRIGGER IF EXISTS temp.' + name); } catch { /* exact scan remains the fallback */ }
    }
  }
  return state;
}

// Caller holds a transaction. An actual main-database read pins its snapshot;
// BEGIN alone does not. Cross-connection commits are observed via data_version,
// local mutations by the connection-specific trigger. No payload is logged.
function readPinned(db, kind, state, scan, admit, copy) {
  if (!state || state.disabled || state.overflow) {
    return { value: scan(), reason: state ? 'disabled' : 'transaction' };
  }
  const table = specs[kind].table;
  if (!db.prepare("SELECT rootpage FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) {
    state.cached = null;
    return { value: scan(), reason: 'missing-table' };
  }
  const tempSchema = db.pragma('temp.schema_version', { simple: true });
  if (!Number.isSafeInteger(tempSchema) || tempSchema < 0) {
    state.cached = null;
    throw new Error('gc_asset_witness_unavailable');
  }
  // TEMP schema cookies can be reused after temp_store resets, and SQLite
  // retargets a TEMP trigger on main-table rename without changing that cookie.
  // Always check the actual definitions and table bindings, not just a number.
  const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_temp_master
    WHERE (type='trigger' AND name IN (?,?,?))
       OR (type IN ('table','view') AND name=? COLLATE NOCASE)`)
    .all(...state.names, table);
  if (objects.some(object => object.type === 'table' || object.type === 'view')) {
    // The original scan is deliberately unqualified. A TEMP shadow changes
    // its meaning, and its writes are not witnessed by our main-table trigger.
    state.cached = null;
    return { value: scan(), reason: 'temp-shadow' };
  }
  const triggers = new Map(objects.map(object => [object.name, object]));
  if (state.names.some((name, index) => {
    const object = triggers.get(name);
    return !object || object.tbl_name !== table || object.sql !== state.definitions[index];
  })) {
    state.disabled = true; state.cached = null;
    return { value: scan(), reason: 'trigger-changed' };
  }
  if (tempSchema !== state.tempSchema) {
    state.tempSchema = tempSchema;
    state.cached = null;
  }
  // Function names are random and current application writers do not register
  // them. The probe also rejects replacement of a function under that name.
  let bound = false;
  try { bound = state.probe(); } catch { /* no witness: do the real scan */ }
  if (!bound) {
    state.disabled = true; state.cached = null;
    return { value: scan(), reason: 'witness-changed' };
  }
  const witness = {
    epoch: state.epoch,
    data: db.pragma('main.data_version', { simple: true }),
    schema: db.pragma('main.schema_version', { simple: true }),
    tempSchema,
  };
  if (!Number.isSafeInteger(witness.data) || witness.data < 0
    || !Number.isSafeInteger(witness.schema) || witness.schema < 0) {
    state.cached = null;
    throw new Error('gc_asset_witness_unavailable');
  }
  const old = state.cached?.witness;
  if (old && Object.keys(witness).every(key => old[key] === witness[key])) {
    return { value: copy(state.cached.value), reason: 'hit' };
  }
  const reason = !old ? 'cold'
    : old.epoch !== witness.epoch ? 'local-change'
      : old.data !== witness.data ? 'foreign-change' : 'schema-change';
  state.cached = null;
  const value = scan();
  if (!state.overflow && state.epoch === witness.epoch && admit(value)) {
    state.cached = { witness, value: copy(value) };
  }
  return { value, reason };
}

function readHistoryInventory(db, scan) {
  const state = prepareTracker(db, 'history');
  if (!state || state.disabled) return { value: scan(), reason: state ? 'disabled' : 'transaction' };
  return db.transaction(() => readPinned(db, 'history', state, scan,
    value => value.length <= 4096, value => value.slice()))();
}

// The list only contains candidate rows. Receipts, fingerprints and sidecar
// owners must still be checked anew, even on a hit.
function prepareQueueInventory(db) { return prepareTracker(db, 'queue'); }
function readQueueInventoryPinned(db, state, scan) {
  const admit = rows => {
    if (rows.length > 128) return false;
    let characters = 0;
    for (const row of rows) {
      if (typeof row.operation_key !== 'string' || typeof row.asset_transfer_ids_json !== 'string') return false;
      characters += row.operation_key.length + row.asset_transfer_ids_json.length;
      if (characters > 65536) return false;
    }
    return true;
  };
  const copy = rows => rows.map(row => ({ operation_key: row.operation_key,
    asset_transfer_ids_json: row.asset_transfer_ids_json }));
  return readPinned(db, 'queue', state, scan, admit, copy);
}

// Bounded pairs preserve a start record before materialization when admitted.
// Non-admitted operations are still counted by the existing causal work ring.
// Only fixed labels and scalar counts/memory are recorded; never rows or IDs.
function inventoryDiagnostic(site, callback) {
  const now = performance.now();
  let window = logWindows.get(site);
  if (!window || now - window.start >= 60000) {
    window = { start: now, pairs: 0, suppressed: 0, previousSuppressed: window?.suppressed || 0 };
    logWindows.set(site, window);
  }
  const log = window.pairs < 4;
  if (log) window.pairs++;
  else window.suppressed++;
  const operation = ++diagnosticSequence;
  const meta = { rows: null, ids: null, candidates: null, reason: 'unknown' };
  const emit = phase => {
    if (!log) return;
    try {
      const memory = process.memoryUsage(), limit = v8.getHeapStatistics().heap_size_limit;
      console.log('[GCAssetInventory] phase=' + phase + ' site=' + site
        + ' operation=' + operation + ' pid=' + process.pid + ' boot=' + sourceBoot
        + ' heap=' + memory.heapUsed + ' heapLimit=' + limit + ' rss=' + memory.rss
        + ' external=' + memory.external + ' rows=' + (meta.rows ?? 'unknown')
        + ' candidates=' + (meta.candidates ?? 'unknown') + ' ids=' + (meta.ids ?? 'unknown')
        + ' cache=' + meta.reason + ' coverage=4pairs-per-60s'
        + ' priorSuppressed=' + window.previousSuppressed);
    } catch { /* diagnostics cannot change the inventory outcome */ }
  };
  emit('start');
  try {
    const value = callback(meta);
    emit('end');
    return value;
  } catch (error) {
    emit('error');
    throw error;
  }
}

module.exports = { readHistoryInventory, prepareQueueInventory, readQueueInventoryPinned, inventoryDiagnostic };
