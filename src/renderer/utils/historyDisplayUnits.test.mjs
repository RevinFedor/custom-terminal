import test from 'node:test';
import assert from 'node:assert';
import {
  buildHistoryDisplayUnits,
  entrySeriesFamily,
  isCaptionForNext,
  resolveHistoryDisplayTarget,
} from './historyDisplayUnits.mjs';

let seq = 0;
const raw = (toolName, family, extra = {}) => ({
  tool: '__raw__',
  rawTool: { toolUseId: 'call-' + (seq += 1), toolName, family, ...extra },
});
const row = (role, props = {}) => ({
  uuid: 'u-' + (seq += 1),
  role,
  timestamp: '',
  content: '',
  sessionId: 's',
  ...props,
});
const bashRow = (family = 'read', props = {}) =>
  row('assistant', { actions: [raw('Bash', family)], ...props });

test('series of one family collapses at threshold 2; user row breaks it', () => {
  const entries = [
    row('user', { content: 'go' }),
    bashRow('read'),
    bashRow('read'),
    bashRow('read'),
    row('user', { content: 'next' }),
    bashRow('read'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 4);
  assert.equal(units[0].kind, 'entry');
  assert.equal(units[1].kind, 'group');
  assert.equal(units[1].entries.length, 3);
  assert.equal(units[1].facts.length, 3);
  assert.equal(units[2].kind, 'entry');
  assert.equal(units[3].kind, 'entry'); // single call below threshold
});

test('MIXED noise (read + mcp + git + run) collapses into ONE unit', () => {
  const entries = [
    bashRow('read'),
    bashRow('read'),
    row('assistant', { actions: [raw('MCP', 'mcp', { mcpServer: 'electron', mcpMethod: 'click' })] }),
    row('assistant', { actions: [raw('MCP', 'mcp', { mcpServer: 'terminal', mcpMethod: 'list_tabs' })] }),
    bashRow('git'),
    bashRow('run'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  // The user does not open these rows; interleaved types must not cost one
  // line each. A different MCP server no longer breaks the run either.
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].familyKey, 'noise');
  assert.equal(units[0].facts.length, 6);
});

test('edits collapse WITH EACH OTHER but never merge into noise', () => {
  const entries = [
    bashRow('read'),
    bashRow('read'),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    row('assistant', { actions: [raw('Write', 'edit')] }),
    row('assistant', { actions: [raw('MultiEdit', 'edit')] }),
    bashRow('run'),
    bashRow('run'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 3);
  assert.equal(units[0].familyKey, 'noise');
  assert.equal(units[1].familyKey, 'edit');
  assert.equal(units[1].facts.length, 3);
  assert.equal(units[2].familyKey, 'noise');
  assert.equal(entrySeriesFamily(entries[2]), 'edit');
  assert.equal(entrySeriesFamily(entries[0]), 'noise');
});

test('a row mixing an edit and a read in ONE message never collapses', () => {
  const composite = row('assistant', {
    actions: [raw('Read', 'read'), raw('Edit', 'edit')],
  });
  assert.equal(entrySeriesFamily(composite), null);
  const units = buildHistoryDisplayUnits([composite, bashRow('read')], { threshold: 2 });
  assert.equal(units.length, 2);
  assert.ok(units.every((unit) => unit.kind === 'entry'));
});

test('caption (shared messageId, Claude) joins the group and does not break it', () => {
  const caption = row('assistant', {
    content: 'Теперь дочитаю нужные участки',
    messageId: 'msg-1',
  });
  const call1 = bashRow('read', { messageId: 'msg-1' });
  const call2 = bashRow('read', { messageId: 'msg-2' });
  assert.equal(isCaptionForNext(caption, call1), true);
  const units = buildHistoryDisplayUnits([caption, call1, call2], { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].captionEntry, caption);
  assert.equal(units[0].entries.length, 3);
  assert.equal(units[0].facts.length, 2); // caption carries no calls
});

test('codex commentary is a caption; final_answer is a boundary', () => {
  const commentary = row('assistant', { content: 'Смотрю обработчики', textPhase: 'commentary' });
  const finalAnswer = row('assistant', {
    content: 'Готово: причина найдена.',
    textPhase: 'final_answer',
  });
  const call1 = bashRow('search');
  const call2 = bashRow('search');
  assert.equal(isCaptionForNext(commentary, call1), true);
  assert.equal(isCaptionForNext(finalAnswer, call1), false);
  const units = buildHistoryDisplayUnits(
    [commentary, call1, call2, finalAnswer, bashRow('search'), bashRow('search')],
    { threshold: 2 },
  );
  // group(commentary+2 calls), final answer row, group(2 calls)
  assert.equal(units.length, 3);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[1].kind, 'entry');
  assert.equal(units[1].entry, finalAnswer);
  assert.equal(units[2].kind, 'group');
});

test('long text is a standalone reply even with shared messageId', () => {
  const longText = row('assistant', {
    content: 'x'.repeat(700),
    messageId: 'msg-1',
  });
  const call = bashRow('read', { messageId: 'msg-1' });
  assert.equal(isCaptionForNext(longText, call), false);
});

test('GIDRATION INVARIANCE: stubs with actionSummary group exactly like full rows', () => {
  const fullRows = [
    row('user', { content: 'go' }),
    bashRow('search'),
    bashRow('search'),
    bashRow('search'),
    row('assistant', { content: 'итог работы — всё нашёл, вот подробности '.repeat(30) }),
  ];
  const stubbed = fullRows.map((entry) => {
    const facts = (entry.actions || []).map((action) => ({
      toolUseId: action.rawTool.toolUseId,
      toolName: action.rawTool.toolName,
      family: action.rawTool.family,
    }));
    const stub = {
      rowStub: true,
      uuid: entry.uuid,
      role: entry.role,
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
    };
    if (entry.content) stub.hasContent = true;
    if (facts.length > 0) stub.actionSummary = facts;
    return stub;
  });
  const fullUnits = buildHistoryDisplayUnits(fullRows, { threshold: 2 });
  const stubUnits = buildHistoryDisplayUnits(stubbed, { threshold: 2 });
  assert.equal(fullUnits.length, stubUnits.length);
  for (let i = 0; i < fullUnits.length; i += 1) {
    assert.equal(fullUnits[i].kind, stubUnits[i].kind);
    if (fullUnits[i].kind === 'group') {
      assert.equal(fullUnits[i].key, stubUnits[i].key);
      assert.equal(fullUnits[i].entries.length, stubUnits[i].entries.length);
    }
  }
});

test('expandedKeys keeps the header unit and unrolls members after it', () => {
  const entries = [bashRow('read'), bashRow('read'), bashRow('read')];
  const collapsed = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(collapsed.length, 1);
  assert.notEqual(collapsed[0].expanded, true);
  const key = collapsed[0].key;
  const expanded = buildHistoryDisplayUnits(entries, {
    threshold: 2,
    expandedKeys: new Set([key]),
  });
  // header (still a group unit, marked expanded) + 3 member rows
  assert.equal(expanded.length, 4);
  assert.equal(expanded[0].kind, 'group');
  assert.equal(expanded[0].expanded, true);
  assert.equal(expanded[0].key, key);
  assert.ok(expanded.slice(1).every((unit) => unit.kind === 'entry'));
  assert.equal(expanded[1].expandedGroup.key, key);
  assert.equal(expanded[1].expandedGroup.first, true);
  assert.equal(expanded[3].expandedGroup.last, true);
});

test('resolver: uuid inside collapsed group names the group; visible uuid names its index', () => {
  const entries = [row('user', { content: 'q' }), bashRow('read'), bashRow('read')];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  const hidden = resolveHistoryDisplayTarget(units, entries[2].uuid);
  assert.equal(hidden.index, 1);
  assert.equal(hidden.groupKey, units[1].key);
  const visible = resolveHistoryDisplayTarget(units, entries[0].uuid);
  assert.deepEqual(visible, { index: 0 });
  assert.equal(resolveHistoryDisplayTarget(units, 'missing-uuid'), null);
});

test('kill switch returns identity projection', () => {
  const entries = [bashRow('read'), bashRow('read'), bashRow('read')];
  const units = buildHistoryDisplayUnits(entries, { enabled: false });
  assert.equal(units.length, 3);
  assert.ok(units.every((unit) => unit.kind === 'entry'));
});

test('error count stays in the unit data (context menu/debug) — header no longer renders it', () => {
  const entries = [
    bashRow('run'),
    row('assistant', { actions: [raw('Bash', 'run', { isError: true })] }),
    bashRow('run'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].errorCount, 1);
});

test('NO third text state: text before a single call stays an ordinary paragraph', () => {
  const caption = row('assistant', { content: 'Проверяю обработчик', messageId: 'm1' });
  const call = bashRow('run', { messageId: 'm1' });
  const reply = row('assistant', { content: 'итог '.repeat(200) });
  const units = buildHistoryDisplayUnits([caption, call, reply], { threshold: 2 });
  // Text is a group headline OR an ordinary paragraph — with no group here it
  // renders as its own entry, ordinary text style (user rejected the glued
  // mini-caption: wrong indents, wrong size, belongs to nothing).
  assert.equal(units.length, 3);
  assert.equal(units[0].kind, 'entry');
  assert.equal(units[0].entry, caption);
  assert.equal(units[0].captionOf, undefined);
  assert.equal(units[1].entry, call);
  assert.deepEqual(resolveHistoryDisplayTarget(units, caption.uuid), { index: 0 });
  assert.deepEqual(resolveHistoryDisplayTarget(units, call.uuid), { index: 1 });
});

test('group key is stable while a live series grows at the tail', () => {
  const first = bashRow('read');
  const entries = [first, bashRow('read')];
  const before = buildHistoryDisplayUnits(entries, { threshold: 2 });
  const after = buildHistoryDisplayUnits([...entries, bashRow('read')], { threshold: 2 });
  assert.equal(before[0].key, after[0].key);
  assert.equal(after[0].entries.length, 3);
});

test('mixed-group breakdown keeps first-appearance order and per-family counts', async () => {
  const { groupFamilyBreakdown } = await import('./historyDisplayUnits.mjs');
  const facts = [
    { family: 'read', toolName: 'Bash', bashWord: 'sed', subject: 'PresentationVideo.tsx' },
    { family: 'git', toolName: 'Bash', bashWord: 'git', bashDetail: 'diff', subject: 'Storyboard.tsx' },
    { family: 'read', toolName: 'Bash', bashWord: 'sed', subject: 'PresentationVideo.tsx' },
    { family: 'git', toolName: 'Bash', bashWord: 'git', bashDetail: 'status' },
    { family: 'run', toolName: 'Bash', bashWord: 'npm', subject: 'npm run build' },
    { family: 'mcp', toolName: 'MCP', mcpServer: 'electron', mcpMethod: 'evaluate' },
    { family: 'mcp', toolName: 'MCP', mcpServer: 'electron', mcpMethod: 'click' },
  ];
  const breakdown = groupFamilyBreakdown(facts);
  assert.deepEqual(breakdown.map((b) => b.family), ['read', 'git', 'run', 'mcp']);
  assert.deepEqual(breakdown.map((b) => b.count), [2, 2, 1, 2]);
  // git's distinguishing token is the SUBCOMMAND, never the word "git"
  assert.deepEqual([...breakdown[1].words.keys()], ['diff', 'status']);
  // mcp's distinguishing token is the SERVER (methods are member-level detail):
  // the header phrase reads «Called electron ×2», never «Called evaluate»
  assert.deepEqual([...breakdown[3].words.entries()], [['electron', 2]]);
  // subjects deduplicate: two reads of the same file name it once
  assert.deepEqual(breakdown[0].subjects, ['PresentationVideo.tsx']);
});

test('edit block swallows a short noise pocket BETWEEN edits (E N N E → one block)', () => {
  const entries = [
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    bashRow('run'),                                   // test run
    bashRow('read'),                                  // re-read
    row('assistant', { actions: [raw('Edit', 'edit')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].familyKey, 'edit');
  assert.equal(units[0].entries.length, 4);
});

test('noise TAIL after the last edit is NOT absorbed (E E N N → block + noise group)', () => {
  const entries = [
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    bashRow('run'),
    bashRow('read'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 2);
  assert.equal(units[0].familyKey, 'edit');
  assert.equal(units[0].facts.length, 2);
  assert.equal(units[1].familyKey, 'noise');
  assert.equal(units[1].facts.length, 2);
});

test('a 4+ noise gap breaks the edit block (corpus boundary)', () => {
  const entries = [
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    bashRow('read'), bashRow('read'), bashRow('search'), bashRow('run'),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  // edit alone, noise group of 4, edit alone
  assert.equal(units.length, 3);
  assert.equal(units[0].kind, 'entry');
  assert.equal(units[1].kind, 'group');
  assert.equal(units[1].familyKey, 'noise');
  assert.equal(units[2].kind, 'entry');
});

test('short text inside the edit gap rides along (E t N E → one block)', () => {
  const entries = [
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    row('assistant', { content: 'Исходный product-файл восстановлен полностью' }),
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].familyKey, 'edit');
  assert.equal(units[0].entries.length, 4);
});

test('noise PREFIX stays outside the edit block (git, E read E → git card + block)', () => {
  const entries = [
    bashRow('git'),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 2);
  assert.equal(units[0].kind, 'entry'); // lone git — below noise threshold
  assert.equal(units[1].kind, 'group');
  assert.equal(units[1].familyKey, 'edit');
});

test('position-based caption glues without structural proof (Claude split messages)', () => {
  const caption = row('assistant', { content: 'Проверю контейнер после последней правки' });
  const call = bashRow('search');
  assert.equal(isCaptionForNext(caption, call), true);
  const finalAnswer = row('assistant', { content: 'Готово.', textPhase: 'final_answer' });
  assert.equal(isCaptionForNext(finalAnswer, call), false);
});

test('inFlight marks only calls genuinely awaiting a result', async () => {
  const m = await import('./historyDisplayUnits.mjs');
  const entry = row('assistant', {
    actions: [
      { tool: '__raw__', rawTool: { toolUseId: 'a', toolName: 'Bash', family: 'run' } },
      { tool: '__raw__', rawTool: { toolUseId: 'b', toolName: 'Bash', family: 'run', result: 'ok' } },
      { tool: '__raw__', rawTool: { toolUseId: 'c', toolName: 'Bash', family: 'run', resultRef: { payloadId: 'p1' } } },
      { tool: '__raw__', rawTool: { toolUseId: 'd', toolName: 'Bash', family: 'run', backgroundStatus: 'running' } },
      { tool: '__raw__', rawTool: { toolUseId: 'e', toolName: 'Bash', family: 'run', isError: true } },
    ],
  });
  const facts = m.entryActionFacts(entry);
  assert.deepEqual(facts.map((f) => f.inFlight), [true, false, false, false, false]);
});
