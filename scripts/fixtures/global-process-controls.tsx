import React from 'react';
import { createRoot } from 'react-dom/client';
import ResourceUsageButton from '../../src/renderer/components/Workspace/ResourceUsageButton';
import McpHubButton from '../../src/renderer/components/Workspace/McpHubButton';
import DiskCapacityWarning from '../../src/renderer/components/Workspace/DiskCapacityWarning';
import { useWorkspaceStore } from './global-process-controls-stores';

function Fixture() {
  const view = useWorkspaceStore(state => state.view);
  return <div>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: 10 }}>
      <button data-fixture-toggle onClick={() => useWorkspaceStore.setState({ view: view === 'dashboard' ? 'workspace' : 'dashboard' })}>Home / workspace</button>
      <ResourceUsageButton /><DiskCapacityWarning /><McpHubButton cwd="/synthetic" />
    </header>
    <main data-fixture-view={view} style={{ padding: 20 }}>{view === 'dashboard' ? 'Synthetic Home' : 'Synthetic workspace'}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
