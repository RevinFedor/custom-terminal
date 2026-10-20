import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BringToFront, Undo2, SquareTerminal, X } from 'lucide-react';
import ControlHint from '../UI/ControlHint';
import { useUIStore } from '../../store/useUIStore';
import { terminalRegistry } from '../../utils/terminalRegistry';
import { resolveStableTerminalViewportOffsets } from '../../utils/stableTerminalViewport.mjs';
import { HISTORY_TOP_CHROME_INSET } from '../../utils/promptQueueChrome.mjs';
import { acquireInteractionCursor } from '../../utils/interactionCursor';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import { acquireTerminalFullView, preserveTerminalViewportScroll, resolveTerminalLiftGeometry, TERMINAL_FULL_VIEW_REQUEST } from '../../utils/terminalFullView.mjs';

const SIDE_TERMINAL_MIN_WIDTH = 360;
const SIDE_TERMINAL_MAX_WIDTH = 1200;

interface FloatingTerminalFrameProps {
  tabId: string | null;
  tabName: string;
  floating: boolean;
  open: boolean;
  bottomInset: number;
  /**
   * Pinned: the side terminal is a COLUMN — it reserves its width and the
   * centre shrinks. Unpinned: it overlays the centre, which keeps full width.
   *
   * Same user-facing switch as the transcript's pin, because it is the same
   * slot: Cmd+] opens whichever surface is secondary for this tab. Applying it
   * to only one of them made one gesture behave two ways.
   */
  pinned?: boolean;
  /** Split panes clip their own content; an open side panel may cover the tab sidebar. */
  allowSideOverlayOverflow?: boolean;
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
  pinned = false,
  allowSideOverlayOverflow = false,
  onClose,
  searchNode,
  children,
}: FloatingTerminalFrameProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const liftedRect = useRef<{ owner: string; left: number; top: number; width: number; height: number;
    contentWidth: number; contentHeight: number } | null>(null);
  // React always portals into this SAME node. Only its DOM placement changes;
  // changing a portal target or JSX parent would remount the live xterm tree.
  const [host] = useState(() => document.createElement('div'));
  const [expandedOwner, setExpandedOwner] = useState<string | null>(null);
  const viewOwner = `${tabId || ''}:${floating ? 'side' : 'primary'}`;
  const fullView = !!tabId && expandedOwner === viewOwner && liftedRect.current?.owner === viewOwner && (!floating || open);
  const closeFullView = useCallback(() => setExpandedOwner(null), []);
  const sideTerminalWidth = useUIStore((state) => state.sideTerminalWidth);
  const setSideTerminalWidth = useUIStore((state) => state.setSideTerminalWidth);
  const endResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endResizeRef.current?.(), []);
  const selectedInputSurface = useUIStore((state) => (
    tabId ? (state.promptQueueInputSurfaceTabs[tabId] ?? 'history') : 'history'
  ));
  const setPromptQueueInputSurface = useUIStore((state) => state.setPromptQueueInputSurface);
  const openFullView = useCallback(() => {
    if (!tabId || fullView || (floating && !open)) return;
    const rect = frameRef.current?.getBoundingClientRect();
    const content = bodyRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height || !content?.width || !content.height) return;
    liftedRect.current = { owner: viewOwner, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      contentWidth: content.width, contentHeight: content.height };
    setPromptQueueInputSurface(tabId, 'terminal');
    setExpandedOwner(viewOwner);
  }, [tabId, floating, open, fullView, viewOwner, setPromptQueueInputSurface]);
  const terminalSelected = floating && open && selectedInputSurface === 'terminal';
  const stageOffsets = resolveStableTerminalViewportOffsets({ floating, bottomInset });
  // Pinned only means anything while this frame is the SIDE panel (floating)
  // and actually open — a closed panel reserves nothing.
  const reservesColumn = floating && open && pinned;

  useLayoutEffect(() => {
    slotRef.current?.appendChild(host);
    return () => host.remove();
  }, [host]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (!fullView) {
      if (expandedOwner !== null) setExpandedOwner(null);
      preserveTerminalViewportScroll(host, () => {
        slot.appendChild(host);
        host.removeAttribute('data-terminal-full-view-host');
        host.removeAttribute('data-terminal-full-view-tab-id');
        host.style.cssText = 'position:absolute;inset:0;pointer-events:none';
        host.scrollTop = 0; host.scrollLeft = 0;
      });
      return;
    }
    const release = acquireTerminalFullView(closeFullView);
    const bounds = slot.closest<HTMLElement>('[data-terminal-full-view-bounds]');
    const originPane = slot.closest<HTMLElement>('[data-terminal-pane-wrapper]')
      || host.querySelector<HTMLElement>(`[data-terminal-pane-wrapper="${CSS.escape(tabId!)}"]`);
    const originWorkspace = slot.closest<HTMLElement>('[data-workspace-presentation]');
    const place = () => {
      const rect = bounds?.getBoundingClientRect();
      const geometry = resolveTerminalLiftGeometry(liftedRect.current!, {
        left: Math.max(0, rect?.left ?? 0), top: Math.max(0, rect?.top ?? 0),
        right: Math.min(innerWidth, rect?.right ?? innerWidth), bottom: Math.min(innerHeight, rect?.bottom ?? innerHeight),
      });
      Object.assign(host.style, { left: `${geometry.left}px`, top: `${geometry.top}px`,
        width: `${geometry.viewportWidth}px`, height: `${geometry.viewportHeight}px` });
    };
    const validOrigin = () => {
      if (originPane?.getAttribute('data-terminal-surface-presented') === '0'
        || (originWorkspace && originWorkspace.getAttribute('data-workspace-presentation') !== 'workspace')) {
        host.style.visibility = 'hidden';
        closeFullView();
      }
    };
    const presentation = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.tabId === tabId && (detail.presented === false || detail.focused === false)) closeFullView();
    };
    const startSpace = useWorkspaceStore.getState().activeSpaceId;
    const unsubscribe = useWorkspaceStore.subscribe(state => {
      if (state.view !== 'workspace' || state.activeSpaceId !== startSpace) {
        host.style.visibility = 'hidden';
        closeFullView();
      }
    });
    const originObserver = new MutationObserver(validOrigin);
    if (originPane) originObserver.observe(originPane, { attributes: true, attributeFilter: ['data-terminal-surface-presented'] });
    if (originWorkspace) originObserver.observe(originWorkspace, { attributes: true, attributeFilter: ['data-workspace-presentation'] });
    const resize = new ResizeObserver(place);
    if (bounds) resize.observe(bounds);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A child menu/search owns its first Escape. Ordinary terminal Escape
      // exits this viewing mode before xterm can deliver it to the provider.
      if (document.querySelector('[data-tab-context-menu], [data-run-after-picker-menu], [data-terminal-search-overlay]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeFullView();
    };
    window.addEventListener('resize', place);
    window.addEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation);
    window.addEventListener('keydown', escape, true);
    preserveTerminalViewportScroll(host, () => {
      host.style.cssText = 'position:fixed;z-index:9000;pointer-events:auto;overflow:auto';
      host.style.setProperty('--terminal-lift-width', `${liftedRect.current!.width}px`);
      host.style.setProperty('--terminal-lift-height', `${liftedRect.current!.height}px`);
      host.style.setProperty('--terminal-lift-content-width', `${liftedRect.current!.contentWidth}px`);
      host.style.setProperty('--terminal-lift-content-height', `${liftedRect.current!.contentHeight}px`);
      host.setAttribute('data-terminal-full-view-host', '');
      host.setAttribute('data-terminal-full-view-tab-id', tabId!);
      document.body.appendChild(host);
      place();
    });
    validOrigin();
    console.log('[TerminalFullView] open tab=' + tabId?.slice(-12));
    return () => {
      release(); unsubscribe(); resize.disconnect(); originObserver.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, presentation);
      window.removeEventListener('keydown', escape, true);
      console.log('[TerminalFullView] return tab=' + tabId?.slice(-12));
    };
  }, [closeFullView, expandedOwner, fullView, host, tabId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const request = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-floating-terminal]') !== frame) return;
      if ((event as CustomEvent).detail?.tabId !== tabId) return;
      event.stopPropagation(); openFullView();
    };
    frame.addEventListener(TERMINAL_FULL_VIEW_REQUEST, request);
    return () => frame.removeEventListener(TERMINAL_FULL_VIEW_REQUEST, request);
  }, [openFullView, tabId]);

  useEffect(() => {
    if (!floating || !open || !tabId) return;
    let second: number | null = null;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const slot = slotRef.current;
        if (slot?.closest('[data-terminal-surface-presented="0"]')) return;
        const workspace = slot?.closest('[data-workspace-presentation]');
        if (workspace && workspace.getAttribute('data-workspace-presentation') !== 'workspace') return;
        const ownerPane = slot?.closest('[data-terminal-pane-wrapper]')
          || host.querySelector(`[data-terminal-pane-wrapper="${CSS.escape(tabId)}"]`);
        const paneIndex = ownerPane?.getAttribute('data-pane-event-index');
        if (paneIndex != null && Number(paneIndex) !== useWorkspaceStore.getState().splitFocusedIndex) return;
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
  }, [floating, open, tabId, fullView, host]);

  useEffect(() => {
    if (!floating || open || !tabId || selectedInputSurface !== 'terminal') return;
    setPromptQueueInputSurface(tabId, 'history');
  }, [floating, open, selectedInputSurface, setPromptQueueInputSurface, tabId]);

  const handleResizePointerDown = useCallback((event: React.PointerEvent) => {
    if (!floating || !open || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    endResizeRef.current?.();
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const releaseCursor = acquireInteractionCursor('col-resize', { target, pointerId });
    const startX = event.clientX;
    const startWidth = sideTerminalWidth;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!(moveEvent.buttons & 1)) { onUp(); return; }
      const next = startWidth + startX - moveEvent.clientX;
      setSideTerminalWidth(Math.max(SIDE_TERMINAL_MIN_WIDTH, Math.min(SIDE_TERMINAL_MAX_WIDTH, next)));
    };
    const onUp = () => {
      if (endResizeRef.current !== onUp) return;
      endResizeRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onPointerEnd);
      target.removeEventListener('lostpointercapture', onPointerEnd);
      window.removeEventListener('blur', onUp);
      window.removeEventListener('pointercancel', onPointerEnd);
      releaseCursor();
    };
    const onPointerEnd = (ev: PointerEvent) => { if (ev.pointerId === pointerId) onUp(); };
    endResizeRef.current = onUp;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onPointerEnd);
    target.addEventListener('lostpointercapture', onPointerEnd);
    window.addEventListener('blur', onUp);
    window.addEventListener('pointercancel', onPointerEnd);
  }, [floating, open, setSideTerminalWidth, sideTerminalWidth]);

  const isPresented = !floating || open;

  return (
    <div
      data-floating-terminal-stage
      data-terminal-viewport-shift={stageOffsets.translateY}
      style={{
        position: 'absolute',
        top: stageOffsets.top,
        left: 0,
        // Pinned → the stage ends where the panel begins, so the centre is
        // narrower and nothing is covered. Unpinned → full width, panel on top.
        right: reservesColumn ? sideTerminalWidth : 0,
        bottom: stageOffsets.bottom,
        transform: stageOffsets.translateY
          ? `translateY(${stageOffsets.translateY}px)`
          : undefined,
        pointerEvents: 'none',
        // The composer only shifts/crops this stable-size stage. It must not
        // change xterm rows and trigger a PTY resize/redraw.
        // Side content overlays the center; the stationary Run after service
        // host remains above it (140). Chrome reserves its shared top rail.
        zIndex: floating ? 130 : (allowSideOverlayOverflow ? undefined : 0),
      }}
    >
      <div ref={slotRef} style={{ position: 'absolute', inset: 0 }} />
      {createPortal(<div
        ref={frameRef}
        data-floating-terminal
        data-floating-terminal-tab-id={tabId || ''}
        data-floating-terminal-side={floating ? '1' : '0'}
        data-floating-terminal-open={isPresented ? '1' : '0'}
        data-floating-terminal-selected={terminalSelected ? '1' : '0'}
        // A CLOSED side panel is closed for the keyboard too.
        //
        // It is only hidden by `translateX(100%)` — the terminal stays mounted
        // (it must: its PTY geometry and scrollback have to survive the toggle),
        // and a merely translated element is still visible to the browser's
        // focus order. So Tab walked into the off-screen xterm, the browser
        // scrolled the whole pane sideways to "reveal" the thing it had just
        // focused, and the panel appeared to open — dragging the layout and the
        // composer with it. The next Cmd+] then read as "opens again, closes
        // only on the press after that": the state was still `false`, so one
        // press set it to true, and only the following one closed it.
        //
        // Reported live 2026-08-17 22:22 MSK. `inert` (not `tabIndex={-1}`)
        // because the whole SUBTREE must leave the focus order — the xterm
        // helper textarea is a descendant, not this node. React 19 passes a
        // boolean `inert` through as the real attribute.
        inert={floating && !open}
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
          left: 'auto',
          // Pinned: sits just outside the shortened stage, i.e. in its own
          // column. Unpinned: overlays the centre's right edge as before.
          right: reservesColumn ? -sideTerminalWidth : 0,
          bottom: 0,
          width: sideTerminalWidth,
          // Боковой терминал НЕ сжимается под узкое окно.
          //
          // Раньше здесь стоял `maxWidth: 100%`, и в узкой колонке панель
          // послушно ужималась — вместе с ней ужимался терминал, и в окне,
          // которое человек сделал маленьким, «боковой терминал открывается, а
          // там нихуя нет». Теперь панель держит свою ширину и вылезает за край
          // окна: обрезанный, но рабочий терминал лучше, чем помещающийся и
          // нечитаемый. Сам терминал внутри тоже держит свой минимум и honestly
          // сообщает об обрезке (Terminal.tsx::data-terminal-clipped).
          maxWidth: 'none',
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
          left: 0, top: 0, right: 0, bottom: 0,
          overflow: 'visible',
          pointerEvents: 'auto',
          background: '#1a1a1a',
        }}
      >
        <div
          data-floating-terminal-titlebar
          style={{
            height: floating ? 30 : 0,
            // The stable PTY stage moves up behind the composer. Its controls
            // must stay at the visible pane top; translating chrome alone
            // keeps the body size/rows and retained xterm untouched.
            position: 'relative',
            zIndex: 2,
            transform: floating && open && !fullView
              ? `translateY(${-stageOffsets.translateY + HISTORY_TOP_CHROME_INSET}px)` : undefined,
            // НЕ 'visible': явное значение перебивало бы visibility:hidden
            // обёртки окна чужого пространства (TerminalArea) — шапка панели
            // просвечивала бы из скрытого пространства. undefined наследует.
            visibility: floating ? undefined : 'hidden',
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
          {/* Icon only, no tab name: this titlebar labels a SURFACE ("this is
              the terminal"), not a tab. The tab is already named in the pane
              header right above, and repeating it here read as a second,
              competing tab chip. */}
          <SquareTerminal size={13} />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fullView ? tabName : null}
          </div>
          <ControlHint label={fullView ? 'Вернуть терминал в окно' : 'Показать терминал поверх окон'}>
            <button type="button" data-terminal-full-view-toggle={tabId || ''}
              aria-label={fullView ? 'Вернуть терминал в окно' : 'Показать терминал поверх окон'}
              onPointerDown={event => event.preventDefault()}
              onClick={fullView ? closeFullView : openFullView}
              style={{width:24,height:24,border:0,padding:0,background:'transparent',color:fullView?'#c4b5fd':'#8a8a8f',
                display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}}>
              {fullView ? <Undo2 size={14} /> : <BringToFront size={14} />}
            </button>
          </ControlHint>
          <ControlHint label="Закрыть терминал">
            <button
              type="button"
              aria-label="Hide terminal"
              onClick={() => { closeFullView(); if (floating) onClose(); }}
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
          ref={bodyRef}
          data-terminal-view-body
          style={{
            position: floating ? 'relative' : 'absolute',
            inset: floating ? undefined : 0,
            flex: floating ? 1 : undefined,
            minHeight: 0,
            ...(!floating && allowSideOverlayOverflow
              ? { overflowX: 'visible' as const, overflowY: 'clip' as const }
              : { overflow: 'hidden' as const }),
            background: '#1a1a1a',
          }}
        >
          <div data-terminal-view-content style={{ position: 'absolute', left: 0, top: 0,
            width: '100%', height: '100%' }}>
          {children}
          {floating && open ? searchNode : null}
          </div>
        </div>

        {fullView && !floating && <button type="button" data-terminal-full-view-toggle={tabId || ''}
          aria-label="Вернуть терминал в окно" title="Вернуть терминал в окно"
          onClick={closeFullView} style={{position:'absolute',right:6,top:6,zIndex:10002,width:24,height:24,
            display:'flex',alignItems:'center',justifyContent:'center',background:'#2b2340',color:'#c4b5fd',
            border:'1px solid #a78bfa',borderRadius:4,cursor:'pointer'}}><Undo2 size={14}/></button>}

        {floating && !fullView && (
          <div
            data-floating-terminal-resize="w"
            onPointerDown={handleResizePointerDown}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: 'col-resize',
              touchAction: 'none',
              userSelect: 'none',
              zIndex: 10,
              background: 'transparent',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = '#5b9cf5'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          />
        )}
      </div>, host)}
    </div>
  );
}
