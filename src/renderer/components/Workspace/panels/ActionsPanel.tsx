import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../../store/useUIStore';
import { useWorkspaceStore } from '../../../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

// Portal for settings menu to escape overflow and z-index issues
const SettingsPortal: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return createPortal(children, document.body);
};

interface Action {
  name: string;
  command: string;
}

interface ActionsPanelProps {
  activeTabId: string | null;
  embedded?: boolean; // When true, renders without header/wrapper (for embedding in InfoPanel)
}

export default function ActionsPanel({ activeTabId, embedded = false }: ActionsPanelProps) {
  const { showToast, docPrompt, terminalSelection } = useUIStore();
  const { activeProjectId, createTab, closeTab, getActiveProject, switchTab, getSelectedTabs, clearSelection } = useWorkspaceStore();
  const [isUpdatingDocs, setIsUpdatingDocs] = useState(false);
  const cancelledRef = useRef(false);
  const docsGeminiTabIdRef = useRef<string | null>(null);
  const [actions, setActions] = useState<Action[]>([]); // Kept for potential future use, loaded from global_commands DB table
  const [isScissorsHovered, setIsScissorsHovered] = useState(false);
  
  // Copy Session state
  const [copySessionExpanded, setCopySessionExpanded] = useState(false);
  const [copySessionInput, setCopySessionInput] = useState('');
  const [isCopying, setIsCopying] = useState(false);
  
  // New toggles
  const [includeCode, setIncludeCode] = useState(false);
  const [fromStart, setFromStart] = useState(true);
  const [showCopySettings, setShowCopySettings] = useState(false);
  const copyIconRef = useRef<HTMLSpanElement>(null);

  const selectedTabs = activeProjectId ? getSelectedTabs(activeProjectId) : [];

  // Get icon position for portal positioning
  const getIconPosition = useCallback(() => {
    if (!copyIconRef.current) return { x: 0, y: 0 };
    const rect = copyIconRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }, []);

  // Direction-based close (exactly like Timeline)
  const handleMouseLeaveIcon = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX;

    // If mouse went LEFT (towards settings menu) - keep open
    // If mouse went RIGHT or other direction - close
    const wentLeft = mouseX < rect.left;

    if (!wentLeft) {
      setShowCopySettings(false);
    }
  }, []);

  const handleMouseLeaveSettingsArea = useCallback(() => {
    setShowCopySettings(false);
  }, []);
  const isMultiSelect = selectedTabs.length > 1;

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
  const waitForGeminiReady = (tabId: string, timeoutMs: number = 40000): Promise<boolean> => {
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

  // Cancel Update Docs — close created Gemini tab if any
  const handleCancelUpdateDocs = useCallback(() => {
    cancelledRef.current = true;
    if (docsGeminiTabIdRef.current && activeProjectId) {
      closeTab(activeProjectId, docsGeminiTabIdRef.current);
      docsGeminiTabIdRef.current = null;
    }
    setIsUpdatingDocs(false);
    showToast('Отменено', 'info');
  }, [activeProjectId, closeTab, showToast]);

  // Update Docs feature - exports Claude session and opens Gemini in new blue tab
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

    cancelledRef.current = false;
    docsGeminiTabIdRef.current = null;
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

      if (cancelledRef.current) return;
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

      if (cancelledRef.current) return;

      // 4. Generate tab name with index (docs-gemini-01, docs-gemini-02, etc.)
      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-'))
        .length;
      const tabIndex = String(existingDocsTabs + 1).padStart(2, '0');
      const tabName = `docs-gemini-${tabIndex}`;

      // 5. Create new blue (gemini) tab (in main zone, not utility)
      const newTabId = await createTab(
        activeProjectId,
        tabName,
        workingDir, // Use same cwd as source terminal
        { color: 'gemini', isUtility: false }
      );

      if (!newTabId) {
        throw new Error('Failed to create new tab');
      }

      docsGeminiTabIdRef.current = newTabId;

      if (cancelledRef.current) return;

      // 6. Don't switch tab - let user continue working in current terminal

      // 7. Wait for terminal to initialize
      await new Promise(resolve => setTimeout(resolve, 500));

      if (cancelledRef.current) return;

      // 8. Save prompt to temp file (avoids shell escaping issues with special chars)
      const promptResult = await ipcRenderer.invoke('docs:save-prompt-temp', {
        projectPath: workingDir,
        promptContent,
        exportedFilePath: exportResult.exportedPath
      });

      if (!promptResult.success) {
        throw new Error(promptResult.error || 'Failed to save prompt file');
      }

      if (cancelledRef.current) return;

      // 9. Start Gemini
      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      // 10. Wait for Gemini to be ready (detect "type your message" in output)
      const geminiReady = await waitForGeminiReady(newTabId, 30000);

      if (cancelledRef.current) return;

      if (!geminiReady) {
        throw new Error('Timeout waiting for Gemini to start');
      }

      // Small delay after ready signal
      await new Promise(resolve => setTimeout(resolve, 300));

      if (cancelledRef.current) return;

      // 11. Read prompt file and send directly to terminal (bypasses shell escaping)
      const promptFileContent = await ipcRenderer.invoke('file:read', promptResult.promptFile);
      if (promptFileContent.success) {
        // Send prompt + Enter immediately (PTY write is synchronous)
        ipcRenderer.send('terminal:input', newTabId, promptFileContent.content + '\r');
      }

      // 12. Cleanup temp prompt file (keep exported session - Gemini needs to read it!)
      await ipcRenderer.invoke('docs:cleanup-temp', {
        exportedPath: null,  // Don't delete - Gemini reads this file
        promptPath: promptResult.promptFile
      });

      docsGeminiTabIdRef.current = null;
      showToast('Gemini started with documentation prompt', 'success');

    } catch (error: any) {
      if (cancelledRef.current) return;
      console.error('[UpdateDocs] Error:', error);
      showToast(error.message || 'Update docs failed', 'error');
    } finally {
      if (!cancelledRef.current) setIsUpdatingDocs(false);
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

    cancelledRef.current = false;
    docsGeminiTabIdRef.current = null;
    setIsUpdatingDocs(true);
    showToast('Using terminal selection...', 'info');

    try {
      const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
      const workingDir = tabCwd || activeProject.projectPath;

      let promptContent: string;
      if (docPrompt.useFile) {
        const promptResult = await ipcRenderer.invoke('docs:read-prompt-file', { filePath: docPrompt.filePath });
        if (!promptResult.success) throw new Error(promptResult.error || 'Failed to read prompt file');
        promptContent = promptResult.content;
      } else {
        promptContent = docPrompt.inlineContent;
      }
      if (!promptContent) throw new Error('Documentation prompt is empty');

      if (cancelledRef.current) return;

      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-')).length;
      const tabName = `docs-gemini-${String(existingDocsTabs + 1).padStart(2, '0')}`;

      const newTabId = await createTab(activeProjectId, tabName, workingDir, { color: 'gemini', isUtility: false });
      if (!newTabId) throw new Error('Failed to create new tab');
      docsGeminiTabIdRef.current = newTabId;

      if (cancelledRef.current) return;

      await new Promise(resolve => setTimeout(resolve, 500));

      const selectionResult = await ipcRenderer.invoke('docs:save-selection', { projectPath: workingDir, selectionText: terminalSelection });
      if (!selectionResult.success) throw new Error(selectionResult.error || 'Failed to save selection file');

      showToast('Selection saved, preparing Gemini...', 'info');

      if (cancelledRef.current) return;

      const promptResult = await ipcRenderer.invoke('docs:save-prompt-temp', { projectPath: workingDir, promptContent, exportedFilePath: selectionResult.selectionPath });
      if (!promptResult.success) throw new Error(promptResult.error || 'Failed to save prompt file');

      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      const geminiReady = await waitForGeminiReady(newTabId, 30000);
      if (cancelledRef.current) return;
      if (!geminiReady) throw new Error('Timeout waiting for Gemini to start');

      await new Promise(resolve => setTimeout(resolve, 300));
      if (cancelledRef.current) return;

      const promptFileContent = await ipcRenderer.invoke('file:read', promptResult.promptFile);
      if (promptFileContent.success) {
        ipcRenderer.send('terminal:input', newTabId, promptFileContent.content + '\r');
      }

      await ipcRenderer.invoke('docs:cleanup-temp', { exportedPath: null, promptPath: promptResult.promptFile });

      docsGeminiTabIdRef.current = null;
      showToast('Gemini started with selection', 'success');

    } catch (error: any) {
      if (cancelledRef.current) return;
      console.error('[UpdateDocsSelection] Error:', error);
      showToast(error.message || 'Update docs failed', 'error');
    } finally {
      if (!cancelledRef.current) setIsUpdatingDocs(false);
    }
  };

  // Update Docs with clipboard content (instead of Claude session export)
  const handleUpdateDocsWithClipboard = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!activeTabId || !activeProjectId) {
      showToast('No active terminal tab', 'error');
      return;
    }

    // Read clipboard
    let clipboardText: string;
    try {
      clipboardText = await navigator.clipboard.readText();
      if (!clipboardText || clipboardText.trim().length === 0) {
        showToast('Буфер обмена пуст', 'warning');
        return;
      }
    } catch (err) {
      showToast('Не удалось прочитать буфер обмена', 'error');
      return;
    }

    const activeProject = getActiveProject();
    if (!activeProject) {
      showToast('No active project', 'error');
      return;
    }

    cancelledRef.current = false;
    docsGeminiTabIdRef.current = null;
    setIsUpdatingDocs(true);
    showToast('Using clipboard content...', 'info');

    try {
      const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
      const workingDir = tabCwd || activeProject.projectPath;

      let promptContent: string;
      if (docPrompt.useFile) {
        const promptResult = await ipcRenderer.invoke('docs:read-prompt-file', { filePath: docPrompt.filePath });
        if (!promptResult.success) throw new Error(promptResult.error || 'Failed to read prompt file');
        promptContent = promptResult.content;
      } else {
        promptContent = docPrompt.inlineContent;
      }
      if (!promptContent) throw new Error('Documentation prompt is empty');

      if (cancelledRef.current) return;

      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-')).length;
      const tabName = `docs-gemini-${String(existingDocsTabs + 1).padStart(2, '0')}`;

      const newTabId = await createTab(activeProjectId, tabName, workingDir, { color: 'gemini', isUtility: false });
      if (!newTabId) throw new Error('Failed to create new tab');
      docsGeminiTabIdRef.current = newTabId;

      if (cancelledRef.current) return;

      await new Promise(resolve => setTimeout(resolve, 500));

      const selectionResult = await ipcRenderer.invoke('docs:save-selection', { projectPath: workingDir, selectionText: clipboardText });
      if (!selectionResult.success) throw new Error(selectionResult.error || 'Failed to save clipboard file');

      showToast('Clipboard saved, preparing Gemini...', 'info');

      if (cancelledRef.current) return;

      const promptResult = await ipcRenderer.invoke('docs:save-prompt-temp', { projectPath: workingDir, promptContent, exportedFilePath: selectionResult.selectionPath });
      if (!promptResult.success) throw new Error(promptResult.error || 'Failed to save prompt file');

      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      const geminiReady = await waitForGeminiReady(newTabId, 30000);
      if (cancelledRef.current) return;
      if (!geminiReady) throw new Error('Timeout waiting for Gemini to start');

      await new Promise(resolve => setTimeout(resolve, 300));
      if (cancelledRef.current) return;

      const promptFileContent = await ipcRenderer.invoke('file:read', promptResult.promptFile);
      if (promptFileContent.success) {
        ipcRenderer.send('terminal:input', newTabId, promptFileContent.content + '\r');
      }

      await ipcRenderer.invoke('docs:cleanup-temp', { exportedPath: null, promptPath: promptResult.promptFile });

      docsGeminiTabIdRef.current = null;
      const sizeKB = Math.round(clipboardText.length / 1024);
      showToast(`Gemini started with clipboard (${sizeKB}KB)`, 'success');

    } catch (error: any) {
      if (cancelledRef.current) return;
      console.error('[UpdateDocsClipboard] Error:', error);
      showToast(error.message || 'Update docs failed', 'error');
    } finally {
      if (!cancelledRef.current) setIsUpdatingDocs(false);
    }
  };

  // Copy Claude session to clipboard (with options and multi-tab support)
  const handleCopySession = async (sessionIdOverride?: string) => {
    console.log('[CopySession] Starting copy session...', {
      sessionIdOverride,
      isMultiSelect,
      selectedTabsCount: selectedTabs.length,
      activeTabId,
      includeCode,
      fromStart
    });

    const activeProject = getActiveProject();
    if (!activeProject) {
      console.warn('[CopySession] No active project');
      showToast('No active project', 'error');
      return;
    }

    // Determine tabs to copy
    const tabsToCopy = isMultiSelect ? selectedTabs : (activeTabId ? [activeProject.tabs.get(activeTabId)] : []);
    console.log('[CopySession] Tabs to copy:', tabsToCopy.map(t => t && { id: t.id, name: t.name, claudeSessionId: t.claudeSessionId }));

    const validTabsToCopy = tabsToCopy.filter(t => t && (t.claudeSessionId || sessionIdOverride || copySessionInput.trim()));
    console.log('[CopySession] Valid tabs to copy:', validTabsToCopy.length);

    if (validTabsToCopy.length === 0) {
      console.warn('[CopySession] No valid sessions to copy');
      showToast('Нет сессий для копирования', 'warning');
      return;
    }

    setIsCopying(true);
    try {
      const allResults: string[] = [];

      for (const tab of validTabsToCopy) {
        if (!tab) continue;

        let targetSessionId = '';
        let parsedCwd = '';

        if (sessionIdOverride || copySessionInput.trim()) {
          const inputText = sessionIdOverride || copySessionInput.trim();
          const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
          const cwdPattern = /cwd:\s*(\/[^\s\n]+)/i;

          const uuidMatch = inputText.match(uuidPattern);
          if (uuidMatch) targetSessionId = uuidMatch[0];

          const cwdMatch = inputText.match(cwdPattern);
          if (cwdMatch) parsedCwd = cwdMatch[1];
        }

        if (!targetSessionId) {
          targetSessionId = tab.claudeSessionId || '';
        }

        if (!targetSessionId) {
          console.log('[CopySession] Skipping tab without session ID:', tab.name);
          continue;
        }

        const tabCwd = await ipcRenderer.invoke('terminal:getCwd', tab.id).catch(() => null);
        const cwd = parsedCwd || tabCwd || tab.cwd || activeProject.projectPath;

        console.log('[CopySession] Exporting session:', {
          tabName: tab.name,
          sessionId: targetSessionId,
          cwd,
          includeCode,
          fromStart
        });

        const result = await ipcRenderer.invoke('claude:export-clean-session', {
          sessionId: targetSessionId,
          cwd,
          includeCode,
          fromStart
        });

        if (result.success) {
          console.log('[CopySession] Success for tab:', tab.name, 'Content length:', result.content?.length);
          allResults.push(result.content);
        } else {
          console.warn(`[CopySession] Failed for tab ${tab.name}:`, result.error);
        }
      }

      if (allResults.length > 0) {
        const finalContent = allResults.join('\n\n' + '='.repeat(40) + '\n\n');
        await navigator.clipboard.writeText(finalContent);
        const sizeKB = Math.round(finalContent.length / 1024);
        console.log('[CopySession] Copied to clipboard:', {
          sessionsCount: validTabsToCopy.length,
          totalSize: finalContent.length,
          sizeKB
        });
        showToast(`Скопировано ${validTabsToCopy.length} сессий (${sizeKB}KB)`, 'success');

        // Clear selection after successful multi-copy
        if (isMultiSelect) clearSelection(activeProject.projectId);
      } else {
        console.warn('[CopySession] No results to copy');
        showToast('Не удалось скопировать ни одной сессии', 'error');
      }
    } catch (e: any) {
      console.error('[CopySession] Error:', e);
      showToast(`Ошибка: ${e.message}`, 'error');
    } finally {
      setIsCopying(false);
    }
  };

  const content = (
      <>
        {/* Multi-Select Info */}
        {isMultiSelect && (
          <div className="mb-4 bg-accent/10 border border-accent/20 rounded-lg p-3 text-xs text-accent flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base">📑</span>
              <div className="font-medium">Выбрано {selectedTabs.length} вкладок</div>
            </div>
            <button 
              onClick={() => activeProjectId && clearSelection(activeProjectId)}
              className="px-2 py-1 hover:bg-accent/20 rounded transition-colors"
            >
              Сбросить
            </button>
          </div>
        )}

        {/* System Tools Section */}
        <div className="mb-4">
          {!isMultiSelect && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="text-[9px] uppercase font-semibold text-blue-500">System</span>
              <div className="flex-1 h-px bg-[#333]" />
            </div>
          )}

          {!isMultiSelect && (
            <div className="flex flex-col gap-1">
              <button
                className={`w-full bg-blue-900/30 border border-blue-700/30 text-blue-400 p-3 text-left cursor-pointer rounded-lg text-xs flex items-center gap-2 hover:bg-blue-900/50 hover:border-blue-600/40 transition-colors focus:outline-none ${
                  isUpdatingDocs ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                onClick={handleUpdateDocs}
                disabled={isUpdatingDocs}
              >
                <span className="text-base">📚</span>
                <div className="flex-1">
                  <div className="font-medium">Update Docs</div>
                  <div className="text-[10px] text-blue-600 mt-0.5">
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
                {/* Clipboard button - use content from clipboard */}
                {!isUpdatingDocs && (
                  <div
                    className="relative z-10 text-white text-[9px] px-2 py-1.5 rounded flex items-center gap-1 cursor-pointer select-none transition-all"
                    style={{
                      backgroundColor: '#7c3aed',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#8b5cf6'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7c3aed'}
                    onClick={handleUpdateDocsWithClipboard}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="Use clipboard content"
                    role="button"
                    tabIndex={0}
                  >
                    <span className="text-[10px]">📋</span>
                  </div>
                )}
              </button>
              {/* Cancel button — only visible during processing */}
              {isUpdatingDocs && (
                <button
                  className="w-full bg-red-900/20 border border-red-700/20 text-red-400 p-2 text-center cursor-pointer rounded-lg text-[11px] hover:bg-red-900/40 hover:border-red-600/30 transition-colors focus:outline-none"
                  onClick={handleCancelUpdateDocs}
                >
                  Отменить
                </button>
              )}
            </div>
          )}

          {/* Copy Session - export Claude session */}
          <div className={`${isMultiSelect ? '' : 'mt-2'}`}>
            <div
              className={`w-full text-[#DA7756] p-3 text-left rounded-lg text-xs flex items-center gap-2 transition-colors ${
                isCopying ? 'opacity-50' : ''
              }`}
              style={{
                backgroundColor: 'rgba(218, 119, 86, 0.1)',
                border: '1px solid rgba(218, 119, 86, 0.15)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(218, 119, 86, 0.18)';
                e.currentTarget.style.borderColor = 'rgba(218, 119, 86, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(218, 119, 86, 0.1)';
                e.currentTarget.style.borderColor = 'rgba(218, 119, 86, 0.15)';
              }}
            >
              {/* Icon with simple hover (no scale - like Timeline) */}
              <div
                ref={copyIconRef}
                className={`relative w-6 h-6 flex items-center justify-center cursor-pointer rounded transition-colors ${showCopySettings ? 'bg-white/15' : 'hover:bg-white/10'}`}
                onMouseEnter={() => setShowCopySettings(true)}
                onMouseLeave={handleMouseLeaveIcon}
              >
                <span className="text-base">📋</span>
                {/* Indicators */}
                <div className="absolute -bottom-1 -right-1 flex gap-0.5 pointer-events-none">
                  {includeCode && <div className="w-1.5 h-1.5 rounded-full bg-green-500 border border-[#1a1a1a]" title="С кодом" />}
                  {!fromStart && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 border border-[#1a1a1a]" title="С последнего форка" />}
                </div>
              </div>

              {/* Settings Menu Portal (like Timeline tooltip) */}
              {showCopySettings && (
                <SettingsPortal>
                  <div
                    onMouseLeave={handleMouseLeaveSettingsArea}
                    style={{
                      position: 'fixed',
                      left: getIconPosition().x - 190, // Menu width (150) + bridge (40)
                      top: getIconPosition().y - 60,   // Center vertically
                      zIndex: 10000,
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                    }}
                  >
                    {/* Settings Menu Content */}
                    <div
                      className="bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl p-2 min-w-[150px] flex flex-col gap-2"
                      style={{
                        backdropFilter: 'blur(12px)',
                        boxShadow: '0 15px 35px rgba(0,0,0,0.6)',
                      }}
                    >
                      <div className="px-1 py-0.5 text-[9px] uppercase font-bold text-[#666] border-b border-[#333] mb-1">Настройки</div>

                      <label className="flex items-center justify-between gap-3 cursor-pointer group/label px-1">
                        <span className="text-[10px] text-[#aaa] group-hover/label:text-white transition-colors">С кодом</span>
                        <div
                          className={`w-7 h-4 rounded-full relative transition-colors cursor-pointer ${includeCode ? 'bg-[#DA7756]' : 'bg-[#444]'}`}
                          onClick={(e) => { e.stopPropagation(); setIncludeCode(!includeCode); }}
                        >
                          <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${includeCode ? 'left-[14px]' : 'left-0.5'}`} />
                        </div>
                      </label>

                      <label className="flex items-center justify-between gap-3 cursor-pointer group/label px-1">
                        <span className="text-[10px] text-[#aaa] group-hover/label:text-white transition-colors">С начала</span>
                        <div
                          className={`w-7 h-4 rounded-full relative transition-colors cursor-pointer ${fromStart ? 'bg-[#DA7756]' : 'bg-[#444]'}`}
                          onClick={(e) => { e.stopPropagation(); setFromStart(!fromStart); }}
                        >
                          <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${fromStart ? 'left-[14px]' : 'left-0.5'}`} />
                        </div>
                      </label>
                    </div>

                    {/* CSS Bridge - invisible area connecting menu to icon */}
                    <div style={{ width: '40px', height: '80px' }} />
                  </div>
                </SettingsPortal>
              )}

              <div className="flex-1">
                {/* Clickable title - copies current session(s) */}
                <div
                  className="font-medium cursor-pointer hover:text-white hover:underline transition-colors inline-block"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isCopying) handleCopySession();
                  }}
                  title={isMultiSelect ? `Копировать ${selectedTabs.length} сессий` : "Копировать текущую сессию"}
                >
                  {isMultiSelect ? `Copy ${selectedTabs.length} Sessions` : 'Copy Session'}
                </div>
                <div
                  className="text-[10px] text-[#DA7756]/70 mt-0.5 cursor-pointer"
                  onClick={() => !isCopying && setCopySessionExpanded(!copySessionExpanded)}
                >
                  {isCopying ? 'Копирование...' : 
                    isMultiSelect ? `Экспорт ${selectedTabs.length} сессий в буфер` : 'Claude JSONL → clipboard'}
                </div>
              </div>
              {/* Hide expand button when multi-select - no need for manual ID input */}
              {!isMultiSelect && (
                <span
                  className="text-[10px] text-[#DA7756]/50 cursor-pointer hover:text-[#DA7756] transition-colors px-1"
                  onClick={() => !isCopying && setCopySessionExpanded(!copySessionExpanded)}
                >
                  {copySessionExpanded ? '▼' : '▶'}
                </span>
              )}
            </div>

            {/* Expanded area with textarea (only show for single select) */}
            {copySessionExpanded && !isMultiSelect && (
              <div className="mt-2 p-2 bg-[#1a1a1a] border border-[#DA7756]/30 rounded-lg">
                <textarea
                  value={copySessionInput}
                  onChange={(e) => setCopySessionInput(e.target.value)}
                  placeholder="Вставьте текст с Session ID и cwd..."
                  className="w-full min-h-[40px] p-2 bg-[#252525] border border-[#333] rounded text-[10px] text-[#aaa] font-mono resize-none focus:outline-none focus:border-[#DA7756] placeholder:text-[#555]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey && copySessionInput.trim()) {
                      e.preventDefault();
                      handleCopySession();
                    }
                  }}
                />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[9px] text-[#555]">⌘+Enter для копирования</span>
                  <button
                    onClick={() => handleCopySession()}
                    disabled={isCopying || (!copySessionInput.trim() && !activeTabId)}
                    className="text-[10px] px-3 py-1.5 rounded transition-colors bg-[#DA7756] text-white hover:bg-[#DA7756]/80 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isCopying ? 'Копирование...' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] shrink-0">
        Quick Actions
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {content}
      </div>
    </div>
  );
}
