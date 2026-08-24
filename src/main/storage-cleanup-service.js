'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  APP_STATE_KEY,
  DEFAULT_SETTINGS,
  normalizeStorageRetentionSettings,
  scanStorageInventory,
} = require('./storage-inventory');

const SCAN_CACHE_MS = 15_000;
const DEFAULT_SWEEP_ITEMS = 25;
const DEFAULT_SWEEP_BYTES = 2 * 1024 * 1024 * 1024;

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
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
    getRuntimeProtectedSessionIds = () => [],
    scanInventory = scanStorageInventory,
    deleteCodexSession = null,
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
    this.getRuntimeProtectedSessionIds = getRuntimeProtectedSessionIds;
    this.scanInventory = scanInventory;
    this.unlinkFile = unlinkFile;
    this.removeDirectory = removeDirectory;
    this.now = now;
    this.logger = logger;
    this.deleteCodexSession = deleteCodexSession || (async (sessionId) => {
      const binary = fs.existsSync(this.codexBinary) ? this.codexBinary : 'codex';
      return execFileAsync(binary, ['delete', '--force', sessionId]);
    });
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
      settings: this.getSettings(),
      nowMs,
    }).then((result) => {
      this.cached = result;
      return result;
    }).finally(() => {
      this.scanInflight = null;
    });
    return this.scanInflight;
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

  _sessionStillOpen(item) {
    if (item?.section !== 'sessions' || !item.sessionId) return false;
    const sessionIds = [...new Set(
      (Array.isArray(item.affectedSessionIds) ? item.affectedSessionIds : [item.sessionId])
        .map(String)
        .filter(Boolean),
    )];
    const runtime = new Set((this.getRuntimeProtectedSessionIds() || []).map(String));
    if (sessionIds.some((sessionId) => runtime.has(sessionId))) return true;
    if (!this.sqlite || typeof this.sqlite.prepare !== 'function') return false;
    try {
      const placeholders = sessionIds.map(() => '?').join(',');
      const row = this.sqlite.prepare(`
        SELECT 1 AS found FROM tabs
        WHERE claude_session_id IN (${placeholders})
           OR codex_session_id IN (${placeholders})
        LIMIT 1
      `).get(...sessionIds, ...sessionIds);
      return !!row;
    } catch {
      return true;
    }
  }

  async _deleteOne(item) {
    if (!item || item.deletable !== true || item.protected === true) {
      throw deletionError('storage_item_protected', item?.protectedReason || 'Storage item is protected');
    }
    if (this._sessionStillOpen(item)) {
      throw deletionError('storage_session_became_open', 'Session became open after the storage scan');
    }
    const target = this._assertAllowedPath(item);
    if (item.section === 'sessions') {
      if (item.provider === 'codex' && item.recoveryCopy !== true) {
        await this.deleteCodexSession(item.sessionId, item);
        // Old/manual rollouts may not be registered in the current Codex state
        // store. If upstream reports success but leaves this exact file, refuse
        // to silently claim reclaimed bytes.
        if (fs.existsSync(target)) {
          throw deletionError('codex_session_file_still_present', 'Codex delete completed but the rollout file is still present');
        }
      } else {
        await this.unlinkFile(target);
        if (item.provider === 'claude') {
          for (const auxiliaryPath of Array.isArray(item.auxiliaryPaths) ? item.auxiliaryPaths : []) {
            if (!isInside(path.join(this.claudeHome, 'projects'), auxiliaryPath)) continue;
            await this.removeDirectory(auxiliaryPath);
          }
        }
      }
      return;
    }
    if (item.section === 'builds') {
      if (item.protected) throw deletionError('storage_item_protected', item.protectedReason);
      await this.removeDirectory(target);
      return;
    }
    if (item.section === 'app' && item.group === 'app-backup') {
      await this.unlinkFile(target);
      return;
    }
    throw deletionError('storage_item_not_deletable', 'This storage category has no delete contract');
  }

  async deleteItems({ itemIds, generation, source = 'manual' } = {}) {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String).filter(Boolean))];
    if (ids.length === 0) return { success: false, error: 'storage_item_ids_required' };
    const before = await this.scan({ force: true });
    if (!generation || generation !== before.generation) {
      return { success: false, error: 'storage_scan_stale', currentGeneration: before.generation };
    }
    const byId = new Map(before.items.map((item) => [item.id, item]));
    const requested = ids.map((id) => byId.get(id)).filter(Boolean);
    if (requested.length !== ids.length) {
      return { success: false, error: 'storage_item_missing', currentGeneration: before.generation };
    }
    const failures = [];
    const removed = [];
    let reclaimedBytes = 0;
    // Leaves first: upstream Codex delete can remove descendants, so handling
    // explicitly selected children before a selected parent keeps outcomes
    // deterministic and avoids counting the same file twice.
    requested.sort((a, b) => (a.affectedItems || 1) - (b.affectedItems || 1) || b.sizeBytes - a.sizeBytes);
    for (const item of requested) {
      if (!fs.existsSync(item.path)) continue;
      try {
        await this._deleteOne(item);
        removed.push(item.id);
        reclaimedBytes += Number(item.sizeBytes) || 0;
      } catch (error) {
        failures.push({
          itemId: item.id,
          sessionId: item.sessionId || null,
          error: error?.code || error?.message || String(error),
          detail: error?.message || String(error),
        });
      }
    }
    this.cached = null;
    this.logger.log?.('[StorageCleanup] source=' + source
      + ' requested=' + ids.length
      + ' removed=' + removed.length
      + ' failed=' + failures.length
      + ' reclaimedBytes=' + reclaimedBytes);
    return {
      success: failures.length === 0,
      removed,
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
  deletionError,
  isInside,
};
