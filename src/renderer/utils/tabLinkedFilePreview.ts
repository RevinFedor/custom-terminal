import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useUIStore } from '../store/useUIStore';
import { collectTabLinkedFiles } from './tabLinkedFiles.mjs';
import type { LinkedFile } from '../components/Workspace/TabLinkedFiles';
import { tabNavigationLocation } from './tabNavigationLocation.mjs';

let request = 0;
const location = tabNavigationLocation;

/** Open a document through the existing reader without activating its file tab. */
export async function openTabLinkedFile(ownerProjectId: string, file: LinkedFile,
  revealOwner: () => void | boolean | Promise<void | boolean>) {
  const mine = ++request;
  const state = useWorkspaceStore.getState();
  if (!state.openProjects.get(ownerProjectId)?.tabs.has(file.ownerTabId)) return;
  // Navigation is supplied by the placement owner. This reader never chooses
  // a workflow/window or changes placement defaults.
  const navigation = revealOwner();
  let initialLocation = location(useWorkspaceStore.getState());
  const navigationId = useWorkspaceStore.getState().activeTabNavigationIntent?.id;
  let ownedRevision = useWorkspaceStore.getState().navigationRevision || 0;
  const revision = useUIStore.getState().filePreviewRevision;
  let navigated = false;
  const unsubscribe = useWorkspaceStore.subscribe(next => {
    if (location(next) === initialLocation) return;
    if (navigationId && next.navigationMutationOwner === navigationId
      && next.navigationKey === location(next) && next.navigationRevision > ownedRevision) {
      initialLocation = location(next); ownedRevision = next.navigationRevision;
    } else navigated = true;
  });
  try {
    // Header links have a loaded owner, so root navigation applies its view
    // synchronously. Subscribe before awaiting its result: a close or an
    // away/back gesture in that microtask gap must still cancel this read.
    const revealed = await navigation;
    if (revealed === false || mine !== request || navigated
      || useUIStore.getState().filePreviewRevision !== revision) return;
    const result = await window.require('electron').ipcRenderer.invoke('file:read', file.path);
    const ui = useUIStore.getState(), now = useWorkspaceStore.getState();
    if (mine !== request || navigated || ui.filePreviewRevision !== revision) return;
    const exactLink = collectTabLinkedFiles(now.openProjects, file.ownerTabId)
      .some((link: LinkedFile) => link.id === file.id && link.projectId === file.projectId && link.path === file.path);
    if (!exactLink) return;
    if (!result?.success) { ui.showToast('Could not read file', 'error'); return; }
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const languages: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', java: 'java', go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala', html: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', md: 'markdown', mdx: 'markdown', sh: 'bash', bash: 'bash',
      sql: 'sql', graphql: 'graphql', vue: 'vue', svelte: 'svelte' };
    const preview = { path: file.path, content: result.content, language: languages[extension] || null,
      source: 'tab', sourceTabId: file.id, sourceProjectId: file.projectId,
      ownerTabId: file.ownerTabId, ownerProjectId, sourceSpaceId: now.activeSpaceId } as const;
    ui.openFilePreview(preview);
    // A lease belongs only to this exact preview object. Navigation or unlink
    // cannot clear a newer sidebar/other-owner document, and closing ends it.
    const stopWorkspace = useWorkspaceStore.subscribe(next => {
      const stillLinked = collectTabLinkedFiles(next.openProjects, file.ownerTabId)
        .some((link: LinkedFile) => link.id === file.id && link.projectId === file.projectId && link.path === file.path);
      if (useUIStore.getState().filePreview === preview && (location(next) !== initialLocation || !stillLinked))
        useUIStore.getState().closeFilePreview();
    });
    const stopPreview = useUIStore.subscribe(next => {
      if (next.filePreview !== preview) { stopWorkspace(); stopPreview(); }
    });
  } catch (error) {
    if (mine === request && !navigated && useUIStore.getState().filePreviewRevision === revision)
      useUIStore.getState().showToast(`File preview: ${error instanceof Error ? error.message : 'failed to read file'}`, 'error');
  } finally { unsubscribe(); }
}
