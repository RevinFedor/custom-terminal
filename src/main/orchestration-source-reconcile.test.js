'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectLegacySourceSessionCandidates,
  findUniqueLegacySourceFollowupProof,
} = require('./orchestration-source-reconcile');

const run = {
  sourceProjectId: 'project-a',
  sourceTabId: 'stale-tab-id',
  sourceTabName: 'source name',
};

function projects(tabs) {
  return [{ id: 'project-a', tabs }, { id: 'project-b', tabs: [] }];
}

test('legacy source candidate falls back from a stale tab id to the same project and exact name', () => {
  const candidates = collectLegacySourceSessionCandidates(run, projects([
    { tabId: 'new-tab-id', name: 'source name', commandType: 'claude', claudeSessionId: 'session-a', cwd: '/repo' },
    { tabId: 'other', name: 'other name', commandType: 'claude', claudeSessionId: 'session-b', cwd: '/repo' },
  ]));
  assert.deepEqual(candidates.map((item) => [item.tabId, item.sessionId]), [
    ['new-tab-id', 'session-a'],
  ]);
});

test('exact tab id takes precedence over a same-name replacement', () => {
  const candidates = collectLegacySourceSessionCandidates(run, projects([
    { tabId: 'stale-tab-id', name: 'old name', commandType: 'codex', codexSessionId: 'session-exact' },
    { tabId: 'new-tab-id', name: 'source name', commandType: 'claude', claudeSessionId: 'session-name' },
  ]));
  assert.deepEqual(candidates.map((item) => item.sessionId), ['session-exact']);
});

test('legacy reconcile accepts only one exact transcript proof among name candidates', async () => {
  const result = await findUniqueLegacySourceFollowupProof({
    run,
    projects: projects([
      { tabId: 'new-a', name: 'source name', commandType: 'claude', claudeSessionId: 'session-a' },
      { tabId: 'new-b', name: 'source name', commandType: 'claude', claudeSessionId: 'session-b' },
    ]),
    probe: async (candidate) => ({
      found: candidate.sessionId === 'session-b',
      userUuid: candidate.sessionId === 'session-b' ? 'queued-command-b' : null,
    }),
  });
  assert.equal(result.found, true);
  assert.equal(result.candidate.sessionId, 'session-b');
  assert.equal(result.proof.userUuid, 'queued-command-b');
});

test('legacy reconcile stays unresolved when exact proof is ambiguous', async () => {
  const result = await findUniqueLegacySourceFollowupProof({
    run,
    projects: projects([
      { tabId: 'new-a', name: 'source name', commandType: 'claude', claudeSessionId: 'session-a' },
      { tabId: 'new-b', name: 'source name', commandType: 'claude', claudeSessionId: 'session-b' },
    ]),
    probe: async () => ({ found: true }),
  });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'legacy-source-proof-ambiguous');
  assert.equal(result.matchCount, 2);
});
