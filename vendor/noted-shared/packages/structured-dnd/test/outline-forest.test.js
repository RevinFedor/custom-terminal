import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDragRoots, prepareDrag, projectVerticalMove, getSubtreeIds,
  projectForestToRootEnd, detachedBoundaryTops, forestAnchorOffset, boundaryFromGeometry } from '../src/core/index.js';

const node = (id, children = [], extra = {}) => ({ id, children, ...extra });
test('noncontiguous A,Q,B: pickup B leaves tree intact; one projection moves A+B in original order', () => {
  const tree = [node('A'), node('Q'), node('B'), node('Z')], original = structuredClone(tree);
  const prepared = prepareDrag(tree, 'B', {sourceRootIds:['B','A']});
  assert.deepEqual(tree, original);
  assert.deepEqual(prepared.sourceRootIds, ['A','B']);
  assert.equal(prepared.sourceNode.id, 'B');
  assert.deepEqual(prepared.baseTree.map(n=>n.id), ['Q','Z']);
  for (const [boundary, expected] of [[0,['A','B','Q','Z']], [2,['Q','Z','A','B']]]) {
    const result = projectVerticalMove({...prepared,boundary,preferredDepth:0});
    assert.deepEqual(result.tree.map(n=>n.id),expected);
    assert.deepEqual(result.tree.flatMap(getSubtreeIds).sort(), ['A','B','Q','Z']);
  }
});
test('selected ancestor covers selected hidden descendants without losing clicked anchor', () => {
  const tree = [node('A',[node('child',[node('hidden')])],{collapsible:true,expanded:false}),node('Q'),node('B')];
  assert.deepEqual(normalizeDragRoots(tree,['child','B','A','hidden']), ['A','B']);
  const prepared = prepareDrag(tree,'child',{sourceRootIds:['child','B','A']});
  assert.deepEqual(prepared.sourceIds,['A','child','hidden','B']);
  assert.equal(prepared.sourceNode.id,'child');
  const preview=projectForestToRootEnd(tree,'child',prepared.sourceRootIds);
  assert.deepEqual(preview.map(n=>n.id),['Q','A','B']);
  assert.deepEqual(preview[1],tree[0]);
});
test('disjoint footprints remove only A+B; clicked B offset excludes intervening Q', () => {
  const rows=[{id:'A',top:10,bottom:30},{id:'Q',top:36,bottom:86},
    {id:'B',top:92,bottom:122},{id:'Z',top:128,bottom:148}];
  const sourceIds=['A','B'];
  assert.deepEqual(detachedBoundaryTops({rows,sourceIds,currentBoundary:1,allowDisjoint:true}),[10,66,92]);
  assert.equal(forestAnchorOffset({rows,sourceIds,anchorId:'B'}),26);
  assert.equal(boundaryFromGeometry({sourceTop:92-26,boundaryTops:[10,66,92]}),1);
  assert.deepEqual(detachedBoundaryTops({rows,sourceIds,currentBoundary:1}),[]);
});
test('single-source API retains its shape and ordinary subtree behavior', () => {
  const tree=[node('A',[node('child')]),node('B')],prepared=prepareDrag(tree,'A');
  assert.equal(prepared.sourceRootIds,undefined);
  assert.deepEqual(projectVerticalMove({...prepared,boundary:1}).tree.map(n=>n.id),['B','A']);
});
test('roots from different parents retain all child edges during one common Y projection', () => {
  const tree=[node('P',[node('A',[node('a1')]),node('Q')]),node('R',[node('B')])];
  const prepared=prepareDrag(tree,'B',{sourceRootIds:['A','B']});
  const result=projectVerticalMove({...prepared,boundary:0,preferredDepth:0});
  assert.deepEqual(result.tree.map(n=>n.id),['A','B','P','R']);
  assert.deepEqual(result.tree[0].children.map(n=>n.id),['a1']);
  assert.deepEqual(result.tree[2].children.map(n=>n.id),['Q']);
  assert.deepEqual(result.tree[3].children,[]);
});
