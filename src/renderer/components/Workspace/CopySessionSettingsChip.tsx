import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import CopySessionButton from './CopySessionButton';

// Чип «Settings Copy» в нижней полосе приложения.
//
// Раньше эта обёртка стояла в верхней полосе и ПРЯТАЛАСЬ, когда у активной
// вкладки нет сессии агента: кнопка называлась «Copy session», и копировать
// действительно было нечего. Теперь чип — настройки, а не действие, и прятать
// его на обычной вкладке значит убирать настройку из-под руки ровно тогда,
// когда её собираются подготовить заранее. Умолчания приложения не мигают в
// такт тому, куда человек кликнул.
//
// Оттенок берётся у сессии активной вкладки, когда она есть: рядом стоят
// умолчания Claude и Codex в своих цветах, и чип не должен выглядеть чужим.
// Без сессии — оттенок Claude, как у первого соседа.
export default function CopySessionSettingsChip() {
  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const sessionType = useWorkspaceStore((s) => {
    if (!activeTabId) return 'claude' as const;
    for (const [, ws] of s.openProjects) {
      const tab = ws.tabs.get(activeTabId);
      if (!tab) continue;
      if (tab.geminiSessionId) return 'gemini' as const;
      if (tab.codexSessionId) return 'codex' as const;
      return 'claude' as const;
    }
    return 'claude' as const;
  });

  return (
    <div className="flex items-center select-none">
      <CopySessionButton activeTabId={activeTabId} sessionType={sessionType} />
    </div>
  );
}
