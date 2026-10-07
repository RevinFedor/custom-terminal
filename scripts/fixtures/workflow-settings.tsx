import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowSettings from '../../src/renderer/components/UI/ProjectIconsSettings';
import DirectoryRootsSettings from '../../src/renderer/components/UI/DirectoryRootsSettings';
import './workflow-settings-stores';
import '../../src/renderer/styles/sidebar.css';

createRoot(document.getElementById('root')!).render(<div style={{ width: '100%', padding: 16, boxSizing: 'border-box' }}><WorkflowSettings /><DirectoryRootsSettings /></div>);
