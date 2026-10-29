'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const asar = require('@electron/asar');
const { createVoiceInstallContinuation } = require('./voice-install-continuation.cjs');
const { voiceInstallBinding } = require('../src/main/voice-install-binding');
const binding = () => voiceInstallBinding({ version: 1, requestId: 'request-one', requestHash: 'a'.repeat(64), requestHashVersion: 2,
  jobId: 'job-one', operationId: 'voice-force-job-one', maintenanceOperationId: 'install:noted:job-one',
  callbackHandoffId: 'build-install-return:job-one', sourceMainPid: 11, sourceInstanceId: 'old-main',
  source: { tabId: 'caller', projectId: 'P', toolType: 'codex', sessionId: 'S', expectedTarget: { toolType: 'codex', sessionId: 'S' } } });
test('driver capture addresses only the registered Main/job; known refusal and lost ACK keep different Quit outcomes', async () => {
  let requests = 0;
  const changed = createVoiceInstallContinuation(binding(), { inspect: () => ({ status: 'found', server: { pid: 12, port: 9 } }), request: () => requests++ });
  await assert.rejects(changed.capture(), error => error.quitRequested === false); assert.equal(requests, 0);
  const options = { inspect: () => ({ status: 'found', server: { pid: 11, port: 9 } }), token: () => 'private-token' };
  const refused = createVoiceInstallContinuation(binding(), { ...options, request: async () => ({ statusCode: 409, body: { error: 'capture-denied' } }) });
  await assert.rejects(refused.capture(), error => error.quitRequested === false && error.message === 'capture-denied');
  const unknown = createVoiceInstallContinuation(binding(), { ...options, request: async () => { requests++; throw Error('ACK lost'); } });
  await assert.rejects(unknown.capture(), error => error.quitRequested !== false); assert.equal(requests, 1);
});
test('actual ASAR guard requires the complete raw shutdown/API/executor cohort before app-owned Quit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-continue-cohort-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'Noted Terminal.app'), resources = path.join(app, 'Contents/Resources'), source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src/main'), { recursive: true }); await fs.mkdir(resources, { recursive: true });
  for (const name of ['build-install-continue.js', 'build-continue-operation.js', 'build-continue-api.js', 'voice-install-binding.js', 'build-continue-return-admission.js']) {
    await fs.copyFile(path.join(__dirname, '../src/main', name), path.join(source, 'src/main', name));
  }
  const archive = path.join(resources, 'app.asar'), client = createVoiceInstallContinuation(binding());
  await asar.createPackage(source, archive); await client.validateCandidate(app);
  await fs.writeFile(path.join(source, 'src/main/build-install-continue.js'), 'module.exports = {};');
  await asar.createPackage(source, archive); asar.uncache(archive);
  await assert.rejects(client.validateCandidate(app), /protocol_missing/);
});
