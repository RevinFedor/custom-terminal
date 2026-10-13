import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..');
const dashboard = fs.readFileSync(path.join(renderer, 'components', 'Dashboard', 'Dashboard.tsx'), 'utf8');
const browser = fs.readFileSync(path.join(renderer, 'components', 'Dashboard', 'StorageBrowser.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(renderer, 'store', 'useUIStore.ts'), 'utf8');
const main = fs.readFileSync(path.join(renderer, '..', 'main', 'main.js'), 'utf8');

test('workflow Home keeps one Storage view with the existing details host', () => {
  assert.match(dashboard, /import StorageBrowser from '\.\/StorageBrowser'/);
  assert.equal((dashboard.match(/<StorageBrowser\b/g) || []).length, 1);
  assert.match(dashboard, /<StorageBrowser detailsHost=\{wide\?detailsHost:null\}/);
  assert.match(dashboard, /data-dashboard-root/);
  assert.match(dashboard, /data-home-create-workflow/);
  assert.match(dashboard, /className="home-detail-host"/);
  assert.doesNotMatch(dashboard, /!isProcessesLoading\s*&&\s*<StorageBrowser/);
});

test('Home storage uses global tooltips, provider filter, retention and opaque delete IPC', () => {
  assert.match(browser, /<ControlHint label=\{definition\.description\}/);
  assert.match(browser, /STORAGE_PROVIDER_FILTERS/);
  assert.match(browser, /storage:set-settings/);
  assert.match(browser, /storage:delete-items/);
  assert.match(browser, /storage:prepare-delete/);
  assert.match(browser, /confirmationToken: confirmation\.confirmationToken/);
  assert.match(browser, /generation: inventory\.generation/);
  assert.match(browser, /data-storage-date-from/);
  assert.match(browser, /data-storage-date-to/);
  assert.match(browser, /data-storage-select-all-checkbox/);
  assert.match(browser, /data-storage-select-all-filtered/);
  assert.match(browser, /data-storage-delete-checked/);
  assert.match(browser, /storage:delete-progress/);
  assert.match(browser, /operationId,/);
  assert.match(browser, /storageSelectionRangeIds\(visibleItems/);
  assert.match(browser, /storage_production_authority_unavailable/);
  assert.match(browser, /const confirmationPreparationSeqRef = useRef\(0\);/);
  assert.match(browser, /\n}\s*$/, 'StorageBrowser must not leave component-local confirmation code at module scope');
  assert.match(browser, /<Virtuoso/);
  assert.match(browser, /let storageInventoryCache: StorageInventory \| null = null/);
  assert.match(browser, /useState<StorageInventory \| null>\(\(\) => storageInventoryCache\)/);
  assert.doesNotMatch(browser, /requestIdleCallback\(refresh/);
  assert.doesNotMatch(browser, /STORAGE_SILENT_REVALIDATE_MS/);
  assert.match(uiStore, /storageBrowserExpanded: boolean/);
  assert.match(uiStore, /noted-terminal-storage-browser-expanded/);
  assert.doesNotMatch(browser, /setSelectedId\(visibleItems\[0\]/);
  assert.doesNotMatch(browser, /unlink|rmSync|renderer\.send\(.+path/);
});

test('main owns inventory, deletion and bounded automatic retention', () => {
  assert.match(main, /ipcMain\.handle\('storage:get-inventory'/);
  assert.match(main, /ipcMain\.handle\('storage:delete-items'/);
  assert.match(main, /ipcMain\.handle\('storage:prepare-delete'/);
  assert.match(main, /scheduleStorageRetentionSweep\(90_000\)/);
  assert.match(main, /canOwnAutomaticStorageRetention/);
  assert.match(main, /getMutationAuthority: getStorageMutationAuthority/);
  assert.match(main, /auditPath: path\.join\(canonicalNotedUserDataDir, 'storage-deletion-audit\.jsonl'\)/);
  assert.match(main, /getRuntimeProtectedSessionIds: storageRuntimeProtectedSessionIds/);
  assert.match(main, /relationDatabases: getStorageRelationDatabases\(\)/);
  assert.match(main, /currentEnvironment: app\.isPackaged \? 'production' : 'development'/);
  assert.match(main, /event\.sender\.send\('storage:delete-progress'/);
});
