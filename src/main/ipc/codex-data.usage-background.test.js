'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { _api } = require('./codex-data');

test('actual snapshot-only handler reads both account caches without any network or rollout scan', async () => {
  const file = require.resolve('./codex-data');
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let body;
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'module.exports._api.getUsage') body = node.right.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(body);
  const accounts = ['A', 'B'].map(key => ({ accountKey: key, label: key, stale: false,
    lastAttemptAt: 123, timestamp: new Date().toISOString(), source: 'openai-usage-api',
    usage: { seven_day: { utilization: key === 'A' ? 12 : 24 } } }));
  const forbidden = () => { throw new Error('snapshot unexpectedly performed network or disk scan'); };
  const scope = {
    Date, console: { log() {}, error() {} }, compactPreview: text => text,
    readCurrentCodexAuthSession: () => ({ accountKey: 'A' }),
    resolveCodexUsageRefreshScope: _api.resolveCodexUsageRefreshScope,
    getCodexRemoteUsage: forbidden,
    refreshCodexManagedProfileAccounts: forbidden,
    getCodexManagedUsageSnapshot: () => ({ accounts: [], results: [] }),
    getCodexRemoteUsageSnapshot: () => ({ accounts, currentAccountKey: 'A' }),
    shouldLoadCodexFallbackUsage: forbidden,
    getCodexUsageAccountsFast: forbidden,
    loadLatestCodexUsageForSession: forbidden,
    findLatestCodexUsage: forbidden,
    getCodexUsageAccountsSnapshot: () => ({ accounts: [] }),
    mergeCodexPreferredAccounts: _api.mergeCodexPreferredAccounts,
    codexUsageAccountIsStale: _api.codexUsageAccountIsStale,
    codexActiveUsageMatchesSelected: _api.codexActiveUsageMatchesSelected,
    codexAccountProfileManager: {
      syncDefaultProfile() {},
      listPublicProfiles: () => accounts.map(a => ({ accountKey: a.accountKey, status: 'connected', isDefault: a.accountKey === 'A' })),
    },
  };
  vm.runInNewContext('globalThis.read = ' + body, scope);
  const result = await scope.read({ snapshotOnly: true, accountKey: 'B', sessionId: 'must-not-scan' });
  assert.equal(result.success, true);
  assert.equal(result.error, null);
  assert.equal(result.selectedAccountKey, 'B');
  assert.equal(result.currentAccountKey, 'A');
  assert.equal(result.accounts.length, 2);
  assert.equal(result.data.seven_day.utilization, 24);
  assert.equal(result.stale, false);
  assert.equal(result.lastAttemptAt, 123);
});

test('managed Retry-After also suppresses native quota probes, until auth rotates', async () => {
  const file = require.resolve('./codex-data');
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Map();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const profile = { profileId: 'B', accountKey: 'B', status: 'connected', homePath: 'private-fixture' };
  let auth = { accountKey: 'B', tokenFingerprint: 'token-one' };
  let probes = 0;
  const scope = {
    Date: { now: () => 100_000 }, CODEX_REMOTE_USAGE_ERROR_COOLDOWN_MS: 60_000,
    codexRemoteUsageByAccount: new Map([['B', { tokenFingerprint: 'token-one', retryAt: 300_000 }]]),
    readCodexAuthSession: () => auth,
    getCodexRemoteUsageSnapshot: () => ({ accounts: [{ accountKey: 'B', usage: {}, stale: true }], error: '429' }),
    codexAccountProfileManager: {
      listPublicProfiles: () => [profile], getProfile: () => profile,
      refreshManagedProfiles: async () => { probes++; return []; },
    },
  };
  vm.runInNewContext(functions.get('decorateCodexProfileAccount') + '\n'
    + functions.get('refreshCodexManagedProfileAccountsInner')
    + '\nglobalThis.read = refreshCodexManagedProfileAccountsInner;', scope);
  const held = await scope.read({ accountKey: 'B', force: true });
  assert.equal(held.error, '429');
  assert.equal(held.accounts[0].stale, true);
  assert.equal(probes, 0);
  auth = { ...auth, tokenFingerprint: 'rotated-token' };
  await scope.read({ accountKey: 'B' });
  assert.equal(probes, 1, 'new auth revokes the old server pause');
});
