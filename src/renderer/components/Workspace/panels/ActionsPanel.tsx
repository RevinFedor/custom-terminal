import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface Action {
  name: string;
  command: string;
}

interface ActionsPanelProps {
  activeTabId: string | null;
}

export default function ActionsPanel({ activeTabId }: ActionsPanelProps) {
  const { showToast } = useUIStore();
  const [actions, setActions] = useState<Action[]>([]);

  useEffect(() => {
    loadActions();
  }, []);

  const loadActions = async () => {
    try {
      const result = await ipcRenderer.invoke('commands:get-global');
      if (result.success && result.data) {
        setActions(result.data);
      }
    } catch (err) {
      console.error('[Actions] Error loading:', err);
    }
  };

  const runAction = (command: string) => {
    if (!activeTabId) {
      showToast('No active terminal tab', 'error');
      return;
    }

    console.log('[Actions] Running command:', command);
    ipcRenderer.send('terminal:executeCommand', activeTabId, command);
    showToast(`Running: ${command.substring(0, 30)}...`, 'info');
  };

  if (actions.length === 0) {
    return (
      <div className="h-full p-4 flex items-center justify-center text-gray-500 text-sm">
        <p className="text-center">
          No quick actions defined.<br />
          <span className="text-xs text-[#666]">Add commands in Settings → Commands</span>
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] shrink-0">
        Quick Actions
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <div className="flex flex-col gap-2">
          {actions.map((action, index) => (
            <button
              key={index}
              className="bg-[#333] border border-[#444] text-[#ddd] p-2 text-left cursor-pointer rounded text-xs flex items-center hover:bg-[#444] hover:border-[#555] transition-colors"
              onClick={() => runAction(action.command)}
            >
              <span className="mr-2 text-sm">⚡</span>
              {action.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
