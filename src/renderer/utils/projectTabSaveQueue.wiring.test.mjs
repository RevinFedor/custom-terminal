import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.resolve(here, '../store/useWorkspaceStore.ts'), 'utf8');

test('all full tab snapshots use one per-project queue', () => {
  assert.match(store, /const projectTabSaveQueue = createProjectTabSaveQueue\(\)/);
  assert.match(store, /return projectTabSaveQueue\.enqueue\(projectId, \(\) => \(/);
});

test('closeTab resolves only after its reduced snapshot commits', () => {
  const start = store.indexOf('const closeSnapshot = closeCatalogs.size > 1');
  const end = store.indexOf('if (!isDurableSaveTabsAck(closeSnapshot))', start);
  assert.ok(start >= 0 && end > start);
  assert.match(store.slice(start, end), /await saveTabsBatchThenNotifyProjectLayoutChanged/);
  assert.match(store.slice(start, end), /await saveTabsThenNotifyProjectLayoutChanged/);
  assert.match(store.slice(start, end), /'tab-closed'/);
  assert.match(store, /\[CloseTab\] snapshot-committed/);
});
