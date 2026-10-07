import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');
const start = source.indexOf('closeTab: async (projectId, tabId, options)');
const end = source.indexOf('\n\n  restoreTabHistoryEntry:', start);
assert.ok(start >= 0 && end > start, 'closeTab implementation not found');
const closeTab = source.slice(start, end);

test('close persists an exact candidate before removing it from renderer state', () => {
  const expectedAt = closeTab.indexOf('const expectedTabIdsBeforeClose = Array.from(workspace.tabs.keys())');
  const preflightAt = closeTab.indexOf("ipcRenderer.invoke('project:validate-tab-snapshot'");
  const candidateAt = closeTab.indexOf('const closeCandidateTabs = tabsAfterClose(');
  const persistAt = closeTab.indexOf('const closeSnapshot = closeCatalogs.size > 1');
  const rejectAt = closeTab.indexOf('if (!isDurableSaveTabsAck(closeSnapshot))');
  const publishAt = closeTab.indexOf('for (const catalog of closeCatalogs.values()) catalog.workspace.tabs = catalog.tabs');
  const bufferCleanupAt = closeTab.indexOf('clearTerminalBuffer(tabId)');

  assert.ok(expectedAt >= 0);
  assert.ok(preflightAt > expectedAt);
  assert.ok(candidateAt > expectedAt);
  assert.ok(persistAt > candidateAt);
  assert.ok(rejectAt > persistAt);
  assert.ok(publishAt > rejectAt);
  assert.ok(bufferCleanupAt > publishAt, 'renderer buffer must survive until the close ACK');
  assert.match(closeTab.slice(persistAt, rejectAt), /expectedTabIdsBeforeClose/);
  assert.match(closeTab.slice(persistAt, rejectAt), /await saveTabsBatchThenNotifyProjectLayoutChanged/);
  assert.match(closeTab.slice(persistAt, rejectAt), /await saveTabsThenNotifyProjectLayoutChanged/);
  assert.doesNotMatch(closeTab.slice(0, persistAt), /workspace\.tabs\.delete\(tabId\)/);
});
