import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rendererRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(rendererRoot, ...parts), 'utf8');

const store = read('store', 'useUIStore.ts');
const history = read('components', 'Workspace', 'HistoryPanel.tsx');
const timeline = read('components', 'Workspace', 'Timeline.tsx');
const switcher = read('components', 'Workspace', 'TabSwitcherOverlay.tsx');
const home = read('components', 'Workspace', 'ProjectHome.tsx');

test('a History jump names one tab instead of waking every persistent panel', () => {
  assert.match(store, /historyScrollTargetTabId: string \| null/);
  assert.match(store, /setHistoryScrollToUuid: \(uuid: string \| null, tabId\?: string \| null\)/);
  assert.match(history, /historyScrollTargetTabId === tabId[\s\S]*?requestedHistoryScrollUuid/);
  assert.match(history, /pendingJump\.historyScrollTargetTabId === tabId/);

  const timelineCalls = timeline.match(/setHistoryScrollToUuid\([^)]*\)/g) || [];
  assert.equal(timelineCalls.length, 3);
  timelineCalls.forEach((call) => assert.match(call, /,\s*tabId\s*\)$/));

  assert.match(switcher, /setHistoryScrollToUuid\(\s*target\.entryUuid,\s*target\.tabId/);
  assert.match(home, /setHistoryScrollToUuid\(targetUuid, previewTabId\)/);
  assert.match(home, /selectedPreview\.targetUuid!,\s*previewTabId/);
  assert.match(history, /onJumpToCard=\{\(entryUuid\) => setHistoryScrollToUuid\(entryUuid, tabId\)\}/);
});

test('a live Timeline point resolves exact source identity to the canonical History UUID', () => {
  assert.match(timeline, /historyNavigationIdentityForTimelineEntry\(entry\)/);
  assert.match(history, /resolveHistoryNavigationTarget\(\s*entries,\s*requestedTargetIdentity/);
  assert.match(history, /const targetUuid = resolvedNavigationTarget\?\.uuid \|\| requestedTargetIdentity/);
  assert.match(
    history,
    /history-panel:scrolled-to'[\s\S]{0,160}uuid: requestedTargetIdentity[\s\S]{0,80}targetUuid/,
  );
});
