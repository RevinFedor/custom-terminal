'use strict';

const crypto = require('node:crypto');

function boundedDiagnosticText(value, limit = 256 * 1024) {
  const text = typeof value === 'string' ? value : '';
  const metadata = {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    truncated: text.length > limit,
  };
  return metadata.truncated
    ? { ...metadata, head: text.slice(0, Math.ceil(limit / 2)), tail: text.slice(-Math.floor(limit / 2)) }
    : { ...metadata, text };
}

function normalizeHistoryEntryCopyDiagnostic(value) {
  if (!value || value.queueStatus !== 'delivery-unknown'
    || typeof value.tabId !== 'string' || !value.tabId.trim()
    || (value.toolType !== 'codex' && value.toolType !== 'claude')) return null;
  const string = (input, limit = 4096) => typeof input === 'string' ? input.slice(0, limit) : null;
  const number = (input) => input != null && Number.isFinite(Number(input)) ? Number(input) : null;
  return {
    tabId: value.tabId,
    toolType: value.toolType,
    messageId: string(value.messageId),
    sessionId: string(value.sessionId),
    handoffId: string(value.handoffId),
    queueStatus: 'delivery-unknown',
    statusReason: string(value.statusReason),
    statusChangedAt: number(value.statusChangedAt),
    messageTimestamp: string(value.messageTimestamp),
    requestedAt: number(value.requestedAt),
    prompt: boundedDiagnosticText(value.promptText),
    imagePaths: Array.isArray(value.imagePaths)
      ? value.imagePaths.slice(0, 64).map((item) => string(item)).filter(Boolean)
      : [],
    imageCount: Array.isArray(value.imagePaths) ? value.imagePaths.length : 0,
    chipCount: number(value.chipCount),
  };
}

async function copyHistoryEntryDetails(payload, { captureDiagnostic, writeText }) {
  const copyText = payload?.copyText;
  if (typeof copyText !== 'string' || !copyText.trim()) return { success: false, copied: false };
  const context = normalizeHistoryEntryCopyDiagnostic(payload.diagnostic);
  if (!context) {
    writeText(copyText);
    return { success: true, copied: true, diagnosticRequested: false };
  }
  let saved;
  try {
    saved = await captureDiagnostic({
      tabId: context.tabId,
      toolType: context.toolType,
      historyEntry: payload.diagnostic,
    });
    if (!saved?.artifactPath || !saved.reference) throw new Error('diagnostic_reference_unavailable');
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 4096);
    try {
      writeText(copyText + '\n\nTerminal diagnostic could not be saved: ' + reason);
    } catch (copyError) {
      return { success: false, copied: false, diagnosticRequested: true,
        error: reason + '; clipboard: ' + String(copyError?.message || copyError) };
    }
    return { success: false, copied: true, diagnosticRequested: true, error: reason };
  }
  const partial = saved.snapshotAvailable === false;
  // A reference is published only after the shared collector has atomically
  // saved its artifact. Failure still leaves the original ID copy useful.
  try {
    writeText(copyText + '\n\n' + saved.reference
      + (partial ? '\nTerminal snapshot: unavailable; see artifact for the recorded reason.' : ''));
  } catch (error) {
    return { ...saved, success: false, copied: false, diagnosticRequested: true,
      error: 'Diagnostics saved, but clipboard failed: ' + String(error?.message || error) };
  }
  return { ...saved, success: true, copied: true, diagnosticRequested: true, partial };
}

module.exports = { boundedDiagnosticText, normalizeHistoryEntryCopyDiagnostic, copyHistoryEntryDetails };
