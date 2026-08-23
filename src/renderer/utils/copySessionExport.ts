// «Скопировать сессию» — сама операция, отдельно от кнопки, которая её звала.
//
// Она жила внутри `CopySessionButton` и была доступна только оттуда. Как только
// тот же пункт понадобился в контекстном меню вкладки, выбор был из двух: либо
// написать копирование второй раз, либо вынести. Второе копирование разошлось
// бы с первым на первом же изменении — а меняется здесь многое: набор фильтров,
// правило выбора Codex-сессии, формат склейки нескольких вкладок.
//
// Что осталось у кнопки: как она выглядит, где показывает настройки и что
// делает с введённым вручную идентификатором. Что здесь: какие вкладки годятся,
// какой сессии они принадлежат, чем именно её экспортировать и как склеить
// несколько. Разделение проходит ровно по границе «оформление ↔ операция».

const { ipcRenderer } = window.require('electron');

import { requireCodexSurfaceSessionId } from './codexWriterIdentity';
import type { CopySessionFilters } from './copySessionFilters';
export type { CopySessionFilters } from './copySessionFilters';

interface CopySessionTab {
  id: string;
  cwd?: string;
  commandType?: string;
  claudeSessionId?: string;
  geminiSessionId?: string;
  codexSessionId?: string;
}

export interface CopySessionResult {
  /** Полный текст, уже положенный в буфер. Пусто — копировать было нечего. */
  content: string;
  /** Сколько вкладок реально экспортировалось. */
  copied: number;
  /** Сколько вкладок просили скопировать (включая те, у которых нет сессии). */
  requested: number;
}

/** Есть ли у вкладки что копировать. Один ответ на кнопку и на пункт меню. */
export function tabHasCopyableSession(tab: CopySessionTab | undefined | null): boolean {
  if (!tab) return false;
  return !!(tab.claudeSessionId || tab.geminiSessionId || tab.codexSessionId || tab.commandType === 'codex');
}

/**
 * Экспортировать сессии перечисленных вкладок и положить результат в буфер.
 *
 * `overrideInput` — вручную введённый идентификатор (и, возможно, путь): это
 * явная выгрузка ЧУЖОЙ, исторической сессии, поэтому она обходит проверку
 * живого писателя Codex — проверять нечего, вкладка тут только источник
 * настроек и рабочей директории.
 *
 * Ничего не показывает пользователю: сообщения принадлежат той поверхности,
 * которая эту операцию позвала, и в меню они другие, чем на кнопке.
 */
export async function copySessionsToClipboard({
  tabs,
  filters,
  fallbackCwd,
  overrideInput,
}: {
  tabs: Array<CopySessionTab | undefined | null>;
  filters: CopySessionFilters;
  fallbackCwd: string;
  overrideInput?: string;
}): Promise<CopySessionResult> {
  const requested = tabs.length;
  const valid = tabs.filter((tab): tab is CopySessionTab => (
    !!tab && (tabHasCopyableSession(tab) || !!overrideInput)
  ));
  if (valid.length === 0) return { content: '', copied: 0, requested };

  const parts: string[] = [];
  for (const tab of valid) {
    const declaredCodex = tab.commandType === 'codex';
    let targetId = '';
    let parsedCwd = '';
    let kind: 'claude' | 'gemini' | 'codex' = 'claude';

    if (overrideInput) {
      const uuidMatch = overrideInput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const cwdMatch = overrideInput.match(/cwd:\s*(\/[^\s\n]+)/i);
      if (uuidMatch) targetId = uuidMatch[0];
      if (cwdMatch) parsedCwd = cwdMatch[1];
      kind = declaredCodex || tab.codexSessionId ? 'codex' : tab.geminiSessionId ? 'gemini' : 'claude';
    }
    if (!targetId) {
      if (declaredCodex) { targetId = tab.codexSessionId || ''; kind = 'codex'; }
      else if (tab.claudeSessionId) { targetId = tab.claudeSessionId; kind = 'claude'; }
      else if (tab.geminiSessionId) { targetId = tab.geminiSessionId; kind = 'gemini'; }
      else if (tab.codexSessionId) { targetId = tab.codexSessionId; kind = 'codex'; }
    }
    // Идентификатор Codex-сессии у вкладки — это то, что ей когда-то передали;
    // писать может уже другая. Спрашиваем главный процесс, кто пишет сейчас.
    if (kind === 'codex' && !overrideInput) {
      targetId = await requireCodexSurfaceSessionId({
        tabId: tab.id,
        operation: 'Копировать сессию',
      });
    }
    if (!targetId) continue;

    const liveCwd = await ipcRenderer.invoke('terminal:getCwd', tab.id).catch(() => null);
    const cwd = parsedCwd || liveCwd || tab.cwd || fallbackCwd;

    let result: any;
    if (kind === 'gemini') {
      result = await ipcRenderer.invoke('gemini:copy-range', {
        sessionId: targetId, cwd, startUuid: null, endUuid: null,
      });
    } else {
      if (kind === 'codex') {
        result = await ipcRenderer.invoke('agent-transcript:export-codex-session', {
          sessionId: targetId,
          cwd,
          copyOptions: filters,
        });
      } else {
        result = await ipcRenderer.invoke('claude:export-clean-session', {
          sessionId: targetId,
          cwd,
          ...filters,
        });
      }
    }
    if (result?.success) parts.push(result.content);
  }

  if (parts.length === 0) return { content: '', copied: 0, requested };
  const content = parts.join('\n\n' + '='.repeat(40) + '\n\n');
  const { clipboard } = window.require('electron');
  clipboard.writeText(content);
  return { content, copied: parts.length, requested };
}
