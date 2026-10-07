import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWorkflowGlobalGroups, workflowGlobalGroupMembers, workflowLegacyGlobalGroup, workflowGroupChoices,
  workflowGroupDisplayName } from './workflowGlobalGroups.mjs';
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
test('archival placeholders cannot become new assignment choices; explicit later names and provenance survive',()=>{
  const placeholder={id:'global-placeholder',name:'legacy-opaque-id',legacyGroupId:'legacy-opaque-id',missingLegacyDefinition:true};
  const renamed={...placeholder,id:'renamed',name:'Design'};
  const input={...publication,groups:[...publication.groups,placeholder,renamed]};
  const before=structuredClone(input);
  assert.deepEqual(workflowGroupChoices(input).map(group=>group.id),['g','other','renamed']);
  assert.equal(workflowGroupDisplayName(placeholder),'Группа без названия');
  assert.equal(workflowGroupDisplayName(renamed),'Design');
  assert.deepEqual(input,before);
});
