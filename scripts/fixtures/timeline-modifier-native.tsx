import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/blocks.css';

const fixture = (window as any).modifierFixture;
const owners = 12, count = 600, projectId = 'private-modifier', cwd = '/synthetic-modifier';
const tabs = Array.from({ length: owners }, (_, index) => ({ id: 'owner-' + index,
  name: 'Owner ' + index, cwd, commandType: 'codex', tabType: 'file', codexSessionId: 'session-' + index }));
const rails = new Map(tabs.map(tab => [tab.codexSessionId, Array.from({ length: count }, (_, i) => ({
  uuid: tab.id + '-row-' + i, sessionId: tab.codexSessionId, type: 'user', role: 'user',
  timestamp: new Date(1760000000000 + i * 1000).toISOString(), content: 'Synthetic user message ' + i,
}))]));
fixture.timeline = (sessionId: string) => rails.get(sessionId) || [];
useWorkspaceStore.setState({ openProjects: new Map([[projectId, { projectId, projectPath: cwd,
  tabs: new Map(tabs.map(tab => [tab.id, tab])), activeTabId: 'owner-0', currentView: 'terminal',
  tabGroups: [], selectedTabIds: [] }]]), activeProjectId: projectId } as any);
useUIStore.setState({ timelineFontSize: 12 } as any);

function Fixture() {
  const [shown, setShown] = useState(true);
  fixture.show = setShown;
  return <>
    <textarea data-modifier-input defaultValue="unchanged draft" style={{position:'absolute',left:30,top:30,width:300}} />
    {tabs.map((tab, index) => <div key={tab.id} data-modifier-owner={tab.id}
      style={{position:'absolute',top:120,left:index<2?30+index*400:0,width:380,height:500,
        opacity:shown&&index<2?1:0,pointerEvents:shown&&index<2?'auto':'none',willChange:'opacity'}}>
      <Timeline tabId={tab.id} sessionId={tab.codexSessionId} cwd={cwd} toolType="codex"
        isActive={false} isTurnBusy={false} isVisible={shown&&index<2} isOpen historySurfaceVisible
        presentationExternallyManaged readOnly backgroundPrewarmAdmitted />
    </div>)}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
