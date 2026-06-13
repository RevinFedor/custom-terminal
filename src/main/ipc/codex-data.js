const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let modelCache = null;
const loggedRollbackKeys = new Set();

function compactPreview(value, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function recordTimestamp(record) {
  return record?.timestamp || record?.time || record?.created_at || new Date().toISOString();
}

function stableUuid(sessionId, index, prefix = 'codex') {
  return `${prefix}-${sessionId || 'unknown'}-${index}`;
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
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
  const text = await fs.promises.readFile(filePath, 'utf8');
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      records.push({ ...record, __line: i });
    } catch {
      // Ignore partial/corrupt trailing lines. Codex appends JSONL while running.
    }
  }
  return records;
}

function getSessionMeta(records) {
  for (const record of records) {
    if (record?.type === 'session_meta') return record.payload || {};
  }
  return {};
}

function getTimelineSessionMeta(records) {
  const meta = getSessionMeta(records);
  return {
    id: meta.id,
    forked_from_id: meta.forked_from_id,
    timestamp: meta.timestamp,
    cwd: meta.cwd,
  };
}

function getSessionMetas(records) {
  return records
    .filter((record) => record?.type === 'session_meta' && record.payload)
    .map((record) => record.payload);
}

function recordsReferenceSession(records, sessionId) {
  if (!sessionId) return false;
  return getSessionMetas(records).some((meta) => meta?.id === sessionId);
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

async function findLatestCodexSession({ cwd, sinceMs = 0, sourceSessionId = null } = {}) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
  const normalizedCwd = cwd ? path.resolve(cwd) : null;
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

  for (const candidate of candidates.slice(0, 80)) {
    let records;
    try {
      records = await parseJsonlFile(candidate.filePath);
    } catch {
      continue;
    }
    const meta = getSessionMeta(records);
    if (!meta?.id) continue;
    if (sourceSessionId && meta.id === sourceSessionId) continue;
    const sessionStartedMs = meta.timestamp ? Date.parse(meta.timestamp) : 0;
    if (sinceMs && sessionStartedMs && sessionStartedMs < sinceMs - 60000) continue;
    const cwdMatched = !normalizedCwd || !meta.cwd || path.resolve(meta.cwd) === normalizedCwd;
    const sourceMatched = recordsReferenceSession(records, sourceSessionId);
    if (!cwdMatched && !sourceMatched) continue;
    return {
      sessionId: meta.id,
      filePath: candidate.filePath,
      cwd: meta.cwd,
      cwdMatched,
      sourceMatched,
    };
  }
  return null;
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

function buildCodexCleanExport(records, sessionId, cwd, opts) {
  const meta = getSessionMeta(records);
  const entries = [];
  const pendingCalls = new Map();
  let currentTurnIndex = -1;
  let pendingThinking = '';

  const push = (entry) => entries.push({ ...entry, turnIndex: currentTurnIndex });

  for (const record of records) {
    const payload = record.payload || {};

    if (record.type === 'compacted') {
      push({
        kind: 'compact',
        text: compactEventContent(payload),
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
          });
        }
      } else if (payload.type === 'thread_rolled_back') {
        removeLastCodexTurns(entries, Number(payload.num_turns || payload.turns || 1));
        currentTurnIndex = Math.max(-1, ...entries.map(e => typeof e.turnIndex === 'number' ? e.turnIndex : -1));
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

  const out = [];
  out.push('# Codex Session Export');
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
    resets_at: normalizeCodexReset(bucket.resets_at ?? bucket.resetsAt),
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

  ipcMain.handle('codex:export-clean-session', async (_event, {
    sessionId, cwd,
    includeEditing = false, includeReading = false, fromStart = true,
    includeSubagentResult = false, includeSubagentHistory = false,
    includeUser = true, includeClaude = true,
    includeText = true, includeThinking = true,
    includeBash = false, includeTools = false,
    includeWebSearch = false, includeToolSearch = false, includeOtherTools = includeTools,
  }) => {
    try {
      const loaded = await loadSessionRecords(sessionId, cwd);
      if (!loaded.success) return loaded;
      const content = buildCodexCleanExport(loaded.records, sessionId, cwd, {
        includeEditing,
        includeReading,
        fromStart,
        includeSubagentResult,
        includeSubagentHistory,
        includeUser,
        includeClaude,
        includeText,
        includeThinking,
        includeBash,
        includeTools,
        includeWebSearch,
        includeToolSearch,
        includeOtherTools,
      });
      return { success: true, content, filePath: loaded.filePath };
    } catch (error) {
      console.error('[CodexData] export-clean-session error:', error);
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
      let usage = null;
      if (opts?.sessionId) {
        const loaded = await loadSessionRecords(opts.sessionId, opts.cwd);
        if (loaded.success) {
          usage = latestCodexUsageInRecords(loaded.records, loaded.filePath);
        }
      }
      if (!usage) usage = await findLatestCodexUsage();
      return { success: true, data: usage };
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
  _api: {
    findCodexSessionFile,
    findLatestCodexSession,
    parseJsonlFile,
    latestCodexUsageInRecords,
    findLatestCodexUsage,
  },
};
