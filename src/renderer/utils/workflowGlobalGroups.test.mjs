import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowGlobalGroups, workflowGlobalGroupMembers, workflowLegacyGlobalGroup } from './workflowGlobalGroups.mjs';
const publication = { version:1,revision:4,groups:[{id:'g',name:'Shared',collapsed:true,legacyNamespace:'P',legacyGroupId:'same',future:5},
  {id:'other',name:'Other',legacyNamespace:'Q',legacyGroupId:'same'}],tabGroups:{a:'g',b:'g',c:'g',archive:'g',file:'g',child:'other'} };
const catalog = new Map(['a','b','c','archive','file','child'].map(id => [id,{tabId:id,projectId:id==='b'?'Q':'P',tab:{id,archived:id==='archive',
  ...(id==='file'?{tabType:'file',visualParentTabId:'a'}:{}),...(id==='child'?{parentTabId:'a'}:{})}}]));
const membership = {a:{workflowId:'w'},b:{workflowId:'w'},c:{workflowId:'other-w'},archive:{workflowId:'w'},file:{workflowId:'w'},child:{workflowId:'w'}};
test('partial/cross workflow projection retains one global definition and exact reserve order',()=>{
  const before=JSON.stringify([...catalog]);
  const selected=selectWorkflowGlobalGroups({publication,catalog,membership,workflowId:'w',reserveTabIds:['b','c','file','archive'],orderedTabIds:['file','b']});
  assert.deepEqual(selected.visibleGroups.get('g').members.map(x=>x.tabId),['file','b']);
  assert.equal(selected.groups.size,2);assert.equal(selected.visibleGroups.size,1);assert.equal(selected.visibleGroups.get('g').future,5);
  assert.equal(JSON.stringify([...catalog]),before);assert.equal(selected.tabGroups.get('child'),'other');
});
test('fully placed groups vanish only from sidebar projection',()=>{
  const selected=selectWorkflowGlobalGroups({publication,catalog,membership,workflowId:'w',reserveTabIds:[]});
  assert.equal(selected.visibleGroups.size,0);assert.equal(selected.groups.size,2);assert.equal(selected.tabGroups.size,6);
});
test('exact members never inherit parent group/file relationships and archive excluded by default',()=>{
  assert.deepEqual(workflowGlobalGroupMembers(publication,'g',catalog).map(x=>x.tabId),['a','b','c','file']);
  assert.equal(workflowGlobalGroupMembers(publication,'g',catalog,{includeArchived:true}).length,5);
  assert.equal(workflowLegacyGlobalGroup(publication,'Q','same').id,'other');
  assert.equal(workflowLegacyGlobalGroup(publication,'wrong','same'),null);
});
