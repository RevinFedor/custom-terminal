'use strict';

// A live adapter only: callers own source verification and lifecycle events.
function createMiniOrchestratorCapture({ core, isEnabled, isOwnerCurrent, isReady, log = () => {} }) {
  const tabs = new Map();
  const limit = 250000;
  let disposed = false;
  const key = o => o && ['codex', 'claude'].includes(o.provider) && typeof o.sessionId === 'string' && o.sessionId && typeof o.generation === 'string' && o.generation ? JSON.stringify([o.provider, o.sessionId, o.generation]) : null;
  const valid = s => { try { return isOwnerCurrent({ tabId: s.tabId, owner: s.owner, turnId: s.turnId }) === true; } catch { return false; } };
  const enabled = tabId => { try { return !disposed && isEnabled(tabId) === true; } catch { return false; } };
  function get(tabId, owner, turnId) {
    const k = key(owner);
    if (!enabled(tabId)) { tabs.delete(tabId); return null; }
    if (!k || typeof tabId !== 'string' || !tabId || !valid({ tabId, owner, turnId })) return null;
    let s = tabs.get(tabId);
    if (s && s.key !== k) { tabs.delete(tabId); core.invalidate(tabId, 'owner_changed'); s = null; }
    if (!s) { s = { tabId, owner: { ...owner }, key: k, turnId: null, final: null, pending: null, completed: null }; tabs.set(tabId, s); }
    return s;
  }
  function flush(tabId) {
    const s = tabs.get(tabId);
    if (!s) return;
    if (!enabled(tabId)) { tabs.delete(tabId); return; }
    if (!valid(s)) { tabs.delete(tabId); core.invalidate(tabId, 'owner_changed'); return; }
    if (!s.pending) return;
    let ready = false; try { ready = isReady({ tabId, owner: s.owner, turnId: s.turnId }) === true; } catch {}
    if (!ready) return;
    const p = s.pending; s.pending = null; s.completed = s.turnId;
    try { Promise.resolve(core.complete(p)).catch(() => log('mini-orchestrator capture completion failed', { tabId })); }
    catch { log('mini-orchestrator capture completion failed', { tabId }); }
  }
  function input(s, inputId, text, turnId, correctionHandoffId, inputAliases) {
    if (typeof inputId !== 'string' || !inputId || typeof text !== 'string') return;
    if (s.pending || s.completed) { s.pending = null; core.invalidate(s.tabId, 'new_input'); s.final = null; s.turnId = null; s.completed = null; }
    core.observeInput({ tabId: s.tabId, owner: s.owner, inputId, text, turnId, correctionHandoffId, inputAliases });
  }
  function begin(s, turnId) {
    if (typeof turnId !== 'string' || !turnId) return;
    if (s.turnId !== turnId) { s.turnId = turnId; s.final = null; s.pending = null; s.completed = null; }
    core.beginTurn({ tabId: s.tabId, owner: s.owner, turnId });
  }
  function finish(s, turnId, answerId, answer, complete) {
    if (!turnId || s.turnId !== turnId || s.completed === turnId || s.pending) return;
    s.pending = { tabId: s.tabId, owner: s.owner, turnId, answerId, answer, complete, sourceVerified: true };
    flush(s.tabId);
  }
  function observeCodex({ tabId, owner, record, sourceVerified, recordId, inputId, inputText, inputAliases, turnId, completionProven, correctionHandoffId }) {
    if (sourceVerified !== true || !record || typeof record !== 'object') return;
    const s = get(tabId, owner, turnId); if (!s || owner.provider !== 'codex') return;
    const p = record.payload || {};
    if (record.type === 'event_msg' && p.type === 'task_started') { begin(s, turnId); return; }
    if (record.type === 'event_msg' && p.type === 'user_message') { input(s, inputId, inputText, turnId, correctionHandoffId, inputAliases); return; }
    if (s.turnId !== turnId || !turnId) return;
    let answer;
    if (record.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.phase === 'final_answer' && Array.isArray(p.content)) {
      answer = p.content.filter(x => x && x.type === 'output_text' && typeof x.text === 'string').map(x => x.text).join('');
      if (answer) {
        const id = typeof recordId === 'string' && recordId ? recordId : typeof p.id === 'string' && p.id ? p.id : null;
        if (!s.final || !s.final.canonical) s.final = { canonical: true, ids: new Set(), answer: '', answerId: id, complete: true };
        const f = s.final;
        if (!id || f.ids.size >= 4096) f.complete = false;
        else if (!f.ids.has(id)) {
          f.ids.add(id); f.answerId = id;
          if (f.answer.length + answer.length > limit) f.complete = false;
          f.answer = (f.answer + answer).slice(0, limit + 1);
        }
      }
    } else if (record.type === 'event_msg' && p.type === 'agent_message' && p.phase === 'final_answer' && typeof p.message === 'string' && p.message && !s.final) {
      s.final = { answer: p.message.slice(0, limit + 1), answerId: recordId, complete: p.message.length <= limit };
    }
    if (record.type === 'event_msg' && p.type === 'task_complete' && completionProven === true) {
      if (!s.final && typeof p.last_agent_message === 'string' && p.last_agent_message) s.final = { answer: p.last_agent_message.slice(0, limit + 1), answerId: recordId, complete: p.last_agent_message.length <= limit };
      if (s.final) finish(s, turnId, s.final.answerId, s.final.answer, s.final.complete);
    }
  }
  function observeClaudeInput({ tabId, owner, turnId, inputId, text, sourceVerified, correctionHandoffId }) {
    if (sourceVerified !== true) return;
    const s = get(tabId, owner, turnId); if (!s || owner.provider !== 'claude') return;
    input(s, inputId, text, turnId, correctionHandoffId); begin(s, turnId);
  }
  function observeClaudeCompletion({ tabId, owner, turnId, answerId, answer, sourceVerified, complete, truncated }) {
    if (sourceVerified !== true) return;
    const s = get(tabId, owner, turnId); if (!s || owner.provider !== 'claude') return;
    finish(s, turnId, answerId, typeof answer === 'string' ? answer.slice(0, limit + 1) : answer, complete === true && truncated === false && typeof answer === 'string' && answer.length <= limit);
  }
  function invalidate(tabId, reason) { tabs.delete(tabId); if (!disposed) core.invalidate(tabId, reason); }
  function dispose() { disposed = true; tabs.clear(); }
  return { observeCodex, observeClaudeInput, observeClaudeCompletion, flush, invalidate, dispose };
}
module.exports = { createMiniOrchestratorCapture };
