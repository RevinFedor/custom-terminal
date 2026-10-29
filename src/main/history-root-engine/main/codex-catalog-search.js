'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DEFER, PRESENCE, ITEMS, createJsonProjection, readProjectedJsonlRange } = require('./codex-json-projection');
const { codexUserMessagePresentationText, codexUserCarrierTextsMatch } = require('./codex-prompt-audit');
const { scoreSessionTurnMatch } = require('./session-catalog-search');

const CHUNK_BYTES = 256 * 1024;
const SNAPSHOT_LIMITS = Object.freeze({ encodedValueBytes: 8 * 1024 * 1024,
  structuralBatchBytes: 16 * 1024 * 1024, retainedRows: 50000 });
const INVALIDATED = 'CODEX_SOURCE_READ_INVALIDATED';
const HEAD = { type: true, role: true, name: true, tool_name: true, turn_id: true };
const TEXT_ITEM = { type: true, text: true, value: true, message: true,
  image_url: PRESENCE, imageUrl: PRESENCE };
const TEXT = { ...TEXT_ITEM, [ITEMS]: TEXT_ITEM };
const MESSAGE = { ...HEAD, phase: true, message: true, text: true, content: TEXT,
  local_images: { [ITEMS]: true }, images: { [ITEMS]: true } };
const ROW = { type: true, timestamp: true, time: true, created_at: true,
  turn_id: true, payload: { [DEFER]: HEAD } };

function invalidated(cause) {
  return Object.assign(new Error('Codex catalog source changed during read', { cause }), { code: INVALIDATED });
}
function physicalKey(snapshot) {
  return JSON.stringify([snapshot.filePath, snapshot.fileIdentity ?? `${snapshot.dev}:${snapshot.ino}`,
    snapshot.size, snapshot.mtimeMs, snapshot.ctimeMs]);
}
function statSnapshot(filePath, stat) {
  return { filePath, fileIdentity: `${stat.dev}:${stat.ino}`, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function logicalKey(source) {
  return JSON.stringify([source.kind, source.viewOwnerSessionId, source.revisionKey,
    source.eventKey, source.manifestDigest, source.childPrefix,
    source.segments.map(segment => [segment.segmentId, segment.filePath, segment.physicalSessionId,
      segment.fromByte, segment.toByte, segment.startLine, segment.endLine, segment.frozen,
      segment.digest, physicalKey(segment.sourceSnapshot)])]);
}
// Same predicate as Main's catalog eligibility (guarded against drift by the
// differential controls). The canonical projector owns all provider filters.
function noise(text) {
  return !text || typeof text !== 'string'
    || ['<command-name>', '<system-reminder>', '<task-notification>', '<local-command-stdout>',
      '<local-command-stderr>', '<local-command-caveat>'].some(marker => text.includes(marker))
    || text.startsWith('[Request interrupted');
}
function textContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof content.text === 'string' ? content.text
    : typeof content.value === 'string' ? content.value : '';
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') parts.push(part);
    else if (typeof part.text === 'string') parts.push(part.text);
    else if (typeof part.value === 'string') parts.push(part.value);
  }
  return parts.join('\n');
}
// A substring can pin its entire parent string in V8. UTF16 copying also
// preserves a lone surrogate at the exact 500-code-unit preview boundary.
const preview = text => Buffer.from(text.slice(0, 500), 'utf16le').toString('utf16le');
function thinActions(actions) {
  return (actions || []).map(action => ({ tool: action.tool, toolUseId: action.toolUseId,
    ...(action.rawTool ? { rawTool: { toolUseId: action.rawTool.toolUseId } } : {}) }));
}
/** Query-local canonical projection. No raw array, full body graph or cache.
 * Searchable bodies are hydrated one FINAL logical pair at a time. Structural
 * tool decoding still uses the canonical decoder: a single tool payload, and
 * the accumulated outputs of ONE async cell, can be large transient values.
 * Patch-event routing also transiently hydrates open patch/exec invocations
 * together, because the canonical router compares their literal paths.
 * This is not a fixed heap cap; those peaks are reported, never truncated.
 */
function createCodexCatalogSearchReader({ codexApi, onRead, onDiagnostic } = {}) {
  for (const method of ['createCodexHistoryProjector', 'codexHistoryActionsForCall',
    'codexHistorySettledOutputParts', 'beginCodexSourceRead', 'assertCodexSourceRead',
    'finishCodexSourceRead', 'isCodexSourceSnapshotCurrent']) {
    if (typeof codexApi?.[method] !== 'function') throw new Error(`Codex catalog API unavailable: ${method}`);
  }

  async function search({ sessionId, query, matchesPerSession, resolveSource, assertLogicalCurrent,
    snapshot = null, assertSnapshotCurrent }) {
    const started = performance.now();
    const diagnostics = { scanBytes: 0, hydrateBytes: 0, sourceVerificationBytes: 0,
      records: 0, parseErrors: 0, partialBytes: 0, sources: 0,
      // Projection token+chunk buffering and encoded selected token/value sizes,
      // not peak heap/RSS or the canonical decoder's temporary allocations.
      maxBufferedBytes: 0, maxParsedValueBytes: 0, maxStructuralValueBytes: 0,
      maxCellOutputChars: 0, maxPatchCallPayloadBytes: 0, maxPairChars: 0,
      observationFailures: 0 };
    const reads = new Map(), witnesses = [];
    let snapshotSource = null, currentExecution = null;
    const snapshotCutoff = [];
    const executionKeys = new Set();
    let handlesClosed = false;
    const closeWitnesses = async () => {
      if (handlesClosed) return;
      handlesClosed = true;
      const results = await Promise.allSettled(witnesses.map(({ witness }) => witness.close()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    };
    const count = (bytes, phase) => {
      if (!(bytes > 0)) return;
      diagnostics[phase === 'scan' ? 'scanBytes' : phase === 'source-verification'
        ? 'sourceVerificationBytes' : 'hydrateBytes'] += bytes;
      try { onRead?.({ bytes, phase }); }
      catch { diagnostics.observationFailures++; }
    };
    const boundedValue = loc => {
      if (snapshot && loc.to - loc.from > SNAPSHOT_LIMITS.encodedValueBytes) {
        throw Object.assign(new Error('History snapshot value exceeds the decode budget'), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
      }
    };
    const projected = async (loc, schema) => {
      boundedValue(loc);
      // Same shared value projection, with its encoded token/chunk metrics
      // included in this query's diagnostics as well as the initial scan.
      const parser = createJsonProjection(schema);
      let offset = loc.from;
      for await (const bytes of fs.createReadStream(loc.filePath, {
        start: loc.from, end: loc.to - 1, highWaterMark: CHUNK_BYTES,
      })) {
        parser.write(bytes.toString('latin1'), offset); offset += bytes.length;
        count(bytes.length, 'hydrate');
        await new Promise(resolve => setImmediate(resolve));
      }
      const result = parser.finish(offset);
      const stats = parser.stats();
      diagnostics.maxBufferedBytes = Math.max(diagnostics.maxBufferedBytes, stats.maxBufferedBytes);
      // No decoded-graph walk/serialization solely to measure diagnostics.
      // This covers retained scalar/key tokens, not aggregate container size.
      diagnostics.maxParsedValueBytes = Math.max(diagnostics.maxParsedValueBytes, stats.maxTokenBytes);
      if (!result.valid || offset !== loc.to) throw invalidated();
      const value = result.value;
      return value;
    };
    // Native JSON.parse is used only for selected structural values, whose
    // arbitrary argument/result keys the canonical tool decoder needs. JSONL
    // validation, skipped bodies and message projection use the shared parser.
    // There is no new JSON grammar or fallback full-record/array reader.
    const structural = async loc => {
      boundedValue(loc);
      diagnostics.maxStructuralValueBytes = Math.max(diagnostics.maxStructuralValueBytes, loc.to - loc.from);
      diagnostics.maxParsedValueBytes = Math.max(diagnostics.maxParsedValueBytes, loc.to - loc.from);
      const chunks = [];
      for await (const bytes of fs.createReadStream(loc.filePath, {
        start: loc.from, end: loc.to - 1, highWaterMark: CHUNK_BYTES,
      })) { chunks.push(bytes); count(bytes.length, 'hydrate'); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const message = async descriptor => ({ ...descriptor.header,
      payload: await projected(descriptor.payload, MESSAGE) });
    const userText = async descriptor => codexUserMessagePresentationText(await message(descriptor));
    let current, preparedMatches = new Set(), restoredCell, currentPatchPayload;
    const users = new WeakMap(), calls = new WeakMap(), cells = new WeakMap(), pendingActions = new WeakMap();
    const detachCall = call => {
      if (!call) return;
      let descriptor = calls.get(call);
      if (!descriptor && call.record) { descriptor = current; calls.set(call, descriptor); }
      if (!descriptor) return;
      // cell_id is the only argument finalize uses before the decoder hook.
      call.args = call.args?.cell_id == null ? {} : { cell_id: call.args.cell_id };
      call.patchApplyEvents = [];
      call.record = descriptor.header;
    };
    const restoreCall = async call => {
      const descriptor = calls.get(call);
      if (!descriptor) return;
      const record = { ...descriptor.header, payload: await structural(descriptor.payload) };
      const payload = record.payload;
      let args;
      if (payload.arguments) {
        try { args = JSON.parse(payload.arguments) || {}; }
        catch { args = { raw: payload.arguments }; }
      } else args = payload.input && typeof payload.input === 'string' ? { input: payload.input } : payload.input || {};
      call.args = args && typeof args === 'object' ? args : { value: args };
      call.record = record;
      call.patchApplyEvents = [];
      for (const patch of descriptor.patches || []) {
        call.patchApplyEvents.push(await structural(patch.payload));
      }
    };
    const sink = {
      questionMetadata: false, // proof metadata cannot change catalog rows
      retainUserText: () => current,
      userTextForEntry: entry => users.get(entry),
      userTextsMatch: (candidate, text) => typeof candidate === 'string'
        ? codexUserCarrierTextsMatch(candidate, text) : preparedMatches.has(candidate),
      onUserEntry(entry) { users.set(entry, current); entry.catalogUser = current; entry.content = ''; },
      onAssistantEntry(entry) {
        // Only ordinary assistant messages contribute searchable content.
        if (entry.content) entry.catalogAssistant = current;
        entry.content = ''; entry.thinking = undefined;
        entry.actions = thinActions(entry.actions);
      },
      pendingActionsForCall: call => pendingActions.get(call),
      afterFeed(state) {
        if (snapshot && state.entries.length + state.pendingCalls.size + state.pendingExecCells.size > SNAPSHOT_LIMITS.retainedRows) {
          throw Object.assign(new Error('History snapshot exceeds the projection row budget'), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
        }
        const measureCell = cell => {
          if (cell?.parts) diagnostics.maxCellOutputChars = Math.max(diagnostics.maxCellOutputChars,
            cell.parts.reduce((sum, part) => sum + part.length, 0));
        };
        // A completed wait may have removed its cell from the active map.
        measureCell(restoredCell);
        for (const call of state.pendingCalls.values()) {
          if (currentPatchPayload && call.patchApplyEvents.includes(currentPatchPayload)) {
            (calls.get(call).patches ||= []).push(current);
          }
          detachCall(call);
        }
        for (const cell of state.pendingExecCells.values()) {
          measureCell(cell);
          let descriptor = cells.get(cell);
          if (!descriptor) { descriptor = { outputs: [current] }; cells.set(cell, descriptor); }
          else if (cell === restoredCell) descriptor.outputs.push(current);
          detachCall(cell.call);
          cell.parts = []; cell.actions.splice(0, cell.actions.length, ...thinActions(cell.actions));
        }
        for (const card of state.subagents.cardByCallId.values()) {
          // Status/identity are structural; descriptions/results are not.
          delete card.result; delete card.launchSettings;
          card.baseDescription = 'Subagent'; card.description = 'Subagent';
        }
      },
    };
    const projector = codexApi.createCodexHistoryProjector(sessionId, {}, { catalogSink: sink });

    const consume = async (record, locator, segment) => {
      const payloadLoc = record.payload && { ...record.payload, filePath: locator.filePath };
      const header = { ...record, payload: undefined, __physicalSessionId: segment.physicalSessionId || sessionId,
        __segmentId: segment.segmentId };
      current = { header, payload: payloadLoc };
      // Classify from the validating first pass; ignored telemetry does not
      // open another stream merely to discover its type.
      const head = payloadLoc?.value || {};
      if (snapshot && record.type === 'event_msg') {
        const providerTurnId = head.turn_id || record.turn_id || null;
        const physicalSessionId = header.__physicalSessionId;
        if (head.type === 'task_started') {
          const key = physicalSessionId + ':' + providerTurnId;
          if (executionKeys.size >= SNAPSHOT_LIMITS.retainedRows) {
            throw Object.assign(new Error('History snapshot exceeds the execution metadata budget'), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
          }
          currentExecution = { turnId: providerTurnId, physicalSessionId, status: providerTurnId ? 'in_progress' : 'unknown' };
          if (executionKeys.has(key)) currentExecution.status = 'unknown';
          executionKeys.add(key);
        } else if (['task_complete', 'turn_aborted'].includes(head.type) && currentExecution?.turnId
          && currentExecution.turnId === providerTurnId && currentExecution.physicalSessionId === physicalSessionId
          && currentExecution.status === 'in_progress') {
          currentExecution.status = head.type === 'task_complete' ? 'completed' : 'aborted';
        }
      }
      if (snapshot) current.execution = currentExecution;
      const isMessage = record.type === 'response_item' && head.type === 'message';
      const isUser = isMessage && head.role === 'user'
        || record.type === 'event_msg' && head.type === 'user_message';
      let payload = head;
      if (isMessage || isUser) payload = await projected(payloadLoc, MESSAGE);
      else if (payloadLoc && (record.type === 'response_item' && ['function_call', 'custom_tool_call',
        'function_call_output', 'custom_tool_call_output', 'reasoning', 'agent_message'].includes(head.type)
        || record.type === 'event_msg' && ['patch_apply_end', 'sub_agent_activity', 'thread_rolled_back'].includes(head.type)
        || record.type === 'turn_context'
        || record.type === 'event_msg' && head.type === 'thread_settings_applied')) payload = await structural(payloadLoc);
      else if (payloadLoc && record.type === 'session_meta') {
        payload = await projected(payloadLoc, snapshot ? { cwd: true, id: true, session_id: true, history_mode: true } : { cwd: true });
        if (snapshot && (payload.id || payload.session_id) && (payload.id || payload.session_id) !== header.__physicalSessionId) throw invalidated();
        if (snapshot && source.kind === 'physical' && payload.history_mode === 'paginated') {
          throw Object.assign(new Error('snapshot_requires_prepared_lineage'), { code: 'history_lineage_unresolved',
            lineageReason: 'snapshot_requires_prepared_lineage' });
        }
      }
      // Settings, token/error/compact summaries do not enter catalog matching;
      // their role/boundary remains in the unchanged canonical reducer.
      const materialized = { ...header, payload: payload || {} };
      preparedMatches = new Set();
      if (isUser) {
        const text = codexUserMessagePresentationText(materialized);
        const candidates = new Set(projector.userMatchCandidates(materialized, text));
        for (const candidate of candidates) {
          if (codexUserCarrierTextsMatch(await userText(candidate), text)) preparedMatches.add(candidate);
        }
      }
      restoredCell = null;
      const state = projector.catalogState();
      currentPatchPayload = null;
      if (record.type === 'event_msg' && head.type === 'patch_apply_end') {
        // Reuse canonical direct/path/unique-open routing, including an event
        // whose id differs from the enclosing exec's provider call id.
        currentPatchPayload = payload;
        let bytes = 0;
        for (const call of state.pendingCalls.values()) {
          if (!['apply_patch', 'exec'].includes(call.toolName)) continue;
          const loc = calls.get(call)?.payload;
          if (loc) bytes += loc.to - loc.from;
          if (snapshot && bytes > SNAPSHOT_LIMITS.structuralBatchBytes) {
            throw Object.assign(new Error('History snapshot patch batch exceeds the decode budget'), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
          }
          await restoreCall(call);
        }
        diagnostics.maxPatchCallPayloadBytes = Math.max(diagnostics.maxPatchCallPayloadBytes, bytes);
      }
      if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(head.type)) {
        const call = state.pendingCalls.get(payload.call_id || payload.id);
        if (call) {
          await restoreCall(call);
          restoredCell = call.toolName === 'wait' ? state.pendingExecCells.get(String(call.args?.cell_id || '')) : null;
          if (restoredCell) {
            await restoreCall(restoredCell.call);
            restoredCell.parts = [];
            let batchBytes = 0;
            for (const output of cells.get(restoredCell).outputs) {
              batchBytes += output.payload.to - output.payload.from;
              if (snapshot && batchBytes > SNAPSHOT_LIMITS.structuralBatchBytes) {
                throw Object.assign(new Error('History snapshot cell exceeds the decode budget'), { code: 'HISTORY_SNAPSHOT_BUDGET_EXCEEDED' });
              }
              const body = await structural(output.payload);
              restoredCell.parts.push(...codexApi.codexHistorySettledOutputParts(body.output));
            }
            diagnostics.maxCellOutputChars = Math.max(diagnostics.maxCellOutputChars,
              restoredCell.parts.reduce((sum, part) => sum + part.length, 0));
          }
        }
      }
      try { projector.feed(materialized); }
      finally { currentPatchPayload = null; restoredCell = null; }
    };

    let source, sourceAdmitted = false;
    try {
      source = await resolveSource();
      if (!source?.success || !Array.isArray(source.segments) || !snapshot && source.digestsVerified === false) {
        throw Object.assign(new Error(source?.error || 'Codex catalog source unavailable'), {
          code: source?.retryable === true ? INVALIDATED : source?.error === 'lineage_unresolved'
            ? 'history_lineage_unresolved' : 'history_source_read_failed',
          lineageReason: source?.lineageReason,
        });
      }
      sourceAdmitted = true;
      if (snapshot && (source.viewOwnerSessionId !== sessionId || !source.segments.length)) throw invalidated();
      if (snapshot) snapshotSource = await require('./codex-snapshot-source').captureCodexSnapshotSource(source, {
        assertCurrent: assertSnapshotCurrent, onRead: bytes => count(bytes, 'source-verification'),
      });
      else for (const segment of source.segments) {
        if (!reads.has(segment.filePath)) {
          const read = await codexApi.beginCodexSourceRead(segment.filePath, segment.physicalSessionId || sessionId);
          reads.set(segment.filePath, read);
          const witness = await fs.promises.open(segment.filePath, 'r');
          witnesses.push({ witness, filePath: segment.filePath, key: physicalKey(read.snapshot) });
          if (physicalKey(statSnapshot(segment.filePath, await witness.stat())) !== physicalKey(read.snapshot)) throw invalidated();
        }
        if (physicalKey(reads.get(segment.filePath).snapshot) !== physicalKey(segment.sourceSnapshot)) throw invalidated();
      }
      diagnostics.sources = snapshot ? new Set(source.segments.map(segment => segment.filePath)).size : reads.size;
      count(source.sourceVerificationBytes, 'source-verification');
      for (const segment of source.segments) {
        const metrics = {}, hash = createHash('sha256');
        const result = await readProjectedJsonlRange(segment.filePath, segment.fromByte, segment.toByte - 1, {
          schema: ROW, startLine: segment.startLine, highWaterMark: CHUNK_BYTES, metrics,
          onBytes: bytes => count(bytes, 'scan'), onChunk: bytes => hash.update(bytes),
          onRecord: (record, loc) => consume(record, loc, segment),
        });
        diagnostics.maxBufferedBytes = Math.max(diagnostics.maxBufferedBytes, metrics.maxBufferedBytes);
        diagnostics.maxParsedValueBytes = Math.max(diagnostics.maxParsedValueBytes, metrics.maxTokenBytes);
        diagnostics.records += result.parsed; diagnostics.parseErrors += result.errors;
        diagnostics.partialBytes += result.partialBytes;
        if (!snapshot && source.kind === 'virtual' && !segment.frozen && result.partialBytes) {
          // The former operation-source reader rejects an unfinished thin
          // child tail; physical JSONL readers may still expose prior lines.
          throw Object.assign(new Error('Codex child tail is incomplete'), {
            code: 'history_lineage_unresolved', lineageReason: 'child-tail-incomplete',
          });
        }
        const digest = hash.digest('hex');
        if (metrics.bytes !== segment.toByte - segment.fromByte || segment.frozen
          && (result.partialBytes || segment.endLine != null && result.lineCount !== segment.endLine
            || segment.digest && digest !== segment.digest)) throw invalidated();
        snapshotSource?.record(segment, digest);
        if (snapshot) snapshotCutoff.push({ segmentId: segment.segmentId, physicalSessionId: segment.physicalSessionId,
          fromByte: segment.fromByte, toByte: segment.toByte, completeToByte: segment.toByte - result.partialBytes,
          trailingPartialBytes: result.partialBytes, frozen: !!segment.frozen });
      }
      // Finalize one pending call at a time; the reducer still owns anchors,
      // wait suppression, spawn/control rows and thinking-only placeholders.
      for (const call of projector.pendingCallsForDecode()) {
        await restoreCall(call);
        const decoded = codexApi.codexHistoryActionsForCall(call, undefined, false);
        pendingActions.set(call, { actions: thinActions(decoded.actions), cellId: decoded.cellId });
        detachCall(call);
      }
      const rows = projector.finalize();
      const assistantByUuid = new Map(rows.filter(row => row.role === 'assistant').map(row => [row.uuid, row]));
      const pairs = []; let pair = null, turnIndex = 0;
      const flush = () => { if (pair) { pairs.push(pair); turnIndex++; } pair = null; };
      for (const row of rows) {
        if (row.role === 'user') { flush(); pair = { user: row, assistant: [], turnIndex }; }
        else if (row.role === 'compact') { flush(); turnIndex++; }
        else if (row.role === 'assistant') {
          pair ||= { user: null, assistant: [], turnIndex };
          pair.assistant.push(row.uuid);
        }
      }
      flush();
      const bestMatches = [], candidates = [], limit = Math.max(1, Math.min(10, Number(matchesPerSession) || 3));
      let totalIterations = 0;
      for (const pair of pairs) {
        if (!pair.user) continue;
        const prompt = await userText(pair.user.catalogUser);
        if (noise(prompt) || !prompt.trim()) continue;
        const iterationIndex = totalIterations++;
        if (snapshot) {
          candidates.push({ pair, prompt: { text: Buffer.from(prompt.slice(0, snapshot.maxChars), 'utf16le').toString('utf16le'),
            chars: prompt.length, truncated: prompt.length > snapshot.maxChars },
          promptHash: createHash('sha256').update(prompt).digest('hex'), iterationIndex });
          if (candidates.length > snapshot.limit) candidates.shift();
          continue;
        }
        if (!String(query || '').trim()) continue;
        const blocks = [];
        for (const uuid of pair.assistant) {
          const descriptor = assistantByUuid.get(uuid)?.catalogAssistant;
          if (!descriptor) continue;
          const text = textContent((await message(descriptor)).payload.content);
          if (text) blocks.push(text);
        }
        const answer = blocks.join('\n\n');
        diagnostics.maxPairChars = Math.max(diagnostics.maxPairChars, prompt.length + answer.length);
        const match = scoreSessionTurnMatch({ query, title: '', userText: prompt, assistantText: answer });
        if (match.matched) {
          bestMatches.push({ iterationIndex, turnIndex: pair.turnIndex, entryUuid: pair.user.uuid,
            timestamp: pair.user.timestamp || null, matchedIn: match.matchedIn, score: match.score,
            userPreview: preview(prompt), assistantPreview: preview(answer) });
          bestMatches.sort((a, b) => b.score - a.score || a.iterationIndex - b.iterationIndex);
          if (bestMatches.length > limit) bestMatches.pop();
        }
      }
      if (snapshot) {
        const entries = [];
        for (const { pair, prompt, promptHash, iterationIndex } of candidates) {
          const blocks = [], executions = new Set();
          let assistantChars = 0, retainedChars = 0, blockCount = 0;
          if (pair.user.catalogUser.execution) executions.add(pair.user.catalogUser.execution);
          for (const uuid of pair.assistant) {
            const descriptor = assistantByUuid.get(uuid)?.catalogAssistant;
            if (!descriptor) continue;
            if (descriptor.execution) executions.add(descriptor.execution);
            const text = textContent((await message(descriptor)).payload.content);
            if (text) {
              const separator = blockCount++ ? '\n\n' : '';
              assistantChars += separator.length + text.length;
              for (const part of [separator, text]) {
                const keep = Math.min(part.length, snapshot.maxChars - retainedChars);
                if (keep > 0) { blocks.push(Buffer.from(part.slice(0, keep), 'utf16le').toString('utf16le')); retainedChars += keep; }
              }
            }
          }
          const execution = executions.size === 1 ? [...executions][0] : null;
          const status = execution?.status || 'unknown';
          entries.push({ iterationIndex, turnIndex: pair.turnIndex, userUuid: pair.user.uuid,
            physicalSessionId: pair.user.sessionId || sessionId, turnId: execution?.turnId || null,
            timestamp: pair.user.timestamp || null, status, responseComplete: status === 'completed',
            user: prompt, assistant: { text: blocks.join(''), chars: assistantChars, truncated: assistantChars > snapshot.maxChars },
            ref: { sessionId, userUuid: pair.user.uuid, turnIndex: pair.turnIndex,
              userTextHash: promptHash } });
        }
        const latest = await resolveSource();
        await snapshotSource.validate(latest);
        await snapshotSource.close();
        handlesClosed = true;
        diagnostics.durationMs = performance.now() - started;
        try { onDiagnostic?.({ ...diagnostics }); } catch { diagnostics.observationFailures++; }
        snapshotSource.assertCurrent();
        if (assertLogicalCurrent?.(source) === false) throw invalidated();
        const snapshotId = snapshotSource.snapshotId();
        for (const entry of entries) entry.ref.snapshotId = snapshotId;
        return { success: true, version: 1, sessionId, viewOwnerSessionId: source.viewOwnerSessionId,
          snapshotId, asOf: new Date(snapshotSource.capturedAt).toISOString(),
          cutoff: snapshotCutoff,
          totalIterations, entries, coverage: { completeRecordsOnly: true, parseErrors: diagnostics.parseErrors,
            trailingPartialBytes: diagnostics.partialBytes, earlierIterationsOmitted: totalIterations - entries.length,
            physicalSourceCount: source.segments.length, textTruncated: entries.some(entry => entry.user.truncated || entry.assistant.truncated) }, diagnostics };
      }
      for (const read of reads.values()) await codexApi.assertCodexSourceRead(read);
      let finalSource;
      try { finalSource = await resolveSource(); }
      catch (error) { throw invalidated(error); }
      count(finalSource?.sourceVerificationBytes, 'source-verification');
      if (!finalSource?.success || finalSource.digestsVerified === false || logicalKey(source) !== logicalKey(finalSource)) throw invalidated();
      for (const { witness, filePath, key } of witnesses) {
        if (physicalKey(statSnapshot(filePath, await witness.stat())) !== key) throw invalidated();
      }
      for (const read of reads.values()) await codexApi.assertCodexSourceRead(read);
      await closeWitnesses();
      diagnostics.durationMs = performance.now() - started;
      try { onDiagnostic?.({ ...diagnostics }); }
      catch { diagnostics.observationFailures++; }
      // ALL async stat/close/resolve operations precede admission. A later
      // source's await may revoke an earlier ticket, so check the entire set
      // synchronously, with every ticket still pinned. No await follows this.
      for (const read of reads.values()) {
        if (read.ticket?.invalidated
          || !codexApi.isCodexSourceSnapshotCurrent(read.snapshot)) throw invalidated();
      }
      if (assertLogicalCurrent?.(source) === false) throw invalidated();
      return { success: true, totalIterations, bestMatches, diagnostics };
    } catch (error) {
      // A stable missing/invalid lineage or decoder failure is not proof of
      // mutation. Retrying every error could hash the same large bad source
      // three times. Only a revoked proof receives the existing retry code.
      if (!snapshot && sourceAdmitted && error.code !== INVALIDATED) {
        try {
          for (const read of reads.values()) await codexApi.assertCodexSourceRead(read);
          for (const read of reads.values()) {
            if (read.ticket?.invalidated || !codexApi.isCodexSourceSnapshotCurrent(read.snapshot)) throw invalidated();
          }
          if (assertLogicalCurrent?.(source) === false) throw invalidated();
        } catch (revoked) { throw invalidated(revoked); }
      }
      throw error;
    } finally {
      if (snapshotSource && !snapshotSource.closed) await snapshotSource.close();
      // Successful admission has already closed all async handles. Finishing
      // these synchronous tickets cannot open another mutation window.
      if (!handlesClosed) {
        try { await closeWitnesses(); }
        finally { for (const read of reads.values()) codexApi.finishCodexSourceRead(read); }
      } else for (const read of reads.values()) codexApi.finishCodexSourceRead(read);
    }
  }
  return { search, snapshot: options => search({ ...options, snapshot: {
    limit: options.limit ?? 5, maxChars: options.maxChars ?? 4000,
  } }) };
}

module.exports = { createCodexCatalogSearchReader, SNAPSHOT_LIMITS };
