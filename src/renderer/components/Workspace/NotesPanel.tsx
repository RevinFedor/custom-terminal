import React, { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import GeminiPanel from './panels/GeminiPanel';
import ActionsPanel from './panels/ActionsPanel';
import SessionsPanel from './panels/SessionsPanel';

const { ipcRenderer } = window.require('electron');

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

type TabType = 'notes' | 'ai' | 'actions' | 'sessions';

export default function NotesPanel({ projectId, project }: NotesPanelProps) {
  const { notesPanelWidth } = useUIStore();
  const { getActiveProject, getActiveTab } = useWorkspaceStore();

  const [activeTab, setActiveTab] = useState<TabType>('notes');
  const [notes, setNotes] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const notesRef = useRef<{ [key: string]: string }>({});

  const activeProject = getActiveProject();
  const activeTabId = activeProject?.activeTabId || null;

  // Load notes when tab changes
  useEffect(() => {
    if (activeTabId) {
      setNotes(notesRef.current[activeTabId] || '');
    }
  }, [activeTabId]);

  // Auto-save notes
  const handleNotesChange = (value: string) => {
    setNotes(value);

    if (activeTabId) {
      notesRef.current[activeTabId] = value;
    }

    setSaveStatus('saving');

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1000);
    }, 500);
  };

  const tabs: { id: TabType; label: string }[] = [
    { id: 'notes', label: 'Notes' },
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
        {activeTab === 'notes' && (
          <div className="h-full flex flex-col">
            <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] flex justify-between items-center shrink-0">
              <span>Session Notes</span>
              <span className={`text-[10px] ${
                saveStatus === 'saving' ? 'text-[#888]' :
                saveStatus === 'saved' ? 'text-accent' : 'text-[#666]'
              }`}>
                {saveStatus === 'saving' ? 'Saving...' :
                 saveStatus === 'saved' ? 'Saved' : 'Auto-saved'}
              </span>
            </div>
            <textarea
              className="flex-1 p-3 outline-none overflow-y-auto font-mono text-[13px] leading-relaxed text-[#ddd] bg-transparent resize-none"
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              spellCheck={false}
              placeholder="Type your notes here..."
            />
          </div>
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
