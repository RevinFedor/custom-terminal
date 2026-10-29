'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const Module = require('node:module'), { pathToFileURL } = require('node:url'), ts = require('typescript');
const Database = require('better-sqlite3');
const root = __dirname, pre = process.env.TRANSPORT_PRE_ROOT;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const source = file => fs.readFileSync(path.join(pre || path.join(root, '../..'), file), 'utf8');
const actual = (file, name) => {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
function selectedModule(file) {
  if (!pre) return require('./' + file);
  const loaded = new Module(path.join(root, file), module); loaded.filename = path.join(root, file);
  loaded.paths = module.paths; loaded._compile(source('src/main/' + file), loaded.filename); return loaded.exports;
}
async function composer() {
  if (!pre) return import('../shared/composer-chips.mjs');
  const text = source('src/shared/composer-chips.mjs').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => 'from ' + JSON.stringify(pathToFileURL(path.join(root, '../shared', relative)).href));
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
}
const quiet = { log() {}, warn() {}, error() {} };
function contextFixture(t) {
  const db = new Database(':memory:');
  const { TabWorkContext } = selectedModule('tab-work-context.js');
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'T', projectId: 'P',
    commandType: 'codex', tabType: 'terminal', cwd: '/synthetic' }], archivedTab: () => null, onChanged() {} });
  context.configure({ readReceipts: () => [] });
  t.after(async () => { await context.syncLinks(); for (const watcher of context.watchers.values()) watcher.close();
    await Promise.allSettled([...context.reads.values()]); db.close(); });
  return { db, context };
}
function mainImagePrepare(text, authoringTransport) {
  const calls = [];
  const c = vm.createContext({ console: quiet, buildCodexImagePastePlan: require('./codex-image-transport').buildCodexImagePastePlan,
    stageCodexImagePathForPasteSync: (_tab, sourcePath) => { calls.push(sourcePath); return { success: true,
      path: sourcePath, inputPath: '/synthetic/alias-' + calls.length + '.png', size: 1, mediaType: 'image/png' }; } });
  vm.runInContext(actual('src/main/main.js', 'prepareCodexImagePathMarkersForPaste'), c);
  return { calls, plan: c.prepareCodexImagePathMarkersForPaste('T', text, 'controlled', authoringTransport || null) };
}

test('causal actual History assembly → context handoff → Main keeps a paste-chip literal, stages only its real neighbor', async t => {
  const c = await composer(), h = contextFixture(t);
  const chip = { id: 'paste-one', kind: 'paste', text: 'literal [imagePath: /synthetic/example.png] 🧩' };
  const raw = 'before ' + c.buildPasteChipMarker(chip) + '\n[imagePath: /synthetic/real.png]';
  h.context.publish('T', { title: 'MD', text: 'deferred [imagePath: /synthetic/md-example.png]' });
  const panel = source('src/renderer/components/Workspace/HistoryPanel.tsx');
  const start = panel.indexOf(pre ? '        let sendPayload = serializeComposerDraft({' : '        const draftTransport = prepareComposerDraftTransport({');
  const end = panel.indexOf("        markSendPreparation('context-ready');", start);
  assert.ok(start > 0 && end > start);
  const assemble = vm.runInNewContext('(async () => { let sendIncidentPromptText; ' + panel.slice(start, end)
    + '; return { prompt: contextPrepared.prompt, plan: contextPrepared.authoringTransport }; })', {
    ...c, preparedPrompt: { payload: raw }, sendDraftChips: [chip],
    historyServicePromptFingerprint: sha, actionTabId: 'T', handoffId: 'history-literal',
    prepareTabWorkContext: (...args) => h.context.prepare(...args),
  });
  const result = await assemble(), staged = mainImagePrepare(result.prompt, result.plan);
  assert.ok(result.prompt.includes(chip.text));
  assert.ok(result.prompt.includes('deferred [imagePath: /synthetic/md-example.png]'));
  assert.deepEqual(staged.calls, ['/synthetic/real.png']);
  assert.ok(staged.plan.text.includes(chip.text), 'literal bytes do not change');
  const repeated = await h.context.prepare('T', 'history-literal', result.prompt, result.plan);
  assert.deepEqual(JSON.parse(JSON.stringify(repeated)), JSON.parse(JSON.stringify(result.plan
    ? { prompt: result.prompt, prefix: repeated.prefix, authoringTransport: result.plan } : repeated)));
});

test('user-written wrapper delimiters alone do not exempt portable image markers', async () => {
  const c = await composer(), raw = '<pasted_content>\n[imagePath: /synthetic/user.png]\n</pasted_content>';
  const prepared = c.prepareComposerDraftTransport ? c.prepareComposerDraftTransport({ text: raw }) : { prompt: c.serializeComposerDraft({ text: raw }) };
  assert.deepEqual(mainImagePrepare(prepared.prompt, prepared.imageRanges && { sourceHash: sha(prepared.prompt),
    imageRanges: prepared.imageRanges }).calls, ['/synthetic/user.png']);
});

test('explicit typed image authorship wins over web-looking surrounding text, while typed text stays literal', async () => {
  const c = await composer();
  if (!c.prepareComposerDraftTransport) return;
  const prepared = c.prepareComposerDraftTransport({ parts: [{ kind: 'text', text: '[image](https://example.test/icon "' },
    { kind: 'image', imageId: 9 }, { kind: 'text', text: '")\nliteral [imagePath: /synthetic/example.png]' }],
  renderImage: () => '[imagePath: /synthetic/typed.png]' });
  assert.deepEqual(mainImagePrepare(prepared.prompt, { sourceHash: sha(prepared.prompt), imageRanges: prepared.imageRanges }).calls,
    ['/synthetic/typed.png']);
});

function webFunctions(names, extra = {}) {
  const c = vm.createContext({ require, path, crypto, srcMainDir: root, console: quiet,
    ...require('./agent-saved-prompt-refs'), ...require('./agent-context-files'), ...extra });
  vm.runInContext(names.map(name => actual('src/main/web-server.js', name)).join('\n'), c); return c;
}
test('causal MCP saved/context bodies are literal, and a same-path attachment declaration still stages once', async () => {
  const text = 'example [imagePath: /synthetic/same.png]';
  const web = webFunctions(['resolveSendPromptPresentation', 'appendAttachmentsToPrompt'], {
    resolveSavedPromptRefs: async () => [{ id: 'rules', kind: 'prompt', label: 'Rules', text }],
    resolveContextFileRefs: async () => [{ id: 'file', kind: 'prompt', attachmentKind: 'file',
      filePath: '/synthetic/source.md', role: 'source', label: 'File', text }],
    normalizeSendAttachments: x => x || [],
  });
  const prepared = await web.resolveSendPromptPresentation({ getPrompts: () => [] }, { prompts: ['rules'], files: ['file'] }, 'ordinary text');
  const bound = web.appendAttachmentsToPrompt(prepared.prompt, [{ kind: 'image', path: '/synthetic/same.png' }], {
    includeFileRanges: true, authoringTransport: prepared.presentationSnapshot?.authoringTransport,
  });
  const result = mainImagePrepare(bound.prompt, bound.authoringTransport);
  assert.equal(result.calls.length, 1, 'two literal examples must not stage or swallow the attachment');
  assert.equal((result.plan.text.match(/example \[imagePath: \/synthetic\/same.png\]/g) || []).length, 2);
});

test('context refresh uses exact edits, Unicode coordinates, idempotent frozen plan and no double delta', async t => {
  const { context } = contextFixture(t);
  const published = context.publish('T', { title: 'update', text: 'new [imagePath: /synthetic/example.png]' });
  const old = '<saved_prompt context-update-id="' + published.updateId + '">old</saved_prompt>';
  const prompt = '🧩 [imagePath: /synthetic/first.png]\n' + old + '\n[imagePath: /synthetic/last.png]';
  const sourcePlan = { sourceHash: sha(prompt), imageRanges: require('../shared/prompt-web-images.cjs').collectLegacyPromptImageRanges(prompt) };
  const first = await context.prepare('T', 'refresh-literal', prompt, sourcePlan);
  assert.ok(first.prompt.includes('new [imagePath: /synthetic/example.png]'));
  assert.deepEqual(mainImagePrepare(first.prompt, first.authoringTransport).calls, ['/synthetic/first.png', '/synthetic/last.png']);
  assert.deepEqual(await context.prepare('T', 'refresh-literal', prompt, sourcePlan), first);
  assert.deepEqual(await context.prepare('T', 'refresh-literal', first.prompt, first.authoringTransport), first);
  const binder = require('./structured-authoring').bindStructuredAuthoringPresentation;
  assert.deepEqual(binder({ authoringTransport: first.authoringTransport }, first.prompt, first.prompt).authoringTransport, first.authoringTransport);
  await assert.rejects(context.prepare('T', 'refresh-literal', prompt, { ...sourcePlan, imageRanges: [] }), /authoring changed/);
});

test('completion exact answer body + favicon title + real prefix image share the same legacy collector', () => {
  const body = 'literal [imagePath: /synthetic/answer.png]';
  const prefix = '[image](https://example.test/icon "[imagePath: /synthetic/favicon.png]")\n[imagePath: /synthetic/real.png]\n';
  const web = webFunctions(['orchestrationPresentationSnapshot']);
  const prompt = prefix + body;
  const snapshot = web.orchestrationPresentationSnapshot({ runId: 'research', runKind: 'external-research' },
    'completion', { prompt: body, bodyStart: 0, bodyEnd: body.length }, prompt);
  assert.deepEqual(mainImagePrepare(prompt, snapshot.authoringTransport).calls, ['/synthetic/real.png']);
});

const transport = require('./codex-image-transport'), projection = selectedModule('codex-image-request-projection.js');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const auditModule = require('./codex-prompt-audit');
function transformed({ preflight = false, mixed = false } = {}) {
  const request = 'keep  exact\n[imagePath: /synthetic/missing.png]' + (mixed ? '\n[imagePath: /synthetic/ok.png]\n[imagePath: /synthetic/missing.png]' : '') + '\nend';
  const sourcePlan = { sourceHash: sha(request), imageRanges: require('../shared/prompt-web-images.cjs').collectLegacyPromptImageRanges(request) };
  const before = preflight ? transport.buildUnavailableImagePathPlan(request,
    [{ path: '/synthetic/missing.png', error: 'image_path_missing' }], sourcePlan) : null;
  const plan = transport.buildCodexImagePastePlan(before?.text || request, sourcePath => sourcePath.includes('missing')
    ? { success: false, error: 'image_path_missing', path: sourcePath }
    : { success: true, path: sourcePath, inputPath: '/synthetic/alias.png', size: 1, mediaType: 'image/png' },
  { authoringTransport: before?.authoringTransport || sourcePlan });
  const stages = [...(before ? [before.transform] : []), ...(plan.replaced ? [plan.transform] : [])];
  const scope = { tabId: 'T', handoffId: 'H', operationKey: 'history:T:H', attemptId: 'A' };
  const proof = projection.createCodexImageRequestProjection({ ...scope, requestText: request, transportText: plan.text,
    segments: plan.segments, imageRefs: plan.staged, authoringTransport: sourcePlan, stages });
  const record = { ...scope, provider: 'codex', sessionId: 'S', promptHash: hash(request), promptLength: request.length };
  const audit = { handoffId: 'H', sendOperationKey: scope.operationKey, sendAttemptId: 'A',
    expectedText: plan.text, expectedHash: hash(plan.text), expectedLen: plan.text.length,
    imageRequestProjection: proof, expectedImagePaths: plan.segments.filter(s => s.kind === 'image').map(s => s.text),
    expectedImageRefs: plan.staged };
  return { request, record, audit, plan, stages, proof };
}
for (const preflight of [false, true]) for (const mixed of [false, true]) test('causal request projection handles ' +
  (mixed ? 'mixed' : 'all-missing') + ' at ' + (preflight ? 'preflight' : 'staging'), () => {
  const f = transformed({ preflight, mixed });
  assert.ok(f.proof, 'actual ordered Main outcomes must bind the immutable request');
  const native = mixed ? f.plan.text.replace('/synthetic/alias.png', '[Image #1]') : f.plan.text;
  const result = { success: true, actualText: native, actualHash: hash(native), actualLen: native.length,
    expectedHash: f.audit.expectedHash, expectedLen: f.audit.expectedLen };
  assert.equal(projection.projectCodexImageAuditToRequest({ tabId: 'T', ...f, result }).applied, true);
  for (const changed of [native.replace('unavailable #1', 'unavailable #9'),
    native.replace('keep  exact', 'keep exact'), native.replace('_path_unavailable', '_different_error')]) {
    assert.equal(projection.projectCodexImageAuditToRequest({ tabId: 'T', ...f,
      result: { ...result, actualText: changed, actualHash: hash(changed), actualLen: changed.length } }).applied, false);
  }
});

test('strict mixed carrier preserves literal markers and rejects forged ranges/hash/error/scope/ref', () => {
  const f = transformed({ mixed: true }); assert.ok(f.proof);
  for (const mutate of [x => x.audit.imageRequestProjection.stages[0].outcomes[0].error = '',
    x => x.audit.imageRequestProjection.stages[0].outcomes[0].sourceRange.start++,
    x => x.audit.imageRequestProjection.attemptId = 'foreign', x => x.audit.expectedImageRefs[0].path = '/foreign.png',
    x => x.audit.imageRequestProjection.stages[0].outputHash = 'f'.repeat(64)]) {
    const changed = JSON.parse(JSON.stringify(f)); mutate(changed);
    assert.equal(projection.validateCodexImageRequestProjection({ tabId: 'T', record: changed.record, audit: changed.audit }).valid, false);
  }
  const literal = f.plan.text + '\nliteral [Image #12] [imageError: exact #77]';
  const extra = { ...f.audit, expectedText: literal };
  assert.equal(auditModule.matchCodexImageTransformCarrier(extra,
    literal.replace('/synthetic/alias.png', '[Image #1]').replace('exact #77', 'other #77')), false);
});

test('strict positive boundary preserves ordinary spaces and the supported native slot separator', () => {
  const request = 'before  [imagePath: /synthetic/ok.png] after  unchanged [imageError: literal #12]';
  const plan = transport.buildCodexImagePastePlan(request, sourcePath => ({ success: true, path: sourcePath, inputPath: '/synthetic/alias.png' }));
  const proof = projection.createCodexImageRequestProjection({ tabId: 'T', handoffId: 'H', operationKey: 'history:T:H', attemptId: 'A',
    requestText: request, transportText: plan.text, segments: plan.segments, imageRefs: plan.staged, stages: [plan.transform] });
  assert.ok(proof);
  const expected = { expectedText: plan.text, imageRequestProjection: proof };
  for (const token of ['[Image #1]', '[Image #1] ']) {
    const native = plan.text.replace('/synthetic/alias.png', token);
    assert.equal(auditModule.matchCodexImageTransformCarrier(expected, native), true);
    assert.equal(auditModule.matchCodexImageTransformCarrier(expected, native.replace('after  unchanged', 'after unchanged')), false);
    assert.equal(auditModule.matchCodexImageTransformCarrier(expected, native.replace('literal #12', 'other #12')), false);
  }
});

test('all-missing proof reaches real durable promotion; arbitrary allowlisted hash or missing pre-Enter proof cannot', t => {
  const f = transformed(); assert.ok(f.proof);
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = require('./agent-send-receipt-store').createAgentSendReceiptStore(db, { randomUUID: () => 'A' });
  const identity = { ...f.record, surface: 'desktop-history', requestFingerprint: 'frozen' };
  store.beginAttempt(identity);
  store.stageAttemptContext(identity.operationKey, 'A', { promptText: f.request, transportText: f.plan.text,
    expectedImagePaths: [], expectedImageRefs: [], imageRequestProjection: f.proof });
  store.markAttemptState(identity.operationKey, 'A', 'enter-armed');
  const audit = { success: true, operationKey: identity.operationKey, attemptId: 'A', provider: 'codex', sessionId: 'S',
    promptHash: identity.promptHash, expectedHash: identity.promptHash, actualHash: hash(f.plan.text),
    canonicalized: true, canonicalReason: 'codex_image_request_transform', entryUuid: 'native',
    sourceIdentity: 'codex-user-source-S-0', auditTimestamp: new Date().toISOString() };
  assert.equal(store.promoteFromAudit(audit).promoted, false);
  assert.equal(store.promoteFromAudit({ ...audit, actualHash: 'forged-native-hash', imageTransformEvidence: {
    actualText: f.plan.text, actualHash: hash(f.plan.text), actualLen: f.plan.text.length,
    actualIdentity: { sessionId: 'S', filePath: '/synthetic/own.jsonl', byteOffset: 0, timestamp: new Date().toISOString() },
  } }).promoted, false, 'valid reconstruction cannot bless a different caller native hash');
  assert.equal(store.promoteFromAudit({ ...audit, imageTransformEvidence: { actualText: f.plan.text + 'changed',
    actualHash: hash(f.plan.text + 'changed'), actualLen: f.plan.text.length + 7 } }).promoted, false);
  assert.equal(store.promoteFromAudit({ ...audit, imageTransformEvidence: { actualText: f.plan.text,
    actualHash: hash(f.plan.text), actualLen: f.plan.text.length, actualImagePaths: [],
    actualIdentity: { sessionId: 'S', filePath: '/synthetic/own.jsonl', byteOffset: 0, timestamp: new Date().toISOString() } } }).promoted, true);
  assert.equal(store.get(identity.operationKey).promptHash, hash(f.request));
});

test('two originals that degrade to identical error transport cannot claim the same native row', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = require('./agent-send-receipt-store').createAgentSendReceiptStore(db);
  const native = '[imageError: codex_image_path_unavailable #1]';
  const timestamp = new Date(Date.now() + 1000).toISOString();
  for (const [index, file] of ['/synthetic/one.png', '/synthetic/two.png'].entries()) {
    const request = '[imagePath: ' + file + ']', handoffId = 'H' + index, operationKey = 'history:T:' + handoffId;
    const record = { tabId: 'T', handoffId, operationKey, provider: 'codex', surface: 'desktop-history',
      sessionId: 'S', promptHash: hash(request), promptLength: request.length, requestFingerprint: handoffId };
    const { attemptId } = store.beginAttempt(record);
    const plan = transport.buildCodexImagePastePlan(request, () => ({ success: false, error: 'image_path_missing', path: file }));
    const proof = projection.createCodexImageRequestProjection({ ...record, attemptId, requestText: request, transportText: plan.text,
      imageRefs: [], segments: plan.segments, stages: [plan.transform] }); assert.ok(proof);
    store.stageAttemptContext(operationKey, attemptId, { promptText: request, transportText: plan.text,
      imageRequestProjection: proof, expectedImagePaths: [], expectedImageRefs: [] });
    store.markAttemptState(operationKey, attemptId, 'enter-armed');
    const result = store.promoteFromAudit({ success: true, operationKey, attemptId, provider: 'codex', sessionId: 'S',
      promptHash: hash(request), expectedHash: hash(request), actualHash: hash(native),
      canonicalized: true, canonicalReason: 'codex_image_request_transform', entryUuid: 'one-native-user',
      sourceIdentity: 'codex-user-source-S-11', auditTimestamp: timestamp,
      imageTransformEvidence: { actualText: native, actualHash: hash(native), actualLen: native.length,
        actualIdentity: { sessionId: 'S', filePath: '/synthetic/own.jsonl', byteOffset: 11, timestamp } } });
    assert.equal(result.promoted, index === 0);
    if (index) assert.equal(result.reason, 'canonical-user-already-owned');
  }
});
