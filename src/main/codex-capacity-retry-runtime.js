'use strict';
const { reduceCodexCapacityRetry, isCodexCapacityRetryEffectCurrent } = require('./codex-capacity-retry-policy');
const { CODEX_MODEL_CAPACITY_MESSAGE } = require('./codex-model-capacity-state');

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') return textOf(value.text || value.content || value.summary);
  return '';
}

function classifyCodexCapacityRetryRecord(record) {
  const p = record?.payload || {};
  const at = Date.parse(record?.timestamp || '');
  if (!Number.isFinite(at)) return null;
  if (p.is_system === true || p.metadata?.purpose === 'conversation_recap'
    || ['compaction', 'recap', 'summary'].includes(p.phase)) return null;
  if (record.type === 'event_msg' && p.type === 'task_complete'
    && p.error?.codex_error_info === 'server_overloaded'
    && String(p.error.message || '').trim() === CODEX_MODEL_CAPACITY_MESSAGE
    && typeof p.turn_id === 'string' && p.turn_id) {
    return { type: 'capacity', errorId: p.turn_id, at };
  }
  let meaningful = false;
  if (record.type === 'response_item') {
    if (['function_call', 'custom_tool_call'].includes(p.type)) meaningful = !!(p.name || p.call_id);
    else if (p.type === 'reasoning') meaningful = !!(textOf(p.summary || p.content).trim() || p.encrypted_content);
    else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content).trim();
      meaningful = !!text;
    }
  } else if (record.type === 'event_msg') {
    if (['agent_message', 'agent_reasoning'].includes(p.type)) meaningful = !!textOf(p.message || p.text).trim();
    else if (['exec_command_begin', 'mcp_tool_call_begin', 'patch_apply_begin'].includes(p.type)) meaningful = !!p.call_id;
  }
  if (!meaningful) return null;
  return { type: 'progress', at, eventId: String(record.__byteOffset ?? p.id ?? p.call_id ?? record.timestamp) };
}

function createCodexCapacityRetryRuntime({ getSettings, loadState, saveState, isCurrent, send, notify, cancelSend, log = () => {} }) {
  const entries = new Map();
  const scopeOf = owner => JSON.stringify([owner.tabId, owner.sessionId]);
  function entryFor(owner) {
    const scopeKey = scopeOf(owner);
    const previous = entries.get(owner.tabId);
    if (previous?.scopeKey === scopeKey && previous.owner.generation === owner.generation) return previous;
    let state = loadState(owner.tabId);
    if (state?.scopeKey !== scopeKey) state = null;
    // A new live process is a new explicit launch after Stop. Pending effects
    // are never replayed on boot; only new typed errors can request a retry.
    if (state?.cancelled) state = null;
    const entry = { scopeKey, owner, state };
    entries.set(owner.tabId, entry);
    return entry;
  }
  function cancel(tabId, reason = 'cancelled') {
    const entry = entries.get(tabId);
    if (!entry) return;
    if (entry.state?.pendingEffectId) cancelSend?.(tabId, entry.state.pendingEffectId, reason);
    entry.state = reduceCodexCapacityRetry(entry.state, { type: 'cancel', scopeKey: entry.scopeKey }).state;
    saveState(tabId, entry.state);
  }
  function progress(owner, event) {
    if (!isCurrent(owner)) return;
    const entry = entryFor(owner);
    const previous = entry.state;
    const result = reduceCodexCapacityRetry(previous, { ...event, scopeKey: entry.scopeKey });
    entry.state = result.state;
    // Ordinary output has no disk-write hot path. Persist only a replenished
    // retry budget; this does not change anyone's transcript read cursor.
    if (result.state !== previous && (previous?.attempts || previous?.exhausted || previous?.pendingEffectId)) {
      if (previous.pendingEffectId) cancelSend?.(owner.tabId, previous.pendingEffectId, 'real-progress');
      saveState(owner.tabId, entry.state);
    }
  }
  async function capacity(owner, event) {
    const settings = await getSettings();
    if (!isCurrent(owner)) return { ignored: true };
    const entry = entryFor(owner);
    const result = reduceCodexCapacityRetry(entry.state, { ...event, scopeKey: entry.scopeKey }, settings);
    entry.state = result.state;
    if (!result.effect) return { ignored: true };
    saveState(owner.tabId, entry.state); // reserve before any external effect
    const effect = result.effect;
    const stillCurrent = async () => isCurrent(owner)
      && entries.get(owner.tabId) === entry
      && isCodexCapacityRetryEffectCurrent(entry.state, effect, await getSettings());
    if (!await stillCurrent()) return { ignored: true };
    log('capacity ' + effect.type + ' tab=' + owner.tabId.slice(-12) + ' attempt=' + effect.attempt);
    if (effect.type === 'exhausted') {
      await notify(owner, effect);
      return { exhausted: true };
    }
    try {
      const result = await send(owner, effect, stillCurrent);
      if (result?.submitted === false && await stillCurrent()) {
        cancel(owner.tabId, 'retry-not-submitted');
        await notify(owner, effect, result.error || result.code || 'continue was not submitted');
      }
      // Unknown delivery is not permission to issue another Enter. Its exact
      // receipt and the next typed provider event own further reconciliation.
      return result;
    } catch (error) {
      log('capacity delivery observation failed: ' + String(error?.message || error));
      return { submitted: null, deliveryUnknown: true };
    }
  }
  function reset(owner, at) {
    const entry = entryFor(owner);
    if (entry.state?.pendingEffectId) cancelSend?.(owner.tabId, entry.state.pendingEffectId, 'new-user-request');
    entry.state = reduceCodexCapacityRetry(entry.state, { type: 'reset', scopeKey: entry.scopeKey, at }).state;
    saveState(owner.tabId, entry.state);
  }
  return { capacity, progress, cancel, reset, snapshot: tabId => entries.get(tabId)?.state || null };
}

module.exports = { classifyCodexCapacityRetryRecord, createCodexCapacityRetryRuntime };
