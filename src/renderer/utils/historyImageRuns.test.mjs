import test from 'node:test';
import assert from 'node:assert/strict';
import { historyImageRuns } from './historyImageRuns.mjs';
import { buildHistoryComposerPresentationParts } from '../../shared/composer-chips.mjs';

test('only whitespace between exact image occurrences becomes a horizontal run; text keeps its place', () => {
  const parts = [{kind:'image',id:1},{kind:'text',text:'\n\n'},{kind:'image',id:2},
    {kind:'text',text:' keep this text '},{kind:'image',id:3}];
  const result = historyImageRuns(parts);
  assert.deepEqual(result[0].items.map(i=>i.index),[0,2]);
  assert.equal(result[1].part,parts[3]); assert.equal(result[2].items[0].index,4);
  assert.equal(parts[1].text,'\n\n');
});
test('intentional same-path images retain two slot identities and preview refs', () => {
  const imagePaths=[{id:1,path:'/image.jpg'},{id:2,path:'/image.jpg'}];
  const parsed=buildHistoryComposerPresentationParts({text:'[imagePath: /image.jpg]\n\n[imagePath: /image.jpg]',imagePaths});
  const result=historyImageRuns(parsed.parts);
  assert.deepEqual(result[0].items.map(i=>[i.part.id,i.part.ref.id]),[[1,1],[2,2]]);
});
