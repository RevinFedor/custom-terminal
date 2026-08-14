import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const historyPanel = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);

test('History delegates Claude and Codex live user ownership to the exact shared policy', () => {
  assert.match(
    historyPanel,
    /shouldIncludeHistoryLiveUserText\(\{\s*toolType,\s*envelope: detail,\s*localHandoffs,\s*currentEntries: current,/,
  );
  const liveStart = historyPanel.indexOf("ipcRenderer.on('agent-transcript:live-message'");
  const liveEnd = historyPanel.indexOf("ipcRenderer.removeListener('agent-transcript:live-message'", liveStart);
  assert.notEqual(liveStart, -1);
  assert.notEqual(liveEnd, -1);
  const liveHandler = historyPanel.slice(liveStart, liveEnd);
  assert.doesNotMatch(
    liveHandler,
    /const includeUserText = toolType === 'claude'/,
    'Codex manual user rows must not be hidden by the former provider-wide gate',
  );
});
