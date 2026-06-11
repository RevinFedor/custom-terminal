// Voice-dictation toggle for the Claude control bar.
//
// UX flow:
//   click → record-state ON instantly (no connecting spinner — audio capture
//   starts at the same instant locally; PCM is buffered until ws.onopen and
//   then flushed). Floating window appears immediately, positioned ABOVE the
//   mic button. Live transcript streams into the window line-by-line as
//   Soniox sends frames. Click again or click STOP in the window → recording
//   ends, captured text is:
//     - PTY-Claude tab → typed into the TUI input via terminal:input
//     - SDK tab        → injected into the composer textarea
//     - terminal/no input → saved to dictation history only
//   In every mode the transcript is also appended to dictation history so
//   the project-toolbar dropdown can recopy it later.
//
// Floating window architecture: anchored to the mic button via DOMRect from
// onLayoutEffect, position:fixed in a Portal. NOT a child of the button so
// overflow:hidden ancestors don't clip it.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { DictationSession } from '../../utils/dictation';
import { appendDictationEntry } from '../../utils/dictationHistory';
import { DictationHistoryPopover } from './DictationHistoryButton';

const { ipcRenderer } = window.require('electron');

export const DICTATION_STATE_EVENT = 'dictation:state';
export const DICTATION_STOP_AND_DELIVER_EVENT = 'dictation:stop-and-deliver';
export const DICTATION_DELIVERED_EVENT = 'dictation:delivered';

interface Props {
  tabId: string;
  sessionType: 'claude' | 'gemini' | 'codex';
}

type MicMode = 'sdk' | 'pty-claude' | 'pty-codex' | 'terminal';

function useTargetMode(tabId: string): MicMode {
  const tabType = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.tabType || 'terminal';
    }
    return 'terminal';
  });
  const commandType = useWorkspaceStore((s) => {
    for (const [, ws] of s.openProjects) {
      const t = ws.tabs.get(tabId);
      if (t) return t.commandType;
    }
    return null;
  });
  if (tabType === 'claude-sdk') return 'sdk';
  if (commandType === 'claude') return 'pty-claude';
  if (commandType === 'codex') return 'pty-codex';
  return 'terminal';
}

export default function MicButton({ tabId }: Props) {
  const showToast = useUIStore((s) => s.showToast);
  const mode = useTargetMode(tabId);

  // Two simple states: 'idle' or 'recording'. Connecting is invisible — audio
  // capture starts the instant getUserMedia resolves (~50ms), PCM is buffered
  // locally until ws opens. Stopping is also brief (≤500ms) but shown via the
  // STOP button's loader inside the floating window, not on the toolbar btn.
  const [recording, setRecording] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [final, setFinal] = useState('');
  const [partial, setPartial] = useState('');
  // Cmd+click on the mic opens the dictation-history popover (the old toolbar
  // `history` chip is gone). Plain click toggles recording as before.
  const [historyOpen, setHistoryOpen] = useState(false);
  const sessionRef = useRef<DictationSession | null>(null);
  const finalizedSessionRef = useRef<DictationSession | null>(null);
  const pendingSubmitRequestsRef = useRef<string[]>([]);
  const statusRef = useRef({ recording: false, stopping: false });
  const btnRef = useRef<HTMLButtonElement>(null);

  const publishState = (next: { recording: boolean; stopping: boolean }) => {
    statusRef.current = next;
    window.dispatchEvent(new CustomEvent(DICTATION_STATE_EVENT, {
      detail: { tabId, ...next, mode },
    }));
  };

  useEffect(() => {
    publishState({ recording, stopping });
  }, [tabId, mode, recording, stopping]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent(DICTATION_STATE_EVENT, {
        detail: { tabId, recording: false, stopping: false, mode },
      }));
    };
  }, [tabId, mode]);

  const flushSubmitRequests = (payload: { success: boolean; delivered: boolean; hadText: boolean; error?: string }) => {
    const requestIds = pendingSubmitRequestsRef.current.splice(0);
    requestIds.forEach((requestId) => {
      window.dispatchEvent(new CustomEvent(DICTATION_DELIVERED_EVENT, {
        detail: { tabId, requestId, ...payload },
      }));
    });
  };

  const finalizeStop = async (session: DictationSession, source: string) => {
    if (finalizedSessionRef.current === session) return;
    finalizedSessionRef.current = session;
    if (sessionRef.current === session) sessionRef.current = null;

    ipcRenderer.send('log:renderer', '[MicButton] onStopped source=' + source);
    const captured = (session.getText() || '').trim();
    let success = true;
    let delivered = false;
    let error: string | undefined;
    if (captured) {
      appendDictationEntry(captured);
      try {
        const result = await deliverFinal(captured, mode, tabId);
        success = result.success;
        delivered = result.delivered;
        error = result.error;
      } catch (e: any) {
        success = false;
        error = e?.message || String(e);
      }
    }
    if (!success && error) showToast('Dictation deliver: ' + error, 'error');
    publishState({ recording: false, stopping: false });
    setRecording(false);
    setStopping(false);
    flushSubmitRequests({ success, delivered, hadText: !!captured, error });
  };

  const start = async () => {
    if (recording || stopping) return;
    ipcRenderer.send('log:renderer', '[MicButton] start mode=' + mode);
    setFinal('');
    setPartial('');
    finalizedSessionRef.current = null;
    publishState({ recording: true, stopping: false });
    // Flip UI to recording IMMEDIATELY so floating window appears in the same
    // frame as the click. Don't wait for getUserMedia.
    setRecording(true);
    const session = new DictationSession({
      fetchToken: async () => {
        const r = await ipcRenderer.invoke('soniox:mint-token');
        if (!r?.api_key) throw new Error('no api_key in token response');
        return r.api_key as string;
      },
      onUpdate: ({ final, partial }) => {
        setFinal(final);
        setPartial(partial);
      },
      onConnected: () => {
        ipcRenderer.send('log:renderer', '[MicButton] onConnected');
      },
      onError: (msg) => {
        ipcRenderer.send('log:renderer', '[MicButton] onError ' + msg);
        // Silent "socket error" if we initiated stop — it's just teardown noise.
        if (msg === 'socket error' && (stopping || !recording)) return;
        showToast('Dictation: ' + msg, 'error');
      },
      onStopped: () => { void finalizeStop(session, 'onStopped'); },
      languageHints: ['en', 'ru'],
    });
    sessionRef.current = session;
    await session.start();
  };

  const stop = async () => {
    if (stopping) return;
    const s = sessionRef.current;
    if (!s) {
      sessionRef.current = null;
      publishState({ recording: false, stopping: false });
      setRecording(false);
      setStopping(false);
      flushSubmitRequests({ success: true, delivered: false, hadText: false });
      return;
    }
    ipcRenderer.send('log:renderer', '[MicButton] stop');
    publishState({ recording: true, stopping: true });
    setStopping(true);
    await s.stop();
    // Force reset if onStopped never fires.
    setTimeout(() => {
      if (sessionRef.current === s) {
        ipcRenderer.send('log:renderer', '[MicButton] onStopped never fired → force reset');
        void finalizeStop(s, 'fallback');
      }
    }, 4000);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const { tabId: targetTabId, requestId } = (e as CustomEvent).detail || {};
      if (targetTabId !== tabId || typeof requestId !== 'string') return;
      if (!pendingSubmitRequestsRef.current.includes(requestId)) {
        pendingSubmitRequestsRef.current.push(requestId);
      }
      const status = statusRef.current;
      if (status.recording && !status.stopping) {
        void stop();
      } else if (!status.recording && !status.stopping) {
        flushSubmitRequests({ success: true, delivered: false, hadText: false });
      }
    };
    window.addEventListener(DICTATION_STOP_AND_DELIVER_EVENT, handler);
    return () => window.removeEventListener(DICTATION_STOP_AND_DELIVER_EVENT, handler);
  }, [tabId, recording, stopping]);

  const onClick = (e: React.MouseEvent) => {
    // Cmd/Ctrl+click → open dictation history instead of recording. (Meta on
    // macOS, Ctrl elsewhere.) Never toggles recording in this branch.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setHistoryOpen(o => !o);
      return;
    }
    if (stopping) return;
    if (recording) stop();
    else start();
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={onClick}
        title={recording ? 'Click to stop' : 'Start voice dictation (Soniox) · ⌘-click for history'}
        aria-label={recording ? 'Stop dictation' : 'Start voice dictation'}
        style={{
          height: 22,
          width: 26,
          padding: 0,
          marginLeft: 2,
          background: recording ? 'rgba(218, 119, 86, 0.18)' : 'transparent',
          border: `1px solid ${recording ? 'rgba(218,119,86,0.55)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: 4,
          color: recording ? '#FF9466' : '#bbb',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background-color 0.12s, color 0.12s, border-color 0.12s',
          flexShrink: 0,
          position: 'relative',
        }}
        onMouseEnter={(e) => {
          if (recording) return;
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
          (e.currentTarget as HTMLButtonElement).style.color = '#fff';
        }}
        onMouseLeave={(e) => {
          if (recording) return;
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = '#bbb';
        }}
      >
        <MicIcon recording={recording} />
        {recording && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -2, right: -2,
              width: 6, height: 6,
              borderRadius: '50%',
              background: '#ef4444',
              boxShadow: '0 0 4px rgba(239,68,68,0.8)',
              animation: 'mic-pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
      </button>

      {recording && (
        <FloatingTranscript
          anchorRef={btnRef}
          final={final}
          partial={partial}
          stopping={stopping}
          onStop={stop}
        />
      )}

      {/* Dictation history — opened via ⌘-click on the mic (was a separate
          toolbar chip). Anchored above the button via a Portal. */}
      <DictationHistoryPopover
        anchorRef={btnRef}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />

      <style>{`
        @keyframes mic-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.78); }
        }
        @keyframes mic-spin {
          to { transform: rotate(360deg); }
        }
        @keyframes mic-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}

// Where the captured text lands when the user clicks Stop.
async function deliverFinal(text: string, mode: MicMode, tabId: string): Promise<{ success: boolean; delivered: boolean; error?: string }> {
  if (mode === 'pty-claude' || mode === 'pty-codex') {
    // safePasteAndSubmit with submit:false types into the TUI input without
    // pressing Enter. User can then edit / hit Enter themselves.
    const result = await ipcRenderer.invoke('terminal:paste', { tabId, content: text, submit: false });
    if (!result?.success) {
      return { success: false, delivered: false, error: result?.error || 'terminal:paste failed' };
    }
    return { success: true, delivered: true };
  } else if (mode === 'sdk') {
    // ClaudeSDKTab listens for this event and writes via native setter to
    // bypass assistant-ui's controlled-input ping-pong.
    window.dispatchEvent(new CustomEvent('claude-sdk:dictation-deliver', {
      detail: { tabId, text },
    }));
    return { success: true, delivered: true };
  }
  // terminal mode → history only; user copies from the dropdown.
  return { success: true, delivered: false };
}

function MicIcon({ recording }: { recording: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={recording ? 2 : 1.7}
         strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  );
}

// Live transcript window anchored above the mic button. Rendered into a
// portal so overflow:hidden on the control bar doesn't clip it; position is
// recomputed every animation frame while recording so it follows the button
// if the window is resized.
function FloatingTranscript({ anchorRef, final, partial, stopping, onStop }: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  final: string;
  partial: string;
  stopping: boolean;
  onStop: () => void;
}) {
  // Position state — read once on mount, re-read on every rAF tick so it
  // tracks resizes / scrolls without an explicit listener.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = anchorRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        // Anchor BOTTOM of floating window to TOP of button minus 6px gap.
        // Anchor LEFT of floating window to LEFT of button, then clamp so it
        // doesn't run past viewport edge.
        const width = 320;
        let left = r.left;
        if (left + width > window.innerWidth - 8) {
          left = window.innerWidth - width - 8;
        }
        if (left < 8) left = 8;
        const bottom = window.innerHeight - r.top + 6;
        setPos((prev) => {
          if (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.bottom - bottom) < 0.5) return prev;
          return { left, bottom };
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchorRef]);

  // Auto-scroll the transcript area to keep latest partial visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [final, partial]);

  if (!pos) return null;

  // Render outside the button into <body> so we're not clipped by the
  // control bar's overflow:hidden.
  return createPortal(
    <div
      role="dialog"
      aria-label="Voice dictation"
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        width: 320,
        background: '#0e0e0e',
        border: '1px solid rgba(218,119,86,0.45)',
        borderRadius: 8,
        boxShadow: '0 10px 28px rgba(0,0,0,0.65)',
        // Tight vertical padding on the shell — header sits flush against the
        // top edge as requested. Horizontal padding kept for legibility of
        // the transcript text.
        padding: '0 8px 6px',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 9999,
        animation: 'mic-fade-in 120ms ease-out',
      }}
    >
      {/* Header row — zero vertical padding (height = button height). */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0',
        height: 22,
        fontSize: 10,
        letterSpacing: 0.6,
        color: '#FF9466',
        fontWeight: 600,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: stopping ? '#888' : '#ef4444',
            boxShadow: stopping ? 'none' : '0 0 6px rgba(239,68,68,0.85)',
            animation: stopping ? 'none' : 'mic-pulse 1.2s ease-in-out infinite',
          }} />
          {stopping ? 'STOPPING…' : 'DICTATING'}
        </span>
        <button
          onClick={onStop}
          disabled={stopping}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.22)',
            borderRadius: 4,
            color: stopping ? '#666' : '#ddd',
            fontSize: 10,
            padding: '2px 10px',
            cursor: stopping ? 'default' : 'pointer',
            letterSpacing: 0.3,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
          title={stopping ? 'Finalizing…' : 'Stop & deliver to input'}
        >
          {stopping && (
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth={2.6} strokeLinecap="round"
                 style={{ animation: 'mic-spin 0.7s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          STOP
        </button>
      </div>
      <div
        ref={scrollRef}
        style={{
          // Fixed height (~6 lines @ 13px/1.42) — popup must NOT grow with
          // content; overflow scrolls instead. 6 lines = 5 lines visible + 1
          // extra for breathing room as requested.
          height: 110,
          overflowY: 'auto',
          marginTop: 4,
          color: '#e0e0e0',
          fontSize: 13,
          lineHeight: 1.42,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {final ? <span>{final}</span> : null}
        {partial ? (
          <span style={{ color: '#aaa', fontStyle: 'italic' }}>{partial}</span>
        ) : null}
        {!final && !partial && (
          <span style={{ color: '#666' }}>listening…</span>
        )}
      </div>
    </div>,
    document.body
  );
}
