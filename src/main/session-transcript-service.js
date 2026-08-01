const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const {
  buildHistoryRevision,
  validateHistoryRevision,
} = require('./history-revision');
const {
  decorateHistoryPromptPresentations,
} = require('./history-prompt-presentations');
const {
  decorateHistoryResponseTimings,
} = require('./history-response-timings');
const {
  dehydrateHistoryEntries,
  historyPayloadStash,
  capPayloadForRender,
} = require('./history-payload-dehydrate');
const { applyHistoryEntryWindow } = require('./history-entry-window');

function shortId(value, n = 8) {
  return String(value || '').slice(0, n);
}

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
    return {
      type: 'user',
      uuid: getRecordUuid(record, sessionId, record.__line),
      timestamp: record.timestamp || null,
      message: {
        role: 'user',
        content: payload.message || '',
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
    resolveClaudePromptOwner = null,
    claudeData,
    codexData,
    promptPresentationStore = null,
  }) {
    this.getMainWindow = getMainWindow;
    this.webBroadcast = webBroadcast;
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.resolveClaudePromptOwner = typeof resolveClaudePromptOwner === 'function'
      ? resolveClaudePromptOwner
      : null;
    this.claudeData = claudeData;
    this.codexData = codexData;
    this.promptPresentationStore = promptPresentationStore;
    this.sessions = new Map();
    this.sessionInitInflight = new Map();
    this.consumerToKey = new Map();
    // Resolved transcript paths survive state teardown. Switching away from
    // a tab drops its last consumer and closes the state; without this memo
    // every switch BACK re-walked the whole sessions tree (~400ms of main
    // loop per subscribe — the measured right-click delay). A session's file
    // never moves; existence is re-checked on reuse.
    this.resolvedPathCache = new Map(); // `${toolType}:${sessionId}` → filePath
  }

  registerIpc() {
    ipcMain.handle('agent-transcript:subscribe', async (_event, payload = {}) => this.subscribe(payload));
    ipcMain.handle('agent-transcript:unsubscribe', async (_event, payload = {}) => this.unsubscribe(payload));
    ipcMain.handle('agent-transcript:refresh', async (_event, payload = {}) => this.refresh(payload));
    ipcMain.handle('agent-transcript:get-timeline', async (_event, payload = {}) => this.getTimeline(payload));
    ipcMain.handle('agent-transcript:get-history', async (_event, payload = {}) => this.getHistory(payload));
    ipcMain.handle('agent-transcript:get-messages', async (_event, payload = {}) => this.getMessages(payload));
    ipcMain.handle('history:get-tool-payload', async (_event, payload = {}) => this.getToolPayload(payload));
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
        const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
        if (!loaded?.success) return { success: false, error: loaded?.error || 'session not found' };
        const entries = this.codexData._api.buildCodexFullHistory(loaded.records || [], sessionId);
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
    const state = await this._ensureState({ key, toolType, sessionId, cwd });
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
    await this._refreshFile(state);
    this._emitChanged(state, payload.reason || 'manual-refresh');
    return { success: true, ...this._stateMeta(state) };
  }

  async getTimeline(payload = {}) {
    const toolType = normalizeToolType(payload.toolType);
    const sessionId = payload.sessionId;
    const cwd = payload.cwd;
    if (!sessionId) return { success: false, error: 'sessionId required', entries: [] };
    if (toolType === 'codex') {
      const presentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const revisionContext = JSON.stringify({ promptPresentationRevision: presentationRevision });
      if (payload.ifRevision) {
        const validation = await validateHistoryRevision(
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
          };
        }
      }
      const startedAt = Date.now();
      const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
      if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', entries: [] };
      const loadedAt = Date.now();
      const entries = this.codexData._api.buildCodexTimeline(loaded.records || [], sessionId);
      const presentedEntries = decorateHistoryPromptPresentations(this.promptPresentationStore, {
        toolType,
        sessionId,
        entries,
      });
      const sessionMeta = this.codexData._api.getTimelineSessionMeta(loaded.records || []);
      const finalPresentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const revision = buildHistoryRevision(
        { toolType, sessionId, cwd },
        loaded.sourceSnapshot ? [loaded.sourceSnapshot] : [],
        {
          context: JSON.stringify({ promptPresentationRevision: finalPresentationRevision }),
        }
      );
      const finishedAt = Date.now();
      if (finishedAt - startedAt >= 50) {
        console.log('[TranscriptService:TimelineProjection] tool=codex' +
          ' session=' + shortId(sessionId) +
          ' records=' + (loaded.records?.length || 0) +
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
        filePath: loaded.filePath,
        revision,
      };
    }
    const found = this.claudeData?.findSessionFile?.(sessionId, cwd);
    if (!found) return { success: true, entries: [], sessionId, toolType };
    const entries = this.claudeData.parseTimelineEntries(found.filePath);
    return {
      success: true,
      entries: decorateHistoryPromptPresentations(this.promptPresentationStore, {
        toolType,
        sessionId,
        entries,
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
      const presentationRevision = this.promptPresentationStore?.getHistoryPromptPresentationRevision
        ? this.promptPresentationStore.getHistoryPromptPresentationRevision(toolType, sessionId)
        : 'none';
      const responseTimingRevision = this.promptPresentationStore?.getHistoryResponseTimingRevision
        ? this.promptPresentationStore.getHistoryResponseTimingRevision(toolType, sessionId, payload.tabId || null)
        : 'none';
      const revisionContext = JSON.stringify({
        promptPresentationRevision: presentationRevision,
        responseTimingRevision,
      });
      if (payload.ifRevision) {
        const validation = await validateHistoryRevision(
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
          };
        }
      }
      const loaded = await this.codexData?._api?.loadSessionRecords?.(sessionId, cwd);
      if (!loaded?.success) return loaded || { success: false, error: 'codex parser unavailable', entries: [] };
      const entries = this.codexData._api.buildCodexFullHistory(loaded.records || [], sessionId);
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
        loaded.sourceSnapshot ? [loaded.sourceSnapshot] : [],
        {
          context: JSON.stringify({
            promptPresentationRevision: finalPresentationRevision,
            responseTimingRevision: finalResponseTimingRevision,
          }),
        }
      );
      const historyWindow = applyHistoryEntryWindow(timedEntries, payload.bounds);
      return {
        success: true,
        unchanged: false,
        entries: historyWindow.entries,
        total: historyWindow.total,
        dropped: historyWindow.dropped,
        truncated: historyWindow.truncated,
        boundsApplied: historyWindow.boundsApplied,
        firstUuid: historyWindow.firstUuid,
        lastUuid: historyWindow.lastUuid,
        claudeMemoryBoundaryUuid: null,
        filePath: loaded.filePath,
        revision,
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
    if (state.consumers.size === 0) {
      this._closeState(state, 'no-consumers');
      this.sessions.delete(key);
    }
  }

  async _ensureState({ key, toolType, sessionId, cwd }) {
    const existing = this.sessions.get(key);
    if (existing) return existing;

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
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
        parsed += 1;
      } catch {
        continue;
      }
      const content = record?.message?.content;
      const hasToolResult = record?.type === 'user'
        && Array.isArray(content)
        && content.some((block) => block?.type === 'tool_result');
      const isOrdinaryUser = record?.type === 'user'
        && record?.isMeta !== true
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
      if (isClaudePendingThinkingRecord(record)) {
        record.livePendingThinking = true;
      }
      if (!mainWindow || mainWindow.isDestroyed()) continue;
      // History, Timeline and the control bar can all subscribe to the same
      // session for one tab. A JSONL record is a tab event, not a subscriber
      // event: replaying `dequeue` once per consumer advances multiple queued
      // prompts. Fan out once per distinct tab instead.
      const tabIds = new Set(
        Array.from(state.consumers.values())
          .map((consumer) => String(consumer?.tabId || ''))
          .filter(Boolean),
      );
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
        mainWindow.webContents.send('agent-transcript:live-message', {
          tabId,
          toolType: 'claude',
          sessionId: state.sessionId,
          timestamp: record.timestamp || new Date().toISOString(),
          recordByteOffset,
          message: record,
          ...(promptOwner ? { promptOwner } : {}),
        });
        sent += 1;
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
