import {useSyncExternalStore} from 'react';
import {getWorkspaceOverlayHost,subscribeWorkspaceOverlayHost} from '../utils/workspaceOverlayHost.mjs';

export function useWorkspaceOverlayTarget(): Element {
  return useSyncExternalStore(subscribeWorkspaceOverlayHost,getWorkspaceOverlayHost,()=>null) || document.body;
}
