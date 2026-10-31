'use strict';

// Persistence only: no capture, profiler, app, command, quota or prune authority.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { NATIVE_INPUT_NAMES } = require('./perf-input-latency');
const MAX_BYTES = 256 * 1024;
const MAX_VISITS = 131072;
const STAGE_MEANING = Object.freeze({
  'browser-delivery': 'интервал до регистрации события в RenderWidgetHost; при CDP может включать ожидание интерфейса; это не замер CPU Main',
  'browser-to-renderer': 'передача события в процесс интерфейса',
  'renderer-queue': 'ожидание в очереди потока прокрутки',
  'renderer-compositor': 'обработка в потоке прокрутки',
  'renderer-main-delivery': 'ожидание передачи в основной поток интерфейса',
  'renderer-processing': 'обработка события интерфейсом',
  'frame-production': 'подготовка нового кадра',
  presentation: 'передача кадра на показ; физический экран не измерен',
});
const FILE = /^incident-[0-9]{1,16}-[0-9]{1,10}\.input\.json$/;
const FAILURE_CODES = new Set(['INPUT_SNAPSHOT_INVALID_RECORD','INPUT_SNAPSHOT_OVERSIZE','INPUT_SNAPSHOT_WRONG_OWNER',
  'INPUT_SNAPSHOT_INVALID_NAME','INPUT_SNAPSHOT_INVALID_DIRECTORY','INPUT_SNAPSHOT_INVALID_FILE',
  'INPUT_SNAPSHOT_PARTIAL_WRITE','INPUT_SNAPSHOT_FILE_CHANGED','INPUT_SNAPSHOT_CLOSE_FAILED']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('INPUT_SNAPSHOT_INVALID_RECORD');
const large = () => fail('INPUT_SNAPSHOT_OVERSIZE');
const plain = v => v && typeof v === 'object' && !types.isProxy(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function field(v, key) {
  if (!plain(v) && !Array.isArray(v) || types.isProxy(v)) invalid();
  const d = Object.getOwnPropertyDescriptor(v, key);
  if (!d) return undefined;
  if (!Object.hasOwn(d, 'value')) invalid(); // Never execute getters/toJSON.
  return d.value;
}
const num = { kind: 'number' }, count = { kind: 'integer', min: 0 };
const bounded = max => ({ kind: 'integer', min: 0, max });
const positivePid = { kind: 'integer', min: 1, max: 2147483647 };
const ownedPid = { kind: 'pid' };
const time = { kind: 'number', min: 0 };
const bool = { kind: 'boolean' };
const en = (...values) => ({ kind: 'enum', values: new Set(values.flat()) });
const lit = value => en(value);
const nil = schema => ({ ...schema, nullable: true });
const arr = (item, max) => ({ kind: 'array', item, max });
const obj = (fields, required = []) => ({ kind: 'object', fields, required });
const id = { kind: 'id' };
const nativeTypes = ['MouseDown','MouseUp','MouseMove','MouseWheel','TouchStart','TouchMove','TouchEnd',
  'GestureScrollBegin','GestureScrollUpdate','GestureScrollEnd','KeyDown','KeyUp'];
const eventTypes = ['MOUSE_PRESSED','MOUSE_RELEASED','MOUSE_MOVED','MOUSE_WHEEL','TOUCH_PRESSED','TOUCH_MOVED','TOUCH_RELEASED',
  'GESTURE_SCROLL_BEGIN','GESTURE_SCROLL_UPDATE','GESTURE_SCROLL_END','KEY_PRESSED','KEY_RELEASED'];
const stages = ['GenerationToBrowserMain','BrowserMainToRendererCompositor','RendererCompositorQueueingDelay',
  'RendererCompositorProcessing','RendererCompositorToMain','RendererMainProcessing','RendererMainFinishedToCommit',
  'RendererMainFinishedToBeginImplFrame','BeginImplFrameToSendBeginMainFrame','SendBeginMainFrameToCommit','Commit',
  'EndCommitToActivation','Activation','EndActivateToSubmitCompositorFrame','SubmitCompositorFrameToPresentationCompositorFrame',
  'SubmitToReceiveCompositorFrame','ReceiveCompositorFrameToStartDraw','StartDrawToSwapStart','Swap'];
const components = ['Original','BrowserMain','RendererMain','RenderingScheduledMain','RenderingScheduledImpl',
  'RendererSwap','DisplayReceivedFrame','GpuSwapBuffer','FrameSwap'];
const componentTypes = ['COMPONENT_INPUT_EVENT_LATENCY_ORIGINAL','COMPONENT_INPUT_EVENT_LATENCY_BEGIN_RWH',
  'COMPONENT_INPUT_EVENT_LATENCY_RENDERER_MAIN','COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_MAIN',
  'COMPONENT_INPUT_EVENT_LATENCY_RENDERING_SCHEDULED_IMPL','COMPONENT_INPUT_EVENT_LATENCY_RENDERER_SWAP',
  'COMPONENT_DISPLAY_COMPOSITOR_RECEIVED_FRAME','COMPONENT_INPUT_EVENT_GPU_SWAP_BUFFER','COMPONENT_INPUT_EVENT_LATENCY_FRAME_SWAP'];
const steps = ['STEP_SEND_INPUT_EVENT_UI','STEP_HANDLE_INPUT_EVENT_IMPL','STEP_DID_HANDLE_INPUT_AND_OVERSCROLL',
  'STEP_HANDLE_INPUT_EVENT_MAIN','STEP_HANDLED_INPUT_EVENT_MAIN_OR_IMPL','STEP_HANDLED_INPUT_EVENT_IMPL'];
const handle = 'WebFrameWidgetImpl::HandleInputEvent';
const forward = 'RenderWidgetHostImpl::ForwardWheelEvent';
const names = [...stages, ...steps, ...nativeTypes.map(t => 'InputLatency::' + t), 'EventLatency','LatencyInfo.Flow',handle,forward,'thread_name'];
const categories = ['browser-delivery','browser-to-renderer','renderer-queue','renderer-compositor',
  'renderer-main-delivery','renderer-processing','frame-production','presentation'];
const threadNames = ['CrRendererMain','CrBrowserMain','Compositor'];
const issues = ['nonmonotonic','duplicate-pair','duplicate-root','missing-root','missing-pair','negative-interval','outside-root',
  'duplicate-identity','missing-native-root','invalid-components','type-mismatch','original-mismatch','nonmonotonic-components',
  'component-outside-input','missing-core-stage','noncontiguous-core-stages','duplicate-native-interval','native-interval-outside-root',
  'missing-stages','incomplete-export-evidence','coalesced','coalescing-unknown'];
const reasons = ['missing-markers','marker-limit','duplicate-or-invalid-marker','duplicate-clock-event','missing-clock-event',
  'invalid-clock-snapshot','nonmonotonic-clock','offset-bounds-conflict','missing-renderer-clock-relation','foreign-clock-relation',
  'main-trace-clock-unproven','invalid-renderer-clock-relation','foreign-document-clock-relation','missing-trigger','foreign-renderer',
  'foreign-or-unknown-document','missing-native-original','unsupported-native-type','clock-unproven','invalid-timestamp-uncertainty',
  'invalid-native-original','nonunique-native-original','incomplete-evidence','no-native-original-match','not-an-individual-input',
  'incomplete-native-chain-or-clock-coverage','output-limit'];
const rejectionReasons = ['foreign-pid','unsupported-event','unsupported-input-type','unknown-component','flow-limit',
  'malformed-json','event-not-object','wrong-pid-role','invalid-ts','invalid-tid','record-limit','invalid-thread-phase',
  'thread-metadata-limit','invalid-clock-phase','invalid-clock-id','invalid-pair-phase','unsupported-pair-scope',
  'invalid-pair-id','unsupported-global-id','invalid-trace-id','missing-components','component-limit',
  'invalid-component-time','duplicate-component','invalid-duration','invalid-end-time','invalid-thread-duration',
  'wrong-step-pid','retained-byte-limit','unlinked-native-root','invalid-forward-scope'];
const errors = ['input-trace-scope-changed','input-trace-end-unconfirmed','input-trace-export-deadline',
  'input-trace-chunk-invalid','input-trace-export-cap','renderer-clock-unavailable','input-trace-read-failed',
  'input-trace-analysis-failed','input-trace-owner-lost','input-exclusive-unavailable','input-receipt-invalid',
  'input-command-unconfirmed','input-unsubscribe-failed','input-cleanup-owner-lost','input-stream-missing',
  'input-stream-close-unconfirmed','input-cleanup-unconfirmed','input-completion-invalid','input-clock-unavailable',
  'input-renderer-clock-unavailable','input-subscription-unavailable','input-trace-start-refused','input-trace-start-unconfirmed',
  'input-start-unavailable','input-scope-unavailable','input-post-unavailable','input-during-snapshot-gap',
  'input-persistence-unconfirmed','input-summary-cap-or-invalid','input-snapshot-failed','input-actions-invalid','input-pause-unconfirmed',
  'input-retired-callback-failed','input-trace-end-refused','input-clock-projection-failed','input-action-foreign-scope'];
const snapshot = obj({ timeOrigin: time, now: time, epochMs: time }, ['epochMs']);
const pair = arr(num, 2);
const native = obj({
  name: en(names), ph: en('b','e','n','X','M'), pid: ownedPid, tid: positivePid, ts: count, dur: count, tdur: count, id,
  id2: obj({ local: id }, ['local']),
  args: obj({
    name: nil(en(threadNames)), type: en(nativeTypes), hasDelta: bool,
    chrome_latency_info: obj({ trace_id: id, is_coalesced: nil(bool), step: en(steps),
      component_info: arr(obj({ component_type: en(componentTypes), time_us: count }, ['component_type','time_us']), 16) }),
    event_latency: obj({ event_latency_id: id, event_type: nil(en(eventTypes)) }, ['event_type'])
  })
}, ['name','ph','pid','tid','ts']);
const interval = obj({
  name: en(names), startUs: count, endUs: count, durationMs: time, pid: ownedPid,
  tid: positivePid, emitterTid: positivePid, depth: { kind: 'integer', min: -1, max: 4096 },
  depthFromExport: lit(1), depthEvidence: lit('validated-core-boundary'),
  threadMs: nil(time), category: en(categories), threadName: nil(en(threadNames)),
  cpuQualification: en('exact-flow-and-thread','unknown-thread','ambiguous-flow'), evidence: lit('exact-trace-id'),
  eventRootRelation: lit('metrics-end-inside-main-handler'), eventRootOverlapMs: time, scopeTailAfterEventMs: time,
  hasDelta: bool,
  nativeType: en(nativeTypes), association: lit('unbound'), nativeEvidence: native, startAbsBoundsMs: pair, endAbsBoundsMs: pair
}, ['name','startUs','endUs','durationMs','pid']);
const clock = obj({
  status: en('unknown','conflict','bounded'), reason: nil(en(reasons)), offsetLowMs: nil(num), offsetHighMs: nil(num),
  uncertaintyMs: nil(time), traceRangeUs: nil(pair), mainTimeOriginMs: time, omittedMarkers: count,
  markers: arr(obj({ index: count, traceUs: count, mainBeforeAbsMs: time, mainAfterAbsMs: time, offsetLowMs: num, offsetHighMs: num },
    ['index','traceUs','mainBeforeAbsMs','mainAfterAbsMs','offsetLowMs','offsetHighMs']), 16)
}, ['status','markers']);
const rendererClock = obj({ status: en('unknown','bounded'), reason: en(reasons), offsetLowMs: num, offsetHighMs: num,
  uncertaintyMs: time, rendererTimeOriginMs: time, rendererSampleAbsMs: time, mainBeforeAbsMs: time, mainAfterAbsMs: time,
  model: lit('constant-offset-for-captured-document') }, ['status']);
const counts = keys => obj(Object.fromEntries(keys.split(' ').map(k => [k, count])));
const evidence = obj({
  schema: lit('noted-input-latency-v1'), status: en('unknown','partial','complete'),
  scope: obj({ mainPid: ownedPid, rendererPid: ownedPid, documentTimeOriginMs: nil(time) }, ['mainPid','rendererPid','documentTimeOriginMs']),
  limits: obj({ inputBytes: bounded(4194304), carryBytes: bounded(65536), flows: bounded(512), records: bounded(16384),
    retainedBytes: bounded(4194304), outputFlows: bounded(64),
    outputBytes: bounded(MAX_BYTES) }, ['inputBytes','carryBytes','flows','records','outputBytes']),
  stream: obj({ ...counts('bytes acceptedBytes omittedBytes lines overlongLines incompleteTailBytes peakCarryBytes carryLimitBytes').fields, completeExport: bool }),
  dataLoss: nil(bool),
  omitted: counts('records flowRecords components threadRecords outputFlows outputNativeIntervals outputClockMarkers outputThreadRecords outputOrphanEvidence retainedByteRecords retainedBytes'),
  stats: counts('malformedLines foreignEvents wrongRoleEvents invalidIds invalidTimes invalidRecords unsupportedEvents unknownComponents invalidThreadTimes retainedRecords retainedBytes orphanTracks sameTimestampCoreBoundaries'),
  clock, rendererClock, threadEvidence: arr(native, 32),
  trigger: obj({ status: en('not-requested','unknown','unmatched','matched','ambiguous','coalesced'), reason: en(reasons),
    candidates: arr(id, 64), candidateCount: count, omittedCandidates: count, traceId: id, nativeType: en(nativeTypes), nativeOriginalRendererAbsMs: time,
    nativeOriginalMainAbsBoundsMs: pair, uncertaintyMs: time }, ['status']),
  rejections: obj({ total: count, retained: bounded(32), omitted: count, outputOmitted: count,
    projectionBytes: bounded(4194304), counts: obj(Object.fromEntries(rejectionReasons.map(reason => [reason, count]))),
    events: arr(obj({ reason: en(rejectionReasons), kind: en('unknown','thread','clock','input','event','step','native','forward'),
      name: en([...names,'clock_sync',...NATIVE_INPUT_NAMES.map(type => 'InputLatency::' + type)]),
      ph: en('B','E','X','b','e','n','s','t','f','I','i','M','c','C','N','O','D','R','P','v','V'),
      // Rejected headers are metadata, not authority for an owned flow.
      pid: { kind: 'integer', min: 1 }, tid: { kind: 'integer', min: 1 }, ts: count,
      localId: id, id, traceId: id, nativeType: en(NATIVE_INPUT_NAMES), nativeOriginalUs: count,
    }, ['reason','kind']), 32), qualification: lit('diagnostic-only; conservative input qualification unchanged'),
  }, ['total','retained','omitted','outputOmitted','projectionBytes','counts','events','qualification']),
  flows: arr(obj({
    traceId: id, nativeType: nil(en(nativeTypes)), status: en('measured','partial','ambiguous'), issues: arr(en(issues), 32),
    coalesced: nil(bool), originalUs: nil(count), inputInterval: nil(interval), eventInterval: nil(interval),
    components: arr(obj({ name: en(components), ts: count }, ['name','ts']), 16),
    stages: arr(interval, 4096), linkedNativeIntervals: arr(interval, 4096), nativeEvidence: arr(native, 4096),
    wheelForwarding: obj({ status: en('qualified','unknown','ambiguous'),
      reason: nil(en('incomplete-export-evidence','clock-unproven','missing-browser-component','incomplete-flow',
        'missing-forward-scope','nonunique-forward-scope','unknown-main-thread','nonunique-forward-owner','output-limit')),
      candidateCount: count, omittedCandidates: count, ownerCount: count, candidates: arr(interval, 8)
    }, ['status','reason','candidateCount','omittedCandidates','ownerCount','candidates']),
    absoluteClockStatus: en('bounded','unknown'), largestMeasuredStage: nil(obj({ name: en(stages), category: en(categories), durationMs: time },
      ['name','category','durationMs']))
  }, ['traceId','nativeType','status','issues','nativeEvidence']), 64),
  unboundNativeIntervals: arr(interval, 4096), orphanEvidence: arr(native, 4096),
  interpretation: lit('Native intervals only; nested intervals are not additive CPU. FrameSwap is not physical scanout. No JS source or root-cause inference.')
}, ['schema','status','scope','limits','stream','dataLoss','omitted','stats','clock','rendererClock','trigger','flows']);
const envelope = obj({
  version: lit(1), kind: lit('input-native-preroll'), cpuProfiler: lit(false),
  recordingId: { kind: 'recordingId' },
  status: en('partial','complete'), companionCaptureId: nil({ kind: 'captureId' }),
  scope: obj({ mainPid: ownedPid, rendererPid: ownedPid, window: count, documentGeneration: count,
    frameProcessId: count, frameRoutingId: count, documentTimeOriginMs: nil(time),
    attachmentIdSha256: { kind: 'digest', from: 'attachmentId' } },
  ['mainPid','rendererPid','window','documentGeneration','frameProcessId','frameRoutingId']),
  actions: arr(obj({ id: { kind: 'actionId' }, event: en('click','pointerdown','pointerup','mousedown','mouseup','keydown','keyup','wheel'),
    startAbs: time, durationMs: { kind: 'number', min: 0, max: 60000 },
    inputDelayMs: { kind: 'number', min: 0, max: 60000 }, rendererPid: { kind: 'rendererPid' }, documentTimeOriginMs: time,
    coverage: en('ring-candidate','snapshot-gap'), nativeOriginal: obj({ type: en('click','pointerdown','pointerup','mousedown','mouseup','keydown','keyup','wheel'),
      timeStampMs: time, pointerType: en('mouse','touch','pen'), uncertaintyMs: { kind: 'number', min: 0, max: 2 } }, ['type','timeStampMs']) }, ['id','event','startAbs','durationMs']), 16),
  multipleActions: arr(obj({ id: { kind: 'actionId' }, binding: en('primary-evidence','unknown-snapshot-gap','unknown-additional-action'),
    inputMeaning: en('mouse-release-half-only','native-event-only'),
    exclusiveCpuClaim: lit(false) }, ['id','binding','exclusiveCpuClaim']), 16),
  triggerInterpretation: nil(obj({ actionId: { kind: 'actionId' }, mapping: lit('trusted-mouse-click-to-release'),
    meaning: lit('mouse-release-half-only'), wholeGesture: lit(false) }, ['actionId','mapping','meaning','wholeGesture'])),
  clockCoverage: counts('issued receiptsRetained retiredReceipts presentInExport usableReceipts missingFromExport'),
  rejectedForeignTriggers: count,
  omittedTriggers: count, captureStartedAbs: time, captureFinishedAbs: time, recordingStartedAbs: nil(time),
  exportBytes: bounded(4194304), exportComplete: bool, dataLoss: nil(bool), cleanupConfirmed: bool,
  rendererClock: obj({ rendererEpochMs: time, parentBeforeAbs: time, parentAfterAbs: time }),
  rendererClockRelation: obj({ mainPid: ownedPid, rendererPid: ownedPid, mainBefore: snapshot, mainAfter: snapshot, renderer: snapshot }),
  clockMarkers: arr(obj({ label: en('snapshot-before','snapshot-after'), before: snapshot, after: snapshot }, ['before','after']), 16),
  errors: arr(en(errors), 16), evidence: nil(evidence)
}, ['version','kind','cpuProfiler','scope','actions','captureStartedAbs','captureFinishedAbs','recordingStartedAbs','errors']);

// Encode only fixed schema fields. No traversal/clone/stringify of caller-owned
// objects, arbitrary strings, unknown members, accessors or toJSON hooks.
function encode(record, owner) {
  const parts = []; let bytes = 0, visits = 0;
  const put = text => { bytes += Buffer.byteLength(text); if (bytes > MAX_BYTES) large(); parts.push(text); };
  function visit(schema, v) {
    if (++visits > MAX_VISITS) large();
    if (v === null && schema.nullable) { put('null'); return; }
    if (schema.kind === 'object') {
      if (!plain(v)) invalid();
      put('{'); let comma = false;
      for (const [key, type] of Object.entries(schema.fields)) {
        const item = field(v, type.from || key);
        if (item === undefined) { if (schema.required.includes(key)) invalid(); continue; }
        if (comma) put(','); comma = true; put(JSON.stringify(key) + ':'); visit(type, item);
      }
      put('}'); return;
    }
    if (schema.kind === 'array') {
      if (!Array.isArray(v) || types.isProxy(v)) invalid();
      if (v.length > schema.max) large();
      put('['); for (let i = 0; i < v.length; i++) { if (i) put(','); visit(schema.item, field(v, String(i))); } put(']'); return;
    }
    let value = v;
    switch (schema.kind) {
      case 'number': case 'integer': case 'pid': case 'rendererPid':
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER
          || v < (schema.min ?? -Number.MAX_SAFE_INTEGER) || v > (schema.max ?? Number.MAX_SAFE_INTEGER)
          || (schema.kind !== 'number' && !Number.isSafeInteger(v))) invalid();
        if (schema.kind === 'pid' && v !== owner.mainPid && v !== owner.rendererPid) fail('INPUT_SNAPSHOT_WRONG_OWNER');
        if (schema.kind === 'rendererPid' && v !== owner.rendererPid) fail('INPUT_SNAPSHOT_WRONG_OWNER');
        break;
      case 'boolean': if (typeof v !== 'boolean') invalid(); break;
      case 'enum': if (typeof v === 'string' && v.length > 256 || !schema.values.has(v)) invalid(); break;
      case 'id':
        if (typeof v !== 'string' || v.length > 20 || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > 18446744073709551615n) invalid();
        break;
      case 'recordingId':
        if (typeof v !== 'string' || v.length > 64 || !new RegExp('^input-ring-' + owner.mainPid + '-[0-9]{1,16}$').test(v)) invalid();
        break;
      case 'captureId':
        if (typeof v !== 'string' || v.length > 48 || !/^incident-[0-9]{1,16}-[0-9]{1,10}$/.test(v)) invalid();
        break;
      case 'actionId':
        if (typeof v !== 'string' || v.length > 40 || !/^ui-[a-z0-9]{1,16}-[a-z0-9]{1,12}$/.test(v)
          || v.split('-').slice(1).some(s => !Number.isSafeInteger(parseInt(s, 36)) || parseInt(s, 36).toString(36) !== s)) invalid();
        break;
      case 'digest':
        if (typeof v !== 'string' || v.length < 1 || v.length > 128 || !/^[\w:-]+$/.test(v)) invalid();
        value = createHash('sha256').update(v).digest('hex'); break;
      default: invalid();
    }
    put(JSON.stringify(value));
  }
  visit(envelope, record); put('\n');
  return Buffer.from(parts.join(''), 'utf8');
}
function prepare(record, mainPid, windowId) {
  if (!plain(record)) invalid();
  for (const key of ['name','file','filename','path']) if (Object.hasOwn(record, key)) fail('INPUT_SNAPSHOT_INVALID_NAME');
  const scope = field(record, 'scope'), start = field(record, 'captureStartedAbs'), end = field(record, 'captureFinishedAbs');
  const rendererPid = field(scope, 'rendererPid'), window = field(scope, 'window');
  if (field(scope, 'mainPid') !== mainPid || !Number.isSafeInteger(rendererPid) || rendererPid <= 0
    || rendererPid > 2147483647 || rendererPid === mainPid || (windowId !== undefined && windowId !== window)) fail('INPUT_SNAPSHOT_WRONG_OWNER');
  if (!Number.isSafeInteger(window) || window < 0) invalid();
  if (typeof start !== 'number' || !Number.isFinite(start) || !Number.isSafeInteger(Math.round(start)) || Math.round(start) < 1
    || typeof end !== 'number' || !Number.isFinite(end) || end < start || field(record, 'recordingStartedAbs') > start) fail('INPUT_SNAPSHOT_INVALID_NAME');
  const name = 'incident-' + Math.round(start) + '-' + mainPid + '.input.json';
  if (!FILE.test(name)) fail('INPUT_SNAPSHOT_INVALID_NAME');
  const e = field(record, 'evidence');
  if (e !== undefined && e !== null) {
    const es = field(e, 'scope');
    if (field(es, 'mainPid') !== mainPid || field(es, 'rendererPid') !== rendererPid) fail('INPUT_SNAPSHOT_WRONG_OWNER');
    const origin = field(scope, 'documentTimeOriginMs');
    if (origin !== undefined && field(es, 'documentTimeOriginMs') !== origin) fail('INPUT_SNAPSHOT_WRONG_OWNER');
  } else if (!Array.isArray(field(record, 'errors')) || field(record, 'errors').length === 0) invalid();
  return { name, window, data: encode(record, { mainPid, rendererPid }) };
}

/**
 * One writer instance per Main. publish(record) resolves strictly true only
 * after one exclusive write, exact size/inode checks and successful close.
 * False is final for that call; no retry, deletion, rename or overwrite.
 * io is a narrow fs.promises-compatible test seam (mkdir/lstat/open).
 */
function createInputSnapshotWriter({ directory, mainPid, windowId, log = () => {}, io = fs.promises } = {}) {
  if (typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)
    || !Number.isSafeInteger(mainPid) || mainPid < 1 || mainPid > 2147483647
    || (windowId !== undefined && (!Number.isSafeInteger(windowId) || windowId < 0))
    || typeof log !== 'function') throw new TypeError('invalid input snapshot writer configuration');
  directory = path.resolve(directory);
  const flights = new Set();
  const report = value => { try { Promise.resolve(log('[Perf:InputSnapshot] ' + JSON.stringify(value))).catch(() => {}); } catch {} };
  async function publish(record) {
    let p, handle, opened = false, closeAttempted = false, written = null, code = null;
    try {
      p = prepare(record, mainPid, windowId);
      if (flights.has(p.window)) { report({ status: 'failed', code: 'INPUT_SNAPSHOT_BUSY', name: p.name }); return false; }
      flights.add(p.window);
    } catch (error) {
      report({ status: 'rejected', code: FAILURE_CODES.has(error?.code) ? error.code : 'INPUT_SNAPSHOT_INVALID_RECORD' }); return false;
    }
    const target = path.join(directory, p.name);
    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      const dir = await io.lstat(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) fail('INPUT_SNAPSHOT_INVALID_DIRECTORY');
      handle = await io.open(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      opened = true;
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== 0 || (before.mode & 0o777) !== 0o600) fail('INPUT_SNAPSHOT_INVALID_FILE');
      // One write attempt. Even a short successful write remains a partial
      // original file; filling/reopening it would conceal the failed attempt.
      const result = await handle.write(p.data, 0, p.data.length, 0);
      written = result.bytesWritten;
      if (written !== p.data.length) fail('INPUT_SNAPSHOT_PARTIAL_WRITE');
      const after = await handle.stat();
      if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== p.data.length) fail('INPUT_SNAPSHOT_FILE_CHANGED');
      closeAttempted = true; await handle.close();
      const current = await io.lstat(target), currentDir = await io.lstat(directory);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino
        || current.size !== p.data.length || (current.mode & 0o777) !== 0o600 || !currentDir.isDirectory() || currentDir.isSymbolicLink() || currentDir.dev !== dir.dev || currentDir.ino !== dir.ino) fail('INPUT_SNAPSHOT_FILE_CHANGED');
    } catch (error) {
      code = FAILURE_CODES.has(error?.code) ? error.code
        : error?.code === 'EEXIST' || error?.code === 'ELOOP' ? 'INPUT_SNAPSHOT_EXISTS' : 'INPUT_SNAPSHOT_IO_FAILED';
    } finally {
      if (handle && !closeAttempted) {
        closeAttempted = true;
        try { await handle.close(); } catch { code = 'INPUT_SNAPSHOT_CLOSE_FAILED'; }
      }
      flights.delete(p.window);
    }
    if (code) { report({ status: opened ? 'failed-original-retained' : 'failed', code, name: p.name, bytesWritten: written }); return false; }
    report({ status: 'written', name: p.name, bytes: p.data.length });
    // Read only our bounded, validated projection, not caller fields/getters.
    // A concise record makes the layer visible without opening the full trace.
    // Failure to format it cannot revoke an already verified file write.
    try {
      const saved = JSON.parse(p.data), e = saved.evidence, trigger = e?.trigger;
      const primaryId = saved.multipleActions?.find(a => a.binding === 'primary-evidence')?.id;
      const action = saved.actions.find(a => a.id === primaryId);
      const flow = trigger?.status === 'matched' ? e.flows.find(f => f.traceId === trigger.traceId) : null;
      const stage = flow?.status === 'measured' ? flow.largestMeasuredStage : null;
      const summary = { actionId: action?.id || null, event: action?.event || null,
        inputMeaning: saved.triggerInterpretation?.meaning || 'native-event-only', wholeGesture: false,
        inputWaitMs: action?.inputDelayMs ?? null, uiObservedMs: action?.durationMs ?? null,
        nativeBinding: trigger?.status || 'unknown', reason: trigger?.reason || null,
        nativeCandidates: (trigger?.candidates || []).slice(0, 4).map(id => {
          const candidate = e?.flows.find(f => f.traceId === id);
          const observed = candidate?.stages.filter(s => s.depth === 0 && s.durationMs >= 0)
            .reduce((best, s) => !best || s.durationMs > best.durationMs ? s : best, null);
          return { traceId: id, status: candidate?.status || 'not-in-output',
            largestMeasuredStage: candidate?.largestMeasuredStage || null,
            largestObservedInterval: observed ? { stage: observed.name, meaning: STAGE_MEANING[observed.category],
              wallMs: observed.durationMs, qualified: candidate.status === 'measured' } : null,
            issues: candidate?.issues || [] };
        }),
        rejectedRecords: e?.rejections ? { counts: e.rejections.counts, omitted: e.rejections.omitted,
          outputOmitted: e.rejections.outputOmitted,
          firstInvalid: e.rejections.events.find(r => r.reason.startsWith('invalid-') || r.reason === 'malformed-json'
            || r.reason === 'event-not-object' || r.reason === 'unsupported-pair-scope') || null } : null,
        largestMeasuredStage: stage ? { ...stage, meaning: STAGE_MEANING[stage.category] } : null,
        stages: flow?.status === 'measured' ? flow.stages.filter(s => s.depth === 0).slice(0, 24)
          .map(s => ({ stage: s.name, meaning: STAGE_MEANING[s.category], wallMs: s.durationMs })) : [],
        cause: 'measured-layer-only; a stage is not a function or root-cause verdict',
        artifact: p.name, exportComplete: saved.exportComplete, dataLoss: saved.dataLoss };
      try { Promise.resolve(log('[Perf:InputPath] ' + JSON.stringify(summary))).catch(() => {}); } catch {}
    } catch {}
    return true;
  }
  return { publish };
}
module.exports = { createInputSnapshotWriter };
