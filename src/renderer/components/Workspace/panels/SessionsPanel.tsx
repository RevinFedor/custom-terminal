import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface Session {
  id: number;
  session_key: string;
  tool_type: 'gemini' | 'claude';
  updated_at: number;
  original_cwd: string;
  locations?: string[];  // All folders where session is available
}

interface SessionsPanelProps {
  projectPath: string;
  activeTabId: string | null;
}

export default function SessionsPanel({ projectPath, activeTabId }: SessionsPanelProps) {
  const { showToast, showSessionModal } = useUIStore();
  const [geminiSessions, setGeminiSessions] = useState<Session[]>([]);
  const [claudeSessions, setClaudeSessions] = useState<Session[]>([]);
  const [selectedGemini, setSelectedGemini] = useState<Session | null>(null);
  const [selectedClaude, setSelectedClaude] = useState<Session | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<number | null>(null);

  useEffect(() => {
    loadSessions();
  }, [projectPath]);

  const loadSessions = async () => {
    try {
      // Load ALL sessions globally (not just current project)
      const result = await ipcRenderer.invoke('session:list', {
        dirPath: projectPath,
        toolType: null,
        global: true  // Get all sessions across all projects
      });

      if (result.success && result.data) {
        setGeminiSessions(result.data.filter((s: Session) => s.tool_type === 'gemini'));
        setClaudeSessions(result.data.filter((s: Session) => s.tool_type === 'claude'));
      }
    } catch (err) {
      console.error('[Sessions] Error loading:', err);
    }
  };

  const getTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const deleteSession = async (id: number) => {
    if (!confirm('Delete this session from ALL locations?')) return;

    const result = await ipcRenderer.invoke('session:delete', id);
    if (result.success) {
      showToast('Session deleted from all locations', 'success');
      setExpandedSessionId(null);
      loadSessions();
    } else {
      showToast('Failed to delete', 'error');
    }
  };

  const deleteDeployment = async (sessionId: number, sessionKey: string, deployedCwd: string) => {
    if (!confirm(`Remove session from "${deployedCwd.split('/').pop()}"?`)) return;

    const result = await ipcRenderer.invoke('session:delete-deployment', {
      sessionId,
      sessionKey,
      deployedCwd
    });

    if (result.success) {
      showToast('Removed from location', 'success');
      loadSessions();
    } else {
      showToast('Failed to remove: ' + result.message, 'error');
    }
  };

  // Gemini Export
  const exportGeminiSession = async () => {
    console.log('[SessionsPanel] ========== EXPORT GEMINI START ==========');
    console.log('[SessionsPanel] activeTabId:', activeTabId);
    console.log('[SessionsPanel] projectPath:', projectPath);

    if (!activeTabId) {
      console.log('[SessionsPanel] ❌ No activeTabId');
      showToast('Please open a terminal tab first', 'error');
      return;
    }

    // Check if something is running in terminal (Gemini is a Node.js app, so it shows as 'node')
    const activeProcess = await ipcRenderer.invoke('terminal:getActiveProcess', activeTabId);
    console.log('[SessionsPanel] Active process:', activeProcess);

    if (!activeProcess) {
      console.log('[SessionsPanel] ❌ No process running (shell is idle)');
      showToast('No process running. Start Gemini first, then export.', 'warning');
      return;
    }

    // activeProcess could be 'node', '/opt/homebrew/opt/node/bin/node', 'gemini', etc.
    console.log('[SessionsPanel] ✅ Process detected:', activeProcess);

    // Get actual cwd of the tab (Gemini uses this for checkpoint hash, not project root)
    const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
    console.log('[SessionsPanel] Tab cwd:', tabCwd);

    const sessionKey = await showSessionModal(
      'Export Gemini Session',
      'Checkpoint Name',
      'session-' + Date.now(),
      'This will run "/chat save <name>" in your terminal'
    );

    console.log('[SessionsPanel] Session key from modal:', sessionKey);

    if (!sessionKey) {
      console.log('[SessionsPanel] ❌ No sessionKey (user cancelled)');
      return;
    }

    showToast('Saving checkpoint in Gemini...', 'info');
    console.log('[SessionsPanel] Step 1: Sending /chat save command to terminal...');
    console.log('[SessionsPanel] Command:', `/chat save ${sessionKey}`);
    console.log('[SessionsPanel] TabId:', activeTabId);

    // Send command to terminal
    ipcRenderer.send('terminal:executeCommand', activeTabId, `/chat save ${sessionKey}`);

    // Step 2: Wait for confirmation in terminal output
    console.log('[SessionsPanel] Step 2: Waiting for checkpoint confirmation...');
    const confirmationPattern = `checkpoint saved with tag: ${sessionKey}`;

    const waitForConfirmation = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[SessionsPanel] ⏱️ Timeout waiting for confirmation');
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(false);
      }, 10000); // 10 second timeout

      const handler = (_event: any, { tabId: dataTabId, data }: { tabId: string; data: string }) => {
        if (dataTabId === activeTabId && data.toLowerCase().includes(confirmationPattern.toLowerCase())) {
          console.log('[SessionsPanel] ✅ Confirmation detected in terminal output!');
          clearTimeout(timeout);
          ipcRenderer.removeListener('terminal:data', handler);
          resolve(true);
        }
      };

      ipcRenderer.on('terminal:data', handler);
    });

    const confirmed = await waitForConfirmation;

    if (!confirmed) {
      console.log('[SessionsPanel] ⚠️ No confirmation received, proceeding anyway...');
    }

    // Small delay after confirmation for file to be written
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('[SessionsPanel] Step 3: Calling session:export-gemini IPC...');
    // Use tabCwd for finding checkpoint (Gemini hash), but projectPath for DB organization
    const result = await ipcRenderer.invoke('session:export-gemini', {
      dirPath: tabCwd || projectPath,  // Where Gemini saved the checkpoint
      projectPath,                      // For DB organization
      sessionKey
    });

    console.log('[SessionsPanel] Step 4: Export result:', result);

    if (result.success) {
      showToast(result.message, 'success');
      loadSessions();
      console.log('[SessionsPanel] ✅ Export successful!');
    } else {
      showToast('Export failed: ' + result.message, 'error');
      console.log('[SessionsPanel] ❌ Export failed:', result.message);
    }

    console.log('[SessionsPanel] ========== EXPORT GEMINI END ==========');
  };

  // Strip ANSI escape codes from text
  const stripAnsi = (text: string): string => {
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '');
  };

  // METHOD 1: Wait for HIDE CURSOR (Gemini hides cursor when ready for input)
  const waitForHideCursor = (maxWaitMs: number): Promise<boolean> => {
    const startTime = Date.now();
    let hideCount = 0;

    console.log(`[CURSOR] ========== WAITING FOR HIDE CURSOR (max ${maxWaitMs}ms) ==========`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[CURSOR] ⏱️ TIMEOUT - HIDE=${hideCount}`);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(false);
      }, maxWaitMs);

      const handler = (_event: any, { tabId: dataTabId, data }: { tabId: string; data: string }) => {
        if (dataTabId !== activeTabId) return;

        if (data.includes('\x1b[?25l')) {
          hideCount++;
          console.log(`[CURSOR] ✅ HIDE #${hideCount} at ${Date.now() - startTime}ms`);
          clearTimeout(timeout);
          ipcRenderer.removeListener('terminal:data', handler);
          resolve(true);
        }
      };

      ipcRenderer.on('terminal:data', handler);
    });
  };

  // DIAGNOSTIC: Wait for silence in terminal output
  const waitForSilence = (silenceMs: number, maxWaitMs: number): Promise<boolean> => {
    const startTime = Date.now();
    let lastDataTime = Date.now();
    let chunkCount = 0;
    let silenceTimer: NodeJS.Timeout | null = null;

    console.log(`[SILENCE] ========== WAITING FOR ${silenceMs}ms SILENCE (max ${maxWaitMs}ms) ==========`);

    return new Promise((resolve) => {
      const maxTimeout = setTimeout(() => {
        console.log(`[SILENCE] ⏱️ MAX TIMEOUT after ${maxWaitMs}ms, chunks: ${chunkCount}`);
        if (silenceTimer) clearTimeout(silenceTimer);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(false);
      }, maxWaitMs);

      const checkSilence = () => {
        const silenceDuration = Date.now() - lastDataTime;
        console.log(`[SILENCE] ✅ SILENCE ACHIEVED: ${silenceDuration}ms at ${Date.now() - startTime}ms total`);
        clearTimeout(maxTimeout);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(true);
      };

      const handler = (_event: any, { tabId: dataTabId, data }: { tabId: string; data: string }) => {
        if (dataTabId !== activeTabId) return;

        chunkCount++;
        const now = Date.now();
        const gap = now - lastDataTime;
        lastDataTime = now;

        // Log significant gaps
        if (gap > 200) {
          console.log(`[SILENCE] 🔇 Gap ${gap}ms before chunk #${chunkCount} at ${now - startTime}ms`);
        }

        // Reset silence timer
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(checkSilence, silenceMs);
      };

      ipcRenderer.on('terminal:data', handler);

      // Start initial silence timer (in case no data comes at all)
      silenceTimer = setTimeout(checkSilence, silenceMs);
    });
  };

  // DIAGNOSTIC: Log terminal data stream to analyze patterns
  const waitForTerminalPattern = (pattern: string, timeoutMs: number = 15000): Promise<boolean> => {
    const startTime = Date.now();
    let buffer = '';
    let lastDataTime = Date.now();
    let chunkCount = 0;
    let showCursorCount = 0;  // Track \x1b[?25h occurrences
    let hideCursorCount = 0;  // Track \x1b[?25l occurrences

    console.log(`[DIAG] ========== WAITING FOR: "${pattern}" ==========`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const silenceDuration = Date.now() - lastDataTime;
        console.log(`[DIAG] ⏱️ TIMEOUT after ${timeoutMs}ms`);
        console.log(`[DIAG] 📊 Stats: ${chunkCount} chunks, last data ${silenceDuration}ms ago`);
        console.log(`[DIAG] 🖱️ Cursor: SHOW=${showCursorCount}, HIDE=${hideCursorCount}`);
        console.log(`[DIAG] 📋 Buffer (clean): "${stripAnsi(buffer).substring(0, 800)}"`);
        ipcRenderer.removeListener('terminal:data', handler);
        resolve(false);
      }, timeoutMs);

      const handler = (_event: any, { tabId: dataTabId, data }: { tabId: string; data: string }) => {
        if (dataTabId !== activeTabId) return;

        chunkCount++;
        const now = Date.now();
        const silenceBefore = now - lastDataTime;
        lastDataTime = now;

        // Check for cursor ANSI codes
        if (data.includes('\x1b[?25h')) {
          showCursorCount++;
          console.log(`[DIAG] 🖱️ SHOW CURSOR detected at ${now - startTime}ms (after ${silenceBefore}ms silence)`);
        }
        if (data.includes('\x1b[?25l')) {
          hideCursorCount++;
          console.log(`[DIAG] 🖱️ HIDE CURSOR detected at ${now - startTime}ms`);
        }

        // Log silence gaps > 100ms
        if (silenceBefore > 100) {
          console.log(`[DIAG] 🔇 SILENCE GAP: ${silenceBefore}ms before chunk #${chunkCount}`);
        }

        buffer += data;
        const cleanBuffer = stripAnsi(buffer);
        const hasPattern = cleanBuffer.toLowerCase().includes(pattern.toLowerCase());

        if (hasPattern) {
          console.log(`[DIAG] ✅ PATTERN FOUND at ${now - startTime}ms: "${pattern}"`);
          console.log(`[DIAG] 📊 Stats at match: ${chunkCount} chunks, cursor SHOW=${showCursorCount}`);
          clearTimeout(timeout);
          ipcRenderer.removeListener('terminal:data', handler);
          resolve(true);
        }
      };

      ipcRenderer.on('terminal:data', handler);
    });
  };

  // Gemini Import using Trojan Horse method
  const importGeminiSession = async () => {
    console.log('[SessionsPanel] ========== IMPORT GEMINI (TROJAN HORSE) START ==========');
    console.log('[SessionsPanel] activeTabId:', activeTabId);
    console.log('[SessionsPanel] selectedGemini:', selectedGemini);

    if (!activeTabId) {
      showToast('Please create a tab first', 'error');
      return;
    }

    if (!selectedGemini) {
      showToast('Please select a session from the list', 'error');
      return;
    }

    // Get actual cwd of the tab
    const tabCwd = await ipcRenderer.invoke('terminal:getCwd', activeTabId);
    console.log('[SessionsPanel] Tab cwd:', tabCwd);

    // Phase 1: Get patch data from backend
    showToast('Preparing session restore...', 'info');
    const result = await ipcRenderer.invoke('session:import-gemini', {
      dirPath: tabCwd || projectPath,
      sessionKey: selectedGemini.session_key,
      tabId: activeTabId,
      sessionId: selectedGemini.id
    });

    if (!result.success) {
      showToast('Import failed: ' + result.message, 'error');
      return;
    }

    if (!result.trojanHorse || !result.patchData) {
      showToast('Invalid response from backend', 'error');
      return;
    }

    const { patchData } = result;
    const sessionKey = patchData.sessionKey;

    // Check if Gemini is already running
    const activeProcess = await ipcRenderer.invoke('terminal:getActiveProcess', activeTabId);
    console.log('[SessionsPanel] Active process:', activeProcess);

    const importStartTime = Date.now();
    const logPhase = (phase: string) => console.log(`[Import] 🔷 ${phase} at ${Date.now() - importStartTime}ms`);

    // Phase 2: Start Gemini if not running
    if (!activeProcess || !activeProcess.includes('node')) {
      logPhase('PHASE 2: Starting Gemini');
      showToast('Starting Gemini CLI...', 'info');

      logPhase('PHASE 2: Calling executeCommandAsync("gemini")');
      await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, 'gemini');
      logPhase('PHASE 2: executeCommandAsync returned');

      logPhase('PHASE 2: Starting waitForTerminalPattern("type your message")');
      const geminiReady = await waitForTerminalPattern('type your message', 15000);
      logPhase(`PHASE 2: waitForTerminalPattern returned: ${geminiReady}`);

      if (!geminiReady) {
        showToast('Timeout waiting for Gemini. Please try manually.', 'warning');
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Phase 3: Send dummy message to create session
    logPhase('PHASE 3: Sending dummy message "hi"');
    showToast('Creating checkpoint shell...', 'info');
    await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, 'hi');
    logPhase('PHASE 3: executeCommandAsync returned');

    // Wait for Gemini to finish responding - using HIDE cursor detection
    // METHOD 1: waitForHideCursor - instant, no timeout delay
    // METHOD 2: waitForSilence(1500, 30000) - waits for 1.5s silence
    logPhase('PHASE 3: Starting waitForHideCursor');
    await waitForHideCursor(30000);
    logPhase('PHASE 3: waitForHideCursor returned');

    // Phase 4: /chat save - setup listener BEFORE sending command
    logPhase(`PHASE 4: Setting up listener then sending "/chat save ${sessionKey}"`);

    // Start listening BEFORE sending command to not miss data
    const savePromise = waitForTerminalPattern('checkpoint saved', 10000);

    // Small delay to ensure listener is registered
    await new Promise(r => setTimeout(r, 50));

    // Now send command
    await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, `/chat save ${sessionKey}`);
    logPhase('PHASE 4: Command sent, waiting for pattern...');

    const saved = await savePromise;
    logPhase(`PHASE 4: waitForTerminalPattern returned: ${saved}`);

    if (!saved) {
      showToast('Failed to create checkpoint. Please try manually.', 'warning');
      return;
    }
    await new Promise(r => setTimeout(r, 300));

    // Phase 5: Patch the checkpoint file with our content
    showToast('Patching checkpoint...', 'info');
    console.log('[SessionsPanel] Patching checkpoint file...');
    const patchResult = await ipcRenderer.invoke('session:patch-checkpoint', {
      targetCwd: patchData.targetCwd,
      sessionKey: sessionKey,
      patchedContent: patchData.patchedContent
    });

    if (!patchResult.success) {
      showToast('Failed to patch: ' + patchResult.message, 'error');
      return;
    }

    // Phase 5.5: Exit dummy Gemini session
    logPhase('PHASE 5.5: Exiting dummy Gemini session');
    showToast('Exiting dummy session...', 'info');
    await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, '/exit');

    // Wait for shell prompt (Gemini to fully exit)
    logPhase('PHASE 5.5: Waiting for shell prompt');
    await waitForTerminalPattern('$', 5000); // or '%' for zsh
    await new Promise(r => setTimeout(r, 300));

    // Phase 6: Start fresh Gemini and resume our patched session
    logPhase('PHASE 6: Starting fresh Gemini');
    showToast('Starting Gemini with restored session...', 'info');
    await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, 'gemini');

    // Wait for Gemini ready
    const geminiReady = await waitForTerminalPattern('type your message', 15000);
    if (!geminiReady) {
      showToast('Timeout waiting for Gemini restart', 'warning');
      return;
    }
    await new Promise(r => setTimeout(r, 500));

    // Now resume the patched session
    logPhase('PHASE 6: Sending /chat resume');
    await ipcRenderer.invoke('terminal:executeCommandAsync', activeTabId, `/chat resume ${sessionKey}`);

    // Reload sessions to show updated locations
    loadSessions();

    showToast('Session restored!', 'success');
    console.log('[SessionsPanel] ========== IMPORT GEMINI (TROJAN HORSE) END ==========');
  };

  // Claude Export
  const exportClaudeSession = async () => {
    const sessionKey = await showSessionModal(
      'Export Claude Session',
      'Session UUID (optional)',
      '',
      'Leave empty to auto-detect latest session'
    );

    const result = await ipcRenderer.invoke('session:export-claude', {
      dirPath: projectPath,
      sessionKey: sessionKey || ''
    });

    if (result.success) {
      showToast(result.message, 'success');
      loadSessions();
    } else {
      showToast('Export failed: ' + result.message, 'error');
    }
  };

  // Claude Import
  const importClaudeSession = async () => {
    if (!selectedClaude) {
      showToast('Please select a session from the list', 'error');
      return;
    }

    const result = await ipcRenderer.invoke('session:import-claude', {
      dirPath: projectPath,
      sessionKey: selectedClaude
    });

    if (result.success) {
      showToast(result.message, 'success');
      if (result.commands?.[0]) {
        showToast(`Run: ${result.commands[0]}`, 'info');
      }
    } else {
      showToast('Import failed: ' + result.message, 'error');
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] shrink-0">
        Session Persistence
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* Gemini Section */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#4da6ff]">
              Gemini <span className="text-[10px] text-[#666]">({geminiSessions.length})</span>
            </span>
            <div className="flex gap-1">
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={exportGeminiSession}
              >
                Export
              </button>
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={importGeminiSession}
              >
                Import
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {geminiSessions.length === 0 ? (
              <div className="text-[10px] text-[#555] italic">No saved sessions</div>
            ) : (
              geminiSessions.map((session) => {
                const isExpanded = expandedSessionId === session.id;
                const locations = session.locations || [session.original_cwd];

                return (
                  <div key={session.id} className="flex flex-col">
                    {/* Session header */}
                    <div
                      className={`flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded-t cursor-pointer border transition-colors ${
                        selectedGemini?.id === session.id
                          ? 'border-accent'
                          : 'border-transparent hover:border-[#444]'
                      } ${isExpanded ? 'rounded-b-none' : 'rounded-b'}`}
                      onClick={() => setSelectedGemini(session)}
                    >
                      {/* Expand/collapse arrow */}
                      <button
                        className="text-[10px] text-[#666] hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedSessionId(isExpanded ? null : session.id);
                        }}
                      >
                        {isExpanded ? '▼' : '▶'}
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-white truncate">{session.session_key}</div>
                        <div className="text-[10px] text-[#666] flex gap-2">
                          <span>{getTimeAgo(session.updated_at)}</span>
                          <span className="text-[#555]">📁 {locations.length} location{locations.length > 1 ? 's' : ''}</span>
                        </div>
                      </div>

                      {/* Delete all button */}
                      <button
                        className="text-[#888] hover:text-red-500 text-xs"
                        onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                        title="Delete from all locations"
                      >
                        🗑️
                      </button>
                    </div>

                    {/* Expanded locations list */}
                    {isExpanded && (
                      <div className="bg-[#252525] border border-t-0 border-[#444] rounded-b p-2 space-y-1">
                        {locations.map((loc, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between text-[10px] text-[#888] hover:text-white px-2 py-1 hover:bg-[#333] rounded"
                          >
                            <span className="truncate flex-1" title={loc}>
                              📁 {loc?.split('/').pop() || '?'}
                            </span>
                            <button
                              className="text-[#666] hover:text-red-500 ml-2"
                              onClick={() => deleteDeployment(session.id, session.session_key, loc)}
                              title={`Remove from ${loc}`}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Claude Section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#ff9f43]">
              Claude <span className="text-[10px] text-[#666]">({claudeSessions.length})</span>
            </span>
            <div className="flex gap-1">
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={exportClaudeSession}
              >
                Export
              </button>
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={importClaudeSession}
              >
                Import
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {claudeSessions.length === 0 ? (
              <div className="text-[10px] text-[#555] italic">No saved sessions</div>
            ) : (
              claudeSessions.map((session) => (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded cursor-pointer border transition-colors ${
                    selectedClaude === session.session_key
                      ? 'border-accent'
                      : 'border-transparent hover:border-[#444]'
                  }`}
                  onClick={() => setSelectedClaude(session.session_key)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{session.session_key}</div>
                    <div className="text-[10px] text-[#666]">{getTimeAgo(session.updated_at)}</div>
                  </div>
                  <button
                    className="text-[#888] hover:text-red-500 text-xs"
                    onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
