'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), esbuild = require('esbuild');
const requireRepo = createRequire(path.resolve(__dirname, '../../../package.json'));
const React = requireRepo('react'), { renderToStaticMarkup } = requireRepo('react-dom/server');

test('actual shared dock row renders durable installer phase/mode/receipt and stale/error state without orchestration actions', async () => {
  const result = await esbuild.build({ entryPoints: [path.resolve(__dirname, '../components/Workspace/BuildInstallTracker.tsx')],
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node18', write: false, external: ['react', 'react/*', 'react-dom', 'lucide-react'], logLevel: 'silent' });
  const context = vm.createContext({ require: requireRepo, module: { exports: {} }, exports: {}, console });
  context.exports = context.module.exports; vm.runInContext(result.outputFiles[0].text, context);
  const { BuildInstallTracker } = context.module.exports;
  const job = { id: 'opaque:install-J', requestId: 'request-I', revision: 5, startedAt: 1,
    phase: 'building', stage: 'installing', running: true, force: true, ok: null,
    returnTo: { tabId: '753', sessionId: 'exact-S' }, callback: { status: 'pending' } };
  const html = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: false, history: true, onCancel() {} }));
  assert.match(html, /data-request-kind="install"/); assert.match(html, /data-build-install-job="opaque:install-J"/);
  assert.match(html, /Force Install/); assert.match(html, /Установка/); assert.match(html, /exact-S/);
  assert.match(html, /<span class="noted-infinite-animation animate-spin"/); assert.doesNotMatch(html, /data-orchestration-action/);
  const stale = renderToStaticMarkup(React.createElement(BuildInstallTracker, { job, stale: true, history: true, onCancel() {} }));
  assert.match(stale, /Связь не подтверждена/); assert.match(stale, /последнее сохранённое/); assert.match(stale, /disabled/);
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
  assert.equal(buildInstallPresentation({ ...job, callback: { status: 'failed' } }).label, 'Возврат не подтверждён');
});
