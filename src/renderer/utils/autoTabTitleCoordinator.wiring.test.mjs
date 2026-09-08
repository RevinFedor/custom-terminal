import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const coordinator = fs.readFileSync(path.join(here, 'autoTabTitleCoordinator.ts'), 'utf8');
const titleGenerator = fs.readFileSync(path.join(here, 'generateTabTitle.ts'), 'utf8');
const store = fs.readFileSync(path.join(rendererRoot, 'store/useWorkspaceStore.ts'), 'utf8');
const timeline = fs.readFileSync(path.join(rendererRoot, 'components/Workspace/Timeline.tsx'), 'utf8');
const app = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(rendererRoot, '../main/main.js'), 'utf8');
const webServer = fs.readFileSync(path.join(rendererRoot, '../main/web-server.js'), 'utf8');

test('fresh auto-title is owned by one App-global transcript coordinator', () => {
  assert.match(app, /useEffect\(\(\) => startAutoTabTitleCoordinator\(\), \[\]\)/);
  assert.match(coordinator, /subscribePendingAutoTabTitles/);
  assert.match(coordinator, /agent-transcript:subscribe/);
  assert.match(coordinator, /agent-transcript:changed/);
  assert.match(coordinator, /consumerId: `auto-title:\$\{runGeneration\}:/);
  assert.doesNotMatch(coordinator, /isTurnBusy|document\.visibilityState|isVisible/);
  assert.match(titleGenerator, /agent-transcript:get-timeline/);
});

test('pending naming does not expire while a long first turn is busy', () => {
  assert.doesNotMatch(store, /AUTO_TAB_TITLE_PENDING_TTL_MS/);
  assert.doesNotMatch(store, /reason=['"]expired['"]|clearPendingAutoTabTitle\([^\n]+expired/);
  assert.match(store, /clearPendingAutoTabTitle\(tabId, 'tab-closed'\)/);
  assert.match(store, /clearPendingAutoTabTitle\(tabId, 'manual-name'\)/);
  assert.match(store, /claude-session-changed/);
  assert.match(store, /codex-session-changed/);
});

test('Timeline no longer consumes an explicitly armed auto-title', () => {
  assert.match(timeline, /if \(store\.getPendingAutoTabTitle\(tabId, 'claude', sessionId\)\) return;/);
  assert.match(timeline, /store\.recoverPendingAutoTabTitle\(tabId, 'claude', sessionId, 'fork'\)/);
  assert.doesNotMatch(timeline, /\[Timeline:AutoTabTitle\][\s\S]{0,300}generateTabTitleFromPrompt/);
});

test('headless candidate selection keeps fresh and fork ownership rules', () => {
  assert.match(titleGenerator, /if \(pending\.mode !== 'fork'\) return entries\.find\(eligible\)/);
  assert.match(titleGenerator, /selectDirectForkMarker\(normalized, pending\.sessionId, entries\)/);
  assert.match(titleGenerator, /entry\.sourceLine > forkLiveStartLine/);
  assert.match(titleGenerator, /!hasOrchestrationTag\(entry\)/);
  assert.match(titleGenerator, /!entry\.isSentHandoffProjection/);
});

test('system source tags exclude automatic continuation from title, summary and semantic outline inputs', () => {
  assert.match(titleGenerator, /import \{ isServicePromptEntry \} from '..\/..\/shared\/prompt-origin\.mjs'/);
  assert.match(titleGenerator, /function isEligibleTabTitleEntry[\s\S]*?if \(isServicePromptEntry\(entry\)\) return false/);
  assert.match(timeline, /isSystemPromptEntry\(entry\)/);
  assert.match(timeline, /entryIsServicePrompt \? 'rotate\(45deg\)'/);
  assert.match(timeline, /isSystem: entryIsSystem/);
  assert.match(webServer, /presentationSnapshot: withPromptOriginPresentation\(presentationSnapshot, source\)/);
  assert.match(main, /restoreConfirmedSystemPromptOrigins\(agentSendReceiptStartupReconcile\.records\.filter/);
  assert.match(main, /agentSendReceiptStartupReady\.then\([\s\S]*?result\.promoted > 0[\s\S]*?agentSendReceiptStore\.list\(\{ state: AGENT_SEND_DURABLE_STATES\.CONFIRMED \}\)/);
});

test('rename is revalidated after both transcript read and title generation', () => {
  assert.match(coordinator, /manual-name-after-read/);
  assert.match(coordinator, /session-changed-after-read/);
  assert.match(coordinator, /manual-name-after-generate/);
  assert.match(coordinator, /session-changed-after-generate/);
  assert.match(coordinator, /rerunAfterFlight/);
});
