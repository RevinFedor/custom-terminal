import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTabLinkedFiles, tabLinkedFilesSnapshot, isLinkedFilePreview, placeLinkedFilePopup } from './tabLinkedFiles.mjs';

test('all file types across catalogs are direct links; descendants and project inheritance never count', () => {
  const catalogs = new Map([
    ['a', { tabs: new Map([['owner', { id: 'owner' }], ['child', { id: 'child', parentTabId: 'owner' }],
      ['md', { id: 'md', tabType: 'file', filePath: '/docs/spec.md', visualParentTabId: 'owner' }],
      ['nested', { id: 'nested', tabType: 'file', filePath: '/child.md', visualParentTabId: 'child' }],
      ['ai', { id: 'ai', tabType: 'terminal', visualParentTabId: 'owner' }]]) }],
    ['b', { tabs: new Map([['png', { id: 'png', tabType: 'file', filePath: '/image.png', visualParentTabId: 'owner' }],
      ['json', { id: 'json', tabType: 'file', filePath: '/config.json', visualParentTabId: 'owner' }],
      ['free', { id: 'free', tabType: 'file', filePath: '/spec.md' }]]) }],
  ]);
  const links = collectTabLinkedFiles(catalogs, 'owner');
  assert.deepEqual(links.map(x => x.id), ['md', 'png', 'json']);
  assert.equal(links[1].projectId, 'b');
  assert.equal(links[0].name, 'spec.md');
  assert.deepEqual(collectTabLinkedFiles(catalogs, 'missing'), []);
  assert.equal(tabLinkedFilesSnapshot(catalogs, 'owner'), JSON.stringify(links));
});
test('selection names both owner and exact link, including identical paths', () => {
  const preview = { source: 'tab', ownerTabId: 'owner', sourceTabId: 'file1', sourceProjectId: 'a', path: '/same.md' };
  assert.equal(isLinkedFilePreview(preview, 'owner', 'file1', 'a'), true);
  assert.equal(isLinkedFilePreview(preview, 'other', 'file1', 'a'), false);
  assert.equal(isLinkedFilePreview(preview, 'owner', 'file2', 'a'), false);
  assert.equal(isLinkedFilePreview(preview, 'owner', 'file1', 'b'), false);
  assert.equal(isLinkedFilePreview({ path: '/same.md' }, 'owner'), false);
});
test('popup flips at bottom and clamps long-name width and tall lists to viewport', () => {
  assert.deepEqual(placeLinkedFilePopup({ left: 290, top: 260, bottom: 275 }, { width: 120, height: 80 }, { width: 320, height: 300 }),
    { left: 192, top: 176, maxHeight: 248, flip: true });
  const long = placeLinkedFilePopup({ left: 0, top: 20, bottom: 40 }, { width: 900, height: 1000 }, { width: 320, height: 300 });
  assert.equal(long.left, 8); assert.equal(long.maxHeight, 248); assert.equal(long.flip, false);
});
