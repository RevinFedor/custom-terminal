'use strict';

const { findMatchingClaudePromptTurn, promptFingerprint } = require('./claude-prompt-carriers');
const {
  codexUserMessageAuditText, codexUserMessagePresentationText,
  isCodexEnvironmentContextUserText, isCodexProjectInstructionsUserText,
  isCodexTurnAbortedUserText, isCodexGoalContinuationUserText,
} = require('./codex-prompt-audit');

const owner = (record, sessionId) => record.__physicalSessionId || sessionId;
const boundary = record => record.type === 'event_msg'
  && ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type);
const missing = (reason, extra = {}) => ({ selectedPrompt: null,
  targetExecutionContext: null, legacy: null, reason, ...extra });

function inBounds(timestamp, proof) {
  const lower = Number(proof.resultAfterAt) > 0 ? Number(proof.resultAfterAt)
    : Number(proof.requestedAt) > 0 ? Number(proof.requestedAt) - 5 * 60 * 1000 : 0;
  const upper = Number(proof.resultBeforeAt) > 0 ? Number(proof.resultBeforeAt) : 0;
  const time = Date.parse(timestamp || '');
  return !(lower || upper) || (Number.isFinite(time) && (!lower || time >= lower) && (!upper || time <= upper));
}

function hydrateUser(row, text) {
  if (typeof text !== 'string') throw new Error('bootstrap-user-body-unavailable');
  return { ...row.record, payload: { ...row.record.payload, message: text } };
}

function isService(record) {
  const text = codexUserMessagePresentationText(record);
  return !text.trim() || text.includes('<subagent_notification>')
    || isCodexEnvironmentContextUserText(text) || isCodexProjectInstructionsUserText(text)
    || isCodexTurnAbortedUserText(text) || isCodexGoalContinuationUserText(text);
}

/**
 * Private historical bootstrap over one frozen compact-index revision.
 *
 * rows: parent's {record, locator, kind, length, user?}, in source order.
 * user: {uuid, sourceIdentity, timestamp, auditHash, presentationHash, service}.
 * Hashes use promptFingerprint (normalized SHA-256), not the PTY's short hash.
 * coordinates: parent's existing Timeline coordinate index peekEntries(). Its
 * UUID/source aliases and retained users own pairing/rollback; this helper
 * neither builds a projection nor invents another coordinate reducer.
 * readBody(row): async normalized user audit text. Other bodies are never read.
 * findExecutionContext: inject _api.findCodexPromptExecutionContext.
 *
 * For resultAfterAt, nonempty assistant rows establish legacy assistant
 * presence. A retained lightweight row.hasAssistantEvidence or coordinate
 * hasAssistant can additionally carry the old History's tool/thinking-only
 * presence. row.control='compact' carries the parent's canonical compact
 * classification; the fallback names below also accept older compact indexes.
 *
 * Returns selection only. Parent owns text composition and provider outcome
 * classification. generation is ALWAYS null; never use this as live binding.
 * legacy=true means an enclosing provider turn is unproved: wait for a late
 * task_started or use a shared adapter of collectCodexTurnAssistantBlocks.
 */
async function selectCodexResultBootstrap({ rows = [], coordinates, sessionId, proof = {},
  readBody, findExecutionContext } = {}) {
  if (!sessionId || typeof readBody !== 'function' || typeof findExecutionContext !== 'function') {
    return missing('bootstrap-input-incomplete');
  }
  if (!Array.isArray(coordinates)) {
    return missing('bootstrap-prompt-coordinates-required', { requiredAdapter: 'existing-prompt-coordinates' });
  }
  if (!proof.promptUserUuid && !proof.promptSourceIdentity && !proof.promptHash && !(Number(proof.resultAfterAt) > 0)) {
    return missing('prompt-identity-required');
  }
  const coordinateBySource = new Map(), coordinateByUuid = new Map();
  for (const coordinate of coordinates) {
    if (coordinate.type !== 'user' || coordinate.isGoalContinuation) continue;
    coordinateByUuid.set(coordinate.uuid, coordinate);
    for (const source of [coordinate.sourceIdentity, ...(coordinate.sourceIdentityAliases || [])]) {
      if (source) coordinateBySource.set(source, coordinate);
    }
  }
  const groups = new Map();
  let current = null;
  for (const [index, row] of rows.entries()) {
    const record = row.record || {};
    if (row.control === 'compact' || record.type === 'compacted' || (record.type === 'event_msg'
      && ['context_compacted', 'context_compaction'].includes(record.payload?.type))) current = null;
    if (record.type === 'event_msg' && record.payload?.type === 'thread_rolled_back') {
      current = [...groups.values()].at(-1) || null;
    }
    if (row.kind !== 'user') {
      if (current && (row.hasAssistantEvidence === true || (row.kind === 'assistant' && Number(row.length) > 0))) {
        current.observedAssistant = true;
      }
      continue;
    }
    if (!row.user) return missing('bootstrap-user-metadata-required');
    if (row.user.service) continue;
    const coordinate = coordinateBySource.get(row.user.sourceIdentity) || coordinateByUuid.get(row.user.uuid);
    if (!coordinate) { current = null; continue; }
    let group = groups.get(coordinate.uuid);
    if (!group) {
      group = { coordinate, members: [], observedAssistant: false };
      groups.set(coordinate.uuid, group);
    }
    group.members.push({ row, index }); current = group;
  }
  const candidates = [];
  for (const group of groups.values()) {
    const canonical = group.members.find(item => item.row.user.uuid === group.coordinate.uuid);
    if (!canonical) return missing('bootstrap-canonical-carrier-unavailable');
    candidates.push({ ...group, canonical,
      uuids: new Set(group.members.map(item => item.row.user.uuid)),
      sources: new Set(group.members.map(item => item.row.user.sourceIdentity)),
      turn: { kind: 'user', userUuid: group.coordinate.uuid,
        userTimestamp: canonical.row.user.timestamp || null,
        assistantUuids: (group.coordinate.hasAssistant ?? group.observedAssistant)
          ? ['compact-index-assistant-evidence'] : [] },
    });
  }
  const bodies = new Map();
  const body = async item => {
    if (!bodies.has(item.index)) {
      const record = hydrateUser(item.row, await readBody(item.row));
      const audit = codexUserMessageAuditText(record), presented = codexUserMessagePresentationText(record);
      if (audit === null || isService(record) || promptFingerprint(audit) !== item.row.user.auditHash
        || promptFingerprint(presented) !== item.row.user.presentationHash) {
        throw new Error('bootstrap-prompt-metadata-changed');
      }
      bodies.set(item.index, { record, audit, presented });
    }
    return bodies.get(item.index);
  };
  let selected = null, matched = null;
  if (proof.promptUserUuid || proof.promptSourceIdentity) {
    const matches = candidates.filter(candidate => (!proof.promptUserUuid || candidate.uuids.has(proof.promptUserUuid))
      && (!proof.promptSourceIdentity || candidate.sources.has(proof.promptSourceIdentity)));
    if (matches.length !== 1) return missing(matches.length ? 'prompt-ambiguous' : 'prompt-not-found');
    const candidate = matches[0];
    if (!findMatchingClaudePromptTurn({ ...proof, turns: [candidate.turn], promptUserUuid: candidate.turn.userUuid })) {
      return missing('prompt-not-found');
    }
    selected = candidate;
    matched = candidate.members.find(item => item.row.user.uuid === proof.promptUserUuid
      || item.row.user.sourceIdentity === proof.promptSourceIdentity) || candidate.canonical;
  } else if (Number(proof.resultAfterAt) > 0) {
    const match = findMatchingClaudePromptTurn({ ...proof, turns: candidates.map(candidate => candidate.turn) });
    if (match) { selected = candidates[match.turnIndex]; matched = selected.canonical; }
  } else {
    for (const candidate of candidates) {
      if (!inBounds(candidate.turn.userTimestamp, proof)) continue;
      let witness = null;
      for (const member of candidate.members) {
        const meta = member.row.user;
        if (meta.auditHash !== proof.promptHash && meta.presentationHash !== proof.promptHash) continue;
        const value = await body(member);
        const text = [value.presented, value.audit].find(text => promptFingerprint(text) === proof.promptHash);
        if (text === undefined) continue;
        const match = findMatchingClaudePromptTurn({ ...proof, turns: [candidate.turn], recordMap: new Map([
          [candidate.turn.userUuid, { type: 'user', message: { content: text } }],
        ]) });
        if (match) { witness = member; break; }
      }
      if (!witness) continue;
      if (selected) return missing('prompt-ambiguous');
      selected = candidate; matched = witness;
    }
  }
  if (!selected) return missing('prompt-not-found');
  const derive = async item => {
    const { record } = await body(item);
    const physicalSessionId = owner(record, sessionId);
    // Use the existing classifier on the actual physical source and original
    // coordinates, not an alias search across unrelated ancestor files.
    const contextRecords = rows.flatMap((row, index) => index === item.index ? [record]
      : boundary(row.record || {}) && owner(row.record, sessionId) === physicalSessionId ? [row.record] : []);
    const context = findExecutionContext(contextRecords, physicalSessionId, item.row.user.uuid);
    return context?.provider === 'codex' && context.turnId ? {
      provider: 'codex', sessionId: context.sessionId, turnId: context.turnId,
      processId: null, generation: null, startedAt: context.startedAt ?? null,
    } : null;
  };
  const targetExecutionContext = await derive(matched);
  if (matched !== selected.canonical) {
    const canonicalContext = await derive(selected.canonical);
    if (canonicalContext?.turnId !== targetExecutionContext?.turnId
      || canonicalContext?.sessionId !== targetExecutionContext?.sessionId) {
      return missing('bootstrap-alias-execution-mismatch');
    }
  }
  const expected = proof.targetExecutionContext;
  if (expected?.turnId && (expected.provider !== 'codex' || !targetExecutionContext
    || expected.turnId !== targetExecutionContext.turnId
    || (expected.sessionId && expected.sessionId !== targetExecutionContext.sessionId))) {
    return missing('bootstrap-execution-mismatch');
  }
  const { canonical, coordinate } = selected;
  return {
    selectedPrompt: { userUuid: coordinate.uuid, sourceIdentity: coordinate.sourceIdentity,
      userUuidAliases: [...selected.uuids].filter(value => value !== coordinate.uuid),
      sourceIdentityAliases: [...selected.sources].filter(value => value !== coordinate.sourceIdentity),
      timestamp: selected.turn.userTimestamp, physicalSessionId: owner(canonical.row.record, sessionId),
      rowIndex: canonical.index, matchedRowIndex: matched.index, locator: canonical.row.locator,
      turnIndex: coordinate.turnIndex ?? null,
      matchKind: proof.promptUserUuid ? 'uuid' : proof.promptSourceIdentity ? 'source'
        : Number(proof.resultAfterAt) > 0 ? 'after' : 'hash' },
    targetExecutionContext, legacy: !targetExecutionContext,
  };
}

module.exports = { selectCodexResultBootstrap };
