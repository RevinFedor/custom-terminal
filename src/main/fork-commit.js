'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function commitForkMetadata(store, commit) {
  if (typeof store?.db?.transaction !== 'function') throw new Error('fork_metadata_store_unavailable');
  return store.db.transaction(() => {
    const result = commit();
    if (!result || typeof result.then === 'function') throw new Error('fork_metadata_not_committed');
    return result;
  })();
}

// The file is created exclusively before this boundary and is not exposed to
// a tab/CLI until its history event and copied annotations have committed.
// SQLite cannot atomically rename a file: on failure keep the uncommitted copy
// recoverable, but outside the provider's *.jsonl discovery namespace.
async function commitPreparedFork({ filePath, newSessionId, store, commit }) {
  if (!path.isAbsolute(filePath || '')
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(newSessionId || '')
    || !path.basename(filePath).includes(newSessionId)
    || !filePath.endsWith('.jsonl')) {
    throw new Error('fork_artifact_identity_invalid');
  }
  try {
    return commitForkMetadata(store, commit);
  } catch (cause) {
    const recoveryPath = filePath + '.uncommitted';
    let preserved = false;
    try {
      const exists = await fs.lstat(recoveryPath).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (!exists) { await fs.rename(filePath, recoveryPath); preserved = true; }
    } catch {}
    const error = new Error('fork_metadata_commit_failed: ' + (cause?.message || String(cause)));
    error.code = 'fork_metadata_commit_failed';
    error.recoveryPath = preserved ? recoveryPath : filePath;
    error.artifactQuarantined = preserved;
    throw error;
  }
}

module.exports = { commitPreparedFork, commitForkMetadata };
