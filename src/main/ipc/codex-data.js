const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const CODEX_LOGS_DB = path.join(CODEX_HOME, 'logs_2.sqlite');
const CODEX_AUTH_JSON = path.join(CODEX_HOME, 'auth.json');
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_ACCOUNTS_CACHE_TTL_MS = 60 * 1000;
const USAGE_ACCOUNTS_FOREGROUND_BUDGET_MS = 1200;
const CODEX_RESET_DRIFT_TOLERANCE_SECONDS = 10 * 60;
const CODEX_ACTIVE_USAGE_OVERRIDE_TTL_MS = 30 * 60 * 1000;
const CODEX_USAGE_SCAN_DAYS = 10;
const CODEX_USAGE_RATE_ROWS_LIMIT = 5000;

let modelCache = null;
let usageAccountsCache = null;
let usageAccountsRefreshInFlight = null;
let usageAccountsLastAttemptAt = null;
let usageAccountsLastError = null;
const codexActiveUsageOverrides = new Map();
const loggedRollbackKeys = new Set();
const _codexJsonlCache = new Map();
const _codexSessionSelectSkipLogged = new Set();
const _codexJsonlInflight = new Map();

function compactPreview(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function recordTimestamp(record) {
  return record?.timestamp || record?.time || record?.created_at || new Date().toISOString();
}

function stableUuid(sessionId, index, prefix = 'codex') {
  return `${prefix}-${sessionId || 'unknown'}-${index}`;
}

function parseTimestampMs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

function pathsAreSameOrNested(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (left === right) return true;
  const isNestedRelative = (relativePath) => (
    !!relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith('..' + path.sep) &&
    !path.isAbsolute(relativePath)
  );
  const leftToRight = path.relative(left, right);
  if (isNestedRelative(leftToRight)) return true;
  const rightToLeft = path.relative(right, left);
  return isNestedRelative(rightToLeft);
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decodeBase64UrlJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function shortDocsPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return null;
  const isDocsPath = normalized.includes('/docs/') || normalized.startsWith('docs/');
  const isClaudeMd = normalized === 'CLAUDE.md' || normalized.endsWith('/CLAUDE.md');
  if (!isDocsPath && !isClaudeMd) return null;
  const segs = normalized.split('/').filter(Boolean);
  return segs.length >= 2 ? segs.slice(-2).join('/') : segs[0];
}

function addUniqueAttr(entry, key, value) {
  if (!entry || !value) return;
  const list = Array.isArray(entry[key]) ? entry[key] : [];
  if (!list.includes(value)) {
    entry[key] = [...list, value];
  }
}

function addDocsEdited(entry, filePath) {
  const shortName = shortDocsPath(filePath);
  if (shortName) addUniqueAttr(entry, 'docsEdited', shortName);
}

function extractPatchTouchedFiles(patchText) {
  if (typeof patchText !== 'string' || !patchText.includes('*** Begin Patch')) return [];
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match;
  while ((match = re.exec(patchText)) !== null) {
    files.push(match[1].trim());
  }
  return files;
}

function parseToolArguments(payload) {
  if (payload?.arguments != null) {
    return typeof payload.arguments === 'string'
      ? safeJsonParse(payload.arguments, { raw: payload.arguments })
      : payload.arguments;
  }
  if (payload?.input != null && typeof payload.input !== 'string') return payload.input;
  return {};
}

function collectCodexDocsAttributes(currentUser, payload) {
  if (!currentUser || !payload || typeof payload !== 'object') return;
  const toolName = payload.name || payload.tool_name || '';
  const namespace = payload.namespace || '';
  const args = parseToolArguments(payload) || {};

  if ((namespace === 'mcp__knowledge' && toolName === 'docs_search') || toolName === 'mcp__knowledge__docs_search') {
    const query = args.query || args.q || '';
    if (query) addUniqueAttr(currentUser, 'docsSearchQueries', query);
  }

  if (toolName === 'apply_patch') {
    const patchText = typeof payload.input === 'string'
      ? payload.input
      : (typeof payload.arguments === 'string' ? payload.arguments : '');
    for (const filePath of extractPatchTouchedFiles(patchText)) {
      addDocsEdited(currentUser, filePath);
    }
  }
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.value === 'string') return content.value;
    return '';
  }
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      parts.push(part);
    } else if (typeof part.text === 'string') {
      parts.push(part.text);
    } else if (typeof part.value === 'string') {
      parts.push(part.value);
    } else if (part.type === 'input_text' && typeof part.text === 'string') {
      parts.push(part.text);
    } else if (part.type === 'output_text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function formatReplacementHistory(replacementHistory) {
  if (!Array.isArray(replacementHistory) || replacementHistory.length === 0) return '';
  const chunks = [];
  for (const item of replacementHistory) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      const role = item.role || 'message';
      const text = extractTextContent(item.content);
      const hasImage = Array.isArray(item.content) && item.content.some((part) => part?.type === 'input_image' || part?.image_url || part?.image);
      const body = [text, hasImage ? '[image omitted]' : ''].filter(Boolean).join('\n').trim();
      if (body) chunks.push(`### ${role}\n${body}`);
      continue;
    }
    if (item.type === 'compaction') {
      chunks.push('### compaction\n[encrypted compaction state]');
      continue;
    }
    const body = extractTextContent(item.content || item.message || item.text).trim();
    if (body) chunks.push(`### ${item.type || 'record'}\n${body}`);
  }
  return chunks.join('\n\n');
}

function extractReasoning(summary) {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary.map((item) => {
    if (!item) return '';
    if (typeof item === 'string') return item;
    return item.text || item.summary || item.content || '';
  }).filter(Boolean).join('\n');
}

function compactEventContent(payload) {
  const replacement = formatReplacementHistory(payload?.replacement_history || payload?.replacementHistory);
  return replacement || payload?.message || payload?.summary || payload?.text || payload?.content || 'Conversation compacted';
}

function compactEventTitle(payload) {
  return payload?.message || payload?.summary || payload?.text || payload?.content || 'Conversation compacted';
}

function isCompactPayload(payload) {
  const t = String(payload?.type || payload?.name || '').toLowerCase();
  return t === 'compact' ||
    t === 'compact_boundary' ||
    t === 'compact_started' ||
    t === 'compact_completed' ||
    t.includes('compact');
}

async function walkJsonlFiles(rootDir, maxFiles = 4000) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.with-rollbacks-backup')) {
        out.push(full);
        if (out.length >= maxFiles) return;
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function parseJsonlFile(filePath) {
  const inflight = _codexJsonlInflight.get(filePath);
  if (inflight) {
    const records = await inflight;
    return records.slice();
  }
  const load = _parseJsonlFileIncremental(filePath);
  _codexJsonlInflight.set(filePath, load);
  try {
    const records = await load;
    return records.slice();
  } finally {
    if (_codexJsonlInflight.get(filePath) === load) {
      _codexJsonlInflight.delete(filePath);
    }
  }
}

async function _parseJsonlFileIncremental(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    _codexJsonlCache.delete(filePath);
    return [];
  }

  const cached = _codexJsonlCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.records;
  }

  if (cached && stat.size > cached.size) {
    const prevSize = cached.size;
    const prevLineCount = cached.lineCount || 0;
    const prevLeftover = cached.leftover || '';
    const fd = await fs.promises.open(filePath, 'r');
    let newContent = '';
    try {
      const newByteCount = stat.size - prevSize;
      const buf = Buffer.allocUnsafe(newByteCount);
      await fd.read(buf, 0, newByteCount, prevSize);
      newContent = buf.toString('utf8');
    } finally {
      await fd.close();
    }

    const content = prevLeftover + newContent;
    const lines = content.split('\n');
    const leftover = lines.pop() || '';
    const records = cached.records;
    let parsed = 0;
    let errors = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        records.push({ ...record, __line: prevLineCount + i });
        parsed += 1;
      } catch {
        errors += 1;
      }
    }
    _codexJsonlCache.set(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount: prevLineCount + lines.length,
      leftover,
      records,
    });
    console.log('[CodexJsonlCache] append file=' + path.basename(filePath) +
      ' bytes=' + (stat.size - prevSize) +
      ' parsed=' + parsed +
      ' errors=' + errors +
      ' total=' + records.length +
      ' leftover=' + leftover.length);
    return records;
  }

  const text = await fs.promises.readFile(filePath, 'utf8');
  const records = [];
  const lines = text.split('\n');
  const leftover = lines.pop() || '';
  let errors = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      records.push({ ...record, __line: i });
    } catch {
      // Ignore partial/corrupt trailing lines. Codex appends JSONL while running.
      errors += 1;
    }
  }
  _codexJsonlCache.set(filePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount: lines.length,
    leftover,
    records,
  });
  console.log('[CodexJsonlCache] full file=' + path.basename(filePath) +
    ' sizeKB=' + Math.round(stat.size / 1024) +
    ' records=' + records.length +
    ' errors=' + errors +
    ' leftover=' + leftover.length +
    (cached ? ' reason=rewrite-or-shrink' : ' reason=first-read'));
  return records;
}

function invalidateCodexJsonlCache(filePath) {
  if (!filePath) return;
  _codexJsonlCache.delete(filePath);
}

function getSessionMeta(records) {
  for (const record of records) {
    if (record?.type === 'session_meta') return record.payload || {};
  }
  return {};
}

function getSessionMetaRecord(records) {
  for (const record of records) {
    if (record?.type === 'session_meta') return record;
  }
  return null;
}

function getCodexForkLiveStartLine(records, meta) {
  if (!meta?.forked_from_id) return undefined;
  const startedAtMs = parseTimestampMs(meta.timestamp);
  if (!Number.isFinite(startedAtMs)) return undefined;

  for (const record of records) {
    const payload = record?.payload || {};
    if (record?.type !== 'event_msg' || payload.type !== 'task_started') continue;

    const payloadStartedAt = Number(payload.started_at);
    if (Number.isFinite(payloadStartedAt) && payloadStartedAt > 0) {
      if (payloadStartedAt * 1000 >= startedAtMs - 1000) return record.__line;
      continue;
    }

    const recordAtMs = parseTimestampMs(record.timestamp);
    if (Number.isFinite(recordAtMs) && recordAtMs >= startedAtMs + 1000) return record.__line;
  }

  return undefined;
}

function getTimelineSessionMeta(records) {
  const metaRecord = getSessionMetaRecord(records);
  const meta = metaRecord?.payload || {};
  const forkLiveStartLine = getCodexForkLiveStartLine(records, meta);
  return {
    id: meta.id,
    forked_from_id: meta.forked_from_id,
    timestamp: meta.timestamp,
    cwd: meta.cwd,
    sourceLine: metaRecord?.__line,
    forkLiveStartLine,
  };
}

function getSessionMetas(records) {
  return records
    .filter((record) => record?.type === 'session_meta' && record.payload)
    .map((record) => record.payload);
}

function recordsReferenceSession(records, sessionId) {
  if (!sessionId) return false;
  return getSessionMetas(records).some((meta) => {
    if (meta?.id === sessionId) return true;
    if (meta?.forked_from_id === sessionId) return true;
    return false;
  });
}

function isCodexSubagentSession(meta) {
  if (!meta) return false;
  if (meta.thread_source === 'subagent') return true;
  if (meta.parent_thread_id) return true;
  if (meta.source && typeof meta.source === 'object' && meta.source.subagent) return true;
  return false;
}

function isCodexTuiSession(meta) {
  if (!meta) return false;
  if (meta.originator && meta.originator !== 'codex-tui') return false;
  if (meta.source === 'exec') return false;
  return true;
}

function isFreshCodexLaunchSession(meta) {
  if (!isCodexTuiSession(meta)) return false;
  if (isCodexSubagentSession(meta)) return false;
  if (meta.thread_source && meta.thread_source !== 'user') return false;
  return true;
}

function codexSessionSkipReason(meta, { sourceSessionId }) {
  if (sourceSessionId) {
    return 'source-mismatch';
  }
  if (!isCodexTuiSession(meta)) return 'not-tui-session';
  if (isCodexSubagentSession(meta)) return 'subagent-session';
  if (meta.thread_source && meta.thread_source !== 'user') return 'non-user-thread';
  return null;
}

function logCodexSessionCandidateSkip(meta, filePath, reason, { sourceSessionId }) {
  const sessionId = meta?.id || 'unknown';
  const key = [sessionId, path.basename(filePath || ''), reason, sourceSessionId || 'fresh'].join(':');
  if (_codexSessionSelectSkipLogged.has(key)) return;
  _codexSessionSelectSkipLogged.add(key);
  console.log('[CodexSessionSelect] skip session=' + sessionId +
    ' reason=' + reason +
    ' file=' + path.basename(filePath || '') +
    ' cwd=' + (meta?.cwd || 'n/a') +
    ' threadSource=' + (meta?.thread_source || 'n/a') +
    ' parent=' + (meta?.parent_thread_id || 'n/a') +
    ' forkedFrom=' + (meta?.forked_from_id || 'n/a') +
    ' originator=' + (meta?.originator || 'n/a') +
    ' source=' + (sourceSessionId || 'n/a'));
}

async function findCodexSessionFile(sessionId, cwd) {
  if (!sessionId || !fs.existsSync(CODEX_SESSIONS_DIR)) return null;

  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  const suffixHit = files.find((file) => path.basename(file).includes(sessionId) && path.basename(file).endsWith('.jsonl'));
  if (suffixHit) return { filePath: suffixHit };

  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  for (const filePath of files) {
    let records;
    try {
      records = await parseJsonlFile(filePath);
    } catch {
      continue;
    }
    const meta = getSessionMeta(records);
    if (meta?.id !== sessionId) continue;
    if (normalizedCwd && meta.cwd && path.resolve(meta.cwd) !== normalizedCwd) {
      // Keep searching for an exact cwd match, but accept this below if it is
      // the only match.
      return { filePath };
    }
    return { filePath };
  }
  return null;
}

async function findLatestCodexSession({ cwd, sinceMs = 0, sourceSessionId = null, excludeSessionIds = [] } = {}) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  const excludedSessionIds = new Set((Array.isArray(excludeSessionIds) ? excludeSessionIds : [])
    .filter(Boolean)
    .map(String));
  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  const candidates = [];

  for (const filePath of files) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (sinceMs && stat.mtimeMs < sinceMs - 5000) continue;
    candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const relatedFallbacks = [];
  for (const candidate of candidates.slice(0, 80)) {
    let records;
    try {
      records = await parseJsonlFile(candidate.filePath);
    } catch {
      continue;
    }
    const meta = getSessionMeta(records);
    if (!meta?.id) continue;
    if (excludedSessionIds.has(String(meta.id))) continue;
    if (sourceSessionId && meta.id === sourceSessionId) continue;
    const sessionStartedMs = meta.timestamp ? Date.parse(meta.timestamp) : 0;
    if (sinceMs && Number.isFinite(sessionStartedMs) && sessionStartedMs > 0 && sessionStartedMs < sinceMs - 5000) continue;
    const metaCwd = meta.cwd ? path.resolve(meta.cwd) : null;
    const cwdMatched = !normalizedCwd || (metaCwd && metaCwd === normalizedCwd);
    const cwdRelated = !normalizedCwd || (metaCwd && pathsAreSameOrNested(metaCwd, normalizedCwd));
    const sourceMatched = !!sourceSessionId && recordsReferenceSession(records, sourceSessionId);
    if (sourceSessionId && !sourceMatched) {
      if (cwdMatched || cwdRelated) {
        logCodexSessionCandidateSkip(meta, candidate.filePath, codexSessionSkipReason(meta, { sourceSessionId }), { sourceSessionId });
      }
      continue;
    }
    if (sourceSessionId && !isFreshCodexLaunchSession(meta)) {
      if (cwdMatched || cwdRelated || sourceMatched) {
        logCodexSessionCandidateSkip(meta, candidate.filePath, codexSessionSkipReason(meta, { sourceSessionId: null }), { sourceSessionId });
      }
      continue;
    }
    if (!sourceSessionId && !isFreshCodexLaunchSession(meta)) {
      if (cwdMatched || cwdRelated) {
        logCodexSessionCandidateSkip(meta, candidate.filePath, codexSessionSkipReason(meta, { sourceSessionId }), { sourceSessionId });
      }
      continue;
    }
    if (!cwdMatched && !sourceMatched) {
      if (cwdRelated) {
        relatedFallbacks.push({
          sessionId: meta.id,
          filePath: candidate.filePath,
          cwd: meta.cwd,
          cwdMatched: false,
          cwdRelated: true,
          sourceMatched,
          threadSource: meta.thread_source || null,
          parentThreadId: meta.parent_thread_id || null,
          forkedFromId: meta.forked_from_id || null,
          originator: meta.originator || null,
        });
      }
      continue;
    }
    return {
      sessionId: meta.id,
      filePath: candidate.filePath,
      cwd: meta.cwd,
      cwdMatched,
      cwdRelated,
      sourceMatched,
      threadSource: meta.thread_source || null,
      parentThreadId: meta.parent_thread_id || null,
      forkedFromId: meta.forked_from_id || null,
      originator: meta.originator || null,
    };
  }
  return relatedFallbacks[0] || null;
}

function pushAssistantEntry(entries, sessionId, record, turnIndex, content, thinking, actions) {
  if (!content && !thinking && (!actions || actions.length === 0)) return;
  entries.push({
    uuid: stableUuid(sessionId, record.__line, 'codex-assistant'),
    role: 'assistant',
    timestamp: recordTimestamp(record),
    content: content || '',
    thinking: thinking || undefined,
    actions: actions && actions.length > 0 ? actions : undefined,
    sessionId,
    turnIndex,
  });
}

function applyRollback(list, numTurns) {
  const requestedTurns = Number(numTurns || 0);
  const beforeCount = list.length;
  if (!requestedTurns || requestedTurns <= 0) {
    return { requestedTurns, beforeCount, afterCount: list.length, removedTurnIds: [], removedEntries: 0, removedPreview: [] };
  }
  const turnIds = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const tid = list[i].turnIndex;
    if (typeof tid !== 'number') continue;
    if (!turnIds.includes(tid)) turnIds.push(tid);
    if (turnIds.length >= requestedTurns) break;
  }
  if (turnIds.length === 0) {
    return { requestedTurns, beforeCount, afterCount: list.length, removedTurnIds: [], removedEntries: 0, removedPreview: [] };
  }
  const remove = new Set(turnIds);
  let removedEntries = 0;
  const removedPreview = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!remove.has(entry.turnIndex)) continue;
    removedEntries += 1;
    if (removedPreview.length < 4) {
      removedPreview.push({
        role: entry.role || entry.type || 'entry',
        turnIndex: entry.turnIndex,
        line: entry.uuid ? String(entry.uuid).split('-').pop() : undefined,
        text: compactPreview(entry.content || entry.thinking || ''),
      });
    }
    list.splice(i, 1);
  }
  return { requestedTurns, beforeCount, afterCount: list.length, removedTurnIds: turnIds, removedEntries, removedPreview };
}

function logCodexRollback(context, sessionId, record, result) {
  if (!result) return;
  const line = Number(record?.__line ?? -1);
  const key = `${context}:${sessionId || 'unknown'}:${line}:${result.requestedTurns}:${result.removedTurnIds.join(',')}:${result.removedEntries}`;
  if (loggedRollbackKeys.has(key)) return;
  loggedRollbackKeys.add(key);
  if (loggedRollbackKeys.size > 1000) loggedRollbackKeys.clear();
  const sid = sessionId ? String(sessionId).slice(0, 8) : 'unknown';
  const removedTurns = result.removedTurnIds.length > 0 ? result.removedTurnIds.join(',') : 'none';
  const preview = result.removedPreview.map((item) => (
    `${item.role}@t${item.turnIndex}${item.line ? `/L${item.line}` : ''}:${JSON.stringify(item.text)}`
  )).join(' | ');
  console.warn(
    `[CodexRollback] context=${context} session=${sid}` +
    ` line=${line + 1} requested=${result.requestedTurns}` +
    ` removedTurns=${removedTurns} removedEntries=${result.removedEntries}` +
    ` before=${result.beforeCount} after=${result.afterCount}` +
    (preview ? ` preview=${preview}` : ' preview=empty/no-op')
  );
}

function lastCodexTimelineUser(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === 'user') return entries[i];
  }
  return null;
}

function buildCodexTimeline(records, sessionId) {
  const entries = [];
  let currentUser = null;
  let currentTurnIndex = -1;
  let latestModel = null;
  let latestEffort = null;
  let latestTokenCountInfo = null;
  let lastTopLevelCompactLine = -Infinity;

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
      entries.push({
        uuid: stableUuid(sessionId, record.__line, 'codex-compact'),
        type: 'compact',
        timestamp: recordTimestamp(record),
        content: compactEventTitle(payload),
        preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
        sessionId,
      });
      lastTopLevelCompactLine = record.__line;
      continue;
    }

    if (record.type === 'turn_context') {
      latestModel = payload.model || latestModel;
      latestEffort = payload.effort || latestEffort;
      if (currentUser) currentUser.responseModel = latestModel || currentUser.responseModel;
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        currentTurnIndex += 1;
        const text = payload.message || extractTextContent(payload.content) || '';
        const entry = {
          uuid: stableUuid(sessionId, record.__line, 'codex-user'),
          type: 'user',
          timestamp: recordTimestamp(record),
          content: text,
          sourceLine: record.__line,
          hasImage: Array.isArray(payload.images) ? payload.images.length > 0 : false,
          sessionId,
          turnIndex: currentTurnIndex,
          responseModel: latestModel || undefined,
          responseEffort: latestEffort || undefined,
        };
        entries.push(entry);
        currentUser = entry;
      } else if (payload.type === 'thread_rolled_back') {
        const rollback = applyRollback(entries, Number(payload.num_turns || payload.turns || 1));
        logCodexRollback('timeline', sessionId, record, rollback);
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
        currentUser = lastCodexTimelineUser(entries);
      } else if (payload.type === 'token_count') {
        const info = payload.info || {};
        latestTokenCountInfo = info;
        const last = info.last_token_usage || {};
        const total = info.total_token_usage || {};
        if (currentUser) {
          currentUser.responseTokens = Number(last.total_tokens || last.output_tokens || 0) || undefined;
          currentUser.responseModel = latestModel || currentUser.responseModel;
          currentUser.responseEffort = latestEffort || currentUser.responseEffort;
          const contextWindow = Number(info.model_context_window || 0);
          const totalTokens = Number(total.total_tokens || 0);
          if (contextWindow > 0 && totalTokens > 0) {
            currentUser.contextPct = Math.min(100, Math.max(0, (totalTokens / contextWindow) * 100));
          }
          // Per-turn API usage from THIS request's last_token_usage. Codex re-sends
          // full history each turn, so `last` is exactly this turn's billing receipt
          // (per-entry is honest; do NOT sum across a range — counters overlap).
          // Shape differs from Claude: Codex exposes cached_input_tokens (cache-read
          // analogue; no cache_creation) and splits output into reasoning vs answer.
          const lastInput = Number(last.input_tokens || 0);
          const lastCached = Number(last.cached_input_tokens || 0);
          const lastOutput = Number(last.output_tokens || 0);
          const lastReasoning = Number(last.reasoning_output_tokens || 0);
          if (lastInput > 0 || lastOutput > 0) {
            currentUser.codexUsage = {
              inputCached: lastCached,
              inputUncached: Math.max(0, lastInput - lastCached),
              outputAnswer: Math.max(0, lastOutput - lastReasoning),
              outputReasoning: lastReasoning,
            };
          }
          // Subscription quota snapshot (5h / weekly). Same source the toolbar usage
          // chip reads; surfaced here too so the detail panel can show "where this
          // turn left my budget" without a second lookup. resets_at → epoch seconds.
          const limits = buildCodexUsageFromRateLimits(payload.rate_limits);
          if (limits && (limits.five_hour || limits.seven_day)) {
            currentUser.codexLimits = {
              fiveHourPct: limits.five_hour?.utilization ?? null,
              fiveHourResetsAt: limits.five_hour?.resets_at ?? null,
              weeklyPct: limits.seven_day?.utilization ?? null,
              weeklyResetsAt: limits.seven_day?.resets_at ?? null,
              planType: limits.plan_type ?? null,
            };
          }
        }
      } else if (isCompactPayload(payload)) {
        if (record.__line <= lastTopLevelCompactLine + 3) {
          continue;
        }
        const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
        entries.push({
          uuid: stableUuid(sessionId, record.__line, 'codex-compact'),
          type: 'compact',
          timestamp: recordTimestamp(record),
          content: compactEventTitle(payload),
          sourceLine: record.__line,
          preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
          sessionId,
        });
      }
      continue;
    }

    if (record.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        collectCodexDocsAttributes(currentUser, payload);
      }
      if (payload.type === 'reasoning' && currentUser) {
        currentUser.responseHasThinking = true;
      } else if (payload.type === 'message' && payload.role === 'assistant' && currentUser) {
        currentUser.responseModel = payload.model || latestModel || currentUser.responseModel;
      }
    }
  }

  return entries;
}

function buildCodexFullHistory(records, sessionId) {
  const entries = [];
  const pendingCalls = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';
  let latestTokenCountInfo = null;
  let lastTopLevelCompactLine = -Infinity;

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
      entries.push({
        uuid: stableUuid(sessionId, record.__line, 'codex-compact'),
        role: 'compact',
        timestamp: recordTimestamp(record),
        content: 'Conversation compacted',
        compactSummary: compactEventContent(payload),
        preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
        sessionId,
        turnIndex: currentTurnIndex,
      });
      lastTopLevelCompactLine = record.__line;
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        currentTurnIndex += 1;
        entries.push({
          uuid: stableUuid(sessionId, record.__line, 'codex-user'),
          role: 'user',
          timestamp: recordTimestamp(record),
          content: payload.message || extractTextContent(payload.content) || '',
          sessionId,
          turnIndex: currentTurnIndex,
        });
      } else if (payload.type === 'thread_rolled_back') {
        const rollback = applyRollback(entries, Number(payload.num_turns || payload.turns || 1));
        logCodexRollback('full-history', sessionId, record, rollback);
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
      } else if (payload.type === 'token_count') {
        latestTokenCountInfo = payload.info || {};
      } else if (isCompactPayload(payload)) {
        if (record.__line <= lastTopLevelCompactLine + 3) {
          continue;
        }
        const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
        entries.push({
          uuid: stableUuid(sessionId, record.__line, 'codex-compact'),
          role: 'compact',
          timestamp: recordTimestamp(record),
          content: 'Conversation compacted',
          compactSummary: compactEventContent(payload),
          preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
          sessionId,
          turnIndex: currentTurnIndex,
        });
      }
      continue;
    }

    if (record.type !== 'response_item') continue;

    if (payload.type === 'reasoning') {
      const text = extractReasoning(payload.summary);
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      continue;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = extractTextContent(payload.content);
      pushAssistantEntry(entries, sessionId, record, currentTurnIndex, text, pendingThinking, null);
      pendingThinking = '';
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id || payload.id || stableUuid(sessionId, record.__line, 'codex-call');
      const args = payload.arguments
        ? (safeJsonParse(payload.arguments, { raw: payload.arguments }) || {})
        : (payload.input && typeof payload.input === 'string'
          ? { input: payload.input }
          : (payload.input || {}));
      pendingCalls.set(callId, {
        toolName: payload.name || payload.tool_name || payload.type,
        args: args && typeof args === 'object' ? args : { value: args },
        timestamp: recordTimestamp(record),
        line: record.__line,
      });
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id || payload.id;
      const call = pendingCalls.get(callId) || {
        toolName: payload.name || payload.type,
        args: {},
        timestamp: recordTimestamp(record),
        line: record.__line,
      };
      const output = typeof payload.output === 'string'
        ? payload.output
        : payload.output != null ? JSON.stringify(payload.output, null, 2) : '';
      pushAssistantEntry(entries, sessionId, record, currentTurnIndex, '', pendingThinking, [{
        tool: '__raw__',
        rawTool: {
          toolName: call.toolName,
          args: call.args || {},
          result: output,
          isError: !!payload.is_error,
        },
      }]);
      pendingThinking = '';
      pendingCalls.delete(callId);
    }
  }

  return entries.map(({ turnIndex, ...entry }) => entry);
}

const CODEX_SHELL_TOOLS = new Set([
  'exec_command', 'write_stdin', 'read_output', 'run_command', 'restart_process',
  'kill_process', 'run_chain',
]);
const CODEX_SUBAGENT_NAMES = new Set(['spawn_agent', 'resume_agent', 'wait_agent', 'send_input', 'close_agent']);
const CODEX_OUTPUT_LIMIT = 60_000;

function stringifyCompact(value, max = CODEX_OUTPUT_LIMIT) {
  let text = '';
  if (value == null) text = '';
  else if (typeof value === 'string') text = value;
  else text = JSON.stringify(value, null, 2);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function stripBase64Images(text) {
  return String(text || '').replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g, '[image: base64 omitted]');
}

function summarizeToolSearchOutput(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  if (tools.length === 0) return stringifyCompact(payload?.output || payload, 10_000);
  const lines = [];
  const visit = (node, prefix = '') => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'namespace' && node.name) {
      lines.push(`${prefix}${node.name}/`);
      const childPrefix = `${prefix}  `;
      for (const child of Array.isArray(node.tools) ? node.tools : []) visit(child, childPrefix);
      return;
    }
    if (node.name) {
      lines.push(`${prefix}${node.name}`);
    }
  };
  for (const tool of tools) visit(tool);
  return lines.join('\n') || `[tool_search returned ${tools.length} tools]`;
}

function codexToolName(call) {
  if (!call) return 'tool';
  if (call.type === 'web_search_call') return 'web_search';
  if (call.type === 'tool_search_call' || call.type === 'tool_search_output') return 'tool_search';
  return call.name || call.tool_name || call.type || 'tool';
}

function codexToolGroup(call) {
  const type = call?.type;
  const name = codexToolName(call);
  const namespace = call?.namespace || '';
  if (type === 'web_search_call' || name === 'web_search') return 'web';
  if (type === 'tool_search_call' || type === 'tool_search_output' || name === 'tool_search') return 'toolSearch';
  if (namespace === 'multi_agent_v1' || CODEX_SUBAGENT_NAMES.has(name)) return 'subagent';
  if (name === 'apply_patch') return 'editing';
  if (namespace && namespace.startsWith('mcp__')) return 'mcp';
  if (CODEX_SHELL_TOOLS.has(name)) return 'bash';
  return 'tools';
}

function parseCodexCallArgs(call) {
  if (!call) return {};
  if (call.type === 'web_search_call') return call.action || {};
  if (call.type === 'tool_search_call') return call.arguments || {};
  return parseToolArguments(call);
}

function shouldIncludeCodexTool(group, toolName, opts) {
  if (!opts.includeClaude) return false;
  if (group === 'editing') return !!opts.includeEditing;
  if (group === 'bash') return !!opts.includeBash;
  if (group === 'mcp') return !!opts.includeTools;
  if (group === 'web') return !!opts.includeWebSearch;
  if (group === 'toolSearch') return !!opts.includeToolSearch;
  if (group === 'tools') return !!opts.includeOtherTools;
  if (group === 'subagent') {
    if (opts.includeSubagentHistory) return true;
    return !!opts.includeSubagentResult && toolName === 'wait_agent';
  }
  return false;
}

function codexToolLabel(call) {
  const name = codexToolName(call);
  const namespace = call?.namespace || '';
  if (name === 'apply_patch') return '🧩 apply_patch';
  if (CODEX_SHELL_TOOLS.has(name)) return `🖥 ${name}`;
  if (namespace === 'multi_agent_v1' || CODEX_SUBAGENT_NAMES.has(name)) return `🧵 ${name}`;
  if (namespace && namespace.startsWith('mcp__')) return `🔌 ${namespace} / ${name}`;
  if (name === 'web_search') return '🌐 web_search';
  if (name === 'tool_search') return '🧰 tool_search';
  return `⚙️ ${name}`;
}

function normalizeCodexToolOutput(outputPayload) {
  if (!outputPayload) return '';
  if (outputPayload.type === 'tool_search_output') return summarizeToolSearchOutput(outputPayload);
  const raw = outputPayload.output != null ? outputPayload.output : outputPayload.result;
  if (raw == null) return '';
  return stripBase64Images(stringifyCompact(raw));
}

function formatCodexToolForExport(call, outputPayload, opts) {
  const group = codexToolGroup(call);
  const name = codexToolName(call);
  if (!shouldIncludeCodexTool(group, name, opts)) return null;

  const args = parseCodexCallArgs(call);
  const output = normalizeCodexToolOutput(outputPayload);
  const body = { request: args };
  if (output) body.response = output;
  if (outputPayload?.is_error) body.isError = true;

  return [
    '🛠 TOOL:',
    codexToolLabel(call),
    '```json',
    stringifyCompact(body),
    '```',
    '',
  ].join('\n');
}

function removeLastCodexTurns(entries, numTurns) {
  const requested = Number(numTurns || 1);
  if (!requested || requested <= 0) return;
  const turns = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const tid = entries[i]?.turnIndex;
    if (typeof tid !== 'number') continue;
    if (!turns.includes(tid)) turns.push(tid);
    if (turns.length >= requested) break;
  }
  const remove = new Set(turns);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (remove.has(entries[i]?.turnIndex)) entries.splice(i, 1);
  }
}

function removeLastCodexRecordTurns(wrappers, numTurns) {
  const requested = Number(numTurns || 1);
  if (!requested || requested <= 0) return { removedTurns: [], removedRecords: 0 };
  const turns = [];
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const tid = wrappers[i]?.turnIndex;
    if (typeof tid !== 'number') continue;
    if (!turns.includes(tid)) turns.push(tid);
    if (turns.length >= requested) break;
  }
  if (turns.length === 0) return { removedTurns: [], removedRecords: 0 };
  const remove = new Set(turns);
  let removedRecords = 0;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    if (!remove.has(wrappers[i]?.turnIndex)) continue;
    wrappers.splice(i, 1);
    removedRecords += 1;
  }
  return { removedTurns: turns, removedRecords };
}

function maxCodexRecordTurnIndex(wrappers) {
  let max = -1;
  for (const wrapper of wrappers) {
    if (typeof wrapper?.turnIndex === 'number' && wrapper.turnIndex > max) max = wrapper.turnIndex;
  }
  return max;
}

function normalizeCodexText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function isCodexPreUserRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === 'event_msg' && payload.type === 'task_started') return true;
  if (record?.type === 'turn_context') return true;
  if (record?.type === 'response_item' && payload.type === 'message') {
    return payload.role === 'user' || payload.role === 'developer';
  }
  return false;
}

function isCodexResponseUserRecord(record) {
  const payload = record?.payload || {};
  return record?.type === 'response_item' && payload.type === 'message' && payload.role === 'user';
}

function codexPendingStartForUserMessage(pending, message) {
  const expected = normalizeCodexText(message);
  if (!expected) return pending.length;
  let duplicateIdx = -1;
  for (let i = pending.length - 1; i >= 0; i--) {
    const record = pending[i]?.record;
    if (!isCodexResponseUserRecord(record)) continue;
    const text = normalizeCodexText(extractTextContent(record.payload?.content));
    if (text === expected) {
      duplicateIdx = i;
      break;
    }
  }
  if (duplicateIdx < 0) return pending.length;
  let start = duplicateIdx;
  while (start > 0) {
    const prev = pending[start - 1]?.record;
    if (prev?.type === 'turn_context') {
      start -= 1;
      continue;
    }
    if (prev?.type === 'event_msg' && prev.payload?.type === 'task_started') {
      start -= 1;
      continue;
    }
    break;
  }
  return start;
}

function cloneCodexRecordForWrite(record) {
  const cloned = JSON.parse(JSON.stringify(record || {}));
  delete cloned.__line;
  return cloned;
}

function isCodexCompactRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === 'compacted') return true;
  if (record?.type === 'event_msg' && isCompactPayload(payload)) return true;
  const payloadType = String(payload?.type || '').toLowerCase();
  return record?.type === 'response_item' && payloadType.includes('compact');
}

function pushCodexVisibleWrapper(wrappers, record, turnIndex, extra = {}) {
  wrappers.push({
    record,
    turnIndex: typeof turnIndex === 'number' && turnIndex >= 0 ? turnIndex : null,
    line: record?.__line,
    ...extra,
  });
}

function buildCodexVisibleRecordWrappers(records, sessionId) {
  const wrappers = [];
  const pending = [];
  let currentTurnIndex = -1;
  let lastTopLevelCompactLine = -Infinity;

  const flushPending = (turnIndex) => {
    while (pending.length > 0) {
      const item = pending.shift();
      pushCodexVisibleWrapper(wrappers, item.record, turnIndex);
    }
  };

  for (const record of records) {
    const payload = record?.payload || {};

    if (record?.type === 'event_msg' && payload.type === 'thread_rolled_back') {
      // Materialize the current visible thread: old rolled-back turns and the
      // rollback event itself are intentionally omitted from rewritten files.
      pending.length = 0;
      removeLastCodexRecordTurns(wrappers, Number(payload.num_turns || payload.turns || 1));
      currentTurnIndex = maxCodexRecordTurnIndex(wrappers);
      continue;
    }

    if (record?.type === 'event_msg' && payload.type === 'user_message') {
      const previousTurnIndex = currentTurnIndex;
      currentTurnIndex += 1;
      const text = payload.message || extractTextContent(payload.content) || '';
      const turnStart = codexPendingStartForUserMessage(pending, text);
      for (let i = 0; i < turnStart; i++) {
        pushCodexVisibleWrapper(wrappers, pending[i].record, previousTurnIndex);
      }
      for (let i = turnStart; i < pending.length; i++) {
        pushCodexVisibleWrapper(wrappers, pending[i].record, currentTurnIndex);
      }
      pending.length = 0;
      pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
        sourceUuid: stableUuid(sessionId, record.__line, 'codex-user'),
        kind: 'user',
      });
      continue;
    }

    if (isCodexPreUserRecord(record)) {
      pending.push({ record });
      continue;
    }

    if (pending.length > 0) {
      flushPending(currentTurnIndex);
    }

    if (record?.type === 'compacted') {
      pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
        sourceUuid: stableUuid(sessionId, record.__line, 'codex-compact'),
        kind: 'compact',
      });
      lastTopLevelCompactLine = record.__line;
      continue;
    }

    if (record?.type === 'event_msg' && isCompactPayload(payload)) {
      const isTopLevelCompanion = record.__line <= lastTopLevelCompactLine + 3;
      pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
        sourceUuid: isTopLevelCompanion ? null : stableUuid(sessionId, record.__line, 'codex-compact'),
        kind: isTopLevelCompanion ? undefined : 'compact',
      });
      continue;
    }

    pushCodexVisibleWrapper(wrappers, record, currentTurnIndex);
  }

  if (pending.length > 0) {
    flushPending(currentTurnIndex);
  }

  return wrappers;
}

function codexRolloutTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

function codexDateParts(date = new Date()) {
  return {
    yyyy: String(date.getUTCFullYear()),
    mm: String(date.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(date.getUTCDate()).padStart(2, '0'),
  };
}

async function writeCodexEditedFork(records, sourceSessionId, cwd, outputRecords) {
  const now = new Date();
  const nowIso = now.toISOString();
  const newSessionId = crypto.randomUUID();
  const { yyyy, mm, dd } = codexDateParts(now);
  const dir = path.join(CODEX_SESSIONS_DIR, yyyy, mm, dd);
  await fs.promises.mkdir(dir, { recursive: true });

  const metaIdx = outputRecords.findIndex((record) => record?.type === 'session_meta');
  if (metaIdx >= 0) {
    const meta = outputRecords[metaIdx];
    meta.timestamp = nowIso;
    meta.payload = { ...(meta.payload || {}) };
    meta.payload.id = newSessionId;
    meta.payload.timestamp = nowIso;
    meta.payload.cwd = cwd || meta.payload.cwd || getSessionMeta(records).cwd || '';
    meta.payload.forked_from_id = sourceSessionId;
    if (!meta.payload.source) meta.payload.source = 'cli';
    if (!meta.payload.thread_source) meta.payload.thread_source = 'user';
  } else {
    outputRecords.unshift({
      timestamp: nowIso,
      type: 'session_meta',
      payload: {
        id: newSessionId,
        timestamp: nowIso,
        cwd: cwd || '',
        originator: 'noted-terminal',
        source: 'cli',
        thread_source: 'user',
        forked_from_id: sourceSessionId,
      },
    });
  }

  let filePath = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = attempt === 0 ? '' : '-' + attempt;
    filePath = path.join(dir, `rollout-${codexRolloutTimestamp(now)}-${newSessionId}${suffix}.jsonl`);
    try {
      await fs.promises.writeFile(filePath, outputRecords.map((record) => JSON.stringify(record)).join('\n') + '\n', {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { newSessionId, filePath };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Could not allocate Codex edited fork path');
}

function createCodexReplacementRecords(compactText, timestamp = new Date().toISOString()) {
  const text = String(compactText || '').trim();
  return [
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: text,
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
  ];
}

async function editCodexRange({ sessionId, cwd, startUuid, endUuid, compactText }) {
  const replacementText = String(compactText || '').trim();
  if (!sessionId) return { success: false, error: 'sessionId required' };
  if (!startUuid || !endUuid) return { success: false, error: 'startUuid/endUuid required' };
  if (!replacementText) return { success: false, error: 'Replacement text required' };

  const loaded = await loadSessionRecords(sessionId, cwd);
  if (!loaded.success) return loaded;

  const timeline = buildCodexTimeline(loaded.records, sessionId);
  const startIndex = timeline.findIndex((entry) => entry.uuid === startUuid);
  const endIndex = timeline.findIndex((entry) => entry.uuid === endUuid);
  if (startIndex < 0 || endIndex < 0) {
    return { success: false, error: 'Timeline range not found' };
  }

  const minIndex = Math.min(startIndex, endIndex);
  const maxIndex = Math.max(startIndex, endIndex);
  const selected = timeline.slice(minIndex, maxIndex + 1);

  const selectedTurns = new Set();
  const selectedCompacts = new Set();
  for (const entry of selected) {
    if (entry.type === 'compact') selectedCompacts.add(entry.uuid);
    else if (typeof entry.turnIndex === 'number') selectedTurns.add(entry.turnIndex);
  }
  if (selectedTurns.size === 0 && selectedCompacts.size === 0) {
    return { success: false, error: 'Selected range has no editable Codex turns' };
  }

  const wrappers = buildCodexVisibleRecordWrappers(loaded.records, sessionId);
  const selectedCompactLines = new Set(
    wrappers
      .filter((wrapper) => wrapper.sourceUuid && selectedCompacts.has(wrapper.sourceUuid))
      .map((wrapper) => Number(wrapper.line))
      .filter((line) => Number.isFinite(line))
  );
  const isSelectedCompactCompanion = (wrapper) => {
    if (!isCodexCompactRecord(wrapper.record)) return false;
    const line = Number(wrapper.line);
    if (!Number.isFinite(line)) return false;
    for (const compactLine of selectedCompactLines) {
      if (line > compactLine && line <= compactLine + 3) return true;
    }
    return false;
  };
  const shouldRemoveWrapper = (wrapper) => {
    if (typeof wrapper.turnIndex === 'number' && selectedTurns.has(wrapper.turnIndex)) return true;
    if (wrapper.sourceUuid && selectedCompacts.has(wrapper.sourceUuid)) return true;
    return isSelectedCompactCompanion(wrapper);
  };
  const firstRemovalIndex = wrappers.findIndex(shouldRemoveWrapper);
  if (firstRemovalIndex < 0) {
    return { success: false, error: 'Selected Codex turns were not found in visible rollout records' };
  }
  let replacementTimestamp = new Date().toISOString();
  if (firstRemovalIndex >= 0) {
    for (let i = firstRemovalIndex + 1; i < wrappers.length; i++) {
      const wrapper = wrappers[i];
      if (shouldRemoveWrapper(wrapper)) continue;
      const nextMs = Date.parse(wrapper.record?.timestamp || '');
      if (Number.isFinite(nextMs)) {
        replacementTimestamp = new Date(nextMs - 1).toISOString();
        break;
      }
    }
  }
  const replacementRecords = createCodexReplacementRecords(replacementText, replacementTimestamp);
  const outputRecords = [];
  let inserted = false;
  let removedRecords = 0;
  let removedUsers = 0;

  for (const wrapper of wrappers) {
    const shouldRemove = shouldRemoveWrapper(wrapper);
    if (shouldRemove) {
      if (!inserted) {
        for (const replacement of replacementRecords) outputRecords.push(replacement);
        inserted = true;
      }
      removedRecords += 1;
      const payload = wrapper.record?.payload || {};
      if (wrapper.record?.type === 'event_msg' && payload.type === 'user_message') removedUsers += 1;
      continue;
    }
    outputRecords.push(cloneCodexRecordForWrite(wrapper.record));
  }

  if (!inserted) {
    for (const replacement of replacementRecords) outputRecords.push(replacement);
  }

  const replacementEventRecord = replacementRecords.find((record) => record.type === 'event_msg' && record.payload?.type === 'user_message');
  const result = await writeCodexEditedFork(loaded.records, sessionId, cwd, outputRecords);
  const finalLine = outputRecords.findIndex((record) => record === replacementEventRecord);
  const replacementUuid = finalLine >= 0 ? stableUuid(result.newSessionId, finalLine, 'codex-user') : null;

  return {
    success: true,
    newSessionId: result.newSessionId,
    filePath: result.filePath,
    sourceFilePath: loaded.filePath,
    replacementUuid,
    compactUuid: replacementUuid,
    removedCount: removedRecords,
    removedUsers,
    selectedCount: selected.length,
    selectedTurns: Array.from(selectedTurns),
    selectedCompacts: Array.from(selectedCompacts),
  };
}

function codexCopyOptions(params = {}) {
  const includeTools = params.includeTools ?? false;
  return {
    includeEditing: params.includeEditing ?? false,
    includeReading: params.includeReading ?? false,
    fromStart: params.fromStart ?? true,
    includeSubagentResult: params.includeSubagentResult ?? false,
    includeSubagentHistory: params.includeSubagentHistory ?? false,
    includeUser: params.includeUser ?? true,
    includeClaude: params.includeClaude ?? true,
    includeText: params.includeText ?? true,
    includeThinking: params.includeThinking ?? true,
    includeBash: params.includeBash ?? false,
    includeTools,
    includeWebSearch: params.includeWebSearch ?? false,
    includeToolSearch: params.includeToolSearch ?? false,
    includeOtherTools: params.includeOtherTools ?? includeTools,
  };
}

function buildCodexCleanEntries(records, sessionId, opts = codexCopyOptions(), options = {}) {
  const entries = [];
  const pendingCalls = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';
  let lastTopLevelCompactLine = -Infinity;
  const expandedCompactUuids = options.expandedCompactUuids instanceof Set
    ? options.expandedCompactUuids
    : new Set();

  const push = (entry) => entries.push({ ...entry, turnIndex: currentTurnIndex });
  const compactText = (payload, sourceUuid) => (
    expandedCompactUuids.has(sourceUuid)
      ? compactEventContent(payload)
      : compactEventTitle(payload)
  );

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      // For clean export, a Codex compacted record is a snapshot of model
      // context, not a new user-visible turn. Expanding replacement_history
      // recursively re-exports old/rolled-back prompts on every compaction.
      const sourceUuid = stableUuid(sessionId, record.__line, 'codex-compact');
      push({
        kind: 'compact',
        text: compactText(payload, sourceUuid),
        sourceUuid,
      });
      lastTopLevelCompactLine = record.__line;
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        currentTurnIndex += 1;
        if (opts.includeUser) {
          const images = [
            ...(Array.isArray(payload.local_images) ? payload.local_images : []),
            ...(Array.isArray(payload.images) ? payload.images : []),
          ];
          const imageLines = images.map((img) => `[image: ${typeof img === 'string' ? img : 'attached image'}]`);
          push({
            kind: 'user',
            text: [payload.message || extractTextContent(payload.content), ...imageLines].filter(Boolean).join('\n'),
            sourceUuid: stableUuid(sessionId, record.__line, 'codex-user'),
          });
        }
      } else if (payload.type === 'thread_rolled_back') {
        removeLastCodexTurns(entries, Number(payload.num_turns || payload.turns || 1));
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
      } else if (isCompactPayload(payload)) {
        if (record.__line > lastTopLevelCompactLine + 3) {
          const sourceUuid = stableUuid(sessionId, record.__line, 'codex-compact');
          push({
            kind: 'compact',
            text: compactText(payload, sourceUuid),
            sourceUuid,
          });
        }
      }
      continue;
    }

    if (record.type !== 'response_item') continue;

    if (payload.type === 'reasoning') {
      const text = extractReasoning(payload.summary || payload.content);
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      continue;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      if (!opts.includeClaude) {
        pendingThinking = '';
        continue;
      }
      const text = opts.includeText ? extractTextContent(payload.content) : '';
      const thinking = opts.includeThinking && pendingThinking ? `<thinking>\n${pendingThinking}\n</thinking>` : '';
      const content = [thinking, text].filter(Boolean).join('\n\n').trim();
      if (content) push({ kind: 'assistant', text: content });
      pendingThinking = '';
      continue;
    }

    if (payload.type === 'web_search_call') {
      const formatted = formatCodexToolForExport(payload, null, opts);
      if (formatted) push({ kind: 'tool', text: formatted });
      continue;
    }

    if (payload.type === 'tool_search_call') {
      const callId = payload.call_id || stableUuid(sessionId, record.__line, 'codex-tool-search');
      pendingCalls.set(callId, payload);
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id || payload.id || stableUuid(sessionId, record.__line, 'codex-call');
      pendingCalls.set(callId, payload);
      continue;
    }

    if (payload.type === 'tool_search_output') {
      const callId = payload.call_id || payload.id;
      const call = pendingCalls.get(callId) || { type: 'tool_search_call', arguments: {} };
      const formatted = formatCodexToolForExport(call, payload, opts);
      if (formatted) push({ kind: 'tool', text: formatted });
      pendingCalls.delete(callId);
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id || payload.id;
      const call = pendingCalls.get(callId) || { type: payload.type, name: payload.name || 'tool' };
      const formatted = formatCodexToolForExport(call, payload, opts);
      if (formatted) push({ kind: 'tool', text: formatted });
      pendingCalls.delete(callId);
    }
  }

  return entries;
}

function formatCodexCleanExport(entries, sessionId, cwd, meta, title = '# Codex Session Export') {
  const out = [];
  out.push(title);
  out.push(`Session: ${sessionId}`);
  out.push(`CWD: ${cwd || meta.cwd || 'unknown'}`);
  if (meta.forked_from_id) out.push(`Forked from: ${meta.forked_from_id}`);
  out.push('');

  for (const entry of entries) {
    const text = String(entry.text || '').trim();
    if (!text) continue;
    if (entry.kind === 'user') {
      out.push('---', '', '👤 USER:', text, '');
    } else if (entry.kind === 'assistant') {
      out.push('🤖 CODEX:', text, '');
    } else if (entry.kind === 'tool') {
      out.push(text);
    } else if (entry.kind === 'compact') {
      out.push('═══ COMPACTED ═══', text, '');
    }
  }
  return out.join('\n');
}

function buildCodexCleanExport(records, sessionId, cwd, opts) {
  const meta = getSessionMeta(records);
  const entries = buildCodexCleanEntries(records, sessionId, codexCopyOptions(opts));
  return formatCodexCleanExport(entries, sessionId, cwd, meta);
}

function buildCodexRangeExport(records, sessionId, cwd, opts, startUuid, endUuid) {
  if (!startUuid || !endUuid) {
    return { success: false, error: 'startUuid/endUuid required' };
  }

  const timeline = buildCodexTimeline(records, sessionId);
  const startIndex = timeline.findIndex((entry) => entry.uuid === startUuid);
  const endIndex = timeline.findIndex((entry) => entry.uuid === endUuid);
  if (startIndex < 0 || endIndex < 0) {
    return { success: false, error: 'Timeline range not found' };
  }

  const minIndex = Math.min(startIndex, endIndex);
  const maxIndex = Math.max(startIndex, endIndex);
  const selected = timeline.slice(minIndex, maxIndex + 1);
  const selectedTurns = new Set();
  const selectedCompacts = new Set();
  for (const entry of selected) {
    if (entry.type === 'compact') {
      selectedCompacts.add(entry.uuid);
    } else if (typeof entry.turnIndex === 'number') {
      selectedTurns.add(entry.turnIndex);
    }
  }

  // Context-menu "Copy compact" passes start=end for one compact marker.
  // Expand only that case; multi-entry ranges keep compact markers shallow.
  const expandedCompactUuids = selected.length === 1 && selected[0]?.type === 'compact'
    ? new Set([selected[0].uuid])
    : new Set();
  const cleanEntries = buildCodexCleanEntries(records, sessionId, codexCopyOptions(opts), {
    expandedCompactUuids,
  });
  const filtered = cleanEntries.filter((entry) => {
    if (entry.kind === 'compact') return selectedCompacts.has(entry.sourceUuid);
    return typeof entry.turnIndex === 'number' && selectedTurns.has(entry.turnIndex);
  });

  if (filtered.length === 0) {
    return { success: false, error: 'Selected range has no copyable content' };
  }

  const meta = getSessionMeta(records);
  return {
    success: true,
    content: formatCodexCleanExport(filtered, sessionId, cwd, meta, '# Codex Range Export'),
    selectedCount: selected.length,
  };
}

function normalizeCodexReset(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return new Date(Number(trimmed) * 1000).toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function normalizeCodexLimitBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const used = Number(bucket.used_percent ?? bucket.utilization ?? bucket.usedPercent);
  return {
    utilization: Number.isFinite(used) ? used : null,
    resets_at: normalizeCodexReset(bucket.resets_at ?? bucket.resetsAt ?? bucket.reset_at ?? bucket.resetAt),
    window_minutes: Number.isFinite(Number(bucket.window_minutes ?? bucket.windowMinutes))
      ? Number(bucket.window_minutes ?? bucket.windowMinutes)
      : null,
  };
}

function buildCodexUsageFromRateLimits(rateLimits, timestamp = null, filePath = null) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const primary = normalizeCodexLimitBucket(rateLimits.primary);
  const secondary = normalizeCodexLimitBucket(rateLimits.secondary);
  if (!primary && !secondary) return null;
  return {
    primary,
    secondary,
    five_hour: primary,
    seven_day: secondary,
    limit_id: rateLimits.limit_id || null,
    limit_name: rateLimits.limit_name || null,
    plan_type: rateLimits.plan_type || null,
    credits: rateLimits.credits || null,
    individual_limit: rateLimits.individual_limit || null,
    rate_limit_reached_type: rateLimits.rate_limit_reached_type || null,
    timestamp,
    filePath,
  };
}

function latestCodexUsageInRecords(records, filePath = null) {
  let latest = null;
  for (const record of records) {
    const payload = record.payload || {};
    if (record.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const usage = buildCodexUsageFromRateLimits(payload.rate_limits, recordTimestamp(record), filePath);
    if (usage) latest = usage;
  }
  return latest;
}

async function findLatestCodexUsage() {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  const candidates = [];
  for (const filePath of files) {
    try {
      const stat = await fs.promises.stat(filePath);
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, 120)) {
    try {
      const records = await parseJsonlFile(candidate.filePath);
      const usage = latestCodexUsageInRecords(records, candidate.filePath);
      if (usage) return usage;
    } catch {}
  }
  return null;
}

function runSqliteJson(dbPath, sql) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', dbPath, sql], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message;
        reject(new Error(message));
        return;
      }
      resolve(safeJsonParse(stdout || '[]', []));
    });
  });
}

function shortCodexId(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function maskCodexEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const [local, domain] = value.split('@');
  if (!domain) return shortCodexId(value);
  const prefix = local.slice(0, Math.min(2, Math.max(1, local.length)));
  return `${prefix}***@${domain}`;
}

function hashCodexAccountKey(raw) {
  return crypto.createHash('sha256').update(String(raw || 'unknown')).digest('hex').slice(0, 16);
}

function codexAccountIdentityKey(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return identity.accountId || identity.email || null;
}

function codexAccountKeyFromIdentity(identity) {
  const key = codexAccountIdentityKey(identity);
  return key ? hashCodexAccountKey(key) : null;
}

function sqlString(value) {
  return String(value || '').replace(/'/g, "''");
}

function sqlStringList(values) {
  return values.map((value) => `'${sqlString(value)}'`).join(',');
}

function arrayChunks(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function extractCodexThreadId(body) {
  if (!body || typeof body !== 'string') return null;
  return (body.match(/thread_id=([0-9a-f-]+)/) || [])[1]
    || (body.match(/thread\.id=([0-9a-f-]+)/) || [])[1]
    || (body.match(/conversation\.id=([0-9a-f-]+)/) || [])[1]
    || null;
}

function parseCodexRateLimitLog(body) {
  if (!body || typeof body !== 'string' || !body.includes('codex.rate_limits')) return null;
  const plan = (body.match(/"plan_type":"([^"]+)"/) || [])[1] || null;
  const primaryMatch = body.match(/"primary":\{"used_percent":([0-9.]+),"window_minutes":([0-9]+)(?:,"reset_after_seconds":[0-9.]+)?,"reset_at":([0-9]+)\}/);
  const secondaryMatch = body.match(/"secondary":\{"used_percent":([0-9.]+),"window_minutes":([0-9]+)(?:,"reset_after_seconds":[0-9.]+)?,"reset_at":([0-9]+)\}/);
  const primary = primaryMatch ? {
    used_percent: Number(primaryMatch[1]),
    window_minutes: Number(primaryMatch[2]),
    reset_at: Number(primaryMatch[3]),
  } : null;
  const secondary = secondaryMatch ? {
    used_percent: Number(secondaryMatch[1]),
    window_minutes: Number(secondaryMatch[2]),
    reset_at: Number(secondaryMatch[3]),
  } : null;
  if (!primary && !secondary) return null;
  return {
    limit_id: 'codex',
    limit_name: null,
    primary,
    secondary,
    credits: null,
    individual_limit: null,
    plan_type: plan,
    rate_limit_reached_type: null,
  };
}

function parseCodexAccountIdentityLog(body) {
  if (!body || typeof body !== 'string') return { accountId: null, email: null };
  if (!body.includes('terminal.type=')) return { accountId: null, email: null };
  return {
    accountId: (body.match(/user\.account_id="([^"]+)"/) || [])[1] || null,
    email: (body.match(/user\.email="([^"]+)"/) || [])[1] || null,
  };
}

function codexLogTimeMs(row) {
  return (Number(row?.ts) || 0) * 1000 + (Number(row?.ts_nanos) || 0) / 1_000_000;
}

function codexRateResetEpoch(rateLimits, bucketName) {
  const bucket = rateLimits?.[bucketName];
  if (!bucket || typeof bucket !== 'object') return 0;
  const raw = bucket.reset_at ?? bucket.resets_at ?? bucket.resetAt ?? bucket.resetsAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

function compareCodexResetGeneration(next, prev, bucketName) {
  const nextReset = codexRateResetEpoch(next.rateLimits, bucketName);
  const prevReset = codexRateResetEpoch(prev.rateLimits, bucketName);
  const diff = nextReset - prevReset;
  if (Math.abs(diff) <= CODEX_RESET_DRIFT_TOLERANCE_SECONDS) return 0;
  return diff;
}

function compareCodexRateSnapshotFreshness(next, prev) {
  if (!prev) return 1;
  if (!next) return -1;

  const weeklyGeneration = compareCodexResetGeneration(next, prev, 'secondary');
  if (weeklyGeneration !== 0) return weeklyGeneration;

  const fiveHourGeneration = compareCodexResetGeneration(next, prev, 'primary');
  if (fiveHourGeneration !== 0) return fiveHourGeneration;

  const nextTs = Number(next.ts) || 0;
  const prevTs = Number(prev.ts) || 0;
  if (nextTs !== prevTs) return nextTs - prevTs;
  return (Number(next.tsNanos) || 0) - (Number(prev.tsNanos) || 0);
}

function codexUsageTimestampParts(usage) {
  const ms = parseTimestampMs(usage?.timestamp);
  if (!Number.isFinite(ms)) return { ts: 0, tsNanos: 0 };
  return {
    ts: Math.floor(ms / 1000),
    tsNanos: Math.floor((ms % 1000) * 1_000_000),
  };
}

function codexUsageFreshnessCandidate(usage) {
  if (!usage) return null;
  const { ts, tsNanos } = codexUsageTimestampParts(usage);
  return {
    rateLimits: {
      primary: usage.primary || usage.five_hour || null,
      secondary: usage.secondary || usage.seven_day || null,
    },
    ts,
    tsNanos,
  };
}

function compareCodexUsageFreshness(nextUsage, prevUsage) {
  return compareCodexRateSnapshotFreshness(
    codexUsageFreshnessCandidate(nextUsage),
    codexUsageFreshnessCandidate(prevUsage)
  );
}

function readCurrentCodexAuthIdentity() {
  if (!fs.existsSync(CODEX_AUTH_JSON)) return null;
  const raw = safeJsonParse(fs.readFileSync(CODEX_AUTH_JSON, 'utf8'), null);
  const tokens = raw?.tokens || {};
  const accessPayload = decodeBase64UrlJson(String(tokens.access_token || '').split('.')[1]);
  const idPayload = decodeBase64UrlJson(String(tokens.id_token || '').split('.')[1]);
  const authClaims = accessPayload?.['https://api.openai.com/auth']
    || idPayload?.['https://api.openai.com/auth']
    || {};
  const profileClaims = accessPayload?.['https://api.openai.com/profile']
    || idPayload?.['https://api.openai.com/profile']
    || {};
  const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;
  const email = profileClaims.email || idPayload?.email || accessPayload?.email || null;
  if (!accountId && !email) return null;
  return {
    accountId,
    email,
    refreshedAtMs: parseTimestampMs(raw?.last_refresh),
  };
}

function currentCodexAuthIdentityForUsage(usage) {
  const identity = readCurrentCodexAuthIdentity();
  if (!identity) return null;
  const refreshedAtMs = identity.refreshedAtMs;
  const usageMs = parseTimestampMs(usage?.timestamp);
  // Auth.json is global state. Only use it for active rollouts newer than the
  // current auth snapshot; older resurrected sessions must rely on log identity.
  if (Number.isFinite(refreshedAtMs) && Number.isFinite(usageMs) && usageMs + 30 * 1000 < refreshedAtMs) {
    return null;
  }
  return identity;
}

function closestCodexIdentity(rate, identities) {
  if (!rate || !Array.isArray(identities) || identities.length === 0) return null;
  let closest = null;
  for (const identity of identities) {
    const distance = Math.abs(identity.timeMs - rate.timeMs);
    if (!closest || distance < closest.distance) {
      closest = { identity, distance };
    }
  }
  return closest?.identity || null;
}

function codexAccountLabel({ email, accountId }, index) {
  const maskedEmail = maskCodexEmail(email);
  if (maskedEmail) return maskedEmail;
  const short = shortCodexId(accountId);
  return short ? `Account ${short}` : `Account ${index + 1}`;
}

function buildCodexUsageAccount(raw, index) {
  const identity = codexAccountIdentityKey(raw) || `unknown-${index}`;
  const accountKey = hashCodexAccountKey(identity);
  const label = codexAccountLabel(raw, index);
  const usage = buildCodexUsageFromRateLimits(raw.rateLimits, raw.timestamp, raw.filePath);
  if (!usage) return null;
  return {
    accountKey,
    label,
    accountHint: raw.email ? maskCodexEmail(raw.email) : shortCodexId(raw.accountId),
    accountIdHint: shortCodexId(raw.accountId),
    plan_type: usage.plan_type,
    timestamp: usage.timestamp,
    sourceThreadId: raw.threadId || null,
    source: 'codex-log',
    usage,
  };
}

function buildCodexActiveUsageAccount(identity, usage, threadId) {
  if (!usage) return null;
  const accountKey = codexAccountKeyFromIdentity(identity);
  if (!accountKey) return null;
  return {
    accountKey,
    label: codexAccountLabel(identity, 0),
    accountHint: identity.email ? maskCodexEmail(identity.email) : shortCodexId(identity.accountId),
    accountIdHint: shortCodexId(identity.accountId),
    plan_type: usage.plan_type,
    timestamp: usage.timestamp,
    sourceThreadId: threadId || null,
    source: 'active-session-rollout',
    usage,
  };
}

function mergeCodexActiveUsageIntoAccounts(accounts, selectedAccountKey, activeUsage, sessionId) {
  if (!Array.isArray(accounts) || !selectedAccountKey || !activeUsage) return accounts;
  let changed = false;
  const merged = accounts.map((account) => {
    if (account?.accountKey !== selectedAccountKey) return account;
    changed = true;
    return {
      ...account,
      usage: activeUsage,
      timestamp: activeUsage.timestamp,
      plan_type: activeUsage.plan_type || account.plan_type,
      source: 'active-session-rollout',
      sourceThreadId: sessionId || account.sourceThreadId || null,
    };
  });
  return changed ? merged : accounts;
}

function codexUsagePercentSummary(usage) {
  const weekly = usage?.seven_day || usage?.secondary || null;
  const fiveHour = usage?.five_hour || usage?.primary || null;
  return 'weekly=' + (weekly?.utilization ?? 'null') +
    ' fiveHour=' + (fiveHour?.utilization ?? 'null');
}

function codexAccountTimestampMs(account) {
  const ms = parseTimestampMs(account?.timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function pruneCodexActiveUsageOverrides(now = Date.now()) {
  for (const [accountKey, entry] of codexActiveUsageOverrides) {
    if (!entry?.account?.usage || now - (entry.updatedAt || 0) > CODEX_ACTIVE_USAGE_OVERRIDE_TTL_MS) {
      codexActiveUsageOverrides.delete(accountKey);
    }
  }
}

function rememberCodexActiveUsageOverride(identity, usage, sessionId) {
  const account = buildCodexActiveUsageAccount(identity, usage, sessionId);
  if (!account) return null;
  const now = Date.now();
  pruneCodexActiveUsageOverrides(now);

  const existing = codexActiveUsageOverrides.get(account.accountKey);
  if (existing?.account?.usage && compareCodexUsageFreshness(existing.account.usage, account.usage) >= 0) {
    return existing.account;
  }

  codexActiveUsageOverrides.set(account.accountKey, { account, updatedAt: now });
  console.log('[CodexData] usage active override remember account=' + account.label +
    ' session=' + (shortCodexId(sessionId) || 'none') +
    ' ' + codexUsagePercentSummary(usage));
  return account;
}

function mergeCodexActiveOverridesIntoAccounts(accounts, { includeMissing = true, reason = 'merge' } = {}) {
  pruneCodexActiveUsageOverrides();
  if (codexActiveUsageOverrides.size === 0) return Array.isArray(accounts) ? accounts : [];

  const next = Array.isArray(accounts) ? [...accounts] : [];
  let changed = false;
  for (const entry of codexActiveUsageOverrides.values()) {
    const activeAccount = entry?.account;
    if (!activeAccount?.accountKey || !activeAccount?.usage) continue;

    const idx = next.findIndex((account) => account?.accountKey === activeAccount.accountKey);
    if (idx >= 0) {
      const prev = next[idx];
      if (compareCodexUsageFreshness(activeAccount.usage, prev?.usage) > 0) {
        next[idx] = {
          ...prev,
          usage: activeAccount.usage,
          timestamp: activeAccount.timestamp,
          plan_type: activeAccount.plan_type || prev.plan_type,
          source: 'active-session-rollout',
          sourceThreadId: activeAccount.sourceThreadId || prev.sourceThreadId || null,
        };
        changed = true;
        console.log('[CodexData] usage active override apply reason=' + reason +
          ' account=' + (prev.label || activeAccount.label || 'unknown') +
          ' session=' + (shortCodexId(activeAccount.sourceThreadId) || 'none') +
          ' ' + codexUsagePercentSummary(activeAccount.usage));
      }
      continue;
    }

    if (includeMissing) {
      next.push(activeAccount);
      changed = true;
      console.log('[CodexData] usage active override add reason=' + reason +
        ' account=' + (activeAccount.label || 'unknown') +
        ' session=' + (shortCodexId(activeAccount.sourceThreadId) || 'none') +
        ' ' + codexUsagePercentSummary(activeAccount.usage));
    }
  }

  if (!changed) return Array.isArray(accounts) ? accounts : [];
  return next.sort((a, b) => codexAccountTimestampMs(b) - codexAccountTimestampMs(a));
}

async function scanLatestCodexUsageAccounts() {
  if (!fs.existsSync(CODEX_LOGS_DB)) {
    return [];
  }

  // Extract only the useful slices from the large Codex log rows. Do not mix
  // identity rows and rate rows under one global LIMIT: a busy account can
  // otherwise push a quieter account out of the scan window completely.
  const rateSql = `
    SELECT
      ts,
      ts_nanos,
      thread_id,
      substr(feedback_log_body, 1, 260) || ' ' ||
      substr(feedback_log_body, instr(feedback_log_body, 'websocket event: {"type":"codex.rate_limits"'), 5000) AS body
    FROM logs
    WHERE ts > strftime('%s','now','-${CODEX_USAGE_SCAN_DAYS} days')
      AND target = 'codex_api::endpoint::responses_websocket'
      AND feedback_log_body LIKE '%websocket event: {"type":"codex.rate_limits"%'
    ORDER BY ts DESC, ts_nanos DESC
    LIMIT ${CODEX_USAGE_RATE_ROWS_LIMIT};
  `;

  const rateRows = await runSqliteJson(CODEX_LOGS_DB, rateSql);

  const byThread = new Map();
  for (const row of Array.isArray(rateRows) ? rateRows : []) {
    const body = row?.body || '';
    const threadId = row?.thread_id || extractCodexThreadId(body);
    if (!threadId) continue;
    const ctx = byThread.get(threadId) || { threadId, identities: [], rates: [] };
    const rateLimits = parseCodexRateLimitLog(body);
    if (rateLimits) {
      ctx.rates.push({
        ts: Number(row.ts) || 0,
        tsNanos: Number(row.ts_nanos) || 0,
        timeMs: codexLogTimeMs(row),
        rateLimits,
        timestamp: row.ts ? new Date(Number(row.ts) * 1000).toISOString() : null,
      });
    }
    byThread.set(threadId, ctx);
  }

  const threadIds = [...byThread.keys()];
  for (const chunk of arrayChunks(threadIds, 400)) {
    if (chunk.length === 0) continue;
    const identitySql = `
      SELECT
        ts,
        ts_nanos,
        thread_id,
        CASE
          WHEN instr(feedback_log_body, 'user.account_id=') > 0
            THEN substr(feedback_log_body, instr(feedback_log_body, 'user.account_id='), 900)
          WHEN instr(feedback_log_body, 'user.email=') > 0
            THEN substr(feedback_log_body, instr(feedback_log_body, 'user.email='), 900)
          ELSE ''
        END AS body
      FROM logs
      WHERE ts > strftime('%s','now','-${CODEX_USAGE_SCAN_DAYS} days')
        AND target = 'codex_otel.log_only'
        AND thread_id IN (${sqlStringList(chunk)})
        AND (
          feedback_log_body LIKE '%user.account_id=%'
          OR feedback_log_body LIKE '%user.email=%'
        );
    `;
    const identityRows = await runSqliteJson(CODEX_LOGS_DB, identitySql);
    for (const row of Array.isArray(identityRows) ? identityRows : []) {
      const body = row?.body || '';
      const threadId = row?.thread_id || extractCodexThreadId(body);
      if (!threadId) continue;
      const ctx = byThread.get(threadId);
      if (!ctx) continue;
      const { accountId, email } = parseCodexAccountIdentityLog(body);
      if (!accountId && !email) continue;
      ctx.identities.push({
        ts: Number(row.ts) || 0,
        tsNanos: Number(row.ts_nanos) || 0,
        timeMs: codexLogTimeMs(row),
        accountId,
        email,
      });
    }
  }

  const latestByIdentity = new Map();
  for (const ctx of byThread.values()) {
    if (!ctx.rates?.length) continue;
    for (const rate of ctx.rates) {
      const accountIdentity = closestCodexIdentity(rate, ctx.identities);
      const accountId = accountIdentity?.accountId || null;
      const email = accountIdentity?.email || null;
      const identity = accountId || email || `thread:${ctx.threadId}`;
      const prev = latestByIdentity.get(identity);
      const candidate = {
        accountId,
        email,
        rateLimits: rate.rateLimits,
        timestamp: rate.timestamp,
        threadId: ctx.threadId,
        ts: rate.ts,
        tsNanos: rate.tsNanos,
      };
      if (compareCodexRateSnapshotFreshness(candidate, prev) > 0) {
        latestByIdentity.set(identity, candidate);
      }
    }
  }

  const accounts = [...latestByIdentity.values()]
    .sort((a, b) => (b.ts - a.ts) || (b.tsNanos - a.tsNanos))
    .map(buildCodexUsageAccount)
    .filter(Boolean);

  console.log('[CodexData] usage accounts scanned count=' + accounts.length +
    ' labels=' + accounts.map((a) => {
      const weekly = a.usage?.seven_day || a.usage?.secondary || null;
      const fiveHour = a.usage?.five_hour || a.usage?.primary || null;
      return a.label + ':' + (a.plan_type || 'unknown') +
        ':w=' + (weekly?.utilization ?? 'null') +
        ':5h=' + (fiveHour?.utilization ?? 'null') +
        ':wReset=' + (weekly?.resets_at || 'null') +
        ':5hReset=' + (fiveHour?.resets_at || 'null') +
        ':sample=' + (a.timestamp || 'null') +
        ':thread=' + (shortCodexId(a.sourceThreadId) || 'none');
    }).join(','));
  return accounts;
}

async function findCodexAccountIdentityForThread(threadId) {
  if (!threadId || !fs.existsSync(CODEX_LOGS_DB)) return null;
  const sql = `
    SELECT
      ts,
      ts_nanos,
      thread_id,
      CASE
        WHEN instr(feedback_log_body, 'user.account_id=') > 0
          THEN substr(feedback_log_body, instr(feedback_log_body, 'user.account_id='), 900)
        WHEN instr(feedback_log_body, 'user.email=') > 0
          THEN substr(feedback_log_body, instr(feedback_log_body, 'user.email='), 900)
        ELSE ''
      END AS body
    FROM logs
    WHERE ts > strftime('%s','now','-10 days')
      AND target = 'codex_otel.log_only'
      AND thread_id = '${sqlString(threadId)}'
      AND (
        feedback_log_body LIKE '%user.account_id=%'
        OR feedback_log_body LIKE '%user.email=%'
      )
    ORDER BY ts DESC, ts_nanos DESC
    LIMIT 20;
  `;

  const rows = await runSqliteJson(CODEX_LOGS_DB, sql);
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = parseCodexAccountIdentityLog(row?.body || '');
    if (identity.accountId || identity.email) return identity;
  }
  return null;
}

function resolveAfterBudget(promise, budgetMs, timeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, budgetMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timeoutValue);
      }
    );
  });
}

function startCodexUsageAccountsRefresh({ force = false, reason = 'refresh' } = {}) {
  if (usageAccountsRefreshInFlight) {
    console.log('[CodexData] usage accounts refresh join reason=' + reason);
    return usageAccountsRefreshInFlight;
  }

  const startedAt = Date.now();
  usageAccountsLastAttemptAt = startedAt;
  console.log('[CodexData] usage accounts refresh start reason=' + reason +
    ' force=' + (force ? '1' : '0') +
    ' cache=' + (usageAccountsCache ? 'hit' : 'empty'));

  usageAccountsRefreshInFlight = scanLatestCodexUsageAccounts()
    .then((accounts) => {
      const mergedAccounts = mergeCodexActiveOverridesIntoAccounts(accounts, { reason });
      usageAccountsCache = { ts: Date.now(), accounts: mergedAccounts };
      usageAccountsLastError = null;
      console.log('[CodexData] usage accounts refresh done count=' + mergedAccounts.length +
        ' durMs=' + (Date.now() - startedAt));
      return mergedAccounts;
    })
    .catch((error) => {
      usageAccountsLastError = error?.message || String(error);
      if (!usageAccountsCache) {
        usageAccountsCache = { ts: Date.now(), accounts: [] };
      }
      console.warn('[CodexData] usage accounts refresh failed durMs=' + (Date.now() - startedAt) +
        ' error=' + usageAccountsLastError);
      return usageAccountsCache.accounts;
    })
    .finally(() => {
      usageAccountsRefreshInFlight = null;
    });

  return usageAccountsRefreshInFlight;
}

async function getCodexUsageAccountsFast({ force = false, reason = 'ipc' } = {}) {
  const now = Date.now();
  const cache = usageAccountsCache;
  const cacheAgeMs = cache ? now - cache.ts : null;

  if (!force && cache && cacheAgeMs < USAGE_ACCOUNTS_CACHE_TTL_MS) {
    const accounts = mergeCodexActiveOverridesIntoAccounts(cache.accounts, { reason: 'cache-hit' });
    if (accounts !== cache.accounts) usageAccountsCache = { ...cache, accounts };
    return {
      accounts,
      stale: false,
      refreshing: !!usageAccountsRefreshInFlight,
      cacheAgeMs,
      lastAttemptAt: usageAccountsLastAttemptAt,
      error: usageAccountsLastError,
    };
  }

  const refreshPromise = startCodexUsageAccountsRefresh({ force, reason });
  if (cache) {
    const accounts = mergeCodexActiveOverridesIntoAccounts(cache.accounts, { reason: force ? 'force-stale-cache' : 'stale-cache' });
    if (accounts !== cache.accounts) usageAccountsCache = { ...cache, accounts };
    return {
      accounts,
      stale: true,
      refreshing: true,
      cacheAgeMs,
      lastAttemptAt: usageAccountsLastAttemptAt,
      error: usageAccountsLastError,
    };
  }

  const quickAccounts = await resolveAfterBudget(
    refreshPromise,
    USAGE_ACCOUNTS_FOREGROUND_BUDGET_MS,
    null
  );
  if (quickAccounts) {
    return {
      accounts: quickAccounts,
      stale: false,
      refreshing: false,
      cacheAgeMs: 0,
      lastAttemptAt: usageAccountsLastAttemptAt,
      error: usageAccountsLastError,
    };
  }

  return {
    accounts: [],
    stale: false,
    refreshing: true,
    cacheAgeMs: null,
    lastAttemptAt: usageAccountsLastAttemptAt,
    error: usageAccountsLastError,
  };
}

async function findLatestCodexUsageAccounts({ force = false } = {}) {
  const result = await getCodexUsageAccountsFast({ force, reason: 'direct' });
  if (result.refreshing && usageAccountsRefreshInFlight) {
    return usageAccountsRefreshInFlight;
  }
  return result.accounts;
}

function normalizeCodexModel(raw) {
  const id = raw.slug || raw.id || raw.name;
  if (!id) return null;
  const levels = raw.supported_reasoning_efforts || raw.supported_reasoning_levels || raw.reasoning_efforts || raw.reasoning_levels || ['low', 'medium', 'high', 'xhigh'];
  const efforts = (Array.isArray(levels) ? levels : [])
    .map((level) => typeof level === 'string' ? level : level?.effort || level?.name || level?.id)
    .filter(Boolean);
  return {
    id,
    label: raw.display_name || raw.name || id,
    defaultEffort: raw.default_reasoning_effort || raw.default_reasoning_level || 'medium',
    efforts: efforts.length > 0 ? efforts : ['low', 'medium', 'high', 'xhigh'],
  };
}

function parseCodexModelsCatalog(stdout) {
  const parsed = safeJsonParse(stdout, []);
  const rawModels = Array.isArray(parsed) ? parsed : (parsed.models || parsed.available_models || []);
  return rawModels
    .filter((m) => {
      const visibility = m.visibility || m.display || m.state;
      return !visibility || visibility === 'list' || visibility === 'visible';
    })
    .map(normalizeCodexModel)
    .filter(Boolean);
}

function listCodexModels() {
  if (modelCache && Date.now() - modelCache.ts < MODEL_CACHE_TTL_MS) return Promise.resolve(modelCache.value);
  return new Promise((resolve) => {
    const fallback = [
      { id: 'gpt-5.5', label: 'GPT-5.5', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ];
    const finish = (models) => {
      const value = models.length > 0 ? models : [
        { id: 'gpt-5.5', label: 'GPT-5.5', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
      ];
      modelCache = { ts: Date.now(), value };
      resolve(value);
    };

    // Live catalog matches the current account/config and the interactive
    // `/model` picker. Bundled catalog contains hidden/internal/upgrade-only
    // rows that the TUI will not accept.
    execFile('codex', ['debug', 'models'], { maxBuffer: 20 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      if (!err) {
        const models = parseCodexModelsCatalog(stdout);
        if (models.length > 0) {
          finish(models);
          return;
        }
      }

      execFile('codex', ['debug', 'models', '--bundled'], { maxBuffer: 20 * 1024 * 1024, timeout: 5_000 }, (bundledErr, bundledStdout) => {
        if (bundledErr) {
          finish(fallback);
          return;
        }
        finish(parseCodexModelsCatalog(bundledStdout));
      });
    });
  });
}

async function loadSessionRecords(sessionId, cwd) {
  const found = await findCodexSessionFile(sessionId, cwd);
  if (!found) return { success: false, error: 'Codex session file not found' };
  const records = await parseJsonlFile(found.filePath);
  return { success: true, records, filePath: found.filePath };
}

function register() {
  ipcMain.handle('codex:get-timeline', async (_event, { sessionId, cwd }) => {
    try {
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      return {
        success: true,
        entries: buildCodexTimeline(loaded.records, sessionId),
        sessionMeta: getTimelineSessionMeta(loaded.records),
        sessionBoundaries: [],
        claudeMemoryBoundaryUuid: null,
        filePath: loaded.filePath,
      };
    } catch (error) {
      console.error('[CodexData] get-timeline error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:get-full-history', async (_event, { sessionId, cwd }) => {
    try {
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      return {
        success: true,
        entries: buildCodexFullHistory(loaded.records, sessionId),
        claudeMemoryBoundaryUuid: null,
        filePath: loaded.filePath,
      };
    } catch (error) {
      console.error('[CodexData] get-full-history error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:export-clean-session', async (_event, params = {}) => {
    try {
      const { sessionId, cwd } = params;
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      const content = buildCodexCleanExport(loaded.records, sessionId, cwd, codexCopyOptions(params));
      return { success: true, content, filePath: loaded.filePath };
    } catch (error) {
      console.error('[CodexData] export-clean-session error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:copy-range', async (_event, params = {}) => {
    try {
      const { sessionId, cwd, startUuid, endUuid } = params;
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      const result = buildCodexRangeExport(
        loaded.records,
        sessionId,
        cwd,
        codexCopyOptions(params),
        startUuid,
        endUuid
      );
      return result.success ? { ...result, filePath: loaded.filePath } : result;
    } catch (error) {
      console.error('[CodexData] copy-range error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:edit-range', async (_event, params = {}) => {
    try {
      return await editCodexRange(params);
    } catch (error) {
      console.error('[CodexData] edit-range error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:list-models', async () => {
    try {
      const models = await listCodexModels();
      return { success: true, models };
    } catch (error) {
      return { success: false, error: error.message, models: [] };
    }
  });

  ipcMain.handle('codex:get-usage', async (_event, opts = {}) => {
    try {
      const accountResult = await getCodexUsageAccountsFast({
        force: !!opts?.force,
        reason: opts?.force ? 'ipc-force' : 'ipc',
      });
      let accountUsages = accountResult.accounts || [];

      let activeUsage = null;
      let activeIdentity = null;
      let activeAccountKey = null;
      if (opts?.sessionId) {
        try {
          const [identity, loaded] = await Promise.all([
            findCodexAccountIdentityForThread(opts.sessionId).catch(() => null),
            loadSessionRecords(opts.sessionId, opts.cwd).catch((error) => ({ success: false, error: error?.message || String(error) })),
          ]);
          activeIdentity = identity;
          if (loaded?.success) {
            activeUsage = latestCodexUsageInRecords(loaded.records, loaded.filePath);
          }
          if (!activeIdentity && activeUsage) {
            activeIdentity = currentCodexAuthIdentityForUsage(activeUsage);
            if (activeIdentity) {
              console.log('[CodexData] usage active identity from auth account=' +
                (maskCodexEmail(activeIdentity.email) || shortCodexId(activeIdentity.accountId) || 'unknown') +
                ' session=' + (shortCodexId(opts.sessionId) || 'none') +
                ' sample=' + (activeUsage.timestamp || 'null'));
            }
          }
          activeAccountKey = codexAccountKeyFromIdentity(activeIdentity);
        } catch {}
      }
      if (activeUsage && activeIdentity) {
        rememberCodexActiveUsageOverride(activeIdentity, activeUsage, opts.sessionId);
        accountUsages = mergeCodexActiveOverridesIntoAccounts(accountUsages, { reason: 'ipc-active' });
        if (usageAccountsCache) {
          const cachedAccounts = mergeCodexActiveOverridesIntoAccounts(usageAccountsCache.accounts, { reason: 'ipc-cache' });
          if (cachedAccounts !== usageAccountsCache.accounts) {
            usageAccountsCache = { ...usageAccountsCache, accounts: cachedAccounts };
          }
        }
      }

      let selectedAccount = opts?.accountKey
        ? accountUsages.find((account) => account.accountKey === opts.accountKey)
        : null;
      if (!selectedAccount && activeAccountKey) {
        selectedAccount = accountUsages.find((account) => account.accountKey === activeAccountKey) || null;
      }
      if (!selectedAccount) selectedAccount = accountUsages[0] || null;

      let usage = selectedAccount?.usage || null;
      let selectedAccountKey = selectedAccount?.accountKey || null;
      let source = selectedAccount?.source === 'active-session-rollout'
        ? 'active-session-rollout'
        : (usage ? 'account-log' : 'none');

      const activeMatchesSelected = !!activeUsage && (
        !selectedAccountKey ||
        (activeAccountKey && activeAccountKey === selectedAccountKey) ||
        (!!opts?.sessionId && selectedAccount?.sourceThreadId === opts.sessionId)
      );
      if (activeMatchesSelected && (!usage || compareCodexUsageFreshness(activeUsage, usage) > 0)) {
        if (!selectedAccountKey && activeAccountKey) {
          const activeAccount = buildCodexActiveUsageAccount(activeIdentity, activeUsage, opts.sessionId);
          if (activeAccount) {
            accountUsages = [activeAccount];
            selectedAccount = activeAccount;
            selectedAccountKey = activeAccount.accountKey;
          }
        } else if (selectedAccountKey) {
          accountUsages = mergeCodexActiveUsageIntoAccounts(accountUsages, selectedAccountKey, activeUsage, opts.sessionId);
          selectedAccount = accountUsages.find((account) => account.accountKey === selectedAccountKey) || selectedAccount;
        }
        usage = activeUsage;
        source = 'active-session-rollout';
      }
      if (!usage && !accountResult.refreshing) {
        usage = await findLatestCodexUsage();
        source = usage ? 'latest-rollout' : source;
      }
      if (!usage && accountResult.refreshing) {
        source = 'account-refreshing';
      }

      const weekly = usage?.seven_day?.utilization ?? usage?.secondary?.utilization ?? null;
      const fiveHour = usage?.five_hour?.utilization ?? usage?.primary?.utilization ?? null;
      const accountLabel = selectedAccount?.label || accountUsages[0]?.label || 'none';
      console.log('[CodexData] get-usage source=' + source +
        ' accounts=' + accountUsages.length +
        ' selected=' + accountLabel +
        ' weekly=' + (weekly ?? 'null') +
        ' fiveHour=' + (fiveHour ?? 'null') +
        ' refreshing=' + (accountResult.refreshing ? '1' : '0') +
        ' stale=' + (accountResult.stale ? '1' : '0') +
        ' cacheAgeMs=' + (accountResult.cacheAgeMs ?? 'none') +
        ' session=' + (opts?.sessionId ? String(opts.sessionId).slice(0, 8) : 'none') +
        ' error=' + (accountResult.error ? compactPreview(accountResult.error, 120) : 'none'));

      return {
        success: true,
        data: usage,
        accounts: accountUsages,
        selectedAccountKey,
        source,
        refreshing: accountResult.refreshing,
        stale: accountResult.stale,
        cacheAgeMs: accountResult.cacheAgeMs,
        lastAttemptAt: accountResult.lastAttemptAt,
        error: !usage && accountResult.error ? accountResult.error : null,
      };
    } catch (error) {
      console.error('[CodexData] get-usage error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  register,
  findCodexSessionFile,
  findLatestCodexSession,
  buildCodexTimeline,
  buildCodexFullHistory,
  buildCodexCleanExport,
  buildCodexRangeExport,
  editCodexRange,
  getTimelineSessionMeta,
  listCodexModels,
  invalidateCodexJsonlCache,
  _api: {
    listCodexModels,
    findCodexSessionFile,
    findLatestCodexSession,
    parseJsonlFile,
    invalidateJsonlCache: invalidateCodexJsonlCache,
    buildCodexCleanEntries,
    buildCodexCleanExport,
    buildCodexRangeExport,
    buildCodexVisibleRecordWrappers,
    editCodexRange,
    loadSessionRecords,
    buildCodexFullHistory,
    buildCodexTimeline,
    getTimelineSessionMeta,
    latestCodexUsageInRecords,
    findLatestCodexUsage,
    findLatestCodexUsageAccounts,
    getCodexUsageAccountsFast,
    compareCodexRateSnapshotFreshness,
    compareCodexUsageFreshness,
    findCodexAccountIdentityForThread,
    codexAccountKeyFromIdentity,
    currentCodexAuthIdentityForUsage,
    rememberCodexActiveUsageOverride,
    mergeCodexActiveOverridesIntoAccounts,
  },
};
