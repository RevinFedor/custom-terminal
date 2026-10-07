'use strict';

// Application API metadata/admission only. The renderer store and its existing
// App-root runner retain authoring and execution ownership.
const QUEUE_OPS = Object.freeze(['add', 'addAction', 'update', 'updateAction', 'remove', 'reorder', 'clear',
  'setAutoRun', 'setStopAfter', 'setCloseAfter', 'setRunAfterTab', 'setCondition', 'setTrigger', 'clearTrigger',
  'setFirstDelaySeconds', 'setPostPromptEnabled', 'setPostPromptText', 'setLoopPromptEnabled', 'setLoopPromptText',
  'beginEdit', 'endEdit', 'replay', 'sendNow', 'quickCompact']);
const AUTO_COMPACT_OPS = Object.freeze(['updatePolicy', 'setExcluded', 'cancel', 'requestNow']);
const RUN_AFTER_CAPABILITY = Object.freeze({ version: 1,
  read: '/api/terminal-tabs/:tabId/queue?runAfter=1',
  mutate: '/api/terminal-tabs/:tabId/queue', envelope: 'runAfter',
  operationRead: '/api/run-after/operations/:operationId',
  draftRelease: '/api/run-after/operations/:operationId/release',
  overview: '/api/run-after', autoCompact: '/api/run-after/auto-compact',
  imagePreview: '/api/run-after/image-preview',
  event: 'queue-update', globalEvent: 'project-activity', ordering: 'main-renderer-epoch-revision',
  durableMutations: true, editorLocks: true, richAuthoring: true, authoringFormat: 'queue-snapshot-v1',
  queueOperations: QUEUE_OPS, autoCompactOperations: AUTO_COMPACT_OPS,
  triggers: ['timer', 'onTab', 'app-restart'], replay: 'draft-snapshot',
  sendNow: 'explicit', finiteRepeats: false, cron: false, perPromptThinkingFast: false,
});
const ACTION_FIELDS = ['kind', 'toolType', 'model', 'effort', 'targetUuid', 'targetText', 'sourceSessionId', 'targetIteration'];
const ARG_FIELDS = {
  add: ['text', 'title', 'chips', 'images', 'imagePaths'], addAction: [...ACTION_FIELDS, 'action', 'title'],
  update: ['id', 'text', 'title', 'titleManual', 'enabled', 'chips', 'images', 'imagePaths'],
  updateAction: ['id', ...ACTION_FIELDS, 'action', 'title'], remove: ['id'], reorder: ['fromIndex', 'toIndex'], clear: [],
  setAutoRun: ['value'], setStopAfter: ['value'], setCloseAfter: ['value'], setRunAfterTab: ['value'],
  setCondition: ['id', 'operator', 'value'], setTrigger: ['id', 'trigger'], clearTrigger: ['id'],
  setFirstDelaySeconds: ['value'], setPostPromptEnabled: ['value'], setPostPromptText: ['value'],
  setLoopPromptEnabled: ['value'], setLoopPromptText: ['value'], beginEdit: ['id'], endEdit: [],
  replay: ['id'], sendNow: ['id'], quickCompact: [],
  updatePolicy: ['patch'], setExcluded: ['tabId', 'excluded'], cancel: ['tabId', 'targetGuard', 'activityId'], requestNow: ['tabId', 'resume', 'targetGuard'],
};
function runAfterError(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
function validOperationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}
function validateRunAfterEnvelope(input, allowed = QUEUE_OPS) {
  const envelope = input?.runAfter;
  if (!envelope || envelope.version !== 1 || !validOperationId(envelope.operationId)
    || !allowed.includes(input.op) || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)
    || !envelope.expected || typeof envelope.expected !== 'object'
    || typeof envelope.expected.epoch !== 'string' || !envelope.expected.epoch
    || !Number.isSafeInteger(envelope.expected.revision) || envelope.expected.revision < 1
    || typeof envelope.expected.scopeKey !== 'string' || !envelope.expected.scopeKey) {
    throw runAfterError('run_after_request_invalid', 400);
  }
  if (Object.keys(input.args).some(key => !ARG_FIELDS[input.op]?.includes(key))) throw runAfterError('run_after_argument_unsupported', 400);
  return { version: 1, operationId: envelope.operationId, expected: envelope.expected,
    editorToken: typeof envelope.editorToken === 'string' ? envelope.editorToken : null };
}
module.exports = { RUN_AFTER_CAPABILITY, QUEUE_OPS, AUTO_COMPACT_OPS,
  runAfterError, validOperationId, validateRunAfterEnvelope };
