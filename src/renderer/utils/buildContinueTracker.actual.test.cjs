'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const esbuild = require('esbuild'), ts = require('typescript');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const component = path.resolve(__dirname, '../components/Workspace/BuildContinueTracker.tsx');
const hook = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../hooks/useBuildContinueStatus.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const target = { operationId: 'OP', tabId: 'T', capturedAt: 100, phase: 'restoring', state: 'pending', reason: 'prior-continuation-pending',
  active: true, handoffId: 'H', operationKey: 'history:T:H', route: { kind: 'local' },
  source: { tabId: 'T', name: 'чаты с hh', projectId: 'project' }, taskId: 'original-task-turn' };
const snap = (revision = 1, patch = {}, epoch = 'Main-A') => ({ version: 1, epoch, revision, tabId: 'T', targets: [{ ...target, ...patch }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function hookFixture(invoke) {
  let state, effect; const listeners = new Map(), calls = [], refs = [];
  const react = { useEffect: fn => { effect = fn; }, useCallback: fn => fn, useRef: value => { const r = { current: value }; refs.push(r); return r; },
    useState: initial => { state = initial; return [state, update => { state = typeof update === 'function' ? update(state) : update; }]; } };
  const ipcRenderer = { on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name),
    invoke: async (name, args) => { calls.push({ name, args }); return invoke(name, args); } };
  const module = { exports: {} };
  vm.runInNewContext(hook, { module, exports: module.exports, window: { require: () => ({ ipcRenderer }) },
    require: () => react, crypto: { randomUUID: () => 'same-cancel-request' }, console });
  const h = module.exports.useBuildContinueStatus('T'), cleanup = effect(); await tick();
  return { h, state: () => state, calls, emit: value => listeners.get('build-continue:status')?.({}, value), cleanup };
}
async function trackerModule(react = React, openTabById = () => assert.fail('render cannot navigate'), openProjects) {
  const result = await esbuild.build({ entryPoints: [component], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    plugins: process.env.BUILD_CONTINUE_TRACKER_PRE ? [{ name: 'frozen-tracker-control', setup(build) {
      build.onLoad({ filter: /BuildContinueTracker\.tsx$/ }, () => ({ contents: fs.readFileSync(process.env.BUILD_CONTINUE_TRACKER_PRE, 'utf8'), loader: 'tsx' }));
    } }] : [],
    external: ['react', 'react/*', 'react-dom', 'lucide-react', '../UI/Tooltip', './RequestDetailsPopover', './TabMessageSourceChip', '../../store/useWorkspaceStore'], logLevel: 'silent' });
  const module = { exports: {} }, leaf = name => {
    if (name === 'react') return react;
    if (name.endsWith('/Tooltip')) return { __esModule: true, default: ({ children, content, actionBar, side, align }) => React.createElement('section',
      { 'data-tooltip-side': side, 'data-tooltip-align': align }, children, React.createElement('aside', null, content), actionBar) };
    if (name.endsWith('/RequestDetailsPopover')) return { RequestDetailsPopover: ({ children, title, attributes }) => React.createElement('aside', { ...attributes, role: 'dialog', 'aria-label': title }, children) };
    if (name.endsWith('/TabMessageSourceChip')) return { TabMessageSourceChip: ({ source, onNavigate }) => React.createElement('button', { 'data-tab-message-source': source.sourceTabId, onClick: () => openTabById(source.sourceTabId, { projectId: source.sourceProjectId }).then(onNavigate) }, source.sourceTabName) };
    if (name.endsWith('/useWorkspaceStore')) return { useWorkspaceStore: { getState: () => ({ openTabById, openProjects }) } };
    if (name.endsWith('/TabMessageSourceChip')) return { ResearchSourceAction: ({ runId, destination = 'desktop', researchIcon }) => React.createElement('button', {
      'data-external-research-source': runId, 'data-external-research-destination': destination,
    }, researchIcon ? React.createElement('img', { alt: 'SC Desktop' }) : destination) };
    return require(name);
  };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: leaf, console }); return module.exports;
}
for (const state of ['pending', 'unknown', 'unresolved', 'paused']) test('card-contract: ' + state + ' row has one icon, full name budget and one exact X', async () => {
  const { BuildContinueTracker } = await trackerModule();
  const value = { ...target, operationId: '5bb31dcb-df87-4db6-8f07-8af1950210fa',
    source: { ...target.source, name: 'пробемы с телеграм' }, state, active: state === 'pending' || state === 'unknown' };
  const html = renderToStaticMarkup(React.createElement(BuildContinueTracker, { target: value, onCancel() {} }));
  const header = html.match(/<div[^>]*data-request-row-header[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(header); assert.equal((header.match(/<svg\b/g) || []).length, 1, 'no second continuation/type icon beside its one status');
  assert.doesNotMatch(header, /<code|5bb31dcb/); assert.match(header, /пробемы с телеграм/);
  assert.match(html, /data-build-continue-cancel=/);
  assert.doesNotMatch(html, /Установка:|data-build-continue-details/);
  assert.match(html, /aria-expanded="false"/);
});
test('card-contract: hook rejects an ok/no-op cancel snapshot rather than pretending the X worked', async () => {
  const h = await hookFixture(async name => name === 'build-continue:status-for-tab'
    ? snap(1, { state: 'unresolved', active: false }) : { ok: true, snapshot: snap(2, { state: 'unresolved', active: false }) });
  await h.h.cancel({ ...target, state: 'unresolved', active: false });
  assert.match(h.state().error, /не подтверждена/); assert.equal(h.state().targets[0].state, 'unresolved'); h.cleanup();
});
test('card-contract: one X invokes only its exact continuation owner; navigation and Research are independent', async () => {
  const calls = [], react = { ...React, useRef: value => ({ current: value }), useState: initial => [initial, () => {}] };
  const { BuildContinueTracker, buildContinueVisible } = await trackerModule(react, () => assert.fail('X cannot navigate'));
  const value = { ...target, active: false, state: 'unresolved' };
  const tree = BuildContinueTracker({ target: value, onCancel: input => calls.push(input) });
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.['data-build-continue-cancel']) return node;
    const nodes = [node.props?.actions, ...React.Children.toArray(node.props?.children)];
    for (const child of nodes) { const result = find(child); if (result) return result; }
    return null;
  }
  const close = find(tree); assert.ok(close); let stopped = 0;
  close.props.onClick({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 1); assert.deepEqual(calls, [value]); assert.equal(close.props.disabled, undefined);
  assert.equal(buildContinueVisible({ ...value, cancellation: { requestId: 'close', acknowledgedAt: 200 } }), false);
  assert.equal(buildContinueVisible({ ...value, state: 'confirmed' }), false);
});
for (const bad of [
  { operationKey: 'other' }, { handoffId: 'other' }, { operationId: 'other' }, { tabId: 'other' },
  { cancellation: { requestId: 'foreign', acknowledgedAt: 200 } },
  { cancellation: { requestId: 'same-cancel-request', acknowledgedAt: null } },
]) test('card-contract: cancellation ACK must match the same row and request: ' + JSON.stringify(bad), async () => {
  const h = await hookFixture(async name => name === 'build-continue:status-for-tab' ? snap(1)
    : { ok: true, snapshot: snap(2, { state: 'cancelled', active: false,
      cancellation: { requestId: 'same-cancel-request', acknowledgedAt: 200 }, ...bad }) });
  await h.h.cancel(target); assert.match(h.state().error, /не подтверждена/);
  assert.equal(h.state().targets[0].state, 'pending'); h.cleanup();
});
test('request row opens only its exact event by click; render and hover have no preview or navigation', async () => {
  const calls = [];
  const { BuildContinueTracker, buildContinueVisible } = await trackerModule();
  const tree = BuildContinueTracker({ target, onCancel() { assert.fail('read cannot cancel'); }, onOpen: s => calls.push(s) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /aria-haspopup="dialog"/); assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /data-build-continue-details|data-tooltip|Research|Установка:/);
  const walk = n => n?.props?.['data-build-continue-open'] ? n : React.Children.toArray(n?.props?.children).map(walk).find(Boolean);
  const button = walk(tree); assert.ok(button); assert.equal(button.props.onMouseEnter, undefined);
  const rect = { x: 1 }, anchor = { getBoundingClientRect: () => rect };
  button.props.onClick({ currentTarget: { closest: () => anchor } });
  assert.equal(calls.length, 1); assert.equal(calls[0].operationKey, target.operationKey);
  assert.equal(calls[0].anchor, anchor); assert.equal(calls[0].rect, rect); assert.equal(calls[0].history, false);
  assert.equal(buildContinueVisible({ ...target, state: 'confirmed', active: false }), false);
  assert.equal(buildContinueVisible({ ...target, route: { kind: 'install-callback' } }), false);
});
test('selected continuation preview contains exactly its task and no tab-wide Research, including legacy DTOs', async () => {
  const { BuildContinuePreview } = await trackerModule();
  const refs = Array.from({ length: 20 }, (_, i) => ({ runId: 'unrelated-' + i, runKind: 'external-research', externalResearchJobId: 'foreign-job-' + i }));
  const value = { ...target, relatedRequests: refs }, before = JSON.stringify(value);
  const html = renderToStaticMarkup(React.createElement(BuildContinuePreview, {
    target: value, selection: { operationKey: value.operationKey }, onClose() {}, previewRef: { current: null },
  }));
  assert.match(html, /role="dialog"/); assert.match(html, /Продолжение после обновления/);
  assert.match(html, /original-task-turn/); assert.match(html, /Установка:/); assert.match(html, /Запрос:/);
  assert.match(html, /data-tab-message-source="T"/);
  assert.doesNotMatch(html, /unrelated-|foreign-job-|Research|data-external-research|Открыть вкладку:/);
  assert.equal(JSON.stringify(value), before);
});
test('legacy row keeps its current tab name without inventing Research associations', async () => {
  const projects = new Map([['project', { tabs: new Map([['T', { name: 'Текущее имя вкладки' }]]) }]]);
  const { BuildContinueTracker } = await trackerModule(React, undefined, projects);
  const legacy = { ...target, source: undefined, relatedRequests: undefined };
  const html = renderToStaticMarkup(React.createElement(BuildContinueTracker, { target: legacy, onCancel() {}, onOpen() {} }));
  assert.match(html, /Текущее имя вкладки/); assert.doesNotMatch(html, /Research|data-tooltip/);
});
test('status hydration/events are scoped metadata, ordered and independent of History reads', async () => {
  let release;
  const h = await hookFixture(() => new Promise(resolve => { release = resolve; }));
  h.emit(snap(3)); release(snap(1)); await tick(); assert.equal(h.state().targets[0].state, 'pending');
  h.emit(snap(2, { state: 'confirmed' })); assert.equal(h.state().targets[0].state, 'pending');
  h.emit(snap(1, { state: 'confirmed', active: false }, 'Main-B')); assert.equal(h.state().targets[0].state, 'confirmed');
  h.emit(snap(99, {}, 'Main-A')); assert.equal(h.state().targets[0].state, 'confirmed');
  h.emit({ ...snap(99), tabId: 'other' }); assert.equal(h.state().targets[0].state, 'confirmed');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, 'build-continue:status-for-tab'); h.cleanup();
});
test('cancel lost ACK retry uses the same exact request and cannot refresh another owner after unmount', async () => {
  let cancels = 0;
  const h = await hookFixture(async name => name === 'build-continue:status-for-tab' ? snap(1)
    : ++cancels === 1 ? Promise.reject(Error('lost ACK')) : { ok: true, snapshot: snap(2, { state: 'cancelled', active: false,
      cancellation: { requestId: 'same-cancel-request', acknowledgedAt: 200 } }) });
  await h.h.cancel(target); assert.match(h.state().error, /lost ACK/); await h.h.cancel(target);
  const sent = h.calls.filter(x => x.name === 'build-continue:cancel-target'); assert.deepEqual(sent[0].args, sent[1].args);
  assert.equal(sent[0].args.operationKey, target.operationKey); assert.equal(h.state().targets[0].state, 'cancelled'); h.cleanup();
});
test('late cancellation readback cannot regress a newer epoch or an unmounted view', async () => {
  let release;
  const h = await hookFixture(name => name === 'build-continue:status-for-tab' ? snap(1) : new Promise(resolve => { release = resolve; }));
  const pending = h.h.cancel(target); h.emit(snap(1, { state: 'unknown' }, 'Main-B')); release({ ok: true, snapshot: snap(99) }); await pending;
  assert.equal(h.state().targets[0].state, 'unknown');
  const late = h.h.cancel(target), before = h.state(); h.cleanup(); release({ ok: true, snapshot: snap(200, { state: 'confirmed' }) }); await late;
  assert.equal(h.state(), before);
});

test('continuation indicators distinguish pending delivery, proven failure, unknown and confirmed', async () => {
  const { BuildContinueTracker } = await trackerModule();
  const render = patch => renderToStaticMarkup(React.createElement(BuildContinueTracker, { target: { ...target, ...patch }, onOpen() {}, onCancel() {} }));
  const waiting = render({ state: 'pending', active: true });
  assert.match(waiting, /color:#60a5fa/); assert.match(waiting, /animate-spin/);
  const failed = render({ state: 'unresolved', active: false, reason: 'continue-not-delivered' });
  assert.match(failed, /color:#f87171/); assert.doesNotMatch(failed, /animate-spin/);
  assert.match(render({ state: 'unknown', active: true }), /color:#fbbf24/);
  assert.match(render({ state: 'confirmed', active: false }), /color:#4ade80/);
  assert.doesNotMatch(render({ state: 'confirmed', active: false }), /animate-spin/);
});
