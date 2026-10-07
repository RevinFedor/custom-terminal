import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {buildSync} from 'esbuild';

// Execute the actual retained TabBar effects against the actual pane bridge.
// A component-only reserve fixture omits precisely this competing owner.
const source=ts.createSourceFile('TabBar.tsx',fs.readFileSync(new URL('./TabBar.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const effects=[];
const visit=node=>{
  if(ts.isCallExpression(node) && node.expression.getText(source)==='useEffect')effects.push(node.arguments[0].getText(source));
  ts.forEachChild(node,visit);
};visit(source);
const sync=effects.find(body=>body.includes('const navigationMode = tabOutlineDnd.dragState?.navigationMode === true;'));
const cleanup=effects.find(body=>body.includes('endPaneTabDrag(current.source.rootTabId)') && !body.includes('const navigationMode'));
assert.ok(sync && cleanup);
const bridgeCode=buildSync({entryPoints:[new URL('../../utils/paneTabDragBridge.ts',import.meta.url).pathname],
  bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text;
function fixture({menuOnlyForProject=true,active=false}={}){
  const module={exports:{}};vm.runInNewContext(bridgeCode,{module,exports:module.exports,console:{log(){}},
    require:()=>({useSyncExternalStore(){}})});
  const api=module.exports,bindings={...api,menuOnlyForProject,projectId:'P',sidebarDragOrigin:null,
    tabOutlineDnd:{dragState:{navigationMode:active}},sharedOutlineDragActive:active,
    sharedOutlineRootTabIds:['legacy-root'],sharedOutlineSourceTabIds:['legacy-root'],
    structuredExternalTarget:{zone:'body',paneKey:'pane:0',paneIndex:0,spaceId:'w',at:Infinity}};
  const effect=body=>{
    const code=ts.transpileModule('module.exports='+body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    const module={exports:null};vm.runInNewContext(code,{...bindings,module,exports:module.exports});return module.exports;
  };
  const beginWorkflow=()=>api.beginPaneTabDrag({owner:'sidebar',input:'pointer',rootTabId:'R0',gestureId:'physical-1',
    workflowDrag:{gestureId:'physical-1'},entries:[{projectId:'P',tabId:'R0'},{projectId:'P',tabId:'R4'}]});
  return {api,bindings,beginWorkflow,sync:()=>effect(sync)(),cleanup:()=>effect(cleanup)()};
}

test('menu-only retained TabBar cannot clear the reserve pane target on Meta publication',()=>{
  const f=fixture();f.beginWorkflow();const before=f.api.getPaneTabDragSnapshot();f.sync();
  assert.equal(f.api.getPaneTabDragSnapshot(),before);
});
test('menu-only stale drag cannot overwrite the new physical workflow gesture',()=>{
  const f=fixture({active:true});f.beginWorkflow();const before=f.api.getPaneTabDragSnapshot();f.sync();
  assert.equal(f.api.getPaneTabDragSnapshot(),before);
});
test('legacy cleanup during cutover cannot end a workflow-owned pointer',()=>{
  const f=fixture({menuOnlyForProject:false});const dispose=f.cleanup();f.beginWorkflow();
  const before=f.api.getPaneTabDragSnapshot();dispose?.();assert.equal(f.api.getPaneTabDragSnapshot(),before);
});
test('ordinary legacy navigation still starts and ends its pane bridge',()=>{
  const f=fixture({menuOnlyForProject:false,active:true});f.sync();
  assert.equal(f.api.getPaneTabDragSnapshot().source.rootTabId,'legacy-root');
  assert.equal(f.api.getPaneTabDragSnapshot().target.zone,'body');
  f.bindings.sharedOutlineDragActive=false;f.sync();assert.equal(f.api.getPaneTabDragSnapshot().active,false);
});
