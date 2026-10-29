// Timeline's full-row read plane. Counts are logical coordinates, never an
// allocation size for an entries/UUID index. Only the current finite corridor
// and one provisional root's corridor may own decoded bodies here.
import { createDocumentUtf16Digest } from './documentUtf16Digest.mjs';
import { checkedHistoryRootOpenHeader, historyRootIdentity, isHistoryRootDescriptor } from './historyRootReadClient.mjs';

export const TIMELINE_PRIMARY_PROFILE = 'timeline-primary-v1';
const PAGE_ITEMS = 3;
const identityKeys = ['leaseId', 'ownerKey', 'revision', 'generation'];
const sameIdentity = (a, b) => identityKeys.every(key => a?.[key] === b?.[key]);
const fail = code => Object.assign(new Error(code), { code });
const always = () => true;
const current = (signal, owns) => {
  if (signal?.aborted || !owns()) throw fail('HISTORY_READ_CANCELLED');
};
const release = async resource => {
  try { await resource?.close(); }
  catch (error) { console.warn('[TimelineRoot] release-failed code=' + String(error?.code || error?.message || error)); }
};

// Same UTF16LE digest/independent text-fork contract as the explicit History
// selected-value sink. UTF8/TextDecoder would replace lone surrogate values.
async function readText(reader, node, { signal, owns }) {
  current(signal, owns);
  const document = await reader.forkText(node, { signal });
  try {
    current(signal, owns);
    const hash = await createDocumentUtf16Digest();
    current(signal, owns);
    const parts = []; let length = 0;
    for await (const part of document.chunks({ signal })) {
      current(signal, owns); hash.update(part); parts.push(part); length += part.length;
    }
    if (length !== document.length) throw fail('TIMELINE_ROOT_TEXT_LENGTH');
    const text = parts.join('');
    const digest = hash.digest();
    current(signal, owns);
    if (digest !== document.digest) throw fail('TIMELINE_ROOT_TEXT_DIGEST');
    return text;
  } finally { await release(document); }
}

// Decode only an explicitly selected row/sessionMeta subtree. The temporary
// identity table preserves aliases/cycles within that subtree and dies with
// this call. There is no root-wide table or count-sized row array. Parent page
// pulls deliberately have NO range signal: its abort closes that shared reader.
export async function readTimelineSelectedValue(reader, descriptor, { signal, owns = always, pull = operation => operation() } = {}) {
  const decoded = new Map(), pending = [], containers = [];
  const value = async node => {
    current(signal, owns);
    if (!isHistoryRootDescriptor(node)) return node;
    if (!sameIdentity(historyRootIdentity(node), reader.identity)) throw fail('TIMELINE_ROOT_VALUE_IDENTITY');
    if (node.nodeToken === reader.root.nodeToken) throw fail('TIMELINE_ROOT_SELECTED_VALUE_REQUIRED');
    if (decoded.has(node.nodeToken)) return decoded.get(node.nodeToken);
    if (node.kind === 'text') {
      const text = await readText(reader, node, { signal, owns });
      current(signal, owns); decoded.set(node.nodeToken, text); return text;
    }
    // The collection range wire is arrays only. Do not invent a Map/Set
    // encoding when a peer advertises another kind.
    if (!['object', 'array'].includes(node.kind)) throw fail('TIMELINE_ROOT_VALUE_KIND');
    const result = node.kind === 'array' ? [] : {};
    decoded.set(node.nodeToken, result); pending.push({ node, result }); containers.push(result); return result;
  };
  const result = await value(descriptor);
  while (pending.length) {
    const frame = pending.pop(); let offset = 0;
    for (;;) {
      current(signal, owns);
      const page = await pull(() => frame.node.kind === 'object'
        ? reader.fields(frame.node, { offset, limit: PAGE_ITEMS })
        : reader.range(frame.node, { offset, limit: PAGE_ITEMS }));
      current(signal, owns);
      if (page.nextOffset !== offset + page.items.length || (frame.node.kind === 'array'
        && (page.length !== frame.node.length || page.nextOffset > frame.node.length
          || page.done !== (page.nextOffset === frame.node.length)))) throw fail('TIMELINE_ROOT_VALUE_PROGRESS');
      for (const item of page.items) {
        if (frame.node.kind === 'array' && item.present === false) continue;
        const name = frame.node.kind === 'array' ? String(item.ordinal) : await value(item.name);
        if (typeof name !== 'string' || Object.hasOwn(frame.result, name)) throw fail('TIMELINE_ROOT_VALUE_FIELD');
        Object.defineProperty(frame.result, name, { value: await value(item.value),
          enumerable: true, configurable: true, writable: true });
        current(signal, owns);
      }
      if (page.done) break;
      if (page.nextOffset <= offset) throw fail('TIMELINE_ROOT_VALUE_PROGRESS');
      offset = page.nextOffset;
    }
    if (frame.node.kind === 'array') {
      if (!Number.isSafeInteger(frame.node.length) || frame.node.length < frame.result.length
        || frame.node.length > 0xffffffff) throw fail('TIMELINE_ROOT_VALUE_LENGTH');
      // This is a selected row's own value (including trailing holes), never
      // a logical Timeline count or the full entries root.
      frame.result.length = frame.node.length;
    }
  }
  for (const container of containers) Object.freeze(container);
  current(signal, owns); return result;
}

function checkedWindow(start, end, maxRows) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
    || end - start >= maxRows) throw fail('TIMELINE_ROOT_WINDOW_RANGE');
  return Object.freeze({ start, end }); // Public demand uses inclusive end.
}
const bounds = (demand, total) => {
  const start = Math.min(demand.start, Math.max(0, total - 1));
  return { start, end: Math.min(total, Math.max(start, demand.end) + 1) };
};
const covered = (window, range) => window && window.start <= range.start && window.end >= range.end;
const sliceWindow = (window, range) => Object.freeze({ ...range,
  entries: Object.freeze(window.entries.slice(range.start - window.start, range.end - window.start)) });

export class TimelineRootReadModel {
  constructor(invoke, transport, { creditBytes = 3072, maxWindowRows = 96 } = {}) {
    if (typeof invoke !== 'function' || typeof transport?.openHistoryRootThroughIpc !== 'function'
      || !Number.isSafeInteger(creditBytes) || creditBytes < 512 || creditBytes > 65536
      || !Number.isSafeInteger(maxWindowRows) || maxWindowRows < 1 || maxWindowRows > 256) {
      throw fail('TIMELINE_ROOT_CONFIGURATION');
    }
    this.invoke = invoke; this.transport = transport; this.creditBytes = creditBytes; this.maxWindowRows = maxWindowRows;
    this.view = null; this.candidate = null; this.demand = Object.freeze({ start: 0, end: 0 });
    this.demandRevision = 0; this.adoptionId = 0; this.rangeJob = null; this.pump = null;
    this.closed = false; this.closePromise = null; this.listeners = new Set(); this.state = null; this.findJob = null;
  }
  get header() { return this.view?.header || null; }
  get totalCount() { return this.header?.totalEntries || 0; }
  get metadata() { return this.view?.metadata || null; }
  snapshot() { return this.state; }
  entryAt(index) {
    const window = this.view?.window;
    return Number.isSafeInteger(index) && window && index >= window.start && index < window.end
      ? window.entries[index - window.start] : undefined;
  }
  subscribe(listener) {
    if (this.closed || typeof listener !== 'function') throw fail('TIMELINE_ROOT_SUBSCRIPTION');
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  publish() {
    const view = this.view;
    this.state = view ? Object.freeze({ header: view.header, adoptionId: view.adoptionId,
      totalCount: view.header.totalEntries, metadata: view.metadata, ...view.window }) : null;
    const published = this.state;
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn('[TimelineRoot] listener-failed code=' + String(error?.code || error?.message || error)); }
    }
    return published;
  }
  noteRange(start, end) {
    if (this.closed) throw fail('HISTORY_READ_CANCELLED');
    const next = checkedWindow(start, end, this.maxWindowRows);
    if (next.start !== this.demand.start || next.end !== this.demand.end) {
      this.demand = next; this.demandRevision++;
      this.candidate?.rangeController?.abort();
      this.cancelWindow();
    }
  }
  async pull(view, operation, { signal, owns }) {
    // Only one parent page may settle at a time. The bounded range worker and
    // one explicit navigation request may wait here, never a promise queue of
    // historical ranges/UUIDs. Cancellation is checked before taking the slot.
    while (view.pageTask) {
      await view.pageTask.catch(() => {});
      current(signal, owns);
    }
    current(signal, owns);
    const task = Promise.resolve().then(() => { current(signal, owns); return operation(); });
    view.pageTask = task;
    try { return await task; }
    finally { if (view.pageTask === task) view.pageTask = null; }
  }
  decode(view, descriptor, options) {
    return readTimelineSelectedValue(view.reader, descriptor, { ...options,
      pull: operation => this.pull(view, operation, options) });
  }
  async fillWindow(view, demand, { signal, owns }) {
    const range = bounds(demand, view.header.totalEntries), entries = [];
    for (let offset = range.start; offset < range.end;) {
      current(signal, owns);
      const page = await this.pull(view, () => view.reader.rowWindow(view.root, { offset,
        limit: Math.min(PAGE_ITEMS, range.end - offset), fields: [], creditBytes: this.creditBytes }), { signal, owns });
      current(signal, owns);
      if (page.next <= offset || page.next > range.end) throw fail('TIMELINE_ROOT_WINDOW_PROGRESS');
      for (const row of page.rows) {
        if (row.ordinal !== range.start + entries.length || row.entry.kind !== 'object') throw fail('TIMELINE_ROOT_ROW_HEADER');
        const entry = await this.decode(view, row.entry, { signal, owns });
        current(signal, owns);
        if (!entry || typeof entry.uuid !== 'string' || !entry.uuid || entry.rowStub) throw fail('TIMELINE_ROOT_FULL_ROW_REQUIRED');
        entries.push(entry);
      }
      offset = page.next;
    }
    current(signal, owns);
    if (entries.length !== range.end - range.start) throw fail('TIMELINE_ROOT_WINDOW_PROGRESS');
    return Object.freeze({ ...range, entries: Object.freeze(entries) });
  }
  async open(payload, { signal, owns = always, beforeAdopt = async () => {}, adopt,
    expectedOwnerKey, expectedGeneration } = {}) {
    current(signal, () => !this.closed && owns());
    // No unbounded preparation queue or overlapping candidate root owners.
    // The UI caller may cancel/settle this attempt before explicitly opening
    // another. BUSY/loss never triggers an implicit replay here.
    if (this.candidate) throw fail('TIMELINE_ROOT_OPEN_IN_FLIGHT');
    const controller = new AbortController(), candidate = { controller, rangeController: null, opened: null, done: null, finish: null };
    candidate.done = new Promise(resolve => { candidate.finish = resolve; });
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.candidate = candidate;
    const valid = () => !this.closed && this.candidate === candidate && owns();
    const protectedLease = this.header?.leaseId;
    // Malformed OPEN may echo the retained lease. Even transport-level abort
    // cleanup must not close that previous owner's root.
    const invoke = (channel, request) => channel === 'agent-transcript:release-read-root'
      && protectedLease && request?.leaseId === protectedLease
      ? Promise.resolve({ success: false, error: 'TIMELINE_ROOT_RETAINED_LEASE' }) : this.invoke(channel, request);
    let adopted = false;
    try {
      current(signal, valid);
      const opened = candidate.opened = await this.transport.openHistoryRootThroughIpc(invoke,
        'agent-transcript:get-timeline', { ...payload, readTransport: 'root-v1', readProfile: TIMELINE_PRIMARY_PROFILE },
        { signal: controller.signal, pageBytes: this.creditBytes, pageItems: PAGE_ITEMS });
      current(controller.signal, valid);
      if (opened?.kind !== 'root') throw fail(opened?.result?.error || 'TIMELINE_ROOT_REQUIRED');
      const header = checkedHistoryRootOpenHeader(opened.header, { sessionId: payload.sessionId });
      if (header.readProfile !== TIMELINE_PRIMARY_PROFILE || header.semanticSnapshotComplete !== true
        || !sameIdentity(header, opened.reader?.identity) || !sameIdentity(header, opened.root)
        || header.root.nodeToken !== opened.root?.nodeToken || header.root.length !== opened.root?.length
        || opened.root?.kind !== 'array' || opened.reader?.root?.nodeToken !== header.root.nodeToken
        || (expectedOwnerKey !== undefined && header.ownerKey !== expectedOwnerKey)
        || (expectedGeneration !== undefined && header.generation !== expectedGeneration)
        || header.leaseId === protectedLease) throw fail('TIMELINE_ROOT_OPEN_IDENTITY');
      const view = { reader: opened.reader, root: header.root, header, metadata: null, window: null };
      // A cancelled corridor must not abort the provisional root while reading
      // metadata. Only the OPEN's own signal/lifetime owns this phase.
      view.metadata = await this.decode(view, header.sessionMeta, { signal: controller.signal, owns: valid });
      current(controller.signal, valid);
      for (;;) {
        const revision = this.demandRevision, demand = this.demand, rangeController = new AbortController();
        candidate.rangeController = rangeController;
        const abortRange = () => rangeController.abort();
        controller.signal.addEventListener('abort', abortRange, { once: true });
        try {
          view.window = null;
          view.window = await this.fillWindow(view, demand, { signal: rangeController.signal,
            owns: () => valid() && revision === this.demandRevision && !controller.signal.aborted });
          current(controller.signal, valid);
          if (revision !== this.demandRevision) continue;
          // Closing/aborting a provisional root also releases an adopter
          // callback that is still awaiting its external work. Its late result
          // cannot acquire ownership afterwards.
          await Promise.race([Promise.resolve().then(beforeAdopt), view.reader.closedPromise]);
          current(controller.signal, valid);
          if (revision !== this.demandRevision) continue;
          // Transfer the root capability only after the final demand/owner
          // checks. A later abort of this flight cannot close retained state.
          view.reader.detachSignal(controller.signal);
          signal?.removeEventListener('abort', abort);
          const previous = this.view;
          this.cancelWindow(); this.cancelFind();
          view.adoptionId = ++this.adoptionId; this.view = view; adopted = true;
          try { this.publish(); adopt?.(this); }
          finally { if (previous?.reader !== view.reader) void release(previous?.reader); }
          return { kind: 'root', model: this };
        } catch (error) {
          current(controller.signal, valid);
          if (error?.code !== 'HISTORY_READ_CANCELLED' || revision === this.demandRevision) throw error;
          // A NEW explicit demand may prepare its own corridor. A protocol,
          // UNKNOWN or source error never enters this branch.
        } finally {
          controller.signal.removeEventListener('abort', abortRange);
          if (candidate.rangeController === rangeController) candidate.rangeController = null;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (!adopted && candidate.opened?.kind === 'root') {
        const opened = candidate.opened;
        if (opened.header?.leaseId === protectedLease || opened.reader?.identity?.leaseId === protectedLease) {
          await opened.reader?.abandon?.();
        } else await release(opened.reader);
      }
      if (this.candidate === candidate) this.candidate = null;
      candidate.finish();
    }
  }
  cancelFind() {
    const job = this.findJob;
    if (job) { this.findJob = null; job.controller.abort(); }
  }
  findUUID(uuid, { signal, owns = always } = {}) {
    try {
      current(signal, () => !this.closed && owns());
      if (typeof uuid !== 'string' || !uuid || uuid.length > 2048) throw fail('TIMELINE_ROOT_FIND_UUID');
      if (!this.view) throw fail('TIMELINE_ROOT_REQUIRED');
      if (this.view.failure) throw this.view.failure;
    } catch (error) { return Promise.reject(error); }
    const view = this.view, existing = this.findJob;
    if (existing) return existing.view === view && existing.uuid === uuid && existing.signal === signal && existing.owns === owns
      ? existing.promise : Promise.reject(fail('TIMELINE_ROOT_FIND_IN_FLIGHT'));
    const controller = new AbortController(), abort = () => controller.abort();
    const job = { view, uuid, signal, owns, controller, promise: null };
    const valid = () => !this.closed && this.view === view && this.findJob === job && owns();
    this.findJob = job; signal?.addEventListener('abort', abort, { once: true });
    job.promise = (async () => {
      try {
        const page = await this.pull(view, () => {
          if (view.failure) throw view.failure;
          return view.reader.find(view.root, 'uuid', uuid, { offset: 0, limit: 1, creditBytes: this.creditBytes });
        }, { signal: controller.signal, owns: valid });
        current(controller.signal, valid);
        const item = page.items[0];
        if (!page.done || page.nextOffset !== (item ? item.ordinal + 1 : view.header.totalEntries)) throw fail('TIMELINE_ROOT_FIND_RESULT');
        if (!item) return null;
        if (page.items.length !== 1 || item.ordinal >= view.header.totalEntries
          || item.value?.kind !== 'object' || !sameIdentity(item.value, view.header)) throw fail('TIMELINE_ROOT_FIND_RESULT');
        return Object.freeze({ index: item.ordinal, header: view.header });
      } catch (error) {
        if (error?.code !== 'HISTORY_READ_CANCELLED' && this.view === view) {
          view.failure = error; void release(view.reader);
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (this.findJob === job) this.findJob = null;
      }
    })();
    job.promise.catch(() => {}); return job.promise;
  }
  cancelWindow() {
    const job = this.rangeJob;
    if (job) {
      this.rangeJob = null; job.controller.abort(); job.detach(); job.reject(fail('HISTORY_READ_CANCELLED'));
    }
  }
  readWindow(start, end, { signal, owns = always } = {}) {
    try { current(signal, () => !this.closed && owns()); this.noteRange(start, end); }
    catch (error) { return Promise.reject(error); }
    const view = this.view;
    if (!view) return Promise.resolve(null); // Demand is retained for the first OPEN.
    if (view.failure) return Promise.reject(view.failure);
    const existing = this.rangeJob;
    if (existing && existing.view === view && existing.signal === signal && existing.owns === owns) return existing.promise;
    const range = bounds(this.demand, view.header.totalEntries);
    if (covered(view.window, range)) {
      this.cancelWindow(); view.window = sliceWindow(view.window, range);
      return Promise.resolve(this.publish());
    }
    this.cancelWindow();
    const controller = new AbortController(), job = { view, controller, signal, owns,
      revision: this.demandRevision, demand: this.demand, promise: null, resolve: null, reject: null, detach: null };
    const abort = () => { if (this.rangeJob === job) this.cancelWindow(); };
    job.detach = () => signal?.removeEventListener('abort', abort);
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    // Observe supersession internally even if the caller has not yet installed
    // its await/catch. The original promise still rejects for that caller.
    job.promise.catch(() => {});
    this.rangeJob = job; signal?.addEventListener('abort', abort, { once: true });
    this.startPump(); return job.promise;
  }
  startPump() {
    if (this.pump) return;
    this.pump = Promise.resolve().then(async () => {
      while (this.rangeJob && !this.closed) {
        const job = this.rangeJob, view = job.view;
        const valid = () => !this.closed && this.view === view && this.rangeJob === job && job.owns()
          && this.demandRevision === job.revision;
        try {
          current(job.controller.signal, valid);
          if (view.failure) throw view.failure;
          const window = await this.fillWindow(view, job.demand, { signal: job.controller.signal, owns: valid });
          current(job.controller.signal, valid);
          view.window = window; this.rangeJob = null; job.detach();
          job.resolve(this.publish());
        } catch (error) {
          if (error?.code !== 'HISTORY_READ_CANCELLED' && this.view === view) {
            view.failure = error; void release(view.reader);
          }
          if (this.rangeJob === job) {
            this.rangeJob = null; job.detach();
            // Cancellation is not root loss. Every other read failure is
            // latched; another range request cannot replay it automatically.
          }
          job.reject(error);
        }
      }
    }).finally(() => { this.pump = null; if (this.rangeJob && !this.closed) this.startPump(); });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    // Publish/listener callbacks may re-enter close. Install the exact close
    // receipt before any notification or cancellation side effect.
    let finish;
    this.closePromise = new Promise(resolve => { finish = resolve; });
    this.closed = true; this.cancelWindow();
    const candidate = this.candidate, find = this.findJob;
    this.cancelFind(); candidate?.controller.abort();
    const view = this.view, provisional = candidate?.opened;
    this.view = null; this.publish(); this.listeners.clear();
    Promise.all([release(view?.reader),
      provisional?.reader !== view?.reader && provisional?.reader?.identity?.leaseId !== view?.header?.leaseId
        ? release(provisional?.reader) : Promise.resolve(), this.pump, find?.promise?.catch(() => {}), candidate?.done]).then(finish, finish);
    return this.closePromise;
  }
}
