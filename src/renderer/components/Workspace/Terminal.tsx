import React, { useEffect, useRef, useState, memo } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { terminalRegistry } from '../../utils/terminalRegistry';

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

// Get pending command for a tab (used for fork)
const getTabPendingCommand = (tabId: string): string | undefined => {
  const state = useWorkspaceStore.getState();
  for (const [, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) return tab.pendingCommand;
  }
  return undefined;
};

// Clear pending command after execution
const clearTabPendingCommand = (tabId: string) => {
  const state = useWorkspaceStore.getState();
  for (const [projectId, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab && tab.pendingCommand) {
      tab.pendingCommand = undefined;
      state.openProjects.set(projectId, { ...workspace });
      useWorkspaceStore.setState({ openProjects: new Map(state.openProjects) });
      return;
    }
  }
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

  console.log('[getCurrentCommand] Result:', JSON.stringify(logicalLine));
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
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const isInitialized = useRef(false);
  const isMounted = useRef(true);
  const isReadyRef = useRef(false); // Track if first fit completed
  const hasBeenActive = useRef(false); // Track if tab was ever active (for lazy init)
  const pendingBuffer = useRef<string>(''); // Buffer PTY data before xterm init
  const [isVisible, setIsVisible] = useState(false); // Hide until ready
  const claudeSessionDetected = useRef<string | null>(null); // Track detected Claude session UUID

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);

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

      fit.fit();

      const dims = fit.proposeDimensions();
      if (dims) {
        ipcRenderer.send('terminal:resize', tabId, dims.cols, dims.rows);
      }
    } catch (e) {
      // Silently ignore fit errors
    }
  };

  useEffect(() => {
    if (isInitialized.current || !terminalRef.current) return;
    isInitialized.current = true;

    const containerRef = terminalRef.current;

    // IPC: Receive data from PTY (with write buffer to prevent jitter)
    const handleData = (_: any, payload: { tabId: string; data: string }) => {
      if (payload.tabId !== tabId) return;

      // NOTE: Session ID detection via regex is DISABLED
      // It catches the wrong ID (parent session) from Claude's UI output
      // Instead we use:
      // - Sniper Watcher for 'claude' command (catches new file creation)
      // - Explicit ID setting for 'claude-c' and 'claude-f' commands

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

    // Sniper Watcher: receive session ID when Claude creates it
    const handleSessionDetected = (_: any, data: { tabId: string; sessionId: string }) => {
      if (data.tabId !== tabId) return;
      console.log('[Terminal] Sniper caught session:', data.sessionId);
      getSetClaudeSessionId()(tabId, data.sessionId);
    };

    // Register IPC listeners synchronously
    ipcRenderer.on('terminal:data', handleData);
    ipcRenderer.on('terminal:exit', handleExit);
    ipcRenderer.on('claude:session-detected', handleSessionDetected);

    // Resize observer with Guard Clause (prevents WebGL accordion effect)
    const resizeObserver = new ResizeObserver((entries) => {
      // Guard: If container is hidden (0x0), DON'T let xterm reset to 12x6
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }

      // Only fit if active, wrapped in rAF to prevent layout thrashing
      if (active) {
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
        cursorBlink: true,
        cursorStyle: 'block',
        allowTransparency: false,
        scrollback: 10000
      });

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      fitAddonRef.current = fitAddon;
      serializeAddonRef.current = serializeAddon;

      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef);

      xtermInstance.current = term;

      // Register terminal in global registry for selection access
      terminalRegistry.register(tabId, term);

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

        // Execute pending command if any (used for fork)
        const pendingCommand = getTabPendingCommand(tabId);
        if (pendingCommand) {
          console.log('[Terminal] Executing pending command:', pendingCommand);
          // Small delay to ensure PTY is fully ready
          setTimeout(() => {
            ipcRenderer.send('terminal:input', tabId, pendingCommand + '\r');
            clearTabPendingCommand(tabId);
          }, 200);
        }
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
        console.log('[Claude Intercept] Full line:', JSON.stringify(fullLine));

        // --- CASE 1: claude (new session) - must end with exactly "claude" ---
        if (fullLine.endsWith(' claude') || fullLine === 'claude') {
          event.preventDefault();

          // Check if session already exists - prevent accidental overwrite
          const existingId = getClaudeSessionId(tabId);
          if (existingId) {
            console.log('[Claude Intercept] Session exists, blocking new:', existingId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
            return false;
          }

          // Clear line, start watcher, then launch claude
          ipcRenderer.send('terminal:input', tabId, '\x15');
          console.log('[Claude Intercept] Spawning with Sniper Watcher');
          // Main process will: 1) start fs.watch 2) write 'claude\r' to PTY
          ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
          return false;
        }

        // --- CASE 2: claude-c (continue session) ---
        if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
          const existingSessionId = getClaudeSessionId(tabId);
          console.log('[Claude-c] tabId:', tabId);
          console.log('[Claude-c] existingSessionId from store:', existingSessionId);
          if (existingSessionId) {
            event.preventDefault();
            console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
            ipcRenderer.send('terminal:input', tabId, '\x15claude --dangerously-skip-permissions --resume ' + existingSessionId + '\r');
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
          event.preventDefault();

          const existingId = getClaudeSessionId(tabId);
          if (existingId) {
            console.log('[Claude Intercept] Session exists, blocking new:', existingId);
            ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
            return false;
          }

          ipcRenderer.send('terminal:input', tabId, '\x15');
          console.log('[Claude Intercept] Spawning with Sniper Watcher');
          ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
          return false;
        }

        return true; // Allow default handling for other commands
      });
    };

    // Lazy init: only create xterm when tab is active AND project is active
    // This prevents creating xterm for background projects during restore
    if (active && isActiveProject) {
      hasBeenActive.current = true;
      initTerminal();
    }

    return () => {
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);
      ipcRenderer.removeListener('claude:session-detected', handleSessionDetected);

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

      try {
        termToDispose?.dispose();
      } catch (e) {
        // Ignore dispose errors
      }
    };
  }, [tabId]);

  // Focus and fit when becoming active (with rAF to let browser paint first)
  // Also handles lazy initialization on first activation
  useEffect(() => {
    if (!active || !isActiveProject) {
      // Clear global selection when terminal becomes inactive
      if (!active) {
        getSetTerminalSelection()('');
      }
      return;
    }

    // Lazy init: if this is first activation and xterm not created yet
    if (!hasBeenActive.current && !xtermInstance.current && terminalRef.current) {
      hasBeenActive.current = true;

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
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: false,
          scrollback: 10000
        });

        const fitAddon = new FitAddon();
        const serializeAddon = new SerializeAddon();
        fitAddonRef.current = fitAddon;
        serializeAddonRef.current = serializeAddon;

        term.loadAddon(fitAddon);
        term.loadAddon(serializeAddon);
        term.loadAddon(new WebLinksAddon());

        term.open(terminalRef.current);

        xtermInstance.current = term;
        terminalRegistry.register(tabId, term);

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
          if (event.key !== 'Enter' || event.type !== 'keydown') {
            return true;
          }

          // SAFETY: If terminal is in Alternate Buffer (TUI active), BYPASS interception!
          if (term.buffer.active.type === 'alternate') {
            return true;
          }

          // Get full command (handles wrapped lines)
          const fullLine = getCurrentCommand(term).trim();
          console.log('[Claude Intercept] Full line:', JSON.stringify(fullLine));

          if (fullLine.endsWith(' claude') || fullLine === 'claude') {
            event.preventDefault();

            // Check if session already exists
            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            ipcRenderer.send('terminal:input', tabId, '\x15');
            console.log('[Claude Intercept] Spawning with Sniper Watcher');
            ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
            return false;
          }

          if (fullLine.endsWith(' claude-c') || fullLine === 'claude-c') {
            const existingSessionId = getClaudeSessionId(tabId);
            console.log('[Claude-c] tabId:', tabId);
            console.log('[Claude-c] existingSessionId from store:', existingSessionId);
            if (existingSessionId) {
              event.preventDefault();
              console.log('[Claude-c] Sending command: claude --resume', existingSessionId);
              ipcRenderer.send('terminal:input', tabId, '\x15claude --dangerously-skip-permissions --resume ' + existingSessionId + '\r');
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
            event.preventDefault();

            const existingId = getClaudeSessionId(tabId);
            if (existingId) {
              console.log('[Claude Intercept] Session exists, blocking new:', existingId);
              ipcRenderer.send('terminal:input', tabId, '\x15echo "❌ Уже есть сессия: ' + existingId + '. Используйте claude-c или claude-f <ID>"\r');
              return false;
            }

            ipcRenderer.send('terminal:input', tabId, '\x15');
            console.log('[Claude Intercept] Spawning with Sniper Watcher');
            ipcRenderer.send('claude:spawn-with-watcher', { tabId, cwd });
            return false;
          }

          return true;
        });

        setTimeout(() => {
          safeFit();
          isReadyRef.current = true;
          setIsVisible(true);
          term.focus();

          // Execute pending command if any (used for fork)
          const pendingCommand = getTabPendingCommand(tabId);
          if (pendingCommand) {
            console.log('[Terminal] Executing pending command:', pendingCommand);
            setTimeout(() => {
              ipcRenderer.send('terminal:input', tabId, pendingCommand + '\r');
              clearTabPendingCommand(tabId);
            }, 200);
          }
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

      // Save scroll position before fit/focus
      const scrollY = term.buffer.active.viewportY;

      safeFit();
      term.focus();

      // Restore scroll position after focus (which auto-scrolls to cursor)
      if (scrollY !== undefined && scrollY !== term.buffer.active.baseY + term.rows - 1) {
        // Only restore if user wasn't at the bottom (avoid fighting auto-scroll)
        term.scrollToLine(scrollY);
      }

      // Update selection state when becoming active
      const selection = term.getSelection() || '';
      getSetTerminalSelection()(selection);
    });

    return () => cancelAnimationFrame(frameId);
  }, [active, isActiveProject]);

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

    ipcRenderer.send('show-terminal-context-menu', { hasSelection, prompts });
  };

  // CSS: visibility:hidden preserves geometry, prevents WebGL context loss
  // (unlike display:none which collapses to 0x0 and kills WebGL textures)
  // opacity:0 initially to prevent jitter during first fit
  return (
    <div
      ref={terminalRef}
      className="terminal-instance absolute inset-0"
      style={{
        width: '100%',
        height: '100%',
        visibility: active ? 'visible' : 'hidden',
        opacity: isVisible ? 1 : 0,
        transition: 'opacity 0.05s ease-in',
        zIndex: active ? 1 : -1
      }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    />
  );
}

// Wrap in memo to prevent re-renders when other terminals' state changes
export default memo(Terminal);
