import React, { useState } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import InfoPanel from './panels/InfoPanel';
import GeminiPanel from './panels/GeminiPanel';
import ActionsPanel from './panels/ActionsPanel';
import SessionsPanel from './panels/SessionsPanel';

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

type TabType = 'info' | 'ai' | 'actions' | 'sessions';

export default function NotesPanel({ projectId, project }: NotesPanelProps) {
  const { notesPanelWidth } = useUIStore();
  const { getActiveProject } = useWorkspaceStore();

  const [activeTab, setActiveTab] = useState<TabType>('info');

  const activeProject = getActiveProject();
  const activeTabId = activeProject?.activeTabId || null;

  const tabs: { id: TabType; label: string }[] = [
    { id: 'info', label: 'Info' },
    { id: 'ai', label: 'AI' },
    { id: 'actions', label: 'Actions' },
    { id: 'sessions', label: 'Sessions' }
  ];

  return (
    <div
      className="bg-notes border-l border-border-main flex flex-col min-w-[150px]"
      style={{ width: notesPanelWidth }}
    >
      {/* Tabs */}
      <div className="flex border-b border-border-main bg-[#2d2d2d]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 bg-transparent border-none py-2 text-xs cursor-pointer border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'text-white border-accent'
                : 'text-[#888] border-transparent hover:text-[#ccc]'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'info' && (
          <InfoPanel activeTabId={activeTabId} />
        )}

        {activeTab === 'ai' && (
          <GeminiPanel
            projectPath={project.path}
            geminiPrompt={project.geminiPrompt}
          />
        )}

        {activeTab === 'actions' && (
          <ActionsPanel activeTabId={activeTabId} />
        )}

        {activeTab === 'sessions' && (
          <SessionsPanel
            projectPath={project.path}
            activeTabId={activeTabId}
          />
        )}
      </div>
    </div>
  );
}
