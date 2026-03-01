import React, { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useResearchStore } from '../../store/useResearchStore';
import InfoPanel from './panels/InfoPanel';
import GeminiPanel from './panels/GeminiPanel';
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

type TabType = 'info' | 'ai' | 'sessions';

export default function NotesPanel({ projectId, project }: NotesPanelProps) {
  const { getActiveProject, getEffectiveTabId } = useWorkspaceStore();
  const { pendingResearch } = useResearchStore();

  const [activeTab, setActiveTab] = useState<TabType>('info');

  const activeProject = getActiveProject();
  // Use effectiveTabId (sub-agent aware) — resolves to sub-agent tab when viewing one
  const activeTabId = getEffectiveTabId();

  // Check if active tab has an active AI session
  const activeTabData = activeTabId && activeProject ? activeProject.tabs.get(activeTabId) : null;
  const hasActiveSession = !!(activeTabData?.claudeSessionId || activeTabData?.geminiSessionId);

  // Auto-switch to AI tab when research is triggered
  useEffect(() => {
    if (pendingResearch) {
      setActiveTab('ai');
    }
  }, [pendingResearch]);

  const tabs: { id: TabType; label: string }[] = [
    { id: 'info', label: 'Info' },
    { id: 'ai', label: 'AI' },
    { id: 'sessions', label: 'Sessions' }
  ];

  return (
    <div
      className="bg-notes border-l border-border-main flex flex-col min-w-[150px] w-full h-full"
    >
      {/* Tabs */}
      <div className="flex border-b border-border-main bg-[#2d2d2d]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 bg-transparent border-none py-2 text-xs cursor-pointer border-b-2 transition-colors flex items-center justify-center gap-1 ${
              activeTab === tab.id
                ? 'text-white border-accent'
                : 'text-[#888] border-transparent hover:text-[#ccc]'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'info' && hasActiveSession && (
              <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: '#4ade80', flexShrink: 0 }} />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'info' && (
          <InfoPanel activeTabId={activeTabId} project={project} />
        )}

        {activeTab === 'ai' && (
          <GeminiPanel
            projectPath={project.path}
            geminiPrompt={project.geminiPrompt}
          />
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
