'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { causal } = require('./perf-causal-context');
const { createCatalogControl, createFsLimiter, stableSort, copyMetadata } = require('./prompt-catalog-cooperative');
const { naturalCompare, probeSource, sameProbe, captureLayout, scanSourceMetadata,
  optionalStat, identity, error } = require('./prompt-catalog-source');
const { PROMPT_SUFFIX } = require('../shared/prompt-source-policy.cjs');
const policyVersion = () => require('../shared/prompt-source-policy.cjs').PROMPT_SOURCE_POLICY_VERSION;

const obsolete = () => Object.assign(Error('prompt_catalog_obsolete'), { code: 'prompt_catalog_obsolete' });
const sameFence = (a, b) => !!a && !!b && a.connection === b.connection
  && ['schema', 'external', 'changes', 'committed', 'transaction'].every(k => a[k] === b[k]);
const rowSignature = rows => { const h = crypto.createHash('sha256'); for (const row of rows) h.update(JSON.stringify(row) + '\n'); return h.digest('hex'); };

/** Complete ordered metadata per CONFIGURED spelling; request authority is never cached. */
class PreparedPromptCatalog {
  constructor(service, { asyncFs, controlOptions = {}, authorityFence = null } = {}) {
    this.service = service;
    this.fs = asyncFs || (service.fs === fs ? fs.promises : null);
    if (!this.fs || ['opendir', 'stat', 'lstat', 'realpath'].some(k => typeof this.fs[k] !== 'function')) {
      throw error('prompt_catalog_async_fs_required');
    }
    this.controlOptions = controlOptions; this.authorityFence = authorityFence;
    this.pool = createFsLimiter(); this.slots = new Map(); this.watchers = new Map();
    this.queue = []; this.running = null; this.pumpScheduled = false;
    this.closed = false; this.lifetime = 1; this.reconcileScheduled = false;
    this.reconcileRunning = false; this.reconcileDesired = false; this.consumersKnown = false;
    this.counters = { preparations: 0, publications: 0, obsolete: 0, failures: 0, reconciliations: 0,
      diagnosticLoss: 0, notificationLoss: 0, watchLoss: 0 };
    this.sourceSequence = 0;
    if (service.watchEnabled) this.refreshWatchers();
  }
  control(assertCurrent = () => this.assertOpen()) { return createCatalogControl({ ...this.controlOptions, assertCurrent }); }
  assertOpen() { if (this.closed) throw error('prompt_catalog_unavailable'); }
  io(method, target, ...args) {
    return this.pool.run(() => ['read', 'close'].includes(method) ? target[method](...args) : this.fs[method](target, ...args));
  }
  changed(payload) {
    try { this.service.onChanged?.({ ...payload, at: Date.now() }); } catch { this.counters.notificationLoss++; }
  }
  notifySlot(slot, state) {
    this.changed({ reason: 'catalog-' + state, state, ...(this.consumersKnown ? { tabIds: [...(slot.tabIds || [])], projectIds: [...(slot.projectIds || [])] } : {}) });
  }
  diagnostic(kind, control, extra = {}) {
    // No configured paths, file bodies, titles, query strings or per-unit packets.
    const current = causal.current();
    const fields = current?.fields;
    try { console.log('[PromptCatalog] ' + JSON.stringify({ kind, spanId: current?.spanId,
      parentSpanId: current?.parentSpanId, actionId: fields?.actionId,
      readId: fields?.readId, requestId: fields?.requestId,
      mode: 'prepared-source-metadata', ...control.finish(),
      diagnosticLoss: this.counters.diagnosticLoss, notificationLoss: this.counters.notificationLoss,
      watchLoss: this.counters.watchLoss, ...extra })); } catch { this.counters.diagnosticLoss++; }
  }
  slot(root) {
    let slot = this.slots.get(root);
    if (!slot) {
      slot = { root, sourceId: ++this.sourceSequence, epoch: 1, watchEpoch: 0, state: 'preparing', snapshot: null,
        demanded: false,
        queued: false, running: null, timer: null, watches: new Set(), tabIds: new Set(), projectIds: new Set() };
      this.slots.set(root, slot);
    }
    return slot;
  }
  current(slot, epoch, token, life, policy) {
    if (this.closed || life !== this.lifetime || this.slots.get(slot.root) !== slot
      || slot.epoch !== epoch || slot.running !== token || policyVersion() !== policy) throw obsolete();
  }
  enqueue(slot) {
    if (this.closed || !slot.demanded || slot.queued || (slot.running && slot.runningEpoch === slot.epoch)) return;
    slot.queued = true; this.queue.push(slot);
    if (!this.pumpScheduled && !this.running) {
      this.pumpScheduled = true;
      setImmediate(() => { this.pumpScheduled = false; this.pump().catch(() => {}); });
    }
  }
  markDirty(slot, reason, coalesce = false) {
    if (this.closed || this.slots.get(slot.root) !== slot) return;
    slot.epoch++; slot.state = 'preparing'; slot.failure = null; slot.observationRetries = 0;
    this.notifySlot(slot, 'preparing');
    if (coalesce) {
      if (!slot.timer) {
        const life = this.lifetime;
        const timer = setTimeout(() => {
          if (this.closed || life !== this.lifetime || this.slots.get(slot.root) !== slot || slot.timer !== timer) return;
          slot.timer = null; this.enqueue(slot);
        }, 180);
        slot.timer = timer; timer.unref?.();
      }
    } else this.enqueue(slot);
  }
  invalidate(tabIds, reason = 'filesystem', projectIds = []) {
    this.consumersKnown = false;
    // Binding changes alter projections, not complete physical source metadata.
    if (!/sources|bindings|createTab|Migration|registerLegacy/.test(reason)) {
      for (const slot of this.slots.values()) this.markDirty(slot, reason);
    }
    this.changed({ reason, projectIds, ...(Array.isArray(tabIds) ? { tabIds: [...new Set(tabIds.filter(Boolean))] } : {}) });
    this.refreshWatchers();
  }
  onLayoutCommitted(root) {
    if (this.closed) return { scheduled: false, state: 'unavailable' };
    const slot = this.slots.get(root);
    if (!slot) {
      // A never-demanded source has no ready snapshot to revoke and will use
      // the committed layout on its first preparation. No eager unbound scan.
      return { scheduled: false, state: 'cold' };
    }
    this.markDirty(slot, 'layout-committed');
    return { scheduled: slot.demanded, state: 'preparing' };
  }
  async pump() {
    if (this.running || this.closed) return;
    while (this.queue.length && !this.closed) {
      const slot = this.queue.shift(); slot.queued = false;
      if (this.slots.get(slot.root) !== slot) continue;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const token = {}, epoch = slot.epoch, life = this.lifetime, policy = policyVersion();
      this.running = token; slot.running = token; slot.runningEpoch = epoch;
      const control = this.control(() => this.current(slot, epoch, token, life, policy));
      this.counters.preparations++;
      try {
        await causal.run('catalog.prepare', {}, async () => {
          if (policy !== 1) throw error('prompt_catalog_policy_unavailable');
          const probe = await probeSource(slot.root, this.io.bind(this), control);
          const layout = await captureLayout(this.service.layoutStore, slot.root, control);
          await this.ensureWatchers(slot, probe, control);
          const watchEpoch = slot.watchEpoch;
          const metadata = await scanSourceMetadata(slot.root, probe, layout.layout, this.io.bind(this), control);
          const afterProbe = await probeSource(slot.root, this.io.bind(this), control);
          const afterLayout = await captureLayout(this.service.layoutStore, slot.root, control);
          if (!sameProbe(probe, afterProbe) || layout.stamp !== afterLayout.stamp
            || watchEpoch !== slot.watchEpoch) throw obsolete();
          const snapshot = { metadata, probe, layoutStamp: layout.stamp, epoch, watchEpoch, lifetime: life, policy,
            observedAt: Date.now() };
          this.current(slot, epoch, token, life, policy); this.assertCoverage(slot);
          // One reference replacement; no clone/sort/serialization at publication.
          slot.snapshot = snapshot; slot.state = 'ready'; slot.failure = null;
          slot.observationKey = rowSignature([{ probe, layoutStamp: layout.stamp, policy }]);
          this.counters.publications++; this.notifySlot(slot, 'ready');
          this.diagnostic('prepare', control, { sourceId: slot.sourceId, candidateEpoch: epoch, state: 'ready', directories: metadata.directories, entries: metadata.entriesRead, prompts: metadata.prompts.length });
        });
      } catch (e) {
        if (e.code === 'prompt_catalog_obsolete') {
          this.counters.obsolete++;
          if (!this.closed && this.slots.get(slot.root) === slot && slot.epoch === epoch) {
            // A missed topology/layout observation permits one event-driven
            // reconciliation candidate; unstable probes cannot spin forever.
            if ((slot.observationRetries || 0) >= 1) {
              slot.state = 'failed'; slot.failure = error('prompt_catalog_changed'); this.counters.failures++; this.notifySlot(slot, 'failed');
            } else { slot.observationRetries = (slot.observationRetries || 0) + 1; slot.epoch++; }
          }
        }
        else if (!this.closed && this.slots.get(slot.root) === slot && epoch === slot.epoch) {
          slot.state = 'failed'; slot.failure = e; this.counters.failures++; this.notifySlot(slot, 'failed');
        }
        this.diagnostic('prepare', control, { sourceId: slot.sourceId, candidateEpoch: epoch, state: e.code === 'prompt_catalog_obsolete' ? 'obsolete' : 'failed', errorCode: e.code || 'prepare_error' });
      } finally {
        slot.running = null; this.running = null;
        // Latest desired epoch goes to queue END; unrelated sources remain fair.
        if (!this.closed && this.slots.get(slot.root) === slot && slot.epoch !== epoch && slot.state !== 'failed') this.enqueue(slot);
      }
    }
  }
  assertCoverage(slot) {
    if (!this.service.watchEnabled) return;
    if (!slot.watches.size) throw error('prompt_catalog_watch_unavailable');
    for (const key of slot.watches) {
      const entry = this.watchers.get(key);
      if (!entry || entry.retired || !entry.watcher || !entry.slots.has(slot)) throw error('prompt_catalog_watch_unavailable');
    }
  }
  retire(entry) {
    if (this.watchers.get(entry.key) !== entry) return;
    this.watchers.delete(entry.key); entry.retired = true;
    for (const slot of entry.slots) { slot.watches.delete(entry.key); slot.watchEpoch++; }
    try { entry.watcher?.close(); } catch {}
  }
  async nearestParent(file, control) {
    let target = path.dirname(file);
    for (;;) {
      const stat = await optionalStat(this.io.bind(this), target);
      await control.step('probe');
      if (stat?.isDirectory()) return { target, stat };
      const next = path.dirname(target); if (next === target) throw error('prompt_catalog_watch_unavailable'); target = next;
    }
  }
  async ensureWatchers(slot, probe, control) {
    if (!this.service.watchEnabled) return;
    const wanted = new Map();
    const add = (target, recursive, stat) => wanted.set(`${recursive ? 'r' : 's'}:${target}`, { target, recursive, identity: identity(stat) });
    const parent = await this.nearestParent(slot.root, control); add(parent.target, false, parent.stat);
    if (probe.docs.exists) add(probe.docsPath, true, await this.io('stat', probe.docsPath));
    else {
      const parent = await this.nearestParent(probe.docsPath, control); add(parent.target, false, parent.stat);
    }
    // Relevant aliases may be ancestors of the configured root, not only root
    // itself. NON-recursive sentinels watch their own parent, never recursive home.
    for (const seed of [slot.root, probe.docsPath]) {
      let current = seed;
      for (;;) {
        const stat = await optionalStat(this.io.bind(this), current, 'lstat');
        if (stat?.isSymbolicLink()) { const parent = await this.nearestParent(current, control); add(parent.target, false, parent.stat); }
        await control.step('probe');
        const next = path.dirname(current); if (next === current) break; current = next;
      }
    }
    for (const key of [...slot.watches]) if (!wanted.has(key)) {
      const entry = this.watchers.get(key); slot.watches.delete(key); slot.watchEpoch++;
      entry?.slots.delete(slot); if (entry && !entry.slots.size) this.retire(entry);
    }
    for (const [key, spec] of wanted) {
      let entry = this.watchers.get(key);
      if (entry && entry.identity !== spec.identity) {
        const affected = [...entry.slots]; this.retire(entry);
        for (const other of affected) if (other !== slot) this.markDirty(other, 'watch-replacement');
        entry = null;
      }
      if (!entry) {
        entry = { ...spec, key, slots: new Set(), retired: false, watcher: null };
        this.watchers.set(key, entry);
        try {
          entry.watcher = this.service.fs.watch(spec.target, { recursive: spec.recursive }, (kind, filename) => this.watchEvent(entry, kind, filename));
          const loss = () => {
            if (this.closed || this.watchers.get(key) !== entry) return;
            const affected = [...entry.slots]; this.retire(entry);
            this.counters.watchLoss++;
            for (const other of affected) this.markDirty(other, 'watch-loss', true);
            this.refreshWatchers();
          };
          entry.watcher.on?.('error', loss);
          entry.watcher.on?.('close', loss);
        } catch (e) { this.retire(entry); throw error('prompt_catalog_watch_unavailable', e); }
      }
      entry.slots.add(slot); if (!slot.watches.has(key)) { slot.watches.add(key); slot.watchEpoch++; }
      await control.step('probe');
    }
  }
  watchEvent(entry, kind, filename) {
    if (this.closed || this.watchers.get(entry.key) !== entry || entry.retired) return;
    const name = filename == null ? null : String(filename);
    // Dependency exclusion is proven only for a relative event inside the
    // recursive docs owner; a sentinel's own ancestor name is not that proof.
    if (entry.recursive && name && !path.isAbsolute(name)
      && name.split(/[\\/]/).some((part, i, parts) => part.startsWith('.') || (part === 'node_modules' && i < parts.length - 1))) return;
    for (const slot of [...entry.slots]) {
      if (!entry.recursive && name) {
        const event = path.resolve(entry.target, name), docs = path.join(slot.root, 'docs');
        const ancestor = target => event === target || target.startsWith(event + path.sep);
        if (!ancestor(slot.root) && !ancestor(docs)) continue;
      }
      const before = slot.snapshot;
      this.markDirty(slot, 'filesystem', true); // revoke synchronously, before debounce/probes
      const epoch = slot.epoch, life = this.lifetime;
      const file = name && path.resolve(entry.target, name);
      const fact = before?.metadata.leafFacts.get(file);
      if (entry.recursive && kind === 'change' && fact && file.endsWith(PROMPT_SUFFIX)) {
        this.confirmContentOnly(slot, entry, before, epoch, life, file, fact).catch(() => {});
      }
    }
    if (!entry.recursive || name == null || kind === 'rename') this.refreshWatchers();
  }
  async confirmContentOnly(slot, entry, before, epoch, life, file, fact) {
    const stat = await this.io('lstat', file);
    if (identity(stat) !== fact.identity || stat.isSymbolicLink() || !stat.isFile()) return;
    const control = this.control();
    const probe = await probeSource(slot.root, this.io.bind(this), control);
    const layout = await captureLayout(this.service.layoutStore, slot.root, control);
    if (this.closed || life !== this.lifetime || this.slots.get(slot.root) !== slot || slot.epoch !== epoch
      || this.watchers.get(entry.key) !== entry || slot.running || slot.queued
      || !sameProbe(before.probe, probe) || before.layoutStamp !== layout.stamp) return;
    this.assertCoverage(slot);
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    slot.snapshot = { ...before, epoch, watchEpoch: slot.watchEpoch, observedAt: Date.now() }; slot.state = 'ready';
    this.notifySlot(slot, 'ready');
  }
  fence() {
    if (this.authorityFence) return this.authorityFence();
    if (this.service.rootRegistry?.captureCatalogFence) return this.service.rootRegistry.captureCatalogFence();
    const connection = this.service.db.db;
    if (!connection?.prepare) throw error('prompt_catalog_authority_unavailable');
    return { connection, schema: connection.prepare('PRAGMA schema_version').get().schema_version,
      external: connection.prepare('PRAGMA data_version').get().data_version,
      changes: connection.prepare('SELECT total_changes() AS n').get().n, committed: 0, transaction: !!connection.inTransaction };
  }
  async scopes(control) {
    const registry = this.service.rootRegistry;
    if (!registry && this.service.db.db?.prepare) {
      // Legacy scopes keep original updated_at DESC/id ASC ordering with fresh
      // bounded pages. No iterator or SQLite transaction survives an await.
      const output = []; let cursor = null;
      for (;;) {
        const connection = this.service.db.db;
        const page = connection.prepare(`SELECT DISTINCT p.id,p.name,p.path,p.icon,p.updated_at
          FROM projects p INNER JOIN project_prompt_sources s ON s.project_id=p.id
          ${cursor ? 'WHERE p.updated_at < ? OR (p.updated_at = ? AND p.id > ?)' : ''}
          ORDER BY p.updated_at DESC,p.id ASC LIMIT 256`).all(...(cursor ? [cursor.updated_at, cursor.updated_at, cursor.id] : []));
        for (const row of page) await control.step('authority', () => output.push(row));
        if (page.length < 256) return output;
        cursor = page.at(-1);
      }
    }
    if (!registry?.readSourceScopesPage) {
      // Explicit controlled/legacy ports; production registry uses fresh SQL pages.
      const rows = registry ? registry.listSourceScopes() : this.service.db.getProjectsWithPromptSources();
      const output = []; for (const row of rows) await control.step('authority', () => output.push(row)); return output;
    }
    const output = []; let after = '';
    for (;;) {
      const page = registry.readSourceScopesPage(after, 256);
      for (const row of page) await control.step('authority', () => output.push(row));
      if (page.length < 256) return output;
      after = page.at(-1).id;
    }
  }
  async registrations(control) {
    const registry = this.service.rootRegistry;
    if (!registry) return [];
    if (!registry.readSourceRegistrationsPage) return registry.read().roots;
    const output = []; let after = 0;
    for (;;) {
      const page = registry.readSourceRegistrationsPage(after, 256);
      for (const row of page) await control.step('authority', () => output.push(row));
      if (page.length < 256) return output;
      after = page.at(-1).catalogCursor;
    }
  }
  rows(kind, id, reader) {
    if (kind === 'tab') {
      if (!this.service.rootRegistry) throw Object.assign(Error('root_registry_unavailable'), { code: 'root_registry_unavailable' });
      if (typeof id !== 'string' || !id) throw Object.assign(Error('tab_id_required'), { code: 'tab_id_required' });
      return reader ? reader(id) : this.service.rootRegistry.sourcesForTab(id);
    }
    if (!this.service.db.getProjectById(id)) throw Object.assign(Error('project_not_found'), { code: 'project_not_found' });
    return this.service.db.getProjectPromptSources(id);
  }
  async readRows(kind, id, ctx) {
    if (kind === 'tab' && (typeof id !== 'string' || !id)) throw Object.assign(Error('tab_id_required'), { code: 'tab_id_required' });
    if (kind === 'tab' && ctx.reader?.header && ctx.reader?.page) {
      const header = await ctx.control.step('authority', () => ctx.reader.header(id)), output = [];
      let cursor = null;
      for (;;) {
        const page = await ctx.control.step('authority', () => ctx.reader.page(header, cursor));
        for (const row of page) await ctx.control.step('authority', () => output.push(this.service.rootRegistry.decodeCatalogSource(row, header.namespace)));
        if (page.length < 256) return output;
        cursor = page.at(-1);
      }
    }
    return ctx.control.step('authority', () => this.rows(kind, id, ctx.reader));
  }
  async signature(rows, control) {
    const hash = crypto.createHash('sha256');
    for (const row of rows) await control.step('authority', () => hash.update(JSON.stringify(row) + '\n'));
    return hash.digest('hex');
  }
  context() {
    return { control: this.control(), reader: this.service.rootRegistry?.createSourcesReader?.(), views: new Map(),
      leaves: new Map(), projects: new Map(), tokens: new Map(), selections: [], availability: null };
  }
  async request(name, run) {
    this.assertOpen(); const life = this.lifetime;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = this.context(), before = this.fence(); let value, failure;
      if (before.transaction) throw error('prompt_catalog_changed');
      try {
        value = await causal.run(name, {}, async () => {
          const value = await run(ctx);
          this.diagnostic('read', ctx.control, { authorityPasses: attempt + 1 });
          return value;
        });
      } catch (e) { failure = e; }
      // Awaiting the causal span includes its settle observers. Authority belongs
      // to THIS last frame, after diagnostics/observers and every awaited stage.
      let after = this.fence();
      if (!sameFence(before, after)) { if (attempt === 0) continue; throw error('prompt_catalog_changed'); }
      if (failure) throw failure;
      let mismatch = false;
      for (const selected of ctx.selections) if (await this.signature(await this.readRows(selected.kind, selected.id, ctx), ctx.control) !== selected.signature) mismatch = true;
      if (mismatch || !sameFence(after, this.fence())) { if (attempt === 0) continue; throw error('prompt_catalog_changed'); }
      after = this.fence();
      if (!sameFence(after, this.fence())) { if (attempt === 0) continue; throw error('prompt_catalog_changed'); }
      if (this.closed || life !== this.lifetime) throw error('prompt_catalog_changed');
      for (const [slot, snapshot] of ctx.tokens) if (this.slots.get(slot.root) !== slot || slot.snapshot !== snapshot
        || slot.state !== 'ready' || slot.epoch !== snapshot.epoch || slot.watchEpoch !== snapshot.watchEpoch || snapshot.policy !== policyVersion()) throw error('prompt_catalog_changed');
      return value;
    }
    throw error('prompt_catalog_changed');
  }
  async describe(rows, ctx) {
    const roots = [], counts = new Map();
    for (const row of rows) await ctx.control.step('map', () => {
      const root = this.service.resolveSourcePath(row.rootPath), name = path.basename(root) || root;
      roots.push(root); counts.set(name.toLocaleLowerCase(), (counts.get(name.toLocaleLowerCase()) || 0) + 1);
    });
    const output = [];
    for (let i = 0; i < rows.length; i++) {
      const detached = await copyMetadata(rows[i], ctx.control);
      await ctx.control.step('map', () => {
      const root = roots[i], name = path.basename(root) || root;
      output.push({ ...detached, rootPath: root, sourceName: counts.get(name.toLocaleLowerCase()) > 1 ? `${name} · ${path.dirname(root)}` : name });
      });
    }
    return output;
  }
  async view(root, ctx) {
    if (ctx.views.has(root)) return ctx.views.get(root);
    const slot = this.slot(root); slot.demanded = true;
    const probe = await probeSource(root, this.io.bind(this), ctx.control);
    const layout = await captureLayout(this.service.layoutStore, root, ctx.control);
    const snapshot = slot.snapshot;
    const observationKey = rowSignature([{ probe, layoutStamp: layout.stamp, policy: policyVersion() }]);
    if (snapshot && (!sameProbe(snapshot.probe, probe) || snapshot.layoutStamp !== layout.stamp || snapshot.policy !== policyVersion())
      && slot.observationKey !== observationKey) {
      slot.observationKey = observationKey; this.markDirty(slot, 'source-observation');
    }
    if (slot.state === 'failed') {
      const cause = slot.failure;
      if (!ctx.availability || ctx.availability.code === 'prompt_catalog_preparing') ctx.availability = error('prompt_catalog_failed', cause);
    } else if (!slot.snapshot || slot.state === 'preparing') {
      // Reads never bypass first-event coalescing/content-only verification.
      if (!slot.timer) this.enqueue(slot);
      ctx.availability ||= error('prompt_catalog_preparing');
    }
    const ready = slot.state === 'ready' ? slot.snapshot : null;
    if (ready) { this.assertCoverage(slot); ctx.tokens.set(slot, ready); }
    const view = { slot, ready, probe }; ctx.views.set(root, view); return view;
  }
  async catalog(kind, id, ctx) {
    const rows = await this.readRows(kind, id, ctx), signature = await this.signature(rows, ctx.control);
    ctx.selections.push({ kind, id, signature });
    const all = await this.describe(rows, ctx);
    const selected = await stableSort(kind === 'tab' ? all.filter(s => s.enabled === true) : all,
      (a, b) => naturalCompare(a.sourceName, b.sourceName), ctx.control);
    const sources = [], prompts = [];
    for (const source of selected) {
      const view = await this.view(source.rootPath, ctx), metadata = view.ready?.metadata;
      const facts = { docsPath: view.probe.docsPath, exists: view.probe.root.exists, docsExists: view.probe.docs.exists };
      const base = kind === 'tab' ? { ...source, ...facts } : { rootPath: source.rootPath, sourceName: source.sourceName, ...facts };
      sources.push({ ...base, promptCount: metadata?.prompts.length || 0 });
      for (const entry of metadata?.prompts || []) await ctx.control.step('map', () => prompts.push({
        id: `project-prompt:${kind === 'tab' ? source.projectId : id}:${crypto.createHash('sha1').update(entry.path).digest('hex').slice(0, 16)}`,
        title: entry.title, content: '', position: entry.position, group_id: null, file_paths: [entry.path],
        path: entry.path, relativePath: entry.relativePath, sourceRoot: source.rootPath,
        sourceName: source.sourceName, projectId: kind === 'tab' ? source.projectId : id,
      }));
    }
    if (kind === 'tab') return { tabId: id, sources, prompts, updatedAt: Date.now() };
    const project = this.service.db.getProjectById(id);
    if (!project) throw Object.assign(Error('project_not_found'), { code: 'project_not_found' });
    return { project: { id: project.id, name: project.name, path: project.path, icon: project.icon || null }, sources, prompts, updatedAt: Date.now() };
  }
  list(kind, id, { force = false } = {}) {
    return this.request(kind === 'tab' ? 'catalog.listTab' : 'catalog.listProject', async ctx => {
      if (force) for (const row of this.rows(kind, id, ctx.reader)) this.markDirty(this.slot(this.service.resolveSourcePath(row.rootPath)), 'explicit-refresh');
      const value = await this.catalog(kind, id, ctx);
      if (ctx.availability) throw ctx.availability; return value;
    });
  }
  async canonical(file, ctx) {
    const resolved = this.service.resolveSourcePath(file);
    if (!ctx.leaves.has(resolved)) {
      let value; try { value = await this.io('realpath', resolved); } catch { value = resolved; }
      ctx.leaves.set(resolved, value);
    }
    return ctx.leaves.get(resolved);
  }
  usage(root) {
    return this.request('catalog.usageForRoot', async ctx => {
      const wanted = await this.canonical(root, ctx), byPath = new Map(), scopes = await this.scopes(ctx.control);
      for (const scope of scopes) {
        const catalog = await this.catalog(this.service.rootRegistry ? 'tab' : 'project', scope.tabId || scope.id, ctx);
        for (const prompt of catalog.prompts) {
          if (!this.service.inside(wanted, await this.canonical(prompt.path, ctx))) continue;
          await ctx.control.step('map', () => {
            if (this.service.rootRegistry) {
              const use = byPath.get(prompt.path) || { projects: new Map(), tabs: new Map() };
              use.tabs.set(scope.tabId, { id: scope.tabId, name: scope.name || scope.tabId });
              if (prompt.projectId && !ctx.projects.has(prompt.projectId)) ctx.projects.set(prompt.projectId, this.service.db.getProjectById(prompt.projectId));
              const project = ctx.projects.get(prompt.projectId);
              if (project) use.projects.set(project.id, { id: project.id, name: project.name, icon: project.icon || null });
              byPath.set(prompt.path, use);
            } else {
              const use = byPath.get(prompt.path) || []; use.push({ id: catalog.project.id, name: catalog.project.name, icon: catalog.project.icon }); byPath.set(prompt.path, use);
            }
          });
        }
      }
      if (ctx.availability) throw ctx.availability;
      const entries = await stableSort(byPath.entries(), ([a], [b]) => naturalCompare(a, b), ctx.control), output = [];
      for (const [file, use] of entries) {
        const projects = await stableSort(this.service.rootRegistry ? use.projects.values() : use, (a, b) => naturalCompare(a.name, b.name), ctx.control);
        const tabs = [];
        if (this.service.rootRegistry) for (const tab of use.tabs.values()) await ctx.control.step('map', () => tabs.push(tab));
        await ctx.control.step('map', () => output.push({ path: file, projects, ...(this.service.rootRegistry ? { tabs } : {}) }));
      }
      return output;
    });
  }
  refreshWatchers({ recovery = false } = {}) {
    if (this.closed) return;
    if (recovery) {
      for (const entry of [...this.watchers.values()]) this.retire(entry);
      for (const slot of this.slots.values()) {
        if (slot.demanded) this.markDirty(slot, 'observation-recovery');
        else { slot.epoch++; slot.state = 'preparing'; }
      }
    }
    this.reconcileDesired = true;
    if (this.reconcileScheduled || this.reconcileRunning) return;
    this.reconcileScheduled = true;
    setImmediate(() => { this.reconcileScheduled = false; this.reconcile().catch(() => {}); });
  }
  async reconcile() {
    if (this.closed || this.reconcileRunning) return;
    this.reconcileRunning = true; this.reconcileDesired = false; this.counters.reconciliations++;
    const life = this.lifetime, control = this.control(), wanted = new Map();
    try {
      let before, registrations, stable = false;
      for (let pass = 0; pass < 2; pass++) {
        wanted.clear(); before = this.fence();
        if (before.transaction) throw error('prompt_catalog_changed');
        const ctx = { control, reader: this.service.rootRegistry?.createSourcesReader?.() };
        for (const scope of await this.scopes(control)) {
          const rows = await this.readRows(this.service.rootRegistry ? 'tab' : 'project', scope.tabId || scope.id, ctx);
          for (const row of rows) {
            if (this.service.rootRegistry && row.enabled !== true) continue;
            const root = this.service.resolveSourcePath(row.rootPath), owner = wanted.get(root) || { tabs: new Set(), projects: new Set() };
            if (scope.tabId) owner.tabs.add(scope.tabId); if (row.projectId || scope.id) owner.projects.add(row.projectId || scope.id);
            wanted.set(root, owner); await control.step('authority');
          }
        }
        registrations = await this.registrations(control);
        if (sameFence(before, this.fence())) { stable = true; break; }
      }
      if (!stable) throw error('prompt_catalog_changed');
      if (this.closed || life !== this.lifetime) return;
      for (const [root, owners] of wanted) {
        const slot = this.slot(root); slot.demanded = true; slot.tabIds = owners.tabs; slot.projectIds = owners.projects;
        if (!slot.snapshot) this.enqueue(slot);
        else {
          const probe = await probeSource(root, this.io.bind(this), control), layout = await captureLayout(this.service.layoutStore, root, control);
          if (!sameProbe(slot.snapshot.probe, probe) || slot.snapshot.layoutStamp !== layout.stamp) this.markDirty(slot, 'reconcile');
          await this.ensureWatchers(slot, probe, control);
        }
      }
      // Unbound registrations get recovery coverage only, never an eager tree scan.
      const registered = new Set();
      for (const row of registrations) {
        const root = this.service.resolveSourcePath(row.path); registered.add(root);
        if (!wanted.has(root) && this.service.watchEnabled) {
          const slot = this.slot(root); slot.demanded = false;
          const probe = await probeSource(root, this.io.bind(this), control);
          await this.ensureWatchers(slot, probe, control);
        }
      }
      for (const [root, slot] of this.slots) if (!wanted.has(root) && !registered.has(root)) this.removeSlot(slot);
      this.consumersKnown = sameFence(before, this.fence());
      this.diagnostic('reconcile', control, { sources: wanted.size, registrations: registered.size });
    } catch (e) {
      this.consumersKnown = false;
      this.diagnostic('reconcile', control, { state: 'failed', errorCode: e.code || 'reconcile_error' });
    } finally {
      this.reconcileRunning = false;
      if (this.reconcileDesired && !this.closed) this.refreshWatchers();
    }
  }
  removeSlot(slot) {
    if (this.slots.get(slot.root) !== slot) return;
    this.slots.delete(slot.root); slot.epoch++; if (slot.timer) clearTimeout(slot.timer);
    for (const key of slot.watches) { const entry = this.watchers.get(key); entry?.slots.delete(slot); if (entry && !entry.slots.size) this.retire(entry); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.lifetime++; this.queue.length = 0;
    for (const entry of [...this.watchers.values()]) this.retire(entry);
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
  }
}
module.exports = { PreparedPromptCatalog, sameFence, rowSignature };
