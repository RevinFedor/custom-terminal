'use strict';

const crypto = require('crypto');

const MAX_EVENT_TABS = 32;

function eventTabIds(query) {
  if (query.tabIds == null) return null; // legacy single-tab / projects route
  if (query.tabId != null || query.scope != null || query.projectActivity != null) {
    throw new Error('tabIds cannot be combined with tabId or scope');
  }
  let ids;
  try { ids = JSON.parse(query.tabIds); } catch { throw new Error('tabIds must be a JSON array'); }
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_EVENT_TABS
    || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 1024 || /[\x00-\x1f]/.test(id))) {
    throw new Error('tabIds must contain 1..' + MAX_EVENT_TABS + ' nonempty tab IDs');
  }
  // JSON members are already decoded by the URL parser. Do not decode twice:
  // percent characters inside an ID are data, not another URL layer.
  return [...new Set(ids)];
}

// Initial reads may yield while live events arrive. Send each tab's initial
// snapshots before those queued events, never a late initial over a live one.
// A slow/disconnected reader is closed, not allowed an unbounded replay queue.
function stampedEventSink(transport, instanceId, maxBufferedBytes = 2 * 1024 * 1024) {
  const connectionId = crypto.randomUUID();
  const pending = new Map(); let sequence = 0; let bufferedBytes = 0;
  const write = (str, initial = false) => {
    if (!transport.isAlive()) return;
    const event = JSON.parse(str);
    transport.send(JSON.stringify({ ...event, streamInstanceId: instanceId,
      connectionId, sequence: ++sequence, initial }));
  };
  const sink = { ...transport,
    send(str) {
      if (!transport.isAlive()) return;
      const event = JSON.parse(str), queue = pending.get(event.tabId);
      if (!queue) return write(str);
      bufferedBytes += Buffer.byteLength(str);
      if (bufferedBytes > maxBufferedBytes) { pending.clear(); bufferedBytes = 0; transport.close(); return; }
      queue.push(str);
    },
    beginInitial(tabId) {
      pending.set(tabId, []);
      return { ...transport, send: str => write(str, true), finish() {
        const queue = pending.get(tabId) || []; pending.delete(tabId);
        for (const str of queue) { bufferedBytes -= Buffer.byteLength(str); write(str); }
      } };
    },
  };
  return sink;
}

/** Opaque, bounded read receipts, not a second transcript cache/parser. Never
 * accept client-supplied file paths as a stat/revision witness. Restart/eviction
 * simply falls back to the normal reader. Bounds and read owner are part of the
 * capability: identical files do not prove an identical requested window. */
class PublicHistoryRevisions {
  constructor(limit = 512) { this.limit = limit; this.entries = new Map(); }
  scope(request) { return JSON.stringify(request); }
  lookup(token, request) {
    const entry = this.entries.get(token);
    if (!entry || entry.scope !== this.scope(request)) return null;
    this.entries.delete(token); this.entries.set(token, entry);
    return entry.revision;
  }
  remember(revision, request) {
    if (!revision?.token) return null;
    const scope = this.scope(request);
    const token = crypto.createHash('sha256').update(scope + '\n' + revision.token).digest('hex');
    this.entries.delete(token); this.entries.set(token, { scope, revision });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return token;
  }
  clear() { this.entries.clear(); }
}

/** One service consumer per tab, even with overlapping SSE/WS clients. Close,
 * reconnect and source->writer changes cannot leave a late async subscribe
 * orphaned or allow its cleanup to remove a newer binding. */
class TabTranscriptSubscriptions {
  constructor({ hasConsumers, readSession, subscribe, unsubscribe, onError = () => {} }) {
    Object.assign(this, { hasConsumers, readSession, subscribe, unsubscribe, onError });
    this.tabs = new Map(); this.stopped = false;
  }
  reconcile(tabId) {
    if (this.stopped) return Promise.resolve();
    let state = this.tabs.get(tabId);
    if (!state) {
      if (!this.hasConsumers(tabId)) return Promise.resolve();
      state = { consumerId: 'web:' + tabId, key: null, dirty: false, running: null };
      this.tabs.set(tabId, state);
    }
    state.dirty = true;
    if (state.running) return state.running;
    state.running = this.drain(tabId, state).catch(async error => {
      await this.unsubscribe({ consumerId: state.consumerId }).catch(() => {});
      state.key = null; this.onError(error);
    }).finally(() => {
      state.running = null;
      if (state.dirty && !this.stopped) void this.reconcile(tabId);
      else if (!state.key) this.tabs.delete(tabId);
    });
    return state.running;
  }
  async drain(tabId, state) {
    while (state.dirty) {
      state.dirty = false;
      const wanted = !this.stopped && this.hasConsumers(tabId);
      const info = wanted ? await this.readSession(tabId) : null;
      if (state.dirty) continue; // superseded while resolving: read latest once
      const live = !this.stopped && this.hasConsumers(tabId);
      const request = live && info?.sessionId && ['claude', 'codex'].includes(info.toolType)
        ? { tabId, consumerId: state.consumerId, toolType: info.toolType, sessionId: info.sessionId, cwd: info.cwd || null }
        : null;
      const key = request ? JSON.stringify(request) : null;
      if (key === state.key) continue;
      if (request) {
        // Mark before await so close/error cleanup also owns a partial subscribe.
        state.key = key;
        const result = await this.subscribe(request);
        if (result?.success === false) throw new Error(result.error || 'transcript subscription failed');
      } else {
        await this.unsubscribe({ consumerId: state.consumerId }); state.key = null;
      }
      if (this.stopped || !this.hasConsumers(tabId)) state.dirty = true;
    }
  }
  releaseOrphans() {
    for (const tabId of this.tabs.keys()) if (!this.hasConsumers(tabId)) void this.reconcile(tabId);
  }
  async stop() {
    this.stopped = true;
    await Promise.all([...this.tabs.values()].map(async state => {
      state.dirty = true;
      await state.running;
      await this.unsubscribe({ consumerId: state.consumerId });
    }));
    this.tabs.clear();
  }
}

module.exports = { MAX_EVENT_TABS, eventTabIds, stampedEventSink, PublicHistoryRevisions, TabTranscriptSubscriptions };
