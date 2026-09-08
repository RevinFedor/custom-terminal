'use strict';

const {
  MAX_PREVIEW_CHARS,
  createTerminalHistoryStructuredProof,
  deriveTerminalHistoryPreviewTextAfterBaseline,
  extractTerminalHistoryPreviewText,
  mergeTerminalHistoryPreviewText,
  normalizeTerminalHistoryPromptText,
  previewTextHash,
  subtractTerminalHistoryMaterializedText,
  subtractTerminalHistoryStructuredProjection,
} = require('./terminal-history-preview');

const DEFAULT_EMIT_COALESCE_MS = 64;
const PROMPT_AUTHORITY_PROVISIONAL_TAIL = 'provisional-tail';
const PROMPT_AUTHORITY_EXACT_TRANSCRIPT = 'exact-transcript';

const short = (value, size = 12) => {
  const text = String(value || '');
  return text ? text.slice(-size) : '-';
};

const oneLine = (value, size = 96) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, size);

const finiteNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function createTerminalHistoryPreviewController({
  getContext,
  readFrame,
  emit,
  log = console,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  emitCoalesceMs = DEFAULT_EMIT_COALESCE_MS,
  isEnabled = () => true,
} = {}) {
  if (typeof getContext !== 'function') throw new TypeError('getContext is required');
  if (typeof readFrame !== 'function') throw new TypeError('readFrame is required');
  if (typeof emit !== 'function') throw new TypeError('emit is required');

  const turns = new Map();
  const semanticAuthorities = new Map();

  const writeLog = (level, event, state, detail = {}) => {
    const fn = level === 'error'
      ? log?.error
      : level === 'warn'
        ? log?.warn
        : log?.log;
    if (typeof fn !== 'function') return;
    const fields = {
      tab: short(state?.tabId),
      provider: state?.provider || '-',
      session: short(state?.sessionId, 8),
      turn: short(state?.turnId, 18),
      lifecycle: short(state?.lifecycleGeneration, 18),
      mirror: short(state?.mirrorGeneration, 8),
      phase: state?.phase || '-',
      ...detail,
    };
    fn.call(log, '[TerminalHistoryPreview] ' + event + ' '
      + Object.entries(fields)
        .map(([key, value]) => key + '=' + String(value ?? '-'))
        .join(' '));
  };

  const publicPreview = (state) => ({
    previewId: state.previewId,
    tabId: state.tabId,
    toolType: state.provider,
    sessionId: state.sessionId,
    turnId: state.turnId,
    lifecycleGeneration: state.lifecycleGeneration,
    mirrorGeneration: state.mirrorGeneration,
    mirrorGenerationOrdinal: state.mirrorGenerationOrdinal,
    committedFrameGeneration: state.committedFrameGeneration,
    writeSeq: state.writeSeq,
    previewSeq: state.previewSeq,
    phase: state.phase,
    sourceMode: state.sourceMode || 'screen',
    text: state.text,
    textHash: state.text ? previewTextHash(state.text) : null,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    reason: state.lastMergeReason || state.lastFrameReason || null,
    boundaryKind: state.boundaryKind || null,
    boundaryRow: state.boundaryRow,
    truncated: state.truncated === true,
    promptAuthority: state.promptAuthority || null,
  });

  const emitAction = (state, action, reason, detail = {}) => {
    emit({
      action,
      tabId: state.tabId,
      toolType: state.provider,
      previewId: state.previewId,
      reason,
      preview: action === 'clear' ? null : publicPreview(state),
      ...detail,
    });
  };

  const cancelPendingEmission = (state) => {
    if (!state?.emitTimer) return;
    clearTimer(state.emitTimer);
    state.emitTimer = null;
  };

  const publishFrame = (state, action = 'update') => {
    cancelPendingEmission(state);
    if (!state.text) return;
    state.previewSeq += 1;
    state.updatedAt = now();
    const coalesced = Math.max(1, state.coalescedFrames || 1);
    state.coalescedFrames = 0;
    emitAction(state, action, state.lastMergeReason || state.lastFrameReason || 'frame');
    writeLog('log', action === 'settle' ? 'SETTLE' : 'FRAME', state, {
      frame: state.committedFrameGeneration ?? '-',
      writeSeq: state.writeSeq ?? '-',
      previewSeq: state.previewSeq,
      chars: state.text.length,
      hash: previewTextHash(state.text),
      rows: state.lastPhysicalRows ?? '-',
      coalesced,
      reason: state.lastMergeReason || state.lastFrameReason || '-',
      truncated: state.truncated === true,
      systemBlocks: state.lastFilteredBlockKinds?.join(',') || '-',
      promptRowsRemoved: state.lastResidualPromptLinesRemoved || 0,
      styleEvidence: state.lastStyleEvidenceUsed === true,
      answerMarkerRemoved: state.lastAnswerMarkerRemoved === true,
      head: JSON.stringify(oneLine(state.text)),
      tail: JSON.stringify(oneLine(state.text.slice(-160))),
    });
  };

  const scheduleFramePublication = (state) => {
    state.coalescedFrames = Number(state.coalescedFrames || 0) + 1;
    if (state.emitTimer) return;
    state.emitTimer = setTimer(() => {
      state.emitTimer = null;
      if (turns.get(state.tabId) !== state) return;
      publishFrame(state, state.phase === 'settled' ? 'settle' : 'update');
    }, Math.max(0, Number(emitCoalesceMs) || 0));
  };

  const applyStructuredProjectionProof = (state, text, detail = {}) => {
    const result = subtractTerminalHistoryStructuredProjection(
      state.structuredProof,
      text,
    );
    if (result.reason === 'structured-proof-unavailable'
      || result.reason === 'candidate-not-structured-projection') return result;
    writeLog('log', 'STRUCTURED_SUPPRESS', state, {
      reason: result.reason,
      kind: detail.kind || '-',
      identity: short(detail.identity, 20),
      candidateChars: String(text || '').length,
      candidateHash: text ? previewTextHash(text) : '-',
      remainingChars: result.text.length,
      remainingHash: result.text ? previewTextHash(result.text) : '-',
      proofFragments: state.structuredProof?.fragments?.length || 0,
      proofChars: state.structuredProof?.chars || 0,
      frame: state.committedFrameGeneration ?? '-',
      writeSeq: state.writeSeq ?? '-',
    });
    return result;
  };

  const applyCanonicalMaterializationProof = (state, text, detail = {}) => {
    const result = subtractTerminalHistoryMaterializedText(
      state.rebaseCanonicalText,
      text,
    );
    if (result.reason === 'candidate-after-materialized-record'
      || result.reason === 'materialized-text-unavailable') return result;
    writeLog('log', 'CANONICAL_SUPPRESS', state, {
      reason: result.reason,
      proofAt: detail.proofAt || 'committed-frame',
      projection: result.projection || 'exact-jsonl',
      canonicalChars: state.rebaseCanonicalText.length,
      canonicalHash: previewTextHash(state.rebaseCanonicalText),
      candidateChars: String(text || '').length,
      candidateHash: text ? previewTextHash(text) : '-',
      remainingChars: result.text.length,
      remainingHash: result.text ? previewTextHash(result.text) : '-',
      frame: state.committedFrameGeneration ?? '-',
      writeSeq: state.writeSeq ?? '-',
    });
    return result;
  };

  const disposeMarker = (state) => {
    try { state?.marker?.dispose?.(); } catch {}
    state.marker = null;
  };

  const exactContext = (state) => {
    const context = getContext(state.tabId);
    if (!context) return { ok: false, reason: 'context-missing' };
    if (context.terminal !== state.terminal) return { ok: false, reason: 'terminal-replaced' };
    if (context.mirror !== state.mirror) return { ok: false, reason: 'mirror-replaced' };
    if (context.lifecycleGeneration !== state.lifecycleGeneration) {
      return { ok: false, reason: 'lifecycle-replaced' };
    }
    if (context.mirror?.generation !== state.mirrorGeneration) {
      return { ok: false, reason: 'mirror-generation-replaced' };
    }
    return { ok: true, context };
  };

  const captureExactFrameBaseline = (state, kind, identity = null) => {
    const snapshot = state?.lastCommittedSnapshot;
    const usable = snapshot?.authoritativeFrameCommitted === true
      && snapshot.mirrorGeneration === state?.mirrorGeneration;
    state.rebaseBaselineSnapshot = usable ? snapshot : null;
    state.rebaseBaselineKind = usable ? kind : null;
    state.baselineAdvanceCount = 0;
    state.baselineAdvanceLogged = false;
    writeLog(usable ? 'log' : 'warn', usable ? 'BASELINE_CAPTURE' : 'BASELINE_UNAVAILABLE', state, {
      kind,
      identity: short(identity, 20),
      frame: usable ? snapshot.committedFrameGeneration ?? '-' : '-',
      writeSeq: usable ? snapshot.writeSeq ?? '-' : '-',
      rows: usable && Array.isArray(snapshot.lines) ? snapshot.lines.length : 0,
      reason: usable ? 'exact-jsonl-boundary' : 'no-authoritative-frame-before-boundary',
    });
    return usable;
  };

  const clear = (tabId, reason = 'clear', expected = null) => {
    const state = turns.get(tabId);
    if (!state || (expected && expected !== state)) return false;
    turns.delete(tabId);
    cancelPendingEmission(state);
    disposeMarker(state);
    if (state.text) emitAction(state, 'clear', reason);
    writeLog('log', 'CLEAR', state, {
      reason,
      chars: state.text.length,
      hash: state.text ? previewTextHash(state.text) : '-',
    });
    return true;
  };

  const clearAll = (reason = 'clear-all') => {
    let cleared = 0;
    for (const [tabId, state] of Array.from(turns)) {
      if (clear(tabId, reason, state)) cleared += 1;
    }
    return cleared;
  };

  const activateSemanticSource = ({ tabId, instanceId, processId = null, provider = 'codex' } = {}) => {
    if (!tabId || !instanceId) return false;
    const previous = semanticAuthorities.get(tabId) || null;
    const sameInstance = previous?.instanceId === String(instanceId);
    const authority = {
      provider,
      instanceId: String(instanceId),
      processId: finiteNumberOrNull(processId),
      connected: true,
      expected: true,
      gap: sameInstance ? previous.gap === true : false,
    };
    semanticAuthorities.set(tabId, authority);
    const state = turns.get(tabId);
    if (state?.provider === provider
      && !(sameInstance
        && state.sourceMode === 'semantic'
        && state.semanticInstanceId === authority.instanceId)) {
      cancelPendingEmission(state);
      if (state.text) {
        emitAction(state, 'clear', 'semantic-authority-established');
      }
      state.text = '';
      state.sourceMode = 'semantic';
      state.semanticInstanceId = authority.instanceId;
      state.semanticGap = false;
      state.semanticItems = new Map();
      state.semanticItemOrder = [];
      state.semanticCanonicalReceipts = [];
      state.semanticReceiptKeys = new Set();
      state.lastSemanticCanonicalReceipt = null;
      state.lastMergeReason = 'semantic-authority-established';
      state.lastUnknownKey = null;
      state.coalescedFrames = 0;
    }
    writeLog('log', 'SEMANTIC_AUTHORITY', state || {
      tabId,
      provider,
      phase: 'idle',
    }, {
      instance: short(instanceId, 18),
      pid: authority.processId ?? '-',
      replaced: previous?.instanceId && previous.instanceId !== authority.instanceId,
      reconnected: sameInstance,
    });
    return true;
  };

  const expectSemanticSource = ({ tabId, provider = 'codex' } = {}) => {
    if (!tabId) return false;
    const previous = semanticAuthorities.get(tabId) || {};
    semanticAuthorities.set(tabId, {
      ...previous,
      provider,
      expected: true,
      connected: previous.connected === true,
    });
    return true;
  };

  const disconnectSemanticSource = ({ tabId, instanceId, reason = 'disconnect' } = {}) => {
    const authority = semanticAuthorities.get(tabId);
    if (!authority || (instanceId && authority.instanceId !== instanceId)) return false;
    authority.connected = false;
    const state = turns.get(tabId);
    if (state?.sourceMode === 'semantic' && state.semanticInstanceId === authority.instanceId) {
      state.semanticGap = true;
      writeLog('warn', 'SEMANTIC_FREEZE', state, {
        reason,
        instance: short(authority.instanceId, 18),
      });
    }
    return true;
  };

  const clearSemanticSource = (tabId, reason = 'clear') => {
    const authority = semanticAuthorities.get(tabId);
    if (!authority) return false;
    semanticAuthorities.delete(tabId);
    const state = turns.get(tabId);
    if (state?.sourceMode === 'semantic') {
      writeLog('log', 'SEMANTIC_RELEASE', state, {
        reason,
        instance: short(authority.instanceId, 18),
      });
    }
    return true;
  };

  const normalizedSemanticText = (value) => String(value || '').trim();

  const semanticText = (state) => state.semanticItemOrder
    .map((itemId) => state.semanticItems.get(itemId))
    .filter((item) => item?.materialized !== true)
    .map((item) => item?.text || '')
    .filter((text) => text.length > 0)
    .join('\n\n');

  const reconcileSemanticCanonicalReceipts = (state, { allowTextFallback = false } = {}) => {
    if (state?.sourceMode !== 'semantic'
      || !(state.semanticItems instanceof Map)
      || !Array.isArray(state.semanticItemOrder)
      || !Array.isArray(state.semanticCanonicalReceipts)
      || state.semanticCanonicalReceipts.length === 0) return 0;

    const pending = [];
    let matched = 0;
    for (const receipt of state.semanticCanonicalReceipts) {
      let item = receipt.itemId ? state.semanticItems.get(receipt.itemId) : null;
      let match = item ? 'item-id' : null;
      // Claude JSONL can persist one content block per row, sharing the API
      // message.id but not its SSE block index. Join only INSIDE that exact
      // message, using a completed block's full text and ordered unused blocks.
      // Equal prose in another response/turn is never a receipt.
      if (!item && state.provider === 'claude' && receipt.messageId && receipt.text) {
        item = state.semanticItemOrder.map(id => state.semanticItems.get(id)).find(candidate => (
          candidate?.messageId === receipt.messageId
          && candidate.completed === true && candidate.materialized !== true
          && normalizedSemanticText(candidate.text) === receipt.text
        )) || null;
        if (item) match = 'message-id-and-complete-block';
      }
      if (item?.materialized === true) {
        writeLog('log', 'SEMANTIC_CANONICAL_ACK', state, {
          match: 'already-materialized',
          item: short(item.itemId, 18),
          identity: short(receipt.identity, 20),
          pending: pending.length,
        });
        matched += 1;
        continue;
      }
      if (!item && state.provider !== 'claude' && allowTextFallback && receipt.text) {
        item = state.semanticItemOrder
          .map((itemId) => state.semanticItems.get(itemId))
          .find((candidate) => (
            candidate?.materialized !== true
            && candidate?.completed === true
            && normalizedSemanticText(candidate.text) === receipt.text
          )) || null;
        if (item) match = receipt.itemId ? 'exact-text-after-id-miss' : 'exact-text';
      }
      if (!item) {
        pending.push(receipt);
        continue;
      }
      item.materialized = true;
      item.canonicalIdentity = receipt.identity || null;
      state.lastSemanticCanonicalReceipt = receipt;
      matched += 1;
      writeLog('log', 'SEMANTIC_CANONICAL_ACK', state, {
        match,
        item: short(item.itemId, 18),
        identity: short(receipt.identity, 20),
        pending: Math.max(0, state.semanticCanonicalReceipts.length - matched),
      });
    }
    state.semanticCanonicalReceipts = pending;
    return matched;
  };

  const observeSemanticCanonicalReceipt = (state, {
    itemId = null,
    messageId = null,
    identity = null,
    text = '',
    receiptKey = null,
  } = {}) => {
    if (state?.sourceMode !== 'semantic') return 0;
    if (!Array.isArray(state.semanticCanonicalReceipts)) {
      state.semanticCanonicalReceipts = [];
    }
    if (state.provider === 'claude') {
      if (!messageId || !identity) return 0;
      state.semanticReceiptKeys ||= new Set();
      const key = receiptKey || identity;
      if (state.semanticReceiptKeys.has(key)) return 0;
      state.semanticReceiptKeys.add(key);
    }
    const receipt = {
      itemId: typeof itemId === 'string' && itemId ? itemId : null,
      messageId,
      identity: typeof identity === 'string' && identity ? identity : null,
      text: normalizedSemanticText(text),
    };
    state.semanticCanonicalReceipts.push(receipt);
    const matched = reconcileSemanticCanonicalReceipts(state, {
      allowTextFallback: true,
    });
    if (matched === 0) {
      writeLog('log', 'SEMANTIC_CANONICAL_PENDING', state, {
        item: short(receipt.itemId, 18),
        identity: short(receipt.identity, 20),
        canonicalChars: receipt.text.length,
        canonicalHash: receipt.text ? previewTextHash(receipt.text) : '-',
        pending: state.semanticCanonicalReceipts.length,
      });
    }
    return matched;
  };

  const setSemanticText = (state, reason) => {
    const fullText = semanticText(state);
    const nextText = fullText.length > MAX_PREVIEW_CHARS
      ? fullText.slice(fullText.length - MAX_PREVIEW_CHARS)
      : fullText;
    if (nextText === state.text) return false;
    cancelPendingEmission(state);
    const previousText = state.text;
    state.text = nextText;
    state.truncated = fullText.length > MAX_PREVIEW_CHARS;
    state.lastMergeReason = reason;
    state.lastFrameReason = reason;
    state.lastUnknownKey = null;
    if (!nextText) {
      if (previousText && state.previewSeq > 0) {
        const receipt = state.provider === 'claude' && reason !== 'semantic-request-failed'
          ? state.lastSemanticCanonicalReceipt : null;
        emitAction(state, 'clear', receipt ? 'canonical-materialized' : reason,
          receipt ? { canonicalIdentity: receipt.identity } : {});
      }
      return true;
    }
    state.canonicalMaterialized = false;
    scheduleFramePublication(state);
    return true;
  };

  const ensureSemanticTurn = ({ tabId, threadId = null, turnId = null, instanceId, provider = 'codex' } = {}) => {
    let state = turns.get(tabId);
    if (provider === 'claude' && (!state || state.provider !== provider
      || state.turnId !== turnId || state.phase !== 'streaming'
      || state.semanticInstanceId !== instanceId || !exactContext(state).ok)) return null;
    if (!state
      || state.provider !== provider
      || (turnId && state.turnId && state.turnId !== turnId)) {
      begin({
        tabId,
        provider,
        // Provider thread/session metadata is transport identity. A resumed or
        // paginated Codex run may write its canonical rows to a different
        // rollout owner, so never seed durable session ownership from it.
        sessionId: null,
        turnId,
        promptSource: 'codex-provider-stream',
      });
      state = turns.get(tabId);
    }
    if (!state) return null;
    state.sourceMode = 'semantic';
    state.semanticInstanceId = instanceId;
    state.providerThreadId = threadId || state.providerThreadId || null;
    if (!(state.semanticItems instanceof Map)) state.semanticItems = new Map();
    if (!Array.isArray(state.semanticItemOrder)) state.semanticItemOrder = [];
    return state;
  };

  const observeSemanticEvent = ({
    tabId,
    instanceId,
    gap = false,
    event,
  } = {}) => {
    const authority = semanticAuthorities.get(tabId);
    if (!authority || authority.instanceId !== instanceId || authority.connected !== true) {
      return false;
    }
    if (!event || typeof event !== 'object') return false;
    const provider = authority.provider || 'codex';
    if (provider === 'claude') {
      const state = turns.get(tabId);
      if (!state || state.provider !== provider || state.turnId !== event.turnId
        || state.phase !== 'streaming' || !exactContext(state).ok) return false;
    }
    if (gap) authority.gap = true;
    const type = String(event.type || '');
    if (type === 'disconnect') {
      return disconnectSemanticSource({ tabId, instanceId, reason: 'socket-disconnect' });
    }
    if (type === 'turn_started') {
      authority.turnId = event.turnId || null;
      authority.threadId = event.threadId || null;
      authority.gap = gap === true;
      return true;
    }
    if (type === 'request_failed') {
      const state = turns.get(tabId);
      if (!state || state.provider !== provider || state.sourceMode !== 'semantic') return false;
      if (event.turnId && state.turnId && String(event.turnId) !== String(state.turnId)) {
        return false;
      }
      const requestId = String(event.requestId || '');
      if (!requestId) return false;
      const before = state.semanticItemOrder.length;
      state.semanticItemOrder = state.semanticItemOrder.filter((itemId) => {
        const candidate = state.semanticItems.get(itemId);
        if (candidate?.requestId !== requestId || candidate?.materialized === true) return true;
        state.semanticItems.delete(itemId);
        return false;
      });
      state.semanticGap = false;
      authority.gap = false;
      const changed = setSemanticText(state, 'semantic-request-failed');
      writeLog('warn', 'SEMANTIC_REQUEST_FAILED', state, {
        request: short(requestId, 20),
        removed: before - state.semanticItemOrder.length,
        reason: String(event.reason || 'provider-request-failed'),
      });
      return changed || before !== state.semanticItemOrder.length;
    }
    if (type !== 'assistant_delta'
      && type !== 'item_started'
      && type !== 'item_completed'
      && type !== 'turn_completed') return false;

    const item = event.item && typeof event.item === 'object' ? event.item : null;
    const itemKind = String(item?.kind || '');
    const assistantEvent = type === 'assistant_delta' || itemKind === 'agentMessage';
    if (!assistantEvent) return true;
    const itemId = String(event.itemId || item?.itemId || '');
    if (!itemId) return false;
    const state = ensureSemanticTurn({
      tabId,
      provider,
      threadId: event.threadId || authority.threadId || null,
      turnId: event.turnId || authority.turnId || null,
      instanceId,
    });
    if (!state) return false;
    if (gap) {
      state.semanticGap = true;
      writeLog('warn', 'SEMANTIC_GAP', state, {
        instance: short(instanceId, 18),
        item: short(itemId, 18),
        type,
      });
    }
    let semanticItem = state.semanticItems.get(itemId);
    if (!semanticItem) {
      semanticItem = {
        itemId,
        requestId: String(event.requestId || item?.requestId || '') || null,
        messageId: item?.messageId || null,
        text: '',
        phase: null,
        completed: false,
        materialized: false,
        canonicalIdentity: null,
      };
      state.semanticItems.set(itemId, semanticItem);
      state.semanticItemOrder.push(itemId);
    }
    if (!semanticItem.requestId && (event.requestId || item?.requestId)) {
      semanticItem.requestId = String(event.requestId || item.requestId);
    }
    if (item?.phase != null) semanticItem.phase = item.phase;
    const identityMatches = reconcileSemanticCanonicalReceipts(state);
    if (type === 'item_completed') {
      if (typeof item?.text === 'string') semanticItem.text = item.text;
      semanticItem.completed = true;
      // Item completion is the exact full text for this item and repairs any
      // dropped delta inside it. Other items have their own exact completion.
      state.semanticGap = false;
      authority.gap = false;
      const textMatches = reconcileSemanticCanonicalReceipts(state, {
        allowTextFallback: true,
      });
      return setSemanticText(state, 'semantic-assistant-completed')
        || identityMatches > 0
        || textMatches > 0;
    }
    if (type === 'assistant_delta') {
      if (state.semanticGap || authority.gap || typeof event.delta !== 'string') return false;
      semanticItem.text += event.delta;
      return setSemanticText(state, 'semantic-assistant-delta');
    }
    return true;
  };

  const registerMarker = (context) => {
    try { return context?.mirror?.terminal?.registerMarker?.(0) || null; } catch { return null; }
  };

  const begin = ({
    tabId,
    provider,
    sessionId = null,
    turnId = null,
    promptText = '',
    processId = null,
    sourceSequence = null,
    sourceBoundary = null,
    promptSource = null,
    promptAuthority = null,
  } = {}) => {
    if (!tabId || (provider !== 'claude' && provider !== 'codex')) return null;
    clear(tabId, 'new-turn');
    if (isEnabled() !== true) {
      writeLog('log', 'START_SKIPPED', {
        tabId,
        provider,
        sessionId,
        turnId,
        phase: 'disabled',
      }, { reason: 'feature-disabled' });
      return null;
    }
    const context = getContext(tabId);
    if (!context?.terminal || !context?.mirror || !context?.lifecycleGeneration) {
      const diagnostic = {
        tabId,
        provider,
        sessionId,
        turnId,
        lifecycleGeneration: context?.lifecycleGeneration || null,
        mirrorGeneration: context?.mirror?.generation || null,
        phase: 'unavailable',
      };
      writeLog('warn', 'START_SKIPPED', diagnostic, { reason: 'owner-context-incomplete' });
      return null;
    }
    // Marker is a useful fast-path inside an append-only shell buffer, but it
    // is not ownership. Full-screen Claude/Codex redraws legitimately erase
    // xterm markers. The exact lifecycle + submitted prompt remain authoritative.
    const marker = registerMarker(context);
    const startedAt = now();
    const state = {
      previewId: provider + ':' + context.lifecycleGeneration + ':'
        + String(turnId || sourceSequence || startedAt),
      tabId,
      provider,
      sessionId: sessionId || null,
      turnId: turnId || null,
      promptText: String(promptText || ''),
      promptSource: promptSource || null,
      promptAuthority: promptAuthority
        || (promptText ? PROMPT_AUTHORITY_EXACT_TRANSCRIPT : 'none'),
      // The active segment may clear its prompt fields after an exact JSONL
      // boundary, but a later full-screen redraw can repaint the submitted
      // user card anywhere in the viewport. Keep the exact turn prompt until
      // the whole turn ends so that repaint can never become assistant text.
      submittedPromptText: String(promptText || ''),
      submittedPromptSource: promptSource || null,
      submittedPromptAuthority: promptAuthority
        || (promptText ? PROMPT_AUTHORITY_EXACT_TRANSCRIPT : 'none'),
      processId: processId || null,
      sourceSequence: finiteNumberOrNull(sourceSequence),
      sourceBoundary: finiteNumberOrNull(sourceBoundary),
      initialSourceBoundary: finiteNumberOrNull(sourceBoundary),
      terminal: context.terminal,
      mirror: context.mirror,
      marker,
      lifecycleGeneration: context.lifecycleGeneration,
      mirrorGeneration: context.mirror.generation,
      mirrorGenerationOrdinal: context.mirror.generationOrdinal,
      phase: 'streaming',
      sourceMode: semanticAuthorities.get(tabId)?.provider === provider && semanticAuthorities.get(tabId)?.expected === true
        ? (semanticAuthorities.get(tabId)?.connected === true ? 'semantic' : 'semantic-pending')
        : 'screen',
      semanticInstanceId: semanticAuthorities.get(tabId)?.provider === provider
        ? semanticAuthorities.get(tabId)?.instanceId || null
        : null,
      semanticGap: false,
      semanticItems: new Map(),
      semanticItemOrder: [],
      semanticCanonicalReceipts: [],
      text: '',
      previewSeq: 0,
      startedAt,
      updatedAt: startedAt,
      committedFrameGeneration: null,
      writeSeq: null,
      truncated: false,
      emitTimer: null,
      coalescedFrames: 0,
      lastUnknownKey: null,
      lastMergeReason: null,
      lastFrameReason: null,
      lastPhysicalRows: 0,
      boundaryKind: null,
      lastFilteredBlockKinds: [],
      lastStyleEvidenceUsed: false,
      lastAnswerMarkerRemoved: false,
      boundaryRow: null,
      markerLossLogged: false,
      lastCommittedSnapshot: null,
      rebaseBaselineSnapshot: null,
      rebaseBaselineKind: null,
      rebaseCanonicalText: '',
      structuredProof: createTerminalHistoryStructuredProof([]),
      canonicalMaterialized: false,
      baselineAdvanceCount: 0,
      baselineAdvanceLogged: false,
    };
    turns.set(tabId, state);
    writeLog('log', 'START', state, {
      markerLine: marker?.line ?? '-',
      markerAvailable: !!marker,
      sourceSeq: state.sourceSequence ?? '-',
      sourceBoundary: state.sourceBoundary ?? '-',
      promptChars: state.promptText.length,
      promptHash: state.promptText ? previewTextHash(state.promptText) : '-',
      promptSource: state.promptSource || '-',
      promptAuthority: state.promptAuthority || '-',
    });
    return publicPreview(state);
  };

  // A fresh Codex rollout can expose its exact task_started while the watcher
  // is still replaying a privately-held launch range. The following exact
  // user_message belongs to that already-busy turn and may arm the preview,
  // but it must never replace a turn which was started through the normal
  // live lifecycle path.
  const beginIfAbsent = (detail = {}) => {
    const existing = turns.get(detail?.tabId);
    if (existing) return null;
    return begin(detail);
  };

  const observeFrame = (tabId, mirror, committedSnapshot) => {
    const state = turns.get(tabId);
    if (!state || state.phase === 'cleared') return false;
    if (isEnabled() !== true) {
      clear(tabId, 'feature-disabled', state);
      return false;
    }
    if (mirror !== state.mirror) {
      clear(tabId, 'frame-from-foreign-mirror', state);
      return false;
    }
    const ownership = exactContext(state);
    if (!ownership.ok) {
      clear(tabId, ownership.reason, state);
      return false;
    }
    // The Codex provider stream gives us raw assistant Markdown before ratatui
    // turns it into cells. Keep the headless snapshot for terminal mechanics
    // and diagnostics, but never reinterpret its tool/status rows as prose
    // while the semantic source owns this turn.
    if (state.sourceMode === 'semantic' || state.sourceMode === 'semantic-pending') {
      if (committedSnapshot?.authoritativeFrameCommitted
        && committedSnapshot.mirrorGeneration === state.mirrorGeneration) {
        state.lastCommittedSnapshot = committedSnapshot;
        state.committedFrameGeneration = committedSnapshot.committedFrameGeneration ?? null;
        state.writeSeq = committedSnapshot.writeSeq ?? null;
      }
      return false;
    }
    if ((!state.marker || state.marker.isDisposed || Number(state.marker.line) < 0)
      && !state.markerLossLogged) {
      state.markerLossLogged = true;
      const submittedPrompt = state.submittedPromptText || state.promptText;
      writeLog('warn', 'ANCHOR_LOST', state, {
        reason: state.marker ? 'xterm-marker-disposed-by-redraw' : 'xterm-marker-unavailable',
        action: submittedPrompt
          ? 'recover-from-exact-prompt'
          : state.rebaseBaselineSnapshot
            ? 'recover-from-exact-jsonl-baseline'
            : 'freeze-until-proof',
        promptHash: submittedPrompt
          ? previewTextHash(normalizeTerminalHistoryPromptText(submittedPrompt))
          : '-',
      });
    }
    if (!committedSnapshot?.authoritativeFrameCommitted
      || committedSnapshot.mirrorGeneration !== state.mirrorGeneration) {
      const key = 'frame-not-authoritative:' + String(committedSnapshot?.writeSeq ?? '-');
      if (state.lastUnknownKey !== key) {
        state.lastUnknownKey = key;
        writeLog('warn', 'FREEZE', state, {
          reason: 'frame-not-authoritative',
          frame: committedSnapshot?.committedFrameGeneration ?? '-',
          writeSeq: committedSnapshot?.writeSeq ?? '-',
        });
      }
      return false;
    }
    state.lastCommittedSnapshot = committedSnapshot;
    const frame = readFrame({ state, context: ownership.context, snapshot: committedSnapshot });
    if (!frame || frame.status !== 'ready') {
      const reason = frame?.reason || 'frame-region-unavailable';
      const key = reason + ':' + String(frame?.candidateHash || '-');
      if (state.lastUnknownKey !== key) {
        state.lastUnknownKey = key;
        writeLog('warn', 'FREEZE', state, {
          reason,
          markerLine: state.marker?.line ?? '-',
          viewportY: committedSnapshot.viewportY ?? '-',
          frame: committedSnapshot.committedFrameGeneration ?? '-',
          writeSeq: committedSnapshot.writeSeq ?? '-',
        });
      }
      return false;
    }
    state.committedFrameGeneration = committedSnapshot.committedFrameGeneration ?? null;
    state.writeSeq = committedSnapshot.writeSeq ?? null;
    state.lastPhysicalRows = frame.physicalLines.length;
    state.lastFrameReason = frame.reason || null;
    const nextBoundaryKind = frame.boundaryKind || null;
    const nextBoundaryRow = finiteNumberOrNull(frame.boundaryRow);
    if (nextBoundaryKind
      && (state.boundaryKind !== nextBoundaryKind || state.boundaryRow !== nextBoundaryRow)) {
      state.boundaryKind = nextBoundaryKind;
      state.boundaryRow = nextBoundaryRow;
      writeLog('log', 'ANCHOR', state, {
        kind: nextBoundaryKind,
        row: nextBoundaryRow ?? '-',
        markerAlive: !!(state.marker && !state.marker.isDisposed),
        frame: state.committedFrameGeneration ?? '-',
        writeSeq: state.writeSeq ?? '-',
      });
    }
    const submittedPrompt = state.submittedPromptText || state.promptText;
    let extracted = extractTerminalHistoryPreviewText({
      provider: state.provider,
      leadingPhysicalLines: frame.leadingPhysicalLines,
      physicalLines: frame.physicalLines,
      promptText: submittedPrompt,
      promptPrefixClipped: frame.promptPrefixClipped === true,
      regionTruncated: frame.truncated === true,
      exactStructuredBoundaryKind: frame.boundaryKind === 'exact-jsonl-frame-baseline'
        ? state.rebaseBaselineKind
        : null,
    });
    state.lastFilteredBlockKinds = Array.isArray(extracted.filteredBlockKinds)
      ? extracted.filteredBlockKinds
      : [];
    state.lastStyleEvidenceUsed = extracted.styleEvidenceUsed === true;
    state.lastAnswerMarkerRemoved = extracted.answerMarkerRemoved === true;
    state.lastResidualPromptLinesRemoved = Number(
      extracted.residualPromptLinesRemoved || 0,
    );
    if (extracted.status === 'unknown') {
      const key = extracted.reason + ':' + String(extracted.hash || '-');
      if (state.lastUnknownKey !== key) {
        state.lastUnknownKey = key;
        writeLog('warn', 'FREEZE', state, {
          reason: extracted.reason,
          rows: frame.physicalLines.length,
          systemBlocks: state.lastFilteredBlockKinds.join(',') || '-',
          promptRowsRemoved: state.lastResidualPromptLinesRemoved || 0,
          styleEvidence: state.lastStyleEvidenceUsed,
          frame: state.committedFrameGeneration ?? '-',
          writeSeq: state.writeSeq ?? '-',
        });
      }
      return false;
    }
    // Preserve what the terminal parser proved before exact JSONL/tool
    // receipts subtract already-materialized content. A frame which becomes
    // empty only after that subtraction may still contain the beginning of a
    // new assistant answer, so it must not replace the exact screen baseline.
    const rawFrameWasEmpty = extracted.status === 'empty';
    if (Array.isArray(frame.baselinePhysicalLines)) {
      const baselineExtracted = extractTerminalHistoryPreviewText({
        provider: state.provider,
        physicalLines: frame.baselinePhysicalLines,
        promptText: submittedPrompt,
        regionTruncated: frame.baselineTruncated === true,
      });
      if (baselineExtracted.status === 'unknown') {
        const key = 'baseline-' + baselineExtracted.reason + ':'
          + String(baselineExtracted.hash || '-');
        if (state.lastUnknownKey !== key) {
          state.lastUnknownKey = key;
          writeLog('warn', 'FREEZE', state, {
            reason: 'exact-baseline-' + baselineExtracted.reason,
            baselineFrame: frame.baselineFrameGeneration ?? '-',
            baselineWriteSeq: frame.baselineWriteSeq ?? '-',
            frame: state.committedFrameGeneration ?? '-',
            writeSeq: state.writeSeq ?? '-',
          });
        }
        return false;
      }
      if (extracted.status === 'empty') {
        // The common empty-frame path below advances the baseline. Keeping it
        // in one place also covers the short interval while the fresh xterm
        // marker still exists and excludes the structured row itself.
      } else {
        const delta = deriveTerminalHistoryPreviewTextAfterBaseline(
          baselineExtracted.text,
          extracted.text,
        );
        if (delta.status === 'unknown') {
          const key = delta.reason + ':' + String(delta.candidateHash || '-');
          if (state.lastUnknownKey !== key) {
            state.lastUnknownKey = key;
            writeLog('warn', 'FREEZE', state, {
              reason: delta.reason,
              baselineHash: delta.baselineHash || '-',
              candidateHash: delta.candidateHash || '-',
              baselineFrame: frame.baselineFrameGeneration ?? '-',
              baselineWriteSeq: frame.baselineWriteSeq ?? '-',
              frame: state.committedFrameGeneration ?? '-',
              writeSeq: state.writeSeq ?? '-',
            });
          }
          return false;
        }
        if (delta.status === 'empty') {
          extracted = { ...extracted, status: 'empty', reason: delta.reason, text: '' };
        } else {
          extracted = { ...extracted, status: 'text', reason: delta.reason, text: delta.text };
          writeLog('log', 'BASELINE_DELTA', state, {
            kind: state.rebaseBaselineKind || '-',
            baselineFrame: frame.baselineFrameGeneration ?? '-',
            baselineWriteSeq: frame.baselineWriteSeq ?? '-',
            baselineAdvances: state.baselineAdvanceCount || 0,
            chars: delta.text.length,
            hash: previewTextHash(delta.text),
            frame: state.committedFrameGeneration ?? '-',
            writeSeq: state.writeSeq ?? '-',
          });
        }
      }
    }
    if (extracted.status === 'text' && state.rebaseCanonicalText) {
      const materialized = applyCanonicalMaterializationProof(state, extracted.text);
      if (materialized.status === 'empty') {
        extracted = { ...extracted, status: 'empty', reason: materialized.reason, text: '' };
      } else if (materialized.reason !== 'candidate-after-materialized-record'
        && materialized.reason !== 'materialized-text-unavailable') {
        extracted = {
          ...extracted,
          status: 'text',
          reason: materialized.reason,
          text: materialized.text,
        };
      }
    }
    if (extracted.status === 'text' && state.structuredProof?.fragments?.length > 0) {
      const structured = applyStructuredProjectionProof(state, extracted.text, {
        kind: 'committed-frame',
      });
      if (structured.status === 'empty') {
        extracted = { ...extracted, status: 'empty', reason: structured.reason, text: '' };
      } else if (structured.reason === 'structured-projection-prefix-removed') {
        extracted = {
          ...extracted,
          status: 'text',
          reason: structured.reason,
          text: structured.text,
        };
      }
    }
    if (extracted.status === 'empty') {
      // Only a frame which the terminal parser itself proved to contain no
      // assistant text may replace the baseline. An otherwise-valid frame can
      // become empty later because JSONL or a structured tool receipt removed
      // known content; advancing on that derived result would let the baseline
      // chase and absorb the beginning of the next real answer.
      if (rawFrameWasEmpty
        && !state.text
        && state.rebaseBaselineSnapshot
        && state.rebaseBaselineSnapshot !== committedSnapshot) {
        state.rebaseBaselineSnapshot = committedSnapshot;
        state.baselineAdvanceCount = Number(state.baselineAdvanceCount || 0) + 1;
        if (!state.baselineAdvanceLogged) {
          state.baselineAdvanceLogged = true;
          writeLog('log', 'BASELINE_ADVANCE', state, {
            kind: state.rebaseBaselineKind || '-',
            frame: state.committedFrameGeneration ?? '-',
            writeSeq: state.writeSeq ?? '-',
            reason: 'later-system-only-frame',
          });
        }
      }
      const key = 'empty:' + String(extracted.reason || '-');
      if (state.lastUnknownKey !== key) {
        state.lastUnknownKey = key;
        writeLog('log', 'WAIT', state, {
          reason: extracted.reason || 'owned-output-empty',
          rows: frame.physicalLines.length,
          filtered: extracted.filteredLines ?? '-',
          systemBlocks: state.lastFilteredBlockKinds.join(',') || '-',
          promptRowsRemoved: state.lastResidualPromptLinesRemoved || 0,
          styleEvidence: state.lastStyleEvidenceUsed,
          frame: state.committedFrameGeneration ?? '-',
          writeSeq: state.writeSeq ?? '-',
        });
      }
      return false;
    }
    const merged = mergeTerminalHistoryPreviewText(state.text, extracted.text);
    if (merged.status === 'unknown') {
      const key = merged.reason + ':' + String(merged.candidateHash || '-');
      if (state.lastUnknownKey !== key) {
        state.lastUnknownKey = key;
        writeLog('warn', 'FREEZE', state, {
          reason: merged.reason,
          currentHash: state.text ? previewTextHash(state.text) : '-',
          candidateHash: merged.candidateHash || '-',
          candidateChars: extracted.text.length,
          candidateHead: JSON.stringify(oneLine(extracted.text)),
          candidateTail: JSON.stringify(oneLine(extracted.text.slice(-160))),
          rows: frame.physicalLines.length,
          systemBlocks: state.lastFilteredBlockKinds.join(',') || '-',
          promptRowsRemoved: state.lastResidualPromptLinesRemoved || 0,
          styleEvidence: state.lastStyleEvidenceUsed,
          frame: state.committedFrameGeneration ?? '-',
          writeSeq: state.writeSeq ?? '-',
        });
      }
      return false;
    }
    if (merged.status !== 'updated') return false;
    state.text = merged.text.length > MAX_PREVIEW_CHARS
      ? merged.text.slice(merged.text.length - MAX_PREVIEW_CHARS)
      : merged.text;
    state.lastMergeReason = merged.reason;
    state.truncated = state.truncated === true
      || extracted.truncated === true
      || merged.text.length > MAX_PREVIEW_CHARS;
    state.lastUnknownKey = null;
    scheduleFramePublication(state);
    return true;
  };

  const bindPrompt = ({
    tabId,
    provider,
    sessionId = null,
    promptText = '',
    sourceSequence = null,
    sourceBoundary = null,
    promptSource = 'transcript-user-message',
    promptAuthority = PROMPT_AUTHORITY_EXACT_TRANSCRIPT,
  } = {}) => {
    const state = turns.get(tabId);
    if (!state || state.provider !== provider || state.phase !== 'streaming') return false;
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      writeLog('warn', 'STALE', state, {
        reason: 'prompt-session-mismatch',
        incomingSession: short(sessionId, 8),
      });
      return false;
    }
    if (sessionId && !state.sessionId) {
      state.sessionId = sessionId;
    }
    const incoming = normalizeTerminalHistoryPromptText(promptText);
    if (!incoming || String(promptText || '').trimStart().startsWith('/')) return false;
    const current = normalizeTerminalHistoryPromptText(state.promptText);
    const sequence = finiteNumberOrNull(sourceSequence);
    const boundary = finiteNumberOrNull(sourceBoundary);
    const sequenceIsNewer = sequence === null
      || state.sourceSequence === null
      || sequence > state.sourceSequence;
    // The manual capture stores the current EOF. The causal user_message may
    // start at that exact byte, so equality is expected; only an older offset
    // is contradictory. Sequence still has to advance for a text upgrade.
    const boundaryIsCompatible = boundary === null
      || state.sourceBoundary === null
      || boundary >= state.sourceBoundary;
    const exactTailUpgrade = current
      && current !== incoming
      && state.promptAuthority === PROMPT_AUTHORITY_PROVISIONAL_TAIL
      && promptAuthority === PROMPT_AUTHORITY_EXACT_TRANSCRIPT
      && incoming.length > current.length
      && incoming.endsWith(current)
      && sequenceIsNewer
      && boundaryIsCompatible;
    if (current && current !== incoming) {
      if (exactTailUpgrade) {
        writeLog('log', 'PROMPT_UPGRADE', state, {
          proof: 'exact-transcript-contains-provisional-tail',
          currentChars: current.length,
          incomingChars: incoming.length,
          currentHash: previewTextHash(current),
          incomingHash: previewTextHash(incoming),
          currentAuthority: state.promptAuthority || '-',
          incomingAuthority: promptAuthority || '-',
          sourceSeq: sequence ?? '-',
          sourceBoundary: boundary ?? '-',
        });
      } else {
        writeLog('warn', 'STALE', state, {
          reason: 'prompt-text-mismatch',
          currentChars: current.length,
          incomingChars: incoming.length,
          currentHash: previewTextHash(current),
          incomingHash: previewTextHash(incoming),
          currentAuthority: state.promptAuthority || '-',
          incomingAuthority: promptAuthority || '-',
          sourceSeq: sequence ?? '-',
          sourceBoundary: boundary ?? '-',
        });
        return false;
      }
    }
    state.promptText = String(promptText || '');
    state.promptSource = promptSource || null;
    state.promptAuthority = promptAuthority || PROMPT_AUTHORITY_EXACT_TRANSCRIPT;
    state.submittedPromptText = String(promptText || '');
    state.submittedPromptSource = promptSource || null;
    state.submittedPromptAuthority = promptAuthority || PROMPT_AUTHORITY_EXACT_TRANSCRIPT;
    if (sequence !== null) state.sourceSequence = sequence;
    if (boundary !== null) state.sourceBoundary = boundary;
    state.lastUnknownKey = null;
    state.promptBoundaryConfirmed = false;
    state.rebaseBaselineSnapshot = null;
    state.rebaseBaselineKind = null;
    state.rebaseCanonicalText = '';
    state.baselineAdvanceCount = 0;
    state.baselineAdvanceLogged = false;
    if (!exactTailUpgrade) {
      writeLog('log', 'PROMPT_BOUND', state, {
        promptChars: incoming.length,
        promptHash: previewTextHash(incoming),
        promptSource: state.promptSource || '-',
        promptAuthority: state.promptAuthority || '-',
        sourceSeq: state.sourceSequence ?? '-',
        sourceBoundary: state.sourceBoundary ?? '-',
      });
    }
    return true;
  };

  const finish = ({ tabId, provider, turnId = null, reason = 'turn-ended' } = {}) => {
    const state = turns.get(tabId);
    if (!state || state.provider !== provider) return false;
    if (provider === 'claude' && state.sourceMode === 'semantic' && !exactContext(state).ok) return false;
    if (turnId && state.turnId && turnId !== state.turnId) {
      writeLog('warn', 'STALE', state, {
        reason: 'finish-turn-mismatch',
        incomingTurn: short(turnId, 18),
      });
      return false;
    }
    if (state.phase === 'settled') return true;
    state.phase = 'settled';
    state.lastFrameReason = reason;
    // The exact assistant record has already replaced the provisional block.
    // Once this same turn ends, a trailing TUI repaint is presentation only:
    // keeping the observer armed would allow that late frame to resurrect the
    // already-materialized answer as a second settled preview.
    if (!state.text && state.canonicalMaterialized === true) {
      turns.delete(tabId);
      cancelPendingEmission(state);
      disposeMarker(state);
      writeLog('log', 'SETTLE_CANONICAL', state, {
        reason,
        canonicalChars: state.rebaseCanonicalText.length,
        canonicalHash: state.rebaseCanonicalText
          ? previewTextHash(state.rebaseCanonicalText)
          : '-',
      });
      return true;
    }
    if (state.text) publishFrame(state, 'settle');
    else writeLog('log', 'SETTLE_EMPTY', state, { reason });
    return true;
  };

  const observeCanonical = ({
    tabId,
    provider,
    sessionId = null,
    sourceSequence = null,
    sourceEndOffset = null,
    identity = null,
    semanticItemId = null,
    semanticMessageId = null,
    canonicalTexts = null,
    canonicalText = '',
  } = {}) => {
    const state = turns.get(tabId);
    if (!state || state.provider !== provider) return false;
    if (provider === 'claude' && state.sourceMode === 'semantic' && !exactContext(state).ok) return false;
    const semanticCodexSessionHandoff = provider === 'codex'
      && state.sourceMode === 'semantic';
    if (state.sessionId && sessionId && state.sessionId !== sessionId
      && !semanticCodexSessionHandoff) {
      writeLog('warn', 'STALE', state, {
        reason: 'canonical-session-mismatch',
        incomingSession: short(sessionId, 8),
      });
      return false;
    }
    if (sessionId && (!state.sessionId || semanticCodexSessionHandoff)) {
      state.sessionId = sessionId;
    }
    const sequence = finiteNumberOrNull(sourceSequence);
    if (state.sourceSequence !== null
      && sequence !== null
      && sequence <= state.sourceSequence) {
      writeLog('warn', 'STALE', state, {
        reason: 'canonical-before-turn-sequence',
        sourceSeq: sequence,
        startSeq: state.sourceSequence,
      });
      return false;
    }
    const endOffset = finiteNumberOrNull(sourceEndOffset);
    const receiptBoundary = provider === 'claude' && state.sourceMode === 'semantic'
      ? state.initialSourceBoundary : state.sourceBoundary;
    if (receiptBoundary !== null
      && endOffset !== null
      && endOffset <= receiptBoundary) {
      writeLog('warn', 'STALE', state, {
        reason: 'canonical-before-transcript-boundary',
        sourceEnd: endOffset,
        startBoundary: receiptBoundary,
      });
      return false;
    }
    if (sequence !== null) state.sourceSequence = sequence;
    if (endOffset !== null) state.sourceBoundary = Math.max(state.sourceBoundary ?? 0, endOffset);
    const previousChars = state.text.length;
    const previousHash = state.text ? previewTextHash(state.text) : '-';
    const materializedText = String(canonicalText || '').trim();
    const receiptTexts = provider === 'claude' && Array.isArray(canonicalTexts)
      ? canonicalTexts : [materializedText];
    const semanticAcks = receiptTexts.reduce((count, text, index) => count + observeSemanticCanonicalReceipt(state, {
      itemId: semanticItemId,
      messageId: semanticMessageId,
      identity,
      receiptKey: identity + ':' + index,
      text,
    }), 0);
    if (state.sourceMode === 'semantic' && semanticAcks === 0) {
      writeLog('warn', 'CANONICAL_UNMATCHED', state, {
        identity: short(identity, 20),
        sourceSeq: sequence ?? '-',
        sourceEnd: endOffset ?? '-',
        semanticItem: short(semanticItemId, 18),
        canonicalChars: materializedText.length,
        canonicalHash: materializedText ? previewTextHash(materializedText) : '-',
        reason: 'exact-semantic-item-not-observed',
      });
      return false;
    }
    const remainingSemanticText = state.sourceMode === 'semantic'
      ? semanticText(state)
      : '';
    state.canonicalMaterialized = state.sourceMode !== 'semantic'
      || remainingSemanticText.length === 0;
    cancelPendingEmission(state);
    if (state.text && remainingSemanticText.length === 0) {
      emitAction(state, 'clear', 'canonical-materialized', {
        // Renderer must not remove a tall provisional row merely because main
        // has parsed its canonical carrier. The exact physical identity lets
        // it wait until THAT row exists in the stateful History projection and
        // replace the preview under one semantic viewport anchor.
        canonicalIdentity: identity || null,
        canonicalSourceSequence: sequence,
        canonicalSourceEndOffset: endOffset,
        canonicalTextHash: materializedText ? previewTextHash(materializedText) : null,
      });
    }
    writeLog('log', 'CANONICAL', state, {
      identity: short(identity, 20),
      sourceSeq: sequence ?? '-',
      sourceEnd: endOffset ?? '-',
      clearedChars: previousChars,
      clearedHash: previousHash,
      canonicalChars: materializedText.length,
      canonicalHash: materializedText ? previewTextHash(materializedText) : '-',
      semanticItem: short(semanticItemId, 18),
      semanticAcks,
      disposition: state.phase === 'settled' ? 'finish' : 'rebase',
    });
    if (state.sourceMode === 'semantic' && remainingSemanticText) {
      state.text = remainingSemanticText.length > MAX_PREVIEW_CHARS
        ? remainingSemanticText.slice(remainingSemanticText.length - MAX_PREVIEW_CHARS)
        : remainingSemanticText;
      state.truncated = remainingSemanticText.length > MAX_PREVIEW_CHARS;
      state.rebaseCanonicalText = materializedText;
      state.lastMergeReason = 'semantic-item-materialized';
      state.lastUnknownKey = null;
      if (state.previewSeq > 0) publishFrame(state, 'update');
      else scheduleFramePublication(state);
      return true;
    }
    if (state.phase === 'settled') {
      turns.delete(tabId);
      disposeMarker(state);
      return true;
    }
    const ownership = exactContext(state);
    if (!ownership.ok) {
      clear(tabId, 'canonical-rebase-' + ownership.reason, state);
      return true;
    }
    captureExactFrameBaseline(state, 'canonical-assistant', identity);
    state.rebaseCanonicalText = materializedText;
    disposeMarker(state);
    const marker = registerMarker(ownership.context);
    state.marker = marker;
    state.promptText = '';
    state.promptSource = null;
    state.promptAuthority = 'none';
    state.promptBoundaryConfirmed = false;
    state.text = '';
    state.truncated = false;
    state.lastMergeReason = null;
    state.lastUnknownKey = null;
    state.coalescedFrames = 0;
    state.lastFilteredBlockKinds = [];
    state.lastStyleEvidenceUsed = false;
    state.lastAnswerMarkerRemoved = false;
    state.boundaryKind = null;
    state.boundaryRow = null;
    state.markerLossLogged = false;
    writeLog(marker ? 'log' : 'warn', marker ? 'CANONICAL_REBASE' : 'CANONICAL_REBASE_MARKER_UNAVAILABLE', state, {
      markerLine: marker?.line ?? '-',
      baselineFrame: state.rebaseBaselineSnapshot?.committedFrameGeneration ?? '-',
      reason: marker ? 'exact-canonical-record' : 'durable-baseline-only',
    });
    return true;
  };

  const observeBoundary = ({
    tabId,
    provider,
    sessionId = null,
    sourceSequence = null,
    sourceEndOffset = null,
    identity = null,
    kind = 'structured-record',
    structuredTexts = [],
  } = {}) => {
    const state = turns.get(tabId);
    if (!state || state.provider !== provider || state.phase !== 'streaming') return false;
    // A tool/thinking receipt must not subtract genuine network prose using
    // screen-text heuristics. Only exact assistant receipts settle live items.
    if (provider === 'claude' && state.sourceMode !== 'screen') return false;
    if (state.sessionId && sessionId && state.sessionId !== sessionId) {
      writeLog('warn', 'STALE', state, {
        reason: 'boundary-session-mismatch',
        incomingSession: short(sessionId, 8),
        kind,
      });
      return false;
    }
    if (sessionId && !state.sessionId) state.sessionId = sessionId;
    const sequence = finiteNumberOrNull(sourceSequence);
    if (state.sourceSequence !== null
      && sequence !== null
      && sequence <= state.sourceSequence) {
      writeLog('warn', 'STALE', state, {
        reason: 'boundary-before-turn-sequence',
        sourceSeq: sequence,
        startSeq: state.sourceSequence,
        kind,
      });
      return false;
    }
    const endOffset = finiteNumberOrNull(sourceEndOffset);
    if (state.sourceBoundary !== null
      && endOffset !== null
      && endOffset <= state.sourceBoundary) {
      writeLog('warn', 'STALE', state, {
        reason: 'boundary-before-transcript-boundary',
        sourceEnd: endOffset,
        startBoundary: state.sourceBoundary,
        kind,
      });
      return false;
    }
    if (sequence !== null) state.sourceSequence = sequence;
    if (endOffset !== null) state.sourceBoundary = endOffset;
    state.structuredProof = createTerminalHistoryStructuredProof(
      structuredTexts,
      state.structuredProof,
    );
    // An exact thinking/tool boundary opens a new semantic segment. A prior
    // assistant record proves only the segment before this boundary; it must
    // not make task completion close the observer before a final post-tool
    // terminal repaint has had a chance to materialize.
    state.canonicalMaterialized = false;
    // Reconcile once more at every exact JSONL boundary. A repaint can race
    // immediately after observeCanonical and briefly republish a rendered
    // tail of that already-saved Markdown. The next tool/thinking receipt is
    // a deterministic second chance to clear it instead of letting the stale
    // preview block all later baseline advances.
    if (state.text && state.rebaseCanonicalText) {
      const materialized = applyCanonicalMaterializationProof(state, state.text, {
        proofAt: kind,
      });
      if (materialized.status === 'empty') {
        const wasPublished = state.previewSeq > 0;
        cancelPendingEmission(state);
        state.text = '';
        state.lastMergeReason = materialized.reason;
        state.lastUnknownKey = null;
        if (wasPublished) emitAction(state, 'clear', materialized.reason);
      } else if (materialized.reason !== 'candidate-after-materialized-record'
        && materialized.reason !== 'materialized-text-unavailable'
        && materialized.text !== state.text) {
        cancelPendingEmission(state);
        state.text = materialized.text;
        state.lastMergeReason = materialized.reason;
        state.lastUnknownKey = null;
        if (state.previewSeq > 0) publishFrame(state, 'update');
        else scheduleFramePublication(state);
      }
    }
    if (state.text) {
      const structured = applyStructuredProjectionProof(state, state.text, {
        kind,
        identity,
      });
      if (structured.status === 'empty') {
        const wasPublished = state.previewSeq > 0;
        cancelPendingEmission(state);
        state.text = '';
        state.lastMergeReason = structured.reason;
        state.lastUnknownKey = null;
        if (wasPublished) emitAction(state, 'clear', structured.reason);
      } else if (structured.reason === 'structured-projection-prefix-removed') {
        cancelPendingEmission(state);
        state.text = structured.text;
        state.lastMergeReason = structured.reason;
        state.lastUnknownKey = null;
        if (state.previewSeq > 0) publishFrame(state, 'update');
        else scheduleFramePublication(state);
      }
    }
    if (state.text) {
      writeLog('warn', 'BOUNDARY_HELD', state, {
        kind,
        identity: short(identity, 20),
        sourceSeq: sequence ?? '-',
        sourceEnd: endOffset ?? '-',
        chars: state.text.length,
        hash: previewTextHash(state.text),
        reason: 'provisional-text-not-yet-materialized',
      });
      return true;
    }
    const ownership = exactContext(state);
    if (!ownership.ok) {
      clear(tabId, 'boundary-rebase-' + ownership.reason, state);
      return true;
    }
    captureExactFrameBaseline(state, kind, identity);
    disposeMarker(state);
    const marker = registerMarker(ownership.context);
    state.marker = marker;
    state.promptText = '';
    state.promptSource = null;
    state.promptAuthority = 'none';
    state.promptBoundaryConfirmed = false;
    state.truncated = false;
    state.lastMergeReason = null;
    state.lastUnknownKey = null;
    state.coalescedFrames = 0;
    state.lastFilteredBlockKinds = [];
    state.lastStyleEvidenceUsed = false;
    state.lastAnswerMarkerRemoved = false;
    state.boundaryKind = null;
    state.boundaryRow = null;
    state.markerLossLogged = false;
    writeLog(marker ? 'log' : 'warn', marker ? 'BOUNDARY_REBASE' : 'BOUNDARY_REBASE_FAILED', state, {
      kind,
      identity: short(identity, 20),
      sourceSeq: sequence ?? '-',
      sourceEnd: endOffset ?? '-',
      markerLine: marker?.line ?? '-',
      reason: marker
        ? 'exact-structured-record'
        : state.rebaseBaselineSnapshot
          ? 'durable-baseline-only'
          : 'xterm-marker-and-baseline-unavailable',
    });
    return true;
  };

  const get = (tabId, provider = null) => {
    if (isEnabled() !== true) return null;
    const state = turns.get(tabId);
    if (!state || (provider && state.provider !== provider) || !state.text) return null;
    const ownership = exactContext(state);
    if (!ownership.ok) {
      clear(tabId, 'read-' + ownership.reason, state);
      return null;
    }
    return publicPreview(state);
  };

  const getCanonicalCatchupScope = (tabId) => {
    const state = turns.get(tabId);
    if (!state || state.provider !== 'claude' || state.sourceMode !== 'semantic'
      || state.initialSourceBoundary === null || !exactContext(state).ok) return null;
    return {
      previewId: state.previewId, sessionId: state.sessionId,
      fromByteOffset: state.initialSourceBoundary,
      lifecycleGeneration: state.lifecycleGeneration,
    };
  };

  return {
    activateSemanticSource,
    begin,
    beginIfAbsent,
    bindPrompt,
    clear,
    clearAll,
    clearSemanticSource,
    disconnectSemanticSource,
    expectSemanticSource,
    finish,
    get,
    getCanonicalCatchupScope,
    observeBoundary,
    observeCanonical,
    observeFrame,
    observeSemanticEvent,
    _turns: turns,
    _semanticAuthorities: semanticAuthorities,
  };
}

module.exports = {
  DEFAULT_EMIT_COALESCE_MS,
  createTerminalHistoryPreviewController,
};
