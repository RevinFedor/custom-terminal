'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), esbuild = require('esbuild');

test('actual continuation IPC client retains live hold over stale startup GET; duplicate/late callback cannot regress its floor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-continuation-client-')), outfile = path.join(root, 'client.cjs');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'buildInstallContinuation.mjs')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  const events = new EventEmitter(); let resolve;
  global.window = { require: () => ({ ipcRenderer: { on: events.on.bind(events),
    invoke: () => new Promise(done => resolve = done) } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  const client = require(outfile), entry = { requestId: 'I', fingerprint: 'exact', source: { tabId: '753' }, state: 'waiting-install' };
  assert.equal(client.buildInstallContinuationBlocks('753'), true, 'unknown is never empty authority');
  const initialized = client.initializeBuildInstallContinuations();
  events.emit('build-install:continuation', null, entry);
  resolve({ version: 1, known: true, entries: [] }); await initialized;
  assert.equal(client.buildInstallContinuationBlocks('753'), true, 'live accepted intent wins over older empty read');
  events.emit('build-install:continuation', null, { ...entry, state: 'continued', outcomeFloorAt: 123, callbackProof: { turnId: 'T' } });
  assert.equal(client.buildInstallContinuationBlocks('753'), false); assert.equal(client.buildInstallContinuationFloor('753'), 123);
  events.emit('build-install:continuation', null, entry);
  assert.equal(client.buildInstallContinuationBlocks('753'), false); assert.equal(client.buildInstallContinuationFloor('753'), 123);
  assert.equal(client.buildInstallContinuationBlocks('ordinary'), false);
});

test('actual orchestration activity store projects installer waiting without creating a fake run or own model busy', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-activity-store-')), outfile = path.join(root, 'activity.cjs');
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../store/useOrchestrationStore.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  const events = new EventEmitter(), entry = { requestId: 'I', fingerprint: 'F', source: { tabId: '753', projectId: 'P' }, state: 'waiting-install' };
  global.window = { require: () => ({ ipcRenderer: { on: events.on.bind(events), invoke: async channel => {
    if (channel === 'orchestration:list-active') return [];
    if (channel === 'build-install:list-continuations') return { version: 1, known: true, entries: [entry] };
    throw Error('unexpected IPC ' + channel);
  } } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  const owner = require(outfile); await owner.initializeOrchestrationStore();
  assert.equal(owner.useOrchestrationStore.getState().activeRuns.size, 0);
  assert.equal(owner.useOrchestrationStore.getState().inheritedBusyTabIds.has('753'), true);
  assert.equal(owner.useOrchestrationStore.getState().inheritedBusyProjectIds.has('P'), true);
  assert.equal(owner.isOrchestrationCompletionBlocked('753'), true);
  events.emit('build-install:continuation', null, { ...entry, state: 'continued', outcomeFloorAt: 123, callbackProof: { turnId: 'T' } });
  assert.equal(owner.isOrchestrationCompletionBlocked('753'), false);
  assert.equal(owner.useOrchestrationStore.getState().inheritedBusyTabIds.has('753'), false);
});

test('finished installer awaiting callback proof remains blocked and visible, but is not inherited work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-finished-proof-')), outfile = path.join(root, 'activity.cjs');
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../store/useOrchestrationStore.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  const events = new EventEmitter(), entry = { requestId: 'I', jobId: 'J', fingerprint: 'F',
    source: { tabId: '753', projectId: 'P', sessionId: 'S' }, state: 'waiting-callback-turn',
    inheritedActive: false, canCancelContinuation: true, projection: { epoch: 'main', revision: 2 } };
  global.window = { require: () => ({ ipcRenderer: { on: events.on.bind(events), invoke: async channel => {
    if (channel === 'orchestration:list-active') return [];
    if (channel === 'build-install:list-continuations') return { version: 1, known: true, entries: [entry] };
    throw Error('unexpected IPC ' + channel);
  } } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  const owner = require(outfile); await owner.initializeOrchestrationStore();
  assert.equal(owner.useOrchestrationStore.getState().activeRuns.size, 0);
  assert.equal(owner.isOrchestrationCompletionBlocked('753'), true, 'proof guard is not cosmetic activity');
  assert.equal(owner.useOrchestrationStore.getState().inheritedBusyTabIds.has('753'), false);
  const presentation = await import('./buildInstallPresentation.mjs');
  const job = { id: 'J', requestId: 'I', running: false, cancelled: true, callback: { status: 'sent' }, continuation: entry };
  assert.equal(presentation.buildInstallVisibleInDock(job), true);
  assert.equal(presentation.buildInstallPresentation(job).spinning, false);
  assert.match(presentation.buildInstallPresentation(job).label, /продолжения/);
});
