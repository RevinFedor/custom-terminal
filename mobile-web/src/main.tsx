import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// Portable Claude-conversation blocks (tool cards / bash / diff / thinking /
// markdown) + design-token theme — shared with the desktop SDK tab. Imported
// here so .cb-* classes + --cb-* tokens are available app-wide. See
// packages/claude-blocks.
import '@noted/claude-blocks/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
