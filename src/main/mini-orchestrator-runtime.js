'use strict';

const { createHash } = require('node:crypto');
const { createMiniOrchestrator } = require('./mini-orchestrator');
const { createMiniOrchestratorCapture } = require('./mini-orchestrator-capture');
const { createMiniOrchestratorGemini } = require('./mini-orchestrator-gemini');
const { createMiniOrchestratorForward } = require('./mini-orchestrator-forward');
const { createMiniOrchestratorMcpSender } = require('./mini-orchestrator-mcp');
const { resolveContextFileRefs } = require('./agent-context-files');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const PROMPT_ID = 'mini-orchestrator-review';
const PREFIX = 'mini-orchestrator:';
// Forward mode keeps the robot a pure condition: the chosen reviewer tab and
// the user's instruction live in one app-state row per source tab. The default
// instruction text is the shared prompt file; it is never rewritten from here.
const FORWARD_INSTRUCTION_FILE = path.join(os.homedir(),
  'Global-Templates/\u{1F9E9} Code-Patterns/документация/вкладка-проверяющий-ответов.prompt.md');
const FORWARD_INSTRUCTION_LIMIT = 60000;
const FORWARD_FALLBACK_INSTRUCTION = [
  'Ты — проверяющий завершённого ответа соседней вкладки.',
  'Найди существенный незакрытый запрос пользователя.',
  'Если всё выполнено — ничего не отправляй.',
  'Если есть конкретный пробел — отправь ОДНО замечание через send_prompt в указанную вкладку.',
].join('\n');
const AUTOMATIC_OUTPUT_FORMAT = [
  'Private prototype review output mode: application-owned automatic return.',
  'You remain read-only. read_review_iteration only reads the one captured iteration. finish_review is a declarative output record, NOT an MCP tool or an executor: it cannot send, edit, select a recipient, or operate a tab.',
  'In this private prototype the application may separately forward at most one correction to the same pinned reviewed session through its existing guarded queue. You only return data; earlier read-only instructions still grant no execution tools or direct sending authority.',
  'Read the captured iteration exactly once. On the second and final response return exactly one finish_review call with exactly these keys: verdict, explanation, correction. No recipient, session, tab, filename, or extra arguments.',
  'verdict must be ok, needs_correction, or unknown. explanation must be a nonempty string of at most 250000 UTF-16 code units. Only needs_correction may have a nonempty correction, at most 16000 UTF-16 code units; for ok and unknown correction must be exactly the empty string.',
  'Use needs_correction only for a material evidence-backed unmet part of the original request within its existing scope. A correction is a concise request to repair that gap, not a new task or a prescribed answer. Use unknown if the captured evidence is insufficient. Do not invent a defect to produce a correction.',
  'This explicit mode replaces only earlier text-only output formatting. It does not expand your read access or grant any additional tools.',
].join('\n');

// Also used by the offline evidence preparer. It never calls a provider and
// assembles the SAME live-file instruction as the runtime, without secrets.
async function resolveMiniOrchestratorInstruction({ prompt, settings, includeFileMetadata = false, automaticCorrections = false }) {
  if (!prompt || !/^gemini-/.test(settings?.model)) throw new Error('mini_reviewer_gemini_prompt_required');
  const files = await resolveContextFileRefs({ refs: prompt.filePaths.map(path => ({ path, role: 'instructions' })),
    maxFileBytes: 256 * 1024, maxTotalBytes: 256 * 1024 });
  const automatic = automaticCorrections === true;
  const text = [prompt.content, ...files.map(file => file.text), ...(automatic ? [AUTOMATIC_OUTPUT_FORMAT] : [])].filter(Boolean).join('\n\n');
  const hash = createHash('sha256').update(text).digest('hex');
  return { id: prompt.id, name: prompt.name, model: settings.model, thinkingLevel: settings.thinkingLevel,
    revision: prompt.revision + ':' + hash.slice(0, 12), filePaths: files.map(file => file.filePath), text,
    ...(automatic ? { automaticCorrections: true } : {}),
    ...(includeFileMetadata ? { linkedFiles: files.map(file => ({ path: file.filePath, bytes: file.bytes, sha256: file.sha256 })) } : {}) };
}

// One app-state row per source tab: which neighbour reviews it and the user's
// own instruction override. Absent row means forward mode is simply unset.
function normalizeForwardTarget(value) {
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!raw || typeof raw !== 'object' || typeof raw.reviewerTabId !== 'string' || !raw.reviewerTabId) return null;
  return { reviewerTabId: raw.reviewerTabId,
    ...(typeof raw.instruction === 'string' && raw.instruction.trim()
      ? { instruction: raw.instruction.slice(0, FORWARD_INSTRUCTION_LIMIT) } : {}),
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0 };
}

async function readForwardInstructionFile() {
  const bytes = await fs.readFile(FORWARD_INSTRUCTION_FILE, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (typeof bytes !== 'string' || !bytes.trim()) return null;
  return bytes.slice(0, FORWARD_INSTRUCTION_LIMIT);
}

function createMiniOrchestratorRuntime({ db, systemPromptService, readOwner, endpointFor, publish,
  automaticCorrections = false, review, sendCorrection, loadPresentation, clearPresentation,
  describeTab = () => ({}), isAiTab = () => true, log = () => {} }) {
  const automatic = automaticCorrections === true;
  const forwardReview = createMiniOrchestratorForward({
    describeSource: ({ tabId, owner }) => {
      const source = describeTab(tabId) || {};
      const target = forwardTarget(tabId);
      const reviewer = target ? describeTab(target.reviewerTabId) || {} : {};
      return { name: source.name, reviewerName: reviewer.name, provider: owner?.provider };
    } });
  const runReview = review === undefined
    ? async args => (args.instruction?.mode === 'forward' ? forwardReview : createMiniOrchestratorGemini({ automaticCorrections: automatic }))(args)
    : review;
  const enabled = new Set(), pendingInputs = new Map();
  const settingsByTab = new Map();
  const forwardByTab = new Map();
  const viewRevisions = new Map();
  function forwardTarget(tabId) {
    if (!forwardByTab.has(tabId)) {
      let value = null;
      try { value = normalizeForwardTarget(db.getAppState('mini-orchestrator-forward:' + tabId)); } catch { value = null; }
      forwardByTab.set(tabId, value);
    }
    return forwardByTab.get(tabId);
  }
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
  function forwardPresentation(tabId) {
    const target = forwardTarget(tabId);
    if (!target) return {};
    const reviewer = describeTab(target.reviewerTabId) || {};
    return { forward: { reviewerTabId: target.reviewerTabId,
      reviewerName: typeof reviewer.name === 'string' ? reviewer.name.slice(0, 120) : '',
      reviewerAvailable: isAiTab(target.reviewerTabId) === true,
      instructionCustom: typeof target.instruction === 'string',
      revision: 'forward:' + Number(target.revision || 0) + ':' + target.reviewerTabId } };
  }
  function withSettings(tabId, snapshot) {
    const viewRevision = (viewRevisions.get(tabId) || 0) + 1; viewRevisions.set(tabId, viewRevision);
    const forward = forwardPresentation(tabId);
    // Forward mode needs no Gemini model/effort: do not surface a provider
    // picker whose value cannot apply to a real reviewer tab.
    if (forward.forward) return { ...snapshot, viewRevision, ...forward, ...(automatic ? { autoReturn: true } : {}) };
    try { return { ...snapshot, viewRevision, settings: settingsFor(tabId), ...(automatic ? { autoReturn: true } : {}) }; }
    catch (error) { return { ...snapshot, viewRevision, settings: { error: String(error.message || error).slice(0, 160) }, ...(automatic ? { autoReturn: true } : {}) }; }
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
  const core = createMiniOrchestrator({ review: runReview, sendCorrection: mcpSend, automaticCorrections: automatic,
    isCurrent: sameOwner, loadPresentation,
    loadLedger: tabId => {
      const raw = db.getAppState('mini-orchestrator-ledger:' + tabId);
      return raw ? JSON.parse(raw) : [];
    },
    persist: (tabId, ledger) => db.setAppState('mini-orchestrator-ledger:' + tabId, JSON.stringify(ledger)),
    loadInstruction: async ({ tabId }) => {
      // Forward mode needs no provider model/key: the reviewer is a real tab.
      const target = forwardTarget(tabId);
      if (target) {
        if (target.reviewerTabId === tabId) throw new Error('mini_forward_self_target');
        if (isAiTab(target.reviewerTabId) !== true) throw new Error('mini_forward_reviewer_unavailable');
        const text = target.instruction || await readForwardInstructionFile() || FORWARD_FALLBACK_INSTRUCTION;
        const reviewer = describeTab(target.reviewerTabId) || {};
        return { id: PROMPT_ID + ':forward', name: 'Проверяющая вкладка' + (reviewer.name ? ' · ' + reviewer.name : ''),
          mode: 'forward', text, reviewerTabId: target.reviewerTabId, sourceTabId: tabId,
          revision: 'forward:' + Number(target.revision || 0) + ':' + target.reviewerTabId,
          filePaths: target.instruction ? [] : [FORWARD_INSTRUCTION_FILE] };
      }
      const prompt = systemPromptService.get(PROMPT_ID);
      const settings = settingsFor(tabId);
      if (settings.error) throw new Error(settings.error);
      return resolveMiniOrchestratorInstruction({ prompt, settings, automaticCorrections: automatic });
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
    // Choosing the reviewer tab (or clearing it) is the whole robot condition.
    setForwardTarget(tabId, { reviewerTabId, instruction, expectedRevision } = {}) {
      if (['reviewing', 'sending'].includes(core.snapshot(tabId).phase)) throw new Error('mini_forward_busy');
      const current = forwardTarget(tabId);
      const currentRevision = current ? 'forward:' + Number(current.revision || 0) + ':' + current.reviewerTabId : 'forward:none';
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new Error('mini_forward_changed');
      if (reviewerTabId === null) {
        forwardByTab.set(tabId, null);
        try { db.setAppState('mini-orchestrator-forward:' + tabId, null); }
        catch { forwardByTab.delete(tabId); throw new Error('mini_forward_unconfirmed'); }
        core.refreshPresentation(tabId);
        try { log('forward-cleared', { tabId }); } catch {}
        return withSettings(tabId, core.snapshot(tabId));
      }
      if (typeof reviewerTabId !== 'string' || !reviewerTabId) throw new Error('mini_forward_invalid');
      if (reviewerTabId === tabId) throw new Error('mini_forward_self_target');
      if (isAiTab(reviewerTabId) !== true) throw new Error('mini_forward_reviewer_unavailable');
      if (instruction !== undefined && instruction !== null
        && (typeof instruction !== 'string' || instruction.length > FORWARD_INSTRUCTION_LIMIT)) throw new Error('mini_forward_instruction_invalid');
      const next = { reviewerTabId, revision: Number(current?.revision || 0) + 1,
        ...(typeof instruction === 'string' && instruction.trim() ? { instruction } : {}) };
      forwardByTab.set(tabId, next);
      try { db.setAppState('mini-orchestrator-forward:' + tabId, next); }
      catch { forwardByTab.delete(tabId); throw new Error('mini_forward_unconfirmed'); }
      core.refreshPresentation(tabId);
      try { log('forward-target', { tabId, reason: reviewerTabId }); } catch {}
      return withSettings(tabId, core.snapshot(tabId));
    },
    forwardInstructionText: async tabId => {
      const target = forwardTarget(tabId);
      if (!target) return null;
      return { text: target.instruction || await readForwardInstructionFile() || FORWARD_FALLBACK_INSTRUCTION,
        custom: typeof target.instruction === 'string', defaultFile: FORWARD_INSTRUCTION_FILE };
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
    dispose() { enabled.clear(); pendingInputs.clear(); settingsByTab.clear(); forwardByTab.clear(); viewRevisions.clear(); capture.dispose(); core.dispose(); },
  };
}

module.exports = { createMiniOrchestratorRuntime, resolveMiniOrchestratorInstruction, MINI_REVIEW_PROMPT_ID: PROMPT_ID };
