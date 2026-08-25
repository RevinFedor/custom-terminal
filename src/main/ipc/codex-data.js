const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  buildHistoryRevision,
  validateHistoryRevision,
} = require('../history-revision');
const { buildChildProcessEnv } = require('../child-process-env');
const {
  createCodexSubagentTracker,
  isCodexSubagentControlCall,
  isCodexSubagentSpawnCall,
} = require('../codex-subagent-cards');
const {
  findCodexAgentFile,
  readAgentCompletionProof,
} = require('../subagent-transcript');
const {
  getCodexProcessActionGeneration,
} = require('../codex-process-action-ownership');
const { promptFingerprint } = require('../claude-prompt-carriers');
const { promptAuditFingerprint } = require('../prompt-audit-fingerprint');
const { classifyCodexTurnRecord } = require('../codex-turn-outcome');
const { resolveCodexSourceSettingsProof } = require('../codex-source-settings');
const {
  codexUserCarrierTextsMatch,
  codexUserMessageAuditText,
  codexUserMessagePresentationText,
  groupCodexPreferredUserMessageAuditRecords,
  isCodexEnvironmentContextUserText,
  isCodexGoalContinuationUserText,
  isCodexProjectInstructionsUserText,
} = require('../codex-prompt-audit');
const {
  RESULT_PROOF_CODES,
} = require('../orchestration-result-proof');
const {
  classifyHistoryAction,
  historyActionPresentationMeta,
} = require(path.join(__dirname, '..', '..', 'shared', 'history-action-grammar.cjs'));
const {
  formatCopyAction,
} = require('../copy-action-format');
const {
  deriveCodexForkSnapshot,
  mapTimelineEntryUuidsAcrossFork,
} = require('../session-history-events');
const {
  CodexAccountProfileManager,
  DEFAULT_PROFILE_ID,
} = require('../codex-account-profiles');
const {
  buildCodexHistoryContextItem,
} = require('../agent-history-context-injection');
const { execFile } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const CODEX_LOGS_DB = path.join(CODEX_HOME, 'logs_2.sqlite');
const CODEX_USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESET_CREDITS_API_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_ACCOUNTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USAGE_ACCOUNTS_FOREGROUND_BUDGET_MS = 1200;
const USAGE_ACCOUNTS_ERROR_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const CODEX_REMOTE_USAGE_CACHE_TTL_MS = 55 * 1000;
const CODEX_REMOTE_USAGE_STALE_MS = 6 * 60 * 1000;
const CODEX_REMOTE_USAGE_ERROR_COOLDOWN_MS = 60 * 1000;
const CODEX_REMOTE_USAGE_TIMEOUT_MS = 8 * 1000;
const CODEX_RESET_CREDITS_TIMEOUT_MS = 4 * 1000;
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
const CODEX_COMPACT_RAW_IMAGES = Symbol('codexCompactRawImages');
// Raw file bytes are only a lower bound: parsed JSON strings/objects cost
// substantially more. Keep one oversized active rollout if necessary, but do
// not retain an unbounded collection of fully parsed sessions forever.
const CODEX_JSONL_CACHE_MAX_RAW_BYTES = 768 * 1024 * 1024;
// The byte budget is the real memory bound; the file cap only limits entry
// count. At 3, a workspace with a couple of open codex tabs plus usage/
// timeline reads of other sessions evicted the ACTIVE 73MB rollout between
// its own refreshes — every live append then cost a full 3.1s re-parse
// instead of the incremental range read (tab-3163, 06.08 11:37 loadMs=3147).
const CODEX_JSONL_CACHE_MAX_FILES = 6;
// Потолок на ОДИН файл, который вообще разрешено разбирать в память целиком.
//
// Почему он обязан быть: в проде лежат пять файлов больше гигабайта (максимум
// 1369 МБ). Разобранные объекты стоят кратно больше исходных байтов, поэтому
// один такой разбор гарантированно убивает процесс — «нехватка памяти» и
// мгновенное закрытие приложения без единой строки в логе. Именно так ушёл
// вылет 19.08 08:41: за три минуты память поднялась с 2.0 до 3.6 ГБ на потоке
// полных чтений, среди которых был файл на 717 МБ.
//
// Потолок считается по размеру на диске, а картинки внутри сжатий отбрасываются
// ещё до разбора (см. stripCompactedInlineImages), поэтому фактический вес в
// памяти в разы меньше числа ниже. Замерено на реальном файле пользователя
// (1340 МБ): без обрезки разбор занимает 1725 МБ памяти, с обрезкой — 532 МБ.
// 1.5 ГБ на диске — это заведомо выше любого файла, который встречается в
// проде (максимум 1369 МБ), и заведомо ниже того, что убивает процесс после
// обрезки. Отказ здесь честный и виден в логе; молчаливое падение всего
// приложения — нет.
const CODEX_JSONL_PARSE_MAX_BYTES = 1536 * 1024 * 1024;
const CODEX_SESSION_META_HEAD_MAX_BYTES = 512 * 1024;
const CODEX_SESSION_META_HEAD_CHUNK_BYTES = 16 * 1024;
const CODEX_SESSION_META_HEAD_MAX_RECORDS = 32;

let modelCache = null;
let modelCacheInflight = null;
let usageAccountsCache = null;
let usageAccountsRefreshInFlight = null;
let usageAccountsLastAttemptAt = null;
let usageAccountsLastError = null;
let usageAccountsLastErrorAt = 0;
let codexUsageStateStore = null;
let codexUsageStateHydrated = false;
let codexAccountProfileManager = null;
let codexAccountProfileCleanupBound = false;
const codexRemoteUsageByAccount = new Map();
const codexRemoteUsageInflight = new Map();
const codexActiveUsageOverrides = new Map();
const loggedRollbackKeys = new Set();
const _codexJsonlCache = new Map();
let _codexJsonlCacheRawBytes = 0;
const _codexSessionSelectSkipLogged = new Set();
const _codexJsonlInflight = new Map();
const _codexHistoryContextInflight = new Map();

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

async function getCodexJsonlSourceSnapshot(filePath, sessionId) {
  const cached = _codexJsonlCache.get(filePath);
  if (cached) {
    return {
      filePath,
      size: cached.size,
      mtimeMs: cached.mtimeMs,
      sessionId: sessionId || path.basename(filePath, '.jsonl'),
      linkKind: 'end',
    };
  }
  try {
    const stat = await fs.promises.stat(filePath);
    return {
      filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sessionId: sessionId || path.basename(filePath, '.jsonl'),
      linkKind: 'end',
    };
  } catch {
    return null;
  }
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

function codexRecordPhysicalSessionId(record, fallbackSessionId) {
  const physical = typeof record?.__physicalSessionId === 'string'
    ? record.__physicalSessionId.trim()
    : '';
  return physical || fallbackSessionId;
}

function stableUuidForRecord(fallbackSessionId, record, prefix = 'codex') {
  return stableUuid(codexRecordPhysicalSessionId(record, fallbackSessionId), record?.__line, prefix);
}

function stableSourceIdentity(sessionId, record, prefix = 'codex') {
  const physicalSessionId = codexRecordPhysicalSessionId(record, sessionId);
  const position = Number.isFinite(record?.__byteOffset)
    ? Number(record.__byteOffset)
    : Number(record?.__line ?? -1);
  return `${prefix}-source-${physicalSessionId || 'unknown'}-${position}`;
}

function addStableSourceIdentityAlias(entry, alias) {
  const normalized = typeof alias === 'string' ? alias.trim() : '';
  if (!entry || !normalized || normalized === entry.sourceIdentity) return;
  const aliases = Array.isArray(entry.sourceIdentityAliases)
    ? entry.sourceIdentityAliases.filter((value) => (
        typeof value === 'string'
        && value
        && value !== entry.sourceIdentity
      ))
    : [];
  if (!aliases.includes(normalized)) aliases.push(normalized);
  entry.sourceIdentityAliases = aliases;
}

function promoteStableSourceIdentity(entry, nextIdentity) {
  if (!entry || typeof nextIdentity !== 'string' || !nextIdentity) return;
  const previousIdentity = typeof entry.sourceIdentity === 'string'
    ? entry.sourceIdentity
    : '';
  entry.sourceIdentity = nextIdentity;
  const aliases = Array.isArray(entry.sourceIdentityAliases)
    ? entry.sourceIdentityAliases.filter((value) => (
        typeof value === 'string'
        && value
        && value !== nextIdentity
      ))
    : [];
  if (previousIdentity && previousIdentity !== nextIdentity && !aliases.includes(previousIdentity)) {
    aliases.push(previousIdentity);
  }
  if (aliases.length > 0) entry.sourceIdentityAliases = aliases;
  else delete entry.sourceIdentityAliases;
}

function codexPromptPresentationAuditIdentity(record, text) {
  const auditTimestamp = String(recordTimestamp(record) || '').trim();
  const transportHash = promptAuditFingerprint(text || '');
  return auditTimestamp && transportHash
    ? { auditTimestamp, transportHash }
    : null;
}

function addCodexPromptPresentationAuditAlias(entry, identity) {
  if (!entry || !identity?.auditTimestamp || !identity?.transportHash) return;
  if (
    entry.promptPresentationAuditTimestamp === identity.auditTimestamp
    && entry.promptPresentationTransportHash === identity.transportHash
  ) return;
  const aliases = Array.isArray(entry.promptPresentationAuditAliases)
    ? entry.promptPresentationAuditAliases.filter((candidate) => (
        candidate?.auditTimestamp
        && candidate?.transportHash
      ))
    : [];
  if (!aliases.some((candidate) => (
    candidate.auditTimestamp === identity.auditTimestamp
    && candidate.transportHash === identity.transportHash
  ))) aliases.push(identity);
  entry.promptPresentationAuditAliases = aliases;
}

function promoteCodexPromptPresentationAuditIdentity(entry, record, text) {
  if (!entry) return;
  const next = codexPromptPresentationAuditIdentity(record, text);
  if (!next) return;
  const previous = entry.promptPresentationAuditTimestamp
    && entry.promptPresentationTransportHash
    ? {
        auditTimestamp: entry.promptPresentationAuditTimestamp,
        transportHash: entry.promptPresentationTransportHash,
      }
    : null;
  if (previous) addCodexPromptPresentationAuditAlias(entry, previous);
  entry.promptPresentationAuditTimestamp = next.auditTimestamp;
  entry.promptPresentationTransportHash = next.transportHash;
  if (Array.isArray(entry.promptPresentationAuditAliases)) {
    entry.promptPresentationAuditAliases = entry.promptPresentationAuditAliases.filter((candidate) => !(
      candidate.auditTimestamp === next.auditTimestamp
      && candidate.transportHash === next.transportHash
    ));
    if (entry.promptPresentationAuditAliases.length === 0) {
      delete entry.promptPresentationAuditAliases;
    }
  }
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
  return docsIndex >= 0
    ? segs.slice(docsIndex).join('/')
    : baseName;
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

function addSemanticDocsEdits(entry, actions) {
  for (const action of Array.isArray(actions) ? actions : []) {
    const raw = action?.rawTool;
    if (!raw) continue;
    const presentation = historyActionPresentationMeta({
      toolName: raw.toolName,
      args: raw.args || {},
      family: raw.family,
      bashWord: raw.bashWord,
      bashDetail: raw.bashDetail,
      mcpServer: raw.mcpServer,
      mcpMethod: raw.mcpMethod,
    });
    if (presentation.docsKind !== 'edit') continue;
    const docsPath = presentation.targetLabel || presentation.targetKey;
    if (docsPath) addUniqueAttr(entry, 'docsEdited', docsPath);
  }
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
  // A backtick string with `${…}` in it is a TEMPLATE: its real value exists
  // only at runtime. Reading it as a finished literal is what put `${file}`
  // and `${content.split("` on screen as a file name and a diff — the parser
  // handed the source of the value to a card that promised the value itself.
  // Refusing it here lets the caller fall back to the authoritative
  // patch-apply event, which names the files that actually changed.
  let template = false;
  for (index += 1; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === quote) return (quote === '`' && template) ? null : { value, end: index + 1 };
    if (quote === '`' && ch === '$' && source[index + 1] === '{') template = true;
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

/**
 * Background cell id announced by Codex when a command keeps running.
 *
 * The announcement is a MACHINE line, and its id is always a plain number.
 * Matching `[^\s]+` anywhere in the output made any PROSE mentioning the
 * phrase look like a real announcement — and a tool output is mostly prose:
 * file contents, diffs, an agent quoting our own docs. Scar 2026-07-31
 * (prod tab-2634): a command printed our documentation sentence «Orchestrated
 * `exec` может вернуть `Script running with cell ID N`», the parser captured
 * "N`," as the cell id, and the card was filed away as background work under
 * an id no `wait` could ever name. Its spinner never stopped — 809 live tool
 * cards opened against 808 closed, and the one left over was whatever command
 * happened to be on screen.
 *
 * Anchoring to a line start and demanding digits keeps the real announcement
 * (a line of its own) and rejects every quotation of it: prose that mentions
 * the phrase mid-sentence no longer matches, and a literal `N` is not a
 * number. A false negative is cheap — the card stays inline and settles
 * normally; a false positive strands it forever.
 */
function codexHistoryCellId(rawOutput) {
  const text = codexHistoryOutputParts(rawOutput).join('\n');
  return /^\s*Script running with cell ID\s+(\d+)\s*$/m.exec(text)?.[1] || null;
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

function parseHistoryUnifiedDiffHunks(unifiedDiff) {
  if (typeof unifiedDiff !== 'string' || !unifiedDiff.includes('@@')) return null;
  const lines = unifiedDiff.split('\n');
  const hunks = [];
  let current = null;
  const flush = () => {
    if (!current) return true;
    const oldCount = current.entries.reduce(
      (count, entry) => count + (entry.tag === 'add' ? 0 : 1),
      0,
    );
    const newCount = current.entries.reduce(
      (count, entry) => count + (entry.tag === 'del' ? 0 : 1),
      0,
    );
    if (oldCount !== current.oldLines || newCount !== current.newLines) return false;
    hunks.push({
      oldStart: current.oldStart,
      newStart: current.newStart,
      entries: current.entries,
    });
    current = null;
    return true;
  };

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (!flush()) return null;
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] == null ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] == null ? 1 : Number(header[4]),
        entries: [],
      };
      continue;
    }
    if (!current || line === '\\ No newline at end of file' || line === '') continue;
    const prefix = line[0];
    if (prefix === ' ') current.entries.push({ tag: 'eq', line: line.slice(1) });
    else if (prefix === '+') current.entries.push({ tag: 'add', line: line.slice(1) });
    else if (prefix === '-') current.entries.push({ tag: 'del', line: line.slice(1) });
    else return null;
  }
  if (!flush()) return null;
  return hunks.length > 0 ? hunks : null;
}

function historyDiffHunkStrings(hunk) {
  return {
    old_string: hunk.entries
      .filter((entry) => entry.tag !== 'add')
      .map((entry) => entry.line)
      .join('\n'),
    new_string: hunk.entries
      .filter((entry) => entry.tag !== 'del')
      .map((entry) => entry.line)
      .join('\n'),
  };
}

function parseCodexPatchApplyChanges(payload) {
  if (payload?.type !== 'patch_apply_end' || payload.success !== true) return null;
  const changes = payload.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const actions = [];

  for (const [filePath, rawChange] of Object.entries(changes)) {
    const change = rawChange && typeof rawChange === 'object' ? rawChange : null;
    if (!change) return null;
    const changeType = String(change.type || '').toLowerCase();
    if (changeType === 'update') {
      const diffHunks = parseHistoryUnifiedDiffHunks(change.unified_diff);
      if (!diffHunks) return null;
      const edits = diffHunks.map(historyDiffHunkStrings);
      actions.push(diffHunks.length === 1
        ? {
            toolName: 'Edit',
            args: {
              file_path: change.move_path || filePath,
              ...edits[0],
            },
            diffHunks,
          }
        : {
            toolName: 'MultiEdit',
            args: {
              file_path: change.move_path || filePath,
              edits,
            },
            diffHunks,
          });
      continue;
    }
    if (changeType === 'add') {
      const content = typeof change.content === 'string' ? change.content : '';
      actions.push({
        toolName: 'Write',
        args: { file_path: change.move_path || filePath, content },
        diffHunks: [{
          oldStart: 0,
          newStart: 1,
          entries: content.split('\n').map((line) => ({ tag: 'add', line })),
        }],
      });
      continue;
    }
    if (changeType === 'delete') {
      // Real rollouts often omit `content` on deletes (only the fact of the
      // deletion is recorded). That is still an authoritative edit action —
      // demanding content here used to void the WHOLE event, which left
      // computed-patch calls rendering as the junk «Edit (patch)».
      const content = typeof change.content === 'string' ? change.content : '';
      actions.push({
        toolName: 'Edit',
        args: {
          file_path: filePath,
          old_string: content,
          new_string: '',
        },
        ...(content
          ? {
            diffHunks: [{
              oldStart: 1,
              newStart: 0,
              entries: content.split('\n').map((line) => ({ tag: 'del', line })),
            }],
          }
          : {}),
      });
      continue;
    }
    return null;
  }
  return actions.length > 0 ? actions : null;
}

function normalizeHistoryPatchPath(filePath, cwd) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value));
}

function expectedHistoryPatchPaths(patchText, cwd) {
  return new Set(
    extractPatchTouchedFiles(patchText)
      .map((filePath) => normalizeHistoryPatchPath(filePath, cwd))
      .filter(Boolean),
  );
}

function codexPatchEventPathSet(payload, cwd) {
  if (!parseCodexPatchApplyChanges(payload)) return null;
  const changes = payload?.changes;
  return new Set(
    Object.keys(changes || {})
      .map((filePath) => normalizeHistoryPatchPath(filePath, cwd))
      .filter(Boolean),
  );
}

function sameHistoryPatchPaths(left, right) {
  if (!left || !right || left.size === 0 || left.size !== right.size) return false;
  for (const filePath of left) {
    if (!right.has(filePath)) return false;
  }
  return true;
}

function codexNestedApplyPatchTexts(call) {
  if (call?.toolName !== 'exec' || typeof call?.args?.input !== 'string') return [];
  const source = call.args.input;
  const values = [];
  for (const nestedCall of findCodexExecNestedCalls(source)) {
    if (nestedCall.toolName !== 'apply_patch') continue;
    const parsed = resolveSimpleJsCallValue(source, nestedCall);
    if (typeof parsed === 'string' && parsed.includes('*** Begin Patch')) values.push(parsed);
  }
  return values;
}

function attachCodexPatchApplyEvent(pendingCalls, payload, cwd) {
  const direct = pendingCalls.get(payload?.call_id);
  if (direct?.toolName === 'apply_patch') {
    direct.patchApplyEvents.push(payload);
    return true;
  }
  // The event's call_id names the EXEC call itself when apply_patch ran
  // nested inside `tools.exec(...)`. With a computed patch text the path
  // comparison below has nothing to compare (the literal parser cannot
  // resolve `const patch = header + files.map(...)`), so the same-call_id
  // exec that visibly invokes tools.apply_patch is the authoritative owner.
  if (direct?.toolName === 'exec'
      && typeof direct?.args?.input === 'string'
      && direct.args.input.includes('apply_patch')) {
    direct.patchApplyEvents.push(payload);
    return true;
  }

  const eventPaths = codexPatchEventPathSet(payload, cwd);
  if (!eventPaths) return false;
  const eventTurnId = String(payload?.turn_id || '');
  const candidates = [];
  for (const call of pendingCalls.values()) {
    if (call.toolName !== 'exec') continue;
    if (eventTurnId && call.turnId && eventTurnId !== call.turnId) continue;
    const matches = codexNestedApplyPatchTexts(call).some((patchText) => (
      sameHistoryPatchPaths(expectedHistoryPatchPaths(patchText, cwd), eventPaths)
    ));
    if (matches) candidates.push(call);
  }
  if (candidates.length === 1) {
    candidates[0].patchApplyEvents.push(payload);
    return true;
  }
  if (candidates.length > 1) return false;

  // Last resort — ORDER, because identity is not available at all.
  //
  // The event names itself `exec-<uuid>`, which is a DIFFERENT id space from
  // the call's `call_<id>`: measured over 40 rollouts, 1540 of 1540 events
  // failed the direct id lookup. Path comparison rescues only literal
  // patches; every computed one (`const patch = "…" + files.map(…)`, a
  // template literal with `${file}`) has no text to compare, which is exactly
  // why those cards printed the placeholder subject `(patch)` / `${file}`
  // instead of the files that changed.
  //
  // What IS reliable is the protocol's own sequencing: Codex emits the event
  // while the call is still open (verified: 27/27 events arrive before their
  // call's output) and never runs two patch calls concurrently — across the
  // same 40 rollouts, 1531 of 1540 events had EXACTLY ONE open apply_patch
  // call and not one had two. So when precisely one open call invokes
  // apply_patch, it is the owner. Two open candidates is ambiguous and the
  // event is dropped rather than guessed: a wrong attachment would print
  // someone else's files.
  const open = [];
  for (const call of pendingCalls.values()) {
    if (eventTurnId && call.turnId && eventTurnId !== call.turnId) continue;
    if (call.toolName === 'apply_patch') { open.push(call); continue; }
    if (call.toolName === 'exec'
        && typeof call?.args?.input === 'string'
        && call.args.input.includes('apply_patch')) {
      open.push(call);
    }
  }
  if (open.length !== 1) return false;
  open[0].patchApplyEvents.push(payload);
  return true;
}

function takeCanonicalCodexPatchActions(call, patchText, usedEventIndexes) {
  const expectedPaths = expectedHistoryPatchPaths(patchText, call?.cwd);
  if (expectedPaths.size === 0) return null;
  const candidates = [];
  const events = Array.isArray(call?.patchApplyEvents) ? call.patchApplyEvents : [];
  for (let index = 0; index < events.length; index += 1) {
    if (usedEventIndexes.has(index)) continue;
    const actions = parseCodexPatchApplyChanges(events[index]);
    if (!actions) continue;
    const actualPaths = codexPatchEventPathSet(events[index], call?.cwd);
    if (sameHistoryPatchPaths(expectedPaths, actualPaths)) {
      candidates.push({ index, actions });
    }
  }
  // Two pending patches touching the same file are ambiguous. Keep the
  // input-derived card, but do not borrow line metadata from the wrong event.
  if (candidates.length !== 1) return null;
  usedEventIndexes.add(candidates[0].index);
  return candidates[0].actions;
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

/**
 * A short, safe subject for an MCP card header.
 *
 * `prompt` is deliberately NOT a candidate. For send/delegate tools it is
 * the whole user task (often several thousand characters), not a summary.
 * Putting it into `args.summary` made a COLLAPSED `terminal · delegate to
 * session` row print the complete delegated instruction inline. The prompt
 * remains in `args` for the explicitly expanded body and row copy.
 */
function firstCodexMcpDetail(args) {
  if (!args || typeof args !== 'object') return '';
  const direct = args.label || args.query || args.q || args.path || args.file_path
    || args.location || args.uri || args.pattern;
  if (typeof direct === 'string') return direct;
  const query = Array.isArray(args.search_query) ? args.search_query[0]?.q : null;
  return typeof query === 'string' ? query : '';
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
    if (actions.length > 0) return actions;
    // No readable patch and no authoritative apply event (the caller tries
    // that first). Verified cause in production: the script that was to BUILD
    // the patch crashed, so nothing was ever applied. Claiming «Edit» here
    // painted a failed run as a successful file change — the row now says a
    // patch was attempted and names no file it did not touch.
    return [{ toolName: 'Patch', args: { summary: 'Patch not applied' } }];
  }
  if (qualifiedName === 'exec_command' || qualifiedName === 'run_command' || qualifiedName === 'restart_process' || qualifiedName === 'kill_process' || qualifiedName === 'run_chain') {
    let command = input.cmd || input.command || input.input || '';
    // Unparsed nested arguments arrive as the RAW `{cmd,workdir:"…"}` source
    // (shorthand/variable args defeat the literal parser). That junk must
    // never become the command: recover the cmd string by regex, else drop.
    if (typeof command === 'string' && command.trim().startsWith('{')) {
      const recovered = command.match(/cmd\s*:\s*"((?:[^"\\]|\\.)+)"/)
        || command.match(/cmd\s*:\s*'((?:[^'\\]|\\.)+)'/)
        || command.match(/cmd\s*:\s*`((?:[^`\\]|\\.)+)`/);
      command = recovered ? recovered[1].replace(/\\n/g, '\n') : '';
    }
    return [{
      toolName: 'Bash',
      args: {
        command: command || humanizeCodexToolName(qualifiedName),
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
    const detail = firstCodexMcpDetail(input);
    // Parsed transport identity for the renderer: the visual dictionary
    // forbids surfacing `mcp__server__tool` as the row label, and the display
    // grouping collapses MCP series per SERVER — both need these fields.
    const mcpServer = parts.length > 1 ? parts[0] : (parts[0] || 'mcp');
    const mcpMethod = parts.length > 1 ? parts.slice(1).join('__') : '';
    return [{
      toolName: 'MCP',
      mcpServer,
      mcpMethod,
      args: { summary: detail ? `${action} — ${detail}` : action, ...input },
    }];
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
  // In-process subagents. The durable parser builds full Task cards; the LIVE
  // stream reaches this same decoder, and its shape decides whether the agent
  // is visible as background work at all.
  //
  // A live spawn must therefore emit the SAME `tool: 'Task'` card shape the
  // durable side uses — the background-chip strip recognises subagents by that
  // shape alone. Emitting a generic `Subagent` tool row rendered a plausible
  // card but was invisible to the strip: E2E ct-e2e24 showed a `default` agent
  // running 41s with three recomputes inside its lifetime and `count=0` in all
  // of them, while the log said `projected=Subagent`. Explorer only "worked"
  // earlier because its durable reload happened to land inside the window.
  //
  // Never surface the v2 encrypted message; task_name/agent_type are the
  // readable identity.
  if (namespace === 'multi_agent_v1' || namespace === 'collaboration') {
    if (qualifiedName === 'spawn_agent') {
      const label = String(input.task_name || '').trim()
        || (typeof input.message === 'string' && !input.message.startsWith('gAAAA')
          ? String(input.message).slice(0, 60)
          : 'Subagent');
      const agentType = String(input.agent_type || '').trim();
      const description = agentType ? label + ' (' + agentType + ')' : label;
      // `running` is the live truth: a spawn that was rejected or already
      // finished is re-projected by the durable parser, which wins by source
      // identity and carries the terminal status.
      // toolUseId is stamped by the caller, which owns the call identity.
      return [{ tool: 'Task', description, subagentStatus: 'running' }];
    }
    if (qualifiedName === 'wait_agent') {
      return [{ toolName: 'Wait', args: { summary: 'Waiting for subagents' } }];
    }
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
  const callId = call?.callId == null ? '' : String(call.callId);
  const nested = source ? findCodexExecNestedCalls(source) : [];
  const callGroups = [];
  const usedPatchEventIndexes = new Set();

  if (nested.length > 0) {
    for (const nestedCall of nested) {
      const parsed = resolveSimpleJsCallValue(source, nestedCall);
      const args = parsed && typeof parsed === 'object'
        ? parsed
        : (typeof parsed === 'string' ? { input: parsed } : { input: compactPreview(nestedCall.argumentsText, 1000) });
      let canonicalPatchActions = null;
      if (nestedCall.toolName === 'apply_patch') {
        if (typeof parsed === 'string') {
          canonicalPatchActions = takeCanonicalCodexPatchActions(call, parsed, usedPatchEventIndexes);
        }
        // Computed patch text (`const patch = header + files.map(...)`):
        // the literal parser cannot resolve it, which used to leave the
        // junk «Edit (patch)» card. The patch_apply_end event on this SAME
        // call_id carries the authoritative per-file changes — when exactly
        // one unclaimed event exists, its actions are the truth.
        if (!canonicalPatchActions) {
          const events = Array.isArray(call?.patchApplyEvents) ? call.patchApplyEvents : [];
          const free = [];
          for (let index = 0; index < events.length; index += 1) {
            if (usedPatchEventIndexes.has(index)) continue;
            const actions = parseCodexPatchApplyChanges(events[index]);
            if (actions) free.push({ index, actions });
          }
          if (free.length === 1) {
            usedPatchEventIndexes.add(free[0].index);
            canonicalPatchActions = free[0].actions;
          }
        }
      }
      callGroups.push(canonicalPatchActions || normalizeCodexHistoryCall(nestedCall.toolName, args));
    }
  } else if (call?.toolName === 'exec') {
    // An exec that calls no tool at all is a plain snippet Codex ran in its
    // own sandbox to check something (`text(typeof atob)`). «Orchestration»
    // was an invented category the user could not place — it named nothing
    // the model did. It is a script run, so it says so and joins the noise
    // class like every other run (as its own row it split neighbouring
    // groups in two).
    const lookup = /\bALL_TOOLS\b/.test(source);
    callGroups.push([{
      toolName: lookup ? 'Tool Search' : 'Script',
      // The snippet IS the invocation, so it goes to the body like any other
      // run; the header must not try to read JS as a shell line (it produced
      // «Run const example» — the first two tokens of the source). `Script`
      // has its own headline rule: one word, source in the body.
      args: lookup ? { summary: 'Inspect available tools' } : { command: source },
    }]);
  } else {
    const patchText = call?.toolName === 'apply_patch' && typeof call?.args?.input === 'string'
      ? call.args.input
      : null;
    const canonicalPatchActions = patchText
      ? takeCanonicalCodexPatchActions(call, patchText, usedPatchEventIndexes)
      : null;
    callGroups.push(canonicalPatchActions || normalizeCodexHistoryCall(call?.toolName, call?.args || {}, call?.namespace || ''));
  }

  const cellId = call?.toolName === 'exec' ? codexHistoryCellId(rawOutput) : null;
  if (!cellId) assignCodexHistoryResults(callGroups, rawOutput, isError);
  const actions = callGroups.flat().map((action, index) => {
    // A subagent card is already in its final shape — wrapping it as a raw
    // tool row would hide it from the background-chip strip, which recognises
    // subagents by `tool: 'Task'` alone (E2E ct-e2e24: live spawns projected
    // as generic tool rows never produced a chip).
    if (action?.tool === 'Task') {
      return {
        ...action,
        ...(callId && !action.toolUseId ? { toolUseId: String(callId) } : {}),
        ...(action.result === undefined ? {} : { result: action.result }),
      };
    }
    // Grouping identity, stamped at normalization time so the renderer's
    // series-collapsing works identically for Claude and Codex — and so
    // row-window stubs can carry the same fields without content.
    const classified = classifyHistoryAction({
      toolName: action.toolName,
      args: action.args,
      mcpServer: action.mcpServer,
      mcpMethod: action.mcpMethod,
    });
    return {
      tool: '__raw__',
      rawTool: {
        ...(callId ? { toolUseId: `${callId}:canonical:${index}` } : {}),
        toolName: action.toolName,
        args: action.args || {},
        family: classified.family,
        bashWord: classified.bashWord,
        bashDetail: classified.bashDetail,
        mcpServer: classified.mcpServer,
        mcpMethod: classified.mcpMethod,
        result: action.result,
        isError: action.isError,
        diffHunks: action.diffHunks,
      },
    };
  });
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

  // Keep Timeline on the same semantic grammar as History. This covers
  // nested exec_command calls whose shell body writes docs via Python/cat/sed
  // instead of apply_patch — the transport tool name itself says only `exec`.
  // Do not run the full nested-call decoder for every search/read command in a
  // giant rollout: History can only prove a docs edit when the literal target
  // is present anyway, so this cheap gate preserves Timeline parse cost.
  const editCapableTransport = toolName === 'exec'
    || toolName === 'apply_patch'
    || toolName === 'exec_command'
    || toolName === 'run_command';
  let semanticSource = '';
  try {
    semanticSource = typeof payload.arguments === 'string'
      ? payload.arguments
      : typeof payload.input === 'string'
        ? payload.input
        : JSON.stringify(payload.arguments ?? payload.input ?? args);
  } catch {
    semanticSource = '';
  }
  if (!editCapableTransport || !/(?:^|[\\/])docs[\\/]|\bCLAUDE\.md\b/i.test(semanticSource)) return;
  const callArgs = payload.arguments != null
    ? parseToolArguments(payload)
    : (typeof payload.input === 'string' ? { input: payload.input } : (payload.input || args));
  const decoded = codexHistoryActionsForCall({
    callId: payload.call_id || payload.id || '',
    toolName,
    namespace,
    args: callArgs && typeof callArgs === 'object' ? callArgs : { value: callArgs },
  }, '', false);
  addSemanticDocsEdits(currentUser, decoded.actions);
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

// Codex does not currently emit this for encrypted compaction v2, but accept
// only explicitly post-compact fields if a future protocol adds one. Generic
// usage.total_tokens is the PRE-compaction window and must never be reused.
function compactPostTokenCount(payload) {
  const value = Number(
    payload?.post_tokens
    ?? payload?.postTokens
    ?? payload?.compacted_tokens
    ?? payload?.compactedTokens,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
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
function codexCompactCompanionPairs(records) {
  const pairs = new Map();
  const pendingTopLevelLines = [];
  for (const record of Array.isArray(records) ? records : []) {
    const payload = record?.payload || {};
    if (record?.type === 'compacted') {
      if (Number.isFinite(Number(record.__line))) pendingTopLevelLines.push(Number(record.__line));
      continue;
    }
    if (record?.type === 'event_msg' && isCompactPayload(payload)) {
      if (pendingTopLevelLines.length > 0 && Number.isFinite(Number(record.__line))) {
        pairs.set(pendingTopLevelLines.shift(), Number(record.__line));
      }
      continue;
    }
    if (record?.type === 'event_msg' && payload.type === 'user_message') {
      const text = codexUserMessagePresentationText(record);
      if (isCodexTurnAbortedUserText(text)) continue;
      pendingTopLevelLines.length = 0;
    }
  }
  return pairs;
}

function codexCompactCompanionLines(records) {
  return new Set(codexCompactCompanionPairs(records).values());
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

async function inspectJsonlFiles(rootDir, maxFiles = 4000) {
  const files = [];
  const errors = [];
  let truncated = false;

  async function walk(dir) {
    if (truncated) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({
        stage: 'walk',
        path: dir,
        code: error?.code || null,
        message: error?.message || String(error),
      });
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.with-rollbacks-backup')) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(full);
      }
    }
  }

  await walk(rootDir);
  return { files, errors, truncated };
}

async function parseJsonlFile(filePath, options = {}) {
  if (options.forceFresh === true) {
    // A task_complete append can land while another reader is still consuming
    // the previous file size. Await and discard that snapshot before the
    // orchestration result reader takes its authoritative final view.
    while (_codexJsonlInflight.has(filePath)) {
      const pending = _codexJsonlInflight.get(filePath);
      try {
        await pending;
      } catch {
        // The fresh read below owns the retry and the resulting error.
      }
      if (_codexJsonlInflight.get(filePath) === pending) {
        _codexJsonlInflight.delete(filePath);
      }
    }
    invalidateCodexJsonlCache(filePath);
  }
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

/**
 * Картинки внутри записи о сжатии контекста — единственное, что делает файлы
 * истории гигантскими, и единственное, что мы из них НЕ показываем.
 *
 * Как получается гигабайт. При переполнении контекста Codex сохраняет всю
 * предыдущую переписку одной строкой, и каждое следующее сжатие включает в
 * себя предыдущее. Скриншот, попавший в диалог один раз, копируется в каждое
 * последующее сжатие. Замерено на реальном файле пользователя: 1340 МБ, из них
 * 1260 МБ — 64 строки сжатий, а внутри них 1236 МБ (98%) — картинки, вписанные
 * прямо в текст. Без них тот же файл весит 104 МБ.
 *
 * Почему их можно выбросить именно из PARSED/PRESENTATION памяти. Показ сжатия
 * и так подставляет вместо картинки пометку «[image omitted]» (см.
 * formatReplacementHistory) — то есть до экрана эти байты не доходят. Но
 * Fork/Edit/Delete являются write-path: они получают невидимые raw ranges и
 * при записи потоково возвращают точные data URL, сверяя SHA-256. Смешение
 * этих границ 20.08 создало resumable fork с буквальным image_url=
 * "[image omitted]"; OpenAI затем отклонял каждый turn как invalid URL.
 * Именно бессмысленное удержание base64 в UI-памяти убило приложение 19.08
 * 08:41, а их потеря на persistence-boundary сломала fork днём позже.
 *
 * Границы. Режется ТОЛЬКО содержимое записи `compacted`. Картинки в обычных
 * сообщениях не трогаются: они нужны для повтора запроса с изображением
 * (см. materializeBuffer в main). Обрезка делается по сырому тексту строки ДО
 * разбора — иначе гигабайт всё равно окажется в памяти, просто чуть позже.
 * Raw descriptor хранит только file offsets + hashes, не сами base64.
 */
const CODEX_COMPACT_IMAGE_DATA_URL = /"(image_url|imageUrl)"\s*:\s*"data:image\/[^"]*"/g;

function describeCompactedInlineImages(rawLine, rawLineBuffer, filePath, lineStartOffset) {
  if (typeof rawLine !== 'string' || rawLine.length < 4096) return null;
  if (!Buffer.isBuffer(rawLineBuffer) || rawLineBuffer.length === 0) return null;
  if (rawLine.lastIndexOf('"type":"compacted"', 400) === -1) return null;
  if (rawLine.indexOf('"data:image/') === -1) return null;
  const images = [];
  let previousCharOffset = 0;
  let previousByteOffset = 0;
  let searchFrom = 0;
  while (searchFrom < rawLine.length) {
    const snakeIndex = rawLine.indexOf('"image_url"', searchFrom);
    const camelIndex = rawLine.indexOf('"imageUrl"', searchFrom);
    let key = null;
    let keyIndex = -1;
    if (snakeIndex >= 0 && (camelIndex < 0 || snakeIndex < camelIndex)) {
      key = 'image_url';
      keyIndex = snakeIndex;
    } else if (camelIndex >= 0) {
      key = 'imageUrl';
      keyIndex = camelIndex;
    } else {
      break;
    }
    let cursor = keyIndex + key.length + 2;
    while (/\s/.test(rawLine[cursor] || '')) cursor += 1;
    if (rawLine[cursor] !== ':') {
      searchFrom = cursor + 1;
      continue;
    }
    cursor += 1;
    while (/\s/.test(rawLine[cursor] || '')) cursor += 1;
    if (rawLine[cursor] !== '"' || !rawLine.startsWith('data:image/', cursor + 1)) {
      searchFrom = cursor + 1;
      continue;
    }
    const closingQuote = rawLine.indexOf('"', cursor + 1);
    if (closingQuote < 0) break;
    const valueCharStart = cursor;
    const valueCharEnd = closingQuote + 1;
    const bytesBefore = Buffer.byteLength(rawLine.slice(previousCharOffset, valueCharStart));
    const start = Number(lineStartOffset) + previousByteOffset + bytesBefore;
    // data URLs and their JSON quotes are ASCII, so their character length is
    // the exact byte length. The surrounding JSON may contain Unicode; that is
    // why `bytesBefore` above is measured explicitly.
    const byteLength = valueCharEnd - valueCharStart;
    const relativeStart = start - Number(lineStartOffset);
    const rawValueBuffer = rawLineBuffer.subarray(relativeStart, relativeStart + byteLength);
    images.push({
      key,
      filePath,
      start,
      endExclusive: start + byteLength,
      byteLength,
      sha256: crypto.createHash('sha256').update(rawValueBuffer).digest('hex'),
    });
    previousCharOffset = valueCharEnd;
    previousByteOffset = start + byteLength - Number(lineStartOffset);
    searchFrom = valueCharEnd;
  }
  return images.length > 0 ? { images } : null;
}

function stripCompactedInlineImages(line) {
  // Дешёвая проверка перед дорогой заменой: обычные строки не должны платить.
  if (line.length < 4096) return line;
  if (line.lastIndexOf('"type":"compacted"', 400) === -1) return line;
  if (line.indexOf('"data:image/') === -1) return line;
  return line.replace(CODEX_COMPACT_IMAGE_DATA_URL, '"$1":"[image omitted]"');
}

async function readJsonlRange(filePath, startByte, endByte, options = {}) {
  const records = options.records || [];
  let lineCount = Number(options.lineCount) || 0;
  let parsed = 0;
  let errors = 0;
  let leftoverBuffer = Buffer.isBuffer(options.leftoverBuffer)
    ? Buffer.from(options.leftoverBuffer)
    : Buffer.from(String(options.leftover || ''), 'utf8');
  let nextChunkOffset = Math.max(0, Number(startByte) || 0);
  let leftoverStartOffset = Math.max(0, nextChunkOffset - leftoverBuffer.length);

  const consume = (chunk) => {
    if (!chunk?.length) return;
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const dataStartOffset = leftoverBuffer.length > 0
      ? leftoverStartOffset
      : nextChunkOffset;
    const data = leftoverBuffer.length > 0
      ? Buffer.concat([leftoverBuffer, chunkBuffer])
      : chunkBuffer;
    let lineStart = 0;
    let newlineIndex = data.indexOf(0x0a, lineStart);
    while (newlineIndex >= 0) {
      const rawLineBuffer = data.subarray(lineStart, newlineIndex);
      const rawLineText = rawLineBuffer.toString('utf8');
      const rawLine = rawLineText.trim();
      const line = stripCompactedInlineImages(rawLine);
      if (line) {
        try {
          const record = JSON.parse(line);
          const decorated = {
            ...record,
            __line: lineCount,
            __byteOffset: dataStartOffset + lineStart,
          };
          const rawImages = describeCompactedInlineImages(
            rawLineText,
            rawLineBuffer,
            filePath,
            dataStartOffset + lineStart,
          );
          if (rawImages) {
            Object.defineProperty(decorated, CODEX_COMPACT_RAW_IMAGES, {
              value: rawImages,
              enumerable: false,
              configurable: false,
              writable: false,
            });
          }
          records.push(decorated);
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
    leftoverStartOffset = dataStartOffset + lineStart;
    nextChunkOffset += chunkBuffer.length;
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

async function scanCodexStableSourceRewindProof(filePath, {
  targetSourceLine,
  actionStartedAtMs,
} = {}) {
  const targetLine = Number(targetSourceLine);
  const actionAt = Number(actionStartedAtMs);
  if (!filePath
    || !Number.isInteger(targetLine)
    || targetLine < 0
    || !Number.isFinite(actionAt)) {
    return {
      complete: false,
      error: 'codex_stable_source_scan_input_invalid',
      targetRecord: null,
      taskStartedRecord: null,
      userMessageRecord: null,
      threadRolledBackRecord: null,
    };
  }

  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let nextChunkOffset = 0;
  let lineNumber = 0;
  let parseErrors = 0;
  let targetRecord = null;
  let taskStartedRecord = null;
  let userMessageRecord = null;
  let threadRolledBackRecord = null;
  let stoppedAtProof = false;

  const inspectLine = (lineBuffer, byteOffset) => {
    const sourceLine = lineNumber;
    lineNumber += 1;
    const raw = lineBuffer.toString('utf8').trim();
    if (!raw) return false;
    const couldMatter = sourceLine === targetLine
      || (sourceLine > targetLine
        && raw.includes('"event_msg"')
        && (raw.includes('"task_started"')
          || raw.includes('"user_message"')
          || raw.includes('"thread_rolled_back"')));
    if (!couldMatter) return false;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      parseErrors += 1;
      return false;
    }
    const decorated = { ...record, __line: sourceLine, __byteOffset: byteOffset };
    if (sourceLine === targetLine) {
      targetRecord = decorated;
      return false;
    }
    if (record?.type !== 'event_msg') return false;
    const timestampMs = parseTimestampMs(record.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < actionAt) return false;
    if (record.payload?.type === 'task_started' && !taskStartedRecord) {
      taskStartedRecord = decorated;
    } else if (record.payload?.type === 'user_message' && !userMessageRecord) {
      userMessageRecord = decorated;
    } else if (record.payload?.type === 'thread_rolled_back' && !threadRolledBackRecord) {
      threadRolledBackRecord = decorated;
    }
    return !!taskStartedRecord && !!userMessageRecord;
  };

  try {
    const stream = fs.createReadStream(filePath, {
      highWaterMark: CODEX_JSONL_READ_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      const chunkStart = nextChunkOffset;
      nextChunkOffset += chunk.length;
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const dataStart = pending.length > 0 ? pendingStart : chunkStart;
      let cursor = 0;
      let newlineIndex = data.indexOf(0x0a, cursor);
      while (newlineIndex >= 0) {
        if (inspectLine(data.subarray(cursor, newlineIndex), dataStart + cursor)) {
          stoppedAtProof = true;
          stream.destroy();
          break;
        }
        cursor = newlineIndex + 1;
        newlineIndex = data.indexOf(0x0a, cursor);
      }
      if (stoppedAtProof) break;
      pending = Buffer.from(data.subarray(cursor));
      pendingStart = dataStart + cursor;
    }
    if (!stoppedAtProof && pending.length > 0) {
      inspectLine(pending, pendingStart);
    }
    return {
      complete: parseErrors === 0,
      error: parseErrors > 0 ? 'codex_stable_source_scan_parse_failed' : null,
      parseErrors,
      scannedBytes: nextChunkOffset,
      scannedLines: lineNumber,
      stoppedAtProof,
      targetRecord,
      taskStartedRecord,
      userMessageRecord,
      threadRolledBackRecord,
    };
  } catch (error) {
    return {
      complete: false,
      error: error?.message || String(error),
      parseErrors,
      scannedBytes: nextChunkOffset,
      scannedLines: lineNumber,
      stoppedAtProof,
      targetRecord,
      taskStartedRecord,
      userMessageRecord,
      threadRolledBackRecord,
    };
  }
}

/** Наши кадры стека вызова, ради ответа «кто заказал полное чтение файла».
 * Только имена функций проекта: кадры Node и внутренние обёртки шума дают
 * больше, чем смысла. */
function _describeJsonlReadCaller() {
  try {
    const stack = String(new Error().stack || '').split('\n').slice(2, 40);
    const names = [];
    for (const line of stack) {
      const m = line.match(/at\s+(?:async\s+)?([A-Za-z_$][\w$.]*)\s/);
      if (!m) continue;
      const name = m[1];
      if (name.startsWith('_parseJsonlFile') || name === 'parseJsonlFile') continue;
      if (name.startsWith('process.') || name.startsWith('Object.')) continue;
      if (names[names.length - 1] === name) continue;
      names.push(name);
      if (names.length >= 4) break;
    }
    return names.length ? names.join('<') : 'unknown';
  } catch {
    return 'unknown';
  }
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

  // Файл, который нельзя разобрать целиком, не разбираем вовсе. Дописи к уже
  // разобранному файлу (ветка ниже) под запрет не попадают: там читается
  // только новый хвост, а не весь файл.
  if (!cached && stat.size > CODEX_JSONL_PARSE_MAX_BYTES) {
    console.warn('[CodexJsonlCache] refused file=' + path.basename(filePath)
      + ' sizeMB=' + Math.round(stat.size / (1024 * 1024))
      + ' maxMB=' + Math.round(CODEX_JSONL_PARSE_MAX_BYTES / (1024 * 1024))
      + ' by=' + _describeJsonlReadCaller());
    return [];
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
    (cached ? ' reason=rewrite-or-shrink' : ' reason=first-read')
    // Кто именно заказал полное чтение. Без этого в проде видно ЧТО читается,
    // но не видно КЕМ: 19.08 05:38–05:41 через кэш прогнали 195 разных файлов,
    // память ушла с 2.0 до 3.6 ГБ и процесс упал — а в логе не было ни одного
    // вызывающего. Стек здесь стоит дёшево (одно полное чтение — сотни
    // миллисекунд) и печатается только в этот момент, не на попадания в кэш.
    + ' by=' + _describeJsonlReadCaller());
  return result.records;
}

function invalidateCodexJsonlCache(filePath) {
  if (!filePath) return;
  deleteCodexJsonlCacheEntry(filePath);
  // Every explicit rewrite path (edit/delete-range/fork, forceFresh reads)
  // funnels through here — burn the resumable projector too. The projector's
  // own structural witness also catches rewrites (byte offsets shift), this
  // is the belt to that suspenders.
  invalidateCodexHistoryProjectors(filePath);
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

async function findCodexLinkedLiveBoundary(filePath, options = {}) {
  const metadata = await readCodexSessionMetadata(filePath);
  const meta = metadata.meta || {};
  const metadataStartedAtMs = parseTimestampMs(meta.timestamp);
  const requestedStartedAtMs = Number(options.startedAtMs);
  // A rollout may have been created by a native Codex rewind long before the
  // current `resume` launch. In that case metadata time proves only historical
  // creation; current ownership starts at the newer launch boundary. Taking
  // the older timestamp used to classify copied/history turns as live proof.
  const liveThresholdCandidates = [metadataStartedAtMs, requestedStartedAtMs]
    .filter((value) => Number.isFinite(value));
  const liveThresholdMs = liveThresholdCandidates.length > 0
    ? Math.max(...liveThresholdCandidates) - 1000
    : null;

  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let nextChunkOffset = 0;
  let scannedLines = 0;

  const inspectLine = (lineBuffer, byteOffset) => {
    scannedLines += 1;
    const line = lineBuffer.toString('utf8').trim();
    if (!line.includes('"task_started"') || !line.includes('"event_msg"')) return null;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (record?.type !== 'event_msg' || record.payload?.type !== 'task_started') return null;

    const rawStartedAt = Number(record.payload.started_at);
    const payloadStartedAtMs = Number.isFinite(rawStartedAt)
      ? (rawStartedAt > 1e12 ? rawStartedAt : rawStartedAt * 1000)
      : null;
    const recordStartedAtMs = parseTimestampMs(record.timestamp);
    const isLive = Number.isFinite(liveThresholdMs)
      ? (Number.isFinite(payloadStartedAtMs)
        ? payloadStartedAtMs >= liveThresholdMs
        : Number.isFinite(recordStartedAtMs) && recordStartedAtMs >= liveThresholdMs + 2000)
      : true;
    if (!isLive) return null;
    return {
      byteOffset,
      turnId: record.payload.turn_id || null,
      startedAtMs: payloadStartedAtMs,
      recordTimestamp: record.timestamp || null,
    };
  };

  const stream = fs.createReadStream(filePath, { highWaterMark: CODEX_JSONL_READ_CHUNK_BYTES });
  for await (const chunk of stream) {
    const chunkStart = nextChunkOffset;
    nextChunkOffset += chunk.length;
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const dataStart = pending.length > 0 ? pendingStart : chunkStart;
    let cursor = 0;
    let newlineIndex = data.indexOf(0x0a, cursor);
    while (newlineIndex >= 0) {
      const hit = inspectLine(data.subarray(cursor, newlineIndex), dataStart + cursor);
      if (hit) {
        stream.destroy();
        return {
          found: true,
          offset: hit.byteOffset,
          scannedBytes: nextChunkOffset,
          scannedLines,
          sessionId: meta.id || null,
          metadataStartedAtMs: Number.isFinite(metadataStartedAtMs) ? metadataStartedAtMs : null,
          ...hit,
        };
      }
      cursor = newlineIndex + 1;
      newlineIndex = data.indexOf(0x0a, cursor);
    }
    pending = Buffer.from(data.subarray(cursor));
    pendingStart = dataStart + cursor;
  }

  if (pending.length > 0) {
    const hit = inspectLine(pending, pendingStart);
    if (hit) {
      return {
        found: true,
        offset: hit.byteOffset,
        scannedBytes: nextChunkOffset,
        scannedLines,
        sessionId: meta.id || null,
        metadataStartedAtMs: Number.isFinite(metadataStartedAtMs) ? metadataStartedAtMs : null,
        ...hit,
      };
    }
  }

  return {
    found: false,
    // Keep an incomplete final JSONL record inside the live watcher boundary.
    offset: pending.length > 0 ? pendingStart : nextChunkOffset,
    scannedBytes: nextChunkOffset,
    scannedLines,
    sessionId: meta.id || null,
    metadataStartedAtMs: Number.isFinite(metadataStartedAtMs) ? metadataStartedAtMs : null,
    turnId: null,
    startedAtMs: null,
    recordTimestamp: null,
  };
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
  // Only the rollout's own (first) metadata describes its direct launch edge.
  // Later session_meta records are copied transcript ancestry. Treating those
  // as ownership lets an ancestor tab steal a sibling rollout after the real
  // owner closes (tab-165/tab-194 incident, 2026-07-22).
  const rootMeta = getSessionMeta(records);
  return rootMeta?.forked_from_id === sessionId;
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

function isCodexUserTuiSession(meta) {
  return isCodexTuiSession(meta)
    && !isCodexSubagentSession(meta)
    && (!meta?.thread_source || meta.thread_source === 'user');
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

// sessionId → filePath memo. The sessions tree holds hundreds of rollouts
// (dozens over 100MB); the full walk plus metadata reads costs ~400ms of
// main-loop time, and every consumer (subscribe, timeline, history, hover)
// used to pay it again after any state teardown. A rollout never moves once
// created; existence is re-verified before reuse and a miss falls through to
// the normal walk.
const codexSessionFilePathMemo = new Map();

async function findCodexSessionFile(sessionId, cwd, {
  allowContentScan = true,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  if (!sessionId || !fs.existsSync(sessionsDir)) return null;

  const memoKey = sessionId + ':' + (sessionsDir || '');
  const memoized = codexSessionFilePathMemo.get(memoKey);
  if (memoized) {
    try {
      await fs.promises.access(memoized);
      return { filePath: memoized };
    } catch {
      codexSessionFilePathMemo.delete(memoKey);
    }
  }

  const files = await walkJsonlFiles(sessionsDir);
  const suffixHit = files.find((file) => path.basename(file).includes(sessionId) && path.basename(file).endsWith('.jsonl'));
  if (suffixHit) {
    codexSessionFilePathMemo.set(memoKey, suffixHit);
    return { filePath: suffixHit };
  }
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
      codexSessionFilePathMemo.set(memoKey, filePath);
      return { filePath };
    }
    codexSessionFilePathMemo.set(memoKey, filePath);
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
    const sessionStartedMs = parseTimestampMs(meta.timestamp);
    const metadataFreshForLaunch = !sinceMs || (
      Number.isFinite(sessionStartedMs)
      && sessionStartedMs >= sinceMs - 5000
    );
    let linkedLiveBoundary = null;
    if (!metadataFreshForLaunch) {
      // Fresh launches must never adopt an old same-cwd rollout. A linked
      // resume may reopen an existing direct child, but only a task_started
      // after this launch proves that the old file is active again.
      if (!sourceSessionId || !sourceMatched) continue;
      linkedLiveBoundary = await findCodexLinkedLiveBoundary(candidate.filePath, {
        startedAtMs: sinceMs,
      });
      if (!linkedLiveBoundary?.found) continue;
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
      sourceMatchMode: sourceMatched ? 'direct-fork' : null,
      metadataStartedAtMs: Number.isFinite(sessionStartedMs) ? sessionStartedMs : null,
      metadataFreshForLaunch,
      reopenedExisting: !metadataFreshForLaunch,
      linkedLiveBoundary,
      threadSource: meta.thread_source || null,
      parentThreadId: meta.parent_thread_id || null,
      forkedFromId: meta.forked_from_id || null,
      originator: meta.originator || null,
    };
  }
  return relatedFallbacks[0] || null;
}

async function inspectCodexSessionMetadataIndex(
  sessionsDir = CODEX_SESSIONS_DIR,
  dependencies = {},
) {
  const walkFiles = dependencies.inspectJsonlFiles || inspectJsonlFiles;
  const readMetadata = dependencies.readCodexSessionMetadata || readCodexSessionMetadata;
  let walkResult;
  try {
    walkResult = await walkFiles(sessionsDir);
  } catch (error) {
    walkResult = {
      files: [],
      errors: [{
        stage: 'walk',
        path: sessionsDir,
        code: error?.code || null,
        message: error?.message || String(error),
      }],
      truncated: false,
    };
  }
  const files = Array.isArray(walkResult)
    ? walkResult
    : (Array.isArray(walkResult?.files) ? walkResult.files : []);
  const errors = Array.isArray(walkResult?.errors) ? [...walkResult.errors] : [];
  const truncated = walkResult?.truncated === true;
  const entries = [];

  for (const filePath of files) {
    let metadata;
    try {
      metadata = await readMetadata(filePath);
    } catch (error) {
      errors.push({
        stage: 'metadata-read',
        path: filePath,
        code: error?.code || null,
        message: error?.message || String(error),
      });
      continue;
    }
    const meta = metadata?.meta || {};
    if (!meta.id) {
      errors.push({
        stage: 'metadata-classify',
        path: filePath,
        code: 'session_metadata_missing',
        message: 'Readable JSONL could not be classified because session metadata is missing',
      });
      continue;
    }
    entries.push({
      meta,
      filePath,
    });
  }

  return {
    entries,
    errors,
    truncated,
    filesScanned: files.length,
  };
}

async function inspectCodexDirectChildSessions({
  sourceSessionId,
  cwd,
  sinceMs,
  untilMs,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}, dependencies = {}) {
  if (!sourceSessionId) {
    return {
      complete: false,
      children: [],
      errors: [{
        stage: 'input',
        path: sessionsDir,
        code: 'source_session_id_required',
        message: 'sourceSessionId is required for direct-child discovery',
      }],
      truncated: false,
      filesScanned: 0,
    };
  }
  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  const lowerBound = Number(sinceMs);
  const upperBound = Number(untilMs);
  const hasLowerBound = Number.isFinite(lowerBound) && lowerBound > 0;
  const hasUpperBound = Number.isFinite(upperBound) && upperBound > 0;
  const index = await inspectCodexSessionMetadataIndex(sessionsDir, dependencies);
  const errors = [...index.errors];
  const children = [];

  for (const { meta, filePath } of index.entries) {
    if (!meta.id
      || meta.id === sourceSessionId
      || meta.forked_from_id !== sourceSessionId
      || !isCodexUserTuiSession(meta)) {
      continue;
    }
    if (normalizedCwd && (!meta.cwd || path.resolve(meta.cwd) !== normalizedCwd)) {
      continue;
    }
    const createdAtMs = parseTimestampMs(meta.timestamp);
    if (!Number.isFinite(createdAtMs)) {
      errors.push({
        stage: 'metadata-classify',
        path: filePath,
        code: 'session_timestamp_invalid',
        message: 'Direct child metadata has no usable creation timestamp',
      });
      continue;
    }
    if (hasLowerBound && createdAtMs < lowerBound) continue;
    if (hasUpperBound && createdAtMs > upperBound) continue;
    children.push({
      sessionId: meta.id,
      filePath,
      cwd: meta.cwd || null,
      forkedFromId: meta.forked_from_id,
      createdAtMs,
    });
  }

  children.sort((left, right) => left.createdAtMs - right.createdAtMs);
  return {
    complete: errors.length === 0 && !index.truncated,
    children,
    errors,
    truncated: index.truncated,
    filesScanned: index.filesScanned,
  };
}

function resolveCodexDescendantLineage(meta, sourceSessionId, metadataBySessionId, conflicts) {
  const source = String(sourceSessionId || '');
  let currentId = String(meta?.id || '');
  if (!source || !currentId || currentId === source) {
    return {
      proven: false,
      reason: currentId === source ? 'source-is-not-descendant' : 'lineage-id-missing',
    };
  }

  const seen = new Set([currentId]);
  const chain = [currentId];
  let depth = 0;
  while (currentId) {
    if (conflicts.has(currentId)) {
      return {
        proven: false,
        incomplete: true,
        reason: 'lineage-conflict',
        conflictSessionId: currentId,
        chain,
      };
    }
    const current = metadataBySessionId.get(currentId)?.meta || null;
    if (!current) {
      return {
        proven: false,
        incomplete: true,
        reason: 'lineage-metadata-missing',
        missingSessionId: currentId,
        chain,
      };
    }
    const parentId = current.forked_from_id ? String(current.forked_from_id) : '';
    if (!parentId) {
      return {
        proven: false,
        incomplete: false,
        reason: 'different-lineage-root',
        rootSessionId: currentId,
        chain,
      };
    }
    depth += 1;
    if (parentId === source) {
      return {
        proven: true,
        incomplete: false,
        reason: depth === 1 ? 'direct-child' : 'descendant',
        depth,
        relation: depth === 1 ? 'direct-child' : 'descendant',
        chain: [...chain, source],
      };
    }
    if (seen.has(parentId)) {
      return {
        proven: false,
        incomplete: true,
        reason: 'lineage-cycle',
        cycleSessionId: parentId,
        chain: [...chain, parentId],
      };
    }
    seen.add(parentId);
    chain.push(parentId);
    currentId = parentId;
  }
  return {
    proven: false,
    incomplete: true,
    reason: 'lineage-metadata-missing',
    chain,
  };
}

async function inspectCodexDescendantSessions({
  sourceSessionId,
  cwd,
  sinceMs,
  untilMs,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}, dependencies = {}) {
  if (!sourceSessionId) {
    return {
      complete: false,
      descendants: [],
      errors: [{
        stage: 'input',
        path: sessionsDir,
        code: 'source_session_id_required',
        message: 'sourceSessionId is required for descendant discovery',
      }],
      truncated: false,
      filesScanned: 0,
    };
  }

  const normalizedCwd = cwd ? path.resolve(cwd) : null;
  const lowerBound = Number(sinceMs);
  const upperBound = Number(untilMs);
  const hasLowerBound = Number.isFinite(lowerBound) && lowerBound > 0;
  const hasUpperBound = Number.isFinite(upperBound) && upperBound > 0;
  const index = await inspectCodexSessionMetadataIndex(sessionsDir, dependencies);
  const errors = [...index.errors];
  const metadataBySessionId = new Map();
  const conflicts = new Set();

  for (const entry of index.entries) {
    const { meta, filePath } = entry;
    if (!isCodexUserTuiSession(meta)) continue;
    if (normalizedCwd && (!meta.cwd || path.resolve(meta.cwd) !== normalizedCwd)) continue;
    const sessionId = String(meta.id);
    const existing = metadataBySessionId.get(sessionId);
    if (existing && existing.filePath !== filePath) {
      conflicts.add(sessionId);
      errors.push({
        stage: 'metadata-classify',
        path: filePath,
        code: 'duplicate_session_id',
        message: 'Multiple rollout files claim the same Codex session ID',
        sessionId,
        otherPath: existing.filePath,
      });
      continue;
    }
    metadataBySessionId.set(sessionId, entry);
  }

  const descendants = [];
  const reportedLineageErrors = new Set();
  for (const { meta, filePath } of metadataBySessionId.values()) {
    if (meta.id === sourceSessionId || !meta.forked_from_id) continue;
    const createdAtMs = parseTimestampMs(meta.timestamp);
    const validTimestamp = Number.isFinite(createdAtMs);
    if (validTimestamp) {
      if (hasLowerBound && createdAtMs < lowerBound) continue;
      if (hasUpperBound && createdAtMs > upperBound) continue;
    }

    const lineage = resolveCodexDescendantLineage(
      meta,
      sourceSessionId,
      metadataBySessionId,
      conflicts,
    );
    if (!lineage.proven) {
      if (lineage.incomplete) {
        const errorKey = [
          meta.id,
          lineage.reason,
          lineage.missingSessionId || lineage.conflictSessionId || lineage.cycleSessionId || '',
        ].join(':');
        if (!reportedLineageErrors.has(errorKey)) {
          reportedLineageErrors.add(errorKey);
          errors.push({
            stage: 'lineage-classify',
            path: filePath,
            code: lineage.reason,
            message: 'A fresh Codex rollout has an incomplete ancestry chain',
            sessionId: meta.id,
            ...lineage,
          });
        }
      }
      continue;
    }
    if (!validTimestamp) {
      errors.push({
        stage: 'metadata-classify',
        path: filePath,
        code: 'session_timestamp_invalid',
        message: 'Descendant metadata has no usable creation timestamp',
        sessionId: meta.id,
      });
      continue;
    }
    descendants.push({
      sessionId: meta.id,
      filePath,
      cwd: meta.cwd || null,
      forkedFromId: meta.forked_from_id,
      createdAtMs,
      lineageDepth: lineage.depth,
      lineageRelation: lineage.relation,
      lineageChain: lineage.chain,
    });
  }

  descendants.sort((left, right) => (
    left.createdAtMs - right.createdAtMs
    || left.lineageDepth - right.lineageDepth
    || left.sessionId.localeCompare(right.sessionId)
  ));
  return {
    complete: errors.length === 0 && !index.truncated,
    descendants,
    errors,
    truncated: index.truncated,
    filesScanned: index.filesScanned,
  };
}

function selectSingleProvenCodexRewindRecoveryCandidate(evaluatedCandidates) {
  const evaluated = Array.isArray(evaluatedCandidates) ? evaluatedCandidates : [];
  const proven = evaluated.filter(candidate => candidate?.targetProof?.proven === true);
  if (proven.length === 1) {
    return {
      status: 'selected',
      selected: proven[0],
      proven,
      evaluated,
    };
  }
  return {
    status: 'unresolved',
    reason: proven.length === 0
      ? 'no-proven-descendant'
      : 'multiple-proven-descendants',
    selected: null,
    proven,
    evaluated,
  };
}

async function findCodexDirectChildSessions(options = {}) {
  const inspection = await inspectCodexDirectChildSessions(options);
  if (!inspection.complete) {
    const error = new Error('Codex direct-child discovery was incomplete');
    error.code = 'CODEX_SESSION_DISCOVERY_INCOMPLETE';
    error.inspection = inspection;
    throw error;
  }
  return inspection.children;
}

async function findCodexDescendantSessions(options = {}) {
  const inspection = await inspectCodexDescendantSessions(options);
  if (!inspection.complete) {
    const error = new Error('Codex descendant discovery was incomplete');
    error.code = 'CODEX_SESSION_DISCOVERY_INCOMPLETE';
    error.inspection = inspection;
    throw error;
  }
  return inspection.descendants;
}

function pushAssistantEntry(
  entries,
  sessionId,
  record,
  turnIndex,
  content,
  thinking,
  actions,
  identityLine = record.__line,
  identityByteOffset = record.__byteOffset,
  textPhase = undefined,
) {
  if (!content && !thinking && (!actions || actions.length === 0)) return;
  const identityRecord = {
    __line: identityLine,
    __byteOffset: identityByteOffset,
  };
  entries.push({
    uuid: stableUuid(sessionId, identityLine, 'codex-assistant'),
    sourceIdentity: stableSourceIdentity(sessionId, identityRecord, 'codex-assistant'),
    role: 'assistant',
    timestamp: recordTimestamp(record),
    content: content || '',
    thinking: thinking || undefined,
    actions: actions && actions.length > 0 ? actions : undefined,
    sessionId,
    turnIndex,
    // Codex marks every assistant text with `phase`: 'commentary' (interim
    // remark — the natural caption for the calls that follow) or
    // 'final_answer' (the turn's real answer, 99.7% the last text of the
    // turn). Claude has no equivalent; its caption linkage runs on
    // messageId instead. The display grammar uses whichever exists.
    textPhase: textPhase || undefined,
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

function isCodexSubagentNotification(payload = {}) {
  if (payload.type !== 'user_message') return false;
  const text = payload.message || extractTextContent(payload.content) || '';
  return String(text).includes('<subagent_notification>');
}

const CODEX_INTERRUPTED_HISTORY_TEXT = 'Conversation interrupted';
const CODEX_GOAL_CONTINUATION_HISTORY_TEXT = 'Goal continued';

// Some Codex protocol generations persist the interrupted boundary as a
// provider-owned role=user carrier instead of (or in addition to) the
// structural turn_aborted event. It is never something the user typed.
function isCodexTurnAbortedUserText(text) {
  return /^<turn_aborted>(?:\s|$)/i.test(String(text || '').trim());
}

/**
 * Resumable Timeline projector — same contract as the history projector
 * below (feed in file order; finalize without consuming state), same reason:
 * a live giant refreshed its Timeline through a full 74K-record replay, and
 * with two giants open the records cache thrashed (evict/full parse every
 * ~10s, live 07.08 09:56). Timeline enrichment mutates the LAST user entry
 * retroactively (token_count/task_complete arrive after the row was pushed),
 * which is resumable by construction — the mutated object is the retained
 * one; finalize hands out shallow copies so callers never alias live state.
 *
 * Also tracks the session-meta head and the fork live-start boundary so
 * getTimelineSessionMeta no longer needs the records array.
 */
function createCodexTimelineProjector(sessionId) {
  const entries = [];
  const pendingResponseUsers = [];
  let currentUser = null;
  let currentTurnIndex = -1;
  let latestModel = null;
  let latestEffort = null;
  let latestTokenCountInfo = null;
  let pendingCompactCompanions = 0;
  let metaRecord = null;
  let forkLiveStartLine;
  let forkStartedAtMs = NaN;
  let currentTurnCanonicalUserText = null;
  let currentTurnCanonicalUserEntry = null;

  const attachSubagentLaunch = (entry, payload, record) => {
    if (!entry) return;
    const callId = String(payload.call_id || payload.id || stableUuidForRecord(sessionId, record, 'codex-agent'));
    const call = {
      callId,
      toolName: payload.name || payload.tool_name || payload.type,
      namespace: payload.namespace || '',
      args: parseToolArguments(payload),
    };
    const nestedSource = call.toolName === 'exec' && typeof call.args?.input === 'string'
      ? call.args.input
      : '';
    if (!isCodexSubagentSpawnCall(call) && !/\bspawn_agent\s*\(/.test(nestedSource)) return;
    // Reuse the exact History decoder: current Codex often wraps
    // `collaboration.spawn_agent` inside one custom `exec` call, so checking
    // only the outer tool name would miss the launch marker on Timeline.
    const decoded = codexHistoryActionsForCall(call, '', false);
    const card = (decoded.actions || []).find((action) => action?.tool === 'Task');
    if (!card) return;
    const label = String(
      card?.description
      || call.args?.task_name
      || call.args?.label
      || call.args?.agent_type
      || 'Agent',
    ).replace(/\s+·\s+running\s*$/i, '');
    const key = 'task:' + (card.toolUseId || callId);
    if (!Array.isArray(entry.subAgents)) entry.subAgents = [];
    if (!entry.subAgents.some((agent) => agent?.key === key)) {
      entry.subAgents.push({ key, label });
    }
  };

  const feed = (record) => {
    const payload = record.payload || {};
    const physicalSessionId = codexRecordPhysicalSessionId(record, sessionId);

    if (record.type === 'session_meta') {
      if (!metaRecord || physicalSessionId === sessionId) {
        metaRecord = { payload, __line: record.__line };
        if (payload.forked_from_id && physicalSessionId === sessionId) {
          forkStartedAtMs = parseTimestampMs(payload.timestamp);
        }
      }
      return;
    }

    // Fork live boundary: first task_started proving the fork's own live run
    // (mirrors getCodexForkLiveStartLine, evaluated incrementally).
    if (
      forkLiveStartLine === undefined
      && Number.isFinite(forkStartedAtMs)
      && record.type === 'event_msg'
      && payload.type === 'task_started'
    ) {
      const payloadStartedAt = Number(payload.started_at);
      if (Number.isFinite(payloadStartedAt) && payloadStartedAt > 0) {
        if (payloadStartedAt * 1000 >= forkStartedAtMs - 1000) forkLiveStartLine = record.__line;
      } else {
        const recordAtMs = parseTimestampMs(record.timestamp);
        if (Number.isFinite(recordAtMs) && recordAtMs >= forkStartedAtMs + 1000) {
          forkLiveStartLine = record.__line;
        }
      }
    }

    if (record.type === 'compacted') {
      pendingCompactCompanions += 1;
      const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
      entries.push({
        uuid: stableUuidForRecord(sessionId, record, 'codex-compact'),
        type: 'compact',
        timestamp: recordTimestamp(record),
        content: compactEventTitle(payload),
        sourceLine: record.__line,
        preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
        postTokens: compactPostTokenCount(payload),
        compactEncrypted: true,
        sessionId: physicalSessionId,
        turnIndex: currentTurnIndex,
      });
      return;
    }

    if (record.type === 'turn_context') {
      latestModel = payload.model || latestModel;
      latestEffort = payload.effort || latestEffort;
      if (currentUser) currentUser.responseModel = latestModel || currentUser.responseModel;
      return;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') {
        currentTurnCanonicalUserText = null;
        currentTurnCanonicalUserEntry = null;
      }
      if (payload.type === 'user_message') {
        const text = codexUserMessagePresentationText(record);
        const goalContinuation = isCodexGoalContinuationUserText(text);
        // Service record, not a user turn: a fire-and-forget subagent
        // announces completion via <subagent_notification> inside a user
        // message. Full history feeds it to the card tracker; Timeline must
        // not mint a phantom dot for it.
        if (isCodexSubagentNotification(payload)) return;
        if (isCodexTurnAbortedUserText(text)
          || isCodexEnvironmentContextUserText(text)
          || isCodexProjectInstructionsUserText(text)) return;
        // Companion pairing window closes at the next REAL user turn (same
        // counter semantics as the old whole-file pre-pass). Injected
        // environment context above is service input, not that boundary.
        pendingCompactCompanions = 0;
        const pendingIndex = pendingResponseUsers.findIndex((candidate) => (
          codexUserCarrierTextsMatch(candidate.text, text)
        ));
        if (pendingIndex >= 0) {
          const pending = pendingResponseUsers.splice(pendingIndex, 1)[0];
          pending.entry.uuid = stableUuidForRecord(sessionId, record, 'codex-user');
          promoteStableSourceIdentity(
            pending.entry,
            stableSourceIdentity(sessionId, record, 'codex-user'),
          );
          pending.entry.timestamp = recordTimestamp(record);
          pending.entry.content = goalContinuation
            ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
            : text;
          pending.entry.isGoalContinuation = goalContinuation || undefined;
          pending.entry.sourceLine = record.__line;
          pending.entry.sessionId = physicalSessionId;
          pending.entry.hasImage = Array.isArray(payload.images) ? payload.images.length > 0 : false;
          currentUser = pending.entry;
        } else {
          currentTurnIndex += 1;
          const entry = {
            uuid: stableUuidForRecord(sessionId, record, 'codex-user'),
            sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-user'),
            type: 'user',
            timestamp: recordTimestamp(record),
            content: goalContinuation
              ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
              : text,
            isGoalContinuation: goalContinuation || undefined,
            sourceLine: record.__line,
            hasImage: Array.isArray(payload.images) ? payload.images.length > 0 : false,
            sessionId: physicalSessionId,
            turnIndex: currentTurnIndex,
            responseModel: latestModel || undefined,
            responseEffort: latestEffort || undefined,
          };
          entries.push(entry);
          currentUser = entry;
        }
        currentTurnCanonicalUserText = text;
        currentTurnCanonicalUserEntry = currentUser;
      } else if (payload.type === 'thread_rolled_back') {
        const rollback = applyRollback(entries, Number(payload.num_turns || payload.turns || 1));
        logCodexRollback('timeline', sessionId, record, rollback);
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
        currentUser = lastCodexTimelineUser(entries);
        currentTurnCanonicalUserEntry = currentUser;
        currentTurnCanonicalUserText = currentUser?.isGoalContinuation
          ? null
          : currentUser?.content || null;
        for (let index = pendingResponseUsers.length - 1; index >= 0; index -= 1) {
          if (!entries.includes(pendingResponseUsers[index].entry)) pendingResponseUsers.splice(index, 1);
        }
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
      } else if (payload.type === 'task_complete' && currentUser) {
        currentUser.responseComplete = true;
        pendingResponseUsers.length = 0;
      } else if (isCompactPayload(payload)) {
        if (pendingCompactCompanions > 0) {
          pendingCompactCompanions -= 1;
          return;
        }
        const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
        entries.push({
          uuid: stableUuidForRecord(sessionId, record, 'codex-compact'),
          type: 'compact',
          timestamp: recordTimestamp(record),
          content: compactEventTitle(payload),
          sourceLine: record.__line,
          preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
          postTokens: compactPostTokenCount(payload),
          compactEncrypted: true,
          sessionId: physicalSessionId,
          turnIndex: currentTurnIndex,
        });
      }
      return;
    }

    if (record.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'user') {
        const text = codexUserMessagePresentationText(record);
        const goalContinuation = isCodexGoalContinuationUserText(text);
        if (!text
          || text.includes('<subagent_notification>')
          || isCodexTurnAbortedUserText(text)
          || isCodexEnvironmentContextUserText(text)
          || isCodexProjectInstructionsUserText(text)) return;
        if (currentTurnCanonicalUserText
          && codexUserCarrierTextsMatch(currentTurnCanonicalUserText, text)) {
          addStableSourceIdentityAlias(
            currentTurnCanonicalUserEntry,
            stableSourceIdentity(sessionId, record, 'codex-user'),
          );
          return;
        }
        pendingCompactCompanions = 0;
        currentTurnIndex += 1;
        const content = Array.isArray(payload.content) ? payload.content : [];
        const entry = {
          uuid: stableUuidForRecord(sessionId, record, 'codex-user'),
          sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-user'),
          type: 'user',
          timestamp: recordTimestamp(record),
          content: goalContinuation
            ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
            : text,
          isGoalContinuation: goalContinuation || undefined,
          sourceLine: record.__line,
          hasImage: content.some((part) => String(part?.type || '').toLowerCase().includes('image')),
          sessionId: physicalSessionId,
          turnIndex: currentTurnIndex,
          responseModel: latestModel || undefined,
          responseEffort: latestEffort || undefined,
        };
        entries.push(entry);
        currentUser = entry;
        pendingResponseUsers.push({ entry, text });
        return;
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        collectCodexDocsAttributes(currentUser, payload);
        attachSubagentLaunch(currentUser, payload, record);
      }
      if (payload.type === 'reasoning' && currentUser) {
        currentUser.responseHasThinking = true;
      } else if (payload.type === 'message' && payload.role === 'assistant' && currentUser) {
        currentUser.responseModel = payload.model || latestModel || currentUser.responseModel;
      }
    }
  };

  const finalize = () => entries.map((entry) => ({
    ...entry,
    ...(Array.isArray(entry.subAgents)
      ? { subAgents: entry.subAgents.map((agent) => ({ ...agent })) }
      : {}),
  }));

  const getSessionMeta = () => {
    const meta = metaRecord?.payload || {};
    return {
      id: meta.id,
      forked_from_id: meta.forked_from_id,
      timestamp: meta.timestamp,
      cwd: meta.cwd,
      sourceLine: metaRecord?.__line,
      forkLiveStartLine,
    };
  };

  return {
    feed,
    finalize,
    getSessionMeta,
    // Cost accounting reads the retained projector state directly; callers
    // still receive cloned rows through finalize().
    peekEntries: () => entries,
  };
}

function buildCodexTimeline(records, sessionId) {
  const projector = createCodexTimelineProjector(sessionId);
  for (const record of Array.isArray(records) ? records : []) {
    projector.feed(record);
  }
  return projector.finalize();
}

/**
 * Resumable full-history projector.
 *
 * The one-shot `buildCodexFullHistory(records)` pass made every refresh of a
 * live session O(whole file): one appended tool result re-projected all 74K
 * records of a 730MB rollout (~3.5s of main loop, tab-3163/3233 ping-pong,
 * live 07.08 09:56). The projector keeps the pass's accumulated state —
 * entries, pending calls, exec cells, subagent tracker, thinking buffer —
 * so a refresh feeds ONLY the appended records.
 *
 * Contract:
 * - `feed(record)` consumes exactly one parsed rollout record. Records must
 *   arrive in file order; identity fields (__line/__byteOffset) come from
 *   the JSONL reader and are stable across incremental re-reads.
 * - `finalize()` returns the presentation array WITHOUT consuming state: the
 *   in-flight tail (pending calls materialized as live cards) is built on a
 *   copy each time, so `feed` may continue afterwards. Calling it twice in a
 *   row returns equal results.
 * - The compact-companion pre-pass of the old builder is folded into a
 *   forward counter (its transitions only ever depended on records already
 *   seen), so no whole-file pre-scan remains.
 *
 * Mutation rules the resumability leans on (same as the one-shot pass):
 * Task cards are shared by reference between state entries and the tracker
 * and are mutated in place by later records; background exec cells fill
 * results into already-pushed action objects. `finalize` mutating a card via
 * the own-transcript last resort is monotone (completed never reverts except
 * by an explicit resume record, which arrives through `feed`).
 */
function createCodexHistoryProjector(sessionId) {
  const entries = [];
  const pendingResponseUsers = [];
  const pendingProjectInstructions = [];
  const pendingCalls = new Map();
  const pendingExecCells = new Map();
  const subagents = createCodexSubagentTracker();
  const registerSubagentSpawn = (call) => {
    const card = subagents.registerSpawn(call);
    const processGeneration = getCodexProcessActionGeneration({
      sessionId: call?.physicalSessionId || sessionId,
      callId: call?.callId,
      sourceByteOffset: call?.byteOffset,
    });
    if (processGeneration) card.processGeneration = processGeneration;
    return card;
  };
  let sessionCwd = '';
  let currentTurnIndex = -1;
  let pendingThinking = '';
  let latestTokenCountInfo = null;
  let lastDisplayedModel = null;
  let lastDisplayedEffort = null;
  // Inline companion counter (was codexCompactCompanionLines): a top-level
  // `compacted` snapshot arms it; the next compact-like event_msg before a
  // real user turn is that snapshot's telemetry twin and renders nothing.
  let pendingCompactCompanions = 0;
  let consumedRecords = 0;
  let currentTurnCanonicalUserText = null;
  let currentTurnCanonicalUserEntry = null;
  let currentInterruptedNotice = null;

  const pushInterruptedNotice = (record) => {
    const physicalSessionId = codexRecordPhysicalSessionId(record, sessionId);
    const sourceIdentity = stableSourceIdentity(sessionId, record, 'codex-interrupted');
    // A protocol run may emit both the reserved user carrier and turn_aborted.
    // They describe one boundary, so retain the second identity as an alias
    // instead of drawing the same notice twice.
    if (
      currentInterruptedNotice?.turnIndex === currentTurnIndex
      && currentInterruptedNotice.physicalSessionId === physicalSessionId
    ) {
      addStableSourceIdentityAlias(currentInterruptedNotice.entry, sourceIdentity);
      return;
    }
    const entry = {
      uuid: stableUuidForRecord(sessionId, record, 'codex-interrupted'),
      sourceIdentity,
      role: 'interrupted',
      timestamp: recordTimestamp(record),
      content: CODEX_INTERRUPTED_HISTORY_TEXT,
      sessionId: physicalSessionId,
      turnIndex: currentTurnIndex,
      serviceCarrier: 'turn-aborted',
    };
    entries.push(entry);
    currentInterruptedNotice = { entry, turnIndex: currentTurnIndex, physicalSessionId };
  };

  const queueProjectInstructions = (record, text) => {
    const physicalSessionId = codexRecordPhysicalSessionId(record, sessionId);
    const existingIndex = pendingProjectInstructions.findIndex((candidate) => (
      codexUserCarrierTextsMatch(candidate.text, text)
    ));
    if (existingIndex >= 0) {
      // Prefer event_msg when a protocol generation emits both carriers. The
      // row is still held until the following real user turn supplies its
      // structural coordinate.
      if (record?.type === 'event_msg') {
        const pending = pendingProjectInstructions[existingIndex];
        pending.record = record;
        pending.entry.uuid = stableUuidForRecord(sessionId, record, 'codex-user');
        promoteStableSourceIdentity(
          pending.entry,
          stableSourceIdentity(sessionId, record, 'codex-user'),
        );
        pending.entry.timestamp = recordTimestamp(record);
        pending.entry.sessionId = physicalSessionId;
      }
      return;
    }
    const entry = {
      uuid: stableUuidForRecord(sessionId, record, 'codex-user'),
      sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-user'),
      role: 'user',
      timestamp: recordTimestamp(record),
      content: text,
      sessionId: physicalSessionId,
      turnIndex: currentTurnIndex + 1,
      serviceCarrier: 'project-instructions',
    };
    entries.push(entry);
    pendingProjectInstructions.push({ record, text, entry });
  };

  const flushProjectInstructions = (turnIndex) => {
    for (const pending of pendingProjectInstructions) pending.entry.turnIndex = turnIndex;
    pendingProjectInstructions.length = 0;
  };

  const feed = (record) => {
    consumedRecords += 1;
    const payload = record.payload || {};
    const physicalSessionId = codexRecordPhysicalSessionId(record, sessionId);

    if (record.type === 'session_meta') {
      if (!sessionCwd) sessionCwd = payload.cwd || '';
      return;
    }

    if (record.type === 'turn_context') {
      const model = typeof payload.model === 'string' ? payload.model.trim() : '';
      const effort = typeof payload.effort === 'string' ? payload.effort.trim() : '';
      const nextTurnIndex = currentTurnIndex + 1;
      if (model && model !== lastDisplayedModel) {
        entries.push({
          uuid: stableUuidForRecord(sessionId, record, 'codex-model'),
          role: 'slash',
          timestamp: recordTimestamp(record),
          content: `/model ${model}`,
          sessionId: physicalSessionId,
          turnIndex: nextTurnIndex,
        });
        lastDisplayedModel = model;
      }
      if (effort && effort !== lastDisplayedEffort) {
        entries.push({
          uuid: stableUuidForRecord(sessionId, record, 'codex-effort'),
          role: 'slash',
          timestamp: recordTimestamp(record),
          content: `/effort ${effort}`,
          sessionId: physicalSessionId,
          turnIndex: nextTurnIndex,
        });
        lastDisplayedEffort = effort;
      }
      return;
    }

    if (record.type === 'compacted') {
      pendingProjectInstructions.length = 0;
      pendingCompactCompanions += 1;
      const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
      entries.push({
        uuid: stableUuidForRecord(sessionId, record, 'codex-compact'),
        sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-compact'),
        role: 'compact',
        timestamp: recordTimestamp(record),
        content: 'Conversation compacted',
        compactSummary: compactEventContent(payload),
        preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
        postTokens: compactPostTokenCount(payload),
        compactEncrypted: true,
        sessionId: physicalSessionId,
        turnIndex: currentTurnIndex,
      });
      return;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') {
        currentTurnCanonicalUserText = null;
        currentTurnCanonicalUserEntry = null;
      }
      if (
        payload.type === 'user_message'
        || payload.type === 'task_started'
        || payload.type === 'task_complete'
        || payload.type === 'turn_aborted'
      ) {
        pendingThinking = '';
      }
      if (payload.type === 'patch_apply_end') {
        attachCodexPatchApplyEvent(pendingCalls, payload, sessionCwd);
      } else if (payload.type === 'user_message') {
        const userText = codexUserMessagePresentationText(record);
        const goalContinuation = isCodexGoalContinuationUserText(userText);
        // Third subagent completion path: a fire-and-forget child announces
        // its outcome via <subagent_notification> INSIDE a user message —
        // no wait_agent output, no agent_message FINAL_ANSWER ever arrives
        // (E2E-proven zombie: card climbed 4m+ as running). Feed the tracker
        // and keep the service record out of the transcript, like Claude's
        // <task-notification> filter.
        if (userText.includes('<subagent_notification>')) {
          subagents.onSubagentNotification(userText, recordTimestamp(record));
          return;
        }
        if (isCodexTurnAbortedUserText(userText)) {
          pushInterruptedNotice(record);
          return;
        }
        if (isCodexEnvironmentContextUserText(userText)) return;
        if (isCodexProjectInstructionsUserText(userText)) {
          queueProjectInstructions(record, userText);
          return;
        }
        currentInterruptedNotice = null;
        // The companion pairing window closes at the next REAL user turn.
        // Codex service carriers above do not create transcript boundaries.
        pendingCompactCompanions = 0;
        const pendingIndex = pendingResponseUsers.findIndex((candidate) => (
          codexUserCarrierTextsMatch(candidate.text, userText)
        ));
        if (pendingIndex >= 0) {
          const pending = pendingResponseUsers.splice(pendingIndex, 1)[0];
          pending.entry.uuid = stableUuidForRecord(sessionId, record, 'codex-user');
          promoteStableSourceIdentity(
            pending.entry,
            stableSourceIdentity(sessionId, record, 'codex-user'),
          );
          promoteCodexPromptPresentationAuditIdentity(pending.entry, record, userText);
          pending.entry.timestamp = recordTimestamp(record);
          pending.entry.role = goalContinuation ? 'goal' : 'user';
          pending.entry.content = goalContinuation
            ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
            : userText;
          pending.entry.serviceCarrier = goalContinuation
            ? 'goal-continuation'
            : undefined;
          pending.entry.sessionId = physicalSessionId;
          currentTurnCanonicalUserEntry = pending.entry;
        } else {
          currentTurnIndex += 1;
          flushProjectInstructions(currentTurnIndex);
          const entry = {
            uuid: stableUuidForRecord(sessionId, record, 'codex-user'),
            sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-user'),
            promptPresentationAuditTimestamp: recordTimestamp(record),
            promptPresentationTransportHash: promptAuditFingerprint(userText),
            role: goalContinuation ? 'goal' : 'user',
            timestamp: recordTimestamp(record),
            content: goalContinuation
              ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
              : userText,
            serviceCarrier: goalContinuation ? 'goal-continuation' : undefined,
            sessionId: physicalSessionId,
            turnIndex: currentTurnIndex,
          };
          entries.push(entry);
          currentTurnCanonicalUserEntry = entry;
        }
        currentTurnCanonicalUserText = userText;
      } else if (payload.type === 'thread_rolled_back') {
        currentInterruptedNotice = null;
        pendingProjectInstructions.length = 0;
        const rollback = applyRollback(entries, Number(payload.num_turns || payload.turns || 1));
        logCodexRollback('full-history', sessionId, record, rollback);
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
        currentTurnCanonicalUserEntry = [...entries].reverse().find((entry) => (
          entry?.role === 'user' || entry?.role === 'goal'
        )) || null;
        currentTurnCanonicalUserText = currentTurnCanonicalUserEntry?.role === 'goal'
          ? null
          : currentTurnCanonicalUserEntry?.content || null;
        for (let index = pendingResponseUsers.length - 1; index >= 0; index -= 1) {
          if (!entries.includes(pendingResponseUsers[index].entry)) pendingResponseUsers.splice(index, 1);
        }
      } else if (payload.type === 'token_count') {
        latestTokenCountInfo = payload.info || {};
      } else if (payload.type === 'task_complete') {
        pendingResponseUsers.length = 0;
        pendingProjectInstructions.length = 0;
      } else if (payload.type === 'turn_aborted') {
        pushInterruptedNotice(record);
      } else if (payload.type === 'sub_agent_activity') {
        // v2 collaboration: the only parent-side link spawn call → child
        // rollout (agent_thread_id) + live status kinds started/interacted/
        // interrupted. Mutates the already-pushed Task card in place.
        subagents.onSubAgentActivity(payload, recordTimestamp(record));
      } else if (isCompactPayload(payload)) {
        if (pendingCompactCompanions > 0) {
          pendingCompactCompanions -= 1;
          return;
        }
        const last = latestTokenCountInfo?.last_token_usage || latestTokenCountInfo?.total_token_usage || {};
        entries.push({
          uuid: stableUuidForRecord(sessionId, record, 'codex-compact'),
          sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-compact'),
          role: 'compact',
          timestamp: recordTimestamp(record),
          content: 'Conversation compacted',
          compactSummary: compactEventContent(payload),
          preTokens: Number(last.total_tokens || last.input_tokens || 0) || undefined,
          postTokens: compactPostTokenCount(payload),
          compactEncrypted: true,
          sessionId: physicalSessionId,
          turnIndex: currentTurnIndex,
        });
      }
      return;
    }

    if (record.type !== 'response_item') return;

    if (payload.type === 'message' && payload.role === 'user') {
      const userText = codexUserMessagePresentationText(record);
      const goalContinuation = isCodexGoalContinuationUserText(userText);
      // Codex currently persists fire-and-forget subagent completion in two
      // legitimate carrier shapes. Older rollouts used event_msg
      // user_message; newer/mixed protocol runs can write only a
      // response_item user message. Both carry the same exact agent identity
      // and must close the same Task card. A normal response_item is also the
      // fallback visible user carrier when this Codex protocol run omits the
      // paired event_msg; the block below upgrades it in place if that event
      // eventually arrives.
      if (userText.includes('<subagent_notification>')) {
        subagents.onSubagentNotification(userText, recordTimestamp(record));
        return;
      }
      if (isCodexTurnAbortedUserText(userText)) {
        pushInterruptedNotice(record);
        return;
      }
      if (!userText || isCodexEnvironmentContextUserText(userText)) return;
      if (isCodexProjectInstructionsUserText(userText)) {
        queueProjectInstructions(record, userText);
        return;
      }
      currentInterruptedNotice = null;
      if (currentTurnCanonicalUserText
        && codexUserCarrierTextsMatch(currentTurnCanonicalUserText, userText)) {
        addStableSourceIdentityAlias(
          currentTurnCanonicalUserEntry,
          stableSourceIdentity(sessionId, record, 'codex-user'),
        );
        addCodexPromptPresentationAuditAlias(
          currentTurnCanonicalUserEntry,
          codexPromptPresentationAuditIdentity(record, userText),
        );
        return;
      }
      pendingCompactCompanions = 0;
      currentTurnIndex += 1;
      flushProjectInstructions(currentTurnIndex);
      const entry = {
        uuid: stableUuidForRecord(sessionId, record, 'codex-user'),
        sourceIdentity: stableSourceIdentity(sessionId, record, 'codex-user'),
        promptPresentationAuditTimestamp: recordTimestamp(record),
        promptPresentationTransportHash: promptAuditFingerprint(userText),
        role: goalContinuation ? 'goal' : 'user',
        timestamp: recordTimestamp(record),
        content: goalContinuation
          ? CODEX_GOAL_CONTINUATION_HISTORY_TEXT
          : userText,
        serviceCarrier: goalContinuation ? 'goal-continuation' : undefined,
        sessionId: physicalSessionId,
        turnIndex: currentTurnIndex,
      };
      entries.push(entry);
      pendingResponseUsers.push({ entry, text: userText });
      return;
    }

    if (payload.type === 'reasoning') {
      const text = extractReasoning(payload.summary);
      if (text) pendingThinking = pendingThinking ? `${pendingThinking}\n${text}` : text;
      return;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = extractTextContent(payload.content);
      const textPhase = payload.phase === 'final_answer' || payload.phase === 'commentary'
        ? payload.phase
        : undefined;
      pushAssistantEntry(
        entries, physicalSessionId, record, currentTurnIndex, text, pendingThinking, null,
        record.__line, record.__byteOffset, textPhase,
      );
      pendingThinking = '';
      return;
    }

    if (payload.type === 'agent_message') {
      // v2 collaboration result carrier: FINAL_ANSWER payload is plaintext and
      // becomes the Task card's result; interim MESSAGE payloads are encrypted
      // and only prove liveness. Never rendered as a normal assistant row —
      // author is the subagent, not this session's assistant.
      subagents.onAgentMessage(payload, extractTextContent, recordTimestamp(record));
      return;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id || payload.id || stableUuidForRecord(sessionId, record, 'codex-call');
      const args = payload.arguments
        ? (safeJsonParse(payload.arguments, { raw: payload.arguments }) || {})
        : (payload.input && typeof payload.input === 'string'
          ? { input: payload.input }
          : (payload.input || {}));
      const pendingCall = {
        callId,
        toolName: payload.name || payload.tool_name || payload.type,
        namespace: payload.namespace || '',
        args: args && typeof args === 'object' ? args : { value: args },
        cwd: sessionCwd,
        turnId: String(
          payload.turn_id
          || payload.internal_chat_message_metadata_passthrough?.turn_id
          || '',
        ),
        patchApplyEvents: [],
        timestamp: recordTimestamp(record),
        line: record.__line,
        byteOffset: record.__byteOffset,
        physicalSessionId,
        // Exact presentation slot at CALL time. Most calls close immediately,
        // but a lost output can leave one pending for days. finalize() must
        // materialize that orphan where the call happened, not append it after
        // every later final answer (real session 7395…: old Search 12367 was
        // rendered below answer 13737 although its byte offset was 35MB older).
        entryIndexAtCall: entries.length,
        record,
      };
      // Register spawn cards at CALL time: the v2 sub_agent_activity(started)
      // event that binds the child thread id arrives BETWEEN the call and its
      // output, so output-time registration would drop that linkage.
      if (isCodexSubagentSpawnCall(pendingCall)) {
        pendingCall.subagentCard = registerSubagentSpawn(pendingCall);
      }
      pendingCalls.set(callId, pendingCall);
      return;
    }

    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const callId = payload.call_id || payload.id;
      const call = pendingCalls.get(callId) || {
        callId,
        toolName: payload.name || payload.type,
        namespace: payload.namespace || '',
        args: {},
        timestamp: recordTimestamp(record),
        line: record.__line,
        byteOffset: record.__byteOffset,
        physicalSessionId,
      };
      // Subagent lifecycle: spawn becomes a Task card (SubAgentBlock UX like
      // the Claude SDK tab); v1 spawn output binds agent_id/nickname; control
      // calls (wait/close/…) feed results into existing cards instead of
      // rendering as generic "Spawn Agent"/"Wait Agent" JSON cards.
      if (isCodexSubagentSpawnCall(call)) {
        const card = call.subagentCard || registerSubagentSpawn(call);
        subagents.attachSpawnOutput(call.callId, payload.output, recordTimestamp(record));
        pushAssistantEntry(
          entries,
          call.physicalSessionId || physicalSessionId,
          record,
          currentTurnIndex,
          '',
          pendingThinking,
          [card],
          call.line,
          call.byteOffset,
        );
        pendingThinking = '';
        pendingCalls.delete(callId);
        return;
      }
      if (isCodexSubagentControlCall(call)) {
        const absorbed = subagents.absorbControlOutput(
          call,
          payload.output,
          recordTimestamp(record),
        );
        if (absorbed) {
          pushAssistantEntry(entries, physicalSessionId, record, currentTurnIndex, '', pendingThinking, null);
          pendingThinking = '';
          pendingCalls.delete(callId);
          return;
        }
      }
      const waitCellId = call.toolName === 'wait' ? String(call.args?.cell_id || '') : '';
      const pendingCellActions = waitCellId ? pendingExecCells.get(waitCellId) : null;
      if (pendingCellActions) {
        fillPendingCodexHistoryActions(pendingCellActions, payload.output, !!payload.is_error);
        pendingExecCells.delete(waitCellId);
        pushAssistantEntry(entries, physicalSessionId, record, currentTurnIndex, '', pendingThinking, null);
      } else {
        const decoded = codexHistoryActionsForCall(call, payload.output, !!payload.is_error);
        // The call row owns the visible card identity. Completion enriches that
        // same card instead of replacing it with an output-line row, preserving
        // collapse state and Virtuoso measurement during streaming.
        pushAssistantEntry(
          entries,
          call.physicalSessionId || physicalSessionId,
          record,
          currentTurnIndex,
          '',
          pendingThinking,
          decoded.actions,
          call.line,
          call.byteOffset,
        );
        if (decoded.cellId) pendingExecCells.set(decoded.cellId, decoded.actions);
      }
      pendingThinking = '';
      pendingCalls.delete(callId);
    }
  };

  const finalize = () => {
    // A transcript-changed notification is emitted as soon as Codex appends
    // the call, before its output exists. Keep that in-flight call in the
    // canonical history snapshot so a live semantic tool card is not briefly
    // replaced by an empty REST reload during a long-running command. A
    // pending `wait` for a known async exec cell is intentionally hidden: the
    // original projected card is already present in `entries` and owns the
    // eventual result.
    //
    // Built on a COPY: pending calls stay pending and the thinking buffer is
    // not consumed, so later `feed` calls attach them to their real records
    // exactly as a fresh one-shot pass at that future moment would.
    const tail = [];
    const tailPlacements = [];
    const rememberTailPlacement = (call, beforeLength) => {
      const anchor = Number.isInteger(call?.entryIndexAtCall)
        ? Math.max(0, Math.min(entries.length, call.entryIndexAtCall))
        : entries.length;
      for (let index = beforeLength; index < tail.length; index += 1) {
        tailPlacements.push({ entry: tail[index], anchor });
      }
    };
    let tailThinking = pendingThinking;
    for (const call of pendingCalls.values()) {
      const waitCellId = call.toolName === 'wait' ? String(call.args?.cell_id || '') : '';
      if (waitCellId && pendingExecCells.has(waitCellId)) continue;
      // In-flight spawn (no output yet): show a running Task card, not raw
      // JSON. The card is cached on the call so repeated finalizes reuse ONE
      // tracker identity instead of re-registering a fresh card (which would
      // orphan the accumulated status of the previous one).
      if (isCodexSubagentSpawnCall(call)) {
        if (!call.subagentCard) call.subagentCard = registerSubagentSpawn(call);
        const beforeLength = tail.length;
        pushAssistantEntry(
          tail,
          call.physicalSessionId || sessionId,
          call.record || { __line: call.line, timestamp: call.timestamp },
          currentTurnIndex,
          '',
          tailThinking,
          [call.subagentCard],
        );
        rememberTailPlacement(call, beforeLength);
        tailThinking = '';
        continue;
      }
      // An in-flight wait_agent while subagent cards exist is control-plane
      // noise — the cards already carry the live status.
      if (isCodexSubagentControlCall(call) && call.toolName === 'wait_agent' && subagents.hasCards()) {
        continue;
      }
      const decoded = codexHistoryActionsForCall(call, undefined, false);
      const beforeLength = tail.length;
      pushAssistantEntry(
        tail,
        call.physicalSessionId || sessionId,
        call.record || { __line: call.line, timestamp: call.timestamp },
        currentTurnIndex,
        '',
        tailThinking,
        decoded.actions
      );
      rememberTailPlacement(call, beforeLength);
      tailThinking = '';
    }

    // Last resort for cards the parent never closed, and exact timing source
    // for cards a later list_agents query could only classify as completed.
    // `wait_agent` is routinely
    // called with no target, and its "Wait completed" output names nobody — so
    // an agent that really finished can leave zero terminal trace in this
    // rollout and keep animating the tab forever (live production tab: 12 of
    // 36 spawns, 11 of them plainly finished in their own file). Each such
    // agent is checked against its OWN transcript, which is authoritative
    // about itself. Card mutation here is monotone — an explicit resume
    // record arriving later through `feed` reopens it, same as a fresh pass.
    const trackedCards = subagents.allCards().filter((card) => (
      card.subagentStatus === 'running'
      || (card.subagentStatus === 'completed' && !Number(card.completedAt))
    ));
    if (trackedCards.length > 0) {
      let resolved = 0;
      for (const card of trackedCards) {
        const threadId = card.agentSessionId;
        if (!threadId) continue;
        const filePath = findCodexAgentFile({ agentSessionId: threadId });
        if (!filePath) continue;
        const completion = readAgentCompletionProof({ toolType: 'codex', filePath });
        if (!completion.finished) continue;
        if (card.subagentStatus === 'running') resolved += 1;
        card.subagentStatus = 'completed';
        card.description = card.baseDescription;
        if (!card.result) card.result = 'Агент завершил работу (по его собственной истории).';
        if (completion.completedAt > 0) {
          card.completedAt = completion.completedAt;
          if (Number(card.startedAt) > 0) {
            card.durationMs = Math.max(0, completion.completedAt - Number(card.startedAt));
          }
        }
      }
      if (resolved > 0) {
        console.log('[CodexSubagents] closed by own transcript: ' + resolved
          + '/' + trackedCards.length + ' session=' + String(sessionId).slice(0, 8));
      }
    }

    // Pending calls are presentation rows, but not necessarily TAIL rows. A
    // current in-flight call naturally anchors at entries.length; an old call
    // whose output was lost anchors at the number of rows that existed when
    // its call record arrived. Buckets preserve provider arrival order when
    // several concurrent calls share one slot.
    const pendingByAnchor = new Map();
    for (const placement of tailPlacements) {
      const bucket = pendingByAnchor.get(placement.anchor) || [];
      bucket.push(placement.entry);
      pendingByAnchor.set(placement.anchor, bucket);
    }
    const presented = [];
    const appendPresented = (source) => {
      const { turnIndex, ...entry } = source;
      presented.push(entry);
    };
    for (let index = 0; index <= entries.length; index += 1) {
      const pending = pendingByAnchor.get(index);
      if (pending) pending.forEach(appendPresented);
      if (index < entries.length) appendPresented(entries[index]);
    }
    return presented;
  };

  return {
    feed,
    finalize,
    getConsumedRecords: () => consumedRecords,
    // Live view of the accumulated rows, for cost accounting only. Excludes
    // the in-flight tail (which finalize builds fresh each time) — that is a
    // handful of rows and never the memory that matters.
    peekEntries: () => entries,
  };
}

function buildCodexFullHistory(records, sessionId) {
  const projector = createCodexHistoryProjector(sessionId);
  for (const record of Array.isArray(records) ? records : []) {
    projector.feed(record);
  }
  return projector.finalize();
}

// ── Per-session projector reuse (file-cursor based) ─────────────────────────
// The projector cache turns a live-session History refresh from O(file) into
// O(appended tail) — and, unlike the records cache, it does not need the
// parsed records array at all after the first build: the cache record keeps a
// FILE CURSOR (size/mtime consumed + carry-over of a partially written last
// line, mirroring _parseJsonlFileIncremental's semantics exactly), and a
// refresh reads only bytes [cursor.size, stat.size) straight from disk. Two
// 730MB rollouts therefore stop fighting over the 768MB records budget: what
// survives per giant is the projector state + projected entries (~150MB),
// bounded by the byte budget below.
//
// Witness rules (same as the records cache): size+mtime equal → unchanged;
// size grew → append-only tail read; size shrank or same-size-different-mtime
// → the file was rewritten, burn and rebuild. Explicit rewrite paths
// (edit/fork/forceFresh) additionally burn through invalidateCodexJsonlCache.
//
// The cache is bounded by BYTES, not by session count. Counting sessions was
// the original bound (cap 2, chosen when a giant's projection cost ~150MB),
// and it broke the moment row-level hydration made a giant cheap: an 18-row
// session and a 16K-row session each took one slot, so opening eleven small
// tabs evicted the giant and the return paid a full 5.5s re-parse (live
// 07.08 17:45, tab-3163). A byte budget makes the bound describe the thing
// it protects — main-process memory — instead of a proxy that no longer
// correlates with it.
const CODEX_HISTORY_PROJECTOR_BUDGET_DEFAULT_MB = 400;
// Empty and tiny sessions still retain two stateful projectors, maps, cursors
// and metadata. Charge a conservative fixed floor so the BYTE budget also
// bounds session count without a second, contradictory count-based truth.
// At the 64MB minimum this permits at most 64 tiny sessions; at larger budgets
// real projected content normally dominates long before the floor does.
const CODEX_HISTORY_PROJECTOR_MIN_SESSION_BYTES = 1024 * 1024;
let _codexHistoryProjectorBudgetBytes = CODEX_HISTORY_PROJECTOR_BUDGET_DEFAULT_MB * 1024 * 1024;
let _codexHistoryProjectorBytes = 0;
const _codexHistoryProjectors = new Map(); // sessionId → cache record
const _codexProjectorChains = new Map(); // sessionId → serialization tail

/**
 * Budget is read once at startup from the app settings (see
 * `historyProjectorBudgetMb` in SettingsModal) — changing it takes effect on
 * restart, which is what the setting's own hint promises. Applying it live
 * would mean re-costing every cached projector mid-flight for a knob nobody
 * turns twice a session.
 */
function setCodexHistoryProjectorBudgetMb(valueMb) {
  const parsed = Math.floor(Number(valueMb));
  if (!Number.isFinite(parsed) || parsed <= 0) return _codexHistoryProjectorBudgetBytes;
  // Floor keeps one giant resident whatever the user types; ceiling keeps a
  // typo from claiming the whole V8 heap of the main process.
  const clamped = Math.max(64, Math.min(2048, parsed));
  _codexHistoryProjectorBudgetBytes = clamped * 1024 * 1024;
  console.log('[CodexHistoryProjector] budget=' + clamped + 'MB'
    + (clamped !== parsed ? ' requested=' + parsed + ' (clamped)' : ''));
  return _codexHistoryProjectorBudgetBytes;
}

/**
 * Approximate retained bytes of one projector's presentation.
 *
 * Sampled, not walked: the array can hold 16K rows and this runs on every
 * cache insert. Heavy payloads already live in the shared payload stash
 * (dehydration), so what is measured here is the presentation skeleton —
 * exactly what the renderer-side estimator measures on its own copy, and its
 * numbers matched production within the same order (12-30MB per session).
 */
const PROJECTOR_COST_SAMPLE_ROWS = 48;
function estimateProjectorBytes(entries) {
  const rows = Array.isArray(entries) ? entries.length : 0;
  if (rows === 0) return 0;
  let sampledBytes = 0;
  let sampled = 0;
  const step = Math.max(1, Math.floor(rows / PROJECTOR_COST_SAMPLE_ROWS));
  for (let index = 0; index < rows; index += step) {
    const entry = entries[index];
    if (!entry) continue;
    let bytes = 128; // object overhead + fixed identity fields
    if (typeof entry.content === 'string') bytes += entry.content.length * 2;
    if (typeof entry.thinking === 'string') bytes += entry.thinking.length * 2;
    if (typeof entry.compactSummary === 'string') bytes += entry.compactSummary.length * 2;
    const actions = Array.isArray(entry.actions) ? entry.actions : null;
    if (actions) {
      for (const action of actions) {
        bytes += 96;
        const raw = action && action.tool === '__raw__' ? action.rawTool : null;
        if (!raw) continue;
        if (typeof raw.result === 'string') bytes += raw.result.length * 2;
        if (raw.args) {
          // Args hold apply_patch bodies and command text — the biggest
          // remaining non-dehydrated field.
          for (const value of Object.values(raw.args)) {
            if (typeof value === 'string') bytes += value.length * 2;
            else bytes += 32;
          }
        }
        if (Array.isArray(raw.diffHunks)) {
          for (const hunk of raw.diffHunks) {
            const lines = Array.isArray(hunk?.entries) ? hunk.entries.length : 0;
            bytes += 64 + lines * 96;
          }
        }
      }
    }
    sampledBytes += bytes;
    sampled += 1;
  }
  if (sampled === 0) return rows * 128;
  return Math.round((sampledBytes / sampled) * rows);
}

function estimateCodexProjectorCacheEntryBytes(historyEntries, timelineEntries) {
  return Math.max(
    CODEX_HISTORY_PROJECTOR_MIN_SESSION_BYTES,
    estimateProjectorBytes(historyEntries) + estimateProjectorBytes(timelineEntries),
  );
}

function _dropProjectorEntry(sessionId) {
  const cached = _codexHistoryProjectors.get(sessionId);
  if (!cached) return false;
  _codexHistoryProjectors.delete(sessionId);
  _codexHistoryProjectorBytes = Math.max(0, _codexHistoryProjectorBytes - (cached.approxBytes || 0));
  return true;
}

function invalidateCodexHistoryProjectors(filePath = null) {
  if (!filePath) {
    _codexHistoryProjectors.clear();
    _codexHistoryProjectorBytes = 0;
    return;
  }
  for (const [sessionId, cached] of [..._codexHistoryProjectors]) {
    if (cached.filePath === filePath) _dropProjectorEntry(sessionId);
  }
}

function getCodexHistoryProjectorStats() {
  return {
    sessions: _codexHistoryProjectors.size,
    approxBytes: _codexHistoryProjectorBytes,
    budgetBytes: _codexHistoryProjectorBudgetBytes,
    minimumSessionBytes: CODEX_HISTORY_PROJECTOR_MIN_SESSION_BYTES,
  };
}

/**
 * Serialized per session: overlapping calls (renderer History refresh +
 * Timeline + web client) must not feed the same projectors concurrently —
 * later callers wait and then see an unchanged cursor.
 */
function _chainCodexProjection(sessionId, task) {
  const previous = _codexProjectorChains.get(sessionId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  _codexProjectorChains.set(sessionId, run);
  run.finally(() => {
    if (_codexProjectorChains.get(sessionId) === run) {
      _codexProjectorChains.delete(sessionId);
    }
  }).catch(() => {});
  return run;
}

function projectCodexFullHistoryFromFile(sessionId, cwd, options = {}) {
  return _chainCodexProjection(sessionId, async () => {
    const advanced = await _advanceCodexProjection(sessionId, cwd, options);
    if (!advanced.success) return advanced;
    const entries = advanced.cached.historyProjector.finalize();
    return { ...advanced.result, entries };
  });
}

function projectCodexTimelineFromFile(sessionId, cwd, options = {}) {
  return _chainCodexProjection(sessionId, async () => {
    const advanced = await _advanceCodexProjection(sessionId, cwd, options);
    if (!advanced.success) return advanced;
    const entries = advanced.cached.timelineProjector.finalize();
    const sessionMeta = advanced.cached.timelineProjector.getSessionMeta();
    return { ...advanced.result, entries, sessionMeta };
  });
}

async function _advanceCodexProjection(sessionId, cwd, options = {}) {
  const startedAt = Date.now();
  const found = await findCodexSessionFile(sessionId, cwd, {
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
  });
  if (!found) return { success: false, error: 'Codex session file not found' };
  const filePath = found.filePath;
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    invalidateCodexHistoryProjectors(filePath);
    return { success: false, error: 'Codex session stat failed: ' + (error?.message || error) };
  }

  let cached = _codexHistoryProjectors.get(sessionId) || null;
  let mode = 'rebuild';
  if (cached && cached.filePath === filePath) {
    if (cached.fileSize === stat.size && cached.fileMtimeMs === stat.mtimeMs) mode = 'unchanged';
    else if (stat.size > cached.fileSize) mode = 'append';
  }

  let fedRecords = 0;
  let readBytes = 0;
  if (mode === 'rebuild') {
    _dropProjectorEntry(sessionId);
    // Self-contained read up to OUR stat.size — deliberately not coupled to
    // parseJsonlFile's records cache. Copying a cursor from that cache is
    // racy (the file can grow between our stat and the shared parse, and a
    // straddling last line cannot be reconstructed afterwards), and coupling
    // would also keep giants pinned in the 768MB records budget for History's
    // sake. The projector cache makes rebuilds rare (first open / rewrite),
    // so one direct read is the whole price; the records cache keeps serving
    // usage/export consumers independently. One read feeds BOTH projections.
    const result = await readJsonlRange(filePath, 0, stat.size - 1);
    const historyProjector = createCodexHistoryProjector(sessionId);
    const timelineProjector = createCodexTimelineProjector(sessionId);
    for (const record of result.records) {
      historyProjector.feed(record);
      timelineProjector.feed(record);
    }
    fedRecords = result.records.length;
    readBytes = stat.size;
    cached = {
      historyProjector,
      timelineProjector,
      filePath,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
      lineCount: result.lineCount,
      leftoverBuffer: result.leftoverBuffer,
    };
  } else if (mode === 'append') {
    const result = await readJsonlRange(filePath, cached.fileSize, stat.size - 1, {
      records: [],
      lineCount: cached.lineCount,
      leftoverBuffer: cached.leftoverBuffer,
    });
    for (const record of result.records) {
      cached.historyProjector.feed(record);
      cached.timelineProjector.feed(record);
    }
    fedRecords = result.records.length;
    readBytes = stat.size - cached.fileSize;
    cached.fileSize = stat.size;
    cached.fileMtimeMs = stat.mtimeMs;
    cached.lineCount = result.lineCount;
    cached.leftoverBuffer = result.leftoverBuffer;
  }

  // LRU refresh + byte budget. Re-costed on every advance: an append grows
  // the projection, and a stale cost would let the cache drift past its
  // budget exactly on the sessions that grow fastest.
  const previousCost = _codexHistoryProjectors.get(sessionId) === cached
    ? (cached.approxBytes || 0)
    : 0;
  cached.approxBytes = estimateCodexProjectorCacheEntryBytes(
    cached.historyProjector.peekEntries(),
    cached.timelineProjector.peekEntries(),
  );
  _codexHistoryProjectors.delete(sessionId);
  _codexHistoryProjectorBytes = Math.max(0, _codexHistoryProjectorBytes - previousCost)
    + cached.approxBytes;
  _codexHistoryProjectors.set(sessionId, cached);
  const usedBeforeEvictionBytes = _codexHistoryProjectorBytes;
  const evicted = [];
  while (
    _codexHistoryProjectorBytes > _codexHistoryProjectorBudgetBytes
    && _codexHistoryProjectors.size > 1
  ) {
    // Never evict the session we just served (it is the newest key, and the
    // size>1 guard keeps one giant resident even if it alone exceeds the
    // budget — the alternative is re-parsing it on every single request).
    const lruKey = _codexHistoryProjectors.keys().next().value;
    if (lruKey === undefined || lruKey === sessionId) break;
    evicted.push(lruKey);
    _dropProjectorEntry(lruKey);
  }
  if (evicted.length > 0) {
    console.log('[CodexHistoryProjector] evict sessions=' + evicted.map((id) => String(id).slice(0, 8)).join(',')
      + ' reason=byte-budget'
      + ' remaining=' + _codexHistoryProjectors.size
      + ' usedBeforeMB=' + Math.round(usedBeforeEvictionBytes / (1024 * 1024))
      + ' usedMB=' + Math.round(_codexHistoryProjectorBytes / (1024 * 1024))
      + ' budgetMB=' + Math.round(_codexHistoryProjectorBudgetBytes / (1024 * 1024)));
  }

  if (mode !== 'unchanged' || Date.now() - startedAt >= 50) {
    console.log('[CodexHistoryProjector] session=' + String(sessionId || '').slice(0, 8)
      + ' mode=' + mode
      + ' fed=' + fedRecords
      + ' readKB=' + Math.round(readBytes / 1024)
      + ' consumed=' + cached.historyProjector.getConsumedRecords()
      + ' ms=' + (Date.now() - startedAt));
  }
  return {
    success: true,
    cached,
    result: {
      success: true,
      filePath,
      mode,
      fedRecords,
      // Built from the CURSOR, not a fresh stat: the file may have grown
      // again while we were reading, and a revision newer than the entries
      // it labels would make the next ifRevision check falsely answer
      // "unchanged".
      sourceSnapshot: {
        filePath,
        size: cached.fileSize,
        mtimeMs: cached.fileMtimeMs,
        sessionId,
        linkKind: 'end',
      },
    },
  };
}

const CODEX_SHELL_TOOLS = new Set([
  'exec_command', 'write_stdin', 'read_output', 'run_command', 'restart_process',
  'kill_process', 'run_chain',
]);
// Both rollout generations: v1 multi_agent_v1 + v2 collaboration tool names.
const CODEX_SUBAGENT_NAMES = new Set([
  'spawn_agent', 'resume_agent', 'wait_agent', 'send_input', 'close_agent',
  'send_message', 'followup_task', 'interrupt_agent', 'list_agents',
]);
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
  return call.toolName || call.name || call.tool_name || call.type || 'tool';
}

function codexToolGroup(call) {
  const type = call?.type;
  const name = codexToolName(call);
  const namespace = call?.namespace || '';
  if (type === 'web_search_call' || name === 'web_search') return 'web';
  if (type === 'tool_search_call' || type === 'tool_search_output' || name === 'tool_search') return 'toolSearch';
  if (namespace === 'multi_agent_v1' || namespace === 'collaboration' || CODEX_SUBAGENT_NAMES.has(name)) return 'subagent';
  if (name === 'apply_patch') return 'editing';
  if (namespace && namespace.startsWith('mcp__')) return 'mcp';
  if (CODEX_SHELL_TOOLS.has(name)) return 'bash';
  return 'tools';
}

function parseCodexCallArgs(call) {
  if (!call) return {};
  if (call.type === 'web_search_call') return call.action || {};
  if (call.type === 'tool_search_call') return call.arguments || {};
  if (call.args && typeof call.args === 'object') return call.args;
  return parseToolArguments(call);
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
  const args = parseCodexCallArgs(call);
  const output = normalizeCodexToolOutput(outputPayload);
  if (group === 'subagent') {
    const subject = String(
      args.task_name || args.label || args.target || args.agent_id
      || (name === 'wait_agent' ? 'result' : 'subagent'),
    ).trim();
    // Result-only means the terminal result carrier, not the spawn receipt.
    const result = opts.includeSubagentHistory || name === 'wait_agent' ? output : '';
    return formatCopyAction({
      toolName: 'Subagent',
      description: subject,
      args,
      result,
      isError: !!outputPayload?.is_error,
    }, opts);
  }

  let actions = [];
  if (call?.type === 'web_search_call' || name === 'web_search') {
    actions = [{ toolName: 'WebSearch', args, result: output, isError: !!outputPayload?.is_error }];
  } else if (call?.type === 'tool_search_call' || call?.type === 'tool_search_output' || name === 'tool_search') {
    actions = [{ toolName: 'Tool Search', args, result: output, isError: !!outputPayload?.is_error }];
  } else {
    const decoded = codexHistoryActionsForCall({
      callId: call?.call_id || call?.id || '',
      toolName: name,
      args,
      namespace: call?.namespace || '',
      patchApplyEvents: call?.patchApplyEvents,
    }, output, !!outputPayload?.is_error);
    actions = (decoded.actions || []).map((action) => (
      action?.tool === 'Task'
        ? {
            toolName: 'Subagent',
            description: action.description,
            args: action.args || {},
            result: action.result,
            isError: action.isError,
          }
        : (action.rawTool || action)
    ));
  }

  const formatted = actions
    .map((action) => formatCopyAction(action, opts))
    .filter(Boolean);
  return formatted.length > 0 ? formatted.join('\n\n') : null;
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
    const turnKey = wrappers[i]?.turnKey;
    if (!Number.isFinite(turnKey)) continue;
    if (!turns.includes(turnKey)) turns.push(turnKey);
    if (turns.length >= requested) break;
  }
  if (turns.length === 0) return { removedTurns: [], removedRecords: 0 };
  const remove = new Set(turns);
  let removedRecords = 0;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    if (!remove.has(wrappers[i]?.turnKey)) continue;
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

function isCodexTurnPreambleRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === 'turn_context') return true;
  if (record?.type === 'event_msg' && payload.type === 'task_started') return true;
  if (record?.type !== 'response_item' || payload.type !== 'message') return false;
  if (payload.role === 'developer') return true;
  if (payload.role !== 'user') return false;
  const text = codexUserMessageAuditText(record) || '';
  return isCodexEnvironmentContextUserText(text)
    || isCodexProjectInstructionsUserText(text);
}

function codexPendingStartForUserMessage(pending, message) {
  if (!normalizeCodexText(message)) return pending.length;
  let duplicateIdx = -1;
  for (let i = pending.length - 1; i >= 0; i--) {
    const record = pending[i]?.record;
    if (!isCodexResponseUserRecord(record)) continue;
    const text = codexUserMessageAuditText(record) || '';
    if (codexUserCarrierTextsMatch(text, message)) {
      duplicateIdx = i;
      break;
    }
  }
  if (duplicateIdx < 0) {
    // Some Codex protocol generations emit only event_msg/user_message. The
    // preceding task_started + turn_context still belong to that new turn;
    // leaving them on the previous turn creates an orphan settings/start pair
    // after deletion. A task_started is the causal boundary. Without one, only
    // a trailing turn_context can safely move with the user record.
    let taskStartedIdx = -1;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const record = pending[i]?.record;
      if (record?.type === 'event_msg' && record.payload?.type === 'task_started') {
        taskStartedIdx = i;
        break;
      }
    }
    let start = taskStartedIdx >= 0 ? taskStartedIdx : pending.length;
    while (start > 0 && pending[start - 1]?.record?.type === 'turn_context') {
      start -= 1;
    }
    return start;
  }
  let start = duplicateIdx;
  while (start > 0 && isCodexTurnPreambleRecord(pending[start - 1]?.record)) start -= 1;
  return start;
}

function cloneCodexRecordForWrite(record) {
  if (!record || typeof record !== 'object') return {};
  const {
    __line: _sourceLine,
    __byteOffset: _sourceByteOffset,
    __byteEndOffset: _sourceByteEndOffset,
    ...cloned
  } = record;
  const rawImages = record[CODEX_COMPACT_RAW_IMAGES];
  if (rawImages) {
    Object.defineProperty(cloned, CODEX_COMPACT_RAW_IMAGES, {
      value: rawImages,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
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
    turnKey: Number.isFinite(extra.turnKey) ? Number(extra.turnKey) : null,
    line: record?.__line,
    ...extra,
  });
}

function buildCodexVisibleRecordWrappers(records, sessionId) {
  const wrappers = [];
  const compactCompanionLines = codexCompactCompanionLines(records);
  const pending = [];
  let currentTurnIndex = -1;
  let currentTurnKey = null;

  const flushPending = (turnIndex) => {
    const fallbackIndex = pending.findIndex((item) => {
      if (!isCodexResponseUserRecord(item?.record)) return false;
      const text = codexUserMessageAuditText(item.record) || '';
      return !!text
        && !text.includes('<subagent_notification>')
        && !isCodexEnvironmentContextUserText(text)
        && !isCodexProjectInstructionsUserText(text);
    });
    if (fallbackIndex >= 0) {
      const fallbackText = codexUserMessageAuditText(pending[fallbackIndex].record) || '';
      const turnStart = codexPendingStartForUserMessage(pending, fallbackText);
      for (let index = 0; index < turnStart; index += 1) {
        pushCodexVisibleWrapper(wrappers, pending[index].record, turnIndex, {
          turnKey: currentTurnKey,
        });
      }
      currentTurnIndex = Math.max(currentTurnIndex, turnIndex) + 1;
      currentTurnKey = Number(pending[fallbackIndex].record?.__line);
      for (let index = turnStart; index < pending.length; index += 1) {
        const record = pending[index].record;
        pushCodexVisibleWrapper(
          wrappers,
          record,
          currentTurnIndex,
          record === pending[fallbackIndex].record
            ? {
                sourceUuid: stableUuid(sessionId, record.__line, 'codex-user'),
                kind: 'user',
                turnKey: currentTurnKey,
              }
            : { turnKey: currentTurnKey },
        );
      }
      pending.length = 0;
      return;
    }
    while (pending.length > 0) {
      const item = pending.shift();
      pushCodexVisibleWrapper(wrappers, item.record, turnIndex, {
        turnKey: currentTurnKey,
      });
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
      currentTurnKey = [...wrappers].reverse().find((wrapper) => Number.isFinite(wrapper?.turnKey))?.turnKey ?? null;
      continue;
    }

    if (record?.type === 'event_msg' && payload.type === 'user_message') {
      if (isCodexSubagentNotification(payload)) {
        for (const item of pending) {
          pushCodexVisibleWrapper(wrappers, item.record, currentTurnIndex, {
            turnKey: currentTurnKey,
          });
        }
        pending.length = 0;
        pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
          turnKey: currentTurnKey,
        });
        continue;
      }
      const previousTurnIndex = currentTurnIndex;
      const previousTurnKey = currentTurnKey;
      currentTurnIndex += 1;
      currentTurnKey = Number(record.__line);
      const text = codexUserMessageAuditText(record) || '';
      const turnStart = codexPendingStartForUserMessage(pending, text);
      for (let i = 0; i < turnStart; i++) {
        pushCodexVisibleWrapper(wrappers, pending[i].record, previousTurnIndex, {
          turnKey: previousTurnKey,
        });
      }
      for (let i = turnStart; i < pending.length; i++) {
        pushCodexVisibleWrapper(wrappers, pending[i].record, currentTurnIndex, {
          turnKey: currentTurnKey,
        });
      }
      pending.length = 0;
      pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
        sourceUuid: stableUuid(sessionId, record.__line, 'codex-user'),
        kind: 'user',
        turnKey: currentTurnKey,
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
        turnKey: null,
      });
      currentTurnKey = null;
      continue;
    }

    if (record?.type === 'event_msg' && isCompactPayload(payload)) {
      const isTopLevelCompanion = compactCompanionLines.has(record.__line);
      pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
        sourceUuid: isTopLevelCompanion ? null : stableUuid(sessionId, record.__line, 'codex-compact'),
        kind: isTopLevelCompanion ? undefined : 'compact',
        turnKey: null,
      });
      currentTurnKey = null;
      continue;
    }

    pushCodexVisibleWrapper(wrappers, record, currentTurnIndex, {
      turnKey: currentTurnKey,
    });
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

const CODEX_COMPACT_IMAGE_PLACEHOLDER = /"(image_url|imageUrl)"\s*:\s*("\[image omitted\]")/g;

function compactImagePlaceholderRanges(serialized) {
  const ranges = [];
  CODEX_COMPACT_IMAGE_PLACEHOLDER.lastIndex = 0;
  let match;
  while ((match = CODEX_COMPACT_IMAGE_PLACEHOLDER.exec(serialized))) {
    const rawValue = match[2];
    const valueStart = match.index + match[0].lastIndexOf(rawValue);
    ranges.push({
      key: match[1],
      valueStart,
      valueEnd: valueStart + rawValue.length,
    });
  }
  CODEX_COMPACT_IMAGE_PLACEHOLDER.lastIndex = 0;
  return ranges;
}

async function appendVerifiedCodexRawImage(handle, image) {
  if (!image?.filePath
    || !Number.isInteger(image.start)
    || !Number.isInteger(image.endExclusive)
    || image.endExclusive <= image.start
    || image.byteLength !== image.endExclusive - image.start) {
    throw new Error('Codex compact raw-image source is invalid');
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const stream = fs.createReadStream(image.filePath, {
    start: image.start,
    end: image.endExclusive - 1,
    highWaterMark: CODEX_JSONL_WRITE_CHUNK_BYTES,
  });
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
    await handle.appendFile(chunk);
  }
  if (bytes !== image.byteLength || hash.digest('hex') !== image.sha256) {
    const error = new Error('Codex compact raw-image source changed before fork write');
    error.code = 'codex_compact_raw_image_source_changed';
    throw error;
  }
}

async function appendCodexRecordWithRawImages(handle, serialized, rawImages) {
  const placeholders = compactImagePlaceholderRanges(serialized);
  const images = Array.isArray(rawImages?.images) ? rawImages.images : [];
  if (placeholders.length !== images.length || images.length === 0) {
    throw new Error('Codex compact raw-image placeholder count mismatch');
  }
  let cursor = 0;
  for (let index = 0; index < placeholders.length; index += 1) {
    const placeholder = placeholders[index];
    const image = images[index];
    if (placeholder.key !== image.key) {
      throw new Error('Codex compact raw-image key order mismatch');
    }
    if (placeholder.valueStart > cursor) {
      await handle.appendFile(serialized.slice(cursor, placeholder.valueStart), 'utf8');
    }
    await appendVerifiedCodexRawImage(handle, image);
    cursor = placeholder.valueEnd;
  }
  await handle.appendFile(serialized.slice(cursor) + '\n', 'utf8');
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
      const writableRecord = cloneCodexRecordForWrite(record);
      const serialized = JSON.stringify(writableRecord);
      if (typeof serialized !== 'string') {
        throw new Error('Codex edited fork contains a non-serializable record');
      }
      const rawImages = writableRecord[CODEX_COMPACT_RAW_IMAGES];
      if (rawImages) {
        await flush();
        await appendCodexRecordWithRawImages(handle, serialized, rawImages);
        continue;
      }
      if (writableRecord?.type === 'compacted'
        && serialized.includes('"[image omitted]"')
        && compactImagePlaceholderRanges(serialized).length > 0) {
        const error = new Error('Codex compact image source is unavailable for fork write');
        error.code = 'codex_compact_image_source_unavailable';
        throw error;
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

function buildCodexEmptySessionMetaRecord({ sessionId, cwd, timestamp }) {
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp,
      cwd,
      // Match the ownership class emitted by interactive Codex. The app's
      // discovery layer intentionally excludes exec/app-server/subagent
      // rollouts from user-tab writer adoption.
      originator: 'codex-tui',
      cli_version: '0.0.0',
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
    },
  };
}

async function materializeEmptyCodexSession({
  cwd,
  sessionId = null,
  now = new Date(),
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  const exactCwd = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null;
  if (!exactCwd) {
    const error = new Error('codex_empty_session_cwd_required');
    error.code = 'codex_empty_session_cwd_required';
    throw error;
  }
  const exactSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : crypto.randomUUID();
  const timestamp = now.toISOString();
  const { yyyy, mm, dd } = codexDateParts(now);
  const dir = path.join(sessionsDir, yyyy, mm, dd);
  await fs.promises.mkdir(dir, { recursive: true });
  const records = [buildCodexEmptySessionMetaRecord({
    sessionId: exactSessionId,
    cwd: exactCwd,
    timestamp,
  })];

  let filePath = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? '' : '-' + attempt;
    filePath = path.join(
      dir,
      `rollout-${codexRolloutTimestamp(now)}-${exactSessionId}${suffix}.jsonl`,
    );
    try {
      await writeCodexJsonlExclusive(filePath, records);
      invalidateCodexJsonlCache(filePath);
      return {
        success: true,
        committed: true,
        sessionId: exactSessionId,
        filePath,
        createdAt: timestamp,
        records,
      };
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  const error = new Error('codex_empty_session_path_unavailable');
  error.code = 'codex_empty_session_path_unavailable';
  throw error;
}

function isCodexRealUserRecord(record) {
  const text = codexUserMessageAuditText(record);
  if (text === null) return false;
  return !isCodexEnvironmentContextUserText(text)
    && !isCodexProjectInstructionsUserText(text);
}

function inspectCodexConversationMaterialization(records, sessionId = null) {
  const list = Array.isArray(records) ? records : [];
  const meta = getSessionMeta(list);
  const exactSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : null;
  if (!meta?.id || (exactSessionId && meta.id !== exactSessionId)) {
    return {
      materialized: false,
      metadataOnly: false,
      userRecords: 0,
      reason: 'session-meta-missing-or-mismatched',
    };
  }
  const userRecords = list.filter(isCodexRealUserRecord).length;
  const userTurns = buildCodexTimeline(list, meta.id)
    .filter((entry) => entry?.type === 'user').length;
  return {
    materialized: userTurns > 0,
    metadataOnly: userTurns === 0,
    userRecords,
    userTurns,
    reason: userTurns > 0 ? 'user-history-present' : 'session-meta-only',
  };
}

const CODEX_MATERIALIZATION_HEAD_MAX_BYTES = 512 * 1024;

async function inspectCodexConversationMaterializationFromFile(
  sessionId,
  cwd,
  options = {},
) {
  const exactSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!exactSessionId) {
    return {
      materialized: false,
      metadataOnly: false,
      userRecords: 0,
      userTurns: 0,
      reason: 'session-id-missing',
    };
  }
  const found = await findCodexSessionFile(exactSessionId, cwd, {
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
  });
  if (!found?.filePath) {
    return {
      materialized: false,
      metadataOnly: false,
      userRecords: 0,
      userTurns: 0,
      reason: 'session-file-missing',
    };
  }
  const stat = await fs.promises.stat(found.filePath);
  const maxBytes = Math.max(
    1024,
    Number(options.maxBytes) || CODEX_MATERIALIZATION_HEAD_MAX_BYTES,
  );
  const readBytes = Math.min(stat.size, maxBytes);
  const parsed = readBytes > 0
    ? await readJsonlRange(found.filePath, 0, readBytes - 1)
    : { records: [], errors: 0 };
  const projected = inspectCodexConversationMaterialization(
    parsed.records || [],
    exactSessionId,
  );
  if (projected.materialized === true || stat.size <= maxBytes) {
    return {
      ...projected,
      filePath: found.filePath,
      inspectedBytes: readBytes,
      fileSize: stat.size,
      bounded: stat.size > maxBytes,
    };
  }
  return {
    materialized: false,
    metadataOnly: false,
    userRecords: Number(projected.userRecords || 0),
    userTurns: Number(projected.userTurns || 0),
    reason: 'materialization-unresolved-bounded-head',
    filePath: found.filePath,
    inspectedBytes: readBytes,
    fileSize: stat.size,
    bounded: true,
  };
}

function rewriteCodexEditedForkMetadata(
  records,
  sourceSessionId,
  cwd,
  outputRecords,
  newSessionId,
  nowIso,
) {
  const metaIdx = outputRecords.findIndex((record) => record?.type === 'session_meta');
  if (metaIdx >= 0) {
    const meta = outputRecords[metaIdx];
    meta.timestamp = nowIso;
    meta.payload = { ...(meta.payload || {}) };
    meta.payload.id = newSessionId;
    // Current Codex rollouts may carry both identity aliases. Keeping the
    // copied source session_id next to the new id makes the edited rollout
    // self-contradictory and causes the Resume settings proof to reject it.
    // Both fields describe this new rollout; forked_from_id preserves ancestry.
    meta.payload.session_id = newSessionId;
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
        session_id: newSessionId,
        timestamp: nowIso,
        cwd: cwd || '',
        originator: 'noted-terminal',
        source: 'cli',
        thread_source: 'user',
        forked_from_id: sourceSessionId,
      },
    });
  }
}

function normalizeCodexHistoryMutationSettingsProof(value, sourceSessionId) {
  const model = typeof value?.model === 'string' ? value.model.trim() : '';
  const effort = typeof value?.effort === 'string' ? value.effort.trim().toLowerCase() : '';
  const proofAt = Number(value?.proofAt);
  const ownerSessionId = typeof value?.sessionId === 'string' ? value.sessionId.trim() : '';
  if (!model || !effort || !Number.isFinite(proofAt) || proofAt <= 0) return null;
  if (ownerSessionId && ownerSessionId !== sourceSessionId) return null;
  return {
    model,
    effort,
    proofAt,
    sessionId: sourceSessionId,
    ...(typeof value?.fast === 'boolean' ? { fast: value.fast } : {}),
  };
}

function resolveCodexHistoryMutationSettingsProof(records, sourceSessionId, explicitProof = null) {
  const normalizedExplicit = normalizeCodexHistoryMutationSettingsProof(explicitProof, sourceSessionId);
  const source = resolveCodexSourceSettingsProof(records, sourceSessionId);
  if (source.status === 'found') {
    const record = records[source.recordIndex];
    const recordAt = Date.parse(record?.timestamp || '');
    const sourceProofAt = Number.isFinite(recordAt) && recordAt > 0 ? recordAt : Date.now();
    const matchingExplicit = normalizedExplicit
      && normalizedExplicit.model === source.model
      && normalizedExplicit.effort === source.effort
      ? normalizedExplicit
      : null;
    return {
      status: 'found',
      model: source.model,
      effort: source.effort,
      proofAt: matchingExplicit
        ? Math.max(sourceProofAt, matchingExplicit.proofAt)
        : sourceProofAt,
      sessionId: sourceSessionId,
      sourceKind: source.sourceKind,
      source: 'source-jsonl',
      ...(matchingExplicit && typeof matchingExplicit.fast === 'boolean'
        ? { fast: matchingExplicit.fast }
        : {}),
    };
  }
  if (source.status === 'invalid') return source;
  if (normalizedExplicit) {
    return {
      status: 'found',
      ...normalizedExplicit,
      sourceKind: 'renderer-proof',
      source: 'exact-renderer-proof',
    };
  }
  return source;
}

function ensureCodexEditedForkSettingsProof(outputRecords, newSessionId, proof, nowIso) {
  if (!proof || proof.status !== 'found') {
    return { success: false, error: 'Codex history mutation settings proof is unavailable' };
  }
  let resolved = resolveCodexSourceSettingsProof(outputRecords, newSessionId);
  if (resolved.status === 'found'
    && resolved.model === proof.model
    && resolved.effort === proof.effort) {
    return { success: true, injected: false, proof };
  }
  if (resolved.status === 'invalid') {
    return {
      success: false,
      error: 'Codex edited child settings metadata is invalid: ' + (resolved.reason || 'unknown'),
    };
  }
  // Append the carried pair so it is the latest structured settings state of
  // the edited thread. Inserting near session_meta would let an older retained
  // turn_context later in the file override it during Resume proof.
  outputRecords.push({
    timestamp: nowIso,
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: {
        model: proof.model,
        reasoning_effort: proof.effort,
      },
      source: 'noted-terminal-history-mutation',
      source_session_id: proof.sessionId,
      proof_at: proof.proofAt,
    },
  });
  resolved = resolveCodexSourceSettingsProof(outputRecords, newSessionId);
  if (resolved.status !== 'found'
    || resolved.model !== proof.model
    || resolved.effort !== proof.effort) {
    return {
      success: false,
      error: 'Codex edited child settings proof validation failed',
      status: resolved.status,
      reason: resolved.reason,
    };
  }
  return { success: true, injected: true, proof };
}

function persistCodexForkHistoryEvent({
  sourceSessionId,
  childSessionId,
  sourceRecords,
  outputRecords,
  occurredAt,
  forkMode,
  origin = 'app',
}) {
  if (!codexUsageStateStore?.saveSessionForkEvent) return false;
  const childRecords = (Array.isArray(outputRecords) ? outputRecords : [])
    .map((record, index) => ({ ...record, __line: index }));
  const childTimeline = buildCodexTimeline(childRecords, childSessionId);
  const sourceTimeline = buildCodexTimeline(
    Array.isArray(sourceRecords) ? sourceRecords : [],
    sourceSessionId,
  );
  const sourceTotalIterations = sourceTimeline.filter((entry) => entry?.type === 'user').length;
  const event = codexUsageStateStore.saveSessionForkEvent({
    provider: 'codex',
    sourceSessionId,
    childSessionId,
    entryUuids: childTimeline.map((entry) => entry.uuid).filter(Boolean),
    boundaryEntryUuid: childTimeline.at(-1)?.uuid || null,
    snapshotComplete: true,
    occurredAt,
    forkMode,
    origin,
    isDirect: true,
    afterIterationIndex: sourceTotalIterations > 0 ? sourceTotalIterations - 1 : null,
    nextIterationIndex: sourceTotalIterations,
  });
  if (codexUsageStateStore.copyTimelineMetadataForMappedFork) {
    const mappings = mapTimelineEntryUuidsAcrossFork(sourceTimeline, childTimeline);
    codexUsageStateStore.copyTimelineMetadataForMappedFork(
      childSessionId,
      mappings,
      null,
    );
    codexUsageStateStore.markSessionForkMetadataCopied?.(event.eventKey);
  }
  return true;
}

async function writeCodexEditedFork(records, sourceSessionId, cwd, outputRecords, options = {}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const newSessionId = crypto.randomUUID();
  const { yyyy, mm, dd } = codexDateParts(now);
  const dir = path.join(CODEX_SESSIONS_DIR, yyyy, mm, dd);
  await fs.promises.mkdir(dir, { recursive: true });

  rewriteCodexEditedForkMetadata(
    records,
    sourceSessionId,
    cwd,
    outputRecords,
    newSessionId,
    nowIso,
  );
  const settingsProof = resolveCodexHistoryMutationSettingsProof(
    records,
    sourceSessionId,
    options.codexSettingsProof,
  );
  const settingsReady = settingsProof?.status === 'found'
    ? ensureCodexEditedForkSettingsProof(
        outputRecords,
        newSessionId,
        settingsProof,
        nowIso,
      )
    : options.requireSettingsProof === true
      ? { success: false, error: 'Codex history mutation settings proof is unavailable' }
      : { success: true, injected: false, proof: null };
  if (!settingsReady.success) {
    const error = new Error(settingsReady.error);
    error.code = 'codex_history_mutation_settings_unproven';
    error.reason = settingsProof?.reason || settingsReady.reason || 'settings-pair-absent';
    throw error;
  }

  let filePath = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = attempt === 0 ? '' : '-' + attempt;
    filePath = path.join(dir, `rollout-${codexRolloutTimestamp(now)}-${newSessionId}${suffix}.jsonl`);
    try {
      await writeCodexJsonlExclusive(filePath, outputRecords);
      return {
        newSessionId,
        filePath,
        createdAt: nowIso,
        ...(settingsProof?.status === 'found'
          ? {
              codexSettingsProof: {
                model: settingsProof.model,
                effort: settingsProof.effort,
                proofAt: settingsProof.proofAt,
                sessionId: newSessionId,
                ...(typeof settingsProof.fast === 'boolean' ? { fast: settingsProof.fast } : {}),
              },
            }
          : {}),
        settingsProofInjected: settingsReady.injected === true,
      };
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

function codexTimelineSemanticEntry(entry) {
  return {
    type: entry?.type || 'unknown',
    content: normalizeCodexText(entry?.content || ''),
    compactSummary: normalizeCodexText(entry?.compactSummary || ''),
    hasImage: entry?.hasImage === true,
  };
}

function validateCodexRangeRewriteProjection({
  sourceTimeline,
  outputRecords,
  minIndex,
  maxIndex,
  replacementText,
}) {
  const expected = sourceTimeline
    .filter((_entry, index) => index < minIndex || index > maxIndex)
    .map(codexTimelineSemanticEntry);
  if (replacementText) {
    expected.splice(minIndex, 0, {
      type: 'user',
      content: normalizeCodexText(replacementText),
      compactSummary: '',
      hasImage: false,
    });
  }
  const projectedRecords = outputRecords.map((record, index) => ({
    ...record,
    __line: index,
  }));
  const actual = buildCodexTimeline(projectedRecords, 'codex-range-validation')
    .map(codexTimelineSemanticEntry);
  if (actual.length !== expected.length) {
    return {
      success: false,
      error: 'Codex range rewrite projection count mismatch',
      expectedCount: expected.length,
      actualCount: actual.length,
    };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (JSON.stringify(actual[index]) === JSON.stringify(expected[index])) continue;
    return {
      success: false,
      error: 'Codex range rewrite projection content mismatch',
      mismatchIndex: index,
      expected: expected[index],
      actual: actual[index],
    };
  }
  return { success: true, expectedCount: expected.length, actualCount: actual.length };
}

function planCodexRangeRewrite(records, sessionId, startUuid, endUuid, replacementText = null) {
  const timeline = buildCodexTimeline(records, sessionId);
  const startIndex = timeline.findIndex((entry) => entry.uuid === startUuid);
  const endIndex = timeline.findIndex((entry) => entry.uuid === endUuid);
  if (startIndex < 0 || endIndex < 0) {
    return { success: false, error: 'Timeline range not found' };
  }

  const minIndex = Math.min(startIndex, endIndex);
  let maxIndex = Math.max(startIndex, endIndex);
  // A rewrite from the first visible entry is a new root. Any compact snapshot
  // immediately following the selected prefix still describes that deleted
  // root and cannot lead the first retained user turn. Middle-range deletes do
  // not use this expansion: their following compact remains valid and must stay.
  if (minIndex === 0) {
    while (timeline[maxIndex + 1]?.type === 'compact') maxIndex += 1;
  }
  const selected = timeline.slice(minIndex, maxIndex + 1);

  const selectedTurns = new Set();
  const selectedTurnKeys = new Set();
  const selectedCompacts = new Set();
  const wrappers = buildCodexVisibleRecordWrappers(records, sessionId);
  const canonicalByUuid = new Map(
    wrappers
      .filter((wrapper) => wrapper.sourceUuid)
      .map((wrapper) => [wrapper.sourceUuid, wrapper]),
  );
  const selectedUserUuids = new Set();
  for (const entry of selected) {
    if (entry.type === 'compact') {
      selectedCompacts.add(entry.uuid);
      continue;
    }
    if (entry.type !== 'user') continue;
    const canonical = canonicalByUuid.get(entry.uuid);
    if (!canonical || canonical.kind !== 'user' || !Number.isFinite(canonical.turnKey)) {
      return {
        success: false,
        error: 'Selected Codex user turn has no exact rollout identity',
        entryUuid: entry.uuid,
      };
    }
    selectedUserUuids.add(entry.uuid);
    selectedTurnKeys.add(Number(canonical.turnKey));
    if (typeof entry.turnIndex === 'number') selectedTurns.add(entry.turnIndex);
  }
  if (selectedTurnKeys.size !== selectedUserUuids.size) {
    return {
      success: false,
      error: 'Selected Codex turns have ambiguous rollout identities',
      selectedUsers: selectedUserUuids.size,
      selectedTurnKeys: selectedTurnKeys.size,
    };
  }
  if (selectedTurnKeys.size === 0 && selectedCompacts.size === 0) {
    return { success: false, error: 'Selected range has no editable Codex turns' };
  }

  const selectedCompactLines = new Set(
    wrappers
      .filter((wrapper) => wrapper.sourceUuid && selectedCompacts.has(wrapper.sourceUuid))
      .map((wrapper) => Number(wrapper.line))
      .filter((line) => Number.isFinite(line))
  );
  if (selectedCompactLines.size !== selectedCompacts.size) {
    return {
      success: false,
      error: 'Selected Codex compact has no exact rollout identity',
      selectedCompacts: selectedCompacts.size,
      selectedCompactLines: selectedCompactLines.size,
    };
  }
  const compactCompanionPairs = codexCompactCompanionPairs(records);
  const selectedCompactCompanionLines = new Set(
    [...selectedCompactLines]
      .map((line) => compactCompanionPairs.get(line))
      .filter((line) => Number.isFinite(line)),
  );
  const isSelectedCompactCompanion = (wrapper) => {
    if (!isCodexCompactRecord(wrapper.record)) return false;
    const line = Number(wrapper.line);
    return Number.isFinite(line) && selectedCompactCompanionLines.has(line);
  };
  const shouldRemoveWrapper = (wrapper) => {
    if (Number.isFinite(wrapper.turnKey) && selectedTurnKeys.has(Number(wrapper.turnKey))) return true;
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
  const removedUserUuids = new Set();

  for (const wrapper of wrappers) {
    const shouldRemove = shouldRemoveWrapper(wrapper);
    if (shouldRemove) {
      if (replacementRecords.length > 0 && !inserted) {
        for (const replacement of replacementRecords) outputRecords.push(replacement);
        inserted = true;
      }
      removedRecords += 1;
      if (wrapper.kind === 'user') {
        removedUsers += 1;
        if (wrapper.sourceUuid) removedUserUuids.add(wrapper.sourceUuid);
      }
      continue;
    }
    outputRecords.push(cloneCodexRecordForWrite(wrapper.record));
  }

  if (replacementRecords.length > 0 && !inserted) {
    for (const replacement of replacementRecords) outputRecords.push(replacement);
  }

  if (removedUsers !== selectedUserUuids.size
    || removedUserUuids.size !== selectedUserUuids.size
    || [...selectedUserUuids].some((uuid) => !removedUserUuids.has(uuid))) {
    return {
      success: false,
      error: 'Codex range rewrite user identity validation failed',
      selectedUsers: selectedUserUuids.size,
      removedUsers,
      removedUserUuids: [...removedUserUuids],
    };
  }
  const projection = validateCodexRangeRewriteProjection({
    sourceTimeline: timeline,
    outputRecords,
    minIndex,
    maxIndex,
    replacementText,
  });
  if (!projection.success) return projection;

  return {
    success: true,
    outputRecords,
    replacementRecords,
    removedCount: removedRecords,
    removedUsers,
    selectedCount: selected.length,
    selectedTurns: Array.from(selectedTurns),
    selectedTurnKeys: Array.from(selectedTurnKeys),
    selectedCompacts: Array.from(selectedCompacts),
    expectedRemainingCount: projection.expectedCount,
  };
}

function planCodexForkFromLatestCompact(records, sessionId) {
  const wrappers = buildCodexVisibleRecordWrappers(records, sessionId);
  let compactIndex = -1;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    if (wrappers[index]?.record?.type === 'compacted') {
      compactIndex = index;
      break;
    }
  }
  if (compactIndex < 0) {
    return {
      success: false,
      reason: 'no-compact',
      error: 'В этой Codex-сессии ещё нет сжатия контекста',
    };
  }

  const outputRecords = [];
  const sessionMeta = wrappers.find((wrapper) => wrapper?.record?.type === 'session_meta');
  if (sessionMeta) outputRecords.push(cloneCodexRecordForWrite(sessionMeta.record));
  for (let index = compactIndex; index < wrappers.length; index += 1) {
    const record = wrappers[index]?.record;
    if (!record || record.type === 'session_meta') continue;
    outputRecords.push(cloneCodexRecordForWrite(record));
  }

  return {
    success: true,
    outputRecords,
    compactLine: wrappers[compactIndex]?.line ?? null,
    removedRecordCount: wrappers
      .slice(0, compactIndex)
      .filter((wrapper) => wrapper?.record?.type !== 'session_meta')
      .length,
    retainedRecordCount: outputRecords.filter((record) => record?.type !== 'session_meta').length,
  };
}

async function forkCodexFromLatestCompact({ sessionId, cwd }) {
  if (!sessionId) return { success: false, error: 'sessionId required' };
  const loaded = await loadSessionRecords(sessionId, cwd);
  if (!loaded.success) return loaded;
  const plan = planCodexForkFromLatestCompact(loaded.records, sessionId);
  if (!plan.success) return plan;

  const result = await writeCodexEditedFork(
    loaded.records,
    sessionId,
    cwd,
    plan.outputRecords,
    { forkMode: 'latest_compact' },
  );
  let historyEventPersisted = false;
  try {
    historyEventPersisted = persistCodexForkHistoryEvent({
      sourceSessionId: sessionId,
      childSessionId: result.newSessionId,
      sourceRecords: loaded.records,
      outputRecords: plan.outputRecords,
      occurredAt: result.createdAt,
      forkMode: 'latest_compact',
    });
  } catch (historyEventError) {
    console.warn('[CodexData] compact fork history event persist failed child=' + result.newSessionId.slice(0, 8) + ': ' + historyEventError.message);
  }
  return {
    success: true,
    newSessionId: result.newSessionId,
    filePath: result.filePath,
    sourceFilePath: loaded.filePath,
    fromLatestCompact: true,
    compactLine: plan.compactLine,
    removedRecordCount: plan.removedRecordCount,
    retainedRecordCount: plan.retainedRecordCount,
    historyEventPersisted,
  };
}

async function editCodexRange({
  sessionId,
  cwd,
  startUuid,
  endUuid,
  compactText,
  codexSettingsProof = null,
  validateOnly = false,
}) {
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
  const effectiveSettingsProof = resolveCodexHistoryMutationSettingsProof(
    loaded.records,
    sessionId,
    codexSettingsProof,
  );
  if (effectiveSettingsProof.status !== 'found') {
    return {
      success: false,
      error: 'Codex history mutation settings proof is unavailable',
      code: 'codex_history_mutation_settings_unproven',
      reason: effectiveSettingsProof.reason || 'settings-pair-absent',
    };
  }

  console.log('[CodexRangeRewrite] operation=edit source=' + String(sessionId).slice(0, 8)
    + ' selected=' + plan.selectedCount
    + ' users=' + plan.removedUsers
    + ' rawRecords=' + plan.removedCount
    + ' expectedRemaining=' + plan.expectedRemainingCount);
  if (validateOnly === true) {
    return {
      success: true,
      validationOnly: true,
      removedCount: plan.removedCount,
      removedUsers: plan.removedUsers,
      selectedCount: plan.selectedCount,
      expectedRemainingCount: plan.expectedRemainingCount,
      codexSettingsProof: effectiveSettingsProof,
    };
  }

  const replacementEventRecord = plan.replacementRecords.find(
    (record) => record.type === 'event_msg' && record.payload?.type === 'user_message'
  );
  let result;
  try {
    result = await writeCodexEditedFork(loaded.records, sessionId, cwd, plan.outputRecords, {
      codexSettingsProof: effectiveSettingsProof,
      requireSettingsProof: true,
      forkMode: 'history_edit',
    });
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
      code: error?.code || null,
      reason: error?.reason || null,
    };
  }
  const outputRecords = plan.outputRecords;
  const rewrittenRecords = outputRecords.map((record, index) => ({ ...record, __line: index }));
  const remainingTimeline = buildCodexTimeline(rewrittenRecords, result.newSessionId);
  if (remainingTimeline.length !== plan.expectedRemainingCount) {
    await fs.promises.unlink(result.filePath).catch(() => {});
    invalidateCodexJsonlCache(result.filePath);
    return {
      success: false,
      error: 'Codex edited child failed post-write Timeline validation',
      code: 'codex_history_mutation_postwrite_validation_failed',
      expectedRemainingCount: plan.expectedRemainingCount,
      actualRemainingCount: remainingTimeline.length,
    };
  }
  const finalLine = outputRecords.findIndex((record) => record === replacementEventRecord);
  const replacementUuid = finalLine >= 0 ? stableUuid(result.newSessionId, finalLine, 'codex-user') : null;
  let historyEventPersisted = false;
  try {
    historyEventPersisted = persistCodexForkHistoryEvent({
      sourceSessionId: sessionId,
      childSessionId: result.newSessionId,
      sourceRecords: loaded.records,
      outputRecords,
      occurredAt: result.createdAt,
      forkMode: 'history_edit',
    });
  } catch (historyEventError) {
    console.warn('[CodexData] edited fork history event persist failed child=' + result.newSessionId.slice(0, 8) + ': ' + historyEventError.message);
  }

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
    codexSettingsProof: result.codexSettingsProof,
    settingsProofInjected: result.settingsProofInjected,
    expectedRemainingCount: plan.expectedRemainingCount,
    remainingCount: remainingTimeline.length,
    historyEventPersisted,
  };
}

async function deleteCodexRange({
  sessionId,
  cwd,
  startUuid,
  endUuid,
  codexSettingsProof = null,
  validateOnly = false,
}) {
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
  const effectiveSettingsProof = resolveCodexHistoryMutationSettingsProof(
    loaded.records,
    sessionId,
    codexSettingsProof,
  );
  if (effectiveSettingsProof.status !== 'found') {
    return {
      success: false,
      error: 'Codex history mutation settings proof is unavailable',
      code: 'codex_history_mutation_settings_unproven',
      reason: effectiveSettingsProof.reason || 'settings-pair-absent',
    };
  }

  console.log('[CodexRangeRewrite] operation=delete source=' + String(sessionId).slice(0, 8)
    + ' selected=' + plan.selectedCount
    + ' users=' + plan.removedUsers
    + ' rawRecords=' + plan.removedCount
    + ' turnKeys=' + plan.selectedTurnKeys.join(',')
    + ' expectedRemaining=' + plan.expectedRemainingCount);
  if (validateOnly === true) {
    return {
      success: true,
      validationOnly: true,
      removedCount: plan.removedCount,
      removedUsers: plan.removedUsers,
      selectedCount: plan.selectedCount,
      selectedTurnKeys: plan.selectedTurnKeys,
      selectedCompacts: plan.selectedCompacts,
      expectedRemainingCount: plan.expectedRemainingCount,
      codexSettingsProof: effectiveSettingsProof,
    };
  }

  let result;
  try {
    result = await writeCodexEditedFork(loaded.records, sessionId, cwd, plan.outputRecords, {
      codexSettingsProof: effectiveSettingsProof,
      requireSettingsProof: true,
      forkMode: 'history_delete',
    });
  } catch (error) {
    return {
      success: false,
      error: error?.message || String(error),
      code: error?.code || null,
      reason: error?.reason || null,
    };
  }
  const rewrittenRecords = plan.outputRecords.map((record, index) => ({ ...record, __line: index }));
  const remainingTimeline = buildCodexTimeline(rewrittenRecords, result.newSessionId);
  if (remainingTimeline.length !== plan.expectedRemainingCount) {
    await fs.promises.unlink(result.filePath).catch(() => {});
    invalidateCodexJsonlCache(result.filePath);
    return {
      success: false,
      error: 'Codex deleted child failed post-write Timeline validation',
      code: 'codex_history_mutation_postwrite_validation_failed',
      expectedRemainingCount: plan.expectedRemainingCount,
      actualRemainingCount: remainingTimeline.length,
    };
  }
  let historyEventPersisted = false;
  try {
    historyEventPersisted = persistCodexForkHistoryEvent({
      sourceSessionId: sessionId,
      childSessionId: result.newSessionId,
      sourceRecords: loaded.records,
      outputRecords: plan.outputRecords,
      occurredAt: result.createdAt,
      forkMode: 'history_delete',
    });
  } catch (historyEventError) {
    console.warn('[CodexData] deleted fork history event persist failed child=' + result.newSessionId.slice(0, 8) + ': ' + historyEventError.message);
  }

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
    selectedTurnKeys: plan.selectedTurnKeys,
    remainingCount: remainingTimeline.length,
    remainingUsers: remainingTimeline.filter((entry) => entry.type === 'user').length,
    fileDeleted: false,
    codexSettingsProof: result.codexSettingsProof,
    settingsProofInjected: result.settingsProofInjected,
    expectedRemainingCount: plan.expectedRemainingCount,
    historyEventPersisted,
  };
}

function codexCopyOptions(params = {}) {
  const includeTools = params.includeTools ?? false;
  const includeBash = params.includeBash ?? false;
  return {
    includeEditing: params.includeEditing ?? false,
    includeReading: params.includeReading ?? false,
    includeSearch: params.includeSearch ?? includeBash,
    includeRun: params.includeRun ?? includeBash,
    includeGit: params.includeGit ?? includeBash,
    includeMcp: params.includeMcp ?? includeTools,
    includeWeb: params.includeWeb ?? params.includeWebSearch ?? false,
    includePlan: params.includePlan ?? params.includeToolSearch ?? params.includeOtherTools ?? false,
    includeOther: params.includeOther ?? params.includeOtherTools ?? params.includeToolSearch ?? includeTools,
    includeActions: params.includeActions ?? true,
    fromStart: params.fromStart ?? true,
    includeSubagentResult: params.includeSubagentResult ?? false,
    includeSubagentHistory: params.includeSubagentHistory ?? false,
    includeUser: params.includeUser ?? true,
    includeClaude: params.includeClaude ?? true,
    includeText: params.includeText ?? true,
    includeThinking: params.includeThinking ?? true,
    includeBash,
    includeTools,
    includeWebSearch: params.includeWebSearch ?? false,
    includeToolSearch: params.includeToolSearch ?? false,
    includeOtherTools: params.includeOtherTools ?? includeTools,
  };
}

function compactCopyTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '';
  if (count < 1000) return String(Math.floor(count));
  const rounded = count >= 10_000
    ? Math.round(count / 1000)
    : Math.round(count / 100) / 10;
  return String(rounded).replace(/\.0$/, '') + 'k';
}

function codexCompactCopyLine(preTokens, postTokens) {
  const pre = Number(preTokens);
  const post = Number(postTokens);
  const preText = compactCopyTokenCount(pre);
  const postText = compactCopyTokenCount(post);
  if (preText && postText) {
    const reduced = pre > post ? compactCopyTokenCount(pre - post) : '';
    return `Context compacted · ${preText} → ${postText} tokens${reduced ? `, −${reduced}` : ''} (encrypted)`;
  }
  if (postText) return `Context compacted · ${postText} tokens (encrypted)`;
  return 'Context compacted (encrypted)';
}

function buildCodexCleanEntries(records, sessionId, opts = codexCopyOptions()) {
  const entries = [];
  const pendingResponseUsers = [];
  const pendingProjectInstructions = [];
  const compactCompanionLines = codexCompactCompanionLines(records);
  const pendingCalls = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';
  let currentTurnCanonicalUserText = null;
  let latestTokenCountInfo = null;

  const push = (entry) => entries.push({ ...entry, turnIndex: currentTurnIndex });
  const compactText = (payload) => {
    const last = latestTokenCountInfo?.last_token_usage
      || latestTokenCountInfo?.total_token_usage
      || {};
    const preTokens = Number(last.total_tokens || last.input_tokens || 0) || undefined;
    return codexCompactCopyLine(preTokens, compactPostTokenCount(payload));
  };

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      // For clean export, a Codex compacted record is a snapshot of model
      // context, not a new user-visible turn. Expanding replacement_history
      // recursively re-exports old/rolled-back prompts on every compaction.
      const sourceUuid = stableUuidForRecord(sessionId, record, 'codex-compact');
      push({
        kind: 'compact',
        text: compactText(payload),
        sourceUuid,
      });
      continue;
    }

    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') currentTurnCanonicalUserText = null;
      if (payload.type === 'patch_apply_end') {
        attachCodexPatchApplyEvent(pendingCalls, payload);
      } else if (payload.type === 'user_message') {
        // Codex persists a built-in subagent completion as an event_msg with a
        // user role, but it is a service carrier inside the current external
        // turn. Timeline already ignores it; the clean result projection must
        // keep the same boundary or it drops the final assistant tail.
        if (isCodexSubagentNotification(payload)) continue;
        const userText = payload.message || extractTextContent(payload.content) || '';
        const presentedUserText = codexUserMessagePresentationText(record);
        const goalContinuation = isCodexGoalContinuationUserText(presentedUserText);
        if (isCodexEnvironmentContextUserText(userText)) continue;
        if (isCodexProjectInstructionsUserText(userText)) {
          // Project instructions are a service preamble of the following
          // real user turn. Timeline does not mint an editable dot for them,
          // so clean copy must not consume a turn coordinate either.
          const pendingIndex = pendingProjectInstructions.findIndex((candidate) => (
            codexUserCarrierTextsMatch(candidate, userText)
          ));
          if (pendingIndex >= 0) {
            pendingProjectInstructions.splice(pendingIndex, 1);
          }
          currentTurnCanonicalUserText = userText;
          continue;
        }
        pendingProjectInstructions.length = 0;
        const pendingIndex = pendingResponseUsers.findIndex((candidate) => (
          codexUserCarrierTextsMatch(candidate.text, userText)
        ));
        const pending = pendingIndex >= 0
          ? pendingResponseUsers.splice(pendingIndex, 1)[0]
          : null;
        if (!pending) currentTurnIndex += 1;
        if (goalContinuation) {
          if (pending?.entry) {
            pending.entry.kind = 'goal';
            pending.entry.text = CODEX_GOAL_CONTINUATION_HISTORY_TEXT;
            pending.entry.sourceUuid = stableUuidForRecord(sessionId, record, 'codex-user');
          } else {
            push({
              kind: 'goal',
              text: CODEX_GOAL_CONTINUATION_HISTORY_TEXT,
              sourceUuid: stableUuidForRecord(sessionId, record, 'codex-user'),
            });
          }
        } else if (opts.includeUser) {
          if (pending?.entry) {
            pending.entry.text = presentedUserText;
            pending.entry.sourceUuid = stableUuidForRecord(sessionId, record, 'codex-user');
          } else {
            const entry = {
              kind: 'user',
              text: presentedUserText,
              sourceUuid: stableUuidForRecord(sessionId, record, 'codex-user'),
            };
            push(entry);
          }
        }
        currentTurnCanonicalUserText = userText;
      } else if (payload.type === 'thread_rolled_back') {
        removeLastCodexTurns(entries, Number(payload.num_turns || payload.turns || 1));
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
        pendingProjectInstructions.length = 0;
      } else if (isCompactPayload(payload)) {
        if (!compactCompanionLines.has(record.__line)) {
          const sourceUuid = stableUuidForRecord(sessionId, record, 'codex-compact');
          push({
            kind: 'compact',
            text: compactText(payload),
            sourceUuid,
          });
        }
      } else if (payload.type === 'token_count') {
        latestTokenCountInfo = payload.info || latestTokenCountInfo;
      } else if (payload.type === 'task_complete') {
        pendingResponseUsers.length = 0;
        pendingProjectInstructions.length = 0;
      }
      continue;
    }

    if (record.type !== 'response_item') continue;

    if (payload.type === 'message' && payload.role === 'user') {
      const userText = codexUserMessageAuditText(record) || '';
      const presentedUserText = codexUserMessagePresentationText(record);
      const goalContinuation = isCodexGoalContinuationUserText(presentedUserText);
      if (!userText
        || userText.includes('<subagent_notification>')
        || isCodexEnvironmentContextUserText(userText)) continue;
      if (isCodexProjectInstructionsUserText(userText)) {
        pendingProjectInstructions.push(userText);
        currentTurnCanonicalUserText = userText;
        continue;
      }
      pendingProjectInstructions.length = 0;
      if (currentTurnCanonicalUserText
        && codexUserCarrierTextsMatch(currentTurnCanonicalUserText, userText)) {
        continue;
      }
      currentTurnIndex += 1;
      let entry = null;
      if (goalContinuation) {
        entry = {
          kind: 'goal',
          text: CODEX_GOAL_CONTINUATION_HISTORY_TEXT,
          sourceUuid: stableUuidForRecord(sessionId, record, 'codex-user'),
        };
        push(entry);
      } else if (opts.includeUser) {
        entry = {
          kind: 'user',
          text: presentedUserText,
          sourceUuid: stableUuidForRecord(sessionId, record, 'codex-user'),
        };
        push(entry);
      }
      pendingResponseUsers.push({ entry, text: userText });
      continue;
    }

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
      const callId = payload.call_id || stableUuidForRecord(sessionId, record, 'codex-tool-search');
      pendingCalls.set(callId, payload);
      continue;
    }

    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const callId = payload.call_id || payload.id || stableUuidForRecord(sessionId, record, 'codex-call');
      pendingCalls.set(callId, {
        ...payload,
        callId,
        toolName: codexToolName(payload),
        args: parseCodexCallArgs(payload),
        namespace: payload.namespace || '',
        turnId: payload.turn_id || '',
        patchApplyEvents: [],
      });
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
      out.push(text, '');
    } else if (entry.kind === 'goal') {
      out.push(text, '');
    }
  }
  return out.join('\n');
}

function buildCodexCleanExport(records, sessionId, cwd, opts) {
  const meta = opts?.virtualSessionMeta || getSessionMeta(records);
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

  // Compact is a structural, selectable Timeline point. Its encrypted body is
  // never expanded into replacement_history; the clean projection carries
  // exactly one metadata line for both single-point and range copy.
  const cleanEntries = buildCodexCleanEntries(records, sessionId, codexCopyOptions(opts));
  const filtered = cleanEntries.filter((entry) => {
    if (entry.kind === 'compact') return selectedCompacts.has(entry.sourceUuid);
    return typeof entry.turnIndex === 'number' && selectedTurns.has(entry.turnIndex);
  });

  if (filtered.length === 0) {
    const cleanTurnIndexes = cleanEntries
      .map((entry) => entry.turnIndex)
      .filter((turnIndex) => typeof turnIndex === 'number');
    const cleanTurnRange = cleanTurnIndexes.length > 0
      ? `${Math.min(...cleanTurnIndexes)}..${Math.max(...cleanTurnIndexes)}`
      : 'none';
    console.warn('[CodexCopyRange] empty projection'
      + ' session=' + String(sessionId || '').slice(0, 8)
      + ' start=' + String(startUuid || '').slice(0, 16)
      + ' end=' + String(endUuid || '').slice(0, 16)
      + ' selected=' + selected.map((entry) => `${entry.type}@${entry.turnIndex ?? '-'}:${String(entry.uuid || '').slice(0, 8)}`).join(',')
      + ' selectedTurns=' + [...selectedTurns].join(',')
      + ' selectedCompacts=' + selectedCompacts.size
      + ' cleanTurnRange=' + cleanTurnRange);
    return { success: false, error: 'Selected range has no copyable content' };
  }

  const meta = opts?.virtualSessionMeta || getSessionMeta(records);
  return {
    success: true,
    content: formatCodexCleanExport(filtered, sessionId, cwd, meta, '# Codex Range Export'),
    selectedCount: selected.length,
  };
}

function projectCodexAssistantContext(blocks, maxChars = 8000, maxLimit = 16000) {
  const values = (Array.isArray(blocks) ? blocks : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (values.length === 0) {
    return { assistantText: '', assistantChars: 0, truncated: false };
  }
  const limit = Math.max(500, Math.min(maxLimit, Number(maxChars) || 8000));
  const joined = values.join('\n\n');
  if (joined.length <= limit) {
    return { assistantText: joined, assistantChars: joined.length, truncated: false };
  }
  const first = values[0];
  const last = values[values.length - 1];
  let assistantText;
  if (values.length === 1) {
    const head = Math.floor(limit * 0.4);
    assistantText = first.slice(0, head).trimEnd() + '\n…\n' + first.slice(-(limit - head - 3)).trimStart();
  } else {
    const firstLimit = Math.min(Math.floor(limit * 0.35), first.length);
    const lastLimit = Math.max(0, limit - firstLimit - 3);
    assistantText = first.slice(0, firstLimit).trimEnd() + '\n…\n' + last.slice(-lastLimit).trimStart();
  }
  return { assistantText, assistantChars: joined.length, truncated: true };
}

function boundCodexAssistantContext(blocks, maxChars = 8000) {
  return projectCodexAssistantContext(blocks, maxChars, 16000).assistantText;
}

function collectCodexTurnAssistantBlocks(records, sessionId, entryUuid) {
  const timeline = buildCodexTimeline(records, sessionId);
  const target = timeline.find((entry) => entry.uuid === entryUuid && typeof entry.turnIndex === 'number');
  if (!target) return { success: false, error: 'Timeline turn not found' };
  const cleanEntries = buildCodexCleanEntries(records, sessionId, codexCopyOptions({
    // Keep user rows in the structural projection so rollback indexing stays
    // identical to Timeline. Assistant filtering happens only after the exact
    // real user turn has been identified.
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
  return { success: true, target, assistantBlocks };
}

function codexProviderTurnId(record) {
  const value = record?.payload?.turn_id ?? record?.turn_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findCodexPromptExecutionContext(records, sessionId, entryUuid) {
  if (!sessionId || !entryUuid) return null;
  const rows = Array.isArray(records) ? records : [];
  // The UUID identifies one physical carrier. Resolve that row before looking
  // for its enclosing provider turn; globally pairing same-text aliases can
  // otherwise connect a response_item from turn A to an event_msg from turn B.
  const promptIndex = rows.findIndex((record) => (
    codexUserMessageAuditText(record) !== null
    && stableUuid(sessionId, record.__line, 'codex-user') === entryUuid
  ));
  if (promptIndex < 0) return null;

  const contextFromStart = (record) => {
    const turnId = codexProviderTurnId(record);
    if (!turnId) return null;
    const startedAtSeconds = Number(record?.payload?.started_at);
    const startedAt = Number.isFinite(startedAtSeconds)
      ? Math.round(startedAtSeconds * 1000)
      : (Date.parse(String(record?.timestamp || '')) || null);
    return {
      provider: 'codex',
      sessionId,
      turnId,
      processId: null,
      generation: null,
      startedAt,
    };
  };

  // An already-open previous turn wins. Only when no task_started exists since
  // the previous terminal boundary may this be Codex's legal pre-start carrier.
  for (let index = promptIndex - 1; index >= 0; index -= 1) {
    const record = rows[index];
    const payload = record?.payload || {};
    if (record?.type !== 'event_msg') continue;
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') break;
    if (payload.type !== 'task_started') continue;
    return contextFromStart(record);
  }
  for (let index = promptIndex + 1; index < rows.length; index += 1) {
    const record = rows[index];
    const payload = record?.payload || {};
    if (record?.type !== 'event_msg') continue;
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') break;
    if (payload.type === 'task_started') return contextFromStart(record);
  }
  return null;
}

function buildCodexProviderTurnAssistantResult(
  records,
  sessionId,
  proof = {},
  maxChars = 100000,
) {
  const executionContext = proof?.targetExecutionContext;
  const expectedTurnId = typeof executionContext?.turnId === 'string'
    ? executionContext.turnId.trim()
    : '';
  const expectedSessionId = typeof executionContext?.sessionId === 'string'
    ? executionContext.sessionId.trim()
    : '';
  const hasExpectedGeneration = executionContext?.generation != null
    && Number.isFinite(Number(executionContext.generation));
  const expectedGeneration = hasExpectedGeneration ? Number(executionContext.generation) : null;
  if (executionContext?.provider !== 'codex') {
    return {
      success: false,
      errorCode: RESULT_PROOF_CODES.PROVIDER_MISMATCH,
      error: 'Codex provider turn proof has a provider mismatch',
      proofDefinitive: true,
    };
  }
  if (!expectedSessionId || expectedSessionId !== sessionId) {
    return {
      success: false,
      errorCode: RESULT_PROOF_CODES.SESSION_MISMATCH,
      error: 'Codex provider turn proof has a session mismatch',
      proofDefinitive: true,
    };
  }
  if (!expectedTurnId || !hasExpectedGeneration) {
    return {
      success: false,
      errorCode: RESULT_PROOF_CODES.EXECUTION_IDENTITY_INCOMPLETE,
      error: 'Codex provider turn identity is incomplete',
      proofDefinitive: true,
    };
  }

  const rows = Array.isArray(records) ? records : [];
  const starts = [];
  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index];
    if (record?.type === 'event_msg'
      && record?.payload?.type === 'task_started'
      && codexProviderTurnId(record) === expectedTurnId) {
      starts.push(index);
    }
  }
  if (starts.length !== 1) {
    return {
      success: false,
      errorCode: starts.length === 0
        ? RESULT_PROOF_CODES.TASK_STARTED_NOT_FOUND
        : RESULT_PROOF_CODES.TASK_STARTED_AMBIGUOUS,
      error: starts.length === 0
        ? 'matching Codex task_started not found'
        : 'matching Codex task_started is ambiguous',
      proofMode: 'provider-turn-id',
      providerTurnId: expectedTurnId,
      proofDefinitive: starts.length > 1,
    };
  }

  const startIndex = starts[0];
  let boundaryIndex = rows.length;
  let boundaryReason = 'transcript-end';
  let terminalIndex = -1;
  let terminalEvent = null;
  for (let index = startIndex + 1; index < rows.length; index += 1) {
    const record = rows[index];
    const payload = record?.payload || {};
    if (record?.type !== 'event_msg') continue;
    if (payload.type === 'task_started') {
      boundaryIndex = index;
      boundaryReason = codexProviderTurnId(record) === expectedTurnId
        ? 'duplicate-task-started'
        : 'next-task-started';
      break;
    }
    if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') continue;
    const terminalTurnId = codexProviderTurnId(record);
    if (terminalTurnId === expectedTurnId) {
      terminalIndex = index;
      terminalEvent = payload.type;
      boundaryIndex = index;
      boundaryReason = payload.type;
      break;
    }
    boundaryIndex = index;
    boundaryReason = terminalTurnId ? 'mismatched-terminal-turn' : 'terminal-turn-id-missing';
    break;
  }

  const terminalTracker = {};
  let terminalOutcome = null;
  if (terminalIndex >= 0) {
    for (let index = startIndex; index <= terminalIndex; index += 1) {
      const outcome = classifyCodexTurnRecord(terminalTracker, rows[index]);
      if (outcome && outcome.busy === false) terminalOutcome = outcome;
    }
  }

  const lowerBound = Number(proof?.resultAfterAt) > 0
    ? Number(proof.resultAfterAt)
    : (Number(proof?.requestedAt) > 0 ? Number(proof.requestedAt) - 5 * 60 * 1000 : 0);
  const upperBound = Number(proof?.resultBeforeAt) > 0 ? Number(proof.resultBeforeAt) : 0;
  const exactUuid = typeof proof?.promptUserUuid === 'string' && proof.promptUserUuid.trim()
    ? proof.promptUserUuid.trim()
    : null;
  const exactSourceIdentity = typeof proof?.promptSourceIdentity === 'string'
    && proof.promptSourceIdentity.trim()
    ? proof.promptSourceIdentity.trim()
    : null;
  const expectedPromptHash = typeof proof?.promptHash === 'string' && proof.promptHash.trim()
    ? proof.promptHash.trim()
    : null;
  if (!exactUuid && !exactSourceIdentity && !expectedPromptHash) {
    return {
      success: false,
      errorCode: RESULT_PROOF_CODES.PROMPT_IDENTITY_REQUIRED,
      error: 'Codex provider turn proof requires an exact prompt UUID, source identity, or hash',
      proofMode: 'provider-turn-id',
      providerTurnId: expectedTurnId,
      proofDefinitive: true,
    };
  }

  let carrierStartIndex = startIndex + 1;
  if (exactUuid || exactSourceIdentity) {
    // Exact physical identity may precede task_started in a valid Codex turn.
    // Admit only the immediately preceding structural segment; hash-only legacy
    // proof remains post-start so copied history cannot become causal.
    let cursor = startIndex - 1;
    let previousBoundaryType = null;
    while (cursor >= 0) {
      const previous = rows[cursor];
      const previousType = previous?.type === 'event_msg' ? previous?.payload?.type : null;
      if (previousType === 'task_started'
        || previousType === 'task_complete'
        || previousType === 'turn_aborted') {
        previousBoundaryType = previousType;
        break;
      }
      cursor -= 1;
    }
    if (previousBoundaryType === null
      || previousBoundaryType === 'task_complete'
      || previousBoundaryType === 'turn_aborted') {
      carrierStartIndex = cursor + 1;
    }
  }
  const carrierCandidates = [];
  for (let index = carrierStartIndex; index < boundaryIndex; index += 1) {
    const record = rows[index];
    const payload = record?.payload || {};
    if (record?.type === 'event_msg' && isCodexSubagentNotification(payload)) continue;
    if (codexUserMessageAuditText(record) === null) continue;
    carrierCandidates.push({
      record,
      index,
      byteOffset: record.__byteOffset,
    });
  }
  const promptCandidates = [];
  const carrierGroups = groupCodexPreferredUserMessageAuditRecords(carrierCandidates);
  for (const group of carrierGroups) {
    const recordsWithAliases = [group.candidate, ...(group.aliases || [])];
    const userUuids = recordsWithAliases.map((candidate) => (
      stableUuid(sessionId, candidate.record.__line, 'codex-user')
    ));
    const sourceIdentities = recordsWithAliases.map((candidate) => (
      stableSourceIdentity(sessionId, candidate.record, 'codex-user')
    ));
    const hasExactIdentity = Boolean(exactUuid || exactSourceIdentity);
    if (hasExactIdentity) {
      const uuidMatches = !exactUuid || userUuids.includes(exactUuid);
      const sourceMatches = !exactSourceIdentity || sourceIdentities.includes(exactSourceIdentity);
      if (uuidMatches && sourceMatches) {
        promptCandidates.push({
          index: Math.min(...recordsWithAliases.map((candidate) => candidate.index)),
          record: group.candidate.record,
          userUuid: userUuids[0],
          sourceIdentity: sourceIdentities[0],
          sourceIdentityAliases: sourceIdentities.slice(1),
          carrierKind: group.candidate.record.type === 'event_msg' ? 'event' : 'response',
        });
      }
      continue;
    }
    const record = group.candidate.record;
    const timestampMs = Date.parse(recordTimestamp(record) || '');
    if ((lowerBound || upperBound) && !Number.isFinite(timestampMs)) continue;
    if (lowerBound && timestampMs < lowerBound) continue;
    if (upperBound && timestampMs > upperBound) continue;
    const text = codexUserMessageAuditText(record) || '';
    if (promptFingerprint(text) === expectedPromptHash) {
      promptCandidates.push({
        index: Math.min(...recordsWithAliases.map((candidate) => candidate.index)),
        record,
        userUuid: userUuids[0],
        sourceIdentity: sourceIdentities[0],
        sourceIdentityAliases: sourceIdentities.slice(1),
        carrierKind: record.type === 'event_msg' ? 'event' : 'response',
      });
    }
  }
  if (promptCandidates.length !== 1) {
    return {
      success: false,
      errorCode: promptCandidates.length === 0
        ? RESULT_PROOF_CODES.PROMPT_OUTSIDE_TURN
        : RESULT_PROOF_CODES.PROMPT_AMBIGUOUS,
      error: promptCandidates.length === 0
        ? 'matching prompt is outside the exact Codex provider turn'
        : 'matching prompt is ambiguous inside the exact Codex provider turn',
      proofMode: 'provider-turn-id',
      providerTurnId: expectedTurnId,
      boundaryReason,
      terminalEvent,
      proofDefinitive: promptCandidates.length > 1 || boundaryReason !== 'transcript-end',
    };
  }

  const prompt = promptCandidates[0];
  const assistantBlocks = [];
  for (let index = prompt.index + 1; index < boundaryIndex; index += 1) {
    const payload = rows[index]?.payload || {};
    if (rows[index]?.type !== 'response_item'
      || payload.type !== 'message'
      || payload.role !== 'assistant') continue;
    const text = extractTextContent(payload.content).trim();
    if (text) assistantBlocks.push(text);
  }
  let projected = projectCodexAssistantContext(assistantBlocks, maxChars, 250000);
  if (!projected.assistantText && terminalOutcome?.hasFinalResult === true) {
    const terminalText = String(rows[terminalIndex]?.payload?.last_agent_message || '').trim();
    if (terminalText) projected = projectCodexAssistantContext([terminalText], maxChars, 250000);
  }
  if (!projected.assistantText && !terminalOutcome) {
    return {
      success: false,
      errorCode: RESULT_PROOF_CODES.ASSISTANT_NOT_MATERIALIZED,
      error: 'No assistant response found inside the exact Codex provider turn',
      proofMode: 'provider-turn-id',
      providerTurnId: expectedTurnId,
      userUuid: prompt.userUuid,
      boundaryReason,
      terminalEvent,
      proofDefinitive: boundaryReason !== 'transcript-end',
    };
  }
  const target = buildCodexTimeline(rows, sessionId)
    .find((entry) => entry.uuid === prompt.userUuid && typeof entry.turnIndex === 'number');
  const proofDefinitive = terminalIndex < 0 && boundaryReason !== 'transcript-end';
  return {
    success: true,
    // A terminal envelope is not necessarily a successful answer. Codex
    // writes `turn_aborted` after Stop/close and can leave assistant text
    // before that record. Treating any terminal event as `complete` lets that
    // partial text fabricate a successful orchestration result.
    complete: terminalOutcome?.reason === 'task_complete'
      && terminalOutcome?.hasFinalResult === true,
    assistantText: projected.assistantText,
    assistantChars: projected.assistantChars,
    truncated: projected.truncated,
    assistantMessageCount: assistantBlocks.length,
    assistantBlockCount: assistantBlocks.length,
    turnIndex: target?.turnIndex ?? null,
    userUuid: prompt.userUuid,
    sourceIdentity: prompt.sourceIdentity,
    sourceIdentityAliases: prompt.sourceIdentityAliases,
    promptCarrierKind: prompt.carrierKind,
    proofMode: 'provider-turn-id',
    providerTurnId: expectedTurnId,
    providerGeneration: expectedGeneration,
    terminalEvent,
    terminalOutcomeReason: terminalOutcome?.reason || null,
    hasFinalResult: terminalOutcome?.hasFinalResult === true,
    boundaryReason,
    proofDefinitive,
    errorCode: proofDefinitive ? RESULT_PROOF_CODES.TURN_BOUNDARY_CLOSED : null,
    error: proofDefinitive
      ? 'Codex provider turn closed before an exact terminal result'
      : null,
  };
}

// Orchestration completion is one provider turn, even when Codex compacts its
// context in the middle of that turn. The normal History projection exposes
// the post-compact continuation as a synthetic row for navigation, while the
// clean projection deliberately keeps it under the original real user turn.
// Reuse that projection here so get_delegation_result includes the final answer
// and still stops before the next real user message.
function buildCodexTurnAssistantResult(records, sessionId, entryUuid, maxChars = 100000) {
  const collected = collectCodexTurnAssistantBlocks(records, sessionId, entryUuid);
  if (!collected.success) return collected;
  const projected = projectCodexAssistantContext(collected.assistantBlocks, maxChars, 250000);
  return projected.assistantText
    ? {
      success: true,
      complete: collected.target.responseComplete === true,
      assistantText: projected.assistantText,
      assistantChars: projected.assistantChars,
      truncated: projected.truncated,
      assistantMessageCount: collected.assistantBlocks.length,
      assistantBlockCount: collected.assistantBlocks.length,
      turnIndex: collected.target.turnIndex,
    }
    : { success: false, error: 'No completed assistant response found' };
}

function buildCodexTurnAssistantContext(records, sessionId, entryUuid, maxChars = 8000) {
  const collected = collectCodexTurnAssistantBlocks(records, sessionId, entryUuid);
  if (!collected.success) return collected;
  const assistantText = boundCodexAssistantContext(collected.assistantBlocks, maxChars);
  return assistantText
    ? {
      success: true,
      assistantText,
      assistantMessageCount: collected.assistantBlocks.length,
      turnIndex: collected.target.turnIndex,
    }
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
  const windowMinutes = parseCodexNumber(
    bucket.window_minutes ?? bucket.windowMinutes ?? bucket.windowDurationMins
  );
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

function normalizeCodexAppServerCredits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return normalizeCodexCreditBalance({
    has_credits: raw.hasCredits,
    unlimited: raw.unlimited,
    overage_limit_reached: raw.overageLimitReached ?? raw.spendControlReached,
    balance: raw.balance,
  });
}

function buildCodexResetCreditsFromAppServer(raw, receivedAtMs = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const availableCount = parseCodexNumber(raw.availableCount);
  const credits = (Array.isArray(raw.credits) ? raw.credits : [])
    .map((credit) => {
      if (!credit || typeof credit !== 'object') return null;
      if (credit.status && credit.status !== 'available') return null;
      const expiresAt = normalizeCodexReset(credit.expiresAt);
      if (!expiresAt || Date.parse(expiresAt) <= receivedAtMs) return null;
      return {
        title: typeof credit.title === 'string' && credit.title.trim()
          ? credit.title.trim().slice(0, 80)
          : 'Full reset',
        expires_at: expiresAt,
      };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at));
  if (availableCount == null && credits.length === 0) return null;
  return {
    available_count: availableCount != null ? Math.max(0, Math.floor(availableCount)) : credits.length,
    credits,
    timestamp: new Date(receivedAtMs).toISOString(),
  };
}

function buildCodexUsageFromAppServerRateLimits(payload, receivedAtMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const rows = Object.values(payload.rateLimitsByLimitId || {})
    .filter((row) => row && typeof row === 'object');
  const core = payload.rateLimits
    || rows.find((row) => row.limitId === 'codex')
    || rows[0]
    || null;
  if (!core) return null;

  const mapRow = (row) => buildCodexUsageFromRateLimits({
    primary: row?.primary || null,
    secondary: row?.secondary || null,
    limit_id: row?.limitId || null,
    limit_name: row?.limitName || null,
    plan_type: row?.planType || null,
    credits: normalizeCodexAppServerCredits(row?.credits),
    individual_limit: row?.individualLimit || null,
    rate_limit_reached_type: row?.rateLimitReachedType || null,
  }, new Date(receivedAtMs).toISOString(), null);

  const usage = mapRow(core);
  if (!usage) return null;
  const coreLimitId = core.limitId || null;
  const additional = rows
    .filter((row) => !coreLimitId || row.limitId !== coreLimitId)
    .map((row) => {
      const rowUsage = mapRow(row);
      if (!rowUsage?.five_hour && !rowUsage?.seven_day) return null;
      return {
        key: String(row.limitId || row.limitName || '').slice(0, 120),
        label: String(row.limitName || 'Additional Codex limit').slice(0, 120),
        five_hour: rowUsage.five_hour,
        seven_day: rowUsage.seven_day,
      };
    })
    .filter((row) => row?.key);

  return {
    usage: {
      ...usage,
      authoritative_windows: true,
      additional_rate_limits_observed: rows.length > 0,
      additional_rate_limits: additional,
    },
    resetCredits: buildCodexResetCreditsFromAppServer(payload.rateLimitResetCredits, receivedAtMs),
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
      env: buildChildProcessEnv(),
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

function readCodexAuthSession(codexHome = CODEX_HOME) {
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  const raw = safeJsonParse(fs.readFileSync(authPath, 'utf8'), null);
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

function readCurrentCodexAuthSession() {
  return readCodexAuthSession(CODEX_HOME);
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

function normalizeCodexCreditBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const balance = parseCodexNumber(raw.balance);
  const hasCredits = typeof raw.has_credits === 'boolean' ? raw.has_credits : null;
  const unlimited = typeof raw.unlimited === 'boolean' ? raw.unlimited : null;
  const overageLimitReached = typeof raw.overage_limit_reached === 'boolean'
    ? raw.overage_limit_reached
    : null;
  if (balance == null && hasCredits == null && unlimited == null && overageLimitReached == null) return null;
  return {
    has_credits: hasCredits,
    unlimited,
    overage_limit_reached: overageLimitReached,
    balance: balance != null && balance >= 0 ? balance : null,
  };
}

function normalizeCodexAdditionalRateLimits(rawLimits, receivedAtMs) {
  if (!Array.isArray(rawLimits)) return null;
  const normalized = [];
  const seen = new Set();
  for (const raw of rawLimits.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue;
    const rateLimit = raw.rate_limit;
    if (!rateLimit || typeof rateLimit !== 'object') continue;
    const primary = normalizeCodexWhamWindow(rateLimit.primary_window ?? rateLimit.primary, receivedAtMs);
    const secondary = normalizeCodexWhamWindow(rateLimit.secondary_window ?? rateLimit.secondary, receivedAtMs);
    const usage = buildCodexUsageFromRateLimits({ primary, secondary }, null, null);
    if (!usage?.five_hour && !usage?.seven_day) continue;

    const rawKey = typeof raw.metered_feature === 'string' ? raw.metered_feature.trim() : '';
    const rawLabel = typeof raw.limit_name === 'string' ? raw.limit_name.trim() : '';
    const key = (rawKey || rawLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      key,
      label: (rawLabel || 'Additional Codex limit').slice(0, 120),
      five_hour: usage.five_hour,
      seven_day: usage.seven_day,
    });
  }
  return normalized;
}

function sanitizeCodexAdditionalRateLimits(rawLimits) {
  if (!Array.isArray(rawLimits)) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of rawLimits.slice(0, 16)) {
    if (!raw || typeof raw !== 'object') continue;
    const key = typeof raw.key === 'string' ? raw.key.trim().slice(0, 120) : '';
    const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 120) : '';
    if (!key || !label || seen.has(key)) continue;
    const fiveHour = normalizeCodexLimitBucket(raw.five_hour);
    const sevenDay = normalizeCodexLimitBucket(raw.seven_day);
    if (!fiveHour && !sevenDay) continue;
    seen.add(key);
    normalized.push({ key, label, five_hour: fiveHour, seven_day: sevenDay });
  }
  return normalized;
}

function codexWhamWindowsAreAuthoritative(rateLimit, usage) {
  const hasBothSlots = Object.prototype.hasOwnProperty.call(rateLimit, 'primary_window')
    && Object.prototype.hasOwnProperty.call(rateLimit, 'secondary_window');
  return hasBothSlots && !!(usage?.five_hour || usage?.seven_day);
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

  const usage = buildCodexUsageFromRateLimits({
    limit_id: 'codex',
    limit_name: null,
    primary,
    secondary,
    credits: normalizeCodexCreditBalance(payload?.credits || rateLimit.credits || null),
    individual_limit: rateLimit.individual_limit || payload?.spend_control?.individual_limit || null,
    plan_type: payload?.plan_type || rateLimit.plan_type || null,
    rate_limit_reached_type: payload?.rate_limit_reached_type || rateLimit.rate_limit_reached_type || null,
  }, new Date(receivedAtMs).toISOString(), null);
  return {
    ...usage,
    authoritative_windows: codexWhamWindowsAreAuthoritative(rateLimit, usage),
    additional_rate_limits_observed: Array.isArray(payload?.additional_rate_limits),
    additional_rate_limits: normalizeCodexAdditionalRateLimits(payload?.additional_rate_limits, receivedAtMs),
  };
}

function buildCodexResetCreditsFromResponse(payload, receivedAtMs = Date.now()) {
  const availableCount = parseCodexNumber(payload?.available_count);
  if (!Number.isInteger(availableCount) || availableCount < 0 || !Array.isArray(payload?.credits)) {
    throw new CodexUsageFetchError('invalid_response', 'OpenAI reset credits response is invalid');
  }
  const credits = payload.credits
    .slice(0, 32)
    .filter((credit) => credit && typeof credit === 'object')
    .filter((credit) => credit.status === 'available')
    .filter((credit) => credit.reset_type === 'codex_rate_limits')
    .filter((credit) => credit.is_supported_by_plan !== false)
    .map((credit) => {
      const expiresAt = normalizeCodexReset(credit.expires_at);
      if (!expiresAt || Date.parse(expiresAt) <= receivedAtMs) return null;
      const title = typeof credit.title === 'string' && credit.title.trim()
        ? credit.title.trim().slice(0, 80)
        : 'Full reset';
      return { title, expires_at: expiresAt };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at));
  return {
    available_count: credits.length,
    credits,
    timestamp: new Date(receivedAtMs).toISOString(),
  };
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
  const authoritativeWindows = usage.authoritative_windows === true;
  const fiveHour = usage.five_hour
    || (!authoritativeWindows ? previousUsage?.five_hour : null)
    || null;
  const sevenDay = usage.seven_day
    || (!authoritativeWindows ? previousUsage?.seven_day : null)
    || null;
  if (!fiveHour && !sevenDay) return null;
  const ownAdditionalLimits = sanitizeCodexAdditionalRateLimits(usage.additional_rate_limits);
  const additionalLimitsObserved = usage.additional_rate_limits_observed === true;
  const additionalRateLimits = additionalLimitsObserved || ownAdditionalLimits.length > 0
    ? ownAdditionalLimits
    : sanitizeCodexAdditionalRateLimits(previousUsage?.additional_rate_limits);
  const credits = normalizeCodexCreditBalance(usage.credits)
    || normalizeCodexCreditBalance(previousUsage?.credits);
  return {
    ...usage,
    primary: fiveHour ? { ...fiveHour, window_minutes: 5 * 60 } : null,
    secondary: sevenDay ? { ...sevenDay, window_minutes: 7 * 24 * 60 } : null,
    five_hour: fiveHour,
    seven_day: sevenDay,
    authoritative_windows: authoritativeWindows || previousUsage?.authoritative_windows === true,
    additional_rate_limits_observed: additionalLimitsObserved
      || previousUsage?.additional_rate_limits_observed === true,
    additional_rate_limits: additionalRateLimits,
    credits,
  };
}

function codexUsageBucketSnapshot(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const utilization = parseCodexNumber(bucket.utilization);
  if (utilization == null || utilization < 0 || utilization > 100) return null;
  const resetMs = parseTimestampMs(bucket.resets_at);
  return {
    utilization,
    resetMs: Number.isFinite(resetMs) ? resetMs : null,
  };
}

function codexUsageWindowSnapshot(usage, key) {
  return codexUsageBucketSnapshot(usage?.[key]);
}

function codexUsageWindowSnapshots(usage) {
  const snapshots = new Map();
  for (const key of ['five_hour', 'seven_day']) {
    const snapshot = codexUsageWindowSnapshot(usage, key);
    if (snapshot) snapshots.set(`main:${key}`, snapshot);
  }
  for (const limit of sanitizeCodexAdditionalRateLimits(usage?.additional_rate_limits)) {
    for (const key of ['five_hour', 'seven_day']) {
      const snapshot = codexUsageBucketSnapshot(limit[key]);
      if (snapshot) snapshots.set(`${limit.key}:${key}`, snapshot);
    }
  }
  return snapshots;
}

function codexUsageSnapshotsMatch(leftUsage, rightUsage) {
  const leftSnapshots = codexUsageWindowSnapshots(leftUsage);
  const rightSnapshots = codexUsageWindowSnapshots(rightUsage);
  const keys = new Set([...leftSnapshots.keys(), ...rightSnapshots.keys()]);
  for (const key of keys) {
    const left = leftSnapshots.get(key) || null;
    const right = rightSnapshots.get(key) || null;
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

  const previousSnapshots = codexUsageWindowSnapshots(previousUsage);
  const candidateSnapshots = codexUsageWindowSnapshots(candidateUsage);
  const keys = new Set([...previousSnapshots.keys(), ...candidateSnapshots.keys()]);
  for (const key of keys) {
    const previous = previousSnapshots.get(key) || null;
    const candidate = candidateSnapshots.get(key) || null;
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

  if (candidateResult?.usageConsensusVerified === true) {
    return {
      entry: {
        ...previousEntry,
        account: normalizedCandidate.account,
        fetchedAt: normalizedCandidate.fetchedAt || nowMs,
        pending: null,
        warning: null,
      },
      status: 'verified',
      accepted: true,
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
  const rebuiltUsage = buildCodexUsageFromRateLimits({
    primary: raw?.usage?.five_hour || raw?.usage?.primary || null,
    secondary: raw?.usage?.seven_day || raw?.usage?.secondary || null,
    limit_id: 'codex',
    plan_type: typeof raw?.usage?.plan_type === 'string' ? raw.usage.plan_type.slice(0, 80) : null,
    credits: normalizeCodexCreditBalance(raw?.usage?.credits),
  }, normalizeCodexReset(raw?.usage?.timestamp || raw?.timestamp), null);
  const usage = canonicalizeCodexUsage(rebuiltUsage ? {
    ...rebuiltUsage,
    authoritative_windows: raw?.usage?.authoritative_windows === true,
    additional_rate_limits_observed: raw?.usage?.additional_rate_limits_observed === true,
    additional_rate_limits: sanitizeCodexAdditionalRateLimits(raw?.usage?.additional_rate_limits),
  } : null);
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

async function fetchCodexResetCreditsFromOpenAI(auth, {
  fetchImpl = global.fetch,
  timeoutMs = CODEX_RESET_CREDITS_TIMEOUT_MS,
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
  try {
    const response = await fetchImpl(CODEX_RESET_CREDITS_API_URL, {
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
      throw new CodexUsageFetchError('rate_limited', 'OpenAI reset credits are temporarily rate limited', response.status);
    }
    if (!response.ok) {
      throw new CodexUsageFetchError('server_error', 'OpenAI reset credits request failed', response.status);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CodexUsageFetchError('invalid_response', 'OpenAI reset credits response is not JSON');
    }
    const responseDateMs = Date.parse(response.headers?.get?.('date') || '');
    const receivedAtMs = Number.isFinite(responseDateMs) ? responseDateMs : now();
    return buildCodexResetCreditsFromResponse(payload, receivedAtMs);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new CodexUsageFetchError('timeout', 'OpenAI reset credits request timed out');
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
  resetCreditsFetchImpl = null,
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
      const shouldFetchResetCredits = typeof resetCreditsFetchImpl === 'function'
        || fetchImpl === global.fetch;
      const resetCreditsRequest = shouldFetchResetCredits
        ? fetchCodexResetCreditsFromOpenAI(attemptAuth, {
          fetchImpl: resetCreditsFetchImpl || global.fetch,
        }).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error })
        )
        : Promise.resolve({ value: null, error: null });
      let result;
      try {
        result = await fetchCodexUsageFromOpenAI(attemptAuth, { fetchImpl });
        const acceptedEntry = codexRemoteUsageByAccount.get(attemptAuth.accountKey);
        const acceptedUsage = acceptedEntry?.account?.usage || null;
        const needsInitialVerification = verifyInitial && !acceptedUsage;
        const needsManualBranchVerification = verifyInitial
          && force
          && acceptedUsage
          && classifyCodexUsageSnapshot(acceptedUsage, result.account?.usage, Date.now()) === 'suspicious';
        if (needsInitialVerification || needsManualBranchVerification) {
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
            throw new CodexUsageFetchError(
              'inconsistent_response',
              needsInitialVerification
                ? 'Initial OpenAI usage responses did not agree'
                : 'Manual OpenAI usage verification did not agree'
            );
          }
          result = {
            ...consensus,
            usageConsensusVerified: needsManualBranchVerification,
          };
        }
        const resetCreditsResult = await resetCreditsRequest;
        result = {
          ...result,
          account: {
            ...result.account,
            reset_credits: resetCreditsResult.value,
          },
        };
        if (resetCreditsResult.error) {
          console.warn('[CodexData] reset credits unavailable account=' + result.account.label +
            ' error=' + compactPreview(resetCreditsResult.error?.message || String(resetCreditsResult.error), 120));
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
    if (nextEntry.account) {
      nextEntry.account = {
        ...nextEntry.account,
        reset_credits: result.account.reset_credits || null,
      };
    }
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
          resetCreditsFetchImpl,
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

function decorateCodexProfileAccount(account, profile, overrides = {}) {
  if (!account?.accountKey || !account?.usage || !profile) return null;
  return {
    ...account,
    profileId: profile.profileId,
    connected: profile.status === 'connected',
    authStatus: profile.status,
    isDefaultProfile: !!profile.isDefault,
    ...overrides,
  };
}

function codexProfileFallbackAccount(result, receivedAtMs = Date.now()) {
  const profile = result?.profile;
  if (!profile?.accountKey || profile.status !== 'connected') return null;
  const mapped = buildCodexUsageFromAppServerRateLimits(result.rateLimits, receivedAtMs);
  if (!mapped?.usage) return null;
  return decorateCodexProfileAccount({
    accountKey: profile.accountKey,
    label: profile.label,
    accountHint: profile.accountHint,
    accountIdHint: null,
    plan_type: mapped.usage.plan_type || profile.planType || null,
    timestamp: mapped.usage.timestamp,
    sourceThreadId: null,
    source: 'codex-app-server',
    usage: mapped.usage,
    reset_credits: mapped.resetCredits,
    stale: false,
    lastError: null,
  }, profile, { stale: false });
}

async function refreshCodexManagedProfileAccounts({ force = false } = {}) {
  if (!codexAccountProfileManager) return { accounts: [], results: [] };
  const initialResults = await codexAccountProfileManager.refreshManagedProfiles({ force });
  const accounts = [];
  const results = [];

  for (let result of initialResults) {
    let profile = result?.profile;
    if (!profile || profile.isDefault) {
      results.push(result);
      continue;
    }

    let auth = readCodexAuthSession(profile.homePath);
    if (profile.status !== 'connected' && !(auth?.accessToken && auth?.accountId && auth?.accountKey)) {
      results.push(result);
      continue;
    }
    let refreshedToken = false;
    if (auth?.accessExpiresAtMs && auth.accessExpiresAtMs <= Date.now() + 30_000) {
      result = await codexAccountProfileManager.probeProfile(profile, {
        refreshToken: true,
        includeRateLimits: true,
      });
      profile = result.profile;
      auth = readCodexAuthSession(profile.homePath);
      refreshedToken = true;
    }

    let remoteResult = null;
    if (auth?.accessToken && auth?.accountId && auth?.accountKey) {
      remoteResult = await getCodexRemoteUsage({
        force,
        verifyInitial: true,
        authReader: () => readCodexAuthSession(profile.homePath),
      });
      if (!refreshedToken && remoteResult.error === 'Codex login expired. Sign in to Codex again.') {
        result = await codexAccountProfileManager.probeProfile(profile, {
          refreshToken: true,
          includeRateLimits: true,
        });
        profile = result.profile;
        auth = readCodexAuthSession(profile.homePath);
        if (auth?.accessToken && auth?.accountId && auth?.accountKey) {
          remoteResult = await getCodexRemoteUsage({
            force: true,
            verifyInitial: true,
            authReader: () => readCodexAuthSession(profile.homePath),
          });
        }
      }
    }

    const remoteAccount = auth?.accountKey
      ? remoteResult?.accounts?.find((account) => account.accountKey === auth.accountKey)
      : null;
    const decorated = remoteAccount?.usage && !remoteResult?.error
      ? decorateCodexProfileAccount(remoteAccount, profile, { isCurrent: false, stale: false })
      : codexProfileFallbackAccount(result);
    if (decorated) {
      if (profile.status !== 'connected') {
        profile = codexAccountProfileManager.markProfileConnected(profile.profileId, {
          accountKey: decorated.accountKey,
          label: decorated.label,
          accountHint: decorated.accountHint,
          planType: decorated.plan_type,
        }) || profile;
      }
      accounts.push(decorateCodexProfileAccount(decorated, profile, { isCurrent: false, stale: false }));
    }
    results.push(result);
  }

  return { accounts, results };
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
  // Dozens of persistent Codex controls mount together after workspace
  // restore. Before the first catalog request completed, every control spawned
  // its own `codex debug models` child; production 24.08 recorded 32 copies
  // taking 11-12s each and starving the process-tree proof used by AutoResume.
  // The TTL cache only helps AFTER completion, so the pending request itself
  // must also be shared.
  if (modelCacheInflight) {
    console.log('[CodexModels] join in-flight catalog request');
    return modelCacheInflight;
  }
  modelCacheInflight = new Promise((resolve) => {
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
      modelCacheInflight = null;
      resolve(value);
    };

    // Live catalog matches the current account/config and the interactive
    // `/model` picker. Bundled catalog contains hidden/internal/upgrade-only
    // rows that the TUI will not accept.
    execFile('codex', ['debug', 'models'], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15_000,
      env: buildChildProcessEnv(),
    }, (err, stdout) => {
      if (!err) {
        const models = parseCodexModelsCatalog(stdout);
        if (models.length > 0) {
          finish(models);
          return;
        }
      }

      execFile('codex', ['debug', 'models', '--bundled'], {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 5_000,
        env: buildChildProcessEnv(),
      }, (bundledErr, bundledStdout) => {
        if (bundledErr) {
          finish(fallback);
          return;
        }
        finish(parseCodexModelsCatalog(bundledStdout));
      });
    });
  });
  return modelCacheInflight;
}

async function loadSessionRecords(sessionId, cwd, options = {}) {
  const found = await findCodexSessionFile(sessionId, cwd);
  if (!found) return { success: false, error: 'Codex session file not found' };
  const records = await parseJsonlFile(found.filePath, options);
  const sourceSnapshot = await getCodexJsonlSourceSnapshot(found.filePath, sessionId);
  return { success: true, records, filePath: found.filePath, sourceSnapshot };
}

function register({ projectManager, transcriptService } = {}) {
  codexUsageStateStore = projectManager?.db || null;
  codexUsageStateHydrated = false;
  hydrateCodexUsageState();
  codexAccountProfileManager?.shutdown?.();
  codexAccountProfileManager = new CodexAccountProfileManager({
    store: codexUsageStateStore,
    defaultCodexHome: CODEX_HOME,
    onChange: (payload) => {
      try {
        const { BrowserWindow } = require('electron');
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send('codex:account-profiles-updated', payload);
          }
        }
      } catch {}
    },
  });
  if (!codexAccountProfileCleanupBound) {
    codexAccountProfileCleanupBound = true;
    try {
      const { app } = require('electron');
      app.once('before-quit', () => codexAccountProfileManager?.shutdown?.());
    } catch {}
  }

  module.exports._api.materializeEmptySession = materializeEmptyCodexSession;
  module.exports._api.inspectConversationMaterialization = inspectCodexConversationMaterialization;
  module.exports._api.inspectConversationMaterializationFromFile = inspectCodexConversationMaterializationFromFile;

  module.exports._api.injectHistoryContext = async function ({
    sessionId = null,
    cwd,
    prompt,
    imagePaths = [],
    model = null,
    effort = null,
    itemId = null,
    onBeforeCommit = null,
  } = {}) {
    const exactCwd = typeof cwd === 'string' && path.isAbsolute(cwd)
      ? cwd
      : null;
    const exactPrompt = typeof prompt === 'string' ? prompt : '';
    if (!exactCwd) return { success: false, committed: false, error: 'history_context_cwd_required' };
    if (!exactPrompt.trim()) return { success: false, committed: false, error: 'history_context_prompt_required' };
    const exactModel = typeof model === 'string' ? model.trim() : '';
    const exactEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
    if (!exactModel || !exactEffort) {
      return {
        success: false,
        committed: false,
        error: 'codex_history_context_settings_required',
      };
    }
    const exactItemId = typeof itemId === 'string' && itemId.trim()
      ? itemId.trim()
      : 'msg_' + crypto.randomUUID();
    const item = await buildCodexHistoryContextItem(exactPrompt, exactItemId, { imagePaths });
    const requestedSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : null;
    const lockKey = requestedSessionId || ('fresh:' + exactItemId);
    const previous = _codexHistoryContextInflight.get(lockKey) || Promise.resolve();
    let committed = false;
    let appendStarted = false;
    const work = previous.catch(() => {}).then(async () => {
      let exactSessionId = requestedSessionId;
      let filePath = null;
      let fresh = false;
      try {
        if (!exactSessionId) {
          const materialized = await materializeEmptyCodexSession({ cwd: exactCwd });
          exactSessionId = materialized.sessionId;
          filePath = materialized.filePath;
          fresh = true;
        } else {
          const found = await findCodexSessionFile(exactSessionId, exactCwd);
          filePath = found?.filePath || null;
        }
        if (!exactSessionId || !filePath) {
          throw new Error('codex_history_context_session_not_found');
        }

        const loadedBefore = await loadSessionRecords(exactSessionId, exactCwd);
        if (!loadedBefore.success || loadedBefore.filePath !== filePath) {
          throw new Error(loadedBefore.error || 'codex_history_context_source_unavailable');
        }
        const expectedSource = loadedBefore.sourceSnapshot;
        if (!expectedSource) throw new Error('codex_history_context_source_snapshot_missing');

        const timestamp = new Date().toISOString();
        const responseTimestamp = new Date(Date.parse(timestamp) + 1).toISOString();
        const eventTimestamp = new Date(Date.parse(timestamp) + 2).toISOString();
        const settingsRecord = {
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'thread_settings_applied',
            thread_settings: {
              model: exactModel,
              reasoning_effort: exactEffort,
            },
            source: 'noted-terminal-history-context',
            source_session_id: exactSessionId,
            proof_at: Date.parse(timestamp),
          },
        };
        const responseRecord = {
          timestamp: responseTimestamp,
          type: 'response_item',
          payload: item,
        };
        const presentationText = codexUserMessagePresentationText(responseRecord) || exactPrompt;
        const eventRecord = {
          timestamp: eventTimestamp,
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: presentationText,
            kind: 'plain',
          },
        };
        const serialized = JSON.stringify(settingsRecord) + '\n'
          + JSON.stringify(responseRecord) + '\n'
          + JSON.stringify(eventRecord) + '\n';

        if (typeof onBeforeCommit === 'function') await onBeforeCommit({
          provider: 'codex',
          sessionId: exactSessionId,
          itemId: exactItemId,
          fresh,
        });

        const handle = await fs.promises.open(filePath, 'a+');
        try {
          const sourceNow = await handle.stat();
          if (sourceNow.size !== Number(expectedSource.size)
            || sourceNow.mtimeMs !== Number(expectedSource.mtimeMs)) {
            const error = new Error('codex_history_context_source_changed');
            error.code = 'codex_history_context_source_changed';
            throw error;
          }
          if (sourceNow.size > 0) {
            const tail = Buffer.alloc(1);
            await handle.read(tail, 0, 1, sourceNow.size - 1);
            if (tail[0] !== 0x0a) {
              const error = new Error('codex_history_context_partial_tail');
              error.code = 'codex_history_context_partial_tail';
              throw error;
            }
          }
          appendStarted = true;
          await handle.appendFile(serialized, 'utf8');
          committed = true;
        } finally {
          await handle.close();
        }

        invalidateCodexJsonlCache(filePath);
        const loaded = await loadSessionRecords(exactSessionId, exactCwd);
        if (!loaded.success) {
          const error = new Error(loaded.error || 'codex_history_context_record_unavailable');
          error.historyContextCommitted = committed;
          throw error;
        }
        const record = loaded.records.find((candidate) => (
          candidate?.type === 'response_item'
          && candidate?.payload?.type === 'message'
          && candidate?.payload?.role === 'user'
          && String(candidate?.payload?.id || '') === exactItemId
        ));
        if (!record) {
          const error = new Error('codex_history_context_record_identity_missing');
          error.historyContextCommitted = committed;
          error.historyContextOutcomeUnknown = appendStarted && !committed;
          throw error;
        }
        committed = true;
        const auditTimestamp = recordTimestamp(record);
        return {
          success: true,
          committed: true,
          provider: 'codex',
          sessionId: exactSessionId,
          itemId: exactItemId,
          entryUuid: stableUuid(exactSessionId, record.__line, 'codex-user'),
          sourceIdentity: stableSourceIdentity(exactSessionId, record, 'codex-user'),
          recordByteOffset: Number.isFinite(record.__byteOffset)
            ? Number(record.__byteOffset)
            : null,
          auditTimestamp,
          fresh,
          filePath: loaded.filePath,
          presentationText: codexUserMessagePresentationText(record),
        };
      } catch (error) {
        if (fresh && filePath && appendStarted !== true) {
          await fs.promises.unlink(filePath).catch(() => null);
          invalidateCodexJsonlCache(filePath);
        }
        throw error;
      }
    });
    _codexHistoryContextInflight.set(lockKey, work);
    try {
      return await work;
    } catch (error) {
      if (error.historyContextCommitted === undefined) {
        error.historyContextCommitted = committed;
      }
      if (error.historyContextOutcomeUnknown === undefined) {
        error.historyContextOutcomeUnknown = appendStarted && !committed;
      }
      throw error;
    } finally {
      if (_codexHistoryContextInflight.get(lockKey) === work) {
        _codexHistoryContextInflight.delete(lockKey);
      }
    }
  };

  ipcMain.handle('codex:get-account-profiles', async () => ({
    success: true,
    profiles: codexAccountProfileManager?.listPublicProfiles() || [],
  }));

  ipcMain.handle('codex:start-account-login', async (_event, payload = {}) => {
    try {
      const result = await codexAccountProfileManager.startLogin(payload.profileId || null);
      return {
        success: true,
        ...result,
        profiles: codexAccountProfileManager.listPublicProfiles(),
      };
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error),
        profiles: codexAccountProfileManager?.listPublicProfiles() || [],
      };
    }
  });

  ipcMain.handle('codex:cancel-account-login', async (_event, payload = {}) => {
    try {
      await codexAccountProfileManager.cancelLogin(payload.profileId);
      return { success: true, profiles: codexAccountProfileManager.listPublicProfiles() };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('codex:logout-account-profile', async (_event, payload = {}) => {
    try {
      await codexAccountProfileManager.logout(payload.profileId);
      return { success: true, profiles: codexAccountProfileManager.listPublicProfiles() };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('codex:remove-account-profile', async (_event, payload = {}) => {
    try {
      await codexAccountProfileManager.removeProfile(payload.profileId);
      return { success: true, profiles: codexAccountProfileManager.listPublicProfiles() };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('codex:get-timeline', async (_event, { sessionId, cwd }) => {
    try {
      // Same file-cursor projector as the panel's Timeline: this channel is
      // also called on ordinary flows (tab-title generation, AI-launch
      // finalize), and a full re-parse of a giant rollout there is exactly
      // the storm that evicted the active session from the records cache.
      const projected = await projectCodexTimelineFromFile(sessionId, cwd);
      if (!projected.success) return projected;
      let historyEventPersisted = false;
      try {
        const snapshot = deriveCodexForkSnapshot(projected.entries, projected.sessionMeta);
        if (snapshot && codexUsageStateStore?.saveSessionForkEvent) {
          codexUsageStateStore.saveSessionForkEvent({
            provider: 'codex',
            sourceSessionId: snapshot.sourceSessionId,
            childSessionId: sessionId,
            entryUuids: snapshot.entryUuids,
            boundaryEntryUuid: snapshot.boundaryEntryUuid,
            snapshotComplete: snapshot.snapshotComplete,
            occurredAt: snapshot.occurredAt,
            forkMode: 'unknown',
            origin: 'transcript',
            isDirect: true,
          });
          historyEventPersisted = true;
        }
      } catch (historyEventError) {
        console.warn('[CodexData] timeline fork event reconcile failed session=' + String(sessionId).slice(0, 8) + ': ' + historyEventError.message);
      }
      return {
        success: true,
        entries: projected.entries,
        sessionMeta: projected.sessionMeta,
        historyEventPersisted,
        sessionBoundaries: [],
        claudeMemoryBoundaryUuid: null,
        filePath: projected.filePath,
      };
    } catch (error) {
      console.error('[CodexData] get-timeline error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('codex:get-full-history', async (_event, payload = {}) => {
    if (transcriptService?.getHistory) {
      return transcriptService.getHistory({
        ...payload,
        toolType: 'codex',
      });
    }
    const { sessionId, cwd, ifRevision } = payload;
    try {
      if (ifRevision) {
        const validation = await validateHistoryRevision(
          ifRevision,
          { toolType: 'codex', sessionId, cwd },
          {
            resolvePrimaryFile: async () => {
              const found = await findCodexSessionFile(sessionId, cwd);
              return found?.filePath || null;
            },
          }
        );
        if (validation.unchanged) {
          return { success: true, unchanged: true, revision: ifRevision };
        }
      }
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      const revision = buildHistoryRevision(
        { toolType: 'codex', sessionId, cwd },
        loaded.sourceSnapshot ? [loaded.sourceSnapshot] : []
      );
      return {
        success: true,
        unchanged: false,
        entries: buildCodexFullHistory(loaded.records, sessionId),
        claudeMemoryBoundaryUuid: null,
        filePath: loaded.filePath,
        revision,
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
      return {
        success: false,
        error: error.message,
        code: error.code || null,
        reason: error.reason || null,
      };
    }
  });

  ipcMain.handle('codex:delete-range', async (_event, params = {}) => {
    try {
      return await deleteCodexRange(params);
    } catch (error) {
      console.error('[CodexData] delete-range error:', error);
      return {
        success: false,
        error: error.message,
        code: error.code || null,
        reason: error.reason || null,
      };
    }
  });

  ipcMain.handle('codex:fork-from-latest-compact', async (_event, params = {}) => {
    try {
      const result = await forkCodexFromLatestCompact(params);
      console.log(
        '[CodexData] fork-from-latest-compact' +
        ' session=' + String(params?.sessionId || '').slice(0, 8) +
        ' success=' + (result?.success === true ? '1' : '0') +
        ' reason=' + String(result?.reason || (result?.success === true ? 'created' : 'error'))
      );
      return result;
    } catch (error) {
      console.error('[CodexData] fork-from-latest-compact error:', error);
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
    // Stage probes. This handler has shown 620ms-7.7s wall times and once
    // coincided with a 5002ms main-loop stall at near-zero CPU — i.e. the
    // process was WAITING synchronously, not computing. The stage log names
    // which phase ate the time so the blocker is identified by evidence, not
    // by guess. (5002ms at zero CPU smells like a lock-acquisition timeout;
    // the probe will say.)
    const usageStages = [];
    const usageStartedAt = Date.now();
    let usageStageStartedAt = usageStartedAt;
    const markUsageStage = (name) => {
      const now = Date.now();
      usageStages.push(name + '=' + (now - usageStageStartedAt));
      usageStageStartedAt = now;
    };
    const logUsageStages = () => {
      const totalMs = Date.now() - usageStartedAt;
      if (totalMs > 250) {
        console.log('[CodexUsage:Stages] totalMs=' + totalMs
          + ' ' + usageStages.join(' ')
          + ' force=' + (!!opts?.force));
      }
    };
    try {
      const [remoteResult, managedProfileResult] = await Promise.all([
        getCodexRemoteUsage({
          force: !!opts?.force,
          verifyInitial: true,
        }),
        refreshCodexManagedProfileAccounts({ force: !!opts?.force }),
      ]);
      markUsageStage('remoteAndProfiles');
      const currentRemoteAccount = remoteResult.currentAccountKey
        ? remoteResult.accounts?.find((account) => account.accountKey === remoteResult.currentAccountKey)
        : null;
      codexAccountProfileManager?.syncDefaultProfile({
        accountKey: remoteResult.currentAccountKey || null,
        label: currentRemoteAccount?.label || null,
        accountHint: currentRemoteAccount?.accountHint || null,
        planType: currentRemoteAccount?.plan_type || null,
        connected: !!remoteResult.currentAccountKey,
        error: remoteResult.currentAccountKey ? remoteResult.error : null,
      });
      // The local log is discovery/fallback only. A healthy OpenAI response
      // must not start or wait for a multi-gigabyte log scan.
      const needsFallback = shouldLoadCodexFallbackUsage(remoteResult, opts?.accountKey);
      const accountResult = needsFallback
        ? await getCodexUsageAccountsFast({ force: false, reason: 'ipc-fallback' })
        : getCodexUsageAccountsSnapshot('ipc-server-primary');
      markUsageStage(needsFallback ? 'accountsFallback' : 'accountsSnapshot');
      let accountUsages = mergeCodexPreferredAccounts(
        accountResult.accounts || [],
        [
          ...(remoteResult.accounts || []),
          ...(managedProfileResult.accounts || []),
        ]
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
        markUsageStage('sessionIdentity');
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
        [
          ...(remoteResult.accounts || []).filter((account) => account.isCurrent && !account.stale),
          ...(managedProfileResult.accounts || []),
        ]
      );
      const accountProfiles = codexAccountProfileManager?.listPublicProfiles() || [];
      const profileByAccountKey = new Map(
        accountProfiles
          .filter((profile) => profile.accountKey)
          .map((profile) => [profile.accountKey, profile])
      );
      accountUsages = accountUsages.map((account) => ({
        ...account,
        profileId: account.profileId || profileByAccountKey.get(account.accountKey)?.profileId || null,
        connected: account.connected === true
          || profileByAccountKey.get(account.accountKey)?.status === 'connected',
        authStatus: account.authStatus
          || profileByAccountKey.get(account.accountKey)?.status
          || 'historical',
        isDefaultProfile: account.isDefaultProfile === true
          || profileByAccountKey.get(account.accountKey)?.isDefault === true,
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
        markUsageStage('latestRolloutScan');
      }

      if (selectedAccount?.source) source = selectedAccount.source;
      const selectedIsCurrent = !!selectedAccountKey
        && selectedAccountKey === remoteResult.currentAccountKey;
      const selectedIsConnected = selectedAccount?.connected === true;
      const stale = selectedAccount
        ? codexUsageAccountIsStale(selectedAccount)
        : !!usage;
      const warning = selectedAccount && !selectedIsConnected && stale
        ? 'This Codex account is not connected. Showing its last known value.'
        : (selectedIsCurrent ? (remoteResult.warning || selectedAccount?.warning || null) : selectedAccount?.warning || null);
      const relevantError = selectedIsCurrent
        ? remoteResult.error
        : (selectedAccount?.lastError || (!usage ? (accountResult.error || remoteResult.error) : null));

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
        profiles: accountProfiles,
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
    } finally {
      logUsageStages();
    }
  });
}

module.exports = {
  register,
  findCodexSessionFile,
  findLatestCodexSession,
  findCodexDescendantSessions,
  inspectCodexDescendantSessions,
  findCodexDirectChildSessions,
  inspectCodexDirectChildSessions,
  findCodexLinkedLiveBoundary,
  buildCodexTimeline,
  buildCodexFullHistory,
  buildCodexCleanExport,
  buildCodexRangeExport,
  buildCodexTurnAssistantContext,
  buildCodexTurnAssistantResult,
  editCodexRange,
  deleteCodexRange,
  forkCodexFromLatestCompact,
  getTimelineSessionMeta,
  listCodexModels,
  invalidateCodexJsonlCache,
  _api: {
    listCodexModels,
    findCodexSessionFile,
    findLatestCodexSession,
    findCodexDescendantSessions,
    inspectCodexDescendantSessions,
    findCodexDirectChildSessions,
    inspectCodexDirectChildSessions,
    selectSingleProvenCodexRewindRecoveryCandidate,
    findCodexLinkedLiveBoundary,
    readCodexSessionMetadata,
    scanCodexStableSourceRewindProof,
    isCodexUserTuiSession,
    parseJsonlFile,
    readJsonlRange,
    getCodexJsonlCacheStats,
    codexCompactCompanionLines,
    codexHistoryCellId,
    invalidateJsonlCache: invalidateCodexJsonlCache,
    buildCodexCleanEntries,
    extractTextContent,
    buildCodexCleanExport,
    buildCodexRangeExport,
    buildCodexTurnAssistantContext,
    buildCodexTurnAssistantResult,
    buildCodexProviderTurnAssistantResult,
    findCodexPromptExecutionContext,
    buildCodexVisibleRecordWrappers,
    planCodexRangeRewrite,
    validateCodexRangeRewriteProjection,
    planCodexForkFromLatestCompact,
    rewriteCodexEditedForkMetadata,
    resolveCodexHistoryMutationSettingsProof,
    ensureCodexEditedForkSettingsProof,
    writeCodexJsonlExclusive,
    buildCodexEmptySessionMetaRecord,
    materializeEmptySession: materializeEmptyCodexSession,
    inspectConversationMaterialization: inspectCodexConversationMaterialization,
    inspectConversationMaterializationFromFile: inspectCodexConversationMaterializationFromFile,
    editCodexRange,
    deleteCodexRange,
    forkCodexFromLatestCompact,
    loadSessionRecords,
    injectHistoryContext: null,
    buildCodexFullHistory,
    createCodexHistoryProjector,
    projectCodexFullHistoryFromFile,
    projectCodexTimelineFromFile,
    createCodexTimelineProjector,
    invalidateCodexHistoryProjectors,
    getCodexHistoryProjectorStats,
    setCodexHistoryProjectorBudgetMb,
    estimateProjectorBytes,
    estimateCodexProjectorCacheEntryBytes,
    buildCodexTimeline,
    findCodexExecNestedCalls,
    resolveSimpleJsCallValue,
    parseApplyPatchHistoryActions,
    parseHistoryUnifiedDiffHunks,
    parseCodexPatchApplyChanges,
    codexHistoryActionsForCall,
    getTimelineSessionMeta,
    latestCodexUsageInRecords,
    findLatestCodexUsage,
    findLatestCodexUsageAccounts,
    getCodexUsageAccountsFast,
    compareCodexRateSnapshotFreshness,
    compareCodexUsageFreshness,
    normalizeCodexWhamWindow,
    normalizeCodexAdditionalRateLimits,
    buildCodexUsageFromWhamResponse,
    buildCodexResetCreditsFromResponse,
    buildCodexUsageFromRateLimits,
    buildCodexUsageFromAppServerRateLimits,
    canonicalizeCodexUsage,
    codexUsageSnapshotsMatch,
    classifyCodexUsageSnapshot,
    reconcileCodexUsageSnapshot,
    selectCodexInitialUsageConsensus,
    serializeCodexUsageState,
    parseCodexUsageState,
    fetchCodexUsageFromOpenAI,
    fetchCodexResetCreditsFromOpenAI,
    getCodexRemoteUsage,
    readCodexAuthSession,
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
