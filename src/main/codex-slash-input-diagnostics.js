'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Scalar evidence for ONE existing short-control owner. No writer, timers,
// parser, log files or global collection; the retained receipt owns its life.
const STAGES = new Set(['begin', 'paste-attempt', 'paste-returned', 'paste-threw',
  'raw-output', 'mirror-output', 'pump-flushed', 'pump-error', 'frame-committed', 'frame-blocked', 'frame-reused',
  'notify-frame', 'observer-subscribed', 'observer-wake', 'observer-unsubscribed',
  'check', 'observation-result', 'recovery-requested', 'rollback-attempt',
  'rollback-returned', 'released', 'enter-attempt', 'enter-returned', 'enter-threw',
  'outbound-unavailable', 'outbound-enqueue', 'outbound-fd-call', 'outbound-fd-callback',
  'outbound-abandoned', 'outbound-dispose',
  'mirror-disposed']);
const OUTCOMES = new Set(['begin', 'observation-result', 'released', 'enter-result', 'paste-error', 'outbound-result']);
const REASONS = new Set(['post-write-composer-unproven', 'composer-control-unavailable',
  'original-write-active', 'clear-not-confirmed', 'exact-draft-proof-unavailable',
  'draft-changed-after-slash-insert', 'owned-input-cleared', 'enter-armed',
  'terminal-instance-changed', 'terminal-stopping', 'terminal-generation-changed',
  'terminal-run-changed', 'terminal-input-changed', 'terminal-mirror-changed',
  'launch-generation-changed', 'terminal-process-stopped', 'terminal-exited',
  'synchronized-output-open', 'frame-not-flushed', 'post-resize-frame-not-observed',
  'mirror-unavailable', 'mirror-replaced', 'mirror-failed', 'mirror-incomplete',
  'flush-sequence-mismatch', 'snapshot-unavailable', 'already-committed',
  'deadline', 'owner-changed', 'send-cancelled', 'process-stopping', 'process-exited',
  'input-changed', 'read-failed', 'subscription-failed']);
const NUMBERS = ['seq', 'chars', 'items', 'writeSeq', 'flushedSeq', 'committedWriteSeq',
  'committedFrameGeneration', 'pendingResizeWriteSeq', 'waiters', 'checks', 'wakeRevision',
  'elapsedMs', 'budgetMs', 'afterWriteSeq', 'cursorRow', 'inputRevision', 'stopRevision',
  'runSeq', 'queuedChars', 'queuedItems', 'queuedBatches', 'inFlightChars', 'ordinal',
  'taskId', 'fdAttempt', 'bytesTotal', 'offsetBefore', 'offsetAfter', 'writtenBytes',
  'requestedBytes', 'queueSize', 'aheadCount', 'aheadBytes'];
const BOOLEANS = ['sameMirror', 'sameTerminal', 'sameLifecycle', 'sameLaunch', 'failed', 'disposed', 'complete',
  'synchronizedOutputOpen', 'inFlight', 'pumpFailed', 'ready', 'lateMcpProofPending',
  'runtimePolicy', 'available', 'generationMatches', 'cursorSourceMatches', 'hasDraft',
  'accepted', 'success', 'timedOut', 'outboundAvailable', 'aheadBytesComplete'];
const WRITE_KINDS = new Set(['paste', 'rollback', 'enter']);
const WRITE_ERRORS = new Set(['EAGAIN', 'EWOULDBLOCK', 'EINTR', 'EBADF', 'EIO', 'EPIPE', 'EINVAL', 'ECANCELED', 'ENXIO', 'ENOMEM']);
const WRITE_TRACE = Symbol.for('noted.pty.writeTrace.v1');
const MAX_PUBLICATIONS = 12, MAX_OUTBOUND_TASKS = 8;
const ACTIONS = new Set(['wait', 'clear', 'clear-confirmed', 'retire', 'retired']);
const STATUSES = new Set(['settled', 'unresolved', 'expired', 'superseded', 'cancelled', 'failed']);
const WAKE_SOURCES = new Set(['frame', 'owner', 'readiness', 'cancellation']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9:_/+=.-]{1,256}$/.test(value) ? value : null;

function scalars(input = {}) {
  const result = {};
  for (const key of NUMBERS) if (Number.isFinite(input[key])) result[key] = input[key];
  for (const key of BOOLEANS) if (typeof input[key] === 'boolean') result[key] = input[key];
  if (REASONS.has(input.reason)) result.reason = input.reason;
  else if (input.reason != null) result.reason = 'other';
  if (ACTIONS.has(input.action)) result.action = input.action;
  if (STATUSES.has(input.status)) result.status = input.status;
  if (WAKE_SOURCES.has(input.wakeSource)) result.wakeSource = input.wakeSource;
  if (WRITE_KINDS.has(input.writeKind)) result.writeKind = input.writeKind;
  if (input.errorCode === null) result.errorCode = null;
  else if (input.errorCode != null) result.errorCode = WRITE_ERRORS.has(input.errorCode) ? input.errorCode : 'other';
  return result;
}

function createCodexSlashInputDiagnostic({ tabId, command, operationId = null,
  identity = {}, readState = () => ({}), log = () => {},
  now = () => performance.timeOrigin + performance.now(), maxEvents = 16,
} = {}) {
  try {
    if (!['/compact', '/model', '/fast'].includes(command)) return null;
    const traceId = randomUUID();
    const startedAt = now();
    const limit = Math.max(4, Math.min(32, Math.floor(Number(maxEvents) || 16)));
    const events = [], stages = {}, outboundTasks = new Map();
    let droppedOutboundEvents = 0;
    let droppedEvents = 0, unknownStages = 0, errors = 0, publications = 0, suppressedPublications = 0;
    let lastDecision = null;
    const header = { version: 2, traceId, tabId: identifier(tabId), command,
      operationId: identifier(operationId), startedAt,
      owner: { launchId: identifier(identity.launchId),
        lifecycle: identifier(identity.terminalLifecycleGeneration),
        mirror: identifier(identity.mirrorGeneration),
        ...scalars({ runSeq: identity.terminalRunSeq, inputRevision: identity.inputRevision,
          stopRevision: identity.terminalStopRevision, afterWriteSeq: identity.mirrorWriteSeq }) } };
    const record = (stage, fields = {}) => {
      try {
        if (!STAGES.has(stage)) { unknownStages++; return; }
        const at = now(), data = scalars(fields);
        const stat = stages[stage] ||= { count: 0, firstAt: at, lastAt: at };
        stat.count++; stat.lastAt = at;
        if (Number.isFinite(data.seq)) {
          stat.firstSeq ??= data.seq; stat.lastSeq = data.seq;
        }
        if (Number.isFinite(data.chars)) stat.chars = (stat.chars || 0) + data.chars;
        // Reason/error histograms survive ring eviction; neither admits arbitrary strings.
        for (const key of ['reason', 'errorCode']) if (data[key] != null) {
          const counts = stat[key + 'Counts'] ||= {};
          counts[data[key]] = (counts[data[key]] || 0) + 1;
        }
        if (stage.startsWith('outbound-') && Number.isSafeInteger(data.taskId)) {
          let task = outboundTasks.get(data.taskId);
          if (!task && outboundTasks.size < MAX_OUTBOUND_TASKS) {
            task = { taskId: data.taskId, writeKind: data.writeKind, ordinal: data.ordinal, stages: {} };
            outboundTasks.set(data.taskId, task);
          }
          if (task) {
            const entry = task.stages[stage] ||= { count: 0, firstAt: at, lastAt: at };
            entry.count++; entry.lastAt = at; entry.last = data;
          } else droppedOutboundEvents++;
        }
        events.push({ stage, at, ...data });
        if (events.length > limit) { events.shift(); droppedEvents++; }
        if (stage === 'check' || stage === 'released') lastDecision = data;
      } catch { errors++; }
    };
    const snapshot = () => {
      let state = {};
      try { state = scalars(readState()); } catch { errors++; }
      return { ...header, capturedAt: now(), stages: Object.fromEntries(
        Object.entries(stages).map(([key, value]) => [key, { ...value,
          ...(value.reasonCounts && { reasonCounts: { ...value.reasonCounts } }),
          ...(value.errorCodeCounts && { errorCodeCounts: { ...value.errorCodeCounts } }) }])),
        outboundTasks: [...outboundTasks.values()].map(task => ({ ...task, stages: Object.fromEntries(
          Object.entries(task.stages).map(([key, value]) => [key, { ...value, last: { ...value.last } }])) })),
        events: events.map(event => ({ ...event })), lastDecision: lastDecision && { ...lastDecision }, state,
        limits: { maxEvents: limit, maxPublications: MAX_PUBLICATIONS, maxOutboundTasks: MAX_OUTBOUND_TASKS },
        droppedEvents, droppedOutboundEvents, unknownStages, diagnosticErrors: errors, publications, suppressedPublications,
        publicationBudgetExhausted: publications >= MAX_PUBLICATIONS,
        coverage: 'scoped-outbound-fd-callback-and-app-pty-to-committed-frame; no-cli-stdin-or-provider-proof' };
    };
    const diagnostic = {
      traceId,
      record,
      withWrite(term, writeKind, ordinal, write) {
        let stream, previous, installed = false;
        try {
          stream = term?._writeStream;
          if (stream?.notedWriteTraceVersion === 1 && WRITE_KINDS.has(writeKind)) {
            previous = stream[WRITE_TRACE];
            const published = new Set();
            stream[WRITE_TRACE] = { observe(event) {
              record('outbound-' + event.phase, { ...event, writeKind, ordinal });
              if (event.complete || event.phase === 'abandoned' || event.phase === 'dispose') {
                const key = event.taskId + ':' + event.phase;
                if (published.size < MAX_OUTBOUND_TASKS * 2 && !published.has(key)) {
                  published.add(key); diagnostic.publish('outbound-result');
                }
              }
            } };
            installed = true;
          } else record('outbound-unavailable', { writeKind, ordinal, outboundAvailable: false });
        } catch { errors++; record('outbound-unavailable', { writeKind, ordinal, outboundAvailable: false }); }
        // The original call still happens exactly once; a throw stays a throw.
        try { return write(); }
        finally {
          if (installed) try {
            if (previous === undefined) delete stream[WRITE_TRACE];
            else stream[WRITE_TRACE] = previous;
          } catch { errors++; }
        }
      },
      publish(outcome) {
        try {
          if (!OUTCOMES.has(outcome)) return;
          if (publications >= MAX_PUBLICATIONS) { suppressedPublications++; return; }
          publications++;
          log({ ...snapshot(), outcome });
        } catch { errors++; }
      },
      snapshot() { try { return snapshot(); } catch { errors++; return null; } },
    };
    return diagnostic;
  } catch { return null; }
}

module.exports = { createCodexSlashInputDiagnostic };
