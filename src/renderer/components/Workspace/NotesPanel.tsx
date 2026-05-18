import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import InfoPanel from './panels/InfoPanel';

// AI Sessions tab (GeminiPanel) — открывается через Cmd+Shift+E как модалка ResearchSheet.
// Sessions tab (SessionsPanel, Trojan-Horse import) — устарел: команды Gemini /chat save
// больше не нужны (мы используем JSONL), Claude вообще не нуждается в spawning через PTY.
// Файлы panels/GeminiPanel.tsx и panels/SessionsPanel.tsx сохранены в кодовой базе как
// historical reference (см. ResearchSheet для актуального replacement). Удалены отсюда.

interface Project {
  id: string;
  path: string;
  name: string;
  notes?: string;
  geminiPrompt?: string;
}

interface NotesPanelProps {
  projectId: string;
  project: Project;
}

export default function NotesPanel({ projectId: _projectId, project }: NotesPanelProps) {
  const { getEffectiveTabId } = useWorkspaceStore();
  const activeTabId = getEffectiveTabId();

  return (
    <div
      data-info-aside
      className="bg-notes border-l border-border-main flex flex-col min-w-[150px] w-full h-full"
    >
      <div className="flex-1 overflow-hidden">
        <InfoPanel activeTabId={activeTabId} project={project} />
      </div>
    </div>
  );
}
