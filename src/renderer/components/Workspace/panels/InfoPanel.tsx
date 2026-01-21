import React, { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';

interface InfoPanelProps {
  activeTabId: string | null;
}

export default function InfoPanel({ activeTabId }: InfoPanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Poll for session ID changes (every 500ms)
  // This avoids store subscription that causes terminal re-render issues
  useEffect(() => {
    const checkSession = () => {
      if (!activeTabId) {
        setSessionId(null);
        return;
      }

      const state = useWorkspaceStore.getState();
      for (const [, workspace] of state.openProjects) {
        const tab = workspace.tabs.get(activeTabId);
        if (tab) {
          const newId = tab.claudeSessionId || null;
          setSessionId(prev => prev !== newId ? newId : prev);
          return;
        }
      }
      setSessionId(null);
    };

    checkSession(); // Initial check
    const interval = setInterval(checkSession, 500);
    return () => clearInterval(interval);
  }, [activeTabId]);

  const hasSession = !!sessionId;

  return (
    <div className="h-full flex flex-col p-3 overflow-y-auto">
      {/* Claude Session Status */}
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">Claude Session</div>
        {hasSession ? (
          <div className="bg-[#2a3a2a] border border-[#3a5a3a] rounded p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              <span className="text-green-400 text-xs font-medium">Active</span>
            </div>
            <code className="text-[11px] text-[#aaa] break-all">{sessionId}</code>
          </div>
        ) : (
          <div className="bg-[#3a3a2a] border border-[#5a5a3a] rounded p-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
              <span className="text-yellow-400 text-xs font-medium">No session</span>
            </div>
            <p className="text-[11px] text-[#888] mt-1">
              Type <code className="text-accent">claude</code> to start
            </p>
          </div>
        )}
      </div>

      {/* Available Commands */}
      <div className="mb-4">
        <div className="text-[11px] uppercase text-[#888] mb-2">Команды</div>
        <div className="space-y-2">
          {/* claude */}
          <div className="bg-[#2d2d2d] rounded p-2">
            <div className="flex items-center justify-between">
              <code className="text-accent text-xs">claude</code>
              <span className="text-green-400 text-[10px]">всегда</span>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Новая сессия</p>
          </div>

          {/* claude-c */}
          <div className={`rounded p-2 ${hasSession ? 'bg-[#2d2d2d]' : 'bg-[#252525] opacity-60'}`}>
            <div className="flex items-center justify-between">
              <code className={`text-xs ${hasSession ? 'text-accent' : 'text-[#666]'}`}>claude-c</code>
              <span className={`text-[10px] ${hasSession ? 'text-green-400' : 'text-red-400'}`}>
                {hasSession ? 'готово' : 'нет сессии'}
              </span>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Продолжить активную сессию</p>
          </div>

          {/* claude-f <ID> */}
          <div className="bg-[#2d2d2d] rounded p-2">
            <div className="flex items-center justify-between">
              <code className="text-accent text-xs">claude-f &lt;ID&gt;</code>
              <span className="text-green-400 text-[10px]">всегда</span>
            </div>
            <p className="text-[10px] text-[#888] mt-1">Форк сессии по UUID</p>
          </div>
        </div>
      </div>

      {/* Quick Tips */}
      <div>
        <div className="text-[11px] uppercase text-[#888] mb-2">Подсказки</div>
        <ul className="text-[10px] text-[#777] space-y-1 list-disc list-inside">
          <li>Сессия сохраняется после перезапуска</li>
          <li>Форк создаёт копию в новой вкладке</li>
          <li>У каждой вкладки своя сессия</li>
        </ul>
      </div>
    </div>
  );
}
