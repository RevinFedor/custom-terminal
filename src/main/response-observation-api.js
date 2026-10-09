'use strict';

const { RESPONSE_OBSERVATION_KIND, responseObservationRequestIdentity } = require('./orchestration-response-observation');

const fail = (code, message, statusCode = 409) => {
  throw Object.assign(new Error(message), { code, statusCode });
};

function createResponseObservationApi({ store, descriptor, readState, sourceExecutionContext,
  captureSourceTarget, onAccepted }) {
  return {
    async start(targetTabId, body) {
      const allowed = new Set(['runId', 'sourceTabId', 'waitForDescendants', 'sourceMeta']);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !allowed.has(key))
        || typeof body.runId !== 'string' || !body.runId.trim() || body.runId.length > 200
        || typeof body.sourceTabId !== 'string' || !body.sourceTabId.trim()
        || (body.waitForDescendants != null && typeof body.waitForDescendants !== 'boolean')) {
        fail('invalid_response_observation_arguments', 'runId, sourceTabId and a valid wait mode are required', 400);
      }
      const runId = body.runId.trim(), sourceTabId = body.sourceTabId.trim();
      const identity = responseObservationRequestIdentity({ sourceTabId, targetTabId,
        waitForDescendants: body.waitForDescendants !== false });
      const previous = await store.getInternal(runId);
      if (store.activityReadError) fail('response_observation_registry_unavailable', 'Saved observations could not be loaded', 503);
      if (previous) {
        if (previous.requestFingerprint !== identity.requestFingerprint) {
          fail('idempotency_key_reused', 'runId belongs to a different request');
        }
        return { accepted: true, idempotent: true, runId, run: await store.get(runId) };
      }
      const source = descriptor(sourceTabId), target = descriptor(targetTabId);
      if (!source || !['claude', 'codex'].includes(source.toolType)) {
        fail('response_source_unavailable', 'Source tab is not an available Claude/Codex session', 404);
      }
      if (!target || !['claude', 'codex'].includes(target.toolType)) {
        fail('response_target_unavailable', 'Target tab is not an available Claude/Codex session', 404);
      }
      const state = await readState(targetTabId);
      if (state?.known !== true || typeof state.busy !== 'boolean' || !state.sessionId || !['claude', 'codex'].includes(state.toolType)) {
        fail('response_target_runtime_unknown', 'Target session could not be verified', 503);
      }
      if (body.waitForDescendants === false && state.busy && !state.currentSubject) {
        fail('response_current_turn_unresolved', 'The current provider turn cannot yet be identified');
      }
      const sourceContext = sourceExecutionContext(sourceTabId, body.sourceMeta);
      const sourceSendTarget = await captureSourceTarget(source, null, sourceContext);
      const reserved = await store.reserveOrGet({
        ...identity, runId, runKind: RESPONSE_OBSERVATION_KIND, sourceTabId, targetTabId,
        sourceTabName: source.tabName, sourceProjectId: source.projectId, sourceProjectName: source.projectName,
        sourceProjectPath: source.projectPath, sourceToolType: source.toolType,
        sourceExecutionContext: sourceContext, sourceSendTarget,
        sourceSessionId: sourceSendTarget?.sessionId || sourceContext?.sessionId || null,
        targetTabName: target.tabName, targetProjectId: target.projectId, targetProjectName: target.projectName,
        targetProjectPath: target.projectPath, targetCwd: state.cwd || target.cwd || target.projectPath,
        targetToolType: state.toolType, sessionId: state.sessionId,
        targetCreated: false, autoStopCreatedTargets: false, notifySource: true,
        label: 'Ожидание ответа', waitForDescendants: body.waitForDescendants !== false,
        observationTarget: { sessionId: state.sessionId, toolType: state.toolType },
        observationLiveContext: state.currentSubject?.targetExecutionContext || state.executionContext || null,
        observationCurrentTurnSubject: body.waitForDescendants === false ? state.currentSubject || null : null,
      });
      if (reserved.conflict) fail('idempotency_key_reused', 'runId belongs to a different request');
      if (reserved.created) onAccepted(reserved.run);
      return { accepted: true, idempotent: !reserved.created, runId, run: reserved.run };
    },
  };
}

module.exports = { createResponseObservationApi };
