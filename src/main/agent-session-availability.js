'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const DEFAULT_CACHE_MS = 15_000;
const DEFAULT_MATERIALIZATION_GRACE_MS = 15_000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProvider(value) {
  const provider = clean(value).toLowerCase();
  return provider === 'claude' || provider === 'codex' || provider === 'gemini'
    ? provider
    : null;
}

function sessionKey(provider, sessionId) {
  return `${provider}:${String(sessionId || '').toLowerCase()}`;
}

function descriptorKey(descriptor) {
  return `${clean(descriptor?.tabId) || '-'}:${sessionKey(descriptor?.provider, descriptor?.sessionId)}`;
}

function normalizeDescriptor(value) {
  const provider = normalizeProvider(value?.provider);
  const sessionId = clean(value?.sessionId).toLowerCase();
  if (!provider || !sessionId) return null;
  return {
    tabId: clean(value?.tabId),
    provider,
    sessionId,
    cwd: clean(value?.cwd) || null,
  };
}

async function pathState(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? 'present' : 'missing';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    return 'unknown';
  }
}

async function readDir(dirPath) {
  try {
    return { entries: await fs.promises.readdir(dirPath, { withFileTypes: true }), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { entries: [], error: null };
    return { entries: [], error };
  }
}

function idsInFilename(filename, wanted) {
  UUID_RE.lastIndex = 0;
  const found = [];
  let match;
  while ((match = UUID_RE.exec(filename)) !== null) {
    const id = String(match[0]).toLowerCase();
    if (wanted.has(id)) found.push(id);
  }
  return found;
}

async function scanClaudeProjects(root, wanted) {
  const matches = new Map();
  let authoritative = true;
  const projects = await readDir(root);
  if (projects.error) authoritative = false;
  for (const project of projects.entries) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const listing = await readDir(projectDir);
    if (listing.error) {
      authoritative = false;
      continue;
    }
    for (const entry of listing.entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length).toLowerCase();
      if (!wanted.has(sessionId) || matches.has(sessionId)) continue;
      matches.set(sessionId, { filePath: path.join(projectDir, entry.name), location: 'active' });
    }
  }
  return { matches, authoritative };
}

async function scanCodexTree(root, wanted, location) {
  const matches = new Map();
  let authoritative = true;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const listing = await readDir(dir);
    if (listing.error) {
      authoritative = false;
      continue;
    }
    for (const entry of listing.entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      for (const sessionId of idsInFilename(entry.name, wanted)) {
        if (!matches.has(sessionId)) matches.set(sessionId, { filePath, location });
      }
    }
  }
  return { matches, authoritative };
}

async function readGeminiSessionId(filePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return clean(parsed?.sessionId).toLowerCase() || null;
  } catch {
    return null;
  }
}

class AgentSessionAvailabilityService {
  constructor({
    claudeProjectsDir = require('./claude-paths').claudeProjectsDir(),
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    resolveGeminiProjectDir = null,
    getCodexLineageManifest = null,
    isRuntimeActive = null,
    cacheMs = DEFAULT_CACHE_MS,
    materializationGraceMs = DEFAULT_MATERIALIZATION_GRACE_MS,
    now = () => Date.now(),
  } = {}) {
    this.claudeProjectsDir = claudeProjectsDir;
    this.codexHome = codexHome;
    this.resolveGeminiProjectDir = typeof resolveGeminiProjectDir === 'function'
      ? resolveGeminiProjectDir
      : null;
    this.getCodexLineageManifest = typeof getCodexLineageManifest === 'function'
      ? getCodexLineageManifest
      : null;
    this.isRuntimeActive = typeof isRuntimeActive === 'function'
      ? isRuntimeActive
      : () => false;
    this.cacheMs = Math.max(1_000, Number(cacheMs) || DEFAULT_CACHE_MS);
    this.materializationGraceMs = Math.max(1_000, Number(materializationGraceMs) || DEFAULT_MATERIALIZATION_GRACE_MS);
    this.now = now;
    this.pathCache = new Map();
    this.rawCache = new Map();
    this.wasPresent = new Set();
    this.missingSince = new Map();
    this.deleted = new Map();
    this.inflight = null;
  }

  invalidate(sessionIds = []) {
    const ids = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds])
      .map((value) => clean(value).toLowerCase())
      .filter(Boolean));
    if (ids.size === 0) {
      this.rawCache.clear();
      return;
    }
    for (const provider of ['claude', 'codex', 'gemini']) {
      for (const sessionId of ids) this.rawCache.delete(sessionKey(provider, sessionId));
    }
  }

  noteDeletedSessions(sessionIds = [], metadata = {}) {
    const deletedAt = Number(metadata.deletedAt) || this.now();
    const source = clean(metadata.source) || 'noted-terminal';
    const operationId = clean(metadata.operationId) || null;
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds])
      .map((value) => clean(value).toLowerCase())
      .filter(Boolean))];
    for (const provider of ['claude', 'codex', 'gemini']) {
      for (const sessionId of ids) {
        const key = sessionKey(provider, sessionId);
        this.pathCache.delete(key);
        this.rawCache.delete(key);
        this.deleted.set(key, { deletedAt, source, operationId });
      }
    }
  }

  async probeBatch({ sessions = [], force = false } = {}) {
    const descriptors = [...new Map((Array.isArray(sessions) ? sessions : [])
      .map(normalizeDescriptor)
      .filter(Boolean)
      .slice(0, 1000)
      .map((descriptor) => [descriptorKey(descriptor), descriptor])).values()];
    if (descriptors.length === 0) return { success: true, checkedAt: this.now(), results: [] };
    if (this.inflight) await this.inflight;
    const run = this._probeDescriptors(descriptors, force === true);
    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  // Тот же discovery, что и у probeBatch, но наружу отдаётся путь файла.
  // probeBatch намеренно его скрывает — он отвечает на «жив ли транскрипт»,
  // а не «где он лежит». Читателю сырого транскрипта (grep по сессиям) путь
  // нужен, и переоткрывать деревья ~/.claude и ~/.codex вторым сканером
  // означало бы завести второй кэш с собственным рассинхроном.
  async resolveSessionFiles({ sessions = [], force = false } = {}) {
    const descriptors = [...new Map((Array.isArray(sessions) ? sessions : [])
      .map(normalizeDescriptor)
      .filter(Boolean)
      .slice(0, 1000)
      .map((descriptor) => [descriptorKey(descriptor), descriptor])).values()];
    if (descriptors.length === 0) return { success: true, results: [] };
    const probe = await this.probeBatch({ sessions: descriptors, force });
    const results = descriptors.map((descriptor) => {
      const key = sessionKey(descriptor.provider, descriptor.sessionId);
      const cached = this.pathCache.get(key) || null;
      const probed = (probe.results || []).find((entry) => (
        entry.provider === descriptor.provider && entry.sessionId === descriptor.sessionId
      )) || null;
      return {
        provider: descriptor.provider,
        sessionId: descriptor.sessionId,
        tabId: descriptor.tabId || null,
        filePath: cached?.filePath || null,
        location: cached?.location || null,
        state: probed?.state || 'unknown',
        reason: probed?.reason || 'probe-incomplete',
      };
    });
    return { success: true, checkedAt: probe.checkedAt, results };
  }

  async _probeDescriptors(descriptors, force) {
    const checkedAt = this.now();
    const wantedByProvider = new Map([
      ['claude', new Set()],
      ['codex', new Set()],
      ['gemini', new Set()],
    ]);
    const manifests = new Map();
    for (const descriptor of descriptors) {
      wantedByProvider.get(descriptor.provider).add(descriptor.sessionId);
      if (descriptor.provider !== 'codex' || !this.getCodexLineageManifest) continue;
      try {
        const manifest = this.getCodexLineageManifest(descriptor.sessionId);
        if (!manifest || !Array.isArray(manifest.sourceSegments)) continue;
        manifests.set(sessionKey('codex', descriptor.sessionId), manifest);
        for (const segment of manifest.sourceSegments) {
          const physicalSessionId = clean(segment?.physicalSessionId).toLowerCase();
          if (physicalSessionId) wantedByProvider.get('codex').add(physicalSessionId);
        }
      } catch {}
    }

    const rawByKey = new Map();
    const unresolved = new Map();
    for (const [provider, wanted] of wantedByProvider) {
      const providerUnresolved = new Set();
      for (const sessionId of wanted) {
        const key = sessionKey(provider, sessionId);
        const cached = this.rawCache.get(key);
        if (!force && cached && checkedAt - cached.checkedAt < this.cacheMs) {
          rawByKey.set(key, cached);
          continue;
        }
        const cachedPath = this.pathCache.get(key);
        if (cachedPath) {
          const state = await pathState(cachedPath.filePath);
          if (state === 'present') {
            const raw = { state: cachedPath.location === 'archived' ? 'archived' : 'available', checkedAt, ...cachedPath };
            rawByKey.set(key, raw);
            this.rawCache.set(key, raw);
            this.wasPresent.add(key);
            this.deleted.delete(key);
            continue;
          }
          if (state === 'unknown') {
            const raw = { state: 'unknown', reason: 'path-check-failed', checkedAt };
            rawByKey.set(key, raw);
            this.rawCache.set(key, raw);
            continue;
          }
          this.pathCache.delete(key);
        }
        providerUnresolved.add(sessionId);
      }
      unresolved.set(provider, providerUnresolved);
    }

    await this._discoverClaude(unresolved.get('claude'), rawByKey, checkedAt);
    await this._discoverCodex(unresolved.get('codex'), rawByKey, checkedAt);
    await this._discoverGemini(descriptors, unresolved.get('gemini'), rawByKey, checkedAt);

    const results = descriptors.map((descriptor) => {
      const key = sessionKey(descriptor.provider, descriptor.sessionId);
      const raw = rawByKey.get(key) || { state: 'unknown', reason: 'probe-incomplete', checkedAt };
      let state = raw.state;
      let reason = raw.reason || (state === 'archived' ? 'archived-session-file' : 'session-file-present');
      let missingDependencies = [];
      let historyState = state === 'available' ? 'complete' : state;

      if (descriptor.provider === 'codex' && state === 'available') {
        const manifest = manifests.get(key);
        if (manifest) {
          const dependencyStates = manifest.sourceSegments.map((segment) => {
            const physicalSessionId = clean(segment?.physicalSessionId).toLowerCase();
            return { physicalSessionId, raw: rawByKey.get(sessionKey('codex', physicalSessionId)) };
          });
          missingDependencies = dependencyStates
            .filter((entry) => entry.physicalSessionId && entry.raw?.state === 'missing')
            .map((entry) => entry.physicalSessionId);
          if (missingDependencies.length > 0) {
            state = 'partial';
            historyState = 'partial';
            reason = 'lineage-source-file-missing';
          } else if (dependencyStates.some((entry) => !entry.raw || entry.raw.state === 'unknown')) {
            historyState = 'unknown';
          }
        }
      }

      if (state === 'missing') {
        const runtimeActive = this.isRuntimeActive(descriptor) === true;
        const deleted = this.deleted.get(key) || null;
        const descriptorId = descriptorKey(descriptor);
        if (!deleted && runtimeActive && !this.wasPresent.has(key)) {
          const since = this.missingSince.get(descriptorId) || checkedAt;
          this.missingSince.set(descriptorId, since);
          if (checkedAt - since < this.materializationGraceMs) {
            state = 'checking';
            historyState = 'checking';
            reason = 'runtime-session-materializing';
          }
        } else {
          this.missingSince.delete(descriptorId);
          reason = deleted ? 'deleted-by-noted-terminal' : (this.wasPresent.has(key) ? 'session-file-disappeared' : 'session-file-not-found');
        }
      } else {
        this.missingSince.delete(descriptorKey(descriptor));
      }

      const deleted = this.deleted.get(key) || null;
      return {
        tabId: descriptor.tabId || null,
        provider: descriptor.provider,
        sessionId: descriptor.sessionId,
        state,
        historyState,
        reason,
        checkedAt,
        archived: raw.state === 'archived',
        missingDependencies,
        deletedAt: deleted?.deletedAt || null,
        deletionSource: deleted?.source || null,
        deletionOperationId: deleted?.operationId || null,
      };
    });
    return { success: true, checkedAt, results };
  }

  _rememberRaw(provider, sessionId, raw, rawByKey) {
    const key = sessionKey(provider, sessionId);
    rawByKey.set(key, raw);
    this.rawCache.set(key, raw);
    if (raw.filePath) this.pathCache.set(key, { filePath: raw.filePath, location: raw.location || 'active' });
    if (raw.state === 'available' || raw.state === 'archived') {
      this.wasPresent.add(key);
      this.deleted.delete(key);
    }
  }

  async _discoverClaude(wanted, rawByKey, checkedAt) {
    if (!wanted || wanted.size === 0) return;
    const discovered = await scanClaudeProjects(this.claudeProjectsDir, wanted);
    for (const sessionId of wanted) {
      const hit = discovered.matches.get(sessionId);
      const raw = hit
        ? { state: 'available', reason: 'session-file-present', checkedAt, ...hit }
        : discovered.authoritative
          ? { state: 'missing', reason: 'session-file-not-found', checkedAt }
          : { state: 'unknown', reason: 'session-root-read-failed', checkedAt };
      this._rememberRaw('claude', sessionId, raw, rawByKey);
    }
  }

  async _discoverCodex(wanted, rawByKey, checkedAt) {
    if (!wanted || wanted.size === 0) return;
    const active = await scanCodexTree(path.join(this.codexHome, 'sessions'), wanted, 'active');
    const remaining = new Set([...wanted].filter((sessionId) => !active.matches.has(sessionId)));
    const archived = await scanCodexTree(path.join(this.codexHome, 'archived_sessions'), remaining, 'archived');
    for (const sessionId of wanted) {
      const hit = active.matches.get(sessionId) || archived.matches.get(sessionId);
      const raw = hit
        ? {
            state: hit.location === 'archived' ? 'archived' : 'available',
            reason: hit.location === 'archived' ? 'archived-session-file' : 'session-file-present',
            checkedAt,
            ...hit,
          }
        : active.authoritative && archived.authoritative
          ? { state: 'missing', reason: 'session-file-not-found', checkedAt }
          : { state: 'unknown', reason: 'session-root-read-failed', checkedAt };
      this._rememberRaw('codex', sessionId, raw, rawByKey);
    }
  }

  async _discoverGemini(descriptors, wanted, rawByKey, checkedAt) {
    if (!wanted || wanted.size === 0) return;
    const matches = new Map();
    let authoritative = !!this.resolveGeminiProjectDir;
    const byCwd = new Map();
    for (const descriptor of descriptors) {
      if (descriptor.provider !== 'gemini' || !wanted.has(descriptor.sessionId)) continue;
      const cwd = descriptor.cwd || '';
      const list = byCwd.get(cwd) || [];
      list.push(descriptor.sessionId);
      byCwd.set(cwd, list);
    }
    for (const [cwd, ids] of byCwd) {
      let resolved = null;
      try { resolved = this.resolveGeminiProjectDir?.(cwd || os.homedir()) || null; } catch {}
      if (!resolved?.chatsDir) continue;
      const listing = await readDir(resolved.chatsDir);
      if (listing.error) {
        authoritative = false;
        continue;
      }
      const wantedHere = new Set(ids);
      for (const entry of listing.entries) {
        if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;
        const candidates = [...wantedHere].filter((sessionId) => entry.name.includes(sessionId.slice(-8)));
        if (candidates.length === 0) continue;
        const filePath = path.join(resolved.chatsDir, entry.name);
        const exactSessionId = await readGeminiSessionId(filePath);
        if (exactSessionId && wantedHere.has(exactSessionId)) {
          matches.set(exactSessionId, { filePath, location: 'active' });
        }
      }
    }
    for (const sessionId of wanted) {
      const hit = matches.get(sessionId);
      const raw = hit
        ? { state: 'available', reason: 'session-file-present', checkedAt, ...hit }
        : authoritative
          ? { state: 'missing', reason: 'session-file-not-found', checkedAt }
          : { state: 'unknown', reason: 'session-root-read-failed', checkedAt };
      this._rememberRaw('gemini', sessionId, raw, rawByKey);
    }
  }
}

module.exports = {
  AgentSessionAvailabilityService,
  descriptorKey,
  normalizeDescriptor,
  normalizeProvider,
  sessionKey,
};
