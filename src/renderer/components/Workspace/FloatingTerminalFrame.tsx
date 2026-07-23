import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minus, SquareTerminal } from 'lucide-react';
import ControlHint from '../UI/ControlHint';
import { terminalRegistry } from '../../utils/terminalRegistry';
import {
  DEFAULT_FLOATING_TERMINAL_GEOMETRY,
  dragFloatingTerminalRect,
  floatingPixelsToGeometry,
  normalizeFloatingTerminalGeometry,
  resizeFloatingTerminalRect,
} from '../../utils/floatingTerminalGeometry.mjs';

const { ipcRenderer } = window.require('electron');
const STORAGE_KEY = 'noted-terminal-floating-terminal-geometry';
const APP_STATE_KEY = 'floatingTerminalGeometry';
const RESIZE_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
type ResizeDirection = typeof RESIZE_DIRECTIONS[number];
type Geometry = { x: number; y: number; width: number; height: number };

const readBootGeometry = (): Geometry => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeFloatingTerminalGeometry(JSON.parse(raw));
  } catch {}
  return { ...DEFAULT_FLOATING_TERMINAL_GEOMETRY };
};

const handleStyle = (direction: ResizeDirection): React.CSSProperties => {
  const corner = direction.length === 2;
  const base: React.CSSProperties = {
    position: 'absolute',
    zIndex: 6,
    background: 'transparent',
    pointerEvents: 'auto',
  };
  if (corner) {
    const north = direction.includes('n');
    const west = direction.includes('w');
    return {
      ...base,
      width: 14,
      height: 14,
      top: north ? -5 : undefined,
      bottom: north ? undefined : -5,
      left: west ? -5 : undefined,
      right: west ? undefined : -5,
      cursor: direction === 'ne' || direction === 'sw' ? 'nesw-resize' : 'nwse-resize',
    };
  }
  if (direction === 'n' || direction === 's') {
    return {
      ...base,
      left: 10,
      right: 10,
      height: 10,
      top: direction === 'n' ? -5 : undefined,
      bottom: direction === 's' ? -5 : undefined,
      cursor: 'ns-resize',
    };
  }
  return {
    ...base,
    top: 10,
    bottom: 10,
    width: 10,
    left: direction === 'w' ? -5 : undefined,
    right: direction === 'e' ? -5 : undefined,
    cursor: 'ew-resize',
  };
};

interface FloatingTerminalFrameProps {
  tabId: string | null;
  floating: boolean;
  open: boolean;
  bottomInset: number;
  onClose: () => void;
  searchNode?: React.ReactNode;
  children: React.ReactNode;
}

export default function FloatingTerminalFrame({
  tabId,
  floating,
  open,
  bottomInset,
  onClose,
  searchNode,
  children,
}: FloatingTerminalFrameProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const geometryRef = useRef<Geometry>(readBootGeometry());
  const [geometry, setGeometryState] = useState<Geometry>(geometryRef.current);
  const gestureRef = useRef<{
    kind: 'drag' | 'resize';
    direction?: ResizeDirection;
    pointerId: number;
    startX: number;
    startY: number;
    startRect: Geometry;
    bounds: { width: number; height: number };
    cursor: string;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingGeometryRef = useRef<Geometry | null>(null);

  const setGeometry = useCallback((next: Geometry) => {
    const normalized = normalizeFloatingTerminalGeometry(next);
    geometryRef.current = normalized;
    setGeometryState(normalized);
  }, []);

  const persistGeometry = useCallback((next: Geometry) => {
    const normalized = normalizeFloatingTerminalGeometry(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch {}
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY, value: normalized }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipcRenderer.invoke('app:getState', APP_STATE_KEY).then((value: unknown) => {
      if (!cancelled && value && typeof value === 'object' && !gestureRef.current) {
        const next = normalizeFloatingTerminalGeometry(value);
        setGeometry(next);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [setGeometry]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setGeometry(geometryRef.current);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [setGeometry]);

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

  const flushPreview = useCallback(() => {
    rafRef.current = null;
    if (pendingGeometryRef.current) {
      setGeometry(pendingGeometryRef.current);
      pendingGeometryRef.current = null;
    }
  }, [setGeometry]);

  const queuePreview = useCallback((next: Geometry) => {
    pendingGeometryRef.current = next;
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushPreview);
  }, [flushPreview]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const delta = { x: event.clientX - gesture.startX, y: event.clientY - gesture.startY };
      const nextRect = gesture.kind === 'drag'
        ? dragFloatingTerminalRect(gesture.startRect, delta, gesture.bounds)
        : resizeFloatingTerminalRect(gesture.startRect, gesture.direction || 'se', delta, gesture.bounds);
      queuePreview(floatingPixelsToGeometry(nextRect, gesture.bounds));
    };
    const finish = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (pendingGeometryRef.current) {
        setGeometry(pendingGeometryRef.current);
        pendingGeometryRef.current = null;
      }
      gestureRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      persistGeometry(geometryRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [persistGeometry, queuePreview, setGeometry]);

  const beginGesture = useCallback((
    event: React.PointerEvent,
    kind: 'drag' | 'resize',
    direction?: ResizeDirection,
  ) => {
    if (!floating || !open || event.button !== 0) return;
    if (kind === 'drag' && (event.target as HTMLElement).closest('button')) return;
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!stage || !frame) return;
    const rect = stage.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const bounds = { width: rect.width, height: rect.height };
    const cursor = kind === 'drag' ? 'grabbing' : String(handleStyle(direction || 'se').cursor || 'default');
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = {
      kind,
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: {
        x: frameRect.left - rect.left,
        y: frameRect.top - rect.top,
        width: frameRect.width,
        height: frameRect.height,
      },
      bounds,
      cursor,
    };
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';
  }, [floating, open]);

  const isPresented = !floating || open;
  const frameStyle: React.CSSProperties = floating ? {
    left: `${geometry.x}%`,
    top: `${geometry.y}%`,
    width: `${geometry.width}%`,
    height: `${geometry.height}%`,
    visibility: open ? 'visible' : 'hidden',
    opacity: open ? 1 : 0,
    pointerEvents: open ? 'auto' : 'none',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 8,
    boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
    background: '#151515',
  } : {
    inset: 0,
    visibility: 'visible',
    opacity: 1,
    pointerEvents: 'auto',
    background: '#1a1a1a',
  };

  return (
    <div
      ref={stageRef}
      data-floating-terminal-stage
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: floating ? Math.max(0, bottomInset) : 0,
        pointerEvents: 'none',
        zIndex: floating ? 80 : 0,
      }}
    >
      <div
        ref={frameRef}
        data-floating-terminal
        data-floating-terminal-open={isPresented ? '1' : '0'}
        style={{
          position: 'absolute',
          overflow: 'visible',
          transition: gestureRef.current ? 'none' : 'opacity 80ms ease-out',
          ...frameStyle,
        }}
      >
        <div
          data-floating-terminal-titlebar
          onPointerDown={(event) => beginGesture(event, 'drag')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: floating ? 30 : 0,
            visibility: floating ? 'visible' : 'hidden',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '0 6px 0 9px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px 8px 0 0',
            background: '#191919',
            color: '#9ca3af',
            cursor: 'grab',
            zIndex: 5,
            boxSizing: 'border-box',
          }}
        >
          <SquareTerminal size={14} />
          <span style={{ fontSize: 11, fontWeight: 650, letterSpacing: '0.04em' }}>TERMINAL</span>
          <div style={{ flex: 1 }} />
          <ControlHint label="Скрыть терминал">
            <button
              type="button"
              aria-label="Hide terminal"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onClose}
              style={{ border: 0, background: 'transparent', color: '#8b8b91', padding: 4, cursor: 'pointer', display: 'flex' }}
            ><Minus size={15} /></button>
          </ControlHint>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: floating ? 30 : 0,
            bottom: 0,
            overflow: 'hidden',
            borderRadius: floating ? '0 0 8px 8px' : 0,
            background: '#1a1a1a',
          }}
        >
          {children}
          {floating && open ? searchNode : null}
        </div>

        {floating && open && RESIZE_DIRECTIONS.map((direction) => (
          <div
            key={direction}
            data-floating-terminal-resize={direction}
            onPointerDown={(event) => beginGesture(event, 'resize', direction)}
            style={handleStyle(direction)}
          />
        ))}
      </div>
    </div>
  );
}
