'use strict';
const { performance } = require('node:perf_hooks');
const WRITE_TRACE = Symbol.for('noted.pty.writeTrace.v1');
const receipts = new WeakMap();
const PHASES = new Set(['enqueue', 'fd-call', 'fd-callback', 'abandoned', 'dispose']);
const REASONS = new Set(['queued', 'dequeued', 'blocked-stopping', 'suppressed', 'terminal-replaced']);
const NUMBERS = ['taskId', 'fdAttempt', 'bytesTotal', 'offsetBefore', 'offsetAfter',
  'writtenBytes', 'requestedBytes', 'queueSize', 'aheadCount', 'aheadBytes'];
const ERROR_CODES = new Set(['EAGAIN', 'EIO', 'EBADF', 'EPIPE', 'ENOSPC']);

function scalarOwner(value = {}) {
  const owner = {};
  for (const key of ['tabId', 'mirrorGeneration', 'lifecycleGeneration', 'origin']) {
    if (typeof value?.[key] === 'string') owner[key] = value[key].slice(0, 256);
  }
  for (const key of ['runSeq', 'inputRevision', 'stopRevision', 'mirrorWriteSeq', 'mirrorFlushedSeq']) {
    if (Number.isFinite(value?.[key])) owner[key] = value[key];
  }
  if (typeof value?.syncOpen === 'boolean') owner.syncOpen = value.syncOpen;
  return owner;
}

// Uses the EXISTING optional node-pty trace protocol. Does not install/patch a
// dependency, replace fs.write, add a queue/retry, or infer CLI stdin consumption.
function createTerminalInputProgress({ now = () => performance.timeOrigin + performance.now(),
  log = null, identity = {} } = {}) {
  const state = { records: new Map(), sequence: 0, omittedInputs: 0, omittedTaskEvents: 0,
    omittedCallbacks: 0, omittedUnfinishedInputs: 0, invalidEvents: 0, errors: 0, reports: 0, suppressedReports: 0,
    windowStart: null, windowReports: 0, now, log, identity };
  const safe = (work, fallback = null) => { try { return work(); } catch { state.errors++; return fallback; } };
  const time = () => { const t = now(); if (!Number.isFinite(t)) throw new TypeError('clock'); return t; };
  const copy = record => ({ ...record, owner: { ...record.owner }, writeOwner: record.writeOwner && { ...record.writeOwner }, notes: record.notes.map(x => ({ ...x })),
    tasks: [...record.tasks.values()].map(task => ({ ...task, stages: Object.fromEntries(
      Object.entries(task.stages).map(([key, value]) => [key, { ...value,
        errors: { ...value.errors } }])) })) });
  state.note = (record, kind) => safe(() => {
    if (!REASONS.has(kind)) return;
    if (record.notes.length < 8) record.notes.push({ kind, at: time() });
    else record.omittedNotes++;
  });
  state.publish = (record, kind) => safe(() => {
    if (typeof log !== 'function') return;
    const t = time();
    if (state.windowStart === null || t - state.windowStart >= 60000) {
      state.windowStart = t; state.windowReports = 0;
    }
    if (state.windowReports >= 8 || record.reports >= 3) { state.suppressedReports++; return; }
    state.windowReports++; state.reports++; record.reports++;
    log({ version: 1, kind, clock: 'performance.timeOrigin+performance.now',
      units: 'chars=UTF-16; utf8Bytes=re-encoded input; task bytes from actual hook',
      input: copy(record), suppressedReports: state.suppressedReports,
      diagnosticErrors: state.errors, coverage: 'write return/callback is NOT CLI stdin/echo proof' });
  });
  state.observe = (id, event) => safe(() => {
    const record = state.records.get(id);
    if (!record) { state.omittedCallbacks++; return; }
    if (!PHASES.has(event?.phase) || !Number.isSafeInteger(event.taskId)) { state.invalidEvents++; return; }
    let task = record.tasks.get(event.taskId);
    if (!task) {
      if (record.tasks.size >= 4) { state.omittedTaskEvents++; record.omittedTaskEvents++; return; }
      task = { taskId: event.taskId, stages: {} }; record.tasks.set(event.taskId, task);
    }
    const t = time();
    const stage = task.stages[event.phase] ||= { count: 0, firstAt: t, lastAt: t, errors: {} };
    stage.count++; stage.lastAt = t;
    // Keep enqueue facts independently: later callbacks must not overwrite queue-ahead evidence.
    for (const key of NUMBERS) if (Number.isFinite(event[key])) { task[key] = event[key]; stage[key] = event[key]; }
    if (typeof event.aheadBytesComplete === 'boolean') { task.aheadBytesComplete = event.aheadBytesComplete; stage.aheadBytesComplete = event.aheadBytesComplete; }
    task.errorCode = event.errorCode == null ? null : ERROR_CODES.has(event.errorCode) ? event.errorCode : 'other';
    if (task.errorCode) stage.errors[task.errorCode] = (stage.errors[task.errorCode] || 0) + 1;
    // These are separate facts. A later dispose cannot erase an earlier complete callback.
    if (event.phase === 'fd-callback' && event.complete === true && event.errorCode == null) task.completedAt ??= t;
    if (event.phase === 'abandoned' || event.phase === 'dispose') task[event.phase + 'At'] ??= t;
    if (task.completedAt === t || event.phase === 'abandoned' || event.phase === 'dispose') state.publish(record, 'input-outbound-observed');
  });
  const api = {
    begin(data, owner = {}) { return safe(() => {
      if (typeof data !== 'string' || !data) return null;
      const id = ++state.sequence, t = Number.isFinite(owner.receivedAt) ? owner.receivedAt : time(), frozenOwner = {};
      for (const key of ['tabId', 'mirrorGeneration', 'lifecycleGeneration', 'origin']) {
        const value = owner[key] ?? identity[key];
        if (typeof value === 'string') frozenOwner[key] = value.slice(0, 256);
      }
      for (const key of ['runSeq', 'inputRevision', 'stopRevision', 'mirrorWriteSeq', 'mirrorFlushedSeq']) {
        if (Number.isFinite(owner[key])) frozenOwner[key] = owner[key];
      }
      if (typeof owner.syncOpen === 'boolean') frozenOwner.syncOpen = owner.syncOpen;
      const record = { id, receivedAt: t, chars: data.length, utf8Bytes: Buffer.byteLength(data, 'utf8'),
        bracketedPaste: data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~'),
        standaloneEnter: data === '\r' || data === '\n', owner: frozenOwner,
        ownerPhase: 'Main received; before this input revision bump', writeOwner: null,
        writesAttempted: 0, writesReturned: 0, writesThrew: 0,
        firstWriteAt: null, lastReturnAt: null, lastThrowAt: null,
        hook: 'not-checked', reports: 0, omittedNotes: 0, omittedTaskEvents: 0,
        notes: [], tasks: new Map() };
      state.records.set(id, record);
      if (state.records.size > 16) {
        const oldest = state.records.keys().next().value, removed = state.records.get(oldest);
        if (removed.writesAttempted && (!removed.tasks.size || [...removed.tasks.values()].some(task => !task.completedAt))) state.omittedUnfinishedInputs++;
        state.records.delete(oldest); state.omittedInputs++;
      }
      // A pending fd task retains only a weak state ref + id, not input/body/terminal.
      const token = { note: kind => { const current = state.records.get(id); if (current) state.note(current, kind); } };
      receipts.set(token, { state: new WeakRef(state), id });
      return token;
    }); },
    snapshot() { return safe(() => ({ version: 1, capturedAt: time(),
      limits: { inputs: 16, tasksPerInput: 4, notesPerInput: 8, reportsPerMinute: 8, reportsPerInput: 3 },
      records: [...state.records.values()].map(copy), omittedInputs: state.omittedInputs,
      omittedTaskEvents: state.omittedTaskEvents, omittedCallbacks: state.omittedCallbacks,
      omittedUnfinishedInputs: state.omittedUnfinishedInputs, invalidEvents: state.invalidEvents,
      diagnosticErrors: state.errors, reports: state.reports, suppressedReports: state.suppressedReports,
      coverage: 'Main receive and direct writes in handleTerminalInput; delegated picker/rewind writes not instrumented here' })); },
  };
  return api;
}

function writeTerminalInputObserved(token, term, data, readWriteOwner = null) {
  let state, record, stream, previousDescriptor, bound = false;
  const safe = work => { try { return work(); } catch { if (state) state.errors++; return null; } };
  safe(() => {
    const receipt = receipts.get(token);
    state = receipt?.state.deref(); record = state?.records.get(receipt.id);
    if (!record) return;
    record.writesAttempted++;
    // This ephemeral reader is NOT retained by the receipt or a pending fd task.
    // Raw typeahead may legitimately cross a run change on the same PTY.
    if (typeof readWriteOwner === 'function') safe(() => {
      const owner = readWriteOwner(); record.writeOwner = owner ? scalarOwner(owner) : null;
    });
    const t = state.now(); if (Number.isFinite(t)) record.firstWriteAt ??= t;
    stream = term?._writeStream;
    if (stream?.notedWriteTraceVersion !== 1) { record.hook = 'unavailable'; return; }
    previousDescriptor = Object.getOwnPropertyDescriptor(stream, WRITE_TRACE);
    const weak = new WeakRef(state), id = receipt.id;
    record.hook = 'binding-failed';
    Object.defineProperty(stream, WRITE_TRACE, { configurable: true, writable: true, value: {
      observe(event) { const live = weak.deref(); if (live) live.observe(id, event); },
    } });
    bound = true; record.hook = 'v1-bound';
  });
  // Never catch a diagnostic failure around the write and retry it. Exactly one
  // original call; same receiver/data/return/exception, including missing hooks.
  try {
    const result = term.write(data);
    safe(() => { if (record) { record.writesReturned++; const t = state.now(); if (Number.isFinite(t)) record.lastReturnAt = t; else state.errors++; } });
    return result;
  } catch (error) {
    safe(() => { if (record) { record.writesThrew++; const t = state.now(); if (Number.isFinite(t)) record.lastThrowAt = t; else state.errors++; } });
    throw error;
  } finally {
    safe(() => {
      if (bound) {
        if (previousDescriptor) Object.defineProperty(stream, WRITE_TRACE, previousDescriptor);
        else delete stream[WRITE_TRACE];
      }
    });
    safe(() => { if (record) state.publish(record, 'input-write-call-finished'); });
  }
}
module.exports = { createTerminalInputProgress, writeTerminalInputObserved };

// Defensive adapters for call sites. Neither getter failures nor an overridden
// diagnostic method may influence a native input path or its return/exception.
function beginTerminalInputProgress(trace, data, owner) {
  try { return trace?.inputProgress?.begin(data, owner) ?? null; }
  catch { try { trace.inputProgressHookErrors = Number(trace.inputProgressHookErrors || 0) + 1; } catch {} return null; }
}
function noteTerminalInputProgress(token, kind) { try { token?.note(kind); } catch {} }
function snapshotTerminalInputProgress(trace) {
  try { return trace?.inputProgress?.snapshot() ?? null; }
  catch { try { trace.inputProgressHookErrors = Number(trace.inputProgressHookErrors || 0) + 1; } catch {} return null; }
}
Object.assign(module.exports, { beginTerminalInputProgress, noteTerminalInputProgress, snapshotTerminalInputProgress });
