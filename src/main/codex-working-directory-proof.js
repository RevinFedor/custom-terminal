'use strict';
const fs = require('node:fs');
const { completeRecords } = require('./codex-resume-launch-source');
const { extractCodexSettingsCandidate } = require('./codex-source-settings');
const identity = stat => stat.dev + ':' + stat.ino;
const version = stat => [identity(stat), stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

// Metadata only: bounded head/tail of the ALREADY process-proven native writer.
// Not History, not a writer-adoption fallback, and never a reason to send a prompt.
async function readCodexWorkingDirectoryProof({ findSessionFile, sessionId, sourceSessionId, cwd, before }) {
  let bytesRead = 0;
  const miss = reason => ({ known: false, reason, bytesRead });
  if (!before?.filePath || !Number.isSafeInteger(before.size) || before.sessionId !== sourceSessionId) {
    return miss('cwd_operation_resume_source_unproven');
  }
  const found = await findSessionFile(sessionId, cwd);
  if (!found?.filePath) return miss('cwd_operation_native_source_unavailable');
  const handle = await fs.promises.open(found.filePath, 'r');
  try {
    const stat = await handle.stat();
    const read = async (start, length) => {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const part = await handle.read(buffer, total, length - total, start + total);
        bytesRead += part.bytesRead;
        if (!part.bytesRead) throw Error('cwd_operation_native_short_read');
        total += part.bytesRead;
      }
      return buffer;
    };
    const head = await read(0, Math.min(stat.size, 64 * 1024));
    const meta = [...completeRecords(head, 0)].find(record => record.type === 'session_meta')?.payload;
    if (meta?.id !== sessionId || meta.session_id && meta.session_id !== sessionId) return miss('cwd_operation_native_identity_changed');
    const sameSource = sessionId === sourceSessionId;
    if (sameSource && (found.filePath !== before.filePath || identity(stat) !== before.fileIdentity || stat.size < before.size)) {
      return miss('cwd_operation_native_source_changed');
    }
    if (!sameSource && (meta.forked_from_id !== sourceSessionId || meta.cwd !== cwd)) return miss('cwd_operation_native_child_unproven');
    const start = Math.max(0, stat.size - 256 * 1024);
    const tail = await read(start, stat.size - start);
    let latest = null;
    for (const record of completeRecords(tail, start)) {
      if (sameSource && record.__byteOffset < before.size) continue;
      if (extractCodexSettingsCandidate(record, 0)) latest = record;
    }
    const settings = latest?.type === 'turn_context' ? latest.payload : latest?.payload?.thread_settings;
    if (!latest || !extractCodexSettingsCandidate(latest, 0)?.complete || settings?.cwd !== cwd) {
      return miss('cwd_operation_native_cwd_unproven');
    }
    const after = await fs.promises.stat(found.filePath);
    const again = await findSessionFile(sessionId, cwd);
    if (version(stat) !== version(await handle.stat()) || version(stat) !== version(after)
      || again?.filePath !== found.filePath) return miss('cwd_operation_native_source_changed');
    return { known: true, cwd, sessionId, sourceSessionId, source: 'owned-native-thread-settings',
      recordByteOffset: latest.__byteOffset, bytesRead };
  } finally { await handle.close(); }
}
module.exports = { readCodexWorkingDirectoryProof };
