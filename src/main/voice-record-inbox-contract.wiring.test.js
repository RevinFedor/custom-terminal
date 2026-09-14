const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Inbox exposes durable status, resume-after-close and exact rewind for external chat owners', () => {
  const web = read('src/main/web-server.js');
  assert.match(web, /auditEntryUuid/);
  assert.match(web, /auditSourceIdentity/);
  assert.match(web, /resumeSessionId/);
  assert.ok(web.includes("parsed.pathname === '/api/inbox/sessions/resume'"));
  assert.ok(web.includes("parsed.pathname.match(/^\\/api\\/inbox\\/runs\\/([^/]+)$/)"));
  assert.ok(web.includes("parsed.pathname.match(/^\\/api\\/inbox\\/runs\\/([^/]+)\\/rewind$/)"));
  assert.match(web, /durableRecord\.state !== 'confirmed'/);
  assert.match(web, /rewindAgentHistoryScenario/);
});

test('renderer creation resumes the saved Codex session instead of launching fresh', () => {
  const app = read('src/renderer/App.tsx');
  assert.match(app, /requestedResumeSessionId/);
  assert.match(app, /getHistoryAgentRuntime\('codex'\)\.resume/);
  assert.match(app, /codexSessionId: requestedResumeSessionId \|\| undefined/);
});

test('external history rewind never writes a duplicate draft into Noted Terminal', () => {
  const app = read('src/renderer/App.tsx');
  const scenario = read('src/renderer/utils/historyRewriteRewind.ts');
  assert.match(app, /restoreDraft: restoreDraft !== false/);
  assert.match(scenario, /restoreDraft = true/);
  assert.match(scenario, /if \(restoredDraft && restoreDraft\)/);
});

test('native clients receive one revisioned runtime contract across reads and SSE', () => {
  const web = read('src/main/web-server.js');
  const main = read('src/main/main.js');
  assert.match(web, /function stampPublicRuntimeSnapshot/);
  assert.match(web, /runtimeRevision: revision/);
  assert.match(web, /coherentPublicRuntimeSnapshot\(tabId, resolved \|\| \{\}\)/);
  assert.match(web, /payload\.type === 'snapshot'.*payload\.type === 'busy'.*payload\.type === 'done'/s);
  assert.match(web, /project\.tabs\.map\(\(tab\) => \{/);
  assert.match(web, /const stamped = stampPublicRuntimeSnapshot\(t\.tabId/);
  assert.match(main, /lifecycleGeneration: payload\?\.lifecycleGeneration/);
  assert.match(main, /turnBusy: typeof payload\?\.turnBusy === 'boolean'/);
});

test('native delivery reconciliation reads a durable handoff receipt without retrying send', () => {
  const web = read('src/main/web-server.js');
  const store = read('src/main/agent-send-receipt-store.js');
  assert.ok(web.includes("parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/send-receipts$/)"));
  assert.match(web, /handoffId: handoffId \|\| undefined/);
  assert.match(web, /\.map\(publicAgentSendReceipt\)/);
  assert.match(store, /clauses\.push\('handoff_id = \?'\)/);
});

test('mobile Timeline and Rewind preserve exact composite transcript identity', () => {
  const web = read('src/main/web-server.js');
  const app = read('src/renderer/App.tsx');
  const scenario = read('src/renderer/utils/agentScenarios.ts');
  assert.match(web, /entryRef,/);
  assert.match(web, /contentRevision,/);
  assert.match(web, /sourceIdentityAliases:/);
  assert.match(web, /revision: timelineResult\.revision \|\| null/);
  assert.match(web, /targetEntryRef: body\.targetEntryRef \|\| null/);
  assert.match(web, /expectedContentRevision: body\.expectedContentRevision \|\| null/);
  assert.match(app, /targetEntryRef,/);
  assert.match(scenario, /viewOwnerSessionId: targetEntryRef\?\.viewOwnerSessionId \|\| sessionId/);
  assert.match(scenario, /expectedContentRevision: expectedContentRevision \|\| targetEntryRef\?\.contentRevision \|\| null/);
});

test('external model catalog projects the manually configured visible Codex rows', () => {
  const web = read('src/main/web-server.js');
  const settings = read('src/renderer/components/UI/SettingsModal.tsx');
  assert.match(web, /getAppState\?\.\('codexSettings'\)/);
  assert.match(web, /projectConfiguredAgentModels\(\{/);
  assert.match(web, /codex: configuredCodexModels/);
  assert.match(web, /getAppState\?\.\('defaultCodexModel'\)/);
  assert.match(web, /getAppState\?\.\('defaultCodexEffort'\)/);
  assert.match(web, /codexDefault: resolveConfiguredAgentDefaultPair/);
  assert.match(web, /codexQuick: resolveConfiguredAgentQuickPair/);
  assert.doesNotMatch(web, /codex:\s*codexModels,/);
  assert.match(settings, />\s*По умолчанию\s*</);
  assert.match(settings, /setSettingsDefaultCodexModel/);
  assert.match(settings, /Модель для новых запусков Codex/);
  assert.match(settings, /Быстрый переход/);
});
