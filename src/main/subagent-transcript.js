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

const MAX_STEP_CHARS = 600;
const MAX_STEPS_RETURNED = 400;

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

/** Claude record → step. Thinking is kept but marked so the UI can fold it. */
function claudeRecordToSteps(record) {
  const steps = [];
  const role = record?.type;
  const content = record?.message?.content;
  if (role === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'thinking' && block.thinking) {
        steps.push({ kind: 'thinking', text: String(block.thinking).slice(0, MAX_STEP_CHARS) });
      } else if (block?.type === 'text' && block.text) {
        steps.push({ kind: 'message', text: String(block.text).slice(0, MAX_STEP_CHARS) });
      } else if (block?.type === 'tool_use') {
        const input = block.input || {};
        const label = typeof input.command === 'string' ? input.command
          : typeof input.file_path === 'string' ? input.file_path
            : typeof input.pattern === 'string' ? input.pattern
              : typeof input.description === 'string' ? input.description : '';
        steps.push({
          kind: 'tool',
          tool: String(block.name || 'Tool'),
          text: String(label).slice(0, MAX_STEP_CHARS),
        });
      }
    }
  }
  return steps;
}

/** Codex rollout record → step. */
function codexRecordToSteps(record) {
  const payload = record?.payload || record;
  const type = payload?.type;
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.map((item) => (typeof item === 'string' ? item : item?.text || '')).join(' ')
      : String(payload.summary || '');
    const text = summary || (Array.isArray(payload.content)
      ? payload.content.map((item) => item?.text || '').join(' ') : '');
    if (!text.trim()) return [];
    return [{ kind: 'thinking', text: text.slice(0, MAX_STEP_CHARS) }];
  }
  if (type === 'custom_tool_call' || type === 'function_call') {
    const raw = typeof payload.input === 'string' ? payload.input
      : typeof payload.arguments === 'string' ? payload.arguments : '';
    return [{
      kind: 'tool',
      tool: String(payload.name || 'exec'),
      text: raw.replace(/\s+/g, ' ').slice(0, MAX_STEP_CHARS),
    }];
  }
  if (type === 'agent_message') {
    const text = String(payload.message || '').trim();
    if (!text) return [];
    return [{
      kind: 'message',
      text: text.slice(0, MAX_STEP_CHARS),
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
function readAgentSteps({ toolType, filePath, offset = 0 }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'transcript not found', steps: [], offset: 0, size: 0 };
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) {
    return { success: false, error: String(error.message || error), steps: [], offset: 0, size: 0 };
  }
  const start = Math.max(0, Number(offset) || 0);
  // File replaced/truncated (rare, but a stale offset would emit garbage).
  const from = start > stat.size ? 0 : start;
  if (from >= stat.size) return { success: true, steps: [], offset: stat.size, size: stat.size };

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
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const parsed = toolType === 'codex' ? codexRecordToSteps(record) : claudeRecordToSteps(record);
    for (const step of parsed) steps.push(step);
  }
  return {
    success: true,
    steps: steps.slice(-MAX_STEPS_RETURNED),
    offset: consumed,
    size: stat.size,
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

function isAgentFinishedByOwnTranscript({ toolType, filePath }) {
  if (!filePath) return false;
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return false;
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(COMPLETION_TAIL_BYTES, stat.size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, stat.size - length);
    const tail = buf.toString('utf8');
    if (toolType === 'codex') {
      // `task_complete` is the turn end; `final_answer` is the answer itself.
      return /"type"\s*:\s*"task_complete"/.test(tail)
        || /"phase"\s*:\s*"final_answer"/.test(tail);
    }
    // Claude subagent transcripts end with the assistant's last message; a
    // `stop_reason` of end_turn marks a completed response rather than a
    // truncated/aborted one.
    return /"stop_reason"\s*:\s*"end_turn"/.test(tail);
  } catch {
    // Unreadable file proves nothing — never synthesise a terminal state.
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = {
  findClaudeAgentFile,
  findCodexAgentFile,
  readAgentSteps,
  claudeRecordToSteps,
  codexRecordToSteps,
  isAgentFinishedByOwnTranscript,
};
