import React from 'react';
import ReactDOM from 'react-dom/client';
// Hydrate localStorage from SQLite + install setItem mirror BEFORE any store
// module loads. Zustand store factories read `localStorage.getItem(...)` at
// import time — if SQLite has fresher values (typical on dev when vite picks a
// new port and origin-bound localStorage is empty), they need to land in
// localStorage before the factory runs.
import { bootstrapPersistedStorage } from './utils/persistedStorage';
bootstrapPersistedStorage();

import App from './App';
import { installPerfFreezeProbe } from './utils/perfFreezeProbe';
import './styles/globals.css';
import './styles/sidebar.css';
// Portable Claude-conversation blocks (tool cards / bash / diff / thinking /
// markdown) + design-token theme. Imported AFTER globals so the host could
// override any --cb-* token there if needed. See packages/claude-blocks.
import '@noted/claude-blocks/styles.css';

// === code-inspector: Claude/Cursor-friendly clipboard formatter ===
// The plugin emits `code-inspector:trackCode` with `detail = HTMLElement` on
// ⌘+click. We format outerHTML + component path so the clipboard payload is
// self-contained — you can paste straight into Claude/Cursor and the model
// has the file:line:col reference plus the actual JSX/DOM snippet.
window.addEventListener('code-inspector:trackCode', (e: any) => {
  try {
    const d = e?.detail || {};
    const { name = '', path = '', line = '', column = '' } = d;
    const loc = path ? `${path}:${line}:${column}` : '';

    // Try to locate the actual DOM node by data-insp-path so we can include
    // its outerHTML (claude/cursor likes seeing the JSX snippet, not just
    // a file:line ref). data-insp-path format from plugin: "path:line:col".
    let html = '';
    if (loc) {
      const candidates = document.querySelectorAll<HTMLElement>(`[data-insp-path="${loc}"]`);
      const el = candidates[candidates.length - 1]; // outermost matching node
      if (el) {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll?.('[data-insp-path]').forEach(n => n.removeAttribute('data-insp-path'));
        clone.removeAttribute('data-insp-path');
        html = clone.outerHTML || '';
        if (html.length > 1200) html = html.slice(0, 1200) + '\n  ...(truncated)';
      }
    }

    const text = html
      ? `${html}\n\nin <${name}> at ${loc}`
      : `<${name}> at ${loc}`;

    const electron = (window as any).require?.('electron');
    if (electron?.clipboard?.writeText) {
      electron.clipboard.writeText(text);
    } else {
      navigator.clipboard?.writeText?.(text);
    }
  } catch (err: any) {
    console.error('[code-inspector] copy failed:', err?.message || err);
  }
});

// === TAG-BASED CONSOLE FILTER ===
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

const LOG_DISABLED_TAGS = new Set([
  'Workspace', 'TerminalArea', 'Terminal', 'safeFit', 'ProjectHome',
  'Store', 'Link', 'Settings', 'SessionsPanel', 'CURSOR', 'SILENCE',
  'DIAG', 'UIStore', 'Dashboard', 'NotesEditor', 'ResearchInput',
  'Research', 'Timeline', 'Think',
]);

const LOG_ALWAYS_TAGS = new Set(['RESTORE', 'Restore', 'ErrorBoundary']);

function _extractTag(args: any[]): string | null {
  const first = args[0];
  if (typeof first !== 'string') return null;
  const m = first.match(/^\[([^\]:\s]+)/);
  return m ? m[1] : null;
}

function _shouldLog(args: any[]): boolean {
  const tag = _extractTag(args);
  if (!tag) return true; // no tag → pass through
  if (LOG_ALWAYS_TAGS.has(tag)) return true;
  if (LOG_DISABLED_TAGS.has(tag)) return false;
  return true;
}

// Forward tagged renderer logs to main process for file logging
const _ipc = (window as any).require?.('electron')?.ipcRenderer;
const _rendererLogBoot = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let _rendererLogSeq = 0;

function _rendererAbsNow(): number {
  return performance.timeOrigin + performance.now();
}

function _sendRendererLog(msg: string) {
  if (!_ipc) return;
  _ipc.send('log:renderer', {
    msg,
    seq: ++_rendererLogSeq,
    boot: _rendererLogBoot,
    emitAbs: _rendererAbsNow(),
    emitIso: new Date().toISOString(),
    href: window.location.href,
  });
}

function _forwardToFile(args: any[]) {
  if (!_ipc || !_extractTag(args)) return;
  const msg = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  _sendRendererLog(msg);
}

// Forward UNTAGGED React/library warnings as `[ReactWarn]`-tagged so they end
// up in dev.log alongside our explicit logs. Captures things like "Accessing
// element.ref was removed in React 19" — the kind of message that's visible
// in DevTools only and goes silent in the file log otherwise.
function _forwardUntaggedWarn(args: any[], level: 'warn' | 'error') {
  if (!_ipc) return;
  const first = args[0];
  if (typeof first !== 'string') return;
  if (_extractTag(args)) return; // already tagged; main path handles it
  // Skip a handful of high-frequency known no-ops we don't want spamming the
  // log — narrow filter, add to it if real noise appears.
  if (/Warning: Each child in a list/.test(first)) return;
  const msg = '[ReactWarn:' + level + '] ' + args.map((a: any) => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return '<unserializable>'; } })()).join(' ').slice(0, 800);
  _sendRendererLog(msg);
}

console.log = (...args: any[]) => { _forwardToFile(args); if (_shouldLog(args)) _origLog(...args); };
console.warn = (...args: any[]) => { _forwardToFile(args); _forwardUntaggedWarn(args, 'warn'); if (_shouldLog(args)) _origWarn(...args); };
console.error = (...args: any[]) => { _origError(...args); _forwardToFile(args); _forwardUntaggedWarn(args, 'error'); };
// All tagged logs go to file regardless of DevTools filter

(window as any).logs = {
  on(tag: string) { LOG_DISABLED_TAGS.delete(tag); _origLog(`[logs] enabled: ${tag}`); },
  off(tag: string) { LOG_DISABLED_TAGS.add(tag); _origLog(`[logs] disabled: ${tag}`); },
  only(...tags: string[]) {
    LOG_DISABLED_TAGS.clear();
    // Disable everything except specified tags
    const allKnown = ['Workspace', 'TerminalArea', 'Terminal', 'safeFit', 'ProjectHome',
      'Store', 'Link', 'Settings', 'SessionsPanel', 'CURSOR', 'SILENCE', 'DIAG',
      'UIStore', 'Dashboard', 'NotesEditor', 'ResearchInput', 'Research', 'Timeline', 'Think'];
    const keep = new Set(tags);
    allKnown.forEach(t => { if (!keep.has(t)) LOG_DISABLED_TAGS.add(t); });
    _origLog(`[logs] only: ${tags.join(', ')}`);
  },
  all() { LOG_DISABLED_TAGS.clear(); _origLog('[logs] all tags enabled'); },
  reset() {
    LOG_DISABLED_TAGS.clear();
    ['Workspace', 'TerminalArea', 'Terminal', 'safeFit', 'ProjectHome',
      'Store', 'Link', 'Settings', 'SessionsPanel', 'CURSOR', 'SILENCE',
      'DIAG', 'UIStore', 'Dashboard', 'NotesEditor', 'ResearchInput',
      'Research', 'Timeline', 'Think'].forEach(t => LOG_DISABLED_TAGS.add(t));
    _origLog('[logs] reset to defaults');
  },
  status() {
    _origLog('[logs] disabled:', [...LOG_DISABLED_TAGS].sort().join(', '));
    _origLog('[logs] always:', [...LOG_ALWAYS_TAGS].join(', '));
  },
};

console.warn(
  `[RendererLog] boot=${_rendererLogBoot}` +
  ` timeOriginAbs=${performance.timeOrigin.toFixed(1)}` +
  ` href=${window.location.href}`
);

installPerfFreezeProbe();

// === GLOBAL ERROR BOUNDARY ===
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const message = error?.message || String(error);
    const stack = error?.stack || '';
    const componentStack = info.componentStack || '';
    _sendRendererLog(
      '[ErrorBoundary] message=' + message.slice(0, 1000)
      + ' stack=' + stack.slice(0, 4000).replace(/\s+/g, ' ')
      + ' componentStack=' + componentStack.slice(0, 4000).replace(/\s+/g, ' ')
    );
    console.error('[ErrorBoundary]', message, stack, componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          height: '100vh', width: '100vw',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: '#1a1a1a', color: '#fff',
          fontFamily: 'system-ui, sans-serif', gap: '16px',
        }}>
          <div style={{ fontSize: '18px', fontWeight: 600 }}>Something went wrong</div>
          <pre style={{
            maxWidth: '600px', padding: '12px 16px',
            backgroundColor: '#2a2a2a', borderRadius: '8px',
            fontSize: '12px', color: '#f87171',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            border: '1px solid #333',
          }}>
            {this.state.error.message}
          </pre>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                padding: '8px 20px', fontSize: '13px',
                backgroundColor: '#333', color: '#fff',
                border: '1px solid #555', borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => {
                // location.reload() in Electron with custom protocols can be
                // intercepted by the OS default browser. Bounce through main
                // so reload stays inside the BrowserWindow.
                try {
                  const { ipcRenderer } = window.require('electron');
                  ipcRenderer.send('app:reload');
                } catch {
                  location.reload();
                }
              }}
              style={{
                padding: '8px 20px', fontSize: '13px',
                backgroundColor: '#DA7756', color: 'white',
                border: 'none', borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Mount React app (no StrictMode - conflicts with xterm.js)
const root = document.getElementById('react-root');
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
