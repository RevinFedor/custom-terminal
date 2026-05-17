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
import './styles/globals.css';
import './styles/sidebar.css';
// === file:// shim for bippy/react-grab in packaged Electron ===
// Problem: bippy's isFetchableUrl() rejects anything that isn't http(s).
// In a packaged .app the renderer loads via file://, so stack frames look
// like file:///Applications/.../app.asar/dist/renderer/index.js and bippy
// never symbolicates → react-grab can't show component paths.
//
// Fix: (1) intercept window.fetch, route http://__app__/... requests to
// fs.readFile on the real filesystem; (2) rewrite file:// URLs to that
// http://__app__/... prefix at every entry point bippy uses — stack
// strings on Error.prototype.stack (via Error.captureStackTrace would be
// overkill; we patch Error.prototype.stack getter) and the
// document.scripts URLs that bippy reads.
//
// nodeIntegration=true + contextIsolation=false makes this trivial — full
// access to fs from the renderer.
//
// Must run BEFORE react-grab is loaded.
(() => {
  try {
    const nodeReq = (window as any).require;
    if (!nodeReq) return;
    const fs = nodeReq('fs');
    const HTTP_PREFIX = 'http://__app__/';
    const FILE_PREFIX = 'file://';

    const rewrite = (s: string): string =>
      typeof s === 'string' ? s.split(FILE_PREFIX).join(HTTP_PREFIX) : s;

    const httpToPath = (httpUrl: string): string | null => {
      if (!httpUrl.startsWith(HTTP_PREFIX)) return null;
      let p = '/' + httpUrl.slice(HTTP_PREFIX.length);
      try { p = decodeURI(p); } catch {}
      // Drop query / hash
      p = p.split('?')[0].split('#')[0];
      return p;
    };

    // (1) fetch shim — read http://__app__/<path> from disk
    const origFetch = window.fetch.bind(window);
    window.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url || String(input));
      const path = typeof url === 'string' ? httpToPath(url) : null;
      if (path) {
        return new Promise((resolve) => {
          fs.readFile(path, 'utf8', (err: any, data: string) => {
            if (err) {
              resolve(new Response(null, { status: 404, statusText: err.message }));
              return;
            }
            resolve(new Response(data, { status: 200, headers: { 'content-type': 'application/javascript' } }));
          });
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    // (2) Rewrite Error.prototype.stack so V8 stack strings shown to bippy
    // contain http://__app__/ instead of file://
    const errProto = Error.prototype as any;
    const origStackDesc = Object.getOwnPropertyDescriptor(errProto, 'stack');
    Object.defineProperty(errProto, 'stack', {
      configurable: true,
      get() {
        const raw = origStackDesc?.get ? origStackDesc.get.call(this) : this._origStack;
        return rewrite(raw || '');
      },
      set(v: string) {
        if (origStackDesc?.set) origStackDesc.set.call(this, v);
        else this._origStack = v;
      },
    });

    console.log('[ReactGrabShim] installed: file:// → http://__app__/');
  } catch (e: any) {
    console.log('[ReactGrabShim] failed:', e?.message || String(e));
  }
})();

import('react-grab').catch(() => {});

// === [ReactGrabDiag] one-shot probe of Fiber source info in this build ===
// Runs once after first paint and prints what react-grab will see.
// Remove this block after diagnosis.
setTimeout(async () => {
  try {
    const root = document.getElementById('react-root');
    const firstChild = root?.querySelector('*');
    if (!firstChild) {
      console.log('[ReactGrabDiag] no React tree yet');
      return;
    }
    const fiberKey = Object.keys(firstChild).find(k => k.startsWith('__reactFiber$'));
    const fiber: any = fiberKey ? (firstChild as any)[fiberKey] : null;
    console.log('[ReactGrabDiag] React.version =', (React as any).version);
    console.log('[ReactGrabDiag] process.env.NODE_ENV =', process.env.NODE_ENV);
    console.log('[ReactGrabDiag] fiber present =', !!fiber);
    if (!fiber) return;

    console.log('[ReactGrabDiag] _debugSource =', JSON.stringify(fiber._debugSource));
    console.log('[ReactGrabDiag] _debugStack present =', !!fiber._debugStack);
    console.log('[ReactGrabDiag] _debugOwner present =', !!fiber._debugOwner);

    // Print raw _debugStack contents — this is what bippy parses
    if (fiber._debugStack) {
      const stackStr = fiber._debugStack.stack || String(fiber._debugStack);
      console.log('[ReactGrabDiag] _debugStack first 600 chars =', String(stackStr).slice(0, 600));
    }

    // Try to ask bippy/source directly what it resolves
    try {
      const bippySource = await import('bippy/source');
      const resolved = await bippySource.getSource(fiber);
      console.log('[ReactGrabDiag] bippy getSource result =', JSON.stringify(resolved));
      const displayName = await bippySource.getDisplayNameFromSource(fiber);
      console.log('[ReactGrabDiag] bippy displayName =', displayName);
    } catch (e: any) {
      console.log('[ReactGrabDiag] bippy resolve failed:', e?.message || String(e));
    }

    // Check if any script chunk has sourcemap available
    try {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      const firstSrc = (scripts[0] as HTMLScriptElement)?.src;
      if (firstSrc) {
        const resp = await fetch(firstSrc);
        const text = await resp.text();
        const lastLines = text.slice(-300);
        const hasSourceMap = /sourceMappingURL/.test(lastLines);
        console.log('[ReactGrabDiag] first script has sourceMappingURL =', hasSourceMap);
        if (hasSourceMap) {
          const match = lastLines.match(/sourceMappingURL=(\S+)/);
          console.log('[ReactGrabDiag] sourceMappingURL prefix =', match?.[1]?.slice(0, 100));
        }
      }
    } catch (e: any) {
      console.log('[ReactGrabDiag] sourcemap check failed:', e?.message);
    }
  } catch (e: any) {
    console.log('[ReactGrabDiag] probe failed:', e?.message || String(e));
  }
}, 2000);

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
function _forwardToFile(args: any[]) {
  if (!_ipc || !_extractTag(args)) return;
  const msg = args.map((a: any) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  _ipc.send('log:renderer', msg);
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
  _ipc.send('log:renderer', msg);
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
    _origError('[ErrorBoundary]', error, info.componentStack);
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
