const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { getCodexProcessActionOwnershipRevision } = require('./codex-process-action-ownership');
const { performance } = require('node:perf_hooks');
const { searchHistoryEntries, normalizeHistorySearchType } = require('../shared/history-search.cjs');
const { historyRecordTimeFromRecord } = require('../shared/history-record-time.cjs');
const { findTabMessageSourceLocation } = require('./tab-message-source-location');
const { describeCodexForkPrefixFailure } = require('./codex-fork-lineage-diagnostic');
const { codexForkCopyPayload } = require('./codex-fork-copy-payload');
const { ipcMain } = require('node:worker_threads').isMainThread ? require('electron') : {};
const { codexProviderErrorMessage } = require('./codex-provider-error');
const { claudeHistoryFailureFromRecord } = require('../shared/claude-provider-failure.cjs');
const { createProjectionIdentityMap, remapHistoryRowIdentity, hasProvenRewritePayloads } = require('../shared/codex-rewrite-identities.cjs');
const {
  buildHistoryRevision,
  isWellFormedRevision,
  validateHistoryRevision,
} = require('./history-revision');
const {
  decorateHistoryPromptPresentations,
  recoverManagedHistoryImageRefs,
} = require('./history-prompt-presentations');
const {
  decorateHistoryResponseTimings,
  prepareHistoryResponseTimingWindow,
} = require('./history-response-timings');
const {
  dehydrateHistoryEntries,
  HISTORY_PAYLOAD_ON_DEMAND,
  HISTORY_PAYLOAD_HEADER_VERSION,
  projectHistoryOnDemand,
  historyPayloadHash,
  sliceHistoryPayload,
  historyPayloadStash,
  capPayloadForRender,
} = require('./history-payload-dehydrate');
const {
  applyHistoryEntryWindow,
  applyHistoryRowWindow,
  normalizeHistoryRowWindowRequest,
  normalizeHistoryEntryWindowRequest,
} = require('./history-entry-window');
const {
  diffHistoryEntriesAgainstDigest,
  HistoryDeltaDigestStore,
} = require('./history-delta');
const {
  isCodexEnvironmentContextUserText,
  codexUserMessagePresentationText,
  codexUserMessageImageRefs,
} = require('./codex-prompt-audit');
const {
  buildCodexLaunchForkEvent,
  deriveCodexForkSnapshot,
  normalizeCodexForkLineageManifest,
  normalizeCodexForkSourceSnapshot,
  isProvenMaterializedCompactFork,
  isProvenEmptyCodexHistoryRewrite,
} = require('./session-history-events');
const {
  createCodexVirtualTranscriptStore,
  hashFileSegment,
} = require('./codex-virtual-transcript');
const { createCodexResultSourceResolver, codexResultSourceRevisionKey } = require('./codex-result-source');
const {
  codexContextObservationFromRecord,
  readLatestCodexContextObservation,
} = require('./codex-context-usage');
const { claudeSettingsServiceDisplayFromRecord } = require('../shared/claude-slash-display.cjs');
const { codexSettingsWindowBaseline } = require('./codex-settings-history');

function shortId(value, n = 8) {
  return String(value || '').slice(0, n);
}

function decoratePromptSnapshot(service, { toolType, sessionId, entries }) {
  const store = service.promptPresentationStore;
  const revision = () => store?.getHistoryPromptPresentationRevision?.(toolType, sessionId) || 'none';
  let projected = entries, token = 'none', stable = false;
  for (let attempt = 0; attempt < (service.preparedHistoryStore ? 3 : 1); attempt++) {
    const before = service.preparedHistoryStore ? revision() : null;
    projected = decorateHistoryPromptPresentations(store, {
      toolType, sessionId, entries, recoverManagedImageRef: service.recoverManagedHistoryImageRef,
    });
    token = revision(); stable = !service.preparedHistoryStore || before === token;
    if (stable) break;
  }
  // Concurrent sidecar writes (including our first exact binding) require a
  // reread. Never stamp old decoration with the foreign writer's newer token.
  // No write transaction spans a full projection; main's writer stays free.
  return { entries: projected, revision: stable ? token : 'pending-presentation:' + token, stable };
}

// Losing the last consumer means "nobody is LOOKING right now", not "this
// session is over". Tab switches, split-pane remounts and owner-key changes all
// drop consumers for a few hundred milliseconds and then re-subscribe to the
// exact same file. Tearing the watch down immediately turned every such blink
// into a cold re-read of the whole rollout (measured: 80 full reads / 139.5s
// over two days on a 450MB session). The state is kept warm for a grace window
// so the return path is a stat, not a parse; a session that truly went away is
// swept when the window expires.
const IDLE_STATE_GRACE_MS = 90_000;
// Warm idle states are cheap (one fs.watch + a 10s stat timer) but not free.
// Bound how many can wait at once so a long session of tab-hopping cannot
// accumulate watchers indefinitely — oldest idle state is evicted first.
const IDLE_STATE_MAX = 8;

function normalizeToolType(toolType) {
  return toolType === 'codex' ? 'codex' : toolType === 'gemini' ? 'gemini' : 'claude';
}

function transcriptKey(toolType, sessionId, cwd) {
  return JSON.stringify({
    toolType: normalizeToolType(toolType),
    sessionId: sessionId || '',
    cwd: cwd || '',
  });
}

function getRecordUuid(record, sessionId, index) {
  if (record?.uuid) return record.uuid;
  if (record?.type === 'event_msg' && record?.payload?.type === 'user_message') {
    return `codex-user-${sessionId || 'unknown'}-${index}`;
  }
  if (record?.type === 'compacted') return `codex-compact-${sessionId || 'unknown'}-${index}`;
  return `codex-record-${sessionId || 'unknown'}-${index == null ? 'unknown' : index}`;
}

function isCodexUserMessageRecord(record) {
  return record?.type === 'event_msg' && record?.payload?.type === 'user_message';
}

function isCodexLiveMessageRecord(record) {
  if (isCodexUserMessageRecord(record)) return true;
  if (record?.type !== 'response_item') return false;
  const payloadType = record?.payload?.type;
  return payloadType === 'message' ||
    payloadType === 'reasoning' ||
    payloadType === 'function_call' ||
    payloadType === 'custom_tool_call' ||
    payloadType === 'function_call_output' ||
    payloadType === 'custom_tool_call_output';
}

// Claude can persist reasoning as a standalone assistant record even though
// the durable History projection intentionally materializes only assistant
// records that contain visible text or tool calls. Keep that reasoning live
// while the turn runs, but mark it as ephemeral so the renderer can fold it
// into the next visible assistant row or discard it at the exact turn boundary.
function isClaudePendingThinkingRecord(record) {
  if (record?.type !== 'assistant') return false;
  const content = record?.message?.content;
  if (!Array.isArray(content)) return false;
  const hasThinking = content.some((block) =>
    block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0
  );
  if (!hasThinking) return false;
  const hasVisibleText = content.some((block) =>
    block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  );
  const hasToolCall = content.some((block) => block?.type === 'tool_use');
  return !hasVisibleText && !hasToolCall;
}

function codexRecordToMobileMessage(record, sessionId) {
  const failure = codexProviderErrorMessage(record, sessionId);
  if (failure) return failure;
  const payload = record?.payload || {};
  if (isCodexUserMessageRecord(record)) {
    const text = codexUserMessagePresentationText(record);
    if (isCodexEnvironmentContextUserText(text)) return null;
    return {
      type: 'user',
      uuid: getRecordUuid(record, sessionId, record.__line),
      timestamp: record.timestamp || null,
      recordTime: historyRecordTimeFromRecord(record),
      ...(codexUserMessageImageRefs(record).length > 0 ? { imagePaths: codexUserMessageImageRefs(record) } : {}),
      message: {
        role: 'user',
        content: text,
      },
    };
  }
  if (record?.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'assistant') {
      return {
        type: 'assistant',
        uuid: getRecordUuid(record, sessionId, record.__line),
        timestamp: record.timestamp || null,
        recordTime: historyRecordTimeFromRecord(record),
        message: {
          role: 'assistant',
          content: payload.content || [],
        },
      };
    }
    if (payload.type === 'reasoning') return null;
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      return {
        type: 'assistant',
        uuid: getRecordUuid(record, sessionId, record.__line),
        timestamp: record.timestamp || null,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: payload.call_id || payload.id || '',
            name: payload.name || payload.tool_name || payload.type,
            input: payload.arguments || payload.input || {},
            recordTime: historyRecordTimeFromRecord(record, 'tool-call', payload.name === 'exec' ? 'container' : 'record'),
          }],
        },
      };
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') return null;
  }
  return null;
}

class SessionTranscriptService {
  constructor({
    getMainWindow,
    webBroadcast,
    onChanged = null,
    onLiveMessage = null,
    onRawRecord = null,
    onCodexContextObservation = null,
    resolveClaudePromptOwner = null,
    claudeData,
    codexData,
    sessionHistoryStore = null,
    promptPresentationStore = null,
    recoverManagedHistoryImageRef = null,
    historyReader = null,
    preparedHistoryStore = null,
    codexVirtualMaxBytes = undefined,
    idleGraceMs = IDLE_STATE_GRACE_MS,
    idleStateMax = IDLE_STATE_MAX,
  }) {
    this.getMainWindow = getMainWindow;
    this.webBroadcast = webBroadcast;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.onLiveMessage = typeof onLiveMessage === 'function' ? onLiveMessage : null;
    this.onRawRecord = typeof onRawRecord === 'function' ? onRawRecord : null;
    this.onCodexContextObservation = typeof onCodexContextObservation === 'function'
      ? onCodexContextObservation
      : null;
    this.resolveClaudePromptOwner = typeof resolveClaudePromptOwner === 'function'
      ? resolveClaudePromptOwner
      : null;
    this.claudeData = claudeData;
    this.codexData = codexData;
    this.historyReader = historyReader;
    this.preparedHistoryStore = preparedHistoryStore;
    this.codexVirtualMaxBytes = codexVirtualMaxBytes;
    this.sessionHistoryStore = sessionHistoryStore;
    this.promptPresentationStore = promptPresentationStore;
    this.recoverManagedHistoryImageRef = typeof recoverManagedHistoryImageRef === 'function'
      ? recoverManagedHistoryImageRef
      : null;
    this.sessions = new Map();
    this.sessionInitInflight = new Map();
    this.consumerToKey = new Map();
    // 0 restores the pre-grace behaviour (close on last consumer) — used by
    // tests that assert immediate teardown.
    this.idleGraceMs = Number.isFinite(idleGraceMs) ? Math.max(0, idleGraceMs) : IDLE_STATE_GRACE_MS;
    this.idleStateMax = Number.isFinite(idleStateMax) ? Math.max(1, idleStateMax) : IDLE_STATE_MAX;
    // Resolved transcript paths survive state teardown. Switching away from
    // a tab drops its last consumer and closes the state; without this memo
    // every switch BACK re-walked the whole sessions tree (~400ms of main
    // loop per subscribe — the measured right-click delay). A session's file
    // never moves; existence is re-checked on reuse.
    this.resolvedPathCache = new Map(); // `${toolType}:${sessionId}` → filePath
    // Delta digests: what each (session, tab) renderer last received, as
    // uuid order + per-row fingerprints. Lets a live refresh return only
    // changed rows instead of the full projection (see history-delta.js).
    this.historyDeltaDigests = new HistoryDeltaDigestStore();
    this.codexVirtualTranscriptStore = null;
    this.codexResultSourceResolver = null;
    this.codexProviderForkMetadata = new Map();
    this.codexLineageRecoveryInflight = new Map();
    this.codexForkPrefixDiagnosticSignatures = new Map();
    this.codexForkValidationFailures = new Map();
    this.codexForkValidationInflight = new Map();
    this.codexForkSourceProofInflight = new Map();
  }

  async getHistoryFreshnessContext(scope, sourceSessionIds = []) {
    if (typeof this.promptPresentationStore?.getHistoryFreshnessMetadata !== 'function') {
      throw new Error('history_freshness_metadata_unavailable');
    }
    const metadata = this.promptPresentationStore.getHistoryFreshnessMetadata({ ...scope, sourceSessionIds });
    let runtime;
    if (scope.toolType === 'codex') runtime = getCodexProcessActionOwnershipRevision(sourceSessionIds);
    else {
      if (typeof this.claudeData?._api?.getHistoryFreshnessRuntime !== 'function') {
        throw new Error('history_freshness_runtime_unavailable');
      }
      runtime = await this.claudeData._api.getHistoryFreshnessRuntime(scope);
    }
    const reader = scope.toolType === 'codex' && this.historyReader ? {
      clientId: this.historyReader.clientId, generation: this.historyReader.workerGeneration,
      alive: !!this.historyReader.worker,
    } : null;
    return { metadata, runtime, reader };
  }

  registerIpc() {
    ipcMain.handle('agent-transcript:subscribe', async (_event, payload = {}) => this.subscribe(payload));
    ipcMain.handle('agent-transcript:unsubscribe', async (_event, payload = {}) => this.unsubscribe(payload));
    ipcMain.handle('agent-transcript:refresh', async (_event, payload = {}) => this.refresh(payload));
    const desktopRead = (method, payload) => payload.toolType === 'codex' && payload.readTransport === 'v8-1' && this.historyReader
      ? this.historyReader.call(method, payload, true) : this[method](payload);
    ipcMain.handle('agent-transcript:get-timeline', async (_event, payload = {}) => desktopRead('getTimeline', payload));
    ipcMain.handle('agent-transcript:get-history', async (_event, payload = {}) => desktopRead('getHistory', payload));
    ipcMain.handle('agent-transcript:get-messages', async (_event, payload = {}) => this.getMessages(payload));
    ipcMain.handle('history:get-tool-payload', async (_event, payload = {}) => this.getToolPayload(payload));
    ipcMain.handle('agent-transcript:search-history', async (_event, payload = {}) => this.searchHistory(payload));
    ipcMain.handle('agent-transcript:copy-codex-range', async (_event, payload = {}) => this.copyCodexVirtualRange(payload));
    ipcMain.handle('agent-transcript:export-codex-session', async (_event, payload = {}) => this.exportCodexSession(payload));
    ipcMain.handle('agent-transcript:resolve-physical-row', async (_event, payload = {}) => this.resolveCodexPhysicalRow(payload));
  }

  /**
   * Rehydrates one dehydrated payload on demand (card expand). The stash is
   * the fast path; a Codex miss re-runs the projection once (LRU-cached
   * records make it cheap), a Claude miss re-reads the session chain. Exact
   * identity only — payloadId is deterministic per source record.
   */
  async getTabMessageSourceLocation(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('getTabMessageSourceLocation', payload);
    const history = await this.getHistory({ toolType, sessionId: payload.sessionId,
      cwd: payload.cwd, tabId: payload.tabId, dehydrate: false });
    return findTabMessageSourceLocation(payload.message, { ...history, toolType, sessionId: payload.sessionId });
  }

  async getToolPayload(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('getToolPayload', payload);
    if (payload.payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND) return this._getOnDemandToolPayload(payload);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    const payloadId = typeof payload.payloadId === 'string' ? payload.payloadId : '';
    if (!sessionId || !payloadId) {
      return { success: false, error: 'sessionId and payloadId required' };
    }
    const payloadGeneration = String(payload.payloadGeneration || '');
    const presentPayload = text => {
      if (payload.expectedContentHash && historyPayloadHash(text) !== payload.expectedContentHash) {
        return { success: false, error: 'history_payload_changed', payloadId };
      }
      return payload.expectedContentHash ? sliceHistoryPayload(text, payload) : capPayloadForRender(text);
    };
    // A payload in a fork can originate in a frozen ancestor. Checking only
    // the child's physical file would let a RAM-stash hit bypass lineage.
    const payloadLineage = toolType === 'codex' ? this._resolveCodexLineage(sessionId, 'full') : null;
    if (payloadLineage?.kind === 'unresolved') return { success: false, error: 'lineage_unresolved', lineageReason: payloadLineage.reason };
    const generationMatches = async () => {
      if (!payloadGeneration && toolType !== 'codex') return true;
      const file = await this._resolveFilePath(toolType, sessionId, cwd);
      const stat = file ? await fs.promises.stat(file).catch(() => null) : null;
      if (!stat) return false;
      if (toolType === 'codex') {
        await this.codexData._api.prepareCodexPayloadSource?.({ sessionId, cwd, filePath: file, stat });
        const snapshot = this.preparedHistoryStore?.readSource({ sessionId, cwd });
        if (snapshot && snapshot.filePath === file && snapshot.size === stat.size
          && snapshot.mtimeMs === stat.mtimeMs && snapshot.ctimeMs === stat.ctimeMs
          && snapshot.fileIdentity === stat.dev + ':' + stat.ino) this.codexData._api.restoreCodexSourceSnapshot?.(snapshot);
        const generation = this.codexData?._api?.getCodexPayloadGeneration?.(file, stat, sessionId);
        if (!payloadGeneration) return true;
        if (generation && payloadGeneration === generation) return true;
      }
      return payloadGeneration === stat.dev + ':' + stat.ino;
    };
    if (!await generationMatches()) return { success: false, error: 'history_payload_generation_changed', payloadId };
    const virtualPayload = payloadLineage?.kind === 'virtual' ? await this._projectCodexVirtual(payloadLineage, cwd) : null;
    if (virtualPayload && !virtualPayload.success) return virtualPayload;
    if (virtualPayload) dehydrateHistoryEntries({ toolType, sessionId,
      entries: virtualPayload.historyEntries || [], stash: historyPayloadStash });
    const stashed = historyPayloadStash.get(toolType, sessionId, payloadId);
    if (typeof stashed === 'string') {
      const capped = presentPayload(stashed);
      console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=stash bytes=${stashed.length}`);
      return { success: true, source: 'stash', payloadId, ...capped };
    }
    let capturedPayload = null;
    try {
      if (toolType === 'codex') {
        const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
        let entries;
        if (lineage.kind === 'virtual') {
          const projected = await this._projectCodexVirtual(lineage, cwd);
          if (!projected?.success) return projected;
          entries = projected.historyEntries || [];
        } else {
          const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
          if (!loaded?.success) return { success: false, error: loaded?.error || 'session not found' };
          entries = this.codexData._api.buildCodexFullHistory(loaded.records || [], sessionId);
        }
        dehydrateHistoryEntries({
          toolType,
          sessionId,
          entries,
          stash: historyPayloadStash,
          onPayload: (id, text) => { if (id === payloadId) capturedPayload = text; },
        });
      } else if (toolType === 'claude') {
        const rebuild = this.claudeData?._api?.rebuildHistoryPayloadStash;
        if (typeof rebuild !== 'function') {
          return { success: false, error: 'claude payload rebuild unavailable' };
        }
        await rebuild({ sessionId, cwd, stash: historyPayloadStash });
      } else {
        return { success: false, error: 'unsupported toolType' };
      }
    } catch (error) {
      return { success: false, error: String(error?.message || error) };
    }
    if (!await generationMatches()) return { success: false, error: 'history_payload_generation_changed', payloadId };
    const rebuilt = capturedPayload ?? historyPayloadStash.get(toolType, sessionId, payloadId);
    if (typeof rebuilt !== 'string') {
      console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=miss`);
      return { success: false, error: 'payload not found', payloadId };
    }
    const capped = presentPayload(rebuilt);
    console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=rebuild bytes=${rebuilt.length}`);
    return { success: true, source: 'rebuild', payloadId, ...capped };
  }

  async _getOnDemandToolPayload(payload) {
    const { toolType, sessionId, cwd, tabId, entryUuid, payloadId, payloadGeneration, contentHash } = payload;
    if (!['codex', 'claude'].includes(toolType) || !sessionId || !entryUuid || !payloadId
      || !payloadGeneration || !/^[a-f0-9]{64}$/.test(contentHash || '')) {
      return { success: false, error: 'history_payload_reference_required' };
    }
    // Reuse the canonical bounded read (including worker/SSD/lineage). Besides
    // surviving stash eviction/restart this proves row membership, not merely
    // an arbitrary payload ID supplied by a client. No fallback to another SID.
    let captured = null;
    const current = await this.getHistory({ toolType, sessionId, cwd, tabId,
      dehydrate: true, payloadPolicy: HISTORY_PAYLOAD_ON_DEMAND,
      bounds: { aroundUuid: entryUuid, radius: 1 },
    }, 0, (id, text) => { if (id === payloadId) captured = text; });
    if (!current?.success) return current;
    if (current.payloadGeneration !== payloadGeneration) return { success: false, error: 'history_payload_generation_changed', reason: 'projection-generation' };
    const row = current.entries?.find(entry => entry.uuid === entryUuid);
    const refs = row ? [row.thinkingRef, row.compactSummaryRef,
      ...(row.actions || []).flatMap(action => [action?.actionRef, action?.rawTool?.resultRef])] : [];
    const ref = refs.find(value => value?.payloadId === payloadId);
    if (!ref) return { success: false, error: 'history_payload_not_found' };
    if (ref.contentHash !== contentHash) return { success: false, error: 'history_payload_changed' };
    let result;
    if (captured !== null) result = { success: true, source: 'projection', ...sliceHistoryPayload(captured, payload) };
    else result = await this.getToolPayload({ toolType, sessionId, cwd, tabId, payloadId, payloadGeneration,
      expectedContentHash: contentHash, offset: payload.offset, limit: payload.limit });
    if (!result?.success) return result;
    // A frozen prefix revision deliberately has mtime=0: its proof is the
    // lineage digest, not whole-file stat equality (the ancestor may append).
    // Reuse the canonical virtual verifier and its physical read tickets.
    let validation;
    if (toolType === 'codex' && current.composite) {
      const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
      if (lineage.kind !== 'virtual') return { success: false, error: 'history_payload_generation_changed' };
      const saved = await this._readVirtualProjection(lineage, cwd);
      const projected = saved?.projection || await this._projectCodexVirtual(lineage, cwd);
      if (!projected?.success) return projected;
      validation = { unchanged: this._buildCodexContentRevision(sessionId, cwd, projected)?.token === current.contentRevision,
        reason: 'lineage-changed' };
    } else validation = await validateHistoryRevision(current.revision, { toolType, sessionId, cwd });
    if (!validation.unchanged) return { success: false, error: 'history_payload_generation_changed', reason: validation.reason };
    return { ...result, payloadId, contentHash, encoding: ref.encoding, entryUuid,
      toolType, sessionId, payloadGeneration };
  }

  _getCodexVirtualTranscriptStore() {
    if (this.codexVirtualTranscriptStore) return this.codexVirtualTranscriptStore;
    const api = this.codexData?._api;
    if (!api) return null;
    try {
      this.codexVirtualTranscriptStore = createCodexVirtualTranscriptStore({ codexApi: api, maxBytes: this.codexVirtualMaxBytes,
        storage: this.preparedHistoryStore,
        prepareEntries: (entries, sessionId) => dehydrateHistoryEntries({ toolType: 'codex', sessionId, entries, stash: historyPayloadStash }),
      });
    } catch {
      return null;
    }
    return this.codexVirtualTranscriptStore;
  }

  _codexForkEventsForChild(sessionId) {
    const store = this.sessionHistoryStore;
    if (!store || !sessionId) return [];
    let events = [];
    if (typeof store.getSessionHistoryEvents === 'function') {
      events = store.getSessionHistoryEvents(sessionId);
    } else if (typeof store.getSessionHistoryContext === 'function') {
      const fork = store.getSessionHistoryContext(sessionId)?.fork;
      if (fork) events = [fork];
    }
    return (Array.isArray(events) ? events : []).filter((event) => (
      event?.eventType === 'fork'
      && event?.provider === 'codex'
      && String(event?.childSessionId || event?.sessionId || '') === sessionId
      && event?.isDirect !== false
    ));
  }

  _resolveCodexLineage(sessionId, payloadPolicy = 'dehydrated') {
    const candidates = this._codexForkEventsForChild(sessionId);
    const exact = [];
    for (const event of candidates) {
      const manifest = normalizeCodexForkLineageManifest(event?.lineageManifest, {
        sourceSessionId: event?.sourceSessionId,
        childSessionId: sessionId,
      });
      if (manifest && event?.snapshotComplete !== false) exact.push({ event, manifest });
    }
    const parentIds = new Set(exact.map((candidate) => candidate.manifest.sourceSessionId));
    if (parentIds.size > 1) {
      return { kind: 'unresolved', reason: 'multiple-exact-parent-events', candidates };
    }
    if (exact.length > 0) {
      exact.sort((left, right) => {
        const trusted = (event) => ['app', 'terminal-mcp', 'orchestration'].includes(event?.origin) ? 1 : 0;
        return trusted(right.event) - trusted(left.event)
          || Number(right.event?.occurredAt || right.event?.createdAt || 0)
            - Number(left.event?.occurredAt || left.event?.createdAt || 0);
      });
      const chosen = exact[0];
      return {
        kind: 'virtual',
        event: chosen.event,
        descriptor: {
          viewOwnerSessionId: sessionId,
          eventKey: chosen.event.eventKey,
          manifest: chosen.manifest,
          payloadPolicy,
        },
      };
    }
    return {
      kind: 'physical',
      legacyForkEvent: candidates[0] || null,
    };
  }

  async _projectCodexVirtual(lineage, cwd) {
    const store = this._getCodexVirtualTranscriptStore();
    if (!store) return { success: false, error: 'lineage_unresolved', lineageReason: 'virtual-projector-unavailable' };
    try {
      // A full client may be the first caller after worker restart. Prime
      // every unchanged physical generation before the canonical rebuild.
      await this._readVirtualProjection(lineage, cwd);
      const result = await store.project(lineage.descriptor, cwd);
      if (result?.success) this.preparedHistoryStore?.saveVirtualProjection?.({ sessionId: lineage.descriptor.viewOwnerSessionId, cwd }, result);
      return result;
    } catch (error) {
      return {
        success: false,
        error: 'lineage_unresolved',
        lineageReason: error?.reason || error?.message || 'virtual-projector-failed',
      };
    }
  }

  async _readVirtualProjection(lineage, cwd) {
    const api = this.codexData?._api;
    if (!this.preparedHistoryStore || !api?.beginCodexSourceRead) return null;
    const saved = this.preparedHistoryStore.readVirtualProjection({ sessionId: lineage.descriptor.viewOwnerSessionId, cwd }, lineage.descriptor);
    if (!saved?.physicalSources?.length) return null;
    const reads = [];
    let childStat = null;
    try {
      for (const source of saved.physicalSources) {
        const found = await api.findCodexSessionFile(source.sessionId, cwd);
        if (found?.filePath !== source.filePath) return null;
        const stat = await fs.promises.stat(source.filePath);
        if (stat.size !== source.size || stat.mtimeMs !== source.mtimeMs || stat.ctimeMs !== source.ctimeMs
          || source.fileIdentity !== stat.dev + ':' + stat.ino || !api.restoreCodexSourceSnapshot(source)) return null;
        reads.push(await api.beginCodexSourceRead(source.filePath, source.sessionId));
        if (source.filePath === saved.filePath) childStat = stat;
      }
      for (const read of reads) await api.assertCodexSourceRead(read);
      return childStat ? { projection: saved, stat: childStat } : null;
    } catch (error) {
      if (error.code === 'CODEX_SOURCE_READ_INVALIDATED') throw error;
      return null;
    } finally { for (const read of reads) api.finishCodexSourceRead(read); }
  }

  async _readVirtualHistoryPage(lineage, payload) {
    if (payload.dehydrate !== true) return null;
    const cached = await this._readVirtualProjection(lineage, payload.cwd);
    if (!cached) return null;
    const { sessionId, cwd, tabId } = payload;
    const contentRevision = this._buildCodexContentRevision(sessionId, cwd, cached.projection);
    const context = JSON.stringify({
      presentationRevision: this.promptPresentationStore?.getHistoryPromptPresentationRevision?.('codex', sessionId) || 'none',
      responseTimingRevision: this.promptPresentationStore?.getHistoryResponseTimingRevision?.('codex', sessionId, tabId || null) || 'none',
      contentRevision: contentRevision?.token || null,
    });
    const request = { owner: { sessionId, cwd, tabId: tabId || null }, filePath: cached.projection.filePath,
      stat: cached.stat, context, hydrate: normalizeHistoryRowWindowRequest(payload.hydrate) };
    let page = this.preparedHistoryStore.readPrepared(request);
    if (page?.source.sourceGeneration !== cached.projection.childSnapshot.sourceGeneration) page = null;
    let base = page ? null : this.preparedHistoryStore.readPrepared({ ...request,
      kind: 'base', context: 'canonical:' + contentRevision.token, hydrate: null });
    if (base?.source.sourceGeneration !== cached.projection.childSnapshot.sourceGeneration) base = null;
    return page || base ? { projection: cached.projection, page, base } : null;
  }

  _buildCodexContentRevision(sessionId, cwd, projected) {
    if (!projected?.success || !projected?.manifest) return null;
    return buildHistoryRevision(
      { toolType: 'codex', sessionId, cwd },
      [...(projected.frozenSnapshots || []), projected.childSnapshot].filter(Boolean),
      {
        context: JSON.stringify({
          kind: 'codex-virtual-content',
          eventKey: projected.eventKey,
          manifestDigest: projected.manifest.manifestDigest,
        }),
      },
    );
  }

  // Result-proof source authority without raw records or History projection.
  // First-time provider lineage recovery retains its existing snapshot/Timeline
  // bootstrap cost; a persisted virtual view or ordinary physical source only
  // resolves files and, unless explicitly observing, verifies frozen ranges.
  // sourceVerificationBytes counts only the result resolver, not that existing
  // one-time lineage bootstrap or the reader's own prefix verification.
  async resolveCodexResultSource({ sessionId, cwd, verifyDigests = true } = {}) {
    let sourceVerificationBytes = 0;
    const unresolved = (lineageReason, retryable = false) => ({
      success: false, error: 'lineage_unresolved', lineageReason,
      digestsVerified: false, sourceVerificationBytes,
      ...(retryable ? { retryable: true } : {}),
    });
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return unresolved('child-session-missing');
    }
    try {
      const recovery = await this.ensureCodexProviderForkLineage({ childSessionId: sessionId, cwd });
      if (recovery.required && !recovery.success) {
        return unresolved(recovery.reason);
      }
      const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
      if (lineage.kind === 'unresolved') {
        return unresolved(lineage.reason);
      }
      this.codexResultSourceResolver ||= createCodexResultSourceResolver({ codexApi: this.codexData?._api });
      const result = await this.codexResultSourceResolver.resolve({ sessionId, cwd, lineage, verifyDigests });
      sourceVerificationBytes = result.sourceVerificationBytes;
      const currentKey = codexResultSourceRevisionKey(sessionId, this._resolveCodexLineage(sessionId, 'dehydrated'));
      if (result.revisionKey !== currentKey) {
        return unresolved('lineage-changed-during-source-resolution', true);
      }
      return result;
    } catch (error) {
      sourceVerificationBytes = error?.sourceVerificationBytes ?? sourceVerificationBytes;
      return unresolved(error?.reason || error?.message || 'result-source-resolution-failed', error?.retryable === true);
    }
  }

  // Shared raw input for history operations and MCP. A view may span frozen
  // ancestors and a growing child; callers must not substitute its local file.
  async loadCodexOperationSource({ sessionId, cwd, forceFresh = false, includeRecords = true } = {}) {
    const recovery = await this.ensureCodexProviderForkLineage({ childSessionId: sessionId, cwd });
    if (recovery.required && !recovery.success) {
      return { success: false, error: 'lineage_unresolved', lineageReason: recovery.reason };
    }
    const lineage = this._resolveCodexLineage(sessionId, 'full');
    if (lineage.kind === 'unresolved') {
      return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason };
    }
    if (lineage.kind !== 'virtual') {
      return this.codexData._api.loadSessionRecords(sessionId, cwd, { forceFresh });
    }
    try {
      const projected = await this._projectCodexVirtual(lineage, cwd);
      if (!projected?.success) return projected;
      if (projected.childHasPartialRecord) {
        return { success: false, error: 'lineage_unresolved', lineageReason: 'child-tail-incomplete' };
      }
      const raw = includeRecords
        ? await this._getCodexVirtualTranscriptStore().readRecords(lineage.descriptor, cwd, {
          childSnapshot: projected.childSnapshot,
        })
        : null;
      return {
        success: true,
        records: raw?.records,
        filePath: projected.filePath,
        sourceSnapshot: projected.childSnapshot,
        historyEntries: projected.historyEntries,
        timelineEntries: projected.timelineEntries,
        sessionMeta: projected.sessionMeta,
        composite: true,
        retainedSourceBytes: lineage.descriptor.manifest.sourceSegments.reduce(
          (sum, segment) => sum + segment.toByte - segment.fromByte, 0,
        ) + projected.childSnapshot.size - lineage.descriptor.manifest.childTailStart.byteOffset,
        contentRevision: this._buildCodexContentRevision(sessionId, cwd, projected)?.token,
      };
    } catch (error) {
      return { success: false, error: 'lineage_unresolved', lineageReason: error.reason || error.message };
    }
  }

  _decorateCodexContentRevision(entries, contentRevision) {
    const token = contentRevision?.token || null;
    return (Array.isArray(entries) ? entries : []).map((entry) => ({
      ...entry,
      contentRevision: token,
      entryRef: entry?.entryRef
        ? { ...entry.entryRef, contentRevision: token }
        : undefined,
    }));
  }

  async captureCodexForkSourceSnapshot({
    sessionId,
    cwd,
    loaded = null,
    endByteOffset = null,
  } = {}) {
    if (!sessionId) return null;
    const boundedEnd = endByteOffset === null || endByteOffset === undefined
      ? null
      : Number(endByteOffset);
    if (boundedEnd !== null && (!Number.isSafeInteger(boundedEnd) || boundedEnd <= 0)) {
      return null;
    }
    const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
    let timelineEntries = [];
    let sourceSegments = [];
    if (lineage.kind === 'virtual' && boundedEnd !== null) {
      const api = this.codexData?._api;
      if (!api?.findCodexSessionFile
        || !api?.readJsonlRange
        || !api?.createCodexTimelineProjector) return null;
      const projector = api.createCodexTimelineProjector(sessionId);
      const feedSegment = async (segment) => {
        const found = await api.findCodexSessionFile(segment.physicalSessionId, cwd);
        if (!found?.filePath) return null;
        const stat = await fs.promises.stat(found.filePath);
        if (stat.size < segment.toByte) return null;
        const digest = await hashFileSegment(found.filePath, segment.fromByte, segment.toByte);
        if (segment.prefixDigest && digest.sha256 !== segment.prefixDigest) return null;
        const parsed = segment.toByte > segment.fromByte
          ? await api.readJsonlRange(
              found.filePath,
              segment.fromByte,
              segment.toByte - 1,
              { lineCount: segment.startLine },
            )
          : { records: [], errors: 0, leftoverBuffer: Buffer.alloc(0), lineCount: segment.startLine };
        if (parsed.errors > 0
          || parsed.leftoverBuffer?.length > 0
          || Number(parsed.lineCount) !== Number(segment.endLine)) return null;
        for (const record of parsed.records || []) {
          projector.feed({ ...record, __physicalSessionId: segment.physicalSessionId });
        }
        return { filePath: found.filePath, digest };
      };

      for (const frozen of lineage.descriptor.manifest.sourceSegments) {
        const segment = { ...frozen };
        if (!await feedSegment(segment)) return null;
        sourceSegments.push(segment);
      }

      const tailStart = lineage.descriptor.manifest.childTailStart;
      if (boundedEnd < tailStart.byteOffset) return null;
      const found = await api.findCodexSessionFile(sessionId, cwd);
      if (!found?.filePath) return null;
      const stat = await fs.promises.stat(found.filePath);
      if (stat.size < boundedEnd) return null;
      const parsedTail = boundedEnd > tailStart.byteOffset
        ? await api.readJsonlRange(
            found.filePath,
            tailStart.byteOffset,
            boundedEnd - 1,
            { lineCount: tailStart.line },
          )
        : { records: [], errors: 0, leftoverBuffer: Buffer.alloc(0), lineCount: tailStart.line };
      if (parsedTail.errors > 0 || parsedTail.leftoverBuffer?.length > 0) return null;
      const tailDigest = await hashFileSegment(found.filePath, tailStart.byteOffset, boundedEnd);
      if (boundedEnd > tailStart.byteOffset) {
        const tailSegment = {
          physicalSessionId: sessionId,
          fromByte: tailStart.byteOffset,
          toByte: boundedEnd,
          startLine: tailStart.line,
          endLine: parsedTail.lineCount,
          prefixDigest: tailDigest.sha256,
        };
        for (const record of parsedTail.records || []) {
          projector.feed({ ...record, __physicalSessionId: sessionId });
        }
        sourceSegments.push(tailSegment);
      }
      timelineEntries = projector.finalize();
    } else if (lineage.kind === 'virtual') {
      const projected = await this._projectCodexVirtual(lineage, cwd);
      if (!projected?.success || projected.childHasPartialRecord) return null;
      timelineEntries = projected.timelineEntries || [];
      sourceSegments = projected.manifest.sourceSegments.map((segment) => ({ ...segment }));
      const tailStart = projected.manifest.childTailStart;
      const tailEnd = Number(projected.childSnapshot?.size);
      if (Number.isInteger(tailEnd) && tailEnd > tailStart.byteOffset) {
        const digest = await hashFileSegment(
          projected.childSnapshot.filePath,
          tailStart.byteOffset,
          tailEnd,
        );
        sourceSegments.push({
          physicalSessionId: sessionId,
          fromByte: tailStart.byteOffset,
          toByte: tailEnd,
          startLine: tailStart.line,
          endLine: projected.childLineCount,
          prefixDigest: digest.sha256,
        });
      }
    } else if (lineage.kind === 'physical') {
      let physical = loaded?.success ? loaded : null;
      if (!physical) {
        const api = this.codexData?._api;
        if (!api?.findCodexSessionFile || !api?.readJsonlRange) return null;
        const found = await api.findCodexSessionFile(sessionId, cwd);
        if (!found?.filePath) return null;
        const stat = await fs.promises.stat(found.filePath);
        const readEnd = boundedEnd === null ? stat.size : boundedEnd;
        if (!Number.isSafeInteger(readEnd) || readEnd <= 0 || stat.size < readEnd) return null;
        const parsed = await api.readJsonlRange(found.filePath, 0, readEnd - 1);
        if (parsed.errors > 0 || parsed.leftoverBuffer?.length > 0) return null;
        physical = {
          success: true,
          filePath: found.filePath,
          records: parsed.records || [],
          sourceSnapshot: { filePath: found.filePath, size: stat.size, mtimeMs: stat.mtimeMs },
        };
      }
      if (!physical?.success || !physical.filePath || !physical.sourceSnapshot) return null;
      const physicalEnd = boundedEnd === null ? physical.sourceSnapshot.size : boundedEnd;
      if (physicalEnd <= 0 || physical.sourceSnapshot.size < physicalEnd) return null;
      const handle = await fs.promises.open(physical.filePath, 'r');
      try {
        const lastByte = Buffer.allocUnsafe(1);
        const read = await handle.read(lastByte, 0, 1, physicalEnd - 1);
        if (read.bytesRead !== 1 || lastByte[0] !== 0x0a) return null;
      } finally {
        await handle.close();
      }
      let physicalRecords = physical.records || [];
      if (boundedEnd !== null) {
        const boundedRead = await this.codexData._api.readJsonlRange(
          physical.filePath,
          0,
          physicalEnd - 1,
        );
        if (boundedRead.errors > 0 || boundedRead.leftoverBuffer?.length > 0) return null;
        physicalRecords = boundedRead.records || [];
      }
      timelineEntries = this.codexData._api.buildCodexTimeline(physicalRecords, sessionId);
      const digest = await hashFileSegment(physical.filePath, 0, physicalEnd);
      const endLine = physicalRecords.reduce(
        (max, record) => Math.max(max, Number(record?.__line) + 1 || 0),
        0,
      );
      sourceSegments = [{
        physicalSessionId: sessionId,
        fromByte: 0,
        toByte: physicalEnd,
        startLine: 0,
        endLine,
        prefixDigest: digest.sha256,
      }];
    } else {
      return null;
    }
    const entryUuids = timelineEntries.map((entry) => String(entry?.uuid || '')).filter(Boolean);
    return {
      sourceSessionId: sessionId,
      entryUuids,
      boundaryEntryUuid: entryUuids.at(-1) || null,
      snapshotComplete: sourceSegments.length > 0,
      nextIterationIndex: timelineEntries.filter((entry) => entry?.type === 'user').length,
      sourceSegments,
      capturedAt: Date.now(),
    };
  }

  async captureCodexRewindSourceSnapshot({
    viewSessionId,
    physicalSessionId,
    targetSourceLine,
    cwd,
  } = {}) {
    const api = this.codexData?._api;
    const targetLine = Number(targetSourceLine);
    if (!viewSessionId
      || !physicalSessionId
      || !Number.isInteger(targetLine)
      || targetLine < 0
      || !api?.buildCodexVisibleRecordWrappers
      || !api?.createCodexTimelineProjector
      || !api?.findCodexSessionFile
      || !api?.readJsonlRange) return null;

    const recovered = await this.ensureCodexProviderForkLineage({ childSessionId: viewSessionId, cwd });
    if (recovered.required && !recovered.success) return null;

    const lineage = this._resolveCodexLineage(viewSessionId, 'full');
    let records = [];
    let descriptors = [];
    if (lineage.kind === 'virtual') {
      const raw = await this._getCodexVirtualTranscriptStore().readRecords(
        lineage.descriptor,
        cwd,
      );
      if (!raw?.success) return null;
      records = raw.records || [];
      descriptors = lineage.descriptor.manifest.sourceSegments.map((segment) => ({ ...segment }));
      const tailStart = lineage.descriptor.manifest.childTailStart;
      const tailRecords = records.filter((record) => (
        Number(record?.__segmentIndex) === descriptors.length
      ));
      descriptors.push({
        physicalSessionId: viewSessionId,
        fromByte: tailStart.byteOffset,
        toByte: raw.childSnapshot.size,
        startLine: tailStart.line,
        endLine: tailRecords.reduce(
          (max, record) => Math.max(max, Number(record?.__line) + 1 || 0),
          tailStart.line,
        ),
      });
    } else if (lineage.kind === 'physical') {
      if (viewSessionId !== physicalSessionId) return null;
      const found = await api.findCodexSessionFile(viewSessionId, cwd);
      if (!found?.filePath) return null;
      const stat = await fs.promises.stat(found.filePath);
      const parsed = stat.size > 0
        ? await api.readJsonlRange(found.filePath, 0, stat.size - 1)
        : { records: [], errors: 0, leftoverBuffer: Buffer.alloc(0), lineCount: 0 };
      if (parsed.errors > 0 || parsed.leftoverBuffer?.length > 0) return null;
      records = (parsed.records || []).map((record) => ({
        ...record,
        __physicalSessionId: viewSessionId,
        __segmentIndex: 0,
      }));
      descriptors = [{
        physicalSessionId: viewSessionId,
        fromByte: 0,
        toByte: stat.size,
        startLine: 0,
        endLine: parsed.lineCount,
      }];
    } else {
      return null;
    }

    const wrappers = api.buildCodexVisibleRecordWrappers(records, viewSessionId);
    const target = wrappers.find((wrapper) => (
      Number(wrapper?.line) === targetLine
      && String(wrapper?.record?.__physicalSessionId || viewSessionId) === physicalSessionId
      && wrapper?.kind === 'user'
    ));
    if (!target || !Number.isFinite(target.turnKey)) return null;
    const turnWrappers = wrappers.filter((wrapper) => (
      Number(wrapper?.turnKey) === Number(target.turnKey)
      && String(wrapper?.record?.__physicalSessionId || viewSessionId) === physicalSessionId
      && Number.isSafeInteger(Number(wrapper?.record?.__byteOffset))
    ));
    if (turnWrappers.length === 0) return null;
    const turnStart = turnWrappers.reduce((first, wrapper) => (
      Number(wrapper.record.__byteOffset) < Number(first.record.__byteOffset)
        ? wrapper
        : first
    ));
    const targetSegmentIndex = Number(turnStart.record.__segmentIndex);
    const boundaryByteOffset = Number(turnStart.record.__byteOffset);
    const boundaryLine = Number(turnStart.record.__line);
    const targetDescriptor = descriptors[targetSegmentIndex] || null;
    if (!targetDescriptor
      || targetDescriptor.physicalSessionId !== physicalSessionId
      || !Number.isSafeInteger(boundaryByteOffset)
      || boundaryByteOffset < targetDescriptor.fromByte
      || boundaryByteOffset > targetDescriptor.toByte
      || !Number.isInteger(boundaryLine)
      || boundaryLine < targetDescriptor.startLine) return null;

    const sourceSegments = descriptors
      .slice(0, targetSegmentIndex)
      .map((segment) => ({ ...segment }));
    const targetFile = await api.findCodexSessionFile(physicalSessionId, cwd);
    if (!targetFile?.filePath) return null;
    const boundaryDigest = await hashFileSegment(
      targetFile.filePath,
      targetDescriptor.fromByte,
      boundaryByteOffset,
    );
    sourceSegments.push({
      physicalSessionId,
      fromByte: targetDescriptor.fromByte,
      toByte: boundaryByteOffset,
      startLine: targetDescriptor.startLine,
      endLine: boundaryLine,
      prefixDigest: boundaryDigest.sha256,
    });

    const retainedRecords = records.filter((record) => {
      const index = Number(record?.__segmentIndex);
      if (index < targetSegmentIndex) return true;
      if (index > targetSegmentIndex) return false;
      return Number(record?.__byteOffset) < boundaryByteOffset;
    });
    const projector = api.createCodexTimelineProjector(viewSessionId);
    for (const record of retainedRecords) projector.feed(record);
    const timelineEntries = projector.finalize();
    const entryUuids = timelineEntries.map((entry) => String(entry?.uuid || '')).filter(Boolean);
    return {
      sourceSessionId: viewSessionId,
      entryUuids,
      boundaryEntryUuid: entryUuids.at(-1) || null,
      snapshotComplete: true,
      nextIterationIndex: timelineEntries.filter((entry) => entry?.type === 'user').length,
      sourceSegments,
      capturedAt: Date.now(),
      targetPhysicalSessionId: physicalSessionId,
      targetSourceLine: targetLine,
      targetTurnStartByteOffset: boundaryByteOffset,
    };
  }

  async prepareCodexProviderForkLineage({
    childSessionId,
    cwd,
    childTabId = null,
    visited = new Set(),
  } = {}) {
    if (!childSessionId) {
      return { required: false, success: false, reason: 'child-session-missing' };
    }
    const lineageVisited = visited instanceof Set ? new Set(visited) : new Set();
    if (lineageVisited.has(childSessionId)) {
      return { required: true, success: false, reason: 'provider-lineage-cycle' };
    }
    lineageVisited.add(childSessionId);
    const existing = this._resolveCodexLineage(childSessionId, 'dehydrated');
    if (existing.kind === 'virtual') {
      return { required: true, success: true, event: existing.event, alreadyPersisted: true };
    }
    const legacyFork = existing.legacyForkEvent || null;
    const api = this.codexData?._api;
    if (!api?.findCodexSessionFile || !api?.readCodexSessionMetadata) {
      return { required: !!legacyFork, success: false, reason: 'codex-loader-unavailable' };
    }
    let meta = this.codexProviderForkMetadata.get(childSessionId) || null;
    if (!meta) {
      const childFound = await api.findCodexSessionFile(childSessionId, cwd);
      if (!childFound?.filePath) {
        return { required: !!legacyFork, success: false, reason: 'child-load-failed' };
      }
      const childMetadata = await api.readCodexSessionMetadata(childFound.filePath);
      meta = childMetadata?.meta?.id === childSessionId
        ? childMetadata.meta
        : null;
      if (meta) this.codexProviderForkMetadata.set(childSessionId, meta);
    }
    const sourceSessionId = String(meta?.forked_from_id || '').trim();
    const historyBase = meta?.history_base && typeof meta.history_base === 'object'
      ? meta.history_base
      : null;
    const baseSourceSessionId = String(historyBase?.thread_id || '').trim();
    const sourceEndByteOffset = Number(historyBase?.end_byte_offset);
    const baseOrdinal = Number(historyBase?.end_ordinal_exclusive);
    const forkOrdinal = Number(meta?.forked_from_ordinal_exclusive);
    const providerPaginated = meta?.history_mode === 'paginated';
    // Old app compact copies retained the parent's paging header (tab-29).
    // Accept the self-contained representation only with the exact persisted
    // app snapshot AND an actual leading compact. Nonempty/native children do
    // not get this exception; no transcript file is rewritten by a read.
    if (providerPaginated && legacyFork?.forkMode === 'latest_compact'
      && ['app', 'terminal-mcp', 'orchestration'].includes(legacyFork.origin)) {
      const physical = await api.loadSessionRecords?.(childSessionId, cwd);
      if (physical?.success && isProvenMaterializedCompactFork(
        legacyFork, meta, physical.records,
        api.buildCodexTimeline(physical.records, childSessionId),
      )) {
        return { required: false, success: true, reason: 'proven-app-materialized-compact-fork' };
      }
    }
    if (!providerPaginated || !historyBase) {
      const legacyUnknownLineage = !!legacyFork
        && (!legacyFork.forkMode || legacyFork.forkMode === 'unknown')
        && (!Array.isArray(legacyFork.entryUuids) || legacyFork.entryUuids.length === 0);
      return {
        required: legacyUnknownLineage,
        success: false,
        reason: 'provider-history-base-absent',
      };
    }
    if (!sourceSessionId
      || baseSourceSessionId !== sourceSessionId
      || !Number.isSafeInteger(sourceEndByteOffset)
      || sourceEndByteOffset <= 0
      || !Number.isSafeInteger(baseOrdinal)
      || baseOrdinal < 0
      || (Number.isSafeInteger(forkOrdinal) && forkOrdinal !== baseOrdinal)) {
      return { required: true, success: false, reason: 'provider-history-base-invalid' };
    }
    if (legacyFork?.sourceSessionId && legacyFork.sourceSessionId !== sourceSessionId) {
      return { required: true, success: false, reason: 'provider-history-base-parent-mismatch' };
    }
    const sourceRecovery = await this.ensureCodexProviderForkLineage({
      childSessionId: sourceSessionId,
      cwd,
      visited: lineageVisited,
    });
    if (sourceRecovery.required && !sourceRecovery.success) {
      return { required: true, success: false, reason: 'provider-source-lineage-unresolved' };
    }
    const snapshot = await this.captureCodexForkSourceSnapshot({
      sessionId: sourceSessionId,
      cwd,
      endByteOffset: sourceEndByteOffset,
    });
    if (!snapshot?.snapshotComplete) {
      return { required: true, success: false, reason: 'provider-source-snapshot-unavailable' };
    }
    const childTailStart = await this.captureCodexForkChildTailStart({
      sourceSessionId,
      childSessionId,
      cwd,
    });
    if (!childTailStart) {
      return { required: true, success: false, reason: 'provider-child-tail-boundary-unavailable' };
    }
    const event = buildCodexLaunchForkEvent({
      snapshot,
      childSessionId,
      childTabId: childTabId || legacyFork?.childTabId || null,
      childTailStart,
      occurredAt: meta?.timestamp || legacyFork?.occurredAt || null,
    });
    if (!event?.lineageManifest) {
      return { required: true, success: false, reason: 'provider-lineage-manifest-invalid' };
    }
    return {
      required: true,
      success: true,
      event,
      providerHistoryBase: {
        sourceSessionId,
        endByteOffset: sourceEndByteOffset,
        endOrdinalExclusive: baseOrdinal,
      },
    };
  }

  async ensureCodexProviderForkLineage(payload = {}) {
    const childSessionId = String(payload?.childSessionId || '').trim();
    if (!childSessionId) {
      return { required: false, success: false, reason: 'child-session-missing' };
    }
    if (payload?.visited instanceof Set && payload.visited.has(childSessionId)) {
      return { required: true, success: false, reason: 'provider-lineage-cycle' };
    }
    const existing = this.codexLineageRecoveryInflight.get(childSessionId);
    if (existing) return existing;
    const run = this._ensureCodexProviderForkLineage(payload);
    this.codexLineageRecoveryInflight.set(childSessionId, run);
    try {
      return await run;
    } finally {
      if (this.codexLineageRecoveryInflight.get(childSessionId) === run) {
        this.codexLineageRecoveryInflight.delete(childSessionId);
      }
    }
  }

  async _verifyCodexForkSourceSnapshot(normalized, cwd, { includeRecords = false } = {}) {
    // Concurrent children of the same immutable prefix share only the in-flight
    // read. Do not keep another full transcript cache after verification ends.
    const key = JSON.stringify([cwd, normalized?.sourceSegments, includeRecords]);
    const pending = this.codexForkSourceProofInflight.get(key);
    if (pending) return pending;
    const run = this._verifyCodexForkSourceSnapshotInner(normalized, cwd, { includeRecords });
    this.codexForkSourceProofInflight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.codexForkSourceProofInflight.get(key) === run) this.codexForkSourceProofInflight.delete(key);
    }
  }

  async _verifyCodexForkSourceSnapshotInner(normalized, cwd, { includeRecords = false } = {}) {
    const api = this.codexData?._api;
    if (!normalized || !api?.findCodexSessionFile || !api?.readJsonlRange) {
      return { success: false, reason: 'source-snapshot-reader-unavailable' };
    }
    const records = [];
    for (const segment of normalized.sourceSegments) {
      const found = await api.findCodexSessionFile(segment.physicalSessionId, cwd);
      if (!found?.filePath) return { success: false, reason: 'source-snapshot-file-missing' };
      const stat = await fs.promises.stat(found.filePath);
      if (stat.size < segment.toByte) {
        return { success: false, reason: 'source-snapshot-file-truncated' };
      }
      const digest = await hashFileSegment(found.filePath, segment.fromByte, segment.toByte);
      if (digest.sha256 !== segment.prefixDigest) {
        return { success: false, reason: 'source-snapshot-digest-changed' };
      }
      const parsed = segment.toByte > segment.fromByte
        ? await api.readJsonlRange(
            found.filePath,
            segment.fromByte,
            segment.toByte - 1,
            { lineCount: segment.startLine },
          )
        : { records: [], errors: 0, leftoverBuffer: Buffer.alloc(0), lineCount: segment.startLine };
      if (parsed.errors > 0
        || parsed.leftoverBuffer?.length > 0
        || Number(parsed.lineCount) !== Number(segment.endLine)) {
        return { success: false, reason: 'source-snapshot-record-boundary-changed' };
      }
      if (includeRecords) {
        for (const record of parsed.records || []) {
          records.push({ ...record, __physicalSessionId: segment.physicalSessionId });
        }
      }
    }
    return { success: true, records };
  }

  _logCodexForkPrefixFailure(details) {
    try {
      // Discovery can retry the same rejected copy. Keep only small signatures,
      // never transcript objects, and diagnose it again when the inputs change.
      const key = JSON.stringify([details.childTabId, details.childSessionId, details.operationKind]);
      const signature = JSON.stringify([
        details.snapshot.sourceSessionId, details.snapshot.capturedAt,
        details.snapshot.sourceSegments, details.snapshot.boundaryEntryUuid,
        details.childSnapshot?.size, details.childSnapshot?.mtimeMs,
        details.counts, details.failure.check, details.failure.index,
      ]);
      if (this.codexForkPrefixDiagnosticSignatures.get(key) === signature) return;
      console.warn('[CodexForkLineage:PrefixMismatch] ' + JSON.stringify(describeCodexForkPrefixFailure(details)));
      this.codexForkPrefixDiagnosticSignatures.set(key, signature);
      if (this.codexForkPrefixDiagnosticSignatures.size > 64) {
        this.codexForkPrefixDiagnosticSignatures.delete(this.codexForkPrefixDiagnosticSignatures.keys().next().value);
      }
    } catch (error) {
      // A diagnostic failure must not change the original rejection/result.
      try {
        console.warn('[CodexForkLineage:DiagnosticFailed] tab=' + details.childTabId
          + ' child=' + details.childSessionId + ' error=' + String(error?.message || error));
      } catch { /* the shared logger may itself be unavailable */ }
    }
  }

  async _codexForkValidationFileSignature(snapshot, childSessionId, cwd) {
    const ids = [...new Set([...snapshot.sourceSegments.map(segment => segment.physicalSessionId), childSessionId])];
    try {
      const files = await Promise.all(ids.map(async sessionId => {
        const found = await this.codexData._api.findCodexSessionFile(sessionId, cwd);
        if (!found?.filePath) throw new Error('missing-file');
        const stat = await fs.promises.stat(found.filePath);
        return [sessionId, found.filePath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
      }));
      return JSON.stringify(files);
    } catch {
      return null;
    }
  }

  async _prepareCodexLineageFromSnapshot(payload = {}) {
    const snapshot = normalizeCodexForkSourceSnapshot(payload.snapshot);
    if (!snapshot || !payload.childSessionId) return this._prepareCodexLineageFromSnapshotInner(payload);
    const key = createHash('sha256').update(JSON.stringify([
      snapshot, payload.childSessionId, payload.childTabId, payload.cwd, payload.operationKind,
    ])).digest('hex');
    const signature = await this._codexForkValidationFileSignature(snapshot, payload.childSessionId, payload.cwd);
    const cached = this.codexForkValidationFailures.get(key);
    // ONLY a previous rejection may be reused. File metadata never grants
    // writer authority: every successful adoption still earns the full proof.
    // ctime/inode also detect same-size writes with a restored mtime and inPlace
    // replacement. An append or a changed snapshot re-runs the normal proof.
    if (signature && cached?.signature === signature) return { ...cached.result };
    this.codexForkValidationFailures.delete(key);
    const flightKey = key + ':' + signature;
    const pending = this.codexForkValidationInflight.get(flightKey);
    if (pending) return pending;
    const run = (async () => {
      const result = await this._prepareCodexLineageFromSnapshotInner(payload);
      if (signature && result.success === false
        && /^(fork|rewind)-materialized-prefix-(mismatch|incomplete)$/.test(result.reason || '')) {
        const after = await this._codexForkValidationFileSignature(snapshot, payload.childSessionId, payload.cwd);
        if (signature === after) {
          this.codexForkValidationFailures.set(key, { signature, result: { ...result } });
          if (this.codexForkValidationFailures.size > 64) {
            this.codexForkValidationFailures.delete(this.codexForkValidationFailures.keys().next().value);
          }
        }
      }
      return result;
    })();
    this.codexForkValidationInflight.set(flightKey, run);
    try {
      return await run;
    } finally {
      if (this.codexForkValidationInflight.get(flightKey) === run) this.codexForkValidationInflight.delete(flightKey);
    }
  }

  async _prepareCodexLineageFromSnapshotInner({
    snapshot,
    childSessionId,
    cwd,
    childTabId = null,
    operationKind,
  } = {}) {
    const normalized = normalizeCodexForkSourceSnapshot(snapshot);
    const reasonPrefix = operationKind === 'fork' ? 'fork' : 'rewind';
    if (!normalized || !childSessionId) {
      return { required: true, success: false, reason: reasonPrefix + '-source-snapshot-invalid' };
    }
    const api = this.codexData._api;
    const found = await api.findCodexSessionFile(childSessionId, cwd);
    if (!found?.filePath) return { required: true, success: false, reason: 'child-load-failed' };
    const metadata = await api.readCodexSessionMetadata(found.filePath);
    const meta = metadata?.meta;
    if (meta?.id !== childSessionId || meta?.forked_from_id !== normalized.sourceSessionId) {
      return { required: true, success: false, reason: reasonPrefix + '-child-source-mismatch' };
    }
    const sourceProof = await this._verifyCodexForkSourceSnapshot(normalized, cwd, {
      includeRecords: meta.history_mode !== 'paginated',
    });
    if (!sourceProof.success) {
      return { required: true, success: false, reason: reasonPrefix + '-' + sourceProof.reason };
    }
    if (meta.history_mode !== 'paginated') {
      if (typeof api.loadSessionRecords !== 'function' || typeof api.buildCodexTimeline !== 'function'
        || typeof api.buildCodexVisibleRecordWrappers !== 'function') {
        return { required: true, success: false, reason: reasonPrefix + '-materialized-reader-unavailable' };
      }
      const loaded = await api.loadSessionRecords(childSessionId, cwd, { forceFresh: true });
      if (!loaded?.success) {
        return { required: true, success: false, reason: reasonPrefix + '-materialized-child-load-failed' };
      }
      const timelineEntries = api.buildCodexTimeline(loaded.records || [], childSessionId);
      const childUserCount = timelineEntries.filter((entry) => entry?.type === 'user').length;
      const expectedUserCount = Number(normalized.nextIterationIndex);
      const diagnosticContext = {
        snapshot: normalized, childSessionId, childTabId, operationKind, meta,
        childSnapshot: loaded.sourceSnapshot,
        counts: {
          snapshotEntries: normalized.entryUuids.length,
          childTimelineEntries: timelineEntries.length,
          expectedUsers: expectedUserCount,
          childUsers: childUserCount,
          sourceRecords: sourceProof.records.length,
          childRecords: (loaded.records || []).length,
        },
      };
      if ((normalized.entryUuids.length > 0 && timelineEntries.length === 0)
        || (Number.isInteger(expectedUserCount) && childUserCount < expectedUserCount)) {
        this._logCodexForkPrefixFailure({ ...diagnosticContext, failure: {
          check: timelineEntries.length === 0 ? 'child-timeline-empty' : 'child-user-count',
          path: '/length',
          expected: timelineEntries.length === 0 ? normalized.entryUuids.length : expectedUserCount,
          actual: timelineEntries.length === 0 ? 0 : childUserCount,
        } });
        return { required: true, success: false, reason: reasonPrefix + '-materialized-prefix-incomplete' };
      }
      // Both native Fork and Rewind may write a complete physical copy. Keep
      // their purpose separate from that storage form, and seal only the
      // inherited prefix (not a later user turn that raced writer discovery).
      const sourceTimeline = api.buildCodexTimeline(sourceProof.records, normalized.sourceSessionId);
      const childPrefix = timelineEntries.slice(0, sourceTimeline.length);
      // Native copying restamps record timestamps. Reuse the canonical visible
      // branch reducer (including old rollbacks), then compare model carriers
      // in order, not timestamp/text similarity. Unique internal line numbers
      // prevent collisions when several physical source segments are combined.
      const copiedCarriers = (records, ownerSessionId) => api.buildCodexVisibleRecordWrappers(
        records.map((record, index) => ({ ...record, __line: index })), ownerSessionId,
      ).map((wrapper) => wrapper.record).filter((record) => (
        record.type === 'response_item' || record.type === 'compacted'
        || (record.type === 'event_msg' && record.payload?.type === 'user_message')
      ));
      const expectedCarriers = copiedCarriers(sourceProof.records, normalized.sourceSessionId);
      const actualCarriers = copiedCarriers(loaded.records || [], childSessionId);
      const copiedPayload = codexForkCopyPayload;
      let prefixFailure = null;
      const completePrefix = sourceTimeline.length === normalized.entryUuids.length
        && childPrefix.length === sourceTimeline.length
        && actualCarriers.length >= expectedCarriers.length
        && sourceTimeline.every((entry, index) => {
          const child = childPrefix[index];
          const matches = entry.uuid === normalized.entryUuids[index]
            && entry.type === child?.type && entry.content === child?.content;
          if (!matches) {
            const field = entry.uuid !== normalized.entryUuids[index] ? 'uuid'
              : entry.type !== child?.type ? 'type' : 'content';
            prefixFailure = {
              check: field === 'uuid' ? 'snapshot-entry-uuid' : 'timeline-' + field,
              index, path: '/' + field, sourceEntry: entry, childEntry: child,
              expected: field === 'uuid' ? normalized.entryUuids[index] : entry[field],
              actual: field === 'uuid' ? entry.uuid : child?.[field],
            };
          }
          return matches;
        })
        && expectedCarriers.every((record, index) => {
          const copied = actualCarriers[index];
          // Includes tools, assistant text, images and opaque compact content;
          // object key ordering and the restamped outer timestamp are irrelevant.
          const matches = record.type === copied?.type && isDeepStrictEqual(copiedPayload(record), copiedPayload(copied));
          if (!matches) {
            const field = record.type === copied?.type ? 'payload' : 'type';
            prefixFailure = {
              check: 'carrier-' + field, index, path: '/' + field,
              expected: field === 'payload' ? copiedPayload(record) : record.type,
              actual: field === 'payload' ? copiedPayload(copied) : copied?.type,
              sourceRecord: sourceProof.records[record.__line],
              childRecord: (loaded.records || [])[copied?.__line],
            };
          }
          return matches;
        });
      if (!completePrefix) {
        this._logCodexForkPrefixFailure({ ...diagnosticContext,
          counts: { ...diagnosticContext.counts,
            sourceTimelineEntries: sourceTimeline.length, childPrefixEntries: childPrefix.length,
            expectedCarriers: expectedCarriers.length, actualCarriers: actualCarriers.length,
          },
          failure: prefixFailure || (sourceTimeline.length !== normalized.entryUuids.length
            ? { check: 'snapshot-entry-count', path: '/length', expected: normalized.entryUuids.length, actual: sourceTimeline.length }
            : childPrefix.length !== sourceTimeline.length
              ? { check: 'child-prefix-count', path: '/length', expected: sourceTimeline.length, actual: childPrefix.length }
              : { check: 'carrier-count', path: '/length', expected: expectedCarriers.length, actual: actualCarriers.length }),
        });
        return { required: true, success: false, reason: reasonPrefix + '-materialized-prefix-mismatch' };
      }
      this.codexForkPrefixDiagnosticSignatures.delete(JSON.stringify([childTabId, childSessionId, operationKind]));
      const entryUuids = childPrefix.map((entry) => String(entry?.uuid || '')).filter(Boolean);
      return {
        required: true,
        success: true,
        storageMode: 'materialized',
        event: {
          provider: 'codex',
          sourceSessionId: normalized.sourceSessionId,
          childSessionId,
          entryUuids,
          entryMappings: sourceTimeline.map((entry, index) => ({
            sourceUuid: entry.uuid, childUuid: childPrefix[index].uuid,
          })),
          sourceSnapshotProof: normalized,
          boundaryEntryUuid: entryUuids.at(-1) || null,
          snapshotComplete: true,
          afterIterationIndex: Number.isInteger(expectedUserCount) && expectedUserCount > 0
            ? expectedUserCount - 1
            : null,
          nextIterationIndex: Number.isInteger(expectedUserCount) && expectedUserCount >= 0
            ? expectedUserCount
            : null,
          occurredAt: meta.timestamp || normalized.capturedAt || null,
          forkMode: operationKind === 'fork' ? 'full' : 'rewind',
          operationKind,
          origin: 'app',
          isDirect: true,
          childTabId,
        },
      };
    }
    const childTailStart = await this.captureCodexForkChildTailStart({
      sourceSessionId: normalized.sourceSessionId, childSessionId, cwd,
    });
    const event = buildCodexLaunchForkEvent({
      snapshot: normalized, childSessionId, childTabId, childTailStart, operationKind,
    });
    if (!event?.lineageManifest) {
      return { required: true, success: false, reason: reasonPrefix + '-lineage-manifest-invalid' };
    }
    const projected = await this._projectCodexVirtual({ descriptor: {
      viewOwnerSessionId: childSessionId,
      eventKey: event.eventKey || `fork:codex:${normalized.sourceSessionId}:${childSessionId}`,
      manifest: event.lineageManifest,
      payloadPolicy: 'dehydrated',
    } }, cwd);
    if (!projected.success) return { required: true, success: false, reason: projected.lineageReason };
    return { required: true, success: true, storageMode: 'virtual', event };
  }

  async prepareCodexRewindLineageFromSnapshot(payload = {}) {
    return this._prepareCodexLineageFromSnapshot({ ...payload, operationKind: 'rewind' });
  }

  async prepareCodexNativeForkLineageFromSnapshot(payload = {}) {
    return this._prepareCodexLineageFromSnapshot({ ...payload, operationKind: 'fork' });
  }

  async _ensureCodexProviderForkLineage(payload = {}) {
    const prepared = await this.prepareCodexProviderForkLineage(payload);
    if (!prepared.required || !prepared.success || prepared.alreadyPersisted) return prepared;
    if (!this.sessionHistoryStore?.saveSessionForkEvent) {
      return { ...prepared, success: false, reason: 'lineage-store-unavailable' };
    }
    try {
      const saved = this.sessionHistoryStore.saveSessionForkEvent(prepared.event);
      const manifest = normalizeCodexForkLineageManifest(saved?.lineageManifest, {
        sourceSessionId: prepared.event.sourceSessionId,
        childSessionId: prepared.event.childSessionId,
      });
      if (!manifest || saved?.snapshotComplete === false) {
        return { ...prepared, success: false, reason: 'lineage-store-did-not-commit' };
      }
      this.notifyCodexLineageCommitted(prepared.event.childSessionId);
      console.log('[CodexForkLineage] provider history_base recovered child=' + shortId(prepared.event.childSessionId)
        + ' source=' + shortId(prepared.event.sourceSessionId)
        + ' entries=' + prepared.event.entryUuids.length
        + ' segments=' + manifest.sourceSegments.length
        + ' endByte=' + prepared.providerHistoryBase.endByteOffset);
      return { ...prepared, event: saved, alreadyPersisted: false };
    } catch (error) {
      return { ...prepared, success: false, reason: error?.message || String(error) };
    }
  }

  async captureCodexForkChildTailStart({ sourceSessionId, childSessionId, cwd } = {}) {
    const api = this.codexData?._api;
    if (!sourceSessionId || !childSessionId || !api?.findCodexSessionFile || !api?.readJsonlRange) return null;
    const found = await api.findCodexSessionFile(childSessionId, cwd);
    if (!found?.filePath) return null;
    const stat = await fs.promises.stat(found.filePath);
    const headEnd = Math.min(stat.size, 4 * 1024 * 1024);
    const parsed = headEnd > 0
      ? await api.readJsonlRange(found.filePath, 0, headEnd - 1)
      : { records: [], errors: 0, leftoverBuffer: Buffer.alloc(0), lineCount: 0 };
    if (parsed.errors > 0 || (headEnd === stat.size && parsed.leftoverBuffer?.length > 0)) return null;
    const rootMeta = (parsed.records || []).find((record) => record?.type === 'session_meta')?.payload || null;
    if (String(rootMeta?.id || '') !== childSessionId
      || String(rootMeta?.forked_from_id || '') !== sourceSessionId) {
      return null;
    }
    const isPrelude = (record) => (
      record?.type === 'session_meta'
      || (record?.type === 'event_msg' && record?.payload?.type === 'thread_settings_applied')
    );
    const firstTailRecord = (parsed.records || []).find((record) => !isPrelude(record));
    if (!firstTailRecord && headEnd < stat.size) return null;
    const byteOffset = firstTailRecord ? Number(firstTailRecord.__byteOffset) : stat.size;
    const prefix = await hashFileSegment(found.filePath, 0, byteOffset);
    return {
      byteOffset,
      line: firstTailRecord ? Number(firstTailRecord.__line) : parsed.lineCount,
      prefixDigest: prefix.sha256,
    };
  }

  async resolveCodexPhysicalRow({
    sessionId,
    cwd,
    expectedContentRevision,
    entryRef,
  } = {}) {
    if (this.historyReader) return this.historyReader.call('resolveCodexPhysicalRow', { sessionId, cwd, expectedContentRevision, entryRef });
    const recovery = await this.ensureCodexProviderForkLineage({ childSessionId: sessionId, cwd });
    if (recovery.required && !recovery.success) {
      return { success: false, error: 'lineage_unresolved', lineageReason: recovery.reason };
    }
    const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
    if (lineage.kind !== 'virtual') {
      return { success: false, error: 'composite_transcript_required' };
    }
    const projected = await this._projectCodexVirtual(lineage, cwd);
    if (!projected?.success) return projected;
    const contentRevision = this._buildCodexContentRevision(sessionId, cwd, projected);
    if (!expectedContentRevision || contentRevision?.token !== expectedContentRevision) {
      return { success: false, error: 'stale_transcript_revision', revision: contentRevision };
    }
    const physicalSessionId = String(entryRef?.physicalSessionId || '');
    const rawUuid = String(entryRef?.rawUuid || '');
    const sourceIdentity = String(entryRef?.sourceIdentity || '');
    const index = (projected.timelineEntries || []).findIndex((entry) => (
      entry?.physicalSessionId === physicalSessionId
      && entry?.uuid === rawUuid
      && (!sourceIdentity || entry?.sourceIdentity === sourceIdentity)
    ));
    if (index < 0) return { success: false, error: 'physical_entry_not_found' };
    const userEntries = (projected.timelineEntries || []).filter((entry) => entry?.type === 'user');
    const logicalUserIndex = userEntries.findIndex((entry) => (
      entry?.physicalSessionId === physicalSessionId
      && entry?.uuid === rawUuid
      && (!sourceIdentity || entry?.sourceIdentity === sourceIdentity)
    ));
    return {
      success: true,
      viewOwnerSessionId: sessionId,
      contentRevision,
      entry: projected.timelineEntries[index],
      logicalIndex: index,
      logicalUserIndex,
      rewindableCount: userEntries.length,
    };
  }

  async copyCodexVirtualRange({
    sessionId,
    cwd,
    expectedContentRevision,
    startEntryRef,
    endEntryRef,
    copyOptions = {},
  } = {}) {
    if (this.historyReader) return this.historyReader.call('copyCodexVirtualRange', { sessionId, cwd, expectedContentRevision, startEntryRef, endEntryRef, copyOptions });
    const recovery = await this.ensureCodexProviderForkLineage({ childSessionId: sessionId, cwd });
    if (recovery.required && !recovery.success) {
      return { success: false, error: 'lineage_unresolved', lineageReason: recovery.reason };
    }
    const lineage = this._resolveCodexLineage(sessionId, 'full');
    if (lineage.kind !== 'virtual') {
      return { success: false, error: 'composite_transcript_required' };
    }
    const projected = await this._projectCodexVirtual(lineage, cwd);
    if (!projected?.success) return projected;
    const contentRevision = this._buildCodexContentRevision(sessionId, cwd, projected);
    if (!expectedContentRevision || contentRevision?.token !== expectedContentRevision) {
      return { success: false, error: 'stale_transcript_revision', revision: contentRevision };
    }
    const matchesRef = (entry, ref) => (
      entry?.physicalSessionId === String(ref?.physicalSessionId || '')
      && entry?.uuid === String(ref?.rawUuid || '')
      && (!ref?.sourceIdentity || entry?.sourceIdentity === ref.sourceIdentity)
    );
    const timeline = projected.timelineEntries || [];
    const startIndex = timeline.findIndex((entry) => matchesRef(entry, startEntryRef));
    const endIndex = timeline.findIndex((entry) => matchesRef(entry, endEntryRef));
    if (startIndex < 0 || endIndex < 0) {
      return { success: false, error: 'physical_entry_not_found' };
    }
    const store = this._getCodexVirtualTranscriptStore();
    const raw = await store.readRecords(lineage.descriptor, cwd);
    if (copyOptions?.assistantOnly === true) {
      const context = this.codexData._api.buildCodexTurnAssistantContext(
        raw.records,
        sessionId,
        timeline[startIndex].uuid,
        copyOptions.maxChars,
      );
      return context?.success
        ? {
            ...context,
            viewOwnerSessionId: sessionId,
            contentRevision: contentRevision.token,
            composite: true,
          }
        : context;
    }
    const result = this.codexData._api.buildCodexRangeExport(
      raw.records,
      sessionId,
      cwd,
      {
        ...copyOptions,
        virtualSessionMeta: {
          id: sessionId,
          forked_from_id: projected.manifest.sourceSessionId,
          cwd,
        },
      },
      timeline[startIndex].uuid,
      timeline[endIndex].uuid,
    );
    return result?.success
      ? {
          ...result,
          viewOwnerSessionId: sessionId,
          contentRevision: contentRevision.token,
          composite: true,
        }
      : result;
  }

  async exportCodexSession({ sessionId, cwd, copyOptions = {} } = {}) {
    if (this.historyReader) return this.historyReader.call('exportCodexSession', { sessionId, cwd, copyOptions });
    if (!sessionId) return { success: false, error: 'sessionId required' };
    const recovery = await this.ensureCodexProviderForkLineage({ childSessionId: sessionId, cwd });
    if (recovery.required && !recovery.success) {
      return { success: false, error: 'lineage_unresolved', lineageReason: recovery.reason };
    }
    const lineage = this._resolveCodexLineage(sessionId, 'full');
    if (lineage.kind === 'unresolved') {
      return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason };
    }
    if (lineage.kind === 'virtual') {
      const projected = await this._projectCodexVirtual(lineage, cwd);
      if (!projected?.success) return projected;
      const raw = await this._getCodexVirtualTranscriptStore().readRecords(lineage.descriptor, cwd);
      return {
        success: true,
        content: this.codexData._api.buildCodexCleanExport(
          raw.records,
          sessionId,
          cwd,
          {
            ...copyOptions,
            virtualSessionMeta: {
              id: sessionId,
              forked_from_id: projected.manifest.sourceSessionId,
              cwd,
            },
          },
        ),
        viewOwnerSessionId: sessionId,
        contentRevision: this._buildCodexContentRevision(sessionId, cwd, projected)?.token || null,
        composite: true,
      };
    }
    const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
    if (!loaded?.success) return loaded || { success: false, error: 'session not found' };
    return {
      success: true,
      content: this.codexData._api.buildCodexCleanExport(
        loaded.records || [],
        sessionId,
        cwd,
        copyOptions,
      ),
      filePath: loaded.filePath,
    };
  }

  /**
   * Cmd+F over the FULL projection, in the read service (worker in desktop).
   *
   * The panel used to scan `entry.content` of every row it held. With
   * row-level hydration a far-away row travels as an identity stub, so a
   * renderer-side scan would silently miss matches — worse than slow: the
   * user would conclude the text is not there. This service can obtain the
   * whole projection independently of the renderer's current window.
   *
   * Returns row identities + offsets only, never row content: the caller
   * scrolls to the row, and hydration delivers the text through the normal
   * window path.
   */
  async searchHistory(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('searchHistory', payload);
    const sessionId = payload.sessionId;
    const query = typeof payload.query === 'string' ? payload.query : '';
    if (!sessionId) return { success: false, error: 'sessionId required', matches: [] };
    const searchType = normalizeHistorySearchType(payload.type);
    if (!query && searchType === 'all') return { success: true, ...searchHistoryEntries([], payload) };
    if (toolType !== 'codex') {
      // Claude keeps its renderer-side scan: its projections are small enough
      // to hold whole, and it has no row-window path yet.
      return { success: false, error: 'search unsupported for this toolType', matches: [] };
    }
    const projectFromFile = this.codexData?._api?.projectCodexFullHistoryFromFile;
    if (typeof projectFromFile !== 'function') {
      return { success: false, error: 'codex projector unavailable', matches: [] };
    }
    const startedAt = Date.now();
    const recovery = await this.ensureCodexProviderForkLineage({
      childSessionId: sessionId,
      cwd: payload.cwd,
      childTabId: payload.tabId || null,
    });
    if (recovery.required && !recovery.success) {
      return {
        success: false,
        error: 'lineage_unresolved',
        lineageReason: recovery.reason,
        matches: [],
      };
    }
    const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
    if (lineage.kind === 'unresolved') {
      return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, matches: [] };
    }
    const projected = lineage.kind === 'virtual'
      ? await this._projectCodexVirtual(lineage, payload.cwd)
      : await projectFromFile(sessionId, payload.cwd);
    if (!projected?.success) return { success: false, error: projected?.error || 'projection failed', matches: [] };
    const limit = Math.max(1, Math.min(5000, Number(payload.limit) || 2000));
    const contentRevision = lineage.kind === 'virtual'
      ? this._buildCodexContentRevision(sessionId, payload.cwd, projected)
      : null;
    const entries = lineage.kind === 'virtual'
      ? this._decorateCodexContentRevision(projected.historyEntries, contentRevision)
      : (projected.entries || []);
    if (lineage.kind === 'physical' && entries.length === 0 && lineage.legacyForkEvent
      && !isProvenEmptyCodexHistoryRewrite(lineage.legacyForkEvent, projected.sessionMeta)) {
      return {
        success: false,
        error: 'lineage_unresolved',
        lineageReason: 'legacy-fork-event-without-raw-manifest',
        matches: [],
      };
    }
    const searchResult = searchHistoryEntries(entries, { query, type: searchType, limit, offset: payload.offset });
    const { matches, total } = searchResult;
    console.log('[TranscriptService:HistorySearch] session=' + shortId(sessionId)
      + ' rows=' + entries.length
      + ' matches=' + total
      + ' returned=' + matches.length
      + ' ms=' + (Date.now() - startedAt));
    return {
      success: true,
      ...searchResult,
      rows: entries.length,
      contentRevision: contentRevision?.token || null,
      viewOwnerSessionId: sessionId,
      composite: lineage.kind === 'virtual',
    };
  }

  async subscribe(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    const { sessionId, cwd, tabId } = payload;
    if (!sessionId || toolType === 'gemini') {
      return { success: false, error: !sessionId ? 'sessionId required' : 'gemini unsupported' };
    }
    const consumerId = payload.consumerId || `${tabId || 'unknown'}:${toolType}:${sessionId}:default`;
    const key = transcriptKey(toolType, sessionId, cwd);
    const prevKey = this.consumerToKey.get(consumerId);
    if (prevKey && prevKey !== key) this._removeConsumer(prevKey, consumerId);
    const ensureStartedAt = Date.now();
    const wasParked = this.sessions.get(key)?.idleTimer != null;
    const state = await this._ensureState({ key, toolType, sessionId, cwd });
    const reclaimedFromIdle = wasParked;
    const ensureMs = Date.now() - ensureStartedAt;
    if (ensureMs > 50) {
      // Attribution probe for external IpcSlow reports on this channel: when
      // this line is ABSENT next to a slow subscribe, the handler's own work
      // was cheap and the measured latency was queue-wait behind another
      // main-loop blocker — look for the concurrent sync op, not here.
      console.log('[TranscriptService:SubscribeSlow] tool=' + toolType
        + ' session=' + shortId(sessionId)
        + ' ensureMs=' + ensureMs
        + ' cachedState=' + (this.sessions.get(key) === state && ensureMs < 5 ? '1' : '0'));
    }
    state.consumers.set(consumerId, { tabId: tabId || null, consumerId });
    this.consumerToKey.set(consumerId, key);
    this._startWatcher(state);
    if (reclaimedFromIdle) {
      // Appends that landed during the quiet window were deliberately not
      // broadcast. Catch up now, once, so the returning surface sees the same
      // tail a never-parked state would have had.
      this._scheduleRead(state, 'idle-reclaim');
    } else if (toolType === 'claude' || (toolType === 'codex' && this.onCodexContextObservation)) {
      // Close the stat -> fs.watch arm window. An append can land after the
      // initial tail seed but before the watcher exists; one joined read makes
      // that boundary monotonic without polling the transcript.
      this._scheduleRead(state, 'subscribe-catch-up');
    }
    console.log('[TranscriptService:Subscribe] key=' + shortId(sessionId) +
      ' tool=' + toolType +
      ' tab=' + shortId(tabId, 12) +
      ' consumers=' + state.consumers.size +
      ' file=' + (state.filePath ? path.basename(state.filePath) : 'none'));
    return { success: true, ...this._stateMeta(state), consumerId };
  }

  async unsubscribe(payload = {}) {
    const consumerId = payload.consumerId;
    if (!consumerId) return { success: false, error: 'consumerId required' };
    const key = this.consumerToKey.get(consumerId);
    if (!key) return { success: true, removed: false };
    this._removeConsumer(key, consumerId);
    this.consumerToKey.delete(consumerId);
    return { success: true, removed: true };
  }

  // A fresh Claude session may become discoverable only AFTER its first
  // assistant row was written. Replay that hook-bounded range to the preview
  // observer, without replaying user prompts, lifecycle or renderer events.
  // The shared tail cursor remains untouched; a concurrent append still owns
  // its normal live fan-out. Exact UUID/message receipts make overlap harmless.
  async replayClaudePreview({ consumerId, fromByteOffset, isCurrent } = {}) {
    const key = this.consumerToKey.get(consumerId);
    const state = this.sessions.get(key);
    const consumer = state?.consumers.get(consumerId);
    if (state?.toolType !== 'claude' || !consumer?.tabId || !state.filePath
      || !Number.isSafeInteger(fromByteOffset) || fromByteOffset < 0
      || typeof isCurrent !== 'function' || !isCurrent()) return false;
    const end = state.size;
    if (end <= fromByteOffset) return true;
    await this._broadcastClaudeDelta({
      ...state, size: end, offset: fromByteOffset, leftover: '',
      consumers: new Map([[consumerId, consumer]]),
    }, fromByteOffset, { previewOnly: true, isCurrent });
    console.log('[TranscriptService:ClaudePreviewCatchup] tab=' + shortId(consumer.tabId)
      + ' session=' + shortId(state.sessionId) + ' from=' + fromByteOffset + ' to=' + end);
    return true;
  }

  async refresh(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (!payload.sessionId || toolType === 'gemini') return { success: false, error: 'unsupported transcript' };
    const key = transcriptKey(toolType, payload.sessionId, payload.cwd);
    const state = await this._ensureState({ key, toolType, sessionId: payload.sessionId, cwd: payload.cwd });
    if (state.refreshInflight) return state.refreshInflight;
    const refresh = (async () => {
      const changed = await this._refreshFile(state);
      if (changed) this._emitChanged(state, payload.reason || 'manual-refresh');
      return { success: true, changed, ...this._stateMeta(state) };
    })();
    state.refreshInflight = refresh;
    try {
      return await refresh;
    } finally {
      if (state.refreshInflight === refresh) state.refreshInflight = null;
    }
  }

  notifyCodexLineageCommitted(childSessionId) {
    this.historyReader?.lineageCommitted(childSessionId);
    const exactSessionId = String(childSessionId || '').trim();
    if (!exactSessionId) return false;
    let emitted = false;
    for (const state of this.sessions.values()) {
      if (state.toolType !== 'codex' || state.sessionId !== exactSessionId) continue;
      state.version += 1;
      this._emitChanged(state, 'lineage-committed');
      emitted = true;
    }
    if (emitted) return true;
    const meta = {
      type: 'transcript-changed',
      toolType: 'codex',
      sessionId: exactSessionId,
      version: 1,
      size: 0,
      mtimeMs: 0,
      filePath: null,
      reason: 'lineage-committed',
    };
    const mainWindow = this.getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-transcript:changed', meta);
    }
    if (this.onChanged) {
      try { void Promise.resolve(this.onChanged(meta)).catch(() => {}); } catch {}
    }
    return true;
  }

  async getTimeline(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('getTimeline', payload);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', entries: [] };
    if (toolType === 'codex') {
      const lineageRecovery = await this.ensureCodexProviderForkLineage({
        childSessionId: sessionId,
        cwd,
        childTabId: payload.tabId || null,
      });
      if (lineageRecovery.required && !lineageRecovery.success) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: lineageRecovery.reason,
          entries: [],
        };
      }
      const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
      if (lineage.kind === 'unresolved') {
        return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, entries: [] };
      }
      const virtualProjected = lineage.kind === 'virtual'
        ? (await this._readVirtualProjection(lineage, cwd))?.projection || await this._projectCodexVirtual(lineage, cwd)
        : null;
      if (virtualProjected && !virtualProjected.success) return { ...virtualProjected, entries: [] };
      const contentRevision = virtualProjected
        ? this._buildCodexContentRevision(sessionId, cwd, virtualProjected)
        : null;
      const presentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const revisionContext = JSON.stringify({
        promptPresentationRevision: presentationRevision,
        ...(contentRevision ? { contentRevision: contentRevision.token } : {}),
      });
      if (payload.ifRevision) {
        const validation = virtualProjected
          ? {
              unchanged: buildHistoryRevision(
                { toolType, sessionId, cwd },
                [...(virtualProjected.frozenSnapshots || []), virtualProjected.childSnapshot].filter(Boolean),
                { context: revisionContext },
              )?.token === payload.ifRevision?.token,
            }
          : await validateHistoryRevision(
              payload.ifRevision,
              { toolType, sessionId, cwd },
              {
                context: revisionContext,
                resolvePrimaryFile: async () => this._resolveFilePath(toolType, sessionId, cwd),
              }
            );
        const presentationStillCurrent = !validation.unchanged
          || !this.promptPresentationStore?.getHistoryPromptPresentationRevision
          || this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
            === presentationRevision;
        if (validation.unchanged && presentationStillCurrent) {
          return {
            success: true,
            unchanged: true,
            revision: payload.ifRevision,
            ...(virtualProjected ? {
              contentRevision: contentRevision?.token || null,
              viewOwnerSessionId: sessionId,
              composite: true,
            } : {}),
          };
        }
      }
      const startedAt = Date.now();
      // Same file-cursor projector family as getHistory: a Timeline refresh
      // of a live giant reads only the appended bytes. Falls back to
      // load+one-shot when the incremental API is absent (minimal stubs).
      const projectTimeline = this.codexData?._api?.projectCodexTimelineFromFile;
      let entries;
      let sessionMeta;
      let timelineFilePath;
      let timelineSnapshot = null;
      let timelineSnapshots = null;
      let loadedRecordCount = -1;
      if (virtualProjected) {
        entries = this._decorateCodexContentRevision(
          virtualProjected.timelineEntries,
          contentRevision,
        );
        sessionMeta = virtualProjected.sessionMeta;
        timelineFilePath = virtualProjected.filePath;
        timelineSnapshot = virtualProjected.childSnapshot || null;
        timelineSnapshots = [
          ...(virtualProjected.frozenSnapshots || []),
          virtualProjected.childSnapshot,
        ].filter(Boolean);
      } else if (typeof projectTimeline === 'function') {
        const projected = await projectTimeline(sessionId, cwd);
        if (!projected?.success) return projected || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = projected.entries;
        sessionMeta = projected.sessionMeta;
        timelineFilePath = projected.filePath;
        timelineSnapshot = projected.sourceSnapshot || null;
      } else {
        const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
        if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = this.codexData._api.buildCodexTimeline(loaded.records || [], sessionId);
        sessionMeta = this.codexData._api.getTimelineSessionMeta(loaded.records || []);
        timelineFilePath = loaded.filePath;
        timelineSnapshot = loaded.sourceSnapshot || null;
        loadedRecordCount = loaded.records?.length || 0;
      }
      const loadedAt = Date.now();
      if (!virtualProjected) {
        try {
          const snapshot = deriveCodexForkSnapshot(entries, sessionMeta);
          if (snapshot && this.sessionHistoryStore?.saveSessionForkEvent) {
            this.sessionHistoryStore.saveSessionForkEvent({
              provider: 'codex',
              sourceSessionId: snapshot.sourceSessionId,
              childSessionId: sessionId,
              entryUuids: snapshot.entryUuids,
              boundaryEntryUuid: snapshot.boundaryEntryUuid,
              snapshotComplete: snapshot.snapshotComplete,
              occurredAt: snapshot.occurredAt,
              forkMode: 'unknown',
              origin: 'transcript',
              isDirect: true,
            });
          }
        } catch (historyEventError) {
          console.warn('[TranscriptService] Codex fork event reconcile failed session=' + shortId(sessionId) + ': ' + historyEventError.message);
        }
      }
      if (!virtualProjected && entries.length === 0 && lineage.legacyForkEvent
        && !isProvenEmptyCodexHistoryRewrite(lineage.legacyForkEvent, sessionMeta)) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: 'legacy-fork-event-without-raw-manifest',
          entries: [],
        };
      }
      const promptSnapshot = decoratePromptSnapshot(this, { toolType, sessionId, entries });
      const presentedEntries = promptSnapshot.entries;
      const finalPresentationRevision = promptSnapshot.revision;
      const revision = buildHistoryRevision(
        { toolType, sessionId, cwd },
        timelineSnapshots || (timelineSnapshot ? [timelineSnapshot] : []),
        {
          context: JSON.stringify({
            promptPresentationRevision: finalPresentationRevision,
            ...(contentRevision ? { contentRevision: contentRevision.token } : {}),
          }),
        }
      );
      const finishedAt = Date.now();
      if (finishedAt - startedAt >= 50) {
        console.log('[TranscriptService:TimelineProjection] tool=codex' +
          ' session=' + shortId(sessionId) +
          (loadedRecordCount >= 0 ? ' records=' + loadedRecordCount : '') +
          ' entries=' + presentedEntries.length +
          ' loadMs=' + (loadedAt - startedAt) +
          ' projectMs=' + (finishedAt - loadedAt) +
          ' totalMs=' + (finishedAt - startedAt));
      }
      return {
        success: true,
        unchanged: false,
        entries: presentedEntries,
        sessionMeta,
        sessionBoundaries: [],
        claudeMemoryBoundaryUuid: null,
        filePath: timelineFilePath,
        revision,
        ...(virtualProjected ? {
          contentRevision: contentRevision?.token || null,
          viewOwnerSessionId: sessionId,
          composite: true,
        } : {}),
      };
    }
    const getClaudeTimeline = this.claudeData?._api?.getTimeline;
    if (typeof getClaudeTimeline === 'function') {
      const projected = await getClaudeTimeline({
        ...payload,
        sessionId,
        cwd,
        source: payload.source || 'transcript-service',
      });
      return {
        ...(projected || {}),
        sessionId,
        toolType,
      };
    }
    // Compatibility for minimal test doubles / older embedded providers. The
    // production module always exposes getTimeline above, so public HTTP/iOS
    // requests reuse the incremental reader instead of this legacy full parse.
    const found = this.claudeData?.findSessionFile?.(sessionId, cwd);
    if (!found) return { success: true, entries: [], sessionId, toolType };
    const entries = this.claudeData.parseTimelineEntries(found.filePath);
    return {
      success: true,
      entries: decorateHistoryPromptPresentations(this.promptPresentationStore, {
        toolType,
        sessionId,
        entries,
        recoverManagedImageRef: this.recoverManagedHistoryImageRef,
      }),
      sessionId,
      toolType,
      filePath: found.filePath,
    };
  }

  async getHistory(payload = {}, sourceAttempt = 0, onPayload = null) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('getHistory', payload);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', entries: [] };
    if (toolType === 'codex') {
      // Cross-owner reuse needs an explicit committed rewrite receipt, not
      // same text, a parent id, or a renderer-supplied "trust me" mapping.
      let rewriteReceipt = this.codexData?._api?.getCodexRewriteReceipt?.(
        sessionId, payload.rewriteFrom?.sessionId,
      ) || null;
      if (rewriteReceipt) {
        const previous = payload.rewriteFrom?.revision;
        const source = rewriteReceipt.sourceSnapshot;
        const target = rewriteReceipt.targetSnapshot;
        const witness = previous?.sources?.[0];
        const valid = previous?.sources?.length === 1 && source
          && isWellFormedRevision(previous, { toolType, sessionId: rewriteReceipt.sourceSessionId, cwd })
          && witness.filePath === source.filePath && witness.size === source.size
          && witness.mtimeMs === source.mtimeMs
          && witness.fileIdentity === String(source.fileIdentity || '')
          && witness.ctimeMs === (Number.isFinite(source.ctimeMs) ? source.ctimeMs : null);
        const stat = valid ? await fs.promises.stat(target.filePath).catch(() => null) : null;
        if (!stat || stat.size !== target.size || stat.mtimeMs !== target.mtimeMs
          || (target.fileIdentity && target.fileIdentity !== stat.dev + ':' + stat.ino)
          || (Number.isFinite(target.ctimeMs) && target.ctimeMs !== stat.ctimeMs)) rewriteReceipt = null;
        else if (payload.hydrate?.centerUuid) {
          const mapping = createProjectionIdentityMap(rewriteReceipt.sourceSessionId, sessionId, rewriteReceipt.records);
          let centerUuid = null;
          try { centerUuid = mapping.identity(payload.hydrate.centerUuid); } catch { /* removed target → tail */ }
          payload = { ...payload, hydrate: { ...payload.hydrate, centerUuid } };
        }
      }
      const lineageRecovery = await this.ensureCodexProviderForkLineage({
        childSessionId: sessionId,
        cwd,
        childTabId: payload.tabId || null,
      });
      if (lineageRecovery.required && !lineageRecovery.success) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: lineageRecovery.reason,
          entries: [],
        };
      }
      const lineage = this._resolveCodexLineage(
        sessionId,
        payload.dehydrate === true ? 'dehydrated' : 'full',
      );
      if (lineage.kind === 'unresolved') {
        return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, entries: [] };
      }
      const virtualPage = lineage.kind === 'virtual' ? await this._readVirtualHistoryPage(lineage, payload) : null;
      const virtualProjected = lineage.kind === 'virtual'
        ? virtualPage?.projection || await this._projectCodexVirtual(lineage, cwd)
        : null;
      if (virtualProjected && !virtualProjected.success) return { ...virtualProjected, entries: [] };
      const contentRevision = virtualProjected
        ? this._buildCodexContentRevision(sessionId, cwd, virtualProjected)
        : null;
      // File identity alone cannot describe a row-window response. The file
      // may be unchanged while the visible range asks main to turn a different
      // set of identity stubs into full rows. Bind that projection identity to
      // the revision so the O(stat) unchanged path remains valid only for the
      // SAME hydration request.
      const rowWindowRequest = normalizeHistoryRowWindowRequest(payload.hydrate);
      const entryWindowRequest = normalizeHistoryEntryWindowRequest(payload.bounds);
      const payloadPolicy = payload.payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND
        ? HISTORY_PAYLOAD_ON_DEMAND : payload.dehydrate === true ? 'dehydrated' : 'full';
      const ownershipRevision = getCodexProcessActionOwnershipRevision([sessionId,
        ...(virtualProjected?.frozenSnapshots || []).map(source => source.sessionId)]);
      const presentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const responseTimingRevision = this.promptPresentationStore?.getHistoryResponseTimingRevision
        ? this.promptPresentationStore.getHistoryResponseTimingRevision(toolType, sessionId, payload.tabId || null)
        : 'none';
      const revisionContext = JSON.stringify({
        promptPresentationRevision: presentationRevision,
        responseTimingRevision,
        rowWindowRequest,
        entryWindowRequest,
        payloadPolicy,
        ...(payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND ? { payloadHeaderVersion: HISTORY_PAYLOAD_HEADER_VERSION } : {}),
        ownershipRevision,
        ...(contentRevision ? { contentRevision: contentRevision.token } : {}),
      });
      if (payload.ifRevision) {
        const validation = virtualProjected
          ? {
              unchanged: buildHistoryRevision(
                { toolType, sessionId, cwd },
                [...(virtualProjected.frozenSnapshots || []), virtualProjected.childSnapshot].filter(Boolean),
                { context: revisionContext },
              )?.token === payload.ifRevision?.token,
            }
          : await validateHistoryRevision(
              payload.ifRevision,
              { toolType, sessionId, cwd },
              {
                context: revisionContext,
                resolvePrimaryFile: async () => this._resolveFilePath(toolType, sessionId, cwd),
              }
            );
        const presentationStillCurrent = !validation.unchanged
          || !this.promptPresentationStore?.getHistoryPromptPresentationRevision
          || this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
            === presentationRevision;
        const responseTimingStillCurrent = !validation.unchanged
          || !this.promptPresentationStore?.getHistoryResponseTimingRevision
          || this.promptPresentationStore.getHistoryResponseTimingRevision(toolType, sessionId, payload.tabId || null)
            === responseTimingRevision;
        if (validation.unchanged && presentationStillCurrent && responseTimingStillCurrent) {
          return {
            success: true,
            unchanged: true,
            revision: payload.ifRevision,
            ...(payload.freshnessProof === true ? { freshnessReadSources: virtualProjected?.physicalSources || payload.ifRevision.sources } : {}),
            ...(virtualProjected ? {
              contentRevision: contentRevision?.token || null,
              viewOwnerSessionId: sessionId,
              composite: true,
            } : {}),
          };
        }
      }
      // Incremental projection: a live-session refresh reads only the bytes
      // appended since the cached projector's file cursor instead of
      // re-loading and replaying all 74K records of a giant rollout
      // (~3.5s → ~ms), and does not require the parsed records array to stay
      // cached at all. Restricted to dehydrate consumers (desktop and
      // opt-in HTTP): dehydration mutates the cached projector's shared action
      // objects into previews+refs, which is stable across dehydrating calls
      // but would poison an ordinary full-payload consumer — those keep the
      // fresh one-shot build, as does getToolPayload's stash rebuild below
      // for the same reason. Falls back to load+one-shot when the
      // incremental API is absent (minimal test stubs).
      const projectFromFile = this.codexData?._api?.projectCodexFullHistoryFromFile;
      // The page store is worker-owned. A seek reads positional metadata and
      // selected bodies, without resurrecting an evicted parser. Its key also
      // covers sidecars: a pending timing or prompt edit cannot reuse old data.
      const preparedOwner = { sessionId, cwd, tabId: payload.tabId || null };
      const preparedContext = JSON.stringify({ presentationRevision, responseTimingRevision,
        ...(virtualProjected ? { contentRevision: contentRevision?.token || null } : {}) });
      if (virtualPage?.page && virtualPage.page.context !== preparedContext) {
        return sourceAttempt < 2 ? this.getHistory(payload, sourceAttempt + 1, onPayload)
          : { success: false, error: 'history_source_changed_during_preparation', entries: [] };
      }
      let prepared = virtualPage?.page || null;
      let basePrepared = virtualPage?.base || null;
      if (this.preparedHistoryStore && !virtualProjected && payload.dehydrate === true) {
        const filePath = await this._resolveFilePath(toolType, sessionId, cwd);
        const stat = filePath ? await fs.promises.stat(filePath).catch(() => null) : null;
        if (stat) prepared = this.preparedHistoryStore.readPrepared({
          owner: preparedOwner, filePath, stat, context: preparedContext, hydrate: rowWindowRequest,
        });
        if (prepared && !this.codexData._api.restoreCodexSourceSnapshot(prepared.source)) prepared = null;
        if (!prepared && stat) {
          // Sidecar changes require the canonical rows for matching/binding,
          // never a parser graph. Full candidates preserve offscreen timing
          // ownership and inherited UUID semantics.
          basePrepared = this.preparedHistoryStore.readPrepared({ owner: preparedOwner,
            filePath, stat, context: 'canonical', kind: 'base' });
          if (basePrepared && !this.codexData._api.restoreCodexSourceSnapshot(basePrepared.source)) basePrepared = null;
        }
      }
      let entries;
      let loadedFilePath;
      let projectedSessionMeta = null;
      let projectedSnapshot = null;
      let projectedSnapshots = null;
      if (prepared || basePrepared) {
        const page = prepared || basePrepared;
        entries = virtualProjected ? this._decorateCodexContentRevision(page.entries, contentRevision) : page.entries;
        for (const ref of page.assets || []) this.recoverManagedHistoryImageRef?.(ref);
        this.codexData._api.refreshCodexSubagentCards?.(
          entries.flatMap(entry => (entry.actions || []).filter(action => action.tool === 'Task')), sessionId,
        );
        loadedFilePath = page.source.filePath;
        projectedSnapshot = page.source;
        projectedSessionMeta = page.sessionMeta;
        if (virtualProjected) projectedSnapshots = [...virtualProjected.frozenSnapshots, virtualProjected.childSnapshot];
      } else if (virtualProjected) {
        entries = this._decorateCodexContentRevision(
          virtualProjected.historyEntries,
          contentRevision,
        );
        loadedFilePath = virtualProjected.filePath;
        projectedSnapshot = virtualProjected.childSnapshot || null;
        projectedSnapshots = [
          ...(virtualProjected.frozenSnapshots || []),
          virtualProjected.childSnapshot,
        ].filter(Boolean);
      } else if (payload.dehydrate === true && typeof projectFromFile === 'function') {
        const projected = await projectFromFile(sessionId, cwd, {
          tabId: payload.tabId,
          cacheOnly: payload.rewriteBaselineOnly === true,
          hydrate: rowWindowRequest,
        });
        if (!projected?.success) return projected || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = projected.entries;
        loadedFilePath = projected.filePath;
        projectedSessionMeta = projected.sessionMeta || null;
        projectedSnapshot = projected.sourceSnapshot || null;
      } else {
        const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
        if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = this.codexData._api.buildCodexFullHistory(loaded.records || [], sessionId);
        loadedFilePath = loaded.filePath;
        projectedSessionMeta = this.codexData._api.getTimelineSessionMeta?.(loaded.records || []) || null;
        projectedSnapshot = loaded.sourceSnapshot || null;
      }
      if (!virtualProjected && entries.length === 0 && lineage.legacyForkEvent
        && !isProvenEmptyCodexHistoryRewrite(lineage.legacyForkEvent, projectedSessionMeta)) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: 'legacy-fork-event-without-raw-manifest',
          entries: [],
        };
      }
      // Heavy payloads (tool outputs, thinking, compact snapshots) leave main
      // as previews + refs; the renderer pulls full text on expand through
      // history:get-tool-payload. OPT-IN per call: ordinary HTTP clients keep
      // full payloads; on-demand-v1 adds its detached bounded projection below.
      const sourceIsCurrent = () => (virtualProjected?.physicalSources || projectedSnapshots || [projectedSnapshot])
        .every(source => this.codexData?._api?.isCodexSourceSnapshotCurrent?.(source) !== false);
      const refreshChangedSource = () => sourceAttempt < 2
        ? this.getHistory(payload, sourceAttempt + 1, onPayload)
        : { success: false, error: 'history_source_changed_during_preparation', entries: [] };
      if (!sourceIsCurrent()) return refreshChangedSource();
      const payloadGeneration = projectedSnapshot?.sourceGeneration || projectedSnapshot?.fileIdentity || '';
      const prepareStart = performance.now();
      let preparePhaseAt = prepareStart;
      const preparePhases = {};
      const finishPreparePhase = (phase) => {
        const at = performance.now();
        preparePhases[phase] = Math.round((at - preparePhaseAt) * 10) / 10;
        preparePhaseAt = at;
      };
      const logPrepare = (shape) => {
        const at = performance.now();
        if (at - prepareStart < 24) return;
        console.log('[TranscriptService:HistoryPrepare] ' + JSON.stringify({
          session: shortId(sessionId), tab: String(payload.tabId || '-').slice(-12),
          rows: entries.length, shape, startAbs: performance.timeOrigin + prepareStart,
          endAbs: performance.timeOrigin + at, elapsedMs: Math.round((at - prepareStart) * 10) / 10,
          ...(!this.preparedHistoryStore ? { syncMs: Math.round((at - prepareStart) * 10) / 10 } : { yieldedCacheWork: true }),
          phases: preparePhases,
        }));
      };
      if (payload.dehydrate === true && !prepared) {
        const dehydration = dehydrateHistoryEntries({
          toolType,
          sessionId,
          entries,
          stash: historyPayloadStash,
        });
        if (dehydration.dehydrated > 0) {
          console.log('[TranscriptService:Dehydrate] session=' + sessionId.slice(0, 8)
            + ' payloads=' + dehydration.dehydrated
            + ' savedKb=' + Math.round(dehydration.savedChars / 1024));
        }
      }
      finishPreparePhase('dehydrate');
      if (this.preparedHistoryStore && payload.dehydrate === true && !prepared && !basePrepared) {
        await this.preparedHistoryStore.savePrepared({ owner: preparedOwner, source: projectedSnapshot,
          context: virtualProjected ? 'canonical:' + contentRevision.token : 'canonical', kind: 'base', entries, sessionMeta: projectedSessionMeta });
        finishPreparePhase('baseCache');
      }
      const promptSnapshot = prepared ? { entries, revision: presentationRevision, stable: true }
        : decoratePromptSnapshot(this, { toolType, sessionId, entries });
      const presentedEntries = promptSnapshot.entries;
      const capturedPresentationRevision = promptSnapshot.revision;
      const presentationStable = promptSnapshot.stable;
      finishPreparePhase('promptPresentation');
      let rowWindow = applyHistoryRowWindow(presentedEntries, rowWindowRequest);
      finishPreparePhase('rowWindow');
      let responseTimingBound = false;
      const persistPrepared = !!this.preparedHistoryStore && payload.dehydrate === true && !prepared;
      const timedWindow = prepared ? { entries: rowWindow.entries, revision: responseTimingRevision }
        : prepareHistoryResponseTimingWindow(this.promptPresentationStore, {
        toolType,
        sessionId,
        tabId: payload.tabId || null,
        entries: persistPrepared ? presentedEntries : rowWindow.entries,
        fullEntries: presentedEntries,
        onBound: () => {
          responseTimingBound = true;
        },
      });
      finishPreparePhase('responseTiming');
      if (persistPrepared) {
        if (presentationStable && !String(timedWindow.revision).startsWith('pending-binding:')) await this.preparedHistoryStore.savePrepared({ owner: preparedOwner, source: projectedSnapshot,
          context: JSON.stringify({ presentationRevision: capturedPresentationRevision, responseTimingRevision: timedWindow.revision,
            ...(virtualProjected ? { contentRevision: contentRevision?.token || null } : {}) }),
          entries: timedWindow.entries, sessionMeta: projectedSessionMeta });
        rowWindow = applyHistoryRowWindow(timedWindow.entries, rowWindowRequest);
      } else rowWindow = { ...rowWindow, entries: timedWindow.entries };
      if (persistPrepared) finishPreparePhase('preparedCache');
      if (responseTimingBound && payload.tabId) {
        const mainWindow = this.getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent-activity:timing-changed', {
            tabId: payload.tabId,
            busy: false,
            reason: 'history-response-bound',
          });
        }
      }
      // Decoration can bind pending prompt/timing rows to exact durable UUIDs.
      // Build the returned revision after those mutations so the renderer
      // never caches a token that predates the presentation it just received.
      const finalPresentationRevision = capturedPresentationRevision;
      const finalResponseTimingRevision = timedWindow.revision;
      const revision = buildHistoryRevision(
        { toolType, sessionId, cwd },
        projectedSnapshots || (projectedSnapshot ? [projectedSnapshot] : []),
        {
          context: JSON.stringify({
            promptPresentationRevision: finalPresentationRevision,
            responseTimingRevision: finalResponseTimingRevision,
            rowWindowRequest,
            entryWindowRequest,
            payloadPolicy,
            ...(payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND ? { payloadHeaderVersion: HISTORY_PAYLOAD_HEADER_VERSION } : {}),
            ownershipRevision,
            ...(contentRevision ? { contentRevision: contentRevision.token } : {}),
          }),
        }
      );
      finishPreparePhase('revision');
      // Row-level windowing: the row LIST stays full length (geometry,
      // anchors, mount wave and Timeline index lookup all address rows by
      // position), but rows outside the hydrated span travel as identity
      // stubs. A 15.5K-row giant costs ~150MB of presentation in the
      // renderer; stubs bring that to ~1.5MB + the hydrated span. Opt-in via
      // `hydrate` so web/iOS and any consumer without a stub renderer keep
      // full rows.
      if (rowWindow.rowWindowApplied) {
        console.log('[TranscriptService:HistoryRows] session=' + shortId(sessionId)
          + ' tab=' + String(payload.tabId || '-').slice(-12)
          + ' rows=' + rowWindow.total
          + ' hydrated=' + rowWindow.hydratedCount
          + ' stubbed=' + rowWindow.stubbedCount
          + ' span=' + rowWindow.hydratedFrom + '-' + rowWindow.hydratedTo
          + (rowWindow.centerMissing ? ' centerMissing=1' : ''));
      }
      const historyWindow = applyHistoryEntryWindow(rowWindow.entries, entryWindowRequest);
      const settingsBaseline = codexSettingsWindowBaseline(rowWindow.entries, historyWindow, {
        sessionId, revision, payloadGeneration, contentRevision: contentRevision?.token || null,
      });
      const freshnessFields = payload.freshnessProof === true
        ? { freshnessReadSources: virtualProjected?.physicalSources || revision?.sources } : {};
      if (payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND) historyWindow.entries = projectHistoryOnDemand({
        toolType, sessionId, entries: historyWindow.entries, onPayload,
      });
      finishPreparePhase('entryWindow');
      // Recheck against the actual projection cursor, not the pre-await stat.
      if (rewriteReceipt && (!projectedSnapshot
        || projectedSnapshot.size !== rewriteReceipt.targetSnapshot.size
        || projectedSnapshot.mtimeMs !== rewriteReceipt.targetSnapshot.mtimeMs
        || projectedSnapshot.fileIdentity !== rewriteReceipt.targetSnapshot.fileIdentity
        || projectedSnapshot.ctimeMs !== rewriteReceipt.targetSnapshot.ctimeMs
        || projectedSnapshot.filePath !== rewriteReceipt.targetSnapshot.filePath)) rewriteReceipt = null;
      // Delta transport. A live session refresh used to reship the ENTIRE
      // projection (15,352 rows / ~70MB for one appended tool result —
      // tab-3163, 06.08 11:37, LOAD_APPLY 4733ms during switch+scroll). When
      // the renderer proves it still holds the digest's exact revision, only
      // rows whose fingerprint moved travel; the renderer reassembles the
      // array from its previous object references (see history-delta.js).
      // Digest maintenance is opt-in (deltaOk) so web/iOS consumers that can
      // never use a delta don't pay the fingerprint pass.
      //
      // The digest describes the WINDOW the caller received, not the whole
      // projection — a windowed panel holds exactly those rows, and diffing
      // against anything else would name rows it cannot supply. A caller that
      // changes its window bounds gets a full window back (its digest is
      // keyed to the previous revision AND to that window's row set, so the
      // order comparison below fails closed).
      const deltaEligible = payload.deltaOk === true && !historyWindow.anchorMissing;
      if (deltaEligible) {
        const digestStartedAt = Date.now();
        // HTTP clients can hold different windows of the same tab. Keep their
        // baseline separate from desktop/other windows, without changing the
        // tab identity used by timing/chip decoration. Otherwise a wider reader
        // could "prove" an unchanged UUID the narrower client never received.
        const deltaOwner = payload.deltaConsumerId
          ? `${payload.tabId || ''}:consumer:${payload.deltaConsumerId}`
          : payload.tabId || null;
        const prevDigest = payload.ifRevision?.token
          ? this.historyDeltaDigests.get(toolType, sessionId, deltaOwner)
          : null;
        const matchedDigest = prevDigest && prevDigest.revisionToken === payload.ifRevision.token
          && prevDigest.payloadGeneration === payloadGeneration
          ? prevDigest
          : null;
        const diff = diffHistoryEntriesAgainstDigest(matchedDigest, historyWindow.entries);
        this.historyDeltaDigests.set(toolType, sessionId, deltaOwner, {
          revisionToken: revision?.token || '',
          payloadGeneration,
          order: diff.order,
          fingerprints: diff.fingerprints,
        });
        finishPreparePhase('digest');
        // A window whose first row is NEW to the digest is a different window
        // (scrolled up, jumped, or the tail slid past what the caller holds):
        // the caller cannot rebuild it from rows it never received, so send
        // the whole window instead of a delta.
        const windowIsContinuation = matchedDigest
          && diff.order.length > 0
          && matchedDigest.fingerprints.has(diff.order[0]);
        if (matchedDigest && revision?.token && windowIsContinuation) {
          logPrepare('delta');
          console.log('[TranscriptService:HistoryDelta] session=' + shortId(sessionId)
            + ' tab=' + String(payload.tabId || '-').slice(-12)
            + ' rows=' + historyWindow.entries.length
            + ' changed=' + diff.changed.length
            + ' unchanged=' + diff.unchangedCount
            + ' windowed=' + (historyWindow.boundsApplied ? '1' : '0')
            + ' diffMs=' + (Date.now() - digestStartedAt));
          return {
            success: true,
            unchanged: false,
            delta: true,
            changedEntries: diff.changed,
            order: diff.order,
            total: historyWindow.total,
            startIndex: historyWindow.startIndex,
            boundsApplied: historyWindow.boundsApplied,
            hasMoreAbove: historyWindow.hasMoreAbove,
            hasMoreBelow: historyWindow.hasMoreBelow,
            // Row-window identity travels on EVERY response shape. The
            // renderer used to infer "session not windowed" from these
            // fields' absence on a delta, which shut its hydration
            // machinery down for the rest of the session (prod 14.08 17:10:
            // Timeline jumps into stubs issued zero hydration requests).
            rowWindowApplied: rowWindow.rowWindowApplied,
            hydratedFrom: rowWindow.hydratedFrom,
            hydratedTo: rowWindow.hydratedTo,
            hydratedCount: rowWindow.hydratedCount,
            stubbedCount: rowWindow.stubbedCount,
            centerMissing: rowWindow.centerMissing === true,
            claudeMemoryBoundaryUuid: null,
            filePath: loadedFilePath,
            revision,
            payloadGeneration,
            settingsBaseline,
            ...freshnessFields,
            ...(virtualProjected ? {
              contentRevision: contentRevision?.token || null,
              viewOwnerSessionId: sessionId,
              composite: true,
            } : {}),
          };
        }
      }
      // No awaits occur in the stages above. Do not include the async rewrite
      // baseline below in this synchronous CPU/lane observation.
      logPrepare('full');
      if (historyWindow.boundsApplied) {
        console.log('[TranscriptService:HistoryWindow] session=' + shortId(sessionId)
          + ' tab=' + String(payload.tabId || '-').slice(-12)
          + ' rows=' + historyWindow.entries.length
          + ' total=' + historyWindow.total
          + ' startIndex=' + historyWindow.startIndex
          + ' above=' + (historyWindow.hasMoreAbove ? '1' : '0')
          + ' below=' + (historyWindow.hasMoreBelow ? '1' : '0')
          + (historyWindow.anchorMissing ? ' anchorMissing=1' : ''));
      }
      if (rewriteReceipt && payload.rewriteFrom?.revision && !historyWindow.boundsApplied) {
        // Build a baseline in-process from an ALREADY warm source, using the
        // exact window/revision the renderer holds. Do not re-read an evicted
        // ancestor just to optimize IPC. Full equality below (not the sampled
        // live-delta fingerprint) is the proof for carrying prefix row bodies.
        let oldHydrate = null;
        try { oldHydrate = JSON.parse(payload.rewriteFrom.revision.context || '{}').rowWindowRequest; } catch {}
        const baseline = await this.getHistory({
          toolType: 'codex', sessionId: rewriteReceipt.sourceSessionId, cwd, tabId: payload.tabId,
          dehydrate: true, hydrate: oldHydrate, rewriteBaselineOnly: true,
        });
        if (baseline.success && baseline.revision?.token === payload.rewriteFrom.revision.token) {
          const mapping = createProjectionIdentityMap(rewriteReceipt.sourceSessionId, sessionId, rewriteReceipt.records);
          const candidates = new Map();
          for (const row of baseline.entries || []) {
            try {
              const uuid = mapping.identity(row.uuid);
              if (uuid !== row.uuid) candidates.set(uuid, row);
            } catch { /* Changed suffix is never a carry candidate. */ }
          }
          const carriedEntries = [];
          const changedEntries = [];
          for (const [index, row] of historyWindow.entries.entries()) {
            const previous = candidates.get(row.uuid);
            let mapped = null;
            try { if (previous && hasProvenRewritePayloads(previous)) mapped = remapHistoryRowIdentity(previous, mapping); } catch { /* A removed alias/result is a changed row. */ }
            if (mapped && isDeepStrictEqual(mapped, row)) {
              carriedEntries.push({ sourceUuid: previous.uuid, uuid: row.uuid });
            } else changedEntries.push(row);
            if (index % 256 === 255) await new Promise((resolve) => setImmediate(resolve));
          }
          console.log('[TranscriptService:RewriteDelta] source=' + shortId(rewriteReceipt.sourceSessionId)
            + ' child=' + shortId(sessionId) + ' carried=' + carriedEntries.length + ' changed=' + changedEntries.length);
          if (!sourceIsCurrent()) return refreshChangedSource();
          return {
            success: true, rewriteDelta: true, rewriteReceipt, carriedEntries, changedEntries,
            order: historyWindow.entries.map((row) => row.uuid), revision,
            payloadGeneration,
            settingsBaseline,
            hydrationRequest: rowWindowRequest,
            ...freshnessFields,
          };
        }
      }
      return {
        success: true,
        unchanged: false,
        entries: historyWindow.entries,
        ...(rewriteReceipt ? { rewriteReceipt, hydrationRequest: rowWindowRequest } : {}),
        total: historyWindow.total,
        startIndex: historyWindow.startIndex,
        dropped: historyWindow.dropped,
        truncated: historyWindow.truncated,
        boundsApplied: historyWindow.boundsApplied,
        hasMoreAbove: historyWindow.hasMoreAbove,
        hasMoreBelow: historyWindow.hasMoreBelow,
        anchorMissing: historyWindow.anchorMissing === true,
        rowWindowApplied: rowWindow.rowWindowApplied,
        hydratedFrom: rowWindow.hydratedFrom,
        hydratedTo: rowWindow.hydratedTo,
        hydratedCount: rowWindow.hydratedCount,
        stubbedCount: rowWindow.stubbedCount,
        centerMissing: rowWindow.centerMissing === true,
        firstUuid: historyWindow.firstUuid,
        lastUuid: historyWindow.lastUuid,
        claudeMemoryBoundaryUuid: null,
        filePath: loadedFilePath,
        revision,
        payloadGeneration,
        settingsBaseline,
        ...freshnessFields,
        ...(virtualProjected ? {
          contentRevision: contentRevision?.token || null,
          viewOwnerSessionId: sessionId,
          composite: true,
        } : {}),
      };
    }
    const getFullHistory = this.claudeData?._api?.getFullHistory;
    if (typeof getFullHistory !== 'function') {
      return { success: false, error: 'claude history service unavailable', entries: [] };
    }
    const mainWindow = this.getMainWindow?.();
    const sender = mainWindow && !mainWindow.isDestroyed?.() ? mainWindow.webContents : null;
    const onDemand = payload.payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND;
    let baseRevision = payload.ifRevision;
    if (onDemand && baseRevision) {
      let context;
      try { context = JSON.parse(baseRevision.context); } catch {}
      baseRevision = context?.payloadPolicy === HISTORY_PAYLOAD_ON_DEMAND
        && context.payloadHeaderVersion === HISTORY_PAYLOAD_HEADER_VERSION
        && JSON.stringify(context.bounds) === JSON.stringify(normalizeHistoryEntryWindowRequest(payload.bounds))
        ? buildHistoryRevision({ toolType, sessionId, cwd }, baseRevision.sources, { context: context.base }) : null;
    }
    const result = await getFullHistory({
      ...payload,
      ...(onDemand ? { dehydrate: false, ifRevision: baseRevision } : {}),
      toolType: 'claude',
      sessionId,
      cwd,
      bounds: payload.bounds || null,
    }, { sender });
    if (payload.freshnessProof === true && result?.unchanged && !result.freshnessReadSources) {
      result.freshnessReadSources = result.revision?.sources;
    }
    if (!onDemand || !result?.success) return result;
    if (!(await validateHistoryRevision(result.revision, { toolType, sessionId, cwd })).unchanged) {
      return sourceAttempt < 2 ? this.getHistory(payload, sourceAttempt + 1, onPayload)
        : { success: false, error: 'history_source_changed_during_preparation', entries: [] };
    }
    const revision = result.unchanged ? payload.ifRevision : buildHistoryRevision({ toolType, sessionId, cwd }, result.revision?.sources, {
      context: JSON.stringify({ payloadPolicy: HISTORY_PAYLOAD_ON_DEMAND, base: result.revision?.context,
        payloadHeaderVersion: HISTORY_PAYLOAD_HEADER_VERSION,
        bounds: normalizeHistoryEntryWindowRequest(payload.bounds) }),
    });
    return { ...result, revision,
      payloadGeneration: buildHistoryRevision({ toolType, sessionId, cwd }, revision?.sources)?.token || '',
      ...(result.entries ? { entries: projectHistoryOnDemand({ toolType, sessionId, entries: result.entries, onPayload }) } : {}),
    };
  }

  async getMessages(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    if (toolType === 'codex' && this.historyReader) return this.historyReader.call('getMessages', payload);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', messages: [] };
    if (toolType !== 'codex') {
      return { success: false, error: 'messages compatibility path not migrated', messages: [] };
    }
    const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
    if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', messages: [] };
    const messages = [];
    for (const record of loaded.records || []) {
      const message = codexRecordToMobileMessage(record, sessionId);
      if (message) messages.push(message);
    }
    return {
      success: true,
      messages,
      total: messages.length,
      filePath: loaded.filePath,
      sessionId,
      toolType,
    };
  }

  _removeConsumer(key, consumerId) {
    const state = this.sessions.get(key);
    if (!state) return;
    state.consumers.delete(consumerId);
    if (state.consumers.size === 0) this._parkState(state, 'no-consumers');
  }

  /**
   * Keeps a consumer-less state alive for the grace window instead of closing
   * it. The watcher stays armed, so a return within the window skips the file
   * parse entirely AND the tail read that would otherwise be needed to catch
   * up on whatever landed while nobody was looking.
   */
  _parkState(state, reason) {
    if (state.idleTimer) return;
    if (this.idleGraceMs === 0) {
      this._closeState(state, reason);
      this.sessions.delete(state.key);
      return;
    }
    state.idleSince = Date.now();
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      // Re-check: a consumer may have returned between the timer firing and
      // this callback running. Only a state that is STILL unobserved closes.
      if (state.consumers.size > 0) {
        state.idleSince = 0;
        return;
      }
      this._closeState(state, 'idle-expired');
      this.sessions.delete(state.key);
    }, this.idleGraceMs);
    if (typeof state.idleTimer.unref === 'function') state.idleTimer.unref();
    console.log('[TranscriptService:Park] tool=' + state.toolType +
      ' session=' + shortId(state.sessionId) +
      ' reason=' + reason +
      ' graceMs=' + this.idleGraceMs +
      ' idleStates=' + this._countIdleStates());
    this._evictExcessIdleStates();
  }

  _unparkState(state) {
    if (!state.idleTimer) return false;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    const idleMs = state.idleSince ? Date.now() - state.idleSince : 0;
    state.idleSince = 0;
    console.log('[TranscriptService:Unpark] tool=' + state.toolType +
      ' session=' + shortId(state.sessionId) +
      ' idleMs=' + idleMs);
    return true;
  }

  _countIdleStates() {
    let count = 0;
    for (const state of this.sessions.values()) {
      if (state.idleTimer) count += 1;
    }
    return count;
  }

  _evictExcessIdleStates() {
    const idle = [];
    for (const state of this.sessions.values()) {
      if (state.idleTimer) idle.push(state);
    }
    if (idle.length <= this.idleStateMax) return;
    idle.sort((a, b) => (a.idleSince || 0) - (b.idleSince || 0));
    for (const state of idle.slice(0, idle.length - this.idleStateMax)) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
      state.idleSince = 0;
      this._closeState(state, 'idle-evicted');
      this.sessions.delete(state.key);
    }
  }

  async _ensureState({ key, toolType, sessionId, cwd }) {
    const existing = this.sessions.get(key);
    if (existing) {
      // Warm state reclaimed before its grace window expired: the watcher never
      // stopped, so there is nothing to re-read here.
      this._unparkState(existing);
      return existing;
    }

    const inflight = this.sessionInitInflight.get(key);
    if (inflight) return inflight;

    const initialization = (async () => {
      const filePath = await this._resolveFilePath(toolType, sessionId, cwd);
      const state = {
        key,
        toolType,
        sessionId,
        cwd,
        filePath,
        consumers: new Map(),
        watcher: null,
        timer: null,
        reconcileTimer: null,
        inflight: false,
        trailingReadReason: null,
        refreshInflight: null,
        // Set while the state is warm but unobserved (see _parkState).
        idleTimer: null,
        idleSince: 0,
        offset: 0,
        leftover: '',
        version: 0,
        size: 0,
        mtimeMs: 0,
        lastUuid: null,
      };
      await this._refreshFile(state);
      state.offset = state.size;
      this.sessions.set(key, state);
      if (toolType === 'codex') {
        await this._seedCodexContextObservation(state, 'state-init');
      }
      return state;
    })();
    this.sessionInitInflight.set(key, initialization);

    try {
      return await initialization;
    } finally {
      if (this.sessionInitInflight.get(key) === initialization) {
        this.sessionInitInflight.delete(key);
      }
    }
  }

  async _resolveFilePath(toolType, sessionId, cwd) {
    const cacheKey = toolType + ':' + sessionId;
    const cached = this.resolvedPathCache.get(cacheKey);
    if (cached) {
      // Existence check only — a vanished file (deleted session) falls
      // through to a fresh discovery walk.
      try {
        await fs.promises.access(cached);
        return cached;
      } catch {
        this.resolvedPathCache.delete(cacheKey);
      }
    }
    let filePath = null;
    if (toolType === 'codex') {
      const found = await this.codexData?._api?.findCodexSessionFile?.(sessionId, cwd);
      filePath = found?.filePath || null;
    } else {
      const found = this.claudeData?.findSessionFile?.(sessionId, cwd);
      filePath = found?.filePath || null;
    }
    if (filePath) this.resolvedPathCache.set(cacheKey, filePath);
    return filePath;
  }

  async _refreshFile(state) {
    if (!state.filePath) {
      state.filePath = await this._resolveFilePath(state.toolType, state.sessionId, state.cwd);
    }
    if (!state.filePath) return false;
    try {
      const stat = await fs.promises.stat(state.filePath);
      const fileIdentity = stat.dev + ':' + stat.ino;
      const replaced = !!state.fileIdentity && state.fileIdentity !== fileIdentity;
      const ctimeChanged = Number.isFinite(state.ctimeMs) && state.ctimeMs !== stat.ctimeMs;
      const rewritten = replaced || (!!state.fileIdentity && (stat.size < state.size
        || (stat.size === state.size && (stat.mtimeMs !== state.mtimeMs || ctimeChanged))));
      const changed = replaced || stat.size !== state.size || stat.mtimeMs !== state.mtimeMs || ctimeChanged;
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      state.ctimeMs = stat.ctimeMs;
      state.fileIdentity = fileIdentity;
      if (rewritten) {
        // Atomic JSONL replacement keeps the path but changes the watched
        // inode. Neither a byte cursor nor fs.watch survives that identity.
        // The changed event reloads canonical rows; do not emit a fake live
        // append by reading the new file at the old generation's offset.
        state.offset = stat.size;
        state.leftover = '';
        state.sourceRewriteVersion = (state.sourceRewriteVersion || 0) + 1;
        this.historyDeltaDigests.invalidateSession(state.toolType, state.sessionId);
        historyPayloadStash.invalidateSession(state.toolType, state.sessionId);
        if (state.toolType === 'codex') this.codexData?._api?.invalidateJsonlCache?.(state.filePath);
        if (replaced && state.watcher) {
          try { state.watcher.close(); } catch {}
          state.watcher = null;
          if (state.reconcileTimer) clearInterval(state.reconcileTimer);
          state.reconcileTimer = null;
          this._startWatcher(state);
          console.log('[TranscriptService:WatchRebind] tool=' + state.toolType
            + ' session=' + shortId(state.sessionId) + ' reason=file-replaced');
        }
      }
      if (changed) state.version += 1;
      return changed;
    } catch {
      return false;
    }
  }

  _startWatcher(state) {
    if (!state.filePath || state.watcher) return;
    try {
      state.watcher = fs.watch(state.filePath, { persistent: false }, () => this._scheduleRead(state, 'fs.watch'));
      state.reconcileTimer = setInterval(() => this._scheduleRead(state, 'stat-reconcile'), 10000);
      console.log('[TranscriptService:WatchStart] tool=' + state.toolType +
        ' session=' + shortId(state.sessionId) +
        ' file=' + state.filePath +
        ' size=' + state.size);
    } catch (e) {
      console.warn('[TranscriptService:WatchStart] failed tool=' + state.toolType +
        ' session=' + shortId(state.sessionId) +
        ' error=' + (e?.message || e));
    }
  }

  _scheduleRead(state, reason) {
    // Parked state: the reconcile interval and fs.watch keep firing, but there
    // is no surface to publish to. Skip the timer entirely; the reclaim path
    // schedules one explicit catch-up read.
    if (state.idleTimer) return;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this._readChange(state, reason).catch((e) => {
        console.warn('[TranscriptService:Read] failed tool=' + state.toolType +
          ' session=' + shortId(state.sessionId) +
          ' reason=' + reason +
          ' error=' + (e?.message || e));
      });
    }, 60);
  }

  async _readChange(state, reason) {
    // Parked (warm but unobserved) state: the watcher stays armed only to keep
    // the state reclaimable, NOT to keep publishing. Broadcasting here would
    // feed live-tail events to main-side hooks (startup proof, web clients) for
    // a session no surface is showing — work that a closed state never did.
    // Unpark re-syncs from the file, so nothing is lost by staying quiet.
    if (state.idleTimer) return;
    if (state.inflight) {
      state.trailingReadReason = reason || 'trailing-change';
      return;
    }
    state.inflight = true;
    try {
      const oldSize = state.size;
      const oldFileIdentity = state.fileIdentity;
      const oldRewriteVersion = state.sourceRewriteVersion || 0;
      const changed = await this._refreshFile(state);
      if (!changed) return;
      if ((oldFileIdentity && oldFileIdentity !== state.fileIdentity)
        || (state.sourceRewriteVersion || 0) !== oldRewriteVersion) {
        if (state.toolType === 'codex') await this._seedCodexContextObservation(state, 'source-rewritten');
      } else if (state.toolType === 'codex') {
        await this._broadcastCodexDelta(state, oldSize);
      } else if (state.toolType === 'claude') {
        await this._broadcastClaudeDelta(state, oldSize);
      }
      this._emitChanged(state, reason);
    } finally {
      state.inflight = false;
      const trailingReason = state.trailingReadReason;
      state.trailingReadReason = null;
      if (trailingReason && state.consumers.size > 0) {
        await this._readChange(state, 'trailing:' + trailingReason);
      }
    }
  }

  _publishCodexContextObservation(state, observation, detail = {}) {
    if (!this.onCodexContextObservation || !observation) return;
    try {
      const notified = this.onCodexContextObservation({
        toolType: 'codex',
        sessionId: state.sessionId,
        filePath: state.filePath,
        ...detail,
        observation,
      });
      if (notified && typeof notified.catch === 'function') {
        void notified.catch((error) => {
          console.warn('[TranscriptService:CodexContext] observer failed session='
            + shortId(state.sessionId) + ' error=' + (error?.message || error));
        });
      }
    } catch (error) {
      console.warn('[TranscriptService:CodexContext] observer failed session='
        + shortId(state.sessionId) + ' error=' + (error?.message || error));
    }
  }

  async _seedCodexContextObservation(state, reason = 'seed') {
    if (!this.onCodexContextObservation || !state?.filePath || state.size <= 0) return null;
    try {
      const observation = await readLatestCodexContextObservation(state.filePath, {
        endOffset: state.size,
      });
      if (observation?.kind === 'value' || observation?.kind === 'invalidated') {
        this._publishCodexContextObservation(state, observation, {
          source: 'tail-seed',
          reason,
        });
      } else {
        console.log('[TranscriptService:CodexContext] seed unknown session='
          + shortId(state.sessionId)
          + ' reason=' + (observation?.reason || 'unknown')
          + ' scanned=' + Number(observation?.scannedBytes || 0));
      }
      return observation;
    } catch (error) {
      console.warn('[TranscriptService:CodexContext] seed failed session='
        + shortId(state.sessionId) + ' error=' + (error?.message || error));
      return null;
    }
  }

  async _broadcastCodexDelta(state, oldSize) {
    if (!state.filePath || state.size <= oldSize) {
      if (state.size < oldSize) {
        state.offset = 0;
        state.leftover = '';
      }
      if (state.filePath && state.size > 0 && state.size <= oldSize) {
        await this._seedCodexContextObservation(state, 'non-append-change');
      }
      return;
    }
    const start = Math.max(0, state.offset || oldSize);
    if (state.size <= start) return;
    const fd = await fs.promises.open(state.filePath, 'r');
    let text = '';
    try {
      const byteCount = state.size - start;
      const buf = Buffer.allocUnsafe(byteCount);
      await fd.read(buf, 0, byteCount, start);
      text = buf.toString('utf8');
    } finally {
      await fd.close();
    }
    state.offset = state.size;
    const previousLeftover = state.leftover || '';
    const bufferBaseOffset = Math.max(0, start - Buffer.byteLength(previousLeftover));
    const buf = previousLeftover + text;
    const lines = buf.split('\n');
    state.leftover = lines.pop() || '';
    let sent = 0;
    let parsed = 0;
    let skippedLiveUsers = 0;
    let suppressedLiveMessages = 0;
    const tabIds = new Set(
      Array.from(state.consumers?.values?.() || [])
        .map((consumer) => String(consumer?.tabId || ''))
        .filter(Boolean),
    );
    let lineByteOffset = bufferBaseOffset;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const recordByteOffset = lineByteOffset;
      lineByteOffset += Buffer.byteLength(rawLine) + 1;
      const recordEndByteOffset = lineByteOffset;
      const line = rawLine.trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
        record.__line = start + i;
        record.__byteOffset = recordByteOffset;
        parsed += 1;
      } catch {
        continue;
      }
      const contextObservation = codexContextObservationFromRecord(record);
      if (contextObservation) {
        this._publishCodexContextObservation(state, contextObservation, {
          source: 'append',
          recordByteOffset,
        });
      }
      // Codex live rows still have one owner (the rollout turn watcher), but
      // TerminalHistoryPreview needs an exact durable receipt even while that
      // watcher is intentionally public-suppressed during writer adoption.
      // This raw callback carries only the physical record boundary; main must
      // prove the current launch/run before it may settle preview or activity.
      if (this.onRawRecord) {
        for (const tabId of tabIds) {
          try {
            this.onRawRecord({
              tabId,
              toolType: 'codex',
              sessionId: state.sessionId,
              filePath: state.filePath,
              timestamp: record.timestamp || new Date().toISOString(),
              recordByteOffset,
              recordEndByteOffset,
              message: record,
            });
          } catch (error) {
            console.warn('[TranscriptService:CodexDelta] raw observer failed tab='
              + shortId(tabId) + ' error=' + (error?.message || error));
          }
        }
      }
      if (isCodexLiveMessageRecord(record)) {
        // CodexTurn watcher is the only live-message owner for Codex. This
        // transcript watcher keeps snapshots fresh via transcript-changed; sending
        // response items here creates a second, differently-normalized stream.
        if (isCodexUserMessageRecord(record)) skippedLiveUsers += 1;
        suppressedLiveMessages += 1;
        continue;
      }
    }
    console.log('[TranscriptService:CodexDelta] session=' + shortId(state.sessionId) +
      ' bytes=' + (state.size - start) +
      ' parsed=' + parsed +
      ' sent=' + sent +
      ' skippedLiveUsers=' + skippedLiveUsers +
      ' suppressedLiveMessages=' + suppressedLiveMessages +
      ' leftover=' + state.leftover.length);
  }

  async _broadcastClaudeDelta(state, oldSize, { previewOnly = false, isCurrent = null } = {}) {
    if (!state.filePath || state.size <= oldSize) {
      if (state.size < oldSize) {
        state.offset = 0;
        state.leftover = '';
      }
      return;
    }
    const start = Math.max(0, state.offset || oldSize);
    if (state.size <= start) return;
    const fd = await fs.promises.open(state.filePath, 'r');
    let text = '';
    try {
      const byteCount = state.size - start;
      const buf = Buffer.allocUnsafe(byteCount);
      await fd.read(buf, 0, byteCount, start);
      text = buf.toString('utf8');
    } finally {
      await fd.close();
    }
    state.offset = state.size;
    const previousLeftover = state.leftover || '';
    const bufferBaseOffset = Math.max(0, start - Buffer.byteLength(previousLeftover));
    const buffer = previousLeftover + text;
    const lines = buffer.split('\n');
    state.leftover = lines.pop() || '';
    let parsed = 0;
    let sent = 0;
    let lineByteOffset = bufferBaseOffset;
    const mainWindow = this.getMainWindow?.();
    for (const line of lines) {
      const recordByteOffset = lineByteOffset;
      lineByteOffset += Buffer.byteLength(line) + 1;
      const recordEndByteOffset = lineByteOffset;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
        parsed += 1;
      } catch {
        continue;
      }
      if (previewOnly) {
        if (!isCurrent?.()) return;
        if (record.type === 'assistant') {
          for (const consumer of state.consumers.values()) {
            this.onLiveMessage?.({
              tabId: consumer.tabId, toolType: 'claude', sessionId: state.sessionId,
              timestamp: record.timestamp, recordByteOffset, recordEndByteOffset,
              message: record,
            });
          }
        }
        continue;
      }
      // Main-owned lifecycle observers need service records that History
      // intentionally hides (notably task-notification attachments). Publish
      // the raw record once per distinct tab before the renderer projection
      // filter; renderer fan-out below remains unchanged.
      const tabIds = new Set(
        Array.from(state.consumers.values())
          .map((consumer) => String(consumer?.tabId || ''))
          .filter(Boolean),
      );
      if (this.onRawRecord) {
        for (const tabId of tabIds) {
          try {
            this.onRawRecord({
              tabId,
              toolType: 'claude',
              sessionId: state.sessionId,
              timestamp: record.timestamp || new Date().toISOString(),
              recordByteOffset,
              recordEndByteOffset,
              message: record,
            });
          } catch (error) {
            console.warn('[TranscriptService:ClaudeDelta] raw observer failed tab='
              + shortId(tabId) + ' error=' + (error?.message || error));
          }
        }
      }
      // Durable Claude projection already removes the exact app-owned
      // history-only boundary. The live stream must apply the same provider
      // predicate before renderer fan-out; otherwise History briefly renders
      // an empty assistant row until the next full refresh.
      if (this.claudeData?._api?.isClaudeHistoryContextAck?.(record) === true) {
        continue;
      }
      const content = record?.message?.content;
      const hasToolResult = record?.type === 'user'
        && Array.isArray(content)
        && content.some((block) => block?.type === 'tool_result');
      const isCompactSummary = record?.type === 'user'
        && record?.isCompactSummary === true;
      const isSettingsService = !!claudeSettingsServiceDisplayFromRecord(record);
      const isServiceFailure = !!claudeHistoryFailureFromRecord(record);
      const isOrdinaryUser = record?.type === 'user'
        && record?.isMeta !== true
        && !isCompactSummary
        && !isSettingsService
        && !hasToolResult;
      const isQueueOperation = record?.type === 'queue-operation';
      const isQueuedCommand = record?.type === 'attachment'
        && record?.attachment?.type === 'queued_command';
      if (
        record?.type !== 'assistant'
        && !hasToolResult
        && !isOrdinaryUser
        && !isQueueOperation
        && !isQueuedCommand
        && !isSettingsService
        && !isServiceFailure
      ) continue;
      const livePromptRecord = isOrdinaryUser ? record : {
        type: 'user',
        message: { content: isQueuedCommand ? record.attachment.prompt
          : isQueueOperation && record.operation === 'enqueue' ? record.content : '' },
      };
      const liveImagePaths = isOrdinaryUser || isQueueOperation || isQueuedCommand
        ? recoverManagedHistoryImageRefs({
            entry: {
              content: this.claudeData?._api?.claudeUserRecordText?.(livePromptRecord) || '',
            },
            imagePaths: [],
            resolveManagedImageRef: this.recoverManagedHistoryImageRef,
          }).imagePaths
        : [];
      if (isClaudePendingThinkingRecord(record)) {
        record.livePendingThinking = true;
      }
      // History, Timeline and the control bar can all subscribe to the same
      // session for one tab. A JSONL record is a tab event, not a subscriber
      // event: replaying `dequeue` once per consumer advances multiple queued
      // prompts. Fan out once per distinct tab instead.
      for (const tabId of tabIds) {
        let promptOwner = null;
        if (this.resolveClaudePromptOwner && (isOrdinaryUser || isQueueOperation || isQueuedCommand)) {
          try {
            promptOwner = this.resolveClaudePromptOwner({
              tabId,
              sessionId: state.sessionId,
              transcriptPath: state.filePath,
              recordByteOffset,
              record,
            }) || null;
          } catch (error) {
            console.warn('[TranscriptService:ClaudeDelta] prompt owner unresolved tab='
              + shortId(tabId) + ' error=' + (error?.message || error));
          }
        }
        const detail = {
          tabId,
          toolType: 'claude',
          sessionId: state.sessionId,
          recordTime: historyRecordTimeFromRecord(record),
          timestamp: record.timestamp || new Date().toISOString(),
          recordByteOffset,
          recordEndByteOffset,
          message: isSettingsService ? { ...record, serviceCarrier: 'local-setting' } : record,
          ...(liveImagePaths.length > 0 ? { imagePaths: liveImagePaths } : {}),
          ...(promptOwner ? { promptOwner } : {}),
        };
        if (this.onLiveMessage) {
          try {
            this.onLiveMessage(detail);
          } catch (error) {
            console.warn('[TranscriptService:ClaudeDelta] live observer failed tab='
              + shortId(tabId) + ' error=' + (error?.message || error));
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent-transcript:live-message', detail);
          sent += 1;
        }
      }
    }
    console.log('[TranscriptService:ClaudeDelta] session=' + shortId(state.sessionId)
      + ' bytes=' + (state.size - start)
      + ' parsed=' + parsed
      + ' sent=' + sent
      + ' leftover=' + state.leftover.length);
  }

  _emitChanged(state, reason) {
    const meta = {
      type: 'transcript-changed',
      toolType: state.toolType,
      sessionId: state.sessionId,
      version: state.version,
      size: state.size,
      mtimeMs: state.mtimeMs,
      filePath: state.filePath,
      ...(state.fileIdentity ? { fileIdentity: state.fileIdentity } : {}),
      sourceRewriteVersion: state.sourceRewriteVersion || 0,
      reason,
    };
    const mainWindow = this.getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-transcript:changed', meta);
    }
    if (this.onChanged) {
      try {
        const notified = this.onChanged(meta);
        if (notified && typeof notified.catch === 'function') {
          void notified.catch((error) => {
            console.warn('[TranscriptService:ChangedHook] failed tool=' + state.toolType
              + ' session=' + shortId(state.sessionId)
              + ' error=' + (error?.message || error));
          });
        }
      } catch (error) {
        console.warn('[TranscriptService:ChangedHook] failed tool=' + state.toolType
          + ' session=' + shortId(state.sessionId)
          + ' error=' + (error?.message || error));
      }
    }
    this._webBroadcast(state, meta);
    console.log('[TranscriptService:Changed] tool=' + state.toolType +
      ' session=' + shortId(state.sessionId) +
      ' version=' + state.version +
      ' reason=' + reason +
      ' consumers=' + state.consumers.size +
      ' size=' + state.size);
  }

  _webBroadcast(state, payload) {
    if (!this.webBroadcast) return;
    const tabIds = new Set();
    for (const consumer of state.consumers.values()) {
      if (consumer.tabId) tabIds.add(consumer.tabId);
    }
    for (const tabId of tabIds) {
      try {
        this.webBroadcast(tabId, payload);
      } catch {}
    }
  }

  _stateMeta(state) {
    return {
      toolType: state.toolType,
      sessionId: state.sessionId,
      filePath: state.filePath,
      version: state.version,
      size: state.size,
      mtimeMs: state.mtimeMs,
    };
  }

  _closeState(state, reason) {
    try { state.watcher?.close(); } catch {}
    if (state.timer) clearTimeout(state.timer);
    if (state.reconcileTimer) clearInterval(state.reconcileTimer);
    state.watcher = null;
    state.timer = null;
    state.reconcileTimer = null;
    console.log('[TranscriptService:WatchStop] tool=' + state.toolType +
      ' session=' + shortId(state.sessionId) +
      ' reason=' + reason);
  }
}

function createSessionTranscriptService(opts) {
  return new SessionTranscriptService(opts);
}

module.exports = {
  createSessionTranscriptService,
  SessionTranscriptService,
  isClaudePendingThinkingRecord,
};
