'use strict';

const fs = require('node:fs');
const { codexUserMessageAuditText } = require('./codex-prompt-audit');

/**
 * Resolve an already audited physical record through the SAME incremental
 * reader that assigns History UUIDs. No new JSONL parser, text search, or UI
 * refresh. The watcher knows byte offsets; only that reader knows line numbers.
 */
async function resolveCodexAuditAddress({ filePath, sessionId, audit, readRecords, hashText }) {
  const prefix = 'codex-user-source-' + sessionId + '-';
  if (!filePath || !sessionId || !audit?.sourceIdentity?.startsWith(prefix)) return null;
  const suffix = audit.sourceIdentity.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null; // timestamp fallback is not a physical address
  const offset = Number(suffix);
  if (!Number.isSafeInteger(offset) || offset < 0 || !audit.actualHash || !audit.auditTimestamp) return null;
  if (audit.recordByteOffset != null && audit.recordByteOffset !== offset) return null;
  const before = await fs.promises.stat(filePath);
  if (before.size <= offset) return null;
  let record;
  for (let pass = 0; pass < 2; pass++) {
    // A shared read may have started just BEFORE the audited append. A second
    // incremental read then catches up once; never invalidate its warm cache.
    const records = await readRecords(filePath);
    const metadata = records.find(row => row?.type === 'session_meta');
    if (metadata?.payload?.id !== sessionId) return null;
    record = records.find(row => row.__byteOffset === offset);
    if (record) break;
  }
  const after = await fs.promises.stat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size
    || after.size <= offset
    || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) return null;
  if (!record || !Number.isSafeInteger(record.__line) || record.__line < 0) return null;
  const text = codexUserMessageAuditText(record, { preserveProviderImageMarkup: true });
  if (text === null || hashText(text) !== audit.actualHash || record.timestamp !== audit.auditTimestamp
    || (Number.isFinite(audit.actualLen) && text.length !== audit.actualLen)) return null;
  return { entryUuid: 'codex-user-' + sessionId + '-' + record.__line,
    sourceIdentity: audit.sourceIdentity, recordByteOffset: offset };
}

module.exports = { resolveCodexAuditAddress };
