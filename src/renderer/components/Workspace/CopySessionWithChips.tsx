import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import CopySessionButton from './CopySessionButton';

// Toolbar wrapper: the compact filter chips live inside CopySessionButton settings now,
// so the top bar keeps only the primary copy action.
export default function CopySessionWithChips() {
  const activeTabId = useWorkspaceStore((s) => s.getEffectiveTabId());
  const sessionType = useWorkspaceStore((s) => {
    if (!activeTabId) return null;
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(activeTabId);
      if (t) {
        if (t.claudeSessionId) return 'claude' as const;
        if (t.geminiSessionId) return 'gemini' as const;
        if (t.codexSessionId) return 'codex' as const;
        return null;
      }
    }
    return null;
  });

  if (!activeTabId || !sessionType) return null;

  return (
    <div className="flex items-center select-none">
      <CopySessionButton activeTabId={activeTabId} sessionType={sessionType} />
    </div>
  );
}
