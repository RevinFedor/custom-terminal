import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import InfoPanel from './panels/InfoPanel';

// Legacy Gemini-orchestration / research-chat panels удалены в 2026-06.

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
