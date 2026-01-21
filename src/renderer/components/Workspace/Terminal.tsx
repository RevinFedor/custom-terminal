import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';

// Get setTerminalSelection outside of component to avoid re-renders
const getSetTerminalSelection = () => useUIStore.getState().setTerminalSelection;

const { ipcRenderer } = window.require('electron');

// Write buffer constants to prevent Ink/TUI render tearing
const FLUSH_DELAY = 10; // ms - aligns with 60fps
const MAX_BUFFER_SIZE = 4096; // safety valve

interface TerminalProps {
  tabId: string;
  cwd: string;
  active: boolean;
}

export default function Terminal({ tabId, cwd, active }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const isInitialized = useRef(false);
  const isMounted = useRef(true);
  const isReadyRef = useRef(false); // Track if first fit completed
  const [isVisible, setIsVisible] = useState(false); // Hide until ready

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
      if (payload.tabId !== tabId || !xtermInstance.current) return;

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

    // Register IPC listeners synchronously
    ipcRenderer.on('terminal:data', handleData);
    ipcRenderer.on('terminal:exit', handleExit);

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
      console.time(`[PERF] Terminal init ${tabId}`);
      console.time(`[PERF] Terminal fonts ${tabId}`);
      // Wait for fonts to load before creating terminal (prevents metric issues)
      await document.fonts.ready;
      console.timeEnd(`[PERF] Terminal fonts ${tabId}`);

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

      console.time(`[PERF] Terminal xterm create ${tabId}`);
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
      console.timeEnd(`[PERF] Terminal xterm create ${tabId}`);

      console.time(`[PERF] Terminal open+webgl ${tabId}`);
      term.open(containerRef);

      try {
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        webglAddonRef.current = webgl;
      } catch (e) {
        // WebGL not available, fallback to canvas renderer
      }
      console.timeEnd(`[PERF] Terminal open+webgl ${tabId}`);

      xtermInstance.current = term;

      // Register terminal in global registry for selection access
      terminalRegistry.register(tabId, term);

      // Fit after opening, then reveal terminal
      setTimeout(() => {
        safeFit();
        isReadyRef.current = true;
        setIsVisible(true); // Reveal after first fit to prevent jitter
        if (active) {
          term.focus();
        }
        console.timeEnd(`[PERF] Terminal init ${tabId}`);
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
    };

    // Start async initialization
    initTerminal();

    return () => {
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);

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
  useEffect(() => {
    if (!active) {
      // Clear global selection when terminal becomes inactive
      getSetTerminalSelection()('');
      return;
    }

    if (!xtermInstance.current) {
      return;
    }

    // Give browser 1 frame to recalculate CSS before calling fit
    const frameId = requestAnimationFrame(() => {
      safeFit();
      xtermInstance.current?.focus();
      // Update selection state when becoming active
      const selection = xtermInstance.current?.getSelection() || '';
      getSetTerminalSelection()(selection);
    });

    return () => cancelAnimationFrame(frameId);
  }, [active]);

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
      console.log('[Terminal] Context menu - selection:', selection.slice(0, 50));
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
