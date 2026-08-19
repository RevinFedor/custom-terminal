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
  codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText,
  isCodexProjectInstructionsUserText,
} = require('./codex-prompt-audit');

const MAX_STEP_CHARS = 600;
const MAX_STEPS_RETURNED = 400;

function createSubagentStepProjectionState() {
  return {
    claudeCalls: new Map(),
    codexCalls: new Map(),
    codexCells: new Map(),
  };
}

function resetSubagentStepProjectionState(state) {
  if (!state) return createSubagentStepProjectionState();
  state.claudeCalls?.clear?.();
  state.codexCalls?.clear?.();
  state.codexCells?.clear?.();
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
  return path.join(os.homedir(), '.claude', 'projects');
}

function codexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
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

/** Claude record → steps. Tool results update the same stable tool id emitted
 * by the earlier call, even when call/result arrive in different byte reads. */
function claudeRecordToSteps(record, projectionState = null) {
  const state = projectionState || createSubagentStepProjectionState();
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
        kind: 'message',
        role: 'user',
        // Preserve the actual prompt. The nested presentation owns collapse
        // and pasted-content chips; a 600-char reader truncation destroyed
        // both before presentation ever saw them.
        text,
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
          kind: 'thinking',
          text: String(block.thinking).slice(0, MAX_STEP_CHARS),
        });
      } else if (block?.type === 'text' && block.text) {
        steps.push({
          id: blockId,
          kind: 'message',
          role: 'assistant',
          text: String(block.text),
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
        };
        if (step.id) state.claudeCalls.set(step.id, step);
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
    return [{
      id: String(payload.id || payload.item_id || ''),
      kind: 'thinking',
      text: text.slice(0, MAX_STEP_CHARS),
    }];
  }
  if (type === 'custom_tool_call' || type === 'function_call') {
    const callId = String(payload.call_id || payload.id || '');
    const call = {
      callId,
      toolName: payload.name || payload.tool_name || payload.type || 'Tool',
      namespace: payload.namespace || '',
      args: codexCallArgs(payload),
      patchApplyEvents: [],
    };
    if (call.toolName === 'wait' || call.toolName === 'wait_agent') {
      const cellId = String(call.args?.cell_id || '');
      if (cellId && state.codexCells.has(cellId)) {
        state.codexCalls.set(callId, { call, joinedCellId: cellId, steps: [] });
        return [];
      }
    }
    const decoded = decodeCodexCallSteps(call, undefined, false, decodeCall);
    state.codexCalls.set(callId, { call, steps: decoded.steps });
    return decoded.steps;
  }
  if (type === 'custom_tool_call_output' || type === 'function_call_output') {
    const callId = String(payload.call_id || payload.id || '');
    const pending = state.codexCalls.get(callId);
    state.codexCalls.delete(callId);
    if (!pending) return [];
    const original = pending.joinedCellId
      ? state.codexCells.get(pending.joinedCellId)
      : pending;
    if (!original?.call) return [];
    const decoded = decodeCodexCallSteps(
      original.call,
      payload.output,
      !!payload.is_error,
      decodeCall,
    );
    if (decoded.cellId) {
      state.codexCells.set(String(decoded.cellId), original);
      return [];
    }
    if (pending.joinedCellId) state.codexCells.delete(pending.joinedCellId);
    return decoded.steps;
  }
  if ((type === 'message' && (payload.role === 'user' || payload.role === 'assistant'))
    || type === 'user_message') {
    const role = type === 'user_message' ? 'user' : payload.role;
    const text = role === 'user'
      ? codexUserMessagePresentationText(record)
      : Array.isArray(payload.content)
        ? payload.content.map((item) => item?.text || '').join('')
        : String(payload.content || payload.message || '');
    if (!text.trim()) return [];
    if (role === 'user' && (
      isCodexEnvironmentContextUserText(text)
      || isCodexProjectInstructionsUserText(text)
      || text.includes('<subagent_notification>')
    )) return [];
    return [{
      id: String(payload.id || payload.item_id || ''),
      kind: 'message',
      role,
      text,
    }];
  }
  if (type === 'agent_message') {
    const text = contentText(payload.content || payload.message).trim();
    if (!text) return [];
    return [{
      kind: 'message',
      role: 'assistant',
      text,
      final: payload.phase === 'final_answer',
    }];
  }
  return [];
}

/**
 * Read new bytes of an agent transcript and parse them into steps.
 * Returns `{ steps, offset, size, done }`; the caller stores `offset` and passes
 * it back next tick so only the appended tail is ever parsed.
 */
function readAgentSteps({
  toolType,
  filePath,
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
  const start = Math.max(0, Number(offset) || 0);
  const state = projectionState || createSubagentStepProjectionState();
  if (start === 0) resetSubagentStepProjectionState(state);
  // File replaced/truncated (rare, but a stale offset would emit garbage).
  const from = start > stat.size ? 0 : start;
  if (from === 0 && start !== 0) resetSubagentStepProjectionState(state);
  if (from >= stat.size) {
    return {
      success: true,
      steps: [],
      offset: stat.size,
      size: stat.size,
      reset: from === 0 && start !== 0,
    };
  }

  let chunk = '';
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const length = stat.size - from;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, from);
    chunk = buf.toString('utf8');
  } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: from, size: stat.size };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  const lines = chunk.split('\n');
  // A trailing partial line means the agent is mid-write: leave it for next tick
  // instead of dropping the record.
  const tail = lines.pop() ?? '';
  const consumed = stat.size - Buffer.byteLength(tail, 'utf8');
  const steps = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const parsed = toolType === 'codex'
      ? codexRecordToSteps(record, state, codexDecodeCall)
      : claudeRecordToSteps(record, state);
    for (let stepIndex = 0; stepIndex < parsed.length; stepIndex += 1) {
      const step = parsed[stepIndex];
      if (!step.id) step.id = `subagent-${from}-${lineIndex}-${stepIndex}`;
      steps.push(step);
    }
  }
  return {
    success: true,
    steps: steps.slice(-MAX_STEPS_RETURNED),
    offset: consumed,
    size: stat.size,
    reset: from === 0 && start !== 0,
  };
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

function readAgentCompletionProof({ toolType, filePath }) {
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
      const finished = toolType === 'codex'
        ? (payload?.type === 'task_complete'
          || payload?.phase === 'final_answer')
        : (record?.stop_reason === 'end_turn'
          || record?.message?.stop_reason === 'end_turn');
      if (!finished) continue;
      return {
        finished: true,
        completedAt: Date.parse(record?.timestamp || payload?.timestamp || '') || 0,
      };
    }
    // A single record can exceed the bounded tail and begin before our read
    // boundary. Regex still proves completion, but without a parseable record
    // there is deliberately no invented completion timestamp.
    const finished = toolType === 'codex'
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
  readAgentSteps,
  claudeRecordToSteps,
  codexRecordToSteps,
  readAgentCompletionProof,
  isAgentFinishedByOwnTranscript,
};
