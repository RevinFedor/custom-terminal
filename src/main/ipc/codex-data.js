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
const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_ACCOUNTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USAGE_ACCOUNTS_FOREGROUND_BUDGET_MS = 1200;
const USAGE_ACCOUNTS_ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const CODEX_REMOTE_USAGE_CACHE_TTL_MS = 55 * 1000;
const CODEX_REMOTE_USAGE_STALE_MS = 6 * 60 * 1000;
const CODEX_REMOTE_USAGE_ERROR_COOLDOWN_MS = 60 * 1000;
const CODEX_REMOTE_USAGE_TIMEOUT_MS = 8 * 1000;
const CODEX_USAGE_PERSISTENCE_KEY = 'codexUsageAccounts.v1';
const CODEX_USAGE_PENDING_CONFIRM_MS = 30 * 1000;
const CODEX_USAGE_BRANCH_RESET_TOLERANCE_SECONDS = 2 * 60;
const CODEX_USAGE_REGRESSION_POINTS = 10;
const CODEX_USAGE_INITIAL_CONFIRM_TIMEOUT_MS = 3 * 1000;
const CODEX_USAGE_INCONSISTENT_WARNING = 'OpenAI returned inconsistent usage. Showing the last verified value.';
const CODEX_USAGE_TAIL_CHUNK_BYTES = 1024 * 1024;
const CODEX_USAGE_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const CODEX_LATEST_USAGE_FILE_LIMIT = 24;
const CODEX_LATEST_USAGE_TAIL_BYTES = 2 * 1024 * 1024;
const CODEX_RESET_DRIFT_TOLERANCE_SECONDS = 10 * 60;
const CODEX_ACTIVE_USAGE_OVERRIDE_TTL_MS = 30 * 60 * 1000;
const CODEX_USAGE_SCAN_DAYS = 10;
const CODEX_USAGE_RATE_ROWS_LIMIT = 5000;
const CODEX_JSONL_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const CODEX_JSONL_WRITE_CHUNK_BYTES = 4 * 1024 * 1024;
// Raw file bytes are only a lower bound: parsed JSON strings/objects cost
// substantially more. Keep one oversized active rollout if necessary, but do
// not retain an unbounded collection of fully parsed sessions forever.
const CODEX_JSONL_CACHE_MAX_RAW_BYTES = 768 * 1024 * 1024;
const CODEX_JSONL_CACHE_MAX_FILES = 3;
const CODEX_SESSION_META_HEAD_MAX_BYTES = 512 * 1024;
const CODEX_SESSION_META_HEAD_CHUNK_BYTES = 16 * 1024;
const CODEX_SESSION_META_HEAD_MAX_RECORDS = 32;

let modelCache = null;
let usageAccountsCache = null;
let usageAccountsRefreshInFlight = null;
let usageAccountsLastAttemptAt = null;
let usageAccountsLastError = null;
let usageAccountsLastErrorAt = 0;
let codexUsageStateStore = null;
let codexUsageStateHydrated = false;
const codexRemoteUsageByAccount = new Map();
const codexRemoteUsageInflight = new Map();
const codexActiveUsageOverrides = new Map();
const loggedRollbackKeys = new Set();
const _codexJsonlCache = new Map();
let _codexJsonlCacheRawBytes = 0;
const _codexSessionSelectSkipLogged = new Set();
const _codexJsonlInflight = new Map();

function deleteCodexJsonlCacheEntry(filePath) {
  const cached = _codexJsonlCache.get(filePath);
  if (!cached) return false;
  _codexJsonlCache.delete(filePath);
  _codexJsonlCacheRawBytes = Math.max(0, _codexJsonlCacheRawBytes - (Number(cached.size) || 0));
  return true;
}

function pruneCodexJsonlCache(protectedFilePath) {
  while (
    _codexJsonlCache.size > CODEX_JSONL_CACHE_MAX_FILES ||
    _codexJsonlCacheRawBytes > CODEX_JSONL_CACHE_MAX_RAW_BYTES
  ) {
    let victim = null;
    for (const filePath of _codexJsonlCache.keys()) {
      if (filePath !== protectedFilePath) {
        victim = filePath;
        break;
      }
    }
    if (!victim) break; // one oversized active rollout is kept to avoid reparsing on every click
    const cached = _codexJsonlCache.get(victim);
    deleteCodexJsonlCacheEntry(victim);
    console.log('[CodexJsonlCache] evict file=' + path.basename(victim) +
      ' sizeKB=' + Math.round((Number(cached?.size) || 0) / 1024) +
      ' remainingFiles=' + _codexJsonlCache.size +
      ' remainingRawMB=' + Math.round(_codexJsonlCacheRawBytes / (1024 * 1024)));
  }
}

function setCodexJsonlCacheEntry(filePath, cached) {
  deleteCodexJsonlCacheEntry(filePath);
  _codexJsonlCache.set(filePath, cached);
  _codexJsonlCacheRawBytes += Number(cached?.size) || 0;
  pruneCodexJsonlCache(filePath);
}

function touchCodexJsonlCacheEntry(filePath, cached) {
  _codexJsonlCache.delete(filePath);
  _codexJsonlCache.set(filePath, cached);
}

function getCodexJsonlCacheStats() {
  return {
    files: _codexJsonlCache.size,
    rawBytes: _codexJsonlCacheRawBytes,
    filePaths: [..._codexJsonlCache.keys()],
  };
}

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

function shortKnowledgeDocsPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = filePath.replace(/\\/g, '/').trim();
  if (!normalized) return null;
  const segs = normalized.split('/').filter(Boolean);
  const baseName = segs[segs.length - 1] || '';
  const docsIndex = segs.findIndex((seg) => seg.toLowerCase() === 'docs');
  const lower = normalized.toLowerCase();
  const semanticIndexSibling = (() => {
    if (docsIndex < 0 || !path.isAbsolute(normalized)) return false;
    try {
      const parent = path.join('/', ...segs.slice(0, docsIndex));
      return fs.existsSync(path.join(parent, '.semantic-index.json'));
    } catch {
      return false;
    }
  })();
  const isDocsPath = docsIndex >= 0 && (
    !path.isAbsolute(normalized) ||
    semanticIndexSibling ||
    lower === 'docs' ||
    lower.startsWith('docs/') ||
    lower.includes('/docs/')
  );
  const isClaudeMd = baseName === 'CLAUDE.md';
  if (!isDocsPath && !isClaudeMd) return null;
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
  const shortName = shortKnowledgeDocsPath(filePath);
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

function skipJsQuotedValue(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return start;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function skipJsComment(source, start) {
  if (source[start] !== '/') return start;
  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2);
    return newline < 0 ? source.length : newline + 1;
  }
  if (source[start + 1] === '*') {
    const end = source.indexOf('*/', start + 2);
    return end < 0 ? source.length : end + 2;
  }
  return start;
}

function findJsToolCallArguments(source, callee) {
  if (typeof source !== 'string' || !source || !callee) return [];
  const calls = [];
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipJsQuotedValue(source, index) - 1;
      continue;
    }
    if (ch === '/') {
      const afterComment = skipJsComment(source, index);
      if (afterComment !== index) {
        index = afterComment - 1;
        continue;
      }
    }
    if (!source.startsWith(callee, index)) continue;
    const before = index > 0 ? source[index - 1] : '';
    if (before && /[\w$]/.test(before)) continue;
    let open = index + callee.length;
    while (/\s/.test(source[open] || '')) open += 1;
    if (source[open] !== '(') continue;

    let depth = 1;
    let cursor = open + 1;
    for (; cursor < source.length; cursor += 1) {
      const inner = source[cursor];
      if (inner === '"' || inner === "'" || inner === '`') {
        cursor = skipJsQuotedValue(source, cursor) - 1;
        continue;
      }
      if (inner === '/') {
        const afterComment = skipJsComment(source, cursor);
        if (afterComment !== cursor) {
          cursor = afterComment - 1;
          continue;
        }
      }
      if (inner === '(') depth += 1;
      if (inner === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    calls.push({
      start: index,
      end: cursor + 1,
      argumentsText: source.slice(open + 1, cursor),
    });
    index = cursor;
  }
  return calls;
}

function decodeSimpleJsString(source, start = 0) {
  while (/\s/.test(source[start] || '')) start += 1;
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === quote) return value;
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    const simpleEscapes = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      '"': '"',
      "'": "'",
      '`': '`',
    };
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
      continue;
    }
    if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
      value += String.fromCharCode(parseInt(source.slice(index + 1, index + 5), 16));
      index += 4;
      continue;
    }
    if (escaped === 'x' && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCharCode(parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (escaped === '\n') continue;
    value += escaped;
  }
  return null;
}

function findLastJsVariableInitializer(source, identifier, end = source.length) {
  let found = -1;
  for (let index = 0; index < Math.min(end, source.length); index += 1) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipJsQuotedValue(source, index) - 1;
      continue;
    }
    if (ch === '/') {
      const afterComment = skipJsComment(source, index);
      if (afterComment !== index) {
        index = afterComment - 1;
        continue;
      }
    }
    const keyword = /^(?:const|let|var)\b/.exec(source.slice(index))?.[0];
    if (!keyword) continue;
    const before = index > 0 ? source[index - 1] : '';
    if (before && /[\w$]/.test(before)) continue;
    let cursor = skipJsTrivia(source, index + keyword.length);
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
    if (!nameMatch || nameMatch[0] !== identifier) continue;
    cursor = skipJsTrivia(source, cursor + nameMatch[0].length);
    if (source[cursor] !== '=') continue;
    found = skipJsTrivia(source, cursor + 1);
  }
  return found;
}

function resolveSimpleJsCallArgument(source, call, argumentText) {
  const direct = decodeSimpleJsString(argumentText);
  if (direct != null) return direct;
  const identifier = String(argumentText || '').trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (!identifier) return null;
  const initializer = findLastJsVariableInitializer(source, identifier, call.start);
  if (initializer < 0) return null;
  return decodeSimpleJsString(source, initializer);
}

function extractExecDocsSearchQuery(argumentsText) {
  const queryMatch = /\b(?:query|q)\s*:\s*/g.exec(argumentsText || '');
  if (!queryMatch) return null;
  return decodeSimpleJsString(argumentsText, queryMatch.index + queryMatch[0].length);
}

function collectCodexExecDocsAttributes(currentUser, source) {
  if (!currentUser || typeof source !== 'string') return;

  for (const call of findJsToolCallArguments(source, 'tools.apply_patch')) {
    const patchText = resolveSimpleJsCallArgument(source, call, call.argumentsText);
    if (!patchText) continue;
    for (const filePath of extractPatchTouchedFiles(patchText)) {
      addDocsEdited(currentUser, filePath);
    }
  }

  for (const call of findJsToolCallArguments(source, 'tools.mcp__knowledge__docs_search')) {
    const query = extractExecDocsSearchQuery(call.argumentsText);
    if (query) addUniqueAttr(currentUser, 'docsSearchQueries', query);
  }
}

function skipJsTrivia(source, start = 0) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    const afterComment = skipJsComment(source, index);
    if (afterComment !== index) {
      index = afterComment;
      continue;
    }
    break;
  }
  return index;
}

function decodeSimpleJsStringToken(source, start = 0) {
  let index = skipJsTrivia(source, start);
  const quote = source[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (index += 1; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === quote) return { value, end: index + 1 };
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    const simpleEscapes = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      '"': '"',
      "'": "'",
      '`': '`',
    };
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
      continue;
    }
    if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
      value += String.fromCharCode(parseInt(source.slice(index + 1, index + 5), 16));
      index += 4;
      continue;
    }
    if (escaped === 'x' && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCharCode(parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (escaped === '\n') continue;
    value += escaped;
  }
  return null;
}

// Safe, deliberately small JS-literal reader for orchestrated exec arguments.
// It understands the JSON-like subset emitted by Codex (objects, arrays,
// strings, numbers and primitives) without eval/vm execution of rollout text.
function parseSimpleJsLiteralAt(source, start = 0, depth = 0) {
  if (depth > 24) return null;
  let index = skipJsTrivia(source, start);
  const stringToken = decodeSimpleJsStringToken(source, index);
  if (stringToken) return stringToken;

  if (source[index] === '{') {
    const value = {};
    index = skipJsTrivia(source, index + 1);
    while (index < source.length && source[index] !== '}') {
      let keyToken = decodeSimpleJsStringToken(source, index);
      let key;
      if (keyToken) {
        key = keyToken.value;
        index = keyToken.end;
      } else {
        const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
        if (!match) return null;
        key = match[0];
        index += match[0].length;
      }
      index = skipJsTrivia(source, index);
      if (source[index] !== ':') return null;
      const parsed = parseSimpleJsLiteralAt(source, index + 1, depth + 1);
      if (!parsed) return null;
      value[key] = parsed.value;
      index = skipJsTrivia(source, parsed.end);
      if (source[index] === ',') {
        index = skipJsTrivia(source, index + 1);
        continue;
      }
      if (source[index] !== '}') return null;
    }
    if (source[index] !== '}') return null;
    return { value, end: index + 1 };
  }

  if (source[index] === '[') {
    const value = [];
    index = skipJsTrivia(source, index + 1);
    while (index < source.length && source[index] !== ']') {
      const parsed = parseSimpleJsLiteralAt(source, index, depth + 1);
      if (!parsed) return null;
      value.push(parsed.value);
      index = skipJsTrivia(source, parsed.end);
      if (source[index] === ',') {
        index = skipJsTrivia(source, index + 1);
        continue;
      }
      if (source[index] !== ']') return null;
    }
    if (source[index] !== ']') return null;
    return { value, end: index + 1 };
  }

  const numberMatch = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
  if (numberMatch) {
    return { value: Number(numberMatch[0]), end: index + numberMatch[0].length };
  }
  for (const [token, value] of [['true', true], ['false', false], ['null', null], ['undefined', null]]) {
    if (source.startsWith(token, index) && !/[\w$]/.test(source[index + token.length] || '')) {
      return { value, end: index + token.length };
    }
  }
  return null;
}

function resolveSimpleJsCallValue(source, call) {
  const direct = parseSimpleJsLiteralAt(call.argumentsText || '', 0);
  if (direct) return direct.value;
  const identifier = String(call.argumentsText || '').trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (!identifier) return null;
  const initializer = findLastJsVariableInitializer(source, identifier, call.start);
  if (initializer < 0) return null;
  return parseSimpleJsLiteralAt(source, initializer)?.value ?? null;
}

function findCodexExecNestedCalls(source) {
  if (typeof source !== 'string' || !source) return [];
  const calls = [];
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipJsQuotedValue(source, index) - 1;
      continue;
    }
    if (ch === '/') {
      const afterComment = skipJsComment(source, index);
      if (afterComment !== index) {
        index = afterComment - 1;
        continue;
      }
    }
    if (!source.startsWith('tools.', index)) continue;
    const before = index > 0 ? source[index - 1] : '';
    if (before && /[\w$]/.test(before)) continue;
    const nameStart = index + 'tools.'.length;
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(nameStart));
    if (!nameMatch) continue;
    const toolName = nameMatch[0];
    let open = skipJsTrivia(source, nameStart + toolName.length);
    if (source[open] !== '(') continue;

    let depth = 1;
    let cursor = open + 1;
    for (; cursor < source.length; cursor += 1) {
      const inner = source[cursor];
      if (inner === '"' || inner === "'" || inner === '`') {
        cursor = skipJsQuotedValue(source, cursor) - 1;
        continue;
      }
      if (inner === '/') {
        const afterComment = skipJsComment(source, cursor);
        if (afterComment !== cursor) {
          cursor = afterComment - 1;
          continue;
        }
      }
      if (inner === '(') depth += 1;
      if (inner === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    calls.push({
      toolName,
      start: index,
      end: cursor + 1,
      argumentsText: source.slice(open + 1, cursor),
    });
    index = cursor;
  }
  return calls;
}

function normalizeCodexHistoryTextPart(text) {
  let current = String(text || '');
  for (let depth = 0; depth < 2; depth += 1) {
    const trimmed = current.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) break;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }
    if (!parsed || Array.isArray(parsed) || !Array.isArray(parsed.content)) break;
    const content = parsed.content.map((item) => {
      if (!item) return '';
      if (String(item.type || '').toLowerCase().includes('image') || item.image_url) return '[Image output]';
      return typeof item.text === 'string' ? item.text : '';
    }).filter(Boolean);
    if (content.length === 0) break;
    current = content.join('\n');
  }
  if (current.trim() === '{}' || current.trim() === '[]') return '';
  return stripBase64Images(current);
}

function codexHistoryOutputParts(rawOutput) {
  if (rawOutput == null) return [];
  if (!Array.isArray(rawOutput)) {
    return [normalizeCodexHistoryTextPart(typeof rawOutput === 'string' ? rawOutput : stringifyCompact(rawOutput))];
  }
  const parts = [];
  for (const item of rawOutput) {
    if (!item) continue;
    const type = String(item.type || '').toLowerCase();
    if (type.includes('image') || item.image_url) {
      parts.push('[Image output]');
      continue;
    }
    const text = typeof item.text === 'string'
      ? item.text
      : (typeof item.output_text === 'string' ? item.output_text : '');
    if (text) parts.push(normalizeCodexHistoryTextPart(text));
  }
  if (/^Script completed\b[\s\S]*\nOutput:\n?$/.test(parts[0] || '')) {
    parts.shift();
  } else if (parts.length > 1 && /^Script running\b[\s\S]*\nOutput:\n?$/.test(parts[0])) {
    parts.shift();
  }
  return parts;
}

function codexHistoryCellId(rawOutput) {
  const text = codexHistoryOutputParts(rawOutput).join('\n');
  return /Script running with cell ID\s+([^\s]+)/.exec(text)?.[1] || null;
}

function parseApplyPatchHunks(body) {
  const hunks = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const oldString = current.oldLines.join('\n');
    const newString = current.newLines.join('\n');
    if ((oldString || newString) && oldString !== newString) {
      hunks.push({ old_string: oldString, new_string: newString });
    }
    current = null;
  };
  for (const line of String(body || '').split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      current = { oldLines: [], newLines: [] };
      continue;
    }
    if (line.startsWith('*** Move to:') || line === '\\ No newline at end of file') continue;
    if (!current) current = { oldLines: [], newLines: [] };
    if (line.startsWith('+')) current.newLines.push(line.slice(1));
    else if (line.startsWith('-')) current.oldLines.push(line.slice(1));
    else {
      const context = line.startsWith(' ') ? line.slice(1) : line;
      current.oldLines.push(context);
      current.newLines.push(context);
    }
  }
  flush();
  return hunks;
}

function parseApplyPatchHistoryActions(patchText) {
  if (typeof patchText !== 'string' || !patchText.includes('*** Begin Patch')) return [];
  const headers = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let match;
  while ((match = re.exec(patchText)) !== null) {
    headers.push({ kind: match[1], filePath: match[2].trim(), bodyStart: re.lastIndex, headerStart: match.index });
  }
  return headers.map((header, index) => {
    const next = headers[index + 1];
    const endMarker = patchText.indexOf('*** End Patch', header.bodyStart);
    const bodyEnd = next?.headerStart ?? (endMarker >= 0 ? endMarker : patchText.length);
    const body = patchText.slice(header.bodyStart, bodyEnd).replace(/^\n/, '').replace(/\n$/, '');
    if (header.kind === 'Add') {
      const content = body.split('\n').map((line) => line.startsWith('+') ? line.slice(1) : line).join('\n');
      return { toolName: 'Write', args: { file_path: header.filePath, content } };
    }
    const hunks = parseApplyPatchHunks(body);
    if (hunks.length > 1) {
      return { toolName: 'MultiEdit', args: { file_path: header.filePath, edits: hunks } };
    }
    return {
      toolName: 'Edit',
      args: {
        file_path: header.filePath,
        old_string: hunks[0]?.old_string || '',
        new_string: header.kind === 'Delete' ? '' : (hunks[0]?.new_string || ''),
      },
    };
  });
}

function humanizeCodexToolName(toolName) {
  return String(toolName || 'Tool')
    .split(/__|[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Tool';
}

function firstCodexToolDetail(args) {
  if (!args || typeof args !== 'object') return '';
  const direct = args.query || args.q || args.path || args.file_path || args.location || args.uri || args.pattern || args.prompt;
  if (typeof direct === 'string') return direct;
  const query = Array.isArray(args.search_query) ? args.search_query[0]?.q : null;
  if (typeof query === 'string') return query;
  return '';
}

function normalizeCodexHistoryCall(toolName, args, namespace = '') {
  const name = String(toolName || 'tool');
  const input = args && typeof args === 'object' ? args : { input: args };
  const qualifiedName = namespace && namespace.startsWith('mcp__')
    ? `${namespace}__${name}`
    : name;

  if (qualifiedName === 'apply_patch') {
    const patchText = typeof input.input === 'string' ? input.input : '';
    const actions = parseApplyPatchHistoryActions(patchText);
    return actions.length > 0 ? actions : [{ toolName: 'Edit', args: { file_path: '(patch)' } }];
  }
  if (qualifiedName === 'exec_command' || qualifiedName === 'run_command' || qualifiedName === 'restart_process' || qualifiedName === 'kill_process' || qualifiedName === 'run_chain') {
    return [{
      toolName: 'Bash',
      args: {
        command: input.cmd || input.command || input.input || humanizeCodexToolName(qualifiedName),
        description: input.justification || '',
      },
    }];
  }
  if (qualifiedName === 'write_stdin') {
    const target = input.session_id != null ? `session ${input.session_id}` : 'terminal';
    return [{ toolName: 'Bash', args: { command: `Write to ${target}: ${String(input.chars || '').slice(0, 200)}` } }];
  }
  if (qualifiedName === 'view_image') {
    return [{ toolName: 'Read', args: { file_path: input.path || '(image)' } }];
  }
  if (qualifiedName === 'web__run') {
    return [{ toolName: 'WebSearch', args: { query: firstCodexToolDetail(input) || 'Web request' } }];
  }
  if (qualifiedName === 'image_gen__imagegen') {
    return [{ toolName: 'Image', args: { summary: firstCodexToolDetail(input) || 'Generate image' } }];
  }
  if (
    qualifiedName.startsWith('mcp__') ||
    qualifiedName === 'read_mcp_resource' ||
    qualifiedName === 'list_mcp_resources' ||
    qualifiedName === 'list_mcp_resource_templates'
  ) {
    const parts = qualifiedName.replace(/^mcp__/, '').split('__');
    const action = parts.length > 1 ? `${parts[0]} · ${parts.slice(1).join(' ')}` : humanizeCodexToolName(qualifiedName);
    const detail = firstCodexToolDetail(input);
    return [{ toolName: 'MCP', args: { summary: detail ? `${action} — ${detail}` : action, ...input } }];
  }
  if (qualifiedName === 'update_plan') {
    const active = Array.isArray(input.plan) ? input.plan.find((item) => item?.status === 'in_progress')?.step : '';
    return [{ toolName: 'Plan', args: { summary: active || input.explanation || 'Update task plan' } }];
  }
  if (qualifiedName === 'request_user_input') {
    const question = Array.isArray(input.questions) ? input.questions[0]?.question : '';
    return [{ toolName: 'Question', args: { summary: question || 'Request user input' } }];
  }
  if (qualifiedName === 'wait') {
    return [{ toolName: 'Wait', args: { summary: input.cell_id ? `Task ${input.cell_id}` : 'Background task' } }];
  }
  return [{ toolName: humanizeCodexToolName(qualifiedName), args: input }];
}

function assignCodexHistoryResults(callGroups, rawOutput, isError) {
  const parts = codexHistoryOutputParts(rawOutput);
  const perCall = callGroups.length === parts.length
    ? parts
    : callGroups.length === 1
      ? [parts.join('\n')]
      : callGroups.map((_, index) => index === callGroups.length - 1 ? parts.join('\n') : '');
  for (let index = 0; index < callGroups.length; index += 1) {
    for (const action of callGroups[index]) {
      action.result = perCall[index] ?? '';
      action.isError = !!isError;
    }
  }
}

function codexHistoryActionsForCall(call, rawOutput, isError) {
  const source = call?.toolName === 'exec' && typeof call?.args?.input === 'string'
    ? call.args.input
    : '';
  const nested = source ? findCodexExecNestedCalls(source) : [];
  const callGroups = [];

  if (nested.length > 0) {
    for (const nestedCall of nested) {
      const parsed = resolveSimpleJsCallValue(source, nestedCall);
      const args = parsed && typeof parsed === 'object'
        ? parsed
        : (typeof parsed === 'string' ? { input: parsed } : { input: compactPreview(nestedCall.argumentsText, 1000) });
      callGroups.push(normalizeCodexHistoryCall(nestedCall.toolName, args));
    }
  } else if (call?.toolName === 'exec') {
    const lookup = /\bALL_TOOLS\b/.test(source);
    callGroups.push([{
      toolName: lookup ? 'Tool Search' : 'Orchestration',
      args: { summary: lookup ? 'Inspect available tools' : compactPreview(source, 240) },
    }]);
  } else {
    callGroups.push(normalizeCodexHistoryCall(call?.toolName, call?.args || {}, call?.namespace || ''));
  }

  const cellId = call?.toolName === 'exec' ? codexHistoryCellId(rawOutput) : null;
  if (!cellId) assignCodexHistoryResults(callGroups, rawOutput, isError);
  const actions = callGroups.flat().map((action) => ({
    tool: '__raw__',
    rawTool: {
      toolName: action.toolName,
      args: action.args || {},
      result: action.result,
      isError: action.isError,
    },
  }));
  return { actions, cellId };
}

function fillPendingCodexHistoryActions(actions, rawOutput, isError) {
  const groups = (actions || []).map((action) => [action.rawTool]);
  assignCodexHistoryResults(groups, rawOutput, isError);
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

  if (toolName === 'exec') {
    const source = typeof payload.input === 'string'
      ? payload.input
      : (typeof payload.arguments === 'string' ? payload.arguments : '');
    collectCodexExecDocsAttributes(currentUser, source);
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

// A single Codex compaction is written twice: the authoritative top-level
// `compacted` snapshot and a later event_msg telemetry companion. The number
// of technical records between them is not stable, so line-distance heuristics
// turn one compaction into two markers. Pair by semantic order instead: keep a
// pending top-level event through token/context bookkeeping and consume the
// next compact-like event before the next real user turn.
function codexCompactCompanionLines(records) {
  const companions = new Set();
  let pendingTopLevelCount = 0;
  for (const record of Array.isArray(records) ? records : []) {
    const payload = record?.payload || {};
    if (record?.type === 'compacted') {
      pendingTopLevelCount += 1;
      continue;
    }
    if (record?.type === 'event_msg' && isCompactPayload(payload)) {
      if (pendingTopLevelCount > 0) {
        companions.add(record.__line);
        pendingTopLevelCount -= 1;
      }
      continue;
    }
    if (record?.type === 'event_msg' && payload.type === 'user_message') {
      pendingTopLevelCount = 0;
    }
  }
  return companions;
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

function codexRecordTypeFromPrefix(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  const match = /"type"\s*:\s*"([^"]+)"/.exec(prefix);
  return match?.[1] || null;
}

async function readCodexSessionMetadata(filePath, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || CODEX_SESSION_META_HEAD_MAX_BYTES);
  const chunkBytes = Math.max(1, Math.min(
    maxBytes,
    Number(options.chunkBytes) || CODEX_SESSION_META_HEAD_CHUNK_BYTES
  ));
  const maxRecords = Math.max(1, Number(options.maxRecords) || CODEX_SESSION_META_HEAD_MAX_RECORDS);
  const metadataRecords = [];
  let bytesRead = 0;
  let scannedRecords = 0;
  let pending = Buffer.alloc(0);
  let stoppedAtNonMetadata = false;
  let fileHandle;

  const result = () => ({
    records: metadataRecords,
    meta: getSessionMeta(metadataRecords),
    bytesRead,
    scannedRecords,
    stoppedAtNonMetadata,
    truncated: bytesRead >= maxBytes,
  });

  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    while (bytesRead < maxBytes && scannedRecords < maxRecords) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes - bytesRead));
      const read = await fileHandle.read(buffer, 0, buffer.length, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
      pending = pending.length > 0
        ? Buffer.concat([pending, buffer.subarray(0, read.bytesRead)])
        : Buffer.from(buffer.subarray(0, read.bytesRead));

      let newlineIndex = pending.indexOf(0x0a);
      while (newlineIndex >= 0 && scannedRecords < maxRecords) {
        const lineBuffer = pending.subarray(0, newlineIndex);
        pending = Buffer.from(pending.subarray(newlineIndex + 1));
        const line = lineBuffer.toString('utf8').trim();
        const lineNumber = scannedRecords;
        scannedRecords += 1;
        if (line) {
          let record = null;
          try {
            record = JSON.parse(line);
          } catch {
            // A corrupt/in-progress line is not metadata. Once the metadata
            // prefix is complete, discovery must not continue into payloads.
          }
          if (record?.type === 'session_meta' && record.payload) {
            metadataRecords.push({ ...record, __line: lineNumber });
          } else if (metadataRecords.length > 0) {
            stoppedAtNonMetadata = true;
            return result();
          }
        }
        newlineIndex = pending.indexOf(0x0a);
      }

      if (metadataRecords.length > 0 && pending.length > 0) {
        const nextType = codexRecordTypeFromPrefix(pending);
        if (nextType && nextType !== 'session_meta') {
          stoppedAtNonMetadata = true;
          return result();
        }
      }
    }

    if (pending.length > 0 && scannedRecords < maxRecords) {
      const line = pending.toString('utf8').trim();
      if (line) {
        try {
          const record = JSON.parse(line);
          if (record?.type === 'session_meta' && record.payload) {
            metadataRecords.push({ ...record, __line: scannedRecords });
          }
        } catch {
          // The bounded head may end in the middle of a non-metadata record.
        }
      }
    }
    return result();
  } finally {
    await fileHandle?.close();
  }
}

async function readJsonlRange(filePath, startByte, endByte, options = {}) {
  const records = options.records || [];
  let lineCount = Number(options.lineCount) || 0;
  let parsed = 0;
  let errors = 0;
  let leftoverBuffer = Buffer.isBuffer(options.leftoverBuffer)
    ? Buffer.from(options.leftoverBuffer)
    : Buffer.from(String(options.leftover || ''), 'utf8');

  const consume = (chunk) => {
    if (!chunk?.length) return;
    const data = leftoverBuffer.length > 0
      ? Buffer.concat([leftoverBuffer, chunk])
      : chunk;
    let lineStart = 0;
    let newlineIndex = data.indexOf(0x0a, lineStart);
    while (newlineIndex >= 0) {
      const line = data.subarray(lineStart, newlineIndex).toString('utf8').trim();
      if (line) {
        try {
          const record = JSON.parse(line);
          records.push({ ...record, __line: lineCount });
          parsed += 1;
        } catch {
          errors += 1;
        }
      }
      lineCount += 1;
      lineStart = newlineIndex + 1;
      newlineIndex = data.indexOf(0x0a, lineStart);
    }
    leftoverBuffer = Buffer.from(data.subarray(lineStart));
  };

  if (endByte >= startByte) {
    const stream = fs.createReadStream(filePath, {
      start: startByte,
      end: endByte,
      highWaterMark: Math.max(1, Number(options.highWaterMark) || CODEX_JSONL_READ_CHUNK_BYTES),
    });
    for await (const chunk of stream) {
      consume(chunk);
    }
  }

  return {
    records,
    lineCount,
    parsed,
    errors,
    leftoverBuffer,
    leftover: leftoverBuffer.toString('utf8'),
  };
}

async function _parseJsonlFileIncremental(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    deleteCodexJsonlCacheEntry(filePath);
    return [];
  }

  const cached = _codexJsonlCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    touchCodexJsonlCacheEntry(filePath, cached);
    return cached.records;
  }

  if (cached && stat.size > cached.size) {
    const prevSize = cached.size;
    const prevLineCount = cached.lineCount || 0;
    const result = await readJsonlRange(filePath, prevSize, stat.size - 1, {
      // Stage appended records separately. If the stream fails mid-read, the
      // previous size checkpoint remains valid and its cached array must stay
      // untouched or the retry would append duplicates.
      records: [],
      lineCount: prevLineCount,
      leftoverBuffer: cached.leftoverBuffer,
      leftover: cached.leftover,
    });
    for (const record of result.records) {
      cached.records.push(record);
    }
    setCodexJsonlCacheEntry(filePath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount: result.lineCount,
      leftover: result.leftover,
      leftoverBuffer: result.leftoverBuffer,
      records: cached.records,
    });
    console.log('[CodexJsonlCache] append file=' + path.basename(filePath) +
      ' bytes=' + (stat.size - prevSize) +
      ' parsed=' + result.parsed +
      ' errors=' + result.errors +
      ' total=' + cached.records.length +
      ' leftoverBytes=' + result.leftoverBuffer.length +
      ' cacheFiles=' + _codexJsonlCache.size +
      ' cacheRawMB=' + Math.round(_codexJsonlCacheRawBytes / (1024 * 1024)));
    return cached.records;
  }

  const result = await readJsonlRange(filePath, 0, stat.size - 1);
  setCodexJsonlCacheEntry(filePath, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount: result.lineCount,
    leftover: result.leftover,
    leftoverBuffer: result.leftoverBuffer,
    records: result.records,
  });
  console.log('[CodexJsonlCache] full file=' + path.basename(filePath) +
    ' sizeKB=' + Math.round(stat.size / 1024) +
    ' records=' + result.records.length +
    ' errors=' + result.errors +
    ' leftoverBytes=' + result.leftoverBuffer.length +
    ' cacheFiles=' + _codexJsonlCache.size +
    ' cacheRawMB=' + Math.round(_codexJsonlCacheRawBytes / (1024 * 1024)) +
    (cached ? ' reason=rewrite-or-shrink' : ' reason=first-read'));
  return result.records;
}

function invalidateCodexJsonlCache(filePath) {
  if (!filePath) return;
  deleteCodexJsonlCacheEntry(filePath);
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

async function findCodexSessionFile(sessionId, cwd, {
  allowContentScan = true,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  if (!sessionId || !fs.existsSync(sessionsDir)) return null;

  const files = await walkJsonlFiles(sessionsDir);
  const suffixHit = files.find((file) => path.basename(file).includes(sessionId) && path.basename(file).endsWith('.jsonl'));
  if (suffixHit) return { filePath: suffixHit };
  if (!allowContentScan) return null;

  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  for (const filePath of files) {
    let metadata;
    try {
      metadata = await readCodexSessionMetadata(filePath);
    } catch {
      continue;
    }
    const meta = metadata.meta;
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

async function findLatestCodexSession({
  cwd,
  sinceMs = 0,
  sourceSessionId = null,
  excludeSessionIds = [],
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  if (!fs.existsSync(sessionsDir)) return null;
  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  const excludedSessionIds = new Set((Array.isArray(excludeSessionIds) ? excludeSessionIds : [])
    .filter(Boolean)
    .map(String));
  const files = await walkJsonlFiles(sessionsDir);
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
    let metadata;
    try {
      metadata = await readCodexSessionMetadata(candidate.filePath);
    } catch {
      continue;
    }
    const meta = metadata.meta;
    if (!meta?.id) continue;
    if (excludedSessionIds.has(String(meta.id))) continue;
    if (sourceSessionId && meta.id === sourceSessionId) continue;
    const sessionStartedMs = meta.timestamp ? Date.parse(meta.timestamp) : 0;
    if (sinceMs && Number.isFinite(sessionStartedMs) && sessionStartedMs > 0 && sessionStartedMs < sinceMs - 5000) continue;
    const metaCwd = meta.cwd ? path.resolve(meta.cwd) : null;
    const cwdMatched = !normalizedCwd || (metaCwd && metaCwd === normalizedCwd);
    const cwdRelated = !normalizedCwd || (metaCwd && pathsAreSameOrNested(metaCwd, normalizedCwd));
    const sourceMatched = !!sourceSessionId && recordsReferenceSession(metadata.records, sourceSessionId);
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
  const compactCompanionLines = codexCompactCompanionLines(records);
  let currentUser = null;
  let currentTurnIndex = -1;
  let latestModel = null;
  let latestEffort = null;
  let latestTokenCountInfo = null;

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
      entries.push({
        uuid: stableUuid(sessionId, record.__line, 'codex-compact'),
        type: 'compact',
        timestamp: recordTimestamp(record),
        content: compactEventTitle(payload),
        sourceLine: record.__line,
        preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
        sessionId,
        turnIndex: currentTurnIndex,
      });
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
        if (compactCompanionLines.has(record.__line)) {
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
          turnIndex: currentTurnIndex,
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
  const compactCompanionLines = codexCompactCompanionLines(records);
  const pendingCalls = new Map();
  const pendingExecCells = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';
  let latestTokenCountInfo = null;
  let lastDisplayedModel = null;
  let lastDisplayedEffort = null;

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model.trim() : '';
      const effort = typeof payload.effort === 'string' ? payload.effort.trim() : '';
      const nextTurnIndex = currentTurnIndex + 1;
      if (model && model !== lastDisplayedModel) {
        entries.push({
          uuid: stableUuid(sessionId, record.__line, 'codex-model'),
          role: 'slash',
          timestamp: recordTimestamp(record),
          content: `/model ${model}`,
          sessionId,
          turnIndex: nextTurnIndex,
        });
        lastDisplayedModel = model;
      }
      if (effort && effort !== lastDisplayedEffort) {
        entries.push({
          uuid: stableUuid(sessionId, record.__line, 'codex-effort'),
          role: 'slash',
          timestamp: recordTimestamp(record),
          content: `/effort ${effort}`,
          sessionId,
          turnIndex: nextTurnIndex,
        });
        lastDisplayedEffort = effort;
      }
      continue;
    }

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
        if (compactCompanionLines.has(record.__line)) {
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
        namespace: payload.namespace || '',
        args: args && typeof args === 'object' ? args : { value: args },
        timestamp: recordTimestamp(record),
        line: record.__line,
        record,
      });
      continue;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id || payload.id;
      const call = pendingCalls.get(callId) || {
        toolName: payload.name || payload.type,
        namespace: payload.namespace || '',
        args: {},
        timestamp: recordTimestamp(record),
        line: record.__line,
      };
      const waitCellId = call.toolName === 'wait' ? String(call.args?.cell_id || '') : '';
      const pendingCellActions = waitCellId ? pendingExecCells.get(waitCellId) : null;
      if (pendingCellActions) {
        fillPendingCodexHistoryActions(pendingCellActions, payload.output, !!payload.is_error);
        pendingExecCells.delete(waitCellId);
        pushAssistantEntry(entries, sessionId, record, currentTurnIndex, '', pendingThinking, null);
      } else {
        const decoded = codexHistoryActionsForCall(call, payload.output, !!payload.is_error);
        pushAssistantEntry(entries, sessionId, record, currentTurnIndex, '', pendingThinking, decoded.actions);
        if (decoded.cellId) pendingExecCells.set(decoded.cellId, decoded.actions);
      }
      pendingThinking = '';
      pendingCalls.delete(callId);
    }
  }

  // A transcript-changed notification is emitted as soon as Codex appends the
  // call, before its output exists. Keep that in-flight call in the canonical
  // history snapshot so a live semantic tool card is not briefly replaced by
  // an empty REST reload during a long-running command. A pending `wait` for a
  // known async exec cell is intentionally hidden: the original projected card
  // is already present in `entries` and owns the eventual result.
  for (const call of pendingCalls.values()) {
    const waitCellId = call.toolName === 'wait' ? String(call.args?.cell_id || '') : '';
    if (waitCellId && pendingExecCells.has(waitCellId)) continue;
    const decoded = codexHistoryActionsForCall(call, undefined, false);
    pushAssistantEntry(
      entries,
      sessionId,
      call.record || { __line: call.line, timestamp: call.timestamp },
      currentTurnIndex,
      '',
      pendingThinking,
      decoded.actions
    );
    pendingThinking = '';
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
  if (!record || typeof record !== 'object') return {};
  const { __line: _sourceLine, ...cloned } = record;
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
  const compactCompanionLines = codexCompactCompanionLines(records);
  const pending = [];
  let currentTurnIndex = -1;

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
      continue;
    }

    if (record?.type === 'event_msg' && isCompactPayload(payload)) {
      const isTopLevelCompanion = compactCompanionLines.has(record.__line);
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

async function writeCodexJsonlExclusive(filePath, records) {
  let handle = null;
  let created = false;
  try {
    handle = await fs.promises.open(filePath, 'wx');
    created = true;
    let chunk = '';
    let chunkBytes = 0;

    const flush = async () => {
      if (!chunk || !handle) return;
      await handle.appendFile(chunk, 'utf8');
      chunk = '';
      chunkBytes = 0;
    };

    for (const record of records) {
      const serialized = JSON.stringify(record);
      if (typeof serialized !== 'string') {
        throw new Error('Codex edited fork contains a non-serializable record');
      }
      const line = serialized + '\n';
      const lineBytes = Buffer.byteLength(line);
      if (chunkBytes > 0 && chunkBytes + lineBytes > CODEX_JSONL_WRITE_CHUNK_BYTES) {
        await flush();
      }
      if (lineBytes >= CODEX_JSONL_WRITE_CHUNK_BYTES) {
        await handle.appendFile(line, 'utf8');
      } else {
        chunk += line;
        chunkBytes += lineBytes;
      }
    }
    await flush();
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.promises.unlink(filePath).catch(() => {});
    throw error;
  }
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
      await writeCodexJsonlExclusive(filePath, outputRecords);
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

function planCodexRangeRewrite(records, sessionId, startUuid, endUuid, replacementText = null) {
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
    if (entry.type === 'compact') selectedCompacts.add(entry.uuid);
    else if (typeof entry.turnIndex === 'number') selectedTurns.add(entry.turnIndex);
  }
  if (selectedTurns.size === 0 && selectedCompacts.size === 0) {
    return { success: false, error: 'Selected range has no editable Codex turns' };
  }

  const wrappers = buildCodexVisibleRecordWrappers(records, sessionId);
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
  if (replacementText) {
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
  const replacementRecords = replacementText
    ? createCodexReplacementRecords(replacementText, replacementTimestamp)
    : [];
  const outputRecords = [];
  let inserted = false;
  let removedRecords = 0;
  let removedUsers = 0;

  for (const wrapper of wrappers) {
    const shouldRemove = shouldRemoveWrapper(wrapper);
    if (shouldRemove) {
      if (replacementRecords.length > 0 && !inserted) {
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

  if (replacementRecords.length > 0 && !inserted) {
    for (const replacement of replacementRecords) outputRecords.push(replacement);
  }

  return {
    success: true,
    outputRecords,
    replacementRecords,
    removedCount: removedRecords,
    removedUsers,
    selectedCount: selected.length,
    selectedTurns: Array.from(selectedTurns),
    selectedCompacts: Array.from(selectedCompacts),
  };
}

async function editCodexRange({ sessionId, cwd, startUuid, endUuid, compactText }) {
  const replacementText = String(compactText || '').trim();
  if (!sessionId) return { success: false, error: 'sessionId required' };
  if (!startUuid || !endUuid) return { success: false, error: 'startUuid/endUuid required' };
  if (!replacementText) return { success: false, error: 'Replacement text required' };

  const loaded = await loadSessionRecords(sessionId, cwd);
  if (!loaded.success) return loaded;

  const plan = planCodexRangeRewrite(
    loaded.records,
    sessionId,
    startUuid,
    endUuid,
    replacementText
  );
  if (!plan.success) return plan;

  const replacementEventRecord = plan.replacementRecords.find(
    (record) => record.type === 'event_msg' && record.payload?.type === 'user_message'
  );
  const result = await writeCodexEditedFork(loaded.records, sessionId, cwd, plan.outputRecords);
  const outputRecords = plan.outputRecords;
  const finalLine = outputRecords.findIndex((record) => record === replacementEventRecord);
  const replacementUuid = finalLine >= 0 ? stableUuid(result.newSessionId, finalLine, 'codex-user') : null;

  return {
    success: true,
    newSessionId: result.newSessionId,
    filePath: result.filePath,
    sourceFilePath: loaded.filePath,
    replacementUuid,
    compactUuid: replacementUuid,
    removedCount: plan.removedCount,
    removedUsers: plan.removedUsers,
    selectedCount: plan.selectedCount,
    selectedTurns: plan.selectedTurns,
    selectedCompacts: plan.selectedCompacts,
  };
}

async function deleteCodexRange({ sessionId, cwd, startUuid, endUuid }) {
  if (!sessionId) return { success: false, error: 'sessionId required' };
  if (!startUuid || !endUuid) return { success: false, error: 'startUuid/endUuid required' };

  const loaded = await loadSessionRecords(sessionId, cwd);
  if (!loaded.success) return loaded;

  const plan = planCodexRangeRewrite(
    loaded.records,
    sessionId,
    startUuid,
    endUuid
  );
  if (!plan.success) return plan;

  const result = await writeCodexEditedFork(loaded.records, sessionId, cwd, plan.outputRecords);
  const rewrittenRecords = plan.outputRecords.map((record, index) => ({ ...record, __line: index }));
  const remainingTimeline = buildCodexTimeline(rewrittenRecords, result.newSessionId);

  return {
    success: true,
    newSessionId: result.newSessionId,
    filePath: result.filePath,
    sourceFilePath: loaded.filePath,
    removedCount: plan.removedCount,
    removedUsers: plan.removedUsers,
    selectedCount: plan.selectedCount,
    selectedTurns: plan.selectedTurns,
    selectedCompacts: plan.selectedCompacts,
    remainingCount: remainingTimeline.length,
    remainingUsers: remainingTimeline.filter((entry) => entry.type === 'user').length,
    fileDeleted: false,
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
  const compactCompanionLines = codexCompactCompanionLines(records);
  const pendingCalls = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';
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
        if (!compactCompanionLines.has(record.__line)) {
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

function boundCodexAssistantContext(blocks, maxChars = 8000) {
  const values = (Array.isArray(blocks) ? blocks : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (values.length === 0) return '';
  const limit = Math.max(500, Math.min(16000, Number(maxChars) || 8000));
  const joined = values.join('\n\n');
  if (joined.length <= limit) return joined;
  const first = values[0];
  const last = values[values.length - 1];
  if (values.length === 1) {
    const head = Math.floor(limit * 0.4);
    return first.slice(0, head).trimEnd() + '\n…\n' + first.slice(-(limit - head - 3)).trimStart();
  }
  const firstLimit = Math.min(Math.floor(limit * 0.35), first.length);
  const lastLimit = Math.max(0, limit - firstLimit - 3);
  return first.slice(0, firstLimit).trimEnd() + '\n…\n' + last.slice(-lastLimit).trimStart();
}

function buildCodexTurnAssistantContext(records, sessionId, entryUuid, maxChars = 8000) {
  const timeline = buildCodexTimeline(records, sessionId);
  const target = timeline.find((entry) => entry.uuid === entryUuid && typeof entry.turnIndex === 'number');
  if (!target) return { success: false, error: 'Timeline turn not found' };
  const cleanEntries = buildCodexCleanEntries(records, sessionId, codexCopyOptions({
    // Keep user rows in the intermediate projection even though this helper
    // returns assistant text only. `thread_rolled_back` is resolved against
    // the rows present in that projection; omitting a just-submitted user that
    // was rolled back before any assistant output makes the rollback remove
    // the previous assistant turn instead and shifts every later turnIndex.
    // Filtering to assistant rows happens below, after structural indexing is
    // complete, so no user text leaks into the returned context.
    includeUser: true,
    includeClaude: true,
    includeText: true,
    includeThinking: false,
    includeBash: false,
    includeTools: false,
    includeWebSearch: false,
    includeToolSearch: false,
    includeOtherTools: false,
  }));
  const assistantBlocks = cleanEntries
    .filter((entry) => entry.kind === 'assistant' && entry.turnIndex === target.turnIndex)
    .map((entry) => entry.text);
  const assistantText = boundCodexAssistantContext(assistantBlocks, maxChars);
  return assistantText
    ? { success: true, assistantText, assistantMessageCount: assistantBlocks.length, turnIndex: target.turnIndex }
    : { success: false, error: 'No completed assistant response found' };
}

function parseCodexNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCodexReset(value) {
  if (value == null) return null;
  let timestampMs = null;
  if (typeof value === 'number' && Number.isFinite(value)) timestampMs = value * 1000;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    timestampMs = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed);
  }
  if (!Number.isFinite(timestampMs)) return null;
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeCodexLimitBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const used = parseCodexNumber(bucket.used_percent ?? bucket.utilization ?? bucket.usedPercent);
  const windowMinutes = parseCodexNumber(bucket.window_minutes ?? bucket.windowMinutes);
  return {
    utilization: used != null && used >= 0 && used <= 100 ? used : null,
    resets_at: normalizeCodexReset(bucket.resets_at ?? bucket.resetsAt ?? bucket.reset_at ?? bucket.resetAt),
    window_minutes: windowMinutes,
  };
}

function codexWindowMatchesMinutes(bucket, expectedMinutes) {
  const minutes = Number(bucket?.window_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  return Math.abs(minutes - expectedMinutes) <= expectedMinutes * 0.05;
}

function buildCodexUsageFromRateLimits(rateLimits, timestamp = null, filePath = null) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const primary = normalizeCodexLimitBucket(rateLimits.primary);
  const secondary = normalizeCodexLimitBucket(rateLimits.secondary);
  if (!primary && !secondary) return null;
  const buckets = [primary, secondary].filter(Boolean);
  const fiveHour = buckets.find((bucket) => codexWindowMatchesMinutes(bucket, 5 * 60)) || null;
  const sevenDay = buckets.find((bucket) => codexWindowMatchesMinutes(bucket, 7 * 24 * 60)) || null;
  return {
    primary,
    secondary,
    five_hour: fiveHour,
    seven_day: sevenDay,
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
  for (const candidate of candidates.slice(0, CODEX_LATEST_USAGE_FILE_LIMIT)) {
    try {
      const usage = await findLatestCodexUsageInFile(candidate.filePath, {
        maxBytes: CODEX_LATEST_USAGE_TAIL_BYTES,
      });
      if (usage) return usage;
    } catch {}
  }
  return null;
}

function latestCodexUsageInJsonlBuffer(buffer, filePath) {
  const lines = buffer.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      const payload = record?.payload || {};
      if (record?.type !== 'event_msg' || payload.type !== 'token_count') continue;
      const usage = buildCodexUsageFromRateLimits(payload.rate_limits, recordTimestamp(record), filePath);
      if (usage) return usage;
    } catch {}
  }
  return null;
}

async function findLatestCodexUsageInFile(filePath, {
  maxBytes = CODEX_USAGE_TAIL_MAX_BYTES,
  chunkBytes = CODEX_USAGE_TAIL_CHUNK_BYTES,
} = {}) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) return null;

  const byteBudget = Math.max(1, Math.min(stat.size, Number(maxBytes) || CODEX_USAGE_TAIL_MAX_BYTES));
  const readChunkSize = Math.max(1, Math.min(byteBudget, Number(chunkBytes) || CODEX_USAGE_TAIL_CHUNK_BYTES));
  const fd = await fs.promises.open(filePath, 'r');
  let position = stat.size;
  let scanned = 0;
  let carry = Buffer.alloc(0);
  try {
    while (position > 0 && scanned < byteBudget) {
      const length = Math.min(readChunkSize, position, byteBudget - scanned);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(chunk, 0, length, start);
      if (bytesRead <= 0) break;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry]);
      scanned += bytesRead;
      position = start;

      if (start === 0) {
        return latestCodexUsageInJsonlBuffer(combined, filePath);
      }
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline < 0) {
        carry = combined;
        continue;
      }
      const usage = latestCodexUsageInJsonlBuffer(combined.subarray(firstNewline + 1), filePath);
      if (usage) return usage;
      carry = combined.subarray(0, firstNewline);
    }
    return null;
  } finally {
    await fd.close();
  }
}

async function loadLatestCodexUsageForSession(sessionId, cwd) {
  const found = await findCodexSessionFile(sessionId, cwd, { allowContentScan: false });
  if (!found) return { success: false, error: 'Session not found' };
  const usage = await findLatestCodexUsageInFile(found.filePath);
  return { success: true, usage, filePath: found.filePath };
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

function codexRateBucketForWindow(rateLimits, semanticKey, expectedMinutes, legacyKey) {
  const explicit = rateLimits?.[semanticKey];
  if (explicit && typeof explicit === 'object') return explicit;
  const candidates = [rateLimits?.primary, rateLimits?.secondary]
    .filter((bucket) => bucket && typeof bucket === 'object');
  const matched = candidates.find((bucket) => {
    const directMinutes = parseCodexNumber(bucket.window_minutes ?? bucket.windowMinutes);
    const seconds = parseCodexNumber(bucket.limit_window_seconds ?? bucket.window_seconds ?? bucket.limitWindowSeconds);
    const minutes = directMinutes ?? (seconds != null ? seconds / 60 : null);
    return minutes != null && Math.abs(minutes - expectedMinutes) <= expectedMinutes * 0.05;
  });
  return matched || rateLimits?.[legacyKey] || null;
}

function codexRateResetEpoch(bucket) {
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

function compareCodexResetGeneration(next, prev, semanticKey, expectedMinutes, legacyKey) {
  const nextReset = codexRateResetEpoch(codexRateBucketForWindow(next.rateLimits, semanticKey, expectedMinutes, legacyKey));
  const prevReset = codexRateResetEpoch(codexRateBucketForWindow(prev.rateLimits, semanticKey, expectedMinutes, legacyKey));
  const diff = nextReset - prevReset;
  if (Math.abs(diff) <= CODEX_RESET_DRIFT_TOLERANCE_SECONDS) return 0;
  return diff;
}

function compareCodexRateSnapshotFreshness(next, prev) {
  if (!prev) return 1;
  if (!next) return -1;

  const weeklyGeneration = compareCodexResetGeneration(next, prev, 'seven_day', 7 * 24 * 60, 'secondary');
  if (weeklyGeneration !== 0) return weeklyGeneration;

  const fiveHourGeneration = compareCodexResetGeneration(next, prev, 'five_hour', 5 * 60, 'primary');
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
      primary: usage.primary || null,
      secondary: usage.secondary || null,
      five_hour: usage.five_hour || null,
      seven_day: usage.seven_day || null,
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

function readCurrentCodexAuthSession() {
  if (!fs.existsSync(CODEX_AUTH_JSON)) return null;
  const raw = safeJsonParse(fs.readFileSync(CODEX_AUTH_JSON, 'utf8'), null);
  const tokens = raw?.tokens || {};
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const accessPayload = decodeBase64UrlJson(accessToken.split('.')[1]);
  const idPayload = decodeBase64UrlJson(String(tokens.id_token || '').split('.')[1]);
  const authClaims = accessPayload?.['https://api.openai.com/auth']
    || idPayload?.['https://api.openai.com/auth']
    || {};
  const profileClaims = accessPayload?.['https://api.openai.com/profile']
    || idPayload?.['https://api.openai.com/profile']
    || {};
  const accountId = tokens.account_id || authClaims.chatgpt_account_id || null;
  const userId = authClaims.user_id || null;
  const email = profileClaims.email || idPayload?.email || accessPayload?.email || null;
  if (!accountId && !email && !accessToken) return null;
  return {
    accountId,
    userId,
    email,
    accessToken,
    authMode: raw?.auth_mode || null,
    tokenFingerprint: accessToken ? hashCodexAccountKey(accessToken) : null,
    accountKey: codexAccountKeyFromIdentity({ accountId, email }),
    accessExpiresAtMs: Number.isFinite(Number(accessPayload?.exp))
      ? Number(accessPayload.exp) * 1000
      : null,
    refreshedAtMs: parseTimestampMs(raw?.last_refresh),
  };
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

class CodexUsageFetchError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'CodexUsageFetchError';
    this.code = code;
    this.status = status;
  }
}

function normalizeCodexWhamWindow(raw, receivedAtMs) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = parseCodexNumber(raw.used_percent ?? raw.utilization ?? raw.usedPercent);
  if (usedPercent == null || usedPercent < 0 || usedPercent > 100) return null;

  let resetAt = parseCodexNumber(raw.reset_at ?? raw.resets_at ?? raw.resetAt ?? raw.resetsAt);
  if (resetAt == null || resetAt <= 0) {
    const resetAfter = parseCodexNumber(raw.reset_after_seconds ?? raw.resetAfterSeconds);
    resetAt = resetAfter != null && resetAfter >= 0
      ? Math.floor(receivedAtMs / 1000 + resetAfter)
      : null;
  }

  const windowSeconds = parseCodexNumber(raw.limit_window_seconds ?? raw.window_seconds ?? raw.limitWindowSeconds);
  const directWindowMinutes = parseCodexNumber(raw.window_minutes ?? raw.windowMinutes);
  const windowMinutes = windowSeconds != null && windowSeconds > 0
    ? windowSeconds / 60
    : directWindowMinutes;

  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes != null && windowMinutes > 0 ? windowMinutes : null,
    reset_at: resetAt,
  };
}

function buildCodexUsageFromWhamResponse(payload, receivedAtMs = Date.now()) {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') {
    throw new CodexUsageFetchError('invalid_response', 'OpenAI usage response has no rate limit');
  }

  const primary = normalizeCodexWhamWindow(rateLimit.primary_window ?? rateLimit.primary, receivedAtMs);
  const secondary = normalizeCodexWhamWindow(rateLimit.secondary_window ?? rateLimit.secondary, receivedAtMs);
  if (!primary && !secondary) {
    throw new CodexUsageFetchError('invalid_response', 'OpenAI usage response has no valid windows');
  }

  return buildCodexUsageFromRateLimits({
    limit_id: 'codex',
    limit_name: null,
    primary,
    secondary,
    credits: payload?.credits || rateLimit.credits || null,
    individual_limit: rateLimit.individual_limit || payload?.spend_control?.individual_limit || null,
    plan_type: payload?.plan_type || rateLimit.plan_type || null,
    rate_limit_reached_type: payload?.rate_limit_reached_type || rateLimit.rate_limit_reached_type || null,
  }, new Date(receivedAtMs).toISOString(), null);
}

function codexUsageErrorMessage(error) {
  const code = error?.code;
  if (code === 'auth_missing') return 'Codex is not signed in with a ChatGPT account.';
  if (code === 'unauthorized') return 'Codex login expired. Sign in to Codex again.';
  if (code === 'account_mismatch') return 'OpenAI returned usage for a different Codex account.';
  if (code === 'account_changed') return 'Codex account changed while usage was updating.';
  if (code === 'timeout') return 'OpenAI usage request timed out.';
  if (code === 'rate_limited') return 'OpenAI usage is temporarily rate limited.';
  if (code === 'invalid_response') return 'OpenAI returned an invalid usage response.';
  if (code === 'inconsistent_response') return 'OpenAI returned inconsistent usage. Try refreshing again.';
  if (code === 'server_error') return `OpenAI usage request failed (${error?.status || 'server error'}).`;
  return 'Could not refresh OpenAI usage.';
}

function canonicalizeCodexUsage(usage, previousUsage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const fiveHour = usage.five_hour || previousUsage?.five_hour || null;
  const sevenDay = usage.seven_day || previousUsage?.seven_day || null;
  if (!fiveHour && !sevenDay) return null;
  return {
    ...usage,
    primary: fiveHour ? { ...fiveHour, window_minutes: 5 * 60 } : null,
    secondary: sevenDay ? { ...sevenDay, window_minutes: 7 * 24 * 60 } : null,
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
}

function codexUsageWindowSnapshot(usage, key) {
  const bucket = usage?.[key];
  if (!bucket || typeof bucket !== 'object') return null;
  const utilization = parseCodexNumber(bucket.utilization);
  if (utilization == null || utilization < 0 || utilization > 100) return null;
  const resetMs = parseTimestampMs(bucket.resets_at);
  return {
    utilization,
    resetMs: Number.isFinite(resetMs) ? resetMs : null,
  };
}

function codexUsageSnapshotsMatch(leftUsage, rightUsage) {
  for (const key of ['five_hour', 'seven_day']) {
    const left = codexUsageWindowSnapshot(leftUsage, key);
    const right = codexUsageWindowSnapshot(rightUsage, key);
    if (!left && !right) continue;
    if (!left || !right) return false;
    if (Math.abs(left.utilization - right.utilization) > 12) return false;
    if (left.resetMs == null || right.resetMs == null) {
      if (left.resetMs !== right.resetMs) return false;
    } else if (Math.abs(left.resetMs - right.resetMs) > CODEX_USAGE_BRANCH_RESET_TOLERANCE_SECONDS * 1000) {
      return false;
    }
  }
  return true;
}

function classifyCodexUsageSnapshot(previousUsage, candidateUsage, nowMs = Date.now()) {
  let suspicious = false;
  let olderWindows = 0;

  for (const key of ['five_hour', 'seven_day']) {
    const previous = codexUsageWindowSnapshot(previousUsage, key);
    const candidate = codexUsageWindowSnapshot(candidateUsage, key);
    if (!previous || !candidate) continue;

    const previousResetElapsed = previous.resetMs != null && previous.resetMs <= nowMs;
    if (previous.resetMs != null && candidate.resetMs != null) {
      const resetDeltaMs = candidate.resetMs - previous.resetMs;
      if (resetDeltaMs < -CODEX_USAGE_BRANCH_RESET_TOLERANCE_SECONDS * 1000) olderWindows += 1;
      if (!previousResetElapsed && Math.abs(resetDeltaMs) > CODEX_USAGE_BRANCH_RESET_TOLERANCE_SECONDS * 1000) {
        suspicious = true;
      }
    }

    if (!previousResetElapsed
      && previous.utilization - candidate.utilization >= CODEX_USAGE_REGRESSION_POINTS) {
      suspicious = true;
    }
  }

  if (olderWindows > 0) return 'obsolete';
  return suspicious ? 'suspicious' : 'accept';
}

function reconcileCodexUsageSnapshot(previousEntry, candidateResult, nowMs = Date.now()) {
  const previousAccount = previousEntry?.account || null;
  const candidateAccount = candidateResult?.account || null;
  const candidateUsage = canonicalizeCodexUsage(candidateAccount?.usage, previousAccount?.usage);
  if (!candidateAccount || !candidateUsage) {
    return { entry: previousEntry || null, status: 'invalid', accepted: false };
  }

  const normalizedCandidate = {
    ...candidateResult,
    account: { ...candidateAccount, usage: candidateUsage, timestamp: candidateUsage.timestamp || candidateAccount.timestamp || null },
  };
  if (!previousAccount?.usage) {
    return {
      entry: {
        account: normalizedCandidate.account,
        fetchedAt: normalizedCandidate.fetchedAt || nowMs,
        pending: null,
        warning: null,
      },
      status: 'accepted',
      accepted: true,
    };
  }

  const classification = classifyCodexUsageSnapshot(previousAccount.usage, candidateUsage, nowMs);
  if (classification === 'accept') {
    return {
      entry: {
        ...previousEntry,
        account: normalizedCandidate.account,
        fetchedAt: normalizedCandidate.fetchedAt || nowMs,
        pending: null,
        warning: null,
      },
      status: 'accepted',
      accepted: true,
    };
  }

  if (classification === 'obsolete') {
    return {
      entry: {
        ...previousEntry,
        pending: null,
        warning: CODEX_USAGE_INCONSISTENT_WARNING,
      },
      status: 'obsolete',
      accepted: false,
    };
  }

  const pending = previousEntry?.pending || null;
  const pendingMatches = pending?.account?.usage
    && codexUsageSnapshotsMatch(pending.account.usage, candidateUsage);
  if (pendingMatches && nowMs - Number(pending.firstSeenAt || nowMs) >= CODEX_USAGE_PENDING_CONFIRM_MS) {
    return {
      entry: {
        ...previousEntry,
        account: normalizedCandidate.account,
        fetchedAt: normalizedCandidate.fetchedAt || nowMs,
        pending: null,
        warning: null,
      },
      status: 'confirmed',
      accepted: true,
    };
  }

  return {
    entry: {
      ...previousEntry,
      pending: {
        account: normalizedCandidate.account,
        fetchedAt: normalizedCandidate.fetchedAt || nowMs,
        firstSeenAt: pendingMatches ? pending.firstSeenAt : nowMs,
        lastSeenAt: nowMs,
      },
      warning: CODEX_USAGE_INCONSISTENT_WARNING,
    },
    status: 'pending',
    accepted: false,
  };
}

function selectCodexInitialUsageConsensus(results) {
  const candidates = (Array.isArray(results) ? results : [])
    .filter((result) => result?.account?.usage);
  let bestGroup = [];
  for (const candidate of candidates) {
    const group = candidates.filter((other) => (
      candidate.account.accountKey === other.account.accountKey
      && codexUsageSnapshotsMatch(candidate.account.usage, other.account.usage)
    ));
    if (group.length > bestGroup.length) bestGroup = group;
  }
  if (bestGroup.length < 2) return null;
  return bestGroup.reduce((latest, candidate) => (
    Number(candidate.fetchedAt || 0) >= Number(latest.fetchedAt || 0) ? candidate : latest
  ));
}

function sanitizeCodexPersistedAccount(raw) {
  const accountKey = typeof raw?.accountKey === 'string' ? raw.accountKey.trim().slice(0, 160) : '';
  if (!accountKey) return null;
  const rawLabel = typeof raw?.label === 'string' ? raw.label.trim().slice(0, 80) : '';
  const rawHint = typeof raw?.accountHint === 'string' ? raw.accountHint.trim().slice(0, 80) : '';
  const label = rawLabel.includes('@') ? maskCodexEmail(rawLabel) : rawLabel;
  const accountHint = rawHint.includes('@') ? maskCodexEmail(rawHint) : rawHint;
  const usage = canonicalizeCodexUsage(buildCodexUsageFromRateLimits({
    primary: raw?.usage?.five_hour || raw?.usage?.primary || null,
    secondary: raw?.usage?.seven_day || raw?.usage?.secondary || null,
    limit_id: 'codex',
    plan_type: typeof raw?.usage?.plan_type === 'string' ? raw.usage.plan_type.slice(0, 80) : null,
  }, normalizeCodexReset(raw?.usage?.timestamp || raw?.timestamp), null));
  if (!usage || !['five_hour', 'seven_day'].some((key) => codexUsageWindowSnapshot(usage, key))) return null;
  return {
    accountKey,
    label: label || 'Codex account',
    accountHint: accountHint || null,
    accountIdHint: null,
    plan_type: usage.plan_type,
    timestamp: usage.timestamp,
    sourceThreadId: null,
    source: 'openai-usage-api',
    usage,
  };
}

function serializeCodexUsageState(entries = codexRemoteUsageByAccount) {
  const accounts = [...entries.entries()]
    .map(([accountKey, entry]) => {
      const account = sanitizeCodexPersistedAccount({ ...entry?.account, accountKey });
      if (!account) return null;
      return {
        account,
        fetchedAt: Number(entry?.fetchedAt || 0) || 0,
        lastAttemptAt: Number(entry?.lastAttemptAt || 0) || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .slice(0, 8);
  return { version: 1, accounts };
}

function parseCodexUsageState(raw) {
  const parsed = typeof raw === 'string' ? safeJsonParse(raw, null) : raw;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) return [];
  return parsed.accounts.slice(0, 8).map((item) => {
    const account = sanitizeCodexPersistedAccount(item?.account);
    if (!account) return null;
    return {
      account,
      tokenFingerprint: null,
      fetchedAt: Number(item?.fetchedAt || 0) || 0,
      lastAttemptAt: Number(item?.lastAttemptAt || 0) || null,
      error: null,
      errorAt: 0,
      pending: null,
      warning: null,
    };
  }).filter(Boolean);
}

function hydrateCodexUsageState() {
  if (codexUsageStateHydrated) return;
  codexUsageStateHydrated = true;
  if (!codexUsageStateStore?.getAppState) return;
  try {
    for (const entry of parseCodexUsageState(codexUsageStateStore.getAppState(CODEX_USAGE_PERSISTENCE_KEY))) {
      codexRemoteUsageByAccount.set(entry.account.accountKey, entry);
    }
    pruneCodexRemoteUsageAccounts(null);
  } catch (error) {
    console.warn('[CodexData] could not restore usage accounts:', error?.message || String(error));
  }
}

function persistCodexUsageState() {
  if (!codexUsageStateStore?.setAppState) return;
  try {
    codexUsageStateStore.setAppState(CODEX_USAGE_PERSISTENCE_KEY, serializeCodexUsageState());
  } catch (error) {
    console.warn('[CodexData] could not persist usage accounts:', error?.message || String(error));
  }
}

async function fetchCodexUsageFromOpenAI(auth, {
  fetchImpl = global.fetch,
  timeoutMs = CODEX_REMOTE_USAGE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!auth?.accessToken || !auth?.accountId || !auth?.accountKey) {
    throw new CodexUsageFetchError('auth_missing', 'Missing Codex ChatGPT OAuth credentials');
  }
  if (typeof fetchImpl !== 'function') {
    throw new CodexUsageFetchError('network_error', 'Fetch is unavailable');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = now();
  try {
    const response = await fetchImpl(CODEX_USAGE_API_URL, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        Accept: 'application/json',
        'User-Agent': 'Noted Terminal',
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new CodexUsageFetchError('unauthorized', 'Codex OAuth token is invalid', response.status);
    }
    if (response.status === 429) {
      throw new CodexUsageFetchError('rate_limited', 'OpenAI usage endpoint is rate limited', response.status);
    }
    if (!response.ok) {
      throw new CodexUsageFetchError('server_error', 'OpenAI usage endpoint failed', response.status);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CodexUsageFetchError('invalid_response', 'OpenAI usage response is not JSON');
    }

    const expectedEmail = String(auth.email || '').trim().toLowerCase();
    const responseEmail = String(payload?.email || '').trim().toLowerCase();
    if (expectedEmail && responseEmail && expectedEmail !== responseEmail) {
      throw new CodexUsageFetchError('account_mismatch', 'OpenAI usage email does not match Codex auth');
    }
    const expectedUserId = String(auth.userId || '').trim();
    const responseUserId = String(payload?.user_id || payload?.account_id || '').trim();
    if (expectedUserId && responseUserId && expectedUserId !== responseUserId) {
      throw new CodexUsageFetchError('account_mismatch', 'OpenAI usage user does not match Codex auth');
    }
    const responseDateMs = Date.parse(response.headers?.get?.('date') || '');
    const receivedAtMs = Number.isFinite(responseDateMs) ? responseDateMs : now();
    const usage = buildCodexUsageFromWhamResponse(payload, receivedAtMs);
    const account = buildCodexActiveUsageAccount(auth, usage, null);
    if (!account) {
      throw new CodexUsageFetchError('invalid_response', 'OpenAI usage account is invalid');
    }
    return {
      account: {
        ...account,
        accountKey: auth.accountKey,
        source: 'openai-usage-api',
        isCurrent: true,
      },
      fetchedAt: now(),
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CodexUsageFetchError('timeout', 'OpenAI usage request timed out');
    }
    if (error instanceof CodexUsageFetchError) throw error;
    throw new CodexUsageFetchError('network_error', error?.message || String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function pruneCodexRemoteUsageAccounts(currentAccountKey = null) {
  if (codexRemoteUsageByAccount.size <= 8) return;
  const removable = [...codexRemoteUsageByAccount.entries()]
    .filter(([accountKey]) => accountKey !== currentAccountKey)
    .sort((a, b) => Number(a[1]?.fetchedAt || 0) - Number(b[1]?.fetchedAt || 0));
  while (codexRemoteUsageByAccount.size > 8 && removable.length > 0) {
    codexRemoteUsageByAccount.delete(removable.shift()[0]);
  }
}

function listCodexRemoteUsageAccounts(currentAccountKey = null) {
  const now = Date.now();
  return [...codexRemoteUsageByAccount.entries()]
    .map(([accountKey, entry]) => {
      if (!entry?.account) return null;
      const isCurrent = accountKey === currentAccountKey;
      return {
        ...entry.account,
        isCurrent,
        stale: !isCurrent || !!entry.error || !!entry.warning
          || now - Number(entry.fetchedAt || 0) > CODEX_REMOTE_USAGE_STALE_MS,
        lastError: entry.error || null,
        warning: entry.warning || null,
        lastAttemptAt: entry.lastAttemptAt || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (!!a.isCurrent !== !!b.isCurrent) return a.isCurrent ? -1 : 1;
      return codexAccountTimestampMs(b) - codexAccountTimestampMs(a);
    });
}

async function getCodexRemoteUsage({
  force = false,
  verifyInitial = false,
  fetchImpl = global.fetch,
  authReader = readCurrentCodexAuthSession,
  authRetryCount = 0,
} = {}) {
  hydrateCodexUsageState();
  let auth = authReader();
  if (!auth?.accessToken || !auth?.accountId || !auth?.accountKey) {
    return {
      accounts: listCodexRemoteUsageAccounts(null),
      currentAccountKey: null,
      error: codexUsageErrorMessage(new CodexUsageFetchError('auth_missing', 'Missing Codex auth')),
      warning: null,
      lastAttemptAt: null,
    };
  }

  const now = Date.now();
  const cached = codexRemoteUsageByAccount.get(auth.accountKey) || null;
  if (auth.accessExpiresAtMs && auth.accessExpiresAtMs <= now + 30_000) {
    const message = codexUsageErrorMessage(new CodexUsageFetchError('unauthorized', 'Codex access token expired'));
    codexRemoteUsageByAccount.set(auth.accountKey, {
      ...cached,
      tokenFingerprint: auth.tokenFingerprint,
      lastAttemptAt: now,
      error: message,
      errorAt: now,
    });
    return {
      accounts: listCodexRemoteUsageAccounts(auth.accountKey),
      currentAccountKey: auth.accountKey,
      error: message,
      warning: cached?.warning || null,
      lastAttemptAt: now,
    };
  }
  if (!force && cached?.account
    && now - cached.fetchedAt < CODEX_REMOTE_USAGE_CACHE_TTL_MS
    && cached.tokenFingerprint === auth.tokenFingerprint) {
    return {
      accounts: listCodexRemoteUsageAccounts(auth.accountKey),
      currentAccountKey: auth.accountKey,
      error: cached.error || null,
      warning: cached.warning || null,
      lastAttemptAt: cached.lastAttemptAt || cached.fetchedAt,
    };
  }
  if (!force && cached?.errorAt
    && cached.tokenFingerprint === auth.tokenFingerprint
    && now - cached.errorAt < CODEX_REMOTE_USAGE_ERROR_COOLDOWN_MS) {
    return {
      accounts: listCodexRemoteUsageAccounts(auth.accountKey),
      currentAccountKey: auth.accountKey,
      error: cached.error || null,
      warning: cached.warning || null,
      lastAttemptAt: cached.lastAttemptAt || cached.errorAt,
    };
  }

  const inflightKey = `${auth.accountKey}:${auth.tokenFingerprint || 'token'}`;
  let request = codexRemoteUsageInflight.get(inflightKey);
  if (!request) {
    request = (async () => {
      const attemptAuth = auth;
      let result;
      try {
        result = await fetchCodexUsageFromOpenAI(attemptAuth, { fetchImpl });
        const acceptedEntry = codexRemoteUsageByAccount.get(attemptAuth.accountKey);
        if (verifyInitial && !acceptedEntry?.account?.usage) {
          const confirmations = await Promise.allSettled([
            fetchCodexUsageFromOpenAI(attemptAuth, {
              fetchImpl,
              timeoutMs: CODEX_USAGE_INITIAL_CONFIRM_TIMEOUT_MS,
            }),
            fetchCodexUsageFromOpenAI(attemptAuth, {
              fetchImpl,
              timeoutMs: CODEX_USAGE_INITIAL_CONFIRM_TIMEOUT_MS,
            }),
          ]);
          const consensus = selectCodexInitialUsageConsensus([
            result,
            ...confirmations
              .filter((confirmation) => confirmation.status === 'fulfilled')
              .map((confirmation) => confirmation.value),
          ]);
          if (!consensus) {
            throw new CodexUsageFetchError('inconsistent_response', 'Initial OpenAI usage responses did not agree');
          }
          result = consensus;
        }
      } catch (error) {
        error.authSnapshot = attemptAuth;
        throw error;
      }
      const currentAuth = authReader();
      const authStayedCurrent = currentAuth?.accountKey === attemptAuth.accountKey
        && currentAuth?.tokenFingerprint === attemptAuth.tokenFingerprint;
      if (authStayedCurrent) return { ...result, auth: currentAuth };
      const error = new CodexUsageFetchError('account_changed', 'Codex auth changed during usage request');
      error.authSnapshot = attemptAuth;
      throw error;
    })();
    codexRemoteUsageInflight.set(inflightKey, request);
    request.finally(() => {
      if (codexRemoteUsageInflight.get(inflightKey) === request) {
        codexRemoteUsageInflight.delete(inflightKey);
      }
    }).catch(() => {});
  }

  const lastAttemptAt = Date.now();
  try {
    const result = await request;
    auth = result.auth || authReader() || auth;
    const previous = codexRemoteUsageByAccount.get(result.account.accountKey) || null;
    const reconciled = reconcileCodexUsageSnapshot(previous, result, lastAttemptAt);
    const nextEntry = {
      ...(reconciled.entry || previous || {}),
      tokenFingerprint: auth.tokenFingerprint,
      lastAttemptAt,
      error: null,
      errorAt: 0,
    };
    codexRemoteUsageByAccount.set(result.account.accountKey, nextEntry);
    pruneCodexRemoteUsageAccounts(auth.accountKey);
    if (reconciled.accepted) persistCodexUsageState();
    console.log('[CodexData] remote usage ' + reconciled.status + ' account=' + result.account.label +
      ' candidate=' + codexUsagePercentSummary(result.account.usage) +
      ' shown=' + codexUsagePercentSummary(nextEntry.account?.usage) +
      ' durMs=' + result.durationMs);
    return {
      accounts: listCodexRemoteUsageAccounts(auth.accountKey),
      currentAccountKey: auth.accountKey,
      error: null,
      warning: nextEntry.warning || null,
      lastAttemptAt,
    };
  } catch (error) {
    const latestAuth = authReader();
    const failedAuth = error?.authSnapshot || auth;
    const latestAuthIsUsable = !!(latestAuth?.accessToken && latestAuth?.accountId && latestAuth?.accountKey);
    const authChanged = !latestAuthIsUsable
      || latestAuth.accountKey !== failedAuth.accountKey
      || latestAuth.tokenFingerprint !== failedAuth.tokenFingerprint;
    if (authChanged) {
      if (latestAuthIsUsable && authRetryCount < 1) {
        return getCodexRemoteUsage({
          force: false,
          verifyInitial,
          fetchImpl,
          authReader,
          authRetryCount: authRetryCount + 1,
        });
      }
      const changedError = latestAuthIsUsable
        ? new CodexUsageFetchError('account_changed', 'Codex auth changed during usage request')
        : new CodexUsageFetchError('auth_missing', 'Missing Codex auth');
      return {
        accounts: listCodexRemoteUsageAccounts(latestAuthIsUsable ? latestAuth.accountKey : null),
        currentAccountKey: latestAuthIsUsable ? latestAuth.accountKey : null,
        error: codexUsageErrorMessage(changedError),
        warning: null,
        lastAttemptAt,
      };
    }
    const message = codexUsageErrorMessage(error);
    const errorAccountKey = latestAuth?.accountKey || failedAuth.accountKey;
    const previous = codexRemoteUsageByAccount.get(errorAccountKey)
      || (cached?.account?.accountKey === errorAccountKey ? cached : null);
    codexRemoteUsageByAccount.set(errorAccountKey, {
      ...previous,
      tokenFingerprint: latestAuth?.tokenFingerprint || failedAuth.tokenFingerprint,
      lastAttemptAt,
      error: message,
      errorAt: Date.now(),
    });
    pruneCodexRemoteUsageAccounts(errorAccountKey);
    console.warn('[CodexData] remote usage failed account=' +
      (maskCodexEmail(latestAuth?.email || failedAuth.email) || shortCodexId(latestAuth?.accountId || failedAuth.accountId) || 'unknown') +
      ' code=' + (error?.code || 'network_error') +
      ' status=' + (error?.status || 'none'));
    return {
      accounts: listCodexRemoteUsageAccounts(errorAccountKey),
      currentAccountKey: errorAccountKey,
      error: message,
      warning: previous?.warning || null,
      lastAttemptAt,
    };
  }
}

function mergeCodexPreferredAccounts(accounts, preferredAccounts) {
  const byKey = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (account?.accountKey) byKey.set(account.accountKey, account);
  }
  for (const account of Array.isArray(preferredAccounts) ? preferredAccounts : []) {
    if (account?.accountKey) byKey.set(account.accountKey, account);
  }
  return [...byKey.values()].sort((a, b) => {
    if (!!a.isCurrent !== !!b.isCurrent) return a.isCurrent ? -1 : 1;
    return codexAccountTimestampMs(b) - codexAccountTimestampMs(a);
  });
}

function resetCodexUsageStateForTests() {
  codexRemoteUsageByAccount.clear();
  codexRemoteUsageInflight.clear();
  codexUsageStateStore = null;
  codexUsageStateHydrated = false;
}

function setCodexUsageStateStoreForTests(store) {
  codexUsageStateStore = store || null;
  codexUsageStateHydrated = false;
  hydrateCodexUsageState();
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
      stale: codexUsageAccountIsStale({ usage: activeUsage, timestamp: activeUsage.timestamp }),
      lastError: null,
    };
  });
  return changed ? merged : accounts;
}

function codexUsagePercentSummary(usage) {
  const weekly = usage?.seven_day || null;
  const fiveHour = usage?.five_hour || null;
  return 'weekly=' + (weekly?.utilization ?? 'null') +
    ' fiveHour=' + (fiveHour?.utilization ?? 'null');
}

function codexAccountTimestampMs(account) {
  const ms = parseTimestampMs(account?.timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

function codexUsageAccountIsStale(account, now = Date.now()) {
  if (!account?.usage) return true;
  if (typeof account.stale === 'boolean') return account.stale;
  const timestampMs = codexAccountTimestampMs(account);
  if (!timestampMs) return true;
  return now - timestampMs > 6 * 60 * 1000;
}

function codexActiveUsageMatchesSelected({
  activeUsage,
  activeAccountKey,
  selectedAccountKey,
  sessionId,
  selectedSourceThreadId,
}) {
  if (!activeUsage) return false;
  if (!selectedAccountKey) return !!activeAccountKey;
  if (activeAccountKey) return activeAccountKey === selectedAccountKey;
  return !!sessionId && selectedSourceThreadId === sessionId;
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
          stale: codexUsageAccountIsStale(activeAccount),
          lastError: null,
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
      const weekly = a.usage?.seven_day || null;
      const fiveHour = a.usage?.five_hour || null;
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
      usageAccountsLastErrorAt = 0;
      console.log('[CodexData] usage accounts refresh done count=' + mergedAccounts.length +
        ' durMs=' + (Date.now() - startedAt));
      return mergedAccounts;
    })
    .catch((error) => {
      const rawError = error?.message || String(error);
      const durationMs = Date.now() - startedAt;
      usageAccountsLastError = durationMs >= 14_500
        ? 'Local Codex usage cache refresh timed out.'
        : 'Local Codex usage cache could not be refreshed.';
      usageAccountsLastErrorAt = Date.now();
      usageAccountsCache = {
        ts: Date.now(),
        accounts: usageAccountsCache?.accounts || [],
      };
      console.warn('[CodexData] usage accounts refresh failed durMs=' + (Date.now() - startedAt) +
        ' error=' + compactPreview(rawError, 240));
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
      stale: !!usageAccountsLastError,
      refreshing: !!usageAccountsRefreshInFlight,
      cacheAgeMs,
      lastAttemptAt: usageAccountsLastAttemptAt,
      error: usageAccountsLastError,
    };
  }

  if (!force && usageAccountsLastErrorAt && now - usageAccountsLastErrorAt < USAGE_ACCOUNTS_ERROR_COOLDOWN_MS) {
    const accounts = mergeCodexActiveOverridesIntoAccounts(cache?.accounts || [], { reason: 'error-cooldown' });
    return {
      accounts,
      stale: true,
      refreshing: false,
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

function getCodexUsageAccountsSnapshot(reason = 'snapshot') {
  const now = Date.now();
  const cache = usageAccountsCache;
  const accounts = mergeCodexActiveOverridesIntoAccounts(cache?.accounts || [], { reason });
  if (cache && accounts !== cache.accounts) usageAccountsCache = { ...cache, accounts };
  return {
    accounts,
    stale: !!usageAccountsLastError || !cache,
    refreshing: !!usageAccountsRefreshInFlight,
    cacheAgeMs: cache ? now - cache.ts : null,
    lastAttemptAt: usageAccountsLastAttemptAt,
    error: usageAccountsLastError,
  };
}

function shouldLoadCodexFallbackUsage(remoteResult, requestedAccountKey = null) {
  const remoteAccounts = Array.isArray(remoteResult?.accounts) ? remoteResult.accounts : [];
  if (requestedAccountKey) {
    const requested = remoteAccounts.find((account) => account?.accountKey === requestedAccountKey);
    if (requested?.source === 'openai-usage-api' && requested?.usage) return false;
    if (!requested) return true;
    return !requested.isCurrent || !!requested.stale;
  }
  if (remoteAccounts.some((account) => account?.isCurrent && account?.usage)) return false;
  return !!remoteResult?.error || remoteAccounts.length === 0;
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
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', defaultEffort: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-5.4', label: 'GPT-5.4', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', defaultEffort: 'medium', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ];
    const finish = (models) => {
      const value = models.length > 0 ? models : fallback;
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

function register({ projectManager } = {}) {
  codexUsageStateStore = projectManager?.db || null;
  codexUsageStateHydrated = false;
  hydrateCodexUsageState();
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
      if (params.assistantOnly) {
        const context = buildCodexTurnAssistantContext(
          loaded.records,
          sessionId,
          startUuid,
          params.maxChars
        );
        return context.success ? { ...context, filePath: loaded.filePath } : context;
      }
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

  ipcMain.handle('codex:delete-range', async (_event, params = {}) => {
    try {
      return await deleteCodexRange(params);
    } catch (error) {
      console.error('[CodexData] delete-range error:', error);
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
      const remoteResult = await getCodexRemoteUsage({
        force: !!opts?.force,
        verifyInitial: true,
      });
      // The local log is discovery/fallback only. A healthy OpenAI response
      // must not start or wait for a multi-gigabyte log scan.
      const needsFallback = shouldLoadCodexFallbackUsage(remoteResult, opts?.accountKey);
      const accountResult = needsFallback
        ? await getCodexUsageAccountsFast({ force: false, reason: 'ipc-fallback' })
        : getCodexUsageAccountsSnapshot('ipc-server-primary');
      let accountUsages = mergeCodexPreferredAccounts(
        accountResult.accounts || [],
        remoteResult.accounts || []
      );

      let activeUsage = null;
      let activeIdentity = null;
      let activeAccountKey = null;
      if (needsFallback && opts?.sessionId) {
        try {
          const [identity, loaded] = await Promise.all([
            resolveAfterBudget(
              findCodexAccountIdentityForThread(opts.sessionId).catch(() => null),
              1000,
              null
            ),
            loadLatestCodexUsageForSession(opts.sessionId, opts.cwd)
              .catch((error) => ({ success: false, error: error?.message || String(error) })),
          ]);
          activeIdentity = identity;
          if (loaded?.success) {
            activeUsage = loaded.usage || null;
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
      accountUsages = mergeCodexPreferredAccounts(
        accountUsages,
        (remoteResult.accounts || []).filter((account) => account.isCurrent && !account.stale)
      );
      accountUsages = accountUsages.map((account) => ({
        ...account,
        isCurrent: account.accountKey === remoteResult.currentAccountKey,
        stale: codexUsageAccountIsStale(account),
      }));

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

      const activeMatchesSelected = codexActiveUsageMatchesSelected({
        activeUsage,
        activeAccountKey,
        selectedAccountKey,
        sessionId: opts?.sessionId,
        selectedSourceThreadId: selectedAccount?.sourceThreadId,
      });
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
      if (!usage && !accountResult.refreshing && !opts?.accountKey && accountUsages.length === 0) {
        usage = await findLatestCodexUsage();
        source = usage ? 'latest-rollout-unverified' : source;
      }

      if (selectedAccount?.source) source = selectedAccount.source;
      const selectedIsCurrent = !!selectedAccountKey
        && selectedAccountKey === remoteResult.currentAccountKey;
      const stale = selectedAccount
        ? codexUsageAccountIsStale(selectedAccount)
        : !!usage;
      const warning = selectedAccount && !selectedIsCurrent && stale
        ? 'Selected account is not the current Codex login. Showing its last known value.'
        : (selectedIsCurrent ? (remoteResult.warning || selectedAccount?.warning || null) : null);
      const relevantError = selectedIsCurrent
        ? remoteResult.error
        : (!usage ? (accountResult.error || remoteResult.error) : null);

      const weekly = usage?.seven_day?.utilization ?? null;
      const fiveHour = usage?.five_hour?.utilization ?? null;
      const accountLabel = selectedAccount?.label || accountUsages[0]?.label || 'none';
      console.log('[CodexData] get-usage source=' + source +
        ' accounts=' + accountUsages.length +
        ' selected=' + accountLabel +
        ' weekly=' + (weekly ?? 'null') +
        ' fiveHour=' + (fiveHour ?? 'null') +
        ' refreshing=0' +
        ' stale=' + (stale ? '1' : '0') +
        ' cacheAgeMs=' + (accountResult.cacheAgeMs ?? 'none') +
        ' session=' + (opts?.sessionId ? String(opts.sessionId).slice(0, 8) : 'none') +
        ' error=' + (relevantError ? compactPreview(relevantError, 120) : 'none'));

      return {
        success: true,
        data: usage,
        accounts: accountUsages,
        selectedAccountKey,
        currentAccountKey: remoteResult.currentAccountKey,
        source,
        refreshing: false,
        stale,
        cacheAgeMs: accountResult.cacheAgeMs,
        lastAttemptAt: selectedIsCurrent
          ? remoteResult.lastAttemptAt
          : accountResult.lastAttemptAt,
        lastSuccessAt: usage?.timestamp || null,
        warning,
        error: relevantError,
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
  buildCodexTurnAssistantContext,
  editCodexRange,
  deleteCodexRange,
  getTimelineSessionMeta,
  listCodexModels,
  invalidateCodexJsonlCache,
  _api: {
    listCodexModels,
    findCodexSessionFile,
    findLatestCodexSession,
    readCodexSessionMetadata,
    parseJsonlFile,
    readJsonlRange,
    getCodexJsonlCacheStats,
    codexCompactCompanionLines,
    invalidateJsonlCache: invalidateCodexJsonlCache,
    buildCodexCleanEntries,
    buildCodexCleanExport,
    buildCodexRangeExport,
    buildCodexTurnAssistantContext,
    buildCodexVisibleRecordWrappers,
    planCodexRangeRewrite,
    writeCodexJsonlExclusive,
    editCodexRange,
    deleteCodexRange,
    loadSessionRecords,
    buildCodexFullHistory,
    buildCodexTimeline,
    findCodexExecNestedCalls,
    resolveSimpleJsCallValue,
    parseApplyPatchHistoryActions,
    codexHistoryActionsForCall,
    getTimelineSessionMeta,
    latestCodexUsageInRecords,
    findLatestCodexUsage,
    findLatestCodexUsageAccounts,
    getCodexUsageAccountsFast,
    compareCodexRateSnapshotFreshness,
    compareCodexUsageFreshness,
    normalizeCodexWhamWindow,
    buildCodexUsageFromWhamResponse,
    buildCodexUsageFromRateLimits,
    canonicalizeCodexUsage,
    codexUsageSnapshotsMatch,
    classifyCodexUsageSnapshot,
    reconcileCodexUsageSnapshot,
    selectCodexInitialUsageConsensus,
    serializeCodexUsageState,
    parseCodexUsageState,
    fetchCodexUsageFromOpenAI,
    getCodexRemoteUsage,
    readCurrentCodexAuthSession,
    mergeCodexPreferredAccounts,
    codexUsageAccountIsStale,
    codexActiveUsageMatchesSelected,
    shouldLoadCodexFallbackUsage,
    findLatestCodexUsageInFile,
    resetCodexUsageStateForTests,
    setCodexUsageStateStoreForTests,
    findCodexAccountIdentityForThread,
    codexAccountKeyFromIdentity,
    rememberCodexActiveUsageOverride,
    mergeCodexActiveOverridesIntoAccounts,
  },
};
