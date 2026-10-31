'use strict';

const { createHash } = require('node:crypto');
const { createMiniOrchestrator } = require('./mini-orchestrator');
const { createMiniOrchestratorCapture } = require('./mini-orchestrator-capture');
const { createMiniOrchestratorGemini } = require('./mini-orchestrator-gemini');
const { createMiniOrchestratorMcpSender } = require('./mini-orchestrator-mcp');
const { resolveContextFileRefs } = require('./agent-context-files');
const PROMPT_ID = 'mini-orchestrator-review';
const PREFIX = 'mini-orchestrator:';

// Also used by the offline evidence preparer. It never calls a provider and
// assembles the SAME live-file instruction as the runtime, without secrets.
async function resolveMiniOrchestratorInstruction({ prompt, settings, includeFileMetadata = false }) {
  if (!prompt || !/^gemini-/.test(settings?.model)) throw new Error('mini_reviewer_gemini_prompt_required');
  const files = await resolveContextFileRefs({ refs: prompt.filePaths.map(path => ({ path, role: 'instructions' })),
    maxFileBytes: 256 * 1024, maxTotalBytes: 256 * 1024 });
  const text = [prompt.content, ...files.map(file => file.text)].filter(Boolean).join('\n\n');
  const hash = createHash('sha256').update(text).digest('hex');
  return { id: prompt.id, name: prompt.name, model: settings.model, thinkingLevel: settings.thinkingLevel,
    revision: prompt.revision + ':' + hash.slice(0, 12), filePaths: files.map(file => file.filePath), text,
    ...(includeFileMetadata ? { linkedFiles: files.map(file => ({ path: file.filePath, bytes: file.bytes, sha256: file.sha256 })) } : {}) };
}

function createMiniOrchestratorRuntime({ db, systemPromptService, readOwner, endpointFor, publish,
  review = createMiniOrchestratorGemini(), sendCorrection, loadPresentation, clearPresentation, log = () => {} }) {
  const enabled = new Set(), pendingInputs = new Map();
  const settingsByTab = new Map();
  const viewRevisions = new Map();
  const thinkingLevels = ['LOW', 'MEDIUM', 'HIGH'];
  function savedSettings(tabId) {
    if (!settingsByTab.has(tabId)) {
      const raw = db.getAppState('mini-orchestrator-settings:' + tabId);
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      settingsByTab.set(tabId, value && typeof value === 'object' ? value : { revision: 0 });
    }
    return settingsByTab.get(tabId);
  }
  function settingsFor(tabId) {
    const prompt = systemPromptService.get(PROMPT_ID);
    if (!prompt) throw new Error('mini_reviewer_prompt_required');
    const saved = savedSettings(tabId);
    return { model: saved.model || prompt.model, thinkingLevel: saved.thinkingLevel || prompt.thinkingLevel || 'HIGH',
      revision: String(prompt.revision) + ':' + Number(saved.revision || 0), thinkingLevels: [...thinkingLevels],
      ...(saved.saveError ? { error: saved.saveError } : {}) };
  }
  function withSettings(tabId, snapshot) {
    const viewRevision = (viewRevisions.get(tabId) || 0) + 1; viewRevisions.set(tabId, viewRevision);
    try { return { ...snapshot, viewRevision, settings: settingsFor(tabId) }; }
    catch (error) { return { ...snapshot, viewRevision, settings: { error: String(error.message || error).slice(0, 160) } }; }
  }
  const sameOwner = ({ tabId, owner, turnId }) => {
    const current = readOwner(tabId);
    return !!current && current.owner?.provider === owner?.provider
      && current.owner.sessionId === owner.sessionId && current.owner.generation === owner.generation
      && (!turnId || current.turnId === turnId);
  };
  const ready = args => sameOwner(args) && readOwner(args.tabId)?.ready === true
    && !(pendingInputs.get(args.tabId)?.size > 0);
  const mcpSend = sendCorrection || createMiniOrchestratorMcpSender({ endpointFor });
  const core = createMiniOrchestrator({ review, sendCorrection: mcpSend,
    isCurrent: sameOwner, loadPresentation,
    loadLedger: tabId => {
      const raw = db.getAppState('mini-orchestrator-ledger:' + tabId);
      return raw ? JSON.parse(raw) : [];
    },
    persist: (tabId, ledger) => db.setAppState('mini-orchestrator-ledger:' + tabId, JSON.stringify(ledger)),
    loadInstruction: async ({ tabId }) => {
      const prompt = systemPromptService.get(PROMPT_ID);
      const settings = settingsFor(tabId);
      if (settings.error) throw new Error(settings.error);
      return resolveMiniOrchestratorInstruction({ prompt, settings });
    }, publish: (tabId, snapshot) => publish?.(tabId, withSettings(tabId, snapshot)),
    log: (action, fields) => log(action, fields),
  });
  const capture = createMiniOrchestratorCapture({ core, isEnabled: tabId => enabled.has(tabId),
    isOwnerCurrent: sameOwner, isReady: ready, log: action => log(action) });
  function onInputAccepted(request) {
    if (!enabled.has(request.tabId) || String(request.handoffId || '').startsWith(PREFIX)) return;
    const pending = pendingInputs.get(request.tabId) || new Set();
    pending.add(request.handoffId || request.operationKey); pendingInputs.set(request.tabId, pending);
    core.invalidateReview(request.tabId, 'new_input_admitted');
  }
  function acknowledgeInput(tabId, handoffId) {
    if (handoffId) pendingInputs.get(tabId)?.delete(handoffId);
  }
  function onReceipt(record) {
    if (!record?.tabId || !record.handoffId) return;
    if (record.handoffId.startsWith(PREFIX)) {
      const r = record.receipt || {};
      const status = record.state === 'confirmed' ? 'sent'
        : r.deliveryUnknown === true || record.state === 'delivery-unknown' || record.state === 'audit-pending' ? 'unknown'
          : ['reserved', 'preparing'].includes(record.state) ? 'queued'
            : ['not-submitted', 'provider-not-accepted'].includes(record.state) ? 'refused' : null;
      if (status) core.observeSendReceipt({ tabId: record.tabId, handoffId: record.handoffId,
        receipt: { status, handoffId: record.handoffId, operationKey: record.operationKey,
          attemptId: record.attemptId || null, ...(r.code ? { error: String(r.code).slice(0, 160) } : {}) } });
    } else if (['not-submitted', 'provider-not-accepted'].includes(record.state)
      && !record.receipt?.pasteWritten && !record.receipt?.enterWritten && !record.receipt?.deliveryUnknown) {
      pendingInputs.get(record.tabId)?.delete(record.handoffId); capture.flush(record.tabId);
    }
  }
  function guard({ tabId, handoffId, preflightScope } = {}) {
    const id = handoffId || preflightScope?.handoffId;
    if (!String(id || '').startsWith(PREFIX)) return null;
    if (core.validateSend({ tabId, handoffId: id })) return null;
    return { success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
      status: 'not-submitted', code: 'mini_orchestrator_review_stale', error: 'Мини-проверка отключена, устарела или её владелец сменился.' };
  }
  return { core, capture, isEnabled: tabId => enabled.has(tabId), guard, onInputAccepted, onReceipt, acknowledgeInput,
    get: tabId => withSettings(tabId, core.snapshot(tabId)),
    setSettings(tabId, { model, thinkingLevel, expectedRevision } = {}) {
      if (['reviewing', 'sending'].includes(core.snapshot(tabId).phase)) throw new Error('mini_settings_busy');
      const current = settingsFor(tabId);
      if (current.revision !== expectedRevision) throw new Error('mini_settings_changed');
      if (typeof model !== 'string' || !/^gemini-[a-zA-Z0-9._-]{1,140}$/.test(model)
        || !thinkingLevels.includes(thinkingLevel)) throw new Error('mini_settings_invalid');
      const next = { model, thinkingLevel, revision: Number(savedSettings(tabId).revision || 0) + 1 };
      settingsByTab.set(tabId, next);
      try { db.setAppState('mini-orchestrator-settings:' + tabId, next); }
      catch (error) { next.saveError = 'mini_settings_unconfirmed'; core.refreshPresentation(tabId); throw new Error(next.saveError); }
      core.refreshPresentation(tabId);
      try { log('settings', { tabId, model, thinkingLevel, settingsRevision: String(next.revision) }); } catch {}
      return withSettings(tabId, core.snapshot(tabId));
    },
    setEnabled(tabId, value) {
      if (value) enabled.add(tabId); else { enabled.delete(tabId); pendingInputs.delete(tabId); capture.invalidate(tabId, 'disabled'); }
      return core.setEnabled(tabId, value);
    },
    clear: tabId => {
      if (['reviewing', 'sending'].includes(core.snapshot(tabId).phase)) return false;
      clearPresentation?.(tabId);
      return core.clear(tabId);
    },
    rawInput: tabId => { if (enabled.has(tabId)) core.invalidateReview(tabId, 'manual_input'); },
    dispose() { enabled.clear(); pendingInputs.clear(); settingsByTab.clear(); viewRevisions.clear(); capture.dispose(); core.dispose(); },
  };
}

module.exports = { createMiniOrchestratorRuntime, resolveMiniOrchestratorInstruction, MINI_REVIEW_PROMPT_ID: PROMPT_ID };
