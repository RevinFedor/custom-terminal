'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const { _api: codexData } = require('./ipc/codex-data');
const {
  TabWorkContext,
  acknowledgeReadCoverage,
  changedHunks,
  fileBatchPresentation,
  shellEditStepSucceeded,
  verifiedReadCoverage,
} = require('./tab-work-context');

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function openHarness(t, before, options = {}) {
  let db;
  try {
    db = new Database(':memory:');
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-work-context-'));
  const filePath = path.join(dir, 'visual-history.md');
  fs.writeFileSync(filePath, before);
  const owner = {
    tabId: 'tab-visual-history',
    projectId: 'project',
    name: 'visual History',
    cwd: dir,
    tabType: 'terminal',
    commandType: 'codex',
    codexSessionId: 'session-visual-history',
  };
  const fileTab = {
    tabId: 'tab-visual-history-file',
    projectId: 'project',
    name: 'visual-history.md',
    cwd: dir,
    tabType: 'file',
    filePath,
    visualParentTabId: owner.tabId,
  };
  const extraTabs = typeof options.extraTabs === 'function'
    ? options.extraTabs({ dir, filePath, owner })
    : (options.extraTabs || []);
  const tabs = [owner, fileTab, ...extraTabs];
  const context = new TabWorkContext({
    db,
    listTabs: () => tabs,
    archivedTab: () => null,
    onChanged: () => {},
  });
  context.configure({
    transcriptService: options.transcriptService || null,
    decodeCodexCall: codexData.codexHistoryActionsForCall,
    decodeCodexPatch: codexData.parseCodexPatchApplyChanges,
    readReceipts: () => [],
    resolveAttributionSource: options.resolveAttributionSource,
  });
  await context.syncLinks();

  t.after(async () => {
    for (const watcher of context.watchers.values()) watcher.close();
    await Promise.allSettled([...context.reads.values()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { context, filePath, owner, tabs };
}

function codexCall(callId, tool, args, source = {}) {
  return {
    tabId: source.tabId || 'tab-visual-history',
    sessionId: source.sessionId || 'session-visual-history',
    toolType: 'codex',
    message: {
      type: 'response_item',
      timestamp: source.timestamp,
      payload: {
        type: 'custom_tool_call',
        call_id: callId,
        name: tool,
        arguments: JSON.stringify(args),
      },
    },
  };
}

test('a path-first prompt includes pending context; only a standalone command leaves it pending', async t => {
  const h = await openHarness(t, '# Work\nbefore\n');
  if (!h) return;
  fs.writeFileSync(h.filePath, '# Work\nupdated body\n');
  await h.context.readFile(h.filePath);
  assert.equal(h.context.get(h.owner.tabId).pendingCount, 1);
  const command = await h.context.prepare(h.owner.tabId, 'local-command', '/compact');
  assert.equal(command.prefix, '');
  assert.equal(h.context.get(h.owner.tabId).pendingCount, 1);
  const prompt = '/Users/fedor/Desktop/voice-record Описание задачи';
  const prepared = await h.context.prepare(h.owner.tabId, 'ordinary-path', prompt);
  assert.ok(prepared.prefix.includes('context-update-id='));
  assert.ok(prepared.prompt.includes('updated body'));
  assert.ok(prepared.prompt.endsWith(prompt));
  assert.equal((await h.context.prepare(h.owner.tabId, 'ordinary-path', prompt)).prompt, prepared.prompt,
    'replay keeps the same frozen payload');
});

function codexResult(callId, source = {}) {
  return {
    tabId: source.tabId || 'tab-visual-history',
    sessionId: source.sessionId || 'session-visual-history',
    toolType: 'codex',
    message: {
      type: 'response_item',
      timestamp: source.timestamp,
      payload: {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: source.output ?? '',
        is_error: source.isError === true,
      },
    },
  };
}

test('shell edit results reject provider errors and explicit non-zero process exits', () => {
  assert.equal(shellEditStepSucceeded({ result: '', isError: false }), true);
  assert.equal(shellEditStepSucceeded({ result: '{"exit_code":0}', isError: false }), true);
  assert.equal(shellEditStepSucceeded({ result: 'Exit code 1', isError: false }), false);
  assert.equal(shellEditStepSucceeded({ result: 'ok', isError: true }), false);
});

test('separated edits report real hunks and lines instead of their bounding span', () => {
  const beforeLines = Array.from({ length: 600 }, (_, index) => `unchanged ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines.splice(152, 10);
  afterLines[534] = 'updated reference A';
  afterLines[540] = 'updated reference B';
  const before = beforeLines.join('\n');
  const after = afterLines.join('\n');

  const diff = changedHunks(before, after);
  assert.equal(diff.fallback, false);
  assert.equal(diff.hunks.length, 3);
  assert.equal(diff.changedLineCount, 12);
  assert.deepEqual(
    diff.hunks.map((hunk) => [hunk.removed, hunk.added]),
    [[10, 0], [1, 1], [1, 1]],
  );
  assert.equal(diff.hunks[0].oldStart, 151);
  assert.deepEqual(diff.hunks[0].entries.slice(0, 2).map((entry) => entry.tag), ['eq', 'eq']);
  assert.deepEqual(diff.hunks.at(-1).entries.slice(-2).map((entry) => entry.tag), ['eq', 'eq']);

  const presentation = fileBatchPresentation([{
    path: '/tmp/plan.md',
    beforeText: before,
    afterText: after,
    sources: [],
    unknownSource: true,
  }]);
  assert.equal(presentation.title, 'plan.md · 3 участка · 12 строк');
  assert.doesNotMatch(presentation.text, /unchanged 300/, 'unchanged middle is not sent to the model');
});

test('verified owner reads remove only changed lines that were actually returned', () => {
  const before = 'one\nold two\nthree\nfour\nfive\nsix\nseven\nold eight\nnine\n';
  const after = 'one\nnew two\nthree\nfour\nfive\nsix\nseven\nnew eight\nnine\n';
  const coverage = verifiedReadCoverage({
    tool: 'Read',
    args: { file_path: '/tmp/context.md', offset: 1, limit: 4 },
    result: '     1\u2192one\n     2\u2192new two\n     3\u2192three\n     4\u2192four',
    isError: false,
  }, after, '/tmp');
  assert.deepEqual(coverage, {
    filePath: '/tmp/context.md',
    ranges: [{ start: 1, end: 4 }],
    full: false,
  });
  const acknowledged = acknowledgeReadCoverage(before, after, coverage);
  assert.equal(acknowledged, 'one\nnew two\nthree\nfour\nfive\nsix\nseven\nold eight\nnine\n');
  const remaining = fileBatchPresentation([{
    path: '/tmp/context.md', beforeText: before, afterText: after,
    acknowledgedText: acknowledged,
  }]);
  assert.equal(remaining.title, 'context.md · 1 участок · 1 строка');
  assert.doesNotMatch(remaining.text, /^[+-] (?:old|new) two$/m);
  assert.match(remaining.text, /^- old eight$/m);
  assert.match(remaining.text, /^\+ new eight$/m);
});

test('verified shell reads require an exact file range, including numbered Codex output', () => {
  const current = 'one\ntwo\nthree\nfour\nfive\n';
  assert.deepEqual(verifiedReadCoverage({
    tool: 'Bash',
    args: { command: "sed -n '2,4p' /tmp/context.md" },
    result: 'two\nthree\nfour\n',
  }, current, '/tmp'), {
    filePath: '/tmp/context.md', ranges: [{ start: 2, end: 4 }], full: false,
  });
  assert.deepEqual(verifiedReadCoverage({
    tool: 'Bash',
    args: { command: "nl -ba /tmp/context.md | sed -n '2,4p'" },
    result: '     2\ttwo\n     3\tthree\n     4\tfour\n',
  }, current, '/tmp'), {
    filePath: '/tmp/context.md', ranges: [{ start: 2, end: 4 }], full: false,
  });
  assert.equal(verifiedReadCoverage({
    tool: 'Bash',
    args: { command: "awk '{print toupper($0)}' /tmp/context.md" },
    result: 'ONE\nTWO\nTHREE\nFOUR\nFIVE\n',
  }, current, '/tmp'), null, 'transformed output is not proof of the original lines');
});

test('an insertion near the beginning does not mark the shifted tail as changed', () => {
  const tail = Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`);
  const before = tail.join('\n');
  const after = ['inserted A', 'inserted B', ...tail].join('\n');
  const diff = changedHunks(before, after);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.changedLineCount, 2);
  assert.equal(diff.hunks[0].added, 2);
  assert.equal(diff.hunks[0].removed, 0);
});

test('file update presentation lists multiple known source tabs and unknown residue', () => {
  const presentation = fileBatchPresentation([{
    path: '/tmp/plan.md',
    beforeText: 'before',
    afterText: 'after',
    sources: [
      { tabId: 'tab-a', tabName: 'state main' },
      { tabId: 'tab-b', tabName: 'history worker' },
    ],
    unknownSource: true,
  }]);
  assert.equal(presentation.title, 'plan.md · 1 участок · 1 строка');
  assert.match(presentation.text, /^Sources: state main, history worker, Внешнее изменение/m);
  assert.equal(presentation.sourceTabId, null);
});

test('multi-hunk output reconstructs the exact current file across mixed edits', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let run = 0; run < 80; run += 1) {
    const previous = Array.from({ length: 30 }, (_, index) => `run ${run} line ${index}`);
    const current = [...previous];
    for (let mutation = 0; mutation < 8; mutation += 1) {
      const index = Math.floor(random() * (current.length + 1));
      const kind = Math.floor(random() * 3);
      if (kind === 0 && current.length > 0) {
        current[Math.min(index, current.length - 1)] = `replacement ${run} ${mutation}`;
      } else if (kind === 1) {
        current.splice(index, 0, `insert ${run} ${mutation}`);
      } else if (current.length > 0) {
        current.splice(Math.min(index, current.length - 1), 1);
      }
    }

    const diff = changedHunks(previous.join('\n'), current.join('\n'));
    const rebuilt = [];
    let previousCursor = 0;
    for (const hunk of diff.hunks) {
      const hunkStart = hunk.oldStart - 1;
      rebuilt.push(...previous.slice(previousCursor, hunkStart));
      let cursor = hunkStart;
      for (const entry of hunk.entries) {
        if (entry.tag === 'add') {
          rebuilt.push(entry.line);
          continue;
        }
        assert.equal(entry.line, previous[cursor], `run ${run}: hunk old line mismatch`);
        if (entry.tag === 'eq') rebuilt.push(entry.line);
        cursor += 1;
      }
      previousCursor = cursor;
    }
    rebuilt.push(...previous.slice(previousCursor));
    assert.deepEqual(rebuilt, current, `run ${run}: hunks lost a file change`);
  }
});

test('a genuinely rewritten file falls back to one complete bounded presentation', () => {
  const previous = Array.from({ length: 1000 }, (_, index) => `old ${index}`).join('\n');
  const current = Array.from({ length: 1000 }, (_, index) => `new ${index}`).join('\n');
  const diff = changedHunks(previous, current);
  assert.equal(diff.fallback, true);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.changedLineCount, 1000);
});

test('a legacy pending envelope is re-presented as multi-hunk through its member identity', async (t) => {
  const beforeLines = Array.from({ length: 600 }, (_, index) => `legacy ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines.splice(152, 10);
  afterLines[534] = 'new legacy reference A';
  afterLines[540] = 'new legacy reference B';
  const harness = await openHarness(t, afterLines.join('\n'));
  if (!harness) return;
  const { context, filePath, owner } = harness;
  context.db.prepare(`INSERT INTO tab_context_updates(
    id,tab_id,title,text,kind,path,file_changes_json,status,created_at
  ) VALUES (?,?,?,?,?,?,?,'pending',?)`).run(
    'legacy-update', owner.tabId, 'plan.md · 399 строк', 'legacy envelope',
    'file-batch', filePath, JSON.stringify([{
      path: filePath,
      beforeText: beforeLines.join('\n'),
      afterText: afterLines.join('\n'),
    }]), Date.now(),
  );

  const update = context.get(owner.tabId).updates.find((item) => item.memberIds.includes('legacy-update'));
  assert.match(update.id, /^file-context-/);
  assert.equal(update.title, 'visual-history.md · 3 участка · 12 строк');
  assert.doesNotMatch(update.text, /legacy 300/);
  const oldWrapper = '<saved_prompt name="plan.md · 399 строк" context-update-id="legacy-update">\n'
    + 'legacy envelope\n</saved_prompt>\n\nЧто изменилось?';
  const prepared = await context.prepare(owner.tabId, 'legacy-handoff', oldWrapper);
  assert.match(prepared.prompt, /name="visual-history\.md · 3 участка · 12 строк"/);
  assert.doesNotMatch(prepared.prompt, /legacy envelope/);
  assert.doesNotMatch(prepared.prompt, /legacy 300/);
});

test('immutable pending versions of one file project as one stable chip and one new handoff wrapper', async (t) => {
  const finalText = 'ONE\nTWO\nTHREE\nFOUR\n';
  const sourceTabs = [
    { tabId: 'tab-source-one', projectId: 'project', name: 'source one', commandType: 'codex', codexSessionId: 'session-one' },
    { tabId: 'tab-source-two', projectId: 'project', name: 'source two', commandType: 'codex', codexSessionId: 'session-two' },
    { tabId: 'tab-source-three', projectId: 'project', name: 'source three', commandType: 'codex', codexSessionId: 'session-three' },
    { tabId: 'tab-source-four', projectId: 'project', name: 'source four', commandType: 'codex', codexSessionId: 'session-four' },
  ];
  const harness = await openHarness(t, finalText, {
    extraTabs: ({ dir }) => sourceTabs.map((tab) => ({
      ...tab, cwd: dir, tabType: 'terminal',
    })),
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const versions = [
    ['one\ntwo\nthree\nfour\n', 'ONE\ntwo\nthree\nfour\n'],
    ['ONE\ntwo\nthree\nfour\n', 'ONE\nTWO\nthree\nfour\n'],
    ['ONE\nTWO\nthree\nfour\n', 'ONE\nTWO\nTHREE\nfour\n'],
    ['ONE\nTWO\nTHREE\nfour\n', finalText],
  ];
  const ids = ['reserved-one', 'reserved-two', 'reserved-three', 'reserved-four'];
  const insertReserved = (index) => {
    const [beforeText, afterText] = versions[index];
    const id = ids[index];
    context.db.prepare(`INSERT INTO tab_context_updates(
      id,tab_id,title,text,kind,path,file_changes_json,status,created_at
    ) VALUES (?,?,?,?,?,?,?,'pending',?)`).run(
      id,
      owner.tabId,
      '',
      '',
      'file-batch',
      filePath,
      JSON.stringify([{
        path: filePath,
        beforeText,
        afterText,
        sources: [{
          tabId: sourceTabs[index].tabId,
          tabName: sourceTabs[index].name,
          projectId: sourceTabs[index].projectId,
        }],
        unknownSource: false,
      }]),
      Date.now() + index,
    );
    context.db.prepare(`INSERT INTO tab_context_handoffs(
      tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,status,created_at
    ) VALUES (?,?,?,?,?,?,?,'failed',?)`).run(
      owner.tabId,
      'old-handoff-' + index,
      'base-' + index,
      '',
      'old prepared ' + index,
      'payload-' + index,
      JSON.stringify([id]),
      Date.now() + index,
    );
  };
  [0, 1, 2].forEach(insertReserved);

  const [group] = context.get(owner.tabId).updates;
  assert.equal(context.get(owner.tabId).updates.length, 1);
  assert.match(group.id, /^file-context-/);
  assert.deepEqual(group.memberIds, ids.slice(0, 3));
  assert.equal(group.title, 'visual-history.md · 3 участка · 3 строки');
  assert.deepEqual(group.sections.map((section) => section.title), [
    '1 участок · 1 строка',
    '1 участок · 1 строка',
    '1 участок · 1 строка',
  ]);
  assert.deepEqual(group.sections.map((section) => section.sourceTabs[0].tabName), [
    'source one', 'source two', 'source three',
  ]);
  assert.equal(group.sections.some((section) => Object.hasOwn(section, 'text')), false,
    'section bodies must reference the one shared text instead of duplicating it in the API');
  assert.match(group.text.slice(group.sections[1].textStart, group.sections[1].textEnd), /source two/);
  const listed = context.list().find((item) => item.tabId === owner.tabId).updates[0];
  assert.equal(Object.hasOwn(listed, 'text'), false);
  assert.equal(Object.hasOwn(listed.sections[0], 'textStart'), false,
    'compact context discovery must not expose unusable body offsets');

  const draft = '<saved_prompt name="old one" context-update-id="reserved-one">\none\n</saved_prompt>\n\n'
    + '<saved_prompt name="old two" context-update-id="reserved-two">\ntwo\n</saved_prompt>\n\nContinue';
  insertReserved(3);
  const expandedGroup = context.get(owner.tabId).updates[0];
  assert.equal(expandedGroup.id, group.id, 'a later update of the same file keeps the wrapper identity');
  assert.deepEqual(expandedGroup.memberIds, ids);
  assert.equal(expandedGroup.title, 'visual-history.md · 4 участка · 4 строки');
  assert.equal(expandedGroup.sections[3].sourceTabs[0].tabName, 'source four');

  context.dismiss(owner.tabId, group.id, group.memberIds);
  assert.deepEqual(context.get(owner.tabId).updates[0].memberIds, ['reserved-four'],
    'a stale click must not dismiss a member the renderer had not shown yet');
  context.restoreDismissed(owner.tabId, group.id, group.memberIds);
  assert.deepEqual(context.get(owner.tabId).updates[0].memberIds, ids);

  context.dismiss(owner.tabId, expandedGroup.id, expandedGroup.memberIds);
  assert.equal(context.get(owner.tabId).updates.length, 0);
  context.restoreDismissed(owner.tabId, expandedGroup.id, expandedGroup.memberIds);
  assert.deepEqual(context.get(owner.tabId).updates[0].memberIds, ids);

  const prepared = await context.prepare(owner.tabId, 'grouped-handoff', draft);
  assert.equal((prepared.prompt.match(/context-update-id=/g) || []).length, 1);
  assert.match(prepared.prompt, new RegExp('context-update-id="' + expandedGroup.id + '"'));
  assert.doesNotMatch(prepared.prompt, /context-update-id="reserved-(?:one|two|three|four)"/);
  assert.match(prepared.prompt, /Context section 1\/4/);
  assert.match(prepared.prompt, /Context section 4\/4/);
  const handoff = context.db.prepare('SELECT update_ids FROM tab_context_handoffs WHERE tab_id=? AND handoff_id=?')
    .get(owner.tabId, 'grouped-handoff');
  assert.deepEqual(JSON.parse(handoff.update_ids), ids);
  assert.deepEqual(context.db.prepare("SELECT id,status FROM tab_context_updates WHERE tab_id=? AND id LIKE 'reserved-%' ORDER BY created_at")
    .all(owner.tabId).map((row) => [row.id, row.status]), ids.map((id) => [id, 'sending']));
});

test('an old single-file row and a newer multi-file row still project as one automatic chip', async (t) => {
  const harness = await openHarness(t, 'after one\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const otherPath = path.join(path.dirname(filePath), 'other.md');
  fs.writeFileSync(otherPath, 'after other\n');
  const insert = (id, changes, createdAt) => context.db.prepare(`INSERT INTO tab_context_updates(
    id,tab_id,title,text,kind,path,file_changes_json,status,created_at
  ) VALUES (?,?,?,?,?,?,?,'pending',?)`).run(
    id, owner.tabId, '', '', 'file-batch', changes.length === 1 ? changes[0].path : null,
    JSON.stringify(changes), createdAt,
  );
  insert('old-single', [{
    path: filePath, beforeText: 'before one\n', afterText: 'after one\n', unknownSource: true,
  }], Date.now());
  insert('new-multi', [
    { path: filePath, beforeText: 'after one\n', afterText: 'latest one\n', unknownSource: true },
    { path: otherPath, beforeText: 'before other\n', afterText: 'after other\n', unknownSource: true },
  ], Date.now() + 1);

  const updates = context.get(owner.tabId).updates;
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].memberIds, ['old-single', 'new-multi']);
  assert.equal(updates[0].title, '2 файла · 3 участка · 3 строки');
  assert.deepEqual(updates[0].sections.map((section) => section.title), [
    '1 участок · 1 строка',
    '2 файла · 2 участка · 2 строки',
  ]);
  context.dismiss(owner.tabId, updates[0].id, updates[0].memberIds);
  context.restoreDismissed(owner.tabId, updates[0].id, updates[0].memberIds);
  assert.deepEqual(context.get(owner.tabId).updates[0].memberIds, ['old-single', 'new-multi']);
  context.dismiss(owner.tabId, updates[0].id, updates[0].memberIds);
  assert.equal(context.get(owner.tabId).updates.length, 0, 'Redo can address the same exact members after restore');
});

test('a structured edit from another live tab is attributed without hiding the update', async (t) => {
  const subscriptions = [];
  const unsubscriptions = [];
  const inactive = new Set();
  const transcriptService = {
    subscribe: async (request) => {
      subscriptions.push(request);
      return { success: true };
    },
    unsubscribe: async (request) => {
      unsubscriptions.push(request.consumerId);
      return { success: true };
    },
  };
  let source;
  const harness = await openHarness(t, 'alpha\nbeta\n', {
    transcriptService,
    extraTabs: ({ dir }) => {
      source = {
        tabId: 'tab-history-worker',
        projectId: 'other-project',
        name: 'history worker',
        cwd: dir,
        tabType: 'terminal',
        commandType: 'codex',
        codexSessionId: 'session-history-worker',
      };
      return [source];
    },
    resolveAttributionSource: (tab) => inactive.has(tab.tabId) ? null : ({
      toolType: 'codex', sessionId: tab.codexSessionId,
    }),
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;
  await waitFor(() => subscriptions.length === 2, 'owner and live source were not subscribed');
  assert.deepEqual(
    new Set(subscriptions.map((request) => request.tabId)),
    new Set([owner.tabId, source.tabId]),
  );

  const after = 'alpha\nbeta\nexternal edit\n';
  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);
  assert.equal(context.get(owner.tabId).updates[0].hasUnknownSource, true);

  const args = {
    file_path: filePath,
    old_string: 'alpha\nbeta\n',
    new_string: after,
  };
  const sourceIdentity = { tabId: source.tabId, sessionId: source.codexSessionId };
  context.observeRecord(codexCall('call-external', 'Edit', args, sourceIdentity));
  context.observeRecord(codexResult('call-external', sourceIdentity));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.sourceTabId === source.tabId,
    'the external edit source was not attached to the file update',
  );
  const update = context.get(owner.tabId).updates[0];
  assert.equal(update.title, 'visual-history.md · 1 участок · 1 строка');
  assert.match(update.text, /^Sources: history worker/m);
  assert.deepEqual(update.sourceTabs.map((item) => item.tabId), [source.tabId]);
  assert.equal(update.sourceTabs[0].projectId, source.projectId);
  assert.equal(update.hasUnknownSource, false);

  context.publish(owner.tabId, {
    title: 'Ручной checkpoint',
    text: 'Состояние изменилось',
    sourceTabId: source.tabId,
  });
  const manual = context.get(owner.tabId).updates.find((item) => item.kind === 'message');
  assert.equal(manual.title, 'Ручной checkpoint');
  const prepared = await context.prepare(owner.tabId, 'handoff-with-sources', 'Продолжай работу');
  assert.match(prepared.prompt, /name="Ручной checkpoint"/);
  assert.match(prepared.prompt, /name="visual-history\.md · 1 участок · 1 строка"/);

  inactive.add(source.tabId);
  await context.syncLinks();
  assert.ok(unsubscriptions.includes('tab-work-context:' + source.tabId));
});

test('an own edit is removed from an existing external batch without hiding the external residue', async (t) => {
  const original = 'heading\nold reference\ntail\n';
  const external = 'heading\nnew reference\ntail\n';
  const own = 'own block\n' + external;
  const harness = await openHarness(t, original);
  if (!harness) return;
  const { context, filePath, owner } = harness;

  fs.writeFileSync(filePath, external);
  await context.readFile(filePath);
  assert.equal(context.get(owner.tabId).updates.length, 1);

  const args = {
    file_path: filePath,
    old_string: 'heading\n',
    new_string: 'own block\nheading\n',
  };
  context.observeRecord(codexCall('call-own-after-external', 'Edit', args));
  fs.writeFileSync(filePath, own);
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-own-after-external'));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.title.includes('1 строка'),
    'the owner edit was not subtracted from the external batch',
  );
  const update = context.get(owner.tabId).updates[0];
  assert.match(update.text, /old reference/);
  assert.match(update.text, /new reference/);
  assert.match(update.text, /^  own block$/m, 'the own line may remain only as hunk context');
  assert.doesNotMatch(update.text, /^[+-] own block$/m);
  assert.equal(update.hasUnknownSource, true);
});

test('sequential exact edits retain every participating source tab without an unknown residue', async (t) => {
  let firstSource;
  let secondSource;
  const harness = await openHarness(t, 'alpha\nbeta\ngamma\n', {
    extraTabs: ({ dir }) => {
      firstSource = {
        tabId: 'tab-source-a', projectId: 'project', name: 'source A', cwd: dir,
        tabType: 'terminal', commandType: 'codex', codexSessionId: 'session-source-a',
      };
      secondSource = {
        tabId: 'tab-source-b', projectId: 'project', name: 'source B', cwd: dir,
        tabType: 'terminal', commandType: 'codex', codexSessionId: 'session-source-b',
      };
      return [firstSource, secondSource];
    },
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;

  const firstIdentity = { tabId: firstSource.tabId, sessionId: firstSource.codexSessionId };
  context.observeRecord(codexCall('call-source-a', 'Edit', {
    file_path: filePath, old_string: 'alpha', new_string: 'ALPHA',
  }, firstIdentity));
  fs.writeFileSync(filePath, 'ALPHA\nbeta\ngamma\n');
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-source-a', firstIdentity));
  await waitFor(
    () => context.get(owner.tabId).updates[0]?.sourceTabId === firstSource.tabId,
    'first source was not attributed',
  );

  const secondIdentity = { tabId: secondSource.tabId, sessionId: secondSource.codexSessionId };
  context.observeRecord(codexCall('call-source-b', 'Edit', {
    file_path: filePath, old_string: 'gamma', new_string: 'GAMMA',
  }, secondIdentity));
  fs.writeFileSync(filePath, 'ALPHA\nbeta\nGAMMA\n');
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-source-b', secondIdentity));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.sourceTabs?.length === 2,
    'both source tabs were not retained',
  );
  const update = context.get(owner.tabId).updates[0];
  assert.match(update.title, /^visual-history\.md · \d+ участ/);
  assert.match(update.title, /2 строки$/);
  assert.match(update.text, /^Sources: source A, source B$/m);
  assert.deepEqual(update.sourceTabs.map((item) => item.tabId), [firstSource.tabId, secondSource.tabId]);
  assert.equal(update.hasUnknownSource, false);
  assert.equal(update.sourceTabId, null, 'several sources cannot collapse to one sourceTabId');
});

test('a structured Claude edit is attributed through the same file transition contract', async (t) => {
  let source;
  const harness = await openHarness(t, 'before\n', {
    extraTabs: ({ dir }) => {
      source = {
        tabId: 'tab-claude-source', projectId: 'other-project', name: 'Claude reviewer', cwd: dir,
        tabType: 'terminal', commandType: 'claude', claudeSessionId: 'session-claude-source',
      };
      return [source];
    },
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const args = { file_path: filePath, old_string: 'before', new_string: 'after' };

  context.observeRecord({
    tabId: source.tabId,
    sessionId: source.claudeSessionId,
    toolType: 'claude',
    message: {
      type: 'assistant',
      uuid: 'assistant-edit',
      message: { content: [{ type: 'tool_use', id: 'toolu-edit', name: 'Edit', input: args }] },
    },
  });
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  context.observeRecord({
    tabId: source.tabId,
    sessionId: source.claudeSessionId,
    toolType: 'claude',
    message: {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-edit', content: 'ok' }] },
    },
  });

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.sourceTabId === source.tabId,
    'Claude source was not attributed',
  );
  assert.equal(context.get(owner.tabId).updates[0].sourceTabs[0].tabName, 'Claude reviewer');
});

for (const scenario of [
  {
    name: 'Edit',
    before: 'alpha\nbeta\n',
    after: 'alpha\nbeta\nself edit\n',
    args: (filePath) => ({
      file_path: filePath,
      old_string: 'alpha\nbeta\n',
      new_string: 'alpha\nbeta\nself edit\n',
    }),
  },
  {
    name: 'MultiEdit',
    before: 'alpha\nbeta\n',
    after: 'ALPHA\nBETA\n',
    args: (filePath) => ({
      file_path: filePath,
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'beta', new_string: 'BETA' },
      ],
    }),
  },
  {
    name: 'Write',
    before: 'old body\n',
    after: 'new body\n',
    args: (filePath) => ({ file_path: filePath, content: 'new body\n' }),
  },
]) {
  test(`a linked file ${scenario.name} by its own Codex tab removes the watcher chip`, async (t) => {
    const harness = await openHarness(t, scenario.before);
    if (!harness) return;
    const { context, filePath, owner } = harness;
    const args = scenario.args(filePath);
    const callId = `call-${scenario.name.toLowerCase()}`;

    // Production order: fs.watch can publish A->B before the transcript service
    // reaches the already-written call/result records.
    fs.writeFileSync(filePath, scenario.after);
    await context.readFile(filePath);
    assert.equal(context.get(owner.tabId).updates.length, 1, 'watcher first exposes the change');

    context.observeRecord(codexCall(callId, scenario.name, args));
    context.observeRecord(codexResult(callId));

    await waitFor(
      () => context.get(owner.tabId).updates.length === 0,
      `${scenario.name} result did not reconcile its own linked-file update`,
    );
  });
}

test('a linked file apply_patch by its own Codex tab removes the watcher chip', async (t) => {
  const before = 'alpha\nbeta\n';
  const after = 'ALPHA\nbeta\n';
  const harness = await openHarness(t, before);
  if (!harness) return;
  const { context, filePath, owner } = harness;

  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);
  assert.equal(context.get(owner.tabId).updates.length, 1, 'watcher first exposes the change');

  context.observeRecord({
    tabId: owner.tabId,
    sessionId: owner.codexSessionId,
    toolType: 'codex',
    message: {
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call-patch',
        success: true,
        changes: {
          [filePath]: {
            type: 'update',
            unified_diff: '@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n beta\n',
          },
        },
      },
    },
  });

  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'apply_patch event did not reconcile its own linked-file update',
  );
});

test('an own pathlib write removes only the file transition inside its successful Bash operation', async (t) => {
  const before = 'alpha\nbeta\n';
  const after = 'alpha\nbeta\npython edit\n';
  const harness = await openHarness(t, before);
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path('${filePath}')\ns=p.read_text()\np.write_text(s + 'python edit\\n')\nPY`;
  const execSource = 'const r = await tools.exec_command('
    + JSON.stringify({ cmd: command }) + '); text(r.output);';
  const startedAt = Date.now();

  context.observeRecord(codexCall('call-python-own', 'exec', { input: execSource }, {
    timestamp: new Date(startedAt).toISOString(),
  }));
  assert.equal(context.shellEdits.size, 1, 'the Python call must reserve one shell-edit proof');
  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);
  assert.equal(context.fileTransitions.size, 1, 'the watcher transition must remain available for the result');
  assert.equal(context.get(owner.tabId).updates.length, 1, 'watcher exposes the change until success');
  const completedAt = Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2);
  context.observeRecord(codexResult('call-python-own', {
    timestamp: new Date(completedAt).toISOString(),
    output: '{"exit_code":0}',
  }));

  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'successful own Python write did not remove its linked-file update',
  );
});

test('a pathlib write from another tab attributes the exact file transition to that tab', async (t) => {
  let source;
  const harness = await openHarness(t, 'before\n', {
    extraTabs: ({ dir }) => {
      source = {
        tabId: 'tab-python-source', projectId: 'other-project', name: 'Python worker', cwd: dir,
        tabType: 'terminal', commandType: 'codex', codexSessionId: 'session-python-source',
      };
      return [source];
    },
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path('${filePath}')\np.write_text('after\\n')\nPY`;
  const identity = {
    tabId: source.tabId,
    sessionId: source.codexSessionId,
    timestamp: new Date(Date.now()).toISOString(),
  };

  context.observeRecord(codexCall('call-python-foreign', 'Bash', { command }, identity));
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-python-foreign', {
    ...identity,
    timestamp: new Date(Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2)).toISOString(),
    output: '{"exit_code":0}',
  }));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.sourceTabId === source.tabId,
    'Python source tab was not attached to the file transition',
  );
  const update = context.get(owner.tabId).updates[0];
  assert.match(update.text, /^Sources: Python worker$/m);
  assert.equal(update.hasUnknownSource, false);
});

test('Claude Bash pathlib writes use the same own-transition proof', async (t) => {
  const harness = await openHarness(t, 'before\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const command = `python3 - <<'PY'\nfrom pathlib import Path\nPath('${filePath}').write_text('after\\n')\nPY`;
  const startedAt = Date.now();
  context.observeRecord({
    tabId: owner.tabId,
    sessionId: 'claude-owner-session',
    toolType: 'claude',
    message: {
      type: 'assistant',
      timestamp: new Date(startedAt).toISOString(),
      uuid: 'assistant-python-edit',
      message: { content: [{ type: 'tool_use', id: 'toolu-python-edit', name: 'Bash', input: { command } }] },
    },
  });
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  context.observeRecord({
    tabId: owner.tabId,
    sessionId: 'claude-owner-session',
    toolType: 'claude',
    message: {
      type: 'user',
      timestamp: new Date(Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2)).toISOString(),
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu-python-edit', content: 'ok' }],
      },
    },
  });

  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'Claude own Python write did not remove its linked-file update',
  );
});

test('a failed or late Python operation cannot claim an unknown file transition', async (t) => {
  const harness = await openHarness(t, 'before\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path('${filePath}')\np.write_text('after\\n')\nPY`;
  const startedAt = Date.now();
  context.observeRecord(codexCall('call-python-failed', 'Bash', { command }, {
    timestamp: new Date(startedAt).toISOString(),
  }));
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-python-failed', {
    timestamp: new Date(Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2)).toISOString(),
    output: '{"exit_code":1}',
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.get(owner.tabId).updates[0]?.hasUnknownSource, true);

  fs.writeFileSync(filePath, 'later\n');
  await context.readFile(filePath);
  const lateStartedAt = fs.statSync(filePath).mtimeMs + 10_000;
  context.observeRecord(codexCall('call-python-late', 'Bash', { command }, {
    timestamp: new Date(lateStartedAt).toISOString(),
  }));
  context.observeRecord(codexResult('call-python-late', {
    timestamp: new Date(lateStartedAt + 10).toISOString(),
    output: '{"exit_code":0}',
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.get(owner.tabId).updates[0]?.hasUnknownSource, true,
    'a replayed operation after the physical write must not claim it');
});

test('two overlapping Python operations leave one transition unattributed instead of guessing', async (t) => {
  const harness = await openHarness(t, 'before\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  const command = `python3 - <<'PY'\nfrom pathlib import Path\nPath('${filePath}').write_text('after\\n')\nPY`;
  const startedAt = Date.now();
  for (const callId of ['call-python-a', 'call-python-b']) {
    context.observeRecord(codexCall(callId, 'Bash', { command }, {
      timestamp: new Date(startedAt).toISOString(),
    }));
  }
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  const completedAt = Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2);
  for (const callId of ['call-python-a', 'call-python-b']) {
    context.observeRecord(codexResult(callId, {
      timestamp: new Date(completedAt).toISOString(),
      output: '{"exit_code":0}',
    }));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.get(owner.tabId).updates[0]?.hasUnknownSource, true);
});

test('an own Python suffix is removed while an earlier external prefix remains visible', async (t) => {
  const harness = await openHarness(t, 'original\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  fs.writeFileSync(filePath, 'external\n');
  await context.readFile(filePath);
  const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path('${filePath}')\np.write_text(p.read_text() + 'own\\n')\nPY`;
  context.observeRecord(codexCall('call-python-after-external', 'Bash', { command }, {
    timestamp: new Date(Date.now()).toISOString(),
  }));
  fs.writeFileSync(filePath, 'external\nown\n');
  await context.readFile(filePath);
  context.observeRecord(codexResult('call-python-after-external', {
    timestamp: new Date(Math.max(Date.now(), fs.statSync(filePath).mtimeMs + 2)).toISOString(),
    output: '{"exit_code":0}',
  }));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.title.includes('1 строка'),
    'the own Python suffix was not removed from the external batch',
  );
  const update = context.get(owner.tabId).updates[0];
  assert.match(update.text, /original/);
  assert.match(update.text, /external/);
  assert.doesNotMatch(update.text, /^[+-] own$/m);
  assert.equal(update.hasUnknownSource, true);
});

test('a successful owner Read clears only the linked-file changes it proves current', async (t) => {
  const before = 'one\nold two\nthree\nfour\nfive\nsix\nseven\nold eight\nnine\n';
  const after = 'one\nnew two\nthree\nfour\nfive\nsix\nseven\nnew eight\nnine\n';
  const harness = await openHarness(t, before);
  if (!harness) return;
  const { context, filePath, owner } = harness;
  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);
  const timestamp = new Date(Date.now() + 1000).toISOString();

  context.observeRecord(codexCall('call-read-part', 'Read', {
    file_path: filePath,
    offset: 1,
    limit: 4,
  }, { timestamp }));
  context.observeRecord(codexResult('call-read-part', {
    timestamp,
    output: '     1\u2192one\n     2\u2192new two\n     3\u2192three\n     4\u2192four',
  }));

  await waitFor(
    () => context.get(owner.tabId).updates[0]?.title.endsWith('1 строка'),
    'the proven Read range did not shrink the pending update',
  );
  const partial = context.get(owner.tabId).updates[0];
  assert.doesNotMatch(partial.text, /^[+-] (?:old|new) two$/m);
  assert.match(partial.text, /^- old eight$/m);
  assert.match(partial.text, /^\+ new eight$/m);

  const afterSecondChange = after.replace('\nfive\n', '\nFIVE\n');
  fs.writeFileSync(filePath, afterSecondChange);
  await context.readFile(filePath);
  const merged = context.get(owner.tabId).updates[0];
  assert.match(merged.title, /2 строки$/);
  assert.doesNotMatch(merged.text, /^[+-] (?:old|new) two$/m,
    'an acknowledged line must not return when a later change is merged');
  assert.match(merged.text, /^- five$/m);
  assert.match(merged.text, /^\+ FIVE$/m);

  context.observeRecord(codexCall('call-read-full', 'Read', { file_path: filePath }, { timestamp }));
  context.observeRecord(codexResult('call-read-full', { timestamp, output: afterSecondChange }));
  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'a full exact Read did not clear the remaining update',
  );
});

test('owner Read can monotonically acknowledge an update reserved by an older handoff', async (t) => {
  const harness = await openHarness(t, 'before\n');
  if (!harness) return;
  const { context, filePath, owner } = harness;
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  const logical = context.get(owner.tabId).updates[0];
  const [memberId] = logical.memberIds;
  context.db.prepare(`INSERT INTO tab_context_handoffs(
    tab_id,handoff_id,base_hash,prefix,prepared_prompt,payload_hash,update_ids,status,created_at
  ) VALUES (?,?,?,?,?,?,?,'failed',?)`).run(
    owner.tabId, 'reserved-read-handoff', 'base', '', 'immutable old payload',
    'payload', JSON.stringify([memberId]), Date.now(),
  );
  const timestamp = new Date(Date.now() + 1000).toISOString();
  context.observeRecord(codexCall('call-reserved-read', 'Read', { file_path: filePath }, { timestamp }));
  context.observeRecord(codexResult('call-reserved-read', { timestamp, output: 'after\n' }));

  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'the reserved update remained visible after an exact owner Read',
  );
  assert.equal(context.db.prepare('SELECT prepared_prompt FROM tab_context_handoffs WHERE handoff_id=?')
    .get('reserved-read-handoff').prepared_prompt, 'immutable old payload');
});

test('an old or failed Read cannot acknowledge a newer linked-file update', async (t) => {
  const before = 'before\n';
  const after = 'after\n';
  const harness = await openHarness(t, before);
  if (!harness) return;
  const { context, filePath, owner } = harness;
  fs.writeFileSync(filePath, after);
  await context.readFile(filePath);

  const oldTimestamp = '2000-01-01T00:00:00.000Z';
  context.observeRecord(codexCall('call-old-read', 'Read', { file_path: filePath }, { timestamp: oldTimestamp }));
  context.observeRecord(codexResult('call-old-read', { timestamp: oldTimestamp, output: after }));
  context.observeRecord(codexCall('call-failed-read', 'Read', { file_path: filePath }, {
    timestamp: new Date(Date.now() + 1000).toISOString(),
  }));
  context.observeRecord(codexResult('call-failed-read', {
    timestamp: new Date(Date.now() + 1000).toISOString(),
    output: after,
    isError: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(context.get(owner.tabId).updates.length, 1);
  assert.match(context.get(owner.tabId).updates[0].text, /^- before$/m);
  assert.match(context.get(owner.tabId).updates[0].text, /^\+ after$/m);
});

test('reading from the writer tab does not acknowledge the owner tab update', async (t) => {
  let writer;
  const harness = await openHarness(t, 'before\n', {
    extraTabs: ({ dir }) => {
      writer = {
        tabId: 'tab-writer', projectId: 'project', name: 'writer', cwd: dir,
        tabType: 'terminal', commandType: 'codex', codexSessionId: 'session-writer',
      };
      return [writer];
    },
  });
  if (!harness) return;
  const { context, filePath, owner } = harness;
  fs.writeFileSync(filePath, 'after\n');
  await context.readFile(filePath);
  const timestamp = new Date(Date.now() + 1000).toISOString();

  context.observeRecord(codexCall('call-writer-read', 'Read', { file_path: filePath }, {
    tabId: writer.tabId, sessionId: writer.codexSessionId, timestamp,
  }));
  context.observeRecord(codexResult('call-writer-read', {
    tabId: writer.tabId, sessionId: writer.codexSessionId, timestamp, output: 'after\n',
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(context.get(owner.tabId).updates.length, 1);

  context.observeRecord(codexCall('call-owner-read', 'Read', { file_path: filePath }, { timestamp }));
  context.observeRecord(codexResult('call-owner-read', { timestamp, output: 'after\n' }));
  await waitFor(
    () => context.get(owner.tabId).updates.length === 0,
    'the owner read did not acknowledge its own pending update',
  );
});

test('dismissed context updates can be restored, while slash commands leave them pending', async (t) => {
  const harness = await openHarness(t, 'context\n');
  if (!harness) return;
  const { context, owner } = harness;
  const published = context.publish(owner.tabId, {
    title: 'Deferred state',
    text: 'Read this on the next real prompt',
    requestId: 'restore-fixture',
  });

  context.dismiss(owner.tabId, published.updateId);
  assert.equal(context.get(owner.tabId).updates.length, 0);
  context.restoreDismissed(owner.tabId, published.updateId);
  assert.equal(context.get(owner.tabId).updates.length, 1);

  const prepared = await context.prepare(owner.tabId, 'slash-handoff', '/compact');
  assert.equal(prepared.prompt, '/compact');
  assert.equal(prepared.prefix, '');
  assert.equal(context.get(owner.tabId).updates[0].status, 'pending');
});
