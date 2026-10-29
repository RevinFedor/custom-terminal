// Finite SOURCE controls. No Electron, app, profile, provider or native UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { TimelineViewClient, checkedTimelineViewHeader, mergeTimelineReadClass } from './timelineViewClient.mjs';
import { TimelineViewReadModel, heldTimelineView, registerTimelineView } from './timelineViewReadModel.mjs';
import * as markers from './timelineMarkerPresentation.mjs';
import * as timelineRefresh from './timelineTranscriptRefresh.mjs';
import * as origin from '../../shared/prompt-origin.mjs';
import { registerHeldHistoryPrimaryRoot } from './historyPrimaryHeldRootRegistry.mjs';
import { readTimelineViewReview, saveTimelineViewReview, clearTimelineViewReview } from './timelineViewReviewJobs.mjs';
import { copiedHistoryMessageIteration } from './historyEntryMessageReference.mjs';
const require = createRequire(import.meta.url);
const hash = text => createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex');
const wire = packet => { packet.creditBytesUsed = 0; let size; do { size = packet.creditBytesUsed; packet.creditBytesUsed = Buffer.byteLength(JSON.stringify(packet)); } while (size !== packet.creditBytesUsed); return packet; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ count = 30, height = 20, rows, tag = 'one' } = {}) {
  const identity = { leaseId: 'lease-' + tag, ownerKey: 'owner', revision: 'a'.repeat(64), generation: 'source' };
  const values = new Map(), refs = new WeakMap(); let nextId = 0, pulls = 0, maxPulls = 0;
  const measured = new Map();
  const prefix = rank => rank * height + [...measured].reduce((sum, [at, extent]) => sum + (at < rank ? extent - height : 0), 0);
  const requests = [], released = []; let opens = 0, retains = 0, pendingDocument = false; let gate = null, corrupt = null;
  const layout = { layoutId: 'layout-' + tag, layoutRevision: 0, layoutFingerprint: 'fixture', mode: 'compact',
    viewportExtent: 100, count, totalExtent: count * height, estimated: false };
  const root = { protocol: 'history-root-v1', kind: 'array', nodeToken: 'root', ...identity, length: count };
  const header = { success: true, __notedHistoryTransport: 'root-v1', ...identity, readProfile: 'timeline-view-v1', timelineViewSchema: 1,
    semanticSnapshotComplete: true, canonicalEntryCount: count, logicalEntryCount: count, visualAtomCount: count, totalEntries: count,
    timelinePresentationIdentity: 'd'.repeat(64), timelinePresentationRevision: 0,
    semanticRevisionToken: 'b'.repeat(64), logicalRevisionToken: 'c'.repeat(64), viewRevisionToken: identity.revision, root, layoutInfo: layout,
    sourceSnapshot: { filePath: '/owned/source.jsonl', sessionId: 'session', size: 1, mtimeMs: 1, ctimeMs: 1, fileIdentity: 'file', linkKind: 'physical' } };
  const row = rank => rows?.[rank] || { uuid: 'row-' + rank, type: 'user', content: 'prompt ' + rank, timestamp: '2026-10-26T00:00:00Z',
    contentRevision: 'exact', entryRef: { viewOwnerSessionId: 'session', physicalSessionId: 'session', rawUuid: 'row-' + rank, segmentId: 'physical' } };
  const encode = (value, leaseId = identity.leaseId) => {
    if (value === null || typeof value !== 'object' && !(typeof value === 'string' && value.length > 64))
      return { kind: 'scalar', type: value === null ? 'null' : typeof value, ...(value == null ? {} : { value }) };
    if (typeof value === 'object' && refs.has(value) && refs.get(value).leaseId === leaseId) return refs.get(value);
    const kind = typeof value === 'string' ? 'text' : Array.isArray(value) ? 'array' : 'object';
    const node = { protocol: kind === 'text' ? 'history-text-v1' : 'history-root-v1', ...identity, leaseId, kind, nodeToken: 'node-' + ++nextId,
      ...(kind === 'array' || kind === 'text' ? { length: value.length } : {}), ...(kind === 'text' ? { digest: hash(value) } : {}) };
    values.set(node.nodeToken, value); if (typeof value === 'object') refs.set(value, node); return node;
  };
  const subject = rank => ({ logicalRank: rank, uuid: row(rank).uuid, canonicalOrdinal: rank, revision: header.logicalRevisionToken, logicalRevision: header.logicalRevisionToken, viewRevision: header.revision });
  const geometry = ordinal => ({ layoutId: layout.layoutId, layoutRevision: layout.layoutRevision, layoutFingerprint: layout.layoutFingerprint,
    ordinal, key: 'atom-' + ordinal, identity: 'identity-' + ordinal, start: prefix(ordinal), end: prefix(ordinal + 1),
    extent: measured.get(ordinal) || height, baseExtent: height, flexWeight: 0, estimated: false, intrinsic: false });
  const item = ordinal => ({ header: { key: 'atom-' + ordinal, visualRank: ordinal, logicalRank: ordinal, canonicalOrdinal: ordinal,
    kind: 'entry', compactClusterCount: 1 }, geometry: geometry(ordinal) });
  const invoke = async (channel, request) => {
    requests.push({ channel, ...request });
    if (channel === 'timeline:save-note') return { success: true, entryUuid: request.entryUuid, anchor: { uuid: request.entryUuid, sessionId: request.sessionId, sourceIdentity: request.sourceIdentity || 'note-source' } };
    if (['agent-transcript:subscribe', 'agent-transcript:unsubscribe', 'agent-transcript:refresh'].includes(channel)) return { success: true };
    if (channel === 'agent-transcript:release-read-root') { released.push(request.leaseId); return { success: true }; }
    if (channel === 'agent-transcript:get-timeline') {
      const result = structuredClone(header), leaseId = ++opens === 1 ? header.leaseId : header.leaseId + '-open' + opens;
      result.leaseId = leaseId; result.root.leaseId = leaseId;
      result.timelinePresentationRevision = request.timelinePresentation?.revision ?? request.timelinePresentationRevision ?? 0;
      return result;
    }
    pulls++; maxPulls = Math.max(maxPulls, pulls);
    try {
      if (gate && request.operation === gate.operation) { const current = gate; gate = null; current.entered.resolve(); await current.release.promise; }
      if (channel === 'agent-transcript:fork-read-leaf') {
        const node = encode(values.get(request.nodeToken));
        return { success: true, payloadDocument: { ...node, leaseId: 'leaf-' + node.nodeToken } };
      }
      if (request.kind === 'timeline-query') {
        const packet = { success: true, ...identity, leaseId: request.leaseId, nodeToken: root.nodeToken, kind: 'timeline-query', operation: request.operation };
        let result;
        switch (request.operation) {
          case 'status': result = { summaryEligibleCount: count, summaryCount: 0, validSemanticGroupCount: 0, outlineNewCount: 0 }; break;
          case 'offset': {
            let lo = 0, hi = count; while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (prefix(mid + 1) <= request.offset) lo = mid + 1; else hi = mid; }
            result = { hit: geometry(Math.min(count - 1, lo)), sticky: null }; break;
          }
          case 'window': { const end = Math.min(count, request.startOrdinal + request.limit); result = { items: [], nextOrdinal: end, done: end === count };
            for (let at = request.startOrdinal; at < end; at++) result.items.push(item(at)); break; }
          case 'row': result = { entry: encode(row(request.logicalRank), request.leaseId), facts: encode({ logicalRank: request.logicalRank, titleEligible: true, summaryEligible: true }, request.leaseId), subject: subject(request.logicalRank) }; break;
          case 'resolve': { const rank = request.logicalRank ?? Number(request.uuid.replace('row-', ''));
            result = { resolved: { found: Number.isInteger(rank) && rank >= 0 && rank < count, logicalRank: rank }, geometry: geometry(rank) }; break; }
          case 'range': result = { facts: { count: request.end - request.start + 1, titleEligibleCount: request.end - request.start + 1,
            startUuid: row(request.start).uuid, endUuid: row(request.end).uuid },
            startEntry: encode(row(request.start), request.leaseId), endEntry: encode(row(request.end), request.leaseId),
            startSubject: subject(request.start), endSubject: subject(request.end) }; break;
          case 'rewind': result = { facts: { entryIndex: request.logicalRank, targetIndex: request.logicalRank, rewindableCount: count, skipDuplicates: 0, menuSource: 'full-text' } }; break;
          case 'iteration': { assert(request.historyRootLease); result = { ordinal: Number(request.historyEntryIdentity.replace('row-', '')) + 1 }; break; }
          case 'resize': { layout.viewportExtent = request.viewportExtent; layout.layoutId += '-resized'; result = { layoutInfo: { ...layout } }; break; }
          case 'measure': {
            assert.equal(request.layoutRevision, layout.layoutRevision); assert(request.measurements.length <= 32);
            for (const m of request.measurements) { assert.equal(m.key, geometry(m.ordinal).key); measured.set(m.ordinal, m.intrinsicExtent); }
            layout.totalExtent = prefix(count); layout.layoutRevision++; layout.layoutId += '-measured-' + layout.layoutRevision; result = { layoutInfo: { ...layout } }; break;
          }
          case 'retain': {
            const snapshot = structuredClone(header), leaseId = 'retained-' + ++retains;
            snapshot.leaseId = leaseId; snapshot.root.leaseId = leaseId;
            snapshot.retainedSnapshot = true; snapshot.parentLeaseId = request.leaseId;
            snapshot.layoutInfo.layoutId += '-retained-' + retains;
            return snapshot;
          }
          case 'document': {
            if (pendingDocument) return { success: false, error: 'TIMELINE_DOCUMENT_PENDING_SOURCE',
              __notedHistoryTransport: 'timeline-document-pending-v1', ...identity, leaseId: request.leaseId, pendingSource: true, logicalRevision: 'logical' };
            const text = 'full Ω🙂\ud800', node = encode(text.repeat(20));
            const docIdentity = { ...identity, leaseId: 'document' };
            result = { document: { success: true, __notedHistoryTransport: 'root-v1', ...docIdentity,
              payloadDocument: { ...node, ...docIdentity }, totalChars: text.repeat(20).length, contentHash: 'source-hash-separate-from-transport', parentLeaseId: request.leaseId } }; break; }
          default: assert.fail('unexpected operation ' + request.operation);
        }
        if (request.operation === 'document') return result.document;
        if (corrupt) { const apply = corrupt; corrupt = null; return wire(apply({ ...packet, ...result })); }
        return wire({ ...packet, ...result });
      }
      const value = values.get(request.nodeToken), offset = request.offset;
      if (request.kind === 'leaf') {
        const text = value.slice(offset, offset + request.limit), end = offset + text.length;
        return wire({ success: true, ...identity, leaseId: request.leaseId, nodeToken: request.nodeToken, kind: 'leaf', offset,
          text, length: value.length, nextOffset: end, done: end === value.length });
      }
      const fields = request.kind === 'projection' ? request.fields : Object.keys(value), end = Math.min(fields.length, offset + request.limit);
      return wire({ success: true, ...identity, leaseId: request.leaseId, nodeToken: request.nodeToken, kind: request.kind, offset,
        nextOffset: end, done: end === fields.length,
        ...(request.kind === 'range' ? { length: value.length } : {}),
        items: fields.slice(offset, end).map(key => ['fields', 'projection'].includes(request.kind)
          ? { name: key, value: encode(value[key], request.leaseId) } : { ordinal: Number(key), value: encode(value[key], request.leaseId), present: true }) });
    } finally { pulls--; }
  };
  return { header, invoke, requests, released, row, layout, get maxPulls() { return maxPulls; },
    block(operation) { const entered = deferred(), release = deferred(); gate = { operation, entered, release }; return { entered: entered.promise, release: release.resolve }; },
    corrupt(apply) { corrupt = apply; }, pendingDocument() { pendingDocument = true; } };
}
async function mount(f, demand = { offset: 0, extent: 100, overscan: 50, bottom: false }) {
  const model = new TimelineViewReadModel(f.invoke);
  await model.requestWindow(demand);
  await model.refresh({ sessionId: 'session', tabId: 'tab', cwd: '/owned', timelineViewOptions: {} });
  return model;
}

test('Native content reference first, then actual client rows and existing marker body', async () => {
  process.env.NOTED_HISTORY_READER_PROCESS = '1';
  const native = require('../../main/ipc/codex-data.js')._api;
  const sessionId = '41964196-4196-4196-4196-419641964196';
  const projector = native.createCodexTimelineProjector(sessionId);
  const stamp = '2026-10-26T00:00:00Z';
  [{ type: 'session_meta', payload: { id: sessionId, cwd: '/owned' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'ordinary Ω🙂' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'answer' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'second prompt' } }]
    .forEach((record, line) => projector.feed({ ...record, timestamp: stamp, __line: line, __byteOffset: line * 100 }));
  const rows = projector.finalize(); assert.equal(rows.length, 2); assert.equal(rows[0].content, 'ordinary Ω🙂');
  const f = fixture({ rows, count: rows.length }), model = await mount(f);
  assert.deepEqual(model.snapshot().window.items.map(item => item.subject.entry), rows);
  const source = readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
  assert.match(source, /return <TimelineRootSurface key=\{owner\}/);
  assert.match(source, /renderRow=\{renderRootTimelineRow\}/);
  const start = source.indexOf('const TimelineSegmentRow ='), end = source.indexOf('\nfunction Timeline({', start);
  const ts = require('typescript'), js = ts.transpileModule(source.slice(start, end) + '\nthis.actualRow = TimelineSegmentRow;',
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const React = { memo: fn => fn, Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
  const sandbox = { React, ...markers, ...origin, getOrchestrationTag: () => null, TimelineCornerBadges: 'badges',
    Tooltip: 'tooltip', ResearchTimelineIcon: 'research', ChevronDown: 'down', ChevronRight: 'right',
    expandedPreviewCharLimit: () => 200, truncateTimelinePreviewText: s => s, renderSingleStarHighlights: s => s };
  vm.runInNewContext(js, sandbox);
  const props = { entry: rows[0], index: 0, api: {}, groupInfo: undefined, groupPresentation: undefined,
    compactClusterCount: 1, summaryText: '', isGroupExpanded: true, isCodex: true, atomPart: 'entry' };
  const rendered = sandbox.actualRow(props);
  const nodes = [], visit = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(visit);
    nodes.push(x); x.children?.forEach(visit); }; visit(rendered);
  assert.equal(nodes.filter(node => node.props?.['data-timeline-entry-uuid'] === rows[0].uuid).length, 1);
  assert.equal(nodes.find(node => Object.hasOwn(node.props || {}, 'data-timeline-marker-kind')).props['data-timeline-marker-kind'], 'ordinary');
  const note = sandbox.actualRow({ ...props, atomPart: 'note-before', hasNote: true, notePos: 'before' });
  assert.equal(note.props.style.height, '6px');
  await model.close();
});

test('viewport geometry, not a hard row cap; billion-row count never allocates a compatibility array', async () => {
  const f = fixture({ count: 1000, height: 1 }), model = await mount(f, { offset: 100, extent: 200, overscan: 100, bottom: false });
  assert.equal(model.snapshot().window.items.length, 400);
  assert(f.requests.filter(r => r.operation === 'window').every(r => r.limit <= 3));
  assert.equal(model.snapshot().window.items.at(-1).geometry.end, 400);
  await model.close();
  const huge = fixture({ count: 1_000_000_000 }), bounded = await mount(huge, { offset: 19_999_999_900, extent: 100, overscan: 20, bottom: false });
  assert.equal(bounded.snapshot().window.items.length, 6);
  assert.equal(bounded.snapshot().window.items[0].header.logicalRank, 999_999_994);
  assert(!('entries' in bounded)); assert.equal(bounded.current.client.header.totalEntries, 1_000_000_000);
  await bounded.close();
});

test('pure latest scroll settles one pull; does not OPEN or close the shared root on cancellation', async () => {
  const f = fixture(), model = await mount(f), blocked = f.block('window');
  const old = model.requestWindow({ offset: 200, extent: 100, overscan: 0, bottom: false });
  await blocked.entered;
  const latest = model.requestWindow({ offset: 400, extent: 100, overscan: 0, bottom: false });
  model.requestWindow({ offset: 300, extent: 100, overscan: 0, bottom: false });
  blocked.release(); await Promise.all([old, latest]);
  assert.equal(model.snapshot().window.offset, 300); assert.equal(f.maxPulls, 1);
  assert.equal(f.requests.filter(r => r.channel === 'agent-transcript:get-timeline').length, 1);
  assert.equal(f.released.length, 0); await model.close();
});

test('exact off-window endpoints, held labels and independent document outlive presentation owner', async () => {
  const f = fixture(), model = await mount(f), unregister = registerTimelineView({ tabId: 'tab', sessionId: 'session', cwd: '/owned' }, model);
  assert.equal(heldTimelineView({ tabId: 'tab', sessionId: 'session', cwd: '/owned' }), model);
  const off = await model.subject('row-24'); assert.equal(off.logicalRank, 24);
  const range = await model.range(24, 2); assert.equal(range.startUuid, 'row-2'); assert.equal(range.endUuid, 'row-24');
  assert.equal(range.startEntryRef.rawUuid, 'row-2');
  const client = model.current.client, release = client.retain(); await model.close();
  assert.equal(f.released.length, 0);
  assert.equal(off.subject.revision, f.header.logicalRevisionToken);
  const text = await client.document({ action: 'turn', subject: off.subject });
  const request = f.requests.find(request => request.operation === 'document');
  assert.equal(request.logicalRank.revision, f.header.logicalRevisionToken);
  assert.notEqual(request.logicalRank.revision, f.header.revision);
  assert.equal(text, 'full Ω🙂\ud800'.repeat(20)); assert(f.released.includes('document'));
  await release(); assert(f.released.includes(f.header.leaseId)); unregister();
});

test('source > metadata > view coalescing and protocol/resource errors never fetch a Native DTO', async () => {
  assert.equal(mergeTimelineReadClass('view', 'metadata'), 'metadata');
  assert.equal(mergeTimelineReadClass('metadata', 'source'), 'source');
  const f = fixture(), model = await mount(f), block = f.block('status');
  const one = model.refresh({ sessionId: 'session', timelinePresentation: { revision: 0 } }, 'view'); await block.entered;
  model.refresh({ sessionId: 'session' }, 'metadata'); model.refresh({ sessionId: 'session' }, 'source');
  block.release(); await one;
  const opens = f.requests.filter(r => r.channel === 'agent-transcript:get-timeline');
  assert.deepEqual(opens.map(r => r.timelineReadClass), ['source', 'view', 'source']);
  assert.equal(opens[1].timelineParentLease.leaseId, f.header.leaseId);
  assert.equal(opens[2].timelineParentLease.leaseId, f.header.leaseId + '-open2');
  await model.close();
  assert.throws(() => checkedTimelineViewHeader({ ...f.header, readProfile: 'timeline-primary-v1' }), /TIMELINE_VIEW_HEADER/);
  const bad = fixture(); bad.corrupt(packet => ({ ...packet, revision: 'foreign' }));
  const failed = new TimelineViewReadModel(bad.invoke);
  await failed.requestWindow({ offset: 0, extent: 100, overscan: 0, bottom: false });
  await assert.rejects(failed.refresh({ sessionId: 'session' }), /TIMELINE_VIEW_QUERY_IDENTITY/);
  assert(bad.requests.filter(r => r.channel === 'agent-transcript:get-timeline').every(r => r.readTransport === 'root-v1'));
  await failed.close();
});

test('actual measured commit preserves canonical anchor/intra-offset and uses exact batch stamp', async () => {
  const f = fixture({ count: 60 }), model = await mount(f, { offset: 205, extent: 100, overscan: 40, bottom: false });
  assert.equal(model.demand.anchor.uuid, 'row-10'); assert.equal(model.demand.anchor.intraOffset, 5);
  await model.measure([{ ordinal: 8, key: 'atom-8', identity: 'identity-8', layoutFingerprint: 'fixture', intrinsicExtent: 60 }]);
  assert.equal(model.snapshot().layout.layoutRevision, 1); assert.equal(model.snapshot().window.offset, 245);
  assert.equal(model.demand.anchor.uuid, 'row-10'); assert.equal(model.demand.anchor.intraOffset, 5);
  assert.equal(f.requests.filter(r => r.operation === 'measure').length, 1);
  await model.close();
});

test('copy iteration only queries the held root; never opens a reader for a label', async () => {
  const f = fixture(), model = await mount(f), owner = { tabId: 'tab', sessionId: 'session', cwd: '/owned', toolType: 'codex' };
  const unregister = registerTimelineView(owner, model), entry = { uuid: 'row-24', role: 'assistant' };
  const unregisterHistory = registerHeldHistoryPrimaryRoot(owner, () => ({ ...f.header, leaseId: 'history', readProfile: 'history-primary-v1' }));
  const before = f.requests.filter(r => r.channel === 'agent-transcript:get-timeline').length;
  assert.equal(await copiedHistoryMessageIteration([entry], entry, owner, () => true), 25);
  assert.equal(f.requests.filter(r => r.channel === 'agent-transcript:get-timeline').length, before);
  assert.equal(f.requests.filter(r => r.operation === 'iteration').length, 1);
  unregisterHistory(); unregister(); await model.close();
});

test('actual RootSurface hook/caller: OPEN, scroll demand, selection/range, draft and provider authority stay separate', async () => {
  const f = fixture({ count: 50 }), models = [], states = [], refs = [], memos = [], effectSlots = [];
  let cursor = 0, queuedEffects = [], layoutEffects = [], rowProps = [], renderSource = null;
  const events = new Map(), frames = new Map(); let frameId = 0;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const stateHook = initial => { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial;
    return [states[at], value => { states[at] = typeof value === 'function' ? value(states[at]) : value; }]; };
  const memoHook = (fn, deps) => { const at = cursor++; if (!memos[at] || !sameDeps(memos[at].deps, deps)) memos[at] = { value: fn(), deps }; return memos[at].value; };
  const effect = queue => (fn, deps) => { const at = cursor++;
    if (!effectSlots[at] || !sameDeps(effectSlots[at].deps, deps)) queue.push(() => {
      effectSlots[at]?.cleanup?.(); effectSlots[at] = { deps, cleanup: fn() };
    }); };
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: stateHook, useRef: initial => { const at = cursor++; return refs[at] ||= { current: initial }; },
    useMemo: memoHook, useCallback: (fn, deps) => memoHook(() => fn, deps),
    useEffect: (fn, deps) => effect(queuedEffects)(fn, deps), useLayoutEffect: (fn, deps) => effect(layoutEffects)(fn, deps),
    useSyncExternalStore: (subscribe, snapshot) => {
      const at = cursor++;
      if (!memos[at] || memos[at].subscribe !== subscribe) queuedEffects.push(() => {
        memos[at]?.unsubscribe?.();
        memos[at] = { subscribe, unsubscribe: subscribe(() => queueMicrotask(() => renderSource?.())) };
      });
      return snapshot();
    } };
  const createStore = object => Object.assign(selector => selector(object), { getState: () => object });
  const draft = { text: 'NEW USER DRAFT', chips: [{ id: 'own-chip' }], images: [{ path: '/owned/image' }] };
  const forbidden = () => assert.fail('authoring/provider/native control was called by a source read');
  const ui = createStore({ timelineTreeModeTabs: {}, timelineWidth: 200, timelineFontSize: 12,
    timelineSummaryFontSize: 11, timelineLineClamp: 3, timelinePreviewResponseLines: 3, timelineTooltipWidth: 260,
    historyPanelOpenTabs: {}, historyVisibleUuids: {}, historyPromptDrafts: { tab: draft.text },
    historyPromptDraftChips: { tab: draft.chips }, historyPromptDraftImages: { tab: draft.images },
    setHistoryPromptDraft: forbidden, showToast: message => { throw new Error('Unexpected root error: ' + message); } });
  const summary = createStore({ globalAuto: false, autoByTab: {}, globalAutoSince: 0, autoSinceByTab: {}, previousUserContextCount: 1 });
  class SourceModel extends TimelineViewReadModel { constructor(...args) { super(...args); models.push(this); } }
  const eventTarget = { addEventListener(name, callback) { (events.get(name) || (events.set(name, new Set()), events.get(name))).add(callback); },
    removeEventListener(name, callback) { events.get(name)?.delete(callback); }, dispatchEvent() {} };
  const element = { clientHeight: 100, clientWidth: 32, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 900, right: 932, top: 0, bottom: 100, height: 100 }), contains: () => false };
  const module = { exports: {} }; let generationCalls = 0, handoffSnapshot = [], handoffListener;
  const imports = {
    react: { ...React, default: React }, 'react-dom': { createPortal: value => value }, 'lucide-react': {},
    '../../utils/timelineViewReadModel.mjs': { TimelineViewReadModel: SourceModel, registerTimelineView },
    '../../utils/timelineViewClient.mjs': { TimelineViewClient, mergeTimelineReadClass },
    '../../utils/timelineViewReviewJobs.mjs': { readTimelineViewReview: () => null },
    '../../store/useUIStore': { useUIStore: ui }, '../../store/useWorkspaceStore': { useWorkspaceStore: createStore({}) },
    '../../store/useTimelineSummaryStore': { useTimelineSummaryStore: summary, refreshRootTimelineSummaries: async () => { generationCalls++; } },
    '../../store/useTimelineRootStatusStore': { publishTimelineRootStatus() {}, clearTimelineRootStatus() {} },
    '../../utils/historySearchMarkers': { useHistorySearchMarkers: createStore({ byTab: {}, markerRevisions: {} }), historySearchMarkerFlags: () => ({ match: false, current: false }) },
    '../../../shared/history-search.mjs': { historySearchEntryKeys: entry => [entry.uuid] },
    '../../utils/historyForegroundPriority.mjs': { historyForegroundPriority: { waitForBackgroundSlot: async () => ({ waitedMs: 0 }) } },
    '../../utils/timelineApplyPriority.mjs': { shouldBypassTimelineApplyPriority: () => true },
    '../../utils/historySnapshotCache': { makeHistorySnapshotKey: JSON.stringify },
    '../../utils/timelineSnapshotCache.mjs': { makeTimelineSnapshotKey: JSON.stringify },
    '../../utils/timelineTranscriptRefresh.mjs': { ...timelineRefresh, readPresentedHistorySurface: () => ({}), matchesHistorySurfacePresented: () => true },
    '../../utils/historyPromptHandoffs': { getHistoryPromptHandoffsSnapshot: () => handoffSnapshot, subscribeHistoryPromptHandoffs: (_tab, listener) => { handoffListener = listener; return () => {}; } },
    '../../utils/queuedRewindTarget.mjs': { pendingQueuedRewindTarget: () => null },
    '../../utils/terminalRegistry': { terminalRegistry: { scrollToTextInBuffer: forbidden } },
    '../../utils/historyAgentRuntimes': { getHistoryAgentRuntime: () => ({ getPresence: async () => ({ status: 'active', runtimeSnapshot: { canNativeRewind: true, canRewriteHistory: true } }) }) },
    '../../utils/timelineViewActions': { nativeTimelineViewRewind: forbidden, mutateTimelineViewRange: forbidden, rewriteTimelineViewTail: forbidden },
    '../../store/usePromptsStore': { usePromptsStore: createStore({}) }, '../../utils/geminiApiKey.mjs': { getGeminiApiKey: forbidden },
    '../../utils/copySessionFilters': {}, '../../utils/uiPerformanceDiagnostics.mjs': { uiPerformancePhase() {} },
    '../../hooks/usePointerGesture': { usePointerGesture: () => ({ start: forbidden }) }, '../../utils/generateTabTitle': {},
  };
  const ts = require('typescript'), code = ts.transpileModule(readFileSync(new URL('../components/Workspace/TimelineRootSurface.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const sandbox = { module, exports: module.exports, console, performance, AbortController, crypto: globalThis.crypto,
    require: name => imports[name] || {},
    window: { ...eventTarget, innerWidth: 1024, innerHeight: 768, require: name => { if (name === 'node:crypto') return require('node:crypto'); assert.equal(name, 'electron'); return { ipcRenderer: { invoke: f.invoke, on: eventTarget.addEventListener, removeListener: eventTarget.removeEventListener }, clipboard: { writeText: forbidden } }; } },
    document: { ...eventTarget, visibilityState: 'visible' },
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([{ contentRect: { width: 32, height: 100 } }]); } disconnect() {} unobserve() {} },
  };
  vm.runInNewContext(code, sandbox);
  const flatten = tree => { const nodes = []; const visit = value => { if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit); nodes.push(value); value.children?.forEach(visit); }; visit(tree); return nodes; };
  const props = { tabId: 'tab', sessionId: 'session', cwd: '/owned', toolType: 'codex', historySurfaceVisible: true,
    backgroundPrewarmAdmitted: true, isVisible: true, isTurnBusy: false,
    renderRow: value => { rowProps.push(value); return null; }, onUnsupportedComposite: forbidden };
  const render = () => {
    cursor = 0; rowProps = []; const tree = module.exports.TimelineRootSurface(props), nodes = flatten(tree);
    for (const node of nodes) if (node.props?.ref && typeof node.props.ref === 'object') node.props.ref.current = element;
    const layout = layoutEffects; layoutEffects = []; layout.forEach(run => run());
    const effects = queuedEffects; queuedEffects = []; effects.forEach(run => run());
    return nodes;
  };
  renderSource = render;
  render(); render(); const model = models[0]; assert(model.openPump); await model.openPump;
  let nodes = render(); assert(rowProps.length > 0);
  assert(nodes.some(node => node.props['data-timeline-root'] === 'timeline-view-v1'));
  const scroller = nodes.find(node => typeof node.props.onScroll === 'function');
  element.scrollTop = 120; scroller.props.onScroll({ currentTarget: element }); await model.windowPump;
  nodes = render(); assert.equal(model.snapshot().window.offset, 120);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, 1);
  const start = rowProps[0], finish = rowProps.at(-1);
  await start.api.handleEntryDoubleClick(start.entry); render();
  await finish.api.handleEntryClick(finish.entry, { preventDefault() {}, stopPropagation() {} }); nodes = render();
  const range = f.requests.filter(request => request.operation === 'range').at(-1);
  assert(range.start < range.end); assert.equal(range.start, start.index); assert.equal(range.end, finish.index);
  assert.equal(ui.getState().historyPromptDrafts.tab, draft.text);
  assert.equal(ui.getState().historyPromptDraftChips.tab, draft.chips);
  assert.equal(ui.getState().historyPromptDraftImages.tab, draft.images);
  assert(f.requests.every(request => !/get-history|run-command|open-history-menu|stop-ai|saved-history|delete-range|edit-range/.test(request.channel)));
  // Enable the existing auto policy explicitly, then prove that scrolling
  // cannot create another generation or OPEN. The generator itself is a Source
  // counter; no provider/SDK is invoked.
  summary.getState().globalAuto = true; render();
  await Promise.resolve(); await model.openPump; render();
  assert.equal(generationCalls, 1);
  const opensBeforeScroll = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length;
  const latestScroller = render().find(node => typeof node.props.onScroll === 'function');
  element.scrollTop = 240; latestScroller.props.onScroll({ currentTarget: element }); await model.windowPump; render();
  assert.equal(generationCalls, 1);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, opensBeforeScroll);
  // Non-quiet presentation inputs use the real existing projectors. Foreign
  // tool/session events cannot alter this reader; exact events reach payload.
  const dispatchIpc = (name, detail) => { for (const listener of events.get(name) || []) listener(null, detail); };
  const beforeForeign = f.requests.length;
  dispatchIpc('agent-transcript:live-message', { tabId: 'tab', sessionId: 'other', toolType: 'codex' });
  assert.equal(f.requests.length, beforeForeign);
  const detail = { tabId: 'tab', sessionId: 'session', toolType: 'codex', timestamp: '2026-10-26T01:00:00Z',
    message: { type: 'user', uuid: 'owned-live', sourceIdentity: 'owned-source', message: { content: [{ type: 'text', text: 'complete live input' }] } } };
  dispatchIpc('agent-transcript:live-message', detail); await model.openPump; render();
  let opening = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(opening.timelinePresentation.liveEntries[0].uuid, 'owned-live');
  assert.equal(opening.timelinePresentation.liveEntries[0].content, 'complete live input');
  handoffSnapshot = [{ handoffId: 'owned-handoff', toolType: 'codex', queueStatus: 'sent', text: 'audited sent input', source: 'terminal-mcp',
    auditProof: { sessionId: 'session', entryUuid: 'row-4', sourceIdentity: 'source-4', auditTimestamp: '2026-10-26T01:00:01Z' } }];
  handoffListener(handoffSnapshot, { type: 'audit', handoffId: 'owned-handoff' }); await model.openPump; render();
  opening = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(opening.timelinePresentation.sentHandoffs[0].uuid, 'row-4');
  assert.equal(opening.timelinePresentation.sentHandoffs[0].isSentHandoffProjection, true);
  dispatchIpc('tab-work-context:changed', { tabId: 'other', files: [{ path: '/foreign' }] });
  const beforeFiles = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length;
  dispatchIpc('tab-work-context:changed', { tabId: 'tab', files: [{ path: '/owned/context' }] }); await model.openPump; render();
  opening = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(opening.timelineReadClass, 'metadata');
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, beforeFiles + 1);
  assert.equal(Object.hasOwn(opening.timelinePresentation, 'workingFiles'), false, 'SQL producer owns file inventory');
  assert(!f.requests.some(request => request.channel === 'tab-work-context:get'), 'root never loads full work context');
  let currentRows = rowProps;
  await currentRows[0].api.handleRightClick({ preventDefault() {}, stopPropagation() {}, clientY: 90 }, currentRows[0].entry);
  nodes = render();
  // Run the actual Workspace capture callback against the actual portal's
  // attributes. Stopping bubble in the popup cannot undo an earlier collapse.
  const popupBoundary = nodes.find(node => node.props?.style?.position === 'fixed'
    && typeof node.props.onMouseDown === 'function' && typeof node.props.onClick === 'function');
  assert(popupBoundary);
  const workspaceSource = readFileSync(new URL('../components/Workspace/Workspace.tsx', import.meta.url), 'utf8');
  const effectStart = workspaceSource.indexOf('// Expanded Timeline overlays the center.');
  const captureStart = workspaceSource.indexOf('const onDown =', effectStart);
  const captureEnd = workspaceSource.indexOf("window.addEventListener('mousedown', onDown, true)", captureStart);
  assert(effectStart >= 0 && captureStart > effectStart && captureEnd > captureStart);
  const captureCode = ts.transpileModule(workspaceSource.slice(captureStart, captureEnd)
    + ';globalThis.captureTimelineOutside = onDown;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const treeBefore = ui.getState().timelineTreeModeTabs.tab, collapsed = [];
  const captureContext = { effectiveTab: { id: 'tab' }, useUIStore: ui,
    setTimelineTreeMode(tab, value) { collapsed.push({ tab, value }); ui.getState().timelineTreeModeTabs[tab] = value; } };
  vm.runInNewContext(captureCode, captureContext);
  ui.getState().timelineTreeModeTabs.tab = true;
  const boundary = { getAttribute: key => popupBoundary.props[key] };
  const popupTarget = { closest: selector => selector.split(',').some(part =>
    Object.hasOwn(popupBoundary.props, part.trim().slice(1, -1))) ? boundary : null };
  captureContext.captureTimelineOutside({ target: popupTarget });
  let bubbleStopped = false;
  popupBoundary.props.onMouseDown({ stopPropagation() { bubbleStopped = true; } });
  assert(bubbleStopped);
  assert.equal(ui.getState().timelineTreeModeTabs.tab, true, 'portal menu belongs to the expanded Timeline during capture');
  assert.equal(collapsed.length, 0);
  captureContext.captureTimelineOutside({ target: { closest: () => null } });
  assert.equal(ui.getState().timelineTreeModeTabs.tab, false, 'real outside click still collapses the overlay');
  assert.deepEqual(collapsed, [{ tab: 'tab', value: false }]);
  ui.getState().timelineTreeModeTabs.tab = treeBefore;
  const addNote = nodes.find(node => node.type === 'button' && node.children.includes('Заметка'));
  assert(addNote); addNote.props.onClick(); nodes = render();
  const textarea = nodes.find(node => node.type === 'textarea'); assert(textarea);
  textarea.props.onChange({ target: { value: 'owned note draft' } }); nodes = render();
  const saveNote = nodes.find(node => node.type === 'button' && node.children.includes('Сохранить')); assert(saveNote);
  await saveNote.props.onClick(); render();
  opening = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(opening.timelinePresentation.noteAnchors.length, 1);
  assert.equal(opening.timelinePresentation.noteAnchors[0].sessionId, 'session');
  renderSource = null; for (const memo of memos) memo?.unsubscribe?.();
  effectSlots.forEach(slot => slot?.cleanup?.()); await model.close();
});

test('strict header strips DTO extensions and preserves distinct semantic/view/source coordinates', () => {
  const f = fixture(), header = checkedTimelineViewHeader({ ...f.header, entries: ['not retained'], allUuids: ['not retained'],
    root: { ...f.header.root, hiddenGraph: ['not retained'] }, layoutInfo: { ...f.layout, heights: ['not retained'] } });
  assert.equal(header.logicalRevisionToken, 'c'.repeat(64)); assert.equal(header.semanticRevisionToken, 'b'.repeat(64)); assert.equal(header.viewRevisionToken, 'a'.repeat(64));
  assert(!('entries' in header)); assert(!('allUuids' in header)); assert(!('hiddenGraph' in header.root)); assert(!('heights' in header.layoutInfo));
  assert.throws(() => checkedTimelineViewHeader({ ...f.header, revision: 'c'.repeat(64) }), /TIMELINE_VIEW_HEADER/);
});

test('allocating Full cancellation releases its independent child after parent presentation closes', async () => {
  const f = fixture(), model = await mount(f), client = model.current.client, controller = new AbortController(), block = f.block('document');
  const reading = client.document({ action: 'full', subject: { logicalRank: 1 } }, { signal: controller.signal });
  await block.entered; controller.abort(); await model.close(); assert.equal(f.released.length, 0);
  block.release(); await assert.rejects(reading, /HISTORY_READ_CANCELLED/);
  assert.equal(f.released.filter(id => id === 'document').length, 1);
  assert.equal(f.released.filter(id => id === f.header.leaseId).length, 1);
});

test('only typed stronger read refusal can recompose; source invalidation has no retry/fallback', async () => {
  const f = fixture(), model = await mount(f), old = model.opener; let refusal = true;
  model.opener = async (invoke, payload, options) => {
    if (refusal) { refusal = false; throw Object.assign(new Error('TIMELINE_VIEW_RECOMPOSE_REQUIRED'), {
      code: 'TIMELINE_VIEW_RECOMPOSE_REQUIRED', requiredClass: 'metadata' }); }
    return old(invoke, payload, options);
  };
  await model.refresh({ sessionId: 'session' }, 'view');
  assert.equal(f.requests.filter(r => r.channel === 'agent-transcript:get-timeline').at(-1).timelineReadClass, 'metadata');
  const count = f.requests.length;
  model.opener = async () => { throw Object.assign(new Error('CODEX_SOURCE_READ_INVALIDATED'), { code: 'CODEX_SOURCE_READ_INVALIDATED' }); };
  await assert.rejects(model.refresh({ sessionId: 'session' }, 'source'), /CODEX_SOURCE_READ_INVALIDATED/);
  assert.equal(f.requests.length, count); assert.equal(model.snapshot().error.code, 'CODEX_SOURCE_READ_INVALIDATED');
  await model.close();
});

test('explicit review survives presentation unmount and closes only its own reader pin', async () => {
  const f = fixture(), model = await mount(f), owner = { tabId: 'review', sessionId: 'session', cwd: '/owned' };
  const value = { client: model.current.client, facts: await model.range(1, 2), sourceContent: 'BodyOPEN range', initialCompact: 'review' };
  saveTimelineViewReview(owner, value); await model.close(); assert.equal(f.released.length, 0);
  assert.equal(readTimelineViewReview(owner), value); clearTimelineViewReview(owner);
  // Reader release is queued exactly once by the signed reader, no new OPEN.
  await value.client.reader.releasePromise;
  assert.equal(f.released.filter(id => id === f.header.leaseId).length, 1);
});

test('actual action adapters forward reader facts/exact endpoints; UNKNOWN mutation cannot replay/restart', async () => {
  const ts = require('typescript'), source = readFileSync(new URL('./timelineViewActions.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }, requests = [], scenarios = [], rewrites = [], adopted = [];
  let unknown = false, finished = 0;
  const invoke = async (channel, payload) => {
    requests.push({ channel, payload });
    if (channel === 'history-mutation:begin') return { tabId: 'tab', operationId: 'reservation' };
    if (channel === 'history-mutation:finish') { finished++; return { success: true }; }
    if (channel === 'terminal:getCommandState') return { isRunning: false };
    if (channel === 'codex:delete-range' && payload.validateOnly) return { success: true };
    if (channel === 'codex:delete-range') { if (unknown) throw new Error('UNKNOWN'); return { success: true, committed: true, newSessionId: 'child', removedCount: 4 }; }
    if (channel === 'codex:run-command') return { success: true, accepted: true };
    assert.fail(channel);
  };
  const imports = {
    './agentScenarios': { rewindAgentTimelineScenario: async args => { scenarios.push(args); return { success: true }; } },
    './historyAgentRuntimes': { getHistoryAgentRuntime: () => ({}) },
    '../store/useWorkspaceStore': { useWorkspaceStore: { getState: () => ({ getCodexSessionId: () => 'session', setCodexSessionId: async (...args) => { adopted.push(args); return true; } }) } },
    '../store/useUIStore': { useUIStore: { getState: () => ({ showToast() {} }) } },
    './historyOperationActivity.mjs': { beginHistoryOperationActivity: () => ({ id: 'operation', setPhase() {}, finish() {} }) },
    './codexLaunch': { getCodexHistoryMutationSettingsProof: () => null, buildCodexRunPayload: value => value, buildCodexHistoryMutationResumePayload: value => value },
    './historyRewriteRewind': { executeHistoryRewriteRewindScenario: async args => { rewrites.push(args); return {}; } },
  };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name], console,
    window: { require: name => { assert.equal(name, 'electron'); return { ipcRenderer: { invoke } }; }, dispatchEvent() {} },
    CustomEvent: class { constructor(name, args) { this.type = name; this.detail = args.detail; } } });
  let pins = 0;
  const client = { retain: () => { pins++; return async () => { pins--; }; }, query: async () => ({ targetIndex: 17, rewindableCount: 30, skipDuplicates: 2, menuSource: 'full-text' }) };
  const entry = { uuid: 'exact-start', type: 'user', content: 'full exact prompt', contentRevision: 'rev', entryRef: { rawUuid: 'native-start', viewOwnerSessionId: 'session' } };
  const subject = { client, entry, logicalRank: 24 }, address = { tabId: 'tab', sessionId: 'session', cwd: '/owned' };
  await module.exports.nativeTimelineViewRewind(address, subject, client);
  assert.equal(scenarios[0].targetIndex, 17); assert.equal(scenarios[0].rewindableCount, 30); assert.equal(scenarios[0].skipDuplicates, 2);
  assert.equal(scenarios[0].targetEntryRef, entry.entryRef); assert.equal(pins, 0);
  const range = { count: 4, startUuid: entry.uuid, endUuid: 'exact-end', startEntryRef: entry.entryRef,
    endEntryRef: { rawUuid: 'native-end' }, expectedContentRevision: 'rev' };
  await module.exports.rewriteTimelineViewTail(address, subject, range);
  assert.equal(rewrites[0].target.endUuid, range.endUuid); assert.equal(rewrites[0].target.entryRef, entry.entryRef);
  await module.exports.mutateTimelineViewRange(address, range);
  assert.equal(adopted.length, 1); assert.equal(finished, 1);
  const mutations = requests.filter(request => request.channel === 'codex:delete-range');
  assert(mutations.every(request => request.payload.startEntryRef === entry.entryRef && request.payload.endEntryRef === range.endEntryRef));
  unknown = true; requests.length = 0;
  await assert.rejects(module.exports.mutateTimelineViewRange(address, range), /UNKNOWN/);
  assert.equal(requests.filter(request => request.channel === 'codex:delete-range' && !request.payload.validateOnly).length, 1);
  assert.equal(requests.filter(request => request.channel === 'codex:run-command').length, 0); assert.equal(finished, 2);
});

test('cold background action has an independent exact reader without a painted viewport', async () => {
  const f = fixture(), model = new TimelineViewReadModel(f.invoke), wait = deferred(), entered = deferred();
  const action = model.withActionSubject('row-24', { sessionId: 'session', tabId: 'tab', cwd: '/owned' }, async (subject, client) => {
    assert.equal(subject.logicalRank, 24); assert.equal(subject.entry.entryRef.rawUuid, 'row-24');
    entered.resolve(); await wait.promise;
    const facts = await client.query('rewind', { logicalRank: subject.logicalRank }); return facts.targetIndex;
  });
  await entered.promise; assert.equal(model.snapshot(), null); await model.close();
  assert.equal(f.released.length, 0); wait.resolve(); assert.equal(await action, 24);
  assert.equal(f.requests.filter(request => request.operation === 'window').length, 0);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, 1);
  assert.equal(f.released.filter(id => id === f.header.leaseId).length, 1);
});

test('typed pending document preserves the current root and cannot return preview bytes', async () => {
  const f = fixture(), model = await mount(f); f.pendingDocument();
  await assert.rejects(model.current.client.document({ action: 'prompt', subject: { logicalRank: 1 } }), error => {
    assert.equal(error.code, 'TIMELINE_DOCUMENT_PENDING_SOURCE'); assert.equal(error.pendingSource, true); return true;
  });
  assert.equal(model.current.client.closed, false); assert.equal(f.released.length, 0);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, 1);
  await model.close();
});

test('retained action snapshot outlives UI with unchanged logical/view tokens and no OPEN/build', async () => {
  const f = fixture(), model = await mount(f), original = model.current.client;
  const retained = await original.retainSnapshot();
  assert.equal(retained.header.retainedSnapshot, true); assert.equal(retained.header.parentLeaseId, original.identity.leaseId);
  assert.notEqual(retained.identity.leaseId, original.identity.leaseId);
  assert.equal(retained.header.logicalRevisionToken, original.header.logicalRevisionToken);
  assert.equal(retained.header.viewRevisionToken, original.header.viewRevisionToken);
  assert.notEqual(retained.layout.layoutId, original.layout.layoutId);
  await model.close(); assert(f.released.includes(original.identity.leaseId));
  const row = await retained.row(24); assert.equal(row.subject.revision, f.header.logicalRevisionToken);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, 1);
  await retained.close(); assert(f.released.includes(retained.identity.leaseId));
});

test('viewport-only resize calls existing layout query and never opens/rebuilds a Timeline', async () => {
  const f = fixture(), model = await mount(f), before = model.current.client.layout.layoutId;
  await model.resizeViewport(160);
  assert.equal(model.snapshot().layout.viewportExtent, 160); assert.notEqual(model.snapshot().layout.layoutId, before);
  assert.equal(model.snapshot().window.items.length, 11);
  assert.equal(f.requests.filter(request => request.operation === 'resize').length, 1);
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, 1);
  await model.close();
});

test('ordinary bottom policy follows new logical entries, while same-count metadata keeps position', async () => {
  const f = fixture({ count: 30 }), model = await mount(f, { offset: 80, extent: 100, overscan: 40, bottom: false });
  const appended = fixture({ count: 31, tag: 'append' });
  model.opener = async () => new TimelineViewClient(appended.invoke, appended.header);
  await model.refresh({ sessionId: 'session' }, 'source');
  assert.equal(model.snapshot().window.offset, 520); assert.equal(model.demand.bottom, true);
  await model.requestWindow({ offset: 80, extent: 100, overscan: 40, bottom: false });
  const metadata = fixture({ count: 31, tag: 'metadata' });
  model.opener = async () => new TimelineViewClient(metadata.invoke, metadata.header);
  await model.refresh({ sessionId: 'session' }, 'metadata');
  assert.equal(model.snapshot().window.offset, 80); assert.equal(model.demand.bottom, false);
  await model.close();
});

test('producer presentation revision admits strict view identity; changed input strengthens to metadata', async () => {
  const f = fixture(), model = await mount(f);
  const unchanged = { revision: 0, sentHandoffs: [], liveEntries: [], noteAnchors: [] };
  await model.refresh({ sessionId: 'session', timelinePresentation: unchanged }, 'view');
  let request = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(request.timelineReadClass, 'view'); assert.equal(Object.hasOwn(request, 'timelinePresentation'), false);
  assert.equal(request.timelinePresentationIdentity, f.header.timelinePresentationIdentity);
  const changed = { ...unchanged, revision: 1, liveEntries: [{ uuid: 'point', type: 'user', content: 'exact volatile owner' }] };
  await model.refresh({ sessionId: 'session', timelinePresentation: changed }, 'view');
  request = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').at(-1);
  assert.equal(request.timelineReadClass, 'metadata'); assert.equal(request.timelinePresentation, changed);
  assert.equal(Object.hasOwn(request, 'timelinePresentationIdentity'), false);
  await model.close();
});

test('painted root stays leased until exact React commit and gates the next coalesced OPEN', async () => {
  const f = fixture(), model = new TimelineViewReadModel(f.invoke, { deferPreviousRelease: true });
  await model.requestWindow({ offset: 0, extent: 100, overscan: 20, bottom: false });
  await model.refresh({ sessionId: 'session' }); const first = model.current.client.identity.leaseId;
  model.commitPresentation(model.snapshot().adoption);
  await model.refresh({ sessionId: 'session' }, 'metadata');
  assert(!f.released.includes(first)); const adoption = model.snapshot().adoption;
  const before = f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length;
  const next = model.refresh({ sessionId: 'session' }, 'source');
  assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, before);
  model.commitPresentation(adoption - 1); assert(!f.released.includes(first));
  model.commitPresentation(adoption); await next;
  assert(f.released.includes(first)); assert.equal(f.requests.filter(request => request.channel === 'agent-transcript:get-timeline').length, before + 1);
  await model.close(); assert.equal(new Set(f.released).size, 3);
});

test('finite heap envelope', () => {
  const memory = process.memoryUsage(); assert(memory.heapTotal <= 128 * 1024 ** 2);
  console.log('SOURCE heapTotalMiB=' + (memory.heapTotal / 1024 ** 2).toFixed(2));
});

function actualRootScrollHandler(dependencies) {
  const source = readFileSync(new URL('../components/Workspace/TimelineRootSurface.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('onScroll={event => {');
  const end = source.indexOf('\n        }}>', start);
  assert(start > 0 && end > start, 'actual physical-scroll callback must be present');
  const callback = source.slice(start + 'onScroll={'.length, end) + '\n}';
  const sandbox = { ...dependencies };
  vm.runInNewContext('globalThis.onScroll = ' + callback + ';', sandbox);
  return sandbox.onScroll;
}

test('actual root scroll can leave the tail of a 20px compact overflow', async () => {
  const f = fixture({ count: 16, height: 20 }); f.layout.viewportExtent = 300;
  const model = await mount(f, { offset: 0, extent: 300, overscan: 150, bottom: true });
  try {
    assert.equal(model.snapshot().window.offset, 20);
    const desiredOffset = { current: 20 }, bottom = { current: true }; let pending;
    const onScroll = actualRootScrollHandler({ layout: model.snapshot().layout, physical: { current: { origin: 0 } },
      desiredOffset, bottom, demand(offset, follows) {
        desiredOffset.current = offset; bottom.current = follows;
        pending = model.requestWindow({ offset, extent: 300, overscan: 150, bottom: follows });
      } });
    onScroll({ currentTarget: { scrollTop: 0, clientHeight: 300 } }); await pending;
    assert.equal(model.demand.bottom, false, 'an upward user scroll must not become a tail demand');
    assert.equal(model.snapshot().window.offset, 0, 'the real read model must keep the first row reachable');
  } finally { await model.close(); }
});

test('actual root scroll does not re-arm follow from its own committed offset', () => {
  const writes = [], desiredOffset = { current: 0 }, bottom = { current: false };
  const onScroll = actualRootScrollHandler({ layout: { totalExtent: 320 }, physical: { current: { origin: 0 } },
    desiredOffset, bottom, demand: (...args) => writes.push(args) });
  onScroll({ currentTarget: { scrollTop: 0, clientHeight: 300 } });
  assert.equal(writes.length, 0, 'a programmatic commit is not a new physical follow intent');
  assert.equal(bottom.current, false);
});

test('actual root scroll preserves downward tail entry, resize clamp and global corridor coordinates', () => {
  const cases = [
    { total: 320, height: 300, before: 0, top: 15, follows: true },
    { total: 300, height: 300, before: 20, top: 0, follows: true },
    { total: 940.5, height: 300, before: 640.5, top: 140.5, follows: false },
    { total: 940.5, height: 300, before: 300, top: 610.5, follows: true },
    { total: 2000000, height: 300, before: 1499000, origin: 500000, top: 999700, follows: false },
  ];
  for (const row of cases) {
    const writes = [];
    const onScroll = actualRootScrollHandler({ layout: { totalExtent: row.total },
      physical: { current: { origin: row.origin || 0 } }, desiredOffset: { current: row.before },
      bottom: { current: true }, demand: (...args) => writes.push(args) });
    onScroll({ currentTarget: { scrollTop: row.top, clientHeight: row.height } });
    assert.equal(writes.length, 1); assert.equal(writes[0][0], row.top + (row.origin || 0));
    assert.equal(writes[0][1], row.follows);
  }
});
