import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore } from '../../../store/useUIStore';
import {
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  useMessage,
  useComposer,
  useComposerRuntime,
  useAuiState,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { AssistantProviderBase, MessageByIndexProvider } from '@assistant-ui/core/react';
import { Virtuoso, type VirtuosoHandle, type VirtuosoProps } from 'react-virtuoso';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Loader2, FileEdit, Terminal as TerminalIcon, FolderSearch, Search, FileText, Globe, RefreshCw, Pencil, Check, X as XIcon, Brain, ChevronRight } from 'lucide-react';
import Tooltip from '../../UI/Tooltip';
import { consumePrefetched } from '../../../utils/sdkHistoryPrefetch';

const { ipcRenderer } = window.require('electron');

// ============================================================
// Internal message type — accumulated from IPC stream
// ============================================================
// Why both `parts[]` and the legacy {text, toolCalls, thinking} fields exist:
// `parts[]` is the ordered source of truth for assistant rendering (preserves
// the exact thinking/text/tool_use sequence Claude emits — without it tools
// always sink below text and Claude's "thinking → call → reflect → call →
// reply" rhythm is destroyed). The flat fields are *derived* and live only so
// the rest of the file (search/filter/findIndex/cancel-empty-detect) keeps
// working without touching every callsite. Build via `assembleMessageFields`.
type ToolCallPart = {
  type: 'tool';
  id: string;
  name: string;
  args: Record<string, any>;
  result?: any;
  status: 'running' | 'done' | 'error';
};
type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | ToolCallPart;
interface SDKChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'compact-summary';
  parts?: AssistantPart[];
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, any>; result?: any; status: 'running' | 'done' | 'error' }>;
  thinking: string | null;
  timestamp: number;
  // Set on compact-summary entries: метаданные сжатия с compact_boundary
  // (pre/post tokens + duration). Прикрепляются в loadHistory когда
  // compact_boundary запись встречается прямо перед summary в JSONL chain.
  compactMetrics?: { preTokens: number; postTokens: number; durationMs: number; trigger?: string };
}

// Derive flat fields from ordered parts. Mirrors the old paths so legacy
// readers (filter empty assistant, smart cancel hasContent, search snippets)
// don't need to know about `parts`.
function assembleMessageFields(parts: AssistantPart[]): { text: string; thinking: string | null; toolCalls: SDKChatMessage['toolCalls'] } {
  const textPieces: string[] = [];
  const thinkingPieces: string[] = [];
  const toolCalls: SDKChatMessage['toolCalls'] = [];
  for (const p of parts) {
    if (p.type === 'text') textPieces.push(p.text);
    else if (p.type === 'thinking') thinkingPieces.push(p.text);
    else if (p.type === 'tool') toolCalls.push({ id: p.id, name: p.name, args: p.args, result: p.result, status: p.status });
  }
  return {
    text: textPieces.join('\n'),
    thinking: thinkingPieces.length ? thinkingPieces.join('\n') : null,
    toolCalls,
  };
}

// Extract textual content from a tool_result block (string OR [{type:'text',text:...}])
function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

// ============================================================
// Convert our internal messages to assistant-ui ThreadMessageLike
// ============================================================
function convertMessage(msg: SDKChatMessage): ThreadMessageLike {
  if (msg.role === 'system') {
    return { role: 'system' as const, content: [{ type: 'text' as const, text: msg.text }], id: msg.id, createdAt: new Date(msg.timestamp) };
  }

  // Compact-summary edits: prefix id so the renderer (AssistantMsg) can
  // dispatch to CompactSummaryMsg instead of the normal assistant layout.
  // assistant-ui doesn't allow custom roles, so we ride on role=assistant
  // and discriminate downstream by id prefix.
  if (msg.role === 'compact-summary') {
    const cid = msg.id.startsWith('compact-summary-') ? msg.id : 'compact-summary-' + msg.id;
    if (msg.compactMetrics) setCompactMetricsForMsg(cid, msg.compactMetrics);
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: msg.text }],
      id: cid,
      createdAt: new Date(msg.timestamp),
    };
  }

  if (msg.role === 'user') {
    return { role: 'user' as const, content: [{ type: 'text' as const, text: msg.text }], id: msg.id, createdAt: new Date(msg.timestamp) };
  }

  // Assistant message — preserve the exact block order Claude emitted so
  // tool calls land *between* the text/thinking they belong to, not at the
  // tail. Source of truth is `msg.parts[]`; if absent (legacy code path /
  // pre-refactor placeholder) fall back to the flat fields in canonical
  // order (thinking → text → tools).
  const aui: ThreadMessageLike['content'] = [];

  if (msg.parts && msg.parts.length > 0) {
    for (const p of msg.parts) {
      if (p.type === 'thinking') {
        if (p.text) aui.push({ type: 'reasoning' as const, text: p.text });
      } else if (p.type === 'text') {
        if (p.text) aui.push({ type: 'text' as const, text: p.text });
      } else if (p.type === 'tool') {
        aui.push({
          type: 'tool-call' as const,
          toolName: p.name,
          toolCallId: p.id,
          args: p.args,
          // result must be defined for "done"/"error" so ToolCallPart can distinguish from "running".
          result: p.status === 'running' ? undefined : (p.result ?? ''),
          isError: p.status === 'error',
        });
      }
    }
  } else {
    if (msg.thinking) aui.push({ type: 'reasoning' as const, text: msg.thinking });
    if (msg.text) aui.push({ type: 'text' as const, text: msg.text });
    for (const tc of msg.toolCalls) {
      aui.push({
        type: 'tool-call' as const,
        toolName: tc.name,
        toolCallId: tc.id,
        args: tc.args,
        result: tc.status === 'running' ? undefined : (tc.result ?? ''),
        isError: tc.status === 'error',
      });
    }
  }

  if (aui.length === 0) {
    aui.push({ type: 'text' as const, text: '' });
  }

  return {
    role: 'assistant' as const,
    content: aui,
    id: msg.id,
    createdAt: new Date(msg.timestamp),
    status: msg.toolCalls.some(t => t.status === 'running')
      ? { type: 'running' as const }
      : { type: 'complete' as const, reason: 'stop' as const },
  };
}

// ============================================================
// SDK model alias → real Anthropic model id.
//
// `default` (undefined) lets SDK pick whatever Anthropic ships as the current
// stable default — that survives Anthropic-side rotation without code changes.
// Named aliases must point at IDs Anthropic actually serves; stale IDs surface
// as runtime 404 from the API (no client-side preflight today). Update this
// table when Anthropic ships a new generation; nothing else in the codebase
// needs to change because every model-mapping lookup goes through here.
const SDK_MODEL_MAP: Record<string, string | undefined> = {
  default: undefined,
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  haiku: 'claude-haiku-4-5-20251001',
};
function resolveSdkModel(alias: string | undefined): string | undefined {
  return SDK_MODEL_MAP[alias || 'default'];
}
// Effort capability gating moved to InfoPanel — it loads
// `claude-sdk:get-model-caps` (SDK-shipped `supportedModels()`) once and
// renders unsupported pills disabled. The hard-coded table that used to live
// here is gone: source of truth is the SDK package, kept current by upgrades.

// True when the model id in the assistant SSE chunk doesn't match what the user picked.
// Anthropic silently re-routes (e.g. picking 'claude-opus-4-7' on a model that's been retired
// will fall back). We compare loose 'opus' / 'sonnet' / 'haiku' family slugs since exact id
// digits change between releases — the family change is what we care about UX-wise.
function detectModelFamilyMismatch(requestedAlias: string | undefined, actualModel: string | undefined): null | { requested: string; actual: string } {
  if (!actualModel || !requestedAlias || requestedAlias === 'default') return null;
  const actualLower = actualModel.toLowerCase();
  // Filter out non-model values like '<synthetic>' that proxies emit on errors.
  if (!actualLower.startsWith('claude-')) return null;
  const actualFamily = actualLower.includes('opus') ? 'opus'
    : actualLower.includes('sonnet') ? 'sonnet'
    : actualLower.includes('haiku') ? 'haiku'
    : null;
  if (!actualFamily) return null;
  if (actualFamily === requestedAlias) return null;
  return { requested: requestedAlias, actual: actualFamily };
}

// Human-friendly "Opus 4.7 (1M context)" label from the raw model id (or alias
// fallback when no real model yet seen). The "(1M context)" suffix is only
// appended when the model actually supports 1M (Opus 4.7 currently).
// Returns null when there's nothing meaningful to show (e.g. <synthetic>).
// SDK default = whatever Anthropic ships as 'default' for `query()` — at the
// moment of writing this is Opus 4.7. Used as fallback label when alias is
// 'default' (or undefined) AND no real model id is known yet (cold start).
const SDK_DEFAULT_MODEL_ID = 'claude-opus-4-7';

function formatModelLabel(realModel: string | null, alias: string | undefined): string | null {
  // Resolution priority:
  //   1. realModel (truth from SSE) — wins только если alias тоже = 'default'/undefined.
  //      Если юзер вручную переключил на конкретный alias — показываем alias-резолв,
  //      иначе footer лжёт ("Opus" пока юзер уже выбрал Sonnet, до первого ответа).
  //   2. resolveSdkModel(alias) — id из map (sonnet → claude-sonnet-4-6, etc.)
  //   3. SDK_DEFAULT_MODEL_ID — для 'default' alias или undefined.
  const aliasResolved = resolveSdkModel(alias);
  const useAliasFirst = !aliasResolved ? false : (alias && alias !== 'default');
  const src = (useAliasFirst ? aliasResolved : (realModel || aliasResolved || SDK_DEFAULT_MODEL_ID)).toLowerCase();
  if (!src || src.startsWith('<')) return null;
  const family = src.includes('opus') ? 'Opus' : src.includes('sonnet') ? 'Sonnet' : src.includes('haiku') ? 'Haiku' : null;
  if (!family) return realModel; // unknown — show raw
  // Pull version like "4-7" or "4.5" out of "claude-opus-4-7", "claude-opus-4-7-20251202", etc.
  const versionMatch = src.match(/-(\d+)[-.](\d+)(?:[-.]\d+)*(?:-\d{8})?$/);
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '';
  // Opus 4.7 supports 1M context; everything else is 200K (current shipping defaults).
  const is1M = family === 'Opus' && version === '4.7';
  const window = is1M ? ' (1M context)' : '';
  return `${family}${version ? ' ' + version : ''}${window}`;
}

// Approximate context window sizes (tokens) per model family. Used to compute
// the "N% used / left" pill — Anthropic doesn't ship this in the SDK so we
// hard-code well-known values. Off-by-2% is fine for the indicator's purpose.
function getModelContextWindow(realModel: string | null, alias: string | undefined): number {
  const src = (realModel || resolveSdkModel(alias) || alias || '').toLowerCase();
  if (src.includes('opus-4-7') || src.includes('opus-4.7')) return 1_000_000;
  if (src.includes('sonnet')) return 200_000;
  if (src.includes('haiku')) return 200_000;
  if (src.includes('opus')) return 200_000;
  return 200_000;
}

// ============================================================
// Tool icon mapping
// ============================================================
const TOOL_ICON: Record<string, React.ReactNode> = {
  Edit: <FileEdit size={12} />, Write: <FileEdit size={12} />, Read: <FileText size={12} />,
  Bash: <TerminalIcon size={12} />, Glob: <FolderSearch size={12} />, Grep: <Search size={12} />,
  WebSearch: <Globe size={12} />, WebFetch: <Globe size={12} />,
};

// ============================================================
// Tool rendering helpers — language detection + simple line diff
// ============================================================
// File extension → Prism language id. Only includes languages we know oneDark
// styles meaningfully; everything else falls back to plain text.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown', html: 'html', css: 'css', scss: 'scss',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sql: 'sql', xml: 'xml', graphql: 'graphql', gql: 'graphql',
};
function detectLanguage(filePath: string | undefined): string {
  if (!filePath) return 'text';
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'text';
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] || 'text';
}

// LCS-based line diff. Returns a flat sequence of {tag, line} entries where
// tag ∈ 'eq' | 'add' | 'del'. Good enough for the Edit-tool case where we
// typically diff two short strings (≤ a few hundred lines). Equal lines from
// the equal-region get collapsed to context outside the renderer; here we just
// emit the structural diff.
type DiffEntry = { tag: 'eq' | 'add' | 'del'; line: string };
function lineDiff(oldText: string, newText: string): DiffEntry[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;
  // LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffEntry[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ tag: 'eq', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ tag: 'del', line: a[i] }); i++; }
    else { out.push({ tag: 'add', line: b[j] }); j++; }
  }
  while (i < n) { out.push({ tag: 'del', line: a[i] }); i++; }
  while (j < m) { out.push({ tag: 'add', line: b[j] }); j++; }
  return out;
}

function countDiffStats(entries: DiffEntry[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const e of entries) {
    if (e.tag === 'add') added++;
    else if (e.tag === 'del') removed++;
  }
  return { added, removed };
}

// ============================================================
// Per-message actions (Edit / Repeat) — exposed via context so the assistant-ui
// MessagePrimitive can reach the parent component's truncate+resend pipeline
// without adding bespoke props at every primitive layer.
// ============================================================
interface UserMsgActions {
  // The displayed message id is whatever convertMessage assigned; for
  // already-persisted messages this matches the JSONL uuid (we set
  // m.id = m.uuid in loadHistory). For "streaming-…" / "user-…" placeholders
  // (the message just sent in this session) we don't have a real uuid yet,
  // so the action handlers map id→uuid via the messages list.
  onRepeat: (msgId: string) => void;
  onEdit: (msgId: string, newText: string) => void;
  // True while a repeat/edit is mid-flight; both buttons get disabled to avoid
  // double-truncates and racing IPC calls.
  busy: boolean;
}
const UserMsgActionsContext = React.createContext<UserMsgActions | null>(null);

// ============================================================
// Props
// ============================================================
interface ClaudeSDKTabProps {
  tabId: string;
  active: boolean;
  isActiveProject?: boolean;
  cwd: string;
}

// ============================================================
// Main component
// ============================================================
function ClaudeSDKTab({ tabId, active, isActiveProject = true, cwd }: ClaudeSDKTabProps) {
  const [messages, setMessages] = useState<SDKChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Cold-start loader. Flips to true on first Virtuoso paint (heavy tabs ≥1s)
  // or immediately for empty history. Reset on sessionId change.
  const [chatReady, setChatReady] = useState(false);

  // Slash-command overlay — открывается на отправку local-info-команды
  // (/usage, /cost, /status, /context, /insights). Поведение как в Claude
  // Code CLI: композер прячется, на его месте — панель ~500px высотой с
  // полным content'ом, юзер скроллит внутри, закрывает Esc/Ctrl+C/Ctrl+[.
  // В thread остаётся только slash-bubble (`/usage`) — output НЕ
  // сохраняется. Сам контент берётся из SDK control-API (real-time
  // `getContextUsage()`, `initializationResult()` + cumulative cost).
  const [slashOverlay, setSlashOverlay] = useState<null | { cmd: string }>(null);
  // Cumulative cost in $ — растёт с каждого `result` события у SDK iterator'а.
  // CLI шипит то же самое в /usage поле `Total cost: $X.XX`.
  const cumCostRef = useRef<{ totalUSD: number; durationMs: number; numTurns: number }>({ totalUSD: 0, durationMs: 0, numTurns: 0 });
  // Active slash-command guard. Set by onNew when user submits a info-type
  // slash (/usage, /cost, /status, /context, /insights). The very next
  // assistant message that arrives in this same turn is the command's
  // output — we capture it into the overlay state, NOT into the thread.
  // Cleared on `result` event regardless of outcome.
  const activeSlashCmdRef = useRef<string | null>(null);
  // Live compaction: holds metrics from compact_boundary event until the
  // following compact-summary user-record arrives. JSONL/stream order
  // guarantees boundary → summary adjacency.
  const pendingCompactMetricsRef = useRef<SDKChatMessage['compactMetrics'] | null>(null);
  // Output captured for the active slash command — drives the overlay's
  // content. String for now (raw text from SDK); future shaped data could
  // be parsed per-command.
  const [slashOutput, setSlashOutput] = useState<string>('');
  // Tracks whether the LAST run was killed by an explicit user Stop (sidebar chip,
  // tab-bar dot, ctx menu, in-composer Cancel). Differentiates "manually stopped,
  // show Resume affordance" from "naturally finished, normal composer". Cleared
  // when the user resumes (clicks Resume) or sends the next message.
  const [wasStopped, setWasStopped] = useState(false);
  // Context-window usage from the last assistant message. Claude API reports
  // total input as `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  // — we keep the raw total here and compute the percentage at render time
  // (cheaper than recomputing the model's window on every paint).
  const [lastContextUsedTokens, setLastContextUsedTokens] = useState<number | null>(null);
  // Real model that produced the last assistant chunk. Server sometimes returns
  // a different model than the requested alias (Anthropic silent downgrade);
  // we display whatever it actually used so the footer doesn't lie.
  const [lastResolvedModel, setLastResolvedModel] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Last request snapshot — used by handleMessage to compare requested vs actual
  // model in the first assistant chunk (Anthropic silently downgrades when a
  // model is retired or unavailable for the requested effort tier).
  // modelMismatchToastedRef prevents spamming the toast for every assistant chunk
  // of the same turn (one toast per send, reset on next onNew).
  const lastRequestRef = useRef<{ modelAlias?: string; effort?: string }>({});
  const modelMismatchToastedRef = useRef(false);
  const updateSDKState = useWorkspaceStore((s) => s.updateSDKState);

  // DEBUG: mount/render tracking
  useEffect(() => {
    console.warn('[ClaudeSDKTab:MOUNT] tabId=' + tabId + ' active=' + active + ' cwd=' + cwd);
    return () => console.warn('[ClaudeSDKTab:UNMOUNT] tabId=' + tabId);
  }, []);
  console.warn('[ClaudeSDKTab:RENDER] tabId=' + tabId + ' msgs=' + messages.length + ' sessionId=' + sessionIdRef.current + ' visible=' + (active && isActiveProject));

  // Load history from JSONL via SDK getSessionMessages
  const loadHistory = useCallback(async (sid: string) => {
    const tLoad0 = Date.now();
    const sidShort = sid.slice(0, 8);
    console.warn('[SDKHistory:Client] sid=' + sidShort + ' tabId=' + tabId.slice(-12) + ' START');
    const state = useWorkspaceStore.getState();
    let tabCwd = cwd;
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) { tabCwd = t.cwd || cwd; break; }
    }

    // Prefetch cache: when restoreSession pre-fetched the history (single-shot,
    // first mount after app start), skip the IPC entirely. Cache is keyed by
    // (tabId, sessionId) and self-deletes on read, so reload/fork/rotation
    // all fall through to the live IPC path below.
    let rawMessages: any[] | null = null;
    const cached = consumePrefetched(tabId, sid);
    if (cached) {
      rawMessages = cached;
      console.warn('[SDKHistory:Client] sid=' + sidShort + ' CACHE_HIT count=' + cached.length);
    } else {
      // Use our own JSONL parser (active-branch-messages) instead of Anthropic
      // SDK's getSessionMessages — the latter returns success=true with empty
      // messages for sessions whose internal index it doesn't recognise (e.g.
      // freshly-rotated sessionIds, sessions written by other Claude versions).
      // Mobile already uses this path; desktop now matches. Same backtrace
      // semantics as Timeline → uuids align → GoTo from Timeline anchors work.
      // See knowledge/fix-mobile-history-uuid-mismatch.md.
      const tIpc0 = Date.now();
      const result = await ipcRenderer.invoke('claude-sdk:active-branch-messages', { sessionId: sid, cwd: tabCwd });
      const ipcMs = Date.now() - tIpc0;
      console.warn('[SDKHistory:Client] sid=' + sidShort + ' ipcMs=' + ipcMs + ' success=' + result.success + ' rawCount=' + (result.messages?.length || 0));
      if (!result.success || !result.messages?.length) { setChatReady(true); return; }
      rawMessages = result.messages;
    }
    if (!rawMessages || !rawMessages.length) { setChatReady(true); return; }
    // Shim — the rest of the function expects `result.messages`; keep the
    // same variable in scope for the smallest possible diff.
    const result: { messages: any[] } = { messages: rawMessages };
    const tPostProcess0 = Date.now();

    // PASS 1: collect tool_result blocks from user-type entries (Claude JSONL models
    // tool results as type:'user' messages with content:[{type:'tool_result', tool_use_id, content}]).
    // Build map tool_use_id → { result, isError } so we can pair them with tool_use entries in pass 2.
    const toolResults = new Map<string, { result: string; isError: boolean }>();
    for (const m of result.messages) {
      if (m.type !== 'user' || !Array.isArray(m.message?.content)) continue;
      for (const block of m.message.content) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, {
            result: extractToolResultText(block.content),
            isError: !!block.is_error,
          });
        }
      }
    }

    // Pending metrics from a compact_boundary record, waiting to attach to
    // the next compact-summary entry. JSONL ordering guarantees boundary →
    // summary adjacency.
    let pendingCompactMetrics: SDKChatMessage['compactMetrics'] | null = null;
    const loaded: SDKChatMessage[] = result.messages.map((m: any, i: number) => {
      // Build ordered parts[] for assistant messages — preserving the exact
      // block sequence Claude emitted (thinking → tool → tool → thinking → text
      // etc.). Each JSONL record contributes its own ordered slice; cross-record
      // merging happens later (assistant turns split across multiple records).
      const contentArr = Array.isArray(m.message?.content) ? m.message.content : null;
      const parts: AssistantPart[] = [];
      if (contentArr) {
        for (const b of contentArr) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            parts.push({ type: 'text', text: b.text });
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            parts.push({ type: 'thinking', text: b.thinking });
          } else if (b.type === 'tool_use') {
            const tid = b.id || 'tool-' + i;
            const tr = toolResults.get(tid);
            parts.push({
              type: 'tool',
              id: tid,
              name: b.name || 'unknown',
              args: typeof b.input === 'object' ? b.input : {},
              result: tr ? tr.result : undefined,
              status: tr ? (tr.isError ? 'error' : 'done') : 'done',
            });
          }
          // tool_result blocks are pulled into toolResults map in PASS 1 — no
          // need to surface them as renderable parts.
        }
      } else if (typeof m.message?.content === 'string') {
        // Legacy string-shape message (rare for assistant; common for plain user).
        parts.push({ type: 'text', text: m.message.content });
      }

      const derived = assembleMessageFields(parts);

      // Classify system commands as 'system' role.
      let role = m.type as 'user' | 'assistant' | 'system' | 'compact-summary';
      let text = derived.text;

      // Compact boundary — stash metrics, render NOTHING by itself. Метрики
      // прикрепятся к следующему compact-summary user-сообщению.
      if (m.type === 'system' && m.subtype === 'compact_boundary') {
        const cm = m.compactMetadata || m.compact_metadata;
        if (cm) {
          pendingCompactMetrics = {
            preTokens: cm.preTokens ?? cm.pre_tokens ?? 0,
            postTokens: cm.postTokens ?? cm.post_tokens ?? 0,
            durationMs: cm.durationMs ?? cm.duration_ms ?? 0,
            trigger: cm.trigger,
          };
        }
        return null;
      }
      // Skip all other system messages (init, status, etc. — internal protocol).
      if (m.type === 'system') return null;

      if (role === 'user') {
        // Compact summary detection — SDK ставит флаг `isCompactSummary:true`
        // (authoritative). На случай старых сессий fallback на canonical
        // phrase. NB: исходный SDK ID `isReplay/isSynthetic` тут НЕ
        // выставляется — есть только `isVisibleInTranscriptOnly` и
        // `isCompactSummary`. Content приходит string'ом, derived.text
        // его захватывает через parts string-branch.
        const trimmedEarly = text.trim();
        const isSummaryRecord = m.isCompactSummary === true
          || trimmedEarly.startsWith('This session is being continued from a previous conversation');
        if (isSummaryRecord) {
          const metrics = pendingCompactMetrics;
          pendingCompactMetrics = null;
          const finalText = trimmedEarly || (typeof m.message?.content === 'string' ? m.message.content.trim() : '');
          return {
            id: m.uuid || ('hist-' + i),
            role: 'compact-summary' as const,
            text: finalText,
            toolCalls: [],
            thinking: null,
            timestamp: Date.now() - (result.messages.length - i) * 1000,
            compactMetrics: metrics || undefined,
          };
        }
        // Replay/synthetic / transcript-only records — служебный мусор, дропаем.
        if (m.isReplay || m.isSynthetic || m.isVisibleInTranscriptOnly) return null;

        // tool_result entries don't have text content (only tool_result blocks) — drop them
        // (their data has already been paired into toolCalls.result above).
        const hasToolResultBlock = contentArr && contentArr.some((b: any) => b?.type === 'tool_result');
        if (hasToolResultBlock && !text.trim()) return null;

        const trimmed = text.trim();
        // Slash commands: /effort, /model, etc. Render as USER bubble (left,
        // not centered) — юзер ввёл команду, это его действие. Дим opacity
        // помечает что это служебка, не обычный prompt. Раньше превращали в
        // role:'system' → SystemMsg центрировал — выглядело как заголовок,
        // а не как сообщение от юзера.
        if (trimmed.startsWith('<command-name>')) {
          const cmdMatch = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
          const argsMatch = trimmed.match(/<command-args>([^<]*)/);
          // CLI sometimes writes the name with leading slash ("/usage"),
          // sometimes without ("usage"). Strip leading slashes so we don't
          // get "//usage" after re-adding ours.
          const rawName = (cmdMatch?.[1] || '').trim().replace(/^\/+/, '');
          const cmdArgs = (argsMatch?.[1] || '').trim();
          text = '/' + rawName + (cmdArgs ? ' ' + cmdArgs : '');
          // role остаётся 'user' — отрендерим в UserMsg ниже с visual hint.
        }
        // Command stdout responses. CLI wraps a slash command's stdout in
        // <local-command-stdout>…</local-command-stdout>. Drop entirely —
        // long outputs (e.g. /usage subscription text) are already rendered
        // through the SlashCommandOverlay or assistant-message path; the
        // raw wrapper duplicates them as a user-bubble. Short markers like
        // "Compacted" / "Settings dialog dismissed" are CLI artefacts, not
        // useful in SDK chat.
        else if (trimmed.startsWith('<local-command-stdout>')) {
          return null;
        }
        // Tool results (internal)
        else if (trimmed === '[tool_result]' || trimmed.startsWith('<tool_result>')) {
          return null; // Filter out
        }
        // System reminders / local-command-caveats — both are CLI/SDK-injected
        // context wrappers, never user text.
        else if (trimmed.startsWith('<system-reminder>') || trimmed.startsWith('<local-command-caveat>')) {
          return null;
        }
        // (Note: canonical summary detection moved above — see compact-summary branch.)
      }

      // For non-assistant roles `parts` is unused by the renderer (user/system
      // go through their own convertMessage branches). We omit it to keep the
      // payload small.
      const out: SDKChatMessage = {
        id: m.uuid || ('hist-' + i),
        role,
        text: role === 'assistant' ? derived.text : text,
        toolCalls: role === 'assistant' ? derived.toolCalls : [],
        thinking: role === 'assistant' ? derived.thinking : null,
        timestamp: Date.now() - (result.messages.length - i) * 1000,
      };
      if (role === 'assistant') out.parts = parts;
      return out;
    }).filter((m: SDKChatMessage | null): m is SDKChatMessage => {
      if (!m) return false;
      if (m.role === 'user' && !m.text.trim()) return false;
      return true;
    });

    // Merge consecutive assistant messages into single turns.
    // Claude JSONL splits one "turn" across multiple records (one block per
    // record). Concatenate `parts[]` in order so the merged message holds the
    // full thinking/tool/text sequence as it actually streamed.
    const merged: SDKChatMessage[] = [];
    for (const m of loaded) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === 'assistant' && m.role === 'assistant') {
        const combined = [...(prev.parts || []), ...(m.parts || [])];
        const d = assembleMessageFields(combined);
        prev.parts = combined;
        prev.text = d.text;
        prev.thinking = d.thinking;
        prev.toolCalls = d.toolCalls;
      } else {
        merged.push({ ...m });
      }
    }

    // Final filter: remove empty assistant messages after merge
    const final = merged.filter(m => {
      if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
      return true;
    });

    // Swap compact-summary ⇄ following /compact slash chip. In JSONL the
    // SDK writes the boundary+summary BEFORE the `<command-name>/compact</…>`
    // record (the chip appears in the new session's prologue, after summary).
    // Visually this reads wrong: «вот summary, теперь юзер ввёл /compact».
    // Юзер ввёл /compact PERED тем как SDK его выполнил → chip должен быть
    // СЛЕВА (выше) от bubble summary. Делаем точечный swap: для каждого
    // compact-summary смотрим следующий элемент — если он user-message
    // содержащий "/compact" — меняем местами.
    for (let i = 0; i < final.length - 1; i++) {
      const a = final[i];
      const b = final[i + 1];
      if (a.role === 'compact-summary' && b.role === 'user' && b.text.trim().startsWith('/compact')) {
        final[i] = b;
        final[i + 1] = a;
      }
    }

    // Diagnostic: count tool calls across all messages
    const totalTools = final.reduce((sum, m) => sum + m.toolCalls.length, 0);
    const toolNames = final.flatMap(m => m.toolCalls.map(t => t.name));
    const uniqueTools = [...new Set(toolNames)];
    const postMs = Date.now() - tPostProcess0;
    const totalMs = Date.now() - tLoad0;
    console.warn('[SDKHistory:Client] sid=' + sidShort + ' loaded=' + loaded.length + ' merged=' + merged.length + ' final=' + final.length + ' totalTools=' + totalTools + ' postMs=' + postMs + ' totalMs=' + totalMs);

    const tSetState0 = Date.now();
    setMessages(final);
    // setState is sync at scheduling, but React reconciliation comes later — log when scheduled
    console.warn('[SDKHistory:Client] sid=' + sidShort + ' setMessages scheduled msgCount=' + final.length + ' scheduleMs=' + (Date.now() - tSetState0));
  }, [tabId, cwd]);

  // Watch store for claudeSessionId changes — handles both mount and late assignment (SDK-Fork)
  const storeSessionId = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.claudeSessionId || null;
    }
    return null;
  });

  useEffect(() => {
    if (!storeSessionId || sessionIdRef.current === storeSessionId) return;
    console.warn('[ClaudeSDKTab:SessionSync] tabId=' + tabId + ' new sessionId=' + storeSessionId);
    sessionIdRef.current = storeSessionId;
    setSessionId(storeSessionId);
    setChatReady(false);
    loadHistory(storeSessionId);
  }, [tabId, storeSessionId, loadHistory]);

  // Reload handler — triggered from InfoPanel ⟳ button
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail;
      if (tid !== tabId) return;
      const sid = sessionIdRef.current;
      if (sid) {
        setMessages([]);
        setIsRunning(false);
        setChatReady(false);
        loadHistory(sid);
      }
    };
    window.addEventListener('claude-sdk:reload', handler);
    return () => window.removeEventListener('claude-sdk:reload', handler);
  }, [tabId, loadHistory]);

  // Listen for external Stop signals (TabBar dot/ctx menu, InfoPanel chip).
  // The Stop callsites already invoke claude-sdk:stop; this event is purely a
  // UI hint so the composer can render the "Resume" affordance.
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail;
      if (tid !== tabId) return;
      setWasStopped(true);
    };
    window.addEventListener('claude-sdk:was-stopped', handler);
    return () => window.removeEventListener('claude-sdk:was-stopped', handler);
  }, [tabId]);

  // Focus the composer input when SessionActionChip's "Continue" is clicked
  // for an SDK tab — there's no PTY to bring forward, so the meaningful action
  // is "let me type the next message". Walks via data-msg-role's nearest
  // tab-root container; we can't reach assistant-ui's internal Composer.Input
  // via ref without a wrapper. Defer to next frame so any pending visibility
  // toggle (display:none → flex) lands first.
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail;
      if (tid !== tabId) return;
      requestAnimationFrame(() => {
        // Scope the textarea search by walking up from a known marker in this
        // component's tree. Falls back to document-level if structure changes.
        const anyMsg = document.querySelector(`[data-msg-role]`) as HTMLElement | null;
        const tabRoot = anyMsg?.closest('.absolute.inset-0') as HTMLElement | null;
        const textarea = (tabRoot ?? document).querySelector('textarea') as HTMLTextAreaElement | null;
        textarea?.focus();
      });
    };
    window.addEventListener('claude-sdk:focus-composer', handler);
    return () => window.removeEventListener('claude-sdk:focus-composer', handler);
  }, [tabId]);

  // External prompt (mobile-web sent a message via REST). The local composer's
  // onNew was never invoked, so the desktop UI never pushed a user-bubble. Mirror
  // it here so both clients show the same conversation. The actual SDK call is
  // already on its way from main; this is purely UI state.
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid, text, source } = (e as CustomEvent).detail || {};
      if (tid !== tabId) return;
      if (!text) return;
      setIsRunning(true);
      setWasStopped(false);
      updateSDKState(tabId, { sdkState: 'fetching' });
      setMessages(prev => [...prev, {
        id: 'user-ext-' + Date.now(),
        role: 'user' as const,
        text,
        toolCalls: [],
        thinking: null,
        timestamp: Date.now(),
        source: source || 'web',
      } as any]);
    };
    window.addEventListener('claude-sdk:external-prompt', handler);
    return () => window.removeEventListener('claude-sdk:external-prompt', handler);
  }, [tabId, updateSDKState]);

  // Emit busy state for TabBar spinner + cleanup on unmount
  useEffect(() => {
    ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: isRunning });
    return () => { ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: false }); };
  }, [isRunning, tabId]);

  // ---- Timeline click → scroll to matching message ----
  // Under virtualization most messages are NOT in the DOM at any given time.
  // We search messages by content snippet → scroll Virtuoso to that index,
  // then on next frame run a DOM querySelectorAll to add the highlight outline
  // (target is mounted by then). Works against a 5000-message list instead of
  // just the ~30 visible ones.
  // messagesRef avoids depending on messages in the effect's dep array (which
  // would re-bind the listener on every stream-update).
  const messagesRef = useRef<SDKChatMessage[]>([]);
  messagesRef.current = messages;
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid, content } = (e as CustomEvent).detail;
      if (tid !== tabId) return;
      const snippet = (content || '').slice(0, 40);
      if (!snippet) return;
      const msgs = messagesRef.current;
      const idx = msgs.findIndex(m => m.text?.includes(snippet));
      if (idx < 0 || !virtuosoRef.current) return;
      virtuosoRef.current.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = scrollContainerRef.current;
        if (!root) return;
        const els = root.querySelectorAll('[data-msg-role]');
        for (const el of els) {
          if (el.textContent?.includes(snippet)) {
            (el as HTMLElement).style.outline = '1px solid rgba(218,119,86,0.4)';
            setTimeout(() => { (el as HTMLElement).style.outline = ''; }, 1500);
            return;
          }
        }
      }));
    };
    window.addEventListener('claude-sdk:scroll-to-entry', handler);
    return () => window.removeEventListener('claude-sdk:scroll-to-entry', handler);
  }, [tabId]);

  // ---- IPC listener: accumulate SDK messages ----
  useEffect(() => {
    const handleMessage = (_: any, data: { tabId: string; message: any; sessionId: string }) => {
      if (data.tabId !== tabId) return;

      // [SlashProbe] Mirror of main-side log: every message that hits the
      // renderer gets a one-liner with type/subtype/content shape. System
      // messages (especially local_command_output) get a full dump — they're
      // the ones SDK emits for /usage, /cost, /status, /help, /compact etc.
      try {
        const m = data.message;
        const summary = {
          type: m?.type,
          subtype: m?.subtype,
          is_error: m?.is_error,
          uuid: m?.uuid?.slice?.(0, 8),
          contentTypes: Array.isArray(m?.message?.content)
            ? m.message.content.map((b: any) => b?.type).join(',')
            : typeof m?.message?.content === 'string' ? 'string' : null,
          hasContent: typeof m?.content === 'string' ? `${m.content.length}ch` : null,
          allKeys: Object.keys(m || {}).join(','),
        };
        console.log('[SlashProbe:Renderer] tab=' + tabId.slice(-12) + ' msg=' + JSON.stringify(summary));
        if (m?.type === 'system') {
          console.log('[SlashProbe:Renderer] tab=' + tabId.slice(-12) + ' SYSTEM_FULL=' + JSON.stringify(m).slice(0, 1000));
        }
      } catch {}

      // ALWAYS adopt the latest sessionId — Claude SDK rotates session UUIDs
      // on session-loss / fresh-start (when our `resume` was rejected as stale,
      // or after `/compact`, or after the JSONL ages out). Old guard only
      // captured the first sessionId, so subsequent rotations stayed in store
      // as the dead UUID, every next prompt re-shipped the dead UUID as
      // resume, server marked stale, started fresh, captured a new UUID,
      // store ignored it → infinite loop of zero-context turns.
      if (data.sessionId && data.sessionId !== sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        setSessionId(data.sessionId);
        updateSDKState(tabId, { claudeSessionId: data.sessionId });
      }

      const msg = data.message;

      // Phase transition: system:init = SDK acknowledged the prompt, now
      // waiting for Claude's first chunk. Flip 'fetching' → 'thinking' here
      // — это первый детерминированный сигнал что network round-trip done.
      // Не флипаем если уже в более поздней фазе (typing / tool_use) —
      // init может прилететь после rotation, не должен сбрасывать loader.
      if (msg?.type === 'system' && msg?.subtype === 'init') {
        const cur = (() => {
          const s = useWorkspaceStore.getState();
          for (const [, ws] of s.openProjects) {
            const t = ws.tabs.get(tabId);
            if (t) return t.sdkState;
          }
          return undefined;
        })();
        if (cur === 'fetching') updateSDKState(tabId, { sdkState: 'thinking' });
      }

      // Capture slash-commands manifest from live session init. SDK ships
      // the full list (including session-specific skills + aliases) in
      // system:init event. Probe IPC's throw-away query misses some entries
      // (like /status) that depend on real session/account context. Shape
      // varies between SDK versions — может быть string[] либо object[];
      // нормализуем.
      if (msg?.type === 'system' && msg?.subtype === 'init' && Array.isArray(msg.slash_commands)) {
        const normalized: SlashCmd[] = msg.slash_commands.map((sc: any) => {
          if (typeof sc === 'string') return { name: sc, description: '' };
          return {
            name: sc.name || sc.command || String(sc),
            description: sc.description || sc.desc || '',
            argumentHint: sc.argumentHint || sc.argument_hint,
            aliases: sc.aliases,
          };
        });
        console.log('[SlashCmds] captured from init: tab=' + tabId.slice(-12) + ' count=' + normalized.length + ' names=' + normalized.map(c => '/' + c.name).join(','));
        setSlashCommandsForTab(tabId, normalized);
      }

      // Local slash-command output (subtype: 'local_command_output'). SDK
      // emits it for shipped commands like /usage, /cost, /status — content
      // is a plain string that CLI would render in Ink. For commands that
      // are wired to our SlashCommandOverlay (info-modals), output stays
      // OUT of the thread — оно показывается в overlay, и dies when overlay
      // closes (Esc). Это поведение Claude Code CLI: /usage не оставляет
      // длинный текст в скроллбеке.
      if (msg.type === 'system' && msg.subtype === 'local_command_output') {
        // No overlay rendering yet — for now we treat ALL local-command
        // output as "ephemeral": drop from thread, что бы юзер не видел
        // длинный текст для /usage / /cost / etc. Маркер /usage уже остался
        // как user-bubble, этого достаточно для пометки "команда выполнена".
        // ВРЕМЕННОЕ упрощение пока overlay рендерит точечно — после расширения
        // overlay'я переключим на whitelist (только info-команды дропаем,
        // прочие — рендерим как assistant text).
        return;
      }

      // Compact-loader handling. SDK sends two markers during /compact:
      //   1. {type:'system', subtype:'status', status:'compacting'}  ~ start
      //   2. {type:'system', subtype:'status', status:null, compact_result:'success'}  ~ end
      //   3. {type:'system', subtype:'compact_boundary', compact_metadata:{...}}  ~ summary
      // Between #1 and #2 the SDK is making an internal "summarise" API call
      // and emits NOTHING else for the full duration (~50s typical). Without
      // an in-thread placeholder the UI just shows the user's "/compact"
      // bubble and nothing happens for almost a minute. We inject a
      // streaming placeholder with a "compacting" flag so AssistantMsg can
      // swap in a progress label instead of the usual loader.
      if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.id === 'compact-' + tabId) return prev; // already showing
          return [...prev, {
            id: 'compact-' + tabId,
            role: 'system' as const,
            text: '⏳ Compacting conversation…',
            toolCalls: [],
            thinking: null,
            timestamp: Date.now(),
          }];
        });
        return; // don't run further branches
      }
      if (msg.type === 'system' && msg.subtype === 'status' && msg.compact_result) {
        // success / failure of compaction — drop the loader placeholder; the
        // compact_boundary record (next event) will provide the real metrics
        // bubble.
        setMessages(prev => prev.filter(m => m.id !== 'compact-' + tabId));
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        // JSONL uses camelCase (compactMetadata.preTokens), streaming SDK
        // events sometimes ship snake_case (compact_metadata.pre_tokens).
        // Support both shapes.
        const cm = msg.compactMetadata || msg.compact_metadata;
        if (cm) {
          pendingCompactMetricsRef.current = {
            preTokens: cm.preTokens ?? cm.pre_tokens ?? 0,
            postTokens: cm.postTokens ?? cm.post_tokens ?? 0,
            durationMs: cm.durationMs ?? cm.duration_ms ?? 0,
            trigger: cm.trigger,
          };
        }
        // Drop loader placeholder if still present.
        setMessages(prev => prev.filter(m => m.id !== 'compact-' + tabId));
        return;
      }
      // Compact-summary user-record arriving live. Authoritative marker is
      // `isCompactSummary:true` on the user-record (set by SDK). Fallback to
      // canonical phrase for older runs. Capture, attach pending metrics,
      // push as compact-summary role.
      if (msg.type === 'user' && (
        msg.isCompactSummary === true
        || (typeof msg.message?.content === 'string'
            && msg.message.content.startsWith('This session is being continued from a previous conversation'))
      )) {
        const contentText = typeof msg.message?.content === 'string' ? msg.message.content : '';
        const metrics = pendingCompactMetricsRef.current;
        pendingCompactMetricsRef.current = null;
        setMessages(prev => [...prev, {
          id: msg.uuid || ('compact-summary-' + Date.now()),
          role: 'compact-summary' as const,
          text: contentText,
          toolCalls: [],
          thinking: null,
          timestamp: Date.now(),
          compactMetrics: metrics || undefined,
        }]);
        return;
      }

      // Assistant message with content blocks
      if (msg.type === 'assistant' && msg.message?.content) {
        // Info-slash command active → capture text-only content into overlay
        // state and DO NOT add to thread. SDK ships /usage / /cost / /status
        // results as plain assistant-text (LocalCommandCall text fallback).
        if (activeSlashCmdRef.current && Array.isArray(msg.message.content)) {
          const textOnly = msg.message.content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
          if (textOnly) {
            setSlashOutput(prev => prev + (prev ? '\n' : '') + textOnly);
            return; // swallow message — НЕ добавляем в thread.
          }
        }

        // Silent-downgrade detector: Anthropic may swap the actual model out from under
        // a request (retired model, capacity, etc.). msg.message.model is the truth from
        // SSE; lastRequestRef holds what the user picked. One toast per turn.
        if (!modelMismatchToastedRef.current) {
          const mismatch = detectModelFamilyMismatch(lastRequestRef.current.modelAlias, msg.message?.model);
          if (mismatch) {
            useUIStore.getState().showToast(
              `Запрос был на ${mismatch.requested}, API ответил моделью ${mismatch.actual} (${msg.message.model}).`,
              'warning', 6000,
            );
            modelMismatchToastedRef.current = true;
          }
        }
        // Track real model + total input tokens for the composer footer.
        // Full context size = input_tokens + cache_read + cache_creation.
        if (msg.message?.model) setLastResolvedModel(msg.message.model);
        if (msg.message?.usage) {
          const u = msg.message.usage;
          const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (total > 0) setLastContextUsedTokens(total);
        }
        // Build new parts in the order Claude emitted them (inside this chunk).
        // Each chunk may contain any mix of thinking/text/tool_use blocks; we
        // walk them once and append to the streaming message's `parts[]` so the
        // rendered ordering matches what the model actually said.
        const newParts: AssistantPart[] = [];
        let chunkHasText = false;
        let chunkHasToolUse = false;
        for (const b of msg.message.content) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string') {
            newParts.push({ type: 'text', text: b.text });
            if (b.text.length > 0) chunkHasText = true;
          } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
            newParts.push({ type: 'thinking', text: b.thinking });
          } else if (b.type === 'tool_use') {
            newParts.push({
              type: 'tool',
              id: b.id,
              name: b.name,
              args: typeof b.input === 'object' ? b.input : {},
              status: 'running',
            });
            chunkHasToolUse = true;
          }
        }
        // Phase transition based on chunk shape (priority: tool > text > thinking):
        //   tool_use → 'tool_use'  (Claude вызвал tool, ждём result)
        //   text     → 'typing'    (контент потёк в bubble, loader исчезает)
        //   only thinking → 'thinking' (loader остаётся active)
        // Skip if activeSlashCmdRef — там overlay'у нужно своё «typing-like»
        // состояние, не переключаем глобальный sdkState.
        if (!activeSlashCmdRef.current) {
          if (chunkHasToolUse) updateSDKState(tabId, { sdkState: 'tool_use' });
          else if (chunkHasText) updateSDKState(tabId, { sdkState: 'typing' });
          else updateSDKState(tabId, { sdkState: 'thinking' });
        }

        setMessages(prev => {
          const last = prev[prev.length - 1];

          if (last?.role === 'assistant' && last.id === 'streaming-' + tabId) {
            const combined = [...(last.parts || []), ...newParts];
            const d = assembleMessageFields(combined);
            return [...prev.slice(0, -1), {
              ...last,
              parts: combined,
              text: d.text,
              thinking: d.thinking,
              toolCalls: d.toolCalls,
            }];
          }

          const d = assembleMessageFields(newParts);
          return [...prev, {
            id: 'streaming-' + tabId,
            role: 'assistant' as const,
            parts: newParts,
            text: d.text,
            thinking: d.thinking,
            toolCalls: d.toolCalls,
            timestamp: Date.now(),
          }];
        });
      }

      // Tool result — arrives as user-type message with tool_result content blocks.
      // SDK-injected replay/synthetic user records (post-/compact context
      // primers). Same filter as loadHistory — these are not real user input,
      // just JSONL bookkeeping. Without this drop, after live /compact two
      // ghost user-bubbles appear in the active thread.
      if (msg.type === 'user' && (msg.isReplay || msg.isSynthetic || msg.isVisibleInTranscriptOnly)) return;

      // Pair each result with its tool_use across ALL assistant messages by id, then flip status.
      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        const resultsById = new Map<string, { result: string; isError: boolean }>();
        for (const block of msg.message.content) {
          if (block?.type === 'tool_result' && block.tool_use_id) {
            resultsById.set(block.tool_use_id, {
              result: extractToolResultText(block.content),
              isError: !!block.is_error,
            });
          }
        }
        if (resultsById.size > 0) {
          setMessages(prev => prev.map(m => {
            if (m.role !== 'assistant' || !m.parts) return m;
            let touched = false;
            const nextParts: AssistantPart[] = m.parts.map(p => {
              if (p.type !== 'tool') return p;
              const r = resultsById.get(p.id);
              if (!r) return p;
              touched = true;
              return { ...p, result: r.result, status: (r.isError ? 'error' : 'done') as const };
            });
            if (!touched) return m;
            const d = assembleMessageFields(nextParts);
            return { ...m, parts: nextParts, toolCalls: d.toolCalls };
          }));
        }
      }

      // Result — finalize: rename streaming id + mark any still-running tools as done
      // (safety net; tool_result pairing above should have already flipped them).
      if (msg.type === 'result') {
        // Cumulative cost tracker for slash-overlay /usage view. SDK shippит
        // total_cost_usd / duration_ms / num_turns per turn — мы суммируем.
        if (typeof msg.total_cost_usd === 'number') cumCostRef.current.totalUSD += msg.total_cost_usd;
        if (typeof msg.duration_ms === 'number') cumCostRef.current.durationMs += msg.duration_ms;
        if (typeof msg.num_turns === 'number') cumCostRef.current.numTurns += msg.num_turns;

        // Info-slash turn done → release the ref. Overlay continues showing
        // captured output until user dismisses with Esc/Ctrl+C.
        if (activeSlashCmdRef.current) activeSlashCmdRef.current = null;

        setIsRunning(false);
        updateSDKState(tabId, { sdkState: msg.is_error ? 'error' : 'idle' });
        if (msg.is_error) {
          // Server-side or stream-level failure (timeout, API 4xx/5xx, abort, etc.).
          // The system-message fallback below stays in-thread; the toast surfaces it
          // immediately so the user notices without scrolling to the bottom.
          const errText = typeof msg.result === 'string' && msg.result.trim()
            ? msg.result.trim()
            : (msg.subtype || 'unknown error');
          useUIStore.getState().showToast(
            'Claude SDK: ' + errText.slice(0, 200),
            'error', 7000,
          );
        }
        setMessages(prev => prev.map(m => {
          const finalizeParts = (parts: AssistantPart[] | undefined): AssistantPart[] | undefined =>
            parts?.map(p => p.type === 'tool' && p.status === 'running' ? { ...p, status: 'done' as const } : p);
          if (m.id === 'streaming-' + tabId) {
            const nextParts = finalizeParts(m.parts);
            const d = nextParts ? assembleMessageFields(nextParts) : null;
            return {
              ...m,
              id: 'msg-' + Date.now(),
              parts: nextParts,
              toolCalls: d ? d.toolCalls : m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t),
            };
          }
          if (m.role === 'assistant' && m.toolCalls.some(t => t.status === 'running')) {
            const nextParts = finalizeParts(m.parts);
            const d = nextParts ? assembleMessageFields(nextParts) : null;
            return {
              ...m,
              parts: nextParts,
              toolCalls: d ? d.toolCalls : m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t),
            };
          }
          return m;
        }));
      }

      // System init — used to push a `Claude Code vX.Y.Z` system bubble for
      // debug visibility, but it was just visual noise. Every send-message
      // produced one, eating screen space without conveying anything the user
      // acts on. Version still logged in main.js console for diagnostics.
    };

    const handleDone = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'idle' });
    };

    // When main detects a stale resumeSessionId mid-stream and retries
    // without resume, it asks us to clear the cached id so future prompts
    // don't replay the same dead handshake. The retry's `init` message will
    // populate the fresh sessionId via handleMessage.
    const handleStaleResume = (_: any, data: { tabId: string; staleSessionId: string }) => {
      if (data.tabId !== tabId) return;
      console.warn('[ClaudeSDK] tab stale resume cleared:', data.staleSessionId?.slice(0, 8));
      sessionIdRef.current = null;
      updateSDKState(tabId, { claudeSessionId: undefined });
    };

    ipcRenderer.on('claude-sdk:message', handleMessage);
    ipcRenderer.on('claude-sdk:done', handleDone);
    ipcRenderer.on('claude-sdk:stale-resume-cleared', handleStaleResume);
    return () => {
      ipcRenderer.removeListener('claude-sdk:message', handleMessage);
      ipcRenderer.removeListener('claude-sdk:done', handleDone);
      ipcRenderer.removeListener('claude-sdk:stale-resume-cleared', handleStaleResume);
    };
  }, [tabId, updateSDKState]);

  // ---- Send handler for external store ----
  const onNew = useCallback(async (message: AppendMessage) => {
    // HARD GATE — pre-empts every send path (typed Enter, click Send, slash
    // commit, external prompt, queue replay). SDK не поддерживает midstream
    // приём prompt'а: попытка вызовет race с активной query и потеряет
    // сообщение. Two sources of truth checked together (один может lag'аться
    // относительно другого):
    //  1. `isRunning` — локальный stream-state, ставится в onNew/setMessages-stream
    //     до того как Zustand update долетит до tabs map.
    //  2. `sdkState` в store — авторитативно но обновляется с tick'а отставанием.
    // ANY === running → silently drop. UI button уже становится Cancel, юзер
    // видит что заблокировано; на Enter мы preventDefault в handleComposerKeyDown.
    const currentlyRunning = isRunning || (() => {
      const s = useWorkspaceStore.getState();
      for (const [, ws] of s.openProjects) {
        const t = ws.tabs.get(tabId);
        if (t) return t.sdkState === 'thinking' || t.sdkState === 'tool_use';
      }
      return false;
    })();
    if (currentlyRunning) {
      console.log('[OnNew] blocked: already running tab=' + tabId.slice(-12));
      return;
    }

    const textPart = message.content.find((p: any) => p.type === 'text');
    const inputText = (textPart?.type === 'text' ? textPart.text : '').trim();

    // Gather paste chips
    const pasteChips: Array<{ text: string }> = (window as any).__sdkPasteChips || [];
    const chipTexts = pasteChips.map(c => c.text);

    // Build full prompt: chips + text
    const parts: string[] = [];
    for (const ct of chipTexts) {
      parts.push('<pasted_content>\n' + ct + '\n</pasted_content>');
    }
    if (inputText) parts.push(inputText);
    else if (parts.length > 0) parts.push('Analyze this content');

    const text = parts.join('\n\n');
    if (!text.trim()) return;

    // [SlashProbe] Detect slash-command prefix in user input. If SDK
    // intercepts these we'll see system messages back; if not, the text
    // goes to the API as-is (Claude reads it literally).
    const slashMatch = text.match(/^\/(\S+)(?:\s|$)/);
    if (slashMatch) {
      console.log('[SlashProbe:onNew] tab=' + tabId.slice(-12) + ' SLASH_DETECTED cmd=/' + slashMatch[1] + ' fullPrompt=' + JSON.stringify(text.slice(0, 200)));
      // Info-type commands open SlashCommandOverlay вместо рендера output'а в
      // thread. Список — те команды, что в CLI открывают полноэкранный
      // Settings panel (LocalJSXCommandCall). SDK для них шипит plain-text
      // fallback через assistant message, мы перехватываем по
      // activeSlashCmdRef. Прочие slash (типа /clear / /compact) идут
      // штатным flow и output реально нужен в треде.
      const INFO_SLASH_CMDS = new Set(['usage', 'cost', 'stats', 'status', 'context', 'insights', 'extra-usage']);
      const slashName = slashMatch[1].toLowerCase();
      if (INFO_SLASH_CMDS.has(slashName)) {
        activeSlashCmdRef.current = slashName;
        setSlashOutput('');           // reset prior
        setSlashOverlay({ cmd: slashName });
      }
    } else {
      console.log('[SlashProbe:onNew] tab=' + tabId.slice(-12) + ' normal_prompt len=' + text.length);
    }

    // Clear chips
    window.dispatchEvent(new Event('claude-sdk:chips-clear'));
    setIsRunning(true);
    setWasStopped(false); // user opted into a new turn — drop the Resume affordance
    // Start at 'fetching' — pure network/warm-up window before SDK sends
    // anything. Flips to 'thinking' on system:init, 'typing'/'tool_use' as
    // first content arrives. See handleMessage phase-machine below.
    updateSDKState(tabId, { sdkState: 'fetching' });

    // Add user message
    setMessages(prev => [...prev, {
      id: 'user-' + Date.now(), role: 'user' as const,
      text, toolCalls: [], thinking: null, timestamp: Date.now(),
    }]);

    // Read SDK settings. `thinking` is the SDK shape ({type:'adaptive'|'disabled'});
    // the InfoPanel Think pill stores a bool in tab.sdkThinking, undefined=ON by default.
    const state = useWorkspaceStore.getState();
    let sdkModel: string | undefined;
    let sdkModelAlias: string | undefined;
    let sdkEffort: string | undefined;
    let sdkThinking: 'adaptive' | 'disabled' = 'adaptive';
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) {
        sdkModelAlias = t.sdkModel || 'default';
        sdkModel = resolveSdkModel(sdkModelAlias);
        sdkEffort = t.sdkEffort || 'high';
        sdkThinking = t.sdkThinking === false ? 'disabled' : 'adaptive';
        break;
      }
    }

    // Capability gating happens in InfoPanel (effort pills disabled for
    // unsupported levels, auto-downgrade on model change). By the time the
    // request lands here, the (model, effort) pair is known-valid client-side.
    // Runtime mismatch (server-side silent model swap, very rare) is caught by
    // `detectModelFamilyMismatch` in handleMessage below.
    const showToast = useUIStore.getState().showToast;
    lastRequestRef.current = { modelAlias: sdkModelAlias, effort: sdkEffort };
    modelMismatchToastedRef.current = false;

    const ipcChannel = sessionIdRef.current ? 'claude-sdk:send-message' : 'claude-sdk:create-session';
    // For resume: pass our captured sessionId explicitly. main.js's send-message
    // used to read sdkSessions.get(tabId) but that Map clears in `finally` of
    // the previous turn, so without explicit resumeSessionId every turn
    // started a fresh sessionId and Claude lost prior turn context.
    // See knowledge/fix-sdk-session-amnesia.md.
    const result = await ipcRenderer.invoke(ipcChannel, {
      tabId, cwd, prompt: text, model: sdkModel, effort: sdkEffort, thinking: sdkThinking,
      resumeSessionId: sessionIdRef.current || null,
    });

    if (!result.success) {
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'error' });
      showToast('Claude SDK: ' + (result.error || 'unknown error'), 'error', 6000);
      setMessages(prev => [...prev, {
        id: 'error-' + Date.now(), role: 'system' as const,
        text: 'Error: ' + result.error, toolCalls: [], thinking: null, timestamp: Date.now(),
      }]);
    }
  }, [tabId, cwd, updateSDKState]);

  const onCancel = useCallback(async () => {
    // The composer's red Cancel button = "stop THIS prompt", not "stop the whole
    // session". Two outcomes depending on what the assistant produced before we
    // intercepted:
    //   (A) Assistant emitted ANY content (text / thinking / a tool_use) — keep
    //       the partial answer in history, leave the composer empty. The user
    //       can hit Edit/Repeat on their last message if they want to retry.
    //   (B) Assistant produced nothing (we cancelled before the first content
    //       block) — pretend the turn never happened. Drop the user-message and
    //       any empty streaming placeholder locally, ask main to truncate the
    //       JSONL (Claude flushed the user-entry to disk the moment it streamed
    //       a `system:init`/`user` boundary — without truncation the next
    //       --resume would replay the prompt as if we'd sent it), then push the
    //       original text back into the composer input so the user can edit
    //       and resubmit.
    // We tell main to abort the stream first either way — content captured
    // *after* the snapshot we read still arrives async, but we're committed to
    // one of the two outcomes by the time we decide.
    const sid = sessionIdRef.current;
    ipcRenderer.invoke('claude-sdk:stop', { tabId });
    setIsRunning(false);
    updateSDKState(tabId, { sdkState: 'idle' });

    // Snapshot messages at the moment of cancel to decide (A) vs (B).
    let pendingRollback: { userMsg: SDKChatMessage; userUuidForTruncate: string | null } | null = null;
    setMessages(prev => {
      // The streaming placeholder is the last assistant message with id
      // "streaming-<tabId>". The user message that triggered it is the user
      // entry right before it.
      const streamingIdx = prev.findLastIndex(m => m.id === 'streaming-' + tabId);
      const lastUserIdx = (() => {
        // If there's a streaming placeholder, scan backwards from it; otherwise
        // from the tail. We only roll back the most recent user→assistant pair.
        const from = streamingIdx === -1 ? prev.length - 1 : streamingIdx - 1;
        for (let i = from; i >= 0; i--) if (prev[i].role === 'user') return i;
        return -1;
      })();

      const streaming = streamingIdx >= 0 ? prev[streamingIdx] : null;
      // `hasContent` checks BOTH legacy flat fields AND ordered parts[].
      // Streaming placeholder может ничего не успеть положить в плоские
      // поля если первый чанк был только thinking — раньше hasContent
      // возвращал false и Escape убивал юзер-message + thinking. Юзер:
      // «если получил thinkblock и нажал Escape → удалился thinkblock И
      // мой запрос, должно было остаться оба». parts[] это authoritative
      // source — любой непустой блок (thinking/text/tool) уже значит
      // «SDK что-то начал отдавать, не roll back».
      const hasContent = !!streaming && (
        streaming.text.trim().length > 0 ||
        (streaming.thinking && streaming.thinking.trim().length > 0) ||
        streaming.toolCalls.length > 0 ||
        (Array.isArray(streaming.parts) && streaming.parts.some(p =>
          (p.type === 'text' && p.text.trim().length > 0) ||
          (p.type === 'thinking' && p.text.trim().length > 0) ||
          p.type === 'tool'
        ))
      );

      // (A) Content captured → keep everything. We just rename the streaming
      // placeholder to a stable id so it survives re-renders (mirrors what the
      // `result` handler usually does, but we beat it by cancelling).
      if (hasContent) {
        return prev.map(m => {
          if (m.id !== 'streaming-' + tabId) return m;
          const nextParts: AssistantPart[] | undefined = m.parts?.map(p =>
            p.type === 'tool' && p.status === 'running' ? { ...p, status: 'done' as const } : p
          );
          const d = nextParts ? assembleMessageFields(nextParts) : null;
          return {
            ...m,
            id: 'msg-' + Date.now(),
            parts: nextParts,
            toolCalls: d ? d.toolCalls : m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t),
          };
        });
      }

      // (B) Nothing captured → drop user + empty streaming placeholder. Stash
      // the original text in pendingRollback so we can push it back into the
      // composer + (maybe) truncate JSONL after the setMessages commit.
      if (lastUserIdx === -1) return prev; // nothing to roll back
      const userMsg = prev[lastUserIdx];
      // Only persisted user messages have a real JSONL uuid; placeholders
      // ("user-…") never made it to disk yet (or arrived without a uuid swap),
      // so we skip the truncate IPC in that case.
      const userUuidForTruncate = isPersistedMsgId(userMsg.id) ? userMsg.id : null;
      pendingRollback = { userMsg, userUuidForTruncate };
      const cutoff = streamingIdx === -1 ? lastUserIdx : Math.min(lastUserIdx, streamingIdx);
      return prev.slice(0, cutoff);
    });

    // Flush rollback effects after the setMessages microtask.
    queueMicrotask(async () => {
      if (!pendingRollback) return;
      const { userMsg, userUuidForTruncate } = pendingRollback;
      // Push the typed text back into the composer (uses the same DOM-level
      // setter as Insert-Prompt / stash restore — assistant-ui's runtime.setText
      // alone doesn't repaint the textarea reliably).
      window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', {
        detail: { tabId, text: userMsg.text, replace: true },
      }));
      if (sid && userUuidForTruncate) {
        try {
          const res = await ipcRenderer.invoke('claude-sdk:truncate-history', {
            sessionId: sid, cwd, targetUuid: userUuidForTruncate,
          });
          if (!res?.success) {
            console.warn('[ClaudeSDKTab:onCancel] JSONL truncate skipped/failed:', res?.error);
          }
        } catch (err: any) {
          console.warn('[ClaudeSDKTab:onCancel] truncate threw:', err?.message);
        }
      }
    });
  }, [tabId, cwd, updateSDKState]);

  // Edit / Repeat action busy flag — separate from isRunning so the streaming
  // spinner doesn't fire prematurely on truncate, and both action buttons get
  // disabled together while the JSONL surgery + new send is in flight.
  const [actionBusy, setActionBusy] = useState(false);

  // Find the JSONL uuid corresponding to a UI message id. For history-loaded
  // entries id === uuid. For freshly-sent messages we used "user-<ts>" / "streaming-<tabId>"
  // — those have no JSONL uuid yet. Caller should fall back to "find user msg by
  // index in messages[] and use the assistant chain just before it" via the
  // SDK's session_id metadata. Cheaper: only allow Edit/Repeat on persisted msgs.
  const isPersistedMsgId = (id: string) => id && !id.startsWith('user-') && !id.startsWith('streaming-') && !id.startsWith('hist-') && !id.startsWith('msg-') && !id.startsWith('init-') && !id.startsWith('error-');

  // Shared truncate+resend used by both Repeat (text = original) and Edit
  // (text = user-edited). Picks the JSONL uuid, calls main to drop everything
  // ≥ that uuid, trims local messages mirror, fires the new prompt.
  const truncateAndResend = useCallback(async (uiMsgId: string, newText: string) => {
    const sid = sessionIdRef.current;
    if (!sid) { console.warn('[ClaudeSDKTab:truncateAndResend] no sessionId'); return; }
    if (!isPersistedMsgId(uiMsgId)) {
      console.warn('[ClaudeSDKTab:truncateAndResend] cannot edit non-persisted msg id=' + uiMsgId);
      return;
    }
    setActionBusy(true);
    try {
      // Resolve cwd same way as loadHistory.
      const state = useWorkspaceStore.getState();
      let tabCwd = cwd;
      let sdkModel: string | undefined;
      let sdkModelAlias: string | undefined;
      let sdkEffort: string | undefined;
      let sdkThinking: 'adaptive' | 'disabled' = 'adaptive';
      for (const [, ws] of state.openProjects) {
        const t = ws.tabs.get(tabId);
        if (t) {
          tabCwd = t.cwd || cwd;
          sdkModelAlias = t.sdkModel || 'default';
          sdkModel = resolveSdkModel(sdkModelAlias);
          sdkEffort = t.sdkEffort || 'high';
          sdkThinking = t.sdkThinking === false ? 'disabled' : 'adaptive';
          break;
        }
      }

      // Same as onNew above — capability gating happens in InfoPanel; only
      // server-side mismatch and IPC failure surface toasts from here.
      const showToast = useUIStore.getState().showToast;
      lastRequestRef.current = { modelAlias: sdkModelAlias, effort: sdkEffort };
      modelMismatchToastedRef.current = false;

      const truncRes = await ipcRenderer.invoke('claude-sdk:truncate-history', {
        sessionId: sid, cwd: tabCwd, targetUuid: uiMsgId,
      });
      if (!truncRes?.success) {
        console.error('[ClaudeSDKTab:truncateAndResend] backend failed:', truncRes?.error);
        showToast('Truncate failed: ' + (truncRes?.error || 'unknown'), 'error', 6000);
        setMessages(prev => [...prev, {
          id: 'error-' + Date.now(), role: 'system' as const,
          text: 'Truncate failed: ' + (truncRes?.error || 'unknown'),
          toolCalls: [], thinking: null, timestamp: Date.now(),
        }]);
        setActionBusy(false);
        return;
      }

      // Trim local messages mirror: drop everything from the target msg onward.
      // Then add the new user msg + flip running for visual feedback.
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === uiMsgId);
        const head = idx === -1 ? prev : prev.slice(0, idx);
        return [...head, {
          id: 'user-' + Date.now(),
          role: 'user' as const,
          text: newText,
          toolCalls: [], thinking: null,
          timestamp: Date.now(),
        }];
      });
      setIsRunning(true);
      setWasStopped(false);
      updateSDKState(tabId, { sdkState: 'fetching' });

      // Fire the resend through the existing SDK channel — server-side
      // session.sessionId is preserved, so this lands as the new turn off the
      // truncated tip. Pass resumeSessionId explicitly (see fix-sdk-session-amnesia).
      const result = await ipcRenderer.invoke('claude-sdk:send-message', {
        tabId, cwd: tabCwd, prompt: newText, model: sdkModel, effort: sdkEffort, thinking: sdkThinking,
        resumeSessionId: sessionIdRef.current || null,
      });
      if (!result?.success) {
        setIsRunning(false);
        updateSDKState(tabId, { sdkState: 'error' });
        showToast('Claude SDK: ' + (result?.error || 'unknown error'), 'error', 6000);
        setMessages(prev => [...prev, {
          id: 'error-' + Date.now(), role: 'system' as const,
          text: 'Error: ' + result.error, toolCalls: [], thinking: null, timestamp: Date.now(),
        }]);
      }
    } finally {
      setActionBusy(false);
    }
  }, [tabId, cwd, updateSDKState]);

  const userMsgActions = useMemo<UserMsgActions>(() => ({
    onRepeat: (msgId) => {
      // Find the original text in messages and resend it as-is.
      setMessages(prev => {
        const m = prev.find(x => x.id === msgId);
        if (m) truncateAndResend(msgId, m.text);
        return prev;
      });
    },
    onEdit: (msgId, newText) => truncateAndResend(msgId, newText),
    busy: actionBusy || isRunning,
  }), [actionBusy, isRunning, truncateAndResend]);

  const isVisible = active && isActiveProject;

  // Gate Virtuoso mount until the tab has been visible at least once.
  // Virtuoso uses a ResizeObserver on its own viewport to compute item ranges.
  // Mounting inside a `display:none` parent gives ResizeObserver a 0×0 box —
  // Virtuoso decides "nothing to show" and never calls itemContent. Toggling
  // the parent's `display` to `flex` does NOT trigger ResizeObserver (RO fires
  // on box-size change, not on the style flip), so the list stays dead even
  // after the user opens the tab. Symptom in live use: SDK tab opens, the
  // composer is there, the chat area is blank grey. Symptom in logs:
  // `[SDKHistory:Client] CACHE_HIT count=N` succeeded → `setMessages(N)` →
  // `[Virt] VirtualizedMessages render length=N` but ZERO `[Virt] itemContent`
  // entries because Virtuoso never measured its parent.
  // Defer the mount one tick after the first hidden→visible flip via a ref +
  // forceUpdate gate. Once it mounts inside a visible (non-zero) box, RO does
  // its job and the list stays alive even if the user later flips back to
  // hidden — Virtuoso keeps its measurement cache.
  const hasBeenVisibleRef = useRef(false);
  const [, _forceVirtMount] = useState(0);
  useLayoutEffect(() => {
    if (isVisible && !hasBeenVisibleRef.current) {
      hasBeenVisibleRef.current = true;
      _forceVirtMount((n) => n + 1);
    }
  }, [isVisible]);

  // [SDKVisibility] Profile the visible-flip → first paint window. When `isVisible`
  // flips false→true the browser does layout/paint of the entire tree that was
  // hidden. For a chat with 744 messages this is the suspected 1.6s freeze
  // during tab-switch. useLayoutEffect runs SYNC after DOM mutation, BEFORE the
  // browser paints; pairing it with a rAF lets us bracket the paint cycle.
  const prevVisibleRef = useRef<boolean>(isVisible);
  useLayoutEffect(() => {
    if (prevVisibleRef.current === isVisible) return;
    const prev = prevVisibleRef.current;
    prevVisibleRef.current = isVisible;
    if (prev === false && isVisible === true) {
      const t0 = performance.now();
      console.warn('[SDKVisibility] tab=' + tabId.slice(-12) + ' msgs=' + messages.length + ' flip=hidden→visible layoutEffectT0=' + t0.toFixed(1));
      requestAnimationFrame(() => {
        const t1 = performance.now();
        console.warn('[SDKVisibility] tab=' + tabId.slice(-12) + ' msgs=' + messages.length + ' rAF1 paintMs=' + (t1 - t0).toFixed(1));
        requestAnimationFrame(() => {
          const t2 = performance.now();
          console.warn('[SDKVisibility] tab=' + tabId.slice(-12) + ' msgs=' + messages.length + ' rAF2 settledMs=' + (t2 - t0).toFixed(1));
        });
      });
    }
  }, [isVisible, tabId, messages.length]);

  // [SlashProbe] Probe SDK control-API once per tab session: enumerates
  // available slash-commands (with aliases), MCP-server status, current
  // context-usage breakdown. Triggered the first time this tab becomes
  // visible — by then sdkSessions has a Query for it (assuming an active
  // turn ran). If no active session, main spawns a throw-away probe-only
  // Query so we still get the global manifest.
  const slashProbedRef = useRef(false);
  useEffect(() => {
    if (!isVisible || slashProbedRef.current) return;
    slashProbedRef.current = true;
    (async () => {
      try {
        const t0 = performance.now();
        const res = await ipcRenderer.invoke('claude-sdk:probe-commands', { tabId });
        const dur = (performance.now() - t0).toFixed(0);
        if (!res?.success) {
          console.warn('[SlashProbe:Renderer] tab=' + tabId.slice(-12) + ' probe failed durMs=' + dur + ' error=' + res?.error);
          return;
        }
        console.log('[SlashProbe:Renderer] tab=' + tabId.slice(-12) + ' probe ok durMs=' + dur
          + ' commands=' + (res.commands?.length ?? 'ERR:' + res.commandsError)
          + ' mcp=' + (res.mcpServerStatus?.length ?? 'ERR:' + res.mcpServerStatusError));
        if (res.commands) {
          for (const c of res.commands) {
            const aliases = c.aliases?.length ? ' aliases=[' + c.aliases.map((a: string) => '/' + a).join(',') + ']' : '';
            const argHint = c.argumentHint ? ' args=' + c.argumentHint : '';
            console.log('[SlashProbe:Renderer]   /' + c.name + argHint + ' — ' + String(c.description || '').slice(0, 120) + aliases);
          }
        }
        if (res.contextUsage) {
          console.log('[SlashProbe:Renderer] contextUsage=' + JSON.stringify(res.contextUsage).slice(0, 600));
        }
        if (res.mcpServerStatus) {
          res.mcpServerStatus.forEach((s: any) => {
            console.log('[SlashProbe:Renderer]   mcp ' + s.name + ' status=' + s.status + (s.error ? ' error=' + String(s.error).slice(0, 80) : ''));
          });
        }
      } catch (e: any) {
        console.warn('[SlashProbe:Renderer] probe exception:', e?.message);
      }
    })();
  }, [isVisible, tabId]);

  // Composer footer pill — "Opus 4.7 (1M context) 19%". Subscribes to the tab's
  // sdkModel alias so switching models in the sidebar updates the label even
  // before the next assistant response lands. Context % is the LATEST known
  // assistant usage / model window (so it lags one turn behind, which matches
  // Claude TUI behaviour).
  const sdkModelAlias = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.sdkModel || 'default';
    }
    return 'default';
  });
  // Reset lastResolvedModel when user manually switches alias. Без этого
  // footer показывает family из ПОСЛЕДНЕГО SSE-ответа («Opus») пока юзер
  // уже выбрал Sonnet — выбор кажется незарегистрированным до следующего
  // turn'а. После reset формула `formatModelLabel(null, newAlias)` сразу
  // даёт правильный label из alias resolution.
  const prevAliasRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevAliasRef.current !== undefined && prevAliasRef.current !== sdkModelAlias) {
      setLastResolvedModel(null);
    }
    prevAliasRef.current = sdkModelAlias;
  }, [sdkModelAlias]);
  const currentModelLabel = useMemo(
    () => formatModelLabel(lastResolvedModel, sdkModelAlias),
    [lastResolvedModel, sdkModelAlias],
  );
  // Show USED percent (filled), not remaining. User reads "92%" as "92%
  // full" — the old "remaining" semantic confused everyone. Match mobile
  // ChatView (same fix in fact-claude-sdk-tab.md::Context indicator).
  // Variable name kept for now to avoid touching every callsite — the value
  // it carries is "usedPct", clamped 0..100.
  const contextPercentRemaining = useMemo(() => {
    if (lastContextUsedTokens == null) return null;
    const win = getModelContextWindow(lastResolvedModel, sdkModelAlias);
    if (!win) return null;
    const usedPct = (lastContextUsedTokens / win) * 100;
    return Math.max(0, Math.min(100, usedPct));
  }, [lastContextUsedTokens, lastResolvedModel, sdkModelAlias]);

  // Escape (or Ctrl+[ / Ctrl+C — Claude TUI aliases): three roles by precedence.
  //   1. Slash-overlay open → close overlay.
  //   2. Query running → cancel running query.
  //   3. Otherwise → no-op (let event bubble for native behavior).
  // Все три hotkey'я (ESC / Ctrl+[ / Ctrl+C) терминалы посылают как 0x1b,
  // muscle memory из CLI работает в overlay'е без сюрпризов.
  useEffect(() => {
    if (!isVisible) return;
    const handler = (e: KeyboardEvent) => {
      const isEscapeAlias = e.key === 'Escape'
        || (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '[' || e.key === 'c'));
      if (!isEscapeAlias) return;
      if (slashOverlay) {
        e.preventDefault();
        setSlashOverlay(null);
        return;
      }
      if (isRunning) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRunning, isVisible, onCancel, slashOverlay]);

  // Cmd+E was the legacy native-menu shortcut for Insert Prompt — replaced by
  // the custom Opt+V two-column picker (handled at App-level). No SDK-tab
  // keybinding needed here anymore; right-click still opens the native menu
  // via the existing show-sdk-context-menu IPC.

  // Subscribe to context-menu commands (forwarded by main when a menu item is
  // clicked). Filter by sdk:true + matching tabId so this listener only acts on
  // events fired by *our* slim SDK menu, not the regular terminal context menu.
  useEffect(() => {
    const handler = (_: any, command: string, payload: any) => {
      if (command !== 'insert-prompt') return;
      if (!payload?.sdk) return;
      if (payload.tabId !== tabId) return;
      const text = payload.content || '';
      if (!text) return;
      // Route through the same window event the right-click menu uses for
      // composer focus — SDKComposer owns the composerRuntime and will append
      // the prompt text to whatever is already typed.
      window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', {
        detail: { tabId, text },
      }));
    };
    ipcRenderer.on('context-menu-command', handler);
    return () => { ipcRenderer.removeListener('context-menu-command', handler); };
  }, [tabId]);

  // ---- External store runtime ----
  // Filter:
  //   1) Drop unknown roles (Claude SDK JSONL can emit role='attachment' for
  //      file-paste / image-attach records; we render only user/assistant/system).
  //      Pre-virtualization the old ThreadPrimitive.Messages internally dispatched
  //      by role and silently rendered nothing for unknown ones. Our custom
  //      MessageRoleDispatch falls through to AssistantMessage for unknowns —
  //      which renders an empty bubble (MessagePrimitive.Root with empty
  //      content). Symptom: visible gaps in the chat between real messages,
  //      and on cold-start the whole list looks blank because the first 30
  //      mounted items happened to be attachments.
  //   2) Drop empty assistants (no text, no tools, no thinking).
  const filteredMessages = useMemo(() =>
    messages.filter(m => {
      // Allowed roles: user / assistant / system / compact-summary. Anything
      // else (raw 'attachment' SDK records, etc.) is internal protocol.
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system' && m.role !== 'compact-summary') return false;
      if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
      return true;
    }),
  [messages]);

  const runtime = useExternalStoreRuntime({
    messages: filteredMessages,
    convertMessage,
    isRunning,
    onNew,
    onCancel,
  });

  // Stable components map for VirtualizedMessages — passing inline {} would
  // bust the memo and force the Virtuoso subtree to reconcile every render.
  const virtuosoComponents = useMemo(
    () => ({ UserMessage: UserMsg, AssistantMessage: AssistantMsg, SystemMessage: SystemMsg }),
    [],
  );

  // Virtuoso owns scrolling — its `initialTopMostItemIndex` (= last item)
  // handles "open at bottom", `followOutput="auto"` handles auto-follow when
  // user is at bottom, and `atBottomStateChange` drives the scroll-to-bottom
  // FAB. We DO NOT do manual scrollTop writes — they fight Virtuoso's owner
  // and cause render loops via flushSync. scrollContainerRef stays for the
  // unused but kept for parity with previous shape.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Virtuoso reports bottom-state via callback — single source of truth.
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollDown(!atBottom);
  }, []);

  // Virtuoso fires itemsRendered every time it paints a non-empty range — the
  // first such call marks "chat is on screen". Idempotent: re-firing during
  // scroll is cheap (setChatReady(true) no-ops once already true).
  const handleFirstPaint = useCallback(() => {
    setChatReady(true);
  }, []);

  // Scroll-to-bottom button: jumps via Virtuoso (manual scrollTop would not
  // play with virtualization — Virtuoso unrenders bottom items if you bypass it).
  // behavior: 'auto' = instant (no smooth animation) — matches Claude TUI:
  // hit Enter, you're at the bottom immediately. Юзер: «нахуй для этой
  // анимации скролла можно убрать».
  const scrollToBottom = useCallback(() => {
    const len = filteredMessages.length;
    if (len > 0) {
      virtuosoRef.current?.scrollToIndex({ index: len - 1, align: 'end', behavior: 'auto' });
    }
  }, [filteredMessages.length]);

  // Focus management — final design from Claude/Perplexity deep research.
  //
  // The Virtuoso scroller is rendered WITHOUT a `tabindex` attribute (see
  // SDKScroller component) → it is not click-focusable → mousedown inside
  // the chat list does NOT move focus → composer textarea retains focus
  // through every click and drag → drag-to-select works natively.
  //
  // No mousedown/mouseup handlers needed on the tab root. The only
  // diagnostic kept is the textarea's onBlur — if focus DOES somehow leave
  // the composer, we'll see who took it.
  // Single mouseup handler. Drag-vs-click discrimination + selection guard.
  //   - drag (delta > 3px) → user selected text → do NOT refocus, leave the
  //     selection alone. They'll click again when ready.
  //   - click (delta ≤ 3px) on a non-interactive target → safe to refocus
  //     the composer.
  //   - interactive (button/link/input/cE) → that element owns its click,
  //     skip.
  // The mousedown.preventDefault on the Virtuoso scroller (defined further
  // below as a custom Scroller component) prevents the scroller from
  // stealing focus during the native click pipeline — so by the time our
  // mouseup runs, document.activeElement is still wherever it was before
  // the click (usually textarea), and we only need to handle the rare case
  // where the user clicked a button that briefly held focus.

  // Right-click anywhere in the tab area → slim native menu (Copy / Paste /
  // Insert Prompt). Forwarded to main; main builds the menu from the prompt
  // store and pops it next to the cursor.
  const handleTabContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Let buttons / inputs handle their own native menu (textarea has paste etc).
    const target = e.target as HTMLElement;
    if (target.closest('button, a')) return;
    e.preventDefault();
    const sel = window.getSelection();
    const hasSelection = !!(sel && sel.toString().length > 0);
    ipcRenderer.send('show-sdk-context-menu', { tabId, hasSelection });
  }, [tabId]);

  // Global keydown → composer. Detached from focus state.
  //
  // Why: `ta.focus()` collapses window.getSelection() (WHATWG focusing-step 7,
  // verified empirically — sel 370→0). So we CAN'T keep both:
  //   - selection in chat AND
  //   - textarea focused.
  // But we want: keystrokes go to composer regardless of selection.
  //
  // Solution: listen for keydown on the SDK tab root. If the event target
  // isn't already a form control (textarea/input/cE/button), AND the key is
  // a printable character or editing key (Backspace, Enter, etc.) — divert
  // it into the composer textarea using the native value setter, which fires
  // input event that React's onChange picks up. Selection in chat survives
  // because we never call ta.focus(). When user is done reading and clicks
  // anywhere, the existing onBlur→refocus pattern reasserts focus.
  // Track visibility in a ref so the keydown listener (effect-scoped, captures
  // initial isVisible) can early-return when this tab isn't active. Without
  // this, 5+ mounted SDKTabs each receive every keydown and write the same
  // letter 5× into the active composer.
  const isVisibleRef = useRef(isVisible);
  useEffect(() => { isVisibleRef.current = isVisible; }, [isVisible]);

  // Snapshot textarea caret on mousedown anywhere in the SDK tab — BEFORE
  // Blink runs its own click-into-form-control side effects. Real trusted
  // mouse from OS commits "click outside textarea → reset caret in textarea
  // to 0,0" between mousedown dispatch and our onBlur, so by the time onBlur
  // reads selectionStart it's already 0. Capturing at mousedown gets us the
  // actual position the user typed at.
  const savedCaretRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!isVisibleRef.current) return;
      const target = e.target as HTMLElement | null;
      const tabRoot = target?.closest?.('.absolute.inset-0.flex.flex-col');
      if (!tabRoot) return;
      const ta = tabRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      // Only snapshot when click is OUTSIDE the textarea — that's the case
      // where Blink would reset caret on us.
      if (ta.contains(target)) return;
      savedCaretRef.current = {
        start: ta.selectionStart ?? 0,
        end: ta.selectionEnd ?? 0,
      };
      try { ipcRenderer.send('log:renderer', `[SDKCaretSnap] mousedown outside-ta savedCaret=${savedCaretRef.current.start},${savedCaretRef.current.end}`); } catch {}
    };
    // Active recovery on mouseup. After click in chat, by the time mouseup
    // fires Blink already (a) moved focus to body, (b) reset textarea caret
    // to 0. We restore both: focus textarea + put caret back to mousedown
    // snapshot. EXCEPT when user actually drag-selected text in chat —
    // window.getSelection() != collapsed → leave focus in body so selection
    // stays visible.
    const onMouseUp = (e: MouseEvent) => {
      if (!isVisibleRef.current) return;
      const target = e.target as HTMLElement | null;
      const tabRoot = target?.closest?.('.absolute.inset-0.flex.flex-col');
      if (!tabRoot) return;
      const ta = tabRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      if (ta.contains(target)) return; // click in textarea — let it own
      // Interactive controls inside chat (buttons, links) own their click.
      if (target?.closest?.('button, a, input, [contenteditable]')) return;
      // setTimeout so Blink finishes its click pipeline first, including
      // committing window.getSelection from drag.
      setTimeout(() => {
        const sel = window.getSelection();
        const selLen = sel?.toString().length || 0;
        // Threshold 5 chars: anything shorter is likely an accidental selection
        // (single character or click that almost-but-not-quite started a drag).
        // Real selections are typically 10+ chars.
        if (selLen >= 5 && sel && !sel.isCollapsed) {
          try { ipcRenderer.send('log:renderer', `[SDKActiveRecover] skip=selection len=${selLen}`); } catch {}
          return;
        }
        // No real selection → restore composer state.
        const snap = savedCaretRef.current;
        try { ipcRenderer.send('log:renderer', `[SDKActiveRecover] → focus + caret=${snap?.start ?? 0},${snap?.end ?? 0}`); } catch {}
        ta.focus({ preventScroll: true });
        if (snap) {
          try { ta.setSelectionRange(snap.start, snap.end); } catch {}
        }
        // Also collapse any tiny accidental selection in chat — keeps UI clean.
        if (selLen > 0 && selLen < 5) {
          try { sel?.removeAllRanges(); } catch {}
        }
      }, 0);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };
  }, []);
  useEffect(() => {
    const isPrintable = (e: KeyboardEvent): boolean => {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.key.length === 1) return true;
      return e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter';
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Only the visible SDK tab's listener acts. Hidden tabs (display:none)
      // also receive the event but must not write to the composer.
      if (!isVisibleRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('textarea, input, [contenteditable], button, a')) return;
      // Two paths for finding the composer textarea:
      //   1) Event target is inside an SDK tab → use that tab's textarea.
      //      Happens on plain click in chat: focus moved to body but the
      //      keydown's target is still the <p> (closest event target).
      //   2) Target is body/html (no SDK ancestor) → user is on a "selected
      //      text" state where mousedown moved focus out of textarea AND
      //      out of any visual tab descendant. In that case fall back to
      //      finding the currently-visible SDK tab in the DOM and using its
      //      textarea. This is the case the user described: "выделил текст,
      //      нажимаю клавишу — нихуя".
      let tabRoot = (target as HTMLElement | null)?.closest?.('.absolute.inset-0.flex.flex-col') as HTMLElement | null;
      if (!tabRoot) {
        const candidates = Array.from(document.querySelectorAll('.absolute.inset-0.flex.flex-col'));
        tabRoot = candidates.find((t: any) => t.style?.display === 'flex' && t.querySelector('textarea')) as HTMLElement | null;
      }
      if (!tabRoot) return;
      const ta = tabRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      if (!isPrintable(e)) return;

      // Apply the key to the textarea via the native value setter so React
      // sees the change. Mirrors React DevTools' way of programmatically
      // updating controlled inputs.
      e.preventDefault();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (!nativeSetter) return;
      let next = ta.value;
      const start = ta.selectionStart ?? next.length;
      const end = ta.selectionEnd ?? next.length;
      if (e.key === 'Backspace') {
        if (start !== end) {
          next = next.slice(0, start) + next.slice(end);
        } else if (start > 0) {
          next = next.slice(0, start - 1) + next.slice(end);
        }
        nativeSetter.call(ta, next);
        const caret = Math.max(0, start === end ? start - 1 : start);
        ta.setSelectionRange(caret, caret);
      } else if (e.key === 'Delete') {
        if (start !== end) {
          next = next.slice(0, start) + next.slice(end);
        } else {
          next = next.slice(0, start) + next.slice(end + 1);
        }
        nativeSetter.call(ta, next);
        ta.setSelectionRange(start, start);
      } else {
        const ch = e.key === 'Enter' ? '\n' : e.key;
        next = next.slice(0, start) + ch + next.slice(end);
        nativeSetter.call(ta, next);
        const caret = start + ch.length;
        ta.setSelectionRange(caret, caret);
      }
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: e.key.length === 1 ? e.key : undefined }));
      // After typing, if focus was on body/non-tab — pull it into the textarea
      // and clear any leftover document selection. This gives the user the
      // natural "I started typing → selection is gone, I'm in the input"
      // experience. WHATWG-correct: typing a character is the explicit signal
      // to drop the read-only selection state.
      if (document.activeElement !== ta) {
        try { window.getSelection()?.removeAllRanges(); } catch {}
        try {
          const caretEnd = ta.selectionEnd ?? ta.value.length;
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(caretEnd, caretEnd);
        } catch {}
      }
      try { ipcRenderer.send('log:renderer', `[SDKGlobalKey] key=${e.key} → composer (target=${target?.tagName?.toLowerCase()})`); } catch {}
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Inherit terminal font-size for the entire SDK tab — keeps SDK chat in
  // sync with the user's Terminal preference (Cmd+/− and the Settings slider).
  // All in-card text uses em-based sizes (text-[1em], text-[0.85em], …) so a
  // single base on this root re-scales the whole tree without per-element edits.
  const sdkBaseFontSize = useUIStore((s) => s.terminalFontSize);

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ display: isVisible ? 'flex' : 'none', fontSize: `${sdkBaseFontSize}px` }}
      onContextMenu={handleTabContextMenu}
    >
      <AssistantProviderBase runtime={runtime}>
        <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
          {/* Viewport: pure flex column, NO overflow — Virtuoso owns scrolling.
              Previously this div had overflow-y-auto and Virtuoso ran in
              customScrollParent mode; that combo created two scroll-aware
              containers chained together. Every Virtuoso scroll-event triggered
              flushSync → parent re-render → Virtuoso ResizeObserver → infinite
              loop (visible in logs as repeated [ClaudeSDKTab:RENDER] from
              react-virtuoso flushSync stacks). Letting Virtuoso be the scroller
              eliminates the chain.

              The Empty state is rendered as a sibling-when-len-0 inside
              VirtualizedMessages itself (Virtuoso returns null on length===0),
              so we wrap it in ThreadPrimitive.Empty too — assistant-ui's
              ThreadPrimitive.Empty already drives off the same store length. */}
          <ThreadPrimitive.Viewport
            ref={scrollContainerRef as any}
            className="flex flex-1 flex-col overflow-hidden sdk-chat-scroll"
          >
            {/* Empty state: shown when the assistant-ui store reports zero
                messages. We don't try to differentiate "loading" from "truly
                empty" here — a skeleton overlay was attempted (see
                fix-sdk-virtualization-tab-switch.md::skeleton-graveyard) but
                never rendered visibly, so we kept only the canonical CTA. */}
            <ThreadPrimitive.Empty>
              <div className="flex flex-1 items-center justify-center h-full">
                <div className="text-center text-[#555] select-none">
                  <div className="mb-3 opacity-40" style={{ color: '#DA7756' }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto' }}>
                      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                    </svg>
                  </div>
                  <p className="text-[1em]">Claude SDK</p>
                  <p className="text-[0.85em] text-[#444] mt-1">Type a message to start</p>
                </div>
              </div>
            </ThreadPrimitive.Empty>

            {/* Messages — Virtuoso is the scroller (flex:1, internal overflow:auto).
                Gated by hasBeenVisibleRef: mounting Virtuoso while parent is
                `display:none` gives it a 0×0 viewport via ResizeObserver, and
                a subsequent `display:flex` flip doesn't trigger RO (style-only
                change isn't a box-size change). The result is a permanently
                empty list — chat history loaded into the store but Virtuoso
                renders zero items. We hold the mount until the first time the
                tab is actually visible, then Virtuoso measures a real box and
                stays alive across future hidden↔visible flips (RO keeps its
                cache). See VirtualizedMessages docblock for the customScrollParent
                graveyard. */}
            <UserMsgActionsContext.Provider value={userMsgActions}>
              {hasBeenVisibleRef.current && (
                <VirtualizedMessages
                  virtuosoRef={virtuosoRef}
                  onAtBottomChange={handleAtBottomChange}
                  onFirstPaint={handleFirstPaint}
                  components={virtuosoComponents}
                />
              )}
            </UserMsgActionsContext.Provider>
            {/* Cold-start loader. Visible from tab-click to first Virtuoso paint
                for tabs with history. Doesn't render at all for new/empty tabs
                (chatReady flips immediately in loadHistory's early-return path).
                500ms delay before fade-in keeps light tabs from flashing. */}
            {!chatReady && messages.length > 0 && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20"
                style={{
                  background: '#1a1a1a',
                  animation: 'sdk-cold-loader-fade 200ms ease-out 500ms both',
                }}
              >
                <div
                  className="w-7 h-7 rounded-full border-2 border-[#333] border-t-[#DA7756]"
                  style={{ animation: 'spin 0.9s linear infinite' }}
                />
                <div className="mt-3 text-[0.85em] text-[#666] select-none">
                  Loading chat…
                </div>
              </div>
            )}

            {/* Composer MUST stay inside Viewport — assistant-ui's
                ComposerPrimitive.Input reads ThreadPrimitive context and
                throws "must be used within ThreadPrimitive.Viewport" if hoisted
                out. NORMAL FLOW (no sticky) — composer is the last element of
                the scrollable area, scrolls out of view when the user scrolls
                up. Matches Claude Code TUI: input is the bottom of the buffer,
                not an overlay. When chat is short, messages-div's flex-1 grows
                and pushes the composer to the bottom-anchored slot anyway. */}
            <ThreadPrimitive.ViewportFooter className="shrink-0">
              {slashOverlay ? (
                <SlashCommandOverlay
                  cmd={slashOverlay.cmd}
                  output={slashOutput}
                  isRunning={isRunning}
                  onClose={() => setSlashOverlay(null)}
                  costSummary={cumCostRef.current}
                  modelLabel={currentModelLabel}
                  contextPercent={contextPercentRemaining}
                  sessionId={sessionId}
                />
              ) : <SDKComposer
                tabId={tabId}
                isRunning={isRunning}
                sessionId={sessionId}
                wasStopped={wasStopped}
                onResume={() => setWasStopped(false)}
                modelLabel={currentModelLabel}
                contextPercent={contextPercentRemaining}
                onUserInteract={scrollToBottom}
                onSessionStop={async () => {
                  // Double-Ctrl+C from inside the composer = "stop the whole
                  // session" (matches Claude TUI). Same path as the TabBar dot,
                  // sidebar chip, ctx menu — surface Resume affordance.
                  try {
                    await ipcRenderer.invoke('claude-sdk:stop', { tabId });
                    window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
                  } catch (e: any) { console.error('[ComposerStop] error', e); }
                }}
              />}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>

          {/* Scroll-to-bottom button */}
          {showScrollDown && (
            <Tooltip content="Scroll to bottom">
            <button
              onClick={scrollToBottom}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute z-10 flex items-center justify-center w-8 h-8 rounded-full bg-[#2a2a2a] border border-[#444] text-[#888] hover:text-white hover:bg-[#3a3a3a] transition-all cursor-pointer shadow-lg"
              style={{ bottom: '70px', right: '52px' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            </Tooltip>
          )}
        </ThreadPrimitive.Root>
      </AssistantProviderBase>
    </div>
  );
}

// ============================================================
// User message — bubble + hover Repeat/Edit. Inline edit mode replaces the
// bubble with a textarea (Save → truncate-and-resend with new text, Cancel →
// drop edit-state). Repeat truncates and resends the original text.
// ============================================================
const UserMsg = () => {
  const actions = React.useContext(UserMsgActionsContext);
  // Null-guarded selectors — see MessageRoleDispatch comment. Compact and
  // session-rotation paths can briefly desync the store from our messages
  // array; without the guard useMessage throws and crashes the boundary.
  const msgId = useMessage((s: any) => {
    try { return s.id; } catch { return null; }
  }) as string | null;
  const msgText = useMessage((s: any) => {
    try {
      const part = s.content.find((p: any) => p.type === 'text') as { type: 'text'; text: string } | undefined;
      return part?.text ?? '';
    } catch { return ''; }
  });
  if (msgId == null) return null;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Slash-command marker (e.g. /usage, /compact, /status). One-line, starts
  // with "/", no newlines. Render as a compact indigo/violet chip — visually
  // distinct from regular prompts (orange) so it reads as "this was a
  // system action, не обычный диалог". CLI behavior: команда живёт в
  // истории как маркер; output (Settings panel) рендерится в input-зоне и
  // не сохраняется. Edit/Repeat hover-buttons тоже не нужны — повтор
  // slash-команды лучше через композер заново.
  const trimmed = msgText.trim();
  const isSlashCommand = /^\/\w[\w-]*(?:\s|$)/.test(trimmed) && !trimmed.includes('\n');
  if (isSlashCommand) {
    return (
      <MessagePrimitive.Root className="flex justify-end py-1 px-1" data-msg-role="user-slash">
        <div
          className="inline-flex items-center px-2.5 py-1 rounded-md text-[0.85em] font-mono select-none"
          style={{
            background: 'rgba(129, 140, 248, 0.08)',
            color: '#a5b4fc',
            border: '1px solid rgba(129, 140, 248, 0.25)',
          }}
        >
          {trimmed}
        </div>
      </MessagePrimitive.Root>
    );
  }

  // Heuristic: ids that begin with one of the placeholder prefixes never made
  // it to JSONL (yet) and can't be safely truncated. Match the same set used
  // in the parent's isPersistedMsgId so the buttons hide instead of failing.
  const isPersisted = msgId && !/^(user-|streaming-|hist-|msg-|init-|error-)/.test(msgId);

  const startEdit = () => {
    setEditValue(msgText);
    setIsEditing(true);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        // Auto-grow once, then cursor at end.
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
  };

  const submitEdit = () => {
    const next = editValue.trim();
    if (!next) return;
    if (next === msgText.trim()) { setIsEditing(false); return; }
    actions?.onEdit(msgId, next);
    setIsEditing(false);
  };

  return (
    <MessagePrimitive.Root className="flex justify-end py-1.5 px-1 group" data-msg-role="user">
      {isEditing ? (
        // Edit-in-place: same right-aligned bubble width as the read-only view,
        // but a textarea + button row instead of static text. Cmd/Ctrl+Enter
        // submits, Esc cancels (matches Claude Code TUI muscle memory).
        <div className="w-[80%] max-w-[80%] bg-[#DA7756]/12 border border-[#DA7756]/40 rounded-xl rounded-br-sm px-3 py-2">
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(e) => {
              setEditValue(e.target.value);
              const ta = e.currentTarget;
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setIsEditing(false); }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(); }
            }}
            className="w-full bg-transparent text-[1em] text-[#e0e0e0] resize-none outline-none border-0 p-0 placeholder-[#666] min-h-[36px] max-h-[320px]"
            placeholder="Edit message…"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[0.77em]">
            <span className="text-[#888]">
              History below will be replaced. <span className="text-[#666]">⌘↵ to save, Esc to cancel.</span>
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="inline-flex items-center justify-center w-[24px] h-[24px] rounded-md cursor-pointer text-[#888] hover:text-white hover:bg-white/10 transition-colors"
                title="Cancel (Esc)"
              >
                <XIcon size={12} />
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={!editValue.trim() || actions?.busy}
                className="inline-flex items-center justify-center w-[24px] h-[24px] rounded-md cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-default"
                style={{
                  color: '#FFB382',
                  backgroundColor: 'rgba(255, 178, 130, 0.18)',
                }}
                title="Send (⌘↵)"
              >
                <Check size={12} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative max-w-[80%]">
          <div className="bg-[#DA7756]/12 border border-[#DA7756]/20 rounded-xl rounded-br-sm px-3 py-2">
            <MessagePrimitive.Content
              components={{ Text: UserTextPart }}
            />
          </div>
          {/* Hover action bar — Repeat & Edit. Anchored to top-LEFT edge of the
              bubble (bubble itself is right-aligned in viewport, so the buttons
              visually sit just outside its left edge, vertically aligned to the
              top of the message). 4px gap between buttons and bubble corner. */}
          {isPersisted && (
            <div
              className="absolute top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto"
              style={{ right: '100%', marginRight: '6px', zIndex: 5 }}
            >
              <div className="flex items-center gap-0.5 rounded-md bg-[#1a1a1a] border border-[#333] shadow-lg px-0.5 py-0.5">
                <button
                  type="button"
                  onClick={() => actions?.onRepeat(msgId)}
                  disabled={actions?.busy}
                  className="inline-flex items-center justify-center w-[20px] h-[20px] rounded cursor-pointer text-[#888] hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                  title="Repeat — drop replies, resend this message"
                >
                  <RefreshCw size={11} />
                </button>
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={actions?.busy}
                  className="inline-flex items-center justify-center w-[20px] h-[20px] rounded cursor-pointer text-[#888] hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
                  title="Edit — drop replies, send a new version of this message"
                >
                  <Pencil size={11} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </MessagePrimitive.Root>
  );
};

// Threshold above which a plain-text message gets a "Раскрыть полностью" toggle.
// Below this, full text always renders inline.
const USER_TEXT_COLLAPSE_THRESHOLD = 600;
const USER_TEXT_COLLAPSED_CHARS = 400;

// Collapsible plain-text block. Independent of <pasted_content> chips below —
// long inline-typed prompts also need truncation since SDK has no input length limit.
const CollapsibleText = ({ text }: { text: string }) => {
  const [expanded, setExpanded] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const onToggle = useStableCollapseToggle(anchorRef, () => setExpanded(v => !v));
  if (text.length <= USER_TEXT_COLLAPSE_THRESHOLD) {
    return <p className="text-[1em] text-[#e0e0e0] whitespace-pre-wrap break-words">{text}</p>;
  }
  const preview = text.slice(0, USER_TEXT_COLLAPSED_CHARS).trimEnd();
  // When expanded, also surface the toggle ABOVE the text — long prompts can
  // be 800+ chars (multiple screens on mobile), and scrolling all the way to
  // the bottom just to collapse is the kind of friction that turns "expand"
  // into "ok, never mind, I'll scroll past it instead".
  const ToggleButton = (
    <button
      type="button"
      onClick={onToggle}
      onMouseDown={(e) => e.preventDefault()}
      className="text-[0.85em] text-[#8ba4ff] hover:text-[#a8b8ff] cursor-pointer select-none"
    >
      {expanded
        ? 'Свернуть'
        : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
    </button>
  );
  return (
    <div ref={anchorRef}>
      {expanded && <div className="mb-1">{ToggleButton}</div>}
      <p className="text-[1em] text-[#e0e0e0] whitespace-pre-wrap break-words">
        {expanded ? text : preview + '…'}
      </p>
      <div className="mt-1">{ToggleButton}</div>
    </div>
  );
};

// User text part — parses <pasted_content> blocks into chips
const UserTextPart = ({ text }: { text: string }) => {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (!text.includes('<pasted_content>')) {
    return <CollapsibleText text={text} />;
  }

  // Split into regular text and pasted blocks
  const parts: Array<{ type: 'text' | 'paste'; content: string }> = [];
  let remaining = text;
  while (remaining.includes('<pasted_content>')) {
    const start = remaining.indexOf('<pasted_content>');
    const end = remaining.indexOf('</pasted_content>');
    if (end === -1) break;
    if (start > 0) parts.push({ type: 'text', content: remaining.slice(0, start).trim() });
    parts.push({ type: 'paste', content: remaining.slice(start + 16, end).trim() });
    remaining = remaining.slice(end + 17).trim();
  }
  if (remaining) parts.push({ type: 'text', content: remaining });

  return (
    <div className="space-y-1.5">
      {parts.map((p, i) => {
        if (p.type === 'text' && p.content) {
          return <CollapsibleText key={i} text={p.content} />;
        }
        if (p.type === 'paste') {
          const preview = p.content.slice(0, 60).replace(/\n/g, ' ') + (p.content.length > 60 ? '...' : '');
          const isExpanded = expandedId === i;
          return (
            <div key={i}>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[0.85em] bg-[#6B8AFF]/15 text-[#8ba4ff] border border-[#6B8AFF]/20 cursor-pointer hover:bg-[#6B8AFF]/25 max-w-[250px]"
                onClick={() => setExpandedId(isExpanded ? null : i)}
              >
                <span className="truncate">{preview}</span>
                <span className="text-[0.7em] text-[#666] shrink-0">{p.content.length.toLocaleString()}</span>
              </span>
              {isExpanded && (
                <pre className="mt-1 px-3 py-2 text-[0.85em] text-[#aaa] bg-[#1a1a1a] border border-[#333] rounded-lg max-h-[200px] overflow-y-auto whitespace-pre-wrap">{p.content}</pre>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
};

// ============================================================
// System message
// ============================================================
// Three flavors keyed by message text content:
//   1. "⏳ Compacting…" — active compact loader. Orange brand color, animated
//      pulse, elapsed seconds counter, indeterminate bar that loops every 2s.
//      SDK does not emit progress %, so we fake forward-motion via CSS keyframes.
//   2. "── Compacted · …" — post-compact divider. Subtle, but NOT the dimmest
//      possible grey — это значимое событие в треде, юзер хочет видеть метрики.
//   3. anything else — generic dim grey centered divider (legacy fallback).
const SystemMsg = () => {
  // Null-guarded — see MessageRoleDispatch comment about /compact sync gap.
  const text = useMessage((m: any) => {
    try {
      const txt = (m?.content || []).find((p: any) => p.type === 'text')?.text || '';
      return txt;
    } catch { return ''; }
  }) as string;

  if (text.startsWith('⏳ Compacting')) return <CompactingLoader />;

  if (text.startsWith('── Compacted')) {
    // Post-compact divider — left-aligned, mono, soft orange — событие
    // должно быть заметным в треде, не сливаться с grey-noise system'ом.
    return (
      <MessagePrimitive.Root className="py-2 pl-4 pr-1">
        <div className="text-[0.85em] text-[#a87356] font-mono select-none">
          {text}
        </div>
      </MessagePrimitive.Root>
    );
  }

  // Fallback — legacy generic system entry (rarely used now, ничего сюда не
  // попадает в нормальном flow).
  return (
    <MessagePrimitive.Root className="py-1">
      <div className="text-center text-[0.85em] text-[#555]">
        <MessagePrimitive.Content
          components={{ Text: ({ text }) => <span>{text}</span> }}
        />
      </div>
    </MessagePrimitive.Root>
  );
};

// Active compact loader: bright brand-orange title, elapsed timer, animated
// gradient bar (indeterminate — SDK не отдаёт реальный прогресс через API
// surface, только Ink CLI рендерит проценты через onCompactProgress hook,
// которого в Agent SDK нет). Bar — CSS keyframes слайдящийся блок поверх
// тёмного track'а, цикл 1.8s — даёт ощущение «работа идёт», без обмана
// конкретными цифрами.
const CompactingLoader = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, []);
  return (
    <MessagePrimitive.Root className="py-3 pl-4 pr-4">
      <div className="text-[0.92em] font-semibold text-[#DA7756] mb-1.5">
        Compacting conversation…
      </div>
      <div className="relative h-[6px] w-full rounded-full bg-[#1a1a1a] overflow-hidden">
        <div
          className="absolute h-full w-[40%] rounded-full"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, #DA7756 50%, transparent 100%)',
            animation: 'sdk-compact-bar 1.8s linear infinite',
          }}
        />
      </div>
      <div className="text-[0.77em] text-[#666] mt-1 font-mono tabular-nums">
        ~{elapsed}s elapsed
      </div>
    </MessagePrimitive.Root>
  );
};

// ============================================================
// Assistant message — markdown + tool calls + thinking
// ============================================================
// ============================================================
// VirtualizedMessages — Virtuoso wrapper that reads message COUNT from the
// assistant-ui store (not from caller props). Critical: useExternalStoreRuntime
// applies the renderer's `messages` prop into the thread store inside an effect,
// so on the first render the store is still empty. If we drove Virtuoso's
// `totalCount` directly from `filteredMessages.length`, the first paint would
// try MessageByIndexProvider(index=0) against a count-0 store → assistant-ui
// throws `tapClientLookup: Index 0 out of bounds (length: 0)`. Reading length
// from the store guarantees lock-step.
// ============================================================
interface VirtualizedMessagesProps {
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  onAtBottomChange: (atBottom: boolean) => void;
  onFirstPaint?: () => void;
  components: {
    UserMessage: React.FC;
    AssistantMessage: React.FC;
    SystemMessage: React.FC;
  };
}

// Custom Virtuoso Scroller. Two reasons it must exist at module scope (not
// inlined per render): (1) Virtuoso remounts the scroller subtree if the
// Scroller component identity changes, losing scroll position; (2) we attach
// onMouseDown.preventDefault to suppress the native focus transfer that
// would otherwise yank focus from the composer textarea.
//
// preventDefault is UNCONDITIONAL on this scroller because every descendant
// inside the chat list is non-form (divs, paragraphs, spans) — none of them
// rely on the native click→focus transition. Earlier attempt used
// `if (e.target === e.currentTarget) e.preventDefault()` (the pattern from
// the research report) — but logs proved it fires only for clicks on the
// bare scroller chrome; clicks on bubble children bubble up and the browser
// nevertheless focuses the scroller on the click pipeline. Unconditional
// preventDefault on mousedown blocks that focus transition globally for the
// scroller while leaving drag-to-select and child click handlers intact
// (selection works via mousemove + mouseup, both fire normally).
//
// Buttons/links/inputs inside bubbles still work because they have their own
// mousedown handlers that don't bubble preventDefault retroactively, and
// because mousedown.preventDefault on a parent does NOT prevent a child
// form-control from receiving focus on its own mousedown.
// Custom scroller: NO tabindex attribute → element is not click-focusable
// per WHATWG/Blink. This is the canonical Slack/Mattermost/Discord pattern,
// confirmed by deep research:
//   * `defaultPrevented` is a single monolithic gate in Blink's
//     MouseEventManager → cancelling mousedown cancels BOTH click-focus and
//     selection-start, no spec-level way to separate them.
//   * tabindex="-1" is STILL click-focusable per WHATWG (`IsMouseFocusable`).
//   * Only a <div> with no tabindex at all is non-click-focusable. This is
//     what Slack's `.c-virtual_list__scroll_container` does.
//
// Result: clicking inside the scroller → no focus transition → textarea
// keeps focus → no blur → selection works natively → composer remains active.
// PageUp/PageDown navigation can be added later via window/composer keydown
// handlers (Slack pattern); not blocking us right now.
//
// The `onMouseDown` guard scoped to `e.target === e.currentTarget` is a
// belt-and-braces defense against future regressions on the scroller's
// gutter/padding (where browser might still try to do something).
const SDKScroller: NonNullable<VirtuosoProps<unknown, unknown>['components']>['Scroller'] =
  React.forwardRef(({ style, tabIndex: _virtuosoTi, ...props }: any, ref: any) => (
    // We DROP Virtuoso's tabIndex={0} (destructured to _virtuosoTi and
    // intentionally NOT forwarded). The plain <div> with no tabindex attribute
    // is non-click-focusable per WHATWG — exactly what we need.
    <div
      ref={ref}
      style={style}
      {...props}
      onMouseDown={(e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) e.preventDefault();
        props.onMouseDown?.(e);
      }}
    />
  ));
const VirtualizedMessages = memo(function VirtualizedMessages({ virtuosoRef, onAtBottomChange, onFirstPaint, components }: VirtualizedMessagesProps) {
  const length = useAuiState((s: any) => s.thread.messages.length);
  // Same dispatcher logic as ThreadMessageComponent in assistant-ui core —
  // pick the right component by role of the message at this index. Wrapping
  // each item in MessageByIndexProvider makes MessagePrimitive.Root / Content
  // resolve to *this* index when child UserMsg/AssistantMsg run their selectors.
  const renderItem = useCallback((index: number) => (
    <MessageByIndexProvider index={index}>
      <MessageRoleDispatch components={components} />
    </MessageByIndexProvider>
  ), [components]);
  if (length === 0) return null;
  return (
    <Virtuoso
      ref={virtuosoRef}
      style={{ flex: '1 1 0%', minHeight: 0 }}
      totalCount={length}
      itemContent={renderItem}
      components={{ Scroller: SDKScroller }}
      // Initial: open at the LAST message (we want to see tail first).
      // Once user scrolls up, Virtuoso preserves position across re-renders.
      initialTopMostItemIndex={length > 0 ? length - 1 : 0}
      // followOutput="auto": if user is at bottom, follow new messages; otherwise
      // keep their scroll position. This replaces the manual atBottom + scrollTop
      // = scrollHeight effect we used to have (which broke scrolling up because
      // it fired on every parent re-render).
      followOutput="auto"
      atBottomStateChange={onAtBottomChange}
      itemsRendered={onFirstPaint ? (items) => { if (items && items.length > 0) onFirstPaint(); } : undefined}
      increaseViewportBy={{ top: 800, bottom: 800 }}
      skipAnimationFrameInResizeObserver
    />
  );
});

// Reads role of the current message (via the MessageByIndexProvider context)
// and renders the matching component. Mirrors the internal ThreadMessageComponent
// from @assistant-ui/core but lives in our tree so the Virtuoso item is a single
// React element (better key stability + memoization).
function MessageRoleDispatch({ components }: { components: VirtualizedMessagesProps['components'] }) {
  // Sync-window guard: assistant-ui's store is repopulated via
  // useExternalStoreRuntime in an effect — between our setMessages() and the
  // store sync, Virtuoso can briefly ask for an index that no longer exists
  // (e.g. during /compact: live-stream shrinks `messages`, store still
  // reports the old totalCount for one tick). Без selector-guard'а
  // useAuiState вылетает с tapClientLookup throw — здесь читаем role через
  // try-in-selector: если внутренний lookup упал — возвращаем null-marker,
  // Virtuoso перерисует item следующим кадром с актуальным totalCount.
  const role = useAuiState((s: any) => {
    try { return s.message.role; } catch { return null; }
  }) as string | null;
  if (role == null) return null;
  if (role === 'user') return <components.UserMessage />;
  if (role === 'system') return <components.SystemMessage />;
  // Unknown roles (e.g. SDK 'attachment' records) are pre-filtered upstream by
  // ClaudeSDKTab.filteredMessages — they never reach this point. The default
  // here only handles assistant; anything else means upstream filter regressed.
  return <components.AssistantMessage />;
}

// [SDKMsgRender] Diagnostic counter for AssistantMsg renders — only logs in
// dev when the rate exceeds normal (>50 renders in 200ms = sign of mass
// reconciliation). After virtualization landed (May 2026) we expect ~10-30
// renders per visible-flip, not 744; this is a regression sensor.
const _sdkMsgRenderCounter = { count: 0, lastLogTs: 0, lastBatchSize: 0 } as { count: number; lastLogTs: number; lastBatchSize: number };

// Module-level metrics cache for compact-summary bubbles. We can't carry
// custom fields through assistant-ui's ThreadMessageLike, so attach by id
// here and look up in CompactSummaryMsg via useMessage.id.
const _compactMetricsByMsgId = new Map<string, NonNullable<SDKChatMessage['compactMetrics']>>();
function setCompactMetricsForMsg(id: string, m: NonNullable<SDKChatMessage['compactMetrics']>) {
  _compactMetricsByMsgId.set(id, m);
}
function getCompactMetricsForMsg(id: string): NonNullable<SDKChatMessage['compactMetrics']> | null {
  return _compactMetricsByMsgId.get(id) || null;
}

// Module-level slash-commands cache. Captured from `system:init` event of any
// live SDK session — it includes the full per-session slash_commands manifest
// (which throw-away probe-query misses because it has no session/model
// context). Per-tab key so different sessions can have different lists.
type SlashCmd = { name: string; description: string; argumentHint?: string; aliases?: string[] };
const _slashCommandsByTab = new Map<string, SlashCmd[]>();
const _slashCommandListeners = new Set<() => void>();
function setSlashCommandsForTab(tabId: string, cmds: SlashCmd[]) {
  _slashCommandsByTab.set(tabId, cmds);
  _slashCommandListeners.forEach(fn => { try { fn(); } catch {} });
}
function getSlashCommandsForTab(tabId: string): SlashCmd[] {
  return _slashCommandsByTab.get(tabId) || [];
}
function subscribeSlashCommands(fn: () => void): () => void {
  _slashCommandListeners.add(fn);
  return () => _slashCommandListeners.delete(fn);
}
function bumpMsgRender() {
  _sdkMsgRenderCounter.count++;
  const now = performance.now();
  if (now - _sdkMsgRenderCounter.lastLogTs > 200) {
    const delta = _sdkMsgRenderCounter.count - _sdkMsgRenderCounter.lastBatchSize;
    if (delta > 50) {
      console.warn('[SDKMsgRender] batchSize=' + delta + ' totalSinceLoad=' + _sdkMsgRenderCounter.count);
    }
    _sdkMsgRenderCounter.lastLogTs = now;
    _sdkMsgRenderCounter.lastBatchSize = _sdkMsgRenderCounter.count;
  }
}

const AssistantMsg = () => {
  bumpMsgRender();
  // Discriminate by id prefix — compact-summary entries ride on assistant
  // role (assistant-ui doesn't allow custom roles) but render in a totally
  // different layout: orange CompactSummaryMsg with collapsible long text.
  // useMessage selector is null-guarded — same sync-window throw protection
  // as MessageRoleDispatch (see comment there). During /compact the store
  // is briefly out-of-sync with our messages array.
  const id = useMessage((s: any) => {
    try { return s.id; } catch { return null; }
  }) as string | null;
  if (id == null) return null;
  if (id.startsWith('compact-summary-')) {
    return <CompactSummaryMsg />;
  }

  // Copy button: sticky pin that follows the viewport while ANY part of this
  // assistant message is on screen — same pattern as Claude.ai / ChatGPT.
  return (
    <MessagePrimitive.Root
      className="py-2 pl-4 pr-1 relative group rounded-md transition-colors has-[.aui-copy-trigger:hover]:bg-[#151515]"
      data-msg-role="assistant"
    >
      <div className="sticky top-1 z-10 float-right h-0">
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton />
        </ActionBarPrimitive.Root>
      </div>
      <MessagePrimitive.Content
        components={{
          Text: AssistantTextPart,
          Reasoning: ReasoningPart,
          tools: { Fallback: ToolCallPart },
        }}
      />
    </MessagePrimitive.Root>
  );
};

// Compact-summary bubble: assistant-style left-aligned card в orange
// brand-color (Claude-coded под /compact). Длинный текст (типичный summary
// 5-30K char'ов) рендерим через collapsible-pattern с toggle вверху и внизу
// — повторяет тот же UX что у CollapsibleText для user-промптов > 600 char.
// Внизу footer-line с метриками (pre/post tokens, duration) если они есть.
const COMPACT_COLLAPSED_CHARS = 600;
const CompactSummaryMsg = () => {
  // ALL hooks must run unconditionally — early return after hook calls
  // breaks rules-of-hooks and silently crashes the component (React
  // mismatches hook order across renders → state corrupt). Null-guard moved
  // BELOW hook section.
  const id = useMessage((s: any) => {
    try { return s.id; } catch { return null; }
  }) as string | null;
  const text = useMessage((s: any) => {
    try {
      const t = (s.content || []).find((p: any) => p.type === 'text');
      return t?.text || '';
    } catch { return ''; }
  }) as string;
  const [expanded, setExpanded] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const onToggle = useStableCollapseToggle(anchorRef, () => setExpanded(v => !v));
  if (id == null) return null;
  const metrics = getCompactMetricsForMsg(id);
  const needsCollapse = text.length > COMPACT_COLLAPSED_CHARS;
  const preview = text.slice(0, COMPACT_COLLAPSED_CHARS).trimEnd();
  const k = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  const s = metrics ? Math.round(metrics.durationMs / 1000) : 0;

  const Toggle = needsCollapse ? (
    <button
      type="button"
      onClick={onToggle}
      onMouseDown={(e) => e.preventDefault()}
      className="text-[0.85em] cursor-pointer select-none"
      style={{ color: '#FFB382' }}
    >
      {expanded ? 'Свернуть' : `Раскрыть полностью (${text.split('\n').length.toLocaleString()} строк)`}
    </button>
  ) : null;

  return (
    <MessagePrimitive.Root className="py-2 pl-4 pr-4" data-msg-role="compact-summary">
      <div
        ref={anchorRef}
        className="relative rounded-md p-3"
        style={{
          background: 'rgba(218,119,86,0.06)',
          border: '1px solid rgba(218,119,86,0.30)',
        }}
      >
        {/* Header — brand-orange "Compact summary" label + metrics chip */}
        <div className="flex items-center justify-between mb-2 gap-3">
          <span className="text-[0.85em] font-semibold uppercase tracking-wide" style={{ color: '#DA7756' }}>
            Compact summary
          </span>
          {metrics && (
            <span className="text-[0.77em] font-mono" style={{ color: '#a87356' }}>
              {k(metrics.preTokens)} → {k(metrics.postTokens)} tokens · {s}s
            </span>
          )}
        </div>

        {/* Top toggle — when expanded, mirrors the pattern from CollapsibleText
            (user-prompt > 600 chars): toggle вверху ТОЛЬКО когда раскрыт, чтобы
            можно было быстро свернуть длинный текст без скролла до низа. */}
        {needsCollapse && expanded && <div className="mb-2">{Toggle}</div>}

        <div className="text-[1em] whitespace-pre-wrap break-words" style={{ color: '#d4d4d4', lineHeight: '1.45' }}>
          {needsCollapse && !expanded ? preview + '…' : text}
        </div>

        {/* Bottom toggle — both collapsed and expanded states (in collapsed
            it's the only toggle, in expanded it's the second one for long
            content reachability). */}
        {needsCollapse && <div className="mt-2">{Toggle}</div>}
      </div>
    </MessagePrimitive.Root>
  );
};

// ---- Text part: markdown rendering (skip empty) ----
// Density + font matched to Claude Code CLI (Ink terminal). CLI рендерится
// MONOSPACE'ом — фиксированная сетка обеспечивает читаемость без любого
// letter-spacing. Раньше пытался использовать пропорциональный шрифт с
// зажатым tracking'ом → давка на кириллице («эвристики», «Период», «hook»
// становились нечитаемыми). Перешёл на тот же JetBrainsMono Nerd Font что
// рендерит сам терминал (xterm.js, см. CSS @font-face в renderer/index.css)
// — тогда визуал реально как CLI, не маскировка под него.
//
// Density: inter-block gap = одна пустая строка (~1em ≈ 13px), <li> идут
// встык (margin 0), line-height 1.45 (моноширинному CLI хватает 1.0, в
// браузере 1.45 даёт ровно те же визуальные расстояния как одна Ink-строка
// с её implicit gap'ом). Tailwind `prose-sm` defaults (my-3.5, leading
// 1.625, list pl-6) растягивают то же содержание в 2-3 раза против CLI.
//
// Color contract (matches CLI Ink + GitHub dark palette): заголовки тем же
// цветом что body — выделяются только bold-весом, как Ink (`<Text bold>`),
// не цветом. Раньше явный `text-[#e8e8e8]` (=232) на body `#d4d4d4` (=212)
// «кричал» — двойной сигнал (ярче + жирнее) на одной иерархической ступени.
// Inline/block code — `#0d0d0d` (ниже фона bubble #151515 hover) для
// GitHub-dark contrast: фон кода ТЕМНЕЕ окружения, не светлее.
const AssistantTextPart = ({ text }: { text: string }) => {
  if (!text.trim()) return null;
  return (
    <div
      className="prose prose-invert prose-sm max-w-none text-[1em] prose-headings:font-semibold prose-h1:text-[1.15em] prose-h1:mt-2 prose-h1:mb-0.5 prose-h1:font-bold prose-h2:text-[1.08em] prose-h2:mt-2 prose-h2:mb-0.5 prose-h3:text-[1em] prose-h3:mt-1.5 prose-h3:mb-0 prose-h4:text-[1em] prose-h4:mt-1.5 prose-h4:mb-0 prose-h5:text-[1em] prose-h5:mt-1.5 prose-h5:mb-0 prose-h6:text-[1em] prose-h6:mt-1.5 prose-h6:mb-0 prose-p:my-1 prose-p:leading-snug prose-ul:my-1 prose-ul:pl-4 prose-ol:my-1 prose-ol:pl-4 prose-li:my-0 prose-li:leading-snug prose-li:pl-0 [&_li>p]:my-0 [&_li_>_*]:my-0 [&_ul_ul]:my-0 [&_ol_ol]:my-0 [&_ul_ol]:my-0 [&_ol_ul]:my-0 prose-headings:text-inherit prose-strong:text-inherit prose-strong:font-semibold marker:text-[#666]"
      style={{
        color: '#d4d4d4',
        lineHeight: '1.45',
        fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark as any} language={match[1]} PreTag="div"
                  customStyle={{ margin: '8px 0', borderRadius: '8px', fontSize: '0.92em', padding: '12px', backgroundColor: '#0d0d0d', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
            }
            // Code bg ниже окружающего bubble: bubble-base = transparent,
            // bubble-hover = #151515 → код #0d0d0d читается как «врезка»
            // независимо от состояния hover. Text #d4d4d4 = body color
            // (одинаковый цвет на тексте и в коде, разница только в фоне +
            // шрифте). GitHub dark inline-code контракт.
            return <code className="bg-[#0d0d0d] px-1.5 py-0.5 rounded text-[0.92em] text-[#d4d4d4] border border-white/5" {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};

// ---- Reasoning/thinking part ----
// Visual: collapsed by default, click to expand. Brain icon + "thinking · <effort>"
// title (lowercased), chevron rotates on open. Body is italic body-size text on a
// subtly-tinted background (not the muted-gray-on-dark void that blended with the
// rest of the UI). Border `white/10` + bg `white/[0.02]` is the established
// "subtle card, distinct from prose" pattern from Vercel AI Elements / Zed.
const ReasoningPart = ({ text }: { text: string }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const onToggle = useStableCollapseToggle(anchorRef, () => setOpen(v => !v));
  const effort = useWorkspaceStore((s) => {
    const activeTabId = s.openProjects.get(s.activeProjectId || '')?.activeTabId;
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t) return (t.sdkEffort || 'high').toLowerCase();
    }
    return null;
  });
  return (
    <div ref={anchorRef} className="my-2 mr-[60px] rounded-lg border border-white/10 overflow-hidden bg-white/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        onMouseDown={(e) => e.preventDefault()}
        className="flex w-full items-center gap-2 px-3 py-2 text-[0.92em] text-[#bdbdbd] hover:text-white hover:bg-white/[0.04] transition-colors cursor-pointer select-none"
      >
        <ChevronRight
          size={12}
          className="text-[#888] transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        />
        <Brain size={13} className="text-[#a78bfa]" />
        <span className="font-medium">thinking{effort ? ` · ${effort}` : ''}</span>
      </button>
      {open && (
        <div className="px-4 py-3 border-t border-white/10 bg-white/[0.015]">
          <div className="text-[1em] italic leading-relaxed text-[#d4d4d4] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {text}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// Tool call rendering — dispatcher + specialised cards
// ============================================================
// Rendering strategy: each tool gets its own card layout (Bash → shell block,
// Read → header + preview, Edit/Write → diff). Shared chrome lives in
// <ToolCard>. Anything we don't have a specialisation for falls back to the
// previous compact one-line pill.

const TOOL_BG = 'rgba(255,255,255,0.025)';
const TOOL_BORDER = 'rgba(255,255,255,0.08)';

type ToolStatus = 'running' | 'done' | 'error';
function toolStatusFrom(result: any, isError?: boolean): ToolStatus {
  if (isError) return 'error';
  if (result === undefined || result === null) return 'running';
  return 'done';
}

function StatusDot({ status }: { status: ToolStatus }) {
  if (status === 'running') return <Loader2 size={11} className="animate-spin text-[#DA7756]" />;
  if (status === 'error') return <span className="inline-block w-[8px] h-[8px] rounded-full bg-[#ef4444]" />;
  return <span className="inline-block w-[8px] h-[8px] rounded-full bg-[#4ade80]" />;
}

// Toggle a collapsible block WITHOUT shifting the visible scroll position.
// Mechanism (no visible jerk):
//   1. Snapshot anchor.top + whether the user is pinned to the scroll-bottom.
//   2. flushSync(toggle) — applies the state update synchronously, layout is
//      recalculated before this returns, but the browser HASN'T painted yet.
//   3. Compensate scrollTop inside the same task. The browser paints exactly
//      ONE frame containing both the new content AND the adjusted scroll —
//      so the user never sees the intermediate "expanded but not scrolled"
//      state that requestAnimationFrame produced.
//
// Why flushSync, not useLayoutEffect: the hook is generic, fired from a click
// handler on a wrapper component. We don't control the consumer's state, so
// we can't hang a layout-effect off "state X changed". flushSync gives us
// the same single-paint guarantee from inside the click handler itself.
//
// wasAtBottom rule: if the user was within 4px of scroll-bottom before the
// click, scroll the new bottom into view after expand — keeps the composer
// visible (matches Claude TUI: bottom-pinned input). Otherwise hold the
// anchor steady so the clicked block stays where the eye was.
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement || null;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}
const BOTTOM_PIN_PX = 4;
function useStableCollapseToggle(
  anchorRef: React.RefObject<HTMLElement | null>,
  toggle: () => void
) {
  return useCallback(() => {
    const el = anchorRef.current;
    const scroller = findScrollParent(el);
    if (!el || !scroller) { toggle(); return; }
    // Capture top-of-anchor position BEFORE expand. After expand we want
    // this same point at the same viewport-Y. Внутри Virtuoso вычисление
    // delta через getBoundingClientRect.top после flushSync НЕ работает —
    // Virtuoso re-measure'ит item через ResizeObserver в следующем кадре,
    // на момент read'а size ещё старый, delta=0, и при следующем RO-цикле
    // Virtuoso хайпом смещает контент относительно scrollTop. Лекарство:
    // НЕ полагаться на anchorY-после-expand, а сделать `scrollIntoView`
    // через rAF, чтобы Virtuoso успел перемерить → block:'start'
    // гарантирует что top expanded-блока сядет точно где был anchor до клика.
    const anchorTopBefore = el.getBoundingClientRect().top;
    const scrollerTopBefore = scroller.getBoundingClientRect().top;
    const targetOffsetFromScroller = anchorTopBefore - scrollerTopBefore;
    flushSync(() => { toggle(); });
    // Two rAFs: first lets React + Virtuoso commit/measure, second is when
    // ResizeObserver has emitted и known-size обновлён. После этого
    // вычисляем смещение и компенсируем — anchor возвращается на ту же
    // viewport-Y что была до клика.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el2 = anchorRef.current;
        if (!el2) return;
        const newAnchorTop = el2.getBoundingClientRect().top;
        const newScrollerTop = scroller.getBoundingClientRect().top;
        const newOffsetFromScroller = newAnchorTop - newScrollerTop;
        const delta = newOffsetFromScroller - targetOffsetFromScroller;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      });
    });
  }, [anchorRef, toggle]);
}

// Generic card chrome — header (always visible) + optional body. Header is
// click-to-toggle when `collapsible` is true.
// Header API: takes an icon and TWO text rows. Row-1 is the small uppercase
// label + counts/badges (always rendered on one line, centred against chevron
// & status-dot). Row-2 is the full path / command / query — can wrap, never
// truncates. Splitting them keeps the click-baseline stable regardless of how
// long row-2 grows.
const ToolCard: React.FC<{
  status: ToolStatus;
  icon: React.ReactNode;
  labelRow: React.ReactNode; // small uppercase: "READ", "BASH", "+3 −1" badges
  detailRow?: React.ReactNode; // path / command / query — monospace, wraps
  body?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}> = ({ status, icon, labelRow, detailRow, body, collapsible = true, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const cardRef = useRef<HTMLDivElement>(null);
  const hasBody = body !== undefined && body !== null && body !== false;
  const handleToggle = useStableCollapseToggle(cardRef, () => setOpen(v => !v));
  return (
    <div
      ref={cardRef}
      className="my-2 mr-[60px] rounded-md overflow-hidden"
      style={{ background: TOOL_BG, border: `1px solid ${TOOL_BORDER}` }}
    >
      <div
        className={hasBody && collapsible ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : ''}
        onClick={hasBody && collapsible ? handleToggle : undefined}
      >
        {/* Row 1: chevron · status · icon · uppercase label — all baseline-aligned */}
        <div className="flex items-center gap-2 px-3 py-1.5 min-h-[28px]">
          {hasBody && collapsible ? (
            <ChevronRight
              size={12}
              className="shrink-0 text-[#888] transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : 'none' }}
            />
          ) : (
            <span className="w-[12px] shrink-0" />
          )}
          <span className="shrink-0 inline-flex items-center justify-center w-[10px]"><StatusDot status={status} /></span>
          <span className="shrink-0 inline-flex items-center text-[#bdbdbd]">{icon}</span>
          <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">{labelRow}</div>
        </div>
        {/* Row 2: detail (path / command / query) — full width, monospace, wraps */}
        {detailRow && (
          <div className="px-3 pb-1.5 pl-[58px] text-[1em] font-mono text-[#e0e0e0] break-all leading-snug">
            {detailRow}
          </div>
        )}
      </div>
      {hasBody && open && (
        <div className="border-t" style={{ borderColor: TOOL_BORDER }}>
          {body}
        </div>
      )}
    </div>
  );
};

// ---- Bash ----
const BashCard: React.FC<{ args: Record<string, any>; result: any; status: ToolStatus }> = ({ args, result, status }) => {
  const cmd: string = args.command || '';
  const description: string = args.description || '';
  const resultText = typeof result === 'string' ? result : (result == null ? '' : JSON.stringify(result));
  const labelRow = (
    <>
      <span className="text-[0.92em] font-medium text-[#bdbdbd] uppercase tracking-wide">Bash</span>
      {description && <span className="text-[0.85em] text-[#888] truncate">{description}</span>}
    </>
  );
  const detailRow = cmd || <span className="italic text-[#666]">(no command)</span>;
  const body = resultText ? (
    <SyntaxHighlighter
      language="bash"
      style={oneDark as any}
      PreTag="div"
      customStyle={{ margin: 0, padding: '10px 12px', background: '#0f0f0f', fontSize: '0.92em', maxHeight: '180px', overflow: 'auto' }}
      codeTagProps={{ style: { fontFamily: 'inherit' } }}
    >
      {resultText}
    </SyntaxHighlighter>
  ) : null;
  return <ToolCard status={status} icon={<TerminalIcon size={13} />} labelRow={labelRow} detailRow={detailRow} body={body} defaultOpen={false} />;
};

// ---- Read ----
// Body holds full content in a single scroll container — no preview+toggle
// because the SyntaxHighlighter already caps height with overflow:auto, so a
// "show more" button below would just duplicate what scrolling already does.
// Click cost without information gain == redundant affordance.
const ReadCard: React.FC<{ args: Record<string, any>; result: any; status: ToolStatus }> = ({ args, result, status }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);
  const raw = typeof result === 'string' ? result : (result == null ? '' : JSON.stringify(result));
  const content = raw.replace(/\n+$/, '');
  const lines = content ? content.split('\n') : [];
  const labelRow = (
    <>
      <span className="text-[0.92em] font-medium text-[#bdbdbd] uppercase tracking-wide">Read</span>
      {lines.length > 0 && (
        <span className="text-[0.77em] text-[#666] font-mono tabular-nums">{lines.length} lines</span>
      )}
    </>
  );
  const detailRow = path || <span className="italic text-[#666]">(no path)</span>;
  const body = content ? (
    <SyntaxHighlighter
      language={lang}
      style={oneDark as any}
      PreTag="div"
      customStyle={{ margin: 0, padding: '10px 12px', background: '#0f0f0f', fontSize: '0.92em', maxHeight: '320px', overflow: 'auto' }}
      codeTagProps={{ style: { fontFamily: 'inherit' } }}
    >
      {content}
    </SyntaxHighlighter>
  ) : null;
  return <ToolCard status={status} icon={<FileText size={13} />} labelRow={labelRow} detailRow={detailRow} body={body} defaultOpen={false} />;
};

// ---- Edit / Write ----
// Edit: diff old_string → new_string with red/green line bg.
// Write: all lines as adds (the whole file is new).
// MultiEdit: render each edit as its own diff hunk.
// No expand-toggle: the container already has max-h + overflow-y:auto, so
// "show all N lines" would just duplicate what scrolling already does. Same
// logic as ReadCard — redundant click on top of native scroll.

function DiffLines({ entries, language }: { entries: DiffEntry[]; language: string }) {
  return (
    <div>
      <div className="font-mono text-[0.92em] leading-[1.55] max-h-[320px] overflow-y-auto bg-[#0f0f0f]" data-diff-lang={language}>
        {entries.map((e, idx) => {
          const bg = e.tag === 'add' ? 'rgba(74, 222, 128, 0.10)' : e.tag === 'del' ? 'rgba(239, 68, 68, 0.10)' : 'transparent';
          const color = e.tag === 'add' ? '#86efac' : e.tag === 'del' ? '#fca5a5' : '#888';
          const sign = e.tag === 'add' ? '+' : e.tag === 'del' ? '-' : ' ';
          return (
            <div key={idx} className="flex" style={{ background: bg }}>
              <span className="select-none w-[20px] shrink-0 text-center" style={{ color }}>{sign}</span>
              <span className="whitespace-pre-wrap break-all flex-1 pr-3" style={{ color: e.tag === 'eq' ? '#888' : '#e0e0e0' }}>
                {e.line || ' '}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EditCard: React.FC<{ toolName: string; args: Record<string, any>; status: ToolStatus }> = ({ toolName, args, status }) => {
  const path: string = args.file_path || args.path || '';
  const lang = detectLanguage(path);

  // Build diff entries based on the specific tool variant.
  const diff: DiffEntry[] = React.useMemo(() => {
    if (toolName === 'Write') {
      // Whole file is a new addition.
      const content = (args.content || '') as string;
      return content ? content.split('\n').map(line => ({ tag: 'add' as const, line })) : [];
    }
    if (toolName === 'MultiEdit') {
      const edits: Array<{ old_string?: string; new_string?: string }> = Array.isArray(args.edits) ? args.edits : [];
      const out: DiffEntry[] = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const hunk = lineDiff(e.old_string || '', e.new_string || '');
        if (i > 0) out.push({ tag: 'eq', line: '─'.repeat(40) });
        out.push(...hunk);
      }
      return out;
    }
    // Edit
    return lineDiff(args.old_string || '', args.new_string || '');
  }, [toolName, args]);

  const { added, removed } = countDiffStats(diff);
  const verb = toolName === 'Write' ? 'Write' : toolName === 'MultiEdit' ? 'MultiEdit' : 'Update';

  const labelRow = (
    <>
      <span className="text-[0.92em] font-medium text-[#bdbdbd] uppercase tracking-wide">{verb}</span>
      {(added > 0 || removed > 0) && (
        <span className="text-[0.85em] font-mono tabular-nums">
          {added > 0 && <span className="text-[#4ade80]">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-[#ef4444]">−{removed}</span>}
        </span>
      )}
    </>
  );
  const detailRow = path || <span className="italic text-[#666]">(no path)</span>;
  const body = diff.length > 0 ? <DiffLines entries={diff} language={lang} /> : null;
  // Edit/Write defaultOpen=true — the diff is the whole point of the call.
  return <ToolCard status={status} icon={<FileEdit size={13} />} labelRow={labelRow} detailRow={detailRow} body={body} defaultOpen={true} />;
};

// ---- Fallback for anything else (Glob, Grep, WebSearch, MCP, etc.) ----
const GenericToolCard: React.FC<{ toolName: string; args: Record<string, any>; result: any; status: ToolStatus }> = ({ toolName, args, result, status }) => {
  const icon = TOOL_ICON[toolName] || <TerminalIcon size={13} />;
  const summary = (() => {
    if (toolName === 'Glob') return args.pattern || '';
    if (toolName === 'Grep') return args.pattern || '';
    if (toolName === 'WebSearch' || toolName === 'WebFetch') return args.query || args.url || '';
    if (typeof args === 'object' && args) {
      const first = Object.values(args).find(v => typeof v === 'string') as string | undefined;
      return first ? first.slice(0, 200) : '';
    }
    return '';
  })();
  const resultText = result == null ? '' : (typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  const labelRow = (
    <span className="text-[0.92em] font-medium text-[#bdbdbd] uppercase tracking-wide truncate">{toolName}</span>
  );
  const detailRow = summary || null;
  const body = resultText ? (
    <pre className="m-0 px-3 py-2 text-[0.92em] text-[#bdbdbd] font-mono whitespace-pre-wrap break-all bg-[#0f0f0f] max-h-[180px] overflow-y-auto">{resultText}</pre>
  ) : null;
  return <ToolCard status={status} icon={icon} labelRow={labelRow} detailRow={detailRow} body={body} defaultOpen={false} />;
};

// ---- Dispatcher ----
const ToolCallPart = ({ toolName, args, result, isError }: { toolName: string; args: Record<string, any>; argsText: string; toolCallId: string; result?: any; isError?: boolean }) => {
  const status = toolStatusFrom(result, isError);
  if (toolName === 'Bash') return <BashCard args={args} result={result} status={status} />;
  if (toolName === 'Read') return <ReadCard args={args} result={result} status={status} />;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return <EditCard toolName={toolName} args={args} status={status} />;
  }
  return <GenericToolCard toolName={toolName} args={args} result={result} status={status} />;
};

// ============================================================
// Copy button with checkmark feedback
// ============================================================
function CopyButton() {
  const [copied, setCopied] = useState(false);
  return (
    <ActionBarPrimitive.Copy
      className="aui-copy-trigger text-[0.77em] px-1.5 py-0.5 rounded bg-[#1a1a1a] hover:bg-[#2a2a2a] cursor-pointer border border-[#333] transition-colors"
      style={{ color: copied ? '#4ade80' : '#555' }}
      onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }}
    >
      {copied ? '✓' : 'Copy'}
    </ActionBarPrimitive.Copy>
  );
}

// ============================================================
// Paste chip type
// ============================================================
interface PasteChip {
  id: string;
  text: string;
  preview: string; // first 60 chars
}

const PASTE_THRESHOLD = 500; // chars — above this, create a chip instead of inline paste

// ============================================================
// Composer with paste chips
// ============================================================
// Window inside which a second Ctrl+C escalates to "stop session" (matches
// Claude TUI muscle memory — first press clears input, second press exits).
const CTRLC_DOUBLE_WINDOW_MS = 2000;

// ============================================================
// Slash-command overlay — replaces the composer with a fullscreen-ish panel
// showing the command output, как в Claude Code CLI Settings UI. Не сохраняется
// в thread — закрывается по Esc/Ctrl+C/Ctrl+[, после чего юзер снова видит
// композер. Top-bar показывает имя команды, hint про закрытие, и pill с
// model/context — чтобы юзер не терял ориентир пока внутри overlay'я.
function SlashCommandOverlay({
  cmd,
  output,
  isRunning,
  onClose,
  costSummary,
  modelLabel,
  contextPercent,
  sessionId,
}: {
  cmd: string;
  output: string;
  isRunning: boolean;
  onClose: () => void;
  costSummary: { totalUSD: number; durationMs: number; numTurns: number };
  modelLabel: string | null;
  contextPercent: number | null;
  sessionId: string | null;
}) {
  const showLoader = isRunning && !output;
  const fmtDuration = (ms: number) => {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
  };
  return (
    <div
      className="border-t border-[#2a2a2a] bg-[#0d0d0d] flex flex-col"
      style={{ height: 500 }}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1f1f1f] shrink-0">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[0.92em] text-[#a5b4fc]">/{cmd}</span>
          <span className="text-[0.77em] text-[#666]">{showLoader ? 'loading…' : 'output'}</span>
        </div>
        <div className="flex items-center gap-2 text-[0.77em] text-[#666]">
          {modelLabel && <span>[{modelLabel}]</span>}
          {contextPercent != null && (
            <span className="font-mono tabular-nums" style={{ color: contextPercent > 90 ? '#ef4444' : contextPercent > 75 ? '#f59e0b' : '#7a7a7a' }}>
              {contextPercent.toFixed(0)}%
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-2 px-2 py-0.5 rounded text-[0.77em] text-[#888] hover:text-white hover:bg-white/10 transition-colors cursor-pointer border border-[#333]"
            title="Close (Esc / Ctrl+C / Ctrl+[)"
          >
            Esc
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 text-[#d4d4d4] text-[0.92em] leading-snug" style={{ fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace' }}>
        {showLoader ? (
          <div className="text-[#888] italic">Waiting for SDK response…</div>
        ) : output ? (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono">{output}</pre>
        ) : (
          <div className="text-[#666]">No output yet — SDK не вернул содержимого для /{cmd}.</div>
        )}

        {/* Local breakdown for /usage / /cost / /stats — SDK's text output
            покрывает только subscription/cost; добавляем то, что мы знаем
            локально из turn-events. CLI это shipит «Total cost / duration /
            turns» — мы суммировали в costSummary. */}
        {(cmd === 'usage' || cmd === 'cost' || cmd === 'stats') && (
          <div className="mt-6 pt-4 border-t border-[#1f1f1f] grid grid-cols-2 gap-y-1 gap-x-6 text-[0.85em]" style={{ fontFamily: 'inherit' }}>
            <div className="text-[#888]">Total cost (this session)</div>
            <div className="font-mono text-[#d4d4d4]">${costSummary.totalUSD.toFixed(4)}</div>
            <div className="text-[#888]">Total duration (API)</div>
            <div className="font-mono text-[#d4d4d4]">{fmtDuration(costSummary.durationMs)}</div>
            <div className="text-[#888]">Total turns</div>
            <div className="font-mono text-[#d4d4d4]">{costSummary.numTurns}</div>
            {sessionId && (
              <>
                <div className="text-[#888]">Session</div>
                <div className="font-mono text-[#666]">{sessionId.slice(0, 8)}…</div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-1.5 border-t border-[#1f1f1f] text-[0.77em] text-[#555] shrink-0">
        <span className="font-mono">Esc</span> · <span className="font-mono">Ctrl+C</span> · <span className="font-mono">Ctrl+[</span> &nbsp; to close
      </div>
    </div>
  );
}

function SDKComposer({
  tabId,
  isRunning,
  sessionId,
  wasStopped,
  onResume,
  onSessionStop,
  modelLabel,
  contextPercent,
  onUserInteract,
}: {
  tabId: string;
  isRunning: boolean;
  sessionId: string | null;
  wasStopped: boolean;
  onResume: () => void;
  onSessionStop: () => void;
  modelLabel: string | null;
  contextPercent: number | null;
  onUserInteract?: () => void;
}) {
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [previewChip, setPreviewChip] = useState<PasteChip | null>(null);
  // Stashed text — populated by Ctrl+S, restored by clicking the chip or
  // reset-to-empty after the next successful submit. Kept here in component
  // state (not in composer runtime) so we can render the chip + diff against
  // the live composer text.
  const [stashed, setStashed] = useState<string | null>(null);
  // 1-second red flash on the composer when юзер пытается отправить (Enter)
  // во время Claude turn'а. Visual signal of «заблокировано» вместо тихого
  // no-op. Триггерится в handleComposerKeyDown.
  const [rejectFlash, setRejectFlash] = useState(false);
  const rejectFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRejectFlash = useCallback(() => {
    setRejectFlash(true);
    if (rejectFlashTimerRef.current) clearTimeout(rejectFlashTimerRef.current);
    rejectFlashTimerRef.current = setTimeout(() => setRejectFlash(false), 1000);
  }, []);
  useEffect(() => () => { if (rejectFlashTimerRef.current) clearTimeout(rejectFlashTimerRef.current); }, []);
  // Effort label for the live "thinking · <effort>" indicator. Subscribed via
  // selector so the indicator re-renders when the user flips the Effort pill
  // mid-turn (rare but valid — pill changes apply to the next request, but the
  // label should reflect the current store value either way).
  const composerEffort = useWorkspaceStore((s) => {
    const activeTabId = s.openProjects.get(s.activeProjectId || '')?.activeTabId;
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t) return (t.sdkEffort || 'high').toLowerCase();
    }
    return null;
  });
  // Last-Ctrl+C timestamp for the double-press → Stop escalation.
  const lastCtrlCRef = useRef<number>(0);
  // Composer runtime: text source-of-truth + setText/cancel methods.
  const composerRuntime = useComposerRuntime({ optional: true });
  const composerText = useComposer((s) => s.text, { optional: true }) ?? '';
  // Direct DOM ref to the textarea — needed for insert-prompt (we drive native
  // value setter + dispatch input event so React's onChange picks it up).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // After a successful send the composer text resets to '', and we want the
  // stash to clear too — it has served its purpose. We watch for the empty
  // composer transition right after stash existed.
  const prevTextRef = useRef(composerText);
  useEffect(() => {
    if (stashed != null && prevTextRef.current.length > 0 && composerText === '') {
      // Composer just submitted (text went non-empty → empty). Drop the stash.
      setStashed(null);
    }
    prevTextRef.current = composerText;
  }, [composerText, stashed]);

  // -------- Slash autocomplete --------
  // Источник списка команд — два слоя, merged по имени с приоритетом live:
  //   1. live: per-tab cache, заполняется handleMessage при system:init —
  //      это AUTHORITATIVE список для этой сессии, включая /status, skills
  //      и любые session-specific команды.
  //   2. probe: throw-away IPC при mount — fallback пока сессия не стартует
  //      (для нового SDK-таба без отправленного prompt'а).
  // Live перезаписывает probe (сессия знает лучше). re-render при изменении
  // module-level cache через subscribeSlashCommands.
  const [_cmdsTick, _forceCmdsRender] = useState(0);
  useEffect(() => subscribeSlashCommands(() => _forceCmdsRender(n => n + 1)), []);
  const [probeCommands, setProbeCommands] = useState<SlashCmd[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await ipcRenderer.invoke('claude-sdk:probe-commands', { tabId: '' });
        if (cancelled) return;
        if (res?.success && Array.isArray(res.commands)) setProbeCommands(res.commands);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  // Note: _forceCmdsRender above is what re-triggers this useMemo via the
  // sub'd listener — мы не можем включить Map.get как dep напрямую (Map
  // identity не меняется). После setSlashCommandsForTab listener дёргается
  // → state +1 → component re-renders → useMemo выполняется заново.
  const allCommands = useMemo(() => {
    const live = getSlashCommandsForTab(tabId);
    if (live.length === 0) return probeCommands;
    const liveNames = new Set(live.map(c => c.name));
    const probeExtras = probeCommands.filter(c => !liveNames.has(c.name));
    return [...live, ...probeExtras];
  }, [tabId, probeCommands, _cmdsTick]);

  // Slash trigger: показываем popup когда текст начинается с "/" и НЕ
  // содержит пробела (после пробела это уже аргументы команды, popup не нужен).
  // Юзер: «если в начале slash — срабатывает, если есть пробел — уже не срабатывает».
  const slashMatch = /^\/(\S*)$/.exec(composerText);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const filteredCommands = useMemo(() => {
    if (slashQuery == null) return [];
    if (!slashQuery) return allCommands.slice(0, 30); // empty query → all
    // Rank: startsWith on name > startsWith on alias > includes on name > includes on alias.
    // Юзер вводит "us" — должен СНАЧАЛА увидеть /usage, потом /extra-usage.
    // Раньше plain `includes` смешивал и /extra-usage оказывался первым.
    type Scored = { cmd: typeof allCommands[number]; rank: number };
    const scored: Scored[] = [];
    for (const c of allCommands) {
      const name = c.name.toLowerCase();
      if (name === slashQuery) { scored.push({ cmd: c, rank: 0 }); continue; }
      if (name.startsWith(slashQuery)) { scored.push({ cmd: c, rank: 1 }); continue; }
      if (c.aliases?.some(a => a.toLowerCase().startsWith(slashQuery))) { scored.push({ cmd: c, rank: 2 }); continue; }
      if (name.includes(slashQuery)) { scored.push({ cmd: c, rank: 3 }); continue; }
      if (c.aliases?.some(a => a.toLowerCase().includes(slashQuery))) { scored.push({ cmd: c, rank: 4 }); continue; }
    }
    scored.sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name));
    return scored.slice(0, 30).map(s => s.cmd);
  }, [allCommands, slashQuery]);
  const showSlashPopup = slashQuery != null && filteredCommands.length > 0;

  const [slashIdx, setSlashIdx] = useState(0);
  // Reset selection when query changes
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  // Keep index in bounds when list shrinks
  useEffect(() => {
    if (slashIdx >= filteredCommands.length) setSlashIdx(Math.max(0, filteredCommands.length - 1));
  }, [filteredCommands.length, slashIdx]);

  // Refs to break stale-closure in handleComposerKeyDown — useCallback only
  // re-binds on its dep array, but Arrow/Enter/Tab handlers need to see the
  // LIVE slashIdx + filteredCommands when key fires (state changes between
  // renders don't re-bind the callback unless we list them as deps, which
  // would cause every keystroke to rebind the handler and break composer focus).
  const slashIdxRef = useRef(slashIdx);
  const filteredCommandsRef = useRef(filteredCommands);
  const showSlashPopupRef = useRef(false);
  slashIdxRef.current = slashIdx;
  filteredCommandsRef.current = filteredCommands;
  showSlashPopupRef.current = slashQuery != null && filteredCommands.length > 0;

  // Commit selected command into composer and IMMEDIATELY submit. Selection
  // в popup'е через клик или Enter — это явное «submit this command».
  // Раньше различали required (<>) vs optional ([]) args и блокировали
  // submit для команд с argumentHint — но у Claude SDK почти все hint'ы
  // в `<…>` даже когда args optional (`/compact <optional summary>`,
  // `/clear [name]`). Юзер: «если выбрал стрелочками — Enter сразу
  // запускает». Если хочет добавить аргументы — печатает их вместо
  // выбора из popup'а (когда есть пробел, popup закрывается, режим
  // обычного ввода).
  const commitSlash = useCallback((cmd: { name: string; argumentHint?: string }) => {
    const next = '/' + cmd.name;
    const ta = composerTextareaRef.current;
    if (ta) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(ta, next);
      else ta.value = next;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { composerRuntime?.setText(next); } catch {}

    if (isRunning) {
      // Claude turn активен — submit заблокирован. Оставляем текст в
      // composer'е, юзер сам нажмёт Enter когда turn закончится. Red flash
      // показывается через handleComposerKeyDown hard-gate.
      requestAnimationFrame(() => {
        if (ta) {
          ta.focus();
          ta.setSelectionRange(next.length, next.length);
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
        }
      });
      return;
    }

    // Not running → fire send directly через composerRuntime.
    requestAnimationFrame(() => {
      try { composerRuntime?.send(); } catch (e) { console.warn('[SlashCommit] send failed', e); }
    });
  }, [composerRuntime, isRunning]);

  // Centralised composer mutation. assistant-ui's ComposerPrimitive.Input
  // ignores runtime.setText, so any programmatic value change has to go through
  // the native value setter + a synthetic input event so React's onChange fires.
  // Used by Stash restore, Ctrl+S, Ctrl+C clear, insert-prompt — keeps them
  // from drifting apart.
  const writeComposerValue = useCallback((value: string, opts?: { focusEnd?: boolean }) => {
    const ta = composerTextareaRef.current;
    if (ta) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(ta, value);
      else ta.value = value;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (value === '') {
        ta.style.height = 'auto'; // collapse auto-grown rows
      } else if (opts?.focusEnd) {
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 320) + 'px';
        });
      }
    }
    try { composerRuntime?.setText(value); } catch {}
  }, [composerRuntime]);

  const restoreStash = useCallback(() => {
    if (stashed == null) return;
    writeComposerValue(stashed, { focusEnd: true });
    setStashed(null);
  }, [stashed, writeComposerValue]);

  const dismissStash = useCallback(() => setStashed(null), []);

  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // HARD GATE: пока Claude печатает (isRunning), Enter не отправляет ничего —
    // ни обычный prompt, ни slash-команду, ни выбранный из popup. Это убирает
    // race-condition с тем что SDK midstream приём новых prompt'ов не
    // поддерживает (нужен result event и новый turn). Очередь будем делать
    // отдельно — пока самый безопасный путь блокировать ввод. Shift+Enter
    // (newline в textarea) пропускаем. Визуальный сигнал блокировки — на
    // 1 секунду подсвечиваем border + bg композера красным, иначе тихий
    // no-op читается юзером как баг клавиатуры.
    if (isRunning && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      triggerRejectFlash();
      return;
    }

    // Slash autocomplete: when popup is open, arrows/Tab/Enter steer the
    // selection and commit. Reads through refs because handleComposerKeyDown
    // is memoised on [composerText, writeComposerValue, isRunning,
    // onSessionStop] — adding slashIdx / filteredCommands / showSlashPopup
    // to deps would re-bind the handler on every state change and break
    // composer focus during scrolling lists. stopPropagation guards against
    // assistant-ui's bubbled Enter-to-send handler hijacking the keystroke.
    if (showSlashPopupRef.current) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        const len = filteredCommandsRef.current.length;
        setSlashIdx(i => Math.min(len - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setSlashIdx(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        const cmd = filteredCommandsRef.current[slashIdxRef.current];
        if (cmd) commitSlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        // Drop the slash → popup closes automatically (slashMatch fails).
        e.preventDefault(); e.stopPropagation();
        writeComposerValue('');
        return;
      }
    }

    // Ctrl+S: stash. Mac users hit ⌘S in muscle memory; we accept both. Skip
    // when textarea is empty (nothing to stash) so a stray ⌘S doesn't replace
    // an existing stash with an empty one.
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (composerText.trim().length === 0) return;
      setStashed(composerText);
      writeComposerValue('');
      return;
    }
    // Ctrl+C: TUI-style two-stage clear → stop. Mac default ⌘C copies; we
    // explicitly require Ctrl (not Meta) so highlight-and-copy still works.
    if (e.key === 'c' && e.ctrlKey && !e.metaKey) {
      // Don't intercept if the user actually has a text selection — they want
      // to copy that selection, not clear/stop.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault();
      const now = Date.now();
      const isDouble = now - lastCtrlCRef.current < CTRLC_DOUBLE_WINDOW_MS;
      lastCtrlCRef.current = now;

      // First press with non-empty input → clear. First press with empty input
      // → escalate immediately to Stop (matches "nothing to clear, you mean
      // exit"). Second press within window → escalate.
      if (composerText.length > 0 && !isDouble) {
        writeComposerValue('');
        return;
      }
      if (isRunning) {
        onSessionStop();
        lastCtrlCRef.current = 0; // reset so next session-Ctrl+C starts fresh
      }
      return;
    }
  }, [composerText, writeComposerValue, isRunning, onSessionStop, triggerRejectFlash, commitSlash]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (text.length >= PASTE_THRESHOLD) {
      e.preventDefault();
      setChips(prev => [...prev, {
        id: 'chip-' + Date.now(),
        text,
        preview: text.slice(0, 60).replace(/\n/g, ' ') + '...',
      }]);
    }
    // Short pastes go through normally to ComposerPrimitive.Input
  }, []);

  const removeChip = useCallback((id: string) => {
    setChips(prev => prev.filter(c => c.id !== id));
    if (previewChip?.id === id) setPreviewChip(null);
  }, [previewChip]);

  // Expose chips to parent via custom event so onNew can read them
  useEffect(() => {
    (window as any).__sdkPasteChips = chips;
    return () => { delete (window as any).__sdkPasteChips; };
  }, [chips]);

  // Clear chips after send
  useEffect(() => {
    const handler = () => setChips([]);
    window.addEventListener('claude-sdk:chips-clear', handler);
    return () => window.removeEventListener('claude-sdk:chips-clear', handler);
  }, []);

  // Insert-prompt event: fired when the user picks an item from the right-click
  // "Insert Prompt" submenu. We can't go through composerRuntime.setText alone —
  // assistant-ui's ComposerPrimitive.Input keeps its own internal state and
  // ignores out-of-band runtime mutations until the user types. So we drive the
  // DOM textarea directly: native value setter + dispatch an "input" event so
  // React's onChange fires and the runtime re-syncs from the real textarea.
  // composerRuntime.setText is still called as a belt-and-braces fallback for
  // future versions where the primitive might react to runtime mutations.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.text) return;
      // Two flavours of insert:
      //   • default (append): used by right-click Insert-Prompt — keeps any
      //     in-progress text the user typed and pins the new prompt below.
      //   • replace: used by the smart-cancel rollback path — the textarea
      //     should equal exactly the cancelled user message, not be mixed with
      //     whatever else is in the input.
      if (detail.replace) {
        writeComposerValue(detail.text, { focusEnd: true });
        return;
      }
      // Read the *current* textarea value, not the runtime state — runtime
      // can lag the DOM after rapid edits, and we want to append to what the
      // user actually sees on screen right now.
      const ta = composerTextareaRef.current
        ?? (document.querySelector('textarea[placeholder*="Message"], textarea[placeholder*="Add a message"]') as HTMLTextAreaElement | null);
      const cur = ta?.value ?? '';
      const next = cur && cur.trim() ? `${cur}\n\n${detail.text}` : detail.text;
      writeComposerValue(next, { focusEnd: true });
    };
    window.addEventListener('claude-sdk:composer-insert', handler);
    return () => window.removeEventListener('claude-sdk:composer-insert', handler);
  }, [writeComposerValue]);

  return (
    <div className="relative">
      {/* Status bar — Thinking only. Session badge moved below input (under
          Send) so it sits in the same visual region as the user's last action,
          freeing the top of the composer for the Stash chip. */}
      {isRunning && (
        <div className="flex items-center gap-2 px-4 py-1 text-[0.77em] text-[#555]">
          <span className="flex items-center gap-1 text-[#DA7756]">
            <Loader2 size={10} className="animate-spin" />
            thinking{composerEffort ? ` · ${composerEffort}` : ''}
          </span>
        </div>
      )}

      {/* Stash chip — appears directly above the input when Ctrl+S has stashed
          text. Click restores; × dismisses. Auto-clears on next submit. */}
      {stashed != null && !wasStopped && (
        <div className="px-4 pb-1.5">
          <div
            className="inline-flex items-center gap-2 px-2 py-1 rounded-md text-[0.85em] cursor-pointer transition-colors"
            style={{
              color: '#aaa',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.10)',
              maxWidth: '100%',
            }}
            onClick={restoreStash}
            title="Click to restore stashed text"
          >
            <span style={{ color: '#888' }}>›</span>
            <span className="truncate">
              Stashed <span className="text-[#666]">(auto-restores after submit)</span>
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); dismissStash(); }}
              className="ml-1 text-[#666] hover:text-white shrink-0"
              title="Discard stash"
            >×</button>
          </div>
        </div>
      )}

      {/* Paste chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-1.5">
          {chips.map(chip => (
            <Tooltip key={chip.id} content="Click to preview">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[0.85em] bg-[#6B8AFF]/15 text-[#8ba4ff] border border-[#6B8AFF]/20 cursor-pointer hover:bg-[#6B8AFF]/25 max-w-[200px]"
              onClick={() => setPreviewChip(previewChip?.id === chip.id ? null : chip)}
            >
              <span className="truncate">{chip.preview}</span>
              <span
                className="text-[#666] hover:text-white ml-0.5 shrink-0"
                onClick={(e) => { e.stopPropagation(); removeChip(chip.id); }}
              >×</span>
            </span>
            </Tooltip>
          ))}
        </div>
      )}

      {/* Chip preview overlay */}
      {previewChip && (
        <div className="mx-4 mb-2 bg-[#1a1a1a] border border-[#333] rounded-lg max-h-[200px] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#333]">
            <span className="text-[0.77em] text-[#888]">Pasted content ({previewChip.text.length.toLocaleString()} chars)</span>
            <button className="text-[#666] hover:text-white text-[0.92em] cursor-pointer" onClick={() => setPreviewChip(null)}>×</button>
          </div>
          <pre className="px-3 py-2 text-[0.85em] text-[#aaa] whitespace-pre-wrap">{previewChip.text}</pre>
        </div>
      )}

      {wasStopped && !isRunning ? (
        // Stopped state: replace the composer with a single Resume button. The
        // Claude SDK has no "/resume" — sessionId is preserved across stops, the
        // next user message naturally continues the conversation. Resume here
        // simply restores the normal composer UI (clears the wasStopped flag).
        // History is intact: the messages array is untouched by Stop.
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              style={{
                width: 8, height: 8, borderRadius: 2,
                backgroundColor: '#ef4444',
                display: 'inline-block', flexShrink: 0,
              }}
            />
            <span className="text-[0.92em] text-[#999] truncate">
              Process stopped — history preserved
            </span>
          </div>
          <button
            onClick={onResume}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg cursor-pointer transition-colors"
            style={{
              fontSize: 12,
              color: '#FFB382',
              backgroundColor: 'rgba(255, 178, 130, 0.14)',
              border: '1px solid rgba(255, 178, 130, 0.35)',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255, 178, 130, 0.24)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255, 178, 130, 0.14)'; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            Resume
          </button>
        </div>
      ) : (
        // relative wrapper для absolute-popup'а. Юзер: «команды должны быть в
        // позиции absolute, перекрывать историю, не двигать ничего».
        <div className="relative">
          {/* Slash autocomplete popup — absolute, sits ABOVE composer,
              перекрывает Virtuoso content без сдвига layout'а. bottom:100%
              ставит его прямо над composer'ом, mb-1 — 4px gap. z-30 чтобы
              быть выше message-bubbles. */}
          {showSlashPopup && (
            <div
              className="absolute left-4 right-4 bottom-full mb-1 rounded-lg border border-[#2a2a2a] bg-[#0f0f0f] shadow-2xl overflow-hidden max-h-[280px] overflow-y-auto z-30"
              onMouseDown={(e) => e.preventDefault() /* не теряем фокус composer'а при клике */}
            >
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onClick={() => commitSlash(cmd)}
                  onMouseEnter={() => setSlashIdx(i)}
                  className={'w-full text-left px-3 py-1.5 flex items-baseline gap-3 cursor-pointer ' + (i === slashIdx ? 'bg-[#1f1410]' : 'hover:bg-[#171717]')}
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className={'font-mono text-[0.92em] ' + (i === slashIdx ? 'text-[#DA7756]' : 'text-[#9ca3af]')}>/{cmd.name}</span>
                  {cmd.argumentHint && (
                    <span className="font-mono text-[0.77em] text-[#555]">{cmd.argumentHint}</span>
                  )}
                  <span className="text-[0.77em] text-[#666] truncate flex-1">{cmd.description}</span>
                  {cmd.aliases?.length ? (
                    <span className="text-[0.7em] text-[#444] font-mono">{cmd.aliases.map(a => '/' + a).join(' ')}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
          <ComposerPrimitive.Root className="flex items-end gap-2 px-4 pb-1">
            <ComposerPrimitive.Input
              autoFocus
              placeholder={chips.length > 0 ? 'Add a message or press Enter to send...' : 'Message Claude...'}
              // Visible caret (orange). Раньше был transparent — юзер печатал,
              // текст реально шёл в textarea, но он его не видел и думал
              // «инпут не работает». Caret = единственный достоверный сигнал
              // «текст идёт сюда» когда юзер начал печатать.
              style={{ caretColor: '#FFB382' }}
              className={'flex-1 text-[#e0e0e0] text-[1em] rounded-lg px-3 py-2 resize-none outline-none border placeholder-[#555] min-h-[36px] max-h-[120px] bg-[#1a1a1a] ' + (rejectFlash ? 'border-red-500 bg-[#2a1414]' : 'border-[#555]')}
              rows={1}
              onPaste={handlePaste}
              onKeyDown={handleComposerKeyDown}
              onInput={() => onUserInteract?.()}
              onFocus={() => {
                try { ipcRenderer.send('log:renderer', '[SDKFocus] textarea onFocus'); } catch {}
              }}
              onBlur={(e) => {
                const ta = e.currentTarget;
                const rel = e.relatedTarget as HTMLElement | null;
                const relTag = rel?.tagName?.toLowerCase() || 'null';
                const relCls = (rel?.className && typeof rel.className === 'string') ? rel.className.slice(0, 60) : '-';
                const relRole = rel?.closest?.('[data-msg-role]')?.getAttribute?.('data-msg-role') || '-';
                const relData = rel ? Array.from(rel.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name).join(',') : '-';
                // Prefer caret captured at mousedown (BEFORE Blink reset) over
                // current selectionStart, which is already 0 if Blink ran its
                // click-outside-form-control reset. Falls back to current if
                // mousedown snapshot is unavailable (e.g. keyboard-only blur).
                const snap = savedCaretRef.current;
                const savedStart = snap?.start ?? ta.selectionStart ?? 0;
                const savedEnd = snap?.end ?? ta.selectionEnd ?? 0;
                try { ipcRenderer.send('log:renderer', `[SDKFocus] textarea onBlur → relTag=${relTag} relRole=${relRole} relData=${relData} relCls="${relCls}" savedCaret=${savedStart},${savedEnd}`); } catch {}

                // ProseMirror/Slate canonical refocus pattern.
                // Refocus textarea if:
                //   (a) blur went to NOWHERE (relatedTarget=null) — click landed on a
                //       non-focusable element (chat <p>/<div>) and Blink cleared
                //       activeElement to body. This is exactly the case we need
                //       to recover from. Selection is already committed by Blink
                //       before onBlur fires, so refocusing the textarea won't
                //       collapse it.
                //   (b) blur went to virtuoso scroller / message bubble — same
                //       intent, user is browsing the chat, composer should stay
                //       focused.
                // Skip when:
                //   * relatedTarget is an interactive control (button/link/input/
                //     textarea/contenteditable) outside our tab — let it keep focus.
                //   * Outside our tab root entirely (sidebar, header, modal).
                const tabRoot = ta.closest('.absolute.inset-0.flex.flex-col') as HTMLElement | null;
                if (!tabRoot) return;
                if (rel) {
                  // Focus moved to another real element. Refocus only if it's
                  // inside our tab AND it's not an interactive control.
                  if (!tabRoot.contains(rel)) return;
                  if (rel.closest('button, a, input, textarea, [contenteditable]')) return;
                }
                // (rel is null OR rel is a passive descendant of tabRoot) → refocus.
                // Microtask: wait for Blink to commit the selection range, then
                // bounce focus back. setTimeout(0) gives the click pipeline a
                // chance to finish (mouseup default action including drag-select
                // completion) before we re-grab focus.
                setTimeout(() => {
                  if (document.activeElement === ta) return;
                  // Selection guard: if user is actively dragging a selection,
                  // do nothing — let mouseup finish naturally. We refocus after.
                  const sel = window.getSelection();
                  if (sel && !sel.isCollapsed && sel.toString().length > 0) {
                    try { ipcRenderer.send('log:renderer', `[SDKRefocus] skip=active-selection len=${sel.toString().length}`); } catch {}
                    return;
                  }
                  try { ipcRenderer.send('log:renderer', `[SDKRefocus] → ta.focus() restoreCaret=${savedStart},${savedEnd}`); } catch {}
                  ta.focus({ preventScroll: true });
                  // Restore caret position so the cursor stays where the user
                  // last left it. Without this Blink resets to (0,0) on focus.
                  try { ta.setSelectionRange(savedStart, savedEnd); } catch {}
                }, 0);
              }}
              ref={composerTextareaRef as any}
            />
          </ComposerPrimitive.Root>
          {/* Footer row below the input — Claude Code style:
              [Opus 4.7 (1M context)] 19% .................. Session: xxx
              Model + context % is the primary signal (left, brighter), session
              ID is the secondary anchor (right, dim). Both hide when nothing
              to show. */}
          {(modelLabel || sessionId) && (
            <div className="px-4 pb-2 pt-0.5 flex items-center justify-between gap-3 text-[0.7em]" style={{ color: '#5a5a5a' }}>
              <div className="flex items-center gap-1.5 min-w-0">
                {modelLabel && (
                  <span className="text-[#bdbdbd] font-medium truncate">[{modelLabel}]</span>
                )}
                {contextPercent != null && (
                  <span
                    className="font-mono tabular-nums"
                    style={{ color: contextPercent > 90 ? '#ef4444' : contextPercent > 75 ? '#f59e0b' : '#7a7a7a' }}
                  >
                    {contextPercent.toFixed(0)}%
                  </span>
                )}
              </div>
              {sessionId && (
                <span className="truncate max-w-[180px]" style={{ color: '#3a3a3a' }}>
                  Session: {sessionId.slice(0, 8)}…
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ClaudeSDKTab);
