'use strict';

const crypto = require('node:crypto');

const DEFAULT_MAX_TRANSITIONS = 256;
const DEFAULT_MAX_INPUTS = 256;
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_PENDING_OUTPUT_CHARS = 128 * 1024;
const DEFAULT_MAX_INPUT_CHARS = 8 * 1024;
const MAX_CHECKPOINT_IDS = 16;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function classifyInput(data) {
  const value = String(data || '');
  if (value === '\x1b[I') return 'focus-in';
  if (value === '\x1b[O') return 'focus-out';
  if (value === '\x07') return 'ctrl-g';
  if (value === '\r' || value === '\n') return 'enter';
  if (value === '\x1b') return 'escape';
  if (value === '\x03') return 'ctrl-c';
  return /^[\x00-\x1f\x7f]+$/.test(value) ? 'control' : 'text';
}

function sampleText(value, limit) {
  const text = String(value || '');
  const safeLimit = Math.max(64, Number(limit) || DEFAULT_MAX_INPUT_CHARS);
  if (text.length <= safeLimit) {
    return { text, chars: text.length, truncated: false };
  }
  const headLength = Math.ceil(safeLimit / 2);
  const tailLength = Math.floor(safeLimit / 2);
  return {
    head: text.slice(0, headLength),
    tail: text.slice(-tailLength),
    chars: text.length,
    truncated: true,
  };
}

function createPendingOutput() {
  return {
    fromSeq: null,
    toSeq: null,
    charsSeen: 0,
    charsStored: 0,
    droppedPrefixChars: 0,
    truncated: false,
    chunks: [],
  };
}

function createTerminalComposerForensics(options = {}) {
  return {
    version: 1,
    createdAt: finiteOrNull(options.createdAt) || Date.now(),
    maxTransitions: Math.max(8, Number(options.maxTransitions) || DEFAULT_MAX_TRANSITIONS),
    maxInputs: Math.max(8, Number(options.maxInputs) || DEFAULT_MAX_INPUTS),
    maxAgeMs: Math.max(60_000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS),
    maxPendingOutputChars: Math.max(
      4 * 1024,
      Number(options.maxPendingOutputChars) || DEFAULT_MAX_PENDING_OUTPUT_CHARS,
    ),
    maxInputChars: Math.max(256, Number(options.maxInputChars) || DEFAULT_MAX_INPUT_CHARS),
    transitions: [],
    inputs: [],
    pendingOutput: createPendingOutput(),
    pendingCheckpointInputIds: [],
    inputSequence: 0,
    lastComposerSignature: null,
    lastComposer: null,
    lastObservedAt: null,
  };
}

function prune(trace, now = Date.now()) {
  if (!trace) return;
  const cutoff = Number(now) - trace.maxAgeMs;
  trace.transitions = trace.transitions
    .filter((entry) => Number(entry?.at) >= cutoff)
    .slice(-trace.maxTransitions);
  trace.inputs = trace.inputs
    .filter((entry) => Number(entry?.at) >= cutoff)
    .slice(-trace.maxInputs);
  const liveInputIds = new Set(trace.inputs.map((entry) => entry.id));
  trace.pendingCheckpointInputIds = trace.pendingCheckpointInputIds
    .filter((id) => liveInputIds.has(id))
    .slice(-MAX_CHECKPOINT_IDS);
}

function trimPendingOutputToLimit(pending, limit) {
  while (pending.charsStored > limit && pending.chunks.length > 0) {
    const overflow = pending.charsStored - limit;
    const first = pending.chunks[0];
    if (first.data.length <= overflow) {
      pending.chunks.shift();
      pending.charsStored -= first.data.length;
      pending.droppedPrefixChars += first.data.length;
      continue;
    }
    first.data = first.data.slice(overflow);
    first.prefixTruncated = true;
    pending.charsStored -= overflow;
    pending.droppedPrefixChars += overflow;
  }
  pending.truncated = pending.droppedPrefixChars > 0;
}

function recordTerminalComposerOutput(trace, data, meta = {}) {
  if (!trace || data === null || data === undefined || data === '') return null;
  const text = String(data);
  const seq = finiteOrNull(meta.seq);
  const at = finiteOrNull(meta.at) || Date.now();
  const pending = trace.pendingOutput;
  if (pending.fromSeq === null) pending.fromSeq = seq;
  pending.toSeq = seq;
  pending.charsSeen += text.length;
  pending.charsStored += text.length;
  pending.chunks.push({ seq, at, data: text });
  trimPendingOutputToLimit(pending, trace.maxPendingOutputChars);
  return { seq, at, chars: text.length };
}

function recordTerminalComposerInput(trace, data, meta = {}) {
  if (!trace) return null;
  const value = String(data || '');
  const at = finiteOrNull(meta.at) || Date.now();
  const kind = String(meta.kind || classifyInput(value));
  const id = ++trace.inputSequence;
  const event = {
    id,
    at,
    kind,
    bytes: Buffer.byteLength(value, 'utf8'),
    hash: hashText(value),
    sample: sampleText(value, trace.maxInputChars),
    phase: meta.phase || null,
    origin: meta.origin || null,
    source: meta.source || null,
    operationKind: meta.operationKind || null,
    revision: finiteOrNull(meta.revision),
    terminalRunSeq: finiteOrNull(meta.terminalRunSeq),
    lifecycleGeneration: meta.lifecycleGeneration || null,
    mirrorGeneration: meta.mirrorGeneration || null,
    mirrorWriteSeq: finiteOrNull(meta.mirrorWriteSeq),
    handoffId: meta.handoffId || null,
    sendAttemptId: meta.sendAttemptId || null,
    sendOperationKey: meta.sendOperationKey || null,
  };
  trace.inputs.push(event);
  const checkpoint = meta.checkpoint === true
    || (meta.checkpoint !== false && (kind === 'enter' || kind === 'ctrl-g'));
  if (checkpoint) {
    trace.pendingCheckpointInputIds.push(id);
    trace.pendingCheckpointInputIds = trace.pendingCheckpointInputIds.slice(-MAX_CHECKPOINT_IDS);
  }
  prune(trace, at);
  return event;
}

function snapshotPendingOutput(pending) {
  if (!pending || pending.charsSeen === 0) return null;
  return {
    fromSeq: pending.fromSeq,
    toSeq: pending.toSeq,
    storedFromSeq: pending.chunks[0]?.seq ?? null,
    charsSeen: pending.charsSeen,
    charsStored: pending.charsStored,
    droppedPrefixChars: pending.droppedPrefixChars,
    truncated: pending.truncated === true,
    chunks: pending.chunks.map((chunk) => ({ ...chunk })),
  };
}

function clearPendingOutput(trace) {
  trace.pendingOutput = createPendingOutput();
}

function observationSignature(observation) {
  return hashText(JSON.stringify(observation || null));
}

function observeTerminalComposerFrame(trace, observation, meta = {}) {
  if (!trace || !observation) return null;
  const at = finiteOrNull(meta.at) || Date.now();
  prune(trace, at);
  const signature = observationSignature(observation);
  const firstObservation = trace.lastComposerSignature === null;
  const semanticChanged = trace.lastComposerSignature !== signature;
  const previousObservation = trace.lastComposer;
  const previousProofOutcome = previousObservation?.proofOutcome || null;
  const currentProofOutcome = observation?.proofOutcome || null;
  const checkpointInputIds = trace.pendingCheckpointInputIds.slice();
  const shouldRecord = semanticChanged || checkpointInputIds.length > 0;
  let event = null;
  if (shouldRecord) {
    const coalescibleTextUpdate = !firstObservation
      && semanticChanged
      && checkpointInputIds.length === 0
      && previousObservation?.provider === observation?.provider
      && previousProofOutcome === currentProofOutcome
      && (currentProofOutcome === 'found' || currentProofOutcome === 'unknown');
    event = {
      at,
      kind: firstObservation
        ? 'initial'
        : (semanticChanged ? 'transition' : 'post-input'),
      signature,
      semanticChanged,
      previousProofOutcome,
      checkpointInputIds,
      frame: {
        writeSeq: finiteOrNull(meta.writeSeq),
        flushedSeq: finiteOrNull(meta.flushedSeq),
        committedFrameGeneration: finiteOrNull(meta.committedFrameGeneration),
        rows: finiteOrNull(meta.rows),
        cols: finiteOrNull(meta.cols),
        inputRevision: finiteOrNull(meta.inputRevision),
        terminalRunSeq: finiteOrNull(meta.terminalRunSeq),
        lifecycleGeneration: meta.lifecycleGeneration || null,
        mirrorGeneration: meta.mirrorGeneration || null,
        mirrorGenerationOrdinal: finiteOrNull(meta.mirrorGenerationOrdinal),
      },
      observation,
      pty: snapshotPendingOutput(trace.pendingOutput),
      coalescibleTextUpdate,
    };
    const previousEvent = trace.transitions.at(-1) || null;
    if (coalescibleTextUpdate && previousEvent?.coalescibleTextUpdate === true) {
      event.kind = 'transition-coalesced';
      event.coalescedFromAt = previousEvent.coalescedFromAt || previousEvent.at;
      event.coalescedUpdates = Number(previousEvent.coalescedUpdates || 1) + 1;
      event.firstObservation = previousEvent.firstObservation || previousEvent.observation;
      event.firstPty = previousEvent.firstPty || previousEvent.pty;
      trace.transitions[trace.transitions.length - 1] = event;
    } else {
      if (coalescibleTextUpdate) {
        event.coalescedFromAt = at;
        event.coalescedUpdates = 1;
        event.firstObservation = observation;
        event.firstPty = event.pty;
      }
      trace.transitions.push(event);
    }
  }
  trace.lastComposerSignature = signature;
  trace.lastComposer = observation;
  trace.lastObservedAt = at;
  trace.pendingCheckpointInputIds = [];
  clearPendingOutput(trace);
  prune(trace, at);
  return event;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function snapshotTerminalComposerForensics(trace, options = {}) {
  if (!trace) return null;
  const capturedAt = finiteOrNull(options.capturedAt) || Date.now();
  prune(trace, capturedAt);
  return {
    version: trace.version,
    createdAt: trace.createdAt,
    capturedAt,
    retention: {
      maxTransitions: trace.maxTransitions,
      maxInputs: trace.maxInputs,
      maxAgeMs: trace.maxAgeMs,
      maxPendingOutputChars: trace.maxPendingOutputChars,
      maxInputChars: trace.maxInputChars,
    },
    incident: cloneJson(options.incident || null),
    transitions: cloneJson(trace.transitions),
    inputs: cloneJson(trace.inputs),
    pendingCheckpointInputIds: trace.pendingCheckpointInputIds.slice(),
    pendingOutput: cloneJson(snapshotPendingOutput(trace.pendingOutput)),
    lastComposer: cloneJson(trace.lastComposer),
    lastObservedAt: trace.lastObservedAt,
  };
}

module.exports = {
  createTerminalComposerForensics,
  observeTerminalComposerFrame,
  recordTerminalComposerInput,
  recordTerminalComposerOutput,
  snapshotTerminalComposerForensics,
};
