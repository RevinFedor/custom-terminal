'use strict';

const path = require('node:path');
const api = require('./noted-prod-api');
const { voiceInstallBinding } = require('../src/main/voice-install-binding');
const ENDPOINT = '/api/build-continue/operations';
function createVoiceInstallContinuation(raw, { inspect = api.inspectProdServer, token = api.readToken,
  request = api.requestJson } = {}) {
  const binding = voiceInstallBinding(raw);
  return {
    binding,
    source: { status: 'found', server: { pid: binding.sourceMainPid } },
    async capture() {
      const server = inspect();
      if (server.status !== 'found' || server.server.pid !== binding.sourceMainPid) throw Object.assign(
        Error('voice_install_source_changed'), { quitRequested: false });
      const result = await request({ port: server.server.port, token: token(), method: 'POST', requestPath: ENDPOINT,
        body: { version: 2, action: 'capture-voice-install', operationId: binding.operationId,
          expectedMainPid: binding.sourceMainPid, binding }, timeoutMs: 15000 });
      if (result.statusCode !== 200 || result.body?.ok !== true) throw Object.assign(
        Error(result.body?.error || 'voice_install_capture_not_confirmed'), { quitRequested: false });
      if (result.body.operation?.installBinding?.bindingDigest !== binding.bindingDigest
        || result.body.operation.sourceMainPid !== binding.sourceMainPid) throw Error('voice_install_capture_ack_changed');
      return result.body.operation;
    },
    async validateCandidate(app) {
      const asar = require('@electron/asar'), archive = path.join(app, 'Contents', 'Resources', 'app.asar');
      for (const [file, marker] of [
        ['src/main/build-install-continue.js', 'voice-install-shutdown-binding-v1'],
        ['src/main/build-continue-operation.js', 'activateInstall'],
        ['src/main/build-continue-api.js', 'capture-voice-install'],
        ['src/main/voice-install-binding.js', 'voice_install_binding_changed'],
        ['src/main/build-continue-return-admission.js', 'captured-return-reservation-pending'],
      ]) if (!asar.extractFile(archive, file).toString('utf8').includes(marker)) throw Error('candidate_voice_install_protocol_missing:' + file);
    },
  };
}
module.exports = { createVoiceInstallContinuation };
