#!/usr/bin/env node
// =============================================================================
// MCP Overseer Server — granular session inspection for orchestrator agent
// Standalone process. Communicates with Noted Terminal via HTTP on localhost.
// Implements MCP JSON-RPC 2.0 over stdio (zero SDK dependencies).
//
// Tools:
//   list_open_sessions          — every Claude/Codex tab with a known session_id
//   session_stats               — char counts, turn count, largest turns
//   list_turns                  — map of turns (no full content, only sizes)
//   get_user_prompt             — one user prompt (with optional byte range)
//   get_thinking                — assistant thinking block(s) of a turn
//   get_assistant_text          — assistant text block(s) of a turn
//
// Design: agent decides granularity. Sizes come back in stats/list_turns so
// the agent can sample large blocks via {start,end} instead of pulling 50KB
// of thinking into its own context.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const PORT_DIR = join(homedir(), '.noted-terminal');

// ---------------------------------------------------------------------------
// Port Discovery — JSON port file format (matches terminal-server.mjs)
// Each port file holds { port, pid, openProjectPaths[], updatedAt }. Legacy
// files with bare port numbers are still recognised (fallback parse).
// ---------------------------------------------------------------------------

function listLiveInstances() {
  const out = [];
  try {
    const files = readdirSync(PORT_DIR).filter(f => f.startsWith('mcp-port-'));
    for (const f of files) {
      const pid = parseInt(f.replace('mcp-port-', ''));
      if (!pid) continue;
      try { process.kill(pid, 0); } catch { continue; }
      const full = join(PORT_DIR, f);
      let raw;
      try { raw = readFileSync(full, 'utf-8').trim(); } catch { continue; }
      let payload;
      try { payload = JSON.parse(raw); }
      catch { payload = { port: parseInt(raw), openProjectPaths: [] }; }
      if (!payload.port) continue;
      const mtime = (() => { try { return statSync(full).mtimeMs; } catch { return 0; } })();
      out.push({ ...payload, pid, mtime });
    }
  } catch {}
  return out;
}

// Pick instance that owns the requested cwd (longest prefix match). Fallback
// to most-recently-updated if no instance has the project open.
function pickInstance(cwd) {
  const instances = listLiveInstances();
  if (!instances.length) return null;
  if (cwd) {
    let best = null;
    let bestLen = -1;
    for (const inst of instances) {
      for (const p of inst.openProjectPaths || []) {
        if (typeof p !== 'string' || !p) continue;
        if (cwd === p || cwd.startsWith(p + '/')) {
          if (p.length > bestLen) { bestLen = p.length; best = inst; }
        }
      }
    }
    if (best) return best;
  }
  instances.sort((a, b) => b.mtime - a.mtime);
  return instances[0];
}

function getPort(cwd) {
  const inst = pickInstance(cwd);
  return inst ? inst.port : null;
}

async function httpGet(endpoint, hintCwd) {
  const port = getPort(hintCwd);
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');
  const res = await fetch('http://127.0.0.1:' + port + endpoint);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

async function httpPost(endpoint, body, hintCwd) {
  const port = getPort(hintCwd);
  if (!port) throw new Error('Noted Terminal is not running (no port file in ' + PORT_DIR + ')');
  const res = await fetch('http://127.0.0.1:' + port + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || text));
  return json;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_open_sessions',
    description: 'List every Claude or Codex tab in the running Noted Terminal that has a known sessionId. Use as the first call to see what work is currently in progress. Returns tabId, tabName, sessionId, cwd, project, commandType (claude, claude-sdk, or codex), isLive (PTY alive), createdAt, plus Claude model/context used/remaining percent when available from the statusline bridge. Completion/waiting MUST be based on busy/status/lastEvent from this tool, not on text block growth. The sessionId from this list is the input for every other overseer tool.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_stats',
    description: 'High-level statistics for a session WITHOUT pulling any content into context. Use this BEFORE list_turns to decide whether the session is small (read everything) or large (sample selectively). Also prints the live lifecycle wait gate from /overseer/sessions: if busy=true, assistant text may still be partial. Returns: turnCount, userTurns, compactSummaries, compactBoundaries, noisePromptCount, totalChars per role, toolUseCount, largestUserTurn, largestThinkingTurn, firstTimestamp, lastTimestamp, sizeBytes. Also: noteCount (user-authored purple notes on Timeline), rewindMarkerCount (pink dots from edit-range compactions), docsEditedTurns (green dots — turns where docs/ or CLAUDE.md was edited), docsSearchTurns.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session UUID from list_open_sessions' },
        cwd: { type: 'string', description: 'Optional: project cwd if sessionId search needs scoping' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_turns',
    description: 'Map of all turns in a session — sizes and previews only, NOT full content. Also prints the live lifecycle wait gate from /overseer/sessions: if busy=true, text blocks are a partial stream, not a final answer. Each turn has turnIndex (the addressable handle), kind (user | compact_summary | compact_boundary), userChars, userPreview (first 220 chars), thinkingBlocks[] and textBlocks[] with chars-per-block, toolUses[] with tool names. Noise prompts (command-name / system-reminder / interrupted) are filtered by default. Annotations attached per turn: `note` (user-authored anchor — purple on Timeline), `rewindMarker` (pink dot from earlier edit-range), `docsEdited` (list of doc/CLAUDE.md files modified — green Docs-update indicator), `docsSearchQueries`. Use to plan which specific turns to inspect deeper AND to localize work by user-named anchors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        limit: { type: 'integer', description: 'Max turns to return (default 50, max 500)' },
        offset: { type: 'integer', description: 'Pagination offset (default 0)' },
        kind: { type: 'string', description: 'Filter by kind: user | compact_summary | compact_boundary' },
        includeNoise: { type: 'boolean', description: 'Include filtered noise prompts (default false)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'list_notes',
    description: 'List all user-authored notes on Timeline of a session, plus rewind markers (pink dots from previous compact operations) and orphan notes (notes pointing to records no longer on the active branch — usually from rewind/fork operations). Notes are the user\'s persistent anchors — they think in terms of "between note A and note B we did X". Each note includes its turnIndex (so you can immediately call get_thinking on that range), the note content (1-line label like "план как читать jsonl"), and the position (before/dot/after the turn). When the user asks "what was around the note about X?" — ALWAYS call this first to find the turnIndex of that note. Notes survive across forks and edit-range operations (copied to the new session).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_user_prompt',
    description: 'Full text of one user prompt by turnIndex. Use start/end (character offsets) when the prompt is huge — list_turns reports userChars so you know the size. Negative offsets are supported (end:-500 = last 500 chars). For pasted_content blocks this returns the raw text including the chip wrappers.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer', description: 'Turn handle from list_turns' },
        start: { type: 'integer', description: 'Char offset start (inclusive). Negative = from end.' },
        end: { type: 'integer', description: 'Char offset end (exclusive). Negative = from end.' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'get_thinking',
    description: 'Assistant thinking block(s) of one turn. Thinking is where Claude restates the task and plans — usually the densest summary of what happened. Without `block` param returns array of {idx, chars, preview:200char} for ALL thinking blocks of the turn. With `block:N` returns the full Nth block (optionally sliced by start/end).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer' },
        block: { type: 'integer', description: 'Specific block index (0-based). Omit to get all-blocks preview map.' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'get_assistant_text',
    description: 'Assistant text block(s) of one turn — what Claude has written to the user so far (excluding thinking and tool_use). Same semantics as get_thinking: no `block` → preview map of all text blocks; with `block:N` → full Nth block with optional range. One turn can have multiple text blocks interleaved with tool_use — they appear in original order. The response includes the live lifecycle wait gate; if busy=true, do NOT treat any text block as final yet.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        turnIndex: { type: 'integer' },
        block: { type: 'integer' },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
      required: ['sessionId', 'turnIndex'],
    },
  },
  {
    name: 'fork_session',
    description: 'Create a copy of a Claude session under a new sessionId. Use BEFORE any edit when you are not 100% sure of the plan, OR rely on apply_edit\'s autoFork (default true on first call). The forked session has all entries with sessionId rewritten so it is independent of the parent — closing the fork tab does NOT touch the original. Returns the new sessionId. Note: chain resolution is skipped (does NOT follow plan-mode bridges). Codex read-path is supported, but Codex edit/fork via overseer is not.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Source session UUID' },
        cwd: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'propose_edit',
    description: 'Dry-run preview of an edit operation for Claude sessions. Computes EXACTLY what apply_edit would remove using the same backtrace + forward-expand logic — but does NOT touch disk. Returns: removedCount split by role (user/assistant/other), removedUserChars/removedAssistantChars (savings), entryBefore/entryAfter UUIDs (relink points), firstRemoved/lastRemoved with previews, and `nearTip` flag (true when actualEnd ≥ branchLength-3 — agent should warn user that this is essentially a rewind, not a mid-session compaction).\n\nUse modes:\n- `compact`: replaces range with a single user-message containing `compactText` (summary of removed work). Used when removed work has results worth preserving as a summary.\n- `delete`: removes range without replacement. Used when user prompt was dump-of-context/repeat-question with no salvageable result.\n\nIMPORTANT: ALWAYS call propose_edit before apply_edit. Show plan to user, get explicit OK, then apply_edit. Codex read-path is supported, but Codex edit-range through overseer is not.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        startUuid: { type: 'string', description: 'First record to remove (from list_turns userUuid or thinking/text record uuid)' },
        endUuid: { type: 'string', description: 'Last record to remove. SAME as startUuid for single-message edit. Forward-expand will pull in following assistant/tool_result records automatically.' },
        mode: { type: 'string', enum: ['compact', 'delete'], description: '"compact" replaces range with summary, "delete" just removes.' },
      },
      required: ['sessionId', 'startUuid', 'endUuid', 'mode'],
    },
  },
  {
    name: 'apply_edit',
    description: 'Execute an edit on a Claude session JSONL via the SAME implementation as Timeline\'s edit-range button — backtrace, forward-expand, orphan cleanup, parentUuid relink, atomic write. NEVER edits JSONL directly — calls existing IPC handlers.\n\nSafety: pass `autoFork: true` on the FIRST edit of a session — server will fork first, edit applies to the fork, the original stays intact. Returns new sessionId user can open in a tab. For follow-up edits on the same fork, pass `autoFork: false` and use the fork\'s sessionId from the previous call as the new `sessionId`.\n\nALWAYS call propose_edit first and confirm with the user. Do not run apply_edit speculatively. Codex read-path is supported, but Codex edit-range through overseer is not.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        cwd: { type: 'string' },
        startUuid: { type: 'string' },
        endUuid: { type: 'string' },
        mode: { type: 'string', enum: ['compact', 'delete'] },
        compactText: { type: 'string', description: 'Required for mode="compact". Pure-fact summary of what work the removed range produced. NO opinions, NO "next steps", just outcome.' },
        autoFork: { type: 'boolean', description: 'If true (default true), create a fork BEFORE applying and operate on the fork. Set false for chained edits on a fork you just created.' },
      },
      required: ['sessionId', 'startUuid', 'endUuid', 'mode'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function qs(params) {
  const pairs = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return pairs.length ? '?' + pairs.join('&') : '';
}

function formatLiveLifecycle(sessionId, session) {
  let text = 'Live lifecycle (authoritative wait gate):\n';
  if (!session) {
    text += '  status: not in open tabs\n';
    text += '  wait: no live busy/Stop signal is available; use transcript timestamps only, and do not infer a live child is done from stable text blocks.\n';
    return text + '\n';
  }

  const status = session.status || (session.busy ? 'busy' : (session.isLive ? 'active' : 'closed'));
  const liveLabel = session.isLive ? 'LIVE' : 'closed/idle';
  text += '  sessionId: ' + sessionId + '\n';
  text += '  tab: ' + (session.tabName || '(unnamed)') + ' [' + liveLabel + ']\n';
  text += '  status: ' + status + '\n';
  if (session.busy) {
    const sources = Array.isArray(session.busySources) && session.busySources.length
      ? ' (' + session.busySources.join(', ') + ')'
      : '';
    text += '  busy: true' + sources + '\n';
  } else if (typeof session.busy === 'boolean') {
    text += '  busy: false\n';
  }
  if (typeof session.turnBusy === 'boolean') {
    text += '  turnBusy: ' + session.turnBusy + '\n';
  }
  if (session.lastEventType) {
    text += '  lastEvent: ' + session.lastEventType + (session.lastEventTs ? ' @ ' + session.lastEventTs : '') + '\n';
  }
  if (session.model) text += '  model: ' + session.model + '\n';
  if (typeof session.contextUsedPct === 'number') {
    const used = Math.round(session.contextUsedPct);
    const remaining = typeof session.contextRemainingPct === 'number'
      ? Math.round(session.contextRemainingPct)
      : Math.max(0, 100 - used);
    text += '  context: ' + used + '% used / ' + remaining + '% remaining';
    if (session.contextSource) text += ' (' + session.contextSource + ')';
    text += '\n';
  }
  if (session.busy) {
    text += '  wait: BUSY - text/thinking blocks may be partial; keep polling list_open_sessions/session_stats until busy:false or a terminal Stop/complete event is visible.\n';
  } else {
    text += '  wait: NOT BUSY - OK to read latest assistant text as the completed transcript state.\n';
  }
  return text + '\n';
}

async function liveLifecycleForSession(sessionId, cwd) {
  try {
    const result = await httpGet('/overseer/sessions', cwd);
    const sessions = result.sessions || [];
    const session = sessions.find(s => s.sessionId === sessionId) || null;
    return formatLiveLifecycle(sessionId, session);
  } catch (err) {
    return 'Live lifecycle (authoritative wait gate):\n' +
      '  status: unavailable (' + err.message + ')\n' +
      '  wait: do not infer completion from stable text block counts; call list_open_sessions again when the backend is reachable.\n\n';
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'list_open_sessions': {
      const result = await httpGet('/overseer/sessions', args && args.cwd);
      const sessions = result.sessions || [];
      if (sessions.length === 0) return 'No open AI sessions with known sessionId.';
      let text = `Open AI sessions (${sessions.length}):\n`;
      for (const s of sessions) {
        const status = s.status || (s.busy ? 'busy' : (s.isLive ? 'active' : 'closed/idle'));
        text += '\n- ' + (s.tabName || '(unnamed)') + (s.isLive ? ' [LIVE]' : ' [closed/idle]');
        text += '\n  status: ' + status;
        if (s.busy) {
          const sources = Array.isArray(s.busySources) && s.busySources.length
            ? ' (' + s.busySources.join(', ') + ')'
            : '';
          text += '\n  busy: true' + sources;
        } else if (typeof s.busy === 'boolean') {
          text += '\n  busy: false';
        }
        if (typeof s.turnBusy === 'boolean') {
          text += '\n  turnBusy: ' + s.turnBusy;
        }
        if (s.lastEventType) {
          text += '\n  lastEvent: ' + s.lastEventType + (s.lastEventTs ? ' @ ' + s.lastEventTs : '');
        }
        text += s.busy
          ? '\n  wait: BUSY - do not treat text blocks as final yet'
          : '\n  wait: NOT BUSY - latest transcript can be read as completed state';
        text += '\n  sessionId: ' + s.sessionId;
        text += '\n  tabId: ' + s.tabId;
        text += '\n  cwd: ' + (s.cwd || '(unknown)');
        text += '\n  type: ' + (s.commandType || s.engine || 'claude');
        if (s.model) text += '\n  model: ' + s.model;
        if (typeof s.contextUsedPct === 'number') {
          const used = Math.round(s.contextUsedPct);
          const remaining = typeof s.contextRemainingPct === 'number'
            ? Math.round(s.contextRemainingPct)
            : Math.max(0, 100 - used);
          text += '\n  context: ' + used + '% used / ' + remaining + '% remaining';
          if (s.contextSource) text += ' (' + s.contextSource + ')';
        }
        if (s.projectTitle) text += '\n  project: ' + s.projectTitle;
        text += '\n';
      }
      return text;
    }

    case 'session_stats': {
      const { sessionId, cwd } = args;
      const r = await httpGet('/overseer/session/' + sessionId + '/stats' + qs({ cwd }), cwd);
      const tc = r.totalChars || {};
      let text = await liveLifecycleForSession(sessionId, cwd);
      text += `Session ${sessionId}\n`;
      text += `File: ${r.filePath} (${(r.sizeBytes / 1024 / 1024).toFixed(2)} MB)\n`;
      text += `Turns: ${r.turnCount} total — ${r.userTurns} user prompts, ${r.compactSummaries} compact_summary, ${r.compactBoundaries} compact_boundary, ${r.noisePromptCount} noise filtered\n`;
      text += `Chars: user=${tc.user || 0}, assistantThinking=${tc.assistantThinking || 0}, assistantText=${tc.assistantText || 0}\n`;
      text += `Tool uses: ${r.toolUseCount || 0}\n`;
      if (r.firstTimestamp) text += `Window: ${r.firstTimestamp} → ${r.lastTimestamp}\n`;
      if (r.largestUserTurn && r.largestUserTurn.turnIndex >= 0) {
        text += `Largest user prompt: turn ${r.largestUserTurn.turnIndex} (${r.largestUserTurn.chars} chars)\n`;
      }
      if (r.largestThinkingTurn && r.largestThinkingTurn.turnIndex >= 0) {
        text += `Largest thinking: turn ${r.largestThinkingTurn.turnIndex} (${r.largestThinkingTurn.chars} chars)\n`;
      }
      text += `Branch length (raw records on active branch): ${r.branchLength}\n`;
      text += `\nTimeline anchors:\n`;
      text += `  Notes: ${r.noteCount || 0}` + (r.orphanNoteCount ? ` (+${r.orphanNoteCount} orphan)` : '') + ` (purple, user-authored)\n`;
      text += `  Rewind markers: ${r.rewindMarkerCount || 0} (pink, from edit-range compactions)\n`;
      text += `  Docs edits: ${r.docsEditedTurns || 0} turns touched docs/ or CLAUDE.md (green dot)\n`;
      text += `  Docs searches: ${r.docsSearchTurns || 0} turns called mcp__knowledge__docs_search\n`;
      if (r.noteCount > 0) text += `  → call list_notes to see them with content\n`;
      return text;
    }

    case 'list_notes': {
      const { sessionId, cwd } = args;
      const r = await httpGet('/overseer/session/' + sessionId + '/notes' + qs({ cwd }), cwd);
      const notes = r.notes || [];
      const rew = r.rewindMarkers || [];
      const orphan = r.orphanNotes || [];
      if (!notes.length && !rew.length && !orphan.length) {
        return 'No timeline notes or rewind markers in this session.';
      }
      let text = `Notes (${notes.length}) — user-authored anchors on Timeline:\n`;
      for (const n of notes) {
        text += `\n[note @ turn ${n.turnIndex}] "${n.content}"`;
        text += ` (pos: ${n.position}` + (n.turnTimestamp ? `, ${n.turnTimestamp}` : '') + `)`;
        if (n.turnPreview) text += `\n  turn preview: ${JSON.stringify(n.turnPreview.slice(0, 140))}`;
        text += '\n';
      }
      if (rew.length) {
        text += `\nRewind markers (${rew.length}) — pink dots, were created by edit-range compactions:\n`;
        for (const m of rew) {
          text += `  [rewind @ turn ${m.turnIndex}]` + (m.turnTimestamp ? ` ${m.turnTimestamp}` : '') + '\n';
        }
      }
      if (orphan.length) {
        text += `\nOrphan notes (${orphan.length}) — entry_uuid no longer on active branch (likely from rewind/fork):\n`;
        for (const o of orphan) {
          text += `  "${o.content}" (uuid ${o.entryUuid.slice(0, 8)}...)\n`;
        }
      }
      return text;
    }

    case 'list_turns': {
      const { sessionId, cwd, limit, offset, kind, includeNoise } = args;
      const r = await httpGet('/overseer/session/' + sessionId + '/turns' + qs({
        cwd, limit, offset, kind, includeNoise: includeNoise ? 1 : undefined,
      }), cwd);
      const items = r.turns || [];
      let text = await liveLifecycleForSession(sessionId, cwd);
      text += `Turns for ${sessionId}: returned ${items.length} of ${r.total} (offset ${r.offset}, limit ${r.limit})\n`;
      for (const t of items) {
        const thChars = (t.thinkingBlocks || []).reduce((s, b) => s + b.chars, 0);
        const txChars = (t.textBlocks || []).reduce((s, b) => s + b.chars, 0);
        const toolNames = (t.toolUses || []).map(x => x.name).slice(0, 8).join(',');
        text += `\n[turn ${t.turnIndex}] ${t.kind}`;
        if (t.timestamp) text += ' @ ' + t.timestamp;
        if (t.model) text += ' | model=' + t.model;
        if (t.note) text += `\n  📝 NOTE (${t.note.position}): "${t.note.content}"`;
        if (t.rewindMarker) text += `\n  ↩ REWIND MARKER (pink dot)`;
        if (t.docsEdited && t.docsEdited.length) text += `\n  ✏️ docsEdited: ${t.docsEdited.join(', ')}`;
        if (t.docsSearchQueries && t.docsSearchQueries.length) text += `\n  🔍 docsSearch: ${t.docsSearchQueries.map(q => JSON.stringify(q.slice(0,60))).join(', ')}`;
        text += `\n  user: ${t.userChars} chars`;
        if (t.userPreview) text += ' | preview: ' + JSON.stringify(t.userPreview.slice(0, 160));
        text += `\n  thinking: ${t.thinkingBlocks.length} blocks (${thChars} chars total)`;
        text += `\n  text: ${t.textBlocks.length} blocks (${txChars} chars total)`;
        if (t.toolUses && t.toolUses.length) text += `\n  tools: ${t.toolUses.length} uses [${toolNames}]`;
        if (t.preTokens) text += `\n  compact: preTokens=${t.preTokens} → postTokens=${t.postTokens}`;
        text += '\n';
      }
      return text;
    }

    case 'get_user_prompt': {
      const { sessionId, cwd, turnIndex, start, end } = args;
      const r = await httpGet('/overseer/session/' + sessionId + '/turn/' + turnIndex + '/user' + qs({ cwd, start, end }), cwd);
      let text = await liveLifecycleForSession(sessionId, cwd);
      text += `Turn ${turnIndex} user prompt — ${r.totalChars} chars total (kind=${r.kind})`;
      if (r.start != null || r.end != null) text += ` | range [${r.start ?? 0}..${r.end ?? r.totalChars}]`;
      text += '\n---\n' + r.text;
      return text;
    }

    case 'get_thinking':
    case 'get_assistant_text': {
      const part = name === 'get_thinking' ? 'thinking' : 'text';
      const { sessionId, cwd, turnIndex, block, start, end } = args;
      const r = await httpGet('/overseer/session/' + sessionId + '/turn/' + turnIndex + '/' + part + qs({
        cwd, block, start, end,
      }), cwd);
      const live = await liveLifecycleForSession(sessionId, cwd);
      if (r.blockIndex != null) {
        let text = live;
        text += `Turn ${turnIndex} ${part} block ${r.blockIndex} — ${r.totalChars} chars`;
        if (start != null || end != null) text += ` | range [${start ?? 0}..${end ?? r.totalChars}]`;
        text += '\n---\n' + r.text;
        return text;
      }
      // No specific block — return preview map
      let text = live;
      text += `Turn ${turnIndex} has ${r.blockCount} ${part} block(s):\n`;
      for (const b of (r.blocks || [])) {
        text += `\n[block ${b.idx}] ${b.chars} chars\n  preview: ${JSON.stringify(b.preview.slice(0, 200))}\n`;
      }
      if (r.joinedText !== undefined) {
        text += `\nJoined text (${r.joinedTotalChars} chars), requested range:\n---\n${r.joinedText}\n`;
      } else {
        text += `\nJoined size: ${r.joinedTotalChars} chars. Call with block=N or start/end to fetch.\n`;
      }
      return text;
    }

    case 'fork_session': {
      const { sessionId, cwd } = args;
      const r = await httpPost('/overseer/fork', { sessionId, cwd }, cwd);
      if (!r.success) return 'Fork failed: ' + (r.error || 'unknown');
      return `Forked ${sessionId} → ${r.newSessionId}\n` +
        `New file ready (forkEntryCount: ${r.forkEntryCount}).\n` +
        `Open this sessionId in a new tab to inspect/continue the fork.`;
    }

    case 'propose_edit': {
      const { sessionId, cwd, startUuid, endUuid, mode } = args;
      const r = await httpPost('/overseer/propose-edit', { sessionId, cwd, startUuid, endUuid, mode }, cwd);
      const p = r.plan;
      let text = `Dry-run plan: ${p.mode.toUpperCase()} ${p.removedCount} records on session ${p.sessionId.slice(0,8)}…\n`;
      text += `  range in branch: idx ${p.rangeStart} → ${p.rangeEnd} (actualEnd ${p.actualEnd}, branch len ${p.branchLength})\n`;
      text += `  removes: ${p.removedUsers} user, ${p.removedAssistants} assistant, ${p.removedOther} other\n`;
      text += `  chars saved: user ${p.removedUserChars}, assistant ${p.removedAssistantChars} (≈ ${Math.round((p.removedUserChars + p.removedAssistantChars) / 4)} tokens)\n`;
      text += `  first removed (${p.firstRemovedType}): ${JSON.stringify((p.firstRemovedPreview || '').slice(0, 160))}\n`;
      text += `  last removed: ${p.lastRemovedType} (uuid ${p.lastRemovedUuid?.slice(0,8)})\n`;
      text += `  entryBefore: ${p.entryBeforeUuid ? p.entryBeforeType + ' ' + p.entryBeforeUuid.slice(0,8) : 'NONE (range starts at branch head)'}\n`;
      text += `  entryAfter:  ${p.entryAfterUuid  ? p.entryAfterType  + ' ' + p.entryAfterUuid.slice(0,8)  : 'NONE (range ends at branch tip — this is effectively a REWIND)'}\n`;
      if (p.nearTip) text += `  ⚠ nearTip: actualEnd is within 3 records of the branch tip. Apply with caution.\n`;
      text += `\nTo execute: call apply_edit with same args + (mode=compact requires compactText). Default autoFork=true.\n`;
      return text;
    }

    case 'apply_edit': {
      const { sessionId, cwd, startUuid, endUuid, mode, compactText, autoFork } = args;
      const payload = {
        sessionId, cwd, startUuid, endUuid, mode, compactText,
        autoFork: autoFork === undefined ? true : !!autoFork,
      };
      const r = await httpPost('/overseer/apply-edit', payload, cwd);
      const er = r.editResult || {};
      let text = `${r.mode.toUpperCase()} applied on session ${r.workingSessionId.slice(0,8)}…\n`;
      if (r.wasForked) {
        text += `  (auto-fork: source ${r.sourceSessionId.slice(0,8)} → working ${r.workingSessionId.slice(0,8)})\n`;
      }
      if (!er.success) {
        text += `  ✗ FAILED: ${er.error}\n`;
        return text;
      }
      text += `  ✓ removed ${er.removedCount} records (${er.removedUsers} user, ${er.removedAssistants} assistant)\n`;
      if (er.compactUuid) text += `  compact entry uuid: ${er.compactUuid}\n`;
      if (er.fileDeleted) text += `  ⚠ file was deleted (no records remain).\n`;
      text += `\nFor follow-up edits on this fork, use sessionId=${r.workingSessionId} with autoFork=false.\n`;
      text += `Tell user the new sessionId so they can open it in a tab.`;
      return text;
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return jsonRpcResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'noted-terminal-overseer', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return jsonRpcResponse(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await callTool(name, args || {});
      return jsonRpcResponse(id, { content: [{ type: 'text', text: result }] });
    } catch (err) {
      return jsonRpcResponse(id, {
        content: [{ type: 'text', text: 'Error: ' + err.message }],
        isError: true,
      });
    }
  }

  return jsonRpcError(id, -32601, 'Method not found: ' + method);
}

const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
  buffer += line;
  try {
    const msg = JSON.parse(buffer);
    buffer = '';
    const response = await handleRequest(msg);
    if (response) process.stdout.write(response + '\n');
  } catch {
    // Incomplete JSON — accumulate
  }
});

process.stderr.write('[overseer-server] MCP server started\n');
