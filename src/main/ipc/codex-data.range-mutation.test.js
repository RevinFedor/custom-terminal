'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('every materialized Codex fork removes inherited paginated pointers but keeps exact retained records', () => {
  for (const purpose of ['latest_compact', 'history_edit', 'history_delete', 'full']) {
    const sourceMeta = {
      type: 'session_meta', payload: {
        id: 'parent', session_id: 'parent', history_mode: 'paginated',
        forked_from_id: 'grandparent', forked_from_ordinal_exclusive: 1805,
        history_base: { thread_id: 'grandparent', end_byte_offset: 11841001, end_ordinal_exclusive: 1805 },
      },
    };
    const compact = { type: 'compacted', payload: { encrypted_content: 'opaque-preserved' } };
    const image = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }] } };
    const records = [sourceMeta, compact, image];
    const output = structuredClone(records);
    _api.rewriteCodexEditedForkMetadata(records, 'parent', '/fixture', output, 'child-' + purpose, '2026-09-07T00:00:00Z');
    assert.equal(output[0].payload.history_mode, 'legacy');
    assert.equal(output[0].payload.forked_from_id, 'parent');
    assert.equal(output[0].payload.history_base, undefined);
    assert.equal(output[0].payload.forked_from_ordinal_exclusive, undefined);
    assert.deepEqual(output.slice(1), [compact, image]);
    assert.equal(sourceMeta.payload.history_mode, 'paginated', 'source is untouched');
  }
});

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

test('event_msg project instructions belong to the following real turn just like response_item instructions', () => {
  const sessionId = 'range-event-project-instructions';
  const records = fixture(sessionId);
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('event_msg', { type: 'user_message', message: PROJECT_INSTRUCTIONS }));
  records.push(rec('turn_context', { model: 'gpt-6-astra', effort: 'max' }));
  records.push(rec('event_msg', { type: 'user_message', message: 'production carrier prompt' }));
  records.push(rec('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
  }));
  records.push(rec('event_msg', { type: 'task_complete' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  assert.deepEqual(
    timeline.filter((entry) => entry.type === 'user').map((entry) => entry.content),
    ['production carrier prompt'],
  );
  const target = timeline.find((entry) => entry.type === 'user');
  const wrappers = _api.buildCodexVisibleRecordWrappers(records, sessionId);
  const canonical = wrappers.find((wrapper) => wrapper.sourceUuid === target.uuid);
  const instructions = wrappers.find((wrapper) => (
    JSON.stringify(wrapper.record).includes('AGENTS.md instructions')
  ));
  assert.ok(Number.isFinite(canonical?.turnKey));
  assert.equal(instructions?.turnKey, canonical.turnKey);

  const plan = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);
  assert.equal(plan.success, true);
  assert.equal(plan.removedUsers, 1);
  assert.equal(
    plan.outputRecords.some((record) => JSON.stringify(record).includes('AGENTS.md instructions')),
    false,
  );
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

test('deleting a compact also removes a trailing orphan project-instructions preamble', () => {
  const sessionId = 'range-orphan-project-instructions-after-compact';
  const records = fixture(sessionId);
  records.push(...userTurn('keep-before'));
  records.push(rec('compacted', { replacement_history: [] }));
  records.push(rec('event_msg', { type: 'context_compacted' }));
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('event_msg', { type: 'user_message', message: PROJECT_INSTRUCTIONS }));
  records.push(rec('turn_context', { model: 'gpt-6-astra', effort: 'max' }));

  const timeline = _api.buildCodexTimeline(records, sessionId);
  assert.deepEqual(
    timeline.map((entry) => ({ type: entry.type, content: entry.content })),
    [
      { type: 'user', content: 'keep-before' },
      { type: 'compact', content: 'Conversation compacted' },
    ],
  );
  const compact = timeline.find((entry) => entry.type === 'compact');
  const plan = _api.planCodexRangeRewrite(records, sessionId, compact.uuid, compact.uuid);
  assert.equal(plan.success, true);
  assert.equal(
    plan.outputRecords.some((record) => JSON.stringify(record).includes('AGENTS.md instructions')),
    false,
  );
  assert.equal(
    plan.outputRecords.filter((record) => (
      record.type === 'event_msg' && record.payload?.type === 'task_started'
    )).length,
    1,
    'the retained turn keeps its task boundary while the orphan preamble boundary is removed',
  );
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), [
    { type: 'user', content: 'keep-before' },
  ]);
});

test('an already orphaned trailing AGENTS carrier can be removed by its exact History identity', () => {
  const sessionId = 'range-existing-orphan-project-instructions';
  const records = fixture(sessionId);
  records.push(...userTurn('keep-before'));
  records.push(rec('event_msg', { type: 'user_message', message: PROJECT_INSTRUCTIONS }));
  records.push(rec('turn_context', { model: 'gpt-6-astra', effort: 'max' }));
  records.push(rec('event_msg', { type: 'task_started' }));
  records.push(rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' }));

  const timelineBefore = timelineTexts(records, sessionId);
  const history = _api.buildCodexFullHistory(records, sessionId);
  const orphan = history.find((entry) => entry.serviceCarrier === 'project-instructions');
  assert.ok(orphan?.uuid);
  assert.equal(_api.buildCodexTimeline(records, sessionId).some((entry) => entry.uuid === orphan.uuid), false);

  const plan = _api.planCodexRangeRewrite(records, sessionId, orphan.uuid, orphan.uuid);
  assert.equal(plan.success, true);
  assert.equal(plan.repairKind, 'trailing-project-instructions');
  assert.equal(plan.removedUsers, 0);
  assert.equal(
    plan.outputRecords.some((record) => JSON.stringify(record).includes('AGENTS.md instructions')),
    false,
  );
  assert.deepEqual(timelineTexts(plan.outputRecords, sessionId), timelineBefore);
});

test('project instructions attached to a following real prompt cannot be deleted independently', () => {
  const sessionId = 'range-owned-project-instructions';
  const records = fixture(sessionId);
  records.push(...userTurn('keep-before'));
  records.push(rec('event_msg', { type: 'user_message', message: PROJECT_INSTRUCTIONS }));
  records.push(rec('turn_context', { model: 'gpt-6-astra', effort: 'max' }));
  records.push(rec('event_msg', { type: 'user_message', message: 'owner prompt' }));
  records.push(rec('event_msg', { type: 'task_complete' }));

  const history = _api.buildCodexFullHistory(records, sessionId);
  const instructions = history.find((entry) => entry.serviceCarrier === 'project-instructions');
  const plan = _api.planCodexRangeRewrite(records, sessionId, instructions.uuid, instructions.uuid);
  assert.equal(plan.success, false);
  assert.equal(plan.error, 'Timeline range not found');
});

test('in-place Codex replacement keeps the physical session id and creates a non-discoverable backup', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-in-place-rewrite-'));
  const sessionId = 'in-place-session';
  const filePath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const records = fixture(sessionId);
  records.push(...userTurn('keep'));
  await _api.writeCodexJsonlExclusive(filePath, records);
  const stat = await fs.promises.stat(filePath);
  try {
    const result = await _api.replaceCodexSessionFileInPlace({
      filePath,
      records: records.slice(0, -1),
      sourceSnapshot: { size: stat.size, mtimeMs: stat.mtimeMs },
      sessionId,
      now: new Date('2026-09-08T20:30:00.000Z'),
    });
    assert.equal(result.success, true);
    assert.equal(result.sessionId, sessionId);
    assert.equal(path.extname(result.backupPath), '.bak');
    assert.equal(fs.existsSync(result.backupPath), true);
    const rewritten = (await fs.promises.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rewritten[0].payload.id, sessionId);
    assert.equal(rewritten.length, records.length - 1);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('in-place Codex replacement fails closed when the source changed after the snapshot', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-in-place-cas-'));
  const sessionId = 'in-place-cas-session';
  const filePath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const records = fixture(sessionId);
  await _api.writeCodexJsonlExclusive(filePath, records);
  const stat = await fs.promises.stat(filePath);
  await fs.promises.appendFile(filePath, '\n');
  try {
    await assert.rejects(
      _api.replaceCodexSessionFileInPlace({
        filePath,
        records,
        sourceSnapshot: { size: stat.size, mtimeMs: stat.mtimeMs },
        sessionId,
      }),
      (error) => error?.code === 'codex_in_place_rewrite_source_changed',
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
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

test('Rewind removes the physical suffix including orphan assistant/tools after compact, while range Delete does not grow to EOF', () => {
  const sessionId = 'rewind-physical-eof';
  const records = fixture(sessionId);
  records.push(...userTurn('keep'), ...userTurn('rewind-here'));
  records.push(rec('compacted', { summary: 'old future compact' }));
  records.push(rec('response_item', { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'orphan-future-answer' }] }));
  records.push(rec('response_item', { type: 'function_call', name: 'future-tool', call_id: 'future-call', arguments: '{}' }));
  records.push(rec('response_item', { type: 'function_call_output', call_id: 'future-call', output: 'future-output' }));
  const timeline = _api.buildCodexTimeline(records, sessionId);
  const target = timeline.find(entry => entry.content === 'rewind-here');
  const original = JSON.stringify(records);
  const rewind = _api.planCodexRangeRewrite(records, sessionId, target.uuid, timeline.at(-1).uuid, null, { toPhysicalEnd: true });
  assert.equal(rewind.success, true, rewind.error);
  assert.equal(JSON.stringify(rewind.outputRecords).includes('orphan-future-answer'), false);
  assert.equal(JSON.stringify(rewind.outputRecords).includes('future-call'), false);
  assert.equal(rewind.suffixProof.retainedRecordCount, rewind.outputRecords.length);
  assert.equal(rewind.suffixProof.retainedRecordCount + rewind.removedCount, records.length);
  assert.deepEqual(timelineTexts(rewind.outputRecords, sessionId), [{ type: 'user', content: 'keep' }]);
  assert.equal(JSON.stringify(records), original, 'the source remains unchanged');
  const middle = _api.planCodexRangeRewrite(records, sessionId, target.uuid, target.uuid);
  assert.equal(middle.success, true);
  assert.equal(JSON.stringify(middle.outputRecords).includes('orphan-future-answer'), true);
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
