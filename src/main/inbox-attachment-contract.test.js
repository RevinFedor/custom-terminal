'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');
const contextFiles = require('./agent-context-files');
const { buildCodexImagePastePlan, CodexImageTransport } = require('./codex-image-transport');
const crypto = require('node:crypto');
const receipt = require('./agent-send-receipt-registry');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { resolveOrchestrationSendOptions } = require('./orchestration-request-plan');
const { bindStructuredAuthoringPresentation } = require('./structured-authoring');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const sourceFile = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function functionSource(name) {
  let found = null;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(found, 'actual web-server function exists: ' + name);
  return source.slice(found.getStart(sourceFile), found.end);
}

function contract(root, known = new Map()) {
  const code = [
    'sendAttachmentError',
    'normalizeSendAttachments',
    'appendAttachmentsToPrompt',
    'inboxAttachmentPresentationSnapshot',
    'resolveInboxAttachmentPrompt',
  ].map(functionSource).join('\n')
    + '\n({ normalizeSendAttachments, appendAttachmentsToPrompt, inboxAttachmentPresentationSnapshot, resolveInboxAttachmentPrompt })';
  return vm.runInNewContext(code, {
    Error,
    Number,
    String,
    Array,
    Map,
    path,
    fs,
    ...contextFiles,
    mobileAttachmentRoot: () => root,
    mobileAttachmentIndex: known,
    sanitizeMobileAttachmentName: (value) => String(value || 'attachment'),
    cleanOptionalString: (value, fallback = '') => String(value || '').trim() || fallback,
    normalizeMobileAttachmentKind: (kind, mimeType) => (
      kind === 'image' || kind === 'file' ? kind : (String(mimeType || '').startsWith('image/') ? 'image' : 'file')
    ),
  });
}

test('Inbox attachments become native Codex image markers and durable presentation refs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inbox-attachments-'));
  try {
    const imagePath = path.join(root, 'image-id', 'photo.png');
    const filePath = path.join(root, 'file-id', 'notes.txt');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(imagePath, 'image');
    fs.writeFileSync(filePath, 'notes');
    const api = contract(root);
    const input = [
      { id: 'image-id', kind: 'image', name: 'photo.png', mimeType: 'image/png', size: 5, path: imagePath },
      { id: 'file-id', kind: 'file', name: 'notes.txt', mimeType: 'text/plain', size: 5, path: filePath },
    ];

    const appended = api.appendAttachmentsToPrompt('Inspect both', input, { strict: true });
    assert.equal(Array.from(appended.attachments, (item) => item.kind).join(','), 'image,file');
    assert.match(appended.prompt, new RegExp('^\\[imagePath: ' + imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]'));
    assert.match(appended.prompt, /Inspect both/);
    assert.match(appended.prompt, /notes\.txt:/);
    assert.equal(appended.prompt.includes('photo.png:'), false, 'the image is native, not duplicated as a text path');

    const presentation = api.inboxAttachmentPresentationSnapshot({
      promptChips: [{ id: 'prompt-1', kind: 'prompt', label: 'Rules', text: 'RULES' }],
      imagePaths: [{ id: 99, path: '/forged.png' }],
    }, appended.attachments);
    assert.equal(presentation.promptChips[0].text, 'RULES');
    assert.equal(presentation.imagePaths.length, 1);
    assert.equal(presentation.imagePaths[0].path, imagePath);
    assert.equal(presentation.imagePaths[0].id, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict Inbox attachment admission rejects unsupported, foreign and missing files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inbox-attachments-'));
  const api = contract(root);
  try {
    assert.throws(
      () => api.normalizeSendAttachments([{ kind: 'audio', path: '/tmp/a.wav' }], { strict: true }),
      (error) => error.code === 'unsupported_attachment_kind',
    );
    assert.throws(
      () => api.normalizeSendAttachments([{ kind: 'file', path: '/tmp/outside.txt' }], { strict: true }),
      (error) => error.code === 'attachment_path_outside_owner',
    );
    assert.throws(
      () => api.normalizeSendAttachments([{ kind: 'file', path: path.join(root, 'gone', 'x.txt') }], { strict: true }),
      (error) => error.code === 'attachment_missing',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox run identity includes attachments and passes their presentation to the shared send scenario', () => {
  const routeStart = source.indexOf("if (parsed.pathname === '/api/inbox/runs'");
  const routeEnd = source.indexOf("if (parsed.pathname === '/api/inbox/sessions/resume'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /normalizeSendAttachments\(body\.attachments, \{ strict: true \}\)/);
  assert.match(route, /attachments: normalizedAttachments/);
  assert.match(route, /presentationSnapshot,/);
  assert.match(route, /await resolveInboxAttachmentPrompt\(prompt, normalizedAttachments\)/);
  assert.match(route, /runAgentSendScenario\(\{[\s\S]*presentationSnapshot,/);
});

test('owner-v2 text and actual PNG bytes materialize before a single Project send boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inbox-payload-'));
  try {
    const document = path.join(root, 'doc', 'Inbox-owner-v2.txt');
    const image = path.join(root, 'image', 'camera.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64');
    fs.mkdirSync(path.dirname(document), { recursive: true });
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(document, 'IOS_OWNER_V2_FILE_OK\r\n');
    fs.writeFileSync(image, png);
    const api = contract(root);
    const input = api.normalizeSendAttachments([
      { id: 'doc', kind: 'file', path: document, name: 'Inbox-owner-v2.txt', mimeType: 'text/plain' },
      { id: 'image', kind: 'image', path: image, name: 'camera.png', mimeType: 'image/png' },
    ], { strict: true });
    const payload = await api.resolveInboxAttachmentPrompt('Read the file and picture', input);
    assert.match(payload.prompt, /<context_file name="Inbox-owner-v2.txt"[^>]*role="source"[^>]*>\nIOS_OWNER_V2_FILE_OK\r\n\n<\/context_file>/);
    assert.equal((payload.prompt.match(/<context_file /g) || []).length, 1);
    assert.equal(payload.contextFiles[0].bytes, 22);
    const transport = new CodexImageTransport({ rootDir: path.join(root, 'staged') });
    const plan = buildCodexImagePastePlan(payload.prompt, file => {
      const staged = transport.stageSync({ path: file });
      return { ...staged, inputPath: staged.path };
    });
    assert.equal(plan.missing.length, 0);
    assert.equal(plan.segments.filter(part => part.kind === 'image').length, 1);
    assert.deepEqual(fs.readFileSync(plan.segments.find(part => part.kind === 'image').text.trim()), png);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual Inbox POST and shared send wrapper retain production Voice file/image request, replay and refusal recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inbox-route-'));
  try {
    const file = path.join(root, 'ce3c1d70-c631-4a09-b523-fb8855ded728', 'Inbox-owner-v2.txt');
    const image = path.join(root, 'image-id', 'camera.png');
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII=', 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(file, 'IOS_OWNER_V2_FILE_OK');
    fs.writeFileSync(image, imageBytes);
    // The real Voice mapping, with the post-normalization shape observed on
    // the failed iOS run. These descriptors are already signature-validated by
    // Voice HTTP (covered independently in its HTTP upload/recovery tests).
    const voiceSource = fs.readFileSync(path.join(__dirname, '../../../voice-record/src/main/main.js'), 'utf8');
    const voiceAst = ts.createSourceFile('voice.js', voiceSource, ts.ScriptTarget.Latest, true);
    const voiceFns = ['codexAttachmentBlock', 'buildCodexUserPrompt', 'codexManagedAttachments', 'codexPresentationSnapshotForMessage']
      .map(name => voiceAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(voiceAst));
    const voice = vm.runInNewContext(voiceFns.join('\n') + '\n({buildCodexUserPrompt,codexManagedAttachments,codexPresentationSnapshotForMessage})', { path });
    const msg = { role: 'user', content: 'Read both', attachments: [
      { id: 'prompt', kind: 'prompt', name: 'Terminal prompt', source: 'terminal', sourcePromptId: 'prompt-11290', text: 'TERMINAL_RULE' },
      { id: 'vrup1.validated-document', managedUpload: true, ownerRemoteId: 'ce3c1d70-c631-4a09-b523-fb8855ded728', kind: 'document', filePath: file, name: 'Inbox-owner-v2.txt', mimeType: 'text/plain' },
      { id: 'vrup1.validated-image', managedUpload: true, ownerRemoteId: 'image-id', kind: 'image', filePath: image, name: 'camera.png', mimeType: 'image/png' },
    ] };
    const routeStart = source.indexOf("if (parsed.pathname === '/api/inbox/runs'");
    const routeEnd = source.indexOf("if (parsed.pathname === '/api/inbox/sessions/resume'", routeStart);
    const calls = [], runs = new Map();
    let outcome = 'sent';
    const environment = {
      ...contract(root), ...receipt, AGENT_SEND_RECEIPT_STATES: receipt.RECEIPT_STATES,
      classifyAgentSendReceipt, resolveOrchestrationSendOptions, crypto,
      console: { log() {}, warn() {} },
      cleanOptionalString: (v, fallback = '') => String(v || '').trim() || fallback,
      clampAutoStopMs: () => -1, clampAutoCloseMs: () => -1,
      assertAgentProviderModel: () => {},
      agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: null,
      inboxSavedHistoryOperations: null, bindStructuredAuthoringPresentation,
      externalRuns: runs, externalRunByConversationKey: new Map(), externalRunByTabId: new Map(),
      reservedInboxTabId: (_run, key) => '__noted_inbox__-tab-external-' + key,
      INBOX_PROJECT_ID: '__noted_inbox__', tabWorkContext: null,
      promptAuditFingerprint: text => crypto.createHash('sha256').update(text).digest('hex'),
      readBody: async req => req.body,
      sendJson: (_res, status, body) => ({ status, body }),
      sendTerminalBridgeError: (_res, error) => { throw error; },
      bridgeRequest: async (action, args) => {
        if (action === 'ensureInboxProject') return {};
        if (action === 'createAgentTab') return { tabId: args.reservedTabId };
        throw new Error(action);
      },
      findOrchestrationTabDescriptor: () => null, setExternalRunMeta: () => {},
      waitForAgentReady: async () => ({ status: 'active', sessionId: '117e3e29-8fe4-4ed4-b048-4d661ddbe17a' }),
      codexSessionIdFromAuthoritativeStatus: status => status.sessionId,
      runPreparedAgentSendScenario: async args => {
        calls.push(args);
        if (outcome === 'refused') return { success: false, submitted: false, code: 'terminal_draft_conflict' };
        if (outcome === 'unknown') return { success: false, submitted: true, deliveryUnknown: true, status: 'delivery-unknown' };
        return { success: true, submitted: true, status: 'sent', exactAuditConfirmed: true,
          codexAudit: { success: true, entryUuid: 'exact-user', sessionId: args.sessionId } };
      },
      sendDeliveryUnknown: (_res, value, extra) => ({ status: 202, body: { ...value, ...extra } }),
    };
    const handle = vm.runInNewContext([
      functionSource('runAgentSendScenario'), functionSource('sendSendFailure'),
      functionSource('externalRunResponseFields'), functionSource('replayExternalRunResponse'),
      functionSource('inboxSetupOutcome'), functionSource('inboxSetupRetryable'),
      functionSource('assertInboxSetupOwner'), functionSource('settleInboxSetupBeforeSend'),
      'async function post(body) { const req = {method:"POST", body}, res = {}, parsed = {pathname:"/api/inbox/runs"};',
      source.slice(routeStart, routeEnd), '\n} post',
    ].join('\n'), environment);
    const payload = { provider: 'codex', prompt: voice.buildCodexUserPrompt(msg),
      conversationKey: 'cmtthjihe8b8e606f', runId: 'b8de5f32-c589-4d30-9874-9deb2e7f934b',
      attachments: voice.codexManagedAttachments(msg), presentationSnapshot: voice.codexPresentationSnapshotForMessage(msg) };
    const result = await handle(payload);
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /<context_file [^>]*>\nIOS_OWNER_V2_FILE_OK\n<\/context_file>/);
    assert.match(calls[0].prompt, /TERMINAL_RULE/);
    assert.equal(calls[0].ownership, 'external');
    assert.equal(calls[0].sendRunId, payload.runId);
    assert.equal(calls[0].presentationSnapshot.promptChips[0].sourceKey, 'terminal:prompt-11290');
    const transport = new CodexImageTransport({ rootDir: path.join(root, 'input') });
    const plan = buildCodexImagePastePlan(calls[0].prompt, file => {
      const value = transport.stageSync({ path: file }); return { ...value, inputPath: value.path };
    });
    assert.equal(plan.missing.length, 0);
    assert.deepEqual(fs.readFileSync(plan.segments.find(item => item.kind === 'image').text), imageBytes);
    assert.equal((await handle(payload)).status, 200);
    assert.equal(calls.length, 1, 'same attempt replays, never sends again');
    for (const next of ['refused', 'unknown']) {
      outcome = next;
      const response = await handle({ ...payload, conversationKey: next, runId: next });
      assert.equal(response.body.attachments.length, 2);
      assert.equal(response.body.attachments[0].path, file);
      if (next === 'unknown') {
        assert.equal((await handle({ ...payload, conversationKey: next, runId: next })).status, 202);
        assert.equal(calls.length, 3, 'unknown preserves the original attempt');
      }
    }
    fs.writeFileSync(file, Buffer.from([0, 255, 0]));
    const binary = await handle({ ...payload, conversationKey: 'binary', runId: 'binary' });
    assert.equal(binary.status, 415);
    assert.equal(binary.body.submitted, false);
    assert.equal(binary.body.code, 'context_file_binary_unsupported');
    assert.equal(binary.body.attachments.length, 2);
    assert.equal(calls.length, 3);
    fs.unlinkSync(file);
    const gone = await handle({ ...payload, conversationKey: 'missing', runId: 'missing' });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.submitted, false);
    assert.equal(calls.length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
