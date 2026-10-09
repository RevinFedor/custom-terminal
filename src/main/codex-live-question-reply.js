'use strict';

const crypto = require('crypto');
const {
  readCodexQuestionReply,
  codexNativeQuestionDefinition,
  registerNativeQuestionDefinition,
  proveCodexNativeQuestionReply,
} = require('../shared/native-question-reply.cjs');

const fingerprint = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const NATIVE_NAMES = new Set(['request_user_input_async', 'functions.request_user_input_async']);

// Display provenance belongs to one physical rollout observer, not to the
// native question stack. accepted:true ends liveToolCalls before human replies,
// so retain only bounded definition hashes until this observer is replaced.
function createCodexLiveQuestionReplyProof({ physicalSessionId, maxDefinitions = 256, log = () => {} }) {
  const definitions = new Map();
  const limit = Number.isSafeInteger(maxDefinitions) && maxDefinitions > 0 ? maxDefinitions : 256;
  const observe = (record, sourceIdentity, recordSessionId) => {
    if (!physicalSessionId || recordSessionId !== physicalSessionId) return;
    const payload = record?.payload || {};
    if (record?.type === 'event_msg' && payload.type === 'thread_rolled_back') {
      const cleared = definitions.size;
      definitions.clear();
      if (cleared) log('reset', { reason: 'thread-rolled-back', cleared });
      return;
    }
    if (record?.type !== 'response_item' || payload.type !== 'function_call'
      || !NATIVE_NAMES.has(payload.name)) return;
    if (!Number.isSafeInteger(record.__byteOffset) || record.__byteOffset < 0 || !sourceIdentity) {
      log('definition-refused', { reason: 'exact-source-unavailable' });
      return;
    }
    let args = payload.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    const definition = codexNativeQuestionDefinition({
      toolName: payload.name, namespace: payload.namespace || '', callId: payload.call_id,
      args, physicalSessionId, sourceIdentity,
    }, fingerprint);
    if (!definition) {
      log('definition-refused', { reason: 'unsupported-native-call', callId: payload.call_id || null });
      return;
    }
    registerNativeQuestionDefinition(definitions, definition);
    let evicted = 0;
    while (definitions.size > limit) { definitions.delete(definitions.keys().next().value); evicted++; }
    log('definition', { callId: definition.callId, count: definitions.size, evicted,
      ambiguous: definitions.get(definition.callId)?.ambiguous === true });
  };
  const decorate = message => {
    if (message?.type !== 'user' || message.sessionId !== physicalSessionId
      || message.message?.role !== 'user') return message;
    const blocks = message.message.content;
    const content = typeof blocks === 'string' ? blocks : Array.isArray(blocks)
      ? blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).filter(Boolean).join('\n') : '';
    if (!content.trimStart().startsWith('<send_user_message_question_reply>')) return message;
    const proof = proveCodexNativeQuestionReply(content, definitions, physicalSessionId, fingerprint);
    if (proof) {
      log('proved', { uuid: message.uuid, links: proof.links.length, transportHash: proof.transportHash });
      return { ...message, questionReplyProof: proof };
    }
    const rows = readCodexQuestionReply(content);
    const reason = !rows ? 'malformed-envelope' : rows.some(row => !definitions.has(row.callId))
      ? 'definition-unavailable' : rows.some(row => definitions.get(row.callId)?.ambiguous)
        ? 'ambiguous-definition' : 'exact-link-mismatch';
    log('literal', { uuid: message.uuid, reason });
    // A reused carrier may have an old certificate; never forward it on a
    // negative current proof. Canonical body/identity stay byte-for-byte intact.
    const { questionReplyProof: _oldProof, ...literal } = message;
    return literal;
  };
  return { observe, decorate };
}

module.exports = { createCodexLiveQuestionReplyProof };
