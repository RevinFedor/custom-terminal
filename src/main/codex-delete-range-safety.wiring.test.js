'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '../..');
const codexData = fs.readFileSync(path.join(repo, 'src/main/ipc/codex-data.js'), 'utf8');
const timeline = fs.readFileSync(path.join(repo, 'src/renderer/components/Workspace/Timeline.tsx'), 'utf8');
const codexLaunch = fs.readFileSync(path.join(repo, 'src/renderer/utils/codexLaunch.ts'), 'utf8');
const app = fs.readFileSync(path.join(repo, 'src/renderer/App.tsx'), 'utf8');
const web = fs.readFileSync(path.join(repo, 'src/main/web-server.js'), 'utf8');

test('Codex range deletion is keyed by exact carrier identity, never turnIndex membership', () => {
  const planStart = codexData.indexOf('function planCodexRangeRewrite');
  const planEnd = codexData.indexOf('function planCodexForkFromLatestCompact', planStart);
  const plan = codexData.slice(planStart, planEnd);
  assert.match(plan, /canonicalByUuid\.get\(entry\.uuid\)/);
  assert.match(plan, /selectedTurnKeys\.has\(Number\(wrapper\.turnKey\)\)/);
  assert.doesNotMatch(plan, /selectedTurns\.has\(wrapper\.turnIndex\)/);
  assert.match(plan, /removedUserUuids[\s\S]*selectedUserUuids/);
  assert.match(plan, /validateCodexRangeRewriteProjection/);
});

test('edited child must validate Timeline and carry exact Model/Effort before publication', () => {
  assert.match(codexData, /ensureCodexEditedForkSettingsProof/);
  assert.match(codexData, /thread_settings_applied/);
  assert.match(codexData, /requireSettingsProof: true/);
  assert.match(codexData, /failed post-write Timeline validation/);
  assert.match(codexData, /fs\.promises\.unlink\(result\.filePath\)/);
  assert.match(codexLaunch, /getCodexHistoryMutationSettingsProof/);
  assert.match(timeline, /result\.codexSettingsProof \|\| codexSettingsProof/);
  assert.match(timeline, /validateOnly: true/);
  assert.ok(
    timeline.indexOf('validateOnly: true') < timeline.indexOf("stopCodexForHistoryMutation('Delete Range')"),
    'Codex delete must validate target/settings before stopping the live process',
  );
  assert.match(app, /codexSettingsProof: toolType === 'codex'/);
  assert.match(web, /codexSettingsProof: result\.codexSettingsProof \|\| target\.status\?\.codexSettingsProof/);
});

test('large prefix deletion has a distinct strong confirmation and errors retain their message', () => {
  assert.match(timeline, /DELETE_PREFIX_STRONG_CONFIRM_THRESHOLD/);
  assert.match(timeline, /Подтвердить масштаб/);
  assert.match(timeline, /Последнее подтверждение:/);
  assert.match(timeline, /Delete range failed: ' \+ deleteErrorMessage/);
  assert.match(timeline, /historyMutated=/);
});
