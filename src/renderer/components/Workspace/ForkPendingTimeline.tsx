import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

// A new target has no History owner yet. Reserve only the narrow rail, never
// mount a reader with the parent's SID or borrow a retained Timeline's rows.
export default function ForkPendingTimeline({ projectId, tabId, hasSession }: {
  projectId: string; tabId: string; hasSession: boolean;
}) {
  const pending = useWorkspaceStore(state =>
    state.openProjects.get(projectId)?.tabs.get(tabId)?.pendingOperation === 'Создание форка…');
  if (!pending || hasSession) return null;
  return <div data-fork-pending-timeline={tabId} role="status" aria-busy="true"
    aria-label="Загрузка Timeline: создание форка" title="Создание форка…"
    style={{ width: 32, flexShrink: 0, borderLeft: '1px solid #333', display: 'flex',
      justifyContent: 'center', paddingTop: 12, color: '#a1a1aa', fontSize: 11 }}>
    <span style={{ writingMode: 'vertical-rl' }}>Создание форка…</span>
  </div>;
}
