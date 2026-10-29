'use strict';

// Reader-owned timing preparation, over a COMPLETE immutable canonical cut.
// Source writes remain DatabaseManager.bindHistoryResponseTimingEntry's job.
// No application input, source rewrite, viewport binding or lazy DB getters.
const { createHash } = require('node:crypto');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { buildHistoryRootIndexes } = require('./history-root-indexes');
const { parseDate } = require('./history-paged-date');
const text = require('./history-paged-text');
const { normalizeHistoryResponseToolType, RESPONSE_TIMING_EDGE_SKEW_MS,
  publishHistoryResponseTimingBinding } = require('./history-response-timings');

const fail = code => Object.assign(new Error(code), { code });
const witness = row => JSON.stringify([row.intervalId, row.toolType, row.tabId, row.sessionId,
  row.startTs, row.endTs, row.durationMs, row.updatedAt]);
const normalized = value => text.trim(text.coerce(value || ''));
const truthy = value => text.isText(value) ? value.length > 0 : !!value;

function timingRow(row) {
  return { intervalId: Number(row.interval_id), toolType: row.tool_type,
    tabId: row.tab_id || null, sessionId: row.session_id || null,
    entryUuid: row.entry_uuid || null, sourceIdentity: row.source_identity || null,
    startTs: Number(row.start_ts), endTs: Number(row.end_ts),
    durationMs: Number(row.duration_ms), updatedAt: Number(row.updated_at || 0) };
}

// SQLite and the existing binding sink need actual pointer strings. This is
// an explicit, measured compatibility boundary, NOT a body conversion. A
// single arbitrary-length ID (and the SQLite row containing it) is unbounded.
function pointer(value, stats) {
  value = text.coerce(value || '');
  let out = '';
  for (const chunk of text.chunks(value)) {
    out += chunk;
    stats.maxPointerChunkChars = Math.max(stats.maxPointerChunkChars, chunk.length);
  }
  stats.pointerMaterializations++;
  stats.pointerChars += out.length;
  stats.maxPointerChars = Math.max(stats.maxPointerChars, out.length);
  return out;
}

function pendingRows(connection, index, { toolType, sessionId, tabId, control, stats }) {
  // Exactly the old ORDER BY, then identity filter, then LIMIT 100. Moving
  // LIMIT ahead of root.hasSessionId would silently miss physical sessions.
  if (!tabId && !truthy(normalized(sessionId)) && index.entries.length === 0) return [];
  const result = [];
  for (const row of connection.prepare(`
    SELECT t.*, a.start_ts, a.end_ts, a.duration_ms
    FROM history_response_timings t
    JOIN agent_activity_intervals a ON a.id = t.interval_id
    WHERE t.tool_type = ? AND t.entry_uuid IS NULL
    ORDER BY a.end_ts DESC
  `).iterate(toolType)) {
    control?.assertCurrent(); stats.pendingRowsScanned++;
    if (!(tabId && row.tab_id === tabId)
      && !(row.session_id && (text.equal(row.session_id, normalized(sessionId))
        || index.hasSessionId(row.session_id)))) continue;
    // Match the pending API's projection, even for a legacy dangling source
    // identity on a still-unbound row.
    result.push({ ...timingRow(row), entryUuid: null, sourceIdentity: null });
    if (result.length === 100) break; // closes SQL iterator before any bind/await
  }
  stats.maxPendingRows = Math.max(stats.maxPendingRows, result.length);
  return result;
}

async function targetFor(index, timing, control, stats) {
  const start = Number(timing.startTs), end = Number(timing.endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const session = normalized(timing.sessionId);
  const entries = index.arena.state().entries;
  let target = null;
  for (let ordinal = 0; ordinal < index.entries.length; ordinal++) {
    control?.assertCurrent(); stats.candidateRowsScanned++;
    const row = entries[ordinal];
    if (text.equal(row?.role, 'assistant') && truthy(row.uuid)
      && (!truthy(row.textPhase) || text.equal(row.textPhase, 'final_answer'))
      && (!session.length || text.equal(normalized(row.sessionId), session))) {
      // Use the actual parent's bounded full-content fact, never rowStub or
      // the loaded viewport. Canonical content is text; scalar coercion keeps
      // the old String(content || '').trim() behavior for finite scalar peers.
      const hasContent = text.isText(row.content)
        ? index.factsAt(ordinal).field('hasContent').scalar()
        : normalized(row.content).length > 0;
      const at = hasContent && truthy(row.timestamp) ? parseDate(row.timestamp) : NaN;
      if (Number.isFinite(at) && at >= start && at <= end + RESPONSE_TIMING_EDGE_SKEW_MS) {
        if (target !== null) { stats.ambiguousIntervals++; return null; }
        target = ordinal;
      }
    }
    if (ordinal % 32 === 31) {
      if (control?.checkpoint) await control.checkpoint();
      else await new Promise(resolve => setImmediate(resolve));
      control?.assertCurrent();
    }
  }
  return target === null ? null : entries[target];
}

// Reproduce DatabaseManager's exact revision bytes incrementally. Metadata
// rows are native SQLite pointer records, not transcript DTOs. No .all() or
// all-session UUID/ID array is hidden in revision preparation.
function timingRevision(connection, { toolType, sessionId, tabId, control, stats }) {
  const session = String(sessionId || '').trim(), tab = String(tabId || '').trim();
  let freshnessVersion = null;
  try { freshnessVersion = require('./history-freshness-metadata')
    .readHistoryTimingFreshnessVersion(connection, toolType, session, tab); }
  catch { /* same legacy/private read-only schema behavior as DatabaseManager */ }
  const filter = (alias, params) => {
    const clauses = [];
    if (session) { clauses.push(alias + '.session_id = ?'); params.push(session); }
    if (tab) { clauses.push('t.tab_id = ?'); params.push(tab); }
    return clauses.length ? 'AND (' + clauses.join(' OR ') + ')' : '';
  };
  const primary = [toolType], aliases = [toolType];
  const primaryFilter = filter('t', primary), aliasFilter = filter('x', aliases);
  const hash = createHash('sha256');
  hash.update(freshnessVersion ? '[[' : '[');
  let count = 0;
  for (const row of connection.prepare(`
    SELECT 'primary' AS projection, t.interval_id, t.session_id,
           t.entry_uuid, t.source_identity, t.updated_at
    FROM history_response_timings t WHERE t.tool_type = ? ${primaryFilter}
    UNION ALL
    SELECT 'alias' AS projection, x.interval_id, x.session_id,
           x.entry_uuid, x.source_identity, x.updated_at
    FROM history_response_timing_aliases x
    JOIN history_response_timings t ON t.interval_id = x.interval_id
    WHERE x.tool_type = ? ${aliasFilter}
    ORDER BY interval_id ASC, projection ASC
  `).iterate(...primary, ...aliases)) {
    control?.assertCurrent();
    const encoded = JSON.stringify(row);
    stats.maxRevisionRowChars = Math.max(stats.maxRevisionRowChars, encoded.length);
    if (count++) hash.update(',');
    hash.update(encoded); stats.revisionRowsScanned++;
  }
  if (!count && (!freshnessVersion || freshnessVersion.every(value => value === 0))) return 'none';
  hash.update(freshnessVersion ? '],' + JSON.stringify(freshnessVersion) + ']' : ']');
  return hash.digest('hex').slice(0, 24);
}

function captureBound(arena, index, connection, toolType, control, stats) {
  // SQL's old 800-ID chunks and native UNION order are retained, including
  // first row on equal endTs. Only this finite parameter window is native;
  // the dedupe and selected timing maps live on owned pages.
  const frame = arena.step(() => {
    const frame = arena.make('object');
    frame.seen = arena.make('map'); frame.timings = arena.make('map');
    return frame;
  });
  let ids = [];
  const flush = () => {
    if (!ids.length) return;
    stats.boundQueryChunks++; stats.maxSqlIds = Math.max(stats.maxSqlIds, ids.length);
    const placeholders = ids.map(() => '?').join(',');
    for (const raw of connection.prepare(`
      SELECT t.interval_id, t.tool_type, t.tab_id, t.session_id,
             t.entry_uuid, t.source_identity, t.updated_at,
             a.start_ts, a.end_ts, a.duration_ms
      FROM history_response_timings t
      JOIN agent_activity_intervals a ON a.id = t.interval_id
      WHERE t.tool_type = ? AND t.entry_uuid IN (${placeholders})
      UNION ALL
      SELECT x.interval_id, x.tool_type, t.tab_id, x.session_id,
             x.entry_uuid, x.source_identity, x.updated_at,
             a.start_ts, a.end_ts, a.duration_ms
      FROM history_response_timing_aliases x
      JOIN history_response_timings t ON t.interval_id = x.interval_id
      JOIN agent_activity_intervals a ON a.id = x.interval_id
      WHERE x.tool_type = ? AND x.entry_uuid IN (${placeholders})
      ORDER BY end_ts ASC
    `).iterate(toolType, ...ids, toolType, ...ids)) {
      control?.assertCurrent(); stats.boundRowsScanned++;
      const row = timingRow(raw);
      if (!row.entryUuid) continue;
      arena.step(() => {
        const prior = frame.timings.get(row.entryUuid);
        if (!prior || Number(row.endTs || 0) > Number(prior.endTs || 0)) {
          frame.timings.set(row.entryUuid, { intervalId: row.intervalId,
            startTs: row.startTs, endTs: row.endTs, durationMs: row.durationMs });
        }
      });
    }
    ids = [];
  };
  const entries = arena.state().entries;
  for (let ordinal = 0; ordinal < index.entries.length; ordinal++) {
    control?.assertCurrent();
    const uuid = normalized(entries[ordinal]?.uuid);
    if (!uuid.length || frame.seen.has(uuid)) continue;
    arena.step(() => frame.seen.set(uuid, true));
    ids.push(pointer(uuid, stats));
    if (ids.length === 800) flush();
  }
  flush();
  for (let ordinal = 0; ordinal < index.entries.length; ordinal++) {
    control?.assertCurrent();
    const entry = entries[ordinal], timing = frame.timings.get(entry?.uuid);
    if (!timing) continue;
    arena.step(() => {
      const copy = arena.assign(entry); copy.responseTiming = timing;
      entries[ordinal] = copy;
    });
    stats.decoratedRows++;
  }
}

/**
 * canonicalRoot is the full entries-array lease (source OR readonlyfile).
 * db is the caller's DatabaseManager, with its original bind method. The
 * separate owned store must not share that SQL connection/file. Returns an
 * immutable entries lease with release(), timing-only revision and stability.
 * No legacy array API fallback; no timed waits, polling or mutation retries.
 * onBound receives the owned paged target proxy, not a materialized body DTO.
 */
async function applyRootResponseTimings(store, canonicalRoot, {
  db, toolType = 'codex', sessionId = null, tabId = null, control, onBound = null,
  captureDependencies = null,
} = {}) {
  const normalizedTool = normalizeHistoryResponseToolType(toolType);
  const connection = db?.db;
  if (!normalizedTool || !connection?.prepare || !connection?.transaction
    || typeof db.bindHistoryResponseTimingEntry !== 'function') throw fail('HISTORY_ROOT_TIMING_DB_REQUIRED');
  if (store.db === connection || store.db?.native && store.db.native === connection.native
    || connection.name && store.filename === connection.name) throw fail('HISTORY_ROOT_TIMING_SEPARATE_STORE_REQUIRED');
  if (connection.inTransaction || connection.native?.isTransaction) throw fail('HISTORY_ROOT_TIMING_BIND_INSIDE_TRANSACTION');
  const stats = { pendingRowsScanned: 0, maxPendingRows: 0, candidateRowsScanned: 0,
    ambiguousIntervals: 0, bindingAttempts: 0, boundIntervals: 0, boundRowsScanned: 0,
    decoratedRows: 0, boundQueryChunks: 0, maxSqlIds: 0, revisionRowsScanned: 0,
    maxRevisionRowChars: 0, pointerMaterializations: 0, pointerChars: 0,
    maxPointerChars: 0, maxPointerChunkChars: 0, cleanupErrors: 0,
    fullBodyMaterializations: 0, completeSemanticSnapshot: false,
    globalMemoryBounded: false, nativeMemoryMeasured: false };
  let index, arena, output, primary;
  try {
    control?.assertCurrent();
    index = await buildHistoryRootIndexes(store, canonicalRoot, { control });
    const options = { toolType: normalizedTool, sessionId, tabId, control, stats };
    const pending = pendingRows(connection, index, options), observed = new Set();
    for (const timing of pending) {
      observed.add(witness(timing));
      const target = await targetFor(index, timing, control, stats);
      if (!target) continue;
      control?.assertCurrent(); stats.bindingAttempts++;
      const targetSession = truthy(target.sessionId) ? pointer(target.sessionId, stats) : null;
      const entryUuid = pointer(target.uuid, stats);
      const bound = db.bindHistoryResponseTimingEntry({ intervalId: timing.intervalId,
        toolType: normalizedTool, sessionId: targetSession || timing.sessionId || sessionId || null,
        entryUuid, sourceIdentity: truthy(target.sourceIdentity) ? pointer(target.sourceIdentity, stats) : null });
      if (bound && typeof onBound === 'function') onBound(timing, target);
      if (bound) {
        stats.boundIntervals++;
        publishHistoryResponseTimingBinding({ tabId: timing.tabId || tabId, toolType: normalizedTool,
          sessionId: targetSession || sessionId, intervalId: timing.intervalId });
        console.log('[HistoryResponseTiming] bound tool=' + normalizedTool + ' interval=' + timing.intervalId
          + ' session=' + String(targetSession || timing.sessionId || sessionId || '-').slice(0, 12)
          + ' entry=' + entryUuid.slice(0, 20) + ' start=' + timing.startTs + ' end=' + timing.endTs);
      }
    }
    arena = new HistoryProjectionArena(store, index.lease);
    // No await/source writes inside this READ cut. Freeze selected values and
    // revision together; later sidecar writes cannot change an older lease.
    const captured = connection.transaction(() => {
      const remaining = pendingRows(connection, index, options); // establishes snapshot
      captureBound(arena, index, connection, normalizedTool, control, stats);
      const token = timingRevision(connection, options);
      const dependencies = typeof captureDependencies === 'function' ? captureDependencies({ db, connection }) : undefined;
      return { token, dependencies, stable: remaining.every(row => observed.has(witness(row))) };
    })();
    control?.assertCurrent();
    output = arena.step(() => arena.publish(arena.state().entries));
    control?.assertCurrent();
    stats.ownership = Object.freeze(arena.inspectOwnership());
    let released = false;
    const result = Object.freeze({ root: output, entries: output.cursor(),
      revision: captured.stable ? captured.token : 'pending-binding:' + captured.token,
      dependencies: captured.dependencies,
      stable: captured.stable, stats: Object.freeze({ ...stats }),
      release() { if (released) return; released = true; output.release(); } });
    return result;
  } catch (error) { primary = error; throw error; }
  finally {
    let cleanupFailure;
    for (const cleanup of [() => { if (primary) output?.release(); },
      () => arena?.close(), () => index?.close()]) {
      try { cleanup(); } catch (error) { stats.cleanupErrors++; cleanupFailure ||= error; }
    }
    if (cleanupFailure && !primary) { try { output?.release(); } catch {} throw cleanupFailure; }
  }
}

// Preserve the existing preparation owner's at-most-three reconciliation
// passes. A completed pass may expose a new pending witness (e.g. row101).
// Each new pass rereads that state; a failed/UNKNOWN binding or cleanup never
// enters this loop again and is not replayed.
async function reconcileRootResponseTimings(store, canonicalRoot, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    options.control?.assertCurrent();
    const prepared = await applyRootResponseTimings(store, canonicalRoot, options);
    if (prepared.stable || attempt === 2) return Object.freeze({ ...prepared, reconciliationPasses: attempt + 1 });
    prepared.release();
  }
}
module.exports = { applyRootResponseTimings, reconcileRootResponseTimings };
