import {
  fetchClaudeStartupDefaultsGate,
  waitForClaudeStartupDefaultsReady,
} from './claudeStartupDefaultsGate';
import { terminalRegistry } from './terminalRegistry';

const { ipcRenderer } = window.require('electron');

function normalizeVisibleText(text: unknown): string {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeClaudePromptReady(text: string): boolean {
  const visible = normalizeVisibleText(text);
  if (!visible) return false;
  return /\[[^\]]+\]\s*\d+%.*[⏵❯]/.test(visible)
    || /[⏵❯].*(?:bypass permissions|for agents|ctrl\+v to paste|Image in clipboard)/i.test(visible);
}

function isPromptBoundaryStartupError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return /prompt boundary/i.test(message);
}

async function getClaudeInputText(tabId: string) {
  try {
    const result = await ipcRenderer.invoke('claude:copy-input', tabId);
    return {
      success: result?.success === true,
      text: String(result?.text || '').replace(/\u00a0/g, ' ').trim(),
      error: result?.error || null,
    };
  } catch (e: any) {
    return { success: false, text: '', error: e?.message || String(e) };
  }
}

export async function isClaudeStartupPromptReadyByVisiblePrompt(tabId: string, label = 'startup-defaults') {
  const visibleText = terminalRegistry.getVisibleText(tabId);
  const promptVisible = looksLikeClaudePromptReady(visibleText);
  const input = await getClaudeInputText(tabId);
  const presence = await ipcRenderer.invoke('claude:get-presence', tabId).catch(() => null);
  const ready = promptVisible
    && input.success
    && input.text.length === 0
    && presence?.status === 'active'
    && presence?.inputReady === true;

  console.warn('[ClaudeStartupDefaultsReady] tab=' + tabId.slice(-12)
    + ' label=' + label
    + ' fallbackReady=' + ready
    + ' promptVisible=' + promptVisible
    + ' inputSuccess=' + input.success
    + ' inputChars=' + input.text.length
    + ' presence=' + (presence?.status || 'unknown')
    + ' inputReady=' + !!presence?.inputReady
    + ' inputError=' + (input.error || '-')
    + ' visibleTail=' + JSON.stringify(normalizeVisibleText(visibleText).slice(-180)));

  return ready;
}

export async function waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId: string, timeoutMs: number | null = 15000, label = 'startup-defaults') {
  try {
    await waitForClaudeStartupDefaultsReady(tabId, timeoutMs);
    return;
  } catch (e) {
    if (isPromptBoundaryStartupError(e)) {
      // A main-owned gate is authoritative even when the renderer sees a
      // prompt. Visible text cannot turn a failed/unknown settings proof into
      // success. The fallback exists only for a legacy process that published
      // no gate at all.
      const gate = await fetchClaudeStartupDefaultsGate(tabId);
      if (!gate && await isClaudeStartupPromptReadyByVisiblePrompt(tabId, label + ':wait-fallback')) {
        return;
      }
    }
    throw e;
  }
}

// A Send already accepted by the shared scenario follows the exact main-owned
// startup transaction. Its completion is a lifecycle fact (ready, failed,
// cleared/replaced), not a stopwatch result. Transport/diagnostic callers may
// still use the bounded helper above; Send uses this no-local-deadline variant
// so a slow but current `/model` proof cannot roll back a prompt one second
// before main commits it.
export async function waitForClaudeStartupDefaultsReadyUntilSettled(
  tabId: string,
  label = 'startup-defaults',
) {
  return waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, null, label);
}
