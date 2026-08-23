'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { partitionProjectRuntimeTabs } = require('./project-tab-runtime-routing');

test('project tab status has one authority per provider', () => {
  const tabs = [
    { tabId: 'claude-a', owner: 'claude' },
    { tabId: 'codex-a', owner: 'codex' },
    { tabId: 'shell-a', owner: null },
    { tabId: 'codex-b', owner: 'codex' },
  ];
  const result = partitionProjectRuntimeTabs(tabs, (tab) => tab.owner);
  assert.deepEqual(result.rendererTabIds, ['claude-a']);
  assert.deepEqual(result.mainCodexTabs.map((tab) => tab.tabId), ['codex-a', 'codex-b']);
  assert.equal(result.rendererTabIds.includes('codex-a'), false);
});
