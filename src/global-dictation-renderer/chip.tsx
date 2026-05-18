// Chip overlay — always-on-top, transparent, frame-less.
//
// Two visual modes driven by `state` from main:
//   idle      → centered round button (44px) with mic icon.
//                Click → opens the popover menu (Open App / Speak / Copy).
//                Press-and-hold (>180ms without click distance threshold)
//                + mouse-move → drag the chip across the desktop.
//   recording → row of three: X (cancel) | Auto-Enter pill | Stop (square).
//
// IMPORTANT design constraints from the user:
//   - No pointer-cursor anywhere on the chip (the user dislikes it).
//   - No opacity / transparency anywhere on visible elements (the BG of the
//     window itself is transparent, but every BUTTON has a solid fill).
//   - Drag should be smooth — main process moves the window via setBounds.
//   - Position is persisted as a fraction of the work area so it survives
//     monitor changes.

import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';

const { ipcRenderer } = window.require('electron');

function dlog(msg: string) {
  try { ipcRenderer.send('log:renderer', '[GD:chip] ' + msg); } catch {}
}

type State = 'idle' | 'recording' | 'delivering';

type StatePayload = {
  state: State;
  sessionAutoEnter: boolean;
  menuOpen: boolean;
  autoEnterDefault: boolean;
  transcriptFontSize: number;
  transcriptLines: number;
};

function ChipApp() {
  const [state, setState] = useState<State>('idle');
  const [autoEnter, setAutoEnter] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    dlog('mounted');
    const handler = (_e: any, payload: StatePayload) => {
      dlog('state push: ' + JSON.stringify(payload));
      setState(payload.state);
      setAutoEnter(!!payload.sessionAutoEnter);
      setMenuOpen(!!payload.menuOpen);
    };
    ipcRenderer.on('global-dict:state', handler);
    return () => { ipcRenderer.removeListener('global-dict:state', handler); };
  }, []);

  // ─── Drag handling ───
  // Pointer-based drag of the entire window. We track the offset between
  // mousedown screen position and window origin, then on every mousemove tell
  // main to move the window.
  //
  // CRITICAL: startDrag MUST be synchronous. Earlier we awaited an IPC for
  // the window position; between mousedown and the await-resolve, mouseup
  // could fire (dragRef still null → onUp early-returns), then dragRef gets
  // set to active=true AFTER, and the next mousemove starts dragging the
  // chip without any button held — the chip ended up following the cursor.
  //
  // We use window.screenX/window.screenY (Electron exposes these on the
  // BrowserWindow renderer) which give the current window origin in screen
  // coords synchronously. screenX/Y on the MouseEvent are also in screen
  // coords, so the difference is the constant drag offset.
  const dragRef = useRef<{ active: boolean; offsetX: number; offsetY: number; downX: number; downY: number; moved: boolean } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !d.active) return;
      // Defensive: if mouseup was missed (rare race), buttons==0 means no
      // primary button is being held. Stop tracking.
      if (e.buttons === 0) {
        d.active = false;
        if (d.moved) {
          dlog('drag-end (buttons==0 safety)');
          ipcRenderer.send('global-dict:chip:drag-end');
        }
        return;
      }
      const dx = e.screenX - d.downX;
      const dy = e.screenY - d.downY;
      if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true;
      if (d.moved) {
        ipcRenderer.send('global-dict:chip:move-to', {
          x: e.screenX - d.offsetX,
          y: e.screenY - d.offsetY,
        });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d || !d.active) return;
      d.active = false;
      if (d.moved) {
        dlog('drag-end');
        ipcRenderer.send('global-dict:chip:drag-end');
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    // Synchronous — read window screen origin from window.screenX/screenY.
    const winX = window.screenX;
    const winY = window.screenY;
    dragRef.current = {
      active: true,
      offsetX: e.screenX - winX,
      offsetY: e.screenY - winY,
      downX: e.screenX,
      downY: e.screenY,
      moved: false,
    };
    dlog('drag-start screen=' + e.screenX + ',' + e.screenY + ' winPos=' + winX + ',' + winY);
  };

  const onIdleClick = (e: React.MouseEvent) => {
    // Suppress click after drag.
    if (dragRef.current && dragRef.current.moved) {
      dlog('idle click suppressed (drag occurred)');
      return;
    }
    dlog('idle click → open menu');
    e.preventDefault();
    ipcRenderer.invoke('global-dict:menu:open').catch(() => {});
  };

  const onCancelClick = (e: React.MouseEvent) => {
    e.preventDefault();
    dlog('cancel click');
    ipcRenderer.invoke('global-dict:cancel').catch(() => {});
  };

  const onStopClick = (e: React.MouseEvent) => {
    e.preventDefault();
    dlog('stop click');
    ipcRenderer.invoke('global-dict:stop').catch(() => {});
  };

  const onToggleAutoEnter = (e: React.MouseEvent) => {
    e.preventDefault();
    const next = !autoEnter;
    setAutoEnter(next);
    dlog('toggle autoEnter → ' + next);
    ipcRenderer.invoke('global-dict:set-session-auto-enter', next).catch(() => {});
  };

  const isRecording = state === 'recording' || state === 'delivering';
  // Idle button shows mic by default; when menu is open it morphs into an X.
  const showX = menuOpen;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Idle (round) — opacity-fade with the recording row. */}
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isRecording ? 0 : 1,
          transform: isRecording ? 'scale(0.7)' : 'scale(1)',
          transition: 'opacity 180ms ease, transform 220ms cubic-bezier(.4,1.7,.5,1)',
          pointerEvents: isRecording ? 'none' : 'auto',
        }}
      >
        <button
          onClick={onIdleClick}
          onMouseDown={startDrag}
          aria-label="Open dictation menu"
          style={{
            position: 'relative',
            width: 44, height: 44,
            borderRadius: '50%',
            border: 'none',
            cursor: 'default',
            background: showX ? '#3a3a3d' : '#1f1f22',
            color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0,
            boxShadow: '0 2px 8px rgba(0,0,0,0.55)',
            transition: 'background 180ms ease',
            overflow: 'hidden',
          }}
        >
          {/* Both icons absolutely-positioned, cross-faded + rotated.
              Mic visible at rest; X visible when the menu is open. */}
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: showX ? 0 : 1,
            transform: showX ? 'rotate(-90deg) scale(0.6)' : 'rotate(0) scale(1)',
            transition: 'opacity 180ms ease, transform 220ms cubic-bezier(.4,1.7,.5,1)',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
          </span>
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: showX ? 1 : 0,
            transform: showX ? 'rotate(0) scale(1)' : 'rotate(90deg) scale(0.6)',
            transition: 'opacity 180ms ease, transform 220ms cubic-bezier(.4,1.7,.5,1)',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </span>
        </button>
      </div>

      {/* Recording row — fades in when isRecording. */}
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          opacity: isRecording ? 1 : 0,
          transform: isRecording ? 'scale(1)' : 'scale(0.85)',
          transition: 'opacity 200ms ease 60ms, transform 220ms cubic-bezier(.4,1.7,.5,1) 60ms',
          pointerEvents: isRecording ? 'auto' : 'none',
        }}
      >
        <PressableButton onClick={onCancelClick} ariaLabel="Cancel" bg="#3a3a3d" hoverBg="#4a4a4d">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </PressableButton>

        <PressablePill
          onClick={onToggleAutoEnter}
          active={autoEnter}
          ariaLabel="Toggle Auto-Enter"
        >Auto-Enter</PressablePill>

        {/* Stop — same dark family as the other two; inner square is white. */}
        <PressableButton onClick={onStopClick} ariaLabel="Stop & paste" bg="#1f1f22" hoverBg="#2a2a2d">
          <span style={{ display: 'block', width: 12, height: 12, background: '#fff', borderRadius: 2 }} />
        </PressableButton>
      </div>
    </div>
  );
}

// Round 38×38 button with hover and active (mousedown flash) feedback.
function PressableButton({ children, onClick, ariaLabel, bg, hoverBg }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  ariaLabel: string;
  bg: string;
  hoverBg: string;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        width: 38, height: 38,
        borderRadius: '50%',
        border: 'none',
        cursor: 'default',
        background: pressed ? bg : (hover ? hoverBg : bg),
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: 'background 120ms ease, transform 100ms ease',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 0,
      }}
    >{children}</button>
  );
}

function PressablePill({ children, onClick, ariaLabel, active }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  ariaLabel: string;
  active: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const bg = active ? '#7a5af8' : '#2c2c2e';
  const hoverBg = active ? '#8b6dff' : '#3a3a3d';
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        height: 38, padding: '0 14px',
        borderRadius: 19,
        border: 'none',
        cursor: 'default',
        background: pressed ? bg : (hover ? hoverBg : bg),
        color: '#fff',
        fontSize: 12,
        fontWeight: 500,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
        transform: pressed ? 'scale(0.96)' : 'scale(1)',
        transition: 'background 120ms ease, transform 100ms ease',
      }}
    >{children}</button>
  );
}

createRoot(document.getElementById('root')!).render(<ChipApp />);
