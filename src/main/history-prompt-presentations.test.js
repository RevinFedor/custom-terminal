const test = require('node:test');
const assert = require('node:assert/strict');
const {
  backfillConfirmedSystemPromptPresentations,
  buildCodexPromptPresentationRemap,
  cloneCodexPromptPresentationsForProvenChild,
  collectHistoryImagePathMarkersOutsidePastedContent,
  decorateHistoryPromptPresentations,
  normalizePromptPresentationSnapshot,
  promptPresentationHistorySessionId,
  promptTransportHash,
  saveAuditedPromptPresentation,
  withPromptOriginPresentation,
} = require('./history-prompt-presentations');

test('native ID pasted-content stays opaque to the main image-ref reader, including malformed pairs', () => {
  assert.deepEqual(collectHistoryImagePathMarkersOutsidePastedContent(
    '[imagePath: /before.png] <pasted_content id="1fe1">\n[imagePath: /literal.png]\n'
      + '</pasted_content id="1fe1"> [imagePath: /after.png]'), ['/before.png', '/after.png']);
  assert.deepEqual(collectHistoryImagePathMarkersOutsidePastedContent(
    '[imagePath: /before.png] <pasted_content id="1fe1">\n[imagePath: /literal.png]\n'
      + '</pasted_content id="aaaa"> [imagePath: /ambiguous.png]'), ['/before.png']);
});

test('transport history session hint stays readable without becoming a visible chip', () => {
  assert.equal(promptPresentationHistorySessionId({ historySessionId: ' session-a ' }), 'session-a');
  assert.equal(promptPresentationHistorySessionId({ historySessionId: '   ' }), null);
  assert.equal(promptPresentationHistorySessionId(null), null);
  assert.equal(normalizePromptPresentationSnapshot({ historySessionId: 'session-a' }), null);
});

function createStore() {
  const rows = [];
  return {
    rows,
    saveHistoryPromptPresentation(row) {
      rows.push({ ...row, chips: row.chips });
      return true;
    },
    getHistoryPromptPresentations(_toolType, sessionId) {
      return rows.filter(row => row.sessionId === sessionId);
    },
    getHistoryPromptPresentationsForEntries(_toolType, entryUuids) {
      const wanted = new Set(entryUuids);
      return rows.filter(row => row.entryUuid && wanted.has(row.entryUuid));
    },
    bindHistoryPromptPresentationEntry(query) {
      const row = rows.find(candidate => (
        candidate.toolType === query.toolType
        && candidate.sessionId === query.sessionId
        && candidate.auditTimestamp === query.auditTimestamp
        && candidate.transportHash === query.transportHash
      ));
      if (!row) return false;
      row.entryUuid = query.entryUuid;
      return true;
    },
  };
}

test('post-Enter sidecar decorates the exact durable prompt without changing its content', () => {
  const store = createStore();
  const content = 'saved prompt\n\nuser note';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'codex',
    sessionId: 'writer-1',
    auditTimestamp: '2026-07-24T01:02:03.004Z',
    actualText: content,
    snapshot: {
      promptChips: [{
        id: 'chip-1',
        kind: 'prompt',
        label: 'Review',
        text: 'saved prompt',
      }],
    },
  }), true);

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'codex',
    sessionId: 'writer-1',
    entries: [{
      uuid: 'codex-user-writer-1-17',
      role: 'user',
      timestamp: '2026-07-24T01:02:03.004Z',
      content,
    }],
  });

  assert.equal(decorated[0].content, content);
  assert.equal(decorated[0].promptChips[0].label, 'Review');
  assert.equal(store.rows[0].entryUuid, 'codex-user-writer-1-17');
});

for (const toolType of ['claude', 'codex']) {
  test(toolType + ' exact durable message sidecar preserves body hash and address for renderer projection', () => {
    const store = createStore();
    const envelopeText = 'Generated envelope\n\nAnswer:\n';
    const content = envelopeText + '**Exact answer**';
    const tag = { id: 'message-tag', kind: 'tab-message', messageId: 'answer-id',
      replyTo: 'question-id', phase: 'reply', sourceTabId: 'B', sourceTabName: 'Owner B',
      sourceProjectId: 'project-b', targetTabId: 'A', targetTabName: 'Source A', targetProjectId: 'project-a',
      envelopeStart: 0, envelopeText, bodyStart: envelopeText.length, bodyEnd: content.length,
      bodyProjectionHash: require('node:crypto').createHash('sha256').update(content).digest('hex') };
    assert.equal(saveAuditedPromptPresentation(store, { toolType, sessionId: 'recipient-session',
      entryUuid: 'exact-user-entry', auditTimestamp: '2026-10-03T00:00:00Z', actualText: content,
      snapshot: { semanticTags: [tag] } }), true);
    const entries = decorateHistoryPromptPresentations(store, { toolType, sessionId: 'recipient-session',
      entries: [{ uuid: 'exact-user-entry', role: 'user', content }] });
    assert.equal(entries[0].content, content);
    assert.deepEqual(entries[0].semanticTags, [tag]);
  });
}

test('file-chip sidecar keeps only validated snapshot metadata beside its text', () => {
  const store = createStore();
  const content = 'file body\n\nuser task';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'codex',
    sessionId: 'writer-file',
    auditTimestamp: '2026-08-30T10:00:00.000Z',
    actualText: content,
    snapshot: {
      promptChips: [{
        id: 'file-chip',
        kind: 'prompt',
        attachmentKind: 'file',
        label: 'rules.md',
        text: 'file body',
        filePath: '/tmp/rules.md',
        role: 'instructions',
        sha256: 'a'.repeat(64),
        bytes: 9,
      }],
    },
  }), true);
  const [decorated] = decorateHistoryPromptPresentations(store, {
    toolType: 'codex',
    sessionId: 'writer-file',
    entries: [{
      uuid: 'codex-user-writer-file-1',
      role: 'user',
      timestamp: '2026-08-30T10:00:00.000Z',
      content,
    }],
  });
  assert.deepEqual({
    attachmentKind: decorated.promptChips[0].attachmentKind,
    filePath: decorated.promptChips[0].filePath,
    role: decorated.promptChips[0].role,
    sha256: decorated.promptChips[0].sha256,
    bytes: decorated.promptChips[0].bytes,
  }, {
    attachmentKind: 'file',
    filePath: '/tmp/rules.md',
    role: 'instructions',
    sha256: 'a'.repeat(64),
    bytes: 9,
  });
});

test('a Claude queue presentation follows the prompt into a uniquely merged canonical user turn', () => {
  const store = createStore();
  const queuedText = 'queued prompt';
  const queueTimestamp = '2026-08-16T09:58:43.000Z';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'claude',
    sessionId: 'claude-queue-session',
    auditTimestamp: queueTimestamp,
    actualText: queuedText,
    snapshot: {
      promptChips: [{
        id: 'queue-chip',
        kind: 'prompt',
        label: 'Queued source',
        text: queuedText,
      }],
    },
  }), true);

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'claude-queue-session',
    entries: [{
      uuid: 'claude-merged-user',
      role: 'user',
      timestamp: '2026-08-16T10:01:47.000Z',
      content: queuedText + '\nadditional user text',
      sourceIdentity: 'claude-queue:uuid:provider-enqueue',
      promptPresentationAuditTimestamp: queueTimestamp,
      promptPresentationTransportHash: promptTransportHash(queuedText),
    }],
  });

  assert.equal(decorated[0].content, queuedText + '\nadditional user text');
  assert.equal(decorated[0].promptChips[0].label, 'Queued source');
  assert.equal(store.rows[0].entryUuid, 'claude-merged-user');
});

test('audited image refs decorate the exact durable prompt and keep thumbnail identity', () => {
  const store = createStore();
  const content = 'before [Image #1] after';
  const assetId = 'a'.repeat(64) + '.png';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'codex',
    sessionId: 'writer-images',
    auditTimestamp: '2026-08-02T10:00:00.000Z',
    actualText: content,
    snapshot: {
      imagePaths: [{
        id: 1,
        path: `/tmp/${assetId}`,
        assetId,
        mediaType: 'image/png',
        size: 42,
        availability: 'available',
      }],
    },
  }), true);

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'codex',
    sessionId: 'writer-images',
    entries: [{
      uuid: 'codex-user-writer-images-1',
      role: 'user',
      timestamp: '2026-08-02T10:00:00.000Z',
      content,
    }],
  });

  assert.equal(store.rows[0].schemaVersion, 3);
  assert.deepEqual(decorated[0].imagePaths, [{
    id: 1,
    path: `/tmp/${assetId}`,
    assetId,
    mediaType: 'image/png',
    size: 42,
    availability: 'available',
  }]);
});

test('a proven managed imagePath marker repairs a missing sidecar and decorates the same entry', () => {
  const store = createStore();
  const assetId = 'b'.repeat(64) + '.png';
  const managedPath = `/Users/test/Library/Application Support/noted-terminal/prompt-queue-assets/${assetId}`;
  const content = `[imagePath: ${managedPath}]  explain this screenshot`;
  const source = [{
    uuid: 'claude-user-managed-image',
    role: 'user',
    timestamp: '2026-08-16T01:20:03.247Z',
    content,
  }];
  const logs = [];

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'claude-images',
    entries: source,
    recoverManagedImageRef: ({ path: candidate }) => candidate === managedPath
      ? {
          path: managedPath,
          assetId,
          mediaType: 'image/png',
          size: 128,
          availability: 'available',
        }
      : null,
    logger: { info: (message) => logs.push(message) },
  });

  assert.equal(decorated[0].content, content);
  assert.deepEqual(decorated[0].imagePaths, [{
    id: 1,
    path: managedPath,
    assetId,
    mediaType: 'image/png',
    size: 128,
    availability: 'available',
    error: undefined,
  }]);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].entryUuid, 'claude-user-managed-image');
  assert.equal(store.rows[0].schemaVersion, 3);
  assert.match(logs[0], /HistoryPromptPresentation:ImageRecovery/);
});

test('native Codex metadata resolves its managed alias even without imagePath in the text', () => {
  const store = createStore();
  const source = [{ uuid: 'native-image', role: 'user', timestamp: '2026-09-08T20:56:00Z',
    content: 'before [Image #1] after', imagePaths: [{ id: 1, path: '/native/input.png' }] }];
  const rows = decorateHistoryPromptPresentations(store, { toolType: 'codex', sessionId: 'S', entries: source,
    recoverManagedImageRef: ref => ref.path === '/native/input.png'
      ? { path: '/assets/exact.png', assetId: 'exact.png', availability: 'available' } : null,
    logger: { info() {} } });
  assert.equal(rows[0].content, source[0].content);
  assert.deepEqual(rows[0].imagePaths, [{ id: 1, path: '/assets/exact.png', assetId: 'exact.png', availability: 'available' }]);
  assert.equal(store.rows.length, 1, 'persist the recovered exact source association');
});

test('imagePath-looking text in pasted content, escaped text, or an unmanaged path stays literal', () => {
  const store = createStore();
  const managedPath = '/managed/' + 'c'.repeat(64) + '.png';
  const source = [{
    uuid: 'claude-user-literal-image-markers',
    role: 'user',
    timestamp: '2026-08-16T01:21:00.000Z',
    content: [
      `<pasted_content>\n[imagePath: ${managedPath}]\n</pasted_content>`,
      `\\[imagePath: ${managedPath}]`,
      '[imagePath: /tmp/not-managed.png]',
    ].join('\n'),
  }];
  let resolverCalls = 0;

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'claude-images',
    entries: source,
    recoverManagedImageRef: () => {
      resolverCalls += 1;
      return null;
    },
  });

  assert.equal(decorated, source);
  assert.equal(resolverCalls, 1, 'only the ordinary unescaped marker is eligible for validation');
  assert.equal(store.rows.length, 0);
});

test('managed image recovery preserves an existing prompt-chip presentation', () => {
  const store = createStore();
  const assetId = 'd'.repeat(64) + '.webp';
  const managedPath = `/managed/${assetId}`;
  const content = `saved prompt\n\n[imagePath: ${managedPath}] note`;
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'claude',
    sessionId: 'mixed-presentation',
    auditTimestamp: '2026-08-16T01:22:00.000Z',
    actualText: content,
    snapshot: {
      promptChips: [{ id: 'chip-1', kind: 'prompt', label: 'Saved', text: 'saved prompt' }],
    },
  }), true);

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'mixed-presentation',
    entries: [{
      uuid: 'claude-user-mixed-presentation',
      role: 'user',
      timestamp: '2026-08-16T01:22:00.000Z',
      content,
    }],
    recoverManagedImageRef: () => ({
      path: managedPath,
      assetId,
      mediaType: 'image/webp',
      size: 64,
      availability: 'available',
    }),
    logger: { info() {} },
  });

  assert.equal(decorated[0].promptChips[0].label, 'Saved');
  assert.equal(decorated[0].imagePaths[0].path, managedPath);
  const repaired = store.rows.at(-1);
  assert.ok(repaired.chips.some(item => item.kind === 'prompt'));
  assert.ok(repaired.chips.some(item => item.kind === 'image-ref'));
});

test('image presentation rejects relative paths and duplicate slot guesses', () => {
  const store = createStore();
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'codex',
    sessionId: 'writer-images',
    auditTimestamp: '2026-08-02T10:01:00.000Z',
    actualText: '[Image #1]',
    snapshot: {
      imagePaths: [
        { id: 1, path: 'relative.png' },
        { id: 1, path: '/tmp/second.png' },
      ],
    },
  }), true);
  assert.deepEqual(store.rows[0].chips, [{
    kind: 'image-ref',
    id: 1,
    path: '/tmp/second.png',
    availability: 'available',
    presentationIndex: 1,
  }]);
});

test('a hash or timestamp mismatch never attaches presentation metadata', () => {
  const store = createStore();
  store.rows.push({
    toolType: 'codex',
    sessionId: 'writer-1',
    auditTimestamp: '2026-07-24T01:02:03.004Z',
    transportHash: promptTransportHash('expected'),
    entryUuid: null,
    chips: [{ id: 'chip', kind: 'prompt', label: 'Prompt', text: 'expected' }],
  });

  const source = [{
    uuid: 'codex-user-writer-1-18',
    role: 'user',
    timestamp: '2026-07-24T01:02:03.004Z',
    content: 'different',
  }];
  assert.equal(decorateHistoryPromptPresentations(store, {
    toolType: 'codex',
    sessionId: 'writer-1',
    entries: source,
  }), source);
});

test('an audited orchestration tag decorates only the proven user record', () => {
  const store = createStore();
  const content = '[Оркестрация] Запрос завершён.\nrunId: run-1';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'claude',
    sessionId: 'source-session',
    auditTimestamp: '2026-07-27T08:00:00.000Z',
    actualText: content,
    snapshot: {
      semanticTags: [{
        kind: 'orchestration',
        runId: 'run-1',
        phase: 'completion',
        sourceTabId: 'source-tab',
        targetTabId: 'target-tab',
      }],
    },
  }), true);

  const entries = [{
    uuid: 'claude-user-entry-1',
    type: 'user',
    timestamp: '2026-07-27T08:00:00.000Z',
    content,
  }];
  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'source-session',
    entries,
  });

  assert.equal(decorated[0].semanticTags[0].kind, 'orchestration');
  assert.equal(decorated[0].semanticTags[0].runId, 'run-1');
  assert.equal(decorated[0].semanticTags[0].phase, 'completion');
  assert.equal(decorated[0].promptChips, undefined);
  assert.equal(store.rows[0].schemaVersion, 2);
});

test('an audited Loop prompt keeps its origin outside the canonical prompt text', () => {
  const store = createStore();
  const content = 'Проверь, полностью ли выполнена исходная задача.';
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'claude',
    sessionId: 'loop-session',
    auditTimestamp: '2026-07-29T01:00:00.000Z',
    actualText: content,
    snapshot: {
      semanticTags: [{ kind: 'prompt-origin', source: 'loop' }],
    },
  }), true);

  const decorated = decorateHistoryPromptPresentations(store, {
    toolType: 'claude',
    sessionId: 'loop-session',
    entries: [{
      uuid: 'claude-loop-entry-1',
      type: 'user',
      timestamp: '2026-07-29T01:00:00.000Z',
      content,
    }],
  });

  assert.equal(decorated[0].content, content);
  assert.deepEqual(decorated[0].semanticTags, [{
    id: 'durable-prompt-origin-tag-0',
    kind: 'prompt-origin',
    source: 'loop',
  }]);
});

function confirmedSystemReceipt(overrides = {}) {
  const sessionId = '40c93948-3f99-4d0b-a83d-efe86f095f63';
  const attemptId = '1cd41a7b-312b-464f-bdc8-77125af4a348';
  const sourceIdentity = `codex-user-source-${sessionId}-332759179`;
  const auditTimestamp = '2026-09-05T12:22:23.562Z';
  const promptHash = promptTransportHash('служебный возврат');
  return {
    state: 'confirmed', attemptId, provider: 'codex', sessionId,
    auditIdentity: { attemptId, provider: 'codex', sessionId, sourceIdentity, auditTimestamp, promptHash },
    receipt: {
      exactAuditConfirmed: true, attemptId, provider: 'codex', sessionId, sourceIdentity,
      source: 'codex-build-install-return', actualHash: promptHash, auditTimestamp,
    },
    ...overrides,
  };
}

test('confirmed system backfill survives restore and binds only its exact canonical source identity', () => {
  const store = createStore();
  const record = confirmedSystemReceipt();
  assert.equal(backfillConfirmedSystemPromptPresentations(store, [record, record]), 1);
  assert.equal(backfillConfirmedSystemPromptPresentations(store, [record]), 0);
  // Simulate the persisted sidecar being read by a fresh process.
  const restored = createStore();
  restored.rows.push(...JSON.parse(JSON.stringify(store.rows)));
  const entry = {
    uuid: `codex-user-${record.sessionId}-32076`, type: 'user',
    timestamp: record.auditIdentity.auditTimestamp, content: 'служебный возврат',
    sourceIdentity: record.auditIdentity.sourceIdentity,
  };
  const quoted = { ...entry, uuid: 'ordinary-user-quote', sourceIdentity: 'another-source' };
  const missingProof = { ...quoted, uuid: 'no-source', sourceIdentity: undefined };
  const result = decorateHistoryPromptPresentations(restored, {
    toolType: 'codex', sessionId: record.sessionId, entries: [quoted, missingProof, entry],
  });
  assert.equal(result[0], quoted, 'identical text and timestamp are not source proof');
  assert.equal(result[1], missingProof);
  assert.equal(result[2].semanticTags[0].source, 'system');
  assert.equal(result[2].semanticTags[0].systemSource, 'build-install-return');
  assert.equal(result[2].semanticTags[0].runId, undefined);
  assert.equal(result[2].content, entry.content);
  assert.equal(restored.rows[0].entryUuid, entry.uuid);
  assert.equal(decorateHistoryPromptPresentations(restored, {
    toolType: 'codex', sessionId: record.sessionId,
    entries: [{ ...entry, content: 'edited later' }],
  })[0].semanticTags[0].source, 'system');
});

test('system backfill accepts canonical source aliases and preserves existing prompt/image presentation', () => {
  const store = createStore();
  const record = confirmedSystemReceipt();
  saveAuditedPromptPresentation(store, {
    toolType: 'codex', sessionId: record.sessionId,
    auditTimestamp: record.auditIdentity.auditTimestamp, actualHash: record.auditIdentity.promptHash,
    snapshot: { promptChips: [{ kind: 'prompt', text: 'rules', label: 'Rules' }],
      imagePaths: [{ id: 1, path: '/tmp/a.png' }] },
  });
  assert.equal(backfillConfirmedSystemPromptPresentations(store, [record]), 1);
  const [entry] = decorateHistoryPromptPresentations(store, {
    toolType: 'codex', sessionId: record.sessionId,
    entries: [{ uuid: 'promoted-event', role: 'user', content: 'служебный возврат',
      timestamp: record.auditIdentity.auditTimestamp, sourceIdentity: 'canonical-source',
      sourceIdentityAliases: [record.auditIdentity.sourceIdentity] }],
  });
  assert.equal(entry.semanticTags[0].source, 'system');
  assert.equal(entry.promptChips[0].label, 'Rules');
  assert.equal(entry.imagePaths[0].path, '/tmp/a.png');
});

test('unconfirmed, inconsistent and ordinary user receipts cannot mint a system tag', () => {
  const record = confirmedSystemReceipt();
  const variants = [
    { state: 'delivery-unknown' },
    { receipt: { ...record.receipt, exactAuditConfirmed: false } },
    { receipt: { ...record.receipt, source: 'history-panel' } },
    { receipt: { ...record.receipt, actualHash: 'different' } },
    { auditIdentity: { ...record.auditIdentity, sourceIdentity: null } },
    { auditIdentity: { ...record.auditIdentity, attemptId: 'stale' } },
    { auditIdentity: { ...record.auditIdentity, sessionId: 'foreign' } },
  ];
  for (const variant of variants) {
    const store = createStore();
    assert.equal(backfillConfirmedSystemPromptPresentations(store, [{ ...record, ...variant }]), 0);
    assert.deepEqual(store.rows, []);
  }
});

test('new capacity retries persist through the same normalizer without becoming orchestration runs', () => {
  const store = createStore();
  assert.equal(saveAuditedPromptPresentation(store, {
    toolType: 'codex', sessionId: 'capacity-session', entryUuid: 'capacity-user',
    auditTimestamp: '2026-09-05T13:00:00.000Z', actualText: 'continue',
    snapshot: withPromptOriginPresentation(null, 'codex-capacity-retry'),
  }), true);
  const [entry] = decorateHistoryPromptPresentations(store, {
    toolType: 'codex', sessionId: 'capacity-session',
    entries: [{ uuid: 'capacity-user', type: 'user', content: 'continue' }],
  });
  assert.equal(entry.semanticTags[0].systemSource, 'codex-capacity-retry');
  assert.equal(entry.semanticTags[0].runId, undefined);
});

function codexUser(line, timestamp, message) {
  return {
    __line: line,
    type: 'event_msg',
    timestamp,
    payload: { type: 'user_message', message },
  };
}

test('Codex child remap follows only the copied user-message prefix and preserves duplicate occurrence order', () => {
  const sourceRecords = [
    codexUser(4, '2026-07-24T01:00:00.000Z', 'first'),
    codexUser(9, '2026-07-24T01:01:00.000Z', 'same'),
    codexUser(15, '2026-07-24T01:01:00.000Z', 'same'),
    codexUser(21, '2026-07-24T01:02:00.000Z', 'removed source turn'),
  ];
  const childRecords = [
    codexUser(7, '2026-07-24T01:00:00Z', 'first'),
    codexUser(12, '2026-07-24T01:01:00.000Z', 'same'),
    codexUser(19, '2026-07-24T01:01:00.000Z', 'same'),
  ];

  const result = buildCodexPromptPresentationRemap({
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords,
    childRecords,
  });

  assert.equal(result.matchedPrefixLength, 3);
  assert.equal(result.stoppedReason, 'partial-projection');
  assert.deepEqual(
    result.mappings.map(mapping => ({
      source: mapping.sourceEntryUuid,
      child: mapping.childEntryUuid,
      occurrence: mapping.occurrence,
    })),
    [
      { source: 'codex-user-source-4', child: 'codex-user-child-7', occurrence: 1 },
      { source: 'codex-user-source-9', child: 'codex-user-child-12', occurrence: 1 },
      { source: 'codex-user-source-15', child: 'codex-user-child-19', occurrence: 2 },
    ],
  );
});

test('Codex child remap preserves surviving messages across a removed middle range', () => {
  const result = buildCodexPromptPresentationRemap({
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords: [
      codexUser(1, '2026-07-24T01:00:00Z', 'copied'),
      codexUser(2, '2026-07-24T01:01:00Z', 'old branch'),
      codexUser(3, '2026-07-24T01:02:00Z', 'looks copied later'),
    ],
    childRecords: [
      codexUser(8, '2026-07-24T01:00:00.000Z', 'copied'),
      codexUser(9, '2026-07-24T01:01:00Z', 'new branch'),
      codexUser(10, '2026-07-24T01:02:00Z', 'looks copied later'),
    ],
  });

  assert.equal(result.stoppedReason, 'partial-projection');
  assert.deepEqual(result.mappings.map(mapping => mapping.childEntryUuid), [
    'codex-user-child-8',
    'codex-user-child-10',
  ]);
});

test('Codex child remap skips an ambiguous duplicate group instead of guessing the surviving occurrence', () => {
  const result = buildCodexPromptPresentationRemap({
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords: [
      codexUser(1, '2026-07-24T01:00:00Z', 'unique'),
      codexUser(2, '2026-07-24T01:01:00Z', 'duplicate'),
      codexUser(3, '2026-07-24T01:01:00Z', 'duplicate'),
    ],
    childRecords: [
      codexUser(8, '2026-07-24T01:00:00Z', 'unique'),
      codexUser(9, '2026-07-24T01:01:00Z', 'duplicate'),
    ],
  });

  assert.equal(result.stoppedReason, 'duplicate-occurrence-ambiguous');
  assert.deepEqual(result.mappings.map(mapping => mapping.childEntryUuid), [
    'codex-user-child-8',
  ]);
});

test('Codex child remap fails closed on missing metadata but normalizes newline encoding without mutating records', () => {
  const sourceText = 'line one\r\nline two';
  const childText = 'line one\nline two';
  const sourceRecords = [
    codexUser(1, '2026-07-24T01:00:00Z', sourceText),
    codexUser(2, null, 'metadata gap'),
    codexUser(3, '2026-07-24T01:02:00Z', 'must not map after gap'),
  ];
  const childRecords = [
    codexUser(5, '2026-07-24T01:00:00.000Z', childText),
    codexUser(6, '2026-07-24T01:01:00Z', 'metadata gap'),
    codexUser(7, '2026-07-24T01:02:00Z', 'must not map after gap'),
  ];

  const result = buildCodexPromptPresentationRemap({
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords,
    childRecords,
  });

  assert.equal(result.stoppedReason, 'identity-metadata-missing');
  assert.equal(result.mappings.length, 1);
  assert.notEqual(result.mappings[0].sourceTransportHash, result.mappings[0].childTransportHash);
  assert.equal(sourceRecords[0].payload.message, sourceText);
  assert.equal(childRecords[0].payload.message, childText);
});

test('Codex child clone helper passes only proven record mappings to the DB operation', () => {
  const calls = [];
  const store = {
    cloneCodexHistoryPromptPresentations(input) {
      calls.push(input);
      return { inserted: 1, updated: 0, unchanged: 0, skipped: 0 };
    },
  };
  const result = cloneCodexPromptPresentationsForProvenChild(store, {
    sourceSessionId: 'source',
    childSessionId: 'child',
    sourceRecords: [codexUser(1, '2026-07-24T01:00:00Z', 'copied')],
    childRecords: [codexUser(8, '2026-07-24T01:00:00Z', 'copied')],
  });

  assert.equal(result.cloned, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entryMappings[0].sourceEntryUuid, 'codex-user-source-1');
  assert.equal(calls[0].entryMappings[0].childEntryUuid, 'codex-user-child-8');
});
