import React, { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';

const { ipcRenderer } = window.require('electron');

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

  const safeFit = () => {
    if (!isMounted.current) return;
    try {
      const term = xtermInstance.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      // Safely check if disposed
      if ((term as any)._isDisposed) return;
      if ((term as any).element === null) return;
      fit.fit();
      const dims = fit.proposeDimensions();
      if (dims) {
        ipcRenderer.send('terminal:resize', tabId, dims.cols, dims.rows);
      }
    } catch (e) {
      // Terminal disposed or not ready - silently ignore
    }
  };

  useEffect(() => {
    if (isInitialized.current || !terminalRef.current) return;
    isInitialized.current = true;

    console.log('[Terminal] Initializing terminal for tabId:', tabId);

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

    term.open(terminalRef.current);

    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      webglAddonRef.current = webgl;
    } catch (e) {
      console.warn('[Terminal] WebGL addon failed to load');
    }

    xtermInstance.current = term;

    // Fit after opening
    setTimeout(() => {
      safeFit();
      if (active) {
        term.focus();
      }
    }, 100);

    // IPC: Send input to PTY
    term.onData((data) => {
      console.log('[Terminal] onData sending to PTY, tabId:', tabId);
      ipcRenderer.send('terminal:input', tabId, data);
    });

    // IPC: Receive data from PTY
    const handleData = (_: any, payload: { tabId: string; data: string }) => {
      if (payload.tabId === tabId && xtermInstance.current) {
        xtermInstance.current.write(payload.data);
      }
    };

    const handleExit = (_: any, exitedTabId: string) => {
      if (exitedTabId === tabId && xtermInstance.current) {
        xtermInstance.current.write('\r\n\r\n[Process completed]');
      }
    };

    ipcRenderer.on('terminal:data', handleData);
    ipcRenderer.on('terminal:exit', handleExit);

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (active) safeFit();
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      console.log('[Terminal] Disposing terminal for tabId:', tabId);
      isMounted.current = false;
      resizeObserver.disconnect();
      ipcRenderer.removeListener('terminal:data', handleData);
      ipcRenderer.removeListener('terminal:exit', handleExit);

      // Dispose WebGL addon BEFORE terminal to avoid errors
      try {
        webglAddonRef.current?.dispose();
      } catch (e) {
        // Ignore WebGL dispose errors
      }

      xtermInstance.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
      webglAddonRef.current = null;

      try {
        term.dispose();
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
