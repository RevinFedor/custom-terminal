// Recording overlay — frame-less, transparent, always-on-top, focusable:false.
//
// IMPORTANT design contract:
//   - NO bottom toolbar. All recording controls (cancel/auto-enter/stop) live
//     in the chip while recording. This window only shows the transcript.
//   - NO opacity / no backdrop-blur anywhere. Solid background colour.
//   - The window's HEIGHT GROWS with content. Starts at "header only" (zero
//     lines of transcript), expands by one line-height each time a new line
//     of transcript appears, up to `transcriptLines` from settings. Past that
//     limit → internal scroll, window height stays at the maximum.
//   - Font size & max lines are user-settable (from settings).

import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { DictationSession } from '../renderer/utils/dictation';

const { ipcRenderer } = window.require('electron');

function dlog(msg: string) {
  try { ipcRenderer.send('log:renderer', '[GD:rec] ' + msg); } catch {}
}

type Phase = 'recording' | 'stopping';

const HEADER_H = 36;          // visual header strip height
const FRAME_PAD = 12;         // top+bottom outer padding (6+6) accounted for by window
const MIN_LINES_RENDERED = 0; // start collapsed (header only)

// Linewidth heuristic — character count per line at given font-size & window width.
// Doesn't have to be perfect; we only use it to compute "how many lines does
// this text wrap into" for window-height estimation.
function approxLineCount(text: string, fontSize: number, contentWidth: number): number {
  if (!text) return 0;
  // Average char width ≈ 0.55 × fontSize for SF Pro / Inter at small sizes.
  const charsPerLine = Math.max(1, Math.floor(contentWidth / (fontSize * 0.55)));
  let total = 0;
  for (const para of text.split(/\n+/)) {
    if (!para) { total += 1; continue; }
    total += Math.ceil(para.length / charsPerLine);
  }
  return Math.max(1, total);
}

function RecordingApp() {
  const [phase, setPhase] = useState<Phase>('recording');
  const [final, setFinal] = useState('');
  const [partial, setPartial] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [maxLines, setMaxLines] = useState(5);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const sessionRef = useRef<DictationSession | null>(null);
  const finalRef = useRef('');
  const partialRef = useRef('');
  const stoppedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastReportedLinesRef = useRef(-1);

  // Initial load settings + start Soniox.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await ipcRenderer.invoke('global-dict:settings:get');
        if (mounted && s) {
          if (typeof s.transcriptFontSize === 'number') setFontSize(s.transcriptFontSize);
          if (typeof s.transcriptLines === 'number') setMaxLines(s.transcriptLines);
        }
      } catch {}

      const sess = new DictationSession({
        fetchToken: async () => {
          const r = await ipcRenderer.invoke('soniox:mint-token');
          return r.api_key;
        },
        onUpdate: ({ final: f, partial: p }) => {
          finalRef.current = f;
          partialRef.current = p;
          setFinal(f);
          setPartial(p);
          requestAnimationFrame(() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          });
        },
        onError: (m) => setErrMsg(m),
        onStopped: () => {
          if (stoppedRef.current) {
            dlog('onStopped: already stopped, skip');
            return;
          }
          stoppedRef.current = true;
          const text = (finalRef.current + partialRef.current).trim();
          dlog('onStopped → sending rec:final len=' + text.length);
          ipcRenderer.send('global-dict:rec:final', { text });
        },
      });
      sessionRef.current = sess;
      sess.start();
    })();

    return () => {
      mounted = false;
      try { sessionRef.current?.stop(); } catch {}
    };
  }, []);

  // ─── Adaptive window height ───
  // On every transcript change, compute how many lines we'd render at the
  // current fontSize and window width. Clamp to [MIN_LINES_RENDERED, maxLines]
  // and tell main to resize.
  useEffect(() => {
    const text = final + partial;
    const contentWidth = window.innerWidth - 24; // padding 12+12
    const wantLines = Math.min(maxLines, approxLineCount(text, fontSize, contentWidth));
    if (wantLines === lastReportedLinesRef.current) return;
    lastReportedLinesRef.current = wantLines;
    const lineHeight = Math.round(fontSize * 1.5);
    const transcriptH = wantLines === 0 ? 0 : (lineHeight * wantLines + 12); // 12 padding around transcript
    const totalH = HEADER_H + transcriptH + FRAME_PAD;
    dlog('resize wantLines=' + wantLines + ' totalH=' + totalH);
    ipcRenderer.send('global-dict:rec:resize', { height: totalH });
  }, [final, partial, fontSize, maxLines]);

  // Listen for main-initiated stop/cancel.
  useEffect(() => {
    const onStop = () => doStop();
    const onCancel = () => doCancel();
    ipcRenderer.on('global-dict:rec:stop-request', onStop);
    ipcRenderer.on('global-dict:rec:cancel-request', onCancel);
    return () => {
      ipcRenderer.removeListener('global-dict:rec:stop-request', onStop);
      ipcRenderer.removeListener('global-dict:rec:cancel-request', onCancel);
    };
  }, []);

  const doStop = () => {
    if (phase === 'stopping') return;
    dlog('doStop ENTER');
    setPhase('stopping');
    try { sessionRef.current?.stop(); dlog('doStop: session.stop() called'); }
    catch (e: any) { dlog('doStop: session.stop() threw: ' + (e?.message || e)); }
    setTimeout(() => {
      if (stoppedRef.current) {
        dlog('doStop 3s-fallback: already stopped, skip');
        return;
      }
      stoppedRef.current = true;
      const text = (finalRef.current + partialRef.current).trim();
      dlog('doStop 3s-fallback FIRED → sending rec:final len=' + text.length);
      ipcRenderer.send('global-dict:rec:final', { text });
    }, 3000);
  };

  const doCancel = () => {
    stoppedRef.current = true;
    try { sessionRef.current?.stop(); } catch {}
    ipcRenderer.invoke('global-dict:cancel').catch(() => {});
  };

  const onHeaderClose = (e: React.MouseEvent) => {
    e.preventDefault();
    doCancel();
  };

  const text = final + partial;
  const hasText = text.length > 0;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'transparent',
        padding: 6,
        boxSizing: 'border-box',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%', height: '100%',
          background: '#1c1c1e',                    // SOLID — no opacity, no blur
          borderRadius: 14,
          border: '1px solid #2c2c2e',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header — always visible */}
        <div
          style={{
            height: HEADER_H,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            borderBottom: hasText ? '1px solid #2c2c2e' : 'none',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#9b9b9d', fontSize: 12 }}>
            <LockIcon />
            <span style={{ fontWeight: 500, color: '#d6d6d8' }}>Universal</span>
            <span style={{ display: 'inline-block', width: 1, height: 12, background: '#3a3a3d' }} />
            {phase === 'stopping' ? <Spinner /> : <Wave />}
            <span style={{
              color: phase === 'stopping' ? '#f5a623' : '#3ecf6e',
              fontWeight: 500,
              transition: 'color 180ms ease',
            }}>{phase === 'stopping' ? 'Stopping' : 'Streaming'}</span>
          </div>
          <button
            onClick={onHeaderClose}
            aria-label="Cancel"
            style={{
              width: 24, height: 24,
              borderRadius: '50%',
              border: 'none',
              cursor: 'default',
              background: '#2c2c2e',
              color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        {/* Transcript body — only rendered when text exists */}
        {hasText && (
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 12px',
              color: '#e6e6e8',
              fontSize,
              lineHeight: 1.5,
              wordBreak: 'break-word',
            }}
          >
            {final && <span>{final}</span>}
            {partial && <span style={{ color: '#9b9b9d' }}>{partial}</span>}
          </div>
        )}
        {errMsg && (
          <div style={{ padding: '6px 12px', color: '#ff7a7a', fontSize: 11, borderTop: '1px solid #2c2c2e' }}>{errMsg}</div>
        )}
      </div>
    </div>
  );
}

// SVG lock — replaces the emoji 🔒 stick-on.
const LockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

// Three small bars that pulse — visualises live audio being streamed.
// CSS-only (no audio API), runs whenever Wave is mounted.
const Wave = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, height: 14, marginRight: 4 }}>
    {[0, 1, 2, 3].map((i) => (
      <span
        key={i}
        style={{
          width: 2.5, height: 14,
          background: '#3ecf6e',
          borderRadius: 1.5,
          animation: `noted-wave 0.9s ease-in-out ${i * 0.12}s infinite`,
        }}
      />
    ))}
    <style>{`
      @keyframes noted-wave {
        0%, 100% { transform: scaleY(0.35); }
        50%       { transform: scaleY(1.0); }
      }
    `}</style>
  </span>
);

// Amber circular spinner — visualises "we're winding the session down". Used
// while phase === 'stopping' so the change is visually obvious even on a
// quick glance (color shift + icon shape, not just a text change).
const Spinner = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', height: 14, marginRight: 4 }}>
    <span style={{
      width: 12, height: 12,
      borderRadius: '50%',
      border: '2px solid #f5a623',
      borderTopColor: 'transparent',
      animation: 'noted-spin 0.7s linear infinite',
    }} />
    <style>{`
      @keyframes noted-spin {
        to { transform: rotate(360deg); }
      }
    `}</style>
  </span>
);

createRoot(document.getElementById('root')!).render(<RecordingApp />);
