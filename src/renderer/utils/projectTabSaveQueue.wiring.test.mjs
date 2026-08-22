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
  assert.match(
    store,
    /const closeSnapshot = await saveTabsThenNotifyProjectLayoutChanged\([\s\S]{0,260}'tab-closed'/,
  );
  assert.match(store, /\[CloseTab\] snapshot-committed/);
});
