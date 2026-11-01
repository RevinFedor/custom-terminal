'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const ts = require('typescript'), esbuild = require('esbuild');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const hookPath = path.resolve(__dirname, '../hooks/useBuildContinueStatus.ts');
const hook = ts.transpileModule(fs.readFileSync(process.env.BUILD_CAPTURE_HOOK_PRE || hookPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const issue = { version: 1, kind: 'capture-unresolved', operationId: 'capture-operation-one', tabId: 'T', issueId: 'a'.repeat(64),
  capturedAt: 100, phase: 'settled', stage: 'capture', reason: 'own-turn-proof-unavailable', active: false, inputCreated: false,
  source: { tabId: 'T', name: 'Оптимизация окон', projectId: 'P', sessionId: 'S' }, observation: { taskTurnId: 'original-turn' }, presentationDismissal: null };
const snapshot = (items = [issue], revision = 1, epoch = 'Main-A') => ({ version: 1, epoch, revision, tabId: 'T', targets: [], captureIssues: { version: 1, items } });
const acknowledgement = request => ({ ...request, kind: 'capture-unresolved', acknowledgedAt: 200 });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function hookFixture(invoke, tabId = 'T') {
  let state, effect; const listeners = new Map(), calls = [];
  const react = { useEffect: fn => { effect = fn; }, useCallback: fn => fn, useRef: value => ({ current: value }),
    useState: initial => { state = initial; return [state, update => { state = typeof update === 'function' ? update(state) : update; }]; } };
  const ipcRenderer = { on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name),
    invoke: async (name, args) => { calls.push({ name, args }); return invoke(name, args); } };
  const module = { exports: {} };
  vm.runInNewContext(hook, { module, exports: module.exports, window: { require: () => ({ ipcRenderer }) },
    require: () => react, crypto: { randomUUID: () => 'capture-close-request-one' } });
  const h = module.exports.useBuildContinueStatus(tabId), cleanup = effect(); await tick();
  return { h, state: () => state, calls, cleanup, emit: value => listeners.get('build-continue:status')?.({}, value) };
}

// Reuse the finite actual Main/Web/SQLite factory, without registering its tests.
// It owns a random authenticated localhost listener, synthetic Quit and private SQL.
function privateWebFixture() {
  const file = path.resolve(__dirname, '../../main/build-continue-http.actual.test.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const prefix = source.slice(0, source.indexOf('\ntest('));
  const module = { exports: {} };
  vm.runInNewContext(prefix + '\nmodule.exports = fixture;', { module, exports: module.exports, require: createRequire(file),
    __dirname: path.dirname(file), process, fetch, AbortSignal, structuredClone, setImmediate, console });
  return module.exports;
}

test('capture-only status with zero targets remains visible and never invents a Send identity', async () => {
  const h = await hookFixture(() => snapshot());
  assert.equal(h.state().captureIssues?.length || 0, 1, 'a missed task must not disappear just because targets is empty');
  assert.equal(h.state().targets.length, 0);
  const saved = h.state().captureIssues[0];
  for (const key of ['handoffId', 'operationKey', 'attemptId']) assert.equal(saved[key], undefined);
  assert.equal(h.calls.length, 1); h.cleanup();
});

test('actual private Main -> Web -> SQLite issue -> renderer hook -> exact X preserves refusal and creates no target', { timeout: 10000 }, async t => {
  let quitObserved;
  const quit = new Promise(resolve => { quitObserved = resolve; });
  const web = await privateWebFixture()(t, false, null, { mainCapture: true, privateCapture: true, writerSession: 'FOREIGN', beforeQuit: quitObserved });
  const capture = await web.api('/api/build-continue/operations', { version: 2, action: 'capture-quit',
    operationId: 'http-operation-one', expectedMainPid: process.pid });
  assert.equal(capture.status, 200); assert.equal(capture.body.operation.targetCount, 0);
  await quit;
  const h = await hookFixture((channel, args) => web.ipc(channel, args), 'worker'); t.after(h.cleanup);
  const capturedIssue = h.state().captureIssues[0];
  assert.equal(capturedIssue.reason, 'capture-foreign-writer');
  await h.h.dismissCapture(capturedIssue);
  assert.equal(h.state().captureIssues.length, 0); assert.equal(h.state().targets.length, 0); assert.equal(h.state().error, null);
  const calls = h.calls.filter(call => call.name !== 'build-continue:status-for-tab');
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'build-continue:dismiss-capture');
  const full = (await web.api(capture.body.reportUrl + '?full=1')).body.operation;
  assert.equal(full.targets.length, 0); assert.equal(full.unresolved[0].reason, capturedIssue.reason);
  assert.equal(full.unresolved[0].presentationDismissal.requestId, calls[0].args.requestId);
  assert.equal(web.quitCount, 1, 'X does not invoke Quit again');
});

test('lost capture X ACK retries the identical request and retains the old refusal until authoritative confirmation', async () => {
  let attempts = 0;
  const h = await hookFixture((channel, request) => channel === 'build-continue:status-for-tab' ? snapshot()
    : ++attempts === 1 ? Promise.reject(Error('lost ACK'))
      : { ok: true, acknowledgement: acknowledgement(request), snapshot: snapshot([], 2) });
  await h.h.dismissCapture(issue); assert.equal(h.state().captureIssues.length, 1); assert.match(h.state().error, /lost ACK/);
  await h.h.dismissCapture(issue); assert.equal(h.state().captureIssues.length, 0);
  const writes = h.calls.filter(call => call.name === 'build-continue:dismiss-capture');
  assert.deepEqual(writes[0].args, writes[1].args); assert.equal(writes[0].args.issueId, issue.issueId); h.cleanup();
});

for (const changed of [
  { version: 2 }, { kind: 'target' }, { operationId: 'foreign-operation' }, { tabId: 'foreign-tab' },
  { issueId: 'b'.repeat(64) }, { requestId: 'foreign-request' }, { acknowledgedAt: null },
]) test('capture X rejects mismatched ACK ' + JSON.stringify(changed), async () => {
  const h = await hookFixture((channel, request) => channel === 'build-continue:status-for-tab' ? snapshot()
    : { ok: true, acknowledgement: { ...acknowledgement(request), ...changed }, snapshot: snapshot([], 2) });
  await h.h.dismissCapture(issue); assert.equal(h.state().captureIssues.length, 1); assert.match(h.state().error, /не подтверждено/); h.cleanup();
});

test('ok-only, unsaved issue and wrong-tab snapshots cannot fake an X confirmation', async () => {
  for (const result of [request => ({ ok: true, snapshot: snapshot([], 2) }),
    request => ({ ok: true, acknowledgement: acknowledgement(request), snapshot: snapshot([issue], 2) }),
    request => ({ ok: true, acknowledgement: acknowledgement(request), snapshot: { ...snapshot([], 2), tabId: 'other' } })]) {
    const h = await hookFixture((channel, request) => channel === 'build-continue:status-for-tab' ? snapshot() : result(request));
    await h.h.dismissCapture(issue); assert.equal(h.state().captureIssues.length, 1); assert.match(h.state().error, /не подтверждено/); h.cleanup();
  }
});

test('capture issues obey scoped revision/epoch ordering; old backend without issues keeps ordinary targets', async () => {
  const h = await hookFixture(() => snapshot());
  h.emit(snapshot([], 2)); h.emit(snapshot([issue], 1)); assert.equal(h.state().captureIssues.length, 0);
  h.emit(snapshot([issue], 1, 'Main-B')); h.emit(snapshot([], 99)); assert.equal(h.state().captureIssues.length, 1);
  h.emit({ ...snapshot([], 99, 'Main-B'), tabId: 'foreign' }); assert.equal(h.state().captureIssues.length, 1);
  h.cleanup();
  const old = await hookFixture(() => ({ version: 1, epoch: 'old', revision: 1, tabId: 'T', targets: [{ state: 'pending' }] }));
  assert.equal(old.state().captureIssues.length, 0); assert.equal(old.state().targets[0].state, 'pending'); old.cleanup();
});

test('foreign issue and late X response cannot mutate another owner or regress a live restart', async () => {
  let resolve;
  const h = await hookFixture(channel => channel === 'build-continue:status-for-tab' ? snapshot() : new Promise(r => { resolve = r; }));
  await h.h.dismissCapture({ ...issue, tabId: 'foreign' }); assert.equal(h.calls.length, 1);
  const pending = h.h.dismissCapture(issue), request = h.calls.at(-1).args;
  h.emit(snapshot([issue], 1, 'Main-B'));
  resolve({ ok: true, acknowledgement: acknowledgement(request), snapshot: snapshot([], 200) }); await pending;
  assert.equal(h.state().captureIssues.length, 1);
  const late = h.h.dismissCapture(issue), before = h.state(); h.cleanup();
  resolve({ ok: true, acknowledgement: acknowledgement(request), snapshot: snapshot([], 200, 'Main-B') }); await late;
  assert.equal(h.state(), before);
});

async function component() {
  const file = path.resolve(__dirname, '../components/Workspace/BuildContinueCaptureTracker.tsx');
  const result = await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'lucide-react', './RequestDetailsPopover', './TabMessageSourceChip', '../../store/useWorkspaceStore'], logLevel: 'silent' });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: name => {
    if (name.endsWith('/RequestDetailsPopover')) return { RequestDetailsPopover: ({ attributes, children }) => React.createElement('aside', { ...attributes, role: 'dialog' }, children) };
    if (name.endsWith('/TabMessageSourceChip')) return { TabMessageSourceChip: ({ source }) => React.createElement('button', { 'data-exact-tab': source.sourceTabId }, source.sourceTabName) };
    if (name.endsWith('/useWorkspaceStore')) return { useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) } };
    return require(name);
  } }); return module.exports;
}

test('capture refusal has one red/name/X row; only a click opens its exact details, without H/O or unrelated Research', async () => {
  const { BuildContinueCaptureTracker, BuildContinueCapturePreview } = await component();
  const calls = [], tree = BuildContinueCaptureTracker({ issue, onDismiss: value => calls.push(['dismiss', value]), onOpen: value => calls.push(['open', value]) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /color:#f87171/); assert.match(html, /Оптимизация окон/); assert.match(html, /data-build-capture-dismiss=/);
  assert.doesNotMatch(html, /role="dialog"|animate-spin|data-build-continue-cancel|data-external-research|handoffId|operationKey/);
  const row = tree.props.children, open = row.props.children, close = row.props.actions;
  assert.equal(open.props.onMouseEnter, undefined); assert.equal(calls.length, 0);
  const anchor = { getBoundingClientRect: () => ({ left: 10, top: 10 }) };
  open.props.onClick({ currentTarget: { closest: () => anchor } });
  assert.equal(calls[0][1].operationId, issue.operationId); assert.equal(calls[0][1].issueId, issue.issueId);
  let stopped = false; close.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true); assert.equal(calls[1][1], issue);
  const preview = renderToStaticMarkup(React.createElement(BuildContinueCapturePreview, { issue, selection: calls[0][1], onClose() {}, previewRef: { current: null } }));
  assert.match(preview, /Автопродолжение не создано/); assert.match(preview, /own-turn-proof-unavailable/);
  assert.match(preview, /original-turn/); assert.match(preview, /capture-operation-one/); assert.match(preview, /data-exact-tab="T"/);
  assert.doesNotMatch(preview, /Запрос:|Research|Продолжить|Повторить|Restore|handoffId|operationKey/);
});
