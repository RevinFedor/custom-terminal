'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { PromptQueueAssetStore, normalizeAssetId } = require('./prompt-queue-assets');
const { AgentSendQueue, readQueuedSendAssetIds, forgetCollectedUploadAliases } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const registry = require('./agent-send-receipt-registry');
const ownership = require('./owned-mobile-attachments');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { buildCodexImagePastePlan, CodexImageTransport } = require('./codex-image-transport');
const { prepareClaudePromptTransport } = require('./claude-prompt-transport');
const { createCodexImageRequestProjection, projectCodexImageAuditToRequest } = require('./codex-image-request-projection');
const { projectClaudePromptAuditToRequest } = require('./claude-prompt-request-projection');
const { isLocalSlashCommandPrompt } = require('./agent-history-send-receipt');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { compactSendReceiptPresentation } = require('./compact-send-settlement');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
const mainTree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declared = (ast, name) => {
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const mainBlock = (start, end) => {
  const at = main.indexOf(start), to = main.indexOf(end, at);
  assert.ok(at > 0 && to > at, start); return main.slice(at, to);
};

async function fixture(t, provider = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-mobile-send-test-'));
  const temp = path.join(directory, 'temp');
  const assetRoot = path.join(directory, 'user data with spaces', 'prompt-queue-assets');
  const databasePath = path.join(directory, 'queue.sqlite');
  const writes = [], staged = [];
  let ready = false, beforeWrite = null;
  let db, store, queue;
  const ctx = vm.createContext({
    fs, path, crypto, Buffer, Date, console: { log() {}, warn() {}, error() {} },
    ...registry, ...ownership, ...require('./structured-authoring'),
    promptAuditFingerprint, buildCodexImagePastePlan, isLocalSlashCommandPrompt,
    compactSendReceiptPresentation, classifyAgentSendReceipt,
    AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
    app: { getPath: kind => kind === 'temp' ? temp : path.dirname(assetRoot) },
    mobileAttachmentIndex: new Map(), mobileAttachmentAssetStore: new PromptQueueAssetStore({ rootDir: assetRoot }),
    MOBILE_ATTACHMENT_MAX_BYTES: 25 * 1024 * 1024, MOBILE_ATTACHMENT_PREVIEW_MAX_BYTES: 12 * 1024 * 1024,
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    decId: decodeURIComponent, shortId: value => value, agentSendBridgeTimeoutMs: 1000,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry(),
    tabWorkContext: null, withPromptOriginPresentation: value => value,
    agentSendTargetPreconditionFailure: require('./agent-send-target-precondition').agentSendTargetPreconditionFailure,
    readAgentRuntimeSnapshot: null,
    findOrchestrationTabDescriptor: () => ({ tabId: 'T', projectId: 'P', toolType: provider, sessionId: 'S' }),
    ensureExplicitAgentTabOpen: async () => ({ descriptor: { projectId: 'P', toolType: provider, sessionId: 'S' } }),
    resolveProjectAgentModelRequest: async () => ({}), projectManager: {},
    resolveSendPromptPresentation: async (_manager, _body, prompt) => ({ prompt, promptChips: [], contextFiles: [] }),
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
    sendSendFailure: (res, data) => ctx.sendJson(res, 409, { ok: false, ...data }),
    sendDeliveryUnknown: (res, data) => ctx.sendJson(res, 202, { ok: true, ...data }),
    sendAuditPending: (res, data) => ctx.sendJson(res, 202, { ok: true, ...data }),
    isAgentSendProviderQueueAccepted: () => false,
  });
  for (const name of ['mobileAttachmentRoot', 'sanitizeMobileAttachmentName', 'normalizeMobileAttachmentKind',
    'inferMobileAttachmentMimeType', 'safeMobileAttachmentPath', 'removeMobileAttachment', 'storeMobileAttachment',
    'sendAttachmentError', 'findOwnedMobileUpload', 'normalizeSendAttachments', 'appendAttachmentsToPrompt', 'readMobileAttachmentPreview',
    'prepareMobileSendOwnership', 'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
    'publicAgentSendReceipt', 'durableAgentSendFailure', 'runAgentSendScenario', 'runPreparedAgentSendScenario']) {
    vm.runInContext(declared(tree, name), ctx);
  }
  const native = vm.createContext({ fs, path, console: ctx.console, buildCodexImagePastePlan,
    mediaTypeFromImagePath: () => 'image/png', codexImageTransport: new CodexImageTransport({ rootDir: path.join(directory, 'aliases') }) });
  for (const name of ['stageCodexImagePathForPasteSync', 'prepareCodexImagePathMarkersForPaste']) {
    vm.runInContext(declared(mainTree, name), native);
  }
  ctx.bridgeRequest = async (_action, input) => {
    const record = store.get(input.sendOperationKey);
    assert.equal(record.state, 'in-flight');
    const physical = vm.createContext({ ...ownership, console: ctx.console,
      destinationRecord: record, durableRawPrompt: input.prompt, content: input.prompt,
      responsePreflightEngine: provider, promptQueueAssetStore: ctx.mobileAttachmentAssetStore,
      presentationSnapshot: input.presentationSnapshot, ownedAttachmentTransport: null,
      leasePromptQueueAssetRefs: refs => assert.ok(refs.every(ref => ref.assetId && ref.availability === 'available')),
    });
    // Execute Main's actual owned-byte admission and pre-Enter persistence,
    // not a test-only reconstruction of those two critical boundaries.
    const refused = await vm.runInContext('(async () => {' + mainBlock(
      '  if (destinationRecord?.receipt?.ownedAttachments) {',
      '  if (requiresImagePathValidation && !presentationSnapshot?.authoringTransport) {') + '})()', physical);
    if (refused) return refused;
    const prepared = physical.ownedAttachmentTransport;
    assert.ok(prepared);
    const plan = provider === 'codex'
      ? native.prepareCodexImagePathMarkersForPaste('T', prepared.text, 'codex-project-api', prepared.authoringTransport, prepared.imageRefs)
      : { text: prepareClaudePromptTransport(prepared.text).transport.text, segments: null, staged: [] };
    const boundary = { sessionId: 'S', fileSize: 0 };
    Object.assign(physical, {
      agentSendReceiptStore: store, createCodexImageRequestProjection,
      sendOperationKey: record.operationKey, sendAttemptId: record.attemptId, handoffId: record.handoffId,
      broadcastTabId: 'T', isCodexPasteSource: provider === 'codex', source: input.source,
      durablePreSubmitBoundary: null, captureCodexPromptAuditBoundary: () => boundary,
      claudeAuditBoundary: boundary, expectedDestination: null, codexImageRequestProjection: null,
      content: plan.text, codexImagePasteSegments: plan.segments, stagedCodexImageRefs: plan.staged,
      normalizedPresentationSnapshot: input.presentationSnapshot,
    });
    const stageResult = vm.runInContext('(() => {' + mainBlock(
      '  if (sendOperationKey && sendAttemptId) {\n    durablePreSubmitBoundary = isCodexPasteSource',
      '\n  if (shouldStageClaudeAudit') + '})()', physical);
    if (stageResult) return stageResult;
    if (beforeWrite) await beforeWrite({ record: store.get(record.operationKey), input, prepared, plan });
    for (const [index, ref] of prepared.imageRefs.entries()) {
      if (!ref || ref.unowned) continue;
      const alias = plan.segments?.filter(segment => segment.kind === 'image')[index]?.text;
      if (provider === 'codex') assert.equal(fs.realpathSync(alias), fs.realpathSync(ref.path));
    }
    writes.push({ prompt: plan.text, original: input.prompt, prepared });
    staged.push(store.get(record.operationKey));
    store.markAttemptState(record.operationKey, record.attemptId, 'enter-armed');
    return { success: null, submitted: true, status: 'audit-pending', auditPending: true };
  };
  const open = () => {
    db = new Database(databasePath); store = createAgentSendReceiptStore(db);
    ctx.agentSendReceiptStore = store;
    queue = new AgentSendQueue({ store, ready: () => ready, execute: request => ctx.runPreparedAgentSendScenario({
      ...request, applicationQueueExecution: true,
    }) });
    ctx.agentSendQueue = queue;
  };
  open();
  const uploadStart = web.indexOf("if (parsed.pathname === '/api/mobile-attachments' && req.method === 'POST')");
  const uploadEnd = web.indexOf("if (parsed.pathname === '/api/app-settings'", uploadStart);
  const sendStart = web.indexOf("m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/send-receipts$/)");
  const sendEnd = web.indexOf("m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/codex\\/goal$/)", sendStart);
  assert.ok(uploadStart > 0 && uploadEnd > uploadStart && sendStart > 0 && sendEnd > sendStart);
  vm.runInContext('async function route(req,res,parsed) { let m;\n' + web.slice(uploadStart, uploadEnd)
    + web.slice(sendStart, sendEnd) + '\nreturn sendJson(res,404,{}); }', ctx);
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer private-fixture') { res.writeHead(401).end(); return; }
    const url = new URL(req.url, 'http://fixture');
    ctx.route(req, res, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) })
      .catch(error => { res.writeHead(500).end(JSON.stringify({ error: error.stack })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (route, body, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method, headers: { authorization: 'Bearer private-fixture', 'content-type': 'application/json' },
      ...(['DELETE', 'GET'].includes(method) ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const upload = async (name, kind, bytes) => {
    const result = await call('/api/mobile-attachments', { name, kind,
      mimeType: kind === 'image' ? 'image/png' : 'application/pdf', dataBase64: Buffer.from(bytes).toString('base64') });
    assert.equal(result.status, 200, JSON.stringify(result)); return result.data.attachment;
  };
  t.after(async () => { queue.dispose(); await tick(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, temp, assetRoot, ctx, upload, call, writes, staged,
    get store() { return store; }, get queue() { return queue; },
    url: 'http://127.0.0.1:' + server.address().port,
    request: (handoff, attachments, prompt = 'Read the attached files') => ({ prompt, attachments,
      handoffId: handoff, applicationQueue: true, source: 'codex-ios-terminal' }),
    send: body => call('/api/terminal-tabs/T/send', body),
    drain: async () => { ready = true; queue.resume(); for (let i = 0; i < 60; i++) await new Promise(resolve => setTimeout(resolve, 2)); },
    beforeWrite: callback => { beforeWrite = callback; },
    restart: () => { queue.dispose(); db.close(); ctx.mobileAttachmentIndex.clear();
      ctx.mobileAttachmentAssetStore = new PromptQueueAssetStore({ rootDir: assetRoot });
      ctx.agentSendReceiptRegistry = registry.createAgentSendReceiptRegistry(); open(); },
  };
}

for (const provider of ['codex', 'claude']) test('actual upload→early ACK→deleted source→restart→owned dispatch: ' + provider, async t => {
  const h = await fixture(t, provider);
  const image = await h.upload('same-name.png', 'image', 'image-A');
  const document = await h.upload('manual.pdf', 'file', '%PDF-document');
  const body = h.request('one', [image, document, image]);
  const result = await h.send(body);
  assert.equal(result.status, 202, JSON.stringify(result));
  assert.equal(result.data.applicationQueued, true);
  assert.equal(result.data.attachmentOwnership?.durable, true);
  assert.equal(h.writes.length, 0);
  const record = h.store.get('project:T:one');
  assert.equal(record.attemptId, null);
  const request = JSON.parse(h.queue.item(record.operationKey).request_json);
  assert.equal(request.ownedAttachments.refs.length, 3);
  assert.equal(request.ownedAttachments.refs[0].assetId, request.ownedAttachments.refs[2].assetId);
  assert.equal(normalizeAssetId(request.ownedAttachments.refs[1].assetId), null, 'documents are not image-preview IDs');
  assert.equal(h.queue.referencedAssetIds().size, 2);
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE');
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE');
  h.restart();
  assert.equal(readQueuedSendAssetIds(h.store.db).size, 2, 'startup inventory needs no running executor');
  const replay = await h.send(body);
  assert.equal(replay.status, 202);
  assert.equal(replay.data.operationKey, result.data.operationKey);
  assert.equal(h.store.list().length, 1, 'lost ACK replay did not create another operation');
  const get = await h.call('/api/terminal-tabs/T/send-receipts?handoffId=one', null, 'GET');
  assert.equal(get.status, 200); assert.equal(get.data.receipts.length, 1);
  assert.deepEqual(get.data.receipts[0].attachmentOwnership, result.data.attachmentOwnership);
  const preview = await h.call('/api/mobile-attachments/preview', { path: image.path });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(Buffer.from(preview.data.attachment.dataBase64, 'base64').toString(), 'image-A');
  await h.drain();
  assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:one')?.receipt));
  assert.equal(h.writes[0].original, request.prompt, 'authored request remains immutable');
  const assets = h.writes[0].prepared.projection.paths;
  assert.equal(fs.readFileSync(assets[0], 'utf8'), 'image-A');
  assert.equal(fs.readFileSync(assets[1], 'utf8'), '%PDF-document');
  assert.ok(h.writes[0].prompt.includes(assets[1]));
  const enteredReplay = await h.send(body);
  assert.equal(enteredReplay.data.submitted, true);
  assert.equal(h.writes.length, 1, 'unknown/entered replay never dispatches a second Enter');
  assert.equal(h.queue.referencedAssetIds().size, 2);
});

test('same filenames with different uploaded bytes keep distinct asset identities', async t => {
  const h = await fixture(t);
  const first = await h.upload('report.pdf', 'file', 'first');
  const second = await h.upload('report.pdf', 'file', 'second');
  assert.equal((await h.send(h.request('two', [first, second]))).status, 202);
  const refs = JSON.parse(h.queue.item('project:T:two').request_json).ownedAttachments.refs;
  assert.notEqual(refs[0].assetId, refs[1].assetId);
  assert.deepEqual(refs.map(ref => ref.name), ['report.pdf', 'report.pdf']);
});

test('typed image ranges preserve literal text, repeated occurrences and a frozen context prefix', async t => {
  const h = await fixture(t);
  const image = await h.upload('фото 🧩.png', 'image', 'typed image bytes');
  h.ctx.tabWorkContext = { prepare: async (_tab, _handoff, prompt) => ({ prompt: 'FROZEN CONTEXT\n\n' + prompt }),
    activate() {}, settle() {}, assertContinuationScope() {}, release() {} };
  const body = { handoffId: 'typed', applicationQueue: true, expectedToolType: 'codex', expectedSessionId: 'S',
    authoring: { version: 1, chips: [], imagePaths: [{ id: 7, path: image.path, mediaType: image.mimeType, size: image.size }],
      parts: [{ kind: 'text', text: 'Literal [imagePath: ' + image.path + '] stays text\n' },
        { kind: 'image', imageId: 7 }, { kind: 'text', text: '\nagain\n' }, { kind: 'image', imageId: 7 }] } };
  const ack = await h.send(body);
  assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.equal(ack.data.attachmentOwnership.imageOccurrences, 2);
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE');
  await h.drain();
  assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:typed').receipt));
  assert.ok(h.writes[0].prompt.includes('Literal [imagePath: ' + image.path + '] stays text'));
  assert.ok(h.writes[0].original.startsWith('FROZEN CONTEXT\n\n'));
  assert.equal(h.staged[0].receipt.imageRequestProjection.images.length, 2);
});

function structuredImages(handoffId, refs, order = refs.map(ref => ref.id)) {
  return { handoffId, applicationQueue: true, expectedToolType: 'codex', expectedSessionId: 'S',
    authoring: { version: 1, chips: [], imagePaths: refs,
      parts: [{ kind: 'text', text: 'Use these exact bytes\n' }, ...order.flatMap(imageId => [
        { kind: 'image', imageId }, { kind: 'text', text: '\n' },
      ])] } };
}

function uploadFileTextPart(file, { prefix = '📄 - [file] ' + file.name + ': ', assetId = null } = {}) {
  return { kind: 'text', text: prefix + file.path + '\n', uploadFiles: [{ path: file.path,
    start: prefix.length, end: prefix.length + file.path.length, uploadId: file.id,
    name: file.name, mediaType: file.mimeType, size: file.size, ...(assetId ? { assetId } : {}) }] };
}

for (const provider of ['codex', 'claude']) test('rich upload PDF remains typed, exact and durable through DELETE/reopen: ' + provider, async t => {
  const h = await fixture(t, provider), file = await h.upload('инструкция.pdf', 'file', '%PDF-private-opaque-bytes');
  const image = await h.upload('mixed.png', 'image', 'mixed image');
  const filePart = uploadFileTextPart(file);
  const body = { handoffId: 'rich-file', applicationQueue: true, expectedToolType: provider, expectedSessionId: 'S',
    authoring: { version: 1, chips: [{ id: 'rules', kind: 'prompt', label: 'Rules', text: 'Keep exact bytes' },
      { id: 'paste', kind: 'paste', text: 'OPAQUE PASTE' }],
    imagePaths: [{ id: 7, path: image.path }],
    parts: [{ kind: 'text', text: 'Literal ' + file.path + '\n' }, { kind: 'paste', chipId: 'paste' },
      { kind: 'text', text: '\n' }, { kind: 'image', imageId: 7 }, { kind: 'text', text: '\n' }, filePart] } };
  const before = JSON.stringify(body);
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.equal(ack.data.attachmentOwnership.files, 1); assert.equal(ack.data.attachmentOwnership.images, 1);
  const frozen = JSON.parse(h.queue.item('project:T:rich-file').request_json);
  assert.deepEqual(frozen.authoringSnapshot.parts.at(-1), filePart);
  assert.ok(frozen.prompt.includes(filePart.text.trimEnd()));
  assert.ok(!frozen.prompt.includes('Attached files from iOS'), 'no rich→plain formatter fallback');
  await h.call('/api/mobile-attachments/' + file.id, null, 'DELETE');
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE'); h.restart();
  const replay = await h.send(body); assert.equal(replay.status, 202); assert.equal(JSON.stringify(body), before);
  await h.drain(); assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:rich-file').receipt));
  assert.ok(h.writes[0].prompt.includes('Literal ' + file.path), 'only declared path span changes');
  const owned = frozen.ownedAttachments.refs.find(ref => ref.kind === 'file');
  assert.ok(h.writes[0].prompt.includes(owned.assetId));
  assert.equal(fs.readFileSync(path.join(h.assetRoot, owned.assetId), 'utf8'), '%PDF-private-opaque-bytes');
});

test('Claude known-empty owner keeps its exact claim while a typed PDF acquires ownership', async t => {
  const h = await fixture(t, 'claude'), file = await h.upload('empty.pdf', 'file', '%PDF-empty-owner');
  const db = h.store.db;
  db.exec('CREATE TABLE private_owner_state (key TEXT PRIMARY KEY, value TEXT)');
  const state = { known: true, provider: 'claude', sessionId: null, projectId: 'P', cwd: h.directory };
  const owner = new (require('./conversation-owner').ConversationOwners)({
    db: { getAppState: key => { const row = db.prepare('SELECT value FROM private_owner_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
      setAppState: (key, value) => db.prepare('INSERT OR REPLACE INTO private_owner_state VALUES (?,?)').run(key, JSON.stringify(value)) },
    capture: () => state,
  });
  owner.checkpoint('T', { operationId: 'private-cleared', toolType: 'claude', bindingCommitted: true,
    fileDeleted: true, activeSessionId: null, binding: { applied: true, mode: 'cleared', sessionId: null } }, state);
  h.ctx.conversationOwners = owner;
  const token = owner.current('T').ownerToken;
  const body = { handoffId: 'empty-pdf', applicationQueue: true, expectedToolType: 'claude',
    expectedSessionId: null, expectedBinding: 'none', ownerToken: token,
    authoring: { version: 1, chips: [], imagePaths: [], parts: [uploadFileTextPart(file)] } };
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.equal(ack.data.attachmentOwnership.files, 1);
  await h.call('/api/mobile-attachments/' + file.id, null, 'DELETE');
  await h.drain(); assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:empty-pdf').receipt));
  assert.equal(owner.stored('T').send.expectedOwnerToken, token);
  assert.equal(h.staged[0].receipt.expectedTarget.expectedBinding, 'none');
});

for (const invalid of ['span', 'foreign', 'foreign-asset', 'overlap', 'unsupported-owner']) test('typed upload declaration refuses without ACK: ' + invalid, async t => {
  const h = await fixture(t), file = await h.upload('negative.pdf', 'file', 'negative file');
  const part = uploadFileTextPart(file);
  if (invalid === 'span') part.uploadFiles[0].start++;
  if (invalid === 'overlap') part.uploadFiles.push({ ...part.uploadFiles[0] });
  if (invalid === 'foreign-asset') part.uploadFiles[0].assetId = 'f'.repeat(64) + '.document.pdf';
  if (invalid === 'foreign') {
    part.uploadFiles[0].path = '/private/outside-owner.pdf';
    part.text = part.text.slice(0, part.uploadFiles[0].start) + part.uploadFiles[0].path + '\n';
    part.uploadFiles[0].end = part.uploadFiles[0].start + part.uploadFiles[0].path.length;
  }
  if (invalid === 'unsupported-owner') h.ctx.mobileAttachmentAssetStore = null;
  const body = { handoffId: invalid, applicationQueue: true, expectedToolType: 'codex', expectedSessionId: 'S',
    authoring: { version: 1, chips: [], imagePaths: [], parts: [part] } };
  const response = await h.send(body); assert.ok(response.status >= 400, JSON.stringify(response));
  assert.equal(response.data.submitted, false); assert.equal(h.queue.item('project:T:' + invalid), null);
  assert.equal(h.writes.length, 0);
});

test('legacy rich PDF text alone stays text and never fabricates ownership', async t => {
  const h = await fixture(t), file = await h.upload('legacy-rich.pdf', 'file', 'legacy file');
  const body = { handoffId: 'legacy-rich', applicationQueue: true, expectedToolType: 'codex', expectedSessionId: 'S',
    authoring: { version: 1, chips: [], imagePaths: [], parts: [{ kind: 'text', text: '- [file] PDF: ' + file.path }] } };
  const ack = await h.send(body); assert.equal(ack.status, 202); assert.equal(ack.data.attachmentOwnership, undefined);
  assert.equal(h.queue.referencedAssetIds().size, 0);
});

test('typed file ranges survive a deferred-context wrapper refresh and preserve repeated files', async t => {
  const h = await fixture(t), file = await h.upload('refresh.pdf', 'file', 'refresh PDF');
  h.ctx.tabWorkContext = { prepare: async (_tab, _handoff, prompt) => ({ prefix: 'NEXT CONTEXT\n',
    prompt: 'NEXT CONTEXT\n' + prompt.replace('old context text', 'fresh generated context with another length') }),
  activate() {}, settle() {}, assertContinuationScope() {}, release() {} };
  const body = { handoffId: 'rich-context', applicationQueue: true, expectedToolType: 'codex', expectedSessionId: 'S',
    authoring: { version: 1, chips: [{ id: 'c', kind: 'prompt', text: 'old context text', contextUpdateId: 'managed' }],
      imagePaths: [], parts: [uploadFileTextPart(file), uploadFileTextPart(file)] } };
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.equal(ack.data.attachmentOwnership.fileOccurrences, 2);
  await h.call('/api/mobile-attachments/' + file.id, null, 'DELETE'); await h.drain();
  assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:rich-context').receipt));
  assert.equal(h.writes[0].prepared.projection.paths.length, 2);
  assert.ok(h.writes[0].prompt.startsWith('NEXT CONTEXT\n'));
});

test('structured explicit asset A is not replaced by current temp B', async t => {
  const h = await fixture(t), image = await h.upload('version.png', 'image', 'version A');
  await h.send(h.request('capture-a', [image]));
  const assetId = JSON.parse(h.queue.item('project:T:capture-a').request_json).ownedAttachments.refs[0].assetId;
  fs.writeFileSync(image.path, 'version B');
  const body = structuredImages('exact-a', [{ id: 7, path: image.path, assetId }]);
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.equal(ack.data.attachmentOwnership.refs[0].assetId, assetId);
  const frozen = JSON.parse(h.queue.item('project:T:exact-a').request_json);
  assert.equal(frozen.authoringSnapshot.imagePaths[0].assetId, assetId);
  h.store.settleQueuedNoWrite('project:T:capture-a', { code: 'private-capture-only' });
  await h.drain(); assert.equal(h.writes.length, 1);
  assert.equal(fs.readFileSync(h.writes[0].prepared.imageRefs[0].path, 'utf8'), 'version A');
});

test('structured same source path binds A/B/A occurrences after DELETE and restart', async t => {
  const h = await fixture(t), image = await h.upload('versions.png', 'image', 'version A');
  const ids = [];
  for (const version of ['A', 'B']) {
    fs.writeFileSync(image.path, 'version ' + version);
    await h.send(h.request('capture-' + version, [image]));
    ids.push(JSON.parse(h.queue.item('project:T:capture-' + version).request_json).ownedAttachments.refs[0].assetId);
    h.store.settleQueuedNoWrite('project:T:capture-' + version, { code: 'private-capture-only' });
  }
  assert.notEqual(ids[0], ids[1]);
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE'); h.restart();
  const body = structuredImages('versions', ids.map((assetId, index) => ({ id: index + 7, path: image.path, assetId })), [7, 8, 7]);
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  assert.deepEqual(ack.data.attachmentOwnership.refs.map(ref => ref.assetId), ids);
  assert.equal(ack.data.attachmentOwnership.imageOccurrences, 3);
  h.restart(); const replay = await h.send(body); assert.equal(replay.status, 202);
  await h.drain(); assert.equal(h.writes.length, 1);
  assert.deepEqual(h.staged[0].receipt.imageRequestProjection.images.map(image => image.ref.assetId), [ids[0], ids[1], ids[0]]);
  assert.deepEqual(h.writes[0].prepared.imageRefs.map(ref => fs.readFileSync(ref.path, 'utf8')), ['version A', 'version B', 'version A']);
});

test('structured foreign assetId is refused rather than silently replaced by the uploaded bytes', async t => {
  const h = await fixture(t), image = await h.upload('foreign.png', 'image', 'actual bytes');
  const body = structuredImages('foreign-asset', [{ id: 7, path: image.path, assetId: 'f'.repeat(64) + '.png' }]);
  const response = await h.send(body);
  assert.equal(response.status, 403); assert.equal(response.data.code, 'attachment_upload_identity_mismatch');
  assert.equal(h.queue.item('project:T:foreign-asset'), null); assert.equal(h.writes.length, 0);
});

for (const kind of ['image', 'file']) test('plain formatter preserves explicit A/B versions of one upload path: ' + kind, async t => {
  const h = await fixture(t), upload = await h.upload(kind === 'image' ? 'pair.png' : 'pair.pdf', kind, 'version A');
  const assetIds = [];
  for (const version of ['A', 'B']) {
    fs.writeFileSync(upload.path, 'version ' + version);
    await h.send(h.request('capture-' + version, [upload]));
    assetIds.push(JSON.parse(h.queue.item('project:T:capture-' + version).request_json).ownedAttachments.refs[0].assetId);
    h.store.settleQueuedNoWrite('project:T:capture-' + version, { code: 'private-capture-only' });
  }
  // Existing formatter consumes A's already-authored marker and prepends B;
  // its exact emitted ranges, not path/count matching, own that B/A order.
  const prompt = kind === 'image' ? 'Body\n[imagePath: ' + upload.path + ']' : 'Read both versions';
  const body = h.request('pair', assetIds.map(assetId => ({ ...upload, assetId })), prompt);
  const ack = await h.send(body); assert.equal(ack.status, 202, JSON.stringify(ack));
  await h.call('/api/mobile-attachments/' + upload.id, null, 'DELETE'); h.restart();
  await h.drain(); assert.equal(h.writes.length, 1);
  if (kind === 'image') {
    assert.deepEqual(h.staged[0].receipt.imageRequestProjection.images.map(value => value.ref.assetId), [assetIds[1], assetIds[0]]);
  } else {
    const text = h.writes[0].prompt;
    assert.ok(text.indexOf(assetIds[0]) >= 0 && text.indexOf(assetIds[0]) < text.indexOf(assetIds[1]));
  }
});

test('authoritative context wrapper refresh rebinds formatter ranges without shifting the leading image incorrectly', async t => {
  const h = await fixture(t), image = await h.upload('context.png', 'image', 'context image');
  const document = await h.upload('context.pdf', 'file', 'context document');
  const wrapper = '<saved_prompt context-update-id="known">old</saved_prompt>';
  h.ctx.tabWorkContext = { prepare: async (_tab, _handoff, prompt) => ({
    prefix: 'NEW CONTEXT\n', prompt: 'NEW CONTEXT\n' + prompt.replace(wrapper,
      '<saved_prompt context-update-id="known">refreshed generated wrapper content</saved_prompt>'),
  }), activate() {}, settle() {}, assertContinuationScope() {}, release() {} };
  const ack = await h.send(h.request('refresh', [image, document], wrapper + '\n\nLiteral user body'));
  assert.equal(ack.status, 202, JSON.stringify(ack));
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE');
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE');
  await h.drain();
  assert.equal(h.writes.length, 1, JSON.stringify(h.store.get('project:T:refresh').receipt));
  assert.ok(h.writes[0].prompt.includes('Literal user body'));
  assert.equal(h.staged[0].receipt.imageRequestProjection.images.length, 1);
});

test('default clients keep the existing wait-for-provider response rather than getting the opt-in early ACK', async t => {
  const h = await fixture(t), document = await h.upload('default.pdf', 'file', 'default client');
  let admitted;
  const waiting = new Promise(resolve => { admitted = resolve; });
  h.queue.publish = record => { if (record.operationKey === 'project:T:default') admitted(); };
  let returned = false;
  const response = h.send({ ...h.request('default', [document]), applicationQueue: false }).then(value => { returned = true; return value; });
  await waiting; assert.equal(returned, false); assert.equal(h.writes.length, 0);
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE');
  await h.drain();
  const result = await response;
  assert.equal(result.data.submitted, true); assert.equal(result.data.applicationQueued, undefined);
  assert.equal(result.data.attachmentOwnership.durable, true);
});

test('the actual capability producer advertises owned uploads only with the shared asset owner configured', async t => {
  const h = await fixture(t); let producer;
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'sendQueue') producer = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(producer);
  const read = () => vm.runInContext('(' + producer + ')', h.ctx);
  assert.equal(read().version, 1); assert.equal(read().attachmentOwnership.version, 1);
  assert.equal(read().attachmentOwnership.scope, 'mobile-upload');
  assert.equal(read().attachmentOwnership.files, true);
  assert.equal(read().attachmentOwnership.structuredFiles.version, 1);
  assert.equal(read().attachmentOwnership.structuredFiles.rangeUnit, 'utf16');
  h.ctx.mobileAttachmentAssetStore = null;
  assert.equal(read().attachmentOwnership, undefined, 'no byte-ownership capability from queue metadata alone');
});

test('old path can attach owned bytes under a new handoff after DELETE; /var spelling stays authored', async t => {
  const h = await fixture(t);
  const image = await h.upload('kept.png', 'image', 'kept image');
  await h.send(h.request('first', [image]));
  const ref = JSON.parse(h.queue.item('project:T:first').request_json).ownedAttachments.refs[0];
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE');
  h.restart();
  const second = await h.send(h.request('second', [{ ...image, assetId: ref.assetId }]));
  assert.equal(second.status, 202, JSON.stringify(second));
  const copied = JSON.parse(h.queue.item('project:T:second').request_json).ownedAttachments.refs[0];
  assert.equal(copied.sourcePath, image.path);
  assert.equal(copied.assetId, ref.assetId);
  assert.equal(h.queue.referencedAssetIds().size, 1);
});

test('legacy receipts are replayed without minting ownership metadata or copying their files', async t => {
  const h = await fixture(t); const image = await h.upload('legacy.png', 'image', 'legacy');
  const owner = h.ctx.mobileAttachmentAssetStore; h.ctx.mobileAttachmentAssetStore = null;
  const body = h.request('legacy', [image]);
  assert.equal((await h.send(body)).data.attachmentOwnership, undefined);
  h.ctx.mobileAttachmentAssetStore = owner;
  assert.equal((await h.send(body)).data.attachmentOwnership, undefined);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.queue.referencedAssetIds().size, 0);
  assert.equal(fs.existsSync(h.assetRoot), false, 'old records were not backfilled');
});

test('an entered unknown keeps bytes across restart and never re-dispatches', async t => {
  const h = await fixture(t); const document = await h.upload('unknown.pdf', 'file', 'unknown bytes');
  const body = h.request('unknown', [document]); await h.send(body); await h.drain();
  const record = h.store.get('project:T:unknown');
  h.store.markDeliveryUnknown(record.operationKey, record.attemptId, { reason: 'private-transport-loss' });
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE'); h.restart();
  const assetId = [...h.queue.referencedAssetIds()][0], asset = path.join(h.assetRoot, assetId);
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000); fs.utimesSync(asset, old, old);
  assert.deepEqual((await h.ctx.mobileAttachmentAssetStore.garbageCollect(h.queue.referencedAssetIds())).removed, []);
  const replay = await h.send(body); assert.equal(replay.status, 202);
  assert.equal(replay.data.deliveryUnknown, true); assert.equal(replay.data.attachmentOwnership.durable, true);
  await h.drain(); assert.equal(h.writes.length, 1);
});

test('startup read uses only exact persisted transforms, never current file contents or a changed prompt', async t => {
  for (const provider of ['codex', 'claude']) {
    const h = await fixture(t, provider), document = await h.upload('startup.pdf', 'file', 'startup body');
    await h.send(h.request('startup', [document])); await h.drain();
    const record = JSON.parse(JSON.stringify(h.staged[0]));
    record.state = 'audit-pending'; record.sessionId = 'S'; record.receipt.sessionId = 'S';
    const filePath = path.join(h.directory, provider + '.jsonl');
    const stamp = new Date().toISOString();
    const source = provider === 'codex'
      ? { type: 'event_msg', timestamp: stamp, payload: { type: 'user_message', message: record.receipt.transportText } }
      : { type: 'user', uuid: 'private-startup-user', sessionId: 'S', timestamp: stamp,
        message: { role: 'user', content: record.receipt.transportText } };
    fs.writeFileSync(filePath, '');
    record.transcriptBoundary = provider === 'claude'
      ? { ...(await require('./claude-prompt-audit').captureClaudePromptAuditBoundary(filePath)), sessionId: 'S' }
      : { capturedAt: Date.now() - 1000, sessionId: 'S', fileSize: 0, filePath };
    fs.appendFileSync(filePath, JSON.stringify(source) + '\n');
    const reconcile = require('./agent-send-startup-reconcile').reconcileAgentSendStartupRecord;
    const found = await reconcile(record);
    assert.equal(found.decision, 'found', JSON.stringify(found));
    assert.equal(found.audit.expectedHash, record.promptHash);
    for (const mutation of [
      copy => { copy.receipt.ownedAttachmentProjection.attemptId = 'foreign'; },
      copy => { copy.receipt.ownedAttachments.refs[0].sourcePath = '/other.pdf'; },
      copy => { copy.receipt.promptText += 'changed'; },
      copy => { delete copy.receipt.ownedAttachmentProjection; },
    ]) {
      const changed = JSON.parse(JSON.stringify(record)); mutation(changed);
      assert.notEqual((await reconcile(changed)).decision, 'found');
    }
  }
});

test('same handoff changed request rejects before rereading or importing removed originals', async t => {
  const h = await fixture(t); const image = await h.upload('photo.png', 'image', 'bytes');
  const body = h.request('same', [image]); assert.equal((await h.send(body)).status, 202);
  await h.call('/api/mobile-attachments/' + image.id, null, 'DELETE');
  const changed = await h.send({ ...body, prompt: 'changed' });
  assert.equal(changed.status, 409); assert.equal(changed.data.code, 'agent_send_handoff_conflict');
  assert.equal(h.queue.referencedAssetIds().size, 1); assert.equal(h.writes.length, 0);
});

test('an actually lost HTTP ACK is recovered by the same frozen handoff without the upload', async t => {
  const h = await fixture(t), document = await h.upload('lost.pdf', 'file', 'lost ACK bytes');
  const body = h.request('lost', [document]);
  let admitted;
  const committed = new Promise(resolve => { admitted = resolve; });
  const request = http.request(h.url + '/api/terminal-tabs/T/send', { method: 'POST',
    headers: { authorization: 'Bearer private-fixture', 'content-type': 'application/json' } });
  const disconnected = new Promise(resolve => { request.on('error', resolve); request.on('close', resolve); });
  h.queue.publish = record => {
    if (record.operationKey === 'project:T:lost') { request.destroy(); admitted(); }
  };
  request.end(JSON.stringify(body)); await committed; await disconnected;
  h.queue.publish = () => {};
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE'); h.restart();
  const get = await h.call('/api/terminal-tabs/T/send-receipts?handoffId=lost', null, 'GET');
  assert.equal(get.status, 200); assert.equal(get.data.receipts[0].attachmentOwnership.durable, true);
  assert.equal(get.data.receipts[0].attemptId, null); assert.equal(h.writes.length, 0);
  const readback = await h.send(body);
  assert.equal(readback.status, 202); assert.equal(readback.data.attachmentOwnership.durable, true);
  assert.equal(h.store.list().length, 1); await h.drain(); assert.equal(h.writes.length, 1);
});

test('only upload-owned references are copied; literal paths and GT/context refs remain separate', async t => {
  const h = await fixture(t), document = await h.upload('owned.pdf', 'file', 'owned document');
  const outside = path.join(h.directory, 'foreign.txt'); fs.writeFileSync(outside, 'must not import');
  const text = 'Read literal ' + outside + '\n[imagePath: /outside/ordinary-image.png]';
  const response = await h.send(h.request('mixed', [document], text));
  assert.equal(response.status, 202);
  const saved = JSON.parse(h.queue.item('project:T:mixed').request_json);
  assert.deepEqual(saved.ownedAttachments.refs.map(ref => ref.sourcePath), [document.path]);
  assert.ok(saved.prompt.includes(text));
});

test('managed logical/physical root aliases retain the exact authored spelling', async t => {
  const h = await fixture(t), document = await h.upload('aliases.pdf', 'file', 'alias document');
  const logical = path.join(h.directory, 'logical-temp'); fs.symlinkSync(h.temp, logical);
  h.ctx.app.getPath = kind => kind === 'temp' ? logical : path.dirname(h.assetRoot);
  const authored = { ...document, path: document.path.replace(h.temp, logical) };
  assert.equal((await h.send(h.request('alias', [authored]))).status, 202);
  const saved = JSON.parse(h.queue.item('project:T:alias').request_json).ownedAttachments;
  assert.equal(saved.refs[0].sourcePath, authored.path);
  const physical = { ...document, path: fs.realpathSync(document.path) };
  await h.call('/api/mobile-attachments/' + document.id, null, 'DELETE'); h.restart();
  assert.equal((await h.send(h.request('alias-two', [physical]))).status, 202);
  const second = JSON.parse(h.queue.item('project:T:alias-two').request_json).ownedAttachments;
  assert.equal(second.refs[0].sourcePath, physical.path); assert.equal(second.refs[0].assetId, saved.refs[0].assetId);
});

test('concurrent imports of one file hold independent temporary leases', async t => {
  const h = await fixture(t), image = await h.upload('concurrent.png', 'image', 'shared bytes');
  const args = { rootDir: h.ctx.mobileAttachmentRoot(), attachments: [image], assetStore: h.ctx.mobileAttachmentAssetStore };
  const [one, two] = await Promise.all([ownership.importMobileUploads(args), ownership.importMobileUploads(args)]);
  assert.equal(one.refs[0].assetId, two.refs[0].assetId);
  const id = one.refs[0].assetId, asset = path.join(h.assetRoot, id);
  assert.equal(args.assetStore.pendingLeases.get(id), 2);
  one.release(); one.release(); assert.equal(args.assetStore.pendingLeases.get(id), 1);
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000); fs.utimesSync(asset, old, old);
  assert.deepEqual((await args.assetStore.garbageCollect(new Set())).removed, []);
  two.release(); assert.equal(args.assetStore.pendingLeases.size, 0);
  assert.deepEqual((await args.assetStore.garbageCollect(new Set())).removed, [id]);
});

for (const at of ['stat', 'unlink']) test('GC cannot remove a newly ACKed copy after a stale ' + at, async t => {
  const h = await fixture(t), document = await h.upload('gc-race.pdf', 'file', 'race bytes');
  await h.send(h.request('old', [document]));
  h.store.settleQueuedNoWrite('project:T:old', { code: 'private-unused' }); h.queue.dismissUnwritten('T', 'old');
  const ref = h.queue.ownedUploadRef(document.path), asset = path.join(h.assetRoot, ref.assetId);
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000); fs.utimesSync(asset, old, old);
  let pause, resume, intercepted = false;
  const paused = new Promise(resolve => { pause = resolve; }), held = new Promise(resolve => { resume = resolve; });
  const original = fs.promises[at];
  fs.promises[at] = async (...args) => {
    if (args[0] === asset && !intercepted) {
      intercepted = true; const stat = at === 'stat' ? await original(...args) : null;
      pause(); await held; return at === 'stat' ? stat : original(...args);
    }
    return original(...args);
  };
  t.after(() => { fs.promises[at] = original; resume(); });
  const collection = h.ctx.mobileAttachmentAssetStore.garbageCollect(new Set()); await paused;
  let acked = false;
  const send = h.send(h.request('new', [document])).then(value => { acked = true; return value; });
  if (at === 'stat') assert.equal((await send).status, 202);
  else { await tick(); await tick(); assert.equal(acked, false); }
  resume(); const collected = await collection;
  assert.equal((await send).status, 202);
  forgetCollectedUploadAliases(h.store.db, collected.removed);
  assert.equal(fs.readFileSync(asset, 'utf8'), 'race bytes');
  assert.ok(h.queue.ownedUploadRef(document.path));
  assert.ok(h.queue.referencedAssetIds().has(ref.assetId));
});

for (const corrupt of ['replace-bytes', 'delete', 'symlink']) test('Main refuses changed owned bytes before physical paste: ' + corrupt, async t => {
  const h = await fixture(t), document = await h.upload('changed.pdf', 'file', 'original bytes');
  const body = h.request('changed', [document]); await h.send(body);
  const id = [...h.queue.referencedAssetIds()][0], asset = path.join(h.assetRoot, id);
  if (corrupt === 'replace-bytes') fs.writeFileSync(asset, 'mutated bytes!');
  else { fs.unlinkSync(asset); if (corrupt === 'symlink') fs.symlinkSync(document.path, asset); }
  await h.drain();
  assert.equal(h.writes.length, 0); assert.equal(h.queue.item('project:T:changed').state, 'failed');
  assert.equal(h.store.get('project:T:changed').receipt.code, 'attachment_owned_bytes_unavailable');
  assert.ok(h.queue.referencedAssetIds().has(id), 'failure does not silently dismiss the attachment inventory');
});

for (const change of ['foreign-path', 'foreign-id', 'symlink', 'parent-symlink', 'copy-failure', 'storage-failure', 'commit-failure']) test('pre-ACK refusal keeps other file leases: ' + change, async t => {
  const h = await fixture(t); const protectedImage = await h.upload('keep.png', 'image', 'keep');
  assert.equal((await h.send(h.request('keep', [protectedImage]))).status, 202);
  const originalIds = [...h.queue.referencedAssetIds()];
  const bad = await h.upload('bad.pdf', 'file', 'bad');
  if (change === 'foreign-path') bad.path = path.join(h.directory, 'foreign.pdf');
  if (change === 'foreign-id') bad.id = protectedImage.id;
  if (change === 'symlink') { fs.unlinkSync(bad.path); fs.symlinkSync(protectedImage.path, bad.path); }
  if (change === 'parent-symlink') {
    const moved = path.join(h.directory, 'foreign-directory');
    fs.renameSync(path.dirname(bad.path), moved); fs.symlinkSync(moved, path.dirname(bad.path));
  }
  if (change === 'copy-failure') h.ctx.mobileAttachmentAssetStore.importUploadHandle = async () => { throw new Error('ENOSPC'); };
  if (change === 'storage-failure') h.ctx.mobileAttachmentAssetStore.ensureRoot = async () => { throw new Error('EACCES'); };
  if (change === 'commit-failure') h.store.stageQueuedRequest = () => { throw new Error('SQLITE_FULL'); };
  const refused = await h.send(h.request('refused', [bad]));
  assert.ok(refused.status >= 400, JSON.stringify(refused));
  assert.equal(refused.data.submitted, false);
  assert.equal(h.queue.item('project:T:refused'), null);
  assert.deepEqual([...h.queue.referencedAssetIds()], originalIds);
  assert.equal(h.ctx.mobileAttachmentAssetStore.pendingLeases.size, 0);
});

test('owned inventory protects old files in waiting/unknown/failed until explicit dismissal', async t => {
  const h = await fixture(t); const document = await h.upload('file.txt', 'file', 'keep old document');
  await h.send(h.request('retained', [document]));
  const refs = JSON.parse(h.queue.item('project:T:retained').request_json).ownedAttachments.refs;
  const asset = path.join(h.assetRoot, refs[0].assetId), old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  fs.utimesSync(asset, old, old);
  assert.deepEqual((await h.ctx.mobileAttachmentAssetStore.garbageCollect(h.queue.referencedAssetIds())).removed, []);
  h.store.settleQueuedNoWrite('project:T:retained', { code: 'private-preparation-failure' });
  assert.equal(h.queue.item('project:T:retained').state, 'failed');
  assert.deepEqual((await h.ctx.mobileAttachmentAssetStore.garbageCollect(h.queue.referencedAssetIds())).removed, []);
  h.queue.dismissUnwritten('T', 'retained');
  assert.deepEqual((await h.ctx.mobileAttachmentAssetStore.garbageCollect(h.queue.referencedAssetIds())).removed, [refs[0].assetId]);
});

test('actual Main publisher and History keep original authoring for both provider codecs and document-only sends', async t => {
  for (const provider of ['codex', 'claude']) for (const documentsOnly of [false, true]) {
    for (const nativeSlots of provider === 'codex' && !documentsOnly ? [false, true] : [false]) {
    const h = await fixture(t, provider), image = await h.upload('a.png', 'image', 'image');
    const document = await h.upload('a.txt', 'file', 'document');
    const original = documentsOnly ? 'plain document request' : 'literal path stays literal\t\r\n' + image.path;
    await h.send(h.request(provider, documentsOnly ? [document] : [image, document], original));
    await h.drain();
    const record = h.staged[0]; assert.ok(record, JSON.stringify(h.store.get('project:T:' + provider)?.receipt));
    const expectedText = record.receipt.transportText;
    const audit = { handoffId: record.handoffId, sendOperationKey: record.operationKey, sendAttemptId: record.attemptId,
      expectedText, expectedHash: promptAuditFingerprint(expectedText), expectedLen: expectedText.length,
      expectedImageRefs: record.receipt.expectedImageRefs, expectedImagePaths: record.receipt.expectedImagePaths,
      imageRequestProjection: record.receipt.imageRequestProjection };
    let actualText = expectedText;
    if (nativeSlots) for (const [index, imagePath] of audit.expectedImagePaths.entries()) {
      actualText = actualText.replace(imagePath, '[Image #' + (index + 1) + '] ');
    }
    const match = nativeSlots ? require('./codex-prompt-audit').codexCanonicalUserMessageMatch(audit, actualText) : null;
    if (nativeSlots) assert.equal(match.reason, 'codex_image_placeholder_canonical');
    let result = { success: true, actualText, actualHash: promptAuditFingerprint(actualText), actualLen: actualText.length,
      ...(match ? { canonicalized: true, canonicalReason: match.reason } : {}),
      expectedHash: audit.expectedHash, expectedLen: expectedText.length };
    const nativeResult = { ...result, sessionId: 'S', entryUuid: 'exact-private-user', sourceIdentity: 'private-source',
      auditTimestamp: new Date().toISOString() };
    const inner = provider === 'codex' ? projectCodexImageAuditToRequest({ tabId: 'T', record, audit, result })
      : projectClaudePromptAuditToRequest({ tabId: 'T', record, audit, result });
    if (inner.applied) result = { ...result, expectedHash: inner.requestHash, expectedLen: inner.requestLength,
      canonicalized: true, canonicalReason: inner.canonicalReason };
    const outer = ownership.projectOwnedAttachmentAuditToRequest(record, result);
    assert.equal(outer.applied, true, JSON.stringify(outer));
    assert.equal(outer.requestHash, record.promptHash);
    assert.ok(record.receipt.promptText.includes(original));
    const routed = [];
    const publisher = vm.runInNewContext('(' + declared(mainTree, 'publishAgentPromptAuditResult') + ')', {
      ...ownership, console: h.ctx.console, projectCodexImageAuditToRequest, projectClaudePromptAuditToRequest,
      agentSendReceiptStore: h.store, AGENT_SEND_DURABLE_STATES: require('./agent-send-receipt-store').STORE_STATES,
      compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'private-fixture' }),
      isOrchestrationPromptAudit: () => false, enrichCodexAuditAddress() {},
      projectManager: { db: null }, backfillConfirmedClaudeRequestPresentations() {},
      routeAgentPromptAuditDetail: detail => routed.push(detail),
      backfillConfirmedCanonicalAuthoringPresentations() {},
    });
    publisher('T', audit, nativeResult, provider);
    assert.equal(h.store.get(record.operationKey).state, 'confirmed');
    assert.equal(routed[0].expectedHash, record.promptHash);
    assert.equal(nativeResult.expectedHash, audit.expectedHash, 'the physical audit object stays unchanged');
    const rows = [];
    const presentations = require('./history-prompt-presentations');
    const historyStore = {
      getHistoryPromptPresentationByAudit: (tool, sid, stamp, hash) => rows.find(row => row.toolType === tool
        && row.sessionId === sid && row.auditTimestamp === stamp && row.transportHash === hash),
      getHistoryPromptPresentations: () => rows,
      getHistoryPromptPresentationsForEntries: () => rows,
      saveHistoryPromptPresentation: value => { rows.push(value); return true; },
    };
    const confirmed = h.store.get(record.operationKey);
    assert.equal(presentations.backfillConfirmedCanonicalAuthoringPresentations(historyStore, [confirmed]), 1);
    const entry = { role: 'user', uuid: 'exact-private-user', sourceIdentity: 'private-source', sessionId: 'S',
      timestamp: confirmed.auditIdentity.auditTimestamp, content: actualText,
      ...(nativeSlots ? { imagePaths: audit.expectedImagePaths.map((value, index) => ({ id: index + 1, path: value })) } : {}),
      promptPresentationTransportHash: result.actualHash };
    const projected = presentations.decorateHistoryPromptPresentations(historyStore, { toolType: provider, sessionId: 'S', entries: [entry] })[0];
    assert.ok(projected.content.includes(original), 'literal authored text is not a path substitution');
    assert.ok(projected.content.includes(document.path), 'History keeps the authored document path');
    assert.equal(entry.content, actualText, 'projection never rewrites the canonical source');
    const historyDb = new Database(':memory:');
    try {
      historyDb.exec('CREATE TABLE history_prompt_presentations (chips_json TEXT, schema_version INTEGER)');
      historyDb.prepare('INSERT INTO history_prompt_presentations VALUES (?, 4)').run(JSON.stringify(rows[0].chips));
      const referenced = require('./database').prototype.getHistoryPromptPresentationAssetIds.call({ db: historyDb });
      const allIds = new Set(record.receipt.ownedAttachments.refs.map(ref => ref.assetId));
      assert.deepEqual(new Set(referenced), allIds, 'canonical sidecars retain image AND document assets after queue completion');
    } finally { historyDb.close(); }
    }
  }
});

test('manifest and attempt tampering cannot turn ownership metadata into delivery proof', async t => {
  const h = await fixture(t), file = await h.upload('proof.pdf', 'file', 'proof bytes');
  await h.send(h.request('proof', [file])); await h.drain();
  const record = h.staged[0];
  const mutations = [
    copy => { delete copy.receipt.ownedAttachmentProjection; },
    copy => { copy.receipt.ownedAttachmentProjection.attemptId = 'foreign'; },
    copy => { copy.receipt.ownedAttachmentProjection.paths[0] = '/foreign/other.pdf'; },
    copy => { copy.receipt.ownedAttachments.refs[0].assetId = ''; },
    copy => { copy.receipt.ownedAttachments.ranges[0].refIndex = -1; },
    copy => { copy.receipt.ownedAttachments.ranges[0].start += 1; },
    copy => { copy.receipt.ownedAttachments.sourceHash = 'foreign'; },
  ];
  for (const mutate of mutations) {
    const changed = JSON.parse(JSON.stringify(record)); mutate(changed);
    assert.equal(ownership.readOwnedAttachmentProjection(changed).valid, false, String(mutate));
    h.store.db.prepare('UPDATE agent_send_receipts SET receipt_json = ? WHERE operation_key = ?')
      .run(JSON.stringify(changed.receipt), record.operationKey);
    const promotion = h.store.promoteFromAudit({ operationKey: record.operationKey, attemptId: record.attemptId,
      provider: 'codex', sessionId: 'S', success: true, promptHash: record.promptHash,
      expectedHash: record.promptHash, actualHash: record.promptHash, entryUuid: 'forged-exact',
      auditTimestamp: new Date().toISOString() });
    assert.equal(promotion.promoted, false); assert.equal(promotion.reason, 'attachment-canonical-proof-missing');
  }
});

test('public metadata cannot mint a byte-ownership ACK and preview never broadens roots', async t => {
  const h = await fixture(t), image = await h.upload('approved.png', 'image', 'approved');
  const response = await h.send({ ...h.request('forged', []), ownedAttachments: { version: 1, refs: [{ path: '/foreign' }] },
    attachmentOwnership: { durable: true } });
  assert.equal(response.status, 202); assert.equal(response.data.attachmentOwnership, undefined);
  await h.send(h.request('valid', [image]));
  const assetId = [...h.queue.referencedAssetIds()][0];
  const outside = await h.call('/api/mobile-attachments/preview', { path: '/foreign/same-name.png', assetId });
  assert.equal(outside.status, 403);
  const wrong = await h.call('/api/mobile-attachments/preview', { path: image.path, assetId: 'f'.repeat(64) + '.png' });
  assert.equal(wrong.status, 403);
  const bareAsset = await h.call('/api/mobile-attachments/preview', { path: path.join(h.assetRoot, assetId) });
  assert.equal(bareAsset.status, 403, 'the store root is not a new preview root');
});
