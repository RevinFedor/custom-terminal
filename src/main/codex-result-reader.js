'use strict';

// A provider proof index, not a second lifecycle owner. It keeps structural
// records/physical locators, reuses the canonical carrier/outcome resolver and
// the existing Timeline coordinate reducer, and never enters the raw LRU.
const fs = require('fs');
const { createHash } = require('crypto');
const { performance } = require('perf_hooks');
const { codexUserMessageAuditText, codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText, isCodexProjectInstructionsUserText,
  isCodexGoalContinuationUserText, isCodexTurnAbortedUserText } = require('./codex-prompt-audit');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { summarizeResultText, projectResultText, MAX_RESULT_CHARS } = require('./codex-result-text');
const { selectCodexResultBootstrap } = require('./codex-result-bootstrap');
const { materializeCodexLegacyResult } = require('./codex-legacy-result-adapter');

function statKey(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const structural = record => record.type === 'event_msg'
  && ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type);
const turnId = record => String(record.payload?.turn_id ?? record.turn_id ?? '').trim();
const locatorKey = loc => [loc.filePath, loc.fromByte, loc.toByte].join(':');
const canDecideResult = result => result?.complete === true || result?.proofDefinitive === true
  || ['task_complete', 'turn_aborted', 'provider_error'].includes(result?.terminalEvent);

function createCodexResultReader({ readJsonlRange, createTimelineProjector, buildResult,
  extractText, userIdentity, isCompactPayload, extractReasoning, findExecutionContext, collectLegacy,
  maxViews = 24, maxIndexBytes = 64 * 1024 * 1024,
  maxTextBytes = 8 * 1024 * 1024, log = console } = {}) {
  const views = new Map(), flights = new Map(), texts = new Map();
  let textBytes = 0, epoch = 0;
  const stats = { bootstraps: 0, appendReads: 0, bytesRead: 0, bodyBytesRead: 0,
    verificationBytes: 0, sourceVerificationBytes: 0,
    records: 0, parseErrors: 0, textHits: 0, textMisses: 0 };

  function cacheText(key, value) {
    const old = texts.get(key);
    if (old) { textBytes -= old.bytes; texts.delete(key); }
    const bytes = Buffer.byteLength(typeof value === 'string' ? value : value.head + value.tail);
    if (bytes > maxTextBytes) return;
    texts.set(key, { value, bytes }); textBytes += bytes;
    while (textBytes > maxTextBytes) {
      const first = texts.keys().next().value;
      textBytes -= texts.get(first).bytes; texts.delete(first);
    }
  }
  function invalidate(filePath) {
    epoch++;
    for (const [key, entry] of views) {
      if (!filePath || entry.parts.some(part => part.segment.filePath === filePath)) views.delete(key);
    }
    // Body samples must never survive a same-offset rewrite.
    texts.clear(); textBytes = 0;
  }
  async function readBody(row) {
    const key = locatorKey(row.locator) + ':' + row.kind;
    const hit = texts.get(key);
    if (hit) { stats.textHits++; texts.delete(key); texts.set(key, hit); return hit.value; }
    stats.textMisses++;
    const loc = row.locator;
    const result = await readJsonlRange(loc.filePath, loc.fromByte, loc.toByte - 1,
      { lineCount: loc.startLine });
    stats.bodyBytesRead += loc.toByte - loc.fromByte;
    if (result.errors || result.records.length !== 1 || result.leftoverBuffer.length) throw new Error('result-body-source-changed');
    const record = result.records[0];
    const value = row.kind === 'user'
      ? codexUserMessageAuditText(record)
      : summarizeResultText(row.kind === 'terminal' ? record.payload?.last_agent_message : extractText(record.payload?.content));
    if (value === null) throw new Error('result-body-source-changed');
    cacheText(key, value);
    return value;
  }

  function createEntry(source) {
    return { sourceKey: source.revisionKey || source.key || source.sessionId,
      rows: [], starts: new Map(), boundaries: [], semanticRevision: 0,
      coordinates: createTimelineProjector(source.sessionId), coordinateLocators: new Map(),
      coordinateTexts: new Set(), parts: [], results: new Map(), epoch,
      sourceSnapshot: source.sourceSnapshot, indexBytes: 0 };
  }
  async function consume(entry, record, locator, physicalSessionId) {
    record = { ...record, __physicalSessionId: physicalSessionId,
      __segmentId: locator.segmentId, __segmentIndex: locator.segmentIndex };
    const payload = record.payload || {};
    const auditText = codexUserMessageAuditText(record);
    const assistant = record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant';
    const assistantText = assistant ? extractText(payload.content).trim() : '';
    const terminal = record.type === 'event_msg' && payload.type === 'task_complete';
    const isBoundary = structural(record);
    const compact = record.type === 'compacted' || (record.type === 'event_msg' && isCompactPayload?.(payload));
    const rollback = record.type === 'event_msg' && payload.type === 'thread_rolled_back';
    if (compact) entry.legacyCurrentUser = null;
    // The coordinate reducer receives only records that can change user
    // coordinates. Tool/usage/assistant presentation work is irrelevant here.
    if (auditText !== null || isBoundary || (record.type === 'event_msg' && payload.type === 'thread_rolled_back')) {
      entry.coordinates.feed(record);
      let state = entry.coordinates.exportState();
      if (auditText !== null && state.currentUser?.sourceLine === record.__line
        && state.currentUser?.sessionId === physicalSessionId) {
        entry.coordinateLocators.set(state.currentUser, { locator, kind: 'user' });
        entry.coordinateTexts.add(state.currentUser);
        state.currentUser.hasAssistant ??= false;
        entry.legacyCurrentUser = state.currentUser;
      }
      // Rollback can revive an older coordinate. Reload that ONE carrier to
      // preserve the existing alias comparison before processing the next row.
      if (payload.type === 'thread_rolled_back' && state.currentUser && !state.currentUser.content) {
        const row = entry.coordinateLocators.get(state.currentUser);
        if (row) {
          const text = await readBody(row);
          state.currentUser.content = codexUserMessagePresentationText({ type: 'event_msg', payload: { type: 'user_message', message: text } });
          state.currentTurnCanonicalUserText = state.currentUser.isGoalContinuation ? null : state.currentUser.content;
          entry.coordinateTexts.add(state.currentUser);
          entry.coordinates = createTimelineProjector(entry.sessionId, state);
        }
      }
      const needed = new Set([state.currentUser, ...(state.pendingResponseUsers || []).map(item => item.entry)]);
      for (const user of entry.coordinateTexts) {
        if (!needed.has(user)) { delete user.content; entry.coordinateTexts.delete(user); }
      }
      if (rollback) entry.legacyCurrentUser = state.currentUser;
    }
    // Match the former History-turn eligibility without retaining tool bodies:
    // an owned call/thinking row is assistant work; a late background output
    // alone must not qualify whichever user happens to be last now.
    const assistantEvidence = !!assistantText || record.type === 'response_item'
      && (['function_call', 'custom_tool_call'].includes(payload.type)
        || payload.type === 'reasoning' && !!extractReasoning?.(payload.summary));
    if (assistantEvidence && entry.legacyCurrentUser && entry.legacyCurrentUser.hasAssistant !== true) {
      entry.legacyCurrentUser.hasAssistant = true;
      entry.semanticRevision++; entry.results.clear();
    }
    if (auditText === null && !assistant && !isBoundary && !compact && !rollback) return;
    const header = { type: record.type, timestamp: record.timestamp, time: record.time,
      created_at: record.created_at, turn_id: record.turn_id,
      __line: record.__line, __byteOffset: record.__byteOffset, __physicalSessionId: physicalSessionId,
      __segmentId: record.__segmentId, __segmentIndex: record.__segmentIndex,
      payload: { type: payload.type, role: payload.role, phase: payload.phase,
        turn_id: payload.turn_id, started_at: payload.started_at,
        ...(rollback ? { num_turns: payload.num_turns, turns: payload.turns } : {}),
        metadata: payload.metadata && { turn_id: payload.metadata.turn_id },
        internal_chat_message_metadata_passthrough: payload.internal_chat_message_metadata_passthrough
          && { turn_id: payload.internal_chat_message_metadata_passthrough.turn_id },
        ...(terminal && payload.error ? { error: payload.error } : {}) } };
    const row = { record: header, locator, control: compact ? 'compact' : rollback ? 'rollback' : null,
      kind: auditText !== null ? 'user' : assistant ? 'assistant'
      : compact || rollback ? 'control' : 'terminal', length: 0 };
    if (auditText !== null) {
      cacheText(locatorKey(locator) + ':user', auditText);
      const presentation = codexUserMessagePresentationText(record);
      row.user = { ...userIdentity?.(record, entry.sessionId),
        timestamp: record.timestamp || record.time || record.created_at || null,
        auditHash: promptFingerprint(auditText), presentationHash: promptFingerprint(presentation),
        service: auditText.includes('<subagent_notification>')
          || isCodexEnvironmentContextUserText(presentation) || isCodexProjectInstructionsUserText(presentation)
          || isCodexGoalContinuationUserText(presentation) || isCodexTurnAbortedUserText(presentation) };
    }
    else if (assistant || terminal) {
      const sample = summarizeResultText(terminal ? payload.last_agent_message : assistantText);
      row.length = sample.length;
      cacheText(locatorKey(locator) + ':' + row.kind, sample);
      if (assistant) header.payload.content = row.length ? [{ type: 'output_text', text: 'x' }] : [];
      if (terminal && Object.prototype.hasOwnProperty.call(payload, 'last_agent_message')) header.payload.last_agent_message = row.length ? 'x' : '';
    }
    const index = entry.rows.length;
    if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type)) {
      const owner = entry.coordinates.exportState().currentUser;
      if (owner && !Number.isInteger(owner.legacyTerminalIndex)) owner.legacyTerminalIndex = index;
    }
    if (isBoundary) entry.boundaries.push(index);
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      const id = turnId(record), previous = entry.starts.get(id) || [];
      previous.push(index); entry.starts.set(id, previous);
    }
    entry.rows.push(row); entry.semanticRevision++; stats.records++;
    entry.results.clear();
  }

  async function sync(entry, source) {
    const beginEpoch = epoch;
    const segments = source.segments;
    const nextParts = [];
    entry.lastReadBytes = 0;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index], before = await fs.promises.stat(segment.filePath);
      const end = Math.min(segment.toByte ?? before.size, before.size);
      const old = entry.parts[index];
      const start = old ? old.end : segment.fromByte || 0;
      if (old && (end < old.end || before.size < old.stat.size || !sameFile(old.stat, before)
        || (before.size === old.stat.size && statKey(old.stat) !== statKey(before)))) {
        throw new Error('result-source-reset');
      }
      const hash = old ? old.hash.copy() : createHash('sha256');
      const result = end > start
        ? await readJsonlRange(segment.filePath, start, end - 1, {
          collectRecords: false, lineCount: old ? old.lineCount : segment.startLine || 0,
          leftoverBuffer: old?.leftoverBuffer,
          onChunk: chunk => hash.update(chunk),
          onRecord: (record, loc) => consume(entry, record,
            { ...loc, segmentId: segment.segmentId, segmentIndex: index },
            segment.physicalSessionId || source.sessionId),
        })
        : { lineCount: old?.lineCount ?? segment.startLine ?? 0, leftoverBuffer: old?.leftoverBuffer || Buffer.alloc(0), errors: 0 };
      stats.bytesRead += end - start;
      entry.lastReadBytes += end - start;
      if (old && end > start) stats.appendReads++;
      // Preserve the shared parser's tolerance of unrelated malformed lines.
      // Missing/malformed target evidence still cannot prove its result.
      stats.parseErrors += result.errors || 0;
      if (segment.frozen && (result.leftoverBuffer.length
        || (segment.endLine != null && result.lineCount !== segment.endLine))) throw new Error('result-frozen-boundary-invalid');
      const after = await fs.promises.stat(segment.filePath);
      if (epoch !== beginEpoch || !sameFile(before, after) || after.size < end
        || (after.size === before.size && statKey(before) !== statKey(after))) throw new Error('result-source-changed-during-read');
      nextParts.push({ segment, end, stat: before, hash, lineCount: result.lineCount,
        leftoverBuffer: result.leftoverBuffer, verified: old?.verified && old.end === end
          && statKey(old.stat) === statKey(before) });
    }
    entry.parts = nextParts; entry.sourceSnapshot = { ...source.sourceSnapshot,
      size: nextParts.at(-1)?.end ?? source.sourceSnapshot?.size };
    entry.indexBytes = entry.rows.length * 320 + entry.coordinates.peekEntries().length * 240
      + nextParts.reduce((sum, part) => sum + part.leftoverBuffer.length, 0);
    if (epoch !== beginEpoch) throw new Error('result-source-invalidated');
  }

  async function projectRows(blocks, maxChars) {
    const limit = Math.max(500, Math.min(MAX_RESULT_CHARS, Number(maxChars) || 8000));
    const total = blocks.reduce((sum, row) => sum + row.length, 0) + Math.max(0, blocks.length - 1) * 2;
    const samples = [];
    for (let i = 0; i < blocks.length; i++) {
      if (total > limit && i !== 0 && i !== blocks.length - 1) {
        samples.push({ length: blocks[i].length }); continue;
      }
      const sample = await readBody(blocks[i]);
      if (!sample || sample.length !== blocks[i].length) throw new Error('result-text-source-changed');
      samples.push(sample);
    }
    return projectResultText(samples, maxChars, MAX_RESULT_CHARS);
  }

  async function materialize(entry, sessionId, proof, maxChars, { historical = false } = {}) {
    if (!proof.targetExecutionContext?.turnId) {
      const selected = await selectCodexResultBootstrap({ rows: entry.rows,
        coordinates: entry.coordinates.peekEntries(), sessionId, proof, readBody, findExecutionContext });
      if (!selected.selectedPrompt) return { success: false, error: selected.reason || 'bootstrap-prompt-not-found', proofDefinitive: false };
      if (!selected.targetExecutionContext) return materializeCodexLegacyResult({
        rows: entry.rows, coordinates: entry.coordinates.peekEntries(),
        selectedPrompt: selected.selectedPrompt, sessionId, readBody, collectLegacy, projectRows, maxChars });
      const context = selected.targetExecutionContext;
      const result = await materialize(entry, context.sessionId, { ...proof,
        promptUserUuid: selected.selectedPrompt.userUuid,
        promptSourceIdentity: selected.selectedPrompt.sourceIdentity,
        targetExecutionContext: context }, maxChars, { historical: true });
      return { ...result, executionContext: context };
    }
    const expectedId = String(proof.targetExecutionContext?.turnId || '').trim();
    const starts = entry.starts.get(expectedId) || [];
    let selected = [];
    if (starts.length === 1) {
      const start = starts[0];
      const previous = entry.boundaries.filter(value => value < start).at(-1) ?? -1;
      const next = entry.boundaries.find(value => value > start) ?? entry.rows.length;
      selected = entry.rows.slice(Math.max(0, previous), next + 1);
    } else selected = starts.map(index => entry.rows[index]);
    const rows = [];
    for (const row of selected) {
      const record = { ...row.record, payload: { ...row.record.payload } };
      if (row.kind === 'user') {
        const text = await readBody(row);
        if (record.type === 'event_msg') record.payload.message = text;
        else record.payload.content = [{ type: 'input_text', text }];
      }
      rows.push(record);
    }
    // Resolve structure/identity first; expensive body retrieval is limited to
    // the selected result, never every historical assistant/tool payload.
    let selectedTextRange;
    const coordinates = () => entry.coordinates.peekEntries();
    const options = {
      allowTimeOnly: true,
      allowHistoricalGenerationUnknown: historical,
      getTurnIndex: uuid => coordinates().find(item => item.type === 'user' && item.uuid === uuid)?.turnIndex,
      projectAssistant: range => {
        selectedTextRange = range;
        return { assistantText: 'x', assistantChars: 1, truncated: false };
      },
    };
    const check = buildResult(rows, sessionId, proof, maxChars, options);
    if (!check.success || !selectedTextRange) return check;
    const { promptIndex, boundaryIndex, terminalIndex } = selectedTextRange;
    let blocks = selected.slice(promptIndex + 1, boundaryIndex).filter(row => row.kind === 'assistant' && row.length > 0);
    if (!blocks.length && terminalIndex >= 0 && selected[terminalIndex]?.length > 0) blocks = [selected[terminalIndex]];
    const projection = await projectRows(blocks, maxChars);
    // Reuse the SAME outcome/matcher after body availability is known. In
    // particular an empty open turn remains ASSISTANT_NOT_MATERIALIZED.
    return buildResult(rows, sessionId, proof, maxChars, { ...options, projectAssistant: () => projection });
  }

  async function verifyPrefix(entry) {
    for (const part of entry.parts) {
      if (part.verified) continue;
      const hash = createHash('sha256');
      if (part.end > part.segment.fromByte) {
        for await (const chunk of fs.createReadStream(part.segment.filePath, {
          start: part.segment.fromByte || 0, end: part.end - 1, highWaterMark: 1024 * 1024,
        })) { hash.update(chunk); stats.verificationBytes += chunk.length; entry.lastVerifyBytes += chunk.length; }
      }
      if (hash.digest('hex') !== part.hash.copy().digest('hex')) throw new Error('result-source-reset');
      part.verified = true;
    }
  }

  async function validateLatestSource(entry, latest, sessionId, authoritative) {
    if ((latest.viewOwnerSessionId && latest.viewOwnerSessionId !== sessionId)
      || (latest.sessionId && latest.sessionId !== sessionId)) throw new Error('result-source-session-mismatch');
    if ((latest.revisionKey || latest.key || sessionId) !== entry.sourceKey
      || latest.segments?.length !== entry.parts.length) throw new Error('result-source-reset');
    for (let i = 0; i < entry.parts.length; i++) {
      const part = entry.parts[i], next = latest.segments[i], old = part.segment;
      if (next.filePath !== old.filePath || next.physicalSessionId !== old.physicalSessionId
        || next.segmentId !== old.segmentId || (next.fromByte || 0) !== (old.fromByte || 0)
        || (next.startLine || 0) !== (old.startLine || 0) || !!next.frozen !== !!old.frozen
        || (old.frozen && (next.toByte !== old.toByte || next.endLine !== old.endLine))) {
        throw new Error('result-source-reset');
      }
      const snapshot = next.sourceSnapshot || (latest.sourceSnapshot?.filePath === next.filePath
        ? latest.sourceSnapshot : null);
      // Real descriptors contain the full physical version. Keep an explicit
      // stat fallback for minimal adapters; a logical revision key is not proof
      // that a body read / cached result still belongs to this physical file.
      const current = snapshot && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
        .every(key => Number.isFinite(snapshot[key])) ? snapshot : await fs.promises.stat(next.filePath);
      if (!sameFile(part.stat, current) || current.size < part.stat.size || current.size < part.end) {
        throw new Error('result-source-reset');
      }
      if (statKey(current) !== statKey(part.stat)) {
        if (current.size === part.stat.size) throw new Error('result-source-reset');
        // Speculative observation may lag a concurrent append. A decision must
        // re-read the tail and verify it, including rewrite combined with growth.
        if (authoritative) throw new Error('result-source-advanced');
      }
      if (!next.frozen && authoritative && Number(next.toByte) > part.end) {
        throw new Error('result-source-advanced');
      }
    }
  }

  async function loadInner({ sessionId, cwd, proof, maxChars, resolveSource, forceFresh = false,
    resultReadMode = 'authoritative' }) {
    const started = performance.now();
    let readBytes = 0, verifyBytes = 0, sourceVerifyBytes = 0;
    const countSourceVerification = source => {
      const bytes = Math.max(0, Number(source?.sourceVerificationBytes) || 0);
      sourceVerifyBytes += bytes; stats.sourceVerificationBytes += bytes;
    };
    const resolve = async verifyDigests => {
      try {
        const source = await resolveSource({ sessionId, cwd, verifyDigests });
        countSourceVerification(source);
        return source;
      } catch (error) {
        countSourceVerification(error);
        throw error;
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = await resolve(false);
      if (!resolved?.success) return resolved || { success: false, error: 'result-source-unavailable' };
      if ((resolved.viewOwnerSessionId && resolved.viewOwnerSessionId !== sessionId)
        || (resolved.sessionId && resolved.sessionId !== sessionId)) {
        return { success: false, error: 'result-source-session-mismatch' };
      }
      const source = { ...resolved, sessionId };
      const key = sessionId + ':' + (cwd || '');
      let entry = views.get(key);
      if (entry?.sourceKey !== (source.revisionKey || source.key || source.sessionId)) entry = null;
      if (!entry) { entry = createEntry(source); entry.sessionId = sessionId; stats.bootstraps++; }
      const readMode = entry.parts.length ? 'warm' : 'bootstrap';
      entry.lastVerifyBytes = 0;
      const beginEpoch = epoch;
      try {
        try { await sync(entry, source); } finally { readBytes += entry.lastReadBytes; }
        const resultKey = JSON.stringify([proof, maxChars]);
        let result = entry.results.get(resultKey);
        if (!result) {
          result = await materialize(entry, sessionId, proof, maxChars); entry.results.set(resultKey, result);
          while (entry.results.size > 8) entry.results.delete(entry.results.keys().next().value);
        }
        // A cheap observation has NO authority to settle or recover a run.
        // Only a caller about to make that decision promotes the candidate.
        // Verify negative terminals too: abort / empty final can trigger
        // recovery even though the provider classifier says complete=false.
        const sourceVerified = resultReadMode !== 'observe' && (resultReadMode === 'source-proof'
          || canDecideResult(result)
          // Source notification handoff proves prompt receipt before its
          // answer finishes. That explicit caller also needs byte authority.
          || (resultReadMode === 'prompt-proof' && result.success === true));
        if (sourceVerified) {
          try { await verifyPrefix(entry); } finally { verifyBytes += entry.lastVerifyBytes; }
        }
        if (epoch !== beginEpoch) throw new Error('result-source-invalidated');
        // A lineage commit need not replace the child file. Revalidate the
        // descriptor after I/O too, not only its physical inode before I/O.
        const latestSource = await resolve(sourceVerified);
        if (!latestSource?.success) throw new Error(latestSource?.lineageReason || latestSource?.error || 'result-source-unavailable');
        if (sourceVerified && latestSource.digestsVerified === false) throw new Error('result-source-digests-unverified');
        await validateLatestSource(entry, latestSource, sessionId, sourceVerified);
        if (epoch !== beginEpoch) throw new Error('result-source-invalidated');
        views.delete(key); views.set(key, entry);
        entry.indexBytes += [...entry.results.values()].reduce((sum, value) => sum + Buffer.byteLength(value.assistantText || ''), 0);
        let retained = [...views.values()].reduce((sum, value) => sum + value.indexBytes, 0);
        for (const [oldKey, old] of views) {
          if (views.size <= maxViews && retained <= maxIndexBytes) break;
          if (oldKey === key) continue;
          views.delete(oldKey); retained -= old.indexBytes;
        }
        log.log?.('[CodexResultReader] session=' + sessionId.slice(0, 12)
          + ' mode=' + (readMode === 'bootstrap' ? readMode : entry.lastReadBytes ? 'append' : 'unchanged')
          + ' records=' + entry.rows.length + ' readBytes=' + readBytes + ' verifyBytes=' + verifyBytes
          + ' sourceVerifyBytes=' + sourceVerifyBytes + ' authority=' + Number(sourceVerified)
          + ' elapsedMs=' + (performance.now() - started).toFixed(1)
          + ' complete=' + Number(result.complete === true));
        return { ...result, sourceSnapshot: entry.sourceSnapshot, sourceVerified };
      } catch (error) {
        if (attempt === 0 && error.message === 'result-source-advanced' && epoch === beginEpoch) {
          views.set(key, entry);
          continue;
        }
        views.delete(key); texts.clear(); textBytes = 0;
        if (attempt === 0 && error.message === 'result-source-reset') continue;
        log.warn?.('[CodexResultReader] session=' + sessionId.slice(0, 12)
          + ' mode=failed readBytes=' + readBytes + ' verifyBytes=' + verifyBytes
          + ' sourceVerifyBytes=' + sourceVerifyBytes + ' authority=0'
          + ' elapsedMs=' + (performance.now() - started).toFixed(1) + ' error=' + error.message);
        return { success: false, error: error.message, proofDefinitive: false, sourceVerified: false,
          retryable: error.message.startsWith('result-source-') };
      }
    }
  }
  function load(request) {
    const key = request.sessionId + ':' + (request.cwd || '');
    const previous = flights.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => loadInner(request));
    flights.set(key, next);
    next.finally(() => { if (flights.get(key) === next) flights.delete(key); }).catch(() => {});
    return next;
  }
  return { load, invalidate, stats: () => ({ ...stats, views: views.size, textBytes,
    indexBytes: [...views.values()].reduce((sum, value) => sum + value.indexBytes, 0) }) };
}

module.exports = { createCodexResultReader };
