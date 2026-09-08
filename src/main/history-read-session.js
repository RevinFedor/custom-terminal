'use strict';

function historyReadSession(info) {
  if (info?.toolType !== 'codex') return info;
  // This projection is for transcript reads only. A historical SID is not a
  // live writer: preserve every writer verdict instead of upgrading its proof.
  const readId = info.readSessionId || info.codexReadSessionId || null;
  return { ...info, sessionId: readId };
}

module.exports = { historyReadSession };
