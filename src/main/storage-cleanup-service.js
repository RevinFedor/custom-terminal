'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  APP_STATE_KEY,
  DEFAULT_SETTINGS,
  normalizeStorageRetentionSettings,
  scanStorageInventory,
  storageItemDeletionRevision,
  summarizeInventory,
} = require('./storage-inventory');
const {
  HOUR_MS, MemoryStorageGraceStore, SqliteStorageGraceStore,
  graceApplies, graceFingerprint, reconcileStorageGrace,
} = require('./storage-retention-grace');
const { CodexStorageDeletionProvider, uniqueSessionIds } = require('./codex-storage-deletion-provider');
const { StorageDeletionAudit } = require('./storage-deletion-audit');

const SCAN_CACHE_MS = 15_000;
const DEFAULT_SWEEP_ITEMS = 25;
const DEFAULT_SWEEP_BYTES = 2 * 1024 * 1024 * 1024;

function canOwnAutomaticStorageRetention({ isPackaged = false, e2e = false } = {}) {
  return isPackaged === true && e2e !== true;
}

function isInside(root, target) {
  const base = path.resolve(root);
  const value = path.resolve(target);
  return value === base || value.startsWith(base + path.sep);
}

function deletionError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

class StorageCleanupService {
  constructor({
    sqlite,
    dbManager = null,
    appDataDir,
    projectRoot = null,
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claudeHome = path.join(os.homedir(), '.claude'),
    codexBinary = path.join(os.homedir(), '.noted-terminal', 'bin', 'codex'),
    currentEnvironment = 'production',
    relationDatabases = [],
    getRuntimeProtectedSessionIds = () => [],
    getMutationAuthority = () => ({ allowed: true, reason: 'default-authority' }),
    scanInventory = scanStorageInventory,
    graceStore = null,
    deleteCodexSession = null,
    createCodexDeletionProvider = null,
    audit = null,
    auditPath = appDataDir ? path.join(appDataDir, 'storage-deletion-audit.jsonl') : null,
    confirmationSecret = crypto.randomBytes(32),
    confirmationTtlMs = 5 * 60 * 1000,
    unlinkFile = (target) => fs.promises.unlink(target),
    removeDirectory = (target) => fs.promises.rm(target, { recursive: true, force: true }),
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.sqlite = sqlite;
    this.dbManager = dbManager;
    this.appDataDir = appDataDir;
    this.projectRoot = projectRoot;
    this.codexHome = codexHome;
    this.claudeHome = claudeHome;
    this.codexBinary = codexBinary;
    this.currentEnvironment = currentEnvironment === 'development' ? 'development' : 'production';
    this.relationDatabases = Array.isArray(relationDatabases) ? relationDatabases : [];
    this.getRuntimeProtectedSessionIds = getRuntimeProtectedSessionIds;
    this.getMutationAuthority = getMutationAuthority;
    this.scanInventory = scanInventory;
    this.graceStore = graceStore;
    this.unlinkFile = unlinkFile;
    this.removeDirectory = removeDirectory;
    this.now = now;
    this.logger = logger;
    this.audit = audit || (auditPath ? new StorageDeletionAudit({ filePath: auditPath, now }) : null);
    this.confirmationSecret = Buffer.isBuffer(confirmationSecret)
      ? confirmationSecret
      : Buffer.from(String(confirmationSecret));
    this.confirmationTtlMs = Math.max(10_000, Number(confirmationTtlMs) || 5 * 60 * 1000);
    this.deleteCodexSession = deleteCodexSession;
    this.createCodexDeletionProvider = createCodexDeletionProvider || (() => new CodexStorageDeletionProvider({
      codexHome: this.codexHome,
      command: fs.existsSync(this.codexBinary) ? this.codexBinary : 'codex',
    }));
    this.cached = null;
    this.scanInflight = null;
  }

  getSettings() {
    let saved = null;
    try { saved = this.dbManager?.getAppState?.(APP_STATE_KEY); } catch {}
    return normalizeStorageRetentionSettings(saved || DEFAULT_SETTINGS);
  }

  setSettings(value) {
    const settings = normalizeStorageRetentionSettings(value);
    this.dbManager?.setAppState?.(APP_STATE_KEY, settings);
    this.cached = null;
    return settings;
  }

  async scan({ force = false } = {}) {
    const nowMs = this.now();
    if (!force && this.cached && nowMs - this.cached.scannedAt < SCAN_CACHE_MS) return this.cached;
    if (this.scanInflight) return this.scanInflight;
    this.scanInflight = this.scanInventory({
      sqlite: this.sqlite,
      codexHome: this.codexHome,
      claudeHome: this.claudeHome,
      projectRoot: this.projectRoot,
      appDataDir: this.appDataDir,
      runtimeProtectedSessionIds: this.getRuntimeProtectedSessionIds(),
      currentEnvironment: this.currentEnvironment,
      relationDatabases: this.relationDatabases,
      settings: this.getSettings(),
      nowMs,
    }).then((result) => {
      if (result.success !== true) throw deletionError('storage_inventory_failed', 'Storage inventory is unavailable');
      const settings = normalizeStorageRetentionSettings(result.settings);
      // Read the clock after asynchronous I/O and reconcile inside one DB
      // transaction: a binding committed during the scan cannot restore an
      // earlier eligible clock from an in-memory snapshot.
      const items = this._getGraceStore().reconcile((previous) => (
        reconcileStorageGrace(result.items, settings, this.now(), previous)
      ));
      const snapshot = {
        ...result,
        settings,
        summary: summarizeInventory(items),
        items: items.map((item) => ({
          ...item,
          deletionRevision: storageItemDeletionRevision(item),
        })),
      };
      this.cached = snapshot;
      return snapshot;
    }).finally(() => {
      this.scanInflight = null;
    });
    return this.scanInflight;
  }

  _getGraceStore() {
    this.graceStore ||= typeof this.sqlite?.exec === 'function'
      ? new SqliteStorageGraceStore(this.sqlite) : new MemoryStorageGraceStore();
    return this.graceStore;
  }

  _assertRetentionReady(item) {
    const settings = this.getSettings();
    const days = item.section === 'builds' ? settings.retentionDays.build
      : item.group === 'app-backup' ? settings.retentionDays.appBackup
        : Object.hasOwn(settings.retentionDays, item.group)
          ? settings.retentionDays[item.group] : settings.retentionDays.regular;
    const clock = this._getGraceStore().get(item.id);
    const baseAt = item.closedAt || item.modifiedAt || item.createdAt || this.now();
    const readyAt = Math.max(
      baseAt + Number(days) * 24 * HOUR_MS,
      Number(clock?.since) + settings.gracePeriodHours * HOUR_MS,
    );
    if (!graceApplies(item) || settings.enabled !== true || days == null
      || item.eligible !== true || !clock || clock.fingerprint !== graceFingerprint(item)
      || !Number.isFinite(readyAt) || readyAt > this.now()) {
      throw deletionError('storage_retention_waiting', 'Session protection changed or its full waiting period has not elapsed');
    }
  }

  _assertAllowedPath(item) {
    const target = path.resolve(String(item?.path || ''));
    const allowedRoots = [
      path.join(this.codexHome, 'sessions'),
      path.join(this.codexHome, 'archived_sessions'),
      path.join(this.claudeHome, 'projects'),
      this.appDataDir,
      this.projectRoot,
      '/private/tmp',
    ].filter(Boolean);
    if (!target || !allowedRoots.some((root) => isInside(root, target))) {
      throw deletionError('storage_path_not_allowed', 'Storage target is outside allowlisted roots');
    }
    return target;
  }

  _mutationAuthority() {
    try {
      const authority = this.getMutationAuthority?.();
      if (authority === true) return { allowed: true, reason: 'boolean-authority' };
      if (authority && typeof authority === 'object') {
        return {
          allowed: authority.allowed === true,
          reason: String(authority.reason || (authority.allowed ? 'authority-proven' : 'authority-unavailable')),
        };
      }
    } catch (error) {
      return { allowed: false, reason: error?.message || 'authority-check-failed' };
    }
    return { allowed: false, reason: 'authority-unavailable' };
  }

  _databaseReference(sqlite, sessionIds, { includeDurableRelations = false } = {}) {
    if (!sqlite || typeof sqlite.prepare !== 'function') return null;
    const placeholders = sessionIds.map(() => '?').join(',');
    const probes = [{
      reference: 'tab',
      sql: `SELECT codex_session_id, claude_session_id FROM tabs
            WHERE claude_session_id IN (${placeholders}) OR codex_session_id IN (${placeholders}) LIMIT 1`,
      values: [...sessionIds, ...sessionIds],
      fields: ['codex_session_id', 'claude_session_id'],
    }];
    if (includeDurableRelations) {
      probes.push({
        reference: 'home-history',
        sql: `SELECT codex_session_id, claude_session_id FROM tab_history
              WHERE claude_session_id IN (${placeholders}) OR codex_session_id IN (${placeholders}) LIMIT 1`,
        values: [...sessionIds, ...sessionIds],
        fields: ['codex_session_id', 'claude_session_id'],
      }, {
        reference: 'favorite',
        sql: `SELECT codex_session_id, claude_session_id FROM favorites
              WHERE claude_session_id IN (${placeholders}) OR codex_session_id IN (${placeholders}) LIMIT 1`,
        values: [...sessionIds, ...sessionIds],
        fields: ['codex_session_id', 'claude_session_id'],
      }, {
        reference: 'session-history-event',
        sql: `SELECT child_session_id, source_session_id FROM session_history_events
              WHERE child_session_id IN (${placeholders}) OR source_session_id IN (${placeholders}) LIMIT 1`,
        values: [...sessionIds, ...sessionIds],
        fields: ['child_session_id', 'source_session_id'],
      });
    }
    for (const probe of probes) {
      const row = sqlite.prepare(probe.sql).get(...probe.values);
      if (row) {
        const matchedSessionId = probe.fields
          .map((field) => String(row[field] || ''))
          .find((value) => sessionIds.includes(value));
        return { reference: probe.reference, sessionId: matchedSessionId || null };
      }
    }
    return null;
  }

  _sessionStillReferenced(item, closureSessionIds) {
    if (item?.section !== 'sessions' || !item.sessionId) return null;
    const sessionIds = uniqueSessionIds(closureSessionIds?.length ? closureSessionIds : [item.sessionId]);
    const runtime = new Set((this.getRuntimeProtectedSessionIds() || []).map(String));
    const runtimeSessionId = sessionIds.find((sessionId) => runtime.has(sessionId));
    if (runtimeSessionId) return { reason: 'runtime-session', sessionId: runtimeSessionId, environment: this.currentEnvironment };

    const databases = [{ sqlite: this.sqlite, environment: this.currentEnvironment, current: true }];
    for (const source of this.relationDatabases) {
      if (!source?.sqlite || source.sqlite === this.sqlite) continue;
      databases.push({ sqlite: source.sqlite, environment: source.environment || 'unknown', current: false });
    }
    for (const source of databases) {
      const foreignProduction = this.currentEnvironment === 'development'
        && source.environment === 'production';
      if (!source.current && !foreignProduction) continue;
      try {
        const match = this._databaseReference(source.sqlite, sessionIds, {
          includeDurableRelations: foreignProduction,
        });
        if (match) return { ...match, reason: 'noted-terminal-reference', environment: source.environment };
      } catch (error) {
        return {
          reason: 'reference-check-failed',
          environment: source.environment,
          error: error?.message || String(error),
        };
      }
    }
    return null;
  }

  _protectedClosureItem(item, closureSessionIds, inventoryItems) {
    const closure = new Set(uniqueSessionIds(closureSessionIds));
    return (Array.isArray(inventoryItems) ? inventoryItems : []).find((candidate) => (
      candidate?.section === 'sessions'
      && candidate?.provider === item?.provider
      && closure.has(String(candidate?.sessionId || ''))
      && (candidate.protected === true || candidate.deletable !== true)
    )) || null;
  }

  _legacyCodexDeletionProvider() {
    return {
      inspectDeleteClosure: async (sessionId, item) => uniqueSessionIds(
        Array.isArray(item?.affectedSessionIds) && item.affectedSessionIds.length > 0
          ? item.affectedSessionIds
          : [sessionId],
      ),
      deleteSession: async (sessionId, expectedSessionIds, item) => {
        const result = await this.deleteCodexSession(sessionId, item);
        return {
          deletedSessionIds: uniqueSessionIds(result?.deletedSessionIds?.length
            ? result.deletedSessionIds
            : expectedSessionIds),
          expectedSessionIds: uniqueSessionIds(expectedSessionIds),
          notificationsComplete: result?.notificationsComplete !== false,
        };
      },
      close() {},
    };
  }

  _signDeleteConfirmation(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', this.confirmationSecret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  _verifyDeleteConfirmation(token, { itemIds, generation }) {
    const [body, signature, extra] = String(token || '').split('.');
    if (!body || !signature || extra) {
      throw deletionError('storage_delete_confirmation_required', 'A fresh deletion confirmation is required');
    }
    const expected = crypto.createHmac('sha256', this.confirmationSecret).update(body).digest();
    let actual = null;
    try { actual = Buffer.from(signature, 'base64url'); } catch {}
    if (!actual || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw deletionError('storage_delete_confirmation_invalid', 'Deletion confirmation is invalid');
    }
    let payload = null;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch {}
    const expectedItemIds = uniqueSessionIds(itemIds).sort();
    const confirmedItemIds = uniqueSessionIds(payload?.itemIds).sort();
    if (![1, 2].includes(payload?.version)
      || payload?.generation !== generation
      || JSON.stringify(expectedItemIds) !== JSON.stringify(confirmedItemIds)) {
      throw deletionError('storage_delete_confirmation_invalid', 'Deletion confirmation does not match the requested items');
    }
    if (!Number.isFinite(Number(payload?.expiresAt)) || Number(payload.expiresAt) < this.now()) {
      throw deletionError('storage_delete_confirmation_expired', 'Deletion confirmation expired; review the current scope again');
    }
    return payload;
  }

  _checkItemRevisions(inventory, revisions, itemIds, phase) {
    const byId = new Map(inventory.items.map((item) => [item.id, item]));
    const changedItems = itemIds.filter((id) => (
      !byId.has(id) || revisions?.[id] !== byId.get(id).deletionRevision
    )).map((id) => ({
      itemId: id,
      title: byId.get(id)?.title || null,
      reason: !byId.has(id) ? 'item-missing'
        : byId.get(id).protected || !byId.get(id).deletable ? 'item-protected'
          : 'item-changed',
    }));
    if (changedItems.length === 0) return null;
    this.logger.log?.('[StorageCleanup:ScopeRejected] ' + JSON.stringify({ phase, changedItems }));
    return { success: false, error: 'storage_scan_stale', scope: 'selected-items', changedItems, currentGeneration: inventory.generation };
  }

  async prepareDeleteItems({ itemIds, generation, itemRevisions = null } = {}) {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String).filter(Boolean))];
    if (ids.length === 0) return { success: false, error: 'storage_item_ids_required' };
    const authority = this._mutationAuthority();
    if (!authority.allowed) {
      return { success: false, error: 'storage_production_authority_unavailable', reason: authority.reason };
    }
    const before = await this.scan({ force: true });
    const scoped = itemRevisions != null;
    if (scoped) {
      if (typeof itemRevisions !== 'object' || Array.isArray(itemRevisions)
        || JSON.stringify(Object.keys(itemRevisions).sort()) !== JSON.stringify([...ids].sort())) {
        return { success: false, error: 'storage_item_revisions_invalid' };
      }
      const rejected = this._checkItemRevisions(before, itemRevisions, ids, 'prepare');
      if (rejected) return rejected;
    } else if (!generation || generation !== before.generation) {
      return { success: false, error: 'storage_scan_stale', currentGeneration: before.generation };
    }
    const byId = new Map(before.items.map((item) => [item.id, item]));
    const requested = ids.map((id) => byId.get(id)).filter(Boolean);
    if (requested.length !== ids.length) {
      return { success: false, error: 'storage_item_missing', currentGeneration: before.generation };
    }
    const canonicalSessionItems = new Map();
    for (const item of before.items) {
      if (item?.section !== 'sessions' || !item?.sessionId || item?.recoveryCopy) continue;
      const key = `${item.provider}:${item.sessionId}`;
      if (!canonicalSessionItems.has(key)) canonicalSessionItems.set(key, item);
    }
    const closures = {};
    const affectedKeys = new Set();
    const affectedItemIds = new Set(ids);
    let affectedBytes = 0;
    let codexProvider = null;
    try {
      for (const item of requested) {
        if (!item || item.deletable !== true || item.protected === true) {
          return { success: false, error: 'storage_item_protected', detail: item?.protectedReason || 'Storage item is protected' };
        }
        let closureSessionIds = uniqueSessionIds([item.sessionId]);
        if (item.provider === 'codex' && item.recoveryCopy !== true) {
          codexProvider ||= this.deleteCodexSession
            ? this._legacyCodexDeletionProvider()
            : this.createCodexDeletionProvider();
          closureSessionIds = uniqueSessionIds(await codexProvider.inspectDeleteClosure(item.sessionId, item));
          const protectedClosureItem = this._protectedClosureItem(item, closureSessionIds, before.items);
          if (protectedClosureItem) {
            return {
              success: false,
              error: 'storage_codex_descendant_protected',
              protectedSessionId: protectedClosureItem.sessionId,
              detail: protectedClosureItem.protectedReason || 'Codex delete would remove a protected descendant',
            };
          }
        }
        const currentReference = this._sessionStillReferenced(item, closureSessionIds);
        if (currentReference) {
          return {
            success: false,
            error: 'storage_session_became_protected',
            protectedSessionId: currentReference.sessionId || null,
            detail: 'Session or a provider-owned descendant is protected by Noted Terminal',
          };
        }
        closures[item.id] = closureSessionIds;
        if (item.section === 'sessions' && item.sessionId && item.recoveryCopy !== true) {
          for (const sessionId of closureSessionIds) {
            const key = `${item.provider}:${sessionId}`;
            if (affectedKeys.has(key)) continue;
            affectedKeys.add(key);
            const physicalItem = canonicalSessionItems.get(key);
            if (physicalItem) affectedItemIds.add(physicalItem.id);
            affectedBytes += Number(physicalItem?.sizeBytes) || 0;
          }
        } else if (!affectedKeys.has(`item:${item.id}`)) {
          affectedKeys.add(`item:${item.id}`);
          affectedBytes += Number(item.sizeBytes) || 0;
        }
      }
    } catch (error) {
      return { success: false, error: error?.code || 'storage_delete_preflight_failed', detail: error?.message || String(error) };
    } finally {
      try { codexProvider?.close?.(); } catch {}
    }
    const issuedAt = this.now();
    const payload = {
      version: scoped ? 2 : 1,
      generation: before.generation,
      itemIds: [...ids].sort(),
      closures,
      ...(scoped ? { itemRevisions: Object.fromEntries([...affectedItemIds].map((id) => [id, byId.get(id).deletionRevision])) } : {}),
      issuedAt,
      expiresAt: issuedAt + this.confirmationTtlMs,
    };
    return {
      success: true,
      generation: before.generation,
      confirmationToken: this._signDeleteConfirmation(payload),
      affectedItems: affectedKeys.size,
      affectedBytes,
      expiresAt: payload.expiresAt,
    };
  }

  _auditPayload({ operationId, source, status, item, closureSessionIds = [], deletedSessionIds = [], error = null }) {
    return {
      operationId,
      source,
      environment: this.currentEnvironment,
      status,
      itemId: item?.id || null,
      provider: item?.provider || null,
      sessionId: item?.sessionId || null,
      group: item?.group || null,
      path: item?.path || null,
      sizeBytes: Number(item?.sizeBytes) || 0,
      closureSessionIds: uniqueSessionIds(closureSessionIds),
      deletedSessionIds: uniqueSessionIds(deletedSessionIds),
      error: error ? {
        code: error?.code || null,
        message: error?.message || String(error),
      } : null,
    };
  }

  async _recordAudit(payload, { required = false } = {}) {
    if (!this.audit || typeof this.audit.record !== 'function') {
      if (required) throw deletionError('storage_deletion_audit_unavailable', 'Deletion audit is unavailable');
      return;
    }
    try {
      await this.audit.record(payload);
    } catch (error) {
      this.logger.error?.('[StorageCleanup:Audit] write failed:', error?.message || error);
      if (required) {
        throw deletionError('storage_deletion_audit_unavailable', 'Deletion audit could not be written', {
          cause: error,
        });
      }
    }
  }

  _logItem(payload) {
    this.logger.log?.('[StorageCleanup:Item] ' + JSON.stringify({
      operationId: payload.operationId,
      source: payload.source,
      environment: payload.environment,
      status: payload.status,
      provider: payload.provider,
      sessionId: payload.sessionId,
      group: payload.group,
      sizeBytes: payload.sizeBytes,
      closureSessionIds: payload.closureSessionIds,
      deletedSessionIds: payload.deletedSessionIds,
      error: payload.error?.code || null,
    }));
  }

  async _deleteOne(item, { codexProvider = null, closureSessionIds = [], source = 'manual' } = {}) {
    if (!item || item.deletable !== true || item.protected === true) {
      throw deletionError('storage_item_protected', item?.protectedReason || 'Storage item is protected');
    }
    let finalClosureSessionIds = uniqueSessionIds(closureSessionIds);
    if (item.provider === 'codex' && item.recoveryCopy !== true) {
      const latestClosure = uniqueSessionIds(await codexProvider.inspectDeleteClosure(item.sessionId, item));
      const allowed = new Set(finalClosureSessionIds);
      const newlyAffected = latestClosure.filter((sessionId) => !allowed.has(sessionId));
      if (newlyAffected.length > 0) {
        throw deletionError('storage_delete_confirmation_stale', 'Codex deletion scope expanded immediately before mutation', {
          unexpectedDescendantSessionIds: newlyAffected,
        });
      }
      finalClosureSessionIds = latestClosure;
    }
    if (source === 'retention') {
      const stat = await fs.promises.stat(item.path);
      if ((item.modifiedAt && stat.mtimeMs !== item.modifiedAt)
        || (item.fileIdentity && `${stat.dev}:${stat.ino}` !== item.fileIdentity)) {
        throw deletionError('storage_retention_source_changed', 'Storage file changed during automatic cleanup');
      }
      this._assertRetentionReady(item);
    }
    const currentReference = this._sessionStillReferenced(item, finalClosureSessionIds);
    if (currentReference) {
      throw deletionError('storage_session_became_protected', 'Session or a provider-owned descendant became protected after the storage scan', {
        protectedReference: currentReference,
      });
    }
    const target = this._assertAllowedPath(item);
    if (item.section === 'sessions') {
      if (item.provider === 'codex' && item.recoveryCopy !== true) {
        const deletion = await codexProvider.deleteSession(item.sessionId, finalClosureSessionIds, item);
        // Old/manual rollouts may not be registered in the current Codex state
        // store. If upstream reports success but leaves this exact file, refuse
        // to silently claim reclaimed bytes.
        if (fs.existsSync(target)) {
          throw deletionError('codex_session_file_still_present', 'Codex delete completed but the rollout file is still present');
        }
        return deletion;
      } else {
        await this.unlinkFile(target);
        if (item.provider === 'claude') {
          for (const auxiliaryPath of Array.isArray(item.auxiliaryPaths) ? item.auxiliaryPaths : []) {
            if (!isInside(path.join(this.claudeHome, 'projects'), auxiliaryPath)) continue;
            await this.removeDirectory(auxiliaryPath);
          }
        }
      }
      return { deletedSessionIds: item.sessionId ? [item.sessionId] : [] };
    }
    if (item.section === 'builds') {
      if (item.protected) throw deletionError('storage_item_protected', item.protectedReason);
      await this.removeDirectory(target);
      return { deletedSessionIds: [] };
    }
    if (item.section === 'app' && item.group === 'app-backup') {
      await this.unlinkFile(target);
      return { deletedSessionIds: [] };
    }
    throw deletionError('storage_item_not_deletable', 'This storage category has no delete contract');
  }

  async deleteItems({ itemIds, generation, source = 'manual', operationId = null, confirmationToken = null, onProgress = null } = {}) {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String).filter(Boolean))];
    if (ids.length === 0) return { success: false, error: 'storage_item_ids_required' };
    const authority = this._mutationAuthority();
    if (!authority.allowed) {
      return { success: false, error: 'storage_production_authority_unavailable', reason: authority.reason };
    }
    const resolvedOperationId = String(operationId || '').trim()
      || `storage-${source}-${this.now().toString(36)}`;
    const before = await this.scan({ force: true });
    let deleteConfirmation = null;
    if (source === 'dashboard') {
      try {
        deleteConfirmation = this._verifyDeleteConfirmation(confirmationToken, { itemIds: ids, generation });
      } catch (error) {
        return { success: false, error: error?.code || 'storage_delete_confirmation_invalid', detail: error?.message || String(error) };
      }
    }
    if (deleteConfirmation?.version === 2) {
      const revisions = deleteConfirmation.itemRevisions;
      if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)
        || ids.some((id) => typeof revisions[id] !== 'string')) {
        return { success: false, error: 'storage_delete_confirmation_invalid' };
      }
      const rejected = this._checkItemRevisions(before, revisions, Object.keys(revisions), 'confirm');
      if (rejected) return rejected;
    } else if (!generation || generation !== before.generation) {
      return { success: false, error: 'storage_scan_stale', currentGeneration: before.generation };
    }
    const byId = new Map(before.items.map((item) => [item.id, item]));
    const requested = ids.map((id) => byId.get(id)).filter(Boolean);
    if (requested.length !== ids.length) {
      return { success: false, error: 'storage_item_missing', currentGeneration: before.generation };
    }
    const failures = [];
    const removed = [];
    const removedSessions = [];
    let reclaimedBytes = 0;
    let completed = 0;
    const publishProgress = (item, status) => {
      completed += 1;
      if (typeof onProgress !== 'function') return;
      try {
        onProgress({
          completed,
          total: requested.length,
          removed: removed.length,
          failed: failures.length,
          reclaimedBytes,
          itemId: item?.id || null,
          sessionId: item?.sessionId || null,
          title: item?.title || item?.sessionId || null,
          status,
        });
      } catch {}
    };
    // Leaves first: upstream Codex delete can remove descendants, so handling
    // explicitly selected children before a selected parent keeps outcomes
    // deterministic and avoids counting the same file twice.
    requested.sort((a, b) => (a.affectedItems || 1) - (b.affectedItems || 1) || b.sizeBytes - a.sizeBytes);
    let codexProvider = null;
    try {
      for (const item of requested) {
        const confirmedClosureSessionIds = uniqueSessionIds(deleteConfirmation
          ? deleteConfirmation.closures?.[item.id]
          : (Array.isArray(item.affectedSessionIds) && item.affectedSessionIds.length > 0
            ? item.affectedSessionIds
            : [item.sessionId]));
        let closureSessionIds = confirmedClosureSessionIds;
        if (!fs.existsSync(item.path)) {
          const payload = this._auditPayload({
            operationId: resolvedOperationId, source, status: 'already-missing', item, closureSessionIds,
          });
          await this._recordAudit(payload);
          this._logItem(payload);
          publishProgress(item, 'already-missing');
          continue;
        }
        try {
          if (item.provider === 'codex' && item.recoveryCopy !== true) {
            codexProvider ||= this.deleteCodexSession
              ? this._legacyCodexDeletionProvider()
              : this.createCodexDeletionProvider();
            closureSessionIds = uniqueSessionIds(await codexProvider.inspectDeleteClosure(item.sessionId, item));
            const protectedClosureItem = this._protectedClosureItem(item, closureSessionIds, before.items);
            if (protectedClosureItem) {
              throw deletionError('storage_codex_descendant_protected', 'Codex delete would remove a protected descendant', {
                protectedSessionId: protectedClosureItem.sessionId,
                protectedReason: protectedClosureItem.protectedReason || 'protected',
              });
            }
            if (source === 'retention' && closureSessionIds.length > 1) {
              throw deletionError('storage_codex_retention_requires_provider_leaf', 'Automatic retention only deletes a provider-proven Codex leaf');
            }
            const confirmedClosure = new Set(confirmedClosureSessionIds);
            const unexpectedDescendants = closureSessionIds.filter((sessionId) => !confirmedClosure.has(sessionId));
            if (unexpectedDescendants.length > 0) {
              throw deletionError(deleteConfirmation ? 'storage_delete_confirmation_stale' : 'storage_codex_delete_closure_expanded', 'Codex delete would affect sessions that were not included in the confirmation', {
                unexpectedDescendantSessionIds: unexpectedDescendants,
              });
            }
          }
          const attempt = this._auditPayload({
            operationId: resolvedOperationId, source, status: 'attempt', item, closureSessionIds,
          });
          await this._recordAudit(attempt, { required: true });
          this._logItem(attempt);
          const deletion = await this._deleteOne(item, { codexProvider, closureSessionIds, source });
          const deletedSessionIds = Array.isArray(deletion?.deletedSessionIds)
            ? uniqueSessionIds(deletion.deletedSessionIds)
            : closureSessionIds;
          removed.push(item.id);
          removedSessions.push(...deletedSessionIds);
          reclaimedBytes += Number(item.sizeBytes) || 0;
          const payload = this._auditPayload({
            operationId: resolvedOperationId,
            source,
            status: deletion?.notificationsComplete === false ? 'removed-notifications-incomplete' : 'removed',
            item,
            closureSessionIds,
            deletedSessionIds,
          });
          await this._recordAudit(payload);
          this._logItem(payload);
          publishProgress(item, 'removed');
        } catch (error) {
          failures.push({
            itemId: item.id,
            sessionId: item.sessionId || null,
            closureSessionIds,
            protectedSessionId: error?.protectedSessionId || error?.protectedReference?.sessionId || null,
            unexpectedDescendantSessionIds: error?.unexpectedDescendantSessionIds || [],
            error: error?.code || error?.message || String(error),
            detail: error?.message || String(error),
          });
          const payload = this._auditPayload({
            operationId: resolvedOperationId, source, status: 'failed', item, closureSessionIds, error,
          });
          await this._recordAudit(payload);
          this._logItem(payload);
          publishProgress(item, 'failed');
        }
      }
    } finally {
      try { codexProvider?.close?.(); } catch {}
    }
    this.cached = null;
    this.logger.log?.('[StorageCleanup] source=' + source
      + ' requested=' + ids.length
      + ' removed=' + removed.length
      + ' failed=' + failures.length
      + ' reclaimedBytes=' + reclaimedBytes
      + ' sessions=' + JSON.stringify(uniqueSessionIds(removedSessions)));
    return {
      success: failures.length === 0,
      removed,
      removedSessions: uniqueSessionIds(removedSessions),
      failures,
      reclaimedBytes,
      requested: ids.length,
    };
  }

  async runRetentionSweep({
    maxItems = DEFAULT_SWEEP_ITEMS,
    maxBytes = DEFAULT_SWEEP_BYTES,
  } = {}) {
    const inventory = await this.scan({ force: true });
    if (inventory.settings.enabled !== true) return { success: true, skipped: true, reason: 'retention-disabled' };
    const candidates = inventory.items
      .filter((item) => item.eligible === true)
      // Builds can belong to a concurrent compiler in another worktree. They
      // remain visible/cleanable manually until a process-owned build lease is
      // added; automatic retention handles sessions and DB recovery files.
      .filter((item) => item.section === 'sessions' || item.group === 'app-backup')
      .filter((item) => item.provider !== 'codex' || (item.affectedItems || 1) === 1)
      .sort((a, b) => a.deleteAfter - b.deleteAfter || b.sizeBytes - a.sizeBytes);
    const selected = [];
    let bytes = 0;
    for (const item of candidates) {
      if (selected.length >= maxItems) break;
      if (selected.length > 0 && bytes + item.sizeBytes > maxBytes) break;
      selected.push(item);
      bytes += item.sizeBytes;
    }
    if (selected.length === 0) return { success: true, removed: [], reclaimedBytes: 0, remainingEligible: 0 };
    const result = await this.deleteItems({
      itemIds: selected.map((item) => item.id),
      generation: inventory.generation,
      source: 'retention',
      operationId: `storage-retention-${this.now().toString(36)}`,
    });
    return {
      ...result,
      remainingEligible: Math.max(0, candidates.length - selected.length),
    };
  }
}

module.exports = {
  DEFAULT_SWEEP_BYTES,
  DEFAULT_SWEEP_ITEMS,
  StorageCleanupService,
  canOwnAutomaticStorageRetention,
  deletionError,
  isInside,
};
