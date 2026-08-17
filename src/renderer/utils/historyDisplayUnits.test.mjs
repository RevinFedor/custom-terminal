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
  assert.equal(units[0].familyKey, 'read');
  assert.equal(units[1].familyKey, 'edit');
  assert.equal(units[1].facts.length, 3);
  assert.equal(units[2].familyKey, 'run');
  assert.equal(entrySeriesFamily(entries[2]), 'edit');
  assert.equal(entrySeriesFamily(entries[0]), 'noise');
});

test('a row mixing a shell call and an edit belongs to the edit block', () => {
  // Codex's normal working shape: ONE record holds the script it ran and the
  // patch that script produced. Treating that mix as "never collapses" left
  // a whole session of such records as hundreds of unmergeable rows standing
  // between collapsed blocks (live screenshot, rollout 01a00884).
  const composite = row('assistant', {
    actions: [raw('Bash', 'run'), raw('Edit', 'edit')],
  });
  assert.equal(entrySeriesFamily(composite), 'edit');
  const units = buildHistoryDisplayUnits([
    composite,
    row('assistant', { actions: [raw('Edit', 'edit')] }),
  ], { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].familyKey, 'edit');
  // The shell call rides INSIDE the edit block — it is not lost, and the
  // header counts it, so «Edited 2 files · Ran 1 command» stays honest.
  assert.equal(units[0].facts.length, 3);
});

test('a mix with no edit at all stays uncollapsed', () => {
  const composite = row('assistant', {
    actions: [raw('Read', 'read'), raw('Plan', 'plan')],
  });
  assert.equal(entrySeriesFamily(composite), null);
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

test('HYDRATION INVARIANCE: a stubbed thinking marker keeps messageId ownership', () => {
  const full = [
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'm1' }),
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'm2' }),
    row('assistant', { thinking: 'tail', thinkingSeconds: 5, messageId: 'm2' }),
  ];
  const stubbed = full.map((entry) => {
    if (entry.thinking) {
      return {
        rowStub: true,
        uuid: entry.uuid,
        role: entry.role,
        messageId: entry.messageId,
        hasThinking: true,
        thinkingSeconds: entry.thinkingSeconds,
      };
    }
    return {
      rowStub: true,
      uuid: entry.uuid,
      role: entry.role,
      messageId: entry.messageId,
      actionSummary: entry.actions.map((action) => ({
        toolUseId: action.rawTool.toolUseId,
        toolName: action.rawTool.toolName,
        family: action.rawTool.family,
        aggregateKey: 'read:regular',
      })),
    };
  });
  const fullUnits = buildHistoryDisplayUnits(full, { threshold: 2 });
  const stubUnits = buildHistoryDisplayUnits(stubbed, { threshold: 2 });
  assert.equal(fullUnits.length, 1);
  assert.equal(stubUnits.length, 1);
  assert.equal(stubUnits[0].entries.length, 3);
  assert.equal(stubUnits[0].thinkingSeconds, 5);
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
  assert.equal(expanded[0].level, 2, 'a homogeneous run needs no redundant outer stack');
  assert.equal(expanded[1].expandedSubgroup.key, key);
  assert.equal(expanded[1].expandedSubgroup.first, true);
  assert.equal(expanded[3].expandedSubgroup.last, true);
});

test('mixed outer group expands into flat inner Read and MCP aggregates', () => {
  const readA = row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'src/main.js', offset: 10 } })] });
  const readB = row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'src/main.js', offset: 200 } })] });
  const mcpA = row('assistant', { actions: [raw('MCP', 'mcp', { mcpServer: 'terminal', mcpMethod: 'list_tabs', args: {} })] });
  const mcpB = row('assistant', { actions: [raw('MCP', 'mcp', { mcpServer: 'terminal', mcpMethod: 'current_context', args: {} })] });
  const entries = [readA, readB, mcpA, mcpB];
  const collapsed = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].level, 1);
  const outerKey = collapsed[0].key;

  const openedOuter = buildHistoryDisplayUnits(entries, {
    threshold: 2,
    expandedKeys: new Set([outerKey]),
  });
  assert.equal(openedOuter.length, 3, 'outer header + two collapsed inner aggregates');
  assert.equal(openedOuter[1].level, 2);
  assert.equal(openedOuter[1].familyKey, 'read');
  assert.equal(openedOuter[2].familyKey, 'mcp');
  assert.equal(openedOuter[1].parentGroup.key, outerKey);
  assert.equal(openedOuter[2].parentGroup.last, true);

  const readKey = openedOuter[1].key;
  const openedRead = buildHistoryDisplayUnits(entries, {
    threshold: 2,
    expandedKeys: new Set([outerKey, readKey]),
  });
  assert.equal(openedRead.length, 5, 'outer + read header + two raw rows + MCP header');
  assert.equal(openedRead[2].expandedSubgroup.key, readKey);
  assert.equal(openedRead[2].expandedGroup.key, outerKey, 'raw row keeps both ancestor rails');
  assert.deepEqual(resolveHistoryDisplayTarget(openedOuter, readB.uuid), { index: 1, groupKey: readKey });
});

test('thinking is a hard boundary for inner Read aggregation', () => {
  const readA = row('assistant', {
    actions: [raw('Read', 'read', { args: { file_path: 'src/a.ts' } })],
    messageId: 'm1',
  });
  const thought = row('assistant', {
    thinking: 'compare with the second file',
    thinkingSeconds: 7,
    messageId: 'm2',
  });
  const readB = row('assistant', {
    actions: [raw('Read', 'read', { args: { file_path: 'src/b.ts' } })],
    messageId: 'm2',
  });
  const entries = [readA, thought, readB];
  const collapsed = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].level, 1, 'reasoning makes this a broad work block, not a root file aggregate');
  const outerKey = collapsed[0].key;

  const openedOuter = buildHistoryDisplayUnits(entries, {
    threshold: 2,
    expandedKeys: new Set([outerKey]),
  });
  assert.equal(openedOuter.length, 4, 'outer header + Read + thinking + Read, in source order');
  assert.ok(openedOuter.slice(1).every((unit) => unit.kind === 'entry'));
  assert.equal(openedOuter[1].entry, readA);
  assert.equal(openedOuter[2].entry, thought);
  assert.equal(openedOuter[3].entry, readB);
  assert.equal(openedOuter[2].expandedGroup.key, outerKey);
  assert.ok(openedOuter.slice(1).every((unit) => unit.expandedSubgroup === undefined));
});

test('a composite thinking plus tool record cannot enter an inner aggregate', () => {
  const composite = row('assistant', {
    thinking: 'inspect first',
    actions: [raw('Read', 'read', { args: { file_path: 'src/a.ts' } })],
  });
  const read = row('assistant', {
    actions: [raw('Read', 'read', { args: { file_path: 'src/b.ts' } })],
  });
  const outer = buildHistoryDisplayUnits([composite, read], { threshold: 2 })[0];
  assert.equal(outer.level, 1);
  const expanded = buildHistoryDisplayUnits([composite, read], {
    threshold: 2,
    expandedKeys: new Set([outer.key]),
  });
  assert.ok(expanded.slice(1).every((unit) => unit.kind === 'entry'));
  assert.ok(expanded.slice(1).every((unit) => unit.expandedSubgroup === undefined));
});

test('a caption between equal actions also breaks the inner aggregate', () => {
  const readA = row('assistant', {
    actions: [raw('Read', 'read', { args: { file_path: 'src/a.ts' } })],
  });
  const caption = row('assistant', { content: 'Now compare the other file' });
  const readB = row('assistant', {
    actions: [raw('Read', 'read', { args: { file_path: 'src/b.ts' } })],
  });
  const outer = buildHistoryDisplayUnits([readA, caption, readB], { threshold: 2 })[0];
  assert.equal(outer.level, 1);
  const expanded = buildHistoryDisplayUnits([readA, caption, readB], {
    threshold: 2,
    expandedKeys: new Set([outer.key]),
  });
  assert.deepEqual(expanded.slice(1).map((unit) => unit.entry), [readA, caption, readB]);
  assert.ok(expanded.slice(1).every((unit) => unit.expandedSubgroup === undefined));
});

test('docs scope splits inner Read aggregates without changing chronology', () => {
  const entries = [
    row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'docs/a.md' } })] }),
    row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'docs/b.md' } })] }),
    row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'src/a.ts' } })] }),
    row('assistant', { actions: [raw('Read', 'read', { args: { file_path: 'src/b.ts' } })] }),
  ];
  const outer = buildHistoryDisplayUnits(entries, { threshold: 2 })[0];
  assert.equal(outer.level, 1, 'different semantic scopes earn the broad outer block');
  const expanded = buildHistoryDisplayUnits(entries, {
    threshold: 2,
    expandedKeys: new Set([outer.key]),
  });
  assert.equal(expanded.length, 3);
  assert.equal(expanded[1].docsKind, 'search');
  assert.equal(expanded[1].aggregateKey, 'read:docs');
  assert.equal(expanded[2].aggregateKey, 'read:regular');
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
  assert.deepEqual(breakdown.map((b) => b.count), [1, 2, 1, 2]);
  assert.deepEqual(breakdown.map((b) => b.callCount), [2, 2, 1, 2]);
  // git's distinguishing token is the SUBCOMMAND, never the word "git"
  assert.deepEqual([...breakdown[1].words.keys()], ['diff', 'status']);
  // mcp's distinguishing token is the SERVER (methods are member-level detail):
  // the header phrase reads «Called electron ×2», never «Called evaluate»
  assert.deepEqual([...breakdown[3].words.entries()], [['electron', 2]]);
  // subjects deduplicate: two reads of the same file name it once
  assert.deepEqual(breakdown[0].subjects, ['PresentationVideo.tsx']);
});

test('outer breakdown keeps docs and regular files as separate honest phrases', async () => {
  const { groupFamilyBreakdown } = await import('./historyDisplayUnits.mjs');
  const breakdown = groupFamilyBreakdown([
    { family: 'read', targetKey: 'docs/a.md', targetLabel: 'a.md', docsKind: 'search' },
    { family: 'read', targetKey: 'docs/b.md', targetLabel: 'b.md', docsKind: 'search' },
    { family: 'read', targetKey: 'src/main.js', targetLabel: 'main.js' },
  ]);
  assert.equal(breakdown.length, 2);
  assert.deepEqual(breakdown.map((bucket) => [bucket.family, bucket.docsKind, bucket.count]), [
    ['read', 'search', 2],
    ['read', '', 1],
  ]);
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

// ── findHistoryHydrationStub: the entry-bounded stub search ────────────────

test('hydration stub search: margin is bounded in ENTRIES, not units', async () => {
  const { findHistoryHydrationStub } = await import('./historyDisplayUnits.mjs');
  // One collapsed group unit hiding 100 stubbed entries, far above the
  // viewport; then hydrated singles. Margin 50 entries: the walk crosses the
  // group (weight 100) and must STOP — with unit-based margins it would have
  // reached the stub behind it.
  const groupMembers = Array.from({ length: 100 }, () => bashRow('read', { rowStub: true }));
  const farStub = row('user', { rowStub: true, content: '' });
  const units = [
    { kind: 'entry', entry: farStub },
    { kind: 'group', key: 'grp:x', familyKey: 'noise', entries: groupMembers, facts: [], errorCount: 0 },
    { kind: 'entry', entry: row('user', { content: 'visible' }) },
    { kind: 'entry', entry: row('user', { content: 'visible2' }) },
  ];
  const found = findHistoryHydrationStub(units, { start: 2, end: 3 }, 50);
  assert.equal(found, null);
  // A wider margin (150 entries) does reach past the group to the far stub.
  const foundWide = findHistoryHydrationStub(units, { start: 2, end: 3 }, 150);
  assert.equal(foundWide?.entry, farStub);
});

test('hydration stub search: off-screen collapsed groups are not targets, on-screen ones are', async () => {
  const { findHistoryHydrationStub } = await import('./historyDisplayUnits.mjs');
  const stubMember = bashRow('read', { rowStub: true });
  const group = { kind: 'group', key: 'grp:y', familyKey: 'noise', entries: [stubMember, bashRow('read', { rowStub: true })], facts: [], errorCount: 0 };
  const visible = { kind: 'entry', entry: row('user', { content: 'v' }) };
  // Group off-screen (below viewport, within margin): NOT a target.
  assert.equal(findHistoryHydrationStub([visible, group], { start: 0, end: 0 }, 10), null);
  // Group inside the viewport: its stubbed member IS a target (caption needs content).
  const foundOnScreen = findHistoryHydrationStub([visible, group], { start: 0, end: 1 }, 10);
  assert.equal(foundOnScreen?.entry, stubMember);
});

test('hydration stub search: on-screen entry stub always wins', async () => {
  const { findHistoryHydrationStub } = await import('./historyDisplayUnits.mjs');
  const onScreen = row('user', { rowStub: true, content: '' });
  const units = [
    { kind: 'entry', entry: row('user', { content: 'a' }) },
    { kind: 'entry', entry: onScreen },
  ];
  const found = findHistoryHydrationStub(units, { start: 0, end: 1 }, 0);
  assert.equal(found?.entry, onScreen);
  assert.equal(found?.index, 1);
});

test('reasoning rides inside a run: it neither breaks it nor counts as a call', () => {
  // The screenshot case: read → think → search → think → bash. Six rows that
  // are one block of work; reasoning as a standalone event cut it into a
  // ladder of three groups and three lone rows.
  const entries = [
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { thinking: 'a', thinkingSeconds: 7 }),
    row('assistant', { actions: [raw('Grep', 'search')] }),
    row('assistant', { thinking: 'b', thinkingSeconds: 5 }),
    row('assistant', { actions: [raw('Bash', 'run')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  // THREE calls, not five: thoughts are not actions and must never inflate
  // the header's count.
  assert.equal(units[0].facts.length, 3);
  // One summed figure for the whole block.
  assert.equal(units[0].thinkingSeconds, 12);
});

test('a reasoning TAIL after the last call is not part of the block', () => {
  const entries = [
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { thinking: 'next step', thinkingSeconds: 9 }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 2);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].thinkingSeconds, 0, 'the tail thought belongs to what comes next');
  assert.equal(units[1].kind, 'entry');
});

test('messageId keeps a trailing reasoning row with the response that owns it', () => {
  const entries = [
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'm1' }),
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'm2' }),
    row('assistant', { thinking: 'analysis of the second read', thinkingSeconds: 9, messageId: 'm2' }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].entries.length, 3);
  assert.equal(units[0].thinkingSeconds, 9);
});

test('messageId moves reasoning forward through its caption instead of orphaning it', () => {
  const entries = [
    row('assistant', { actions: [raw('Edit', 'edit')], messageId: 'old' }),
    row('assistant', { actions: [raw('Edit', 'edit')], messageId: 'old2' }),
    row('assistant', { thinking: 'prepare next reads', thinkingSeconds: 4, messageId: 'next' }),
    row('assistant', { content: 'Now inspect the parent state', messageId: 'next' }),
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'next' }),
    row('assistant', { actions: [raw('Read', 'read')], messageId: 'next2' }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 2);
  assert.equal(units[0].thinkingSeconds, 0);
  assert.equal(units[1].thinkingSeconds, 4);
  assert.equal(units[1].entries[0].thinking, 'prepare next reads');
});

test('reasoning leading INTO a run opens that run', () => {
  const entries = [
    row('assistant', { thinking: 'plan', thinkingSeconds: 4 }),
    row('assistant', { actions: [raw('Read', 'read')] }),
    row('assistant', { actions: [raw('Read', 'read')] }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[0].facts.length, 2);
  assert.equal(units[0].thinkingSeconds, 4);
});

test('reasoning alone never invents a group', () => {
  const entries = [
    row('assistant', { thinking: 'a', thinkingSeconds: 3 }),
    row('assistant', { thinking: 'b', thinkingSeconds: 4 }),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.ok(units.every((unit) => unit.kind === 'entry'), 'nothing to group');
});

test('slash commands never group — each stays its own service line', () => {
  // A settings block («Изменены настройки ×2») was tried and rejected live:
  // two one-word rows cost nothing, while the wrapper hid WHICH settings
  // changed — the only information those rows carry.
  const slash = (content, uuid) => ({ role: 'slash', uuid, content });
  const rows = [slash('/model opus', 's1'), slash('/effort max', 's2'), slash('/model', 's3')];
  const units = buildHistoryDisplayUnits(rows, { threshold: 2 });
  assert.equal(units.length, 3);
  assert.ok(units.every((unit) => unit.kind === 'entry'));
  assert.deepEqual(resolveHistoryDisplayTarget(units, 's3'), { index: 2 });
});

test('a slash row still breaks an action series around it', () => {
  const entries = [
    bashRow('read'),
    bashRow('read'),
    { role: 'slash', uuid: 'sl-1', content: '/model' },
    bashRow('read'),
    bashRow('read'),
  ];
  const units = buildHistoryDisplayUnits(entries, { threshold: 2 });
  assert.equal(units.length, 3);
  assert.equal(units[0].kind, 'group');
  assert.equal(units[1].kind, 'entry');
  assert.equal(units[2].kind, 'group');
});

test('units cache: same rows array + same expanded set is a hit; new array is a miss', async () => {
  const { peekHistoryDisplayUnitsCached, buildHistoryDisplayUnitsCached } =
    await import('./historyDisplayUnits.mjs');
  const rows = [bashRow('read'), bashRow('read'), row('user', { content: 'x' })];
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };

  assert.equal(peekHistoryDisplayUnitsCached(rows, options), null, 'cold peek misses');
  const built = buildHistoryDisplayUnitsCached(rows, options);
  assert.equal(peekHistoryDisplayUnitsCached(rows, options), built, 'same array+set hits');
  // A different Set INSTANCE with the same content still hits (signature, not identity).
  assert.equal(
    peekHistoryDisplayUnitsCached(rows, { enabled: true, threshold: 2, expandedKeys: new Set() }),
    built,
  );
  // Toggling a group is a different signature — its own slot, both stay warm.
  const expanded = { enabled: true, threshold: 2, expandedKeys: new Set([built[0].key]) };
  assert.equal(peekHistoryDisplayUnitsCached(rows, expanded), null);
  const builtExpanded = buildHistoryDisplayUnitsCached(rows, expanded);
  assert.notEqual(builtExpanded, built);
  assert.equal(peekHistoryDisplayUnitsCached(rows, expanded), builtExpanded);
  assert.equal(peekHistoryDisplayUnitsCached(rows, options), built, 'collapse-back stays warm');
  // A NEW rows array (delta reassembly) legitimately misses.
  assert.equal(peekHistoryDisplayUnitsCached([...rows], options), null);
  // Kill switch bypasses grouping but caches too.
  const off = buildHistoryDisplayUnitsCached(rows, { enabled: false });
  assert.equal(peekHistoryDisplayUnitsCached(rows, { enabled: false }), off);
  assert.equal(off.every((unit) => unit.kind === 'entry'), true);
});

test('appended build: tail append reuses the prefix and equals the full build', async () => {
  const { buildHistoryDisplayUnitsAppended } = await import('./historyDisplayUnits.mjs');
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };
  // Prefix with hard boundaries (user rows) so there is something to reuse.
  const prev = [];
  for (let i = 0; i < 6; i += 1) {
    prev.push(bashRow('read'), bashRow('read'), row('user', { content: 'q' + i }));
  }
  const prevUnits = buildHistoryDisplayUnits(prev, options);
  // Live append: same row REFERENCES + new tail rows (one more series).
  const next = [...prev, bashRow('git'), bashRow('git')];
  const appended = buildHistoryDisplayUnitsAppended(prev, prevUnits, next, options);
  assert.ok(appended, 'tail append qualifies for the incremental path');
  assert.ok(appended.reusedUnits > 0, 'a prefix was reused');
  assert.ok(appended.rebuiltEntries < next.length, 'only the tail was rebuilt');
  const full = buildHistoryDisplayUnits(next, options);
  assert.deepEqual(
    appended.units.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
    full.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
    'incremental result structurally equals the full build',
  );
});

test('appended build: growth INSIDE the tail series regroups it identically', async () => {
  const { buildHistoryDisplayUnitsAppended } = await import('./historyDisplayUnits.mjs');
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };
  const prev = [
    bashRow('read'), row('user', { content: 'q' }),
    bashRow('read'), // tail series of ONE call (below threshold → lone row)
  ];
  const prevUnits = buildHistoryDisplayUnits(prev, options);
  // The append EXTENDS the tail series past the threshold — the lone row
  // must become a group; prefix reuse must stop before it.
  const next = [...prev, bashRow('read'), bashRow('read')];
  const appended = buildHistoryDisplayUnitsAppended(prev, prevUnits, next, options);
  const full = buildHistoryDisplayUnits(next, options);
  if (appended) {
    assert.deepEqual(
      appended.units.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
      full.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
      'series that grew across the cut regroups exactly as the full build',
    );
  }
  // Either the incremental path produced the identical structure or it
  // declined (null) and the caller full-builds — both are correct; silently
  // WRONG grouping is the only failure mode this test rejects.
});

test('appended build reuses an expanded inner aggregate atomically', async () => {
  const { buildHistoryDisplayUnitsAppended } = await import('./historyDisplayUnits.mjs');
  const firstRows = [bashRow('read'), bashRow('read')];
  const firstKey = buildHistoryDisplayUnits(firstRows, { threshold: 2 })[0].key;
  const options = { enabled: true, threshold: 2, expandedKeys: new Set([firstKey]) };
  const prev = [...firstRows, row('user', { content: 'boundary' })];
  for (let i = 0; i < 6; i += 1) {
    prev.push(bashRow('run'), bashRow('run'), row('user', { content: 'q' + i }));
  }
  const prevUnits = buildHistoryDisplayUnits(prev, options);
  const next = [...prev, bashRow('git'), bashRow('git')];
  const appended = buildHistoryDisplayUnitsAppended(prev, prevUnits, next, options);
  assert.ok(appended);
  const full = buildHistoryDisplayUnits(next, options);
  const shape = (units) => units.map((unit) => unit.kind === 'group'
    ? ['g', unit.key, unit.entries.map((entry) => entry.uuid)]
    : ['e', unit.entry.uuid, unit.expandedSubgroup?.key || unit.expandedGroup?.key || '']);
  assert.deepEqual(shape(appended.units), shape(full));
});

test('appended build: every split point over a mixed corpus equals the full build', async () => {
  const { buildHistoryDisplayUnitsAppended } = await import('./historyDisplayUnits.mjs');
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };
  const corpus = [
    bashRow('read'), bashRow('read'),
    row('user', { content: 'q1' }),
    row('assistant', { content: 'short caption', messageId: 'm1' }),
    row('assistant', { actions: [raw('Bash', 'search')], messageId: 'm1' }),
    bashRow('search'),
    row('assistant', { content: 'a long standalone reply '.repeat(40) }),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    bashRow('read'),
    row('assistant', { actions: [raw('Edit', 'edit')] }),
    row('user', { content: 'q2' }),
    bashRow('git'), bashRow('git'), bashRow('run'),
  ];
  for (let cut = 1; cut < corpus.length; cut += 1) {
    const prev = corpus.slice(0, cut);
    const prevUnits = buildHistoryDisplayUnits(prev, options);
    const next = [...prev, ...corpus.slice(cut).map((entry) => ({ ...entry }))];
    const appended = buildHistoryDisplayUnitsAppended(prev, prevUnits, next, options);
    if (!appended) continue; // declined → caller full-builds; correctness holds
    const full = buildHistoryDisplayUnits(next, options);
    assert.deepEqual(
      appended.units.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
      full.map((u) => u.kind === 'group' ? ['g', u.entries.map((e) => e.uuid)] : ['e', u.entry.uuid]),
      'split at ' + cut + ' diverged from the full build',
    );
  }
});

test('appended build declines on expansion change and on rewritten arrays', async () => {
  const { buildHistoryDisplayUnitsAppended } = await import('./historyDisplayUnits.mjs');
  const options = { enabled: true, threshold: 2, expandedKeys: new Set() };
  const prev = [];
  for (let i = 0; i < 6; i += 1) {
    prev.push(bashRow('read'), bashRow('read'), row('user', { content: 'q' + i }));
  }
  const prevUnits = buildHistoryDisplayUnits(prev, options);
  const next = [...prev, bashRow('git'), bashRow('git')];
  // Expansion signature moved → decline (reused units would carry the old shape).
  const otherOptions = { enabled: true, threshold: 2, expandedKeys: new Set(['grp:whatever']) };
  assert.equal(buildHistoryDisplayUnitsAppended(prev, prevUnits, next, otherOptions, options), null);
  // Full object rewrite (Claude reload) → zero common prefix → decline.
  const rewritten = next.map((entry) => ({ ...entry }));
  assert.equal(buildHistoryDisplayUnitsAppended(prev, prevUnits, rewritten, options), null);
});
