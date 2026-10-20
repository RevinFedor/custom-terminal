const test=require('node:test'),assert=require('node:assert/strict');
const {paneStripColorGroupsBasis,mergePaneStripColorGroups,adoptPaneStripColorGroups,projectActivePaneStripGroups}=require('./pane-strip-color-groups.cjs');
test('missing differs from unknown/null/future state; stale incidental snapshot preserves Main field and cannot manufacture one',()=>{
  for(const unknown of [null,{version:2,revision:1,groups:[]},{version:1,revision:NaN,groups:[]}])
    assert.throws(()=>paneStripColorGroupsBasis(unknown));
  assert.equal(mergePaneStripColorGroups(undefined,{version:1,revision:999,groups:[]},undefined),undefined);
  const future={version:2,opaque:'keep'};assert.equal(mergePaneStripColorGroups(future,null,undefined),future);
  const before=[{id:'W',name:'draft',layout:{keep:true}}],after=adoptPaneStripColorGroups(before,[{id:'W',stripColorGroups:null}]);
  assert.equal(after[0].stripColorGroups,null);assert.equal(after[0].name,'draft');assert.equal(after[0].layout,before[0].layout);
});
test('explicit basis cannot reassign an existing group membership while changing color',()=>{
  const current={version:1,revision:1,groups:[{id:'g',color:'#123456',revision:1,tabIds:['a','b']}]};
  assert.throws(()=>mergePaneStripColorGroups(current,{version:1,revision:2,groups:[{...current.groups[0],color:'#ffffff',revision:2,tabIds:['a','c']}]},
    {basis:paneStripColorGroupsBasis(current)}),/membership_changed/);
});
test('active projection omits only false, retains unknown and raw provenance; field edit distinguishes retained from newly closed/foreign members',()=>{
  const raw=[{id:'g',revision:1,color:'#123456',tabIds:['a','b','unknown']}];
  assert.deepEqual(projectActivePaneStripGroups(raw,id=>id==='b'?false:undefined)[0].tabIds,['a','unknown']);
  assert.deepEqual(raw[0].tabIds,['a','b','unknown']);assert.equal(projectActivePaneStripGroups(raw,()=>undefined),raw);
  const current={version:1,revision:1,groups:[{...raw[0],tabIds:['a','b']}]},next={version:1,revision:2,
    groups:[{...current.groups[0],color:'#abcdef',revision:2}]},edit={basis:paneStripColorGroupsBasis(current)};
  assert.equal(mergePaneStripColorGroups(current,next,edit,id=>({active:id==='a',member:true})),next);
  assert.throws(()=>mergePaneStripColorGroups(current,next,edit,id=>({active:id==='a',member:id==='a'})),/membership_changed/);
  assert.throws(()=>mergePaneStripColorGroups(undefined,{...current}, {basis:paneStripColorGroupsBasis(undefined)},
    id=>({active:id==='a',member:true})),/membership_changed/);
});
