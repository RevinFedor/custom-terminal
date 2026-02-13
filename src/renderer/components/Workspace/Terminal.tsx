import React, { useEffect, useRef, useState, memo, useCallback } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';

const { shell } = window.require('electron');

// Helper: open URL in browser or file in preview
const handleLinkActivation = (event: MouseEvent, uri: string) => {
  // Only activate on Cmd+click (metaKey on macOS)
  if (!event.metaKey) {
    return;
  }

  console.log('[Link] Cmd+click on:', uri);

  // Check if it's a localhost URL - open in browser
  if (uri.match(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i)) {
    console.log('[Link] Opening localhost URL in browser:', uri);
    shell.openExternal(uri);
    return;
  }

  // Check if it's any other URL - open in browser
  if (uri.match(/^https?:\/\//i)) {
    console.log('[Link] Opening URL in browser:', uri);
    shell.openExternal(uri);
    return;
  }

  // If it looks like a file path, try to open in preview
  // This handles paths like /Users/fedor/file.ts or ./src/file.ts
  if (uri.startsWith('/') || uri.startsWith('./') || uri.startsWith('../')) {
    console.log('[Link] Opening file in preview:', uri);
    // Use ipcRenderer to open file preview
    ipcRenderer.invoke('file:read', uri).then((result: any) => {
      if (result.success) {
        const ext = uri.split('.').pop()?.toLowerCase() || '';
        const languageMap: Record<string, string> = {
          'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
          'json': 'json', 'md': 'markdown', 'css': 'css', 'html': 'html',
          'py': 'python', 'go': 'go', 'rs': 'rust', 'sh': 'bash', 'yaml': 'yaml', 'yml': 'yaml'
        };
        useUIStore.getState().openFilePreview({
          path: uri,
          content: result.content,
          language: languageMap[ext] || null
        });
      }
    }).catch((err: any) => {
      console.error('[Link] Failed to read file:', err);
    });
  }
};
import { SerializeAddon } from '@xterm/addon-serialize';
import { SearchAddon } from '@xterm/addon-search';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, type PendingAction } from '../../store/useWorkspaceStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { log } from '../../utils/logger';

// Get buffer management functions outside of component to avoid re-renders
const getBufferActions = () => ({
  save: useWorkspaceStore.getState().saveTerminalBuffer,
  get: useWorkspaceStore.getState().getTerminalBuffer,
  clear: useWorkspaceStore.getState().clearTerminalBuffer
});

// Get setTerminalSelection outside of component to avoid re-renders
const getSetTerminalSelection = () => useUIStore.getState().setTerminalSelection;

// Get Claude session setter/getter outside of component
const getSetClaudeSessionId = () => useWorkspaceStore.getState().setClaudeSessionId;
const getClaudeSessionId = (tabId: string) => useWorkspaceStore.getState().getClaudeSessionId(tabId);

// Get Gemini session setter/getter outside of component
const getSetGeminiSessionId = () => useWorkspaceStore.getState().setGeminiSessionId;
const getGeminiSessionId = (tabId: string) => useWorkspaceStore.getState().getGeminiSessionId(tabId);

// Get setTabCommandType for auto-color and restart button visibility
const getSetTabCommandType = () => useWorkspaceStore.getState().setTabCommandType;

// Get updateTabCwd for OSC 7 handler (shell reports cwd changes)
const getUpdateTabCwd = () => {
  return (tabId: string, newCwd: string) => {
    const state = useWorkspaceStore.getState();
    for (const [projectId, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) {
        state.updateTabCwd(projectId, tabId, newCwd);
        return;
      }
    }
  };
};

// Get pending action for a tab (used for fork, continue, etc.)
const getTabPendingAction = (tabId: string): PendingAction | undefined => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      console.log('[RESTORE] 10. getTabPendingAction:', { tabId, pendingAction: tab.pendingAction });
      return tab.pendingAction;
    }
  }
  console.log('[RESTORE] 10. getTabPendingAction: TAB NOT FOUND in any workspace, tabId:', tabId);
  return undefined;
};

// Clear pending action after execution
const clearTabPendingAction = (tabId: string) => {
  const state = useWorkspaceStore.getState();
  for (const [projectId, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab && tab.pendingAction) {
      console.log('[RESTORE] 13. clearTabPendingAction:', { tabId, pendingAction: tab.pendingAction });
      tab.pendingAction = undefined;
      state.openProjects.set(projectId, { ...workspace });
      useWorkspaceStore.setState({ openProjects: new Map(state.openProjects) });
      return;
    }
  }
};

// Get tab cwd for fork commands
const getTabCwd = (tabId: string): string | undefined => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      return tab.cwd;
    }
  }
  return undefined;
};

// Execute pending action after terminal is ready
const executePendingAction = (tabId: string, pendingAction: PendingAction) => {
  console.log('[RESTORE] 11. executePendingAction:', { tabId, type: pendingAction.type, sessionId: (pendingAction as any).sessionId });

  switch (pendingAction.type) {
    case 'claude-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'claude');
        console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude-f", forkSessionId:', pendingAction.sessionId, '}');
        ipcRenderer.send('claude:run-command', {
          tabId,
          command: 'claude-f',
          forkSessionId: pendingAction.sessionId
        });
      }
      break;

    case 'claude-continue':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'claude');
        console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude-c", sessionId:', pendingAction.sessionId, '}');
        ipcRenderer.send('claude:run-command', {
          tabId,
          command: 'claude-c',
          sessionId: pendingAction.sessionId
        });
      }
      break;

    case 'claude-new': {
      getSetTabCommandType()(tabId, 'claude');
      console.log('[RESTORE] 12. Sending IPC claude:run-command { command: "claude", tabId:', tabId, '}');
      ipcRenderer.send('claude:run-command', { tabId, command: 'claude' });
      break;
    }

    case 'gemini-fork':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'gemini');
        const cwd = getTabCwd(tabId);
        console.log('[RESTORE] 12. Sending IPC gemini:run-command { command: "gemini-f" }');
        ipcRenderer.send('gemini:run-command', {
          tabId,
          command: 'gemini-f',
          sessionId: pendingAction.sessionId,
          cwd
        });
      }
      break;

    case 'gemini-continue':
      if (pendingAction.sessionId) {
        getSetTabCommandType()(tabId, 'gemini');
        getSetGeminiSessionId()(tabId, pendingAction.sessionId);
        console.log('[RESTORE] 12. Sending IPC gemini:run-command { command: "gemini-c" }');
        ipcRenderer.send('gemini:run-command', {
          tabId,
          command: 'gemini-c',
          sessionId: pendingAction.sessionId
        });
      }
      break;

    case 'gemini-new': {
      getSetTabCommandType()(tabId, 'gemini');
      const geminiCwd = getTabCwd(tabId);
      console.log('[RESTORE] 12. Sending IPC gemini:spawn-with-watcher { cwd:', geminiCwd, '}');
      ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: geminiCwd });
      break;
    }

    case 'shell-command':
      console.log('[RESTORE] 12. shell-command — handled via initialCommand, nothing to do');
      break;
  }

  clearTabPendingAction(tabId);
};

// Regex to detect Claude session ID from terminal output
// Matches only "Session ID: <uuid>" - the most reliable and final pattern
const CLAUDE_SESSION_REGEX = /Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Debounce for session detection (saves only the last detected ID after 300ms)
let sessionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Helper: Get current command from xterm buffer (handles wrapped lines)
// When a long command wraps to multiple visual lines, we need to walk up
// and concatenate all wrapped line segments
// NOTE: When Enter is pressed, cursor already moved to next line, so we start from cursorY - 1
function getCurrentCommand(term: XTerminal): string {
  const buffer = term.buffer.active;
  let cursorY = buffer.cursorY;

  // When Enter is pressed, cursor is already on the NEW line (empty)
  // We need to look at the previous line where the command was typed
  if (cursorY > 0) {
    const currentLine = buffer.getLine(cursorY);
    if (currentLine && currentLine.translateToString(true).trim() === '') {
      cursorY--; // Go back to the command line
    }
  }

  let currentLineObj = buffer.getLine(cursorY);
  if (!currentLineObj) return '';

  // Collect line segments (walk up while lines are wrapped)
  let logicalLine = currentLineObj.translateToString(true);

  // While current line is marked as wrapped, the command starts above
  while (currentLineObj.isWrapped && cursorY > 0) {
    cursorY--;
    currentLineObj = buffer.getLine(cursorY);
    if (currentLineObj) {
      // Prepend the upper part of the command
      logicalLine = currentLineObj.translateToString(true) + logicalLine;
    }
  }

  return logicalLine;
}

const { ipcRenderer } = window.require('electron');

// Write buffer constants to prevent Ink/TUI render tearing
const FLUSH_DELAY = 10; // ms - aligns with 60fps
const MAX_BUFFER_SIZE = 4096; // safety valve

interface TerminalProps {
  tabId: string;
  cwd: string;
  active: boolean;
  isActiveProject?: boolean; // For lazy init optimization
}

function Terminal({ tabId, cwd, active, isActiveProject = true }: TerminalProps) {
  // Removed: excessive render log

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const isInitialized = useRef(false);
  const isMounted = useRef(true);
  const isReadyRef = useRef(false); // Track if first fit completed
  const hasBeenActive = useRef(false); // Track if tab was ever active (for lazy init)
  const isCreatingRef = useRef(false); // Lock to prevent double initialization
  const activeRef = useRef(active); // Track current active state for ResizeObserver closure
  const pendingBuffer = useRef<string>(''); // Buffer PTY data before xterm init
  const [isVisible, setIsVisible] = useState(false); // Hide until ready
  const [showScrollButton, setShowScrollButton] = useState(false); // Show "scroll to bottom" button
  const savedScrollPosition = useRef<number | null>(null); // Save scroll position when tab becomes inactive
  const wasAtBottom = useRef<boolean>(true); // Track if terminal was at bottom when deactivated
  const claudeSessionDetected = useRef<string | null>(null); // Track detected Claude session UUID
  const pendingActionExecuted = useRef(false); // Track if pendingAction was executed

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const workspaceView = useWorkspaceStore((state) => state.view);

  // Per-project currentView: find which project owns this tab and read its currentView
  const projectCurrentView = useWorkspaceStore((state) => {
    for (const [, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) {
        return workspace.currentView || 'terminal';
      }
    }
    return 'terminal';
  });

  // Effective active = tab is active AND we're in terminal view AND workspace is visible (not Dashboard)
  // This prevents focus/fit/repaint when terminals are hidden behind Dashboard or ProjectHome
  const effectiveActive = active && projectCurrentView === 'terminal' && workspaceView === 'workspace';

  // Keep activeRef in sync for ResizeObserver closure
  useEffect(() => {
    activeRef.current = effectiveActive;
  }, [effectiveActive]);

  // Check if terminal is scrolled up (not at bottom)
  const checkScrollPosition = useCallback(() => {
    const term = xtermInstance.current;
    if (!term) return;

    const buffer = term.buffer.active;
    const isAtBottom = buffer.viewportY >= buffer.baseY;
    setShowScrollButton(!isAtBottom);

    // Sync viewport position with registry for Timeline
    terminalRegistry.updateViewport(
      tabId,
      buffer.viewportY,
      buffer.viewportY + term.rows,
      buffer.baseY + term.rows
    );
  }, [tabId]);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    const term = xtermInstance.current;
    if (!term) return;
    term.scrollToBottom();
    setShowScrollButton(false);
  }, []);

  // Attach scroll listeners - called AFTER term.open() when DOM is guaranteed to exist
  const attachScrollListeners = useCallback((term: XTerminal, container: HTMLDivElement) => {
    // 1. Native scroll (mouse wheel, trackpad, scrollbar drag)
    const viewport = container.querySelector('.xterm-viewport');
    if (viewport) {
      viewport.addEventListener('scroll', checkScrollPosition);
    }

    // 2. Xterm scroll (programmatic scroll, buffer changes)
    term.onScroll(checkScrollPosition);

    // 3. When data is written (terminal auto-scrolls down on output)
    term.onWriteParsed(checkScrollPosition);
  }, [checkScrollPosition]);

  // Write buffer refs to batch PTY output and prevent jitter
  const writeBufferRef = useRef<string>('');
  const pendingWriteRef = useRef<NodeJS.Timeout | null>(null);

  const safeFit = () => {
    if (!isMounted.current) return;
    try {
      const term = xtermInstance.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      if ((term as any)._isDisposed) return;
      if (!term.element) return;
      if (!term.options || term.cols === 0 || term.rows === 0) return;

      const colsBefore = term.cols;
      const rowsBefore = term.rows;

      fit.fit();

      const dims = fit.proposeDimensions();
      if (dims) {
        ipcRenderer.send('terminal:resize', tabId, dims.cols, dims.rows);
      }

      const colsAfter = term.cols;
      const rowsAfter = term.rows;
      if (colsBefore !== colsAfter || rowsBefore !== rowsAfter) {
        console.warn(`[safeFit] tabId=${tabId} RESIZED ${colsBefore}x${rowsBefore} → ${colsAfter}x${rowsAfter}, sent to PTY: ${dims?.cols}x${dims?.rows}`);
      }
    } catch (e) {
      console.warn('[safeFit] ERROR:', e);
    }
  };

  useEffect(() => {
    if (isInitialized.current || !terminalRef.current) {
      return;
    }
    isInitialized.current = true;
    console.warn(`[Terminal:MOUNT] tabId=${tabId} active=${active} isActiveProject=${isActiveProject}`);

    const containerRef = terminalRef.current;

    // IPC: Receive data from PTY (with write buffer to prevent jitter)
    const handleData = (_: any, payload: { tabId: string; data: string }) => {
      if (payload.tabId !== tabId) return;

      // Execute pendingAction on first PTY output (= shell is ready)
      if (!pendingActionExecuted.current) {
        pendingActionExecuted.current = true;
        const pendingAction = getTabPendingAction(tabId);
        if (pendingAction) {
          console.log('[Terminal:handleData] First PTY output, executing pendingAction');
          executePendingAction(tabId, pendingAction);
        }
      }

      // If xterm not yet created, buffer data for later replay
      if (!xtermInstance.current) {
        pendingBuffer.current += payload.data;
        // Limit buffer size to prevent memory issues
        if (pendingBuffer.current.length > 100000) {
          pendingBuffer.current = pendingBuffer.current.slice(-50000);
        }
        return;
      }

      // Accumulate data in buffer
      writeBufferRef.current += payload.data;

      // Schedule flush if not already pending
      if (!pendingWriteRef.current) {
        pendingWriteRef.current = setTimeout(() => {
          if (xtermInstance.current && writeBufferRef.current) {
            xtermInstance.current.write(writeBufferRef.current);
            writeBufferRef.current = '';
          }
          pendingWriteRef.current = null;
        }, FLUSH_DELAY);
      }

      // Flush immediately if buffer too large (safety valve)
      if (writeBufferRef.current.length > MAX_BUFFER_SIZE) {
        if (pendingWriteRef.current) {
          clearTimeout(pendingWriteRef.current);
          pendingWriteRef.current = null;
        }
        if (xtermInstance.current) {
          xtermInstance.current.write(writeBufferRef.current);
          writeBufferRef.current = '';
        }
      }
    };

    const handleExit = (_: any, exitedTabId: string) => {
      if (exitedTabId === tabId && xtermInstance.current) {
        xtermInstance.current.write('\r\n\r\n[Process completed]');
      }
    };

    // Session Bridge: receive session ID from StatusLine bridge watcher
    const handleSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      const currentId = getClaudeSessionId(tabId);
      if (currentId !== data.sessionId) {
        console.log('[Terminal] Bridge session:', data.sessionId.substring(0, 8) + '...', currentId ? '(was: ' + currentId.substring(0, 8) + '...)' : '(new)');
      }
      getSetClaudeSessionId()(tabId, data.sessionId);
    };

    // Toast when /status reveals Session ID (visual confirmation)
    const handleStatusSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      const currentId = getClaudeSessionId(tabId);
      const short = data.sessionId.substring(0, 8);
      if (!currentId) {
        getSetClaudeSessionId()(tabId, data.sessionId);
        useUIStore.getState().showToast('Session: ' + short + '...', 'success', 1000);
      } else if (currentId !== data.sessionId) {
        useUIStore.getState().showToast('/status: ' + short + '... \u2260 stored: ' + currentId.substring(0, 8) + '...', 'warning', 2000);
      } else {
        useUIStore.getState().showToast('Session: ' + short + '...', 'success', 1000);
      }
    };

    // Gemini Sniper Watcher: receive session ID when Gemini creates it
    const handleGeminiSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      console.log('[Terminal] Sniper caught Gemini session:', data.sessionId);
      getSetGeminiSessionId()(tabId, data.sessionId);
    };

    // Register IPC listeners synchronously
    ipcRenderer.on('terminal:data', handleData);
    ipcRenderer.on('terminal:exit', handleExit);
    ipcRenderer.on('claude:session-detected', handleSessionDetected);
    ipcRenderer.on('claude:status-session-detected', handleStatusSessionDetected);
    ipcRenderer.on('gemini:session-detected', handleGeminiSessionDetected);

    // Resize observer with Guard Clause (prevents WebGL accordion effect)
    const resizeObserver = new ResizeObserver((entries) => {
      // Guard: If container is hidden (0x0), DON'T let xterm reset to 12x6
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }

      // Only fit if active (use ref to get current value, not stale closure)
      if (activeRef.current) {
        window.requestAnimationFrame(() => {
          safeFit();
        });
      }
    });
    resizeObserver.observe(containerRef);

    // Async terminal initialization (waits for fonts)
    const initTerminal = async () => {
      // Wait for fonts to load before creating terminal (prevents metric issues)
      await document.fonts.ready;

      // Double-check our specific font is loaded
      const fontFamily = "'JetBrains Mono', 'JetBrainsMono NF'";
      if (!document.fonts.check(`13px ${fontFamily}`)) {
        try {
          await document.fonts.load(`13px ${fontFamily}`);
        } catch (e) {
          // Font may not be available, proceed with fallback
        }
      }

      if (!isMounted.current || !containerRef) return;

      // Get current fontSize from store
      const currentFontSize = useUIStore.getState().terminalFontSize;

      const term = new XTerminal({
        theme: {
          background: '#1a1a1a',
          foreground: '#d4d4d4',
          cursor: '#ffffff',
          cursorAccent: '#1a1a1a',
          selectionBackground: '#264f78',
          black: '#000000',
          red: '#cd3131',
          green: '#0dbc79',
          yellow: '#e5e510',
          blue: '#2472c8',
          magenta: '#bc3fbc',
          cyan: '#11a8cd',
          white: '#e5e5e5',
          brightBlack: '#666666',
          brightRed: '#f14c4c',
          brightGreen: '#23d18b',
          brightYellow: '#f5f543',
          brightBlue: '#3b8eea',
          brightMagenta: '#d670d6',
          brightCyan: '#29b8db',
          brightWhite: '#e5e5e5'
        },
        fontFamily: "'JetBrains Mono', 'JetBrainsMono NF', Menlo, Monaco, monospace",
        fontSize: currentFontSize,
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        drawBoldTextInBrightColors: false, // Prevents bright colors from being bold
        cursorBlink: true,
        cursorStyle: 'block',
        allowTransparency: false,
        allowProposedApi: true, // Required for SearchAddon
        scrollback: 10000
      });

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      const searchAddon = new SearchAddon();
      fitAddonRef.current = fitAddon;
      serializeAddonRef.current = serializeAddon;
      searchAddonRef.current = searchAddon;

      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon(handleLinkActivation));

      term.open(containerRef);

      // OSC 7 handler - shell reports current working directory
      // Format: file://hostname/path or just /path
      term.parser.registerOscHandler(7, (data: string) => {
        try {
          let newCwd: string;
          if (data.startsWith('file://')) {
            const url = new URL(data);
            newCwd = decodeURIComponent(url.pathname);
          } else {
            newCwd = data;
          }
          if (newCwd && newCwd.startsWith('/')) {
            console.log('[Terminal] OSC 7 cwd update:', newCwd);
            getUpdateTabCwd()(tabId, newCwd);
          }
        } catch (e) {
          console.error('[Terminal] OSC 7 parse error:', e);
        }
        return true;
      });

      // OSC 7777 handler - entry marker registration (future: main process sends before user prompt)
      // Format: entry:<uuid>
      term.parser.registerOscHandler(7777, (data: string) => {
        if (data.startsWith('entry:')) {
          const uuid = data.slice(6);
          console.log('[Terminal] OSC 7777 entry marker:', uuid);
          terminalRegistry.registerEntryMarker(tabId, uuid);
        }
        return true;
      });

      xtermInstance.current = term;
      hasBeenActive.current = true; // Mark as active AFTER xterm is created to prevent race condition

      // Attach scroll listeners (native + xterm events)
      attachScrollListeners(term, containerRef);

      // Register terminal in global registry for selection access and search
      terminalRegistry.register(tabId, term, searchAddon);

      // Restore previously serialized buffer (from before unmount)
      const savedBuffer = getBufferActions().get(tabId);
      if (savedBuffer) {
        term.write(savedBuffer);
        getBufferActions().clear(tabId); // Clear after restoration
      }

      // Replay buffered PTY data that arrived before xterm was ready
      if (pendingBuffer.current) {
        term.write(pendingBuffer.current);
        pendingBuffer.current = '';
      }

      // Fit after opening, then reveal terminal
      setTimeout(() => {
        safeFit();
        isReadyRef.current = true;
        setIsVisible(true); // Reveal after first fit to prevent jitter
        if (active) {
          term.focus();
        }

        // NOTE: Pending command execution moved to handleData
        // It now waits for first PTY output (= shell ready) instead of arbitrary timeout
      }, 100);

      // IPC: Send input to PTY
      term.onData((data) => {
        ipcRenderer.send('terminal:input', tabId, data);
      });

      // Track selection changes and update global state
      term.onSelectionChange(() => {
        if (active) {
          const selection = term.getSelection() || '';
          getSetTerminalSelection()(selection);
        }
      });

      // === INPUT INTERCEPTION for Claude Commands ===
      // Intercept Enter key to replace claude/claude-c/claude-f with explicit --resume
      // Commands: claude (new), claude-c (continue), claude-f (fork)
      term.attachCustomKeyEventHandler((event) => {
        // Skip xterm.js processing for app-level Meta (Cmd) shortcuts.
        // Prevents Cmd+, (Settings), Cmd+T (new tab), etc. from leaking characters to PTY.
        // Preserve: Cmd+C (copy/SIGINT), Cmd+V (paste), Cmd+A (selectAll), Cmd+X (cut)
        if (event.metaKey && !['c', 'v', 'a', 'x'].includes(event.key.toLowerCase())) {
          return false;
        }

        // Only intercept Enter key on keydown
        if (event.key !== 'Enter' || event.type !== 'keydown') {
          return true; // Allow default handling
        }

        // SAFETY: If terminal is in Alternate Buffer (TUI active), BYPASS interception!
        // This fixes the issue where Enter is swallowed in interactive menus (like "Resume Session")
        if (term.buffer.active.type === 'alternate') {
          return true;
        }

        // Get full command (handles wrapped lines)
        const fullLine = getCurrentCommand(term).trim();
        log.commands('Enter pressed, command: %s', fullLine);

        // --- Detect command type for auto-color and restart button ---
        // npm/npx/yarn/pnpm/bun → devServer (green, show restart)
        // gemini → gemini (blue, hide restart)
        // claude → handled below with explicit interception
        // Note: fullLine includes shell prompt, so don't use ^ anchor
        const devServerMatch = fullLine.match(/\b(npm|npx|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i);
        const geminiMatch = fullLine.match(/\bgemini(\s|$)/i);

        if (devServerMatch) {
          getSetTabCommandType()(tabId, 'devServer');
        } else if (geminiMatch) {
          getSetTabCommandType()(tabId, 'gemini');
        }

        // --- CASE 1: claude (new session) - must end with exactly "claude" ---
        if (fullLine.endsWith(' claude') || fullLine === 'claude') {
          log.claude('Detected claude command in terminal');
          getSetTabCommandType()(tabId, 'claude');
          event.preventDefault();

          // Check if ANY session already exists (Claude OR Gemini) - one session per tab
          const existingClaudeId = getClaudeSessionId(tabId);
          const existingGeminiId = getGeminiSessionId(tabId);

          if (existingClaudeId) {
            log.claude('Blocking: Claude session already exists: %s', existingClaudeId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия: ' + existingClaudeId + '. Используйте claude-c"\r');
            return false;
          }
          if (existingGeminiId) {
            log.claude('Blocking: Gemini session exists, cannot start Claude: %s', existingGeminiId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия. Откройте новую вкладку для Claude."\r');
            return false;
          }

          // Clear line, start watcher, then launch claude
          ipcRenderer.send('terminal:input', tabId, '\x15');
          log.claude('Sending claude:spawn-with-watcher IPC (Bridge handles session detection)');
          // Main process will: 1) start fs.watch 2) write 'claude\r' to PTY
          ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
          return false;
        }

        // --- CASE 2: claude-c (continue session) ---
        if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
          getSetTabCommandType()(tabId, 'claude');
          const existingSessionId = getClaudeSessionId(tabId);
          console.log('[Claude-c] tabId:', tabId);
          console.log('[Claude-c] existingSessionId from store:', existingSessionId);
          if (existingSessionId) {
            event.preventDefault();
            console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
            ipcRenderer.send('terminal:input', tabId, '\x15claude --dangerously-skip-permissions --resume ' + existingSessionId + '\r');
            // Signal command started immediately for Timeline visibility (don't wait for OSC 133)
            ipcRenderer.send('terminal:force-command-started', tabId);
            return false;
          } else {
            event.preventDefault();
            console.log('[Claude Intercept] No session to continue, showing error');
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Claude session saved for this tab"\r');
            return false;
          }
        }

                            // --- CASE 3: claude-f <ID> (fork session by ID) ---
                            // Creates a COPY of the session file with new ID
                            console.log('[Claude Intercept] Checking for claude-f pattern in:', fullLine);
                            const forkWithIdMatch = fullLine.match(/claude-f\s+([a-f0-9-]{8,})$/i);
                            console.log('[Claude Intercept] Fork match result:', forkWithIdMatch);
                            if (forkWithIdMatch) {
                              event.preventDefault();
                              const sourceSessionId = forkWithIdMatch[1];

                              // Check if session already exists - prevent accidental overwrite
                              const existingId = getClaudeSessionId(tabId);
                              if (existingId) {
                                console.log('[Claude Intercept] Session exists, blocking fork:', existingId);
                                ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Откройте новый таб для claude-f"\r');
                                return false;
                              }

                              console.log('[Claude Intercept] Fork from session:', sourceSessionId);

                              // Clear line
                              ipcRenderer.send('terminal:input', tabId, '\x15');

                              // Copy file manually and resume with new ID
                              // This avoids regex catching wrong ID from Claude output
                              (async () => {
                                const result = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId, cwd });
                                if (result.success) {
                                  console.log('[Claude Intercept] Forked to new session:', result.newSessionId);
                                  getSetTabCommandType()(tabId, 'claude'); // Set commandType for Timeline visibility
                                  getSetClaudeSessionId()(tabId, result.newSessionId);
                                  ipcRenderer.send('terminal:input', tabId, 'claude --dangerously-skip-permissions --resume ' + result.newSessionId + '\r');
                                } else {
                                  console.error('[Claude Intercept] Fork failed:', result.error);
                                  ipcRenderer.send('terminal:input', tabId, 'echo "❌ Fork failed: ' + result.error + '"\r');
                                }
                              })();

                              return false;
                            }        // claude-f without ID - show error
        if (fullLine.endsWith(' claude-f') || fullLine === 'claude-f') {
          event.preventDefault();
          ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: claude-f <session-id>"\r');
          return false;
        }

        // --- CASE 4: claude-d (alias for claude) ---
        if (fullLine.endsWith(' claude-d') || fullLine === 'claude-d') {
          getSetTabCommandType()(tabId, 'claude');
          event.preventDefault();

          const existingId = getClaudeSessionId(tabId);
          if (existingId) {
            console.log('[Claude Intercept] Session exists, blocking new:', existingId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
            return false;
          }

          ipcRenderer.send('terminal:input', tabId, '\x15');
          console.log('[Claude Intercept] Launching Claude');
          ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
          return false;
        }

        // --- CASE 5: claude --resume <ID> (direct resume command) ---
        console.log('[Claude Intercept] Checking for --resume pattern in:', fullLine);
        const resumeMatch = fullLine.match(/claude\s+.*--resume\s+([a-f0-9-]{8,})/i);
        console.log('[Claude Intercept] Resume match result:', resumeMatch);
        if (resumeMatch) {
          const sessionId = resumeMatch[1];
          console.log('[Claude Intercept] Direct --resume detected, sessionId:', sessionId);
          getSetTabCommandType()(tabId, 'claude');
          getSetClaudeSessionId()(tabId, sessionId);
          // Let the command pass through, but set commandType for Timeline
          // Don't preventDefault - let it run normally
        }

        // ========== GEMINI INPUT INTERCEPTION ==========

        // --- CASE: gemini (new session) - must end with exactly "gemini" ---
        if (fullLine.endsWith(' gemini') || fullLine === 'gemini') {
          log.gemini('Detected gemini command in terminal');
          log.gemini('TabId: %s, CWD: %s', tabId, cwd);
          getSetTabCommandType()(tabId, 'gemini');
          event.preventDefault();

          // Check if ANY session already exists (Claude OR Gemini) - one session per tab
          const existingGeminiId = getGeminiSessionId(tabId);
          const existingClaudeId = getClaudeSessionId(tabId);

          if (existingGeminiId) {
            log.gemini('Blocking: Gemini session already exists: %s', existingGeminiId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Gemini сессия: ' + existingGeminiId + '. Используйте gemini-c"\r');
            return false;
          }
          if (existingClaudeId) {
            log.gemini('Blocking: Claude session exists, cannot start Gemini: %s', existingClaudeId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть Claude сессия. Откройте новую вкладку для Gemini."\r');
            return false;
          }

          // Clear line, start watcher, then launch gemini
          ipcRenderer.send('terminal:input', tabId, '\x15');
          log.gemini('Sending gemini:spawn-with-watcher IPC to main process');
          // Main process will: 1) start fs.watch 2) write 'gemini\r' to PTY
          ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd });
          return false;
        }

        // --- CASE: gemini-c (continue session) ---
        if (fullLine.endsWith(' gemini-c') || fullLine === 'gemini-c') {
          getSetTabCommandType()(tabId, 'gemini');
          const existingSessionId = getGeminiSessionId(tabId);
          log.gemini('gemini-c command, tabId: %s, sessionId: %s', tabId, existingSessionId);
          if (existingSessionId) {
            event.preventDefault();
            log.gemini('Sending: gemini -r %s', existingSessionId);
            ipcRenderer.send('terminal:input', tabId, '\x15gemini -r ' + existingSessionId + '\r');
            return false;
          } else {
            event.preventDefault();
            log.gemini('No Gemini session to continue');
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Gemini session saved for this tab"\r');
            return false;
          }
        }

        return true; // Allow default handling for other commands
      });
    };

    // Lazy init: only create xterm when tab is active AND project is active
    // This prevents creating xterm for background projects during restore
    if (active && isActiveProject) {
      // Lock: prevent double initialization
      if (isCreatingRef.current) {
        return;
      }
      isCreatingRef.current = true; // Set lock
      initTerminal();
    }

    return () => {
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);
      ipcRenderer.removeListener('claude:session-detected', handleSessionDetected);
      ipcRenderer.removeListener('claude:status-session-detected', handleStatusSessionDetected);
      ipcRenderer.removeListener('gemini:session-detected', handleGeminiSessionDetected);
      // Close Gemini watcher if active for this tab
      ipcRenderer.send('gemini:close-watcher', { tabId });

      // Serialize terminal buffer before unmount (for restoration after remount)
      const term = xtermInstance.current;
      const serializeAddon = serializeAddonRef.current;
      if (term && serializeAddon) {
        try {
          const serialized = serializeAddon.serialize();
          if (serialized) {
            getBufferActions().save(tabId, serialized);
          }
        } catch (e) {
          // Ignore serialization errors
        }
      }

      // Unregister from global registry
      terminalRegistry.unregister(tabId);

      // Clear write buffer timeout
      if (pendingWriteRef.current) {
        clearTimeout(pendingWriteRef.current);
        pendingWriteRef.current = null;
      }
      writeBufferRef.current = '';

      // Dispose WebGL addon BEFORE terminal to avoid errors
      try {
        webglAddonRef.current?.dispose();
      } catch (e) {
        // Ignore WebGL dispose errors
      }

      const termToDispose = xtermInstance.current;
      xtermInstance.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      webglAddonRef.current = null;

      console.warn(`[Terminal:DISPOSE] tabId=${tabId} — terminal disposed (useEffect[tabId] cleanup)`);

      try {
        termToDispose?.dispose();
      } catch (e) {
        // Ignore dispose errors
      }
    };
  }, [tabId]);

  // Focus and fit when becoming active (with rAF to let browser paint first)
  // Also handles lazy initialization on first activation
  // Uses effectiveActive (active && currentView==='terminal') to prevent unmount/remount on view switch
  useEffect(() => {
    if (!effectiveActive || !isActiveProject) {
      // Clear global selection when terminal becomes inactive
      if (!effectiveActive) {
        console.warn(`[Terminal:deactivate] tabId=${tabId}`, {
          active,
          effectiveActive,
          projectCurrentView,
          isActiveProject,
        });
        getSetTerminalSelection()('');
      }
      return;
    }

    // Lazy init: if this is first activation and xterm not created yet
    if (!hasBeenActive.current && !xtermInstance.current && terminalRef.current) {
      console.warn(`[Terminal:LAZY_INIT] tabId=${tabId} — terminal not created yet, initializing from scratch`);
      // Lock: prevent double initialization
      if (isCreatingRef.current) {
        console.warn(`[Terminal:LAZY_INIT] tabId=${tabId} — SKIPPED (isCreatingRef lock)`);
        return;
      }
      isCreatingRef.current = true; // Set lock

      // Need to initialize terminal now (reuse same logic as initTerminal)
      const initLazy = async () => {
        await document.fonts.ready;

        if (!isMounted.current || !terminalRef.current) return;

        const currentFontSize = useUIStore.getState().terminalFontSize;
        const term = new XTerminal({
          theme: {
            background: '#1a1a1a',
            foreground: '#d4d4d4',
            cursor: '#ffffff',
            cursorAccent: '#1a1a1a',
            selectionBackground: '#264f78',
            black: '#000000',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#2472c8',
            magenta: '#bc3fbc',
            cyan: '#11a8cd',
            white: '#e5e5e5'
          },
          fontFamily: "'JetBrains Mono', 'JetBrainsMono NF', Menlo, Monaco, monospace",
          fontSize: currentFontSize,
          fontWeight: 'normal',
          fontWeightBold: 'bold',
          drawBoldTextInBrightColors: false, // Prevents bright colors from being bold
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: false,
          allowProposedApi: true, // Required for SearchAddon
          scrollback: 50000
        });

        const fitAddon = new FitAddon();
        const serializeAddon = new SerializeAddon();
        const searchAddon = new SearchAddon();
        fitAddonRef.current = fitAddon;
        serializeAddonRef.current = serializeAddon;
        searchAddonRef.current = searchAddon;

        term.loadAddon(fitAddon);
        term.loadAddon(serializeAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(new WebLinksAddon(handleLinkActivation));

        term.open(terminalRef.current);

        // OSC 7 handler - shell reports current working directory
        term.parser.registerOscHandler(7, (data: string) => {
          try {
            let newCwd: string;
            if (data.startsWith('file://')) {
              const url = new URL(data);
              newCwd = decodeURIComponent(url.pathname);
            } else {
              newCwd = data;
            }
            if (newCwd && newCwd.startsWith('/')) {
              console.log('[Terminal] OSC 7 cwd update:', newCwd);
              getUpdateTabCwd()(tabId, newCwd);
            }
          } catch (e) {
            console.error('[Terminal] OSC 7 parse error:', e);
          }
          return true;
        });

        // OSC 7777 handler - entry marker registration (future: main process sends before user prompt)
        term.parser.registerOscHandler(7777, (data: string) => {
          if (data.startsWith('entry:')) {
            const uuid = data.slice(6);
            console.log('[Terminal] OSC 7777 entry marker:', uuid);
            terminalRegistry.registerEntryMarker(tabId, uuid);
          }
          return true;
        });

        xtermInstance.current = term;
        hasBeenActive.current = true; // Mark as active AFTER xterm is created

        // Attach scroll listeners (native + xterm events)
        attachScrollListeners(term, terminalRef.current);

        terminalRegistry.register(tabId, term, searchAddon);

        // Restore previously serialized buffer (from before unmount)
        const savedBuffer = getBufferActions().get(tabId);
        if (savedBuffer) {
          term.write(savedBuffer);
          getBufferActions().clear(tabId); // Clear after restoration
        }

        // Replay buffered PTY data
        if (pendingBuffer.current) {
          term.write(pendingBuffer.current);
          pendingBuffer.current = '';
        }

        // Setup handlers
        term.onData((data) => {
          ipcRenderer.send('terminal:input', tabId, data);
        });
        term.onSelectionChange(() => {
          const selection = term.getSelection() || '';
          getSetTerminalSelection()(selection);
        });

        // === INPUT INTERCEPTION for Claude Commands (same as initTerminal) ===
        term.attachCustomKeyEventHandler((event) => {
          // Skip xterm.js processing for app-level Meta (Cmd) shortcuts.
          // Prevents Cmd+, (Settings), Cmd+T (new tab), etc. from leaking characters to PTY.
          // Preserve: Cmd+C (copy/SIGINT), Cmd+V (paste), Cmd+A (selectAll), Cmd+X (cut)
          if (event.metaKey && !['c', 'v', 'a', 'x'].includes(event.key.toLowerCase())) {
            return false;
          }

          if (event.key !== 'Enter' || event.type !== 'keydown') {
            return true;
          }

          // SAFETY: If terminal is in Alternate Buffer (TUI active), BYPASS interception!
          if (term.buffer.active.type === 'alternate') {
            return true;
          }

          // Get full command (handles wrapped lines)
          const fullLine = getCurrentCommand(term).trim();

          // --- Detect command type for auto-color and restart button ---
          // Note: fullLine includes shell prompt, so don't use ^ anchor
          const devServerMatch = fullLine.match(/\b(npm|npx|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i);
          const geminiMatch = fullLine.match(/\bgemini(\s|$)/i);

          if (devServerMatch) {
            log.commands('Detected devServer command, setting commandType');
            getSetTabCommandType()(tabId, 'devServer');
          } else if (geminiMatch) {
            log.commands('Detected gemini command, setting commandType');
            getSetTabCommandType()(tabId, 'gemini');
          }

          if (fullLine.endsWith(' claude') || fullLine === 'claude') {
            getSetTabCommandType()(tabId, 'claude');
            event.preventDefault();

            // Check if session already exists
            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            ipcRenderer.send('terminal:input', tabId, '\x15');
            console.log('[Claude Intercept] Launching Claude');
            ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
            return false;
          }

          if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
            getSetTabCommandType()(tabId, 'claude');
            const existingSessionId = getClaudeSessionId(tabId);
            console.log('[Claude-c] tabId:', tabId);
            console.log('[Claude-c] existingSessionId from store:', existingSessionId);
            if (existingSessionId) {
              event.preventDefault();
              console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
              ipcRenderer.send('terminal:input', tabId, '\x15claude --dangerously-skip-permissions --resume ' + existingSessionId + '\r');
              // Signal command started immediately for Timeline visibility
              ipcRenderer.send('terminal:force-command-started', tabId);
              return false;
            } else {
              event.preventDefault();
              console.log('[Claude Intercept] No session to continue');
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ No Claude session saved for this tab"\r');
              return false;
            }
          }

          // --- CASE 3: claude-f <ID> (fork session by ID) ---
          console.log('[Claude Intercept] Checking for claude-f pattern in:', fullLine);
          const forkWithIdMatch = fullLine.match(/claude-f\s+([a-f0-9-]{8,})$/i);
          console.log('[Claude Intercept] Fork match result:', forkWithIdMatch);
          if (forkWithIdMatch) {
            event.preventDefault();
            const sourceSessionId = forkWithIdMatch[1];

            // Check if session already exists
            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking fork:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Откройте новый таб для claude-f"\r');
              return false;
            }

            console.log('[Claude Intercept] Fork from session:', sourceSessionId);

            // Clear line
            ipcRenderer.send('terminal:input', tabId, '\x15');

            // Copy file manually and resume with new ID
            (async () => {
              const result = await ipcRenderer.invoke('claude:fork-session-file', { sourceSessionId, cwd });
              if (result.success) {
                console.log('[Claude Intercept] Forked to new session:', result.newSessionId);
                getSetTabCommandType()(tabId, 'claude'); // Set commandType for Timeline visibility
                getSetClaudeSessionId()(tabId, result.newSessionId);
                ipcRenderer.send('terminal:input', tabId, 'claude --dangerously-skip-permissions --resume ' + result.newSessionId + '\r');
              } else {
                console.error('[Claude Intercept] Fork failed:', result.error);
                ipcRenderer.send('terminal:input', tabId, 'echo "❌ Fork failed: ' + result.error + '"\r');
              }
            })();

            return false;
          }
          // claude-f without ID - show error
          if (fullLine.endsWith(' claude-f') || fullLine === 'claude-f') {
            event.preventDefault();
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Укажите ID: claude-f <session-id>"\r');
            return false;
          }

          // --- CASE 4: claude-d (alias for claude) ---
          if (fullLine.endsWith(' claude-d') || fullLine === 'claude-d') {
            getSetTabCommandType()(tabId, 'claude');
            event.preventDefault();

            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            ipcRenderer.send('terminal:input', tabId, '\x15');
            console.log('[Claude Intercept] Launching Claude');
            ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
            return false;
          }

          // --- CASE 5: claude --resume <ID> (direct resume command) ---
          console.log('[Claude Intercept 2] Checking for --resume pattern in:', fullLine);
          const resumeMatch = fullLine.match(/claude\s+.*--resume\s+([a-f0-9-]{8,})/i);
          console.log('[Claude Intercept 2] Resume match result:', resumeMatch);
          if (resumeMatch) {
            const sessionId = resumeMatch[1];
            console.log('[Claude Intercept 2] Direct --resume detected, sessionId:', sessionId);
            getSetTabCommandType()(tabId, 'claude');
            getSetClaudeSessionId()(tabId, sessionId);
            // Let the command pass through, but set commandType for Timeline
          }

          return true;
        });

        setTimeout(() => {
          safeFit();
          isReadyRef.current = true;
          setIsVisible(true);
          term.focus();

          // NOTE: Pending command execution moved to handleData
          // It now waits for first PTY output (= shell ready) instead of arbitrary timeout
        }, 100);
      };

      initLazy();
      return;
    }

    if (!xtermInstance.current) {
      return;
    }

    // Give browser 1 frame to recalculate CSS before calling fit
    const frameId = requestAnimationFrame(() => {
      const term = xtermInstance.current;
      if (!term) return;

      const fit = fitAddonRef.current;
      const colsBefore = term.cols;
      const rowsBefore = term.rows;
      const dimsBefore = fit?.proposeDimensions();
      const container = terminalRef.current;
      const containerRect = container?.getBoundingClientRect();

      console.warn(`[Terminal:activate] tabId=${tabId} BEFORE safeFit:`, {
        'term.cols': colsBefore,
        'term.rows': rowsBefore,
        'proposed': dimsBefore ? `${dimsBefore.cols}x${dimsBefore.rows}` : 'null',
        'container': containerRect ? `${Math.round(containerRect.width)}x${Math.round(containerRect.height)}` : 'null',
        'visibility': container?.style.visibility,
        'cursorHidden': (term as any)._core?.buffer?.isCursorHidden,
        'cursorX': term.buffer.active.cursorX,
        'cursorY': term.buffer.active.cursorY,
      });

      safeFit();

      const colsAfter = term.cols;
      const rowsAfter = term.rows;
      console.warn(`[Terminal:activate] AFTER safeFit:`, {
        'term.cols': colsAfter,
        'term.rows': rowsAfter,
        'changed': colsBefore !== colsAfter || rowsBefore !== rowsAfter,
        'cursorX': term.buffer.active.cursorX,
        'cursorY': term.buffer.active.cursorY,
      });

      // FIX: Force Canvas renderer to repaint after returning from visibility:hidden.
      // fit.fit() is a no-op if dimensions haven't changed, leaving canvas stale.
      try {
        const core = (term as any)._core;
        if (core?._renderService) {
          core._renderService.clear();
          console.warn('[Terminal:activate] _renderService.clear() called');
          // Force canvas repaint — clear() only marks lines dirty, refresh() triggers actual paint
          term.refresh(0, term.rows - 1);
        }
      } catch (e) {
        console.warn('[Terminal:activate] _renderService.clear() ERROR:', e);
      }

      term.focus();

      // Restore saved scroll position (from when tab was deactivated)
      const savedWasAtBottom = wasAtBottom.current;
      const savedPos = savedScrollPosition.current;
      const buffer = term.buffer.active;

      console.warn('[Terminal:activate] scroll restore:', {
        savedWasAtBottom,
        savedPos,
        'buffer.baseY': buffer.baseY,
        'buffer.viewportY': buffer.viewportY,
      });

      requestAnimationFrame(() => {
        if (savedWasAtBottom) {
          term.scrollToBottom();
        } else if (savedPos !== null) {
          term.scrollToLine(savedPos);
        } else {
          term.scrollToBottom();
        }
        savedScrollPosition.current = null;
        wasAtBottom.current = true;

        console.warn('[Terminal:activate] scroll restored, final:', {
          'buffer.viewportY': term.buffer.active.viewportY,
          'buffer.baseY': term.buffer.active.baseY,
        });
      });

      const selection = term.getSelection() || '';
      getSetTerminalSelection()(selection);
    });

    // Cleanup: save scroll position when tab becomes inactive
    return () => {
      cancelAnimationFrame(frameId);
      const term = xtermInstance.current;
      if (term && active) {
        // Tab is being deactivated - save current scroll position AND wasAtBottom flag
        const buffer = term.buffer.active;
        savedScrollPosition.current = buffer.viewportY;
        wasAtBottom.current = buffer.viewportY >= buffer.baseY;
      }
    };
  }, [effectiveActive, isActiveProject, tabId]);

  // React to font size changes
  useEffect(() => {
    const term = xtermInstance.current;
    if (!term) return;

    // Update font size
    term.options.fontSize = terminalFontSize;

    // Refit terminal after font size change
    requestAnimationFrame(() => {
      safeFit();
    });
  }, [terminalFontSize]);

  // Handle click to focus
  const handleClick = () => {
    if (xtermInstance.current) {
      xtermInstance.current.focus();
    }
  };

  // Handle context menu (right click)
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const hasSelection = xtermInstance.current?.hasSelection() || false;
    const selection = xtermInstance.current?.getSelection() || '';

    // Update global selection state immediately
    if (selection) {
      getSetTerminalSelection()(selection);
    }

    // Get prompts for context menu
    const promptsResult = await ipcRenderer.invoke('prompts:get');
    const prompts = promptsResult.success ? promptsResult.data : [];

    // Find projectId for this tab
    let currentProjectId: string | undefined;
    const state = useWorkspaceStore.getState();
    for (const [projId, workspace] of state.openProjects) {
      if (workspace.tabs.has(tabId)) { currentProjectId = projId; break; }
    }

    // Get current CWD for scripts detection
    const termCwd = await ipcRenderer.invoke('terminal:getCwd', tabId);

    ipcRenderer.send('show-terminal-context-menu', { hasSelection, prompts, tabId, projectId: currentProjectId, cwd: termCwd || cwd });
  };

  // CSS: visibility:hidden preserves geometry, prevents WebGL context loss
  // (unlike display:none which collapses to 0x0 and kills WebGL textures)
  // opacity:0 initially to prevent jitter during first fit

  return (
    <>
      <div className="absolute inset-0" style={{ zIndex: effectiveActive ? 1 : -1, isolation: 'isolate' }}>

        {/* Layer 1: Terminal (Lower) */}
        <div
          ref={terminalRef}
          className="terminal-instance w-full h-full"
          style={{
            visibility: effectiveActive ? 'visible' : 'hidden',
            opacity: isVisible ? 1 : 0,
            transition: 'opacity 0.05s ease-in'
          }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        />

      </div>

      {/* Scroll-to-bottom button — OUTSIDE isolation:isolate wrapper so its z-index
          participates in root stacking context (above Timeline tooltip portal z:10000) */}
      {active && showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="pointer-events-auto flex items-center justify-center cursor-pointer transition-all duration-200 ease-out hover:scale-105"
          title="Scroll to bottom"
          style={{
            position: 'absolute',
            bottom: '16px',
            right: '16px',
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            backgroundColor: 'rgba(60, 60, 60, 0.85)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            color: 'rgba(255, 255, 255, 0.8)',
            fontSize: '18px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            zIndex: 10001
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(80, 80, 80, 0.95)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 1)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(60, 60, 60, 0.85)';
            e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
          }}
        >
          ↓
        </button>
      )}
    </>
  );
}

// Wrap in memo to prevent re-renders when other terminals' state changes
export default memo(Terminal);
