'use strict';

const {fail,stableJson,layoutReferences,executionScopeForRow}=require('../shared/workflow-organization.cjs');
const {dragPlacement,dragRelation,dragFamily,applyDragLayout}=require('../shared/workflow-drag.cjs');
const same=(a,b)=>stableJson(a)===stableJson(b);

/** One canonical transaction for the forest that was actually painted. */
class WorkflowDrag {
  constructor({organization,groups}) {this.org=organization;this.groups=groups;this.db=organization.db;}
  commit(request) {
    let rows,workflows,baseRevision;
    const validateScope=meta=>{
      baseRevision=meta.revision;
      if(request.version!==1 || !request.gestureId || !Array.isArray(request.tabs) || !Array.isArray(request.workflows)
        || (!request.tabs.length && !Object.keys(request.groupScopes || {}).length) || new Set(request.tabs.map(tab=>tab.tabId)).size!==request.tabs.length
        || new Set(request.workflows.map(space=>space.workflowId)).size!==request.workflows.length
        || !Array.isArray(request.sourceRootTabIds) || !Array.isArray(request.sourceFamilyIds))fail('workflow_drag_plan_required');
      const catalog=this.org.listGlobalTabs(),byId=new Map(catalog.map(tab=>[tab.tabId,tab]));
      if(!Array.isArray(request.guardedFamilyIds) || request.guardedFamilyIds.some(id=>!request.tabs.some(tab=>tab.tabId===id)))fail('workflow_drag_plan_incomplete');
      const records=Object.fromEntries(catalog.filter(tab=>tab.nativeRow && tab.nativeRow.execution_archived!==1)
        .map(tab=>[tab.tabId,tab.nativeRow]));
      if(!same(dragFamily(records,request.sourceRootTabIds).sort(),[...request.sourceFamilyIds].sort()))fail('workflow_drag_family_changed');
      if(!same(dragFamily(records,request.paneRootTabIds,{physicalOnly:true}).sort(),[...request.paneFamilyIds].sort()))fail('workflow_drag_family_changed');
      const globalGroups=this.groups.read();
      for(const [groupId,expectedIds] of Object.entries(request.groupScopes || {})) {
        this.groups.group(groupId);
        const ids=Object.entries(globalGroups.tabGroups).filter(([,id])=>id===groupId).map(([id])=>id).sort();
        if(!same(ids,[...expectedIds].sort()))fail('workflow_drag_group_composition_changed');
      }
      const expectedGuarded=[...new Set([...request.sourceFamilyIds,...(request.destinationKind==='window' ? request.paneFamilyIds:[])])].sort();
      if(!same(expectedGuarded,[...request.guardedFamilyIds].sort()))fail('workflow_drag_plan_incomplete');
      const family=new Set(request.guardedFamilyIds);
      const placements=Object.fromEntries(this.org.listWorkflows().map(space=>[space.id,layoutReferences(space.layout)
        .filter(ref=>family.has(ref.tabId)).map(({tabId,namespace,path,kind})=>({tabId,namespace,path,kind}))])
        .filter(([,refs])=>refs.length));
      if(!same(placements,request.sourcePlacements || {}))fail('workflow_drag_source_placement_changed');
      rows=request.tabs.map(tab=>{
        const current=byId.get(tab.tabId),row=current?.nativeRow,guard=tab.expected;
        if(!row || row.execution_archived===1 || !guard)fail('workflow_drag_source_missing',{tabId:tab.tabId});
        const subject=executionScopeForRow(row),namespace=subject.executionNamespace || subject.projectId;
        if(namespace!==guard.namespace || (subject.subjectId || null)!==guard.subjectId
          || !Number.isSafeInteger(guard.storageId) || row.id!==guard.storageId)fail('workflow_drag_subject_changed',{tabId:tab.tabId});
        const member=this.org.memberRequired(tab.tabId,guard.membershipRevision);
        if(member.workflowId!==guard.workflowId || !same(dragRelation(row),dragRelation(guard)))fail('workflow_drag_relation_changed',{tabId:tab.tabId});
        if((globalGroups.tabGroups[tab.tabId] || null)!==guard.groupId
          || (globalGroups.membershipRevisions[tab.tabId] || 0)!==guard.groupRevision)fail('workflow_group_membership_changed',{tabId:tab.tabId});
        this.org.workflowRequired(tab.workflowId);
        if(tab.groupId!==null)this.groups.group(tab.groupId);
        if((row.parent_tab_id || row.tab_type==='file') && (row.visual_parent_tab_id || null)!==tab.visualParentTabId)
          fail('workflow_drag_physical_parent_locked',{tabId:tab.tabId});
        return {proposal:tab,current,row,subject,namespace};
      });
      const proposedParents=new Map(rows.map(({proposal})=>[proposal.tabId,proposal.visualParentTabId]));
      for(const {proposal,row} of rows) {
        if((row.visual_parent_tab_id || null)===proposal.visualParentTabId)continue;
        const seen=new Set([proposal.tabId]);let cursor=proposal.visualParentTabId;
        while(cursor) {
          if(seen.has(cursor))fail('workflow_drag_parent_cycle');seen.add(cursor);
          const parent=records[cursor];if(!parent)fail('workflow_drag_parent_missing');
          cursor=proposedParents.has(cursor)?proposedParents.get(cursor):parent.visual_parent_tab_id;
        }
      }
      workflows=request.workflows.map(proposal=>{
        const old=this.org.workflowRequired(proposal.workflowId);
        if(old.kind!==proposal.expectedKind || !same(dragPlacement(old.layout),proposal.expectedPlacement)
          || !same(old.metadata.reserveOrder || [],proposal.expectedReserveOrder)
          || !same(old.metadata.reserveRootOrder || [],proposal.expectedReserveRootOrder))fail('workflow_drag_destination_changed');
        return {proposal,old,layout:applyDragLayout(old.layout,proposal.beforeLayout,proposal.layout)};
      });
      // A move cannot leave a placement behind in an unguarded hidden/profile
      // owner. Every touched workflow must be part of this immutable command.
      const touched=new Set(workflows.map(({old})=>old.id));
      for(const space of this.org.listWorkflows())for(const ref of layoutReferences(space.layout)) {
        const proposal=request.tabs.find(tab=>tab.tabId===ref.tabId);
        if(proposal && proposal.workflowId!==space.id && !touched.has(space.id))fail('workflow_drag_unguarded_placement');
      }
    };
    return this.org.mutate('commitDrag',request,generation=>{
      const relationReceipts=[];
      for(const {proposal,current,row,subject,namespace} of rows) {
        if(proposal.workflowId!==current.membership.workflowId)this.db.prepare(
          'UPDATE workflow_org_memberships SET workflow_id=?,revision=revision+1 WHERE tab_id=?').run(proposal.workflowId,proposal.tabId);
        if((row.visual_parent_tab_id || null)!==proposal.visualParentTabId) {
          const native=subject.version===2;
          // Only the organizational column of the exact typed row is changed.
          this.db.prepare(`UPDATE tabs SET visual_parent_tab_id=?,closed_visual_parent_tab_id=NULL
            ${native?',execution_storage_revision=execution_storage_revision+1':''} WHERE id=? AND tab_id=?`).run(proposal.visualParentTabId,row.id,proposal.tabId);
          relationReceipts.push({version:1,kind:'visual-parent',mutationId:request.mutationId,storageId:row.id,
            namespace,tabId:proposal.tabId,subjectId:subject.subjectId || null,executionSubject:subject,
            fromRevision:native?row.execution_storage_revision:null,toRevision:native?row.execution_storage_revision+1:null,
            beforeParent:row.visual_parent_tab_id || null,afterParent:proposal.visualParentTabId});
        }
      }
      this.groups.applyDragAssignments(request.tabs);
      for(const {proposal,old,layout} of workflows) {
        this.org.validateLayout(old.id,layout);
        const metadata={...old.metadata,reserveOrder:proposal.reserveOrder,reserveRootOrder:proposal.reserveRootOrder};
        if(!same(layout,old.layout) || !same(metadata,old.metadata))this.db.prepare(
          'UPDATE workflow_org_workflows SET layout_json=?,metadata_json=?,revision=revision+1 WHERE workflow_id=?')
          .run(stableJson(layout),stableJson(metadata),old.id);
      }
      this.org.journal(generation,{reason:'painted-forest-drag',gestureId:request.gestureId,
        sourceRoots:request.sourceRootTabIds,sourceFamily:request.sourceFamilyIds,admissionRevision:request.expectedRevision,baseRevision});
      return {success:true,baseRevision,relationReceipts,tabIds:request.movingFamilyIds,
        workflowIds:workflows.map(({old})=>old.id),targetWorkflowId:request.targetWorkflowId};
    },{validateScope});
  }
}
module.exports={WorkflowDrag};
