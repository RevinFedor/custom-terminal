'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), esbuild = require('esbuild');
const requireRepo = createRequire(path.resolve(__dirname, '../../../package.json'));
const React = requireRepo('react'), { renderToStaticMarkup } = requireRepo('react-dom/server');

async function trackerModule() {
  const result = await esbuild.build({ entryPoints: [path.resolve(__dirname, '../components/Workspace/BuildInstallTracker.tsx')],
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node18', write: false, external: ['react', 'react/*', 'react-dom', 'lucide-react', './RequestDetailsPopover'], logLevel: 'silent' });
  const context = vm.createContext({ require: name => name.endsWith('/RequestDetailsPopover') ? { RequestDetailsPopover: ({ children, attributes, title }) => React.createElement('aside', attributes, title, children) } : requireRepo(name), module: { exports: {} }, exports: {}, console });
  context.exports = context.module.exports; vm.runInContext(result.outputFiles[0].text, context);
  return context.module.exports;
}

test('actual shared dock row and selected side preview retain mode/receipt and stale/error state', async () => {
  const { BuildInstallTracker, BuildInstallPreview } = await trackerModule();
  const job = { id: 'opaque:install-J', requestId: 'request-I', revision: 5, startedAt: 1,
    phase: 'building', stage: 'installing', running: true, force: true, ok: null,
    returnTo: { tabId: '753', sessionId: 'exact-S' }, callback: { status: 'pending' } };
  const html = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: false, history: true, onCancel() {} }));
  assert.match(html, /data-request-kind="install"/); assert.match(html, /data-build-install-job="opaque:install-J"/);
  assert.match(html, /Force Install/); assert.match(html, /aria-haspopup="dialog"/); assert.doesNotMatch(html, /exact-S|data-build-install-details/);
  const preview = renderToStaticMarkup(React.createElement(BuildInstallPreview, { job, stale: false, selection: {}, previewRef: {}, onClose() {} }));
  assert.match(preview, /Установка/); assert.match(preview, /exact-S/);
  assert.match(html, /<span class="noted-infinite-animation animate-spin"/); assert.doesNotMatch(html, /data-orchestration-action/);
  const stale = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: true, history: true, onCancel() {} }));
  assert.match(stale, /Связь не подтверждена/); assert.doesNotMatch(stale, /data-build-install-details/); assert.match(stale, /disabled/);
  const source = fs.readFileSync(path.resolve(__dirname, '../components/Workspace/OrchestrationStatusChip.tsx'), 'utf8');
  assert.match(source, /statusInstalls\.length > 0/); assert.match(source, /entry\.kind === 'install'/);
});

test('actual job projection rejects stale/source-swapped packets; completed jobs remain available to typed history', async () => {
  const { mergeBuildInstallJobs, buildInstallPresentation, buildInstallVisibleInDock } = await import('./buildInstallPresentation.mjs');
  const job = { id: 'J', requestId: 'I', revision: 5, startedAt: 1, running: false, ok: true,
    returnTo: { tabId: '753', sessionId: 'S' }, callback: { status: 'sent' } };
  const rows = mergeBuildInstallJobs([job], [{ ...job, revision: 3, ok: false }, { ...job, revision: 6, returnTo: { tabId: 'other', sessionId: 'S' } }], '753');
  assert.equal(rows.length, 1); assert.equal(rows[0].revision, 5); assert.equal(buildInstallVisibleInDock(job), false);
  assert.strictEqual(mergeBuildInstallJobs(rows, [{ ...job }], '753'), rows, 'duplicate status does not rerender unrelated retained owners');
  assert.equal(buildInstallPresentation(job).label, 'Установлено');
  assert.equal(buildInstallPresentation({ ...job, callback: { status: 'failed' } }).label, 'Ошибка доставки уведомления');
});

for (const status of ['pending', 'waiting', 'sending', 'confirming', 'sent_unverified']) test('post-restart callback '+status+' spins before delivery without a success icon', async () => {
  const { BuildInstallTracker } = await trackerModule();
  const job = { id: 'J', requestId: 'I', running: false, ok: true, callback: { status },
    continuation: { state: 'waiting-callback-turn', inheritedActive: false } };
  const html = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: false, onOpen() {}, onCancel() {} }));
  assert.match(html, /color:#60a5fa/); assert.match(html, /animate-spin/); assert.doesNotMatch(html, /lucide-circle-check/);
});
test('delivered callback is green while natural-final hold remains; errors are red and unknown remains distinct', async () => {
  const { buildInstallPresentation: present, buildInstallVisibleInDock: visible } = await import('./buildInstallPresentation.mjs');
  const job = { id: 'J', requestId: 'I', ok: true, running: false, callback: { status: 'sent' },
    continuation: { state: 'waiting-callback-turn', inheritedActive: false } };
  assert.equal(present(job).color, '#4ade80'); assert.equal(present(job).spinning, false); assert.equal(visible(job), true);
  assert.equal(visible({ ...job, continuation: { state: 'continued' } }), false);
  for (const status of ['failed', 'blocked']) assert.equal(present({ ...job, callback: { status } }).color, '#f87171');
  assert.equal(present({ ...job, ok: false }).color, '#f87171');
  assert.equal(present({ ...job, installOutcomeUnknown: true }).color, '#fbbf24');
  assert.equal(present(job, true).color, '#fbbf24'); assert.equal(present(job, true).spinning, false);
});
test('install opens its exact event only by click and keeps cancellation separate', async () => {
  const { BuildInstallTracker } = await trackerModule(), opens = [], cancels = [];
  const job = { id: 'J', requestId: 'I', running: true, ok: null };
  const tree = BuildInstallTracker({ job, stale: false, onOpen: value => opens.push(value), onCancel: value => cancels.push(value) });
  function find(n, predicate) { if (!n?.props) return null; if (predicate(n)) return n;
    return [n.props.actions, ...React.Children.toArray(n.props.children)].map(x => find(x, predicate)).find(Boolean); }
  const button = find(tree, n => n.props['data-build-install-open']);
  assert.ok(button); assert.equal(button.props.onMouseEnter, undefined);
  const rect = {}, anchor = { getBoundingClientRect: () => rect };
  button.props.onClick({ currentTarget: { closest: () => anchor } });
  assert.equal(opens.length, 1); assert.equal(opens[0].jobId, 'J'); assert.equal(opens[0].requestId, 'I'); assert.equal(opens[0].anchor, anchor);
  assert.equal(cancels.length, 0);
  find(tree, n => n.props['aria-label'] === 'Отменить запрос установки').props.onClick({ stopPropagation() {} });
  assert.deepEqual(cancels, [job]); assert.equal(opens.length, 1);
});

test('known user Stop is grey/static with a cancellation icon while its already-delivered response finishes', async () => {
  const { BuildInstallTracker } = await trackerModule();
  const job = { id: 'J', requestId: 'I', ok: null, running: false, cancelled: true,
    cancellation: { origin: 'user', surface: 'voice-record-desktop' }, callback: { status: 'sent' },
    continuation: { state: 'waiting-callback-turn', inheritedActive: false } };
  const html = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: false, onOpen() {}, onCancel() {} }));
  assert.match(html, /color:#a3a3a3/); assert.match(html, /lucide-circle-x/);
  assert.doesNotMatch(html, /animate-spin|lucide-circle-check/);
});

test('a finished failed install has one enabled X bound to its original Job/request, even with a cancelled continuation', async () => {
  const { BuildInstallTracker } = await trackerModule(), calls = [];
  const job = { id: 'timvmcxfrhb6233435', requestId: 'mcp-wire-repair-4875-noted-preserving-20261024-v1',
    phase: 'finished', running: false, ok: false, error: 'terminal_process_observation_unknown',
    callback: { status: 'sent' }, continuation: { state: 'cancelled' } };
  const tree = BuildInstallTracker({ job, stale: false, onOpen() { assert.fail('X cannot open preview'); }, onCancel: j => calls.push(j) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /aria-label="Закрыть запрос установки"/); assert.doesNotMatch(html, /disabled=""/);
  function find(n) { if (!n?.props) return null; if (n.props['aria-label'] === 'Закрыть запрос установки') return n;
    return [n.props.actions, ...React.Children.toArray(n.props.children)].map(find).find(Boolean); }
  find(tree).props.onClick({ stopPropagation() {} }); assert.deepEqual(calls, [job]);
});
