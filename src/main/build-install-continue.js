'use strict';

const { resolveAiToolOwner } = require('./ai-tool-owner');

const SHUTDOWN_INTERRUPTED_SESSIONS_KEY = 'shutdown_interrupted_ai_sessions_v1';
const SNAPSHOT_VERSION = 1;
const SUPPORTED_PROVIDERS = new Set(['claude', 'codex']);
const INSTALL_BINDING_PROTOCOL = 'voice-install-shutdown-binding-v1';
let installBindingReader = null;
let buildContinueBindingReader = null;
function registerBuildContinueShutdownBindings(reader) {
  if (typeof reader !== 'function' || buildContinueBindingReader && buildContinueBindingReader !== reader) {
    throw Error('build_continue_shutdown_binding_owner_conflict');
  }
  buildContinueBindingReader = reader;
  return () => { if (buildContinueBindingReader === reader) buildContinueBindingReader = null; };
}
function exactBuildContinueBindings(value) {
  if (!Array.isArray(value) || value.some(row => typeof row?.operationId !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.captureDigest || '') || !/^[a-f0-9]{64}$/.test(row.evidenceDigest || ''))
    || new Set(value.map(row => row.operationId)).size !== value.length) throw Error('build_continue_shutdown_binding_invalid');
  return value.map(row => ({ operationId: row.operationId, captureDigest: row.captureDigest, evidenceDigest: row.evidenceDigest }));
}
function registerInstallShutdownBindings(reader) {
  if (typeof reader !== 'function' || installBindingReader && installBindingReader !== reader) {
    throw Error('install_shutdown_binding_owner_conflict');
  }
  installBindingReader = reader;
  return () => { if (installBindingReader === reader) installBindingReader = null; };
}
function exactInstallBindings(value) {
  if (!Array.isArray(value) || value.some(row => typeof row?.operationId !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.bindingDigest || '') || !/^[a-f0-9]{64}$/.test(row.evidenceDigest || ''))
    || new Set(value.map(row => row.operationId)).size !== value.length) throw Error('install_shutdown_binding_invalid');
  return value.map(row => ({ operationId: row.operationId, bindingDigest: row.bindingDigest, evidenceDigest: row.evidenceDigest }));
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createShutdownInterruptedSnapshot(entries, {
  capturedAt = Date.now(),
  shutdownPid = process.pid,
  reason = 'shutdown',
  installBindings = null,
} = {}) {
  // Main still owns the process census and durable snapshot write. The reader
  // only adds identifiers of a cut already committed by the common executor.
  const bindings = exactInstallBindings(installBindings || installBindingReader?.() || []);
  const buildContinueBindings = exactBuildContinueBindings(buildContinueBindingReader?.() || []);
  const targets = [];
  const unresolved = [];
  const seen = new Set();
  const iterable = entries instanceof Map
    ? entries.entries()
    : Array.isArray(entries)
      ? entries.map((item) => [item?.tabId, item])
      : [];

  for (const [rawTabId, rawInfo] of iterable) {
    const tabId = cleanString(rawTabId || rawInfo?.tabId);
    const provider = cleanString(rawInfo?.engine || rawInfo?.provider || rawInfo?.toolType);
    const sessionId = cleanString(rawInfo?.sessionId);
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    if (!SUPPORTED_PROVIDERS.has(provider) || !sessionId) {
      unresolved.push({
        tabId,
        reason: Array.isArray(rawInfo?.ambiguousOwners) && rawInfo.ambiguousOwners.length > 1
          ? 'live-owner-ambiguous'
          : 'live-owner-unresolved',
      });
      continue;
    }
    targets.push({ tabId, provider, sessionId });
  }

  return {
    version: SNAPSHOT_VERSION,
    capturedAt: Number(capturedAt) || Date.now(),
    shutdownPid: Number(shutdownPid) || null,
    reason: cleanString(reason) || 'shutdown',
    targets,
    unresolved,
    ...(bindings.length ? { installBindings: bindings } : {}),
    ...(buildContinueBindings.length ? { buildContinueBindings } : {}),
  };
}

function collectInterruptedRows(projects) {
  const rows = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    for (const tab of Array.isArray(project?.tabs) ? project.tabs : []) {
      if (tab?.wasInterrupted !== true || tab?.overlayDismissed === true) continue;
      const tabId = cleanString(tab?.tabId);
      if (!tabId || (tab?.tabType || 'terminal') === 'claude-sdk') continue;
      rows.push({
        tabId,
        projectId: cleanString(project?.id),
        projectName: cleanString(project?.name),
        tabName: cleanString(tab?.name),
        cwd: cleanString(tab?.cwd),
        commandType: cleanString(tab?.commandType),
        claudeSessionId: cleanString(tab?.claudeSessionId),
        codexSessionId: cleanString(tab?.codexSessionId),
      });
    }
  }
  return rows;
}

function enrichTarget(target, row) {
  return {
    tabId: target.tabId,
    provider: target.provider,
    sessionId: target.sessionId,
    projectId: row.projectId,
    projectName: row.projectName,
    tabName: row.tabName,
    cwd: row.cwd,
  };
}

function resolveStartupInterruptedSnapshot({
  persistedSnapshot = null,
  projects = [],
  resolvedAt = Date.now(),
} = {}) {
  const rows = collectInterruptedRows(projects);
  const rowLists = new Map();
  for (const row of rows) {
    const list = rowLists.get(row.tabId) || [];
    list.push(row);
    rowLists.set(row.tabId, list);
  }

  const exactSnapshot = persistedSnapshot
    && Number(persistedSnapshot.version) === SNAPSHOT_VERSION
    && Array.isArray(persistedSnapshot.targets)
    ? persistedSnapshot
    : null;
  const targets = [];
  const unresolved = exactSnapshot && Array.isArray(exactSnapshot.unresolved)
    ? exactSnapshot.unresolved.map((item) => ({
      tabId: cleanString(item?.tabId),
      reason: cleanString(item?.reason) || 'shutdown-owner-unresolved',
    })).filter((item) => item.tabId)
    : [];
  const seen = new Set();

  if (exactSnapshot) {
    for (const rawTarget of exactSnapshot.targets) {
      const tabId = cleanString(rawTarget?.tabId);
      const provider = cleanString(rawTarget?.provider || rawTarget?.engine || rawTarget?.toolType);
      const sessionId = cleanString(rawTarget?.sessionId);
      if (!tabId || !SUPPORTED_PROVIDERS.has(provider) || !sessionId) continue;
      const candidates = rowLists.get(tabId) || [];
      if (candidates.length !== 1) {
        unresolved.push({ tabId, provider, sessionId, reason: candidates.length === 0 ? 'not-interrupted-now' : 'duplicate-tab-id' });
        continue;
      }
      const row = candidates[0];
      const currentSessionId = provider === 'codex' ? row.codexSessionId : row.claudeSessionId;
      if (currentSessionId !== sessionId) {
        unresolved.push({ tabId, provider, sessionId, reason: 'session-changed' });
        continue;
      }
      if (seen.has(tabId)) {
        unresolved.push({ tabId, provider, sessionId, reason: 'duplicate-snapshot-target' });
        continue;
      }
      seen.add(tabId);
      targets.push(enrichTarget({ tabId, provider, sessionId }, row));
    }
    return {
      version: SNAPSHOT_VERSION,
      source: 'exact-shutdown-snapshot',
      capturedAt: Number(exactSnapshot.capturedAt) || null,
      shutdownPid: Number(exactSnapshot.shutdownPid) || null,
      resolvedAt: Number(resolvedAt) || Date.now(),
      targets,
      unresolved,
      ...(exactSnapshot.installBindings ? { installBindings: exactInstallBindings(exactSnapshot.installBindings) } : {}),
      ...(exactSnapshot.buildContinueBindings ? { buildContinueBindings: exactBuildContinueBindings(exactSnapshot.buildContinueBindings) } : {}),
    };
  }

  // Bootstrap for the first install that ships this feature: the old app could
  // only persist was_interrupted, not the exact provider snapshot. Accept only
  // a single unambiguous session binding; commandType alone never proves owner.
  for (const row of rows) {
    if ((rowLists.get(row.tabId) || []).length !== 1) {
      unresolved.push({ tabId: row.tabId, reason: 'duplicate-tab-id' });
      continue;
    }
    const provider = resolveAiToolOwner({
      claudeSessionId: row.claudeSessionId,
      codexSessionId: row.codexSessionId,
      storedCommandType: row.commandType,
    });
    const sessionId = provider === 'codex' ? row.codexSessionId
      : provider === 'claude' ? row.claudeSessionId
        : null;
    if (!SUPPORTED_PROVIDERS.has(provider) || !sessionId) {
      unresolved.push({ tabId: row.tabId, reason: 'owner-ambiguous' });
      continue;
    }
    if (seen.has(row.tabId)) continue;
    seen.add(row.tabId);
    targets.push(enrichTarget({ tabId: row.tabId, provider, sessionId }, row));
  }
  return {
    version: SNAPSHOT_VERSION,
    source: 'legacy-interrupted-fallback',
    capturedAt: null,
    shutdownPid: null,
    resolvedAt: Number(resolvedAt) || Date.now(),
    targets,
    unresolved,
  };
}

module.exports = {
  SHUTDOWN_INTERRUPTED_SESSIONS_KEY,
  SNAPSHOT_VERSION,
  INSTALL_BINDING_PROTOCOL,
  registerInstallShutdownBindings,
  registerBuildContinueShutdownBindings,
  createShutdownInterruptedSnapshot,
  resolveStartupInterruptedSnapshot,
};
