'use strict';

const { createTraceLineReader, parseTraceEventLine } = require('./perf-trace-events');

const STAGES = new Map([
  ['GenerationToBrowserMain', 'browser-delivery'],
  ['BrowserMainToRendererCompositor', 'browser-to-renderer'],
  ['RendererCompositorQueueingDelay', 'renderer-queue'],
  ['RendererCompositorProcessing', 'renderer-compositor'],
  ['RendererCompositorToMain', 'renderer-main-delivery'],
  ['RendererMainProcessing', 'renderer-processing'],
  ['RendererMainFinishedToCommit', 'frame-production'],
  ['RendererMainFinishedToBeginImplFrame', 'frame-production'],
  ['BeginImplFrameToSendBeginMainFrame', 'frame-production'],
  ['SendBeginMainFrameToCommit', 'frame-production'],
  ['Commit', 'frame-production'], ['EndCommitToActivation', 'frame-production'],
  ['Activation', 'frame-production'], ['EndActivateToSubmitCompositorFrame', 'frame-production'],
  ['SubmitCompositorFrameToPresentationCompositorFrame', 'presentation'],
  ['SubmitToReceiveCompositorFrame', 'presentation'],
  ['ReceiveCompositorFrameToStartDraw', 'presentation'],
  ['StartDrawToSwapStart', 'presentation'], ['Swap', 'presentation'],
]);
const TYPES = new Map([
  ['MouseDown', 'MOUSE_PRESSED'], ['MouseUp', 'MOUSE_RELEASED'], ['MouseMove', 'MOUSE_MOVED'],
  ['MouseWheel', 'MOUSE_WHEEL'], ['TouchStart', 'TOUCH_PRESSED'], ['TouchMove', 'TOUCH_MOVED'],
  ['TouchEnd', 'TOUCH_RELEASED'], ['GestureScrollBegin', 'GESTURE_SCROLL_BEGIN'],
  ['GestureScrollUpdate', 'GESTURE_SCROLL_UPDATE'], ['GestureScrollEnd', 'GESTURE_SCROLL_END'],
  ['KeyDown', 'KEY_PRESSED'], ['KeyUp', 'KEY_RELEASED'],
]);
// Rejection metadata also recognizes the remaining fixed WebInputEvent names.
// This does not admit them as measured flows or retain characters/key codes.
// Chromium120 catalogue: third_party/blink/public/common/input/web_input_event.h
const NATIVE_INPUT_NAMES = Object.freeze([...TYPES.keys(), 'Undefined', 'MouseEnter', 'MouseLeave', 'ContextMenu',
  'RawKeyDown', 'Char', 'GestureFlingStart', 'GestureFlingCancel', 'GestureShowPress', 'GestureTap',
  'GestureTapUnconfirmed', 'GestureTapDown', 'GestureTapCancel', 'GestureDoubleTap', 'GestureTwoFingerTap',
  'GestureShortPress', 'GestureLongPress', 'GestureLongTap', 'GesturePinchBegin', 'GesturePinchEnd',
  'GesturePinchUpdate', 'TouchCancel', 'TouchScrollStarted', 'PointerDown', 'PointerUp', 'PointerMove',
  'PointerRawUpdate', 'PointerCancel', 'PointerCausedUaAction']);
const REJECTION_INPUT_NAMES = new Set(NATIVE_INPUT_NAMES);
const EVENT_TYPES = new Map([...TYPES].map(([type, event]) => [event, type]));
// Chromium120's EventMetrics name differs from WebInputEvent's MouseMove.
EVENT_TYPES.set('MOUSE_MOVED_EVENT', 'MouseMove');
const COMPONENTS = new Map([
  ['COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL', 'Original'],
  ['COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH', 'BrowserMain'],
  ['COMPONENT_INPUT_EVENT_LATENCY_RENDERER_MAIN', 'RendererMain'],
  ['COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN', 'RenderingScheduledMain'],
  ['COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_IMPL', 'RenderingScheduledImpl'],
  ['COMPONENT_INPUT_EVENT_LATENCY_RENDERER_SWAP', 'RendererSwap'],
  ['COMPONENT_DISPLAY_COMPOSITOR_RECEIVED_FRAME', 'DisplayReceivedFrame'],
  ['COMPONENT_INPUT_EVENT_GPU_SWAP_BUFFER', 'GpuSwapBuffer'],
  ['COMPONENT_INPUT_EVENT_LATENCY_FRAME_SWAP', 'FrameSwap'],
]);
const STEPS = new Set(['STEP_SEND_INPUT_EVENT_UI', 'STEP_HANDLE_INPUT_EVENT_IMPL',
  'STEP_DID_HANDLE_INPUT_AND_OVERSCROLL', 'STEP_HANDLE_INPUT_EVENT_MAIN',
  'STEP_HANDLED_INPUT_EVENT_MAIN_OR_IMPL', 'STEP_HANDLED_INPUT_EVENT_IMPL']);
const HANDLE = 'WebFrameWidgetImpl::HandleInputEvent';
const FORWARD = 'RenderWidgetHostImpl::ForwardWheelEvent';
const STAGE_NAMES = [...STAGES.keys()];
const CORE_STAGES = STAGE_NAMES.slice(0, 6);
const THREAD_NAMES = new Set(['CrRendererMain', 'CrBrowserMain', 'Compositor']);
const KNOWN_PHASES = new Set(['B', 'E', 'X', 'b', 'e', 'n', 's', 't', 'f', 'I', 'i', 'M', 'c', 'C', 'N', 'O', 'D', 'R', 'P', 'v', 'V']);
const MAX_U64 = (1n << 64n) - 1n;
const us = value => Number.isSafeInteger(value) && value >= 0;
const pid = value => Number.isSafeInteger(value) && value > 0;
const ms = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const cap = (value, fallback, low, high) => Number.isFinite(value) ? Math.max(low, Math.min(high, Math.floor(value))) : fallback;

// Already rounded unsafe JSON numbers cannot be repaired. Exact numeric strings
// (including Chrome hex IDs) are normalized without Number coercion.
function numericId(value) {
  if (typeof value === 'number') return us(value) ? String(value) : null;
  if (typeof value !== 'string' || !/^(?:[0-9]{1,20}|0x[0-9a-fA-F]{1,16})$/.test(value)) return null;
  const integer = BigInt(value);
  return integer <= MAX_U64 ? integer.toString() : null;
}
function interval(name, startUs, endUs, extra = {}) {
  return { name, startUs, endUs, durationMs: (endUs - startUs) / 1000, ...extra };
}

// A zero-duration core stage can be exported before the preceding sibling's
// end, or after the next sibling's begin, at the SAME timestamp. Its observed
// stack depth is then one too deep. Resolve only this boundary case after all
// pairs are validated. Never sort records, repair a missing pair, or infer the
// nesting of presentation sub-stages from their timestamps.
function restoreZeroCoreBoundaryDepths(rootInterval, intervals, zeroParents, issues) {
  if (!rootInterval || issues.size || !zeroParents.size) return 0;
  const core = [];
  let end = rootInterval.startUs;
  for (const name of CORE_STAGES) {
    const matches = intervals.filter(row => row.name === name);
    if (matches.length !== 1) return 0;
    const row = matches[0];
    if (row.startUs !== end || row.endUs < row.startUs || row.endUs > rootInterval.endUs) return 0;
    core.push(row); end = row.endUs;
  }
  const corrected = [];
  for (const row of core) {
    if (row.depth === 0) continue;
    const parent = core.find(candidate => candidate.name === zeroParents.get(row));
    if (row.depth !== 1 || row.startUs !== row.endUs || !parent || parent === row
      || parent.depth !== 0 || parent.startUs === parent.endUs
      || (row.startUs !== parent.startUs && row.startUs !== parent.endUs)) return 0;
    corrected.push(row);
  }
  for (const row of corrected) {
    row.depthFromExport = row.depth;
    row.depth = 0;
    row.depthEvidence = 'validated-core-boundary';
  }
  return corrected.length;
}

// InputLatency legacy IDs are Main-scoped; EventLatency local IDs are renderer-
// scoped and shared by nested b/e stages. Never pair by name/time alone.
function pairTrack(records, rootName) {
  const issues = new Set(), stack = [], intervals = [], seen = new Set(), zeroParents = new Map();
  let root = null, rootInterval = null, last = -1, rootCount = 0;
  for (const record of records) {
    // Every InputLatency record is a root; a different input name on the same
    // legacy track is an identity collision, never a nested dispatch stage.
    const isRoot = record.kind === 'input' || record.name === rootName;
    if (record.ts < last) issues.add('nonmonotonic');
    last = record.ts;
    if (record.ph === 'b' || record.ph === 'n') {
      if (seen.has(record.name)) issues.add('duplicate-pair');
      seen.add(record.name);
      if (isRoot) {
        rootCount++;
        if (!root) root = record;
        if (stack.length || rootCount > 1) issues.add('duplicate-root');
      } else if (!stack.length) issues.add('missing-root');
      if (record.ph === 'n') {
        // Perfetto's JSON exporter encodes a zero-duration async slice as n,
        // including a zero-duration dispatch stage. It is not an end marker.
        const measured = interval(record.name, record.ts, record.ts, { pid: record.pid,
          emitterTid: record.tid, depth: stack.length - 1, threadMs: null });
        if (isRoot) rootInterval = measured;
        else {
          const row = { ...measured, category: STAGES.get(record.name) };
          intervals.push(row);
          if (CORE_STAGES.includes(record.name) && stack.length === 2 && stack[0] === root) {
            zeroParents.set(row, stack[1].name);
          }
        }
      } else stack.push(record);
    } else {
      const begin = stack[stack.length - 1];
      if (!begin || begin.name !== record.name) { issues.add('missing-pair'); continue; }
      stack.pop();
      if (record.ts < begin.ts) { issues.add('negative-interval'); continue; }
      const measured = interval(record.name, begin.ts, record.ts, { pid: begin.pid,
        // Async stages have wall intervals, not CPU. Their tid labels the trace
        // emitter, which is often the compositor even for RendererMainProcessing.
        emitterTid: begin.tid, depth: stack.length - 1, threadMs: null });
      if (isRoot) rootInterval = measured;
      else intervals.push({ ...measured, category: STAGES.get(record.name) });
    }
  }
  if (stack.length || !root || !rootInterval) issues.add('missing-pair');
  if (rootInterval) for (const row of intervals) {
    if (row.startUs < rootInterval.startUs || row.endUs > rootInterval.endUs) issues.add('outside-root');
  }
  const sameTimestampCoreBoundaries = rootName === 'EventLatency'
    ? restoreZeroCoreBoundaryDepths(rootInterval, intervals, zeroParents, issues) : 0;
  return { root, rootInterval, intervals, issues: [...issues], sameTimestampCoreBoundaries };
}

function analyzeClock(records, markers) {
  const result = { status: 'unknown', reason: 'missing-markers', offsetLowMs: null, offsetHighMs: null,
    uncertaintyMs: null, traceRangeUs: null, markers: [], omittedMarkers: 0 };
  if (!Array.isArray(markers) || markers.length < 2) return result;
  result.omittedMarkers = Math.max(0, markers.length - 16);
  const ids = new Set();
  let low = -Infinity, high = Infinity, previousTs = -1, previousAfter = -1, origin;
  let problem = result.omittedMarkers ? 'marker-limit' : null;
  for (let index = 0; index < Math.min(16, markers.length); index++) {
    const m = markers[index], id = m?.syncId, before = m?.before, after = m?.after;
    if (typeof id !== 'string' || id.length > 128 || ids.has(id)) { problem = 'duplicate-or-invalid-marker'; continue; }
    ids.add(id);
    const matches = records.filter(r => r.kind === 'clock' && r.syncId === id);
    if (matches.length !== 1) { problem = matches.length ? 'duplicate-clock-event' : 'missing-clock-event'; continue; }
    if (!before || !after || ![before.epochMs, after.epochMs, before.now, after.now, before.timeOrigin, after.timeOrigin].every(ms)
      || before.timeOrigin !== after.timeOrigin || before.now > after.now || before.epochMs > after.epochMs
      || Math.abs(before.epochMs - (before.timeOrigin + before.now)) > 0.001
      || Math.abs(after.epochMs - (after.timeOrigin + after.now)) > 0.001
      || (origin !== undefined && origin !== before.timeOrigin)) { problem = 'invalid-clock-snapshot'; continue; }
    origin = before.timeOrigin;
    const traceUs = matches[0].ts;
    if (traceUs <= previousTs || before.epochMs < previousAfter) problem = 'nonmonotonic-clock';
    previousTs = traceUs; previousAfter = after.epochMs;
    const offsetLowMs = before.epochMs - traceUs / 1000, offsetHighMs = after.epochMs - traceUs / 1000;
    low = Math.max(low, offsetLowMs); high = Math.min(high, offsetHighMs);
    // sync IDs are used only to match exact markers; never persist arbitrary IDs.
    result.markers.push({ index, traceUs, mainBeforeAbsMs: before.epochMs, mainAfterAbsMs: after.epochMs, offsetLowMs, offsetHighMs });
  }
  if (low > high && result.markers.length > 1) { result.status = 'conflict'; result.reason = 'offset-bounds-conflict'; return result; }
  if (problem || result.markers.length < 2) { result.reason = problem || 'missing-markers'; return result; }
  return { ...result, status: 'bounded', reason: null, mainTimeOriginMs: origin, offsetLowMs: low, offsetHighMs: high,
    uncertaintyMs: high - low, traceRangeUs: [result.markers[0].traceUs, result.markers[result.markers.length - 1].traceUs] };
}

function analyzeRendererClock(relation, scope, clock) {
  const unknown = reason => ({ status: 'unknown', reason });
  if (!relation) return unknown('missing-renderer-clock-relation');
  if (relation.mainPid !== scope.mainPid || relation.rendererPid !== scope.rendererPid) return unknown('foreign-clock-relation');
  if (clock.status !== 'bounded') return unknown('main-trace-clock-unproven');
  const { mainBefore: before, mainAfter: after, renderer } = relation;
  const valid = s => s && [s.epochMs, s.now, s.timeOrigin].every(ms)
    && Math.abs(s.epochMs - (s.timeOrigin + s.now)) <= 0.001;
  if (![before, after, renderer].every(valid) || before.timeOrigin !== after.timeOrigin
    || before.timeOrigin !== clock.mainTimeOriginMs || before.now > after.now || before.epochMs > after.epochMs) return unknown('invalid-renderer-clock-relation');
  if (renderer.timeOrigin !== scope.documentTimeOriginMs) return unknown('foreign-document-clock-relation');
  const offsetLowMs = before.epochMs - renderer.epochMs, offsetHighMs = after.epochMs - renderer.epochMs;
  return { status: 'bounded', offsetLowMs, offsetHighMs, uncertaintyMs: offsetHighMs - offsetLowMs,
    rendererTimeOriginMs: renderer.timeOrigin, rendererSampleAbsMs: renderer.epochMs,
    mainBeforeAbsMs: before.epochMs, mainAfterAbsMs: after.epochMs,
    model: 'constant-offset-for-captured-document' };
}

function addClock(row, clock) {
  if (clock.status === 'bounded' && row.startUs >= clock.traceRangeUs[0] && row.endUs <= clock.traceRangeUs[1]) {
    row.startAbsBoundsMs = [row.startUs / 1000 + clock.offsetLowMs, row.startUs / 1000 + clock.offsetHighMs];
    row.endAbsBoundsMs = [row.endUs / 1000 + clock.offsetLowMs, row.endUs / 1000 + clock.offsetHighMs];
  }
  return row;
}

function bindTrigger(trigger, scope, clock, rendererClock, flows, partial, orphanTracks = []) {
  const unknown = reason => ({ status: 'unknown', reason, candidates: [] });
  if (!trigger) return { status: 'not-requested', candidates: [] };
  if (trigger.rendererPid !== scope.rendererPid) return unknown('foreign-renderer');
  if (!ms(scope.documentTimeOriginMs) || trigger.documentTimeOriginMs !== scope.documentTimeOriginMs) return unknown('foreign-or-unknown-document');
  const native = trigger.nativeOriginal;
  if (!native || !ms(native.timeStampMs)) return unknown('missing-native-original');
  const aliases = new Map([['mousedown', 'MouseDown'], ['mouseup', 'MouseUp'], ['mousemove', 'MouseMove'],
    ['wheel', 'MouseWheel'], ['keydown', 'KeyDown'], ['keyup', 'KeyUp'], ['touchstart', 'TouchStart'], ['touchmove', 'TouchMove'], ['touchend', 'TouchEnd']]);
  let type = aliases.get(native.type);
  if (native.pointerType === 'mouse') type = new Map([['pointerdown', 'MouseDown'], ['pointerup', 'MouseUp'], ['pointermove', 'MouseMove']]).get(native.type) || type;
  if (!type) return unknown('unsupported-native-type');
  if (clock.status !== 'bounded') return unknown('clock-unproven');
  if (rendererClock.status !== 'bounded') return unknown(rendererClock.reason);
  const uncertainty = native.uncertaintyMs ?? 0;
  if (!ms(uncertainty) || uncertainty > 2) return unknown('invalid-timestamp-uncertainty');
  const epoch = scope.documentTimeOriginMs + native.timeStampMs;
  if (!ms(epoch)) return unknown('invalid-native-original');
  const mainBounds = [epoch + rendererClock.offsetLowMs - uncertainty, epoch + rendererClock.offsetHighMs + uncertainty];
  const overlapsOriginal = originalUs => originalUs / 1000 + clock.offsetLowMs <= mainBounds[1]
    && originalUs / 1000 + clock.offsetHighMs >= mainBounds[0];
  const candidates = flows.filter(f => f.nativeType === type && us(f.originalUs)
    && overlapsOriginal(f.originalUs));
  const ids = candidates.map(f => f.traceId);
  // Audit every analyzed flow before output admission. The displayed identity
  // list is independently bounded; truncating it never turns many into one.
  const audit = { candidates: ids.slice(0, 16), candidateCount: ids.length, omittedCandidates: Math.max(0, ids.length - 16) };
  if (partial) return { status: 'unknown', reason: 'incomplete-evidence', ...audit };
  if (ids.length > 1 || candidates.some(f => f.issues.includes('duplicate-identity'))) return { status: 'ambiguous', reason: 'nonunique-native-original', ...audit };
  // The displayed type/original belongs to the first root. A duplicate track
  // may also contain a competing root with a different type or unknown time;
  // that first root cannot exclude the whole track from the candidate audit.
  if (flows.some(f => f.issues.some(i => i === 'duplicate-identity' || i === 'duplicate-root'))
    || orphanTracks.some(t => t.issues.some(i => i === 'duplicate-root' || i === 'duplicate-pair'))) {
    return { status: 'unknown', reason: 'incomplete-evidence', ...audit };
  }
  // An unrelated pending MouseMove or a prior EventLatency slice does not
  // remove a later key/wheel identity. This is exclusion only: an unlinked
  // root can never become a positive match by its timestamp. EventLatency's
  // start is kGenerated; InputLatency without components may use a fallback,
  // so its start alone cannot exclude a same-type candidate.
  const couldBeTrigger = (nativeType, eventOriginalUs) => (!nativeType || nativeType === type)
    && (!us(eventOriginalUs) || overlapsOriginal(eventOriginalUs));
  if (flows.some(f => !us(f.originalUs) && couldBeTrigger(f.nativeType,
    f.eventInterval && !f.issues.some(i => ['duplicate-root', 'duplicate-identity', 'nonmonotonic', 'negative-interval'].includes(i))
      ? f.eventInterval.startUs : null))
    || orphanTracks.some(t => couldBeTrigger(t.root?.nativeType,
      t.root?.name === 'EventLatency' && t.rootInterval && !t.issues.length ? t.root.ts : null))) {
    return { status: 'unknown', reason: 'incomplete-evidence', ...audit };
  }
  if (!ids.length) return { status: 'unmatched', reason: 'no-native-original-match', candidates: [] };
  if (candidates[0].coalesced !== false) return { status: candidates[0].coalesced ? 'coalesced' : 'unknown', reason: 'not-an-individual-input', ...audit };
  if (candidates[0].status !== 'measured' || !candidates[0].eventInterval?.startAbsBoundsMs
    || !candidates[0].inputInterval?.startAbsBoundsMs) return { status: 'unknown', reason: 'incomplete-native-chain-or-clock-coverage', ...audit };
  return { status: 'matched', traceId: ids[0], ...audit, nativeType: type,
    nativeOriginalRendererAbsMs: epoch, nativeOriginalMainAbsBoundsMs: mainBounds,
    uncertaintyMs: 2 * uncertainty + rendererClock.uncertaintyMs + clock.uncertaintyMs };
}

// Re-analyzable safe Chrome-shaped evidence. There is no spread of raw args or
// records: even their names/types/steps come from closed vocabularies above.
function nativeEvidence(r) {
  const e = { name: r.name, ph: r.ph || 'X', pid: r.pid, tid: r.tid, ts: r.ts };
  if (r.localId !== undefined) {
    if (r.kind === 'input') e.id = r.localId;
    else e.id2 = { local: r.localId };
  }
  if (r.end !== undefined) { e.dur = r.end - r.ts; if (r.threadUs !== null) e.tdur = r.threadUs; }
  if (r.kind === 'input' && (r.ph === 'b' || r.ph === 'n')) {
    e.args = r.traceId === undefined ? {} : { chrome_latency_info: { trace_id: r.traceId, is_coalesced: r.coalesced,
      component_info: r.components.map(c => ({ component_type: [...COMPONENTS].find(([, name]) => name === c.name)[0], time_us: c.ts })) } };
  } else if (r.kind === 'event' && r.name === 'EventLatency' && (r.ph === 'b' || r.ph === 'n')) {
    e.args = { event_latency: { ...(r.traceId === undefined ? {} : { event_latency_id: r.traceId }),
      event_type: TYPES.get(r.nativeType) || null } };
  } else if (r.kind === 'step') e.args = { chrome_latency_info: { trace_id: r.traceId, step: r.step } };
  else if (r.kind === 'native') e.args = { type: r.nativeType };
  else if (r.kind === 'forward') e.args = { hasDelta: r.hasDelta };
  return e;
}

/** Pure post-export analysis; no Tracing/IO/profiler/logger/timers or app imports.
 * Options identify the two owned processes. documentTimeOriginMs is the caller's
 * captured document scope, required only for UI trigger binding; PID alone does
 * not establish document identity. All persisted fields are projected below.
 *
 * write(Buffer|string), then finish({completeExport, dataLoss, clockMarkers,
 * rendererClockRelation?, trigger?}). finish is idempotent; late writes ignored.
 * Snapshot = {timeOrigin, now, epochMs}, all milliseconds, epochMs=origin+now.
 * clockMarkers = [{syncId, before: MainSnapshot, after: MainSnapshot}], >=2,
 * in time order, bracketing the interval; exact clock_sync IDs are mandatory.
 * rendererClockRelation = {mainPid, rendererPid, mainBefore, mainAfter, renderer}
 * with the renderer snapshot bracketed by the Main snapshots. It is a separate
 * externally obtained receipt, never inferred from matching epoch values.
 * trigger = {rendererPid, documentTimeOriginMs, nativeOriginal:{type,
 * timeStampMs, pointerType?, uncertaintyMs?}}. Pointer aliases require 'mouse'.
 * Native stage durations do not depend on the optional renderer/UI clock join.
 * Analysis defaults/maxima: 512 flows, 16384 projected records, 4MiB encoded
 * projection bytes (not V8 RSS). Output remains <=64 flows / 256KiB, with target
 * candidates first. Any analysis truncation makes candidate authority unknown.
 */
function createInputLatencyCollector({ mainPid, rendererPid, documentTimeOriginMs,
  maxInputBytes, maxCarryBytes, maxFlows, maxRecords, maxRetainedBytes, maxOutputBytes } = {}) {
  if (!pid(mainPid) || !pid(rendererPid) || mainPid === rendererPid) throw new TypeError('distinct owned Main/renderer PIDs required');
  const limits = { inputBytes: cap(maxInputBytes, 4194304, 256, 4194304), carryBytes: cap(maxCarryBytes, 65536, 64, 65536),
    flows: cap(maxFlows, 512, 1, 512), records: cap(maxRecords, 16384, 8, 16384),
    retainedBytes: cap(maxRetainedBytes, 4194304, 1024, 4194304), outputFlows: 64,
    outputBytes: cap(maxOutputBytes, 262144, 4096, 262144) };
  const scope = { mainPid, rendererPid, documentTimeOriginMs: ms(documentTimeOriginMs) ? documentTimeOriginMs : null };
  const records = [], flowIds = new Set();
  const omitted = { records: 0, flowRecords: 0, components: 0, threadRecords: 0, outputFlows: 0,
    outputNativeIntervals: 0, outputClockMarkers: 0, outputThreadRecords: 0, outputOrphanEvidence: 0,
    retainedByteRecords: 0, retainedBytes: 0 };
  const stats = { malformedLines: 0, foreignEvents: 0, wrongRoleEvents: 0, invalidIds: 0, invalidTimes: 0,
    invalidRecords: 0, unsupportedEvents: 0, unknownComponents: 0, invalidThreadTimes: 0, retainedRecords: 0, retainedBytes: 0,
    sameTimestampCoreBoundaries: 0 };
  // Rejection evidence is diagnostic only: existing qualification predicates
  // below are unchanged. Closed enums/numeric identities, never raw args/text.
  // It shares the projection/output byte budgets; native records take precedence.
  const rejected = [], rejectionCounts = Object.create(null);
  let rejectionTotal = 0, rejectionBytes = 0;
  const rejectionPriority = reason => ['foreign-pid', 'unsupported-event', 'unsupported-input-type', 'unknown-component'].includes(reason) ? 2
    : reason.endsWith('-limit') ? 1 : 0;
  function dropRejection() {
    let worst = 0;
    for (let i = 1; i < rejected.length; i++) if (rejected[i].priority > rejected[worst].priority) worst = i;
    rejectionBytes -= rejected[worst].bytes; rejected.splice(worst, 1);
  }
  function reject(reason, e, kind = 'unknown') {
    rejectionTotal++; rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    const row = { reason, kind };
    const name = e?.name;
    if (STAGES.has(name) || ['EventLatency', HANDLE, FORWARD, 'clock_sync', 'thread_name', 'LatencyInfo.Flow'].includes(name)
      || (typeof name === 'string' && name.startsWith('InputLatency::') && REJECTION_INPUT_NAMES.has(name.slice(14)))) row.name = name;
    if (KNOWN_PHASES.has(e?.ph)) row.ph = e.ph;
    if (pid(e?.pid)) row.pid = e.pid;
    if (pid(e?.tid)) row.tid = e.tid;
    if (us(e?.ts)) row.ts = e.ts;
    const localId = numericId(e?.id2?.local), id = numericId(e?.id);
    if (localId !== null) row.localId = localId;
    if (id !== null) row.id = id;
    const info = e?.args?.chrome_latency_info, eventInfo = e?.args?.event_latency;
    const traceId = numericId(info?.trace_id ?? eventInfo?.event_latency_id);
    if (traceId !== null) row.traceId = traceId;
    const type = typeof name === 'string' && name.startsWith('InputLatency::') ? name.slice(14)
      : EVENT_TYPES.get(eventInfo?.event_type) || e?.args?.type;
    if (REJECTION_INPUT_NAMES.has(type)) row.nativeType = type;
    if (Array.isArray(info?.component_info)) {
      const originals = info.component_info.slice(0, 16).filter(c => c?.component_type === 'COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL');
      if (originals.length === 1 && us(originals[0].time_us)) row.nativeOriginalUs = originals[0].time_us;
    }
    const priority = rejectionPriority(reason), bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (rejected.length >= 32 || stats.retainedBytes + rejectionBytes + bytes > limits.retainedBytes) {
      // Do not let a long run of intentional foreign/unsupported skips hide the
      // one invalid record which actually makes candidate authority unknown.
      if (rejected.some(r => r.priority > priority)) dropRejection();
    }
    if (rejected.length >= 32 || stats.retainedBytes + rejectionBytes + bytes > limits.retainedBytes) return;
    rejected.push({ row, priority, bytes }); rejectionBytes += bytes;
  }
  let result, threadRecords = 0;
  function admit(id, e, kind) {
    if (flowIds.has(id)) return true;
    if (flowIds.size >= limits.flows) { omitted.flowRecords++; reject('flow-limit', e, kind); return false; }
    flowIds.add(id); return true;
  }
  function line(text) {
    // Avoid parsing unrelated toplevel and document/script payloads at all.
    if (!text.includes('Latency') && !text.includes('clock_sync') && !text.includes('thread_name') && !text.includes(HANDLE) && !text.includes(FORWARD)
      && !STAGE_NAMES.some(name => text.includes('"' + name + '"'))) return;
    let e;
    try { e = parseTraceEventLine(text); } catch { stats.malformedLines++; reject('malformed-json'); return; }
    if (!e || typeof e !== 'object') { stats.invalidRecords++; reject('event-not-object'); return; }
    let kind, nativeType;
    if (e.name === 'thread_name') kind = 'thread';
    else if (e.name === 'clock_sync') kind = 'clock';
    else if (e.name === 'EventLatency' || STAGES.has(e.name)) kind = 'event';
    else if (typeof e.name === 'string' && e.name.startsWith('InputLatency::')) { kind = 'input'; nativeType = e.name.slice(14); }
    else if (e.name === 'LatencyInfo.Flow' && e.ph === 'X' && STEPS.has(e.args?.chrome_latency_info?.step)) kind = 'step';
    else if (e.name === HANDLE && e.ph === 'X' && TYPES.has(e.args?.type)) { kind = 'native'; nativeType = e.args.type; }
    else if (e.name === FORWARD) kind = 'forward';
    else { stats.unsupportedEvents++; reject('unsupported-event', e); return; }
    if (e.pid !== mainPid && e.pid !== rendererPid) { stats.foreignEvents++; reject('foreign-pid', e, kind); return; }
    if (((kind === 'input' || kind === 'clock' || kind === 'forward') && e.pid !== mainPid)
      || ((kind === 'event' || kind === 'native') && e.pid !== rendererPid)) { stats.wrongRoleEvents++; reject('wrong-pid-role', e, kind); return; }
    if (!us(e.ts)) { stats.invalidTimes++; reject('invalid-ts', e, kind); return; }
    if (!pid(e.tid)) { stats.invalidTimes++; reject('invalid-tid', e, kind); return; }
    if (records.length >= limits.records) { omitted.records++; reject('record-limit', e, kind); return; }
    const r = { kind, name: e.name, pid: e.pid, tid: e.tid, ts: e.ts };
    if (kind === 'thread') {
      if (e.ph !== 'M') { stats.invalidRecords++; reject('invalid-thread-phase', e, kind); return; }
      if (++threadRecords > 32) { omitted.threadRecords++; reject('thread-metadata-limit', e, kind); return; }
      r.role = THREAD_NAMES.has(e.args?.name) ? e.args.name : null;
    } else if (kind === 'clock') {
      const id = e.args?.sync_id;
      if (e.ph !== 'c') { stats.invalidRecords++; reject('invalid-clock-phase', e, kind); return; }
      if (typeof id !== 'string' || !/^[\w.:-]{1,128}$/.test(id)) { stats.invalidRecords++; reject('invalid-clock-id', e, kind); return; }
      r.syncId = id;
    } else if (kind === 'input' || kind === 'event') {
      if (!['b', 'e', 'n'].includes(e.ph)) { stats.invalidRecords++; reject('invalid-pair-phase', e, kind); return; }
      if (e.scope !== undefined && e.scope !== '') { stats.invalidRecords++; reject('unsupported-pair-scope', e, kind); return; }
      if (kind === 'input' && !TYPES.has(nativeType)) { stats.unsupportedEvents++; reject('unsupported-input-type', e, kind); return; }
      const id = numericId(kind === 'event' ? e.id2?.local : e.id);
      if (id === null) { stats.invalidIds++; reject('invalid-pair-id', e, kind); return; }
      if (kind === 'event' && e.id2?.global !== undefined) { stats.invalidIds++; reject('unsupported-global-id', e, kind); return; }
      r.localId = id; r.ph = e.ph;
      if ((e.ph === 'b' || e.ph === 'n') && (kind === 'input' || e.name === 'EventLatency')) {
        const args = kind === 'input' ? e.args?.chrome_latency_info : e.args?.event_latency;
        const rawId = kind === 'input' ? args?.trace_id : args?.event_latency_id;
        const traceId = numericId(rawId);
        // InputLatency carries its metadata at END in Chromium; an unfinished
        // slice may legitimately lack it. EventLatency's link is optional.
        // Retain that exact typed track as unlinked evidence, never invent ID.
        if (rawId !== undefined && traceId === null) { stats.invalidIds++; reject('invalid-trace-id', e, kind); return; }
        if (traceId !== null) { if (!admit(traceId, e, kind)) return; r.traceId = traceId; }
        else reject('unlinked-native-root', e, kind);
        r.nativeType = kind === 'input' ? nativeType : EVENT_TYPES.get(args?.event_type) || null;
        if (kind === 'input') {
          r.coalesced = typeof args?.is_coalesced === 'boolean' ? args.is_coalesced : null;
          r.components = []; r.componentIssues = false;
          const components = args?.component_info;
          if (!Array.isArray(components)) { r.componentIssues = true; reject('missing-components', e, kind); }
          else {
            omitted.components += Math.max(0, components.length - 16);
            if (components.length > 16) reject('component-limit', e, kind);
            const seen = new Set();
            for (const component of components.slice(0, 16)) {
              const name = COMPONENTS.get(component?.component_type);
              if (!name) { stats.unknownComponents++; reject('unknown-component', e, kind); continue; }
              if (!us(component.time_us)) { r.componentIssues = true; reject('invalid-component-time', e, kind); continue; }
              if (seen.has(name)) { r.componentIssues = true; reject('duplicate-component', e, kind); continue; }
              seen.add(name); r.components.push({ name, ts: component.time_us });
            }
          }
        }
      }
    } else {
      if (kind === 'forward') {
        // The ordinary pre-roll feeds raw Chromium records; the bounded
        // profile adapter feeds the safe boolean projection. Normalize both
        // before retaining anything. Conflicting/mixed forms remain invalid.
        const a = e.args || {};
        const projected = typeof a.hasDelta === 'boolean' && a.dx === undefined && a.dy === undefined;
        const raw = a.hasDelta === undefined && typeof a.dx === 'number' && typeof a.dy === 'number'
          && Number.isFinite(a.dx) && Number.isFinite(a.dy);
        if (e.ph !== 'X' || (!projected && !raw)) {
          stats.invalidRecords++; reject('invalid-forward-scope', e, kind); return;
        }
        r.hasDelta = projected ? a.hasDelta : a.dx !== 0 || a.dy !== 0;
      }
      if (!us(e.dur)) { stats.invalidTimes++; reject('invalid-duration', e, kind); return; }
      if (!us(e.ts + e.dur)) { stats.invalidTimes++; reject('invalid-end-time', e, kind); return; }
      r.end = e.ts + e.dur; r.threadMs = null; r.threadUs = null;
      if (e.tdur !== undefined) {
        if (us(e.tdur) && e.tdur <= e.dur + 2) { r.threadUs = e.tdur; r.threadMs = e.tdur / 1000; }
        else { stats.invalidThreadTimes++; reject('invalid-thread-duration', e, kind); }
      }
      if (kind === 'step') {
        const info = e.args.chrome_latency_info, id = numericId(info.trace_id);
        if ((info.step === 'STEP_SEND_INPUT_EVENT_UI' ? mainPid : rendererPid) !== e.pid) { stats.wrongRoleEvents++; reject('wrong-step-pid', e, kind); return; }
        if (id === null) { stats.invalidIds++; reject('invalid-trace-id', e, kind); return; }
        if (!admit(id, e, kind)) return;
        r.traceId = id; r.step = info.step;
      } else if (kind !== 'forward') r.nativeType = nativeType;
    }
    const projectedBytes = Buffer.byteLength(JSON.stringify(r));
    if (stats.retainedBytes + projectedBytes > limits.retainedBytes) {
      omitted.retainedByteRecords++; omitted.retainedBytes += projectedBytes; reject('retained-byte-limit', e, kind); return;
    }
    while (rejected.length && stats.retainedBytes + projectedBytes + rejectionBytes > limits.retainedBytes) dropRejection();
    records.push(r); stats.retainedRecords++; stats.retainedBytes += projectedBytes;
  }
  const reader = createTraceLineReader({ onLine: line, maxCarryBytes: limits.carryBytes, maxBytes: limits.inputBytes, traceEventsOnly: true });
  return {
    write: reader.write,
    finish({ completeExport = false, dataLoss, clockMarkers, rendererClockRelation, trigger } = {}) {
      if (result) return result;
      const stream = reader.finish(completeExport);
      const clock = analyzeClock(records, clockMarkers);
      const rendererClock = analyzeRendererClock(rendererClockRelation, scope, clock);
      const threadEvidence = records.filter(r => r.kind === 'thread').map(r =>
        ({ name: 'thread_name', ph: 'M', pid: r.pid, tid: r.tid, ts: r.ts, args: { name: r.role } }));
      const boundThread = r => {
        const matches = threadEvidence.filter(t => t.pid === r.pid && t.tid === r.tid);
        if (omitted.threadRecords || matches.length !== 1) return null;
        const role = matches[0].args.name;
        if (r.step === 'STEP_HANDLE_INPUT_EVENT_MAIN') return role === 'CrRendererMain' ? role : null;
        if (r.step === 'STEP_SEND_INPUT_EVENT_UI') return role === 'CrBrowserMain' ? role : null;
        return role;
      };
      const partial = !stream.completeExport || dataLoss !== false || stream.omittedBytes > 0 || stream.overlongLines > 0
        || stream.incompleteTailBytes > 0 || stats.malformedLines > 0 || stats.invalidIds > 0 || stats.invalidTimes > 0
        || stats.invalidRecords > 0 || omitted.records > 0 || omitted.flowRecords > 0 || omitted.components > 0 || omitted.retainedByteRecords > 0;
      const flows = new Map([...flowIds].map(id => [id, { traceId: id, inputs: [], events: [], steps: [], evidence: [] }]));
      const tracks = new Map(), nativeIntervals = [], orphanEvidence = [], forwardScopes = [];
      for (const r of records) {
        if (r.kind === 'input' || r.kind === 'event') {
          const key = r.kind + ':' + r.pid + ':' + r.localId;
          if (!tracks.has(key)) tracks.set(key, []);
          tracks.get(key).push(r);
        } else if (r.kind === 'step') {
          flows.get(r.traceId)?.steps.push(addClock(interval(r.step, r.ts, r.end,
            { pid: r.pid, tid: r.tid, threadMs: boundThread(r) ? r.threadMs : null,
              threadName: boundThread(r), cpuQualification: boundThread(r) ? 'exact-flow-and-thread' : 'unknown-thread', evidence: 'exact-trace-id' }), clock));
          flows.get(r.traceId)?.evidence.push(nativeEvidence(r));
        } else if (r.kind === 'forward') {
          const threads = threadEvidence.filter(t => t.pid === r.pid && t.tid === r.tid);
          const threadName = !omitted.threadRecords && threads.length === 1 ? threads[0].args.name : null;
          const scope = addClock(interval(r.name, r.ts, r.end, { pid: r.pid, tid: r.tid, hasDelta: r.hasDelta,
            threadName, threadMs: null, association: 'unbound', nativeEvidence: nativeEvidence(r) }), clock);
          forwardScopes.push(scope); nativeIntervals.push(scope);
        } else if (r.kind === 'native') nativeIntervals.push(addClock(interval(r.name, r.ts, r.end,
          { pid: r.pid, tid: r.tid, nativeType: r.nativeType, threadMs: r.threadMs, association: 'unbound', nativeEvidence: nativeEvidence(r) }), clock));
      }
      let orphanTracks = 0;
      const unlinkedTracks = [];
      for (const rows of tracks.values()) {
        const rootName = rows[0].kind === 'input' ? rows[0].name : 'EventLatency';
        const track = pairTrack(rows, rootName);
        stats.sameTimestampCoreBoundaries += track.sameTimestampCoreBoundaries;
        const owner = flows.get(track.root?.traceId);
        if (!owner) { orphanTracks++; unlinkedTracks.push(track); orphanEvidence.push(...rows.map(nativeEvidence)); continue; }
        owner[rows[0].kind === 'input' ? 'inputs' : 'events'].push(track);
        owner.evidence.push(...rows.map(nativeEvidence));
      }
      const outputFlows = [];
      for (const f of flows.values()) {
        const input = f.inputs[0], event = f.events[0], issues = new Set();
        if (f.inputs.length !== 1 || f.events.length !== 1) issues.add(f.inputs.length > 1 || f.events.length > 1 ? 'duplicate-identity' : 'missing-native-root');
        for (const track of [...f.inputs, ...f.events]) for (const issue of track.issues) issues.add(issue);
        const components = input?.root?.components || [];
        const originalUs = components.find(c => c.name === 'Original')?.ts ?? null;
        if (input?.root?.componentIssues || originalUs === null) issues.add('invalid-components');
        if (!input?.root?.nativeType || input?.root?.nativeType !== event?.root?.nativeType) issues.add('type-mismatch');
        if (originalUs !== input?.root?.ts || originalUs !== event?.root?.ts) issues.add('original-mismatch');
        // component_info is not emitted in chronological array order. Validate
        // the known semantic order, without silently sorting away bad clocks.
        const times = new Map(components.map(c => [c.name, c.ts]));
        let previous = -1;
        for (const name of ['Original', 'BrowserMain', 'RendererMain', 'RendererSwap', 'DisplayReceivedFrame', 'GpuSwapBuffer', 'FrameSwap']) {
          if (!times.has(name)) continue;
          if (times.get(name) < previous) issues.add('nonmonotonic-components');
          previous = times.get(name);
        }
        for (const c of components) if (c.ts < originalUs || (input?.rootInterval && c.ts > input.rootInterval.endUs)) issues.add('component-outside-input');
        const stages = (event?.intervals || []).map(row => addClock(row, clock));
        let coreEnd = event?.root?.ts;
        for (const name of CORE_STAGES) {
          const stage = stages.find(s => s.name === name && s.depth === 0);
          if (!stage) { issues.add('missing-core-stage'); continue; }
          if (stage.startUs !== coreEnd) issues.add('noncontiguous-core-stages');
          coreEnd = stage.endUs;
        }
        const inputInterval = input?.rootInterval ? addClock(input.rootInterval, clock) : null;
        const eventInterval = event?.rootInterval ? addClock(event.rootInterval, clock) : null;
        const mainStage = stages.find(s => s.name === 'RendererMainProcessing' && s.depth === 0);
        const stepKeys = new Set();
        for (const step of f.steps) {
          const key = [step.name, step.pid, step.tid, step.startUs, step.endUs].join(':');
          if (stepKeys.has(key)) issues.add('duplicate-native-interval');
          stepKeys.add(key);
          if (eventInterval && (step.startUs < eventInterval.startUs || step.endUs > eventInterval.endUs)) {
            // Chromium120 WidgetBaseInputHandler::HandleInputEvent stops its
            // EventMetrics monitor before the enclosing LatencyInfo.Flow scope
            // returns. An unretained EventMetrics ends EventLatency there. This
            // is not a second flow or corrupt identity. Admit only that exact
            // thread-bound enclosure, without a tolerance or a timestamp match.
            const metricsEndedInsideMain = !issues.size && mainStage
              && step.name === 'STEP_HANDLE_INPUT_EVENT_MAIN'
              && step.cpuQualification === 'exact-flow-and-thread'
              && step.threadName === 'CrRendererMain'
              && step.startUs >= eventInterval.startUs && step.startUs <= mainStage.startUs
              && mainStage.endUs <= eventInterval.endUs && eventInterval.endUs < step.endUs;
            if (metricsEndedInsideMain) {
              step.eventRootRelation = 'metrics-end-inside-main-handler';
              step.eventRootOverlapMs = (eventInterval.endUs - step.startUs) / 1000;
              step.scopeTailAfterEventMs = (step.endUs - eventInterval.endUs) / 1000;
              // threadMs still covers this ENTIRE synchronous scope. There is
              // no CPU counter at EventMetrics' end to split it into two parts.
            } else issues.add('native-interval-outside-root');
          }
        }
        if (issues.has('duplicate-identity') || issues.has('duplicate-root')
          || issues.has('duplicate-native-interval') || issues.has('native-interval-outside-root')) {
          for (const step of f.steps) { step.threadMs = null; step.cpuQualification = 'ambiguous-flow'; }
        }
        if (!stages.length) issues.add('missing-stages');
        if (partial) issues.add('incomplete-export-evidence');
        if (input?.root?.coalesced !== false) issues.add(input?.root?.coalesced ? 'coalesced' : 'coalescing-unknown');
        const status = issues.size ? (issues.has('duplicate-identity') || issues.has('duplicate-root') ? 'ambiguous' : 'partial') : 'measured';
        const largest = status === 'measured' ? stages.filter(s => s.depth === 0).reduce((best, s) => !best || s.durationMs > best.durationMs ? s : best, null) : null;
        outputFlows.push({ traceId: f.traceId, nativeType: input?.root?.nativeType ?? event?.root?.nativeType ?? null,
          status, issues: [...issues], coalesced: input?.root?.coalesced ?? null, originalUs,
          inputInterval, eventInterval, components, stages, linkedNativeIntervals: f.steps, nativeEvidence: f.evidence,
          absoluteClockStatus: inputInterval?.startAbsBoundsMs && eventInterval?.startAbsBoundsMs ? 'bounded' : 'unknown',
          largestMeasuredStage: largest ? { name: largest.name, category: largest.category, durationMs: largest.durationMs } : null });
      }
      // ForwardWheelEvent itself has no trace ID. A positive link requires a
      // bijection: exactly one containing scope AND exactly one input root in
      // that scope, on a proven CrBrowserMain thread. Inclusive boundaries
      // deliberately retain same-microsecond competitors. Never filter by
      // hasDelta to manufacture a unique DOM trigger or a phase identity.
      for (const flow of outputFlows.filter(f => f.nativeType === 'MouseWheel')) {
        const browser = flow.components.find(c => c.name === 'BrowserMain')?.ts;
        const candidates = us(browser) ? forwardScopes.filter(s => s.startUs <= browser && browser <= s.endUs) : [];
        const scope = candidates[0];
        const owners = scope ? [...flows.values()].flatMap(f => f.inputs.filter(t => {
          const stamp = t.root?.components?.find(c => c.name === 'BrowserMain')?.ts;
          return us(stamp) && scope.startUs <= stamp && stamp <= scope.endUs;
        })) : [];
        const reason = partial ? 'incomplete-export-evidence' : clock.status !== 'bounded' ? 'clock-unproven'
          : !us(browser) ? 'missing-browser-component' : flow.status !== 'measured' ? 'incomplete-flow'
          : !candidates.length ? 'missing-forward-scope' : candidates.length !== 1 ? 'nonunique-forward-scope'
          : scope.threadName !== 'CrBrowserMain' ? 'unknown-main-thread'
          : owners.length !== 1 ? 'nonunique-forward-owner' : null;
        flow.wheelForwarding = { status: reason ? (reason.startsWith('nonunique-') ? 'ambiguous' : 'unknown') : 'qualified',
          reason, candidateCount: candidates.length, omittedCandidates: Math.max(0, candidates.length - 8),
          ownerCount: owners.length, candidates: candidates.slice(0, 8) };
      }
      result = { schema: 'noted-input-latency-v1', status: !outputFlows.length ? 'unknown' : partial || outputFlows.some(f => f.status !== 'measured') || clock.status !== 'bounded' || orphanTracks ? 'partial' : 'complete',
        scope, limits, stream, dataLoss: typeof dataLoss === 'boolean' ? dataLoss : null, omitted, stats: { ...stats, orphanTracks }, clock, rendererClock, threadEvidence,
        trigger: bindTrigger(trigger, scope, clock, rendererClock, outputFlows, partial, unlinkedTracks),
        flows: [], unboundNativeIntervals: [], orphanEvidence: [],
        rejections: { total: rejectionTotal, retained: rejected.length, omitted: rejectionTotal - rejected.length,
          outputOmitted: 0, projectionBytes: rejectionBytes, counts: { ...rejectionCounts }, events: [],
          qualification: 'diagnostic-only; conservative input qualification unchanged' },
        interpretation: 'Native intervals only; nested intervals are not additive CPU. FrameSwap is not physical scanout. No JS source or root-cause inference.' };
      const priority = new Map((result.trigger.candidates || []).map((id, i) => [id, i]));
      outputFlows.sort((a, b) => (priority.get(a.traceId) ?? 16) - (priority.get(b.traceId) ?? 16)
        || (b.originalUs ?? -1) - (a.originalUs ?? -1));
      // Serialize only projected data, one bounded unit at a time. Reserve credit
      // for counters/status changes rather than repeatedly encoding the report.
      const bytes = value => Buffer.byteLength(JSON.stringify(value));
      while (bytes(result) > limits.outputBytes - 128 && clock.markers.length) {
        clock.markers.pop(); omitted.outputClockMarkers++;
      }
      while (bytes(result) > limits.outputBytes - 128 && threadEvidence.length) {
        threadEvidence.pop(); omitted.outputThreadRecords++;
      }
      if (omitted.outputClockMarkers || omitted.outputThreadRecords) {
        for (const flow of outputFlows) if (flow.wheelForwarding) {
          flow.wheelForwarding.status = 'unknown'; flow.wheelForwarding.reason = 'output-limit';
        }
      }
      let credit = limits.outputBytes - bytes(result) - 128;
      const rejectionRows = rejected.slice().sort((a, b) => a.priority - b.priority);
      const appendRejection = item => {
        const cost = bytes(item.row) + 1;
        if (cost > credit) result.rejections.outputOmitted++;
        else { result.rejections.events.push(item.row); credit -= cost; }
      };
      // Invalid evidence explains an already-unqualified interval. Preserve it
      // before old flows; routine foreign/unsupported skips cannot evict a target.
      for (const item of rejectionRows.filter(r => r.priority === 0)) appendRejection(item);
      for (const [rows, output, counter] of [[outputFlows, result.flows, 'outputFlows'],
        [nativeIntervals, result.unboundNativeIntervals, 'outputNativeIntervals'],
        [orphanEvidence, result.orphanEvidence, 'outputOrphanEvidence']]) {
        for (const row of rows) {
          const cost = bytes(row) + 1;
          if (cost > credit || (counter === 'outputFlows' && output.length >= limits.outputFlows)) { omitted[counter]++; continue; }
          output.push(row); credit -= cost;
        }
      }
      for (const item of rejectionRows.filter(r => r.priority !== 0)) appendRejection(item);
      if (omitted.outputFlows || omitted.outputNativeIntervals || omitted.outputClockMarkers || omitted.outputThreadRecords || omitted.outputOrphanEvidence) {
        result.status = 'partial';
        // A complete audit is not revoked by omitting unrelated older output.
        // A qualified target must still carry its complete native evidence and
        // clock/thread proof in this bounded result; otherwise it is unknown.
        if (result.trigger.status === 'matched' && (omitted.outputClockMarkers || omitted.outputThreadRecords
          || !result.flows.some(f => f.traceId === result.trigger.traceId))) {
          result.trigger = { status: 'unknown', reason: 'output-limit', candidates: result.trigger.candidates,
            candidateCount: result.trigger.candidateCount, omittedCandidates: result.trigger.omittedCandidates };
        }
      }
      records.length = 0; flowIds.clear(); rejected.length = 0; // no raw sync IDs retained by the collector
      return result;
    },
  };
}

module.exports = { createInputLatencyCollector, NATIVE_INPUT_NAMES };
