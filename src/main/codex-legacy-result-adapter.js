'use strict';

const { codexRecordTurnId, classifyCodexTurnRecord, CODEX_NO_FINAL_RESULT_REASON } = require('./codex-turn-outcome');
const { codexUserMessageAuditText } = require('./codex-prompt-audit');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { projectResultText, summarizeResultText, MAX_RESULT_CHARS } = require('./codex-result-text');

const unavailable = (error, extra = {}) => ({ success: false, complete: false,
  error, proofDefinitive: false, executionContext: null, providerGeneration: null, ...extra });

function containsProviderTurnIds(rows) {
  return rows.some(row => {
    const record = row.record || {};
    return !!codexRecordTurnId(record)
      || (typeof record.turn_id === 'string' && !!record.turn_id.trim());
  });
}

/**
 * Compatibility adapter for a selected real user in an ID-less transcript.
 * Never call it to bypass a missing modern task_started: any provider turn ID
 * in the logical source keeps the result pending, even a late terminal's ID.
 *
 * collectLegacy is the existing collectCodexTurnAssistantBlocks export. It
 * receives ONLY the selected semantic window, with user audit text and short
 * assistant locator markers. Its existing user/alias/compact/rollback logic
 * chooses markers; no tool output, prior history body or assistant body enters
 * its Timeline/CleanEntries projection. Parent owns source/epoch validation.
 *
 * readBody(row) returns audit text for user rows and bounded {length,head,tail}
 * samples (or a string) for assistant rows. Optional projectRows(rows,maxChars)
 * delegates all bounded assistant I/O to the parent's existing projection.
 * Without it, the same shared projectResultText is used. Old completion comes from
 * the retained canonical coordinate, including task_complete without an ID.
 * Explicit abort/error/empty-final records still win through the shared
 * classifier. An omitted last_agent_message keeps the old format compatible.
 */
async function materializeCodexLegacyResult({ rows = [], coordinates, selectedPrompt,
  sessionId, readBody, collectLegacy, projectRows, maxChars = 100000 } = {}) {
  if (!sessionId || !selectedPrompt?.userUuid || !Array.isArray(coordinates)) {
    return unavailable('legacy-result-input-incomplete');
  }
  if (containsProviderTurnIds(rows)) {
    return unavailable('bootstrap-provider-turn-pending', { pending: true,
      proofMode: 'historical-provider-turn-pending' });
  }
  if (typeof readBody !== 'function' || typeof collectLegacy !== 'function') {
    return unavailable('legacy-result-collector-unavailable');
  }
  const target = coordinates.find(entry => entry.type === 'user' && entry.uuid === selectedPrompt.userUuid);
  if (!target) return unavailable('legacy-result-prompt-not-retained');
  const byUuid = new Map(), bySource = new Map();
  for (const coordinate of coordinates) {
    if (coordinate.type !== 'user' || coordinate.isGoalContinuation) continue;
    byUuid.set(coordinate.uuid, coordinate);
    for (const identity of [coordinate.sourceIdentity, ...(coordinate.sourceIdentityAliases || [])]) {
      if (identity) bySource.set(identity, coordinate);
    }
  }
  const coordinateFor = row => row.kind === 'user' && !row.user?.service
    ? bySource.get(row.user?.sourceIdentity) || byUuid.get(row.user?.uuid) : null;
  const start = rows.findIndex(row => coordinateFor(row) === target);
  if (start < 0) return unavailable('legacy-result-prompt-not-found');
  let end = rows.length;
  for (let index = start + 1; index < rows.length; index++) {
    const coordinate = coordinateFor(rows[index]);
    if (coordinate && coordinate !== target) { end = index; break; }
  }
  const prepared = [], assistantRows = new Map(), terminalRows = new Map();
  let hasCanonicalCarrier = false;
  for (let index = start; index < end; index++) {
    const row = rows[index];
    const record = { ...row.record, payload: { ...row.record?.payload } };
    if (row.user?.uuid === target.uuid) hasCanonicalCarrier = true;
    if (row.kind === 'user') {
      const text = await readBody(row);
      if (typeof text !== 'string' || (row.user?.auditHash && promptFingerprint(text) !== row.user.auditHash)) {
        throw new Error('legacy-user-body-source-changed');
      }
      if (record.type === 'event_msg') record.payload.message = text;
      else record.payload.content = [{ type: 'input_text', text }];
      if (codexUserMessageAuditText(record) === null) throw new Error('legacy-user-carrier-invalid');
    } else if (row.kind === 'assistant') {
      // Unique markers let the shared collector identify sources, without
      // replacing its user-bound grouping with another range/parser algorithm.
      const marker = 'noted-legacy-assistant:' + index;
      record.payload.content = Number(row.length) > 0 ? [{ type: 'output_text', text: marker }] : [];
      if (Number(row.length) > 0) assistantRows.set(marker, row);
    }
    const outcome = classifyCodexTurnRecord({}, record);
    if (outcome?.busy === false) {
      const marker = 'noted-legacy-terminal:' + index;
      terminalRows.set(marker, { record, outcome });
      // Let the SAME user/rollback collector assign terminal locators too.
      // These internal markers never become answer text or final-result proof.
      // A removed user's failure is removed together with its assistant rows.
      prepared.push({ ...record, type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: marker }] } });
    }
    prepared.push(record);
  }
  // A canonical event can upgrade an earlier response carrier after another
  // real user boundary. The first physical alias still identifies this local
  // window; output identity/completion always come from the canonical target.
  const localUuid = hasCanonicalCarrier ? target.uuid : rows[start].user.uuid;
  const collected = await collectLegacy(prepared, sessionId, localUuid);
  if (!collected?.success) return unavailable(collected?.error || 'legacy-result-collection-failed');
  const selectedRows = [];
  // Timeline can promote a late canonical carrier after another user row.
  // Its terminal belongs to the canonical coordinate even when the legacy
  // text window ends earlier. Do not let that bounded text window hide errors.
  const canonicalTerminal = Number.isInteger(target.legacyTerminalIndex)
    ? rows[target.legacyTerminalIndex]?.record : null;
  const canonicalOutcome = canonicalTerminal ? classifyCodexTurnRecord({}, canonicalTerminal) : null;
  let terminal = canonicalOutcome?.busy === false
    ? { record: canonicalTerminal, outcome: canonicalOutcome } : null;
  for (const marker of collected.assistantBlocks || []) {
    if (terminalRows.has(marker)) { terminal ||= terminalRows.get(marker); continue; }
    const row = assistantRows.get(marker);
    if (!row) throw new Error('legacy-result-collector-locator-invalid');
    selectedRows.push(row);
  }
  const omittedLegacyFinal = terminal?.outcome.reason === CODEX_NO_FINAL_RESULT_REASON
    && !Object.prototype.hasOwnProperty.call(terminal.record.payload, 'last_agent_message');
  const terminalFailure = terminal?.outcome.hasFinalResult === false && !omittedLegacyFinal;
  let projection;
  if (typeof projectRows === 'function') {
    projection = await projectRows(selectedRows, maxChars);
  } else {
    const total = selectedRows.reduce((sum, row) => sum + Number(row.length), 0)
      + Math.max(0, selectedRows.length - 1) * 2;
    const limit = Math.max(500, Math.min(MAX_RESULT_CHARS, Number(maxChars) || 8000));
    const samples = [];
    for (let index = 0; index < selectedRows.length; index++) {
      const row = selectedRows[index];
      if (total > limit && index !== 0 && index !== selectedRows.length - 1) {
        samples.push({ length: row.length });
        continue;
      }
      const body = await readBody(row);
      const sample = typeof body === 'string' ? summarizeResultText(body) : body;
      if (!sample || sample.length !== row.length || typeof sample.head !== 'string' || typeof sample.tail !== 'string') {
        throw new Error('legacy-assistant-body-source-changed');
      }
      samples.push(sample);
    }
    projection = projectResultText(samples, maxChars, MAX_RESULT_CHARS);
  }
  if (!projection.assistantText && !terminalFailure) return unavailable('No completed assistant response found', { proofMode: 'legacy-user-turn' });
  const providerError = terminalFailure && ['provider_error', 'model_capacity'].includes(terminal.outcome.reason);
  const failure = terminalFailure ? {
    terminalEvent: providerError ? 'provider_error' : terminal.outcome.event,
    terminalOutcomeReason: terminal.outcome.reason, hasFinalResult: false, proofDefinitive: true,
    boundaryReason: terminal.outcome.event,
    errorCode: providerError ? terminal.record.payload.error?.codex_error_info || 'provider_error'
      : terminal.outcome.event === 'turn_aborted' ? 'turn_aborted' : 'no_final_result',
    error: providerError ? terminal.record.payload.error?.message || terminal.outcome.reason : terminal.outcome.reason,
  } : {};
  return { success: true, complete: !terminalFailure && target.responseComplete === true,
    ...projection, assistantMessageCount: selectedRows.length, assistantBlockCount: selectedRows.length,
    turnIndex: target.turnIndex, userUuid: target.uuid, sourceIdentity: target.sourceIdentity,
    sourceIdentityAliases: selectedPrompt.sourceIdentityAliases || [],
    executionContext: null, providerGeneration: null, proofMode: 'legacy-user-turn', ...failure };
}

module.exports = { materializeCodexLegacyResult, containsProviderTurnIds };
