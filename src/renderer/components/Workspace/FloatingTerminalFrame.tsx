import React, { useCallback, useEffect, useRef } from 'react';
import { SquareTerminal, X } from 'lucide-react';
import ControlHint from '../UI/ControlHint';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';

const SIDE_TERMINAL_MIN_WIDTH = 360;
const SIDE_TERMINAL_MAX_WIDTH = 1200;

interface FloatingTerminalFrameProps {
  tabId: string | null;
  tabName: string;
  floating: boolean;
  open: boolean;
  bottomInset: number;
  onClose: () => void;
  searchNode?: React.ReactNode;
  children: React.ReactNode;
}

export default function FloatingTerminalFrame({
  tabId,
  tabName,
  floating,
  open,
  bottomInset,
  onClose,
  searchNode,
  children,
}: FloatingTerminalFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const sideTerminalWidth = useUIStore((state) => state.sideTerminalWidth);
  const setSideTerminalWidth = useUIStore((state) => state.setSideTerminalWidth);
  const selectedInputSurface = useUIStore((state) => (
    tabId ? (state.promptQueueInputSurfaceTabs[tabId] ?? 'history') : 'history'
  ));
  const setPromptQueueInputSurface = useUIStore((state) => state.setPromptQueueInputSurface);
  const terminalSelected = floating && open && selectedInputSurface === 'terminal';

  useEffect(() => {
    if (!floating || !open || !tabId) return;
    let second: number | null = null;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const terminal = terminalRegistry.get(tabId);
        if (!terminal) return;
        try {
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
          terminal.focus();
        } catch {}
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== null) cancelAnimationFrame(second);
    };
  }, [floating, open, tabId]);

  useEffect(() => {
    if (!floating || open || !tabId || selectedInputSurface !== 'terminal') return;
    setPromptQueueInputSurface(tabId, 'history');
  }, [floating, open, selectedInputSurface, setPromptQueueInputSurface, tabId]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (!floating || !open || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = sideTerminalWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const next = startWidth + startX - moveEvent.clientX;
      setSideTerminalWidth(Math.max(SIDE_TERMINAL_MIN_WIDTH, Math.min(SIDE_TERMINAL_MAX_WIDTH, next)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [floating, open, setSideTerminalWidth, sideTerminalWidth]);

  const isPresented = !floating || open;

  return (
    <div
      data-floating-terminal-stage
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: floating ? Math.max(0, bottomInset) : 0,
        pointerEvents: 'none',
        // Side panel opens ABOVE everything in the center — including the
        // Run after strip host (z 120) and orchestration chips — matching how
        // the History side panel covers them in terminal-primary.
        zIndex: floating ? 130 : 0,
      }}
    >
      <div
        ref={frameRef}
        data-floating-terminal
        data-floating-terminal-open={isPresented ? '1' : '0'}
        data-floating-terminal-selected={terminalSelected ? '1' : '0'}
        onPointerDownCapture={(event) => {
          // Portalled Run after UI remains a React child, so only a physical
          // hit inside this panel proves that terminal input was selected.
          const target = event.target;
          if (!(target instanceof Node) || !frameRef.current?.contains(target)) return;
          if (floating && open && tabId) setPromptQueueInputSurface(tabId, 'terminal');
        }}
        style={floating ? {
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: sideTerminalWidth,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: open ? 'auto' : 'none',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 50ms ease-out',
          borderLeft: terminalSelected
            ? '1px solid rgba(255,255,255,0.92)'
            : '1px solid #333',
          boxShadow: '-14px 0 34px rgba(0,0,0,0.48)',
          background: '#151515',
        } : {
          position: 'absolute',
          inset: 0,
          overflow: 'visible',
          pointerEvents: 'auto',
          background: '#1a1a1a',
        }}
      >
        <div
          data-floating-terminal-titlebar
          style={{
            height: floating ? 30 : 0,
            visibility: floating ? 'visible' : 'hidden',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '0 6px 0 12px',
            borderBottom: floating ? '1px solid #333' : 'none',
            background: '#191919',
            color: '#8a8a8f',
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          <SquareTerminal size={13} />
          <span
            title={tabName}
            style={{ fontSize: 11, color: '#8a8a8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {tabName}
          </span>
          <div style={{ flex: 1 }} />
          <ControlHint label="Закрыть терминал">
            <button
              type="button"
              aria-label="Hide terminal"
              onClick={onClose}
              style={{
                width: 24,
                height: 24,
                border: 0,
                background: 'transparent',
                color: '#8a8a8f',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={14} />
            </button>
          </ControlHint>
        </div>

        <div
          style={{
            position: floating ? 'relative' : 'absolute',
            inset: floating ? undefined : 0,
            flex: floating ? 1 : undefined,
            minHeight: 0,
            overflow: 'hidden',
            background: '#1a1a1a',
          }}
        >
          {children}
          {floating && open ? searchNode : null}
        </div>

        {floating && (
          <div
            data-floating-terminal-resize="w"
            onMouseDown={handleResizeMouseDown}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: 'col-resize',
              zIndex: 10,
              background: 'transparent',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = '#5b9cf5'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          />
        )}
      </div>
    </div>
  );
}
