'use strict';

const { performance } = require('node:perf_hooks');
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));
const STAGES = ['historyFeed', 'historyFinalize', 'timelineFeed', 'timelineFinalize', 'metadata', 'dto'];
const diagnostics = new WeakMap();
const micros = value => Math.max(0, Math.round(value * 1000));

function drainProjectionSteps(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

// One request owns these scalars and its private reducers. No slice history,
// persistent projector, raw-array clone, transport, or diagnostic per record.
function createProjectionControl({ assertCurrent = () => {}, schedule = yieldToEventLoop,
  now = () => performance.now(), maxUnits = 128, targetMs = 8 } = {}) {
  const stats = { slices: 0, yields: 0, maxSliceMs: 0, maxUnitMs: 0,
    historyFedRecords: 0, timelineFedRecords: 0 };
  for (const stage of STAGES) stats[stage] = 0;
  const observeSlice = (stage, start, end) => {
    const elapsed = Math.max(0, end - start);
    stats[stage] += elapsed;
    stats.slices++;
    stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
  };
  return {
    stats,
    unit(stage, callback) {
      assertCurrent();
      const start = now();
      try { return callback(); }
      finally {
        const end = now();
        stats.maxUnitMs = Math.max(stats.maxUnitMs, Math.max(0, end - start));
        observeSlice(stage, start, end);
      }
    },
    async drain(stage, iterator) {
      assertCurrent();
      let sliceStart = now(), units = 0;
      try {
        for (;;) {
          const unitStart = now();
          const step = iterator.next();
          const unitEnd = now();
          stats.maxUnitMs = Math.max(stats.maxUnitMs, Math.max(0, unitEnd - unitStart));
          units++;
          if (step.done) {
            observeSlice(stage, sliceStart, unitEnd);
            return step.value;
          }
          if (units >= maxUnits || unitEnd - sliceStart >= targetMs) {
            observeSlice(stage, sliceStart, unitEnd);
            stats.yields++;
            await schedule();
            assertCurrent();
            units = 0;
            sliceStart = now();
          }
        }
      } catch (error) {
        // Close suspended local generators without replacing the original
        // reducer/scheduler/fence exception or touching caller-owned records.
        try { iterator.return?.(); } catch {}
        throw error;
      }
    },
    fields() {
      const fields = { projectionMode: 'cooperative-physical',
        projectionSlices: stats.slices, projectionYields: stats.yields,
        projectionMaxSliceUs: micros(stats.maxSliceMs), projectionMaxUnitUs: micros(stats.maxUnitMs),
        projectionHistoryFedRecords: stats.historyFedRecords,
        projectionTimelineFedRecords: stats.timelineFedRecords };
      for (const stage of STAGES) fields['projection' + stage[0].toUpperCase() + stage.slice(1) + 'Us'] = micros(stats[stage]);
      return fields;
    },
  };
}

// Waiters contain promise continuations, not loaded raw snapshots or reducers.
// Warm hits bypass this queue. A failed preparation always releases in Main's
// finally; releasing BEFORE final admission covers reentrant scheduling hooks.
function createCodexTurnsPreparationQueue() {
  const waiting = [];
  let held = false;
  const dispatch = () => {
    if (held || waiting.length === 0) return;
    held = true;
    const resolve = waiting.shift();
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      held = false;
      dispatch();
    });
  };
  return { acquire() { return new Promise(resolve => { waiting.push(resolve); dispatch(); }); } };
}

function rememberProjectionDiagnostics(result, fields) {
  diagnostics.set(result, fields);
  return result;
}
function projectionDiagnostics(result) { return diagnostics.get(result) || {}; }

// The original Main mapping, including full recordMap bodies and tool indices.
// Only its traversal is resumable; synchronous/canonical callers drain it inline.
function* codexTurnsDtoSteps({ historyEntries, timelineEntries, sessionId, isNoisePrompt, toolDetail }) {
  let users = [];
  for (const entry of timelineEntries || []) {
    yield;
    if (entry?.type === 'user' && entry?.uuid) users.push(entry);
  }
  const codexTimelineUsersByUuid = new Map();
  for (const entry of users) { yield; codexTimelineUsersByUuid.set(entry.uuid, entry); }
  users = null;
  const turns = [];
  const recordMap = new Map();
  let current = null;

  const flush = () => {
    if (current) turns.push(current);
    current = null;
  };

  for (const entry of historyEntries || []) {
    yield;
    if (!entry) continue;
    if (entry.role === 'user') {
      flush();
      const text = String(entry.content || '');
      const timelineUser = codexTimelineUsersByUuid.get(entry.uuid) || null;
      const rec = {
        uuid: entry.uuid,
        type: 'user',
        timestamp: entry.timestamp || null,
        sessionId,
        message: { content: text },
      };
      recordMap.set(entry.uuid, rec);
      current = {
        kind: 'user',
        userUuid: entry.uuid,
        userTimestamp: entry.timestamp || null,
        userChars: text.length,
        isNoise: isNoisePrompt(text),
        thinkingBlocks: [],
        textBlocks: [],
        toolUses: [],
        assistantUuids: [],
        assistantModel: timelineUser?.responseModel || null,
        assistantEffort: timelineUser?.responseEffort || null,
        codexProviderTurnIndex: Number.isInteger(timelineUser?.turnIndex)
          ? timelineUser.turnIndex
          : (Number.isInteger(entry.turnIndex) ? entry.turnIndex : null),
        physicalSessionId: entry.sessionId || sessionId,
        docsEdited: Array.isArray(timelineUser?.docsEdited) ? [...timelineUser.docsEdited] : undefined,
        docsSearchQueries: Array.isArray(timelineUser?.docsSearchQueries)
          ? [...timelineUser.docsSearchQueries]
          : undefined,
      };
      continue;
    }

    if (entry.role === 'compact') {
      flush();
      const text = String(entry.compactSummary || entry.content || 'Conversation compacted');
      const rec = {
        uuid: entry.uuid,
        type: 'user',
        isCompactSummary: true,
        timestamp: entry.timestamp || null,
        sessionId,
        message: { content: text },
      };
      recordMap.set(entry.uuid, rec);
      current = {
        kind: 'compact_summary',
        userUuid: entry.uuid,
        userTimestamp: entry.timestamp || null,
        userChars: text.length,
        isNoise: false,
        preTokens: entry.preTokens || null,
        thinkingBlocks: [],
        textBlocks: [],
        toolUses: [],
        assistantUuids: [],
        assistantModel: null,
      };
      flush();
      continue;
    }

    if (entry.role === 'assistant') {
      if (!current) {
        current = {
          kind: 'user',
          userUuid: null,
          userTimestamp: entry.timestamp || null,
          userChars: 0,
          isNoise: false,
          thinkingBlocks: [],
          textBlocks: [],
          toolUses: [],
          assistantUuids: [],
          assistantModel: null,
        };
      }
      const blocks = [];
      const thinking = String(entry.thinking || '');
      const text = String(entry.content || '');
      if (thinking) {
        current.thinkingBlocks.push({
          idx: current.thinkingBlocks.length,
          chars: thinking.length,
          preview: thinking.slice(0, 160),
        });
        blocks.push({ type: 'thinking', thinking });
      }
      if (text) {
        current.textBlocks.push({
          idx: current.textBlocks.length,
          chars: text.length,
          preview: text.slice(0, 160),
        });
        blocks.push({ type: 'text', text });
      }
      for (const action of entry.actions || []) {
        yield;
        const name = action?.rawTool?.toolName || action?.tool || 'tool';
        const toolIndex = current.toolUses.length;
        current.toolUses.push({
          idx: toolIndex,
          name,
          detail: toolDetail(action?.rawTool?.args),
          operationId: String(
            action?.id
            || action?.rawTool?.toolUseId
            || action?.rawTool?.toolCallId
            || `${entry.uuid}:action:${toolIndex}`,
          ),
          assistantUuid: entry.uuid || null,
          timestamp: entry.timestamp || null,
        });
        blocks.push({ type: 'tool_use', name });
      }
      const rec = {
        uuid: entry.uuid,
        type: 'assistant',
        timestamp: entry.timestamp || null,
        sessionId,
        message: { content: blocks },
      };
      recordMap.set(entry.uuid, rec);
      current.assistantUuids.push(entry.uuid);
    }
  }
  flush();

  return { turns, recordMap };
}
function buildCodexTurnsDto(input) { return drainProjectionSteps(codexTurnsDtoSteps(input)); }
function buildCodexTurnsDtoCooperatively(input, control) { return control.drain('dto', codexTurnsDtoSteps(input)); }

module.exports = { createProjectionControl, createCodexTurnsPreparationQueue,
  buildCodexTurnsDto, buildCodexTurnsDtoCooperatively,
  drainProjectionSteps, rememberProjectionDiagnostics, projectionDiagnostics,
  projectionNow: () => performance.now(), projectionMicros: micros };
