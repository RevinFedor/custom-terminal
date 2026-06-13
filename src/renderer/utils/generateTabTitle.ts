import {
  DEFAULT_PROMPT_SUMMARY_PROMPT,
  DEFAULT_TAB_TITLE_PROMPT,
  PROMPT_SUMMARY_PROMPT_ID,
  TAB_TITLE_PROMPT_ID,
  usePromptsStore,
  type AIPrompt,
} from '../store/usePromptsStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

export const AUTO_TAB_TITLE_MAX_PROMPT_CHARS = 12000;
export const TIMELINE_PROMPT_SUMMARY_MAX_SOURCE_CHARS = 8000; // ≈2000 tokens for mixed RU/EN prompts.

const TAB_TITLE_COMMAND_RE = /^\s*(#(?:pack|effort|usage|help|model|status|clear)\b|\/(?:model|help|status|usage|compact|clear|exit|quit|login|logout|cost|rewind|init)\b)/i;

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

export function isEligibleTabTitleEntry(entry: TabTitleSourceEntry): boolean {
  if (entry.type !== 'user' || entry.isCompactSummary) return false;
  const text = String(entry.content || '').trim();
  if (text.length < 2) return false;
  if (TAB_TITLE_COMMAND_RE.test(text)) return false;
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
  return clean;
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
        sourceChars: userPrompt.length,
        outputChars: raw.length,
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
    return title || null;
  } catch (err: any) {
    console.warn('[' + options.logPrefix + '] request failed:', err?.message || err);
    await logUsage('error', {}, '', err?.message || err);
    return null;
  }
}

export async function generateTabTitleFromPrompt(userPrompt: string, promptConfig?: AIPrompt): Promise<string | null> {
  return generateTitleFromPromptWithConfig(userPrompt, promptConfig, {
    fallbackPrompt: DEFAULT_TAB_TITLE_PROMPT,
    sourceLabel: 'Первое пользовательское сообщение',
    logPrefix: 'TabTitle',
    taskType: 'tab-title',
    promptId: TAB_TITLE_PROMPT_ID,
  });
}

export async function generateTimelinePromptSummaryFromPrompt(userPrompt: string, promptConfig?: AIPrompt): Promise<string | null> {
  return generateTitleFromPromptWithConfig(trimTimelinePromptSummarySource(userPrompt), promptConfig, {
    fallbackPrompt: DEFAULT_PROMPT_SUMMARY_PROMPT,
    sourceLabel: 'Пользовательское сообщение',
    logPrefix: 'PromptSummary',
    taskType: 'prompt-summary',
    promptId: PROMPT_SUMMARY_PROMPT_ID,
    sanitize: sanitizeGeneratedPromptSummary,
  });
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

  const channel = toolType === 'codex' ? 'codex:get-timeline' : 'claude:get-timeline';
  const timelineResult = await ipcRenderer.invoke(channel, {
    sessionId,
    cwd: tab.cwd,
    source: 'TabTitle.refreshGeneratedTabTitle',
    reason: options.overrideManualName ? 'context-menu' : 'auto',
    tabId,
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
