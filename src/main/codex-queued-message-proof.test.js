'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  captureCodexQueuedMessageBaseline,
  classifyCodexQueuedMessageFrame,
  codexQueuedMessageMatchesAudit,
} = require('./codex-queued-message-proof');

const status = {
  firstTextStyle: 'fg=1:8,bg=0:-1,dim',
  hasDim: true,
  allTextDim: true,
  hasNonDefaultFg: true,
};
const line = (row, text, extra = {}) => ({ row, text, wrapped: false, ...extra });
const snapshot = ({ frame = 10, messages = [], mirror = 'mirror-a' } = {}) => ({
  success: true,
  authoritativeFrameCommitted: true,
  mirrorGeneration: mirror,
  committedFrameGeneration: frame,
  writeSeq: frame * 2,
  preViewportLines: [],
  lines: [
    line(1, '• Messages to be submitted after next tool call', status),
    line(2, '  (press esc to interrupt and send immediately)', status),
    ...messages.map((text, index) => line(3 + index, `  ↳ ${text}`, status)),
    line(3 + messages.length, ''),
    line(4 + messages.length, '› Ask Codex to do anything'),
  ],
});
const identity = {
  mirrorGeneration: 'mirror-a',
  sameTerminal: true,
  runSeq: 7,
  lifecycleGeneration: 'life-a',
  inputRevision: 12,
  writeQueueOwned: true,
};

test('a committed post-Enter queue count increase proves the exact busy send', () => {
  const audit = {
    expectedText: 'queued prompt',
    queuedAtSubmit: true,
    submitWritten: true,
    enterRunSeq: 7,
    enterLifecycleGeneration: 'life-a',
    enterInputRevision: 12,
  };
  const baseline = captureCodexQueuedMessageBaseline(snapshot({
    frame: 10,
    messages: ['older prompt'],
  }), audit);
  const result = classifyCodexQueuedMessageFrame({
    baseline,
    snapshot: snapshot({ frame: 11, messages: ['older prompt', 'queued prompt'] }),
    audit,
    identity,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'codex_tui_queue_exact');
  assert.match(result.sourceIdentity, /^codex-tui-queue:mirror-a:7:12:11:1:/);
});

test('image path transport matches the numbered image slot painted by Codex', () => {
  const imagePath = '/tmp/provider-owned-image.png';
  const audit = {
    expectedText: `${imagePath} это ты написал?`,
    expectedImagePaths: [imagePath],
  };
  assert.deepEqual(
    codexQueuedMessageMatchesAudit(audit, '[Image #1] это ты написал?'),
    { reason: 'codex_image_placeholder_canonical' },
  );
});

test('clipped native preview proves only queue admission with the same causal guards', () => {
  const audit = { expectedText: 'long message with hidden ending', queuedAtSubmit: true,
    submitWritten: true, enterRunSeq: 7, enterLifecycleGeneration: 'life-a', enterInputRevision: 12 };
  const baseline = captureCodexQueuedMessageBaseline(snapshot(), audit);
  const after = snapshot({ frame: 11, messages: ['long message…'] });
  const result = classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit, identity });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'codex_tui_queue_visible_prefix');
  assert.notEqual(result.text, audit.expectedText, 'this does not claim full-text audit success');
  assert.equal(codexQueuedMessageMatchesAudit(audit, 'wrong message…', { truncated: true, styleEvidence: true }), null);
  assert.equal(codexQueuedMessageMatchesAudit(audit, 'long message…', { truncated: true }), null);
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit,
    identity: { ...identity, inputRevision: 13 } }).accepted, false);
});

test('resize of an old nonmatching message cannot masquerade as a newly queued prefix', () => {
  const audit = { expectedText: 'same prefix new message', queuedAtSubmit: true,
    submitWritten: true, enterRunSeq: 7, enterLifecycleGeneration: 'life-a', enterInputRevision: 12 };
  const baseline = captureCodexQueuedMessageBaseline(snapshot({ messages: ['same prefix old message'] }), audit);
  const after = snapshot({ frame: 11, messages: ['same prefix…'] });
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit, identity }).accepted, false);
  const added = snapshot({ frame: 12, messages: ['same prefix…', 'same prefix…'] });
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: added, audit, identity }).accepted, true);
});

test('clipped queue matching handles image slots and whitespace as presentation, not a durable ACK', () => {
  const audit = { expectedText: '/tmp/img.png  line one\n    line two\nremaining', expectedImagePaths: ['/tmp/img.png'] };
  assert.equal(codexQueuedMessageMatchesAudit(audit, '[Image #1] line one line two …',
    { truncated: true, styleEvidence: true }).reason, 'codex_tui_queue_visible_prefix');
  assert.equal(codexQueuedMessageMatchesAudit({ expectedText: 'literal …' }, 'literal …',
    { truncated: true, styleEvidence: true }).reason, 'codex_tui_queue_exact');
});

test('production queue: a token split by explicit TUI rows is not an inserted space', () => {
  const audit = { expectedText: 'project-terminal-tab-4553 /tmp/img.png В этой вкладке что? Почему тут после build install ещё текст',
    expectedImagePaths: ['/tmp/img.png'], queuedAtSubmit: true, submitWritten: true,
    enterRunSeq: 7, enterLifecycleGeneration: 'life-a', enterInputRevision: 12 };
  const baseline = captureCodexQueuedMessageBaseline(snapshot(), audit);
  const after = snapshot({ frame: 11 });
  after.lines.splice(2, 0,
    line(3, '  ↳ project-terminal-tab-', status),
    line(4, '    4553 [Image #1]   В этой вкладке что? Почему тут после', status),
    line(5, '    build install', status), line(6, '    …', status));
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit, identity }).accepted, true);
  const bad = structuredClone(after);
  bad.lines[3].text = '    4553 [Image #1]   Вэтой вкладке что? Почему тут после';
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: bad, audit, identity }).accepted, false,
    'spaces inside a physical row are not optional');
  assert.equal(codexQueuedMessageMatchesAudit(audit, 'project-terminal-tab- 4553 …',
    { truncated: true, styleEvidence: true }), null, 'without row evidence do not remove spaces');
  const old = captureCodexQueuedMessageBaseline(after, audit);
  assert.equal(classifyCodexQueuedMessageFrame({ baseline: old,
    snapshot: { ...after, committedFrameGeneration: 12 }, audit, identity }).accepted, false);
});

test('production queue: blank preview row before ellipsis still proves the visible prefix', () => {
  const audit = { expectedText: '<pasted_content>\n# Правила общения с AI\n\nДлинный текст\n</pasted_content>',
    queuedAtSubmit: true, submitWritten: true, enterRunSeq: 7,
    enterLifecycleGeneration: 'life-a', enterInputRevision: 12 };
  const baseline = captureCodexQueuedMessageBaseline(snapshot(), audit);
  const after = snapshot({ frame: 11 });
  after.lines.splice(2, 0, line(3, '  ↳ <pasted_content>', status),
    line(4, '    # Правила общения с AI', status), line(5, ' '), line(6, '    …', status));
  const result = classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit, identity });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'codex_tui_queue_visible_prefix');
  assert.match(result.text, /…$/u);
  const missingEllipsis = structuredClone(after);
  missingEllipsis.lines.splice(5, 1);
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: missingEllipsis, audit, identity }).accepted, false);
  assert.equal(classifyCodexQueuedMessageFrame({ baseline, snapshot: after, audit,
    identity: { ...identity, writeQueueOwned: false } }).accepted, false);
});

test('same text already present before Enter does not prove a duplicate send', () => {
  const audit = {
    expectedText: 'same prompt',
    queuedAtSubmit: true,
    submitWritten: true,
    enterRunSeq: 7,
    enterLifecycleGeneration: 'life-a',
    enterInputRevision: 12,
  };
  const baseline = captureCodexQueuedMessageBaseline(snapshot({
    frame: 10,
    messages: ['same prompt'],
  }), audit);
  const result = classifyCodexQueuedMessageFrame({
    baseline,
    snapshot: snapshot({ frame: 11, messages: ['same prompt'] }),
    audit,
    identity,
  });
  assert.deepEqual(result, {
    accepted: false,
    reason: 'matching-queue-count-did-not-grow',
  });
});

test('stale terminal, lifecycle, input or mirror cannot claim queue acceptance', () => {
  const audit = {
    expectedText: 'queued prompt',
    queuedAtSubmit: true,
    submitWritten: true,
    enterRunSeq: 7,
    enterLifecycleGeneration: 'life-a',
    enterInputRevision: 12,
  };
  const baseline = captureCodexQueuedMessageBaseline(snapshot({ frame: 10 }), audit);
  for (const changed of [
    { sameTerminal: false },
    { runSeq: 8 },
    { lifecycleGeneration: 'life-b' },
    { inputRevision: 13 },
    { writeQueueOwned: false },
  ]) {
    const result = classifyCodexQueuedMessageFrame({
      baseline,
      snapshot: snapshot({ frame: 11, messages: ['queued prompt'] }),
      audit,
      identity: { ...identity, ...changed },
    });
    assert.equal(result.accepted, false, JSON.stringify(changed));
    assert.equal(result.reason, 'post-enter-identity-changed', JSON.stringify(changed));
  }
  assert.equal(classifyCodexQueuedMessageFrame({
    baseline,
    snapshot: snapshot({ frame: 11, messages: ['queued prompt'], mirror: 'mirror-b' }),
    audit,
    identity,
  }).reason, 'mirror-generation-changed');
});
