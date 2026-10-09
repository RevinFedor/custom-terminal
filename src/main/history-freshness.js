'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { buildHistoryRevision, validateHistoryRevision } = require('./history-revision');

const MAX_SOURCES = 16;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopeKey = scope => hash([scope.tabId, scope.toolType, scope.sessionId, scope.cwd || '', scope.readIdentitySource === 'empty-resume-source']);
const ids = (scope, sources) => [...new Set([scope.sessionId, ...(sources || []).map(s => s.sessionId)].filter(Boolean))].sort();
const snapshot = (source, stat) => ({ ...source, size: stat.size, mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino });
const failureReason = error => error?.code === 'ENOENT' ? 'source-missing'
  : ['EACCES','EPERM'].includes(error?.code) ? 'source-unavailable'
  : /^history_freshness_[a-z_]+$/.test(error?.message || '') ? error.message : 'probe-unavailable';

// A bounded set of reader-issued dependency certificates. Probes never discover
// files, scan JSONL, enter a worker lane or prepare lineage. An unobserved owner
// needs its normal selected History read, not a speculative catalogue rebuild.
class HistoryFreshness {
  constructor({ readContext, epoch = randomUUID(), maxEntries = 512 } = {}) {
    this.readContext = readContext;
    this.epoch = epoch;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.serial = new Map();
    this.sequence = 0;
    this.events = new Map();
    this.probes = new Map();
  }

  envelope(scope, state, extra = {}) {
    return { schema: 1, epoch: this.epoch, sequence: ++this.sequence,
      tabId: scope.tabId, toolType: scope.toolType || null, readSessionId: scope.sessionId || null,
      scope: scopeKey(scope), state, token: null, observedAt: Date.now(), ...extra };
  }

  invalidate(tabId, reason = 'source-event') {
    const entry = [...this.entries.values()].find(e => e.scope.tabId === tabId);
    if (entry) this.events.set(tabId, (this.events.get(tabId) || 0) + 1);
    return this.envelope(entry?.scope || { tabId }, 'unknown', { reason, revalidate: true });
  }

  hasTab(tabId) { return [...this.entries.values()].some(entry => entry.scope.tabId === tabId); }

  async bounded(scope, work, timeoutMs = 1000) {
    let timer;
    try {
      return await Promise.race([work, new Promise(resolve => {
        timer = setTimeout(() => resolve(this.envelope(scope, 'unknown',
          { reason: 'probe-budget-exceeded', revalidate: true })), Math.max(1, timeoutMs));
      })]);
    } finally { clearTimeout(timer); }
  }

  async serialProbe(scope, run) {
    const key = scopeKey(scope);
    const work = (this.serial.get(key) || Promise.resolve()).catch(() => {}).then(run);
    this.serial.set(key, work);
    try { return await work; }
    finally { if (this.serial.get(key) === work) this.serial.delete(key); }
  }

  async context(scope, sources = this.entries.get(scopeKey(scope))?.sources || []) {
    return this.readContext(scope, ids(scope, sources));
  }

  async beginRead(scope) {
    if (!this.entries.has(scopeKey(scope))) this.remember(scope, [], null, false);
    try { return { key: scopeKey(scope), context: await this.context(scope), event: this.events.get(scope.tabId) || 0 }; }
    catch (error) { return { key: scopeKey(scope), error: failureReason(error) }; }
  }

  remember(scope, sources, context, verified, directory = null) {
    const key = scopeKey(scope);
    this.entries.delete(key);
    this.entries.set(key, { scope: { ...scope }, sources: sources.map(s => ({
      filePath: s.filePath, sessionId: s.sessionId, size: s.size, mtimeMs: s.mtimeMs,
      ctimeMs: s.ctimeMs, fileIdentity: s.fileIdentity,
    })), context, verified, directory });
    while (this.entries.size > this.maxEntries) {
      const [victim, entry] = this.entries.entries().next().value;
      this.entries.delete(victim);
      if (![...this.entries.values()].some(item => item.scope.tabId === entry.scope.tabId)) this.events.delete(entry.scope.tabId);
    }
  }

  async directorySnapshot(directory) {
    if (!directory?.filePath) return null;
    return snapshot(directory, await fs.promises.stat(directory.filePath));
  }

  directoryFromRevision(revision) {
    let context;
    try {
      context = JSON.parse(revision?.context || '{}');
      for (let i = 0; i < 3 && typeof context.base === 'string'; i++) context = JSON.parse(context.base);
    } catch { return null; }
    const source = context?.discovery;
    return source?.projectDir ? { filePath: source.projectDir, mtimeMs: source.mtimeMs,
      ctimeMs: source.ctimeMs, fileIdentity: source.fileIdentity } : null;
  }

  async completeRead(scope, data, ticket) {
    return this.serialProbe(scope, async () => {
      const unknown = reason => this.envelope(scope, 'unknown', { reason, revalidate: true });
      if (!data?.success || ticket?.error || ticket?.key !== scopeKey(scope)) return unknown(ticket?.error || 'read-unavailable');
      const sources = data.freshnessReadSources;
      if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES
        || sources.some(s => !path.isAbsolute(s.filePath || '') || !s.fileIdentity || !Number.isFinite(s.ctimeMs))) {
        return unknown('read-source-proof-unavailable');
      }
      try {
        const context = await this.context(scope, sources);
        const directory = scope.toolType === 'claude' ? this.directoryFromRevision(data.revision) : null;
        if (scope.toolType === 'claude' && !directory?.fileIdentity) return unknown('read-source-proof-unavailable');
        const dirNow = await this.directorySnapshot(directory);
        const directoryMatches = !directory || (directory.mtimeMs === dirNow.mtimeMs
          && directory.ctimeMs === dirNow.ctimeMs && directory.fileIdentity === dirNow.fileIdentity);
        const validation = await validateHistoryRevision(buildHistoryRevision(scope, sources), scope);
        const after = await this.context(scope, sources);
        const readerMatches = !context.reader || (context.reader.alive
          && data.freshnessReader?.clientId === context.reader.clientId
          && data.freshnessReader?.generation === context.reader.generation);
        // A cold worker may start during this read. Only its captured result
        // identity can certify that transition; metadata/runtime still match
        // on both sides, and the producer must remain alive through validation.
        const withoutReader = value => { const { reader: _reader, ...rest } = value; return rest; };
        const stable = equal(withoutReader(ticket.context), withoutReader(context)) && equal(context, after) && readerMatches
          && validation.unchanged && directoryMatches
          // A watcher may invalidate after the source stat, while the final
          // context is still awaiting delivery. That older page is not proof
          // for the newer event, even when its metadata remains identical.
          && ticket.event === (this.events.get(scope.tabId) || 0);
        this.remember(scope, sources, after, stable, dirNow);
        if (!stable) return unknown('changed-during-read');
        return this.known(scope, sources, after, dirNow);
      } catch (error) { return unknown(failureReason(error)); }
    });
  }

  known(scope, sources, context, directory) {
    const source = hash([scopeKey(scope), sources.map(s => [s.filePath, s.sessionId, s.fileIdentity])]);
    const token = hash([this.epoch, source, sources.map(s => [s.size,s.mtimeMs,s.ctimeMs]), context, directory]);
    return this.envelope(scope, 'known', { source, token, sourceCount: sources.length });
  }

  async probe(scope, timeoutMs = 1000) {
    const key = scopeKey(scope);
    let work = this.probes.get(key);
    if (work) return this.bounded(scope, work, timeoutMs);
    work = this.serialProbe(scope, async () => {
      const unknown = reason => this.envelope(scope, 'unknown', { reason, revalidate: true });
      if (!scope.sessionId || !['claude','codex'].includes(scope.toolType)) return unknown('read-owner-unavailable');
      const entry = this.entries.get(scopeKey(scope));
      if (!entry?.verified) return unknown(entry ? 'read-proof-required' : 'history-not-observed');
      try {
        const event = this.events.get(scope.tabId) || 0;
        const context = await this.context(scope, entry.sources);
        if (!equal(context.reader, entry.context.reader)) {
          entry.verified = false; return unknown('reader-generation-changed');
        }
        if (!equal(context.metadata.topology, entry.context.metadata.topology)) {
          entry.verified = false; return unknown('source-topology-changed');
        }
        // At most16 async stats, repeated by the existing validator. Files are
        // supplied only by an actual reader certificate, never by the client.
        const sources = await Promise.all(entry.sources.map(async s => snapshot(s, await fs.promises.stat(s.filePath))));
        const directory = await this.directorySnapshot(entry.directory);
        if (!equal(directory, entry.directory)) { entry.verified = false; return unknown('source-discovery-changed'); }
        const validation = await validateHistoryRevision(buildHistoryRevision(scope, sources), scope);
        const after = await this.context(scope, entry.sources);
        if (!validation.unchanged || !equal(context, after) || event !== (this.events.get(scope.tabId) || 0)) {
          return unknown('changed-during-probe');
        }
        this.entries.delete(scopeKey(scope)); this.entries.set(scopeKey(scope), entry);
        return this.known(scope, sources, context, directory);
      } catch (error) { return unknown(failureReason(error)); }
    });
    this.probes.set(key, work);
    void work.finally(() => { if (this.probes.get(key) === work) this.probes.delete(key); }).catch(() => {});
    return this.bounded(scope, work, timeoutMs);
  }
}

module.exports = { HistoryFreshness, MAX_SOURCES, historyFreshnessScopeKey: scopeKey };
