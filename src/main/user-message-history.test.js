'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UserMessageHistory, classifyUserMessage } = require('./user-message-history');
const { extractClaudePromptCarrier } = require('./claude-prompt-carriers');
const SID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const classify = (text, extra = {}) => classifyUserMessage({ text, turn: { kind: 'user', userUuid: 'u', ...extra.turn }, entry: extra.entry });
function fixture(texts = ['first', 'second', 'third']) {
  const turns = texts.map((text, index) => ({ kind: 'user', userUuid: 'user-' + index, userTimestamp: `2026-08-0${index + 1}T10:00:00Z` }));
  const data = { sessionId: SID, engine: 'claude', size: 1, mtimeMs: 1, turns,
    recordMap: new Map(texts.map((text, i) => ['user-' + i, { type: 'user', message: { content: text } }])) };
  const calls = [];
  const dependencies = { listCandidates: async () => [{ sessionId: SID, provider: 'claude', createdAt: 1 }],
    loadSession: async id => { calls.push(id); return data; }, extractText: row => extractClaudePromptCarrier(row)?.text,
    logger: { log() {} } };
  return { data, calls, dependencies, service: new UserMessageHistory(dependencies) };
}

test('historical wrapper names differ from mentions, plain Markdown and context updates', async () => {
  const value = await classify('<saved_prompt name="Rules &amp; review">\n# Body\n</saved_prompt>\n'
    + '<saved_prompt name="Delta" context-update-id="d">\nstate\n</saved_prompt>\nDo the task');
  assert.equal(value.kind, 'user');
  assert.deepEqual(value.prompts.map(p => p.name), ['Rules & review']);
  assert.equal(value.prompts[0].activation, 'unproven');
  assert.deepEqual(value.contextUpdates, [{ id: 'd', title: 'Delta' }]);
  assert.equal(value.userTailChars, 11);
  for (const text of ['Mention Rules & review', '# Rules & review\nFull plain Markdown',
    '```xml\n<saved_prompt name="Rules">quoted</saved_prompt>\n```',
    '> <saved_prompt name="Rules">quoted</saved_prompt>']) {
    assert.deepEqual((await classify(text)).prompts, []);
  }
});

test('context and nested AGENTS prefixes never eat a real user tail', async () => {
  const prefix = '# AGENTS.md instructions for /p\n<INSTRUCTIONS><instructions>rules</instructions></INSTRUCTIONS>\n'
    + '<environment_context>env</environment_context>\n';
  assert.equal((await classify(prefix)).kind, 'project-instructions');
  const mixed = await classify(prefix + 'Please preserve this request');
  assert.equal(mixed.kind, 'user');
  assert.equal(mixed.userPreview, 'Please preserve this request');
  const context = '<saved_prompt name="Changed" context-update-id="c">file</saved_prompt>';
  assert.equal((await classify(context)).kind, 'context-only');
  assert.equal((await classify(context + '\n\nMy actual request')).kind, 'user');
  assert.equal((await classify('<saved_prompt name="Rules">Only a prompt</saved_prompt>')).kind, 'user');
});

test('semantic agents, service records, compacts and synthetic continuations remain distinct', async () => {
  assert.equal((await classify('hello', { entry: { semanticTags: [{ kind: 'orchestration' }] } })).kind, 'agent-message');
  assert.equal((await classify('<command-name>/compact</command-name>')).kind, 'service');
  assert.equal((await classify('summary', { turn: { kind: 'compact_summary' } })).kind, 'compact');
  assert.equal((await classify('', { turn: { userUuid: null } })).kind, 'continuation');
});

test('search filters message timestamps, real queued carriers and literal text, never tools/assistant', async () => {
  const f = fixture(['older', 'newer', 'not a query match']);
  f.data.turns[1].kind = 'queued_command';
  f.data.recordMap.set('user-1', { type: 'attachment', attachment: { type: 'queued_command', prompt: 'newer' } });
  f.data.turns[2].textBlocks = [{ text: 'newer' }];
  f.data.turns[2].toolUses = [{ input: 'newer' }];
  const r = await f.service.search({ project: 'p', dateFrom: '2026-08-02', dateTo: '2026-08-03', query: 'NEWER' });
  assert.deepEqual(r.messages.map(x => x.turnIndex), [1]);
  assert.equal(r.messages[0].carrierKind, 'queued_command');
  assert.equal(r.messages[0].text, undefined);
  assert.equal(r.messages[0].toolUses, undefined);
});

test('exact prompt filter and text search have different evidence contracts', async () => {
  const f = fixture(['<saved_prompt name="Product">rules</saved_prompt>\nTask', '# Product\nPlain rules', '<saved_prompt name="Product" context-update-id="x">delta</saved_prompt>\nTask']);
  const r = await f.service.search({ sessionIds: [SID], promptName: 'product' });
  assert.deepEqual(r.messages.map(x => x.turnIndex), [0]);
  const text = await f.service.search({ sessionIds: [SID], query: 'Plain rules' });
  assert.deepEqual(text.messages.map(x => x.turnIndex), [1]);
  assert.deepEqual(text.messages[0].prompts, []);
});

test('search pages exact rows and rejects changed filters, catalogs and within-session sources', async () => {
  const f = fixture();
  const input = { project: 'p', limit: 1 };
  const first = await f.service.search(input);
  const second = await f.service.search({ ...input, cursor: first.nextCursor });
  const third = await f.service.search({ ...input, cursor: second.nextCursor });
  assert.deepEqual([first, second, third].map(r => r.messages[0].turnIndex), [0, 1, 2]);
  assert.equal(third.nextCursor, null);
  await assert.rejects(f.service.search({ ...input, query: 'changed', cursor: first.nextCursor }), { code: 'history_cursor_mismatch' });
  f.data.size = 2;
  await assert.rejects(f.service.search({ ...input, cursor: first.nextCursor }), { code: 'history_cursor_source_changed' });
  f.service.listCandidates = async () => [{ sessionId: OTHER }];
  await assert.rejects(f.service.search({ ...input, cursor: first.nextCursor }), { code: 'history_cursor_catalog_changed' });
});

test('zero-match limited pages are continuable, and failures remain incomplete on the final page', async () => {
  const f = fixture();
  f.service.listCandidates = async () => [{ sessionId: OTHER }, { sessionId: SID }];
  f.service.loadSession = async id => { if (id === OTHER) throw Object.assign(new Error('lineage_unresolved'), { lineageReason: 'provider-history-base-absent' }); return f.data; };
  const first = await f.service.search({ project: 'p', sessionLimit: 1 });
  assert.equal(first.messages.length, 0);
  assert.ok(first.nextCursor);
  assert.equal(first.errors[0].lineageReason, 'provider-history-base-absent');
  const last = await f.service.search({ project: 'p', sessionLimit: 1, cursor: first.nextCursor });
  assert.equal(last.scanComplete, true);
  assert.equal(last.coverageComplete, false);
  assert.equal(last.failedSessions, 1);
});

test('fork rows are not counted as new uses and continuation points to the real evidence turn', async () => {
  const f = fixture();
  f.service.getFork = () => ({ sourceSessionId: OTHER, snapshotComplete: true, entryUuids: ['user-0'] });
  f.data.turns[1].kind = 'compact_summary';
  f.data.turns[2].userUuid = null;
  const r = await f.service.search({ project: 'p', kinds: ['user', 'compact', 'continuation'] });
  assert.equal(r.messages[0].copyStatus, 'inherited');
  assert.equal(r.messages[2].evidenceTurnIndex, 0);
  assert.equal(r.messages[2].usageProof, 'not-established');
});

test('batch returns exact full bodies with one canonical load, no other turn material', async () => {
  const f = fixture();
  const found = await f.service.search({ project: 'p' }); f.calls.length = 0;
  const read = await f.service.read({ messages: found.messages.map(x => x.ref) });
  assert.deepEqual(read.messages.map(x => x.text), ['first', 'second', 'third']);
  assert.equal(f.calls.length, 1);
  assert.equal(read.complete, true);
  assert.equal(read.messages[0].toolUses, undefined);
});

test('oversized text has lossless UTF16 pages and does not split a surrogate pair', async () => {
  const original = 'a'.repeat(255) + '\u{1f680}' + 'z'.repeat(400);
  const f = fixture([original]);
  const refs = (await f.service.search({ project: 'p' })).messages.map(x => x.ref);
  let cursor, text = '', pages = 0;
  do {
    const page = await f.service.read({ messages: refs, maxChars: 256, cursor });
    for (const message of page.messages) { assert.ok(!/[\uD800-\uDBFF]$/.test(message.text)); text += message.text; }
    cursor = page.nextCursor; pages += 1;
  } while (cursor && pages < 10);
  assert.equal(text, original); assert.equal(pages, 3);
});

test('changed text or shifted UUID never returns another selected body', async () => {
  const f = fixture(); const refs = (await f.service.search({ project: 'p' })).messages.map(x => x.ref);
  f.data.recordMap.get('user-0').message.content = 'changed';
  f.data.turns[1].userUuid = 'user-2';
  const result = await f.service.read({ messages: refs });
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.messages.map(x => x.text), ['third']);
  assert.equal(result.complete, false);
});

test('invalid bounds and missing scope fail explicitly', async () => {
  const f = fixture();
  for (const input of [{}, { project: 'p', limit: 0 }, { project: 'p', sessionIds: [SID] }, { project: 'p', dateFrom: 'nonsense' }, { project: 'p', kinds: ['tools'] }]) {
    await assert.rejects(f.service.search(input));
  }
  await assert.rejects(f.service.read({ messages: [{ sessionId: SID, turnIndex: 0 }] }));
});

test('search summary budget produces a cursor without losing the next matching record', async () => {
  const text = Array.from({ length: 50 }, (_, i) => `<saved_prompt name="${'x'.repeat(900)}${i}">rules</saved_prompt>`).join('\n') + '\nTask';
  const f = fixture(Array(6).fill(text));
  f.data.turns.forEach(turn => { turn.userTimestamp = '2026-08-01T00:00:00Z'; });
  const first = await f.service.search({ project: 'p', limit: 200 });
  assert.ok(first.nextCursor);
  assert.ok(first.metadataChars <= first.metadataBudgetChars);
  assert.equal(first.messages[0].prompts[0].nameTruncated, true);
  const second = await f.service.search({ project: 'p', limit: 200, cursor: first.nextCursor });
  assert.deepEqual([...first.messages, ...second.messages].map(row => row.turnIndex), [0, 1, 2, 3, 4, 5]);
});

test('read failures remain explicit after later successful body pages', async () => {
  const f = fixture(['first', 'z'.repeat(500)]);
  const refs = (await f.service.search({ project: 'p' })).messages.map(row => row.ref);
  f.data.recordMap.get('user-0').message.content = 'changed';
  const first = await f.service.read({ messages: refs, maxChars: 256 });
  assert.equal(first.errors.length, 1); assert.ok(first.nextCursor);
  const last = await f.service.read({ messages: refs, maxChars: 256, cursor: first.nextCursor });
  assert.equal(last.errors.length, 0); assert.equal(last.failedMessages, 1); assert.equal(last.complete, false);
});
