'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createTerminalHistoryPreviewController } = require('./terminal-history-preview-controller');
const { createProviderSemanticShadow } = require('./provider-semantic-shadow');
const { createCodexCanonicalPresentation } = require('./codex-canonical-presentation');
const { canonicalSourceTicket, canonicalRecordDigest, verifyCanonicalSourceSpan } = require('./codex-canonical-source-proof');
const { readCodexTurnAppend } = require('./codex-turn-append-reader');
const previewGuards = require('./codex-provider-preview');
const outcomes = require('./codex-turn-outcome');

const mainPath = process.env.CANONICAL_PRESENTATION_BASELINE_MAIN || path.join(__dirname, 'main.js');
const tree = ts.createSourceFile(mainPath, fs.readFileSync(mainPath, 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = new Map(tree.statements.filter(ts.isFunctionDeclaration).map(n => [n.name?.text, n.getText(tree)]));
const names = ['observeCodexProviderPreviewRawRecord', 'handleCodexProviderSemanticEvent',
  'codexCanonicalPresentationScope', 'currentCodexProviderSemanticOwnerContext',
  'getCodexWriterProofSnapshot', 'codexEventType', 'codexLiveUuid', 'codexLiveSourceIdentity',
  'extractCodexLiveText', 'buildCodexLiveRawMessage', 'codexLiveUserCarrierKind',
  'projectCodexLiveMessageForPublication', 'publishCodexLiveProjection',
  'publishCodexSuppressedCatchUpRelease', 'processCodexTurnLine', 'processCodexTurnText', 'scanCodexTurnAppend'];

async function fixture(t, { maxEntries, maxBytes, verify } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-presentation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'fixture.jsonl');
  const terminal = {}, mirror = { generation: 'mirror', generationOrdinal: 1 };
  const state = { tabId: 'T', sessionId: 'physical', filePath, processGeneration: 'G',
    sourceObservationLaunchId: 'L', processGenerationBoundaryOffset: 0, catchUpGeneration: 0,
    sourceObservationTerminal: terminal, sourceObservationRunSeq: 1, deferredUntilComposer: false,
    publicTurnStateSuppressed: true, catchUpPublicationsSuppressed: true,
    busy: true, liveTurnEvents: 1, currentTurnId: 'TURN', lastEventType: 'task_started',
    lastOutcomeReason: 'task_started', partial: '', partialStartOffset: 0, offset: 0 };
  const owner = { sourceId: 'S', launchId: 'L', terminalToken: terminal, runSeq: 1,
    lifecycleGeneration: 'G', turnId: 'TURN', turnActive: true };
  const rows = [], web = [], runtime = [], logs = [], frames = [], transport = [], timers = new Map();
  let timerId = 0, sourceVersion = 0;
  const log = { log: s => logs.push(s), warn: s => logs.push(s), error: s => logs.push(s) };
  const context = {
    require, Buffer, structuredClone, path, fs, readCodexTurnAppend, srcMainDir: __dirname, console: log,
    terminals: new Map([['T', terminal]]), terminalHeadlessMirrors: new Map([['T', mirror]]),
    terminalCommandState: new Map([['T', { runSeq: 1 }]]),
    codexLastRunCommandPayload: new Map([['T', { launchId: 'L' }]]),
    codexProviderSemanticSources: new Map([['T', owner]]), codexTurnWatchers: new Map([['T', state]]),
    codexKnownSessions: new Map(), codexWriterProofs: new Map(), codexWatchers: new Map(),
    stopRevision: 0, getTerminalStopRevision: () => context.stopRevision,
    getTerminalLifecycleGeneration: () => 'G', terminalHistoryStreamingEnabled: true,
    readTerminalHistoryPreviewFrame: () => ({ status: 'unknown' }),
    emitTerminalHistoryPreview: detail => { frames.push(detail);
      transport.push({ channel: 'agent-transcript:terminal-preview', detail: structuredClone(detail) }); },
    createTerminalHistoryPreviewController: options => createTerminalHistoryPreviewController({ ...options,
      setTimer: fn => { timers.set(++timerId, fn); return timerId; }, clearTimer: id => timers.delete(id) }),
    ...previewGuards, ...outcomes,
    safelyObserveProviderSemantic: (_action, fn) => fn(),
    publishCodexProviderTurnActivity: detail => { owner.turnId = detail.turnId; owner.turnActive = detail.active; },
    compactOperations: { getActive: () => null },
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, detail) => {
      rows.push({ channel, detail }); transport.push({ channel, detail: structuredClone(detail) }); } } },
    _webBroadcast: (_tab, envelope) => web.push(envelope),
    clearCodexPromptInFlight: () => context.codexLastRunCommandPayload.delete('T'),
    finishCodexStartupLifecycle: () => {}, markCodexTuiReadyFromTurnEnd: () => {},
    emitCodexBusy: (_tab, busy) => runtime.push({ kind: 'busy', busy }),
    broadcastCodexPublicRuntimeSnapshot: () => runtime.push({ kind: 'snapshot' }),
    emitCodexTurnStateResolved: () => runtime.push({ kind: 'resolved', rowCount: rows.length }),
    // Unrelated operational/subagent/audit participants are recording/no-op
    // dependencies. None can supply canonical ACK or presentation publication.
    codexNativeQuestionMirror: { observeRecord: () => {} },
    recordCodexLiveSubagentOwnership: () => {}, trackCodexTabSubagentActivity: () => {},
    observeCodexPromptAuditCarrier: () => {}, observeCodexCapacityRetryRecord: () => {},
    buildCodexHistoryLiveCompactEntry: () => null,
    ...require('./compact-operation-state'),
    reconcileCodexManualCompactPendingOwner: () => null,
  };
  vm.createContext(context);
  vm.runInContext(names.filter(n => declarations.has(n)).map(n => declarations.get(n)).join('\n'), context);
  const controllerNode = tree.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name?.getText(tree) === 'terminalHistoryPreviewController'));
  vm.runInContext(controllerNode.getText(tree) + '\nglobalThis.controller = terminalHistoryPreviewController;', context);
  const controller = context.controller;
  const continuationWiring = tree.statements.find(node => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && node.expression.left.getText(tree) === 'codexCanonicalPresentation');
  context.createCodexCanonicalPresentation = options => createCodexCanonicalPresentation({ ...options, maxEntries, maxBytes,
    ...(verify ? { verify } : {}) });
  if (continuationWiring) vm.runInContext(continuationWiring.getText(tree), context);
  else context.codexCanonicalPresentation = createCodexCanonicalPresentation({
    getScope: tab => context.codexCanonicalPresentationScope?.(tab), getController: () => controller,
    maxEntries, maxBytes, verify,
    log: (action, fields) => logs.push(action + ' ' + JSON.stringify(fields)),
    publish: (watcher, record, identity, digest, token) => {
      record.__canonicalRawDigest = digest;
      const message = context.buildCodexLiveRawMessage(watcher, record);
      assert.equal(message.sourceIdentity, identity);
      const projected = context.projectCodexLiveMessageForPublication(watcher, record, message).projections[0];
      return context.publishCodexLiveProjection(watcher, record, projected, token);
    },
  });
  // The original source has no continuation hook. That cut remains a useful
  // RED control, not a replacement implementation of the publication seam.
  context.observeTerminalHistoryCanonicalLiveMessage = detail => controller.observeCanonical({
    tabId: detail.tabId, provider: 'codex', sessionId: detail.sessionId,
    sourceEndOffset: detail.recordByteOffset + 1, identity: detail.message.sourceIdentity,
    semanticItemId: detail.message.semanticItemId,
    canonicalText: detail.message.message.content.filter(x => x.type === 'text').map(x => x.text).join('\n'),
  });
  context.providerSemanticShadow = createProviderSemanticShadow({ log,
    onCodexSemanticEvent: detail => context.handleCodexProviderSemanticEvent(detail) });
  controller.activateSemanticSource({ tabId: 'T', instanceId: 'S' });
  const connection = context.providerSemanticShadow.createCodexConnection({ tabId: 'T', sourceId: 'S' });
  connection.beginRequest({ turn_id: 'TURN', thread_id: 'transport-thread' });
  const send = value => connection.observeServerFrame(JSON.stringify(value));
  const text = '«Проверенная доступность» означала: тест нашёл карточку под координатами клика и смог выбрать её и открыть переименование. Это техническая отметка теста, а не отдельное состояние интерфейса.\n\nТеперь проверю другой симптом: задержку первого скролла после перехода, особенно при загрузке History и стриминге соседних чатов. Фоновые процессы могут влиять через CPU, обработку событий и обновления интерфейса; утверждать, что Terminal MCP совсем не влияет, нельзя. Начну с сохранённых результатов и эпизода 14:00–14:01 BKK, то есть 07:00–07:01 UTC.';
  const raw = { type: 'response_item', timestamp: '2026-10-17T07:03:38.408Z',
    payload: { id: 'ITEM', type: 'message', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text }] } };
  const bytes = Buffer.from(JSON.stringify(raw) + '\n'); fs.writeFileSync(filePath, bytes);
  const stat = fs.statSync(filePath), identity = 'codex-assistant-source-physical-0';
  const ticket = canonicalSourceTicket({ filePath, stat, start: 0, bytes,
    isCurrent: () => sourceVersion === 0 });
  const detail = { tabId: 'T', toolType: 'codex', sessionId: 'physical', filePath,
    recordByteOffset: 0, recordEndByteOffset: bytes.length, sourceTicket: ticket,
    message: { ...structuredClone(raw), __byteOffset: 0 } };
  const providerItem = () => {
    send({ type: 'response.created', response: { id: 'RESPONSE' } });
    send({ type: 'response.output_text.delta', response_id: 'RESPONSE', item_id: 'ITEM', delta: text });
  };
  const observe = (value = detail) => context.observeCodexProviderPreviewRawRecord(value);
  const append = (record) => {
    const start = fs.statSync(filePath).size, buffer = Buffer.from(JSON.stringify(record) + '\n');
    fs.appendFileSync(filePath, buffer);
    return { ...detail, recordByteOffset: start, recordEndByteOffset: start + buffer.length,
      sourceTicket: canonicalSourceTicket({ filePath, stat: fs.statSync(filePath), start, bytes: buffer,
        isCurrent: () => sourceVersion === 0 }), message: { ...record, __byteOffset: start } };
  };
  const release = async ({ read = true, scan = false, target = fs.statSync(filePath).size } = {}) => {
    context.codexKnownSessions.set('T', 'physical');
    context.codexWriterProofs.set('T', { valid: true, sessionId: 'physical', filePath,
      terminalToken: terminal, runSeq: 1, lifecycleGeneration: 'G', launchId: 'L', actionGeneration: 'L' });
    state.offset = target; state.sourceWriterReplayOffset = read ? 0 : null;
    state.sourceWriterReplayPartial = ''; state.sourceWriterReplayPartialStartOffset = 0;
    outcomes.prepareCodexSourceProofReplay(state);
    context.codexCanonicalPresentation.bindRelease(state);
    if (scan) { await context.scanCodexTurnAppend('T', 'fixture'); return; }
    if (read) {
      const end = fs.statSync(filePath).size;
      const result = await readCodexTurnAppend({ filePath, start: 0, end,
        onBatch: batch => context.processCodexTurnText(state, batch.buffer, batch.start, {
          preferredUserAuditOffsets: new Set(), deferCompactFinalization: true }) });
      state.offset = end; context.codexCanonicalPresentation.scanCommitted(state, result);
    }
    const proof = outcomes.completeCodexSuppressedCatchUpRelease(state, { scanSucceeded: true });
    await context.publishCodexSuppressedCatchUpRelease('T', state, proof, 'fixture');
  };
  return { context, controller, state, owner, rows, web, runtime, logs, frames, transport, raw, bytes, detail,
    text, send, providerItem, observe, append, release, connection, filePath, identity,
    revokeSource: () => sourceVersion++,
    flushTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

for (const order of ['provider-first', 'raw-first-no-state', 'raw-first-existing-state']) {
  test(`actual Main suppressed capture/replay/release publishes once: ${order}`, async t => {
    const f = await fixture(t);
    if (order === 'provider-first') { f.providerItem(); f.flushTimers(); }
    const liveEnd = f.transport.length;
    if (order === 'raw-first-existing-state') {
      f.send({ type: 'response.output_text.delta', item_id: 'OTHER', delta: 'other still live' });
    }
    f.observe();
    f.flushTimers();
    const heldEnd = f.transport.length;
    if (order !== 'provider-first') f.providerItem();
    // Incident order: exact raw ACK, then Responses completion, then a tool
    // and another request in the SAME still-busy turn, then writer release.
    f.send({ type: 'response.completed', response: { id: 'RESPONSE', output: [{
      id: 'ITEM', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: f.text }],
    }] } });
    f.append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'TOOL', name: 'shell', input: '{}' } });
    f.connection.beginRequest({ turn_id: 'TURN', thread_id: 'transport-thread' });
    f.flushTimers();
    await f.release(); f.flushTimers();
    const canonical = f.rows.filter(r => r.channel === 'agent-transcript:live-message');
    assert.equal(canonical.length, 1);
    assert.equal(canonical[0].detail.message.sourceIdentity, f.identity);
    assert.equal(canonical[0].detail.message.semanticItemId, 'ITEM');
    assert.equal(canonical[0].detail.message.textPhase, 'commentary');
    assert.equal(canonical[0].detail.message.message.content[0].text, f.text);
    assert.equal(f.web.length, 1);
    assert.equal(f.runtime.find(x => x.kind === 'resolved').rowCount, 1);
    assert.equal(f.owner.turnActive, true);
    if (order === 'raw-first-existing-state') assert.equal(f.controller.get('T').text, 'other still live');
    else assert.equal(f.controller.get('T'), null);
    f.observe(); await f.context.codexCanonicalPresentation.drain('T');
    assert.equal(f.rows.length, 1, 'duplicate raw/release wake cannot append another row');
    if (order === 'provider-first' && process.env.CANONICAL_PRESENTATION_UI_EVENTS) {
      fs.writeFileSync(process.env.CANONICAL_PRESENTATION_UI_EVENTS, JSON.stringify({
        sourceMain: mainPath, mainHash: canonicalRecordDigest(fs.readFileSync(mainPath)),
        controllerHash: canonicalRecordDigest(fs.readFileSync(require.resolve('./terminal-history-preview-controller'))),
        providerHash: canonicalRecordDigest(fs.readFileSync(require.resolve('./provider-semantic-shadow'))),
        mainClosure: Object.fromEntries(['main.js', 'provider-semantic-shadow.js', 'terminal-history-preview-controller.js',
          'session-transcript-service.js', 'codex-turn-append-reader.js', 'codex-canonical-presentation.js',
          'codex-canonical-source-proof.js'].map(file => [file, canonicalRecordDigest(fs.readFileSync(path.join(__dirname, file)))])),
        identity: f.identity, itemId: 'ITEM', text: f.text, tabId: 'T', sessionId: 'physical',
        live: f.transport.slice(0, liveEnd), held: f.transport.slice(liveEnd, heldEnd),
        released: f.transport.slice(heldEnd), runtime: f.runtime,
      }, null, 2));
    }
  });
}

test('release before provider ACK drains only presentation, not runtime a second time', async t => {
  const f = await fixture(t); f.observe(); await f.release();
  assert.equal(f.rows.length, 0);
  const runtime = f.runtime.length;
  f.providerItem(); await f.context.codexCanonicalPresentation.drain('T');
  assert.equal(f.rows.length, 1); assert.equal(f.runtime.length, runtime);
});

test('source proof revoked after capture preserves materialized presentation text', async t => {
  const f = await fixture(t); f.providerItem(); f.observe(); f.revokeSource(); await f.release();
  assert.equal(f.rows.length, 0);
  assert.equal(f.controller.get('T').text, f.text);
  assert.equal(f.controller.get('T').responseSegments[0].deliveryState, 'saved');
});

test('no-replay needs a real complete source ticket; missing ticket retains text', async t => {
  const f = await fixture(t); f.providerItem(); f.observe(); await f.release({ read: false });
  assert.equal(f.rows.length, 1);
  const bad = await fixture(t); bad.providerItem(); delete bad.detail.sourceTicket;
  bad.observe(); await bad.release({ read: false });
  assert.equal(bad.rows.length, 0); assert.equal(bad.controller.get('T').text, bad.text);
});

test('Stop during point verification prevents dispatch after await', async t => {
  let resume;
  const f = await fixture(t, { verify: () => new Promise(resolve => { resume = resolve; }) });
  f.providerItem(); f.observe(); const release = f.release({ read: false });
  while (!resume) await new Promise(setImmediate);
  f.context.stopRevision++;
  resume({ ok: true }); await release;
  assert.equal(f.rows.length, 0);
  assert(!f.runtime.some(event => event.kind === 'resolved'), 'old release cannot emit resolved after Stop during its await');
});

test('late reconciliation after a tool boundary consumes its original receipt once', async t => {
  const f = await fixture(t);
  f.send({ type: 'response.output_text.delta', item_id: 'OTHER', delta: 'other' });
  f.observe();
  f.controller.observeBoundary({ tabId: 'T', provider: 'codex', sessionId: 'physical',
    sourceEndOffset: f.bytes.length + 500, identity: 'tool-boundary', kind: 'tool-use' });
  f.providerItem(); await f.release();
  assert.equal(f.rows.length, 1);
  assert.equal(f.controller.get('T').text, 'other');
});

test('candidate after release target belongs to the actually completed range', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  const secondText = 'second canonical';
  f.send({ type: 'response.output_text.delta', item_id: 'SECOND', delta: secondText });
  const next = f.append({ ...f.raw, payload: { ...f.raw.payload, id: 'SECOND',
    content: [{ type: 'output_text', text: secondText }] } });
  f.observe(next); await f.release({ target: f.bytes.length });
  assert.equal(f.rows.length, 2);
  assert.equal(f.rows[1].detail.recordByteOffset, f.bytes.length);
});

test('ordinary publication on either side of continuation has one dispatch identity', async t => {
  for (const before of [true, false]) {
    const f = await fixture(t); f.providerItem(); f.observe();
    const normal = () => {
      const record = { ...structuredClone(f.raw), __byteOffset: 0,
        __canonicalRawDigest: canonicalRecordDigest(f.bytes) };
      const message = f.context.buildCodexLiveRawMessage(f.state, record);
      const projection = f.context.projectCodexLiveMessageForPublication(f.state, record, message).projections[0];
      return f.context.publishCodexLiveProjection(f.state, record, projection);
    };
    if (before) normal();
    await f.release({ read: false }); normal();
    assert.equal(f.rows.length, 1); assert.equal(f.web.length, 1);
  }
});

test('bounded overflow preserves complete previous text and independent canonical ACK', async t => {
  for (const budget of [{ maxEntries: 1 }, { maxBytes: 1 }]) {
    const f = await fixture(t, budget); f.providerItem(); f.observe();
    if (budget.maxEntries) {
      f.send({ type: 'response.output_text.delta', item_id: 'SECOND', delta: 'second full text' });
      f.observe(f.append({ ...f.raw, payload: { ...f.raw.payload, id: 'SECOND',
        content: [{ type: 'output_text', text: 'second full text' }] } }));
    }
    await f.release({ read: false });
    const preview = f.controller.get('T');
    assert.equal(preview.text, budget.maxEntries ? 'second full text' : f.text);
    assert.equal(preview.responseSegments[0].deliveryState, 'saved');
    assert(f.logs.some(line => line.includes(budget.maxEntries ? 'entry-budget' : 'byte-budget')));
    const snapshot = f.context.codexCanonicalPresentation.snapshot('T');
    assert(snapshot.bytes <= (budget.maxBytes || 2 * 1024 * 1024));
    assert(snapshot.entries <= (budget.maxEntries || 32));
  }
});

test('same SID source replacement and same-inode rewrite with growth never publish the old record', async t => {
  for (const mode of ['inode', 'rewrite-growth', 'observed-aba']) {
    const f = await fixture(t); f.providerItem(); f.observe();
    if (mode === 'inode') {
      const replacement = f.filePath + '.replacement'; fs.writeFileSync(replacement, f.bytes); fs.renameSync(replacement, f.filePath);
    } else if (mode === 'rewrite-growth') {
      const changed = Buffer.from(f.bytes), offset = changed.indexOf(Buffer.from('Terminal'));
      assert(offset >= 0); changed[offset] = 'X'.charCodeAt(0);
      fs.writeFileSync(f.filePath, Buffer.concat([changed, Buffer.from('{}\n')]));
    } else f.revokeSource();
    await f.release({ read: false });
    assert.equal(f.rows.length, 0); assert.equal(f.controller.get('T').text, f.text);
  }
});

test('failed final read cannot be repaired by an empty release retry', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.context.codexCanonicalPresentation.scanFailed(f.state);
  f.context.codexCanonicalPresentation.scanCommitted(f.state, { stats: { bytes: 0 }, sourceProof: {} });
  await f.release({ read: false });
  assert.equal(f.rows.length, 0); assert.equal(f.context.codexCanonicalPresentation.snapshot('T').failed, true);
});

test('valid writer revalidation and disposable launch cleanup do not invalidate the continuation', async t => {
  let resume;
  const f = await fixture(t, { verify: () => new Promise(resolve => { resume = resolve; }) });
  f.providerItem(); f.observe(); const done = f.release({ read: false });
  while (!resume) await new Promise(setImmediate);
  const proof = f.context.codexWriterProofs.get('T');
  f.context.codexWriterProofs.set('T', { ...proof, at: Date.now() });
  assert.equal(f.context.codexLastRunCommandPayload.has('T'), false);
  resume({ ok: true }); await done; assert.equal(f.rows.length, 1);
});

test('invalid writer, pending handoff and replacement owner prevent new publication', async t => {
  for (const mutation of [
    f => f.context.codexWriterProofs.get('T').valid = false,
    f => f.context.codexWatchers.set('T', { sourceMode: 'writer-handoff' }),
    f => f.context.terminals.set('T', {}),
    f => f.owner.turnId = 'OTHER-TURN',
  ]) {
    let resume;
    const f = await fixture(t, { verify: () => new Promise(resolve => { resume = resolve; }) });
    f.providerItem(); f.observe(); const done = f.release({ read: false });
    while (!resume) await new Promise(setImmediate);
    mutation(f); resume({ ok: true }); await done; assert.equal(f.rows.length, 0);
  }
});

test('manual conflict is not legalized retroactively by later promotion', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.state.manualBindingConflict = {};
  f.context.codexCanonicalPresentation.afterMutation('T', 'scope');
  f.state.manualBindingConflict = null;
  await f.release({ read: false }); assert.equal(f.rows.length, 0);
});

test('normal response segment completion does not release a pending whole-turn continuation', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.send({ type: 'response.completed', response: { id: 'RESPONSE', output: [] } });
  await f.context.codexCanonicalPresentation.drain('T');
  assert.equal(f.rows.length, 0); assert.equal(f.owner.turnActive, true);
});

test('a changed candidate object cannot borrow the full-record source digest', async t => {
  const f = await fixture(t); f.providerItem();
  const forged = structuredClone(f.detail.message);
  forged.payload.content[0].text = 'changed prose';
  f.observe({ ...f.detail, message: forged }); await f.release({ read: false });
  assert.equal(f.rows.length, 0); assert.equal(f.controller.get('T').text, f.text);
});

test('actual append scan completes presentation before resolved and without another scan', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  let reads = 0;
  f.context.readCodexTurnAppend = async options => { reads++; return readCodexTurnAppend(options); };
  await f.release({ scan: true });
  assert.equal(reads, 1); assert.equal(f.rows.length, 1);
  assert.equal(f.runtime.find(x => x.kind === 'resolved').rowCount, 1);
});

test('real final validation failure plus empty retry retains the presentation hold', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.context.readCodexTurnAppend = options => readCodexTurnAppend({ ...options,
    onBatch: async (...args) => {
      await options.onBatch(...args);
      const replacement = f.filePath + '.replacement';
      fs.writeFileSync(replacement, f.bytes); fs.renameSync(replacement, f.filePath);
    },
  });
  await f.release({ scan: true });
  assert.equal(f.rows.length, 0);
  assert(f.logs.some(line => line.includes('scan failed')));
  f.context.readCodexTurnAppend = readCodexTurnAppend;
  await f.context.scanCodexTurnAppend('T', 'empty-retry');
  assert.equal(f.rows.length, 0);
  assert.equal(f.context.codexCanonicalPresentation.snapshot('T').failed, true);
  assert.equal(f.controller.get('T').text, f.text);
});

test('continuation never re-enters the user/tool/lifecycle line consumer', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.append({ type: 'event_msg', payload: { type: 'user_message', message: 'must not be replayed' } });
  f.append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'TOOL', input: 'no' } });
  f.append({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'TURN' } });
  f.context.processCodexTurnLine = () => { throw new Error('continuation re-entered line consumer'); };
  await f.release({ read: false });
  assert.equal(f.rows.length, 1); assert.equal(f.web.length, 1);
  assert.equal(f.owner.turnActive, true);
});

test('held canonical text is stable under late provider bytes, with no per-token continuation work', async t => {
  const f = await fixture(t); f.providerItem(); f.observe();
  f.send({ type: 'response.output_text.delta', response_id: 'RESPONSE', item_id: 'ITEM', delta: 'late duplicate' });
  assert.equal(f.controller.get('T').text, f.text);
  let probes = 0;
  const scope = f.context.codexCanonicalPresentationScope;
  f.context.codexCanonicalPresentationScope = (...args) => { probes++; return scope(...args); };
  for (let i = 0; i < 50; i++) f.send({ type: 'response.output_text.delta', item_id: 'OTHER', delta: '.' });
  assert.equal(probes, 0, 'already ACKed hold does not scan its queue/owner on every token');
  await f.release();
  assert.equal(f.rows.length, 1);
  assert.equal(f.controller.get('T').text, '.'.repeat(50));
});

test('default count budget retains entry 33 without truncation or an emergency raw list', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 33; i++) {
    const id = i ? `ITEM-${i}` : 'ITEM', text = i ? `complete ${i}` : f.text;
    f.send({ type: 'response.output_text.delta', item_id: id, delta: text });
    f.observe(i ? f.append({ ...f.raw, payload: { ...f.raw.payload, id,
      content: [{ type: 'output_text', text }] } }) : f.detail);
  }
  await f.release({ read: false });
  assert.equal(f.rows.length, 32);
  assert.equal(f.controller.get('T').text, 'complete 32');
  assert.deepEqual(f.context.codexCanonicalPresentation.snapshot('T'), {
    entries: 32, bytes: 0, failed: false, released: true,
  });
});

test('default byte budget and oversized single record keep canonical text, not truncated rows', async t => {
  for (const oversized of [false, true]) {
    const f = await fixture(t);
    const size = oversized ? 2 * 1024 * 1024 : 1100 * 1024;
    const text = 'x'.repeat(size);
    const ids = oversized ? ['BIG'] : ['BIG', 'BIG-SECOND'];
    for (const id of ids) {
      f.send({ type: 'response.output_text.delta', item_id: id, delta: text });
      f.observe(f.append({ ...f.raw, payload: { ...f.raw.payload, id,
        content: [{ type: 'output_text', text }] } }));
    }
    const before = f.context.codexCanonicalPresentation.snapshot('T');
    assert(before.bytes <= 2 * 1024 * 1024);
    await f.release({ read: false });
    assert.equal(f.rows.length, oversized ? 0 : 1);
    const preview = f.controller.get('T');
    assert.equal(preview.text, text.slice(-preview.text.length));
    assert.equal(preview.responseSegments[0].deliveryState, 'saved');
    const retained = f.controller.getDiagnosticState('T').semanticItems.find(item => item.itemId === ids.at(-1));
    assert.equal(retained.chars, text.length, 'full canonical item survives the existing preview display cap');
  }
});

test('normal publication during point verification wins without duplicate dispatch or false unknown', async t => {
  let resume;
  const f = await fixture(t, { verify: () => new Promise(resolve => { resume = resolve; }) });
  f.providerItem(); f.observe(); const done = f.release({ read: false });
  while (!resume) await new Promise(setImmediate);
  f.context.processCodexTurnLine(f.state, f.bytes.subarray(0, -1).toString('utf8'), 0);
  assert.equal(f.rows.length, 1);
  resume({ ok: true }); await done;
  assert.equal(f.rows.length, 1); assert.equal(f.controller.get('T'), null);
  assert(!f.logs.some(line => line.includes('dispatch-unknown')));
});

test('a committed source wake during verification is coalesced, not lost or polled', async t => {
  let resume, checks = 0;
  const f = await fixture(t, { verify: (ticket, current) => ++checks === 1
    ? new Promise(resolve => { resume = resolve; }) : verifyCanonicalSourceSpan(ticket, current) });
  f.providerItem(); f.observe(); const done = f.release({ read: false });
  while (!resume) await new Promise(setImmediate);
  const read = await readCodexTurnAppend({ filePath: f.filePath, start: 0, end: f.bytes.length, onBatch() {} });
  f.context.codexCanonicalPresentation.scanCommitted(f.state, read);
  resume({ ok: false, reason: 'source-changed-during-verification' });
  await done; await f.context.codexCanonicalPresentation.drain('T');
  assert.equal(checks, 2); assert.equal(f.rows.length, 1);
});
