const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const {
  buildHistoryRevision,
  validateHistoryRevision,
} = require('./history-revision');
const {
  decorateHistoryPromptPresentations,
  recoverManagedHistoryImageRefs,
} = require('./history-prompt-presentations');
const {
  decorateHistoryResponseTimings,
} = require('./history-response-timings');
const {
  dehydrateHistoryEntries,
  historyPayloadStash,
  capPayloadForRender,
} = require('./history-payload-dehydrate');
const {
  applyHistoryEntryWindow,
  applyHistoryRowWindow,
  normalizeHistoryRowWindowRequest,
} = require('./history-entry-window');
const {
  diffHistoryEntriesAgainstDigest,
  HistoryDeltaDigestStore,
} = require('./history-delta');
const {
  isCodexEnvironmentContextUserText,
  codexUserMessagePresentationText,
} = require('./codex-prompt-audit');
const {
  deriveCodexForkSnapshot,
  normalizeCodexForkLineageManifest,
} = require('./session-history-events');
const {
  createCodexVirtualTranscriptStore,
  hashFileSegment,
} = require('./codex-virtual-transcript');

function shortId(value, n = 8) {
  return String(value || '').slice(0, n);
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
  const payload = record?.payload || {};
  if (isCodexUserMessageRecord(record)) {
    const text = codexUserMessagePresentationText(record);
    if (isCodexEnvironmentContextUserText(text)) return null;
    return {
      type: 'user',
      uuid: getRecordUuid(record, sessionId, record.__line),
      timestamp: record.timestamp || null,
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
    resolveClaudePromptOwner = null,
    claudeData,
    codexData,
    sessionHistoryStore = null,
    promptPresentationStore = null,
    recoverManagedHistoryImageRef = null,
    idleGraceMs = IDLE_STATE_GRACE_MS,
    idleStateMax = IDLE_STATE_MAX,
  }) {
    this.getMainWindow = getMainWindow;
    this.webBroadcast = webBroadcast;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.onLiveMessage = typeof onLiveMessage === 'function' ? onLiveMessage : null;
    this.onRawRecord = typeof onRawRecord === 'function' ? onRawRecord : null;
    this.resolveClaudePromptOwner = typeof resolveClaudePromptOwner === 'function'
      ? resolveClaudePromptOwner
      : null;
    this.claudeData = claudeData;
    this.codexData = codexData;
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
  }

  registerIpc() {
    ipcMain.handle('agent-transcript:subscribe', async (_event, payload = {}) => this.subscribe(payload));
    ipcMain.handle('agent-transcript:unsubscribe', async (_event, payload = {}) => this.unsubscribe(payload));
    ipcMain.handle('agent-transcript:refresh', async (_event, payload = {}) => this.refresh(payload));
    ipcMain.handle('agent-transcript:get-timeline', async (_event, payload = {}) => this.getTimeline(payload));
    ipcMain.handle('agent-transcript:get-history', async (_event, payload = {}) => this.getHistory(payload));
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
  async getToolPayload(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    const payloadId = typeof payload.payloadId === 'string' ? payload.payloadId : '';
    if (!sessionId || !payloadId) {
      return { success: false, error: 'sessionId and payloadId required' };
    }
    const stashed = historyPayloadStash.get(toolType, sessionId, payloadId);
    if (typeof stashed === 'string') {
      const capped = capPayloadForRender(stashed);
      console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=stash bytes=${stashed.length}`);
      return { success: true, source: 'stash', payloadId, ...capped };
    }
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
    const rebuilt = historyPayloadStash.get(toolType, sessionId, payloadId);
    if (typeof rebuilt !== 'string') {
      console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=miss`);
      return { success: false, error: 'payload not found', payloadId };
    }
    const capped = capPayloadForRender(rebuilt);
    console.log(`[FullHistory:Rehydrate] session=${String(sessionId).slice(0, 8)} payload=${payloadId.slice(0, 24)} source=rebuild bytes=${rebuilt.length}`);
    return { success: true, source: 'rebuild', payloadId, ...capped };
  }

  _getCodexVirtualTranscriptStore() {
    if (this.codexVirtualTranscriptStore) return this.codexVirtualTranscriptStore;
    const api = this.codexData?._api;
    if (!api) return null;
    try {
      this.codexVirtualTranscriptStore = createCodexVirtualTranscriptStore({ codexApi: api });
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
      return await store.project(lineage.descriptor, cwd);
    } catch (error) {
      return {
        success: false,
        error: 'lineage_unresolved',
        lineageReason: error?.reason || error?.message || 'virtual-projector-failed',
      };
    }
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

  async captureCodexForkSourceSnapshot({ sessionId, cwd, loaded = null } = {}) {
    if (!sessionId) return null;
    const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
    let timelineEntries = [];
    let sourceSegments = [];
    if (lineage.kind === 'virtual') {
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
      const physical = loaded?.success
        ? loaded
        : await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
      if (!physical?.success || !physical.filePath || !physical.sourceSnapshot) return null;
      if (physical.sourceSnapshot.size <= 0) return null;
      const handle = await fs.promises.open(physical.filePath, 'r');
      try {
        const lastByte = Buffer.allocUnsafe(1);
        const read = await handle.read(lastByte, 0, 1, physical.sourceSnapshot.size - 1);
        if (read.bytesRead !== 1 || lastByte[0] !== 0x0a) return null;
      } finally {
        await handle.close();
      }
      timelineEntries = this.codexData._api.buildCodexTimeline(physical.records || [], sessionId);
      const digest = await hashFileSegment(physical.filePath, 0, physical.sourceSnapshot.size);
      const endLine = (physical.records || []).reduce(
        (max, record) => Math.max(max, Number(record?.__line) + 1 || 0),
        0,
      );
      sourceSegments = [{
        physicalSessionId: sessionId,
        fromByte: 0,
        toByte: physical.sourceSnapshot.size,
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

  async captureCodexForkChildTailStart({ sourceSessionId, childSessionId, cwd } = {}) {
    const api = this.codexData?._api;
    if (!sourceSessionId || !childSessionId || !api?.findCodexSessionFile || !api?.readJsonlRange) return null;
    const found = await api.findCodexSessionFile(childSessionId, cwd);
    if (!found?.filePath) return null;
    const stat = await fs.promises.stat(found.filePath);
    const parsed = await api.readJsonlRange(found.filePath, 0, stat.size - 1);
    if (parsed.errors > 0 || parsed.leftoverBuffer?.length > 0) return null;
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
    if (!sessionId) return { success: false, error: 'sessionId required' };
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
   * Cmd+F over the FULL projection, in main.
   *
   * The panel used to scan `entry.content` of every row it held. With
   * row-level hydration a far-away row travels as an identity stub, so a
   * renderer-side scan would silently miss matches — worse than slow: the
   * user would conclude the text is not there. Main always holds the whole
   * projection (that is what the file-cursor projector is), so the scan
   * belongs here.
   *
   * Returns row identities + offsets only, never row content: the caller
   * scrolls to the row, and hydration delivers the text through the normal
   * window path.
   */
  async searchHistory(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    const sessionId = payload.sessionId;
    const query = typeof payload.query === 'string' ? payload.query : '';
    if (!sessionId) return { success: false, error: 'sessionId required', matches: [] };
    if (query.length < 2) return { success: true, matches: [], total: 0, truncated: false };
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
    const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
    if (lineage.kind === 'unresolved') {
      return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, matches: [] };
    }
    const projected = lineage.kind === 'virtual'
      ? await this._projectCodexVirtual(lineage, payload.cwd)
      : await projectFromFile(sessionId, payload.cwd);
    if (!projected?.success) return { success: false, error: projected?.error || 'projection failed', matches: [] };
    const limit = Math.max(1, Math.min(5000, Number(payload.limit) || 2000));
    const needle = query.toLowerCase();
    const matches = [];
    let total = 0;
    const contentRevision = lineage.kind === 'virtual'
      ? this._buildCodexContentRevision(sessionId, payload.cwd, projected)
      : null;
    const entries = lineage.kind === 'virtual'
      ? this._decorateCodexContentRevision(projected.historyEntries, contentRevision)
      : (projected.entries || []);
    if (lineage.kind === 'physical' && entries.length === 0 && lineage.legacyForkEvent) {
      return {
        success: false,
        error: 'lineage_unresolved',
        lineageReason: 'legacy-fork-event-without-raw-manifest',
        matches: [],
      };
    }
    for (let index = 0; index < entries.length; index += 1) {
      const text = String(entries[index]?.content || '').toLowerCase();
      if (!text) continue;
      let at = text.indexOf(needle);
      while (at !== -1) {
        total += 1;
        if (matches.length < limit) {
          matches.push({
            entryIndex: index,
            entryUuid: entries[index].uuid,
            entryRef: entries[index].entryRef || null,
            physicalSessionId: entries[index].physicalSessionId || entries[index].sessionId || null,
            offset: at,
          });
        }
        at = text.indexOf(needle, at + 1);
      }
    }
    console.log('[TranscriptService:HistorySearch] session=' + shortId(sessionId)
      + ' rows=' + entries.length
      + ' matches=' + total
      + ' returned=' + matches.length
      + ' ms=' + (Date.now() - startedAt));
    return {
      success: true,
      matches,
      total,
      truncated: total > matches.length,
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
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', entries: [] };
    if (toolType === 'codex') {
      const lineage = this._resolveCodexLineage(sessionId, 'dehydrated');
      if (lineage.kind === 'unresolved') {
        return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, entries: [] };
      }
      const virtualProjected = lineage.kind === 'virtual'
        ? await this._projectCodexVirtual(lineage, cwd)
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
      if (!virtualProjected && entries.length === 0 && lineage.legacyForkEvent) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: 'legacy-fork-event-without-raw-manifest',
          entries: [],
        };
      }
      const presentedEntries = decorateHistoryPromptPresentations(this.promptPresentationStore, {
        toolType,
        sessionId,
        entries,
        recoverManagedImageRef: this.recoverManagedHistoryImageRef,
      });
      const finalPresentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
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

  async getHistory(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', entries: [] };
    if (toolType === 'codex') {
      const lineage = this._resolveCodexLineage(
        sessionId,
        payload.dehydrate === true ? 'dehydrated' : 'full',
      );
      if (lineage.kind === 'unresolved') {
        return { success: false, error: 'lineage_unresolved', lineageReason: lineage.reason, entries: [] };
      }
      const virtualProjected = lineage.kind === 'virtual'
        ? await this._projectCodexVirtual(lineage, cwd)
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
      // cached at all. Restricted to dehydrate consumers (the desktop
      // panel): dehydration mutates the cached projector's shared action
      // objects into previews+refs, which is stable across dehydrating calls
      // but would poison a full-payload consumer (web/iOS) — those keep the
      // fresh one-shot build, as does getToolPayload's stash rebuild below
      // for the same reason. Falls back to load+one-shot when the
      // incremental API is absent (minimal test stubs).
      const projectFromFile = this.codexData?._api?.projectCodexFullHistoryFromFile;
      let entries;
      let loadedFilePath;
      let projectedSnapshot = null;
      let projectedSnapshots = null;
      if (virtualProjected) {
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
        const projected = await projectFromFile(sessionId, cwd);
        if (!projected?.success) return projected || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = projected.entries;
        loadedFilePath = projected.filePath;
        projectedSnapshot = projected.sourceSnapshot || null;
      } else {
        const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
        if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', entries: [] };
        entries = this.codexData._api.buildCodexFullHistory(loaded.records || [], sessionId);
        loadedFilePath = loaded.filePath;
        projectedSnapshot = loaded.sourceSnapshot || null;
      }
      if (!virtualProjected && entries.length === 0 && lineage.legacyForkEvent) {
        return {
          success: false,
          error: 'lineage_unresolved',
          lineageReason: 'legacy-fork-event-without-raw-manifest',
          entries: [],
        };
      }
      // Heavy payloads (tool outputs, thinking, compact snapshots) leave main
      // as previews + refs; the renderer pulls full text on expand through
      // history:get-tool-payload. OPT-IN per call: web/iOS consumers of this
      // service have no rehydration path yet and keep full payloads.
      if (payload.dehydrate === true) {
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
      const presentedEntries = decorateHistoryPromptPresentations(this.promptPresentationStore, {
        toolType,
        sessionId,
        entries,
        recoverManagedImageRef: this.recoverManagedHistoryImageRef,
      });
      let responseTimingBound = false;
      const timedEntries = decorateHistoryResponseTimings(this.promptPresentationStore, {
        toolType,
        sessionId,
        tabId: payload.tabId || null,
        entries: presentedEntries,
        onBound: () => {
          responseTimingBound = true;
        },
      });
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
      const finalPresentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const finalResponseTimingRevision = this.promptPresentationStore?.getHistoryResponseTimingRevision
        ? this.promptPresentationStore.getHistoryResponseTimingRevision(toolType, sessionId, payload.tabId || null)
        : 'none';
      const revision = buildHistoryRevision(
        { toolType, sessionId, cwd },
        projectedSnapshots || (projectedSnapshot ? [projectedSnapshot] : []),
        {
          context: JSON.stringify({
            promptPresentationRevision: finalPresentationRevision,
            responseTimingRevision: finalResponseTimingRevision,
            rowWindowRequest,
            ...(contentRevision ? { contentRevision: contentRevision.token } : {}),
          }),
        }
      );
      // Row-level windowing: the row LIST stays full length (geometry,
      // anchors, mount wave and Timeline index lookup all address rows by
      // position), but rows outside the hydrated span travel as identity
      // stubs. A 15.5K-row giant costs ~150MB of presentation in the
      // renderer; stubs bring that to ~1.5MB + the hydrated span. Opt-in via
      // `hydrate` so web/iOS and any consumer without a stub renderer keep
      // full rows.
      const rowWindow = applyHistoryRowWindow(timedEntries, rowWindowRequest);
      if (rowWindow.rowWindowApplied) {
        console.log('[TranscriptService:HistoryRows] session=' + shortId(sessionId)
          + ' tab=' + String(payload.tabId || '-').slice(-12)
          + ' rows=' + rowWindow.total
          + ' hydrated=' + rowWindow.hydratedCount
          + ' stubbed=' + rowWindow.stubbedCount
          + ' span=' + rowWindow.hydratedFrom + '-' + rowWindow.hydratedTo
          + (rowWindow.centerMissing ? ' centerMissing=1' : ''));
      }
      const historyWindow = applyHistoryEntryWindow(rowWindow.entries, payload.bounds);
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
        const prevDigest = payload.ifRevision?.token
          ? this.historyDeltaDigests.get(toolType, sessionId, payload.tabId || null)
          : null;
        const matchedDigest = prevDigest && prevDigest.revisionToken === payload.ifRevision.token
          ? prevDigest
          : null;
        const diff = diffHistoryEntriesAgainstDigest(matchedDigest, historyWindow.entries);
        this.historyDeltaDigests.set(toolType, sessionId, payload.tabId || null, {
          revisionToken: revision?.token || '',
          order: diff.order,
          fingerprints: diff.fingerprints,
        });
        // A window whose first row is NEW to the digest is a different window
        // (scrolled up, jumped, or the tail slid past what the caller holds):
        // the caller cannot rebuild it from rows it never received, so send
        // the whole window instead of a delta.
        const windowIsContinuation = matchedDigest
          && diff.order.length > 0
          && matchedDigest.fingerprints.has(diff.order[0]);
        if (matchedDigest && revision?.token && windowIsContinuation) {
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
            ...(virtualProjected ? {
              contentRevision: contentRevision?.token || null,
              viewOwnerSessionId: sessionId,
              composite: true,
            } : {}),
          };
        }
      }
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
      return {
        success: true,
        unchanged: false,
        entries: historyWindow.entries,
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
    return getFullHistory({
      ...payload,
      toolType: 'claude',
      sessionId,
      cwd,
      bounds: payload.bounds || null,
    }, { sender });
  }

  async getMessages(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
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
      const changed = stat.size !== state.size || stat.mtimeMs !== state.mtimeMs;
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
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
      const changed = await this._refreshFile(state);
      if (!changed) return;
      if (state.toolType === 'codex') {
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

  async _broadcastCodexDelta(state, oldSize) {
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
    const buf = state.leftover + text;
    const lines = buf.split('\n');
    state.leftover = lines.pop() || '';
    let sent = 0;
    let parsed = 0;
    let skippedLiveUsers = 0;
    let suppressedLiveMessages = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
        record.__line = start + i;
        parsed += 1;
      } catch {
        continue;
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

  async _broadcastClaudeDelta(state, oldSize) {
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
      const isOrdinaryUser = record?.type === 'user'
        && record?.isMeta !== true
        && !isCompactSummary
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
      ) continue;
      const liveImagePaths = isOrdinaryUser
        ? recoverManagedHistoryImageRefs({
            entry: {
              content: this.claudeData?._api?.claudeUserRecordText?.(record) || '',
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
          timestamp: record.timestamp || new Date().toISOString(),
          recordByteOffset,
          recordEndByteOffset,
          message: record,
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
