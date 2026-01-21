import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../../store/useUIStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

interface Action {
  name: string;
  command: string;
}

interface ActionsPanelProps {
  activeTabId: string | null;
}

export default function ActionsPanel({ activeTabId }: ActionsPanelProps) {
  const { showToast, docPrompt, terminalSelection } = useUIStore();
  const { activeProjectId, createTab, getActiveProject, switchTab } = useWorkspaceStore();
  const [isUpdatingDocs, setIsUpdatingDocs] = useState(false);
  const [actions, setActions] = useState<Action[]>([]);
  const [isScissorsHovered, setIsScissorsHovered] = useState(false);

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

    ipcRenderer.send('terminal:executeCommand', activeTabId, command);
    showToast(`Running: ${command.substring(0, 30)}...`, 'info');
  };

  // Wait for Gemini to be ready (detects "type your message" in terminal output)
  const waitForGeminiReady = (tabId: string, timeoutMs: number = 15000): Promise<boolean> => {
    const pattern = 'type your message';

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(false);
      }, timeoutMs);

      let buffer = '';
      const handler = (_event: any, { tabId: dataTabId, data }: { tabId: string; data: string }) => {
        if (dataTabId !== tabId) return;

        buffer += data;
        // Strip ANSI codes for matching
        const cleanBuffer = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');

        if (cleanBuffer.toLowerCase().includes(pattern)) {
          clearTimeout(timeout);
          ipcRenderer.removeListener('terminal:data', handler);
          resolve(true);
        }
      };

      ipcRenderer.on('terminal:data', handler);
    });
  };

  // Wait for terminal silence (no data for silenceMs)
  const waitForSilence = (tabId: string, silenceMs: number = 500, maxWaitMs: number = 30000): Promise<boolean> => {
    return new Promise((resolve) => {
      let lastDataTime = Date.now();
      let silenceTimer: NodeJS.Timeout | null = null;

      const maxTimeout = setTimeout(() => {
        if (silenceTimer) clearTimeout(silenceTimer);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(true); // Resolve anyway after max wait
      }, maxWaitMs);

      const checkSilence = () => {
        clearTimeout(maxTimeout);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(true);
      };

      const handler = (_event: any, { tabId: dataTabId }: { tabId: string; data: string }) => {
        if (dataTabId !== tabId) return;

        lastDataTime = Date.now();

        // Reset silence timer
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(checkSilence, silenceMs);
      };

      ipcRenderer.on('terminal:data', handler);

      // Start initial silence timer
      silenceTimer = setTimeout(checkSilence, silenceMs);
    });
  };

  // Update Docs feature - exports Claude session and opens Gemini in new green tab
  const handleUpdateDocs = async () => {
    if (!activeTabId || !activeProjectId) {
      showToast('No active terminal tab', 'error');
      return;
    }

    const activeProject = getActiveProject();
    if (!activeProject) {
      showToast('No active project', 'error');
      return;
    }

    setIsUpdatingDocs(true);
    showToast('Exporting Claude session...', 'info');

    try {
      // 1. Get actual cwd of current terminal (where Claude is running)
      const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
      const workingDir = tabCwd || activeProject.projectPath;

      // 2. Export Claude session
      const exportResult = await ipcRenderer.invoke('docs:export-session', {
        tabId: activeTabId,
        projectPath: workingDir
      });

      if (!exportResult.success) {
        throw new Error(exportResult.error || 'Export failed');
      }

      showToast('Session exported, preparing Gemini...', 'info');

      // 3. Get documentation prompt
      let promptContent: string;
      if (docPrompt.useFile) {
        const promptResult = await ipcRenderer.invoke('docs:read-prompt-file', {
          filePath: docPrompt.filePath
        });
        if (!promptResult.success) {
          throw new Error(promptResult.error || 'Failed to read prompt file');
        }
        promptContent = promptResult.content;
      } else {
        promptContent = docPrompt.inlineContent;
      }

      if (!promptContent) {
        throw new Error('Documentation prompt is empty');
      }

      // 4. Generate tab name with index (docs-gemini-01, docs-gemini-02, etc.)
      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-'))
        .length;
      const tabIndex = String(existingDocsTabs + 1).padStart(2, '0');
      const tabName = `docs-gemini-${tabIndex}`;

      // 5. Create new green tab for Gemini (in main zone, not utility)
      const newTabId = await createTab(
        activeProjectId,
        tabName,
        workingDir, // Use same cwd as source terminal
        { color: 'green', isUtility: false }
      );

      if (!newTabId) {
        throw new Error('Failed to create new tab');
      }

      // 6. Don't switch tab - let user continue working in current terminal
      // New tab runs in background

      // 7. Wait for terminal to initialize
      await new Promise(resolve => setTimeout(resolve, 500));

      // 8. Save prompt to temp file (avoids shell escaping issues with special chars)
      const promptResult = await ipcRenderer.invoke('docs:save-prompt-temp', {
        projectPath: workingDir,
        promptContent,
        exportedFilePath: exportResult.exportedPath
      });

      if (!promptResult.success) {
        throw new Error(promptResult.error || 'Failed to save prompt file');
      }

      // 9. Start Gemini
      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      // 10. Wait for Gemini to be ready (detect "type your message" in output)
      const geminiReady = await waitForGeminiReady(newTabId, 15000);
      if (!geminiReady) {
        throw new Error('Timeout waiting for Gemini to start');
      }

      // Small delay after ready signal
      await new Promise(resolve => setTimeout(resolve, 300));

      // 11. Read prompt file and send directly to terminal (bypasses shell escaping)
      const promptFileContent = await ipcRenderer.invoke('file:read', promptResult.promptFile);
      if (promptFileContent.success) {
        // Send prompt + Enter immediately (PTY write is synchronous)
        ipcRenderer.send('terminal:input', newTabId, promptFileContent.content + '\r');
      }

      // 14. Cleanup temp prompt file (keep exported session - Gemini needs to read it!)
      await ipcRenderer.invoke('docs:cleanup-temp', {
        exportedPath: null,  // Don't delete - Gemini reads this file
        promptPath: promptResult.promptFile
      });

      showToast('Gemini started with documentation prompt', 'success');

    } catch (error: any) {
      console.error('[UpdateDocs] Error:', error);
      showToast(error.message || 'Update docs failed', 'error');
    } finally {
      setIsUpdatingDocs(false);
    }
  };

  // Update Docs with terminal selection (instead of Claude session export)
  const handleUpdateDocsWithSelection = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!activeTabId || !activeProjectId || !terminalSelection) {
      showToast('No selection in terminal', 'error');
      return;
    }

    const activeProject = getActiveProject();
    if (!activeProject) {
      showToast('No active project', 'error');
      return;
    }

    setIsUpdatingDocs(true);
    showToast('Using terminal selection...', 'info');

    try {
      // 1. Get actual cwd of current terminal
      const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
      const workingDir = tabCwd || activeProject.projectPath;

      // 2. Get documentation prompt
      let promptContent: string;
      if (docPrompt.useFile) {
        const promptResult = await ipcRenderer.invoke('docs:read-prompt-file', {
          filePath: docPrompt.filePath
        });
        if (!promptResult.success) {
          throw new Error(promptResult.error || 'Failed to read prompt file');
        }
        promptContent = promptResult.content;
      } else {
        promptContent = docPrompt.inlineContent;
      }

      if (!promptContent) {
        throw new Error('Documentation prompt is empty');
      }

      // 3. Generate tab name with index
      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-'))
        .length;
      const tabIndex = String(existingDocsTabs + 1).padStart(2, '0');
      const tabName = `docs-gemini-${tabIndex}`;

      // 4. Create new green tab for Gemini
      const newTabId = await createTab(
        activeProjectId,
        tabName,
        workingDir,
        { color: 'green', isUtility: false }
      );

      if (!newTabId) {
        throw new Error('Failed to create new tab');
      }

      // 5. Wait for terminal to initialize
      await new Promise(resolve => setTimeout(resolve, 500));

      // 6. Save selection to temp file (same pattern as Claude session export)
      const selectionResult = await ipcRenderer.invoke('docs:save-selection', {
        projectPath: workingDir,
        selectionText: terminalSelection
      });

      if (!selectionResult.success) {
        throw new Error(selectionResult.error || 'Failed to save selection file');
      }

      showToast('Selection saved, preparing Gemini...', 'info');

      // 7. Save prompt with path to selection file (same as Claude export flow)
      const promptResult = await ipcRenderer.invoke('docs:save-prompt-temp', {
        projectPath: workingDir,
        promptContent,
        exportedFilePath: selectionResult.selectionPath
      });

      if (!promptResult.success) {
        throw new Error(promptResult.error || 'Failed to save prompt file');
      }

      // 8. Start Gemini
      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      // 9. Wait for Gemini to be ready
      const geminiReady = await waitForGeminiReady(newTabId, 15000);
      if (!geminiReady) {
        throw new Error('Timeout waiting for Gemini to start');
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // 10. Read prompt file and send to terminal
      const promptFileContent = await ipcRenderer.invoke('file:read', promptResult.promptFile);
      if (promptFileContent.success) {
        ipcRenderer.send('terminal:input', newTabId, promptFileContent.content + '\r');
      }

      // 11. Cleanup temp prompt file (keep selection file - Gemini needs to read it!)
      await ipcRenderer.invoke('docs:cleanup-temp', {
        exportedPath: null,  // Don't delete selection file - Gemini reads it
        promptPath: promptResult.promptFile
      });

      showToast('Gemini started with selection', 'success');

    } catch (error: any) {
      console.error('[UpdateDocsSelection] Error:', error);
      showToast(error.message || 'Update docs failed', 'error');
    } finally {
      setIsUpdatingDocs(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] shrink-0">
        Quick Actions
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* System Tools Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[9px] uppercase font-semibold text-green-500">System</span>
            <div className="flex-1 h-px bg-[#333]" />
          </div>

          <button
            className={`w-full bg-green-900/30 border border-green-700/50 text-green-400 p-3 text-left cursor-pointer rounded-lg text-xs flex items-center gap-2 hover:bg-green-900/50 hover:border-green-600/50 transition-colors ${
              isUpdatingDocs ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            onClick={handleUpdateDocs}
            disabled={isUpdatingDocs}
          >
            <span className="text-base">📚</span>
            <div className="flex-1">
              <div className="font-medium">Update Docs</div>
              <div className="text-[10px] text-green-600 mt-0.5">
                {isUpdatingDocs ? 'Processing...' : 'Export session → Gemini analysis'}
              </div>
            </div>
            {/* Selection button - appears when text is selected in terminal */}
            {terminalSelection && !isUpdatingDocs && (
              <div
                className="relative z-10 text-white text-[9px] px-2 py-1.5 rounded flex items-center gap-1 cursor-pointer select-none"
                style={{
                  backgroundColor: isScissorsHovered ? '#3b82f6' : '#2563eb',
                  transform: isScissorsHovered ? 'scale(1.02)' : 'scale(1)',
                  boxShadow: isScissorsHovered ? '0 2px 6px rgba(59, 130, 246, 0.25)' : 'none',
                  transition: 'all 0.15s ease'
                }}
                onClick={handleUpdateDocsWithSelection}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => setIsScissorsHovered(true)}
                onMouseLeave={() => setIsScissorsHovered(false)}
                title={`Use selection (${terminalSelection.length} chars)`}
                role="button"
                tabIndex={0}
              >
                <span className="text-[10px]">✂️</span>
                <span className="font-medium">{terminalSelection.length}</span>
              </div>
            )}
          </button>
        </div>

        {/* User Actions Section */}
        {actions.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="text-[9px] uppercase font-semibold text-[#888]">User</span>
              <div className="flex-1 h-px bg-[#333]" />
            </div>

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
        )}
      </div>
    </div>
  );
}
