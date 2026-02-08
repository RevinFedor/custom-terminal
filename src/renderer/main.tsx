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

// Mount React app (no StrictMode - conflicts with xterm.js)
const root = document.getElementById('react-root');
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
