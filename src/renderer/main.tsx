import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Mount React app (no StrictMode - conflicts with xterm.js)
const root = document.getElementById('react-root');
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
