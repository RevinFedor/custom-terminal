// Close of a LIVE-but-idle Codex tab: the archive's writer-proof refusal is
// resolved by stopping the process and retrying the History write — pinned to
// the store source, because the pure logic (tabPersistenceTransactions) was
// correct while the wiring around it silently returned false with no UI.
//
// The reported symptom: middle-click on a Codex tab with an open (not even
// answering) session did nothing — no loader, no dialog, no error. Right-click
// → Стоп → close worked, because the manual stop removed the live process and
// with it the refusal condition.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = fs.readFileSync(path.join(here, 'useWorkspaceStore.ts'), 'utf8');

const closeTab = (() => {
  const from = store.indexOf('closeTab: async (projectId, tabId, options) => {');
  assert.ok(from >= 0);
  const to = store.indexOf('\n  reopenLastClosedTab', from);
  return store.slice(from, to > from ? to : undefined);
})();

test('the close archive goes through the stop-and-retry wrapper', () => {
  assert.match(closeTab, /commitArchiveWithStopRetry\(/);
  assert.match(closeTab, /commandType: effectiveCommandType/);
  assert.match(closeTab, /toolType: effectiveCommandType/);
  assert.match(closeTab, /reason: 'close-tab-archive-retry'/);
  // The old direct call must be gone — two archive calls with different rules
  // is exactly the drift this file guards against.
  assert.doesNotMatch(closeTab, /commitArchiveBeforeClose\(/);
});

test('the closing loader is up BEFORE the archive, and cleared on refusal', () => {
  // The Codex archive can spend real time (writer proof, stop, retry); a click
  // with no visible reaction for that long was the reported bug.
  const loaderAt = closeTab.indexOf('showsPreArchiveLoader');
  const archiveAt = closeTab.indexOf('commitArchiveWithStopRetry(');
  const refusalAt = closeTab.indexOf('if (!archiveCommit.ok) {');
  const clearAt = closeTab.indexOf('clearClosingLoader();');
  assert.ok(loaderAt >= 0 && loaderAt < archiveAt, 'loader must precede the archive');
  assert.ok(refusalAt > archiveAt && clearAt > refusalAt, 'refusal must clear the loader');
});

test('a refusal that survives the retry is SAID to the user, not swallowed', () => {
  const refusal = closeTab.slice(
    closeTab.indexOf('if (!archiveCommit.ok) {'),
    closeTab.indexOf('return false;', closeTab.indexOf('if (!archiveCommit.ok) {')),
  );
  assert.match(refusal, /showToast\(/);
});
