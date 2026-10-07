import React from 'react';
import { createRoot } from 'react-dom/client';
import GlobalTabArchive from '../../src/renderer/components/Workspace/GlobalTabArchive';
const f: any = (window as any).archiveFixture = {
  calls: [], revision: 1, mode: 'true', delay: false,
  history: [
    { namespace: 'legacy', id: 7, tab_id: null, name: 'same', cwd: '/old/dir', workflowId: 'gone', workflowName: 'Archived workflow', notes: 'Legacy draft', command_type: 'codex', codex_session_id: 'old-sid', assets: [{ id: 'stable-asset' }] },
    { namespace: 'other', id: 7, tab_id: 'opaque', name: 'same', cwd: '/new/dir', workflowId: 'a', workflowName: 'Design', notes: 'Other draft', command_type: 'claude', claude_session_id: 'new-sid' },
    { namespace: 'other', id: 8, tab_id: 'protected', name: 'Protected job', cwd: '/new/dir', workflowId: 'a', protected: true, protectedReason: 'Restore lease active' },
    { namespace: 'file', id: 9, tab_id: null, name: 'notes.md', cwd: '/file', tab_type: 'file', file_path: '/synthetic/notes.md' },
  ],
  favorites: [{ namespace: 'favorite', id: 11, name: 'Saved command', cwd: '/cmd', command_type: 'codex', notes: 'Saved notes', assets: ['exact'], codex_session_id: 'favorite-sid', url: 'legacy-url' }],
};
const readArchive = async () => {
  f.reads = (f.reads || 0) + 1;
  if (f.delayRead) await new Promise(resolve => f.releaseRead = resolve);
  if (f.failRead) throw new Error('Read unavailable');
  return structuredClone({ version: 1, history: f.history, favorites: f.favorites, revision: f.revision });
};
function action(kind: string) {
  return async (request: any) => {
    f.calls.push({ kind, request: structuredClone(request) });
    if (f.delay) await new Promise(resolve => f.release = resolve);
    if (f.mode === 'false') return false;
    if (f.mode === 'missing') return undefined;
    if (f.mode === 'foreign') return { success: true, namespace: 'foreign', id: request.historyId ?? request.favoriteId };
    if (request.expectedRevision !== f.revision) return { success: false, disposition: 'not-applied', message: 'Stale revision' };
    if (kind === 'delete') f.history = f.history.filter((row: any) => !(row.id === request.historyId && row.namespace === request.namespace));
    if (kind === 'remove') f.favorites = f.favorites.filter((row: any) => !(row.id === request.favoriteId && row.namespace === request.namespace));
    if (kind === 'name') f.history.find((row: any) => row.id === request.historyId && row.namespace === request.namespace).name = request.name;
    if (kind === 'notes') f.history.find((row: any) => row.id === request.historyId && row.namespace === request.namespace).notes = request.notes;
    f.revision++;
    return kind === 'restore' ? { tabId: 'restored-exact', historyDeleteFailed: true } : { success: true };
  };
}
const props = {
  readArchive, workflows: [{ id: 'a', name: 'Design' }, { id: 'i', name: 'Incoming', kind: 'inbox' }],
  onRestore: action('restore'), onOpenFavorite: action('open'), onDeleteHistory: action('delete'),
  onRemoveFavorite: action('remove'), onRename: action('name'), onUpdateNotes: action('notes'),
  onAddFavorite: action('favorite'), onRefreshTitle: action('title'),
  renderPreview: (row: any, context: any) => <div data-private-preview style={{ padding: 12 }}><p>Read-only History / Timeline</p><p>{row.codex_session_id || row.claude_session_id || 'No saved session'}</p><p>{context.entryUuid}</p><p>{row.notes}</p></div>,
  searchArchive: async (request: any) => {
    f.searches = [...(f.searches || []), request];
    if (f.delaySearch) await new Promise(resolve => f.releaseSearch = resolve);
    return { version: 1, history: [{ ...f.history[0], entryUuid: 'iteration-1' }, { ...f.history[0], entryUuid: 'iteration-2' }] };
  },
};
createRoot(document.getElementById('root')!).render(<GlobalTabArchive {...props} />);
