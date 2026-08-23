import assert from 'node:assert/strict';
import test from 'node:test';
import { isSamePaneDrop } from './paneTabDropIdentity.mjs';

test('pane index alone cannot identify a window across workflows', () => {
  const source = { sourcePaneKey: 'pane:0', sourceSpaceId: 'workflow-a' };
  assert.equal(isSamePaneDrop(source, { paneKey: 'pane:0', spaceId: 'workflow-a' }, 'workflow-a'), true);
  assert.equal(isSamePaneDrop(source, { paneKey: 'pane:0', spaceId: 'workflow-b' }, 'workflow-b'), false);
});
