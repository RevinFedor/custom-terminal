import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.join(import.meta.dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('main/main.js');
const history = read('renderer/components/Workspace/HistoryPanel.tsx');
const controlBar = read('renderer/components/Workspace/ClaudeControlBar.tsx');

test('provisional settings are a level-triggered runtime snapshot, not a lossy tui-ready edge', () => {
  const projectionStart = main.indexOf('function projectCodexRuntimeSnapshotFromEvents');
  const projectionEnd = main.indexOf('function publishCodexRuntimeProjection', projectionStart);
  const projection = main.slice(projectionStart, projectionEnd);
  assert.match(projection, /getCodexProvisionalSettingsSnapshot\(tabId\)/);
  assert.match(projection, /\.\.\.\(provisionalSettings \|\| \{\}\)/);

  const presenceHandlerStart = main.indexOf("ipcMain.handle('codex:get-runtime-projection'");
  const presenceHandlerEnd = main.indexOf("ipcMain.handle('codex:get-rewind-writer-authorization'", presenceHandlerStart);
  const presenceHandler = main.slice(presenceHandlerStart, presenceHandlerEnd);
  assert.match(presenceHandler, /publishCodexRuntimeProjection\(tabId, 'renderer-presence-query', projectId\)/);

  const snapshotHandlerStart = history.indexOf('const handleRuntimeSnapshotChange = useCallback');
  const snapshotHandlerEnd = history.indexOf('useEffect(() => {', snapshotHandlerStart);
  const snapshotHandler = history.slice(snapshotHandlerStart, snapshotHandlerEnd);
  assert.match(snapshotHandler, /projectCodexProvisionalSettingsOverlay\(snapshot\)/);
  assert.match(snapshotHandler, /updateCodexLiveState\(tabId, provisionalSettingsPatch\)/);

  assert.match(controlBar, /projectCodexProvisionalSettingsOverlay\(snapshot\)/,
    'the initial read remains an optimization, while History presence owns missed-edge recovery');
});
