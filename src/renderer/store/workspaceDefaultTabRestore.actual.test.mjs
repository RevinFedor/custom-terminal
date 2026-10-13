import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const text=fs.readFileSync(new URL('./useWorkspaceStore.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('store.ts',text,ts.ScriptTarget.Latest,true);
function find(root,predicate){let result;function visit(n){if(!result&&predicate(n))result=n;if(!result)ts.forEachChild(n,visit);}visit(root);assert.ok(result);return result;}
for(const name of ['restoreSession','openProject']) {
 const action=find(tree,n=>ts.isPropertyAssignment(n)&&n.name.getText(tree)===name);
 const branch=find(action,n=>ts.isIfStatement(n)&&n.expression.getText(tree).includes('isInbox')
   &&n.thenStatement.getText(tree).includes('defaultTabFailed'));
 const creates=Function('isInbox','projectData','return ('+branch.expression.getText(tree)+');');
 test(name+': known empty execution namespace does not invent a legacy Terminal 1',()=>{
  assert.equal(creates(false,{executionScopeVersion:2,tabs:[],path:null}),false);
  assert.equal(creates(true,{tabs:[]}),false,'Inbox remains empty');
  assert.equal(creates(false,{path:'/legacy',tabs:[]}),true,'legacy Project default remains supported');
  assert.equal(creates(false,null),true,'existing legacy missing-row recovery remains unchanged');
 });
}
