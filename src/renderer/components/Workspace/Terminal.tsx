import React, { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';

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

  // Write buffer refs to batch PTY output and prevent jitter
  const writeBufferRef = useRef<string>('');
  const pendingWriteRef = useRef<NodeJS.Timeout | null>(null);

  const safeFit = () => {
    console.log('[safeFit] called, isMounted:', isMounted.current);
    if (!isMounted.current) return;
    try {
      const term = xtermInstance.current;
      const fit = fitAddonRef.current;
      console.log('[safeFit] term:', !!term, 'fit:', !!fit);
      if (!term || !fit) return;
      console.log('[safeFit] _isDisposed:', (term as any)._isDisposed, 'element:', !!term.element);
      if ((term as any)._isDisposed) return;
      if (!term.element) return;
      console.log('[safeFit] cols:', term.cols, 'rows:', term.rows);
      if (!term.options || term.cols === 0 || term.rows === 0) return;
      console.log('[safeFit] calling fit.fit()');
      fit.fit();
      console.log('[safeFit] calling proposeDimensions()');
      const dims = fit.proposeDimensions();
      console.log('[safeFit] dims:', dims);
      if (dims) {
        ipcRenderer.send('terminal:resize', tabId, dims.cols, dims.rows);
      }
    } catch (e) {
      console.error('[safeFit] error:', e);
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

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (active) safeFit();
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
        fontSize: 13,
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

      console.log('[initTerminal] opening terminal');
      term.open(containerRef);
      console.log('[initTerminal] terminal opened, cols:', term.cols, 'rows:', term.rows);

      try {
        console.log('[initTerminal] loading WebGL addon');
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        webglAddonRef.current = webgl;
        console.log('[initTerminal] WebGL addon loaded');
      } catch (e) {
        console.warn('[Terminal] WebGL addon failed to load:', e);
      }

      xtermInstance.current = term;
      console.log('[initTerminal] xtermInstance.current set');

      // Fit after opening
      setTimeout(() => {
        console.log('[initTerminal] setTimeout callback, calling safeFit');
        safeFit();
        if (active) {
          term.focus();
        }
      }, 100);

      // IPC: Send input to PTY
      term.onData((data) => {
        ipcRenderer.send('terminal:input', tabId, data);
      });
    };

    // Start async initialization
    initTerminal();

    return () => {
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);

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

  // Focus and fit when becoming active
  useEffect(() => {
    if (active && xtermInstance.current) {
      setTimeout(() => {
        safeFit();
        xtermInstance.current?.focus();
      }, 50);
    }
  }, [active]);

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

    // Get prompts for context menu
    const promptsResult = await ipcRenderer.invoke('prompts:get');
    const prompts = promptsResult.success ? promptsResult.data : [];

    ipcRenderer.send('show-terminal-context-menu', { hasSelection, prompts });
  };

  return (
    <div
      ref={terminalRef}
      className={`terminal-instance absolute inset-0 ${active ? 'block' : 'hidden'}`}
      style={{ width: '100%', height: '100%' }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    />
  );
}
