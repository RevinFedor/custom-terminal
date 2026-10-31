'use strict';

// Temporary diagnostic child only. No debugger/IO.read/trace-session authority.
// Callers MUST await ready, await each write, then finish with the original
// export deadline. Never replay a rejected/unknown write. closed is independent
// kernel child-close proof, not an assertion about the parent's trace ownership.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const LIMITS = Object.freeze({ chunkBytes: 65536, rawBytes: 64 * 1024 * 1024,
  events: 300000, projectedBytes: 16 * 1024 * 1024, lineBytes: 65536, heapMiB: 128 });
const fail = code => Object.assign(new Error(code), { code });
const uint = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => uint(n) && n > 0;
function bounded(n, fallback, min, max) {
  return n === undefined ? fallback : uint(n) && n >= min && n <= max ? n : (() => { throw fail('projection-invalid-limit'); })();
}
function config(o) {
  if (!positive(o.mainPid) || !positive(o.rendererPid) || o.mainPid === o.rendererPid) throw fail('projection-invalid-pids');
  if (typeof o.incidentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(o.incidentId)
    || typeof o.incidentDir !== 'string' || o.incidentDir.length > 4096 || !path.isAbsolute(o.incidentDir)
    || path.resolve(o.incidentDir) !== o.incidentDir
    || typeof o.file !== 'string' || o.file !== path.join(o.incidentDir, o.incidentId + '.trace.json')) throw fail('projection-invalid-path');
  if (!Number.isSafeInteger(o.deadlineAt) || o.deadlineAt <= Date.now() || o.deadlineAt - Date.now() > 60000) throw fail('projection-invalid-deadline');
  if (o.packagedRoot !== undefined && (typeof o.packagedRoot !== 'string' || o.packagedRoot.length > 4096 || !path.isAbsolute(o.packagedRoot))) throw fail('projection-invalid-root');
  const syncIds = o.clockSyncIds || [];
  if (!Array.isArray(syncIds) || syncIds.length > 16 || syncIds.some(s => typeof s !== 'string' || !/^[\w.:-]{1,128}$/.test(s))) throw fail('projection-invalid-clock-ids');
  return { file: o.file, incidentDir: o.incidentDir, incidentId: o.incidentId,
    mainPid: o.mainPid, rendererPid: o.rendererPid, deadlineAt: o.deadlineAt,
    packagedRoot: o.packagedRoot, clockSyncIds: syncIds,
    chunkBytes: bounded(o.chunkBytes, LIMITS.chunkBytes, 65536, 262144),
    rawBytes: bounded(o.maxRawBytes, LIMITS.rawBytes, 1, LIMITS.rawBytes),
    events: bounded(o.maxEvents, LIMITS.events, 1, LIMITS.events),
    projectedBytes: bounded(o.maxProjectedBytes, LIMITS.projectedBytes, 8192, LIMITS.projectedBytes) };
}
function createTraceProjectionWriter(options) {
  const c = config(options), parentStarted = process.hrtime.bigint();
  let state = 'starting', pending, seq = 0, rawBytes = 0, finalPromise, terminalError, resultAcknowledged = false;
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((a, b) => { resolveReady = a; rejectReady = b; });
  ready.catch(() => {});
  const closed = new Promise(a => { resolveClosed = a; });
  // Deliberately do not inherit NODE_OPTIONS, preloaders, inspector flags, app
  // secrets, stdio or a second model/runtime. Electron uses its Node entrypoint.
  const child = fork(__filename, ['--trace-projection-worker'], { execArgv: ['--max-old-space-size=128'],
    env: { ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const timer = setTimeout(() => terminate('projection-deadline'), Math.max(1, c.deadlineAt - Date.now()));
  timer.unref();
  function rejectAll(code) {
    terminalError ||= fail(code); rejectReady(terminalError);
    if (pending) { const p = pending; pending = null; p.reject(terminalError); }
  }
  function terminate(code) {
    if (state === 'closed') return;
    state = 'stopping'; rejectAll(code);
    // Only our exact fork handle is signalled. No detached/process-tree kill.
    child.kill('SIGKILL');
  }
  function send(message) {
    try { child.send(message, err => { if (err) terminate('projection-ipc-unknown'); }); }
    catch { terminate('projection-ipc-unknown'); }
  }
  child.on('error', () => terminate('projection-child-error'));
  child.on('disconnect', () => { if (!['stopping', 'closed'].includes(state)) terminate('projection-ipc-unknown'); });
  child.on('message', m => {
    if (!m || state === 'closed') return;
    if (m.type === 'ready' && state === 'starting') {
      state = 'ready'; resolveReady({ pid: child.pid, chunkBytes: c.chunkBytes, limits: LIMITS }); return;
    }
    if (m.type === 'error') { terminate('projection-worker-failed'); return; }
    if (!pending || m.seq !== pending.seq || !['ack', 'result'].includes(m.type)) { terminate('projection-ack-unknown'); return; }
    const p = pending; pending = null;
    if (m.type !== p.expected) { p.reject(fail('projection-ack-unknown')); terminate('projection-ack-unknown'); return; }
    if (m.type === 'result') resultAcknowledged = true;
    state = m.type === 'result' ? 'stopping' : 'ready'; p.resolve(m.value);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer); state = 'closed';
    if (!resultAcknowledged) rejectAll('projection-child-closed');
    resolveClosed({ closed: true, pid: child.pid, code, signal, acknowledged: resultAcknowledged && !terminalError,
      // close confirms OS exit and IPC/stdout closure, not successful export.
      source: 'owned-child-close' });
  });
  function request(type, payload, expected) {
    if (state !== 'ready') return Promise.reject(fail(pending ? 'projection-credit-exhausted' : 'projection-not-ready'));
    state = type === 'finish' ? 'finishing' : 'writing';
    return new Promise((resolve, reject) => { pending = { seq: ++seq, expected, resolve, reject }; send({ type, seq, ...payload }); });
  }
  send({ type: 'init', config: c });
  return {
    ready, closed, pid: child.pid,
    write(chunk) {
      if (state !== 'ready') return Promise.reject(fail(pending ? 'projection-credit-exhausted' : 'projection-not-ready'));
      if (!(Buffer.isBuffer(chunk) || typeof chunk === 'string')) return Promise.reject(fail('projection-invalid-chunk'));
      if (typeof chunk === 'string' && chunk.length > c.chunkBytes) return Promise.reject(fail('projection-chunk-limit'));
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (size > c.chunkBytes) return Promise.reject(fail('projection-chunk-limit'));
      if (rawBytes + size > c.rawBytes) return Promise.reject(fail('projection-raw-limit'));
      // Copy at admission: caller mutation after write cannot change the packet.
      const data = Buffer.from(chunk); rawBytes += size;
      return request('chunk', { data }, 'ack');
    },
    finish({ completeExport = false, dataLoss = false } = {}) {
      if (finalPromise) return finalPromise;
      if (state !== 'ready') return Promise.reject(fail('projection-not-ready'));
      finalPromise = request('finish', { completeExport: completeExport === true, dataLoss: dataLoss === true }, 'result')
        .then(async result => { const proof = await closed;
          if (!proof.acknowledged || proof.code !== 0 || proof.signal) throw fail('projection-close-unconfirmed');
          return { ...result, parentLifetimeMs: Number(process.hrtime.bigint() - parentStarted) / 1e6, closed: proof }; });
      return finalPromise;
    },
    abort() { terminate('projection-aborted'); return closed; },
  };
}

const STAGES = new Set(`GenerationToBrowserMain BrowserMainToRendererCompositor RendererCompositorQueueingDelay RendererCompositorProcessing RendererCompositorToMain RendererMainProcessing RendererMainFinishedToCommit RendererMainFinishedToBeginImplFrame BeginImplFrameToSendBeginMainFrame SendBeginMainFrameToCommit Commit EndCommitToActivation Activation EndActivateToSubmitCompositorFrame SubmitCompositorFrameToPresentationCompositorFrame SubmitToReceiveCompositorFrame ReceiveCompositorFrameToStartDraw StartDrawToSwapStart Swap`.split(' '));
const TYPES = new Set(require('./perf-input-latency').NATIVE_INPUT_NAMES);
// Exact Chromium120.0.6099.291 producer vocabulary, including the first update
// of a scroll. Preserve it even when the native collector cannot qualify that
// gesture type; never turn missing metadata into a different input identity.
// cc/metrics/event_latency_tracing_recorder.cc; ui/latency/latency_info.cc.
const EVENT_TYPES = new Set('MOUSE_PRESSED MOUSE_RELEASED MOUSE_MOVED MOUSE_MOVED_EVENT MOUSE_DRAGGED MOUSE_WHEEL TOUCH_PRESSED TOUCH_MOVED TOUCH_RELEASED GESTURE_SCROLL_BEGIN GESTURE_SCROLL_UPDATE GESTURE_SCROLL_END FIRST_GESTURE_SCROLL_UPDATE INERTIAL_GESTURE_SCROLL_UPDATE GESTURE_DOUBLE_TAP GESTURE_LONG_PRESS GESTURE_LONG_TAP GESTURE_SHOW_PRESS GESTURE_TAP GESTURE_TAP_CANCEL GESTURE_TAP_DOWN GESTURE_TAP_UNCONFIRMED GESTURE_TWO_FINGER_TAP GESTURE_PINCH_BEGIN GESTURE_PINCH_END GESTURE_PINCH_UPDATE KEY_PRESSED KEY_RELEASED'.split(' '));
const COMPONENTS = new Set(`COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL COMPONENT_INPUT_EVENT_LATENCY_SCROLL_UPDATE_ORIGINAL COMPONENT_INPUT_EVENT_LATENCY_FIRST_SCROLL_UPDATE_ORIGINAL COMPONENT_INPUT_EVENT_LATENCY_UI COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH COMPONENT_INPUT_EVENT_LATENCY_RENDERER_MAIN COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_IMPL COMPONENT_INPUT_EVENT_LATENCY_RENDERER_SWAP COMPONENT_DISPLAY_COMPOSITOR_RECEIVED_FRAME COMPONENT_INPUT_EVENT_GPU_SWAP_BUFFER COMPONENT_INPUT_EVENT_LATENCY_FRAME_SWAP COMPONENT_UNSPECIFIED`.split(' '));
const STEPS = new Set('STEP_SEND_INPUT_EVENT_UI STEP_HANDLE_INPUT_EVENT_IMPL STEP_DID_HANDLE_INPUT_AND_OVERSCROLL STEP_HANDLE_INPUT_EVENT_MAIN STEP_HANDLED_INPUT_EVENT_MAIN_OR_IMPL STEP_HANDLED_INPUT_EVENT_IMPL'.split(' '));
const THREADS = new Set(['CrBrowserMain', 'CrRendererMain', 'Compositor']);
const ENGINE = new Set('RunTask ThreadControllerImpl::RunTask FunctionCall EventDispatch UpdateLayoutTree Layout PrePaint Paint Layerize RasterTask MinorGC MajorGC'.split(' '));
// Fixed observed Chromium120 vocabulary, NOT a runtime prefix wildcard.
const GC = new Set('V8.GCFinalizeMC V8.GCIncrementalMarking V8.GCIncrementalMarkingStart V8.GCPhantomHandleProcessingCallback V8.GCScavenger V8.GC_BACKGROUND_FULL_ARRAY_BUFFER_SWEEP V8.GC_BACKGROUND_SAFEPOINT V8.GC_BACKGROUND_UNPARK V8.GC_HEAP_EMBEDDER_TRACING_EPILOGUE V8.GC_HEAP_EPILOGUE V8.GC_HEAP_EPILOGUE_REDUCE_NEW_SPACE V8.GC_HEAP_EPILOGUE_SAFEPOINT V8.GC_HEAP_EXTERNAL_EPILOGUE V8.GC_HEAP_EXTERNAL_PROLOGUE V8.GC_HEAP_EXTERNAL_SECOND_PASS_CALLBACKS V8.GC_HEAP_EXTERNAL_WEAK_GLOBAL_HANDLES V8.GC_HEAP_PROLOGUE V8.GC_HEAP_PROLOGUE_SAFEPOINT V8.GC_MARK_COMPACTOR V8.GC_MC_BACKGROUND_EVACUATE_COPY V8.GC_MC_BACKGROUND_EVACUATE_UPDATE_POINTERS V8.GC_MC_BACKGROUND_MARKING V8.GC_MC_BACKGROUND_SWEEPING V8.GC_MC_CLEAR V8.GC_MC_CLEAR_EXTERNAL_STRING_TABLE V8.GC_MC_CLEAR_FLUSHABLE_BYTECODE V8.GC_MC_CLEAR_FLUSHED_JS_FUNCTIONS V8.GC_MC_CLEAR_JOIN_JOB V8.GC_MC_CLEAR_MAPS V8.GC_MC_CLEAR_STRING_FORWARDING_TABLE V8.GC_MC_CLEAR_STRING_TABLE V8.GC_MC_CLEAR_WEAK_COLLECTIONS V8.GC_MC_CLEAR_WEAK_GLOBAL_HANDLES V8.GC_MC_CLEAR_WEAK_LISTS V8.GC_MC_CLEAR_WEAK_REFERENCES V8.GC_MC_COMPLETE_SWEEPING V8.GC_MC_COMPLETE_SWEEP_ARRAY_BUFFERS V8.GC_MC_EPILOGUE V8.GC_MC_EVACUATE V8.GC_MC_EVACUATE_CLEAN_UP V8.GC_MC_EVACUATE_COPY V8.GC_MC_EVACUATE_COPY_PARALLEL V8.GC_MC_EVACUATE_EPILOGUE V8.GC_MC_EVACUATE_PROLOGUE V8.GC_MC_EVACUATE_REBALANCE V8.GC_MC_EVACUATE_UPDATE_POINTERS V8.GC_MC_EVACUATE_UPDATE_POINTERS_CLIENT_HEAPS V8.GC_MC_EVACUATE_UPDATE_POINTERS_PARALLEL V8.GC_MC_EVACUATE_UPDATE_POINTERS_SLOTS_MAIN V8.GC_MC_EVACUATE_UPDATE_POINTERS_TO_NEW_ROOTS V8.GC_MC_EVACUATE_UPDATE_POINTERS_WEAK V8.GC_MC_FINISH V8.GC_MC_FINISH_SWEEP_ARRAY_BUFFERS V8.GC_MC_INCREMENTAL V8.GC_MC_INCREMENTAL_EMBEDDER_TRACING V8.GC_MC_INCREMENTAL_EXTERNAL_EPILOGUE V8.GC_MC_INCREMENTAL_EXTERNAL_PROLOGUE V8.GC_MC_INCREMENTAL_START V8.GC_MC_MARK V8.GC_MC_MARK_CLIENT_HEAPS V8.GC_MC_MARK_EMBEDDER_PROLOGUE V8.GC_MC_MARK_EMBEDDER_TRACING V8.GC_MC_MARK_FINISH_INCREMENTAL V8.GC_MC_MARK_FULL_CLOSURE V8.GC_MC_MARK_FULL_CLOSURE_PARALLEL V8.GC_MC_MARK_FULL_CLOSURE_PARALLEL_JOIN V8.GC_MC_MARK_RETAIN_MAPS V8.GC_MC_MARK_ROOTS V8.GC_MC_MARK_WEAK_CLOSURE_EPHEMERON_MARKING V8.GC_MC_PROLOGUE V8.GC_MC_SWEEP V8.GC_MC_SWEEP_CODE_POINTER_TABLE V8.GC_MC_SWEEP_EXTERNAL_POINTER_TABLE V8.GC_MC_SWEEP_NEW_LO V8.GC_MC_SWEEP_START_JOBS V8.GC_MINOR_MS_FINISH_SWEEP_ARRAY_BUFFERS V8.GC_SCAVENGER V8.GC_SCAVENGER_BACKGROUND_SCAVENGE_PARALLEL V8.GC_SCAVENGER_COMPLETE_SWEEP_ARRAY_BUFFERS V8.GC_SCAVENGER_FREE_REMEMBERED_SET V8.GC_SCAVENGER_SCAVENGE V8.GC_SCAVENGER_SCAVENGE_FINALIZE V8.GC_SCAVENGER_SCAVENGE_PARALLEL V8.GC_SCAVENGER_SCAVENGE_PARALLEL_PHASE V8.GC_SCAVENGER_SCAVENGE_ROOTS V8.GC_SCAVENGER_SCAVENGE_UPDATE_REFS V8.GC_SCAVENGER_SCAVENGE_WEAK_GLOBAL_HANDLES_IDENTIFY V8.GC_SCAVENGER_SCAVENGE_WEAK_GLOBAL_HANDLES_PROCESS V8.GC_SCAVENGER_SWEEP_ARRAY_BUFFERS V8.GC_TIME_TO_SAFEPOINT'.split(' '));
const CATEGORIES = new Set('__metadata toplevel devtools.timeline disabled-by-default-devtools.timeline v8 disabled-by-default-v8.gc blink cc input input.scrolling latencyInfo benchmark rail'.split(' '));
const PHASES = new Set('B E X b e n s t f I i M c C N O D R P v V'.split(' '));
const DISPATCH = new Set('click auxclick dblclick mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave wheel keydown keyup input beforeinput change scroll pointerdown pointerup pointermove touchstart touchmove touchend focus blur'.split(' '));
const HANDLE = 'WebFrameWidgetImpl::HandleInputEvent';
const FORWARD = 'RenderWidgetHostImpl::ForwardWheelEvent';
// Source122 audit: these exact records are not consumed by the native collector.
// This is not a prefix exemption; future names/steps still count as unknown loss.
const IGNORED_INPUT_NAMES = new Set(['InputRouterImpl::FilterAndSendWebInputEvent',
  'InputEventSentBlocking', 'InputEventSentNonBlocking',
  'WidgetInputHandlerManager::DidHandleInputEventSentToCompositor',
  'WidgetInputHandlerManager::DidHandleInputEventSentToMain',
  'WebCoalescedInputEvent::CoalesceWith', 'TranslateAndScaleWebInputEvent']);
const IGNORED_FLOW_STEPS = new Set(['STEP_SWAP_BUFFERS', 'STEP_DRAW_AND_SWAP', 'STEP_HANDLE_INPUT_EVENT_MAIN_COMMIT']);
const NATIVE_NAMES = new Set([...STAGES, ...[...TYPES].map(t => 'InputLatency::' + t),
  'EventLatency', HANDLE, FORWARD, 'LatencyInfo.Flow', 'clock_sync', 'thread_name']);
const SAFE_SHAPE_NAMES = new Set([...NATIVE_NAMES, ...ENGINE, ...GC, ...IGNORED_INPUT_NAMES]);

// Diagnostic vocabulary is closed. In particular, syntactically valid category
// strings and field names can contain user data: never persist unlisted tokens.
function categoryShape(cat) {
  if (cat === undefined) return 'absent';
  if (typeof cat !== 'string') return 'non-string';
  if (cat.length > 256) return 'too-long';
  if (!/^[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*$/.test(cat)) return 'invalid-syntax';
  return cat.split(',').every(v => CATEGORIES.has(v)) ? 'allowlisted' : 'unlisted-token';
}
function rejectShape(stats, e, reason, field = 'none') {
  const s = stats.rejectShapes;
  s.total++;
  s.reasons[reason] = (s.reasons[reason] || 0) + 1;
  const row = { name: SAFE_SHAPE_NAMES.has(e?.name) ? e.name : 'unlisted', reason, field,
    category: categoryShape(e?.cat), count: 1 };
  const previous = s.entries.find(r => r.name === row.name && r.reason === reason && r.field === field && r.category === row.category);
  if (previous) { previous.count++; return; }
  // Reserve growth of the occurrence count as well as the serialized row.
  const bytes = Buffer.byteLength(JSON.stringify(row)) + 16;
  if (s.entries.length >= 24 || s.reservedBytes + bytes > 4096) { s.omitted++; return; }
  s.reservedBytes += bytes; s.entries.push(row);
}

// Keep the native value, with explicit runtime qualification. Standalone Node
// documents KiB. Electron's normalization is not qualified by the one observed
// value: every Electron runtime retains an unknown unit, without rescaling.
function describeTraceMaxRss(maxRss, { platform = process.platform, node = process.versions.node,
  electron = process.versions.electron } = {}) {
  const version = v => typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]{1,40})?$/.test(v) ? v : null;
  const runtime = { platform: ['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix'].includes(platform) ? platform : 'unknown',
    node: version(node), electron: version(electron) };
  const unit = electron === undefined && runtime.node ? 'KiB' : 'unknown';
  return { maxRss: uint(maxRss) ? maxRss : null, maxRssUnit: unit,
    maxRssSource: 'process.resourceUsage.maxRSS', runtime };
}
function numericId(v) {
  if (uint(v)) return v;
  if (typeof v === 'string' && /^(?:[0-9]{1,20}|0x[0-9a-fA-F]{1,16})$/.test(v) && BigInt(v) <= ((1n << 64n) - 1n)) return v;
  return undefined;
}
function safeCodeUrl(value, root) {
  if (!root || typeof value !== 'string' || value.length > 2048 || /[?#\x00-\x1f]/.test(value)) return undefined;
  let p;
  try { p = value.startsWith('file:') ? fileURLToPath(value) : value; } catch { return undefined; }
  if (/[?#\x00-\x1f]/.test(p) || !path.isAbsolute(p) || path.normalize(p) !== p || !p.startsWith(root + path.sep)
    || !/\.(?:[cm]?js|tsx?)$/.test(p)) return undefined;
  // Keep code identity relative to the parent-proven packaged root; no host path.
  return 'file://' + p;
}
function project(e, c, stats) {
  const input = e?.name === 'EventLatency' || STAGES.has(e?.name) || e?.name === HANDLE || e?.name === FORWARD
    || e?.name === 'LatencyInfo.Flow' || (typeof e?.name === 'string' && e.name.startsWith('InputLatency::'));
  const lost = () => { if (input) stats.inputLossRecords++; return null; };
  if (!e || typeof e !== 'object' || Array.isArray(e)) return lost();
  if (e.pid !== c.mainPid && e.pid !== c.rendererPid) { stats.omitted.foreignPid++; return null; }
  const known = input && (!e.name.startsWith('InputLatency::') || TYPES.has(e.name.slice(14)))
    || ENGINE.has(e.name) || GC.has(e.name) || e.name === 'thread_name' || e.name === 'clock_sync';
  if (!known) {
    stats.omitted.name++;
    if (IGNORED_INPUT_NAMES.has(e.name)) {
      stats.intentionalFiltered.names++; rejectShape(stats, e, 'known-unconsumed-name'); return null;
    }
    rejectShape(stats, e, 'unlisted-name');
    if (!input && typeof e.name === 'string' && /Latency|InputEvent/.test(e.name)) stats.inputLossRecords++;
    return lost();
  }
  if (!positive(e.tid) || !uint(e.ts) || !PHASES.has(e.ph)) {
    stats.omitted.invalid++; rejectShape(stats, e, 'invalid-envelope', !positive(e.tid) ? 'tid' : !uint(e.ts) ? 'ts' : 'ph'); return lost();
  }
  const out = { name: e.name, ph: e.ph, pid: e.pid, tid: e.tid, ts: e.ts };
  if (e.cat !== undefined) {
    if (typeof e.cat !== 'string' || e.cat.length > 256 || !e.cat.split(',').every(v => CATEGORIES.has(v))) {
      stats.omitted.category++; rejectShape(stats, e, 'unsupported-category', 'cat'); return lost();
    }
    out.cat = e.cat;
  }
  for (const key of ['dur', 'tts', 'tdur']) if (e[key] !== undefined) {
    if (!uint(e[key])) { stats.omitted.invalid++; rejectShape(stats, e, 'invalid-time', key); return lost(); } out[key] = e[key];
  }
  for (const key of ['id', 'bind_id']) if (e[key] !== undefined) {
    const id = numericId(e[key]); if (id === undefined) { stats.omitted.invalid++; rejectShape(stats, e, 'invalid-id', key); return lost(); } out[key] = id;
  }
  if (e.id2 !== undefined) {
    out.id2 = {};
    for (const key of ['local', 'global']) if (e.id2?.[key] !== undefined) {
      const id = numericId(e.id2[key]); if (id === undefined) { stats.omitted.invalid++; rejectShape(stats, e, 'invalid-id', 'id2.' + key); return lost(); } out.id2[key] = id;
    }
  }
  if (e.scope !== undefined) { if (e.scope !== '') { stats.omitted.invalid++; rejectShape(stats, e, 'unsupported-scope', 'scope'); return lost(); } out.scope = ''; }
  if (['t', 'p', 'g'].includes(e.s)) out.s = e.s;
  for (const key of ['flow_in', 'flow_out']) if (typeof e[key] === 'boolean') out[key] = e[key];
  const a = e.args || {}; out.args = {};
  let unsafeInput = false, ignoredStep = false;
  const unsafe = (reason, field) => { unsafeInput = true; rejectShape(stats, e, reason, field); };
  if (e.name === 'thread_name') {
    // Unknown roles remain explicit null records: dropping a conflicting
    // rename would let an earlier known role become a false unique binding.
    out.args.name = THREADS.has(a.name) ? a.name : null;
    if (out.args.name === null) stats.omitted.thread++;
  } else if (e.name === 'clock_sync') {
    if (!c.clockSyncIds.includes(a.sync_id)) { stats.omitted.clock++; stats.inputLossRecords++; rejectShape(stats, e, 'unproven-clock-id', 'args.sync_id'); return null; } out.args.sync_id = a.sync_id;
  } else if (e.name === 'EventLatency') {
    if (a.event_latency !== undefined) {
      const v = a.event_latency, b = out.args.event_latency = {};
      if (v?.event_latency_id !== undefined) { b.event_latency_id = numericId(v.event_latency_id); if (b.event_latency_id === undefined) unsafe('invalid-id', 'args.event_latency.event_latency_id'); }
      if (v?.event_type !== undefined) { if (EVENT_TYPES.has(v.event_type)) b.event_type = v.event_type; else unsafe('unlisted-input-type', 'args.event_latency.event_type'); }
      for (const key of ['has_high_latency', 'is_janky_scrolled_frame']) if (v?.[key] !== undefined) {
        if (typeof v[key] === 'boolean') b[key] = v[key];
        else unsafe('unlisted-arg-field', 'args.event_latency');
      }
    }
  } else if (e.name.startsWith('InputLatency::') || e.name === 'LatencyInfo.Flow') {
    if (a.chrome_latency_info !== undefined) {
      const v = a.chrome_latency_info, b = out.args.chrome_latency_info = {};
      if (v?.trace_id !== undefined) { b.trace_id = numericId(v.trace_id); if (b.trace_id === undefined) unsafe('invalid-id', 'args.chrome_latency_info.trace_id'); }
      for (const key of ['gesture_scroll_id', 'touch_id']) if (v?.[key] !== undefined) {
        const id = numericId(v[key]);
        if (id !== undefined) b[key] = id;
        else unsafe('invalid-id', 'args.chrome_latency_info');
      }
      if (typeof v?.is_coalesced === 'boolean') b.is_coalesced = v.is_coalesced;
      if (v?.step !== undefined) {
        if (STEPS.has(v.step)) b.step = v.step;
        else if (e.name === 'LatencyInfo.Flow' && IGNORED_FLOW_STEPS.has(v.step)) ignoredStep = true;
        else unsafe('unlisted-flow-step', 'args.chrome_latency_info.step');
      }
      if (v?.component_info !== undefined) {
        if (!Array.isArray(v.component_info) || v.component_info.length > 16) unsafe('invalid-component-list', 'args.chrome_latency_info.component_info');
        else { b.component_info = []; for (const x of v.component_info) {
          if (COMPONENTS.has(x?.component_type) && uint(x.time_us)) b.component_info.push({ component_type: x.component_type, time_us: x.time_us });
          else unsafe(COMPONENTS.has(x?.component_type) ? 'invalid-component-time' : 'unlisted-component', 'args.chrome_latency_info.component_info');
        } }
      }
    }
  } else if (e.name === FORWARD) {
    // Chromium120 emits numeric dx/dy inside this Main synchronous scope.
    // Persist only their nonzero predicate, never values or coordinates.
    if (e.pid !== c.mainPid || e.ph !== 'X' || !uint(e.dur)
      || !Number.isFinite(a.dx) || !Number.isFinite(a.dy)
      || typeof a.dx !== 'number' || typeof a.dy !== 'number') unsafe('unlisted-arg-field', 'args');
    else out.args.hasDelta = a.dx !== 0 || a.dy !== 0;
  } else if (e.name === HANDLE) {
    if (TYPES.has(a.type)) out.args.type = a.type; else unsafe('unlisted-input-type', 'args.type');
  } else if (e.name === 'EventDispatch') {
    const type = a.data?.type;
    if (DISPATCH.has(type)) out.args.data = { type };
  } else if (e.name === 'FunctionCall') {
    // Function names can be generated from user content: only lexical names
    // anchored to a proven packaged code URL are retained, never arbitrary args.
    const v = a.data, url = safeCodeUrl(v?.url, c.packagedRoot);
    if (url) {
      const b = out.args.data = { url };
      if (typeof v.functionName === 'string' && /^[A-Za-z_$][\w$.:<>-]{0,159}$/.test(v.functionName)) b.functionName = v.functionName;
      for (const key of ['scriptId', 'lineNumber', 'columnNumber']) {
        const n = key === 'scriptId' ? numericId(v[key]) : uint(v[key]) ? v[key] : undefined;
        if (n !== undefined) b[key] = n;
      }
    }
  }
  if (unsafeInput) { stats.omitted.unsafeInput++; return lost(); }
  if (input) {
    const keys = e.name === 'EventLatency' ? ['event_latency'] : e.name === FORWARD ? ['dx', 'dy'] : e.name === HANDLE ? ['type']
      : e.name.startsWith('InputLatency::') || e.name === 'LatencyInfo.Flow' ? ['chrome_latency_info'] : [];
    let unknown = Object.keys(a).some(k => !keys.includes(k));
    if (unknown) rejectShape(stats, e, 'unlisted-arg-field', 'args');
    for (const [key, allowed] of [['event_latency', ['event_latency_id', 'event_type', 'has_high_latency', 'is_janky_scrolled_frame']],
      ['chrome_latency_info', ['trace_id', 'is_coalesced', 'step', 'component_info', 'gesture_scroll_id', 'touch_id']]]) {
      if (a[key] && typeof a[key] === 'object' && Object.keys(a[key]).some(k => !allowed.includes(k))) {
        unknown = true; rejectShape(stats, e, 'unlisted-arg-field', 'args.' + key);
      }
    }
    if (unknown) stats.inputLossRecords++;
  }
  if (ignoredStep) {
    stats.intentionalFiltered.flowSteps++; rejectShape(stats, e, 'known-unconsumed-step', a.chrome_latency_info.step); return null;
  }
  if (input) stats.inputRecords++;
  return out;
}

// Shared framing only: no JSON parsing, no metadata decoding, no event array.
// Chrome newline records are validated to the same bounded grammar in worker
// and adapter. The adapter consumes only this module's canonical safe artifact.
function createProjectionEventReader({ maxBytes, onLine, onRejected }) {
  const { createTraceLineReader } = require('./perf-trace-events');
  let opened = false, arrayClosed = false, rejected = 0;
  const reject = reason => { rejected++; onRejected(reason); };
  const reader = createTraceLineReader({ maxCarryBytes: LIMITS.lineBytes, maxBytes, traceEventsOnly: false,
    onLine(line) {
      if (arrayClosed) return;
      if (!opened) {
        if (!line.trim()) return;
        const header = /^\s*\{\s*"traceEvents"\s*:\s*\[/;
        if (!header.test(line)) { reject('invalid-envelope'); return; }
        opened = true; line = line.replace(header, '');
      }
      if (!line.trim()) return;
      if (/^\s*\]\s*(?:}|,|$)/.test(line)) { arrayClosed = true; return; }
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) { reject('incomplete-event-line'); return; }
      const tail = line.slice(end).trim();
      if (/^\]\s*(?:}|,|$)/.test(tail)) arrayClosed = true;
      else if (tail !== '' && tail !== ',') { reject('multiple-or-invalid-event-line'); return; }
      onLine(line.slice(0, end));
    } });
  return { write: reader.write, finish(completeExport) {
    const r = reader.finish(completeExport);
    return { ...r, traceArrayClosed: arrayClosed, framingRejected: rejected,
      completeExport: r.completeExport && opened && arrayClosed && !rejected && !r.overlongLines };
  } };
}

/** Feed the existing native collector from an exact safe-projection artifact.
 * Parent owns the file/read and must bind projection to that same artifact's
 * receipt. This adapter does not reinterpret old loss flags or parse the footer.
 * write is synchronous (<=256KiB); finish returns {result, audit}. The entire
 * source remains <=16MiB, while the forwarded native stream remains <=4MiB.
 * No event JSON.parse or whole trace object is introduced in the caller/Main.
 */
function createNativeTraceProjectionAdapter({ collector, projection,
  maxInputBytes = LIMITS.projectedBytes, maxOutputBytes = 4194304, maxEvents = LIMITS.events } = {}) {
  if (!collector || typeof collector.write !== 'function' || typeof collector.finish !== 'function') throw fail('native-projection-invalid-collector');
  if (!projection || projection.schema !== 'noted-trace-projection-v1' || typeof projection.complete !== 'boolean'
    || typeof projection.dataLoss !== 'boolean' || !positive(projection.projectedBytes)
    || projection.projectedBytes > LIMITS.projectedBytes) throw fail('native-projection-missing-proof');
  const inputCap = bounded(maxInputBytes, LIMITS.projectedBytes, 1, LIMITS.projectedBytes);
  const outputCap = bounded(maxOutputBytes, 4194304, 256, 4194304);
  const eventCap = bounded(maxEvents, LIMITS.events, 1, LIMITS.events);
  // Snapshot only authority fields: a caller's later mutation cannot clear loss.
  const proof = { complete: projection.complete, dataLoss: projection.dataLoss,
    nativeDataLoss: typeof projection.nativeDataLoss === 'boolean' ? projection.nativeDataLoss : null,
    projectedBytes: projection.projectedBytes };
  const header = '{"traceEvents":[\n', footer = '\n]}\n';
  let sourceBytes = 0, nativeBytes = Buffer.byteLength(header), events = 0, nativeEvents = 0, ignoredEngineEvents = 0;
  let stopped = false, failed = false, done = false, final, rejectedLines = 0, outputLimit = false, eventLimit = false;
  collector.write(header);
  const reader = createProjectionEventReader({ maxBytes: inputCap, onRejected() { rejectedLines++; },
    onLine(line) {
      if (stopped) return;
      if (events >= eventCap) { eventLimit = true; stopped = true; return; }
      events++;
      // Writer emits name as its FIRST key, using this exact canonical encoding.
      // A nested args.name can never make an engine event become a native event.
      const match = /^\{"name":"([A-Za-z0-9_.:]{1,160})",/.exec(line);
      if (!match) { rejectedLines++; return; }
      const name = match[1];
      if (!NATIVE_NAMES.has(name)) {
        if (ENGINE.has(name) || GC.has(name)) ignoredEngineEvents++;
        else rejectedLines++;
        return;
      }
      const text = (nativeEvents ? ',\n' : '') + line, bytes = Buffer.byteLength(text);
      if (nativeBytes + bytes + Buffer.byteLength(footer) > outputCap) { outputLimit = true; stopped = true; return; }
      collector.write(text); nativeBytes += bytes; nativeEvents++;
    } });
  return {
    write(chunk) {
      if (done || stopped || failed) throw fail('native-projection-not-writable');
      if (!(typeof chunk === 'string' || Buffer.isBuffer(chunk))) throw fail('native-projection-invalid-chunk');
      if ((typeof chunk === 'string' && chunk.length > 262144) || Buffer.byteLength(chunk) > 262144) throw fail('native-projection-chunk-limit');
      const bytes = Buffer.byteLength(chunk);
      if (sourceBytes + bytes > inputCap) { failed = true; throw fail('native-projection-input-limit'); }
      sourceBytes += bytes;
      try { reader.write(chunk); } catch { failed = true; throw fail('native-projection-consumer-failed'); }
      return { continue: !stopped, sourceBytes, nativeBytes };
    },
    finish({ completeExport = false, dataLoss = false, clockMarkers, rendererClockRelation, trigger } = {}) {
      if (done) return final;
      done = true;
      let stream;
      try { stream = reader.finish(completeExport === true); collector.write(footer); nativeBytes += Buffer.byteLength(footer); }
      catch { failed = true; throw fail('native-projection-consumer-failed'); }
      const complete = proof.complete && completeExport === true && stream.completeExport
        && sourceBytes === proof.projectedBytes && !stopped && !failed && !rejectedLines;
      const loss = proof.dataLoss || proof.nativeDataLoss === true || dataLoss === true || !complete;
      const result = collector.finish({ completeExport: complete, dataLoss: loss, clockMarkers, rendererClockRelation, trigger });
      final = { result, audit: { schema: 'noted-native-projection-read-v1', sourceBytes, nativeBytes, events, nativeEvents,
        ignoredEngineEvents, rejectedLines, outputLimit, eventLimit, failed, stream, sourceProof: proof,
        completeExport: complete, dataLoss: loss, limits: { inputBytes: inputCap, outputBytes: outputCap, events: eventCap, lineBytes: LIMITS.lineBytes } } };
      return final;
    },
  };
}

function worker() {
  const { parseTraceEventLine } = require('./perf-trace-events');
  let c, fd, dirFd, pin, reader, deadlineTimer, finished = false, seq = 0, written = 0, first = true, buffered = '', stopped = false, stopReason;
  // resourceUsage/uptime/cpuUsage include helper startup and module loading.
  const stats = { schema: 'noted-trace-projection-v1', rawBytes: 0, projectedBytes: 0, eventCount: 0, projectedCount: 0,
    inputRecords: 0, inputLossRecords: 0, complete: false, dataLoss: false, inputCoverage: 'unknown',
    classificationVersion: 3, nativeDataLoss: false, projectionDataLoss: false,
    intentionalFiltered: { names: 0, flowSteps: 0 },
    rejectShapes: { total: 0, omitted: 0, reservedBytes: 0, reasons: {}, entries: [] },
    omitted: { foreignPid: 0, name: 0, category: 0, invalid: 0, malformed: 0, thread: 0, clock: 0, unsafeInput: 0, eventLimit: 0, artifactLimit: 0 },
    claims: 'limited-safe-projection; overlap-only; not-root-cause; main-and-target-renderer-only; GPU-unclaimed' };
  function check() {
    if (Date.now() >= c.deadlineAt) throw fail('projection-deadline');
    const s = fs.lstatSync(c.incidentDir);
    if (fs.realpathSync(c.incidentDir) !== c.incidentDir || !s.isDirectory() || s.isSymbolicLink() || s.dev !== pin.dev || s.ino !== pin.ino) throw fail('projection-directory-changed');
    if (fd !== undefined) {
      const current = fs.lstatSync(c.file), owned = fs.fstatSync(fd);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
        || owned.nlink !== 1) throw fail('projection-file-changed');
    }
  }
  function write(text) { check(); const b = Buffer.from(text); let off = 0; while (off < b.length) { const n = fs.writeSync(fd, b, off); if (n <= 0) throw fail('projection-write-failed'); off += n; } written += b.length; }
  function flush() { if (buffered) { write(buffered); buffered = ''; } }
  function close() { clearTimeout(deadlineTimer); if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } if (dirFd !== undefined) { fs.closeSync(dirFd); dirFd = undefined; } }
  function exit(message) {
    finished = true; close(); process.removeAllListeners('message');
    if (process.connected) process.send(message, () => { if (process.connected) process.disconnect(); });
  }
  function error() { try { close(); } catch {} finished = true;
    // No exception text, stack, paths, trace body or uncontrolled child stderr.
    if (process.connected) process.send({ type: 'error' }, () => { if (process.connected) process.disconnect(); });
  }
  process.once('disconnect', () => { try { close(); } finally { process.exit(0); } });
  process.on('message', m => {
    if (finished) return;
    try {
      if (!c) {
        if (m.type !== 'init') throw fail('projection-protocol'); c = config({ ...m.config, maxRawBytes: m.config.rawBytes, maxEvents: m.config.events, maxProjectedBytes: m.config.projectedBytes });
        if (fs.realpathSync(c.incidentDir) !== c.incidentDir) throw fail('projection-directory-not-canonical');
        deadlineTimer = setTimeout(() => { try { close(); } finally { process.exit(1); } }, Math.max(1, c.deadlineAt - Date.now()));
        dirFd = fs.openSync(c.incidentDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); pin = fs.fstatSync(dirFd); check();
        if (c.packagedRoot && fs.realpathSync(c.packagedRoot) !== c.packagedRoot) throw fail('projection-root-not-canonical');
        fd = fs.openSync(c.file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        check(); write('{"traceEvents":[\n');
        reader = createProjectionEventReader({ maxBytes: c.rawBytes,
          onRejected(reason) { stats.omitted.malformed++; stats.inputLossRecords++; rejectShape(stats, null, reason); },
          onLine(line) {
            if (stopped) { stats.omitted[stopReason]++; return; }
            if (stats.eventCount >= c.events) { stats.omitted.eventLimit++; stopped = true; stopReason = 'eventLimit'; return; }
            stats.eventCount++;
            let e; try { e = parseTraceEventLine(line); } catch { stats.omitted.malformed++; stats.inputLossRecords++; rejectShape(stats, null, 'malformed-json'); return; }
            const projected = project(e, c, stats); if (!projected) return;
            const text = (first ? '' : ',\n') + JSON.stringify(projected);
            if (written + Buffer.byteLength(buffered) + Buffer.byteLength(text) + 8192 > c.projectedBytes) {
              stats.omitted.artifactLimit++; if (stats.inputRecords) stats.inputLossRecords++; stopped = true; stopReason = 'artifactLimit'; return;
            }
            first = false; buffered += text; stats.projectedCount++;
            if (Buffer.byteLength(buffered) >= 65536) flush();
          } });
        process.send({ type: 'ready' }); return;
      }
      check(); if (m.seq !== ++seq) throw fail('projection-protocol');
      if (m.type === 'chunk') {
        if (!Buffer.isBuffer(m.data) || m.data.length > c.chunkBytes || stats.rawBytes + m.data.length > c.rawBytes || stopped) throw fail('projection-ingress-limit');
        stats.rawBytes += m.data.length; reader.write(m.data); flush();
        const rawFull = stats.rawBytes === c.rawBytes;
        process.send({ type: 'ack', seq, value: { rawBytes: stats.rawBytes, projectedBytes: written,
          continue: !stopped && !rawFull, limit: stopped || rawFull ? 'projection-budget' : null } });
      } else if (m.type === 'finish') {
        const r = reader.finish(m.completeExport === true); flush();
        stats.reader = r; stats.complete = r.completeExport && !stopped && !r.overlongLines && !stats.omitted.malformed;
        stats.nativeDataLoss = m.dataLoss === true;
        stats.projectionDataLoss = !stats.complete || stats.inputLossRecords > 0;
        stats.dataLoss = stats.nativeDataLoss || stats.projectionDataLoss;
        stats.inputCoverage = stats.dataLoss || !stats.inputRecords ? 'unknown' : 'preserved-known-vocabulary';
        stats.limits = { ...LIMITS, chunkBytes: c.chunkBytes, rawBytes: c.rawBytes, events: c.events, projectedBytes: c.projectedBytes };
        stats.cost = { elapsedMs: process.uptime() * 1000, cpuMicros: process.cpuUsage(),
          ...describeTraceMaxRss(process.resourceUsage().maxRSS), heapUsedBytes: process.memoryUsage().heapUsed };
        // Footer size converges (only a bounded integer changes), always reserved.
        let footer; for (let i = 0; i < 4; i++) { footer = '\n],"projection":' + JSON.stringify(stats) + '}\n'; stats.projectedBytes = written + Buffer.byteLength(footer); }
        footer = '\n],"projection":' + JSON.stringify(stats) + '}\n';
        if (written + Buffer.byteLength(footer) > c.projectedBytes) throw fail('projection-footer-limit');
        write(footer); stats.projectedBytes = written;
        exit({ type: 'result', seq, value: stats });
      } else throw fail('projection-protocol');
    } catch { error(); }
  });
}

module.exports = { createTraceProjectionWriter, createNativeTraceProjectionAdapter, describeTraceMaxRss, LIMITS };
if (require.main === module && process.argv[2] === '--trace-projection-worker') worker();
