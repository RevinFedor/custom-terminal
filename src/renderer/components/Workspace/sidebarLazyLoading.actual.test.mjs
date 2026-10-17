import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./Sidebar.jsx',import.meta.url),'utf8');
const start=source.indexOf('  const loadTreeRecursive = useCallback('),end=source.indexOf('\n  useEffect(',start);
assert.ok(start>=0&&end>start);
function loader(readDirectory) {
  const context={window:{electronAPI:{readDirectory}},useCallback:fn=>fn,sortModeRef:{current:'name-asc'},
    getSortComparator:()=>((a,b)=>a.name.localeCompare(b.name)),console:{log(){}}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.load=loadTreeRecursive;',context);
  return context.load;
}
test('actual sidebar loader reads one collapsed level and retains ordinary dependency folders for explicit expansion',async()=>{
  const reads=[],load=loader(async p=>{reads.push(p);return[{name:'node_modules',path:p+'/node_modules',isDirectory:true},{name:'docs',path:p+'/docs',isDirectory:true}];});
  const nodes=await load('/root',{});
  assert.deepEqual(reads,['/root']);
  assert.deepEqual(Array.from(nodes,n=>n.name),['docs','node_modules']);
  assert.ok(nodes.every(n=>n.children.length===0));
});
test('actual sidebar loader restores only explicitly expanded directories rather than every loaded folder',async()=>{
  const reads=[],load=loader(async p=>{reads.push(p);return p==='/root'?[{name:'docs',path:'/root/docs',isDirectory:true},{name:'closed',path:'/root/closed',isDirectory:true}]:[{name:'note.md',path:p+'/note.md',isDirectory:false}];});
  const nodes=await load('/root',{'/root/docs':true,'/root/closed':false});
  assert.deepEqual(reads,['/root','/root/docs']);
  assert.equal(nodes.find(n=>n.name==='closed').children.length,0);
  assert.equal(nodes.find(n=>n.name==='docs').children[0].name,'note.md');
});
