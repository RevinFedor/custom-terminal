import React from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from '../../src/renderer/components/Dashboard/Dashboard';
import './home-content-stores';

// Actual Dashboard and StorageBrowser; only the outer stores/IPC are synthetic.
createRoot(document.getElementById('root')!).render(<Dashboard />);
