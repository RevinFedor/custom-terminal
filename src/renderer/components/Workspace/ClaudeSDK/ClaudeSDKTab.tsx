import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';
import { useUIStore, type HistoryPromptDraftChip } from '../../../store/useUIStore';
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
import { Loader2, RefreshCw, Pencil, Check, X as XIcon } from 'lucide-react';
// Portable conversation blocks. The visual canon for tool cards / bash / diff /
// thinking / markdown now lives in this package (single source for desktop +
// mobile). react-markdown, remark-gfm, react-syntax-highlighter and the per-tool
// lucide icons are now its dependencies, not this file's. Collapse behaviour is
// injected (open/onToggle/anchorRef) so this tab keeps its Virtuoso scroll-stable
// toggle. See packages/claude-blocks.
import {
  ConversationMessage,
  Markdown as CBMarkdown,
  MessageActionButton,
  MessageActionRail,
  MessageStatusBadge,
  ThinkBlock as CBThinkBlock,
  ToolCallPart as CBToolCallPart,
  defaultOpenForTool,
} from '@noted/claude-blocks';
import {
  AIComposerSurface,
  type AIComposerSurfaceChip,
} from '../AIConversation/AIComposerSurface';
import {
  haveSameComposerChips,
  mergeComposerAuthoringSnapshot,
  normalizeComposerChips,
  removeComposerChip,
  restoreComposerChipToText,
  serializeComposerDraft,
  shouldCreatePasteChip,
  upsertComposerChip,
} from '../../../utils/composerChips.mjs';
import Tooltip from '../../UI/Tooltip';
import ControlHint from '../../UI/ControlHint';
import { consumePrefetched } from '../../../utils/sdkHistoryPrefetch';
import { BackgroundTasksBar } from './BackgroundTasksBar';
import { TaskDetailPane } from './TaskDetailPane';
import { WorkflowPanel } from './WorkflowPanel';
import SDKAskQuestion, { type SDKQuestion } from './SDKAskQuestion';

const { ipcRenderer } = window.require('electron');

type SDKComposerChip = HistoryPromptDraftChip;

type SDKComposerDraftSnapshot = {
  rawText: string;
  chips: SDKComposerChip[];
  transportText: string;
};

type SDKMidstreamPendingItem = {
  text: string;
  rawText: string;
  chips: SDKComposerChip[];
  ts: number;
  state: 'queued' | 'sent';
};

const readStoredSDKComposerChips = (tabId: string): SDKComposerChip[] => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return normalizeComposerChips(tab.sdkComposerChips || []) as SDKComposerChip[];
    }
  }
  return [];
};

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
  // True если user-prompt был отправлен из type-ahead очереди (Enter во время
  // стриминга → auto-send при turn-end). Live-only — Anthropic JSONL не
  // хранит UI-метаданные, после reload флаг теряется. UserMsg рендерит
  // маленький оранжевый chip "queued" над bubble'ом.
  wasQueued?: boolean;
  // True если этот assistant-turn был прерван юзером (Esc / красная отмена /
  // двойной Ctrl+C). В отличие от wasQueued ВЫЖИВАЕТ reload: на диске Claude
  // пишет служебную запись-маркер `[Request interrupted by user]`, которую
  // loadHistory детектит и навешивает этот флаг на предшествующий assistant.
  // Live-путь (onCancel branch A) ставит флаг сразу, не дожидаясь reload.
  // Рендерится приглушённой плашкой «⊘ stopped» слева у сообщения (AssistantMsg).
  interrupted?: boolean;
}

// Служебные строки, которые Claude CLI/SDK пишет в JSONL как отдельную
// `type:'user'` запись когда turn прерван юзером (Esc / отмена / Ctrl+C).
// Константа захардкожена в самом Claude (английская, не локализуется,
// стабильна на 20+ версиях CLI) — main.js дублирует тот же набор в
// INTERRUPT_TEXTS для PTY busy-watcher'а. Три варианта: обычный стоп, стоп
// во время tool-use, и короткая форма из старых версий.
const SDK_INTERRUPT_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '[Request interrupted]',
]);

// Возвращает true если JSONL-запись — это маркер прерывания (type:'user' с
// единственным text-блоком из SDK_INTERRUPT_TEXTS). Контент бывает строкой
// ИЛИ массивом [{type:'text'}] — обрабатываем оба shape'а (как claude-data.js).
function isInterruptMarkerRecord(rec: any): boolean {
  if (!rec || rec.type !== 'user') return false;
  const content = rec.message?.content;
  if (typeof content === 'string') return SDK_INTERRUPT_TEXTS.has(content.trim());
  if (Array.isArray(content)) {
    if (content.length !== 1) return false;
    const b = content[0];
    return !!b && b.type === 'text' && typeof b.text === 'string' && SDK_INTERRUPT_TEXTS.has(b.text.trim());
  }
  return false;
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
// Task aggregator — собирает TaskCreate / TaskUpdate / TaskList / TodoWrite
// в один live-список (как нативный Claude TUI делает в `expandedView:'tasks'`).
// Source of truth — поток tool_use блоков из assistant сообщений + парные
// tool_result'ы (где для TaskCreate приходит фактический id вида "Task #123").
//
// TodoWrite (legacy V1) — пишет весь список одним вызовом, мы используем
// последний эмит как полную замену. TaskCreate/TaskUpdate (V2) — инкрементальные
// мутации, мы реконструируем состояние пошагово.
//
// Renderer-side (никакой IPC) — потому что все нужные данные уже в
// `messages[*].parts[*]`, нет смысла поднимать main->renderer событие.
// ============================================================
export type AggregatedTaskStatus = 'pending' | 'in_progress' | 'completed';
export interface AggregatedTask {
  id: string;          // taskId (V2) или sintetic 'todo-<idx>' для legacy V1
  subject: string;     // что показывать юзеру (TodoItem.content / Task.subject)
  activeForm?: string; // present-continuous для in_progress спиннера
  status: AggregatedTaskStatus;
}
const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
// Извлекает Task #<id> из тула-результата TaskCreate. Native шлёт ровно
// "Task #<id> created successfully: <subject>".
const TASK_ID_FROM_RESULT_RE = /Task\s+#?(\w+)\s+created/i;
function parseTaskIdFromCreateResult(result: any): string | null {
  if (typeof result !== 'string') return null;
  const m = result.match(TASK_ID_FROM_RESULT_RE);
  return m ? m[1] : null;
}
export function aggregateTasksFromMessages(messages: SDKChatMessage[]): AggregatedTask[] {
  // Map<taskId, AggregatedTask> сохраняет порядок вставки (как нативный list).
  // Для legacy TodoWrite полностью пересоздаём ordered list при каждом вызове —
  // он шлёт весь массив целиком, история мутаций неважна.
  let tasks: AggregatedTask[] = [];
  const byId = new Map<string, number>(); // taskId → index in tasks[]
  // Для TaskCreate мы видим args ДО результата (в стриме), id придёт позже
  // в tool_result. Промежуточный buffer: tool_use_id → temp record (id=tool_use_id
  // как stub). При появлении result обновим запись на настоящий id.
  // НО т.к. мы ходим по уже завершённым parts[] (которые уже могут иметь
  // .result), и стрим обновляет parts[] in-place — этот аггрегатор всегда
  // запускается на актуальном snapshot'е и не должен накапливать состояние
  // между вызовами. Pass-2 проходит по тем же массивам и если result доехал,
  // обновляет stub-id на реальный.
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.parts) continue;
    for (const p of m.parts) {
      if (p.type !== 'tool') continue;
      const name = p.name;
      if (!TASK_TOOL_NAMES.has(name)) continue;
      const args = p.args || {};
      if (name === 'TodoWrite' && Array.isArray(args.todos)) {
        // Legacy V1: full replace. Если все completed → native обнуляет список
        // (см. TodoWriteTool.call::allDone), мы тоже скрываем — пустой массив.
        const allDone = args.todos.length > 0 && args.todos.every((t: any) => t?.status === 'completed');
        if (allDone) { tasks = []; byId.clear(); continue; }
        tasks = args.todos.map((t: any, i: number) => ({
          id: 'todo-' + i,
          subject: String(t?.content ?? ''),
          activeForm: typeof t?.activeForm === 'string' ? t.activeForm : undefined,
          status: (t?.status === 'in_progress' || t?.status === 'completed' ? t.status : 'pending') as AggregatedTaskStatus,
        }));
        byId.clear();
        tasks.forEach((t, i) => byId.set(t.id, i));
        continue;
      }
      if (name === 'TaskCreate') {
        // Реальный taskId приходит в tool_result; до него используем tool_use_id как stub.
        // Дальше при чтении p.result резолвим в настоящий id и переименовываем запись.
        let tid: string | null = parseTaskIdFromCreateResult(p.result);
        const subject = String(args.subject ?? '');
        const activeForm = typeof args.activeForm === 'string' ? args.activeForm : undefined;
        if (tid && byId.has(tid)) continue; // уже есть (idempotent)
        const stubKey = 'create:' + p.id; // pre-result placeholder
        if (!tid) {
          // stream still in flight — пока result не пришёл, держим stub
          if (byId.has(stubKey)) continue;
          tasks.push({ id: stubKey, subject, activeForm, status: 'pending' });
          byId.set(stubKey, tasks.length - 1);
          continue;
        }
        // result есть — добавляем под реальным id. Если был stub — заменяем его.
        const stubIdx = byId.get(stubKey);
        const record: AggregatedTask = { id: tid, subject, activeForm, status: 'pending' };
        if (stubIdx !== undefined) {
          tasks[stubIdx] = record;
          byId.delete(stubKey);
          byId.set(tid, stubIdx);
        } else if (!byId.has(tid)) {
          tasks.push(record);
          byId.set(tid, tasks.length - 1);
        }
        continue;
      }
      if (name === 'TaskUpdate' && typeof args.taskId === 'string') {
        const idx = byId.get(args.taskId);
        if (idx === undefined) continue; // update для неизвестного — ignore (TaskList мог запушить, но мы его не парсим — fine)
        const cur = tasks[idx];
        // status === 'deleted' → убираем запись (native deleteTask flow)
        if (args.status === 'deleted') {
          tasks.splice(idx, 1);
          byId.delete(args.taskId);
          // переиндексируем хвост
          for (let i = idx; i < tasks.length; i++) byId.set(tasks[i].id, i);
          continue;
        }
        const nextStatus: AggregatedTaskStatus | undefined =
          (args.status === 'pending' || args.status === 'in_progress' || args.status === 'completed') ? args.status : undefined;
        tasks[idx] = {
          ...cur,
          subject: typeof args.subject === 'string' ? args.subject : cur.subject,
          activeForm: typeof args.activeForm === 'string' ? args.activeForm : cur.activeForm,
          status: nextStatus ?? cur.status,
        };
        continue;
      }
      // TaskList / TaskGet — read-only, не меняют state. Игнорируем
      // (parsing tool_result текста было бы fragile, у нас всё уже есть из Create/Update).
    }
  }
  return tasks;
}

// ============================================================
// TaskListPanel — collapsible card sitting above the composer.
// Header: ✻ <activeForm of current in_progress task> (N/M)  →  click toggles
// expand. Expanded body: row per task with status glyph + strikethrough on
// completed. Stays empty (renders null) if no tasks.
// ============================================================
function TaskListPanel({ tasks, collapsed, onToggle }: { tasks: AggregatedTask[]; collapsed: boolean; onToggle: () => void }) {
  if (!tasks || tasks.length === 0) return null;
  const done = tasks.filter(t => t.status === 'completed').length;
  const inProgress = tasks.find(t => t.status === 'in_progress');
  // Header label — prefer the active task's activeForm (что Claude "сейчас делает"),
  // иначе static "Tasks". Native CLI делает то же — спиннер крутится с activeForm.
  const headerLabel = inProgress?.activeForm || inProgress?.subject || (done === tasks.length ? 'Tasks (all done)' : 'Tasks');
  return (
    <div className="px-4 pb-1.5">
      <div
        style={{
          backgroundColor: 'rgba(218, 119, 86, 0.06)',
          border: '1px solid rgba(218, 119, 86, 0.22)',
          borderRadius: 6,
          padding: '4px 8px',
          maxWidth: '100%',
        }}
      >
        {/* Header row — clickable, toggles collapse */}
        <div
          onClick={onToggle}
          className="flex items-center gap-2 cursor-pointer select-none"
          style={{ fontSize: '0.85em' }}
          title={collapsed ? 'Развернуть список задач' : 'Свернуть список задач'}
        >
          <span style={{ color: '#DA7756', fontWeight: 600, letterSpacing: '0.04em', fontSize: '0.85em' }}>TASKS</span>
          <span className="truncate" style={{ color: '#d8b9a3' }}>
            {inProgress ? <Loader2 size={10} className="animate-spin inline-block mr-1.5 align-[-1px]" /> : null}
            {headerLabel}
          </span>
          <span className="ml-auto shrink-0" style={{ color: '#9a7a63', fontSize: '0.77em' }}>
            {done}/{tasks.length}
          </span>
          <span className="shrink-0" style={{ color: '#9a7a63', fontSize: '0.77em', minWidth: 10, textAlign: 'right' }}>
            {collapsed ? '▸' : '▾'}
          </span>
        </div>

        {/* Body — only rendered when expanded. Each row: glyph + subject. */}
        {!collapsed && (
          <ul className="mt-1.5 flex flex-col gap-0.5" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {tasks.map(t => {
              const isDone = t.status === 'completed';
              const isActive = t.status === 'in_progress';
              const glyph = isDone ? '✓' : isActive ? '▣' : '□';
              const glyphColor = isDone ? '#7ab87a' : isActive ? '#DA7756' : '#888';
              const textColor = isDone ? '#777' : isActive ? '#FFB382' : '#bdbdbd';
              return (
                <li key={t.id} className="flex items-start gap-2" style={{ fontSize: '0.85em', lineHeight: 1.4 }}>
                  <span style={{ color: glyphColor, fontFamily: 'monospace', flexShrink: 0, width: 14, textAlign: 'center' }}>{glyph}</span>
                  <span
                    style={{
                      color: textColor,
                      textDecoration: isDone ? 'line-through' : 'none',
                    }}
                  >
                    {t.subject}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Convert our internal messages to assistant-ui ThreadMessageLike
// ============================================================
export function convertMessage(msg: SDKChatMessage): ThreadMessageLike {
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
  // Carry the interrupt flag into the module-level Set (ThreadMessageLike drops
  // custom fields) so AssistantMsg can render the «⊘ stopped» badge by id.
  if (msg.interrupted) setInterruptedForMsg(msg.id);
  const aui: ThreadMessageLike['content'] = [];

  if (msg.parts && msg.parts.length > 0) {
    for (const p of msg.parts) {
      if (p.type === 'thinking') {
        if (p.text) aui.push({ type: 'reasoning' as const, text: p.text });
      } else if (p.type === 'text') {
        if (p.text) aui.push({ type: 'text' as const, text: p.text });
      } else if (p.type === 'tool') {
        // Task* / TodoWrite tools агрегируются в TaskListPanel над composer'ом
        // (как нативный TUI делает в `expandedView:'tasks'`). Не рендерим их
        // дублирующимися карточками в основном треде — иначе одно и то же
        // содержимое видно дважды.
        if (TASK_TOOL_NAMES.has(p.name)) continue;
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
      // Task* / TodoWrite — см. комментарий выше, тот же гард для legacy path.
      if (TASK_TOOL_NAMES.has(tc.name)) continue;
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
// Values are what we hand to query() options.model. We pass ALIASES (not full
// IDs) so the CLI's own resolver picks the current shipping model + attaches
// the 1M beta from the [1m] suffix — exactly what `supportedModels()` returns
// as selectable values (verified live: default / sonnet / sonnet[1m] / haiku /
// opus[1m]). The binary maps `opus[1m]` → Opus 4.8 (1M) internally. Passing a
// bare `claude-opus-4-7` here was a double bug: stale version AND no [1m], so
// it silently ran 200K while the footer claimed "(1M context)".
const SDK_MODEL_MAP: Record<string, string | undefined> = {
  default: undefined,
  sonnet: 'claude-sonnet-4-6',
  opus: 'opus[1m]',
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
const SDK_DEFAULT_MODEL_ID = 'claude-opus-4-8';

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
  // 1M is driven by the [1m] alias suffix (mirrors the CLI's has1mContext =
  // /\[1m\]/ which attaches the context-1m beta). We may be looking at the
  // alias ('opus[1m]') OR a real SSE id ('claude-opus-4-8'); the real id never
  // carries [1m], so also treat a known-1M family id as 1M. Opus is 1M-by-
  // default on the API (4.8); Sonnet only with the explicit [1m] variant.
  const has1mTag = /\[1m\]/.test(src);
  // Version digits live on a real model id ('claude-opus-4-8'), never on a bare
  // alias ('opus[1m]'). Prefer the SSE-truth realModel for the version when it's
  // the same family as what we're labelling, so picking the 'opus' alias still
  // renders "Opus 4.8" (not a version-less "Opus") once the first chunk lands.
  const versionSrc = (realModel && family && realModel.toLowerCase().includes(family.toLowerCase()))
    ? realModel.toLowerCase() : src;
  const versionMatch = versionSrc.match(/-(\d+)[-.](\d+)(?:[-.]\d+)*(?:-\d{8})?$/);
  const version = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : '';
  // Opus is 1M-by-default on the API from 4.8 onward; pre-4.8 Opus and all
  // Sonnet/Haiku are 200K unless the [1m] variant was explicitly chosen.
  const opusIs1mByDefault = family === 'Opus' && version !== '' && version !== '4.5' && version !== '4.6' && version !== '4.7';
  const is1M = has1mTag || opusIs1mByDefault;
  const window = is1M ? ' (1M context)' : '';
  return `${family}${version ? ' ' + version : ''}${window}`;
}

// Approximate context window sizes (tokens) per model family. Used to compute
// the "N% used / left" pill — Anthropic doesn't ship this in the SDK so we
// hard-code well-known values. Off-by-2% is fine for the indicator's purpose.
function getModelContextWindow(realModel: string | null, alias: string | undefined): number {
  // Consider BOTH the real SSE id and the chosen alias — the alias carries the
  // [1m] suffix that the real id drops. 1M when: explicit [1m] tag (any family
  // that supports it), or Opus 4.8+ (1M by default on the API).
  const aliasSrc = (resolveSdkModel(alias) || alias || '').toLowerCase();
  const realSrc = (realModel || '').toLowerCase();
  const combined = realSrc + ' ' + aliasSrc;
  if (/\[1m\]/.test(combined)) return 1_000_000;
  // Opus 4.8+ → 1M default (4.5/4.6/4.7 were 200K unless [1m]).
  const opusVer = combined.match(/opus-(\d+)[-.](\d+)/);
  if (opusVer) {
    const v = `${opusVer[1]}.${opusVer[2]}`;
    if (v !== '4.5' && v !== '4.6' && v !== '4.7') return 1_000_000;
  }
  return 200_000;
}

// Tool icon mapping, language detection и line-diff переехали в
// @noted/claude-blocks (единый источник для desktop + mobile). Здесь больше
// не нужны — рендер tool-карточек целиком делегирован пакету.

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
export const UserMsgActionsContext = React.createContext<UserMsgActions | null>(null);

// ============================================================
// Props
// ============================================================
interface ClaudeSDKTabProps {
  tabId: string;
  active?: boolean;
  isActiveProject?: boolean;
  ownerProjectId?: string;
  cwd: string;
}

// ============================================================
// Main component
// ============================================================
function ClaudeSDKTab({ tabId, active: activeProp, isActiveProject: isActiveProjectProp, ownerProjectId, cwd }: ClaudeSDKTabProps) {
  const activeFromStore = useWorkspaceStore((state) => {
    if (!ownerProjectId) return false;
    const workspace = state.openProjects.get(ownerProjectId);
    return !!workspace && state.activeProjectId === ownerProjectId && workspace.activeTabId === tabId;
  });
  const isActiveProjectFromStore = useWorkspaceStore((state) => {
    return ownerProjectId ? state.activeProjectId === ownerProjectId : true;
  });
  const active = activeProp ?? activeFromStore;
  const isActiveProject = isActiveProjectProp ?? isActiveProjectFromStore;

  const [messages, setMessages] = useState<SDKChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Cold-start loader. Flips to true on first Virtuoso paint (heavy tabs ≥1s)
  // or immediately for empty history. Reset on sessionId change.
  const [chatReady, setChatReady] = useState(false);
  // Chips are tab-owned authoring state, not SDK transport state. Keep them
  // above the conditionally visible footer content and mirror them into the
  // workspace tab so a project switch cannot flatten or discard the draft.
  const [sdkComposerChips, setSDKComposerChipsState] = useState<SDKComposerChip[]>(
    () => readStoredSDKComposerChips(tabId),
  );
  const sdkComposerChipsRef = useRef<SDKComposerChip[]>(sdkComposerChips);
  const setSDKComposerChips = useCallback<React.Dispatch<React.SetStateAction<SDKComposerChip[]>>>((nextOrUpdater) => {
    const current = sdkComposerChipsRef.current;
    const candidate = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(current)
      : nextOrUpdater;
    const next = normalizeComposerChips(candidate) as SDKComposerChip[];
    sdkComposerChipsRef.current = next;
    setSDKComposerChipsState(next);
    useWorkspaceStore.getState().updateSDKState(tabId, { sdkComposerChips: next });
  }, [tabId]);
  const clearSDKComposerChipSnapshot = useCallback((snapshot: SDKComposerChip[]) => {
    const consumed = new Map(snapshot.map((chip) => [chip.id, JSON.stringify(chip)]));
    if (consumed.size === 0) return;
    setSDKComposerChips((current) => current.filter((chip) => (
      consumed.get(chip.id) !== JSON.stringify(chip)
    )));
  }, [setSDKComposerChips]);

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
  // Type-ahead queue (single slot) — the user hit Enter while Claude was still
  // streaming. Mirrors native Claude TUI: the message parks above the input and
  // auto-sends when the current turn finishes naturally. Lives in the OUTER
  // component (not SDKComposer) so it survives the composer unmounting when a
  // task-detail-pane opens, and sits next to the `result` handler + dispatchPrompt
  // + onCancel that drive it. `queued` is the render source; `queuedRef` is the
  // synchronous mirror the result-handler reads (its useEffect closure can't see
  // fresh state). Full multi-item queue (reorder, stop-after) is a separate
  // later feature — this is just the native single-shot type-ahead.
  const [queued, setQueued] = useState<string | null>(null);
  const queuedRef = useRef<string | null>(null);
  // Visual state of the chip-over-input:
  //   'queued' — pushed locally, SDK has not yet pulled it. Reversible.
  //              Orange chip; Esc/Up returns text to input.
  //   'sent'   — SDK pulled from channel, Claude received it but JSONL
  //              has not landed yet. Gray chip; recall is no-op
  //              (cannot un-send to Claude).
  //   null     — no chip rendered.
  const [queuedState, setQueuedState] = useState<'queued' | 'sent' | null>(null);
  const queuedStateRef = useRef<'queued' | 'sent' | null>(null);
  // Pending mid-stream type-ahead prompts awaiting "promote to thread"
  // signal: we don't push user-bubble for wasQueued=true immediately (to
  // avoid showing a bubble before SDK actually delivers). When SDK's
  // mid-chain drain happens, Claude emits the NEXT assistant chunk that
  // semantically responds to our queued prompt. We use that chunk as the
  // signal to promote chip → real user-bubble in the thread.
  // Each entry tracks its lifecycle state:
  //   - 'queued':   pushed to main, SDK has not yet pulled from input channel
  //                 → chip is reversible (Esc/Up returns text to input)
  //   - 'sent':     SDK pulled it from channel, en-route to Claude CLI
  //                 → chip is locked (cannot recall), but not yet in JSONL
  //   - landed → entry is removed from pending entirely and a user-bubble is
  //               inserted into the thread at the JSONL position.
  //
  // State transitions:
  //   push      → state:'queued'  (dispatchPrompt for wasQueued=true)
  //   consumed  → state:'sent'    (handleMidstreamConsumed, IPC from main)
  //   landed    → REMOVED         (handleMidstreamJsonlLanded, IPC from main)
  //   done (result/error)  → fallback promote of any remaining 'sent' as
  //                          unconfirmed user-bubble; orphan 'queued' (impossible
  //                          in practice — SDK consumes synchronously) cleared.
  //   stop (manual) → 'sent' → unconfirmed; 'queued' → discarded entirely.
  const pendingMidstreamRef = useRef<SDKMidstreamPendingItem[]>([]);
  // wasStopped mirror for the result-handler closure (belt-and-suspenders: a
  // natural `result` shouldn't arrive after Stop, but guards the rare race).
  const wasStoppedRef = useRef(false);
  useEffect(() => { wasStoppedRef.current = wasStopped; }, [wasStopped]);
  const sdkBusyEndReasonRef = useRef<string | null>(null);
  // isRunning mirror for `onCancel`. assistant-ui's runtime can invoke onCancel
  // unconditionally on Escape (even after the turn finished and the Cancel
  // affordance is gone), and onCancel's rollback branch (B) would then drop the
  // last user→assistant pair from history. Gate the whole function on this ref
  // — Escape after turn-end is a no-op for the SDK tab. Putting `isRunning` in
  // onCancel's useCallback deps would churn the runtime (every state flip
  // recreates the callback, useExternalStoreRuntime may resubscribe), the ref
  // sidesteps that.
  const isRunningRef = useRef(false);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  // dispatchPrompt is defined below; the result-handler effect (above it) needs
  // to call it at event-time, so bridge through a ref kept current by an effect.
  const dispatchPromptRef = useRef<((
    t: string,
    opts?: { wasQueued?: boolean; authoringSnapshot?: SDKComposerDraftSnapshot },
  ) => Promise<boolean>) | null>(null);
  // Background task that has been expanded into the 300px detail pane (replaces
  // the composer). Null = composer visible. Bar above stays visible either way.
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Interactive AskUserQuestion (SDK). Set when main's canUseTool parks a
  // question (claude-sdk:ask-question); cleared on answer/stop/cancel/done.
  // While non-null, <SDKAskQuestion> replaces the composer (blocks typing),
  // exactly like the PTY Ink dialog. State lives here (the tab stays mounted
  // via display:none on switch, so it survives tab switches for free).
  const [activeQuestion, setActiveQuestion] = useState<null | { toolUseID: string; questions: SDKQuestion[] }>(null);
  // Is the currently-expanded task a workflow? Drives which panel the footer
  // shows (WorkflowPanel vs TaskDetailPane). A workflow is NOT auto-expanded —
  // it appears as a chip in BackgroundTasksBar and only expands when the user
  // selects it (↓ to the chip + Enter, or click), exactly like any other task.
  // Primitive boolean selector → no re-render churn.
  const expandedTaskIsWorkflow = useWorkspaceStore((s) => {
    if (!expandedTaskId) return false;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      const bt = t?.bgTasks?.find(b => b.taskId === expandedTaskId);
      if (bt) return bt.kind === 'workflow';
    }
    return false;
  });
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
  const upsertBgTask = useWorkspaceStore((s) => s.upsertBgTask);
  const removeBgTask = useWorkspaceStore((s) => s.removeBgTask);
  // Any background task (workflow / subagent / bash) still running on this tab.
  // Edit/Repeat must be blocked while one runs: rewriting the JSONL requires a
  // hard kill, which would silently abort the bg agent. Granular boolean
  // selector (Fingerprint pattern — never subscribe to the bgTasks array shape).
  const bgAgentRunning = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return !!t.bgTasks?.some(b => b.status === 'running');
    }
    return false;
  });

  // Mirror pendingMidstreamRef into the Zustand tab so that switching projects
  // (which unmounts this component) doesn't lose the chip state. On remount we
  // hydrate the ref from the store. Main-process JSONL watcher is keyed by
  // tabId — it stays alive across project switches; events keep flowing,
  // they just queue up while the component is unmounted, and re-fire onto
  // the freshly hydrated chip when the user returns.
  const syncPendingToStore = useCallback(() => {
    const snapshot = pendingMidstreamRef.current.map((item) => ({
      text: item.text,
      rawText: item.rawText,
      chips: item.chips.map((chip) => ({ ...chip })),
      ts: item.ts,
      state: item.state,
    }));
    updateSDKState(tabId, { sdkMidstreamPending: snapshot });
  }, [tabId, updateSDKState]);
  // Re-derive the visible chip from the front of the pending queue. Called
  // whenever pending mutates so the chip text + color reflect the head.
  const refreshChipFromPending = useCallback(() => {
    const pending = pendingMidstreamRef.current;
    if (pending.length === 0) {
      queuedRef.current = null;
      setQueued(null);
      queuedStateRef.current = null;
      setQueuedState(null);
    } else {
      queuedRef.current = pending[0].text;
      setQueued(pending[0].text);
      queuedStateRef.current = pending[0].state;
      setQueuedState(pending[0].state);
    }
  }, []);
  const requestComposerRestore = useCallback((
    snapshot: SDKComposerDraftSnapshot,
    options: {
      mode: 'append' | 'prepend';
      restoreChips: boolean;
      reason: string;
    },
  ) => {
    window.dispatchEvent(new CustomEvent('claude-sdk:composer-restore', {
      detail: {
        tabId,
        rawText: snapshot.rawText,
        chips: snapshot.chips.map((chip) => ({ ...chip })),
        mode: options.mode,
        restoreChips: options.restoreChips,
        reason: options.reason,
      },
    }));
  }, [tabId]);
  // Hydrate pending from store on mount. Allows the chip to reappear after
  // a project switch (component unmount/remount).
  useEffect(() => {
    const state = useWorkspaceStore.getState();
    let stored: Array<{
      text: string;
      rawText?: string;
      chips?: HistoryPromptDraftChip[];
      ts: number;
      state: 'queued' | 'sent';
    }> | undefined;
    for (const [, ws] of state.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t && Array.isArray(t.sdkMidstreamPending)) { stored = t.sdkMidstreamPending; break; }
    }
    if (stored && stored.length > 0) {
      pendingMidstreamRef.current = stored.map((item) => ({
        text: item.text,
        rawText: typeof item.rawText === 'string' ? item.rawText : item.text,
        chips: normalizeComposerChips(item.chips || []) as SDKComposerChip[],
        ts: item.ts,
        state: item.state,
      }));
      refreshChipFromPending();
      console.log('[TypeAhead] hydrated pending=' + stored.length + ' tab=' + tabId.slice(-12));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

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

    // Pre-pass: resolve which assistant turns the user interrupted. Claude
    // writes a synthetic `[Request interrupted by user]` user-record whose
    // parentUuid chain leads back to the interrupted assistant turn — directly
    // for a text/thinking abort, or through the tool_result record for a
    // mid-tool abort. Walk parentUuid up to the nearest assistant and remember
    // its uuid; the map below drops the marker record itself and flags that
    // assistant message instead (so the «⊘ stopped» badge anchors on the
    // answer, not on a literal "[Request interrupted by user]" user bubble).
    const _byUuid: Record<string, any> = {};
    for (const r of result.messages) { if (r && r.uuid) _byUuid[r.uuid] = r; }
    const _parentOf = (r: any) => (r && (r.logicalParentUuid || r.parentUuid)) || null;
    const interruptedAssistantUuids = new Set<string>();
    for (const r of result.messages) {
      if (!isInterruptMarkerRecord(r)) continue;
      let cur = _parentOf(r);
      let hops = 0;
      while (cur && hops < 20) {
        const rec = _byUuid[cur];
        if (!rec) break;
        if (rec.type === 'assistant' && rec.uuid) { interruptedAssistantUuids.add(rec.uuid); break; }
        cur = _parentOf(rec);
        hops++;
      }
    }

    // Pending metrics from a compact_boundary record, waiting to attach to
    // the next compact-summary entry. JSONL ordering guarantees boundary →
    // summary adjacency.
    let pendingCompactMetrics: SDKChatMessage['compactMetrics'] | null = null;
    const loaded: SDKChatMessage[] = result.messages.map((m: any, i: number) => {
      // Interrupt marker record — never a renderable bubble. The pre-pass above
      // already flagged the assistant turn it points at; drop the marker itself.
      if (isInterruptMarkerRecord(m)) return null;
      // queued_command attachment — CLI writes user mid-stream pushes
      // (priority:'next' / type-ahead during a running turn) as an
      // attachment record, NOT a regular type:'user' record. Surface it as
      // a user-bubble with the wasQueued flag so the orange "↑ QUEUED"
      // badge renders (matches the live-stream path's badge). Without this
      // branch, the entry's role becomes the literal 'attachment' string
      // and the assistant-ui adapter silently drops it — the user
      // perceives this as «my queued message vanished after reload».
      if (m.type === 'attachment' && m.attachment && m.attachment.type === 'queued_command') {
        const prompt = m.attachment.prompt;
        const text = typeof prompt === 'string'
          ? prompt
          : Array.isArray(prompt)
            ? prompt.map((item: any) => typeof item === 'string' ? item : (typeof item?.text === 'string' ? item.text : '')).filter(Boolean).join('\n')
            : (typeof prompt?.text === 'string' ? prompt.text : '');
        // The orange "↑ QUEUED" badge discriminator on user bubbles checks
        // `msgId` against `/^user-queued-/`, not the wasQueued boolean —
        // because assistant-ui drops unknown extra fields when re-importing
        // the message. We must encode wasQueued into the id itself so the
        // badge survives a reload.
        return {
          id: 'user-queued-' + (m.uuid || ('hist-' + i)),
          role: 'user' as const,
          text,
          toolCalls: [],
          thinking: null,
          timestamp: Date.now() - (result.messages.length - i) * 1000,
          wasQueued: true,
        };
      }
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
      if (role === 'assistant') {
        out.parts = parts;
        // Was THIS assistant record the one the user interrupted? (Resolved by
        // the parentUuid pre-pass.) The merge below ORs the flag onto the
        // surviving merged turn — the marker may point at any constituent record.
        if (m.uuid && interruptedAssistantUuids.has(m.uuid)) out.interrupted = true;
      }
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
        // Marker may have pointed at a later constituent record of this turn.
        if (m.interrupted) prev.interrupted = true;
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
      if (isRunningRef.current) sdkBusyEndReasonRef.current = 'manual-stop';
      setWasStopped(true);
      // Stop = "abandon this turn". JSONL is the source of truth: anything
      // that already landed in the transcript was promoted by
      // handleMidstreamJsonlLanded before stop fired (main also does one
      // final tail-read on stop to catch last-millisecond writes). Anything
      // STILL in pending after that is not in the transcript and never
      // will be — Claude wouldn't see it on a future resume. Drop silently
      // for sent. Queued never reached the channel → safe to recall to
      // the composer.
      const pending = pendingMidstreamRef.current;
      const queuedItems = pending.filter(p => p.state === 'queued');
      const droppedSent = pending.filter(p => p.state === 'sent').length;
      pendingMidstreamRef.current = [];
      queuedRef.current = null;
      setQueued(null);
      queuedStateRef.current = null;
      setQueuedState(null);
      syncPendingToStore();
      if (queuedItems.length > 0) {
        const item = queuedItems[0];
        requestComposerRestore({
          rawText: item.rawText,
          chips: item.chips,
          transportText: item.text,
        }, {
          mode: 'append',
          restoreChips: true,
          reason: 'stop-recall',
        });
      }
      if (droppedSent > 0) {
        console.log('[TypeAhead] stop-time drop unconfirmed sent=' + droppedSent + ' tab=' + tabId.slice(-12));
      }
    };
    window.addEventListener('claude-sdk:was-stopped', handler);
    return () => window.removeEventListener('claude-sdk:was-stopped', handler);
  }, [tabId, syncPendingToStore, requestComposerRestore]);

  // Durable "stopped" badge — live path for stop gestures that DON'T run
  // onCancel branch A (TabBar dot, ControlBar chip, ctx-menu — they only invoke
  // claude-sdk:stop). Main's interrupt-marker tail-read (claude-sdk:interrupted)
  // fires once the CLI flushes `[Request interrupted by user]` to JSONL after
  // our graceful query.interrupt(). We flag the LAST assistant message so the
  // «⊘ stopped» plate appears without waiting for a reload. On reopen,
  // loadHistory re-derives the same flag from the on-disk marker, so the two
  // agree. (onCancel branch A already tags its kept partial directly.)
  useEffect(() => {
    const handler = (_: any, data: { tabId: string; markerUuid: string | null; parentUuid: string | null }) => {
      if (data.tabId !== tabId) return;
      setMessages(prev => {
        // Prefer the assistant message the marker parents (by source uuid);
        // fall back to the last assistant message in the thread.
        let idx = -1;
        if (data.parentUuid) idx = prev.findLastIndex(m => m.role === 'assistant' && m.id === data.parentUuid);
        if (idx === -1) idx = prev.findLastIndex(m => m.role === 'assistant');
        if (idx === -1) return prev;
        const target = prev[idx];
        if (target.interrupted) return prev; // already flagged (onCancel beat us)
        setInterruptedForMsg(target.id);
        const next = prev.slice();
        next[idx] = { ...target, interrupted: true };
        return next;
      });
    };
    ipcRenderer.on('claude-sdk:interrupted', handler);
    return () => { ipcRenderer.removeListener('claude-sdk:interrupted', handler); };
  }, [tabId]);

  // Type-ahead enqueue/recall bridge. SDKComposer (which owns the keydown +
  // composer text) fires these; the queue state lives here in the outer
  // component (survives composer unmount on task-pane open). enqueue: park the
  // text above the input. recall: pull it back into the composer (used by
  // ArrowUp-on-empty-caret and by the chip's click/×). recall routes through
  // composer-insert (append semantics) so it lands at the end of whatever the
  // user already typed — matching the user's spec «если в инпуте уже что-то
  // есть то в конец».
  useEffect(() => {
    const onEnqueue = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      const text = typeof detail.text === 'string' ? detail.text : '';
      if (detail.tabId !== tabId || !text.trim()) return;
      const authoringSnapshot: SDKComposerDraftSnapshot = {
        rawText: typeof detail.snapshot?.rawText === 'string'
          ? detail.snapshot.rawText
          : text,
        chips: normalizeComposerChips(detail.snapshot?.chips || []) as SDKComposerChip[],
        transportText: text,
      };
      // Mid-stream type-ahead: push IMMEDIATELY into the live query channel
      // (main detects existing session and routes to session.push with
      // priority:'next'). SDK delivers it at the next block boundary —
      // именно то что юзер описывает: «дожидается окончания блока который
      // сейчас, потом сразу отправляется», not waiting full `result`.
      console.log('[TypeAhead] mid-stream push tab=' + tabId.slice(-12) + ' len=' + text.length);
      // dispatchPrompt сам пушит user-bubble в тред и не нуждается в chip'е
      // как промежуточном "pending" индикаторе — bubble появляется мгновенно
      // (синхронный setMessages). Раньше тут стояли `queuedRef.current=text;
      // setQueued(text)` ПОСЛЕ вызова dispatchPrompt — это переустанавливало
      // chip, который dispatchPrompt только что очистил (внутри setMessages +
      // setQueued(null)), и chip висел навсегда. Race fixed: дёргаем dispatch
      // и НЕ трогаем queue state — bubble в треде достаточен.
      void dispatchPromptRef.current?.(text, {
        wasQueued: true,
        authoringSnapshot,
      });
    };
    const onRecall = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail || {};
      if (tid !== tabId) return;
      if (!queuedRef.current) return;
      // Only the 'queued' state is recallable. Once SDK pulled the message
      // from channel ('sent'), it's already at Claude — cannot un-send.
      if (queuedStateRef.current !== 'queued') {
        console.log('[TypeAhead] recall ignored — state=' + queuedStateRef.current + ' tab=' + tabId.slice(-12));
        return;
      }
      // Remove only the front 'queued' entry; preserve any later entries
      // (none in practice — single-shot type-ahead — but defensive).
      const pending = pendingMidstreamRef.current;
      const idx = pending.findIndex(p => p.state === 'queued' && p.text === queuedRef.current);
      if (idx < 0) return;
      const [item] = pending.splice(idx, 1);
      refreshChipFromPending();
      syncPendingToStore();
      requestComposerRestore({
        rawText: item.rawText,
        chips: item.chips,
        transportText: item.text,
      }, {
        mode: 'append',
        restoreChips: true,
        reason: 'typeahead-recall',
      });
    };
    const onDismiss = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail || {};
      if (tid !== tabId) return;
      if (queuedStateRef.current !== 'queued') {
        console.log('[TypeAhead] dismiss ignored — state=' + queuedStateRef.current + ' tab=' + tabId.slice(-12));
        return;
      }
      const pending = pendingMidstreamRef.current;
      const idx = pending.findIndex(p => p.state === 'queued');
      if (idx >= 0) pending.splice(idx, 1);
      refreshChipFromPending();
      syncPendingToStore();
    };
    window.addEventListener('claude-sdk:typeahead-enqueue', onEnqueue);
    window.addEventListener('claude-sdk:typeahead-recall', onRecall);
    window.addEventListener('claude-sdk:typeahead-dismiss', onDismiss);
    return () => {
      window.removeEventListener('claude-sdk:typeahead-enqueue', onEnqueue);
      window.removeEventListener('claude-sdk:typeahead-recall', onRecall);
      window.removeEventListener('claude-sdk:typeahead-dismiss', onDismiss);
    };
  }, [tabId, refreshChipFromPending, syncPendingToStore, requestComposerRestore]);

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

  // Dictation delivery handler now lives inside SDKComposer (where it has
  // direct access to composerTextareaRef + writeComposerValue). The outer
  // querySelector approach was unreliable for multi-tab layouts.

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
        id: 'user-ext-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
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
    if (isRunning) sdkBusyEndReasonRef.current = null;
    const reason = !isRunning ? (sdkBusyEndReasonRef.current || undefined) : undefined;
    ipcRenderer.send('claude-sdk:busy-state', { tabId, busy: isRunning, reason });
    if (!isRunning) sdkBusyEndReasonRef.current = null;
    return () => {
      ipcRenderer.send('claude-sdk:busy-state', {
        tabId,
        busy: false,
        reason: sdkBusyEndReasonRef.current || undefined,
      });
    };
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

      // Verbose per-message renderer dump — gated behind a localStorage flag
      // so it's available for future SDK-stream forensics without spamming the
      // log on every run. Enable: localStorage.NOTED_DEBUG_SDK_STREAM = '1'.
      try {
        if (localStorage.getItem('NOTED_DEBUG_SDK_STREAM') === '1') {
          const m = data.message;
          console.log('[SlashProbe:Renderer] tab=' + tabId.slice(-12) + ' ' + m?.type + '/' + (m?.subtype || '') + ' keys=' + Object.keys(m || {}).join(','));
          if (m?.type === 'system') console.log('[SlashProbe:Renderer] SYSTEM_FULL=' + JSON.stringify(m).slice(0, 1000));
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
      // ====================================================================
      // Background tasks: task_started / task_progress / task_updated /
      // task_notification — SDK 0.3.x events (opt-in via agentProgressSummaries
      // + forwardSubagentText). Routed into store.bgTasks per tab, surfaced in
      // BackgroundTasksBar above the composer. Agents == kind:'agent' (have
      // subagent_type), bash run-in-background == kind:'bash' (tool_use_id ties
      // to the Bash tool_use block already in thread).
      if (msg.type === 'system' && msg.subtype === 'task_started') {
        // ---- Workflow (SDK 0.3.156 'local_workflow') ----------------------
        // GROUND TRUTH from a real run: a workflow emits ONE task_started, then
        // its phases+agents arrive via task_progress.workflow_progress[] (see
        // that branch below). There is NO per-agent task_started. So here we
        // only create the single workflow BgTask; agents are filled by progress.
        if (msg.task_type === 'local_workflow') {
          upsertBgTask(tabId, msg.task_id, {
            kind: 'workflow',
            workflowName: msg.workflow_name || msg.description || 'workflow',
            name: msg.workflow_name || msg.description || 'workflow',
            description: msg.description,
            status: 'running',
            startedAt: Date.now(),
            phases: [],
            agents: [],
          });
          return;
        }

        // SDK 0.3.x emits TWO task_started per Agent tool call:
        //   1) task_type='local_agent' subagent_type='general-purpose' — the agent itself
        //   2) task_type='local_bash' (no subagent_type) — each Bash CHILD of that agent
        // The child bashes belong inside the agent's transcript (visible via
        // TaskDetailPane → getSubagentMessages). Surfacing them as separate
        // chips in the bar is noise — drop here.
        if (msg.task_type === 'local_bash' && !msg.subagent_type) return;
        const isAgent = !!msg.subagent_type || msg.task_type === 'agent' || msg.task_type === 'local_agent';
        const head = String(msg.description || msg.prompt || msg.task_id || '').slice(0, 80);
        upsertBgTask(tabId, msg.task_id, {
          kind: isAgent ? 'agent' : 'bash',
          toolUseId: msg.tool_use_id,
          name: msg.subagent_type || (isAgent ? 'agent' : 'bash') + ': ' + head,
          description: msg.description,
          status: 'running',
          startedAt: Date.now(),
          // SDK 0.3.x: agentId in JSONL path == task_id for Task-tool subagents.
          agentSessionId: isAgent ? msg.task_id : undefined,
          // Capture initial prompt synchronously — subagent JSONL appears on
          // disk after a short delay; pane uses this until getSubagentMessages
          // returns at least 1 message.
          ...(msg.prompt ? { initialPrompt: msg.prompt } : {}),
        });
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'task_progress') {
        // Workflow progress: the UNDOCUMENTED workflow_progress[] array carries
        // the live tree. Each event is PARTIAL — only changed phases/agents —
        // so we MERGE by index into the workflow BgTask's phases/agents arrays.
        const wp = Array.isArray(msg.workflow_progress) ? msg.workflow_progress : null;
        if (wp) {
          const st = useWorkspaceStore.getState();
          let prev: { phases: any[]; agents: any[] } = { phases: [], agents: [] };
          for (const [, ws] of st.openProjects) {
            const t = ws.tabs.get(tabId);
            const bt = t?.bgTasks?.find(b => b.taskId === msg.task_id);
            if (bt) { prev = { phases: bt.phases || [], agents: bt.agents || [] }; break; }
          }
          const phaseMap = new Map<number, any>(prev.phases.map((p: any) => [p.index, p]));
          const agentMap = new Map<number, any>(prev.agents.map((a: any) => [a.index, a]));
          for (const item of wp) {
            if (item?.type === 'workflow_phase' && typeof item.index === 'number') {
              phaseMap.set(item.index, { index: item.index, title: item.title || ('Phase ' + item.index) });
            } else if (item?.type === 'workflow_agent' && typeof item.index === 'number') {
              const old = agentMap.get(item.index) || {};
              agentMap.set(item.index, {
                ...old,
                index: item.index,
                label: item.label ?? old.label,
                phaseIndex: item.phaseIndex ?? old.phaseIndex,
                phaseTitle: item.phaseTitle ?? old.phaseTitle,
                agentId: item.agentId ?? old.agentId,
                model: item.model ?? old.model,
                state: item.state ?? old.state ?? 'progress',
                tokens: item.tokens ?? old.tokens,
                toolCalls: item.toolCalls ?? old.toolCalls,
                lastToolName: item.lastToolName ?? old.lastToolName,
                lastToolSummary: item.lastToolSummary ?? old.lastToolSummary,
                promptPreview: item.promptPreview ?? old.promptPreview,
                resultPreview: item.resultPreview ?? old.resultPreview,
                durationMs: item.durationMs ?? old.durationMs,
                startedAt: item.startedAt ?? old.startedAt,
                attempt: item.attempt ?? old.attempt,
              });
            }
          }
          upsertBgTask(tabId, msg.task_id, {
            kind: 'workflow',
            phases: [...phaseMap.values()].sort((a, b) => a.index - b.index),
            agents: [...agentMap.values()].sort((a, b) => a.index - b.index),
            summary: msg.summary,
            totalTokens: msg.usage?.total_tokens,
            durationMs: msg.usage?.duration_ms,
          });
          return;
        }
        // Non-workflow task progress (standalone agent/bash).
        upsertBgTask(tabId, msg.task_id, {
          lastToolName: msg.last_tool_name,
          summary: msg.summary,
          totalTokens: msg.usage?.total_tokens,
          toolUses: msg.usage?.tool_uses,
          durationMs: msg.usage?.duration_ms,
          ...(msg.subagent_type ? { name: msg.subagent_type } : {}),
        });
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'task_updated') {
        const patch = msg.patch || {};
        // 'paused' added in SDK 0.3.156 — a workflow/agent can be paused (`p`).
        const mappedStatus = patch.status === 'running' ? 'running' as const
          : patch.status === 'completed' ? 'completed' as const
          : patch.status === 'paused' ? 'paused' as const
          : (patch.status === 'failed' || patch.status === 'killed') ? 'failed' as const
          : undefined;
        upsertBgTask(tabId, msg.task_id, {
          ...(patch.description ? { description: patch.description } : {}),
          ...(mappedStatus ? { status: mappedStatus } : {}),
          ...(typeof patch.end_time === 'number' ? { endedAt: patch.end_time } : {}),
        });
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'task_notification') {
        upsertBgTask(tabId, msg.task_id, {
          status: msg.status === 'completed' ? 'completed'
                : msg.status === 'failed' ? 'failed'
                : msg.status === 'stopped' ? 'stopped'
                : 'completed',
          outputFile: msg.output_file,
          finalSummary: msg.summary,
          totalTokens: msg.usage?.total_tokens,
          toolUses: msg.usage?.tool_uses,
          durationMs: msg.usage?.duration_ms,
          endedAt: Date.now(),
        });
        return;
      }
      if (msg.type === 'tool_progress' && msg.task_id) {
        // Accumulate a rolling activity log (last ~12 tool calls) + monotonic
        // total, feeding the detail pane's "Activity · last 3 of N tool calls".
        const st = useWorkspaceStore.getState();
        let prevActivity: string[] = [];
        let prevTotal = 0;
        for (const [, ws] of st.openProjects) {
          const t = ws.tabs.get(tabId);
          const bt = t?.bgTasks?.find(b => b.taskId === msg.task_id);
          if (bt) { prevActivity = bt.activity || []; prevTotal = bt.toolCallTotal || 0; break; }
        }
        const nextActivity = [...prevActivity, String(msg.tool_name || '?')].slice(-12);
        upsertBgTask(tabId, msg.task_id, {
          lastToolName: msg.tool_name,
          activity: nextActivity,
          toolCallTotal: prevTotal + 1,
          durationMs: typeof msg.elapsed_time_seconds === 'number'
            ? Math.round(msg.elapsed_time_seconds * 1000)
            : undefined,
        });
        return;
      }
      // SDK 0.3.x leaks subagent stream events into the parent iterator —
      // both user AND assistant records carry `parent_tool_use_id` (set to the
      // parent's Agent tool_use block id) and `subagent_type`. Drop them all:
      // they belong to the subagent transcript only (TaskDetailPane loads
      // them via getSubagentMessages from agent-<id>.jsonl). Without this
      // every Bash/Read tool the subagent ran appeared TWICE — once inside
      // the subagent pane and a second time as a ghost card in the main
      // thread under the parent's Agent tool_use card.
      if ((msg.type === 'user' || msg.type === 'assistant') &&
          (msg.parent_tool_use_id || msg.subagent_type)) {
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
        if (localStorage.getItem('NOTED_DEBUG_SDK_STREAM') === '1') {
          const isFromSub = !!(msg.parent_tool_use_id || msg.subagent_type);
          const blockTypes = Array.isArray(msg.message.content) ? msg.message.content.map((b: any) => b?.type).join(',') : 'string';
          console.warn('[BgProbeR:Assistant] tab=' + tabId.slice(-12) + ' fromSub=' + isFromSub + ' subagent_type=' + (msg.subagent_type || 'null') + ' blocks=' + blockTypes + ' modelEcho=' + msg.message?.model?.slice?.(0,20));
        }
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
          // Cache split → ControlBar cooldown chip. SDK runs directly against
          // Anthropic (no proxy in the loop), so unlike PTY we publish from here
          // via the same window-event pattern as sdk-context-update. ts = the
          // moment this turn touched the cache (cooldown anchor, server 1h TTL).
          const cr = u.cache_read_input_tokens || 0;
          const cc = u.cache_creation_input_tokens || 0;
          if (cr > 0 || cc > 0) {
            window.dispatchEvent(new CustomEvent('sdk-cache-update', {
              detail: { tabId, cacheRead: cr, cacheCreate: cc, input: u.input_tokens || 0, ts: Date.now() },
            }));
          }
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

        // Note: mid-stream chip→bubble promotion is driven by main process
        // event `claude-sdk:midstream-consumed` (handler below), NOT by the
        // first assistant chunk after a push. SDK only consumes a pushed
        // priority:'next' message at the boundary between its sub-iterations
        // — that's the exact moment Claude's JSONL gets the `attachment`
        // record. Promoting on the next assistant chunk would put the bubble
        // ABOVE the in-flight tool/text block that fired before SDK actually
        // drained the channel, mis-ordering the visual thread relative to
        // JSONL ground truth.
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

        // Turn-end cleanup. JSONL is the source of truth: every entry that
        // actually made it into the transcript was already promoted by
        // handleMidstreamJsonlLanded. Anything still in pending after `result`
        // arrives is not in JSONL and never will be (Claude wouldn't see it
        // on resume), so we drop silently. Don't render a ghost bubble that
        // doesn't match the transcript.
        if (pendingMidstreamRef.current.length > 0) {
          const remaining = pendingMidstreamRef.current.splice(0);
          const sent = remaining.filter(p => p.state === 'sent').length;
          const queued = remaining.filter(p => p.state === 'queued').length;
          console.log('[TypeAhead] turn-end drop sent=' + sent + ' queued=' + queued + ' tab=' + tabId.slice(-12));
          queuedRef.current = null;
          setQueued(null);
          queuedStateRef.current = null;
          setQueuedState(null);
          syncPendingToStore();
        }
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
      // A turn that ends can't have a live question parked anymore.
      setActiveQuestion(null);
    };

    // Interactive AskUserQuestion bridge (main canUseTool parked a question).
    const handleAskQuestion = (_: any, data: { tabId: string; toolUseID: string; questions: SDKQuestion[] }) => {
      if (data.tabId !== tabId) return;
      setActiveQuestion({ toolUseID: data.toolUseID, questions: data.questions || [] });
    };
    // Main resolved/aborted the parked question on its own (turn abort, session
    // end) — tear the dialog down so the composer returns.
    const handleQuestionCancelled = (_: any, data: { tabId: string; toolUseID?: string }) => {
      if (data.tabId !== tabId) return;
      setActiveQuestion((cur) => (cur && (!data.toolUseID || cur.toolUseID === data.toolUseID) ? null : cur));
    };

    // Stage 2 transition: SDK pulled the pushed message out of the input
    // channel and forwarded it to Claude CLI. Chip stays above the input
    // but switches to gray (sent) — cannot be recalled. The actual JSONL
    // landing is reported separately via `claude-sdk:midstream-jsonl-landed`.
    const handleMidstreamConsumed = (_: any, data: { tabId: string; text: string; ts: number }) => {
      if (data.tabId !== tabId) return;
      const pending = pendingMidstreamRef.current;
      // Match the oldest queued entry with the same text and flip its state.
      const idx = pending.findIndex(p => p.state === 'queued' && p.text === data.text);
      if (idx < 0) {
        console.log('[TypeAhead] consumed event with no matching queued tab=' + tabId.slice(-12));
        return;
      }
      pending[idx].state = 'sent';
      console.log('[TypeAhead] queued→sent idx=' + idx + ' tab=' + tabId.slice(-12));
      // Visual: if the front of the queue is now 'sent', flip the chip color.
      if (pending[0] && pending[0].state === 'sent') {
        queuedStateRef.current = 'sent';
        setQueuedState('sent');
      }
      syncPendingToStore();
    };

    // Stage 3 transition: the queued_command attachment record has been
    // written to the session JSONL by Claude CLI. This is the authoritative
    // position for the user-bubble in the thread. Remove from pending and
    // insert a user-bubble (with wasQueued tag) at the current end of the
    // thread — chunks that arrive after this lands will go below the bubble,
    // mirroring how the JSONL records the order.
    const handleMidstreamJsonlLanded = (_: any, data: { tabId: string; text: string; attachmentUuid: string | null; ts: number }) => {
      if (data.tabId !== tabId) return;
      const pending = pendingMidstreamRef.current;
      // Match by text. Prefer 'sent' entries (they should always be the ones
      // landing); fall back to 'queued' if the consumed event somehow got
      // skipped (e.g. very fast write between consume and JSONL flush).
      let idx = pending.findIndex(p => p.state === 'sent' && p.text === data.text);
      if (idx < 0) idx = pending.findIndex(p => p.text === data.text);
      if (idx < 0) {
        console.log('[TypeAhead] jsonl-landed no matching pending tab=' + tabId.slice(-12) + ' textLen=' + data.text.length);
        return;
      }
      const [promotedItem] = pending.splice(idx, 1);
      console.log('[TypeAhead] promote-on-jsonl-landed idx=' + idx + ' uuid=' + (data.attachmentUuid || '?').slice(-8) + ' remaining=' + pending.length + ' tab=' + tabId.slice(-12));
      refreshChipFromPending();
      syncPendingToStore();
      setMessages(prev => {
        // Finalize any open streaming placeholder so the user-bubble + next
        // chunks split cleanly into separate messages.
        const finalized = prev.map(m => {
          if (m.id !== 'streaming-' + tabId) return m;
          return { ...m, id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
        });
        const rng = Math.random().toString(36).slice(2, 8);
        return [...finalized, {
          id: 'user-queued-' + (data.attachmentUuid || promotedItem.ts) + '-' + rng,
          role: 'user' as const,
          text: promotedItem.text,
          toolCalls: [],
          thinking: null,
          timestamp: data.ts || promotedItem.ts,
          wasQueued: true,
        }];
      });
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
    ipcRenderer.on('claude-sdk:midstream-consumed', handleMidstreamConsumed);
    ipcRenderer.on('claude-sdk:midstream-jsonl-landed', handleMidstreamJsonlLanded);
    ipcRenderer.on('claude-sdk:ask-question', handleAskQuestion);
    ipcRenderer.on('claude-sdk:question-cancelled', handleQuestionCancelled);
    return () => {
      ipcRenderer.removeListener('claude-sdk:message', handleMessage);
      ipcRenderer.removeListener('claude-sdk:done', handleDone);
      ipcRenderer.removeListener('claude-sdk:stale-resume-cleared', handleStaleResume);
      ipcRenderer.removeListener('claude-sdk:midstream-consumed', handleMidstreamConsumed);
      ipcRenderer.removeListener('claude-sdk:midstream-jsonl-landed', handleMidstreamJsonlLanded);
      ipcRenderer.removeListener('claude-sdk:ask-question', handleAskQuestion);
      ipcRenderer.removeListener('claude-sdk:question-cancelled', handleQuestionCancelled);
    };
  }, [tabId, updateSDKState, syncPendingToStore, refreshChipFromPending]);

  // ---- Send core — shared by manual onNew AND type-ahead auto-send ----
  // Takes the FINAL prompt string (paste-chips already embedded by the caller).
  // Does NOT gate on isRunning: `onNew` runs the HARD GATE before calling, and
  // the type-ahead auto-send (claude-sdk:turn-complete listener in SDKComposer)
  // fires exactly on turn-end when the previous query is already torn down. The
  // queued message bypasses the composer entirely, so whatever the user typed
  // AFTER queueing stays untouched in the input.
  const dispatchPrompt = useCallback(async (
    text: string,
    opts?: { wasQueued?: boolean; authoringSnapshot?: SDKComposerDraftSnapshot },
  ) => {
    if (!text.trim()) return false;
    // `wasQueued` — был ли этот prompt отправлен из type-ahead очереди (Enter
    // во время стриминга → парк в QUEUED → auto-send на result event). Юзер
    // визуально отличает background-сообщения от обычных submit'ов: они едут
    // одинаковым путём через query(), но в треде помечаются маленьким
    // оранжевым chip'ом "queued". Флаг live-only — после reload теряется,
    // потому что Anthropic JSONL не хранит наши UI-метаданные. Native TUI
    // делает то же (см. useQueuedMessage context — UI-only, no persistence).
    const wasQueued = !!opts?.wasQueued;
    const authoringSnapshot: SDKComposerDraftSnapshot = opts?.authoringSnapshot || {
      rawText: text,
      chips: [],
      transportText: text,
    };
    let optimisticUserId: string | null = null;

    // [SlashProbe] Detect slash-command prefix in user input. If SDK
    // intercepts these we'll see system messages back; if not, the text
    // goes to the API as-is (Claude reads it literally).
    const slashMatch = text.match(/^\/(\S+)(?:\s|$)/);
    if (slashMatch) {
      console.log('[SlashProbe:dispatch] tab=' + tabId.slice(-12) + ' SLASH_DETECTED cmd=/' + slashMatch[1] + ' fullPrompt=' + JSON.stringify(text.slice(0, 200)));
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
      console.log('[SlashProbe:dispatch] tab=' + tabId.slice(-12) + ' normal_prompt len=' + text.length);
    }

    setIsRunning(true);
    setWasStopped(false); // user opted into a new turn — drop the Resume affordance
    // Start at 'fetching' — pure network/warm-up window before SDK sends
    // anything. Flips to 'thinking' on system:init, 'typing'/'tool_use' as
    // first content arrives. See handleMessage phase-machine below.
    updateSDKState(tabId, { sdkState: 'fetching' });

    if (wasQueued) {
      // Mid-stream type-ahead path. Three lifecycle stages:
      //   1. queued (orange chip): pushed locally to main, SDK has not yet
      //      pulled it. Reversible (Esc/↑ returns text to input).
      //   2. sent   (gray chip):   main got `claude-sdk:midstream-consumed`
      //      from createInputChannel's onConsumed — SDK pulled the message
      //      out of the input channel and forwarded it to the Claude CLI
      //      subprocess. Cannot be recalled (it's at Claude). The CLI then
      //      decides when to flush the attachment record into JSONL — that
      //      can be 100ms or 5+ seconds later, on the next tool/turn
      //      boundary.
      //   3. landed (thread bubble): main saw the `attachment` line with
      //      type 'queued_command' appear in the session JSONL via
      //      fs.watch tail-read. This is the authoritative position — we
      //      promote chip → user-bubble HERE, so the visual order matches
      //      what the JSONL records and what native Claude TUI shows.
      // Fallbacks: turn-end (`result`) promotes any still-pending sent
      // entries as unconfirmed user-bubble (timeout safety, no permanent
      // hang). Manual stop discards pending state.
      queuedRef.current = text;
      setQueued(text);
      queuedStateRef.current = 'queued';
      setQueuedState('queued');
      pendingMidstreamRef.current.push({
        text,
        rawText: authoringSnapshot.rawText,
        chips: authoringSnapshot.chips.map((chip) => ({ ...chip })),
        ts: Date.now(),
        state: 'queued',
      });
      syncPendingToStore();
    } else {
      // Fresh turn path (нет live session или юзер явно сабмитнул когда
      // Claude уже закончил): query() стартует с этим prompt'ом, Anthropic
      // запишет его в JSONL → bubble консистентен с persistence.
      const rng = Math.random().toString(36).slice(2, 8);
      const userId = 'user-' + Date.now() + '-' + rng;
      optimisticUserId = userId;
      setMessages(prev => {
        const finalized = prev.map(m => {
          if (m.id !== 'streaming-' + tabId) return m;
          return { ...m, id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
        });
        return [...finalized, {
          id: userId, role: 'user' as const,
          text, toolCalls: [], thinking: null, timestamp: Date.now(),
          wasQueued: false,
        }];
      });
    }

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
    let result: any;
    try {
      result = await ipcRenderer.invoke(ipcChannel, {
        tabId, cwd, prompt: text, model: sdkModel, effort: sdkEffort, thinking: sdkThinking,
        resumeSessionId: sessionIdRef.current || null,
        // wasQueued — desktop type-ahead очередь auto-sent эту запись. Прокидываем
        // флаг в main → main передаёт его в _webBroadcast synthetic user-message
        // → mobile UI рендерит "queued" chip. Anthropic SDK сам флаг не видит,
        // payload отправляется как обычный prompt; это чисто UI-метаданные для
        // mobile-клиента.
        wasQueued,
      });
    } catch (error: any) {
      result = {
        success: false,
        error: error?.message || String(error),
      };
    }

    if (!result?.success) {
      const errorText = result?.error || 'unknown error';
      setIsRunning(false);
      updateSDKState(tabId, { sdkState: 'error' });
      showToast('Claude SDK: ' + errorText, 'error', 6000);
      setMessages((previous) => {
        const withoutUnsentOptimistic = optimisticUserId
          ? previous.filter((message) => message.id !== optimisticUserId)
          : previous;
        return [...withoutUnsentOptimistic, {
          id: 'error-' + Date.now(), role: 'system' as const,
          text: 'Error: ' + errorText, toolCalls: [], thinking: null, timestamp: Date.now(),
        }];
      });
      if (wasQueued) {
        const pending = pendingMidstreamRef.current;
        const failedIndex = pending.findIndex((item) => (
          item.state === 'queued'
          && item.text === text
          && item.rawText === authoringSnapshot.rawText
          && haveSameComposerChips(item.chips, authoringSnapshot.chips)
        ));
        if (failedIndex >= 0) {
          const [failedItem] = pending.splice(failedIndex, 1);
          refreshChipFromPending();
          syncPendingToStore();
          requestComposerRestore({
            rawText: failedItem.rawText,
            chips: failedItem.chips,
            transportText: failedItem.text,
          }, {
            mode: 'append',
            restoreChips: true,
            reason: 'typeahead-send-failed',
          });
        } else {
          console.log('[TypeAhead] send failed after ownership transfer; draft not restored tab='
            + tabId.slice(-12));
        }
      }
      return false;
    }
    return true;
  }, [
    tabId,
    cwd,
    updateSDKState,
    syncPendingToStore,
    refreshChipFromPending,
    requestComposerRestore,
  ]);
  // Keep the ref current so the message-handler effect (defined above
  // dispatchPrompt) can auto-send the type-ahead queue at turn-end.
  useEffect(() => { dispatchPromptRef.current = dispatchPrompt; }, [dispatchPrompt]);

  // ---- Send handler for external store ----
  const onNew = useCallback(async (message: AppendMessage) => {
    const textPart = message.content.find((p: any) => p.type === 'text');
    const messageInputText = textPart?.type === 'text' ? textPart.text : '';
    const composerChips = normalizeComposerChips(
      sdkComposerChipsRef.current,
    ) as SDKComposerChip[];
    // Chip-only submit uses one temporary space solely to pass assistant-ui's
    // non-empty gate. It is not part of the user's authoring draft.
    const rawInputText = messageInputText === ' ' && composerChips.length > 0
      ? ''
      : messageInputText;
    const inputText = rawInputText.trim();
    const serializedDraft = serializeComposerDraft({
      text: inputText,
      chips: composerChips,
    });
    const text = !inputText
      && composerChips.length > 0
      && composerChips.every((chip) => chip.kind === 'paste')
      ? serializedDraft + '\n\nAnalyze this content'
      : serializedDraft;
    if (!text.trim()) return;

    // HARD GATE — pre-empts programmatic sends which bypass the composer's
    // keydown handler. A live SDK query cannot accept a second independent
    // submit, so this path must join the same one-slot type-ahead flow rather
    // than clear or silently drop the author's draft.
    const currentlyRunning = isRunning || (() => {
      const s = useWorkspaceStore.getState();
      for (const [, ws] of s.openProjects) {
        const t = ws.tabs.get(tabId);
        if (t) return t.sdkState === 'thinking' || t.sdkState === 'tool_use';
      }
      return false;
    })();
    if (currentlyRunning) {
      if (queuedRef.current != null) {
        try {
          useUIStore.getState().showToast(
            'Already queued: edit or discard the chip above the input first.',
            'info',
            3500,
          );
        } catch {}
        window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-flash', {
          detail: { tabId },
        }));
        // assistant-ui clears its input after onNew resolves. Restore on the
        // following paint; equality protection in the receiver makes this a
        // no-op if a future runtime stops clearing rejected submissions.
        requestAnimationFrame(() => requestComposerRestore({
          rawText: rawInputText,
          chips: composerChips,
          transportText: text,
        }, {
          mode: 'prepend',
          restoreChips: false,
          reason: 'typeahead-slot-occupied',
        }));
        return;
      }
      window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-enqueue', {
        detail: {
          tabId,
          text,
          snapshot: {
            rawText: rawInputText,
            chips: composerChips.map((chip) => ({ ...chip })),
            transportText: text,
          },
        },
      }));
      clearSDKComposerChipSnapshot(composerChips);
      return;
    }

    const accepted = await dispatchPrompt(text);
    if (accepted && composerChips.length > 0) {
      clearSDKComposerChipSnapshot(composerChips);
    } else if (!accepted) {
      requestComposerRestore({
        rawText: rawInputText,
        chips: composerChips,
        transportText: text,
      }, {
        mode: 'prepend',
        // Chips remain owned by the outer tab until accepted; restoring them
        // again would duplicate paste chips.
        restoreChips: false,
        reason: 'fresh-send-failed',
      });
    }
  }, [
    tabId,
    isRunning,
    dispatchPrompt,
    clearSDKComposerChipSnapshot,
    requestComposerRestore,
  ]);

  const onCancel = useCallback(async () => {
    const eId = 'E' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_ENTER ${eId} isRunningRef=${isRunningRef.current} queued=${!!queuedRef.current}`); } catch {}
    // Early-return when no live turn. Bug 2026-05-28: assistant-ui's runtime
    // calls `onCancel` on Escape regardless of whether anything is running. If
    // the turn already completed, our rollback branch (B) below would find no
    // streaming placeholder and proceed to drop the last user→assistant pair
    // from history (and truncate JSONL up to that user msg). Юзер: «ответ уже
    // был дан, я нажал Escape, и у меня в итоге история просто стёрлась».
    // Window-level handler on line ~1991 already guards by `isRunning`; this
    // mirrors that for the runtime-driven path. Anything destructive only when
    // there is actually a turn to cancel.
    if (!isRunningRef.current) {
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_EARLY_RETURN ${eId} reason=not-running`); } catch {}
      return;
    }

    // Type-ahead handling on cancel — JSONL is the source of truth.
    // queued: never reached the channel → recall to composer for resend.
    // sent:   not yet in JSONL → drop silently (Claude wouldn't see it on
    //         resume either; transcript is what's real).
    // Anything that already landed in JSONL was promoted by
    // handleMidstreamJsonlLanded before cancel fired.
    {
      const pending = pendingMidstreamRef.current;
      const queuedItems = pending.filter(p => p.state === 'queued');
      const droppedSent = pending.filter(p => p.state === 'sent').length;
      pendingMidstreamRef.current = [];
      queuedRef.current = null;
      setQueued(null);
      queuedStateRef.current = null;
      setQueuedState(null);
      syncPendingToStore();
      if (queuedItems.length > 0) {
        const item = queuedItems[0];
        requestComposerRestore({
          rawText: item.rawText,
          chips: item.chips,
          transportText: item.text,
        }, {
          mode: 'append',
          restoreChips: true,
          reason: 'cancel-recall',
        });
      }
      if (droppedSent > 0) {
        console.log('[TypeAhead] cancel-time drop unconfirmed sent=' + droppedSent + ' tab=' + tabId.slice(-12));
      }
    }
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
    // Escape = SOFT interrupt (native Esc): stop the current TURN, keep the
    // process + session + any background workflow agents ALIVE. We do NOT pass
    // hard:true and do NOT stopTask — background agents keep running and will
    // still deliver their task_notification. (Branch B below escalates to a
    // hard kill before truncating, because JSONL surgery can't run under a live
    // stream.) The interrupted partial answer gets the «⊘ stopped» badge.
    const sid = sessionIdRef.current;
    sdkBusyEndReasonRef.current = 'interrupt';
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

      try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_SNAPSHOT ${eId} prevLen=${prev.length} streamingIdx=${streamingIdx} lastUserIdx=${lastUserIdx} hasContent=${hasContent}`); } catch {}
      // (A) Content captured → keep everything. We just rename the streaming
      // placeholder to a stable id so it survives re-renders (mirrors what the
      // `result` handler usually does, but we beat it by cancelling).
      if (hasContent) {
        try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_BRANCH_A ${eId} keep-all`); } catch {}
        const stoppedId = 'msg-' + Date.now();
        // Live "stopped" badge: tag the kept partial NOW so the «⊘ stopped»
        // plate shows instantly, without waiting for the JSONL marker to land +
        // a reload. The durable source (loadHistory marker detection) re-derives
        // the same flag on reopen, so the two agree.
        setInterruptedForMsg(stoppedId);
        return prev.map(m => {
          if (m.id !== 'streaming-' + tabId) return m;
          const nextParts: AssistantPart[] | undefined = m.parts?.map(p =>
            p.type === 'tool' && p.status === 'running' ? { ...p, status: 'done' as const } : p
          );
          const d = nextParts ? assembleMessageFields(nextParts) : null;
          return {
            ...m,
            id: stoppedId,
            interrupted: true,
            parts: nextParts,
            toolCalls: d ? d.toolCalls : m.toolCalls.map(t => t.status === 'running' ? { ...t, status: 'done' as const } : t),
          };
        });
      }

      // (B) Nothing captured → drop user + empty streaming placeholder. Stash
      // the original text in pendingRollback so we can push it back into the
      // composer + (maybe) truncate JSONL after the setMessages commit.
      if (lastUserIdx === -1) {
        try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_BRANCH_B_NOOP ${eId} no-user-to-rollback`); } catch {}
        return prev; // nothing to roll back
      }
      const userMsg = prev[lastUserIdx];
      // Only persisted user messages have a real JSONL uuid; placeholders
      // ("user-…") never made it to disk yet (or arrived without a uuid swap),
      // so we skip the truncate IPC in that case.
      const userUuidForTruncate = isPersistedMsgId(userMsg.id) ? userMsg.id : null;
      pendingRollback = { userMsg, userUuidForTruncate };
      const cutoff = streamingIdx === -1 ? lastUserIdx : Math.min(lastUserIdx, streamingIdx);
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] ESCAPE_BRANCH_B ${eId} cutoff=${cutoff} dropCount=${prev.length - cutoff} userMsgId=${userMsg.id?.slice(0,8)} userPersisted=${!!userUuidForTruncate}`); } catch {}
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
        // Branch B rewrites the JSONL (drop the empty turn). The soft interrupt
        // above left the session ALIVE — truncating under a live stream would
        // corrupt the parentUuid chain. Escalate to a HARD kill first so the
        // query is fully torn down before JSONL surgery. (Branch B only fires
        // when the assistant produced nothing, so killing the empty turn is safe.)
        try { await ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true }); }
        catch (err: any) { console.warn('[ClaudeSDKTab:onCancel] hard-stop before truncate threw:', err?.message); }
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
  }, [tabId, cwd, updateSDKState, syncPendingToStore, requestComposerRestore]);

  // Edit / Repeat action busy flag — separate from isRunning so the streaming
  // spinner doesn't fire prematurely on truncate, and both action buttons get
  // disabled together while the JSONL surgery + new send is in flight.
  const [actionBusy, setActionBusy] = useState(false);
  // Synchronous click-storm guard. React's `actionBusy` state setter is async —
  // a fast double/triple-click on Repeat fires multiple onClick handlers before
  // React flushes the first `setActionBusy(true)`, so they all see `actionBusy=false`
  // and each spawns its own `send-message`. Юзер: «нажимал 1 раз — в таймлайне 4
  // запроса». A useRef flipped synchronously inside the handler closes the gap.
  const actionInFlightRef = useRef(false);

  // Find the JSONL uuid corresponding to a UI message id. For history-loaded
  // entries id === uuid. For freshly-sent messages we used "user-<ts>" / "streaming-<tabId>"
  // — those have no JSONL uuid yet. Caller should fall back to "find user msg by
  // index in messages[] and use the assistant chain just before it" via the
  // SDK's session_id metadata. Cheaper: only allow Edit/Repeat on persisted msgs.
  const isPersistedMsgId = (id: string) => id && !id.startsWith('user-') && !id.startsWith('streaming-') && !id.startsWith('hist-') && !id.startsWith('msg-') && !id.startsWith('init-') && !id.startsWith('error-');

  // Repeat/Edit — идемпотентный путь на «позиции user-сообщения».
  // N-ный по счёту user msg в треде → удалить ВСЁ на диске начиная с этой
  // позиции (включая её) → послать заново. Кликаешь 5 раз подряд = 5 раз
  // одинаковая операция: каждый клик возвращает тред к одному и тому же
  // состоянию (первые N-1 user-prompts + новая попытка N-ного).
  // Никаких persisted/placeholder развилок: позиция в треде стабильна между
  // кликами, msgId меняется (после resend новый user получает временный
  // placeholder id) но позиция — нет.
  const truncateAndResend = useCallback(async (uiMsgId: string, newText: string) => {
    const diagId = 'D' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (actionInFlightRef.current) {
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] STORM_GUARD ${diagId} reject`); } catch {}
      return;
    }
    actionInFlightRef.current = true;

    const sid = sessionIdRef.current;
    // Position = index среди USER-сообщений (не общий). Это инвариант: каждый
    // юзер видит "первый, второй, третий user-prompt" — порядок не меняется
    // когда мы переотправляем N-ный (все ≥N сносятся, потом N добавляется).
    const arr = messagesRef.current;
    const flatIdx = arr.findIndex(m => m.id === uiMsgId);
    if (flatIdx === -1) {
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] ABORT ${diagId} reason=msg-not-in-ref id=${uiMsgId?.slice(0,8)}`); } catch {}
      actionInFlightRef.current = false;
      return;
    }
    let userPos = 0;
    for (let i = 0; i < flatIdx; i++) if (arr[i].role === 'user') userPos++;

    try { ipcRenderer.send('log:renderer', `[RepeatDiag] ENTER ${diagId} userPos=${userPos} flatIdx=${flatIdx} sid=${sid?.slice(0,8)} textLen=${newText?.length}`); } catch {}

    if (!sid) {
      console.warn('[ClaudeSDKTab:truncateAndResend] no sessionId');
      actionInFlightRef.current = false;
      return;
    }
    setActionBusy(true);

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
    const showToast = useUIStore.getState().showToast;
    lastRequestRef.current = { modelAlias: sdkModelAlias, effort: sdkEffort };
    modelMismatchToastedRef.current = false;

    // Optimistic local trim. Снапшот для отката, потом синхронно режем
    // визуальный список до flatIdx (всё что было ≥ удаляем) + добавляем
    // новый user-msg на месте N-ного.
    let snapshot: SDKChatMessage[] | null = null;
    const newUserMsg: SDKChatMessage = {
      id: 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      role: 'user' as const,
      text: newText,
      toolCalls: [], thinking: null,
      timestamp: Date.now(),
    };
    setMessages(prev => {
      snapshot = prev;
      const next = [...prev.slice(0, flatIdx), newUserMsg];
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] OPTIMISTIC_TRIM ${diagId} prevLen=${prev.length} cut=${flatIdx} nextLen=${next.length}`); } catch {}
      return next;
    });
    setWasStopped(false);

    try {
      // Stop сначала — он триггерит main → 'claude-sdk:done' → handleDone →
      // setIsRunning(false) + sdkState='idle'. Если мы поставим fetching ДО
      // stop'а, done прилетит сразу после и затрёт наш fetching. Поэтому
      // setIsRunning(true) + sdkState='fetching' ПОСЛЕ stop, прямо перед send.
      const existing = await ipcRenderer.invoke('claude-sdk:has-active-session', { tabId }).catch(() => null);
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] HAS_ACTIVE ${diagId} active=${!!existing?.active}`); } catch {}
      if (existing?.active) {
        // HARD kill — Edit/Repeat rewrites the JSONL; the query must be fully
        // torn down (not merely soft-interrupted) before truncate-history.
        // Surface a deterministic "останавливаю процесс…" cue on the control-bar
        // indicator so the user sees the process is being killed (not a hang)
        // before the new turn starts. The process-state alive:false from the
        // hard kill flips the dot to ОСТАНОВЛЕН; this label rides alongside.
        window.dispatchEvent(new CustomEvent('claude-sdk:stopping', { detail: { tabId } }));
        await ipcRenderer.invoke('claude-sdk:stop', { tabId, hard: true, runningTaskIds: [] });
        try { ipcRenderer.send('log:renderer', `[RepeatDiag] STOPPED_ACTIVE ${diagId}`); } catch {}
      }

      try { ipcRenderer.send('log:renderer', `[RepeatDiag] TRUNCATE_INVOKE ${diagId} userPos=${userPos}`); } catch {}
      const truncRes = await ipcRenderer.invoke('claude-sdk:truncate-history', {
        sessionId: sid, cwd: tabCwd, userPosition: userPos,
      });
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] TRUNCATE_RESULT ${diagId} success=${!!truncRes?.success} removed=${truncRes?.removed ?? '?'} err=${truncRes?.error || 'none'}`); } catch {}
      if (!truncRes?.success) {
        console.error('[ClaudeSDKTab:truncateAndResend] backend failed:', truncRes?.error);
        showToast('Truncate failed: ' + (truncRes?.error || 'unknown'), 'error', 6000);
        if (snapshot) setMessages(snapshot);
        return;
      }

      // Loader ON — после stop+truncate, прямо перед send. Любой late `done`
      // event от прошлой query уже отработал (он прилетает синхронно с
      // close(), мы только что await'нули stop). Теперь fetching устоит.
      setIsRunning(true);
      updateSDKState(tabId, { sdkState: 'fetching' });
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] LOADER_ON ${diagId}`); } catch {}

      try { ipcRenderer.send('log:renderer', `[RepeatDiag] SEND_INVOKE ${diagId} resumeSid=${sessionIdRef.current?.slice(0,8)}`); } catch {}
      const result = await ipcRenderer.invoke('claude-sdk:send-message', {
        tabId, cwd: tabCwd, prompt: newText, model: sdkModel, effort: sdkEffort, thinking: sdkThinking,
        resumeSessionId: sessionIdRef.current || null,
      });
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] SEND_RESULT ${diagId} success=${!!result?.success} err=${result?.error || 'none'}`); } catch {}
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
      actionInFlightRef.current = false;
    }
  }, [tabId, cwd, updateSDKState]);

  const userMsgActions = useMemo<UserMsgActions>(() => ({
    onRepeat: (msgId) => {
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] CLICK onRepeat msgId=${msgId?.slice(0,8)} actionBusy=${actionBusy} isRunning=${isRunning}`); } catch {}
      // Read text via messagesRef synchronously WITHOUT wrapping in setMessages.
      // Раньше тут был `setMessages(prev => { …; return prev })` — outer return
      // prev побеждал inner trim в одном React batch'е, оптимистичный срез
      // молча перетирался. messagesRef.current даёт ту же актуальную копию
      // без побочки на state.
      const m = messagesRef.current.find(x => x.id === msgId);
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] CLICK onRepeat foundInMessages=${!!m} refLen=${messagesRef.current.length}`); } catch {}
      if (m) truncateAndResend(msgId, m.text);
    },
    onEdit: (msgId, newText) => {
      try { ipcRenderer.send('log:renderer', `[RepeatDiag] CLICK onEdit msgId=${msgId?.slice(0,8)} textLen=${newText?.length} actionBusy=${actionBusy} isRunning=${isRunning}`); } catch {}
      truncateAndResend(msgId, newText);
    },
    // Disable Edit/Repeat when: a repeat/edit is mid-flight (actionBusy), the
    // turn is streaming (isRunning — like native /rewind only between turns), OR
    // a background agent is still running (bgAgentRunning — a hard kill to
    // rewrite history would abort it). Enabled only on a fully-idle turn.
    busy: actionBusy || isRunning || bgAgentRunning,
  }), [actionBusy, isRunning, bgAgentRunning, truncateAndResend]);

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

  // Resolve the active AskUserQuestion. answers → allow (model continues with
  // the answers). stop → deny+interrupt (turn aborts; focus returns to composer
  // so the user types free text). Clears the dialog optimistically; main also
  // emits claude:awaiting-input false. The focus-composer dispatch is caught by
  // the outer ClaudeSDKTab listener (survives the composer remount).
  const answerQuestion = useCallback(async (answers: Record<string, string> | null, stop: boolean) => {
    const q = activeQuestion;
    if (!q) return;
    setActiveQuestion(null);
    try {
      await ipcRenderer.invoke('claude-sdk:answer-question', {
        tabId,
        toolUseID: q.toolUseID,
        questions: q.questions,
        answers: answers || {},
        stop,
      });
    } catch (e: any) {
      console.error('[SDKAskQuestion] answer-question invoke failed', e);
    }
    if (stop) {
      // Return focus to the (now-remounted) composer for manual input.
      setTimeout(() => window.dispatchEvent(new CustomEvent('claude-sdk:focus-composer', { detail: { tabId } })), 0);
    }
  }, [activeQuestion, tabId]);
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

  // Mirror the SDK context % to ClaudeControlBar (lives under the Terminal
  // column). Bar can't read this from main — SDK does not stream through IPC —
  // so we publish via the same window-event pattern already used elsewhere
  // ('history-panel:loading'). Bar has its own listener gated by tabId.
  useEffect(() => {
    if (contextPercentRemaining == null) return;
    window.dispatchEvent(new CustomEvent('sdk-context-update', {
      detail: { tabId, contextPct: contextPercentRemaining, model: currentModelLabel },
    }));
  }, [tabId, contextPercentRemaining, currentModelLabel]);

  // Escape (or Ctrl+[ / Ctrl+C — Claude TUI aliases): three roles by precedence.
  //   1. Slash-overlay open → close overlay.
  //   2. Query running → cancel running query.
  //   3. Otherwise → no-op (let event bubble for native behavior).
  // Все три hotkey'я (ESC / Ctrl+[ / Ctrl+C) терминалы посылают как 0x1b,
  // muscle memory из CLI работает в overlay'е без сюрпризов.
  useEffect(() => {
    if (!isVisible) return;
    const handler = (e: KeyboardEvent) => {
      // e.code для физических клавиш — иначе на русской/немецкой раскладке
      // Ctrl+C приходит как e.key='с'/'c' (Cyrillic) и handler не срабатывает.
      // CLAUDE.md: «Captured хоткей собирается через e.code, не e.key».
      const isEscapeAlias = e.key === 'Escape'
        || (e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'KeyC'));
      if (!isEscapeAlias) return;
      if (slashOverlay) {
        e.preventDefault();
        setSlashOverlay(null);
        return;
      }
      if (isRunning) {
        try { ipcRenderer.send('log:renderer', `[RepeatDiag] WINDOW_ESCAPE_TRIGGER isRunning=true → onCancel()`); } catch {}
        e.preventDefault();
        onCancel();
      } else {
        try { ipcRenderer.send('log:renderer', `[RepeatDiag] WINDOW_ESCAPE_IGNORE isRunning=false`); } catch {}
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
        detail: {
          tabId,
          text,
          source: 'sdk-context-menu',
          kind: 'prompt',
          label: payload.title || payload.name || 'Prompt',
          sourceKey: `prompt:${payload.id || payload.title || payload.name || text}`,
        },
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
      if (m.role === 'assistant') {
        if (!m.text.trim() && m.toolCalls.length === 0 && !m.thinking) return false;
        // Skip turns whose only "content" is Task* / TodoWrite mgmt (no text,
        // no thinking, all toolCalls are Task tools). They are already
        // represented in TaskListPanel above the composer; rendering an empty
        // bubble for them is noise. См. aggregateTasksFromMessages.
        if (!m.text.trim() && !m.thinking && m.toolCalls.length > 0 && m.toolCalls.every(t => TASK_TOOL_NAMES.has(t.name))) return false;
      }
      return true;
    }),
  [messages]);

  // Aggregate TaskCreate/TaskUpdate/TodoWrite только из ПОСЛЕДНЕГО turn'а:
  // от последнего user-сообщения и до конца. Каждый prompt начинает новый
  // task-список — старые таски прошлых turn'ов в панели не висят. Native
  // Claude TUI ведёт себя так же: TodoWrite/TaskCreate видны пока актуальны,
  // новый юзер-prompt стирает табло (allDone тоже его стирает, см. aggregator).
  const aggregatedTasks = useMemo(() => {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    const slice = lastUserIdx === -1 ? messages : messages.slice(lastUserIdx);
    return aggregateTasksFromMessages(slice);
  }, [messages]);

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
      // Mark mouse-pressed-in-tab BEFORE the focus shift / textarea onBlur runs
      // (this capture listener fires before the mousedown default action).
      _sdkPointerDown.current = true;
      const ta = tabRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta || ta.offsetParent === null) return;
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
      // Always clear the pressed flag first, before any early-return — a drag
      // can start in the chat and end over the sidebar (tabRoot=null below),
      // and the flag must not get stuck true or onBlur refocus stays disabled.
      _sdkPointerDown.current = false;
      if (!isVisibleRef.current) return;
      const target = e.target as HTMLElement | null;
      const tabRoot = target?.closest?.('.absolute.inset-0.flex.flex-col');
      if (!tabRoot) return;
      const ta = tabRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta || ta.offsetParent === null) return;
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
      if (!ta || ta.offsetParent === null) return;
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

  // SDK and PTY History share one AI presentation scale. The runtime remains
  // separate, but messages should not change typography merely because their
  // transport is Agent SDK instead of JSONL/PTy.
  const sdkBaseFontSize = useUIStore((s) => s.historyFontSize);

  return (
    <div
      className="absolute inset-0 flex flex-col"
      data-claude-sdk-tab-id={tabId}
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
              {activeQuestion ? (
                // Interactive AskUserQuestion REPLACES the composer (blocks
                // typing), mirroring the PTY Ink dialog. The real composer stays
                // mounted below in a hidden wrapper so its draft/chips/stash do
                // not disappear while this blocking surface is open.
                <SDKAskQuestion
                  key={activeQuestion.toolUseID}
                  questions={activeQuestion.questions}
                  fontPx={sdkBaseFontSize}
                  onSubmit={(answers) => answerQuestion(answers, false)}
                  onStop={() => answerQuestion(null, true)}
                />
              ) : slashOverlay ? (
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
              ) : expandedTaskId && expandedTaskIsWorkflow ? (
                // Workflow expanded into its phase/agent panel. Only when the
                // user explicitly opened the workflow chip (↓ + Enter or click)
                // — it never auto-takes-over the composer.
                <WorkflowPanel
                  tabId={tabId}
                  taskId={expandedTaskId}
                  onStopTask={(taskId) => {
                    ipcRenderer.invoke('claude-sdk:stop-task', { tabId, taskId })
                      .catch((e: any) => console.error('[WorkflowStop] error', e));
                  }}
                  onClose={() => setExpandedTaskId(null)}
                />
              ) : expandedTaskId ? (
                <TaskDetailPane
                  tabId={tabId}
                  taskId={expandedTaskId}
                  parentSessionId={sessionId}
                  cwd={cwd || ''}
                  onClose={() => setExpandedTaskId(null)}
                />
              ) : null}

              {/* Blocking SDK surfaces replace the composer visually, but never
                  own or destroy its authoring state. Keeping one mounted
                  textarea also keeps tab-scoped event listeners deterministic. */}
              <div
                style={{
                  display: activeQuestion || slashOverlay || expandedTaskId
                    ? 'none'
                    : 'contents',
                }}
              >
                <SDKComposer
                  tabId={tabId}
                  isRunning={isRunning}
                  wasStopped={wasStopped}
                  chips={sdkComposerChips}
                  setChips={setSDKComposerChips}
                  queued={queued}
                  queuedState={queuedState}
                  tasks={aggregatedTasks}
                  onUserInteract={scrollToBottom}
                />
              </div>

              {/* A question/slash overlay owns the whole footer. Task details
                  still keep the task switcher visible below them. */}
              {!activeQuestion && !slashOverlay && (
                <BackgroundTasksBar
                  tabId={tabId}
                  expandedTaskId={expandedTaskId}
                  onSelect={setExpandedTaskId}
                />
              )}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>

          {/* Scroll-to-bottom button */}
          {showScrollDown && (
            <ControlHint label="Прокрутить чат вниз">
            <button
              onClick={scrollToBottom}
              onMouseDown={(e) => e.preventDefault()}
              className="absolute z-10 flex items-center justify-center w-8 h-8 rounded-full bg-[#2a2a2a] border border-[#444] text-[#888] hover:text-white hover:bg-[#3a3a3a] transition-all cursor-pointer shadow-lg"
              style={{ bottom: '70px', right: '52px' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            </ControlHint>
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
export const UserMsg = () => {
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

  // Placeholder-id heuristic (mirrors isPersistedMsgId in the parent). Persisted
  // messages get Repeat + Edit (truncate-and-resend off the JSONL uuid).
  // Placeholders (turn that crashed before its JSONL flush — e.g. spawn
  // ENOTDIR / token errors) also get the action bar so the prompt can be
  // re-fired in place; the parent skips the truncate IPC for them.
  const isPersisted = msgId && !/^(user-|streaming-|hist-|msg-|init-|error-)/.test(msgId);
  const isPlaceholderUser = !!msgId && /^user-/.test(msgId);
  const showActions = isPersisted || isPlaceholderUser;
  // wasQueued discriminator: type-ahead очередь auto-sent эту запись (см.
  // dispatchPrompt). Live-only флаг (anthropic JSONL не хранит, после reload
  // теряется). Прежний `user-` regex выше matched и `user-queued-` тоже —
  // оба считаются placeholder/in-memory user-msg.
  const wasQueued = !!msgId && /^user-queued-/.test(msgId);

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
    <MessagePrimitive.Root className="relative group" data-msg-role="user">
      {isEditing ? (
        // Edit-in-place: same right-aligned bubble width as the read-only view,
        // but a textarea + button row instead of static text. Cmd/Ctrl+Enter
        // submits, Esc cancels (matches Claude Code TUI muscle memory).
        <div className="ml-auto my-1.5 mr-1 w-[80%] max-w-[80%] bg-[#DA7756]/12 border border-[#DA7756]/40 rounded-xl rounded-br-sm px-3 py-2">
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
        <ConversationMessage
          layout="user"
          status={wasQueued ? (
            <MessageStatusBadge
              label="QUEUED"
              tone="warning"
              icon={<span aria-hidden>↑</span>}
              title="Сообщение было поставлено в очередь во время ответа и отправлено автоматически"
            />
          ) : undefined}
          actions={showActions ? (
            <MessageActionRail placement="outside-start">
              <MessageActionButton
                onClick={() => { if (!actions?.busy) actions?.onRepeat(msgId); }}
                disabled={actions?.busy}
                title={actions?.busy ? 'Недоступно пока идёт ответ или работает фоновый агент' : 'Repeat — drop replies, resend this message'}
              >
                <RefreshCw size={11} />
              </MessageActionButton>
              <MessageActionButton
                onClick={() => { if (!actions?.busy) startEdit(); }}
                disabled={actions?.busy}
                title={actions?.busy ? 'Недоступно пока идёт ответ или работает фоновый агент' : 'Edit — drop replies, send a new version of this message'}
              >
                <Pencil size={11} />
              </MessageActionButton>
            </MessageActionRail>
          ) : undefined}
        >
          <MessagePrimitive.Content components={{ Text: UserTextPart }} />
        </ConversationMessage>
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
export const SystemMsg = () => {
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

// Same module-level carry trick for the "stopped" badge: ThreadMessageLike has
// no slot for our per-message `interrupted` flag, so AssistantMsg looks it up by
// id here. Set from loadHistory (durable, JSONL marker) AND from onCancel branch
// A (live, before reload). Map id, not boolean — assistant-ui strips extra fields.
const _interruptedByMsgId = new Set<string>();
function setInterruptedForMsg(id: string) { _interruptedByMsgId.add(id); }
function getInterruptedForMsg(id: string): boolean { return _interruptedByMsgId.has(id); }

// Module-level mouse-pressed flag, shared between the document-level
// mousedown/mouseup handlers (declared in ClaudeSDKTab) and the composer
// textarea's onBlur (declared in the SIBLING top-level function SDKComposer —
// NOT nested, so a component-scoped ref can't reach both). Same "module-level
// carry" trick as _interruptedByMsgId above.
//
// Why it exists: a click/drag in the chat blurs the textarea synchronously at
// mousedown. The onBlur's setTimeout(0) would otherwise fire ~1ms later, BEFORE
// the drag has built any selection, see isCollapsed=true, and yank focus back —
// collapsing the nascent selection (double-click survived only because its word
// selection is synchronous). While the button is down, onBlur defers refocus to
// the document mouseup handler (SDKActiveRecover), which runs at gesture-end and
// can distinguish a real drag-selection from a plain click.
// See fix-controlled-textarea-focus-selection.md.
const _sdkPointerDown = { current: false };

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

export const AssistantMsg = () => {
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

  // Per-message "stopped" badge: this assistant turn was interrupted by the
  // user (Esc / red cancel / double Ctrl+C). Flag carried via module-level Set
  // (set from the JSONL marker in loadHistory → survives reload, AND from
  // onCancel branch A → instant). Muted amber, static, uppercase-free — a small
  // affordance to the LEFT/top of the message, not a status bar.
  const interrupted = getInterruptedForMsg(id);

  // Copy button: sticky pin that follows the viewport while ANY part of this
  // assistant message is on screen — same pattern as Claude.ai / ChatGPT.
  return (
    <MessagePrimitive.Root
      className="relative"
      data-msg-role="assistant"
    >
      <ConversationMessage
        layout="assistant"
        actions={(
          <MessageActionRail placement="sticky-end">
            <ActionBarPrimitive.Root hideWhenRunning autohide="not-last">
              <CopyButton />
            </ActionBarPrimitive.Root>
          </MessageActionRail>
        )}
        footer={interrupted ? (
          <MessageStatusBadge
            label="stopped"
            tone="warning"
            icon={(
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <line x1="6.3" y1="6.3" x2="17.7" y2="17.7" />
              </svg>
            )}
            title="Этот ответ был остановлен пользователем"
          />
        ) : undefined}
      >
        <MessagePrimitive.Content
          components={{
            Text: AssistantTextPart,
            Reasoning: ReasoningPart,
            tools: { Fallback: ToolCallPart },
          }}
        />
      </ConversationMessage>
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
// Markdown body of an assistant message. Visual canon (prose typography, code-
// block chrome, inline-code hue, hex-chips) now lives in @noted/claude-blocks —
// this is a thin delegate. The package's `.cb-prose` carries the font-smoothing
// fix (`-webkit-font-smoothing: antialiased`) so normal text is no longer
// rendered half-a-weight too heavy on macOS.
const AssistantTextPart = ({ text }: { text: string }) => <CBMarkdown text={text} />;

// ---- Reasoning/thinking part ----
// Visual: collapsed by default, click to expand. Brain icon + "thinking · <effort>"
// title (lowercased), chevron rotates on open. Body is italic body-size text on a
// subtly-tinted background (not the muted-gray-on-dark void that blended with the
// rest of the UI). Border `white/10` + bg `white/[0.02]` is the established
// "subtle card, distinct from prose" pattern from Vercel AI Elements / Zed.
// Thinking block. Visual now lives in @noted/claude-blocks::ThinkBlock; this
// delegate injects the two desktop-specific bits: (1) the scroll-stable toggle
// (Virtuoso scroll-compensation), (2) the "thinking · <effort>" label pulled
// from the active tab's sdkEffort.
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
    <CBThinkBlock
      text={text}
      label={`thinking${effort ? ` · ${effort}` : ''}`}
      open={open}
      onToggle={onToggle}
      anchorRef={anchorRef}
    />
  );
};

// ============================================================
// Tool call rendering — delegated to @noted/claude-blocks
// ============================================================
// The tool-card chrome, status colours, icon-as-status-indicator, Bash/Read/
// Edit/Write/MultiEdit/Generic cards and the diff renderer all live in the
// package now (single source for desktop + mobile). The desktop-specific seam
// is collapse behaviour: this tab injects its scroll-stable toggle (the
// `useStableCollapseToggle` hook below, kept here because CompactSummaryMsg /
// CollapsibleText also use it) into the package cards via open/onToggle/anchorRef.

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
    // wasAtBottom: if the user was glued to the very bottom before the click,
    // a toggle there (collapse/expand of the last block — e.g. a turn was
    // stopped mid-stream and the block ended up at the bottom) should FOLLOW
    // to the new bottom, not pin the anchor. Otherwise expanding the last
    // block would push the revealed content below the fold and the user would
    // have to scroll down manually. Distance-to-bottom < BOTTOM_PIN_PX = glued.
    const wasAtBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= BOTTOM_PIN_PX;
    flushSync(() => { toggle(); });
    // Two rAFs: first lets React + Virtuoso commit/measure, second is when
    // ResizeObserver has emitted и known-size обновлён. После этого
    // вычисляем смещение и компенсируем — anchor возвращается на ту же
    // viewport-Y что была до клика.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el2 = anchorRef.current;
        if (!el2) return;
        // Glued-to-bottom path: re-stick to the new bottom (instant, no smooth —
        // matches Claude TUI bottom-pinned input). Covers expand AND collapse.
        if (wasAtBottom) { scroller.scrollTop = scroller.scrollHeight; return; }
        const newAnchorTop = el2.getBoundingClientRect().top;
        const newScrollerTop = scroller.getBoundingClientRect().top;
        const newOffsetFromScroller = newAnchorTop - newScrollerTop;
        const delta = newOffsetFromScroller - targetOffsetFromScroller;
        if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      });
    });
  }, [anchorRef, toggle]);
}

// ---- Dispatcher ----
// Delegates to @noted/claude-blocks::ToolCallPart for ALL card rendering. The
// only desktop-specific bit is the collapse mechanism — we inject the scroll-
// stable toggle (useStableCollapseToggle, defined above) so expanding a tool
// card inside Virtuoso doesn't jerk the scroll position. The package dispatcher
// renders exactly ONE card, so a single open/onToggle/anchorRef pair is enough.
const ToolCallPart = ({ toolName, args, result, isError }: { toolName: string; args: Record<string, any>; argsText: string; toolCallId: string; result?: any; isError?: boolean }) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => defaultOpenForTool(toolName));
  const onToggle = useStableCollapseToggle(anchorRef, () => setOpen(v => !v));
  return (
    <CBToolCallPart
      toolName={toolName}
      args={args}
      result={result}
      isError={isError}
      collapse={{ open, onToggle, anchorRef }}
    />
  );
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

const createSDKComposerChipId = (kind: SDKComposerChip['kind']) =>
  kind + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

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
  wasStopped,
  chips,
  setChips,
  queued,
  queuedState,
  tasks,
  onUserInteract,
}: {
  tabId: string;
  isRunning: boolean;
  wasStopped: boolean;
  chips: SDKComposerChip[];
  setChips: React.Dispatch<React.SetStateAction<SDKComposerChip[]>>;
  queued: string | null;
  queuedState: 'queued' | 'sent' | null;
  tasks: AggregatedTask[];
  onUserInteract?: () => void;
}) {
  const aiComposerChipThreshold = useUIStore((s) => s.aiComposerChipThreshold);
  const historyComposerFontSize = useUIStore((s) => s.historyComposerFontSize);
  const historyComposerMinRows = useUIStore((s) => s.historyComposerMinRows);
  const historyComposerMaxRows = useUIStore((s) => s.historyComposerMaxRows);
  const aiSecondaryFontSize = useUIStore((s) => s.aiSecondaryFontSize);
  // "Logical focus" — composer is the keyboard target. Tracks DOM focus PLUS
  // the selection-in-chat case where DOM focus is parked on body but typing
  // still routes here (global keydown router). Drives the orange border that
  // replaces the blinking caret as the "input is active" signal while text is
  // selected in the history (the caret itself can't survive a selection —
  // WHATWG focus collapses it).
  const [composerFocused, setComposerFocused] = useState(false);
  const [previewChip, setPreviewChip] = useState<SDKComposerChip | null>(null);
  // Flash pulse for the queued chip when the user tries to submit a SECOND
  // mid-stream Enter under an already-pending one. Single-slot UX: there's
  // no room for a second chip; the existing one briefly highlights to
  // confirm the keypress was received but rejected.
  const [chipFlashTick, setChipFlashTick] = useState(0);
  useEffect(() => {
    const onFlash = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail || {};
      if (tid !== tabId) return;
      setChipFlashTick(t => t + 1);
    };
    window.addEventListener('claude-sdk:typeahead-flash', onFlash);
    return () => window.removeEventListener('claude-sdk:typeahead-flash', onFlash);
  }, [tabId]);
  // Stashed text — populated by Ctrl+S, restored by clicking the chip or
  // reset-to-empty after the next successful submit. Kept here in component
  // state (not in composer runtime) so we can render the chip + diff against
  // the live composer text.
  const [stashed, setStashed] = useState<string | null>(null);
  // Task list collapse/expand. Native CLI auto-expands on first Create/Update
  // (см. TaskCreateTool.call → setAppState({expandedView:'tasks'})), мы делаем
  // то же: первый раз когда tasks.length стал >0 — expand; дальше уважаем
  // юзер-collapse. Per-tab состояние (key = tabId через mount) — состояние
  // не персистится между перезапусками, сбрасывается при ремаунте composer'а
  // (open task-pane → close → composer remount), что приемлемо: при следующем
  // Create/Update auto-expand сработает заново.
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const tasksAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (tasks.length > 0 && !tasksAutoExpandedRef.current) {
      tasksAutoExpandedRef.current = true;
      setTasksCollapsed(false);
    }
    // Если все таски сброшены (TodoWrite allDone → tasks=[]), reset auto-expand
    // memory чтобы следующий новый список снова auto-expand'ился.
    if (tasks.length === 0 && tasksAutoExpandedRef.current) {
      tasksAutoExpandedRef.current = false;
    }
  }, [tasks.length]);
  // Caret snapshot captured at mousedown — BEFORE Blink resets selectionStart
  // to 0 when the user clicks outside the textarea. Read in onBlur so we know
  // where the caret really was instead of seeing 0. The same name exists in
  // another function in this file (its-own-scope) — this local copy is what
  // the SDKComposer textarea actually needs.
  const savedCaretRef = useRef<{ start: number; end: number } | null>(null);
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
  // Transient "останавливаю процесс…" cue while Edit/Repeat hard-kills the live
  // session before rewriting history. It is projected in the shared composer
  // status line; the SDK lifecycle itself remains owned by this adapter.
  const [composerStopping, setComposerStopping] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: t } = (e as CustomEvent).detail || {};
      if (t !== tabId) return;
      setComposerStopping(true);
      setTimeout(() => setComposerStopping(false), 1200);
    };
    window.addEventListener('claude-sdk:stopping', handler);
    return () => window.removeEventListener('claude-sdk:stopping', handler);
  }, [tabId]);
  useEffect(() => { if (isRunning) setComposerStopping(false); }, [isRunning]);

  // Last-Ctrl+C timestamp for the double-press → Stop escalation.
  const lastCtrlCRef = useRef<number>(0);
  // Composer runtime: text source-of-truth + setText/cancel methods.
  const composerRuntime = useComposerRuntime({ optional: true });
  const composerText = useComposer((s) => s.text, { optional: true }) ?? '';
  // Direct DOM ref to the textarea — needed for insert-prompt (we drive native
  // value setter + dispatch input event so React's onChange picks it up).
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Cmd+Tab focus restore. main fires BrowserWindow 'focus' → App.tsx
  // re-dispatches as window event. Mounted only when this SDK tab is the
  // currently visible one (SDKComposer is rendered conditionally on active
  // SDK tab), so unconditional refocus is correct here — no extra active
  // check needed.
  useEffect(() => {
    const onRefocus = () => {
      const ta = composerTextareaRef.current;
      if (ta) {
        try { ta.focus({ preventScroll: true }); } catch {}
      }
    };
    window.addEventListener('nt:window-refocus-active', onRefocus);
    return () => window.removeEventListener('nt:window-refocus-active', onRefocus);
  }, []);

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
  const writeComposerValue = useCallback((
    value: string,
    opts?: {
      focusEnd?: boolean;
      selectionStart?: number;
      selectionEnd?: number;
    },
  ) => {
    const ta = composerTextareaRef.current;
    if (ta) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(ta, value);
      else ta.value = value;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (value === '') {
        ta.style.height = 'auto'; // collapse auto-grown rows
      }
      const hasExplicitSelection = Number.isFinite(opts?.selectionStart)
        && Number.isFinite(opts?.selectionEnd);
      if (opts?.focusEnd || hasExplicitSelection) {
        requestAnimationFrame(() => {
          ta.focus();
          const start = hasExplicitSelection
            ? Math.max(0, Math.min(ta.value.length, Number(opts?.selectionStart)))
            : ta.value.length;
          const end = hasExplicitSelection
            ? Math.max(start, Math.min(ta.value.length, Number(opts?.selectionEnd)))
            : start;
          ta.setSelectionRange(start, end);
          savedCaretRef.current = { start, end };
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

  // Dictation delivery (Soniox): MicButton fires this once on Stop with the
  // captured transcript. Append to whatever the user already typed (with a
  // single space separator), park caret at end so they can keep typing.
  // Inside SDKComposer so we have direct access to writeComposerValue and
  // the textarea ref — selectors from the outer ClaudeSDKTab scope were
  // unreliable across multi-tab layouts.
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid, text } = (e as CustomEvent).detail || {};
      if (tid !== tabId || !text) return;
      const ta = composerTextareaRef.current;
      const existing = ta?.value || '';
      const sep = existing && !/\s$/.test(existing) ? ' ' : '';
      writeComposerValue(existing + sep + text, { focusEnd: true });
    };
    window.addEventListener('claude-sdk:dictation-deliver', handler);
    return () => window.removeEventListener('claude-sdk:dictation-deliver', handler);
  }, [tabId, writeComposerValue]);

  // Focus the composer on demand (process-state chip click when «остановлен»,
  // SessionActionChip onStart/onContinue). Handled HERE — direct textarea ref,
  // not the outer-scope querySelector (which fails when the thread has no
  // assistant messages yet → no [data-msg-role] marker to anchor on).
  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: tid } = (e as CustomEvent).detail || {};
      if (tid !== tabId) return;
      requestAnimationFrame(() => {
        composerTextareaRef.current?.focus();
        onUserInteract?.();
      });
    };
    window.addEventListener('claude-sdk:focus-composer', handler);
    return () => window.removeEventListener('claude-sdk:focus-composer', handler);
  }, [tabId, onUserInteract]);

  const dismissStash = useCallback(() => setStashed(null), []);

  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // NB: the old hard-gate (Enter-while-running → reject-flash) is GONE. Mid-
    // stream Enter now parks the message in the type-ahead queue (see block
    // below the slash popup). The slash-popup handler runs first so slash nav
    // (↑↓/Tab/Enter) still works while Claude streams.

    // Slash autocomplete: when popup is open, arrows/Tab/Enter steer the
    // selection and commit. Reads through refs because handleComposerKeyDown
    // is memoised on stable authoring/runtime inputs — adding slashIdx /
    // filteredCommands / showSlashPopup
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

    // Enter with empty composer BUT chips present → still a valid submission.
    // assistant-ui's ComposerPrimitive.Input gates Send on `text.trim() !== ''`
    // so a chip-only payload couldn't be submitted — Enter was silently
    // swallowed and the user saw "Enter не работает". Bypass by injecting a
    // single space (onNew uses `'Analyze this content'` placeholder when the
    // trimmed text part is empty — the space we inject is irrelevant payload-
    // wise but unblocks the gate). Must run BEFORE the type-ahead branch:
    // if Claude is busy, we still want chips to enqueue, not get silently
    // dropped at the gate.
    if (e.key === 'Enter' && !e.shiftKey && composerText.trim().length === 0 && chips.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      if (isRunning) {
        // Mid-stream: enqueue chip-only payload. Same single-slot gate as
        // the text-Enter path.
        if (queued != null) {
          try {
            useUIStore.getState().showToast(
              queuedState === 'sent'
                ? 'Previous mid-stream message is in flight to Claude — wait until it appears in the thread.'
                : 'Already queued: edit or discard the chip above the input first.',
              'info', 3500,
            );
          } catch {}
          window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-flash', { detail: { tabId } }));
          return;
        }
        const queuedDraft = serializeComposerDraft({ text: '', chips });
        window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-enqueue', {
          detail: {
            tabId,
            text: queuedDraft,
            snapshot: {
              rawText: '',
              chips: chips.map((chip) => ({ ...chip })),
              transportText: queuedDraft,
            },
          },
        }));
        setChips([]);
        setPreviewChip(null);
        return;
      }
      writeComposerValue(' ');
      // After React commits the text, fire send. composerRuntime.send() reads
      // composer state which assistant-ui will have synced to ' '.
      setTimeout(() => {
        try { composerRuntime?.send(); } catch (err) { console.warn('[ChipOnlySend] send failed', err); }
      }, 0);
      return;
    }

    // Type-ahead: Enter while Claude is still streaming → park the text in the
    // queue (single slot, owned by the outer component) instead of sending. It
    // auto-fires when this turn finishes naturally. Matches native Claude TUI:
    // you can type the next prompt mid-answer and it goes the moment Claude is
    // done. Shift+Enter is a newline (skip). Empty input is a no-op (nothing to
    // queue) — let it fall through so a stray Enter doesn't queue blanks.
    // Single-slot: if there is already a chip (queued or sent) we refuse —
    // input keeps the text, the chip flashes (CSS), a toast explains why.
    // Reason: a second mid-stream Enter under a still-pending one creates
    // an unbounded queue, the user loses track of order, and the existing
    // chip can't represent multiple entries.
    if (isRunning && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (composerText.trim().length === 0 && chips.length === 0) return;
      if (queued != null) {
        try {
          useUIStore.getState().showToast(
            queuedState === 'sent'
              ? 'Previous mid-stream message is in flight to Claude — wait until it appears in the thread.'
              : 'Already queued: edit or discard the chip above the input first.',
            'info', 3500,
          );
        } catch {}
        window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-flash', { detail: { tabId } }));
        return;
      }
      const queuedDraft = serializeComposerDraft({ text: composerText, chips });
      window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-enqueue', {
        detail: {
          tabId,
          text: queuedDraft,
          snapshot: {
            rawText: composerText,
            chips: chips.map((chip) => ({ ...chip })),
            transportText: queuedDraft,
          },
        },
      }));
      writeComposerValue('');
      setChips([]);
      setPreviewChip(null);
      return;
    }

    // ArrowUp at the very start of the input (caret at offset 0, no selection)
    // recalls the queued type-ahead message back into the composer — append to
    // whatever is already typed. Mirrors the user's spec: «нажатие стрелки вверх
    // — оно возвращается обратно в инпут; если в инпуте уже что-то есть, то в
    // конец». Guarded by caret==0 so ArrowUp still navigates multi-line text
    // normally. Only when something is actually queued — otherwise pass through.
    if (e.key === 'ArrowUp' && !e.shiftKey && queued != null) {
      const ta = composerTextareaRef.current;
      const atStart = !ta || (ta.selectionStart === 0 && ta.selectionEnd === 0);
      if (atStart) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-recall', { detail: { tabId } }));
        return;
      }
    }

    // Ctrl+S: stash. Mac users hit ⌘S in muscle memory; we accept both. Skip
    // when textarea is empty (nothing to stash) so a stray ⌘S doesn't replace
    // an existing stash with an empty one.
    // e.code для физической клавиши — на русской раскладке e.key === 'ы', не 's'.
    if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (composerText.trim().length === 0) return;
      setStashed(composerText);
      writeComposerValue('');
      return;
    }
    // Ctrl+C is a two-stage gesture. Any authoring state (including whitespace
    // or a chip-only draft) is cleared and fully consumes the first keypress.
    // A later Ctrl+C on a truly empty composer bubbles to the window-level
    // Escape alias, which interrupts the running query.
    // Mac default ⌘C copies; мы требуем Ctrl (не Meta), чтобы highlight-and-
    // copy продолжал работать на macOS. e.code === 'KeyC' — на русской
    // раскладке e.key === 'с' (cyrillic), не 'c'.
    if (e.code === 'KeyC' && e.ctrlKey && !e.metaKey) {
      // Не интерсептим если есть выделение — юзер хочет скопировать его.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const hasAuthoringState = composerText.length > 0 || chips.length > 0;
      // Empty → let the window-level interrupt handler own the second press.
      if (!hasAuthoringState) return;
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      writeComposerValue('');
      setChips([]);
      setPreviewChip(null);
      return;
    }
  }, [composerText, writeComposerValue, isRunning, commitSlash, tabId, queued, queuedState, chips, composerRuntime]);

  const addChip = useCallback((
    text: string,
    kind: SDKComposerChip['kind'],
    metadata?: Pick<SDKComposerChip, 'label' | 'sourceKey'>,
  ) => {
    const chip: SDKComposerChip = {
      id: createSDKComposerChipId(kind),
      kind,
      text,
      createdAt: Date.now(),
      ...(metadata?.label ? { label: metadata.label } : {}),
      ...(metadata?.sourceKey ? { sourceKey: metadata.sourceKey } : {}),
    };
    setChips(prev => upsertComposerChip(prev, chip) as SDKComposerChip[]);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (shouldCreatePasteChip(text, aiComposerChipThreshold)) {
      e.preventDefault();
      addChip(text, 'paste');
    }
    // Short pastes go through normally to ComposerPrimitive.Input
  }, [addChip, aiComposerChipThreshold]);

  const discardChip = useCallback((id: string) => {
    setChips(prev => removeComposerChip(prev, id) as SDKComposerChip[]);
    if (previewChip?.id === id) setPreviewChip(null);
  }, [previewChip]);

  // Restore at the user's last/current selection. A chip is a reversible
  // projection of text, not a separate attachment whose only destination is
  // the end of the draft.
  const unpackChip = useCallback((chip: SDKComposerChip) => {
    const ta = composerTextareaRef.current;
    const cur = ta?.value ?? composerText;
    const selection = savedCaretRef.current || {
      start: ta?.selectionStart ?? cur.length,
      end: ta?.selectionEnd ?? cur.length,
    };
    const restored = restoreComposerChipToText({
      text: cur,
      chipText: chip.text,
      selectionStart: selection.start,
      selectionEnd: selection.end,
    });
    writeComposerValue(restored.text, {
      selectionStart: restored.selectionStart,
      selectionEnd: restored.selectionEnd,
    });
    setChips(prev => removeComposerChip(prev, chip.id) as SDKComposerChip[]);
    if (previewChip?.id === chip.id) setPreviewChip(null);
  }, [composerText, writeComposerValue, previewChip]);

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
      if (!detail || typeof detail.text !== 'string') return;
      if (!detail.text && !detail.replace) return;
      if (detail.tabId && detail.tabId !== tabId) return;
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
      // Saved prompts always retain their origin as prompt chips, independent
      // of length. Generic inserts (rollback, dictation, queue recall, scripts)
      // remain editable text because they do not carry saved-prompt identity.
      const isSavedPrompt = !detail.skipChip && (
        detail.kind === 'prompt'
        || detail.source === 'prompt-picker'
        || detail.source === 'sdk-context-menu'
      );
      if (isSavedPrompt) {
        addChip(detail.text, 'prompt', {
          label: typeof detail.label === 'string' ? detail.label : undefined,
          sourceKey: typeof detail.sourceKey === 'string'
            ? detail.sourceKey
            : `prompt:${detail.label || detail.text}`,
        });
        // Keep the composer focused so the user can add a covering message.
        setTimeout(() => composerTextareaRef.current?.focus(), 0);
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
  }, [writeComposerValue, addChip, tabId]);

  // Restore authoring state after a reversible type-ahead recall or a rejected
  // send. The transport string is deliberately not parsed back into chips:
  // raw text and chip metadata travel as a separate snapshot, so a saved
  // prompt stays a prompt chip and repeated paste chips keep their identity.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      if (detail.tabId !== tabId) return;

      const restoredText = typeof detail.rawText === 'string'
        ? detail.rawText
        : '';
      const textarea = composerTextareaRef.current;
      const currentText = textarea?.value ?? composerText;
      const mode = detail.mode === 'prepend' ? 'prepend' : 'append';
      const restoredChips = detail.restoreChips
        ? normalizeComposerChips(detail.chips || []) as SDKComposerChip[]
        : [];
      const merged = mergeComposerAuthoringSnapshot({
        currentText,
        currentChips: chips,
        restoredText,
        restoredChips,
        mode,
      });

      const shouldFocus = !!textarea && textarea.offsetParent !== null;
      writeComposerValue(merged.text, { focusEnd: shouldFocus });
      if (detail.restoreChips && restoredChips.length > 0) {
        setChips(merged.chips as SDKComposerChip[]);
      }

      try {
        ipcRenderer.send(
          'log:renderer',
          `[SDKComposerRestore] tab=${tabId.slice(-12)} reason=${detail.reason || 'unknown'} mode=${mode} old=${restoredText.length} current=${currentText.length} chips=${Array.isArray(detail.chips) ? detail.chips.length : 0}`,
        );
      } catch {}
    };
    window.addEventListener('claude-sdk:composer-restore', handler);
    return () => window.removeEventListener('claude-sdk:composer-restore', handler);
  }, [chips, composerText, setChips, tabId, writeComposerValue]);

  const composerSurfaceChips = useMemo<AIComposerSurfaceChip[]>(() => {
    const surfaceChips: AIComposerSurfaceChip[] = [];
    if (queued != null && !wasStopped && queuedState) {
      surfaceChips.push({
        id: `sdk-queued-${chipFlashTick}`,
        kind: 'queued',
        state: queuedState === 'sent' ? 'sent' : 'pending',
        label: queuedState === 'sent' ? 'SENT' : 'QUEUED',
        text: queued,
        disabled: queuedState === 'sent',
        className: chipFlashTick > 0 ? 'sdk-chip-flash' : undefined,
        onActivate: queuedState === 'queued'
          ? () => window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-recall', { detail: { tabId } }))
          : undefined,
        onDiscard: queuedState === 'queued'
          ? () => window.dispatchEvent(new CustomEvent('claude-sdk:typeahead-dismiss', { detail: { tabId } }))
          : undefined,
      });
    }
    if (stashed != null && !wasStopped) {
      surfaceChips.push({
        id: 'sdk-stash',
        kind: 'stash',
        label: 'STASH',
        text: stashed,
        onActivate: restoreStash,
        onDiscard: dismissStash,
      });
    }
    for (const chip of chips) {
      surfaceChips.push({
        id: chip.id,
        kind: chip.kind,
        label: chip.label || (chip.kind === 'prompt' ? 'PROMPT' : 'ВСТАВКА'),
        text: chip.text,
        onRestore: () => unpackChip(chip),
        onDiscard: () => discardChip(chip.id),
      });
    }
    return surfaceChips;
  }, [
    chipFlashTick,
    chips,
    discardChip,
    dismissStash,
    queued,
    queuedState,
    restoreStash,
    stashed,
    tabId,
    unpackChip,
    wasStopped,
  ]);

  const composerStatus = composerStopping ? (
    <MessageStatusBadge
      label="останавливаю процесс…"
      tone="warning"
      pending
    />
  ) : isRunning ? (
    <MessageStatusBadge
      label={`thinking${composerEffort ? ` · ${composerEffort}` : ''}`}
      tone="warning"
      pending
    />
  ) : null;

  return (
    <div className="relative">
      {/* Task list panel — aggregates TaskCreate/TaskUpdate/TodoWrite tool-calls
          в один свёрнутый список вместо N отдельных карточек в треде. Зеркало
          native Claude CLI поведения (TaskCreateTool.call → expandedView:tasks).
          Скрыто если tasks нет. Header кликабельный → toggle expand. */}
      <TaskListPanel
        tasks={tasks}
        collapsed={tasksCollapsed}
        onToggle={() => setTasksCollapsed(v => !v)}
      />

      {/* SDK has no background process and no "/resume": stopping closes the
          query, sessionId is preserved, and the next user message continues the
          conversation on its own. There is nothing to "resume", so we don't
          replace the composer with a Process-stopped/Resume affordance (that was
          misleading — it implied a paused process). The only trace of a stop is
          the per-message "stopped" badge in the thread. The composer stays
          available immediately after a stop. */}
      {(
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
          <AIComposerSurface
            density="comfortable"
            className="mx-4 mb-1"
            style={{
              borderColor: composerFocused ? '#FFB382' : undefined,
              transition: 'border-color 120ms ease',
            }}
            topBar={composerStatus}
            chips={composerSurfaceChips}
            expandedChipId={previewChip?.id || null}
            onExpandedChipChange={(chipId) => {
              setPreviewChip(chipId ? chips.find((chip) => chip.id === chipId) || null : null);
            }}
            secondaryFontSize={aiSecondaryFontSize}
            input={(
          <ComposerPrimitive.Root className="flex w-full items-end gap-2">
            <ComposerPrimitive.Input
              autoFocus
              placeholder={chips.length > 0 ? 'Add a message or press Enter to send...' : 'Message Claude...'}
              // Visible caret (orange). Раньше был transparent — юзер печатал,
              // текст реально шёл в textarea, но он его не видел и думал
              // «инпут не работает». Caret = единственный достоверный сигнал
              // «текст идёт сюда» когда юзер начал печатать.
              // Border doubles as the focus signal. When text is selected in the
              // chat, DOM focus parks on body so the blinking caret disappears
              // (WHATWG: focus collapses the selection — can't keep both). The
              // orange border (same #FFB382 as the caret) stays lit via
              // composerFocused to show the input is still the keyboard target.
              style={{
                caretColor: '#FFB382',
                fontSize: `${historyComposerFontSize}px`,
                lineHeight: 1.35,
              }}
              className="flex-1 text-[#e0e0e0] rounded-lg px-2 py-1.5 resize-none outline-none border-0 placeholder-[#555] bg-transparent"
              minRows={historyComposerMinRows}
              maxRows={historyComposerMaxRows}
              onPaste={handlePaste}
              onKeyDown={handleComposerKeyDown}
              onInput={() => onUserInteract?.()}
              onSelect={(event) => {
                savedCaretRef.current = {
                  start: event.currentTarget.selectionStart ?? 0,
                  end: event.currentTarget.selectionEnd ?? 0,
                };
              }}
              onClick={(event) => {
                savedCaretRef.current = {
                  start: event.currentTarget.selectionStart ?? 0,
                  end: event.currentTarget.selectionEnd ?? 0,
                };
              }}
              onKeyUp={(event) => {
                savedCaretRef.current = {
                  start: event.currentTarget.selectionStart ?? 0,
                  end: event.currentTarget.selectionEnd ?? 0,
                };
              }}
              onFocus={() => {
                setComposerFocused(true);
                const ta = composerTextareaRef.current;
                if (ta) {
                  savedCaretRef.current = {
                    start: ta.selectionStart ?? 0,
                    end: ta.selectionEnd ?? 0,
                  };
                }
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
                // Mouse-initiated blur → DO NOT refocus here. A click/drag in
                // the chat blurs the textarea at mousedown; this onBlur's
                // setTimeout(0) would fire ~1ms later, BEFORE the drag has built
                // any selection, see isCollapsed=true, and steal focus back —
                // killing drag-select (double-click survived only because the
                // word is selected synchronously). Defer entirely to the
                // document mouseup handler (SDKActiveRecover) which runs at
                // gesture-end and can tell a real selection from a plain click.
                // Keyboard-only blur (no button down) keeps the refocus path.
                if (_sdkPointerDown.current) {
                  try { ipcRenderer.send('log:renderer', '[SDKFocus] onBlur skip-refocus (mouse down → mouseup owns it)'); } catch {}
                  // Keep the logical-focus border lit: the composer is still the
                  // keyboard target (global keydown router writes here), even
                  // though DOM focus left for the selection. The blinking caret
                  // can't survive (WHATWG: focus collapses selection), so the
                  // border is the "input is active" signal in its place.
                  setComposerFocused(true);
                  return;
                }
                if (rel) {
                  // Focus moved to another real element. Refocus only if it's
                  // inside our tab AND it's not an interactive control.
                  // These two cases = genuine focus loss → drop the border.
                  if (!tabRoot.contains(rel)) { setComposerFocused(false); return; }
                  if (rel.closest('button, a, input, textarea, [contenteditable]')) { setComposerFocused(false); return; }
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
            )}
          />
        </div>
      )}
    </div>
  );
}

export default memo(ClaudeSDKTab);
