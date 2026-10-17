'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');
const { inspectCodexNativeQuestions, createCodexNativeQuestionMirror } = require('./codex-native-question-mirror');

const title = 'В эпизоде 14:15 ты копировал выделенный текст через Cmd+C/пункт «Копировать» или нажимал кнопку копирования целого сообщения?';
const options = ['Выделенный текст — Cmd+C/меню', 'Кнопка копирования сообщения'];
const normalize = text => text.replace(/\s+/g, ' ').trim();
async function nativeChoiceFrame(t, { ctrl = '^]', marker = '>', selected = 0, seq = 10,
  committed = true, mainPrompt = false, free = false, dimTitle = false,
  prefixRows = [], afterOptions = [], cursorBeforeFooter = false, otherText = 'Other',
  questionTitle = title, optionLabels = options, selectedStyle = '\x1b[1;30;47m', progress = '',
  titleStyle = '\x1b[1;38;2;99;168;248m', collapsed = false } = {}) {
  const term = new Terminal({ cols: 86, rows: 24, allowProposedApi: true });
  t.after(() => term.dispose());
  const rows = [
    ...prefixRows, 'Working (24m 15s • esc to interrupt)', '', '• Queued follow-up inputs', '',
    ...(progress ? [progress] : []),
    '  ' + titleStyle + questionTitle + '\x1b[0m', '',
    ...(free ? ['  \x1b[2mType your answer\x1b[0m'] : [...optionLabels, otherText].map((label, index) =>
      (selected === index ? selectedStyle : '') + '  ' + (selected === index ? marker : ' ')
      + ' ' + (index + 1) + '. ' + label + '\x1b[0m')),
    '', ...afterOptions, '  enter submit   ' + ctrl + ' skip   ⇧→ ' + (progress ? 'prev question' : 'main prompt'),
    ...(mainPrompt ? ['', '› actual main composer'] : []),
  ];
  if (collapsed) rows.splice(0, rows.length, ...Array(18).fill(''), '• Queued follow-up inputs', '',
    '  \x1b[2m? \x1b[0m1\x1b[2m question · 15s\x1b[0m',
    '    \x1b[2m⇧← to answer\x1b[0m', '', '› Ask Codex to do anything');
  if (dimTitle) rows[prefixRows.length + 4 + Number(!!progress)] = '  \x1b[2m' + questionTitle + '\x1b[0m';
  await new Promise(resolve => term.write(rows.join('\r\n'), resolve));
  const b = term.buffer.active;
  if (cursorBeforeFooter) {
    const footer = Array.from({ length: term.rows }, (_, i) => b.getLine(b.baseY + i).translateToString(true))
      .findIndex(line => line.includes('enter submit'));
    assert.ok(footer > 0 && b.baseY === 0, 'controlled fixture keeps the entire question visible');
    await new Promise(resolve => term.write(`\x1b[${footer};3H`, resolve));
  }
  const lines = Array.from({ length: 24 }, (_, i) => {
    const line = b.getLine(b.baseY + i);
    const cells = [];
    for (let x = 0; x < line.length; x++) { const cell = line.getCell(x);
      if (cell.getWidth() && cell.getChars().trim()) cells.push(cell); }
    const first = cells[0];
    return { row: b.baseY + i, text: line.translateToString(true), wrapped: line.isWrapped,
      hasNonDefaultBg: cells.some(c => c.getBgColorMode() !== 0),
      hasNonDefaultFg: cells.some(c => c.getFgColorMode() !== 0),
      hasInverse: cells.some(c => !!c.isInverse()),
      hasDim: cells.some(c => !!c.isDim()), allTextDim: !!cells.length && cells.every(c => !!c.isDim()),
      firstTextStyle: first ? `fg=${first.getFgColorMode()}:${first.getFgColor()},bg=${first.getBgColorMode()}:${first.getBgColor()}`
        + (first.isBold() ? ',bold' : '') + (first.isDim() ? ',dim' : '') : 'none' };
  });
  const editor = lines.findIndex(row => row.text.includes('Type your answer'));
  return { success: true, source: 'headless-main', authoritativeFrameCommitted: committed,
    baseY: b.baseY, cursorY: free ? editor : b.cursorY, lines, writeSeq: seq, flushedSeq: seq };
}

for (const free of [false, true]) test('headless: default-colour bold question in the native section / free=' + free, async t => {
  const f = await nativeChoiceFrame(t, { free, titleStyle: '\x1b[1m' });
  const titleRows = f.lines.filter(row => /(?:^|,)bold(?:,|$)/.test(row.firstTextStyle)
    && !/^\s*[>›❯]?\s*\d+\./u.test(row.text));
  assert.ok(titleRows.length >= 2, 'actual long title wrapped across real terminal cells');
  assert.ok(titleRows.every(row => !row.hasNonDefaultBg && !row.hasNonDefaultFg));
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded'); assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices.map(c => c.label), free ? [] : [...options, 'Other']);
  assert.equal(r.draft, '');
});

test('headless: default-colour prose without bold is not a native question title', async t => {
  const f = await nativeChoiceFrame(t, { titleStyle: '\x1b[0m' });
  assert.equal(inspectCodexNativeQuestions(f).kind, 'unknown');
});

test('headless: default bold transcript cannot substitute for a current native section or painted choice', async t => {
  const noSection = await nativeChoiceFrame(t, { titleStyle: '\x1b[1m' });
  noSection.lines = noSection.lines.filter(row => !row.text.includes('Queued follow-up inputs'));
  assert.equal(inspectCodexNativeQuestions(noSection).kind, 'unknown');
  const noSelection = await nativeChoiceFrame(t, { titleStyle: '\x1b[1m', selectedStyle: '' });
  const r = inspectCodexNativeQuestions(noSelection);
  assert.equal(r.kind, 'unknown'); assert.equal(r.reason, 'native-question-selection-unproven');
});

for (const free of [false, true]) test('controller: one open recognizes a fresh default-bold frame without retry / free=' + free, async t => {
  let f = await nativeChoiceFrame(t, { collapsed: true });
  const expanded = await nativeChoiceFrame(t, { free, titleStyle: '\x1b[1m', seq: 11 });
  const callbacks = new Set(), writes = [], logs = [];
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => f,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: (_id, cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    withWriter: (_id, work) => work({ abortReason: () => null, write(bytes) {
      writes.push(bytes); f = expanded; for (const cb of callbacks) cb();
    } }), publish() {}, log: (...args) => logs.push(args) });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'native-call', questions: [{ title, ...(free ? {} : { options }) }] } });
  const before = mirror.get('T'); assert.equal(before.expanded, false);
  const r = await mirror.control('T', { action: 'open', targetId: before.targetId, requestId: 'one-open' });
  assert.equal(r.success, true); assert.equal(r.state.title, title);
  assert.deepEqual(r.state.options, free ? [] : options);
  assert.deepEqual(writes, ['\x1b[1;2D']); assert.equal(callbacks.size, 0);
  const frameResult = logs.find(([action]) => action === 'frame-result')[2];
  assert.equal(frameResult.titleStyle, 'default-bold'); assert.equal(frameResult.ready, true);
});

// Real xterm cells with a controlled layout/transport: this is not a capture
// of the old production frame or a native Codex/provider E2E.
for (const selected of [0, 2]) test('headless: bold metadata below native choices cannot replace the title / selected=' + selected, async t => {
  const otherText = selected === 2 ? 'A custom answer' : 'Other';
  const f = await nativeChoiceFrame(t, { selected, otherText, cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] });
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded');
  assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices.map(c => c.label), [...options, otherText]);
  assert.equal(r.optionIndex, selected);
  assert.equal(r.draft, selected === 2 ? otherText : '');
});

test('headless: inverse selection anchors the question without a painted background', async t => {
  const f = await nativeChoiceFrame(t, { selectedStyle: '\x1b[7m', cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] });
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded'); assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices.map(c => c.label), [...options, 'Other']);
});

test('headless: multi-question progress also anchors the list when its summary header is cropped', async t => {
  const f = await nativeChoiceFrame(t, { progress: '  2 of 3', cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] });
  f.lines = f.lines.filter(row => !row.text.includes('Queued follow-up inputs'));
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded'); assert.equal(r.count, 3); assert.equal(r.current, 1);
  assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices.map(c => c.label), [...options, 'Other']);
});

test('headless: previous styled numbered transcript does not anchor a current free question', async t => {
  const f = await nativeChoiceFrame(t, { free: true, prefixRows: [
    '  \x1b[1;38;2;99;168;248mPrevious question\x1b[0m', '',
    '  \x1b[1;30;47m> 1. Previous option\x1b[0m', '    2. Other', '',
  ] });
  const r = inspectCodexNativeQuestions(f);
  assert.equal(r.kind, 'expanded');
  assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices, []);
  assert.equal(r.draft, '');
});

test('headless: a metadata-like actual question title is not blacklisted', async t => {
  const questionTitle = 'call_id: synthetic.';
  const r = inspectCodexNativeQuestions(await nativeChoiceFrame(t, { questionTitle }));
  assert.equal(r.kind, 'expanded');
  assert.equal(r.title, questionTitle);
  assert.deepEqual(r.choices.map(c => c.label), [...options, 'Other']);
});

test('headless: a blank paragraph inside an indented option still belongs to that option', async t => {
  const r = inspectCodexNativeQuestions(await nativeChoiceFrame(t, {
    optionLabels: ['First paragraph\r\n\r\n       Continued paragraph', options[1]],
  }));
  assert.equal(r.kind, 'expanded'); assert.equal(normalize(r.title), title);
  assert.deepEqual(r.choices.map(c => c.label), ['First paragraph Continued paragraph', options[1], 'Other']);
});

test('headless: trailing bold text cannot supply a missing native question title', async t => {
  const f = await nativeChoiceFrame(t, { dimTitle: true, cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] });
  assert.equal(inspectCodexNativeQuestions(f).kind, 'unknown');
});

test('mirror: exact accepted definition survives the title anchor and native Skip clears only this question', async t => {
  let f = await nativeChoiceFrame(t, { cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] });
  const none = await nativeChoiceFrame(t, { mainPrompt: true, seq: 101 });
  const callbacks = new Set(), writes = [], logs = [], published = [];
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => f,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: (_id, cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    withWriter: (_id, work) => work({ abortReason: () => null, write(bytes) {
      writes.push(bytes); f = none; for (const cb of callbacks) cb();
    } }), publish: (_id, q) => published.push(q), log: (...args) => logs.push(args) });
  mirror.observeRecord('T', { type: 'response_item', payload: { type: 'function_call',
    name: 'request_user_input_async', call_id: 'exact-call', arguments: JSON.stringify({ questions: [{ title, options }] }) } });
  assert.equal(mirror.get('T').questionId, null, 'unaccepted definitions never acquire the link');
  mirror.observeRecord('T', { type: 'response_item', payload: { type: 'function_call_output',
    call_id: 'exact-call', output: '{"accepted":true}' } });
  const q = mirror.get('T');
  assert.equal(q.title, title);
  assert.deepEqual(q.options, options);
  assert.equal(q.questionId, JSON.stringify(['request_user_input_async', 'exact-call', 0]));
  const logCount = logs.length, publicationCount = published.length;
  const lastPublished = published.at(-1);
  assert.deepEqual(mirror.get('T'), q);
  f = { ...f, writeSeq: 99, flushedSeq: 99 };
  mirror.observeFrame('T', f);
  assert.equal(logs.length, logCount, 'same target/new frame does not repeat diagnostics');
  assert.equal(published.length, publicationCount, 'same-valued scoped snapshot is retained');
  assert.strictEqual(published.at(-1), lastPublished);
  const match = logs.filter(([action]) => action === 'title-frame').at(-1)[2];
  assert.equal(match.matched, true); assert.equal(match.nativeChoices, 3);
  assert.equal(match.titleHash, match.definitionTitleHash);
  assert.equal(match.titleChars, title.length);
  assert.ok(!JSON.stringify(logs).includes(title));
  assert.ok(!JSON.stringify(logs).includes(options[0]));
  const r = await mirror.control('T', { action: 'skip', requestId: 'skip-one', targetId: q.targetId });
  assert.equal(r.success, true); assert.equal(r.handledLocally, true); assert.equal(r.providerConfirmed, null);
  assert.deepEqual(writes, [String.fromCharCode(29)]);
  assert.equal(mirror.get('T'), null); assert.equal(callbacks.size, 0);
});

test('mirror: an unrelated sole definition never fills a different native question', async t => {
  const f = await nativeChoiceFrame(t), logs = [];
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => f,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: () => () => {}, withWriter: () => { throw new Error('no input expected'); },
    publish() {}, log: (...args) => logs.push(args) });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'foreign-title-call', questions: [{ title: 'A different question', options: ['Not this option'] }] } });
  const q = mirror.get('T');
  assert.equal(q.title, title); assert.equal(q.questionId, null); assert.deepEqual(q.options, []);
  const match = logs.filter(([action]) => action === 'title-frame').at(-1)[2];
  assert.equal(match.matched, false); assert.equal(match.definitions, 1);
  assert.notEqual(match.titleHash, match.definitionTitleHash);
});

for (const ctrl of ['^]', '⌃]', 'ctrl+]']) test('actual headless: wrapped FG-only title and selected native choice / ' + ctrl, async t => {
  const frame = await nativeChoiceFrame(t, { ctrl });
  const r = inspectCodexNativeQuestions(frame);
  assert.equal(r.kind, 'expanded');
  assert.equal(normalize(r.title), title);
  assert.equal(r.optionIndex, 0); assert.equal(r.optionCount, 3);
  assert.deepEqual(r.choices.map(c => c.label), [...options, 'Other']);
});

test('uncommitted/cropped/quoted or non-accent panels remain non-actionable', async t => {
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { committed: false })).kind, 'unknown');
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { mainPrompt: true })).kind, 'none');
  assert.equal(inspectCodexNativeQuestions(await nativeChoiceFrame(t, { dimTitle: true })).kind, 'unknown');
  const f = await nativeChoiceFrame(t); f.lines = f.lines.filter(row => !row.text.includes('skip'));
  assert.notEqual(inspectCodexNativeQuestions(f).kind, 'expanded');
});

for (const tail of [false, true]) test('native choice answer moves selection and presses Enter, without writing Other or pasted text / trailing fragment=' + tail, async t => {
  const extra = tail ? { cursorBeforeFooter: true,
    afterOptions: ['  \x1b[1;38;2;99;168;248mcall_id: synthetic.\x1b[0m', ''] } : {};
  let frame = await nativeChoiceFrame(t, extra);
  const first = frame, second = await nativeChoiceFrame(t, { ...extra, selected: 1, seq: 11 });
  const none = await nativeChoiceFrame(t, { mainPrompt: true, seq: 12 });
  const callbacks = new Set(), writes = [];
  const emit = next => { frame = next; for (const cb of callbacks) cb(); };
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => frame,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: (_id, cb) => { callbacks.add(cb); return () => callbacks.delete(cb); },
    withWriter: (_id, work) => work({ abortReason: () => null, write(bytes) {
      writes.push(bytes);
      if (bytes === '\x1b[B') emit(second);
      else if (bytes === '\r') emit(none);
      else { emit(first); throw new Error('unexpected native input'); }
    } }), publish() {}, log() {} });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'native-call', questions: [{ title, options }] } });
  const q = mirror.get('T'); assert.ok(q?.expanded);
  const result = await mirror.control('T', { action: 'answer', requestId: 'choice-R', targetId: q.targetId,
    answer: options[1], optionIndex: 1, baseDraft: '' });
  assert.equal(result.success, true); assert.deepEqual(writes, ['\x1b[B', '\r']);
  assert.equal(callbacks.size, 0);
});

test('chosen item must match its exact known question definition before any write', async t => {
  const frame = await nativeChoiceFrame(t), writes = [];
  const mirror = createCodexNativeQuestionMirror({ readFrame: () => frame,
    readOwner: () => ({ key: 'exact-T', sessionId: 'SID', lifecycleGeneration: 'L' }),
    subscribeFrames: () => () => {}, withWriter: (_id, work) => work({ abortReason: () => null, write: x => writes.push(x) }),
    publish() {}, log() {} });
  mirror.observeRecord('T', { type: 'event_msg', payload: { type: 'agent_message', delivery: 'async',
    id: 'native-call', questions: [{ title, options }] } });
  const q = mirror.get('T'); assert.ok(q?.expanded);
  const r = await mirror.control('T', { action: 'answer', requestId: 'wrong-choice', targetId: q.targetId,
    answer: 'not this option', optionIndex: 1, baseDraft: '' });
  assert.equal(r.success, false); assert.equal(r.error, 'question_option_changed'); assert.deepEqual(writes, []);
});

test('real headless free editor keeps its wrapped accent title and empty draft', async t => {
  const r = inspectCodexNativeQuestions(await nativeChoiceFrame(t, { free: true, ctrl: '⌃]' }));
  assert.equal(r.kind, 'expanded'); assert.equal(normalize(r.title), title);
  assert.equal(r.draft, ''); assert.deepEqual(r.choices, []);
});
