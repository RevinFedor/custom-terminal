import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import('react-grab').catch(() => {});

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

console.log = (...args: any[]) => { _forwardToFile(args); if (_shouldLog(args)) _origLog(...args); };
console.warn = (...args: any[]) => { _forwardToFile(args); if (_shouldLog(args)) _origWarn(...args); };
console.error = (...args: any[]) => { _origError(...args); _forwardToFile(args); };
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
