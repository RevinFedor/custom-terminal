// Reading a subagent's own transcript so the History background-detail pane can
// show what the agent is actually DOING, live, instead of a placeholder.
//
// Why a separate reader at all: a subagent writes its work into its OWN file and
// hands the parent only the final answer. The parent's rollout/JSONL therefore
// never contains the steps — they exist, they are readable, but nothing was
// opening them (see fact-история-как-основная-поверхность.md).
//
// Two providers, two ways to find that file:
//
//   Claude — `<projectDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl`.
//     The agentId is known only from the completion <task-notification>, so a
//     RUNNING agent cannot be addressed by id at all. It is found positionally
//     instead: newest files in the session's subagents dir, matched by the task
//     text that the spawn call carried — the agent's first record is that very
//     prompt. Byte-identical prefix match, no fuzzy scoring.
//
//   Codex — a sibling rollout with `thread_source: subagent`. Its id IS known
//     immediately (spawn output carries agent_id in v1, task_name in v2), so the
//     lookup is a direct scan for that thread id.
//
// Reading is incremental by byte offset: agents produce megabytes (one real
// explorer wrote 3810 records), and re-reading the whole file on every tick
// would stall the main process exactly while the user watches it work.

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  classifyHistoryAction,
  parseMcpToolName,
} = require('../shared/history-action-grammar.cjs');
const {
  codexUserCarrierTextsMatch,
  codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText,
  isCodexProjectInstructionsUserText,
} = require('./codex-prompt-audit');

const MAX_STEP_CHARS = 600;
const MAX_STEPS_RETURNED = 400;
const SUBAGENT_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const { codexOwnTurnLaunchSettings, claudeOwnAssistantLaunchSettings } = require('./subagent-launch-settings');

function createSubagentStepProjectionState(options = {}) {
  const expectedCodexSessionId = String(options.codexSessionId || '');
  const boundarySeen = options.codexNewTaskBoundarySeen === true;
  return {
    claudeCalls: new Map(),
    codexCalls: new Map(),
    codexCells: new Map(),
    codexExpectedSessionId: expectedCodexSessionId,
    codexSessionId: expectedCodexSessionId,
    codexRootMetaSeen: options.codexRootMetaSeen === true,
    codexAgentPath: String(options.codexAgentPath || ''),
    codexNeedsNewTaskBoundary: options.codexNeedsNewTaskBoundary === true,
    codexNewTaskBoundarySeen: boundarySeen,
    codexAwaitingFirstVisibleOutput: boundarySeen,
    codexBootstrapInstructionSeen: options.codexBootstrapInstructionSeen === true
      || (Array.isArray(options.prefaceSteps)
        && options.prefaceSteps.some((step) => step?.kind === 'instruction')),
    codexCurrentCanonicalUserText: '',
    codexPendingResponseUsers: [],
    codexPendingAgentMessages: [],
    sourceLine: Math.max(0, Number(options.sourceLine) || 0),
    pendingLineParts: [],
    pendingLineBytes: 0,
    pendingLineSkip: false,
    pendingLinePrefix: Buffer.alloc(0),
    pendingLineStartOffset: 0,
    prefaceSteps: Array.isArray(options.prefaceSteps) ? [...options.prefaceSteps] : [],
    launchSettings: null,
  };
}

function resetSubagentStepProjectionState(state) {
  if (!state) return createSubagentStepProjectionState();
  state.claudeCalls?.clear?.();
  state.codexCalls?.clear?.();
  state.codexCells?.clear?.();
  state.codexSessionId = String(state.codexExpectedSessionId || '');
  state.codexRootMetaSeen = false;
  state.codexAgentPath = '';
  state.codexNeedsNewTaskBoundary = false;
  state.codexNewTaskBoundarySeen = false;
  state.codexAwaitingFirstVisibleOutput = false;
  state.codexBootstrapInstructionSeen = false;
  state.codexCurrentCanonicalUserText = '';
  state.codexPendingResponseUsers = [];
  state.codexPendingAgentMessages = [];
  state.sourceLine = 0;
  state.pendingLineParts = [];
  state.pendingLineBytes = 0;
  state.pendingLineSkip = false;
  state.pendingLinePrefix = Buffer.alloc(0);
  state.pendingLineStartOffset = 0;
  state.prefaceSteps = [];
  state.launchSettings = null;
  return state;
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    if (typeof value?.text === 'string') return value.text;
    if (typeof value?.output_text === 'string') return value.output_text;
    if (typeof value?.message === 'string') return value.message;
    return value == null ? '' : (() => {
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    })();
  }
  return value.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.output_text
      || (part?.content !== undefined ? contentText(part.content) : '');
  }).filter(Boolean).join('\n');
}

function codexTopLevelRecordTypeFromPrefix(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  const payloadIndex = prefix.search(/"payload"\s*:/);
  const topLevel = payloadIndex >= 0 ? prefix.slice(0, payloadIndex) : prefix;
  return /"type"\s*:\s*"([^"]+)"/.exec(topLevel)?.[1] || '';
}

function codexRecordShapeFromPrefix(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { recordType: '', payloadType: '', role: '' };
  }
  const prefix = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  const payloadIndex = prefix.search(/"payload"\s*:/);
  const topLevel = payloadIndex >= 0 ? prefix.slice(0, payloadIndex) : prefix;
  const payloadPrefix = payloadIndex >= 0 ? prefix.slice(payloadIndex) : '';
  return {
    recordType: /"type"\s*:\s*"([^"]+)"/.exec(topLevel)?.[1] || '',
    payloadType: /"type"\s*:\s*"([^"]+)"/.exec(payloadPrefix)?.[1] || '',
    role: /"role"\s*:\s*"([^"]+)"/.exec(payloadPrefix)?.[1] || '',
  };
}

function shouldSkipCodexBoundaryLinePrefix(buffer) {
  const shape = codexRecordShapeFromPrefix(buffer);
  if (!shape.recordType) return false;
  if (shape.recordType === 'compacted') return true;
  if (shape.recordType === 'response_item') {
    if (!shape.payloadType) return false;
    if (shape.payloadType === 'agent_message') return false;
    if (shape.payloadType === 'message') return shape.role === 'assistant';
    return true;
  }
  if (shape.recordType === 'event_msg') {
    if (!shape.payloadType) return false;
    return shape.payloadType !== 'agent_message' && shape.payloadType !== 'user_message';
  }
  return shape.recordType !== 'session_meta';
}

function appendBoundedPrefix(current, next, maxBytes = 4096) {
  const existing = Buffer.isBuffer(current) ? current : Buffer.alloc(0);
  if (existing.length >= maxBytes || !Buffer.isBuffer(next) || next.length === 0) return existing;
  const wanted = next.subarray(0, Math.max(0, maxBytes - existing.length));
  return existing.length > 0 ? Buffer.concat([existing, wanted]) : Buffer.from(wanted);
}

function codexSubagentMeta(meta = {}) {
  const sourceSubagent = meta?.source && typeof meta.source === 'object'
    ? meta.source.subagent
    : null;
  const agentPath = String(
    meta.agent_path
    || sourceSubagent?.agent_path
    || sourceSubagent?.agentPath
    || sourceSubagent?.thread_spawn?.agent_path
    || sourceSubagent?.threadSpawn?.agentPath
    || '',
  ).trim();
  const version = String(
    meta.multi_agent_version
    || sourceSubagent?.multi_agent_version
    || sourceSubagent?.version
    || '',
  ).trim().toLowerCase();
  const isSubagent = meta.thread_source === 'subagent'
    || !!meta.parent_thread_id
    || !!sourceSubagent;
  const isV2Subagent = isSubagent && (version === 'v2' || version === '2');
  return {
    agentPath,
    isV2Subagent,
    // Fail closed on metadata drift. A v2 child without an address cannot
    // prove where its copied parent snapshot ends; treating it as legacy would
    // expose the parent transcript again.
    needsNewTaskBoundary: isV2Subagent,
  };
}

function codexAgentEnvelopeHeader(value) {
  const text = String(value || '');
  const type = /^Message Type:\s*([^\r\n]+)\s*$/mi.exec(text)?.[1]?.trim() || '';
  const taskName = /^Task name:\s*([^\r\n]+)\s*$/mi.exec(text)?.[1]?.trim() || '';
  const sender = /^Sender:\s*([^\r\n]+)\s*$/mi.exec(text)?.[1]?.trim() || '';
  return { type, taskName, sender };
}

function isExactCodexNewTaskBoundary(payload, state) {
  const recipient = String(payload?.recipient || '').trim();
  const author = String(payload?.author || '').trim();
  const header = codexAgentEnvelopeHeader(contentText(payload?.content || payload?.message));
  const pathParts = String(state.codexAgentPath || '').split('/').filter(Boolean);
  const expectedParent = pathParts.length > 1
    ? '/' + pathParts.slice(0, -1).join('/')
    : '';
  return header.type === 'NEW_TASK'
    && !!state.codexAgentPath
    && recipient === state.codexAgentPath
    && header.taskName === recipient
    && !!header.sender
    && header.sender === author
    && !!expectedParent
    && author === expectedParent;
}

function stableCodexMessageStepId(state, record, role, payload) {
  const sessionId = String(state.codexSessionId || state.codexExpectedSessionId || 'unknown');
  if (Number.isFinite(record?.__line)) {
    return `codex-${role}-${sessionId}-${Number(record.__line)}`;
  }
  return String(payload?.id || payload?.item_id || '');
}

function codexMessageStep(state, record, payload, role, text) {
  const messageId = stableCodexMessageStepId(state, record, role, payload);
  return {
    id: messageId,
    messageId,
    kind: 'message',
    role,
    text,
    timestamp: record?.timestamp || payload?.timestamp || '',
    sessionId: String(state.codexSessionId || state.codexExpectedSessionId || ''),
    phase: payload?.phase || undefined,
    turnId: String(
      payload?.turn_id
      || payload?.internal_chat_message_metadata_passthrough?.turn_id
      || '',
    ),
    final: role === 'assistant' && payload?.phase === 'final_answer',
  };
}

function extractCodexProviderInstruction(text) {
  const value = String(text || '');
  const header = /^#\s+(AGENTS\.md|CLAUDE\.md)\s+instructions\s+for\s+([^\r\n]+)\s*$/mi.exec(value);
  if (!header) return null;
  const afterHeader = value.slice(header.index + header[0].length);
  const open = /^\s*<(INSTRUCTIONS|instructions)>/.exec(afterHeader);
  if (!open) return null;
  const tag = open[1];
  const bodyStart = header.index + header[0].length + open.index + open[0].length;
  const closeTag = `</${tag}>`;
  const closeIndex = value.indexOf(closeTag, bodyStart);
  if (closeIndex < 0) return null;
  const scope = String(header[2] || '').trim().replace(/[\\/]+$/, '');
  const scopeLabel = scope.split(/[\\/]/).filter(Boolean).pop() || scope;
  const rawName = String(header[1] || 'AGENTS.md');
  return {
    text: value.slice(header.index, closeIndex + closeTag.length),
    instructionFileName: rawName.toUpperCase().startsWith('CLAUDE') ? 'CLAUDE.md' : 'AGENTS.md',
    instructionScope: scopeLabel,
  };
}

function codexProviderInstructionStep(state, record, payload, text) {
  if (state.codexBootstrapInstructionSeen) return null;
  const instruction = extractCodexProviderInstruction(text);
  if (!instruction) return null;
  state.codexBootstrapInstructionSeen = true;
  return {
    id: stableCodexMessageStepId(state, record, 'context', payload),
    kind: 'instruction',
    role: 'user',
    ...instruction,
    timestamp: record?.timestamp || payload?.timestamp || '',
    sessionId: String(state.codexSessionId || state.codexExpectedSessionId || ''),
  };
}

function flushCodexPendingResponseUsers(state) {
  const pending = Array.isArray(state.codexPendingResponseUsers)
    ? state.codexPendingResponseUsers
    : [];
  state.codexPendingResponseUsers = [];
  return pending.map((candidate) => candidate.step);
}

function keepBoundedMap(map, key, value, limit = 128) {
  if (!key) return;
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function subagentPayloadSource(record, kind, toolUseId, extra = {}) {
  if (!Number.isFinite(record?.__byteOffset) || !Number.isFinite(record?.__byteLength)) return null;
  return {
    kind,
    toolUseId: String(toolUseId || ''),
    byteOffset: Number(record.__byteOffset),
    byteLength: Number(record.__byteLength),
    ...extra,
  };
}

function extractSubagentPayloadFromRecord({
  toolType,
  record,
  source,
  relatedRecord = null,
  codexDecodeCall = null,
}) {
  const payload = record?.payload || record;
  if (source?.kind === 'codex-result' && toolType === 'codex') {
    const callPayload = relatedRecord?.payload || {};
    const call = {
      callId: String(callPayload.call_id || callPayload.id || ''),
      toolName: callPayload.name || callPayload.tool_name || callPayload.type || 'Tool',
      namespace: callPayload.namespace || '',
      args: codexCallArgs(callPayload),
      patchApplyEvents: [],
    };
    const decoded = decodeCodexCallSteps(
      call,
      payload?.output,
      !!payload?.is_error,
      codexDecodeCall,
    );
    return contentText(decoded.steps[Number(source.actionIndex) || 0]?.result);
  }
  if (source?.kind === 'codex-args' && toolType === 'codex') {
    const call = {
      callId: String(payload.call_id || payload.id || ''),
      toolName: payload.name || payload.tool_name || payload.type || 'Tool',
      namespace: payload.namespace || '',
      args: codexCallArgs(payload),
      patchApplyEvents: [],
    };
    const decoded = decodeCodexCallSteps(call, undefined, false, codexDecodeCall);
    const args = decoded.steps[Number(source.actionIndex) || 0]?.args || {};
    try { return JSON.stringify(args); } catch { return ''; }
  }
  if (source?.kind === 'claude-result' && toolType !== 'codex') {
    const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
    const match = blocks.find((block) => (
      block?.type === 'tool_result'
      && String(block.tool_use_id || '') === String(source.toolUseId || '')
    ));
    return match ? contentText(match.content) : '';
  }
  if (source?.kind === 'claude-args' && toolType !== 'codex') {
    const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
    const match = blocks.find((block) => (
      block?.type === 'tool_use'
      && String(block.id || '') === String(source.toolUseId || '')
    ));
    try { return match ? JSON.stringify(match.input || {}) : ''; } catch { return ''; }
  }
  return '';
}

function codexStepFromAction(action, fallbackId) {
  if (!action) return null;
  if (action.tool === '__raw__') {
    const raw = action.rawTool || {};
    return {
      id: String(raw.toolUseId || fallbackId || ''),
      kind: 'tool',
      tool: String(raw.toolName || 'Tool'),
      text: String(raw.args?.command || raw.args?.summary || '').slice(0, MAX_STEP_CHARS),
      args: raw.args || {},
      result: raw.result === undefined ? undefined : contentText(raw.result),
      isError: !!raw.isError,
      family: raw.family,
      bashWord: raw.bashWord,
      bashDetail: raw.bashDetail,
      mcpServer: raw.mcpServer,
      mcpMethod: raw.mcpMethod,
      diffHunks: Array.isArray(raw.diffHunks) ? raw.diffHunks : undefined,
    };
  }
  if (action.tool === 'Task') {
    return {
      id: String(action.toolUseId || fallbackId || ''),
      kind: 'tool',
      tool: 'Subagent',
      text: String(action.description || 'Subagent').slice(0, MAX_STEP_CHARS),
      args: { summary: action.description || 'Subagent' },
      result: action.result === undefined ? undefined : contentText(action.result),
      isError: action.subagentStatus === 'interrupted',
      family: 'other',
    };
  }
  if (action.tool === 'Read' || action.tool === 'Edit' || action.tool === 'Write') {
    const args = {
      file_path: action.filePath || '',
      old_string: action.oldString || '',
      new_string: action.newString || '',
      content: action.content || '',
    };
    const classified = classifyHistoryAction({ toolName: action.tool, args });
    return {
      id: String(fallbackId || ''),
      kind: 'tool',
      tool: action.tool,
      text: String(action.filePath || '').slice(0, MAX_STEP_CHARS),
      args,
      diffHunks: Array.isArray(action.diffHunks) ? action.diffHunks : undefined,
      family: classified.family,
    };
  }
  if (typeof action === 'string') {
    return {
      id: String(fallbackId || ''),
      kind: 'tool',
      tool: 'Tool',
      text: action.slice(0, MAX_STEP_CHARS),
      args: { summary: action },
    };
  }
  return null;
}

function claudeProjectsDir() {
  return require('./claude-paths').claudeProjectsDir();
}

function codexSessionsDir() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

/** Text of the first user record — the task the agent was given. */
function readClaudeAgentPrompt(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf8').split('\n')[0];
    const record = JSON.parse(firstLine);
    const content = record?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.find((part) => part?.type === 'text');
      return typeof text?.text === 'string' ? text.text : '';
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function normalizeForMatch(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Locate a Claude subagent transcript.
 *
 * `agentId` is authoritative when present (completed agent). For a running one
 * only `taskText` exists, so candidates are ranked by recency and accepted on a
 * prefix match of the task text. `spawnedAt` narrows the window: files created
 * long before the spawn cannot belong to it.
 */
function findClaudeAgentFile({ parentSessionId, cwd, agentId, taskText, spawnedAt }) {
  const projectsDir = claudeProjectsDir();
  const dirs = [];
  if (cwd) dirs.push(path.join(projectsDir, String(cwd).replace(/\//g, '-')));
  // Resume/fork copies spawn rows into a new session file, so the subagents dir
  // may hang off any session of this project — scan them all as a fallback.
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => path.join(projectsDir, item.name));
  } catch { /* no projects dir */ }
  for (const dir of projectDirs) if (!dirs.includes(dir)) dirs.push(dir);

  if (agentId) {
    for (const dir of dirs) {
      const direct = parentSessionId
        ? path.join(dir, parentSessionId, 'subagents', `agent-${agentId}.jsonl`)
        : null;
      if (direct && fs.existsSync(direct)) return direct;
      // Session unknown or renamed by resume: look through every session dir.
      let sessions = [];
      try {
        sessions = fs.readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isDirectory()).map((item) => item.name);
      } catch { continue; }
      for (const session of sessions) {
        const candidate = path.join(dir, session, 'subagents', `agent-${agentId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  const wanted = normalizeForMatch(taskText);
  if (!wanted) return null;
  const spawnedMs = Number(spawnedAt) || 0;
  const candidates = [];
  for (const dir of dirs) {
    const sessionDirs = parentSessionId ? [parentSessionId] : (() => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isDirectory()).map((item) => item.name);
      } catch { return []; }
    })();
    for (const session of sessionDirs) {
      const subDir = path.join(dir, session, 'subagents');
      let files = [];
      try { files = fs.readdirSync(subDir); } catch { continue; }
      for (const name of files) {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
        const filePath = path.join(subDir, name);
        try {
          const stat = fs.statSync(filePath);
          // Created before the spawn (with a small clock allowance) → not ours.
          if (spawnedMs && stat.birthtimeMs && stat.birthtimeMs < spawnedMs - 30_000) continue;
          candidates.push({ filePath, at: stat.birthtimeMs || stat.mtimeMs });
        } catch { /* vanished mid-scan */ }
      }
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  for (const candidate of candidates.slice(0, 40)) {
    const prompt = normalizeForMatch(readClaudeAgentPrompt(candidate.filePath));
    if (!prompt) continue;
    if (prompt.startsWith(wanted) || wanted.startsWith(prompt)) return candidate.filePath;
  }
  return null;
}

/** Locate a Codex subagent rollout by its thread id (known from spawn output). */
function findCodexAgentFile({ agentSessionId }) {
  const wanted = String(agentSessionId || '').trim();
  if (!wanted) return null;
  const root = codexSessionsDir();
  const stack = [root];
  const found = [];
  while (stack.length) {
    const dir = stack.pop();
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { stack.push(full); continue; }
      if (!item.name.endsWith('.jsonl')) continue;
      // Rollout filenames embed the thread id — no need to open the file.
      if (item.name.includes(wanted)) found.push(full);
    }
  }
  return found[0] || null;
}

/**
 * Find the exact collaboration-v2 NEW_TASK boundary without materialising the
 * forked parent snapshot. The scan is asynchronous and retains at most one
 * JSONL record (plus the stream chunk): copied rollouts can be hundreds of MB
 * and may contain very large compact records.
 */
async function findCodexSubagentNewTaskBoundary({ filePath, expectedSessionId = '', resume = null }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { found: false, requiresBoundary: false, offset: 0, sessionId: '', agentPath: '' };
  }
  let statSize = 0;
  try { statSize = fs.statSync(filePath).size; } catch {}
  const resumeOffset = resume && Number(resume.resumeOffset) >= 0
    && Number(resume.resumeOffset) <= statSize
    ? Number(resume.resumeOffset)
    : 0;
  let rootMetaSeen = resumeOffset > 0 && resume?.rootMetaSeen === true;
  let sessionId = String((rootMetaSeen && resume?.sessionId) || expectedSessionId || '');
  let agentPath = String((rootMetaSeen && resume?.agentPath) || '');
  let requiresBoundary = rootMetaSeen && resume?.requiresBoundary === true;
  let bootstrapInstruction = rootMetaSeen ? (resume?.bootstrapInstruction || null) : null;
  let sourceLine = rootMetaSeen ? Math.max(0, Number(resume?.sourceLine) || 0) : 0;
  let pendingParts = [];
  let pendingBytes = 0;
  let pendingSkip = resumeOffset > 0 && resume?.skippingLine === true;
  let pendingPrefix = Buffer.alloc(0);
  let pendingStart = pendingSkip
    ? Math.max(0, Number(resume?.pendingStart) || 0)
    : resumeOffset;
  let streamOffset = resumeOffset;
  const marker = Buffer.from('NEW_TASK');
  const agentMessageMarker = Buffer.from('agent_message');
  const instructionsMarker = Buffer.from('instructions for');

  const resultBase = () => ({
    sessionId,
    agentPath,
    requiresBoundary,
    rootMetaSeen,
    sourceLine,
    bootstrapInstruction,
  });

  const inspectLine = (lineBuffer, byteOffset, hasNewline, lineNumber) => {
    if (!rootMetaSeen) {
      let record = null;
      try { record = JSON.parse(lineBuffer.toString('utf8')); } catch { /* not metadata */ }
      if (record?.type === 'session_meta' && record.payload) {
        rootMetaSeen = true;
        const child = codexSubagentMeta(record.payload);
        sessionId = String(record.payload.id || sessionId || '');
        agentPath = child.agentPath;
        requiresBoundary = child.needsNewTaskBoundary;
        if (!requiresBoundary) {
          return {
            found: false,
            requiresBoundary: false,
            offset: 0,
            ...resultBase(),
          };
        }
      }
      return null;
    }
    if (requiresBoundary && lineBuffer.includes(instructionsMarker)) {
      let contextRecord = null;
      try { contextRecord = JSON.parse(lineBuffer.toString('utf8')); } catch { /* not context */ }
      const contextPayload = contextRecord?.payload || {};
      if ((contextPayload.type === 'message' && contextPayload.role === 'user')
        || contextPayload.type === 'user_message') {
        const instruction = extractCodexProviderInstruction(
          codexUserMessagePresentationText(contextRecord),
        );
        if (instruction) {
          bootstrapInstruction = {
            id: `codex-context-${sessionId || 'unknown'}-${lineNumber}`,
            kind: 'instruction',
            role: 'user',
            ...instruction,
            timestamp: contextRecord?.timestamp || contextPayload?.timestamp || '',
            sessionId,
          };
        }
      }
    }
    if (!requiresBoundary
      || !lineBuffer.includes(marker)
      || !lineBuffer.includes(agentMessageMarker)) return null;
    let record = null;
    try { record = JSON.parse(lineBuffer.toString('utf8')); } catch { return null; }
    const payload = record?.payload || {};
    if (payload.type !== 'agent_message') return null;
    if (!isExactCodexNewTaskBoundary(payload, { codexAgentPath: agentPath })) return null;
    return {
      found: true,
      requiresBoundary: true,
      offset: byteOffset + lineBuffer.length + (hasNewline ? 1 : 0),
      nextSourceLine: lineNumber + 1,
      ...resultBase(),
    };
  };

  const stream = fs.createReadStream(filePath, {
    highWaterMark: 512 * 1024,
    ...(resumeOffset > 0 ? { start: resumeOffset } : {}),
  });
  for await (const chunk of stream) {
    const chunkStart = streamOffset;
    streamOffset += chunk.length;
    let cursor = 0;
    let newline = chunk.indexOf(0x0a, cursor);
    while (newline >= 0) {
      const segment = chunk.subarray(cursor, newline);
      const hasPendingLine = pendingSkip || pendingParts.length > 0 || pendingBytes > 0;
      const lineStart = hasPendingLine ? pendingStart : chunkStart + cursor;
      if (!hasPendingLine) pendingPrefix = Buffer.alloc(0);
      pendingPrefix = appendBoundedPrefix(pendingPrefix, segment);
      if (rootMetaSeen && shouldSkipCodexBoundaryLinePrefix(pendingPrefix)) {
        pendingSkip = true;
        pendingParts = [];
      }
      let lineBuffer;
      if (pendingSkip) {
        pendingBytes += segment.length;
        lineBuffer = null;
      } else if (pendingParts.length > 0) {
        pendingParts.push(Buffer.from(segment));
        pendingBytes += segment.length;
        lineBuffer = Buffer.concat(pendingParts, pendingBytes);
      } else {
        lineBuffer = segment;
      }
      pendingParts = [];
      pendingBytes = 0;
      const skippedLine = pendingSkip
        || codexTopLevelRecordTypeFromPrefix(lineBuffer) === 'compacted';
      pendingSkip = false;
      pendingPrefix = Buffer.alloc(0);
      const lineNumber = sourceLine;
      const hit = skippedLine || !lineBuffer
        ? null
        : inspectLine(lineBuffer, lineStart, true, lineNumber);
      sourceLine = lineNumber + 1;
      if (hit) {
        stream.destroy();
        return hit;
      }
      cursor = newline + 1;
      newline = chunk.indexOf(0x0a, cursor);
    }
    if (cursor < chunk.length) {
      const hasPendingLine = pendingSkip || pendingParts.length > 0 || pendingBytes > 0;
      if (!hasPendingLine) {
        pendingStart = chunkStart + cursor;
        pendingPrefix = Buffer.alloc(0);
      }
      const tail = Buffer.from(chunk.subarray(cursor));
      pendingPrefix = appendBoundedPrefix(pendingPrefix, tail);
      if (rootMetaSeen && shouldSkipCodexBoundaryLinePrefix(pendingPrefix)) {
        pendingSkip = true;
        pendingParts = [];
      }
      if (!pendingSkip) pendingParts.push(tail);
      pendingBytes += tail.length;
    }
  }

  if (!pendingSkip && pendingParts.length > 0) {
    const lineBuffer = Buffer.concat(pendingParts, pendingBytes);
    const hit = inspectLine(lineBuffer, pendingStart, false, sourceLine);
    if (hit) return hit;
  }
  return {
    found: false,
    offset: 0,
    resumeOffset: pendingSkip
      ? streamOffset
      : (pendingParts.length > 0 || pendingBytes > 0) ? pendingStart : streamOffset,
    skippingLine: pendingSkip,
    pendingStart,
    ...resultBase(),
  };
}

/** Claude record → steps. Tool results update the same stable tool id emitted
 * by the earlier call, even when call/result arrive in different byte reads. */
function claudeRecordToSteps(record, projectionState = null) {
  const state = projectionState || createSubagentStepProjectionState();
  if (!state.launchSettings) state.launchSettings = claudeOwnAssistantLaunchSettings(record);
  const steps = [];
  const role = record?.type;
  const content = record?.message?.content;
  if (role === 'user') {
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = String(block.tool_use_id || '');
      const pending = state.claudeCalls.get(toolUseId);
      if (!pending) continue;
      const updated = {
        ...pending,
        result: contentText(block.content),
        isError: !!block.is_error,
        _payloadSource: subagentPayloadSource(record, 'claude-result', toolUseId),
      };
      state.claudeCalls.delete(toolUseId);
      steps.push(updated);
    }
    const text = typeof content === 'string'
      ? content
      : blocks
        .filter((block) => block?.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');
    if (text.trim()) {
      steps.push({
        id: String(record?.uuid || ''),
        messageId: String(record?.uuid || ''),
        kind: 'message',
        role: 'user',
        // Preserve the actual prompt. The nested presentation owns collapse
        // and pasted-content chips; a 600-char reader truncation destroyed
        // both before presentation ever saw them.
        text,
        timestamp: record?.timestamp || '',
        sessionId: String(record?.sessionId || ''),
      });
    }
  }
  if (role === 'assistant' && Array.isArray(content)) {
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      const blockId = String(block?.id || record?.uuid || '')
        + ':' + blockIndex;
      if (block?.type === 'thinking' && block.thinking) {
        steps.push({
          id: blockId,
          messageId: String(record?.uuid || block?.id || blockId),
          kind: 'thinking',
          text: String(block.thinking).slice(0, MAX_STEP_CHARS),
        });
      } else if (block?.type === 'text' && block.text) {
        steps.push({
          id: blockId,
          messageId: String(record?.uuid || block?.id || blockId),
          kind: 'message',
          role: 'assistant',
          text: String(block.text),
          timestamp: record?.timestamp || '',
          sessionId: String(record?.sessionId || ''),
        });
      } else if (block?.type === 'tool_use') {
        const input = block.input || {};
        const label = typeof input.command === 'string' ? input.command
          : typeof input.file_path === 'string' ? input.file_path
            : typeof input.pattern === 'string' ? input.pattern
              : typeof input.description === 'string' ? input.description : '';
        const classified = classifyHistoryAction({ toolName: block.name, args: input });
        const mcp = parseMcpToolName(block.name);
        const step = {
          id: String(block.id || blockId),
          kind: 'tool',
          tool: String(block.name || 'Tool'),
          text: String(label).slice(0, MAX_STEP_CHARS),
          args: input,
          family: classified.family,
          bashWord: classified.bashWord,
          bashDetail: classified.bashDetail,
          mcpServer: classified.mcpServer || mcp?.server,
          mcpMethod: classified.mcpMethod || mcp?.method,
          _argsPayloadSource: subagentPayloadSource(record, 'claude-args', String(block.id || blockId)),
        };
        if (step.id) keepBoundedMap(state.claudeCalls, step.id, step);
        steps.push(step);
      }
    }
  }
  return steps;
}

function codexCallArgs(payload) {
  if (payload?.arguments != null) {
    if (typeof payload.arguments !== 'string') return payload.arguments || {};
    try { return JSON.parse(payload.arguments); } catch { return { input: payload.arguments }; }
  }
  if (typeof payload?.input === 'string') return { input: payload.input };
  return payload?.input && typeof payload.input === 'object' ? payload.input : {};
}

function decodeCodexCallSteps(call, rawOutput, isError, decodeCall) {
  if (typeof decodeCall === 'function') {
    const decoded = decodeCall(call, rawOutput, isError) || {};
    return {
      cellId: decoded.cellId || null,
      steps: (decoded.actions || [])
        .map((action, index) => codexStepFromAction(action, `${call.callId}:canonical:${index}`))
        .filter(Boolean),
    };
  }
  const rawName = String(call?.toolName || 'Tool');
  const toolName = rawName === 'exec' ? 'Script' : rawName === 'apply_patch' ? 'Patch' : rawName;
  const classified = classifyHistoryAction({ toolName, args: call?.args || {} });
  const mcp = parseMcpToolName(toolName);
  return {
    cellId: null,
    steps: [{
      id: String(call?.callId || ''),
      kind: 'tool',
      tool: toolName,
      text: String(call?.args?.input || '').replace(/\s+/g, ' ').slice(0, MAX_STEP_CHARS),
      args: call?.args || {},
      result: rawOutput == null ? undefined : contentText(rawOutput),
      isError: !!isError,
      family: classified.family,
      bashWord: classified.bashWord,
      bashDetail: classified.bashDetail,
      mcpServer: classified.mcpServer || mcp?.server,
      mcpMethod: classified.mcpMethod || mcp?.method,
    }],
  };
}

/** Codex rollout record → steps using the same canonical call decoder as the
 * parent History. Projection state joins call/result and async cell waits
 * across independent incremental byte reads. */
function codexRecordToSteps(record, projectionState = null, decodeCall = null) {
  const state = projectionState || createSubagentStepProjectionState();
  const payload = record?.payload || record;
  const type = payload?.type;

  if (record?.type === 'session_meta') {
    // A forked rollout can contain copied ancestor metadata later in the same
    // file. Only the first/root session_meta owns this child; accepting a
    // copied parent meta here would turn the NEW_TASK guard off mid-prefix.
    if (state.codexRootMetaSeen) return [];
    state.codexRootMetaSeen = true;
    const meta = record?.payload || {};
    const child = codexSubagentMeta(meta);
    state.codexSessionId = String(meta.id || state.codexExpectedSessionId || '');
    state.codexAgentPath = child.agentPath;
    state.codexNeedsNewTaskBoundary = child.needsNewTaskBoundary;
    state.codexNewTaskBoundarySeen = !child.needsNewTaskBoundary;
    state.codexAwaitingFirstVisibleOutput = false;
    state.codexCurrentCanonicalUserText = '';
    state.codexPendingResponseUsers = [];
    state.codexPendingAgentMessages = [];
    state.codexCalls.clear();
    state.codexCells.clear();
    return [];
  }

  // Collaboration v2 forks the whole parent transcript into the child file.
  // The first byte is therefore NOT the beginning of the child's work. The
  // exact boundary is a parent→child NEW_TASK envelope addressed to the
  // agent_path declared by this rollout's own session_meta. Timestamps cannot
  // prove this boundary because copied records are re-timestamped at spawn.
  if (type === 'agent_message') {
    if (!state.codexNeedsNewTaskBoundary) {
      const text = contentText(payload.content || payload.message).trim();
      if (!text) return [];
      const step = codexMessageStep(state, record, payload, 'assistant', text);
      state.codexPendingAgentMessages.push({ text, phase: payload?.phase || '', step });
      if (state.codexPendingAgentMessages.length > 8) {
        return [state.codexPendingAgentMessages.shift().step];
      }
      return [];
    }
    const recipient = String(payload?.recipient || '').trim();
    const header = codexAgentEnvelopeHeader(contentText(payload?.content || payload?.message));
    if (state.codexNeedsNewTaskBoundary
      && !state.codexNewTaskBoundarySeen
      && isExactCodexNewTaskBoundary(payload, state)) {
      state.codexNewTaskBoundarySeen = true;
      state.codexAwaitingFirstVisibleOutput = true;
      state.codexBootstrapInstructionSeen = false;
      state.codexCurrentCanonicalUserText = '';
      state.codexPendingResponseUsers = [];
      state.codexPendingAgentMessages = [];
      state.codexCalls.clear();
      state.codexCells.clear();
    }
    if (state.codexNewTaskBoundarySeen
      && header.type === 'MESSAGE'
      && recipient === state.codexAgentPath) {
      state.codexAwaitingFirstVisibleOutput = true;
      state.codexCurrentCanonicalUserText = '';
      state.codexPendingResponseUsers = [];
      state.codexPendingAgentMessages = [];
      return [{
        id: String(payload?.id || stableCodexMessageStepId(state, record, 'boundary', payload)),
        kind: 'boundary',
        role: 'user',
        text: '',
        timestamp: record?.timestamp || payload?.timestamp || '',
        sessionId: String(state.codexSessionId || state.codexExpectedSessionId || ''),
      }];
    }
    // Agent-to-agent envelopes (NEW_TASK/MESSAGE/FINAL_ANSWER) are control
    // carriers. Durable visible commentary/final text is recorded separately
    // as response_item.message; drawing both produced exact duplicates.
    return [];
  }

  if (state.codexNeedsNewTaskBoundary && !state.codexNewTaskBoundarySeen) {
    return [];
  }
  if (!state.launchSettings) state.launchSettings = codexOwnTurnLaunchSettings(record,
    state.codexExpectedSessionId, state.codexSessionId);

  if (record?.type === 'event_msg' && type === 'task_started') {
    state.codexCurrentCanonicalUserText = '';
    return [];
  }
  if (record?.type === 'event_msg' && type === 'patch_apply_end') {
    const callId = String(payload.call_id || payload.id || '');
    const pending = state.codexCalls.get(callId);
    if (pending) {
      if (!Array.isArray(pending.call.patchApplyEvents)) pending.call.patchApplyEvents = [];
      pending.call.patchApplyEvents.push(payload);
    }
    return [];
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.map((item) => (typeof item === 'string' ? item : item?.text || '')).join(' ')
      : String(payload.summary || '');
    const text = summary || (Array.isArray(payload.content)
      ? payload.content.map((item) => item?.text || '').join(' ') : '');
    if (!text.trim()) return [];
    state.codexAwaitingFirstVisibleOutput = false;
    return [...flushCodexPendingResponseUsers(state), {
      id: String(payload.id || payload.item_id || ''),
      kind: 'thinking',
      text: text.slice(0, MAX_STEP_CHARS),
      timestamp: record?.timestamp || '',
      sessionId: String(state.codexSessionId || ''),
    }];
  }
  if (type === 'custom_tool_call' || type === 'function_call') {
    state.codexAwaitingFirstVisibleOutput = false;
    const callId = String(payload.call_id || payload.id || '');
    const call = {
      callId,
      toolName: payload.name || payload.tool_name || payload.type || 'Tool',
      namespace: payload.namespace || '',
      args: codexCallArgs(payload),
      patchApplyEvents: [],
      source: subagentPayloadSource(record, 'codex-call', callId),
    };
    if (call.toolName === 'wait' || call.toolName === 'wait_agent') {
      const cellId = String(call.args?.cell_id || '');
      if (cellId && state.codexCells.has(cellId)) {
        keepBoundedMap(state.codexCalls, callId, { call, joinedCellId: cellId, steps: [] });
        return flushCodexPendingResponseUsers(state);
      }
    }
    const decoded = decodeCodexCallSteps(call, undefined, false, decodeCall);
    for (let actionIndex = 0; actionIndex < decoded.steps.length; actionIndex += 1) {
      const step = decoded.steps[actionIndex];
      step._argsPayloadSource = call.source
        ? { ...call.source, kind: 'codex-args', actionIndex }
        : null;
    }
    keepBoundedMap(state.codexCalls, callId, { call, steps: decoded.steps });
    return [...flushCodexPendingResponseUsers(state), ...decoded.steps];
  }
  if (type === 'custom_tool_call_output' || type === 'function_call_output') {
    const callId = String(payload.call_id || payload.id || '');
    const pending = state.codexCalls.get(callId);
    state.codexCalls.delete(callId);
    if (!pending) return flushCodexPendingResponseUsers(state);
    const original = pending.joinedCellId
      ? state.codexCells.get(pending.joinedCellId)
      : pending;
    if (!original?.call) return flushCodexPendingResponseUsers(state);
    const decoded = decodeCodexCallSteps(
      original.call,
      payload.output,
      !!payload.is_error,
      decodeCall,
    );
    if (decoded.cellId) {
      keepBoundedMap(state.codexCells, String(decoded.cellId), original, 64);
      return flushCodexPendingResponseUsers(state);
    }
    if (pending.joinedCellId) state.codexCells.delete(pending.joinedCellId);
    for (let actionIndex = 0; actionIndex < decoded.steps.length; actionIndex += 1) {
      const step = decoded.steps[actionIndex];
      step._argsPayloadSource = original.call.source
        ? { ...original.call.source, kind: 'codex-args', actionIndex }
        : null;
      step._payloadSource = subagentPayloadSource(record, 'codex-result', step.id || callId, {
        actionIndex,
        callSource: original.call.source || null,
      });
    }
    return [...flushCodexPendingResponseUsers(state), ...decoded.steps];
  }

  if (type === 'user_message') {
    const text = codexUserMessagePresentationText(record);
    if (!text.trim()) return [];
    if (state.codexAwaitingFirstVisibleOutput) {
      const instruction = codexProviderInstructionStep(state, record, payload, text);
      return instruction ? [instruction] : [];
    }
    if (
      isCodexEnvironmentContextUserText(text)
      || isCodexProjectInstructionsUserText(text)
      || text.includes('<subagent_notification>')
    ) return [];
    const pendingIndex = state.codexPendingResponseUsers.findIndex((candidate) => (
      codexUserCarrierTextsMatch(candidate.text, text)
    ));
    if (pendingIndex >= 0) state.codexPendingResponseUsers.splice(pendingIndex, 1);
    if (state.codexCurrentCanonicalUserText
      && codexUserCarrierTextsMatch(state.codexCurrentCanonicalUserText, text)) {
      return [];
    }
    state.codexCurrentCanonicalUserText = text;
    return [codexMessageStep(state, record, payload, 'user', text)];
  }

  if (type === 'message' && payload.role === 'user') {
    const text = codexUserMessagePresentationText(record);
    if (!text.trim()) return [];
    if (state.codexAwaitingFirstVisibleOutput) {
      const instruction = codexProviderInstructionStep(state, record, payload, text);
      return instruction ? [instruction] : [];
    }
    if (
      isCodexEnvironmentContextUserText(text)
      || isCodexProjectInstructionsUserText(text)
      || text.includes('<subagent_notification>')
    ) return [];
    if (state.codexCurrentCanonicalUserText
      && codexUserCarrierTextsMatch(state.codexCurrentCanonicalUserText, text)) {
      return [];
    }
    const step = codexMessageStep(state, record, payload, 'user', text);
    state.codexPendingResponseUsers.push({ text, step });
    // Response-only protocol generations are supported, but the response
    // carrier is held until the next meaningful child record. If an event_msg
    // twin arrives first, it replaces this pending carrier without a visual
    // duplicate. The queue is bounded even under a malformed rollout.
    if (state.codexPendingResponseUsers.length > 8) {
      return [state.codexPendingResponseUsers.shift().step];
    }
    return [];
  }

  if (type === 'message' && payload.role === 'assistant') {
    const text = Array.isArray(payload.content)
      ? payload.content.map((item) => item?.text || '').join('')
      : String(payload.content || payload.message || '');
    if (!text.trim()) return [];
    state.codexAwaitingFirstVisibleOutput = false;
    const pendingAgentIndex = state.codexPendingAgentMessages.findIndex((candidate) => (
      candidate.text === text
      && String(candidate.phase || '') === String(payload?.phase || '')
    ));
    if (pendingAgentIndex >= 0) state.codexPendingAgentMessages.splice(pendingAgentIndex, 1);
    return [
      ...flushCodexPendingResponseUsers(state),
      codexMessageStep(state, record, payload, 'assistant', text),
    ];
  }

  if (type === 'task_complete' || type === 'turn_aborted') {
    const pendingAgentMessages = state.codexPendingAgentMessages.splice(0)
      .map((candidate) => candidate.step);
    return [...flushCodexPendingResponseUsers(state), ...pendingAgentMessages];
  }
  return [];
}

function prepareAgentStepReadState({ projectionState, sessionId, offset, size }) {
  const start = Math.max(0, Number(offset) || 0);
  const state = projectionState || createSubagentStepProjectionState({ codexSessionId: sessionId });
  if (!state.codexExpectedSessionId && sessionId) {
    state.codexExpectedSessionId = String(sessionId);
    state.codexSessionId = String(sessionId);
  }
  if (start === 0) resetSubagentStepProjectionState(state);
  // File replaced/truncated (rare, but a stale offset would emit garbage).
  const from = start > size ? 0 : start;
  if (from === 0 && start !== 0) resetSubagentStepProjectionState(state);
  return { start, state, from, reset: from === 0 && start !== 0 };
}

function consumeAgentStepChunk({
  toolType,
  state,
  from,
  chunk,
  size,
  reset,
  codexDecodeCall,
}) {
  const bytesRead = chunk.length;
  const steps = Array.isArray(state.prefaceSteps) ? state.prefaceSteps.splice(0) : [];
  if (from >= size || bytesRead === 0) {
    return {
      success: true,
      steps,
      offset: size,
      size,
      pending: false,
      reset,
      launchSettings: state.launchSettings,
    };
  }
  let cursor = 0;
  let lineIndex = 0;
  let newline = chunk.indexOf(0x0a, cursor);
  while (newline >= 0) {
    const segment = chunk.subarray(cursor, newline);
    const hasPending = state.pendingLineSkip === true
      || (Array.isArray(state.pendingLineParts) && state.pendingLineParts.length > 0)
      || (Number(state.pendingLineBytes) || 0) > 0;
    const sourceByteOffset = hasPending
      ? Number(state.pendingLineStartOffset) || 0
      : from + cursor;
    if (!hasPending) state.pendingLinePrefix = Buffer.alloc(0);
    state.pendingLinePrefix = appendBoundedPrefix(state.pendingLinePrefix, segment);
    if (toolType === 'codex'
      && codexTopLevelRecordTypeFromPrefix(state.pendingLinePrefix) === 'compacted') {
      state.pendingLineSkip = true;
      state.pendingLineParts = [];
    }
    let lineBuffer;
    let skipHeavyCodexRecord = false;
    if (state.pendingLineSkip === true) {
      state.pendingLineBytes = (Number(state.pendingLineBytes) || 0) + segment.length;
      skipHeavyCodexRecord = true;
      lineBuffer = null;
    } else if (hasPending) {
      state.pendingLineParts.push(Buffer.from(segment));
      state.pendingLineBytes = (Number(state.pendingLineBytes) || 0) + segment.length;
      skipHeavyCodexRecord = toolType === 'codex'
        && codexTopLevelRecordTypeFromPrefix(state.pendingLineParts[0]) === 'compacted';
      lineBuffer = skipHeavyCodexRecord
        ? null
        : Buffer.concat(state.pendingLineParts, state.pendingLineBytes);
    } else {
      lineBuffer = segment;
      skipHeavyCodexRecord = toolType === 'codex'
        && codexTopLevelRecordTypeFromPrefix(segment) === 'compacted';
    }
    state.pendingLineParts = [];
    state.pendingLineBytes = 0;
    state.pendingLineSkip = false;
    state.pendingLinePrefix = Buffer.alloc(0);
    const sourceLine = Number(state.sourceLine) || 0;
    state.sourceLine = sourceLine + 1;
    const line = skipHeavyCodexRecord || !lineBuffer ? '' : lineBuffer.toString('utf8');
    if (!skipHeavyCodexRecord && line.trim()) {
      let record;
      try { record = JSON.parse(line); } catch { record = null; }
      if (record) {
        if (!Number.isFinite(record.__line)) record.__line = sourceLine;
        if (!Number.isFinite(record.__byteOffset)) record.__byteOffset = sourceByteOffset;
        if (!Number.isFinite(record.__byteLength)) record.__byteLength = lineBuffer.length;
        const parsed = toolType === 'codex'
          ? codexRecordToSteps(record, state, codexDecodeCall)
          : claudeRecordToSteps(record, state);
        for (let stepIndex = 0; stepIndex < parsed.length; stepIndex += 1) {
          const step = parsed[stepIndex];
          if (!step.id) step.id = `subagent-${sourceByteOffset}-${stepIndex}`;
          steps.push(step);
        }
      }
    }
    cursor = newline + 1;
    lineIndex += 1;
    newline = chunk.indexOf(0x0a, cursor);
  }
  if (cursor < chunk.length) {
    const hasPendingLine = state.pendingLineSkip === true
      || (Array.isArray(state.pendingLineParts) && state.pendingLineParts.length > 0)
      || (Number(state.pendingLineBytes) || 0) > 0;
    if (!hasPendingLine) {
      state.pendingLineParts = [];
      state.pendingLineBytes = 0;
      state.pendingLineStartOffset = from + cursor;
      state.pendingLinePrefix = Buffer.alloc(0);
    }
    const tail = Buffer.from(chunk.subarray(cursor));
    state.pendingLinePrefix = appendBoundedPrefix(state.pendingLinePrefix, tail);
    if (toolType === 'codex'
      && codexTopLevelRecordTypeFromPrefix(state.pendingLinePrefix) === 'compacted') {
      state.pendingLineSkip = true;
      state.pendingLineParts = [];
    }
    if (!state.pendingLineSkip) state.pendingLineParts.push(tail);
    state.pendingLineBytes = (Number(state.pendingLineBytes) || 0) + tail.length;
  }
  const nextOffset = from + bytesRead;
  return {
    success: true,
    steps: steps.slice(-MAX_STEPS_RETURNED),
    offset: nextOffset,
    size,
    pending: nextOffset < size,
    reset,
    launchSettings: state.launchSettings,
  };
}

/**
 * Synchronous helper retained for narrow unit fixtures. Production main uses
 * `readAgentStepsAsync` below so a child transcript never blocks Electron on
 * file I/O. Both consume the same bounded physical chunk and parser state.
 */
function readAgentSteps({
  toolType,
  filePath,
  sessionId = '',
  offset = 0,
  projectionState = null,
  codexDecodeCall = null,
}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'transcript not found', steps: [], offset: 0, size: 0 };
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: 0, size: 0 };
  }
  const prepared = prepareAgentStepReadState({ projectionState, sessionId, offset, size: stat.size });
  if (prepared.from >= stat.size) {
    return consumeAgentStepChunk({
      toolType, state: prepared.state, from: prepared.from, chunk: Buffer.alloc(0),
      size: stat.size, reset: prepared.reset, codexDecodeCall,
    });
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(SUBAGENT_READ_CHUNK_BYTES, stat.size - prepared.from);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, prepared.from);
    return consumeAgentStepChunk({
      toolType, state: prepared.state, from: prepared.from,
      chunk: buffer.subarray(0, bytesRead), size: stat.size,
      reset: prepared.reset, codexDecodeCall,
    });
  } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: prepared.from, size: stat.size };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

async function readAgentStepsAsync({
  toolType,
  filePath,
  sessionId = '',
  offset = 0,
  projectionState = null,
  codexDecodeCall = null,
}) {
  if (!filePath) {
    return { success: false, error: 'transcript not found', steps: [], offset: 0, size: 0 };
  }
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: 0, size: 0 };
  }
  const prepared = prepareAgentStepReadState({ projectionState, sessionId, offset, size: stat.size });
  if (prepared.from >= stat.size) {
    return consumeAgentStepChunk({
      toolType, state: prepared.state, from: prepared.from, chunk: Buffer.alloc(0),
      size: stat.size, reset: prepared.reset, codexDecodeCall,
    });
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const length = Math.min(SUBAGENT_READ_CHUNK_BYTES, stat.size - prepared.from);
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, prepared.from);
    return consumeAgentStepChunk({
      toolType, state: prepared.state, from: prepared.from,
      chunk: buffer.subarray(0, read.bytesRead), size: stat.size,
      reset: prepared.reset, codexDecodeCall,
    });
  } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: prepared.from, size: stat.size };
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
  }
}

/**
 * Did this agent finish, according to its OWN transcript?
 *
 * The parent is not a reliable witness: `wait_agent` is routinely called with
 * no target ("wait for anyone"), and its `Wait completed` output names nobody —
 * so an agent that really finished leaves no terminal trace in the parent. In a
 * live production tab 12 of 36 spawns had no terminal event at all, and 11 of
 * those 12 were plainly finished in their own file. Those cards animated the
 * tab forever.
 *
 * Reading is bounded to the file's tail: completion markers are written last,
 * and these transcripts reach tens of megabytes.
 */
const COMPLETION_TAIL_BYTES = 64 * 1024;

function readAgentCompletionProof({ toolType, filePath, notBefore = 0 }) {
  if (!filePath) return { finished: false, completedAt: 0 };
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return { finished: false, completedAt: 0 };
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(COMPLETION_TAIL_BYTES, stat.size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, stat.size - length);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload || record;
      const timestamp = Date.parse(record?.timestamp || payload?.timestamp || '') || 0;
      if (Number(notBefore) > 0 && timestamp > 0 && timestamp < Number(notBefore)) {
        return { finished: false, completedAt: 0 };
      }
      if (toolType === 'codex' && payload?.type === 'task_started') {
        return { finished: false, completedAt: 0 };
      }
      const finished = toolType === 'codex'
        ? (payload?.type === 'task_complete'
          || payload?.phase === 'final_answer' && payload?.delivery !== 'async')
        : (record?.stop_reason === 'end_turn'
          || record?.message?.stop_reason === 'end_turn');
      if (!finished) continue;
      if (Number(notBefore) > 0 && (!timestamp || timestamp < Number(notBefore))) {
        return { finished: false, completedAt: 0 };
      }
      return {
        finished: true,
        completedAt: timestamp,
      };
    }
    // A single record can exceed the bounded tail and begin before our read
    // boundary. Regex still proves completion, but without a parseable record
    // there is deliberately no invented completion timestamp.
    const finished = Number(notBefore) > 0 ? false : toolType === 'codex'
      ? /"type"\s*:\s*"task_complete"/.test(tail)
        || /"phase"\s*:\s*"final_answer"/.test(tail)
      : /"stop_reason"\s*:\s*"end_turn"/.test(tail);
    return { finished, completedAt: 0 };
  } catch {
    // Unreadable file proves nothing — never synthesise a terminal state.
    return { finished: false, completedAt: 0 };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function isAgentFinishedByOwnTranscript(input) {
  return readAgentCompletionProof(input).finished;
}

module.exports = {
  createSubagentStepProjectionState,
  findClaudeAgentFile,
  findCodexAgentFile,
  findCodexSubagentNewTaskBoundary,
  readAgentSteps,
  readAgentStepsAsync,
  extractSubagentPayloadFromRecord,
  claudeRecordToSteps,
  codexRecordToSteps,
  readAgentCompletionProof,
  isAgentFinishedByOwnTranscript,
};
