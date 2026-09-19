'use strict';

const fs = require('node:fs');
const { codexUserMessageAuditText } = require('./codex-prompt-audit');

/**
 * Resolve an already audited physical record through a compact physical
 * locator and the canonical one-row JSONL reader. No full transcript, text
 * search or UI refresh is needed to recover its zero-based physical line.
 */
async function resolveCodexAuditAddress({ filePath, sessionId, audit, readAddress, hashText }) {
  const prefix = 'codex-user-source-' + sessionId + '-';
  if (!filePath || !sessionId || !audit?.sourceIdentity?.startsWith(prefix)) return null;
  const suffix = audit.sourceIdentity.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null; // timestamp fallback is not a physical address
  const offset = Number(suffix);
  if (!Number.isSafeInteger(offset) || offset < 0 || !audit.actualHash || !audit.auditTimestamp) return null;
  if (audit.recordByteOffset != null && audit.recordByteOffset !== offset) return null;
  const before = await fs.promises.stat(filePath);
  if (before.size <= offset) return null;
  const addressed = await readAddress(filePath, offset);
  if (addressed?.sessionId !== sessionId) return null;
  const record = addressed.record;
  const after = await fs.promises.stat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size
    || after.size <= offset
    || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) return null;
  if (!record || record.__byteOffset !== offset || !Number.isSafeInteger(record.__line) || record.__line < 0) return null;
  const text = codexUserMessageAuditText(record, { preserveProviderImageMarkup: true });
  if (text === null || hashText(text) !== audit.actualHash || record.timestamp !== audit.auditTimestamp
    || (Number.isFinite(audit.actualLen) && text.length !== audit.actualLen)) return null;
  return { entryUuid: 'codex-user-' + sessionId + '-' + record.__line,
    sourceIdentity: audit.sourceIdentity, recordByteOffset: offset };
}

module.exports = { resolveCodexAuditAddress };
