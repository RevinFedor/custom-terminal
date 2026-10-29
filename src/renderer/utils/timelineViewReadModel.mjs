import { openTimelineView, mergeTimelineReadClass, checkedTimelineLayout, timelineViewError } from './timelineViewClient.mjs';
const cancelled = () => timelineViewError('HISTORY_READ_CANCELLED');
const check = owns => { if (!owns()) throw cancelled(); };
const immutable = value => Object.freeze(value);

// This registry is a few active UI capabilities, never a visited-row cache.
// Copy labels may consult the held reader but cannot create a reader.
const handles = new Map(), legacyOwners = new Map();
const ownerKey = owner => JSON.stringify([owner.tabId, owner.sessionId, owner.cwd || '']);
export function isExplicitLegacyTimelineOwner(owner) { return legacyOwners.has(ownerKey(owner)); }
export function registerExplicitLegacyTimelineOwner(owner) {
  const key = ownerKey(owner), token = {}; legacyOwners.set(key, token);
  return () => { if (legacyOwners.get(key) === token) legacyOwners.delete(key); };
}
export function heldTimelineView(owner) { return handles.get(JSON.stringify([owner.tabId, owner.sessionId, owner.cwd || ''])) || null; }
export function registerTimelineView(owner, model) {
  const key = JSON.stringify([owner.tabId, owner.sessionId, owner.cwd || '']);
  handles.set(key, model);
  return () => { if (handles.get(key) === model) handles.delete(key); };
}

export class TimelineViewReadModel {
  constructor(invoke, { open = openTimelineView, beforeAdopt = async () => {}, deferPreviousRelease = false } = {}) {
    this.invoke = invoke; this.opener = open; this.beforeAdopt = beforeAdopt;
    this.deferPreviousRelease = deferPreviousRelease; this.retiredClient = null; this.commitWait = null;
    this.current = null; this.candidate = null; this.state = null; this.listeners = new Set();
    this.demand = immutable({ offset: 0, extent: 0, overscan: 0, bottom: true });
    this.demandRevision = 0; this.appliedDemandRevision = -1; this.measuring = false; this.windowPump = null; this.openPump = null; this.pendingOpen = null;
    this.lane = { pending: null }; this.pendingViewportExtent = null; this.resizePump = null;
    this.closed = false; this.lifetime = new AbortController(); this.adoption = 0;
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  publish(view, window, status = view.status) {
    if (this.closed || this.current !== view) return;
    this.state = immutable({ client: view.client, header: view.client.header, layout: view.client.layout,
      adoption: view.adoption, window, status, error: null });
    const anchor = window.items.find(item => item.geometry.start <= window.offset && item.geometry.end > window.offset);
    if (anchor) this.demand = immutable({ ...this.demand, offset: window.offset,
      anchor: { uuid: anchor.subject?.entry.uuid, visualRank: anchor.header.visualRank,
        kind: anchor.header.kind, intraOffset: window.offset - anchor.geometry.start } });
    this.appliedDemandRevision = this.demandRevision;
    for (const listener of this.listeners) listener();
  }
  report(error) {
    if (this.closed || error?.code === 'HISTORY_READ_CANCELLED') return;
    this.state = immutable({ ...this.state, error });
    for (const listener of this.listeners) listener();
  }
  requestWindow(demand) {
    if (this.closed) return Promise.reject(cancelled());
    for (const key of ['offset', 'extent', 'overscan']) if (!Number.isFinite(demand[key]) || demand[key] < 0)
      throw timelineViewError('TIMELINE_VIEW_DEMAND');
    this.demand = immutable({ ...demand }); this.demandRevision++;
    // Scroll changes only the demand register, never an OPEN generation or
    // source projection. The one settling pull finishes and checks ownership.
    if (!this.current || this.measuring) return Promise.resolve();
    if (!this.windowPump) {
      this.windowPump = this.runWindowPump().finally(() => {
        this.windowPump = null;
        if (!this.closed && !this.measuring && this.current && this.appliedDemandRevision !== this.demandRevision)
          void this.requestWindow(this.demand).catch(error => this.report(error));
      });
    }
    return this.windowPump;
  }
  async runWindowPump() {
    for (;;) {
      const view = this.current, revision = this.demandRevision;
      if (!view || this.closed || this.measuring) return;
      const owns = () => !this.closed && this.current === view && revision === this.demandRevision && !this.measuring;
      try {
        const window = await this.fill(view, this.demand, owns);
        check(owns); this.publish(view, window);
      } catch (error) {
        if (error?.code !== 'HISTORY_READ_CANCELLED') { this.appliedDemandRevision = this.demandRevision; this.report(error); throw error; }
      }
      if (this.closed || (this.current === view && revision === this.demandRevision)) return;
    }
  }
  async selected(view, rank, owns) {
    const held = this.state?.client === view.client
      ? this.state.window?.items.find(item => item.header.logicalRank === rank)?.subject : null;
    if (held) return held;
    const options = { owns }, row = await view.client.row(rank, options);
    const annotations = {};
    // Facts select exactly one scalar annotation ordinal, never whole tables.
    for (const [kind, field] of [['note', 'noteOrdinal'], ['summary', 'summaryOrdinal'], ['action', 'actionOrdinal'], ['meta', 'metaPromptOrdinal']]) {
      annotations[kind] = row.facts[field] == null ? null : await view.client.annotation(kind, row.facts[field], options);
      check(owns);
    }
    return immutable({ ...row, client: view.client, annotations: immutable(annotations) });
  }
  async fill(view, demand, owns) {
    check(owns);
    const client = view.client, layout = client.layout;
    let offset = demand.bottom ? Math.max(0, layout.totalExtent - demand.extent)
      : Math.min(demand.offset, Math.max(0, layout.totalExtent - demand.extent));
    // Reopen/rebase uses a canonical anchor and an intra-atom offset. Source
    // append, metadata-only refresh and measurement have distinct identities.
    if (view !== this.current && !demand.bottom && demand.anchor?.uuid) {
      const target = await client.query('resolve', { uuid: demand.anchor.uuid }, { owns }); check(owns);
      if (target.found && !target.ambiguous && target.geometry)
        offset = Math.min(Math.max(0, layout.totalExtent - demand.extent), target.geometry.start + Math.min(demand.anchor.intraOffset, Math.max(0, target.geometry.extent - 1)));
    }
    const start = Math.max(0, offset - demand.overscan), end = Math.min(layout.totalExtent, offset + demand.extent + demand.overscan);
    if (!layout.count) return immutable({ offset: 0, start: 0, end: 0, items: immutable([]), sticky: null });
    const hit = await client.query('offset', { offset: start }, { owns }); check(owns);
    const rect = hit.hit;
    if (!rect) throw timelineViewError('TIMELINE_VIEW_OFFSET_MISSING');
    let next = rect.ordinal, covered = start; const items = [], subjects = new Map(), groups = new Map();
    while (covered < end) {
      const page = await client.query('window', { startOrdinal: next, limit: 3 }, { owns }); check(owns);
      if (page.nextOrdinal !== next + page.items.length || page.nextOrdinal <= next) throw timelineViewError('TIMELINE_VIEW_WINDOW_PROGRESS');
      for (const item of page.items) {
        const { header, geometry } = item;
        if (header.visualRank !== next || geometry.ordinal !== next || geometry.key !== header.key
          || geometry.layoutId !== layout.layoutId || geometry.layoutRevision !== layout.layoutRevision
          || geometry.layoutFingerprint !== layout.layoutFingerprint || !(geometry.extent > 0)
          || geometry.end <= geometry.start || geometry.start < covered - 0.01 && next !== rect.ordinal)
          throw timelineViewError('TIMELINE_VIEW_ATOM_GEOMETRY');
        next++;
        if (geometry.start >= end) break;
        let subject = null, group = null;
        if (header.logicalRank != null) {
          subject = subjects.get(header.logicalRank);
          if (!subject) { subject = await this.selected(view, header.logicalRank, owns); subjects.set(header.logicalRank, subject); }
        }
        const groupKey = header.groupKey || subject?.facts.automaticGroupKey;
        if (groupKey) {
          group = groups.get(groupKey);
          if (!group) { group = await client.group(groupKey, { owns }); groups.set(groupKey, group); }
        }
        items.push(immutable({ header: immutable(header), geometry: immutable(geometry), subject, group }));
        covered = geometry.end;
      }
      if (page.done) break;
      if (next < page.nextOrdinal) break; // page crossed the geometry corridor
      if (next !== page.nextOrdinal) throw timelineViewError('TIMELINE_VIEW_WINDOW_PROGRESS');
    }
    let sticky = hit.sticky || null;
    if (sticky && !items.some(item => item.header.key === (sticky.header?.key || sticky.key) && item.geometry.start >= offset)) {
      const header = sticky.header || sticky;
      sticky = immutable({ ...sticky, header, group: await client.group(header.groupKey, { owns }) });
    } else sticky = null;
    check(owns);
    return immutable({ offset, start, end: covered, items: immutable(items), sticky });
  }
  refresh(payload, readClass = 'source') {
    if (this.closed) return Promise.reject(cancelled());
    this.pendingOpen = { payload, readClass: mergeTimelineReadClass(this.pendingOpen?.readClass, readClass) };
    if (!this.openPump) this.openPump = this.runOpenPump().finally(() => { this.openPump = null; });
    return this.openPump;
  }
  async runOpenPump() {
    while (this.pendingOpen && !this.closed) {
      if (this.commitWait) await this.commitWait.promise;
      if (this.closed) return;
      const request = this.pendingOpen; this.pendingOpen = null;
      let view;
      try {
        const parent = this.current?.client;
        const presentationRevision = request.payload.timelinePresentation?.revision ?? null;
        const effectiveClass = request.readClass === 'view' && parent
          && parent.header.timelinePresentationRevision !== presentationRevision ? 'metadata' : request.readClass;
        const requestPayload = { ...request.payload, timelineReadClass: parent ? effectiveClass : 'source',
          ...(parent ? { timelineParentLease: parent.identity } : {}) };
        if (parent && effectiveClass === 'view') {
          delete requestPayload.timelinePresentation;
          requestPayload.timelinePresentationIdentity = parent.header.timelinePresentationIdentity;
        } else delete requestPayload.timelinePresentationIdentity;
        const client = await this.opener(this.invoke, requestPayload, { signal: this.lifetime.signal });
        if (this.closed) { await client.close(); throw cancelled(); }
        client.lane = this.lane;
        view = this.candidate = { client, adoption: this.adoption + 1, presentationRevision, status: null };
        view.status = await client.query('status');
        for (;;) {
          const revision = this.demandRevision;
          const owns = () => !this.closed && this.candidate === view && revision === this.demandRevision;
          try {
            const appended = this.current && client.header.logicalEntryCount > this.current.client.header.logicalEntryCount;
            const effectiveDemand = appended ? { ...this.demand, bottom: true } : this.demand;
            const window = await this.fill(view, effectiveDemand, owns); check(owns);
            await this.beforeAdopt(); check(owns);
            const previous = this.current;
            if (appended) this.demand = immutable({ ...this.demand, bottom: true });
            this.current = view; this.candidate = null; this.adoption = view.adoption;
            if (previous && this.deferPreviousRelease) {
              this.retiredClient = previous.client;
              let resolve; const promise = new Promise(done => { resolve = done; });
              this.commitWait = { adoption: view.adoption, promise, resolve };
            } else void previous?.client.close();
            this.publish(view, window);
            break;
          } catch (error) {
            if (this.closed || error?.code !== 'HISTORY_READ_CANCELLED' || revision === this.demandRevision) throw error;
          }
        }
      } catch (error) {
        if (this.candidate === view) this.candidate = null;
        await view?.client.close();
        // An exact read refusal can strengthen the pending read class. This
        // is bounded view→metadata→source adoption, never a Native DTO fallback
        // or replay after source invalidation/UNKNOWN.
        const required = error?.requiredClass;
        if (error?.code === 'TIMELINE_VIEW_RECOMPOSE_REQUIRED'
          && ['metadata', 'source'].includes(required)
          && mergeTimelineReadClass(request.readClass, required) !== request.readClass) {
          this.pendingOpen = { payload: this.pendingOpen?.payload || request.payload,
            readClass: mergeTimelineReadClass(this.pendingOpen?.readClass, required) };
          continue;
        }
        this.report(error); throw error;
      }
    }
  }
  commitPresentation(adoption) {
    if (!this.commitWait || this.commitWait.adoption !== adoption) return;
    const waiting = this.commitWait, client = this.retiredClient;
    this.commitWait = null; this.retiredClient = null;
    void client?.close(); waiting.resolve();
  }
  async resolve(uuid, options) {
    const view = this.current; if (!view) throw timelineViewError('TIMELINE_VIEW_NOT_READY');
    const result = await view.client.query('resolve', { uuid }, options);
    if (result.ambiguous) throw timelineViewError('ambiguous_entry_identity');
    return result;
  }
  async subject(uuid, options) {
    const view = this.current, result = await this.resolve(uuid, options);
    if (!result.found || this.current !== view) throw timelineViewError('stale_transcript_revision');
    return this.selected(view, result.logicalRank, () => !this.closed && this.current === view && !options?.signal?.aborted);
  }
  async withActionSubject(uuid, payload, operation) {
    // Background Rewind must not require a painted renderer/current viewport.
    // A cold explicit action owns a separate source reader; scrolling never
    // calls this method. Its lifetime belongs to the accepted action, not UI.
    const held = this.current?.client;
    const client = held ? await held.retainSnapshot() : await this.opener(this.invoke, { ...payload, timelineReadClass: 'source' });
    try {
      const resolved = await client.query('resolve', { uuid });
      if (!resolved.found || resolved.ambiguous) throw timelineViewError(resolved.ambiguous ? 'ambiguous_entry_identity' : 'stale_transcript_revision');
      const row = await client.row(resolved.logicalRank);
      return await operation(immutable({ ...row, client, annotations: immutable({}) }), client);
    } finally { await client.close(); }
  }
  async range(start, end, client = this.current?.client) {
    if (!client) throw timelineViewError('TIMELINE_VIEW_NOT_READY');
    return client.query('range', { start: Math.min(start, end), end: Math.max(start, end) });
  }
  async measure(batch) {
    const view = this.current; if (!view || !batch.length || this.measuring) return;
    const layout = view.client.layout, anchor = this.demand.anchor;
    this.measuring = true; this.demandRevision++;
    try {
      await this.windowPump?.catch(() => {});
      for (let at = 0; at < batch.length; at += 32) {
        if (this.current !== view || this.closed) return;
        const stamp = view.client.layout;
        const result = await view.client.query('measure', { layoutId: stamp.layoutId, layoutRevision: stamp.layoutRevision,
          layoutFingerprint: stamp.layoutFingerprint, measurements: batch.slice(at, at + 32) });
        if (this.current !== view || this.closed) return;
        const next = checkedTimelineLayout(result.layoutInfo);
        if (next.layoutId === stamp.layoutId || next.layoutFingerprint !== layout.layoutFingerprint
          || next.layoutRevision !== stamp.layoutRevision + 1 || next.count !== stamp.count) throw timelineViewError('TIMELINE_VIEW_MEASURE_OWNER');
        view.client.layout = next;
      }
      if (!this.demand.bottom && anchor) {
        const page = await view.client.query('window', { startOrdinal: anchor.visualRank, limit: 1 });
        const item = page.items[0];
        if (item?.header.kind === anchor.kind) this.demand = immutable({ ...this.demand,
          offset: item.geometry.start + Math.min(anchor.intraOffset, Math.max(0, item.geometry.extent - 1)) });
      }
    } finally { this.measuring = false;
      if (this.pendingViewportExtent !== null) void this.resizeViewport(this.pendingViewportExtent).catch(error => this.report(error));
    }
    if (!this.closed && this.current === view) await this.requestWindow(this.demand);
  }

  resizeViewport(viewportExtent) {
    if (!(Number.isFinite(viewportExtent) && viewportExtent > 0)) return Promise.reject(timelineViewError('TIMELINE_VIEW_VIEWPORT'));
    this.pendingViewportExtent = viewportExtent;
    if (this.resizePump) return this.resizePump;
    if (this.measuring || !this.current || this.closed) return Promise.resolve();
    this.resizePump = (async () => {
      while (this.pendingViewportExtent !== null && this.current && !this.closed) {
        const extent = this.pendingViewportExtent, view = this.current; this.pendingViewportExtent = null;
        this.measuring = true; this.demandRevision++;
        try {
          await this.windowPump?.catch(() => {});
          const before = view.client.layout;
          const result = await view.client.query('resize', { viewportExtent: extent });
          if (this.current !== view || this.closed) return;
          const next = checkedTimelineLayout(result.layoutInfo);
          if (next.layoutId === before.layoutId || next.layoutFingerprint !== before.layoutFingerprint || next.viewportExtent !== extent || next.count !== before.count)
            throw timelineViewError('TIMELINE_VIEW_RESIZE_OWNER');
          view.client.layout = next;
        } finally { this.measuring = false; }
        if (!this.closed && this.current === view) await this.requestWindow({ ...this.demand, extent });
      }
    })().finally(() => { this.resizePump = null; });
    return this.resizePump;
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.lifetime.abort(); this.pendingOpen = null; this.listeners.clear();
    this.commitWait?.resolve(); this.commitWait = null;
    await Promise.all([this.current?.client.close(), this.candidate?.client.close(), this.retiredClient?.close()]);
    this.retiredClient = null;
    this.current = this.candidate = this.state = null;
  }
}
