'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  codexUserMessageAuditText,
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  consumeCodexUserMessageAuditChunk,
  normalizeCodexProviderImageMarkup,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  selectCodexPreferredUserMessageAuditRecords,
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');

test('provisional source audit parser finds a user_message without consuming lifecycle rows', () => {
  const prefix = JSON.stringify({
    timestamp: '2026-07-27T04:07:08.094Z',
    type: 'event_msg',
    payload: { type: 'task_started' },
  }) + '\n';
  const user = JSON.stringify({
    timestamp: '2026-07-27T04:07:13.102Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'Reply only C3-AUDIT-070359' },
  }) + '\n';
  const result = consumeCodexUserMessageAuditChunk({
    chunk: prefix + user,
    incomingStartOffset: 119_292,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record.payload.message, 'Reply only C3-AUDIT-070359');
  assert.equal(result.records[0].byteOffset, 119_292 + Buffer.byteLength(prefix));
  assert.equal(result.partial, '');
});

test('provisional source audit parser carries a split JSONL row with its original byte offset', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-27T04:07:13.102Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'split audit row' },
  });
  const splitAt = 47;
  const first = consumeCodexUserMessageAuditChunk({
    chunk: line.slice(0, splitAt),
    incomingStartOffset: 240_143,
  });
  assert.equal(first.records.length, 0);

  const second = consumeCodexUserMessageAuditChunk({
    chunk: line.slice(splitAt) + '\n',
    incomingStartOffset: 240_143 + Buffer.byteLength(line.slice(0, splitAt)),
    partial: first.partial,
    partialStartOffset: first.partialStartOffset,
  });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].byteOffset, 240_143);
  assert.equal(second.records[0].record.payload.message, 'split audit row');
  assert.equal(second.partial, '');
});

test('provisional Resume accepts an image-bearing response_item user carrier without event_msg', () => {
  const record = {
    timestamp: '2026-08-17T10:19:49.357Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,very-large-payload' },
        { type: 'input_text', text: '<pasted_content>question</pasted_content>' },
        { type: 'input_image', image_url: 'data:image/png;base64,second-large-payload' },
      ],
    },
  };
  const consumed = consumeCodexUserMessageAuditChunk({
    chunk: JSON.stringify(record) + '\n',
    incomingStartOffset: 36_563_744,
  });

  assert.equal(consumed.records.length, 1);
  assert.equal(consumed.records[0].byteOffset, 36_563_744);
  assert.equal(
    codexUserMessageAuditText(consumed.records[0].record),
    ' [Image #1] <pasted_content>question</pasted_content> [Image #2] ',
  );
});

test('two image paste paths match the ordered response_item image slots exactly', () => {
  const firstPath = '/tmp/noted-terminal-codex-image-input/first.png';
  const secondPath = '/tmp/noted-terminal-codex-image-input/second.png';
  const middle = '<pasted_content>question</pasted_content>';
  const expectedText = firstPath + middle + secondPath;
  const actualText = ' [Image] ' + middle + ' [Image] ';
  const selected = selectCodexPendingPromptAudit([{
    expectedText,
    expectedLen: expectedText.length,
    expectedHash: 'expected-operation-hash',
    expectedImagePaths: [firstPath, secondPath],
    sentAt: Date.parse('2026-08-17T10:19:48.810Z'),
    preSubmitBoundary: {
      sessionId: '01a00e88-0d4c-7e53-95f3-22e31a2ecfc2',
      filePath: '/rollout.jsonl',
      fileSize: 36_536_092,
    },
  }], {
    actualText,
    actualHash: 'different-transcript-hash',
    actualPayload: { type: 'message', role: 'user' },
    actualIdentity: {
      sessionId: '01a00e88-0d4c-7e53-95f3-22e31a2ecfc2',
      filePath: '/rollout.jsonl',
      byteOffset: 36_563_744,
      timestamp: '2026-08-17T10:19:49.357Z',
    },
  });

  assert.equal(selected?.canonicalMatch?.reason, 'codex_image_placeholder_canonical');
});

test('Codex XML-like image blocks count each label plus path as one slot', () => {
  const paths = [
    '/tmp/noted-terminal-codex-image-input/first.png',
    '/tmp/noted-terminal-codex-image-input/second.png',
    '/tmp/noted-terminal-codex-image-input/third.png',
  ];
  const middle = 'question between images';
  const expected = paths[0] + paths[1] + middle + paths[2];
  const actual = [
    `<image name=[Image #1] path="${paths[0]}">\n<<ImageDisplayed>>\n</image>`,
    `<image name=[Image #2] path="${paths[1]}">\n<<ImageDisplayed>>\n</image>`,
    middle,
    `<image name=[Image #3] path="${paths[2]}">\n<<ImageDisplayed>>\n</image>`,
  ].join('');
  const matched = codexCanonicalUserMessageMatch({
    expectedText: expected,
    expectedImagePaths: paths,
  }, actual);
  assert.equal(matched?.reason, 'codex_image_placeholder_canonical');
  assert.equal(codexCanonicalUserMessageMatch({
    expectedText: expected,
    expectedImagePaths: paths,
  }, actual.replace(middle, 'different question')), null);
});

test('17 Aug provider image block plus duplicate numbered placeholder is one audited slot', () => {
  const imagePath = '/tmp/noted-terminal-codex-image-input/ea92e0079bbae126b5feef46950051614bfd003b6d7a2ca703c9a735f5325675.png';
  const task = 'change only the requested group colors';
  const expectedText = `${imagePath}  ${task}`;
  const actualText = `<image name=[Image #1] path="${imagePath}"> [Image] </image>[Image #1]   ${task}`;
  const audit = {
    expectedText,
    expectedLen: expectedText.length,
    expectedHash: '66cc84f61b308c76',
    expectedImagePaths: [imagePath],
  };

  assert.equal(
    normalizeCodexPromptImageSlots(expectedText, [imagePath]),
    normalizeCodexPromptImageSlots(actualText, [imagePath]),
  );
  assert.equal(
    selectCodexPendingPromptAudit([audit], {
      actualText,
      actualHash: 'c31ae5975f87a3e5',
    })?.canonicalMatch?.reason,
    'codex_image_placeholder_canonical',
  );
});

test('17 Aug provider envelope and its in-place placeholder stay one slot across prose', () => {
  const imagePath = '/tmp/noted-terminal-codex-image-input/f2daf846013d0ea3bb2f6ec9ec4f5e6afc624f76403a62c8aeb0f2d82e30ac35.png';
  const before = 'Почему сообщения дублируются?';
  const after = 'Agent metadata follows';
  const expectedText = `${before}${imagePath} ${after}`;
  const actualText = `<image name=[Image #1] path="${imagePath}"> [Image] </image>`
    + `${before}[Image #1] ${after}`;
  const audit = {
    expectedText,
    expectedLen: expectedText.length,
    expectedHash: 'expected-hash',
    expectedImagePaths: [imagePath],
  };

  assert.equal(
    normalizeCodexPromptImageSlots(expectedText, [imagePath]),
    normalizeCodexPromptImageSlots(actualText, [imagePath]),
  );
  assert.equal(
    selectCodexPendingPromptAudit([audit], {
      actualText,
      actualHash: 'provider-hash',
    })?.canonicalMatch?.reason,
    'codex_image_placeholder_canonical',
  );
});

test('19:40 tab-3607 production carrier matches the exact 877-char send', () => {
  const assetPath = '/Users/fedor/Library/Application Support/noted-terminal/prompt-queue-assets/f2daf846013d0ea3bb2f6ec9ec4f5e6afc624f76403a62c8aeb0f2d82e30ac35.png';
  const providerPath = '/tmp/noted-terminal-codex-image-input/f2daf846013d0ea3bb2f6ec9ec4f5e6afc624f76403a62c8aeb0f2d82e30ac35.png';
  const submitted = `Что за хуйня, почему тут, блядь, все два идёт дублируется? Это вот эти вот два сообщения, что это какая-то хуета: «проверь, посмотри, что там за дела». Куда это взялось?[imagePath: ${assetPath}] Agent: Codex
Role: assistant
Time: 17.08.2026, 19:38:08
Message ID: codex-live-961a6c74-5c56-4cc2-8c2d-0d433caaeac2-2026-08-17T16-38-08-384Z-84-tool
Session ID: 961a6c74-5c56-4cc2-8c2d-0d433caaeac2 Agent: Codex
Role: assistant
Time: 17.08.2026, 19:38:48
Message ID: codex-live-961a6c74-5c56-4cc2-8c2d-0d433caaeac2-2026-08-17T16-38-48-863Z-87-tool
Session ID: 961a6c74-5c56-4cc2-8c2d-0d433caaeac2 Версия билда, если что, тут старая, но предпоследняя, я бы сказал. Но основные правки там уже должны быть внесены. То есть, что вот эта вот суета с цветом — это непонятно откуда взялось, это очень странно.`;
  const expectedText = submitted.replace(`[imagePath: ${assetPath}]`, providerPath);
  const actualText = `<image name=[Image #1] path="${providerPath}"> [Image] </image>`
    + submitted.replace(`[imagePath: ${assetPath}]`, '[Image #1] ');
  const audit = {
    handoffId: 'msxgmn7e-6xuohw',
    expectedText,
    expectedLen: expectedText.length,
    expectedHash: 'cd11e781287eedf9',
    expectedImagePaths: [providerPath],
  };

  assert.equal(expectedText.length, 877);
  assert.equal(actualText.length, 936);
  assert.equal(
    selectCodexPendingPromptAudit([audit], {
      actualText,
      actualHash: '43c76afc88fd08db',
    })?.canonicalMatch?.reason,
    'codex_image_placeholder_canonical',
  );
  assert.equal(
    selectCodexPendingPromptAudit([audit], {
      actualText: actualText.replace('предпоследняя', 'последняя'),
      actualHash: 'different-non-image-byte',
    }),
    null,
    'a non-image text change must never be hidden by image canonicalization',
  );
});

test('live delivery audit preserves provider path evidence until exact comparison', () => {
  const imagePath = '/tmp/noted-terminal-codex-image-input/content-hash.png';
  const providerText = `<image name=[Image #1] path="${imagePath}"> [Image] </image>`
    + 'before [Image #1] after';
  const record = {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: providerText,
      local_images: [imagePath],
    },
  };
  assert.equal(
    codexUserMessageAuditText(record).trim(),
    'before [Image #1] after',
    'presentation text removes the duplicate provider carrier',
  );
  assert.equal(
    codexUserMessageAuditText(record, { preserveProviderImageMarkup: true }),
    providerText,
    'delivery proof retains the exact path and slot for validation',
  );
});

test('provider image identity rejects changed paths, reordered slots and duplicate slot claims', () => {
  const first = '/tmp/noted-terminal-codex-image-input/first-hash.png';
  const second = '/tmp/noted-terminal-codex-image-input/second-hash.png';
  const expectedText = `before ${first} middle ${second} after`;
  const audit = { expectedText, expectedImagePaths: [first, second] };
  const block = (slot, imagePath) => `<image name=[Image #${slot}] path="${imagePath}"> [Image] </image>`;
  const valid = block(1, first) + block(2, second)
    + 'before [Image #1] middle [Image #2] after';

  assert.equal(
    codexCanonicalUserMessageMatch(audit, valid)?.reason,
    'codex_image_placeholder_canonical',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      audit,
      block(1, second) + block(2, first)
        + 'before [Image #1] middle [Image #2] after',
    ),
    null,
    'slot numbers cannot conceal reordered attachment identities',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      audit,
      block(1, first) + block(1, second)
        + 'before [Image #1] middle [Image #2] after',
    ),
    null,
    'two provider envelopes cannot claim the same slot',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      audit,
      block(1, '/tmp/noted-terminal-codex-image-input/unrelated.png')
        + block(2, second)
        + 'before [Image #1] middle [Image #2] after',
    ),
    null,
    'a different provider image path is not the sent attachment',
  );
});

test('the same image attached twice remains two ordered slots', () => {
  const repeated = '/tmp/noted-terminal-codex-image-input/repeated-hash.png';
  const expectedText = `left ${repeated} center ${repeated} right`;
  const actualText = `<image name=[Image #1] path="${repeated}"> [Image] </image>`
    + `<image name=[Image #2] path="${repeated}"> [Image] </image>`
    + 'left [Image #1] center [Image #2] right';
  assert.equal(
    codexCanonicalUserMessageMatch({
      expectedText,
      expectedImagePaths: [repeated, repeated],
    }, actualText)?.reason,
    'codex_image_placeholder_canonical',
  );
});

test('provider image normalization preserves a distinct adjacent image slot', () => {
  const imagePaths = ['/tmp/first.png', '/tmp/second.png'];
  const actual = '<image name=[Image #1] path="/tmp/first.png"> [Image] </image>[Image #2] compare';
  assert.equal(
    normalizeCodexPromptImageSlots(actual, imagePaths),
    '[Image] [Image] compare',
  );
});

test('literal provider-looking prose stays opaque without structured image evidence', () => {
  const literal = '<image name=[Image #1] path="/tmp/example.png"> [Image] </image>[Image #1] docs';
  assert.equal(normalizeCodexProviderImageMarkup(literal, []), literal);
  assert.equal(codexUserMessageAuditText({
    type: 'event_msg',
    payload: { type: 'user_message', message: literal },
  }), literal);
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: literal }, '[Image #1] docs'),
    null,
    'literal XML examples cannot become delivery proof without attachment evidence',
  );
});

test('response_item assistant messages never become user delivery proof', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    },
  }) + '\n';
  assert.equal(consumeCodexUserMessageAuditChunk({ chunk: line }).records.length, 0);
});

test('paired response_item and event_msg select one canonical event carrier', () => {
  const response = {
    byteOffset: 100,
    record: {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'same prompt' }],
      },
    },
  };
  const event = {
    byteOffset: 200,
    record: {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'same prompt' },
    },
  };
  assert.deepEqual(selectCodexPreferredUserMessageAuditRecords([response, event]), [event]);
});

test('response-only carriers remain distinct for two identical physical sends', () => {
  const candidate = (byteOffset) => ({
    byteOffset,
    record: {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'same prompt' }],
      },
    },
  });
  const first = candidate(100);
  const second = candidate(300);
  assert.deepEqual(selectCodexPreferredUserMessageAuditRecords([first, second]), [first, second]);
});

test('same-file identical records before the pre-Enter byte boundary are not causal', () => {
  const audit = {
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      fileSize: 1_000,
    },
  };
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'writer-a',
    filePath: '/rollouts/writer-a.jsonl',
    byteOffset: 900,
    timestamp: '2026-07-24T16:36:21.000Z',
  }), false);
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'writer-a',
    filePath: '/rollouts/writer-a.jsonl',
    byteOffset: 1_000,
    timestamp: '2026-07-24T16:36:21.000Z',
  }), true);
});

test('linked-child catch-up rejects copied history and accepts a post-Enter record', () => {
  const audit = {
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'source',
      filePath: '/rollouts/source.jsonl',
      fileSize: 5_000,
    },
  };
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'child',
    filePath: '/rollouts/child.jsonl',
    byteOffset: 128,
    timestamp: '2026-07-24T16:30:00.000Z',
  }), false);
  assert.equal(codexAuditRecordIsAfterBoundary(audit, {
    sessionId: 'child',
    filePath: '/rollouts/child.jsonl',
    byteOffset: 10_000,
    timestamp: '2026-07-24T16:36:20.001Z',
  }), true);
});

test('12:51 production Resume send admits the 183-char child turn only after Enter', () => {
  const sourceSessionId = '019fc1f7-3c5c-76a1-99af-49b919b412dd';
  const childSessionId = '019fc276-a21a-71f3-98d0-01d2236e0e45';
  const handoffId = '6c6d344a-8d7a-4422-8c8b-dbe3495570f0';
  const prompt = 'P'.repeat(183);
  const assistantAnswer = 'A'.repeat(415);
  const audit = {
    handoffId,
    expectedText: prompt,
    expectedLen: prompt.length,
    expectedHash: 'production-prompt-hash',
    sentAt: Date.parse('2026-08-02T12:51:20.313Z'),
    preSubmitBoundary: {
      sessionId: sourceSessionId,
      filePath: '/rollouts/' + sourceSessionId + '.jsonl',
      fileSize: 97_000,
    },
  };
  assert.equal(selectCodexPendingPromptAudit([audit], {
    actualText: prompt,
    actualHash: audit.expectedHash,
    actualIdentity: {
      sessionId: childSessionId,
      filePath: '/rollouts/' + childSessionId + '.jsonl',
      byteOffset: 12_000,
      timestamp: '2026-08-02T12:51:20.200Z',
    },
  }), null, 'a copied/pre-Enter child row is not causal');
  assert.deepEqual(selectCodexPendingPromptAudit([audit], {
    actualText: prompt,
    actualHash: audit.expectedHash,
    actualIdentity: {
      sessionId: childSessionId,
      filePath: '/rollouts/' + childSessionId + '.jsonl',
      byteOffset: 12_400,
      timestamp: '2026-08-02T12:51:20.504Z',
    },
  }), { audit, canonicalMatch: null });
  assert.equal(prompt.length, 183);
  assert.equal(assistantAnswer.length, 415);
});

test('accepts the exact Codex boundary-whitespace normalization seen in production', () => {
  assert.deepEqual(
    codexCanonicalUserMessageMatch(
      { expectedText: ' \nlarge prompt\n\n ' },
      'large prompt',
    ),
    { reason: 'codex_trimmed_boundary_whitespace' },
  );
});

test('accepts leading-only and trailing-only boundary normalization', () => {
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: '\nhello' }, 'hello')?.reason,
    'codex_trimmed_boundary_whitespace',
  );
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: 'hello  \n' }, 'hello')?.reason,
    'codex_trimmed_boundary_whitespace',
  );
});

test('accepts the exact Codex PTY CRLF materialization seen in production', () => {
  const expectedText = '<pasted_content>\nline one\r\nline two\r\n\r\nline four\n</pasted_content>';
  const actualText = '<pasted_content>\nline one\n\nline two\n\n\n\nline four\n</pasted_content>';
  const audit = {
    handoffId: 'msog2zbr-zebnag',
    expectedText,
    expectedLen: expectedText.length,
    expectedHash: 'a7fd88f93b6ef1e3',
  };

  assert.equal(actualText.length, expectedText.length, 'CRLF and LF+LF retain the same code-unit length');
  assert.deepEqual(
    codexCanonicalUserMessageMatch(audit, actualText),
    { reason: 'codex_pty_crlf_materialized_as_double_lf' },
  );
  assert.deepEqual(
    selectCodexPendingPromptAudit([audit], {
      actualText,
      actualHash: '2d8b890760950e83',
    }),
    {
      audit,
      canonicalMatch: { reason: 'codex_pty_crlf_materialized_as_double_lf' },
    },
  );
});

test('does not broaden Codex CRLF materialization into fuzzy whitespace matching', () => {
  const expectedText = '<pasted_content>\nline one\r\nline two\n</pasted_content>';
  assert.equal(
    codexCanonicalUserMessageMatch(
      { expectedText },
      '<pasted_content>\nline one\nline two\n</pasted_content>',
    ),
    null,
    'ordinary CRLF-to-LF normalization is not the observed Codex PTY edge',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      { expectedText },
      '<pasted_content>\nline one\n\nline  two\n</pasted_content>',
    ),
    null,
    'an unrelated interior-space mutation remains corruption',
  );
});

test('does not hide interior whitespace corruption or truncation', () => {
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: ' hello  world ' }, 'hello world'),
    null,
  );
  assert.equal(
    codexCanonicalUserMessageMatch({ expectedText: ' complete prompt ' }, 'complete'),
    null,
  );
});

test('keeps image placeholder canonicalization', () => {
  const imagePath = '/tmp/example image.png';
  assert.equal(
    normalizeCodexPromptImageSlots(`before [imagePath: ${imagePath}] after`, [imagePath]),
    'before [Image] after',
  );
  assert.equal(
    codexCanonicalUserMessageMatch(
      {
        expectedText: `before [imagePath: ${imagePath}] after`,
        actualPayload: { local_images: [imagePath] },
      },
      'before [Image #1] after',
    )?.reason,
    'codex_image_placeholder_canonical',
  );
});

test('late A matches its own pending audit after B was staged', () => {
  const auditA = {
    handoffId: 'handoff-a',
    expectedText: 'message A',
    expectedLen: 9,
    expectedHash: 'hash-a',
  };
  const auditB = {
    handoffId: 'handoff-b',
    expectedText: 'message B',
    expectedLen: 9,
    expectedHash: 'hash-b',
  };

  assert.deepEqual(
    selectCodexPendingPromptAudit([auditA, auditB], {
      actualText: 'message A',
      actualHash: 'hash-a',
    }),
    { audit: auditA, canonicalMatch: null },
  );
  assert.deepEqual(
    selectCodexPendingPromptAudit([auditB], {
      actualText: 'message B',
      actualHash: 'hash-b',
    }),
    { audit: auditB, canonicalMatch: null },
  );
});

test('an unrelated user_message does not consume or fail a neighboring audit', () => {
  const audits = [
    {
      handoffId: 'handoff-a',
      expectedText: 'message A',
      expectedLen: 9,
      expectedHash: 'hash-a',
    },
    {
      handoffId: 'handoff-b',
      expectedText: 'message B',
      expectedLen: 9,
      expectedHash: 'hash-b',
    },
  ];
  assert.equal(
    selectCodexPendingPromptAudit(audits, {
      actualText: 'historical message',
      actualHash: 'hash-old',
    }),
    null,
  );
  assert.equal(audits.length, 2);
});

test('selector cannot confirm a new send from an old identical catch-up record', () => {
  const audit = {
    handoffId: 'handoff-new',
    expectedText: 'same prompt',
    expectedLen: 11,
    expectedHash: 'same-hash',
    sentAt: Date.parse('2026-07-24T16:36:20.000Z'),
    preSubmitBoundary: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      fileSize: 4_096,
    },
  };
  assert.equal(selectCodexPendingPromptAudit([audit], {
    actualText: 'same prompt',
    actualHash: 'same-hash',
    actualIdentity: {
      sessionId: 'writer-a',
      filePath: '/rollouts/writer-a.jsonl',
      byteOffset: 2_048,
      timestamp: '2026-07-24T16:36:21.000Z',
    },
  }), null);
});

test('unconfirmed audit retention is bounded without classifying delivery as failed', () => {
  const now = 1_000_000;
  const expired = { handoffId: 'expired', sentAt: now - 60_000 };
  const oldestFresh = { handoffId: 'oldest-fresh', sentAt: now - 3_000 };
  const newest = { handoffId: 'newest', sentAt: now - 1_000 };
  const result = partitionCodexPendingPromptAuditsForRetention(
    [expired, oldestFresh, newest],
    { now, maxAgeMs: 30_000, maxPending: 1 },
  );

  assert.deepEqual(result.retained, [newest]);
  assert.deepEqual(result.evicted, [
    { audit: expired, reason: 'age-bound' },
    { audit: oldestFresh, reason: 'count-bound' },
  ]);
  assert.equal('deliveryFailed' in result, false);
});
