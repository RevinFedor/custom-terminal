import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);

test('response clock lives in the History footer, never in the composer plate', () => {
  assert.match(source, /data-history-tail-response-timer/);
  assert.doesNotMatch(source, /data-history-response-timer(?:\s|>)/);
  assert.match(source, /Footer:\s*HistoryTerminalPreviewFooter/);
});

test('one-second ticks are isolated inside the O(1) footer component', () => {
  const start = source.indexOf('const HistoryResponseTailTimer');
  const end = source.indexOf('const openTerminalHistoryPreviewContextMenu', start);
  assert.ok(start >= 0 && end > start);
  const timerComponent = source.slice(start, end);
  assert.match(timerComponent, /setInterval\(\(\) => setClock\(Date\.now\(\)\), 1000\)/);
  assert.doesNotMatch(source, /activityClock/);
});

test('group headers do not confuse summed thinking with response work time', () => {
  assert.doesNotMatch(source, /hp-history-group-think/);
  assert.doesNotMatch(source, />\{thinkingLabel\}<\/span>/);
});

test('a tab switch cannot publish the previous owner timing under the new tab', () => {
  assert.match(
    source,
    /activityTimingOwnerMatches\s*=\s*activityTimingOwnerKeyRef\.current\s*===\s*tabId\s*\+\s*':'\s*\+\s*toolType/,
  );
  assert.match(source, /!activityTimingOwnerMatches\s*\?\s*null/);
});
