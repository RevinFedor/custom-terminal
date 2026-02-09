import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// === GLOBAL CONSOLE FILTER ===
// Only show [RESTORE] prefixed logs to reduce noise during debugging
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

const RESTORE_DEBUG = true; // Set to false to disable filter

if (RESTORE_DEBUG) {
  console.log = (...args: any[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith('[RESTORE]')) {
      _origLog(...args);
    }
  };
  // Keep warn/error unfiltered
}

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
