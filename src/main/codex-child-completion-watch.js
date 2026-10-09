'use strict';

// Main-owned lifetime of real accepted children. No renderer subscription,
// polling, fixed-delay completion, or inherited historical lease.
function createCodexChildCompletionWatch({ findFile, readCompletion, watchFile,
  sessionsDir, isCurrent, onComplete, log = () => {} }) {
  const owners = new Map();
  let directoryWatch = null;
  const dispose = owner => { try { owner.watch?.close(); } catch {} owner.watch = null; };
  const check = owner => {
    if (!isCurrent(owner.tabId, owner.key, owner.agent, owner.startedAt, owner.generation)) return;
    const proof = readCompletion({ toolType: 'codex', filePath: owner.filePath, notBefore: owner.startedAt });
    if (!proof.finished || !isCurrent(owner.tabId, owner.key, owner.agent, owner.startedAt, owner.generation)) return;
    log('completed', owner, proof);
    onComplete(owner.tabId, owner.key, owner.agent, proof);
  };
  const attach = owner => {
    if (owner.watch || !isCurrent(owner.tabId, owner.key, owner.agent, owner.startedAt, owner.generation)) return;
    owner.filePath = findFile({ agentSessionId: owner.agent.threadId });
    if (!owner.filePath) return;
    try {
      // Subscribe before the first check; a completion between them is not lost.
      owner.watch = watchFile(owner.filePath, { persistent: false }, () => check(owner));
      owner.watch.on?.('error', error => {
        dispose(owner); log('file-watch-error', owner, { error: error.message });
      });
      check(owner);
    } catch (error) { log('file-watch-error', owner, { error: error.message }); }
  };
  const updateDirectoryWatch = () => {
    if (!owners.size) {
      try { directoryWatch?.close(); } catch {}
      directoryWatch = null; return;
    }
    if (directoryWatch) return;
    try {
      directoryWatch = watchFile(sessionsDir(), { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        for (const owner of [...owners.values()]) {
          if (!owner.watch && name.endsWith(owner.agent.threadId + '.jsonl')) attach(owner);
        }
      });
      directoryWatch.on?.('error', error => {
        try { directoryWatch?.close(); } catch {}
        directoryWatch = null; log('directory-watch-error', null, { error: error.message });
      });
    } catch (error) { log('directory-watch-error', null, { error: error.message }); }
  };
  const clear = tabId => {
    for (const [id, owner] of [...owners]) if (owner.tabId === tabId) {
      owners.delete(id); dispose(owner);
    }
    updateDirectoryWatch();
  };
  const reconcile = (tabId, active) => {
    for (const [id, owner] of [...owners]) if (owner.tabId === tabId) {
      const agent = active.get(owner.key);
      if (agent !== owner.agent || agent?.startedAt !== owner.startedAt || agent?.generation !== owner.generation) {
        owners.delete(id); dispose(owner);
      }
    }
    for (const [key, agent] of [...active]) {
      if (!agent.threadId || !agent.generation) continue;
      const id = tabId + '\u0000' + key;
      if (owners.has(id)) continue;
      const owner = { tabId, key, agent, startedAt: agent.startedAt, generation: agent.generation,
        filePath: null, watch: null };
      owners.set(id, owner);
    }
    updateDirectoryWatch();
    for (const owner of [...owners.values()]) if (owner.tabId === tabId) attach(owner);
  };
  return { reconcile, clear };
}

module.exports = { createCodexChildCompletionWatch };
