import {captureWorkflowDrag,workflowDragRequest,workflowDragSourceValid} from './workflowDragModel.mjs';
import {collectTabLinkedFileTree} from './tabLinkedFiles.mjs';

export function linkedFileOutline(files) {
  const nodes=new Map(files.map(file=>[file.id,{id:`reserve-tab:${file.id}`,tabId:file.id,
    projectId:file.projectId,entityType:'tab',kind:'tab',label:file.name,file,expanded:true,children:[]}]));
  const roots=[];
  for(const file of files) (nodes.get(file.parentTabId)?.children || roots).push(nodes.get(file.id));
  return roots;
}

export function captureLinkedFileDrag(state,ownerTabId,input) {
  const admission=captureWorkflowDrag(state,{gestureId:input.sessionId,outline:input.outline,sourceId:input.sourceId,origin:'file-menu'});
  const owner=admission?.guards[ownerTabId];
  if(!owner || owner.tabType==='file')return false;
  const files=collectTabLinkedFileTree(state.openProjects,ownerTabId);
  return Object.freeze({...admission,fileTreeScope:Object.freeze({ownerTabId,tabIds:Object.freeze(files.map(file=>file.id).sort())})});
}

export function linkedFileDragValid(admission,state) {
  return workflowDragSourceValid(admission,state) && !!admission?.fileTreeScope
    && JSON.stringify(collectTabLinkedFileTree(state.openProjects,admission.fileTreeScope.ownerTabId).map(file=>file.id).sort())
      ===JSON.stringify(admission.fileTreeScope.tabIds);
}

/** The popup's root is the real owner, omitted only from its painted rows.
 * Translate that boundary to the SAME durable forest command as the sidebar.
 * Never save a second menu order or turn root-outdent into unlink.
 */
export function linkedFileDragRequest(admission,previewOutline) {
  const scope=admission?.fileTreeScope,owner=scope && admission.guards[scope.ownerTabId];
  if(!owner)return null;
  const ids=[], clean=nodes=>nodes.map(node=>{
    ids.push(node.tabId);
    return {...node,contextParent:null,children:clean(node.children || [])};
  });
  const children=clean(previewOutline);
  if(JSON.stringify([...ids].sort())!==JSON.stringify(scope.tabIds))return null;
  const ownerNode={id:`reserve-tab:${scope.ownerTabId}`,tabId:scope.ownerTabId,projectId:owner.namespace,
    contextParent:owner.visualParentTabId || owner.parentTabId ? {tabId:owner.visualParentTabId || owner.parentTabId}:null,children};
  const outline=owner.groupId ? [{id:`file-owner-group:${owner.groupId}`,groupId:owner.groupId,children:[ownerNode]}]:[ownerNode];
  const request=workflowDragRequest(admission,{workflowId:admission.sourceWorkflowId,previewOutline:outline});
  if(!request)return null;
  // Groups are outside this file-only projection. A Y/X gesture here cannot
  // silently assign every sibling to the owner's global group.
  for(const tab of request.tabs)tab.groupId=tab.expected.groupId;
  // Only files were reordered. The hidden owner/group never moves amongst the
  // workflow's mixed roots, nor amongst its independent AI siblings.
  const orderedFiles=new Set(ids);
  for(const proposal of request.workflows) {
    const baseline=admission.workflows[proposal.workflowId];
    proposal.reserveRootOrder=baseline.reserveRootOrder;
    if(proposal.workflowId===admission.sourceWorkflowId) {
      let at=0;
      proposal.reserveOrder=baseline.reserveOrder.map(id=>orderedFiles.has(id)?ids[at++]:id);
      proposal.reserveOrder.push(...ids.slice(at));
    }
  }
  return {...request,fileTreeScope:scope};
}
