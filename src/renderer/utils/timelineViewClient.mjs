import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';
import { HistoryRootClient, historyRootIdentity, isHistoryRootDescriptor } from './historyRootReadClient.mjs';
import { readHistoryThroughIpc } from './historyReadTransport.mjs';
import { readTimelineSelectedValue } from './timelineRootReadModel.mjs';

export const TIMELINE_VIEW_PROFILE = 'timeline-view-v1';
const identityFields = ['leaseId', 'ownerKey', 'revision', 'generation'];
const same = (a, b) => identityFields.every(key => a?.[key] === b?.[key]);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const extent = n => Number.isFinite(n) && n >= 0;
export const timelineViewError = code => Object.assign(new Error(code), { code });
export const mergeTimelineReadClass = (a, b) => !a ? b : a === 'source' || b === 'source' ? 'source'
  : a === 'metadata' || b === 'metadata' ? 'metadata' : 'view';
const assert = (yes, code) => { if (!yes) throw timelineViewError(code); };
const live = (signal, owns) => assert(!signal?.aborted && owns(), 'HISTORY_READ_CANCELLED');
const always = () => true;
export function checkedTimelineLayout(layout) {
  assert(layout && typeof layout.layoutId === 'string' && integer(layout.layoutRevision)
    && typeof layout.layoutFingerprint === 'string' && ['compact', 'expanded'].includes(layout.mode)
    && extent(layout.viewportExtent) && extent(layout.totalExtent) && integer(layout.count)
    && typeof layout.estimated === 'boolean', 'TIMELINE_VIEW_LAYOUT');
  const result = { layoutId: layout.layoutId, layoutRevision: layout.layoutRevision,
    layoutFingerprint: layout.layoutFingerprint, mode: layout.mode, viewportExtent: layout.viewportExtent,
    count: layout.count, totalExtent: layout.totalExtent, estimated: layout.estimated };
  for (const key of ['baseExtent', 'flexWeight', 'estimatedCount', 'maxWindowItems']) {
    if (Object.hasOwn(layout, key)) { assert(extent(layout[key]), 'TIMELINE_VIEW_LAYOUT'); result[key] = layout[key]; }
  }
  for (const key of ['physicalRebaseRequired', 'readOnly']) {
    if (Object.hasOwn(layout, key)) { assert(typeof layout[key] === 'boolean', 'TIMELINE_VIEW_LAYOUT'); result[key] = layout[key]; }
  }
  return Object.freeze(result);
}
export function checkedTimelineViewHeader(header) {
  historyRootIdentity(header);
  assert(header?.success === true && header.__notedHistoryTransport === 'root-v1'
    && header.readProfile === TIMELINE_VIEW_PROFILE && header.timelineViewSchema === 1
    && header.semanticSnapshotComplete === true && isHistoryRootDescriptor(header.root)
    && same(header, header.root) && header.root.protocol === 'history-root-v1' && header.root.kind === 'array'
    && typeof header.root.nodeToken === 'string' && header.root.nodeToken.length > 0 && header.root.nodeToken.length <= 8192
    && integer(header.canonicalEntryCount) && integer(header.logicalEntryCount)
    && integer(header.visualAtomCount) && header.visualAtomCount === header.totalEntries
    && header.root.length === header.visualAtomCount
    && typeof header.semanticRevisionToken === 'string' && /^[a-f0-9]{64}$/.test(header.semanticRevisionToken)
    && /^[a-f0-9]{64}$/.test(header.viewRevisionToken) && header.viewRevisionToken === header.revision
    && /^[a-f0-9]{64}$/.test(header.logicalRevisionToken)
    && /^[a-f0-9]{64}$/.test(header.timelinePresentationIdentity) && integer(header.timelinePresentationRevision),
  'TIMELINE_VIEW_HEADER');
  const layoutInfo = checkedTimelineLayout(header.layoutInfo);
  assert(layoutInfo.count === header.visualAtomCount, 'TIMELINE_VIEW_LAYOUT_COUNT');
  const snapshot = header.sourceSnapshot;
  assert(snapshot && typeof snapshot.filePath === 'string' && typeof snapshot.sessionId === 'string'
    && extent(snapshot.size) && extent(snapshot.mtimeMs) && extent(snapshot.ctimeMs), 'TIMELINE_VIEW_SOURCE');
  // Retain only the header vocabulary; peer extensions cannot smuggle a DTO.
  return Object.freeze({ success: true, __notedHistoryTransport: 'root-v1', ...historyRootIdentity(header),
    readProfile: header.readProfile, timelineViewSchema: 1, semanticSnapshotComplete: true,
    canonicalEntryCount: header.canonicalEntryCount, logicalEntryCount: header.logicalEntryCount,
    visualAtomCount: header.visualAtomCount, totalEntries: header.totalEntries, root: Object.freeze({ protocol: header.root.protocol, kind: header.root.kind, nodeToken: header.root.nodeToken,
      ...historyRootIdentity(header.root), length: header.root.length }),
    timelinePresentationIdentity: header.timelinePresentationIdentity, timelinePresentationRevision: header.timelinePresentationRevision,
    semanticRevisionToken: header.semanticRevisionToken, logicalRevisionToken: header.logicalRevisionToken, viewRevisionToken: header.viewRevisionToken,
    sourceSnapshot: Object.freeze({ filePath: snapshot.filePath, sessionId: snapshot.sessionId,
      size: snapshot.size, mtimeMs: snapshot.mtimeMs, ctimeMs: snapshot.ctimeMs,
      fileIdentity: snapshot.fileIdentity, sourceGeneration: snapshot.sourceGeneration, linkKind: snapshot.linkKind }),
    layoutInfo, ...(header.retainedSnapshot === true ? { retainedSnapshot: true, parentLeaseId: header.parentLeaseId } : {}) });
}

// One parent pull, including selected descriptor pages. Cancellation of a
// viewport only discards its result; it never closes the shared root reader.
export class TimelineViewClient {
  constructor(invoke, header) {
    this.header = checkedTimelineViewHeader(header); this.invoke = invoke;
    this.identity = historyRootIdentity(header); this.root = header.root;
    this.reader = new HistoryRootClient(invoke, header.root, { pageBytes: 16384, pageItems: 3 });
    this.layout = this.header.layoutInfo; this.lane = { pending: null }; this.closed = false;
    this.references = new Set(['owner']);
  }
  async pull(operation, { signal, owns = always } = {}) {
    while (this.lane.pending) { await this.lane.pending.catch(() => {}); live(signal, owns); }
    live(signal, () => !this.closed && owns());
    const task = Promise.resolve().then(() => { live(signal, () => !this.closed && owns()); return operation(); });
    this.lane.pending = task;
    try { const value = await task; live(signal, () => !this.closed && owns()); return value; }
    finally { if (this.lane.pending === task) this.lane.pending = null; }
  }
  async query(operation, args = {}, options = {}) {
    const result = await this.pull(() => this.invoke('agent-transcript:read-page', {
      ...this.identity, nodeToken: this.root.nodeToken, kind: 'timeline-query', operation,
      creditBytes: 16384, ...args,
    }), options);
    try {
    if (result?.success === false) {
      for (const key of identityFields) if (Object.hasOwn(result, key)) assert(result[key] === this.identity[key], 'TIMELINE_VIEW_QUERY_IDENTITY');
      const error = timelineViewError(result.error || 'TIMELINE_VIEW_QUERY_FAILED');
      if (result.__notedHistoryTransport === 'timeline-document-pending-v1') {
        assert(operation === 'document' && same(result, this.identity) && result.pendingSource === true
          && typeof result.logicalRevision === 'string', 'TIMELINE_VIEW_DOCUMENT_PENDING');
        error.pendingSource = true; error.logicalRevision = result.logicalRevision;
      }
      throw error;
    }
    if (operation === 'retain') {
      assert(result?.success === true && result.retainedSnapshot === true && result.parentLeaseId === this.identity.leaseId
        && result.leaseId !== this.identity.leaseId && result.ownerKey === this.identity.ownerKey
        && result.generation === this.identity.generation && result.revision === this.identity.revision
        && new TextEncoder().encode(JSON.stringify(result)).byteLength <= 16384, 'TIMELINE_VIEW_RETAIN');
      checkedTimelineViewHeader(result);
      return { snapshot: result };
    }
    if (operation === 'document') {
      // The actual query wire returns the independent child root header, not
      // a parent query packet. It must bind back to this exact parent lease.
      assert(result?.success === true && result.__notedHistoryTransport === 'root-v1'
        && result.parentLeaseId === this.identity.leaseId && result.leaseId !== this.identity.leaseId
        && same(result, result.payloadDocument)
        && new TextEncoder().encode(JSON.stringify(result)).byteLength <= 16384, 'TIMELINE_VIEW_DOCUMENT');
      return { document: result };
    }
    assert(same(result, this.identity) && result.nodeToken === this.root.nodeToken
      && result.kind === 'timeline-query' && result.operation === operation, 'TIMELINE_VIEW_QUERY_IDENTITY');
    assert(integer(result.creditBytesUsed) && result.creditBytesUsed <= 16384
      && new TextEncoder().encode(JSON.stringify(result)).byteLength === result.creditBytesUsed, 'TIMELINE_VIEW_QUERY_CREDIT');
    if (operation === 'window') assert(Array.isArray(result.items) && result.items.length <= 3, 'TIMELINE_VIEW_WINDOW_CREDIT');
    if (operation === 'resolve') {
      assert(result.resolved && typeof result.resolved.found === 'boolean', 'TIMELINE_VIEW_RESOLVE');
      return Object.freeze({ ...result.resolved, geometry: result.geometry });
    }
    if (operation === 'rewind') {
      assert(result.facts && integer(result.facts.entryIndex), 'TIMELINE_VIEW_REWIND');
      return Object.freeze({ ...result.facts });
    }
    if (operation === 'range') {
      const facts = result.facts;
      assert(facts && integer(facts.count) && facts.count === args.end - args.start + 1, 'TIMELINE_VIEW_RANGE');
      const start = await this.endpoint(result.startEntry, options), end = args.start === args.end ? start : await this.endpoint(result.endEntry, options);
      assert(start?.uuid === facts.startUuid && end?.uuid === facts.endUuid, 'TIMELINE_VIEW_RANGE_ENDPOINTS');
      return Object.freeze({ ...facts, startLogicalRank: args.start, endLogicalRank: args.end,
        startEntryRef: start.entryRef, endEntryRef: end.entryRef,
        expectedContentRevision: start.contentRevision, geometry: result.geometry, identity: this.identity,
        startSubject: this.subject(result.startSubject, args.start, start.uuid), endSubject: this.subject(result.endSubject, args.end, end.uuid) });
    }
    if (operation === 'note-neighbour') {
      if (!result.found) return Object.freeze({ target: null });
      const entry = await this.decode(result.entry, options);
      assert(typeof entry?.uuid === 'string' && ['before', 'after'].includes(result.position), 'TIMELINE_VIEW_NOTE_NEIGHBOUR');
      return Object.freeze({ target: { entryUuid: entry.uuid, sourceIdentity: entry.sourceIdentity,
        position: result.position, logicalRank: result.logicalRank } });
    }
    if (operation === 'status') {
      assert(['summaryEligibleCount', 'summaryCount', 'validSemanticGroupCount', 'outlineNewCount'].every(key => integer(result[key])), 'TIMELINE_VIEW_STATUS');
      return Object.freeze({ ...result, eligibleCount: result.summaryEligibleCount, outlineCount: result.validSemanticGroupCount });
    }
    return result;
    } catch (error) {
      if (operation === 'document' || operation === 'retain') await this.discardDocument(result?.document || result?.snapshot || result);
      throw error;
    }
  }
  async discardDocument(header) {
    let identity;
    try { identity = historyRootIdentity(header); } catch { return; }
    if (identity.leaseId === this.identity.leaseId) return;
    try { await this.invoke('agent-transcript:release-read-root', identity); }
    catch (error) { console.warn('[TimelineRoot] document-release-unconfirmed code=' + String(error?.code || error?.message)); }
  }
  decode(descriptor, options = {}) {
    return readTimelineSelectedValue(this.reader, descriptor, { ...options,
      pull: operation => this.pull(operation, options) });
  }
  async endpoint(node, options = {}) {
    const page = await this.pull(() => this.reader.project(node, ['uuid', 'entryRef', 'contentRevision'], { limit: 3 }), options);
    const result = {};
    for (const item of page.items) result[item.name] = await this.decode(item.value, options);
    assert(typeof result.uuid === 'string', 'TIMELINE_VIEW_ENDPOINT');
    return Object.freeze(result);
  }
  subject(value, logicalRank, uuid) {
    assert(value && value.logicalRank === logicalRank && value.uuid === uuid
      && value.revision === this.header.logicalRevisionToken && value.logicalRevision === value.revision
      && value.viewRevision === this.identity.revision
      && (value.canonicalOrdinal === null || integer(value.canonicalOrdinal)), 'TIMELINE_VIEW_SUBJECT');
    return Object.freeze({ logicalRank, revision: value.revision, logicalRevision: value.logicalRevision,
      viewRevision: value.viewRevision, uuid, canonicalOrdinal: value.canonicalOrdinal });
  }
  async row(logicalRank, options) {
    const result = await this.query('row', { logicalRank }, options);
    const entry = await this.decode(result.entry, options), facts = await this.decode(result.facts, options);
    assert(entry && typeof entry.uuid === 'string' && !entry.rowStub && facts?.logicalRank === logicalRank,
      'TIMELINE_VIEW_ROW');
    return Object.freeze({ entry, facts, logicalRank, identity: this.identity, subject: this.subject(result.subject, logicalRank, entry.uuid) });
  }
  async annotation(annotationKind, n, options) {
    if (n == null) return null;
    const result = await this.query('annotation', { annotationKind, n }, options);
    return this.decode(result.annotation, options);
  }
  async group(key, options) {
    const result = await this.query('group', { key }, options);
    assert(result.found === true && result.groupInfo?.groupId === key && integer(result.groupInfo.groupSize), 'TIMELINE_VIEW_GROUP');
    const info = result.groupInfo, presentation = result.presentation;
    assert(presentation && integer(presentation.editedCount) && integer(presentation.searchedCount), 'TIMELINE_VIEW_GROUP_COUNTS');
    const group = { key, kind: info.groupKind, groupSize: info.groupSize, displayId: info.displayId,
      startIndex: info.startIndex, endIndex: info.endIndex, expanded: info.expanded, hasTimeout: info.hasTimeout,
      membershipRevision: info.membershipRevision, editedCount: presentation.editedCount, searchedCount: presentation.searchedCount,
      promptCount: presentation.promptLabelCount, isLoop: presentation.isLoop, hasPromptChip: presentation.hasPromptChip,
      failedCount: presentation.failedCount ?? (info.hasTimeout ? null : 0),
      // The actual automatic classifier excludes Research from every group.
      mcpCount: presentation.mcpCount ?? (info.groupKind === 'orchestration' ? info.groupSize : 0), scCount: presentation.scCount ?? 0 };
    if (isHistoryRootDescriptor(info.agentName)) group.agentName = await this.decode(info.agentName, options);
    else group.agentName = info.agentName;
    assert(isHistoryRootDescriptor(result.group) && result.group.kind === 'object', 'TIMELINE_VIEW_GROUP_DETAIL');
    group.detail = result.group;
    if (group.kind === 'semantic') group.title = await this.field(result.group, 'title', options);
    return Object.freeze(group);
  }

  async field(node, fieldName, options = {}) {
    assert(isHistoryRootDescriptor(node) && node.kind === 'object', 'TIMELINE_VIEW_SELECTED_FIELD');
    const result = await this.pull(() => this.reader.project(node, [fieldName], { limit: 1 }), options);
    const item = result.items.find(item => item.name === fieldName);
    return item ? this.decode(item.value, options) : null;
  }
  async document(args, { signal, owns = always } = {}) {
    // The document lease is independent of this parent and can outlive the UI.
    live(signal, owns);
    const releaseParent = this.retain();
    let result;
    try {
      // An allocating document request settles even if its presentation leaves.
      // Only the new independent child is then cancelled/released.
      const subject = args.subject, range = args.range;
      if (subject?.revision) this.subject(subject, subject.logicalRank, subject.uuid);
      if (range?.startSubject) {
        assert(same(range.identity, this.identity), 'TIMELINE_VIEW_RANGE_OWNER');
        this.subject(range.startSubject, range.startLogicalRank, range.startUuid);
        this.subject(range.endSubject, range.endLogicalRank, range.endUuid);
      }
      result = await this.query('document', { ...args,
        ...(subject ? { logicalRank: subject.revision ? subject : subject.logicalRank } : {}),
        ...(range ? { logicalRank: range.startSubject || range.startLogicalRank,
          logicalStart: range.startSubject || range.startLogicalRank, logicalEnd: range.endSubject || range.endLogicalRank } : {}) });
    } finally { await releaseParent(); }
    const header = result.document;
    try {
    assert(header?.success === true && header.__notedHistoryTransport === 'root-v1'
      && header.payloadDocument?.kind === 'text' && header.totalChars === header.payloadDocument.length
      && same(header, header.payloadDocument) && header.leaseId !== this.identity.leaseId, 'TIMELINE_VIEW_DOCUMENT');
    } catch (error) { await this.discardDocument(header); throw error; }
    let reader;
    try { reader = new HistoryRootClient(this.invoke, header.payloadDocument, { pageBytes: 16384, pageItems: 3 }); }
    catch (error) { await this.discardDocument(header); throw error; }
    try {
      live(signal, owns);
      const hash = await createDocumentUtf16Digest();
      live(signal, owns);
      const parts = []; let length = 0;
      for await (const part of reader.text(header.payloadDocument).chunks({ signal })) {
        live(signal, owns); hash.update(part); parts.push(part); length += part.length;
      }
      assert(length === header.totalChars, 'TIMELINE_VIEW_DOCUMENT_LENGTH');
      const text = parts.join('');
      // BodyOPEN: an explicit Full/Copy/edit sink owns the selected string.
      const digest = hash.digest();
      assert(digest === header.payloadDocument.digest, 'TIMELINE_VIEW_DOCUMENT_DIGEST');
      live(signal, owns); return text;
    } finally { await reader.close(); }
  }
  async retainSnapshot({ signal, owns = always } = {}) {
    live(signal, owns);
    const releaseParent = this.retain(); let client, snapshot;
    try {
      const result = await this.query('retain'); snapshot = result.snapshot;
      client = new TimelineViewClient(this.invoke, snapshot);
      assert(client.header.logicalRevisionToken === this.header.logicalRevisionToken
        && client.header.semanticRevisionToken === this.header.semanticRevisionToken
        && client.header.totalEntries === this.header.totalEntries, 'TIMELINE_VIEW_RETAIN_IDENTITY');
      client.lane = this.lane;
      live(signal, owns); return client;
    } catch (error) { if (client) await client.close(); else await this.discardDocument(snapshot); throw error; }
    finally { await releaseParent(); }
  }
  retain() {
    assert(!this.closed, 'HISTORY_READ_CANCELLED'); const token = {}; this.references.add(token);
    return () => this.release(token);
  }
  async release(token) {
    if (!this.references.delete(token) || this.references.size) return;
    this.closed = true; await this.reader.close();
  }
  close() { return this.release('owner'); }
}

export async function openTimelineView(invoke, payload, { signal } = {}) {
  const protectedLease = payload.timelineParentLease?.leaseId;
  let observed, released = false;
  const discard = async header => {
    if (released || !header) return;
    let identity; try { identity = historyRootIdentity(header); } catch { return; }
    if (identity.leaseId === protectedLease) return;
    released = true;
    try { await invoke('agent-transcript:release-read-root', identity); } catch {}
  };
  const guarded = (channel, request) => {
    const result = invoke(channel, request);
    if (channel !== 'agent-transcript:get-timeline') return result;
    return Promise.resolve(result).then(header => { observed = header; if (signal?.aborted) void discard(header); return header; });
  };
  let header;
  try {
    header = await readHistoryThroughIpc(guarded, 'agent-transcript:get-timeline', {
      ...payload, toolType: 'codex', readTransport: 'root-v1', readProfile: TIMELINE_VIEW_PROFILE,
    }, { signal });
    if (header?.success === false) {
      const error = timelineViewError(header.error || 'TIMELINE_VIEW_OPEN');
      if (header.error === 'TIMELINE_VIEW_RECOMPOSE_REQUIRED' && ['metadata', 'source'].includes(header.requiredClass))
        error.requiredClass = header.requiredClass;
      throw error;
    }
    assert(header.leaseId !== protectedLease, 'TIMELINE_VIEW_RETAINED_LEASE');
    assert(header.sourceSnapshot?.sessionId === payload.sessionId, 'TIMELINE_VIEW_SOURCE_OWNER');
    const client = new TimelineViewClient(invoke, header);
    if (signal?.aborted) { await client.close(); throw timelineViewError('HISTORY_READ_CANCELLED'); }
    return client;
  } catch (error) { await discard(header || observed); throw error; }
}
