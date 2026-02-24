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

  // Update Docs expandable prompt
  const [docsExpanded, setDocsExpanded] = useState(false);
  const [additionalPrompt, setAdditionalPrompt] = useState('');

  // Copy Session state
  const [copySessionExpanded, setCopySessionExpanded] = useState(false);
  const [copySessionInput, setCopySessionInput] = useState('');
  const [isCopying, setIsCopying] = useState(false);
  
  // New toggles
  const [includeEditing, setIncludeEditing] = useState(true);
  const [includeReading, setIncludeReading] = useState(false);
  const [fromStart, setFromStart] = useState(true);
  const [showCopySettings, setShowCopySettings] = useState(false);
  const [showDocsInfo, setShowDocsInfo] = useState(false);
  const [showCopyInfo, setShowCopyInfo] = useState(false);
  const copyIconRef = useRef<HTMLSpanElement>(null);
  const copyContainerRef = useRef<HTMLDivElement>(null);
  const docsTitleRef = useRef<HTMLDivElement>(null);
  const copyTitleRef = useRef<HTMLDivElement>(null);
  const docsBlockRef = useRef<HTMLDivElement>(null);

  const selectedTabs = activeProjectId ? getSelectedTabs(activeProjectId) : [];

  // DEBUG: native event listener to bypass React delegation
  useEffect(() => {
    const el = copyContainerRef.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      console.log('[CopySession] NATIVE mousedown!', (e.target as HTMLElement).textContent?.slice(0, 30));
    };
    const onUp = (e: MouseEvent) => {
      console.log('[CopySession] NATIVE click!', (e.target as HTMLElement).textContent?.slice(0, 30));
    };
    el.addEventListener('mousedown', onDown, true); // capture phase
    el.addEventListener('click', onUp, true);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('click', onUp, true);
    };
  }, []);

  const handleMouseLeaveSettingsArea = useCallback(() => {
    setShowCopySettings(false);
  }, []);
  // Info panel helper — read-only reference showing current parameters
  // Uses block ref for horizontal alignment (flush with block left edge)
  const renderInfoPanel = (blockRef: React.RefObject<HTMLDivElement | null>, color: 'blue' | 'orange') => {
    if (!blockRef.current) return null;
    const blockRect = blockRef.current.getBoundingClientRect();
    const accent = color === 'blue' ? 'rgba(59, 130, 246, 0.3)' : 'rgba(218, 119, 86, 0.3)';
    const headerColor = color === 'blue' ? '#60a5fa' : '#DA7756';
    return (
      <SettingsPortal>
        <div style={{
          position: 'fixed',
          left: blockRect.left - 3,
          top: blockRect.top + blockRect.height / 2,
          transform: 'translate(-100%, -50%)',
          zIndex: 10000,
          pointerEvents: 'none',
        }}>
          <div style={{
            backgroundColor: 'rgba(26, 26, 26, 0.98)',
            border: `1px solid ${accent}`,
            borderRadius: '6px',
            padding: '6px 10px',
            fontSize: '10px',
            minWidth: '130px',
            backdropFilter: 'blur(12px)',
            boxShadow: `0 8px 24px rgba(0,0,0,0.5)`,
          }}>
            <div style={{ color: headerColor, fontWeight: 600, marginBottom: 4, fontSize: 9, textTransform: 'uppercase' }}>Параметры</div>
            {[
              { label: 'Чтение', active: includeReading },
              { label: 'Редактирование', active: includeEditing },
              { label: 'С начала', active: fromStart },
            ].map(({ label, active }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1px 0', color: '#999' }}>
                <span>{label}</span>
                <span style={{ color: active ? '#4ade80' : '#555', fontSize: 11 }}>{active ? '●' : '○'}</span>
              </div>
            ))}
          </div>
        </div>
      </SettingsPortal>
    );
  };

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

  // Unified Update Docs — exports content and opens Gemini in new blue tab
  const handleUpdateDocs = async (source: 'session' | 'selection' | 'clipboard' = 'session', e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    if (!activeTabId || !activeProjectId) {
      showToast('No active terminal tab', 'error');
      return;
    }

    if (source === 'selection' && !terminalSelection) {
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

    try {
      const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
      const workingDir = tabCwd || activeProject.projectPath;

      // 1. Get content based on source
      let content: string;

      if (source === 'selection') {
        content = terminalSelection!;
        showToast('Using terminal selection...', 'info');
      } else if (source === 'clipboard') {
        try {
          content = await navigator.clipboard.readText();
          if (!content?.trim()) { showToast('Буфер обмена пуст', 'warning'); return; }
        } catch { showToast('Не удалось прочитать буфер обмена', 'error'); return; }
        showToast('Using clipboard content...', 'info');
      } else {
        // Session export via claude:export-clean-session (same as Copy Session)
        showToast('Exporting session...', 'info');
        const tabsToCopy = isMultiSelect ? selectedTabs : [activeProject.tabs.get(activeTabId)];
        const validTabs = tabsToCopy.filter(t => t?.claudeSessionId);

        if (validTabs.length === 0) {
          showToast('Нет сессий для экспорта', 'warning');
          setIsUpdatingDocs(false);
          return;
        }

        const results: string[] = [];
        for (const tab of validTabs) {
          if (!tab) continue;
          const cwd = await ipcRenderer.invoke('terminal:getCwd', tab.id).catch(() => null) || tab.cwd || activeProject.projectPath;
          const result = await ipcRenderer.invoke('claude:export-clean-session', {
            sessionId: tab.claudeSessionId,
            cwd,
            includeEditing,
            includeReading,
            fromStart
          });
          if (result.success) results.push(result.content);
        }

        if (results.length === 0) { showToast('Export failed', 'error'); setIsUpdatingDocs(false); return; }
        content = results.join('\n\n' + '='.repeat(40) + '\n\n');
        if (isMultiSelect) clearSelection(activeProject.projectId);
      }

      if (cancelledRef.current) return;

      // 2. Get documentation prompt from settings
      let systemPrompt: string;
      if (docPrompt.useFile) {
        const promptResult = await ipcRenderer.invoke('docs:read-prompt-file', { filePath: docPrompt.filePath });
        if (!promptResult.success) throw new Error(promptResult.error || 'Failed to read prompt file');
        systemPrompt = promptResult.content;
      } else {
        systemPrompt = docPrompt.inlineContent;
      }
      if (!systemPrompt) throw new Error('Documentation prompt is empty');

      if (cancelledRef.current) return;

      // 3. Create Gemini tab
      const existingDocsTabs = Array.from(activeProject.tabs.values())
        .filter(t => t.name.startsWith('docs-gemini-')).length;
      const tabName = `docs-gemini-${String(existingDocsTabs + 1).padStart(2, '0')}`;

      const newTabId = await createTab(activeProjectId, tabName, workingDir, { color: 'gemini', isUtility: false });
      if (!newTabId) throw new Error('Failed to create tab');
      docsGeminiTabIdRef.current = newTabId;

      if (cancelledRef.current) return;

      // 4. Save session content to /tmp/ file (large data stays on disk, not pasted)
      const saveResult = await ipcRenderer.invoke('docs:save-temp', { content, projectPath: workingDir });
      if (!saveResult.success) throw new Error('Failed to save temp file: ' + saveResult.error);
      console.warn('[UpdateDocs] Session data saved to: ' + saveResult.filePath + ' (' + content.length + ' chars)');

      if (cancelledRef.current) return;

      // 5. Build prompt text: system prompt + @filepath reference + additional
      // Only the prompt (small) is typed; Gemini reads the big file via @path
      const promptText = [
        'Ниже промпт документации:\n',
        systemPrompt,
        '\n' + saveResult.filePath,
        additionalPrompt.trim() ? '\n' + additionalPrompt.trim() : ''
      ].filter(Boolean).join('\n');

      // 6. Start Gemini and send prompt
      await ipcRenderer.invoke('terminal:executeCommandAsync', newTabId, 'gemini');

      const geminiReady = await waitForGeminiReady(newTabId, 30000);
      if (cancelledRef.current) return;
      if (!geminiReady) throw new Error('Timeout waiting for Gemini to start');

      await new Promise(resolve => setTimeout(resolve, 500));
      if (cancelledRef.current) return;

      console.warn('[UpdateDocs] Sending prompt to Gemini via paste: ' + promptText.length + ' chars');
      await ipcRenderer.invoke('terminal:paste', {
        tabId: newTabId,
        content: promptText,
        submit: true
      });

      docsGeminiTabIdRef.current = null;
      showToast('Gemini started with session context', 'success');

    } catch (error: any) {
      if (cancelledRef.current) return;
      console.error('[UpdateDocs] Error:', error);
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
      includeEditing,
      includeReading,
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
          includeEditing,
          includeReading,
          fromStart
        });

        const result = await ipcRenderer.invoke('claude:export-clean-session', {
          sessionId: targetSessionId,
          cwd,
          includeEditing,
          includeReading,
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
      <div data-keep-selection>
        {/* System Tools Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-[9px] uppercase font-semibold text-blue-500">System</span>
            <div className="flex-1 h-px bg-[#333]" />
          </div>

          <div className="flex flex-col gap-1">
              <div
                ref={docsBlockRef}
                className={`w-full bg-blue-900/30 border border-blue-700/30 text-blue-400 p-3 text-left rounded-lg text-xs flex items-center gap-2 ${
                  isUpdatingDocs ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                style={{ cursor: isUpdatingDocs ? 'not-allowed' : 'default' }}
              >
                <span className="text-base">📚</span>
                <div className="flex-1">
                  <div
                    ref={docsTitleRef}
                    className="font-medium cursor-pointer hover:text-white hover:underline inline-block"
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => setShowDocsInfo(true)}
                    onMouseLeave={() => setShowDocsInfo(false)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isUpdatingDocs) handleUpdateDocs('session');
                    }}
                    title={isMultiSelect ? `Export ${selectedTabs.length} sessions → Gemini` : 'Export session → Gemini'}
                  >
                    {isMultiSelect ? `Update Docs (${selectedTabs.length})` : 'Update Docs'}
                  </div>
                  {showDocsInfo && renderInfoPanel(docsBlockRef, 'blue')}
                  <div
                    className="text-[10px] text-blue-600 mt-0.5 cursor-pointer"
                    onClick={() => !isUpdatingDocs && setDocsExpanded(!docsExpanded)}
                  >
                    {isUpdatingDocs ? 'Processing...' :
                      additionalPrompt.trim() ? `+ prompt (${additionalPrompt.trim().length})` : 'Session → Gemini analysis'}
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
                    }}
                    onClick={(e) => handleUpdateDocs('selection', e)}
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
                {/* Clipboard button - use content from clipboard (hidden during multi-select) */}
                {!isUpdatingDocs && !isMultiSelect && (
                  <div
                    className="relative z-10 text-white text-[9px] px-2 py-1.5 rounded flex items-center gap-1 cursor-pointer select-none"
                    style={{ backgroundColor: '#7c3aed' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#8b5cf6'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7c3aed'}
                    onClick={(e) => handleUpdateDocs('clipboard', e)}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="Use clipboard content"
                    role="button"
                    tabIndex={0}
                  >
                    <span className="text-[10px]">📋</span>
                  </div>
                )}
                {/* Expand button for additional prompt */}
                {!isUpdatingDocs && (
                  <span
                    className="text-[10px] text-blue-400/50 cursor-pointer hover:text-blue-400 px-1"
                    onClick={(e) => { e.stopPropagation(); setDocsExpanded(!docsExpanded); }}
                  >
                    {docsExpanded ? '▼' : '▶'}
                  </span>
                )}
              </div>
              {/* Cancel button — only visible during processing */}
              {isUpdatingDocs && (
                <button
                  className="w-full bg-red-900/20 border border-red-700/20 text-red-400 p-2 text-center cursor-pointer rounded-lg text-[11px] hover:bg-red-900/40 hover:border-red-600/30 focus:outline-none"
                  onClick={handleCancelUpdateDocs}
                >
                  Отменить
                </button>
              )}
              {/* Expanded area with textarea for additional prompt */}
              {docsExpanded && !isUpdatingDocs && (
                <div className="mt-1 p-2 bg-[#1a1a1a] border border-blue-700/20 rounded-lg">
                  <textarea
                    value={additionalPrompt}
                    onChange={(e) => setAdditionalPrompt(e.target.value)}
                    placeholder="Дополнительный промпт (после файла)..."
                    className="w-full min-h-[40px] p-2 bg-[#252525] border border-[#333] rounded text-[10px] text-[#aaa] font-mono resize-none focus:outline-none focus:border-blue-500 placeholder:text-[#555]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.metaKey) {
                        e.preventDefault();
                        handleUpdateDocs('session');
                      }
                    }}
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[9px] text-[#555]">⌘+Enter для запуска</span>
                    {additionalPrompt.trim() && (
                      <button
                        onClick={() => setAdditionalPrompt('')}
                        className="text-[9px] text-red-400/60 hover:text-red-400 cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Copy Session - export Claude session */}
          <div className="mt-2">
            <div
              ref={copyContainerRef}
              data-copy-session
              className={`w-full text-[#DA7756] p-3 text-left rounded-lg text-xs flex items-center gap-2 ${
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
              {/* Settings icon — inside the orange block */}
              <div
                ref={copyIconRef}
                className={`relative w-6 h-6 flex items-center justify-center cursor-pointer rounded shrink-0 ${showCopySettings ? 'bg-white/15' : 'hover:bg-white/10'}`}
                onMouseEnter={() => setShowCopySettings(true)}
                onMouseLeave={(e) => {
                  // Keep open only if mouse went LEFT (towards the settings menu portal)
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (e.clientX >= rect.left) {
                    setShowCopySettings(false);
                  }
                }}
              >
                <span className="text-base">📋</span>
                {/* Indicators */}
                <div className="absolute -bottom-1 -right-1 flex gap-0.5 pointer-events-none">
                  {includeReading && <div className="w-1.5 h-1.5 rounded-full bg-amber-400 border border-[#1a1a1a]" title="Чтение" />}
                  {includeEditing && <div className="w-1.5 h-1.5 rounded-full bg-purple-400 border border-[#1a1a1a]" title="Редактирование" />}
                  {!fromStart && <div className="w-1.5 h-1.5 rounded-full bg-blue-500 border border-[#1a1a1a]" title="С последнего форка" />}
                </div>
              </div>

              {/* Settings Menu Portal — positioned LEFT of the block, vertically centered */}
              {showCopySettings && (() => {
                const bRect = copyContainerRef.current?.getBoundingClientRect();
                if (!bRect) return null;
                return (
                  <SettingsPortal>
                    <div
                      onMouseLeave={handleMouseLeaveSettingsArea}
                      style={{
                        position: 'fixed',
                        left: bRect.left - 3,
                        top: bRect.top + bRect.height / 2,
                        transform: 'translate(-100%, -50%)',
                        zIndex: 10000,
                        display: 'flex',
                        flexDirection: 'row',
                      }}
                    >
                      <div
                        className="bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl p-2 min-w-[150px] flex flex-col gap-2"
                        style={{ backdropFilter: 'blur(12px)', boxShadow: '0 15px 35px rgba(0,0,0,0.6)' }}
                      >
                        <div className="px-1 py-0.5 text-[9px] uppercase font-bold text-[#666] border-b border-[#333] mb-1">Настройки</div>

                        <label className="flex items-center justify-between gap-3 cursor-pointer group/label px-1">
                          <span className="text-[10px] text-[#aaa] group-hover/label:text-white">Чтение</span>
                          <div
                            className={`w-7 h-4 rounded-full relative cursor-pointer ${includeReading ? 'bg-[#DA7756]' : 'bg-[#444]'}`}
                            onClick={(e) => { e.stopPropagation(); setIncludeReading(!includeReading); }}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full ${includeReading ? 'left-[14px]' : 'left-0.5'}`} />
                          </div>
                        </label>

                        <label className="flex items-center justify-between gap-3 cursor-pointer group/label px-1">
                          <span className="text-[10px] text-[#aaa] group-hover/label:text-white">Редактирование</span>
                          <div
                            className={`w-7 h-4 rounded-full relative cursor-pointer ${includeEditing ? 'bg-[#DA7756]' : 'bg-[#444]'}`}
                            onClick={(e) => { e.stopPropagation(); setIncludeEditing(!includeEditing); }}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full ${includeEditing ? 'left-[14px]' : 'left-0.5'}`} />
                          </div>
                        </label>

                        <label className="flex items-center justify-between gap-3 cursor-pointer group/label px-1">
                          <span className="text-[10px] text-[#aaa] group-hover/label:text-white">С начала</span>
                          <div
                            className={`w-7 h-4 rounded-full relative cursor-pointer ${fromStart ? 'bg-[#DA7756]' : 'bg-[#444]'}`}
                            onClick={(e) => { e.stopPropagation(); setFromStart(!fromStart); }}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full ${fromStart ? 'left-[14px]' : 'left-0.5'}`} />
                          </div>
                        </label>
                      </div>
                    </div>
                  </SettingsPortal>
                );
              })()}

              <div className="flex-1">
                {/* Clickable title - copies current session(s) */}
                <div
                  ref={copyTitleRef}
                  className="font-medium cursor-pointer hover:text-white hover:underline inline-block"
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseEnter={() => setShowCopyInfo(true)}
                  onMouseLeave={() => setShowCopyInfo(false)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isCopying) handleCopySession();
                  }}
                  title={isMultiSelect ? `Копировать ${selectedTabs.length} сессий` : copySessionInput.trim() ? `Копировать: ${copySessionInput.trim().slice(0, 40)}...` : "Копировать текущую сессию"}
                >
                  {isMultiSelect ? `Copy ${selectedTabs.length} Sessions` : copySessionInput.trim() ? 'Copy Custom Session' : 'Copy Session'}
                </div>
                {showCopyInfo && renderInfoPanel(copyContainerRef, 'orange')}
                <div
                  className="text-[10px] text-[#DA7756]/70 mt-0.5 cursor-pointer"
                  onClick={() => !isCopying && setCopySessionExpanded(!copySessionExpanded)}
                >
                  {isCopying ? 'Копирование...' :
                    isMultiSelect ? `Экспорт ${selectedTabs.length} сессий в буфер` : copySessionInput.trim() ? `ID: ${copySessionInput.trim().slice(0, 30)}` : 'Claude JSONL → clipboard'}
                </div>
              </div>
              {!isMultiSelect && (
                <span
                  className="text-[10px] text-[#DA7756]/50 cursor-pointer hover:text-[#DA7756] px-1"
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
                <div className="mt-1.5">
                  <span className="text-[9px] text-[#555]">⌘+Enter для копирования</span>
                </div>
              </div>
            )}
          </div>
      </div>
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
