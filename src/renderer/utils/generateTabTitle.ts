import {
  DEFAULT_PROMPT_SUMMARY_PROMPT,
  DEFAULT_TAB_TITLE_PROMPT,
  DEFAULT_TIMELINE_GROUPING_PROMPT,
  PROMPT_SUMMARY_PROMPT_ID,
  TAB_TITLE_PROMPT_ID,
  TIMELINE_GROUPING_PROMPT_ID,
  usePromptsStore,
  type AIPrompt,
} from '../store/usePromptsStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

export const AUTO_TAB_TITLE_MAX_PROMPT_CHARS = 12000;
export const TIMELINE_PROMPT_SUMMARY_MAX_SOURCE_CHARS = 8000; // ≈2000 tokens for mixed RU/EN prompts.

const TAB_TITLE_COMMAND_RE = /^\s*(#(?:pack|effort|usage|help|model|status|clear)\b|\/(?:model|help|status|usage|compact|clear|exit|quit|login|logout|cost|rewind|init)\b)/i;
const TAB_TITLE_BOOTSTRAP_PROMPT_RE = /^\s*Continue from where you left off\.?\s*$/i;
const TAB_TITLE_CODEX_BOOTSTRAP_PROMPT_RE = /^\s*(?:#\s*)?(?:AGENTS|GEMINI)\.md instructions for\b/i;

function isCodexBootstrapInstructionPrompt(text: string): boolean {
  return TAB_TITLE_CODEX_BOOTSTRAP_PROMPT_RE.test(text);
}

export interface TabTitleSourceEntry {
  type?: string;
  content?: string;
  isCompactSummary?: boolean;
}

export type RefreshTabTitleReason =
  | 'tab-not-found'
  | 'unsupported-tab'
  | 'no-session'
  | 'manual-name'
  | 'timeline-error'
  | 'no-user-prompt'
  | 'generation-failed'
  | 'rename-skipped';

export interface RefreshTabTitleResult {
  ok: boolean;
  title?: string;
  reason?: RefreshTabTitleReason;
  error?: string;
}

export interface GenerateTabTitleFromSessionOptions {
  toolType: 'claude' | 'codex';
  sessionId: string;
  cwd?: string;
  tabId?: string;
  source: string;
  reason: string;
}

interface PromptUsageMetadata {
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  tabId?: string | null;
  tabName?: string | null;
  toolType?: string | null;
  sessionId?: string | null;
  entryUuid?: string | null;
  iterationIndex?: number | null;
}

export function isEligibleTabTitleEntry(entry: TabTitleSourceEntry): boolean {
  if (entry.type !== 'user' || entry.isCompactSummary) return false;
  const text = String(entry.content || '').trim();
  if (text.length < 2) return false;
  if (TAB_TITLE_COMMAND_RE.test(text)) return false;
  if (TAB_TITLE_BOOTSTRAP_PROMPT_RE.test(text)) return false;
  // Codex can emit project instructions as a role=user bootstrap block; it is not a user prompt.
  if (isCodexBootstrapInstructionPrompt(text)) return false;
  if (text.startsWith('This session is being continued from a previous conversation')) return false;
  if (text.startsWith('[Request interrupted') || text === '[User cancelled]') return false;
  return true;
}

export function trimTabTitlePrompt(content: string): string {
  return content.length > AUTO_TAB_TITLE_MAX_PROMPT_CHARS
    ? content.slice(0, AUTO_TAB_TITLE_MAX_PROMPT_CHARS) + '\n\n[truncated]'
    : content;
}

export function trimTimelinePromptSummarySource(content: string): string {
  return content.length > TIMELINE_PROMPT_SUMMARY_MAX_SOURCE_CHARS
    ? content.slice(0, TIMELINE_PROMPT_SUMMARY_MAX_SOURCE_CHARS) + '\n\n[truncated]'
    : content;
}

function sanitizeGeneratedTabTitle(raw: string): string {
  let clean = String(raw || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(title|название)\s*[:—-]\s*/i, '')
    .replace(/^[`"'“”«»]+|[`"'“”«».:;!?]+$/g, '')
    .trim();

  const chars = Array.from(clean);
  if (chars.length > 64) {
    clean = chars.slice(0, 64).join('').trim();
  }
  return clean;
}

function buildLocalFallbackTabTitle(userPrompt: string): string | null {
  if (isCodexBootstrapInstructionPrompt(String(userPrompt || '').trimStart())) {
    return null;
  }

  const lines = String(userPrompt || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]*]\(([^)]+)\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .split(/\n+/)
    .map((line) => line
      .replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/g, '')
      .replace(/^(?:\^+\s*)+/, '')
      .replace(/^[\s#>*_\-–—:;,.!?/\\|+=~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    )
    .filter((line) => line.length >= 2 && !TAB_TITLE_COMMAND_RE.test(line));

  const source = lines[0] || '';
  if (!source) return null;

  const words = source
    .split(/\s+/)
    .map((word) => word.replace(/^[`"'“”«»()[\]{}.,:;!?]+|[`"'“”«»()[\]{}.,:;!?]+$/g, ''))
    .filter(Boolean);
  if (words.length === 0) return null;

  return sanitizeGeneratedTabTitle(words.slice(0, 6).join(' ')) || null;
}

function normalizeSingleStarEmphasis(text: string): string {
  let clean = String(text || '').replace(/\*\*([^*]+)\*\*/g, '*$1*');
  let out = '';
  let inAccent = false;
  let closedPairs = 0;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch !== '*') {
      out += ch;
      continue;
    }

    const prev = clean[i - 1];
    const next = clean[i + 1];
    if (prev === '*' || next === '*') {
      continue;
    }

    if (!inAccent && closedPairs >= 1) {
      continue;
    }

    inAccent = !inAccent;
    if (!inAccent) closedPairs += 1;
    out += '*';
  }

  if (inAccent) {
    out = out.replace(/\*([^*]*)$/, '$1');
  }

  return out.replace(/\s+/g, ' ').trim();
}

function sanitizeGeneratedPromptSummary(raw: string): string {
  let clean = String(raw || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(summary|пересказ|кратко)\s*[:—-]\s*/i, '')
    .replace(/^[`"'“”«»]+|[`"'“”«».:;!?]+$/g, '')
    .trim();

  const chars = Array.from(clean);
  if (chars.length > 70) {
    clean = chars.slice(0, 70).join('').trim();
  }
  return normalizeSingleStarEmphasis(clean);
}

function sanitizeGeneratedTimelineAction(raw: string): string {
  let clean = String(raw || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(action|действие|название)\s*[:—-]\s*/i, '')
    .replace(/^["'“”«»]+|["'“”«».:;!?]+$/g, '')
    .trim();
  const chars = Array.from(clean);
  if (chars.length > 90) clean = chars.slice(0, 90).join('').trim();
  return clean;
}

function buildTimelinePromptSummarySource(currentPrompt: string, previousUserMessages: string[] = []): string {
  const current = String(currentPrompt || '').trim();
  const previous = previousUserMessages
    .map((msg) => String(msg || '').trim())
    .filter(Boolean);
  if (previous.length === 0) return current;

  const header = [
    'Контекст для пересказа:',
    'Ниже перечислены предыдущие user-сообщения той же сессии в хронологическом порядке.',
    'Используй их только как контекст. Пересказывай именно текущее user-сообщение.',
  ].join('\n');
  const currentBlock = `Текущее user-сообщение:\n${current}`;
  const fixedChars = header.length + currentBlock.length + 8;
  let remaining = Math.max(0, TIMELINE_PROMPT_SUMMARY_MAX_SOURCE_CHARS - fixedChars);
  const selected: string[] = [];

  for (let i = previous.length - 1; i >= 0; i--) {
    const label = `Предыдущее user-сообщение ${i + 1}:\n`;
    const available = remaining - label.length - 2;
    if (available <= 0) break;
    const raw = previous[i];
    const text = raw.length > available ? raw.slice(raw.length - available) : raw;
    selected.unshift(label + text);
    remaining -= label.length + text.length + 2;
  }

  if (selected.length === 0) return current;
  return `${header}\n\n${selected.join('\n\n')}\n\n${currentBlock}`;
}

async function buildSystemPrompt(promptConfig: AIPrompt | undefined, fallbackPrompt: string, logPrefix: string): Promise<string> {
  const base = (promptConfig?.content || fallbackPrompt).trim();
  const filePaths = promptConfig?.filePaths || [];
  if (filePaths.length === 0) return base;

  try {
    const result = await ipcRenderer.invoke('ai-prompts:read-files', filePaths);
    const files = Array.isArray(result?.data) ? result.data : [];
    if (!result?.success || files.length === 0) return base;
    const fileBlock = files
      .map((f: { path: string; content: string }) => `--- File: ${f.path} ---\n${f.content}`)
      .join('\n\n');
    return `${base}\n\n${fileBlock}`;
  } catch (err: any) {
    console.warn('[' + logPrefix + '] failed to read prompt attachments:', err?.message || err);
    return base;
  }
}

export async function generateTitleFromPromptWithConfig(
  userPrompt: string,
  promptConfig: AIPrompt | undefined,
  options: {
    fallbackPrompt: string;
    sourceLabel: string;
    logPrefix: string;
    taskType?: string;
    promptId?: string;
    sanitize?: (raw: string) => string;
    sourceChars?: number;
    usageMetadata?: PromptUsageMetadata;
  }
): Promise<string | null> {
  const apiKey = (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
  if (!apiKey) {
    console.warn('[' + options.logPrefix + '] GEMINI_API_KEY missing');
    return null;
  }

  const model = promptConfig?.model || 'gemini-3-flash-preview';
  const thinkingLevel = promptConfig?.thinkingLevel || 'NONE';
  const systemPrompt = await buildSystemPrompt(promptConfig, options.fallbackPrompt, options.logPrefix);
  console.warn(
    '[' + options.logPrefix + '] request' +
    ' task=' + (options.taskType || options.logPrefix) +
    ' promptId=' + (promptConfig?.id || options.promptId || 'none') +
    ' model=' + model +
    ' thinking=' + thinkingLevel +
    ' sourceChars=' + userPrompt.length
  );
  const requestBody: any = {
    contents: [{
      role: 'user',
      parts: [{ text: `${options.sourceLabel}:\n\n${userPrompt}` }],
    }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };

  if (model.includes('gemini-3') && thinkingLevel !== 'NONE') {
    requestBody.generationConfig = {
      thinkingConfig: { thinkingLevel },
    };
  }

  const logUsage = async (status: 'success' | 'error', usage: any = {}, raw = '', error?: string) => {
    try {
      await ipcRenderer.invoke('ai-prompts:log-call', {
        promptId: promptConfig?.id || options.promptId || null,
        taskType: options.taskType || options.logPrefix,
        model,
        thinkingLevel,
        promptTokens: Number(usage?.promptTokenCount || 0),
        candidateTokens: Number(usage?.candidatesTokenCount || 0),
        thoughtTokens: Number(usage?.thoughtsTokenCount || 0),
        totalTokens: Number(usage?.totalTokenCount || 0),
        status,
        error: error ? String(error).slice(0, 500) : null,
        sourceChars: Number.isFinite(Number(options.sourceChars)) ? Number(options.sourceChars) : userPrompt.length,
        outputChars: raw.length,
        ...(options.usageMetadata || {}),
      });
    } catch (err: any) {
      console.warn('[' + options.logPrefix + '] failed to log usage:', err?.message || err);
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    );
    const data = await response.json();
    if (data?.error) {
      console.warn('[' + options.logPrefix + '] Gemini error:', data.error.message || data.error.status || response.status);
      await logUsage('error', data?.usageMetadata || {}, '', data.error.message || data.error.status || response.status);
      return null;
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const raw = parts
      .filter((p: any) => !p.thought)
      .map((p: any) => p.text || '')
      .join('');
    await logUsage('success', data?.usageMetadata || {}, raw);
    const title = (options.sanitize || sanitizeGeneratedTabTitle)(raw);
    console.warn(
      '[' + options.logPrefix + '] result' +
      ' task=' + (options.taskType || options.logPrefix) +
      ' status=success' +
      ' rawChars=' + raw.length +
      ' output=' + JSON.stringify(title || null) +
      ' promptTokens=' + Number(data?.usageMetadata?.promptTokenCount || 0) +
      ' candidateTokens=' + Number(data?.usageMetadata?.candidatesTokenCount || 0) +
      ' thoughtTokens=' + Number(data?.usageMetadata?.thoughtsTokenCount || 0) +
      ' totalTokens=' + Number(data?.usageMetadata?.totalTokenCount || 0)
    );
    return title || null;
  } catch (err: any) {
    console.warn('[' + options.logPrefix + '] request failed:', err?.message || err);
    await logUsage('error', {}, '', err?.message || err);
    return null;
  }
}

export async function generateTabTitleFromPrompt(userPrompt: string, promptConfig?: AIPrompt): Promise<string | null> {
  const title = await generateTitleFromPromptWithConfig(userPrompt, promptConfig, {
    fallbackPrompt: DEFAULT_TAB_TITLE_PROMPT,
    sourceLabel: 'Первое пользовательское сообщение',
    logPrefix: 'TabTitle',
    taskType: 'tab-title',
    promptId: TAB_TITLE_PROMPT_ID,
  });
  if (title) return title;

  const fallbackTitle = buildLocalFallbackTabTitle(userPrompt);
  console.warn(
    '[TabTitle] fallback-local' +
    ' sourceChars=' + String(userPrompt || '').length +
    ' output=' + JSON.stringify(fallbackTitle || null)
  );
  return fallbackTitle;
}

export async function generateTimelinePromptSummaryFromPrompt(
  userPrompt: string,
  promptConfig?: AIPrompt,
  options: {
    previousUserMessages?: string[];
    usageMetadata?: PromptUsageMetadata;
  } = {}
): Promise<string | null> {
  const current = trimTimelinePromptSummarySource(userPrompt);
  const source = buildTimelinePromptSummarySource(current, options.previousUserMessages || []);
  return generateTitleFromPromptWithConfig(trimTimelinePromptSummarySource(source), promptConfig, {
    fallbackPrompt: DEFAULT_PROMPT_SUMMARY_PROMPT,
    sourceLabel: options.previousUserMessages?.length ? 'Контекст и текущее пользовательское сообщение' : 'Пользовательское сообщение',
    logPrefix: 'PromptSummary',
    taskType: 'prompt-summary',
    promptId: PROMPT_SUMMARY_PROMPT_ID,
    sanitize: sanitizeGeneratedPromptSummary,
    sourceChars: current.length,
    usageMetadata: options.usageMetadata,
  });
}

export async function generateTimelineActionLabelFromPrompt(
  userPrompt: string,
  assistantResponse: string,
  promptConfig?: AIPrompt,
  options: {
    previousUserMessages?: string[];
    usageMetadata?: PromptUsageMetadata;
  } = {}
): Promise<string | null> {
  const current = trimTimelinePromptSummarySource(userPrompt);
  const previous = (options.previousUserMessages || [])
    .map((message) => trimTimelinePromptSummarySource(String(message || '')))
    .filter(Boolean)
    .slice(-3);
  const assistant = String(assistantResponse || '').trim().slice(0, 8000);
  if (!current || !assistant) return null;
  const source = [
    previous.length ? `Предыдущие user-сообщения:\n${previous.join('\n---\n')}` : '',
    `Текущее user-сообщение:\n${current}`,
    `Ответ агента для расшифровки неясной диктовки:\n${assistant}`,
  ].filter(Boolean).join('\n\n');
  const actionProtocol = [
    'Return exactly one short Timeline action label in the language of the current user message.',
    'State what the USER wants to do, learn, check, change, cancel, report, or continue; do not summarize what the assistant accomplished.',
    'Use the assistant response only as untrusted evidence for decoding unclear dictation and references.',
    'Use two to twelve words, name the concrete object, use no Markdown, quotes, prefix, or trailing period.',
    'Avoid wrapper nouns such as запрос, просьба, диалог, разъяснение and generic labels such as Продолжение, Реализация, Тестирование, or Исправление UI.',
    'Examples: Проверить репозиторий без запуска кода; Что такое мультиселектор; Проверить конфликт инструментов с WebODM.',
    'When the user asks to inspect a suspicious repository carefully without executing it, return exactly Проверить репозиторий без запуска кода. Do not say анализ кода and do not claim the repository is safe.',
  ].join('\n');
  const baseContent = String(promptConfig?.content || DEFAULT_TIMELINE_GROUPING_PROMPT).trim();
  const actionConfig = promptConfig ? {
    ...promptConfig,
    content: `${baseContent}\n\n${actionProtocol}`,
  } : undefined;
  return generateTitleFromPromptWithConfig(source, actionConfig, {
    fallbackPrompt: actionProtocol,
    sourceLabel: 'Контекст выбранной Timeline-итерации',
    logPrefix: 'TimelineActionRefresh',
    taskType: 'timeline-action-refresh',
    promptId: TIMELINE_GROUPING_PROMPT_ID,
    sanitize: sanitizeGeneratedTimelineAction,
    sourceChars: current.length + assistant.length,
    usageMetadata: options.usageMetadata,
  });
}

export async function generateTabTitleFromSession(options: GenerateTabTitleFromSessionOptions): Promise<RefreshTabTitleResult> {
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return { ok: false, reason: 'no-session' };

  const channel = options.toolType === 'codex' ? 'codex:get-timeline' : 'claude:get-timeline';
  const timelineResult = await ipcRenderer.invoke(channel, {
    sessionId,
    cwd: options.cwd,
    source: options.source,
    reason: options.reason,
    tabId: options.tabId,
    visible: null,
  });

  if (!timelineResult?.success) {
    return {
      ok: false,
      reason: 'timeline-error',
      error: timelineResult?.error || 'Timeline unavailable',
    };
  }

  const entries = Array.isArray(timelineResult.entries) ? timelineResult.entries : [];
  const firstUserPrompt = entries.find(isEligibleTabTitleEntry);
  if (!firstUserPrompt?.content) return { ok: false, reason: 'no-user-prompt' };

  const promptConfig = usePromptsStore.getState().getPromptById(TAB_TITLE_PROMPT_ID);
  const title = await generateTabTitleFromPrompt(trimTabTitlePrompt(firstUserPrompt.content), promptConfig);
  if (!title) return { ok: false, reason: 'generation-failed' };

  return { ok: true, title };
}

export async function refreshGeneratedTabTitle(
  tabId: string,
  options: { overrideManualName?: boolean; markNameSetManually?: boolean } = {}
): Promise<RefreshTabTitleResult> {
  const store = useWorkspaceStore.getState();
  let tab: any = null;
  for (const [, workspace] of store.openProjects) {
    const candidate = workspace.tabs.get(tabId);
    if (candidate) {
      tab = candidate;
      break;
    }
  }

  if (!tab) return { ok: false, reason: 'tab-not-found' };
  if (tab.nameSetManually && !options.overrideManualName) {
    return { ok: false, reason: 'manual-name' };
  }

  let toolType: 'claude' | 'codex' | null = null;
  let sessionId = '';
  if (tab.commandType === 'codex' && tab.codexSessionId) {
    toolType = 'codex';
    sessionId = tab.codexSessionId;
  } else if (tab.commandType === 'claude' && tab.claudeSessionId) {
    toolType = 'claude';
    sessionId = tab.claudeSessionId;
  } else if (tab.codexSessionId) {
    toolType = 'codex';
    sessionId = tab.codexSessionId;
  } else if (tab.claudeSessionId) {
    toolType = 'claude';
    sessionId = tab.claudeSessionId;
  }

  if (!toolType) return { ok: false, reason: 'unsupported-tab' };
  if (!sessionId) return { ok: false, reason: 'no-session' };

  const result = await generateTabTitleFromSession({
    toolType,
    sessionId,
    cwd: tab.cwd,
    source: 'TabTitle.refreshGeneratedTabTitle',
    reason: options.overrideManualName ? 'context-menu' : 'auto',
    tabId,
  });
  if (!result.ok || !result.title) return result;

  const title = result.title;
  const renamed = useWorkspaceStore.getState().autoRenameTab(tabId, title, {
    toolType,
    sessionId,
    overrideManualName: options.overrideManualName,
    markNameSetManually: options.markNameSetManually,
  });
  if (!renamed) return { ok: false, reason: 'rename-skipped', title };

  console.warn('[TabTitle] refreshed tab=' + tabId.slice(-8) + ' type=' + toolType + ' title=' + JSON.stringify(title));
  return { ok: true, title };
}
