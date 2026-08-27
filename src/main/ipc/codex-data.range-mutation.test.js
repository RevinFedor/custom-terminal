'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _api } = require('./codex-data');

let line = 0;
const rec = (type, payload, timestamp) => ({
  type,
  payload,
  timestamp: timestamp || `2026-08-18T00:00:${String(line).padStart(2, '0')}.000Z`,
  __line: line++,
  __byteOffset: line * 100,
});

const userTurn = (text, options = {}) => {
  const rows = [];
  rows.push(rec('turn_context', {
    model: options.model || 'gpt-5.6-sol',
    effort: options.effort || 'max',
  }));
  rows.push(rec('event_msg', { type: 'task_started' }));
  if (options.responseCarrier !== false) {
    rows.push(rec('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }));
  }
  if (options.eventCarrier !== false) {
    rows.push(rec('event_msg', { type: 'user_message', message: text }));
  }
  rows.push(rec('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: `answer:${text}` }],
  }));
  rows.push(rec('event_msg', { type: 'task_complete' }));
  return rows;
};

function fixture(sessionId = 'range-session') {
  line = 0;
  return [rec('session_meta', { id: sessionId, session_id: sessionId, cwd: '/tmp/project' })];
}

const timelineTexts = (records, sessionId) => _api.buildCodexTimeline(records, sessionId)
  .map((entry) => ({ type: entry.type, content: entry.content }));

const PROJECT_INSTRUCTIONS = `# AGENTS.md instructions for /tmp/project

<INSTRUCTIONS>
Keep the project contract.
</INSTRUCTIONS>`;

test('project instructions stay inside the following real turn and never become a deletable Timeline user', () => {
  const sessionId = 'range-project-instructions';
  const records = fixture(sessionId);
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: '<permissions instructions>safe</permissions instructions>' }],
  }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: PROJECT_INSTRUCTIONS }],
  }));
  records.push(rec('turn_context', { model: 'gpt-5.6-sol', effort: 'max' }));

  const preambleMaterialization = _api.inspectConversationMaterialization(records, sessionId);
  assert.equal(preambleMaterialization.metadataOnly, true);
  assert.equal(preambleMaterialization.userTurns, 0);

  records.push(rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'delete the real prompt' }],
  }));
  records.push(rec('event_msg', { type: 'user_message', message: 'delete the real prompt' }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
  }));
  records.push(rec('event_msg', { type: 'task_complete' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  assert.deepEqual(
    timeline.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['delete the real prompt'],
  );
  assert.equal(timeline.some((entry) => entry.content === PROJECT_INSTRUCTIONS), false);

  const fullHistory = _api.buildCodexFullHistory(records, sessionId);
  const instructionHistoryEntry = fullHistory.find((entry) => entry.content === PROJECT_INSTRUCTIONS);
  const promptHistoryEntry = fullHistory.find((entry) => entry.content === 'delete the real prompt');
  assert.equal(instructionHistoryEntry?.serviceCarrier, 'project-instructions');
  assert.equal(instructionHistoryEntry?.turnIndex, promptHistoryEntry?.turnIndex);
  assert.ok(
    fullHistory.indexOf(instructionHistoryEntry) < fullHistory.indexOf(promptHistoryEntry),
    'the attached project contract is presented before the prompt it governs',
  );

  const target = timeline.find((entry) => entry.content === 'delete the real prompt');
  const wrappers = _api.buildCodexVisibleRecordWrappers(records, sessionId);
  const canonical = wrappers.find((wrapper) => wrapper.sourceUuid === target.uuid);
  const instructions = wrappers.find((wrapper) => wrapper.line === 3);
  assert.ok(Number.isFinite(canonical?.turnKey));
  assert.equal(instructions?.turnKey, canonical.turnKey);

  const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);
  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.equal(plan.outputRecords.some((record) => JSON.stringify(record).includes('AGENTS.md instructions')), false);
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), []);
});

test('the first prompt after compact owns its injected project instructions as one rewindable turn', () => {
  const sessionId = 'range-project-instructions-after-compact';
  const records = fixture(sessionId);
  records.push(rec('compacted', { replacement_history: [] }));
  records.push(rec('event_msg', { type: 'context_compacted' }));
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: PROJECT_INSTRUCTIONS }],
  }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'first prompt after compact' }],
  }));
  records.push(rec('event_msg', {
    type: 'user_message',
    message: 'first prompt after compact',
  }));
  records.push(rec('event_msg', { type: 'task_complete' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  assert.deepEqual(
    timeline.map((entry) => ({ type: entry.type, content: entry.content })),
    [
      { type: 'compact', content: 'Conversation compacted' },
      { type: 'user', content: 'first prompt after compact' },
    ],
  );

  const prompt = timeline.find((entry) => entry.type === 'user');
  const plan = _api.planCodexRangeRewrite(records, sessionId, prompt.uuid, prompt.uuid);
  assert.equal(plan.success, true);
  assert.equal(
    plan.outputRecords.some((record) => JSON.stringify(record).includes('AGENTS.md instructions')),
    false,
  );
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), [
    { type: 'compact', content: 'Conversation compacted' },
  ]);
});

test('compact deletion removes its semantic companion across world-state and settings records', () => {
  const sessionId = 'range-compact-gap';
  const records = fixture(sessionId);
  records.push(...userTurn('keep-before'));
  records.push(rec('compacted', { replacement_history: [] }));
  records.push(rec('world_state', { cwd: '/tmp/project' }));
  records.push(rec('turn_context', { model: 'gpt-5.6-sol', effort: 'max' }));
  records.push(rec('event_msg', { type: 'token_count', info: {} }));
  records.push(rec('event_msg', { type: 'context_compacted' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  const target = timeline.find((entry) => entry.type === 'compact');
  assert.equal(timeline.filter((entry) => entry.type === 'compact').length, 1);

  const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);
  assert.equal(plan.success, true);
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), [
    { type: 'user', content: 'keep-before' },
  ]);
});

test('image response carrier and canonical event share one exact deletable turn', () => {
  const sessionId = 'range-image-pair';
  const imagePath = '/tmp/noted-terminal-codex-image-input/image.png';
  const records = fixture(sessionId);
  records.push(rec('turn_context', { model: 'gpt-5.6-sol', effort: 'max' }));
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: `<image name=[Image #1] path="${imagePath}">[Image #1]</image>\n[Image #1] delete image turn`,
    }],
    local_images: [imagePath],
  }));
  records.push(rec('event_msg', {
    type: 'user_message',
    message: '[Image #1] delete image turn',
    images: [],
    local_images: [imagePath],
  }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
  }));
  records.push(rec('event_msg', { type: 'task_complete' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  const users = timeline.filter((entry) => entry.type === 'user');
  assert.equal(users.length, 1);
  assert.match(users[0].content, /delete image turn/);

  const plan = _api.planCodexRangeRewrite(records, sessionId, users[0].uuid, users[0].uuid);
  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), []);
});

test('single-turn delete uses exact carrier identity and does not consume the following compact', () => {
  const sessionId = 'range-single';
  const records = fixture(sessionId);
  records.push(...userTurn('keep-before'));
  records.push(...userTurn('delete-only-this'));
  records.push(rec('compacted', { summary: 'compact stays' }));
  records.push(...userTurn('keep-after'));

  const before = _api.buildCodexTimeline(records, sessionId);
  const target = before.find((entry) => entry.content === 'delete-only-this');
  const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);

  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.equal(plan.selectedTurnKeys.length, 1);
  assert.deepEqual(
    timelineTexts(plan.outputRecords.map((record, index) => ({ ...record, __line: index })), sessionId),
    [
      { type: 'user', content: 'keep-before' },
      { type: 'compact', content: 'compact stays' },
      { type: 'user', content: 'keep-after' },
    ],
  );
});

test('tail regression: two paired user turns plus compact remove exactly those three Timeline entries', () => {
  const sessionId = 'range-tail';
  const records = fixture(sessionId);
  records.push(...userTurn('good'));
  records.push(...userTurn('bad-one'));
  records.push(...userTurn('bad-two'));
  records.push(rec('compacted', { summary: 'bad compact' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  const start = timeline.find((entry) => entry.content === 'bad-one');
  const end = timeline.find((entry) => entry.type === 'compact');
  const plan = _api.planCodexRangeRewrite(records, sessionId, start.uuid, end.uuid);

  assert.equal(plan.success, true);
  assert.equal(plan.selectedCount, 3);
  assert.equal(plan.removedUsers, 2);
  assert.equal(plan.selectedCompacts.length, 1);
  assert.deepEqual(
    timelineTexts(plan.outputRecords.map((record, index) => ({ ...record, __line: index })), sessionId),
    [{ type: 'user', content: 'good' }],
  );
});

for (const [label, options] of [
  ['response_item-only user carrier', { eventCarrier: false }],
  ['event_msg-only user carrier', { responseCarrier: false }],
]) {
  test(`${label} maps to one exact deletable turn`, () => {
    const sessionId = `range-${label.slice(0, 8)}`;
    const records = fixture(sessionId);
    records.push(...userTurn('keep'));
    records.push(...userTurn('delete', options));
    const target = _api.buildCodexTimeline(records, sessionId)
      .find((entry) => entry.content === 'delete');
    const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);
    assert.equal(plan.success, true);
    assert.equal(plan.removedUsers, 1);
    assert.equal(plan.removedCount, 5, 'the turn context/start and completion records move with the carrier');
    assert.deepEqual(
      timelineTexts(plan.outputRecords.map((record, index) => ({ ...record, __line: index })), sessionId),
      [{ type: 'user', content: 'keep' }],
    );
  });
}

test('rollback reuse cannot make a later delete match an abandoned turn', () => {
  const sessionId = 'range-rollback';
  const records = fixture(sessionId);
  records.push(...userTurn('keep'));
  records.push(...userTurn('abandoned'));
  records.push(rec('event_msg', { type: 'thread_rolled_back', num_turns: 1 }));
  records.push(...userTurn('delete-new'));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  assert.deepEqual(timeline.filter((entry) => entry.type === 'user').map((entry) => entry.content), [
    'keep',
    'delete-new',
  ]);
  const target = timeline.find((entry) => entry.content === 'delete-new');
  const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);

  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.deepEqual(
    timelineTexts(plan.outputRecords.map((record, index) => ({ ...record, __line: index })), sessionId),
    [{ type: 'user', content: 'keep' }],
  );
  assert.equal(
    plan.outputRecords.some((record) => JSON.stringify(record).includes('abandoned')),
    false,
    'rolled-back raw future must not be resurrected in the edited child',
  );
});

test('edited child receives the exact source settings pair when the selected range removed turn_context', () => {
  const sourceSessionId = 'settings-source';
  const childSessionId = 'settings-child';
  const records = fixture(sourceSessionId);
  records.push(...userTurn('only-turn', { model: 'gpt-5.6-sol', effort: 'max' }));
  const proof = _api.resolveCodexHistoryMutationSettingsProof(records, sourceSessionId);
  assert.equal(proof.status, 'found');

  const output = [rec('session_meta', {
    id: sourceSessionId,
    session_id: sourceSessionId,
    cwd: '/tmp/project',
  })];
  _api.rewriteCodexEditedForkMetadata(
    records,
    sourceSessionId,
    '/tmp/project',
    output,
    childSessionId,
    '2026-08-18T00:10:00.000Z',
  );
  const ensured = _api.ensureCodexEditedForkSettingsProof(
    output,
    childSessionId,
    proof,
    '2026-08-18T00:10:00.000Z',
  );
  assert.equal(ensured.success, true);
  assert.equal(ensured.injected, true);
  assert.equal(output.at(-1).payload.type, 'thread_settings_applied');
  const childProof = require('../codex-source-settings').resolveCodexSourceSettingsProof(
    output,
    childSessionId,
  );
  assert.deepEqual(
    { status: childProof.status, model: childProof.model, effort: childProof.effort },
    { status: 'found', model: 'gpt-5.6-sol', effort: 'max' },
  );
});

test('exact renderer proof is accepted only for the source session identity', () => {
  const sessionId = 'settings-fallback';
  const records = fixture(sessionId);
  const accepted = _api.resolveCodexHistoryMutationSettingsProof(records, sessionId, {
    sessionId,
    model: 'gpt-5.6-sol',
    effort: 'high',
    proofAt: 123,
    fast: true,
  });
  assert.equal(accepted.status, 'found');
  assert.equal(accepted.source, 'exact-renderer-proof');
  assert.equal(accepted.fast, true);
  const rejected = _api.resolveCodexHistoryMutationSettingsProof(records, sessionId, {
    sessionId: 'foreign',
    model: 'gpt-5.6-sol',
    effort: 'high',
    proofAt: 123,
  });
  assert.equal(rejected.status, 'absent');
});

test('source JSONL pair may carry the exact live Fast bit without changing model or effort authority', () => {
  const sessionId = 'settings-fast';
  const records = fixture(sessionId);
  records.push(rec('turn_context', { model: 'gpt-5.6-sol', effort: 'max' }));
  const proof = _api.resolveCodexHistoryMutationSettingsProof(records, sessionId, {
    sessionId,
    model: 'gpt-5.6-sol',
    effort: 'max',
    proofAt: 456,
    fast: true,
  });
  assert.equal(proof.status, 'found');
  assert.equal(proof.source, 'source-jsonl');
  assert.equal(proof.fast, true);
});
