'use strict';

const {
  codexUserMessageAuditText,
  isCodexEnvironmentContextUserText,
  isCodexProjectInstructionsUserText,
} = require('./codex-prompt-audit');

// This proves which Resume source is receiving new model input. It deliberately
// does not match a send receipt: a later manual message can prove a live writer
// while an earlier, different automated prompt remains delivery-unknown.
function createCodexResumeUserActivityProof({
  record,
  sessionId,
  filePath,
  launchId,
  terminalToken,
  runSeq,
  lifecycleGeneration,
  startByte,
  endByte,
  startedAt,
} = {}) {
  const text = codexUserMessageAuditText(record);
  const offset = Number(record?.__byteOffset);
  const timestamp = Date.parse(String(record?.timestamp || ''));
  if (!sessionId || !filePath || !launchId || !terminalToken || !lifecycleGeneration
    || !Number.isInteger(runSeq) || runSeq <= 0
    || !Number.isSafeInteger(startByte) || startByte < 0
    || !Number.isSafeInteger(endByte) || endByte <= startByte
    || !Number.isSafeInteger(offset) || offset < startByte || offset >= endByte
    || !Number.isFinite(startedAt) || startedAt <= 0
    || !Number.isFinite(timestamp) || timestamp < startedAt
    || !text?.trim()
    || isCodexEnvironmentContextUserText(text)
    || isCodexProjectInstructionsUserText(text)
    || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text.trim())) return null;
  return {
    kind: 'resume-source-live-user-record',
    sessionId,
    filePath,
    launchId,
    terminalToken,
    runSeq,
    lifecycleGeneration,
    startByte,
    recordByteOffset: offset,
    recordTimestampMs: timestamp,
  };
}

function matchesCodexResumeUserActivityProof(proof, owner = {}) {
  return !!proof
    && proof.kind === 'resume-source-live-user-record'
    && owner.sourceMode === 'resume'
    && owner.sourceMatch === 'source-in-place'
    && proof.sessionId === owner.sourceSessionId
    && proof.sessionId === owner.sessionId
    && proof.filePath === owner.filePath
    && proof.launchId === owner.launchId
    && proof.terminalToken === owner.terminalToken
    && proof.runSeq === owner.runSeq
    && proof.lifecycleGeneration === owner.lifecycleGeneration
    && proof.startByte === owner.startByte
    && Number.isSafeInteger(owner.endByte)
    && proof.recordByteOffset < owner.endByte;
}

module.exports = {
  createCodexResumeUserActivityProof,
  matchesCodexResumeUserActivityProof,
};
