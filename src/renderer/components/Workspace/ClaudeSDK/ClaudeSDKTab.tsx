import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
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
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { AssistantProviderBase } from '@assistant-ui/core/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Loader2, FileEdit, Terminal as TerminalIcon, FolderSearch, Search, FileText, Globe, RefreshCw, Pencil, Check, X as XIcon, Brain, ChevronRight } from 'lucide-react';
import Tooltip from '../../UI/Tooltip';

const { ipcRenderer } = window.require('electron');

// ============================================================
// Internal message type — accumulated from IPC stream
// ============================================================
interface SDKChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, any>; result?: any; status: 'running' | 'done' | 'error' }>;
  thinking: string | null;
  timestamp: number;
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

  if (msg.role === 'user') {
    return { role: 'user' as const, content: [{ type: 'text' as const, text: msg.text }], id: msg.id, createdAt: new Date(msg.timestamp) };
  }

  // Assistant message — supports status, reasoning, tool calls
  const parts: ThreadMessageLike['content'] = [];

  if (msg.thinking) {
    parts.push({ type: 'reasoning' as const, text: msg.thinking });
  }

  if (msg.text) {
    parts.push({ type: 'text' as const, text: msg.text });
  }

  for (const tc of msg.toolCalls) {
    parts.push({
      type: 'tool-call' as const,
      toolName: tc.name,
      toolCallId: tc.id,
      args: tc.args,
      // result must be defined for "done"/"error" so ToolCallPart can distinguish from "running".
      // Streaming path: undefined while tool runs, then set when paired with tool_result.
      // History path: paired text or '' (we know it's done — JSONL is past-tense).
      result: tc.status === 'running' ? undefined : (tc.result ?? ''),
      isError: tc.status === 'error',
    });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text' as const, text: '' });
  }

  return {
    role: 'assistant' as const,
    content: parts,
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
function formatModelLabel(realModel: string | null, alias: string | undefined): string | null {
  const src = (realModel || resolveSdkModel(alias) || alias || '').toLowerCase();
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
    const state = useWorkspaceStore.getState();
    let tabCwd = cwd;
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) { tabCwd = t.cwd || cwd; break; }
    }
    const result = await ipcRenderer.invoke('claude-sdk:load-history', { sessionId: sid, cwd: tabCwd });
    console.warn('[ClaudeSDKTab:loadHistory] sid=' + sid.slice(0, 8) + ' success=' + result.success + ' rawCount=' + (result.messages?.length || 0));
    if (!result.success || !result.messages?.length) return;

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

    const loaded: SDKChatMessage[] = result.messages.map((m: any, i: number) => {
      const textParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof m.message?.content === 'string' ? m.message.content : '';
      const toolParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'tool_use').map((b: any) => {
            const tid = b.id || 'tool-' + i;
            const tr = toolResults.get(tid);
            return {
              id: tid,
              name: b.name || 'unknown',
              args: typeof b.input === 'object' ? b.input : {},
              result: tr ? tr.result : undefined,
              status: tr ? (tr.isError ? 'error' : 'done') as const : 'done' as const,
            };
          })
        : [];
      const thinkingParts = Array.isArray(m.message?.content)
        ? m.message.content.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking).join('\n')
        : '';

      // Classify system commands as 'system' role
      let role = m.type as 'user' | 'assistant' | 'system';
      let text = textParts;
      if (role === 'user') {
        // tool_result entries don't have text content (only tool_result blocks) — drop them
        // (their data has already been paired into toolCalls.result above).
        const hasToolResultBlock = Array.isArray(m.message?.content) &&
          m.message.content.some((b: any) => b?.type === 'tool_result');
        if (hasToolResultBlock && !text.trim()) return null;

        const trimmed = text.trim();
        // Slash commands: /effort, /model, etc.
        if (trimmed.startsWith('<command-name>')) {
          const cmdMatch = trimmed.match(/<command-name>([^<]+)<\/command-name>/);
          const argsMatch = trimmed.match(/<command-args>([^<]*)/);
          role = 'system';
          text = (cmdMatch?.[1] || '') + ' ' + (argsMatch?.[1] || '').trim();
        }
        // Command stdout responses
        else if (trimmed.startsWith('<local-command-stdout>')) {
          role = 'system';
          text = trimmed.replace(/<\/?local-command-stdout>/g, '').trim();
        }
        // Tool results (internal)
        else if (trimmed === '[tool_result]' || trimmed.startsWith('<tool_result>')) {
          return null; // Filter out
        }
        // System reminders
        else if (trimmed.startsWith('<system-reminder>')) {
          return null; // Filter out
        }
      }

      return {
        id: m.uuid || ('hist-' + i),
        role,
        text,
        toolCalls: toolParts,
        thinking: thinkingParts || null,
        timestamp: Date.now() - (result.messages.length - i) * 1000,
      };
    }).filter((m: SDKChatMessage | null): m is SDKChatMessage => {
      if (!m) return false;
      if (m.role === 'user' && !m.text.trim()) return false;
      return true;
    });

    // Merge consecutive assistant messages into single turns
    // Claude JSONL stores one "turn" as multiple records (thinking, text, tool_use)
    const merged: SDKChatMessage[] = [];
    for (const m of loaded) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === 'assistant' && m.role === 'assistant') {
        // Merge into previous
        if (m.text.trim()) prev.text = prev.text ? prev.text + '\n' + m.text : m.text;
        if (m.thinking) prev.thinking = prev.thinking ? prev.thinking + '\n' + m.thinking : m.thinking;
        prev.toolCalls = [...prev.toolCalls, ...m.toolCalls];
      } else {
        merged.push({ ...m });
      }
    }

    // Final filter: remove empty assistant messages after merge
    const final = merged.filter(m => {
      if (m.role === 'assistant' && !m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
      return true;
    });

    // Diagnostic: count tool calls across all messages
    const totalTools = final.reduce((sum, m) => sum + m.toolCalls.length, 0);
    const toolNames = final.flatMap(m => m.toolCalls.map(t => t.name));
    const uniqueTools = [...new Set(toolNames)];
    console.warn('[ClaudeSDKTab:loadHistory] loaded=' + loaded.length + ' merged=' + merged.length + ' final=' + final.length + ' totalTools=' + totalTools + ' uniqueTools=' + uniqueTools.join(','));

    setMessages(final);
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
      updateSDKState(tabId, { sdkState: 'thinking' });
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
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid, content } = (e as CustomEvent).detail;
      if (tid !== tabId || !viewportRef.current) return;
      // Find the message element that contains this content
      const contentSnippet = (content || '').slice(0, 40);
      const els = viewportRef.current.querySelectorAll('[data-msg-role]');
      for (const el of els) {
        if (el.textContent?.includes(contentSnippet)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Brief highlight
          (el as HTMLElement).style.outline = '1px solid rgba(218,119,86,0.4)';
          setTimeout(() => { (el as HTMLElement).style.outline = ''; }, 1500);
          return;
        }
      }
    };
    window.addEventListener('claude-sdk:scroll-to-entry', handler);
    return () => window.removeEventListener('claude-sdk:scroll-to-entry', handler);
  }, [tabId]);

  // ---- IPC listener: accumulate SDK messages ----
  useEffect(() => {
    const handleMessage = (_: any, data: { tabId: string; message: any; sessionId: string }) => {
      if (data.tabId !== tabId) return;

      if (data.sessionId && !sessionIdRef.current) {
        sessionIdRef.current = data.sessionId;
        setSessionId(data.sessionId);
        updateSDKState(tabId, { claudeSessionId: data.sessionId });
      }

      const msg = data.message;

      // Assistant message with content blocks
      if (msg.type === 'assistant' && msg.message?.content) {
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
        const textBlocks = msg.message.content.filter((b: any) => b.type === 'text');
        const toolBlocks = msg.message.content.filter((b: any) => b.type === 'tool_use');
        const thinkingBlocks = msg.message.content.filter((b: any) => b.type === 'thinking');

        setMessages(prev => {
          const last = prev[prev.length - 1];
          const text = textBlocks.map((b: any) => b.text).join('\n');
          const thinking = thinkingBlocks.map((b: any) => b.thinking).join('\n') || null;

          // Accumulate tool calls
          const newTools = toolBlocks.map((t: any) => ({
            id: t.id, name: t.name,
            args: typeof t.input === 'object' ? t.input : {},
            status: 'running' as const,
          }));

          if (last?.role === 'assistant' && last.id === 'streaming-' + tabId) {
            return [...prev.slice(0, -1), {
              ...last,
              text: text || last.text,
              thinking: thinking || last.thinking,
              toolCalls: [...last.toolCalls, ...newTools],
            }];
          }

          return [...prev, {
            id: 'streaming-' + tabId,
            role: 'assistant' as const,
            text,
            thinking,
            toolCalls: newTools,
            timestamp: Date.now(),
          }];
        });
      }

      // Tool result — arrives as user-type message with tool_result content blocks.
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
            if (m.role !== 'assistant') return m;
            let touched = false;
            const nextTools = m.toolCalls.map(t => {
              const r = resultsById.get(t.id);
              if (!r) return t;
              touched = true;
              return { ...t, result: r.result, status: (r.isError ? 'error' : 'done') as const };
            });
            return touched ? { ...m, toolCalls: nextTools } : m;
          }));
        }
      }

      // Result — finalize: rename streaming id + mark any still-running tools as done
      // (safety net; tool_result pairing above should have already flipped them).
      if (msg.type === 'result') {
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
          if (m.id === 'streaming-' + tabId) {
            return {
              ...m,
              id: 'msg-' + Date.now(),
              toolCalls: m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t),
            };
          }
          if (m.role === 'assistant' && m.toolCalls.some(t => t.status === 'running')) {
            return { ...m, toolCalls: m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t) };
          }
          return m;
        }));
      }

      // System init
      if (msg.type === 'system' && msg.subtype === 'init') {
        setMessages(prev => [...prev, {
          id: 'init-' + Date.now(), role: 'system' as const,
          text: `Claude Code v${msg.claude_code_version}`,
          toolCalls: [], thinking: null, timestamp: Date.now(),
        }]);
      }
    };

    const handleDone = (_: any, data: { tabId: string }) => {
      if (data.tabId !== tabId) return;
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'idle' });
    };

    ipcRenderer.on('claude-sdk:message', handleMessage);
    ipcRenderer.on('claude-sdk:done', handleDone);
    return () => {
      ipcRenderer.removeListener('claude-sdk:message', handleMessage);
      ipcRenderer.removeListener('claude-sdk:done', handleDone);
    };
  }, [tabId, updateSDKState]);

  // ---- Send handler for external store ----
  const onNew = useCallback(async (message: AppendMessage) => {
    // Block sending while running — SDK doesn't queue, it would interrupt
    // Use getState() to avoid stale closure (isRunning not in deps)
    const currentlyRunning = (() => {
      const s = useWorkspaceStore.getState();
      for (const [, ws] of s.openProjects) {
        const t = ws.tabs.get(tabId);
        if (t) return t.sdkState === 'thinking' || t.sdkState === 'tool_use';
      }
      return false;
    })();
    if (currentlyRunning) return;

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

    // Clear chips
    window.dispatchEvent(new Event('claude-sdk:chips-clear'));
    setIsRunning(true);
    setWasStopped(false); // user opted into a new turn — drop the Resume affordance
    updateSDKState(tabId, { sdkState: 'thinking' });

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
    const result = await ipcRenderer.invoke(ipcChannel, { tabId, cwd, prompt: text, model: sdkModel, effort: sdkEffort, thinking: sdkThinking });

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
      const hasContent = !!streaming && (
        streaming.text.trim().length > 0 ||
        (streaming.thinking && streaming.thinking.trim().length > 0) ||
        streaming.toolCalls.length > 0
      );

      // (A) Content captured → keep everything. We just rename the streaming
      // placeholder to a stable id so it survives re-renders (mirrors what the
      // `result` handler usually does, but we beat it by cancelling).
      if (hasContent) {
        return prev.map(m => m.id === 'streaming-' + tabId
          ? { ...m, id: 'msg-' + Date.now(), toolCalls: m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t) }
          : m);
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
      updateSDKState(tabId, { sdkState: 'thinking' });

      // Fire the resend through the existing SDK channel — server-side
      // session.sessionId is preserved, so this lands as the new turn off the
      // truncated tip.
      const result = await ipcRenderer.invoke('claude-sdk:send-message', {
        tabId, cwd: tabCwd, prompt: newText, model: sdkModel, effort: sdkEffort, thinking: sdkThinking,
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
  const currentModelLabel = useMemo(
    () => formatModelLabel(lastResolvedModel, sdkModelAlias),
    [lastResolvedModel, sdkModelAlias],
  );
  const contextPercentRemaining = useMemo(() => {
    if (lastContextUsedTokens == null) return null;
    const win = getModelContextWindow(lastResolvedModel, sdkModelAlias);
    if (!win) return null;
    const usedPct = (lastContextUsedTokens / win) * 100;
    return Math.max(0, Math.min(100, 100 - usedPct));
  }, [lastContextUsedTokens, lastResolvedModel, sdkModelAlias]);

  // Escape (or Ctrl+[ — Claude TUI alias) cancels the running query.
  // Ctrl+[ matches the canonical readline/Claude-Code keybinding: terminals
  // emit ESC (0x1b) for both, so muscle memory carries over from the TUI.
  useEffect(() => {
    if (!isRunning || !isVisible) return;
    const handler = (e: KeyboardEvent) => {
      const isEscapeAlias = e.key === 'Escape' || (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '[');
      if (isEscapeAlias) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRunning, isVisible, onCancel]);

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
  // Filter out empty assistant messages (no text, no tools, no thinking)
  const filteredMessages = useMemo(() =>
    messages.filter(m => {
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

  // Scroll-to-bottom state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowScrollDown(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: 'smooth' });
  }, []);

  // Auto-scroll on new messages when already at bottom
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Click-anywhere → focus the composer textarea. Mirrors Claude TUI behavior
  // (any whitespace click jumps to input). Skips clicks landing on interactive
  // elements (button, a, input, textarea — they have their own focus handling)
  // and on the assistant message bubble area when there's an active text
  // selection (preserves copy gestures).
  const handleTabClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [contenteditable]')) return;
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0 && !sel.isCollapsed) return;
    // Find any textarea inside this tab subtree and focus it.
    const root = e.currentTarget;
    const ta = root.querySelector('textarea') as HTMLTextAreaElement | null;
    ta?.focus();
  }, []);

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

  // Inherit terminal font-size for the entire SDK tab — keeps SDK chat in
  // sync with the user's Terminal preference (Cmd+/− and the Settings slider).
  // All in-card text uses em-based sizes (text-[1em], text-[0.85em], …) so a
  // single base on this root re-scales the whole tree without per-element edits.
  const sdkBaseFontSize = useUIStore((s) => s.terminalFontSize);

  return (
    <div
      className="absolute inset-0 flex flex-col"
      style={{ display: isVisible ? 'flex' : 'none', fontSize: `${sdkBaseFontSize}px` }}
      onClick={handleTabClick}
      onContextMenu={handleTabContextMenu}
    >
      <AssistantProviderBase runtime={runtime}>
        <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
          <ThreadPrimitive.Viewport
            ref={scrollContainerRef as any}
            onScroll={handleScroll}
            className="flex flex-1 flex-col overflow-y-auto sdk-chat-scroll"
          >
            {/* Empty state */}
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

            {/* Messages — grow to push composer down when chat is short. */}
            <div ref={viewportRef} className="flex-1 px-4 py-3">
              <UserMsgActionsContext.Provider value={userMsgActions}>
                <ThreadPrimitive.Messages
                  components={{ UserMessage: UserMsg, AssistantMessage: AssistantMsg, SystemMessage: SystemMsg }}
                />
              </UserMsgActionsContext.Provider>
            </div>

            {/* Composer MUST stay inside Viewport — assistant-ui's
                ComposerPrimitive.Input reads ThreadPrimitive context and
                throws "must be used within ThreadPrimitive.Viewport" if hoisted
                out. NORMAL FLOW (no sticky) — composer is the last element of
                the scrollable area, scrolls out of view when the user scrolls
                up. Matches Claude Code TUI: input is the bottom of the buffer,
                not an overlay. When chat is short, messages-div's flex-1 grows
                and pushes the composer to the bottom-anchored slot anyway. */}
            <ThreadPrimitive.ViewportFooter className="border-t border-[#2a2a2a] shrink-0">
              <SDKComposer
                isRunning={isRunning}
                sessionId={sessionId}
                wasStopped={wasStopped}
                onResume={() => setWasStopped(false)}
                modelLabel={currentModelLabel}
                contextPercent={contextPercentRemaining}
                onSessionStop={async () => {
                  // Double-Ctrl+C from inside the composer = "stop the whole
                  // session" (matches Claude TUI). Same path as the TabBar dot,
                  // sidebar chip, ctx menu — surface Resume affordance.
                  try {
                    await ipcRenderer.invoke('claude-sdk:stop', { tabId });
                    window.dispatchEvent(new CustomEvent('claude-sdk:was-stopped', { detail: { tabId } }));
                  } catch (e: any) { console.error('[ComposerStop] error', e); }
                }}
              />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>

          {/* Scroll-to-bottom button */}
          {showScrollDown && (
            <Tooltip content="Scroll to bottom">
            <button
              onClick={scrollToBottom}
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
  const msgId = useMessage((s) => s.id);
  const msgText = useMessage((s) => {
    const part = s.content.find((p: any) => p.type === 'text') as { type: 'text'; text: string } | undefined;
    return part?.text ?? '';
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
      className="text-[0.85em] text-[#8ba4ff] hover:text-[#a8b8ff] cursor-pointer select-none"
    >
      {expanded
        ? 'Свернуть'
        : `Раскрыть полностью (${text.length.toLocaleString()} символов)`}
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
const SystemMsg = () => (
  <MessagePrimitive.Root className="py-1">
    <div className="text-center text-[0.85em] text-[#555]">
      <MessagePrimitive.Content
        components={{ Text: ({ text }) => <span>{text}</span> }}
      />
    </div>
  </MessagePrimitive.Root>
);

// ============================================================
// Assistant message — markdown + tool calls + thinking
// ============================================================
const AssistantMsg = () => (
  <MessagePrimitive.Root className="py-2 px-1 relative group" data-msg-role="assistant">
    <MessagePrimitive.Content
      components={{
        Text: AssistantTextPart,
        Reasoning: ReasoningPart,
        tools: { Fallback: ToolCallPart },
      }}
    />
    {/* Action bar — absolute, non-blocking */}
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <CopyButton />
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
);

// ---- Text part: markdown rendering (skip empty) ----
const AssistantTextPart = ({ text }: { text: string }) => {
  if (!text.trim()) return null;
  return (
    <div className="prose prose-invert prose-sm max-w-none text-[1em] leading-relaxed" style={{ color: '#d4d4d4' }}>
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
                  customStyle={{ margin: '8px 0', borderRadius: '8px', fontSize: '0.92em', padding: '12px', backgroundColor: '#1a1a1a' }}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
            }
            return <code className="bg-[#1a1a1a] px-1.5 py-0.5 rounded text-[0.92em] text-[#e0e0e0]" {...props}>{children}</code>;
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
    const anchorY = el.getBoundingClientRect().top;
    const wasAtBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= BOTTOM_PIN_PX;
    // flushSync forces React to commit + layout BEFORE returning. The browser
    // has not yet painted, so the next two lines (read + write) land in the
    // same frame and the user only ever sees the final position.
    flushSync(() => { toggle(); });
    if (wasAtBottom) {
      scroller.scrollTop = scroller.scrollHeight;
    } else {
      const newAnchorY = el.getBoundingClientRect().top;
      const delta = newAnchorY - anchorY;
      if (delta !== 0) scroller.scrollTop += delta;
    }
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
      className="text-[0.77em] px-1.5 py-0.5 rounded bg-[#1a1a1a] hover:bg-[#2a2a2a] cursor-pointer border border-[#333] transition-colors"
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

function SDKComposer({
  isRunning,
  sessionId,
  wasStopped,
  onResume,
  onSessionStop,
  modelLabel,
  contextPercent,
}: {
  isRunning: boolean;
  sessionId: string | null;
  wasStopped: boolean;
  onResume: () => void;
  onSessionStop: () => void;
  modelLabel: string | null;
  contextPercent: number | null;
}) {
  const [chips, setChips] = useState<PasteChip[]>([]);
  const [previewChip, setPreviewChip] = useState<PasteChip | null>(null);
  // Stashed text — populated by Ctrl+S, restored by clicking the chip or
  // reset-to-empty after the next successful submit. Kept here in component
  // state (not in composer runtime) so we can render the chip + diff against
  // the live composer text.
  const [stashed, setStashed] = useState<string | null>(null);
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
  }, [composerText, writeComposerValue, isRunning, onSessionStop]);

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
        <>
          <ComposerPrimitive.Root className="flex items-end gap-2 px-4 pb-1">
            <ComposerPrimitive.Input
              autoFocus
              placeholder={chips.length > 0 ? 'Add a message or press Enter to send...' : 'Message Claude...'}
              className="flex-1 bg-[#1a1a1a] text-[#e0e0e0] text-[1em] rounded-lg px-3 py-2 resize-none outline-none border border-[#333] focus:border-[#555] placeholder-[#555] min-h-[36px] max-h-[120px]"
              rows={1}
              onPaste={handlePaste}
              onKeyDown={handleComposerKeyDown}
              ref={composerTextareaRef as any}
            />

            {isRunning ? (
              <ComposerPrimitive.Cancel
                data-sdk-cancel
                className="flex items-center justify-center w-[36px] h-[36px] rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send className="flex items-center justify-center w-[36px] h-[36px] rounded-lg bg-[#DA7756]/20 hover:bg-[#DA7756]/30 text-[#DA7756] transition-colors disabled:opacity-30 disabled:cursor-default cursor-pointer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
              </ComposerPrimitive.Send>
            )}
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
                    style={{ color: contextPercent < 10 ? '#ef4444' : contextPercent < 25 ? '#f59e0b' : '#7a7a7a' }}
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
        </>
      )}
    </div>
  );
}

export default memo(ClaudeSDKTab);
