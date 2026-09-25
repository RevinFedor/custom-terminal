const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HISTORY_REVISION_SCHEMA = 'history-files-v1';
const MAX_HISTORY_REVISION_SOURCES = 16;

function normalizeIdentity({ toolType, sessionId, cwd } = {}) {
  return {
    toolType: toolType === 'codex' ? 'codex' : 'claude',
    sessionId: String(sessionId || ''),
    cwd: String(cwd || ''),
  };
}

function normalizeSource(source = {}) {
  return {
    filePath: path.resolve(String(source.filePath || '')),
    size: Number(source.size || 0),
    mtimeMs: Number(source.mtimeMs || 0),
    // A pathname/size/mtime tuple can survive an atomic replacement, and a
    // writer can restore mtime after an in-place rewrite. Preserve the
    // physical witness captured by the reader, not a newer stat of its path.
    fileIdentity: String(source.fileIdentity || ''),
    ctimeMs: Number.isFinite(source.ctimeMs) ? source.ctimeMs : null,
    sessionId: String(source.sessionId || ''),
    parentSessionId: source.parentSessionId ? String(source.parentSessionId) : null,
    linkKind: source.linkKind === 'jsonl' || source.linkKind === 'sqlite'
      ? source.linkKind
      : 'end',
  };
}

function revisionToken(identity, sources, context = '') {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      schema: HISTORY_REVISION_SCHEMA,
      identity,
      sources,
      context: String(context || ''),
    }))
    .digest('hex');
}

function buildHistoryRevision(identityInput, sourceInputs, options = {}) {
  const identity = normalizeIdentity(identityInput);
  const sources = (Array.isArray(sourceInputs) ? sourceInputs : [])
    .filter((source) => source?.filePath)
    .slice(0, MAX_HISTORY_REVISION_SOURCES)
    .map(normalizeSource);

  if (!identity.sessionId || sources.length === 0) return null;

  const context = String(options.context || '');
  return {
    schema: HISTORY_REVISION_SCHEMA,
    ...identity,
    sources,
    context,
    token: revisionToken(identity, sources, context),
  };
}

function isWellFormedRevision(revision, identityInput) {
  if (!revision || revision.schema !== HISTORY_REVISION_SCHEMA) return false;
  const identity = normalizeIdentity(identityInput);
  if (revision.toolType !== identity.toolType ||
      revision.sessionId !== identity.sessionId ||
      revision.cwd !== identity.cwd) {
    return false;
  }
  if (!Array.isArray(revision.sources) ||
      revision.sources.length === 0 ||
      revision.sources.length > MAX_HISTORY_REVISION_SOURCES) {
    return false;
  }
  const sources = revision.sources.map(normalizeSource);
  const context = String(revision.context || '');
  return revision.token === revisionToken(identity, sources, context);
}

async function validateHistoryRevision(revision, identityInput, options = {}) {
  const identity = normalizeIdentity(identityInput);
  if (!isWellFormedRevision(revision, identity)) {
    return { unchanged: false, reason: 'invalid-revision' };
  }

  const sources = revision.sources.map(normalizeSource);
  if (Object.prototype.hasOwnProperty.call(options, 'context') &&
      String(revision.context || '') !== String(options.context || '')) {
    return { unchanged: false, reason: 'context-changed' };
  }
  if (typeof options.resolvePrimaryFile === 'function') {
    const primaryFile = await options.resolvePrimaryFile();
    if (!primaryFile || path.resolve(primaryFile) !== sources[0].filePath) {
      return { unchanged: false, reason: 'primary-file-changed' };
    }
  }

  for (const source of sources) {
    let stat;
    try {
      stat = await fs.promises.stat(source.filePath);
    } catch {
      return { unchanged: false, reason: 'source-missing', filePath: source.filePath };
    }
    if (stat.size !== source.size || stat.mtimeMs !== source.mtimeMs
      || (source.fileIdentity && source.fileIdentity !== stat.dev + ':' + stat.ino)
      || (source.ctimeMs !== null && source.ctimeMs !== stat.ctimeMs)) {
      return { unchanged: false, reason: 'source-changed', filePath: source.filePath };
    }
  }

  if (typeof options.validateTopology === 'function') {
    const topologyValid = await options.validateTopology(sources);
    if (!topologyValid) {
      return { unchanged: false, reason: 'topology-changed' };
    }
  }

  return { unchanged: true, reason: 'files-unchanged', revision };
}

module.exports = {
  HISTORY_REVISION_SCHEMA,
  MAX_HISTORY_REVISION_SOURCES,
  buildHistoryRevision,
  isWellFormedRevision,
  validateHistoryRevision,
  _api: {
    isWellFormedRevision,
    normalizeIdentity,
    normalizeSource,
    revisionToken,
  },
};
