import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.resolve(here, relative), 'utf8');

const history = read('../components/Workspace/HistoryPanel.tsx');
const timeline = read('../components/Workspace/Timeline.tsx');
const pane = read('../components/Workspace/SplitPaneSurface.tsx');
const persistentTimeline = read('../components/Workspace/PersistentPaneTimeline.tsx');

test('trusted presented wheel owns renderer foreground priority', () => {
  assert.match(history, /historyForegroundPriority\.mark\(tabId, HISTORY_FOREGROUND_PRIORITY_HOLD_MS\)/);
  assert.match(history, /historyPresentationProofRef\.current\.presented/);
  assert.match(history, /\(event as WheelEvent\)\.isTrusted/);
});

test('History and Timeline defer state-heavy apply without discarding results', () => {
  assert.match(history, /waitForHistoryApplySlot\(isRefresh \? 'refresh' : 'cold', \{/);
  assert.match(history, /LOAD_APPLY_PRIORITY/);
  assert.match(history, /isHistoryLightweightServiceDelta\(\{/);
  assert.match(history, /outcome=visible-service-delta/);
  assert.match(history, /shouldBypassHistoryApplyPriority\(\{[\s\S]{0,260}phase,[\s\S]{0,260}presented: historyPresentationProofRef\.current\.presented,[\s\S]{0,260}ownerCurrent: isCurrentOwner\(\),[\s\S]{0,260}lightweightServiceDelta/);
  assert.doesNotMatch(history, /phase === 'cold' && presentedNow && !historyForegroundPriority\.active\(\)/);
  assert.match(history, /Refresh: update when count[\s\S]*startTransition\(\(\) => \{[\s\S]*setEntries\(prev => \{/);
  assert.match(timeline, /waitForTimelineApplySlot\('codex'\)/);
  assert.match(timeline, /Perf:TimelineApplyPriority/);
  assert.match(timeline, /waitForTimelineApplySlot\('codex'\)[\s\S]*startTransition\(\(\) => \{[\s\S]*setEntriesSnapshot/);
  assert.doesNotMatch(history, /historyForegroundPriority[^\n]*return false/);
});

test('dormant admission and mount waves yield, while exact pane visibility remains authoritative', () => {
  assert.match(pane, /scheduleDormantSurfaceAdmission[\s\S]*waitForBackgroundSlot/);
  assert.match(pane, /startBackgroundPrewarm[\s\S]*startTransition\(\(\) => \{[\s\S]*setSurfacesAwake\(true\)/);
  assert.match(history, /historyForegroundPriority\.active\(\)[\s\S]*retryHistoryMountWaveAfterForeground/);
  assert.match(history, /registerInterruptibleBackgroundWork\([\s\S]*MOUNT_WAVE_PREEMPT/);
  assert.match(history, /meta\.pendingStepToken !== stepToken/);
  assert.match(pane, /initialPresented=\{historySurfacePresented\}/);
  assert.match(persistentTimeline, /isVisible=\{presented\}/);
  assert.match(pane, /backgroundPrewarmAdmitted=\{heavyActivationPhase === 'timeline' && !historySurfacePresented\}/);
});

test('hidden terminal preview coalesces behind continuous drag and never reads hidden geometry', () => {
  assert.match(history, /TERMINAL_PREVIEW_DEFER/);
  assert.match(history, /!historyPresentationProofRef\.current\.presented && historyForegroundPriority\.active\(\)/);
  assert.match(history, /waitForBackgroundSlot\(\{[\s\S]{0,220}historyPresentationProofRef\.current\.presented/);
  assert.match(history, /const presentedForGeometry = historyPresentationProofRef\.current\.presented/);
  assert.match(history, /const scroller = presentedForGeometry \? virtuosoScrollerRef\.current : null/);
});
