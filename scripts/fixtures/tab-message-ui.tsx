// Synthetic IPC-only fixture. The runner exports HistoryUserEntry from its
// private source snapshot; the application module's public API stays unchanged.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OrchestrationStatusChip } from '../../src/renderer/components/Workspace/OrchestrationStatusChip';
import { HistoryUserEntry } from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { buildPromptChipWrapper } from '../../src/renderer/utils/composerChips.mjs';
import '../../packages/claude-blocks/src/blocks.css';

const f = (window as any).fixture;
f.fingerprint = (text: string) => window.require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
const prefix = buildPromptChipWrapper({ id: 'ctx', kind: 'prompt', label: 'Saved context', text: 'Context remains', contextUpdateId: 'update-id' }) + '\n\n';
const envelope = 'APP ENVELOPE: reply via tools with messageId=question-1\n\n';
const body = '## Answer\n\n| Key | Value |\n| --- | --- |\n| Exact | 42 |\n\n```js\nconst value = 42;\n```\n';
f.history = {
  uuid: 'history-message', role: 'user', timestamp: '2026-10-03T10:12:00.000Z', content: prefix + envelope + body,
  promptChips: [{ id: 'ctx', kind: 'prompt', label: 'Saved context', text: 'Context remains', contextUpdateId: 'update-id' }],
  semanticTags: [{
    kind: 'tab-message', messageId: 'reply-history', replyTo: 'question-history', phase: 'reply',
    sourceTabId: 'b', sourceTabName: 'Stored source B', sourceProjectId: 'pb', targetTabId: 'a', targetProjectId: 'pa',
    envelopeStart: prefix.length, envelopeText: envelope, bodyStart: prefix.length + envelope.length,
    bodyEnd: prefix.length + envelope.length + body.length, bodyProjectionHash: f.fingerprint(prefix + envelope + body),
  }],
};
const projects = new Map(['a', 'b'].map(id => ['p' + id, {
  projectId: 'p' + id, projectPath: '/synthetic',
  tabs: new Map([[id, { id, name: 'LIVE NAME ' + id, color: 'codex', tabType: 'file' }]]),
  activeTabId: id, currentView: 'terminal', selectedTabIds: [], tabGroups: [],
}]));
useWorkspaceStore.setState({
  openProjects: projects,
  activateCenterTab: (projectId: string, tabId: string) => f.navigation.push({ projectId, tabId }),
  placeTab: (projectId: string, tabId: string) => f.navigation.push({ projectId, tabId }),
} as any);
f.moveSource = () => {
  const original = projects.get('pb')!;
  const moved = new Map(projects);
  moved.set('pb', { ...original, tabs: new Map([['same-name-decoy', { id: 'same-name-decoy', name: 'Stored source B', color: 'codex', tabType: 'file' }]]) });
  moved.set('moved-project', { ...original, projectId: 'moved-project', tabs: new Map([['b', { ...original.tabs.get('b')!, name: 'Renamed live B', color: 'claude', tabType: 'terminal' }]]) });
  useWorkspaceStore.setState({ openProjects: moved } as any);
};
f.restoreSource = () => useWorkspaceStore.setState({ openProjects: projects } as any);
useUIStore.setState({ historyFontSize: 14 });
const root = createRoot(document.getElementById('root')!);
f.render = (tabId = 'a') => root.render(<>
  <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', alignItems: 'start', gap: 4 }}>
    <OrchestrationStatusChip tabId={tabId} panelOpen={false} effectiveWidth={200} />
  </div>
  <div data-history-fixture style={{ margin: '260px 20px 20px', maxWidth: 720 }}>
    <HistoryUserEntry entry={f.history} tabId="a" toolType="codex" allowRewind={false} rewindLocked={false}
      allowHistoryRewriteRewind historyRewriteRewindLocked={false} onHistoryRewriteRewind={(entry: { content: string }) => f.rewinds.push(entry.content)}
      allowDeleteIteration={false} deleteIterationLocked={false} />
  </div>
</>);
f.render();
