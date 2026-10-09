import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { RefreshCw } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const file = path.resolve(import.meta.dirname, '../components/Workspace/ClaudeUsageButton.tsx');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function functionBody(name) {
  let found = null;
  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(found, name + ' exists in the real component');
  return found;
}

function usageRefreshBody(componentName) {
  let found = null;
  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) {
      const inside = (child) => {
        if (ts.isVariableDeclaration(child) && child.name.getText(ast) === 'refresh'
          && ts.isCallExpression(child.initializer)) found = child.initializer.arguments[0].getText(ast);
        ts.forEachChild(child, inside);
      };
      inside(node.body);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(found, 'real ' + componentName + ' refresh callback exists');
  return found;
}

function evaluate(body, scope, name = 'subject') {
  const js = ts.transpileModule('globalThis.' + name + ' = ' + body + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  scope.exports ||= {};
  vm.runInNewContext(js, scope);
  return scope[name];
}

test('the Codex IPC deadline leaves room for the15s physical read and branch verification', async () => {
  let initializer;
  const walk = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'CODEX_USAGE_IPC_DEADLINE_MS') initializer = node.initializer.getText(ast);
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(initializer);
  let deadline;
  let respond;
  let cleared = false;
  const scope = { USAGE_DETAILS_IPC_DEADLINE_MS: 12_000,
    CODEX_USAGE_IPC_DEADLINE_MS: Number(initializer.replaceAll('_', '')),
    setTimeout: (fn, ms) => { deadline = { fn, ms }; return deadline; },
    clearTimeout: () => { cleared = true; },
    ipcRenderer: { invoke: () => new Promise(resolve => { respond = resolve; }) },
  };
  scope.invokeIpcWithDeadline = evaluate(functionBody('invokeIpcWithDeadline'), scope);
  const invoke = evaluate(functionBody('invokeCodexUsage'), scope);
  const pending = invoke({ accountKey: 'a' });
  assert.equal(deadline.ms, 25_000);
  assert.ok(deadline.ms > 15_000 + 3_000, 'renderer does not report a failure before the request/verification finishes');
  const response = { success: true };
  respond(response);
  assert.equal(await pending, response);
  assert.equal(cleared, true);
});

test('error feedback belongs to the account that was requested', () => {
  const target = evaluate(functionBody('usageRefreshFlashTarget'), {});
  assert.equal(target('a', 'a', 'a'), 'both');
  assert.equal(target('b', 'b', 'a'), 'detail');
  assert.equal(target(null, 'b', 'a'), 'compact');
  assert.equal(target('c', 'b', 'a'), null);
});

test('the actual refresh-error hook flashes once for one attempt and clears after one second', () => {
  let shown = null;
  let cleanup = null;
  let nextTimer = 0;
  const timers = new Map();
  const scope = {
    useState: (initial) => [initial, (value) => { shown = value; }],
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useEffect: (fn) => { cleanup = fn(); },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    USAGE_REFRESH_ERROR_FLASH_MS: 1_000,
  };
  const useFlash = evaluate(functionBody('useUsageRefreshFailureFlash'), scope);
  const pulse = useFlash();
  pulse.flash('account-a:attempt-1', 'detail');
  assert.equal(shown, 'detail');
  assert.equal([...timers.values()][0].ms, 1_000);
  pulse.clear();
  assert.equal(shown, null);
  assert.equal(timers.size, 0);
  pulse.flash('account-a:attempt-1', 'detail');
  assert.equal(shown, null, 'cached copy of the same failure does not flash again');
  pulse.flash('account-a:attempt-2', 'both');
  assert.equal(shown, 'both');
  [...timers.values()][0].fn();
  assert.equal(shown, null);
  cleanup();
});

test('real Codex refresh callback flags a per-account error even with an IPC success and old percentages', async () => {
  const target = evaluate(functionBody('usageRefreshFlashTarget'), {});
  const account = {
    accountKey: 'account-a', label: 'account A',
    usage: { seven_day: { utilization: 53 }, timestamp: '2026-09-24T00:00:00Z' },
    lastError: 'OpenAI usage is temporarily rate limited.', lastAttemptAt: 123,
  };
  let response = { success: true, accounts: [account], profiles: [],
    selectedAccountKey: 'account-a', currentAccountKey: 'account-a',
    error: account.lastError, source: 'openai-usage-api', stale: true };
  const flashes = [];
  const shown = {};
  const logs = [];
  const scope = {
    selectedAccountKey: 'account-a', currentAccountKey: 'account-a',
    activeCodexSessionId: null, activeCodexCwd: null,
    refreshSeqRef: { current: 0 }, refreshContextRef: { current: 'account-a||' },
    refreshInFlightRef: { current: false },
    lastRefreshStartedAtRef: { current: 0 },
    usageRefreshFlashTarget: target,
    clearRefreshFailureFlash: () => {},
    flashRefreshFailure: (key, targetName) => flashes.push({ key, targetName }),
    invokeCodexUsage: async () => response,
    Date,
    console: { log: (line) => logs.push(line), warn: () => {} },
    storeCodexUsageAccountKey: () => {},
  };
  for (const key of ['setLoading', 'setCompactLoading', 'setAccounts', 'setProfiles',
    'setCurrentAccountKey', 'setSelectedAccountKey', 'setData', 'setError',
    'setWarning', 'setSource', 'setStale', 'setLastSuccessAt']) scope[key] = (value) => { shown[key] = value; };
  const refresh = evaluate(usageRefreshBody('CodexUsageChip'), scope);
  await refresh(false, { reason: 'interval' });
  assert.equal(flashes.length, 1);
  assert.equal(flashes[0].targetName, 'both');
  assert.match(flashes[0].key, /account-a:123/);
  assert.equal(shown.setError, account.lastError);
  assert.equal(shown.setData, account.usage, 'the verified quota survives a failed refresh');
  assert.equal(shown.setStale, true);
  assert.equal(shown.setLoading, false, 'failure ends the active request');
  assert.match(logs.at(-1), /refresh failed/, 'an IPC success with a provider error is not logged as a successful refresh');

  const healthy = { accountKey: 'account-b', label: 'account B', usage: account.usage, lastError: null };
  response = { ...response, accounts: [account, healthy], selectedAccountKey: 'account-b', error: null };
  await refresh(false, { accountKey: 'account-b', preserveSelection: true, snapshotOnly: true });
  assert.equal(shown.setError, account.lastError, 'a healthy background update of B cannot clear the selected account A failure');

  flashes.length = 0;
  response = { ...response, accounts: [{ ...account, lastError: null }], selectedAccountKey: 'account-a', error: null, stale: false };
  await refresh(false, { reason: 'interval' });
  assert.equal(flashes.length, 0, 'a successful read with unchanged percentages is not an error');
  assert.equal(shown.setError, null, 'a successful snapshot clears the persistent error');
  assert.equal(shown.setData, account.usage);
  assert.match(logs.at(-1), /refresh ok/);

  response = { success: false, error: 'usage unavailable' };
  await refresh(false, { reason: 'interval' });
  assert.equal(flashes.length, 1, 'an IPC-level failure also flashes');

  flashes.length = 0;
  scope.refreshContextRef.current = 'another-account||';
  await refresh(false, { reason: 'interval' });
  assert.equal(flashes.length, 0, 'an old account response cannot flash the new account');
});

test('real Claude refresh callback also flags a failed account read that retained old usage', async () => {
  const account = { accountKey: 'claude-a', label: 'Claude A',
    usage: { seven_day: { utilization: 25 } },
    lastError: 'Anthropic usage temporarily unavailable', lastAttemptAt: 456 };
  const flashes = [];
  const scope = {
    selectedAccountKey: 'claude-a', currentAccountKey: 'claude-a',
    refreshSeqRef: { current: 0 }, refreshContextRef: { current: 'claude-a' },
    usageRefreshFlashTarget: evaluate(functionBody('usageRefreshFlashTarget'), {}),
    clearRefreshFailureFlash: () => {},
    flashRefreshFailure: (key, targetName) => flashes.push({ key, targetName }),
    invokeClaudeUsage: async () => ({ ok: true, accounts: [account],
      selectedAccountKey: 'claude-a', currentAccountKey: 'claude-a',
      data: account.usage, source: 'anthropic-oauth-api', stale: true }),
    console: { log: () => {}, warn: () => {} },
    storeClaudeUsageAccountKey: () => {},
  };
  for (const key of ['setLoading', 'setCompactLoading', 'setAccounts', 'setCurrentAccountKey',
    'setSelectedAccountKey', 'setData', 'setError', 'setNotice', 'setSource',
    'setStale', 'setLastSuccessAt', 'setLastAttemptAt']) scope[key] = () => {};
  const refresh = evaluate(usageRefreshBody('ClaudeUsageChip'), scope);
  await refresh(false, { reason: 'bridge' });
  assert.equal(flashes.length, 1);
  assert.equal(flashes[0].targetName, 'both');
  assert.match(flashes[0].key, /claude-a:456/);
});

test('the actual refresh button retains failure feedback during retry and clears on success', () => {
  const row = evaluate(functionBody('UsageSourceRefreshRow'), {
    require,
    RefreshCw,
  });
  const props = { sourceText: 'OpenAI · 1m ago · stale', loading: false, refreshDisabled: false,
    refreshTitle: 'Refresh usage', onRefresh: () => {}, refreshError: 'OpenAI usage request timed out.' };
  const red = renderToStaticMarkup(row(props));
  const retry = renderToStaticMarkup(row({ ...props, loading: true, refreshDisabled: true }));
  const normal = renderToStaticMarkup(row({ ...props, refreshError: null }));
  assert.match(red, /color:#f87171/);
  assert.doesNotMatch(normal, /color:#f87171/);
  assert.match(red, /refresh/);
  assert.match(red, /data-usage-refresh-state="error"/);
  assert.match(red, /title="Refresh usage\. Последнее обновление не удалось: OpenAI usage request timed out\."/);
  assert.doesNotMatch(red, />[^<]*OpenAI usage request timed out\./, 'the reason stays in title/aria, not a new text row');
  assert.match(retry, /color:#f87171/);
  assert.match(retry, /aria-busy="true"/);
  assert.match(retry, /spin 1s linear infinite/);
  assert.match(retry, /updating/);
  assert.match(normal, /data-usage-refresh-state="idle"/);
  assert.doesNotMatch(normal, /timed out/);
});
