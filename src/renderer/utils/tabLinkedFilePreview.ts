import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useUIStore } from '../store/useUIStore';
import { collectTabLinkedFileTree, isLinkedFilePreview } from './tabLinkedFiles.mjs';
import type { LinkedFile } from '../components/Workspace/TabLinkedFiles';
import { tabNavigationLocation } from './tabNavigationLocation.mjs';

let request = 0;
let pendingRead: { id: number; ownerTabId: string } | null = null;
const location = tabNavigationLocation;

/** Middle-click dismisses this owner's reader, including a late pending read.
 * Link lifetime stays with Unlink; navigation stays with the Root owner.
 */
export function dismissTabLinkedFile(ownerTabId: string) {
  const ui=useUIStore.getState();
  const shown=isLinkedFilePreview(ui.filePreview,ownerTabId);
  if(!shown && pendingRead?.ownerTabId!==ownerTabId)return false;
  ++request;pendingRead=null;
  if(shown)ui.closeFilePreview();
  return true;
}

export async function closeTabLinkedFile(ownerTabId: string) {
  if(!dismissTabLinkedFile(ownerTabId))return false;
  try{return await useWorkspaceStore.getState().openTabById(ownerTabId,{reason:'linked-file-close'});}
  catch(error){console.warn('[LinkedFilePreview:close]',error);return false;}
}

/** Open a document through the existing reader without activating its file tab. */
export async function openTabLinkedFile(ownerProjectId: string, file: LinkedFile,
  revealOwner: () => void | boolean | Promise<void | boolean>) {
  const mine = ++request;
  pendingRead=null;
  const state = useWorkspaceStore.getState();
  if (!state.openProjects.get(ownerProjectId)?.tabs.has(file.ownerTabId)) return false;
  const current = useUIStore.getState().filePreview;
  if (current?.ownerTabId === file.ownerTabId && current.sourceTabId === file.id
    && current.sourceProjectId === file.projectId && current.path === file.path) {
    useUIStore.getState().closeFilePreview();
    return true;
  }
  if (!collectTabLinkedFileTree(state.openProjects, file.ownerTabId)
    .some(link => link.id === file.id && link.projectId === file.projectId && link.path === file.path)) return false;
  // Navigation is supplied by the placement owner. This reader never chooses
  // a workflow/window or changes placement defaults.
  const navigation = revealOwner();
  pendingRead={id:mine,ownerTabId:file.ownerTabId};
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
      || useUIStore.getState().filePreviewRevision !== revision) return false;
    const result = await window.require('electron').ipcRenderer.invoke('file:read', file.path);
    const ui = useUIStore.getState(), now = useWorkspaceStore.getState();
    if (mine !== request || navigated || ui.filePreviewRevision !== revision) return false;
    const exactLink = collectTabLinkedFileTree(now.openProjects, file.ownerTabId)
      .some((link: LinkedFile) => link.id === file.id && link.projectId === file.projectId && link.path === file.path);
    if (!exactLink) return false;
    if (!result?.success) { ui.showToast('Could not read file', 'error'); return false; }
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
      const stillLinked = collectTabLinkedFileTree(next.openProjects, file.ownerTabId)
        .some((link: LinkedFile) => link.id === file.id && link.projectId === file.projectId && link.path === file.path);
      if (useUIStore.getState().filePreview === preview && (location(next) !== initialLocation || !stillLinked))
        useUIStore.getState().closeFilePreview();
    });
    const stopPreview = useUIStore.subscribe(next => {
      if (next.filePreview !== preview) { stopWorkspace(); stopPreview(); }
    });
    return true;
  } catch (error) {
    if (mine === request && !navigated && useUIStore.getState().filePreviewRevision === revision)
      useUIStore.getState().showToast(`File preview: ${error instanceof Error ? error.message : 'failed to read file'}`, 'error');
    return false;
  } finally { unsubscribe();if(pendingRead?.id===mine)pendingRead=null; }
}
