import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

test('renderer uses one batch availability channel rather than probing a session from every row', () => {
  const tracker = read('renderer/utils/sessionAvailabilityTracker.ts');
  assert.match(tracker, /agent-session:get-availability-batch/);
  assert.match(tracker, /registry = new Map/);
  assert.match(tracker, /POLL_MS = 30_000/);
  assert.doesNotMatch(tracker, /file:exists-batch/);
  assert.doesNotMatch(tracker, /fs\./);
});

test('every tab-card surface renders the shared missing-history marker', () => {
  for (const relative of [
    'renderer/components/Workspace/TabBar.tsx',
    'renderer/components/Workspace/PaneTabChip.tsx',
    'renderer/components/Workspace/TabListRows.tsx',
    'renderer/components/Workspace/RunAfterTabPicker.tsx',
  ]) {
    const source = read(relative);
    assert.match(source, /TabSessionAvailabilityMarker/, relative);
    assert.match(source, /data-tab-session-availability/, relative);
  }
});

test('missing transcript mutes persisted context and blocks only history-dependent actions', () => {
  const signals = read('renderer/components/Workspace/TabSignals.tsx');
  const control = read('renderer/components/Workspace/ClaudeControlBar.tsx');
  const history = read('renderer/components/Workspace/HistoryPanel.tsx');
  const sidebar = read('renderer/components/Workspace/SidebarToolsRow.tsx');
  assert.match(signals, /Последнее известное значение/);
  assert.match(signals, /muted \? SESSION_STALE_VALUE_TINT/);
  assert.match(control, /missingHistoryBlocksResume/);
  assert.match(control, /Resume недоступен/);
  assert.match(history, /!sessionHistoryActionUnavailable\(sessionAvailability\)/);
  assert.match(sidebar, /sessionHistoryActionUnavailable\(availability\)/);
});

test('History passes the resolved availability into its nested composer controls', () => {
  const history = read('renderer/components/Workspace/HistoryPanel.tsx');
  assert.match(
    history,
    /function AgentHistoryControls\(\{[\s\S]*?sessionAvailability,[\s\S]*?\}: \{[\s\S]*?sessionAvailability: AgentSessionAvailability;/,
  );
  assert.match(
    history,
    /<AgentHistoryControls[\s\S]*?sessionAvailability=\{sessionAvailability\}/,
  );
});

test('main publishes exact storage deletion ids and owns the disk probe', () => {
  const main = read('main/main.js');
  const app = read('renderer/App.tsx');
  const web = read('main/web-server.js');
  assert.match(main, /AgentSessionAvailabilityService/);
  assert.match(main, /agent-session:get-availability-batch/);
  assert.match(main, /noteStorageDeletedAgentSessions\(result/);
  assert.match(main, /agent-session:availability-invalidated/);
  assert.match(app, /runtimeSession\?\.conversationMaterialized === true/);
  assert.doesNotMatch(app, /codexConversationMaterialized = !!displaySessionId/);
  assert.match(app, /stoppedCodexSessionId[\s\S]*codexRuntime\?\.conversationMaterialized === true/);
  assert.match(web, /runtime\.conversationMaterialized === true/);
});
