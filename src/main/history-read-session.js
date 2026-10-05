'use strict';

function historyReadSession(info) {
  if (info?.toolType !== 'codex') return info;
  // This projection is for transcript reads only. A historical SID is not a
  // live writer: preserve every writer verdict instead of upgrading its proof.
  const readId = info.readSessionId || info.codexReadSessionId || null;
  return { ...info, sessionId: readId };
}

function historyReadOwnerFromProjection(persisted, runtime, hasCodexRuntime = false) {
  if (persisted?.toolType === 'claude' && persisted.sessionId) return persisted;
  if (persisted?.toolType !== 'codex' || !hasCodexRuntime) return null;
  return historyReadSession({ ...persisted, ...(runtime || {}),
    sessionId: runtime?.sessionId || null,
    readSessionId: runtime?.readSessionId || null,
    writerSessionId: runtime?.provenWriterSessionId || null,
    writerConfirmed: runtime?.writerConfirmed === true,
  });
}

module.exports = { historyReadSession, historyReadOwnerFromProjection };
