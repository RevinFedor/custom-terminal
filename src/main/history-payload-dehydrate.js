// History payload dehydration.
//
// A full History projection used to carry every tool output, thinking block
// and compact snapshot inline. On large sessions that meant hundreds of
// megabytes of text built in main, cloned over IPC, and retained by the
// renderer — the direct cause of multi-second tab-switch freezes (the UI
// thread prepares the whole array before the first paint) and of the memory
// multiplication documented in fact-transcript-сервис.md.
//
// Dehydration replaces each heavy text payload with a short preview plus a
// deterministic reference. The renderer shows the preview instantly and
// fetches the full text only when the user actually expands the card
// (`history:get-tool-payload`). This is not truncation: the full payload
// stays reachable by exact identity — preview + identity, never silent loss.

const crypto = require('node:crypto');
const { makeHistoryRowStub } = require('./history-entry-window');
const { historyActionHeaderFacts } = require('../shared/history-action-header.cjs');
const HISTORY_PAYLOAD_ON_DEMAND = 'on-demand-v1';
const HISTORY_PAYLOAD_HEADER_VERSION = 2;
const HISTORY_PAYLOAD_LABEL_CHARS = 512;
const HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD = 16 * 1024;
const HISTORY_PAYLOAD_PREVIEW_CHARS = 2 * 1024;
// A payload larger than this is capped for a single IPC/render pass. The data
// on disk is intact; the card says how much was withheld.
const HISTORY_PAYLOAD_RENDER_CAP = 4 * 1024 * 1024;

const formatHiddenSuffix = (totalChars, previewChars) => {
  const hiddenKb = Math.max(1, Math.round((totalChars - previewChars) / 1024));
  return '\n… (+' + hiddenKb + ' KB — полный вывод загрузится при раскрытии)';
};

const makePreview = (text) => {
  const preview = sliceHistoryPayload(text, { limit: HISTORY_PAYLOAD_PREVIEW_CHARS }).payload;
  return preview + formatHiddenSuffix(text.length, preview.length);
};

/**
 * Byte-bounded LRU for full payload texts, keyed by
 * `${toolType}:${sessionId}:${payloadId}`. Codex needs it because
 * regenerating one payload means re-running the whole projection; Claude
 * re-extracts from the cached recordMap instead and passes no stash.
 */
class HistoryPayloadStash {
  constructor(maxBytes = 192 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.records = new Map();
    this.totalBytes = 0;
  }

  static key(toolType, sessionId, payloadId) {
    return toolType + ':' + sessionId + ':' + payloadId;
  }

  set(toolType, sessionId, payloadId, text) {
    if (typeof text !== 'string' || text.length === 0) return;
    const key = HistoryPayloadStash.key(toolType, sessionId, payloadId);
    const bytes = 16 + text.length * 2;
    const existing = this.records.get(key);
    if (existing) {
      this.records.delete(key);
      this.totalBytes -= existing.bytes;
    }
    if (bytes > this.maxBytes) return;
    this.records.set(key, { text, bytes });
    this.totalBytes += bytes;
    while (this.totalBytes > this.maxBytes) {
      const lruKey = this.records.keys().next().value;
      if (lruKey === undefined) break;
      const record = this.records.get(lruKey);
      this.records.delete(lruKey);
      this.totalBytes -= record.bytes;
    }
  }

  get(toolType, sessionId, payloadId) {
    const key = HistoryPayloadStash.key(toolType, sessionId, payloadId);
    const record = this.records.get(key);
    if (!record) return null;
    this.records.delete(key);
    this.records.set(key, record);
    return record.text;
  }

  stats() {
    return { entries: this.records.size, approxBytes: this.totalBytes };
  }

  invalidateSession(toolType, sessionId) {
    const prefix = HistoryPayloadStash.key(toolType, sessionId, '');
    for (const [key, record] of this.records) {
      if (!key.startsWith(prefix)) continue;
      this.records.delete(key);
      this.totalBytes -= record.bytes;
    }
  }
}

// One shared stash: eviction pressure is global, matching real memory.
const historyPayloadStash = new HistoryPayloadStash();
const historyPayloadHash = text => crypto.createHash('sha256').update(text).digest('hex');

// An additional CONSUMER projection, not another transcript parser or cache.
// Canonical prepared pages remain compatible with desktop and full clients.
// JSON is the existing wire representation of an action; paging below keeps
// every byte available without inventing an incomplete args/diff schema.
function projectHistoryOnDemand({ toolType, sessionId, entries, stash = historyPayloadStash, onPayload }) {
  const refFor = (payloadId, text, rowUuid, encoding) => {
    stash.set(toolType, sessionId, payloadId, text);
    onPayload?.(payloadId, text);
    return { payloadId, totalChars: text.length, contentHash: historyPayloadHash(text), rowUuid, encoding };
  };
  const short = value => typeof value === 'string'
    ? sliceHistoryPayload(value, { limit: HISTORY_PAYLOAD_LABEL_CHARS }).payload : value;
  const exactFields = new Set(['toolUseId', 'toolName', 'agentSessionId', 'agentId', 'processGeneration']);
  const header = object => {
    const result = {};
    for (const field of ['toolUseId', 'toolName', 'family', 'bashWord', 'bashDetail', 'mcpServer', 'mcpMethod',
      'subject', 'aggregateKey', 'targetKey', 'targetLabel', 'operationLabel', 'docsKind', 'isError',
      'description', 'subagentStatus', 'agentSessionId', 'agentId', 'startedAt', 'completedAt', 'durationMs',
      'backgroundStatus', 'processGeneration', 'filePath']) {
      const value = object?.[field];
      if (['string', 'number', 'boolean'].includes(typeof value)) {
        // Long grouping keys must not collide merely because their label is clipped.
        result[field] = exactFields.has(field) ? value
          : field.endsWith('Key') && typeof value === 'string' && value.length > HISTORY_PAYLOAD_LABEL_CHARS
            ? 'sha256:' + historyPayloadHash(value) : short(value);
      }
    }
    return result;
  };
  return (entries || []).map(entry => {
    if (!entry || entry.rowStub) return entry;
    const row = { ...entry };
    const summary = [];
    if (Array.isArray(entry.actions)) row.actions = entry.actions.map((action, index) => {
      if (!action || typeof action !== 'object') return action;
      const actionRef = refFor('action:' + entry.uuid + ':' + index, JSON.stringify(action), entry.uuid, 'json');
      const facts = historyActionHeaderFacts(action);
      const actionSummary = makeHistoryRowStub({ actions: [action] }).actionSummary?.[0];
      if (actionSummary) summary.push({ ...header(actionSummary), ...facts });
      const preview = { tool: action.tool, ...header(action), actionRef, ...facts };
      if (action.rawTool) {
        preview.rawTool = header(action.rawTool);
        if (action.rawTool.resultRef) preview.rawTool.resultRef = {
          ...action.rawTool.resultRef, rowUuid: entry.uuid, encoding: 'text',
        };
      }
      return preview;
    });
    if (summary.length) row.actionSummary = summary;
    for (const [field, prefix] of [['thinking', 'thinking'], ['compactSummary', 'compact']]) {
      if (typeof entry[field] !== 'string' || !entry[field]) continue;
      row[field + 'Ref'] = entry[field + 'Ref']
        ? { ...entry[field + 'Ref'], rowUuid: entry.uuid, encoding: 'text' }
        : refFor(prefix + ':' + entry.uuid, entry[field], entry.uuid, 'text');
      row[field] = short(entry[field]);
      if (field === 'thinking') row.hasThinking = true;
    }
    return row;
  });
}

// Offset/limit are UTF-16 code units (the existing totalChars contract).
// Do not split a surrogate pair: JSON/Swift concatenation must remain lossless.
function sliceHistoryPayload(text, { offset = 0, limit = HISTORY_PAYLOAD_RENDER_CAP } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length
    || !Number.isSafeInteger(limit) || limit < 2 || limit > HISTORY_PAYLOAD_RENDER_CAP) throw Error('history_payload_range_invalid');
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] || '') && /[\uD800-\uDBFF]/.test(text[offset - 1])) throw Error('history_payload_range_invalid');
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return { payload: text.slice(offset, end), totalChars: text.length, offset,
    nextOffset: end < text.length ? end : null, truncatedForRender: false };
}

/**
 * Walks a built History entries array and dehydrates heavy text payloads
 * in place. Returns a summary for logging.
 *
 * Payload identities are deterministic across rebuilds of the same source:
 * - tool result  → 'result:' + rawTool.toolUseId (fallback: entry uuid + index)
 * - thinking     → 'thinking:' + entry.uuid
 * - compact      → 'compact:' + entry.uuid
 */
const dehydrateHistoryEntries = ({
  toolType,
  sessionId,
  entries,
  stash = null,
  threshold = HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD,
  // Claude compact summaries are short human prose and are re-extracted less
  // trivially than tool results; providers opt out of compact dehydration.
  dehydrateCompact = true,
  onPayload,
}) => {
  if (!Array.isArray(entries)) return { dehydrated: 0, savedChars: 0 };
  let dehydrated = 0;
  let savedChars = 0;

  const stashPut = (payloadId, text) => {
    if (stash) stash.set(toolType, sessionId, payloadId, text);
    onPayload?.(payloadId, text);
  };

  for (const entry of entries) {
    if (!entry) continue;

    if (Array.isArray(entry.actions)) {
      for (let index = 0; index < entry.actions.length; index += 1) {
        const action = entry.actions[index];
        const rawTool = action && action.tool === '__raw__' ? action.rawTool : null;
        if (!rawTool || typeof rawTool.result !== 'string') continue;
        if (rawTool.resultRef || rawTool.result.length <= threshold) continue;
        const payloadId = 'result:' + (
          rawTool.toolUseId
            ? String(rawTool.toolUseId)
            : String(entry.uuid || '') + ':' + index
        );
        stashPut(payloadId, rawTool.result);
        savedChars += rawTool.result.length;
        rawTool.resultRef = {
          payloadId,
          totalChars: rawTool.result.length,
          contentHash: historyPayloadHash(rawTool.result),
          ...(Number.isInteger(rawTool.resultSourceLine) ? { recordLine: rawTool.resultSourceLine } : {}),
        };
        rawTool.result = makePreview(rawTool.result);
        dehydrated += 1;
      }
    }

    if (!entry.thinkingRef && typeof entry.thinking === 'string' && entry.thinking.length > threshold) {
      const payloadId = 'thinking:' + String(entry.uuid || '');
      stashPut(payloadId, entry.thinking);
      savedChars += entry.thinking.length;
      entry.thinkingRef = {
        payloadId,
        totalChars: entry.thinking.length,
        contentHash: historyPayloadHash(entry.thinking),
        ...(Number.isInteger(entry.sourceRecordLine) ? { recordLine: entry.sourceRecordLine } : {}),
      };
      entry.thinking = makePreview(entry.thinking);
      dehydrated += 1;
    }

    if (dehydrateCompact && !entry.compactSummaryRef && typeof entry.compactSummary === 'string' && entry.compactSummary.length > threshold) {
      const payloadId = 'compact:' + String(entry.uuid || '');
      stashPut(payloadId, entry.compactSummary);
      savedChars += entry.compactSummary.length;
      entry.compactSummaryRef = {
        payloadId,
        totalChars: entry.compactSummary.length,
        contentHash: historyPayloadHash(entry.compactSummary),
        ...(Number.isInteger(entry.sourceRecordLine) ? { recordLine: entry.sourceRecordLine } : {}),
      };
      entry.compactSummary = makePreview(entry.compactSummary);
      dehydrated += 1;
    }
  }

  return { dehydrated, savedChars };
};

/** Caps a payload for one render/IPC pass without touching the source. */
const capPayloadForRender = (text) => {
  if (typeof text !== 'string') return { payload: '', truncatedForRender: false, totalChars: 0 };
  if (text.length <= HISTORY_PAYLOAD_RENDER_CAP) {
    return { payload: text, truncatedForRender: false, totalChars: text.length };
  }
  return {
    payload: text.slice(0, HISTORY_PAYLOAD_RENDER_CAP),
    truncatedForRender: true,
    totalChars: text.length,
  };
};

module.exports = {
  HISTORY_PAYLOAD_ON_DEMAND,
  HISTORY_PAYLOAD_HEADER_VERSION,
  HISTORY_PAYLOAD_LABEL_CHARS,
  historyPayloadHash,
  projectHistoryOnDemand,
  sliceHistoryPayload,
  HISTORY_PAYLOAD_DEHYDRATE_THRESHOLD,
  HISTORY_PAYLOAD_PREVIEW_CHARS,
  HISTORY_PAYLOAD_RENDER_CAP,
  HistoryPayloadStash,
  historyPayloadStash,
  dehydrateHistoryEntries,
  capPayloadForRender,
};
