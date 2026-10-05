'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');
const { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation } = require('./structured-authoring');
const { createCodexImageRequestProjection, readPersistedCodexImageRequestProjection } = require('./codex-image-request-projection');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { normalizePromptPresentationSnapshot, saveAuditedPromptPresentation, decorateHistoryPromptPresentations } = require('./history-prompt-presentations');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
let codec, images;
test.before(async () => {
  codec = await import(pathToFileURL(path.join(__dirname, '../shared/composer-chips.mjs')));
  images = await import(pathToFileURL(path.join(__dirname, '../shared/prompt-image-attachments.mjs')));
});
const clone = value => JSON.parse(JSON.stringify(value));
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function draft() {
  const fileText = 'α\noriginal snapshot\n';
  return { version: 1, parts: [
    { kind: 'text', text: 'before ' }, { kind: 'paste', chipId: 'paste-A' },
    { kind: 'text', text: ' between ' }, { kind: 'image', imageId: 9 },
    { kind: 'text', text: '\n' }, { kind: 'paste', chipId: 'paste-B' },
    { kind: 'image', imageId: 3 }, { kind: 'text', text: ' after' },
  ], chips: [
    { id: 'rules', kind: 'prompt', label: 'Rules', text: 'Be exact', sourceKey: 'library:123:variant', contextUpdateId: 'update-exact', inheritanceDepth: 2, inheritanceParentLabel: 'Parent' },
    { id: 'file', kind: 'prompt', label: 'plan.md', text: fileText, attachmentKind: 'file', filePath: '/file-need-not-exist.md', role: 'instructions', sourceKey: 'file-key', sha256: sha(fileText), bytes: Buffer.byteLength(fileText) },
    { id: 'paste-A', kind: 'paste', text: 'AAAA' }, { id: 'paste-B', kind: 'paste', text: 'BBBB' },
  ], imagePaths: [{ id: 3, path: '/not-materialized/A.png', mediaType: 'image/png', size: 33 }, { id: 9, path: '/not-materialized/B.png', mediaType: 'image/png', size: 99 }] };
}

test('portable parts use the desktop serializer and perform zero file/image materialization', async () => {
  const input = draft(), before = clone(input);
  const result = await prepareStructuredAuthoring(input);
  const text = codec.composerTextFromParts(input.parts, input.chips);
  const desktop = codec.serializeComposerDraft({ text: images.buildPromptImagePayload(text, input.imagePaths), chips: input.chips }).trim();
  assert.equal(result.prompt, desktop);
  assert.deepEqual(input, before);
  assert.match(result.prompt, /before <pasted_content>\nAAAA\n<\/pasted_content> between \[imagePath: \/not-materialized\/B.png\]/);
  assert.deepEqual(result.presentationSnapshot.imagePaths.map(ref => ref.id), [1, 2]);
  assert.deepEqual(result.presentationSnapshot.imagePaths.map(ref => ref.path), ['/not-materialized/B.png', '/not-materialized/A.png']);
  const staged = [];
  const plan = buildCodexImagePastePlan(result.prompt, file => {
    staged.push(file); return { success: true, path: file, inputPath: '/alias/' + path.basename(file) };
  });
  assert.deepEqual(staged, ['/not-materialized/B.png', '/not-materialized/A.png']);
  assert.equal(plan.replaced, 2, 'one provider staging per declared position, no attachment prefix duplicates');
  assert.doesNotMatch(result.prompt, /Attached files from iOS/);
});

test('declared upload files are exact UTF-16 text-part spans handled by the existing serializer', async () => {
  const path = '/not-read/документ.pdf', prefix = '📄 PDF: ';
  const input = { version: 1, imagePaths: [], chips: [{ id: 'p', kind: 'paste', text: 'PASTE' }],
    parts: [{ kind: 'paste', chipId: 'p' }, { kind: 'text', text: '\n' + prefix + path,
      uploadFiles: [{ path, start: 1 + prefix.length, end: 1 + prefix.length + path.length, name: 'документ.pdf' }] }] };
  await assert.rejects(prepareStructuredAuthoring(input), /supported terminal Send upload ownership/);
  const before = clone(input), result = await prepareStructuredAuthoring(input, { allowUploadFiles: true });
  assert.deepEqual(input, before);
  assert.equal(result.prompt, codec.serializeComposerDraft(input).trim());
  assert.equal(result.uploadAttachments[0].path, path);
  const range = result.uploadFileRanges[0]; assert.equal(result.prompt.slice(range.start, range.end), path);
  const bound = bindStructuredAuthoringPresentation(result.presentationSnapshot, result.prompt, 'EXACT PREFIX\n' + result.prompt);
  const moved = bound.authoringTransport.fileRanges[0];
  assert.equal(('EXACT PREFIX\n' + result.prompt).slice(moved.start, moved.end), path);
  assert.equal(result.authoringSnapshot.parts[1].text, input.parts[1].text, 'binary upload is not a fabricated context_file body');
});

test('Rewind -> edited portable parts -> Send -> audited History -> Rewind retains all metadata', async () => {
  const original = draft();
  const presentationText = codec.serializeComposerDraft({ parts: original.parts, chips: original.chips });
  const restored = codec.restoreComposerDraftFromHistoryPresentation({ text: presentationText,
    chips: original.chips, imagePaths: original.imagePaths, includeAuthoring: true });
  assert.equal(restored.authoring.version, 1);
  const firstPaste = restored.authoring.chips.find(chip => chip.kind === 'paste');
  firstPaste.text = 'Edited 🐈 pasted body with a different length';
  restored.authoring.parts[0].text = 'changed leading text ';
  const sent = await prepareStructuredAuthoring(restored.authoring);
  assert.match(sent.prompt, /Edited 🐈 pasted body with a different length/);
  assert.doesNotMatch(sent.prompt, /Pasted Content \d+ chars/);
  assert.match(sent.authoringSnapshot.editorText, /Pasted Content/);
  const normalized = normalizePromptPresentationSnapshot(sent.presentationSnapshot);
  const { id, kind, label, text, sourceKey, contextUpdateId, inheritanceDepth, inheritanceParentLabel } = normalized.promptChips[0];
  assert.deepEqual({ id, kind, label, text, sourceKey, contextUpdateId, inheritanceDepth, inheritanceParentLabel }, original.chips[0]);
  for (const field of ['sourceKey', 'filePath', 'sha256', 'bytes', 'role']) assert.equal(normalized.promptChips[1][field], original.chips[1][field]);
  const rows = [];
  const db = { saveHistoryPromptPresentation: row => { rows.push(row); return true; }, getHistoryPromptPresentations: () => rows };
  assert.equal(saveAuditedPromptPresentation(db, { toolType: 'codex', sessionId: 'test-session', entryUuid: 'test-user',
    auditTimestamp: '2026-09-13T00:00:00Z', actualHash: 'audit-exact', snapshot: sent.presentationSnapshot }), true);
  const canonical = sent.prompt.replace('[imagePath: /not-materialized/B.png]', '[Image #1]')
    .replace('[imagePath: /not-materialized/A.png]', '[Image #2]');
  const [entry] = decorateHistoryPromptPresentations(db, { toolType: 'codex', sessionId: 'test-session', entries: [
    { role: 'user', uuid: 'test-user', content: canonical, timestamp: '2026-09-13T00:00:00Z' },
  ] });
  const again = codec.restoreComposerDraftFromHistoryPresentation({ text: entry.content,
    chips: entry.promptChips, imagePaths: entry.imagePaths, includeAuthoring: true });
  assert.equal(again.authoring.chips[0].sourceKey, original.chips[0].sourceKey);
  assert.equal(again.authoring.chips[0].contextUpdateId, 'update-exact');
  assert.equal(again.authoring.chips.find(chip => chip.attachmentKind === 'file').sha256, original.chips[1].sha256);
  assert.equal((await prepareStructuredAuthoring(again.authoring)).prompt, sent.prompt);
});

test('a literal paste-looking text part cannot steal another part with the same displayed size', async () => {
  const result = await prepareStructuredAuthoring({ version: 1, parts: [
    { kind: 'text', text: '[Pasted Content 4 chars] literal ' }, { kind: 'paste', chipId: 'p' },
  ], chips: [{ id: 'p', kind: 'paste', text: 'AAAA' }], imagePaths: [] });
  assert.equal(result.prompt, '[Pasted Content 4 chars] literal <pasted_content>\nAAAA\n</pasted_content>');
});

test('legacy text/chips draft remains supported; known unavailable images use the common imageError policy', async () => {
  const result = await prepareStructuredAuthoring({ version: 1, text: 'A [Image #1] B', chips: [],
    imagePaths: [{ id: 1, path: '/missing.png', availability: 'missing', error: 'gone' }] });
  assert.match(result.prompt, /A \[imageError: queued_image_path_unavailable #1\] B/);
  assert.equal(result.presentationSnapshot.imagePaths.length, 0);
  assert.equal(result.authoringSnapshot.imagePaths[0].availability, 'missing');
});

for (const [name, corrupt] of Object.entries({
  version: d => { d.version = 2; }, bothRepresentations: d => { d.text = 'stale'; },
  duplicateChip: d => { d.chips.push(d.chips[0]); }, duplicateImage: d => { d.imagePaths.push(d.imagePaths[0]); },
  unknownPart: d => { d.parts[0].kind = 'html'; }, missingPaste: d => { d.parts[1].chipId = 'unknown'; },
  missingImage: d => { d.parts[3].imageId = 99; }, orphanPaste: d => { d.parts.splice(1, 1); },
  orphanImage: d => { d.parts.splice(3, 1); }, forgedHash: d => { d.chips[1].sha256 = 'b'.repeat(64); },
  wrongBytes: d => { d.chips[1].bytes++; }, wrongRole: d => { d.chips[1].role = 'system'; },
  relativeImage: d => { d.imagePaths[0].path = 'A.png'; }, pathInjection: d => { d.imagePaths[0].path = '/A] extra.png'; },
  badSourceKey: d => { d.chips[0].sourceKey = {}; }, badInheritance: d => { d.chips[0].inheritanceDepth = 1.5; },
  unknownMetadata: d => { d.chips[0].auditTimestamp = 'forged'; }, invalidUnicode: d => { d.parts[0].text = '\ud800'; },
  fileInheritance: d => { d.chips[1].inheritanceDepth = 1; }, fileUpdateId: d => { d.chips[1].contextUpdateId = 'wrong-kind'; },
  multilineLabel: d => { d.chips[0].label = 'broken\nlabel'; },
})) test('rejects ' + name + ' before Send', async () => {
  const input = draft(); corrupt(input);
  await assert.rejects(prepareStructuredAuthoring(input), error => error.code === 'structured_authoring_invalid' && error.submitted === false);
});

test('mixed legacy/structured payload cannot materialize attachments twice or accept forged presentation proof', () => {
  for (const field of ['prompt', 'attachments', 'files', 'prompts', 'presentationSnapshot']) {
    assert.throws(() => validateStructuredSendEnvelope({ expectedSessionId: 'S', expectedToolType: 'codex', [field]: field === 'prompt' ? 'duplicate' : [{}] }), /cannot be combined/);
  }
  validateStructuredSendEnvelope({ expectedSessionId: 'S', expectedToolType: 'codex', prompt: '', attachments: [] });
  assert.doesNotThrow(() => validateStructuredSendEnvelope({ expectedSessionId: 'S', expectedToolType: 'claude' }));
  assert.doesNotThrow(() => validateStructuredSendEnvelope({ expectedSessionId: null, expectedToolType: 'claude' }));
  assert.throws(() => validateStructuredSendEnvelope({ expectedSessionId: 'S', expectedToolType: 'gemini' }));
});

test('actual send fingerprint includes structured metadata and remains order-independent for JSON object keys', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const parsed = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  let statement;
  function visit(node) { if (ts.isVariableStatement(node) && node.getText(parsed).startsWith('const requestFingerprint = sendRequestFingerprint')) statement = node; ts.forEachChild(node, visit); }
  visit(parsed); assert.ok(statement);
  const result = await prepareStructuredAuthoring(draft());
  const scope = { sendRequestFingerprint: null, fingerprintAgentSendRequest, prompt: result.prompt,
    model: null, effort: null, thinking: null, cwd: null, source: null, queue: false, ownership: 'project', expectedTarget: null,
    authoringSnapshot: result.authoringSnapshot };
  const calculate = values => vm.runInNewContext(statement.getText(parsed) + '\nrequestFingerprint', values);
  const first = calculate(scope);
  const reordered = clone(result.authoringSnapshot);
  reordered.chips[0] = Object.fromEntries(Object.entries(reordered.chips[0]).reverse());
  assert.equal(calculate({ ...scope, authoringSnapshot: reordered }), first);
  reordered.chips[0].sourceKey = 'other-library-key';
  assert.notEqual(calculate({ ...scope, authoringSnapshot: reordered }), first);
});

test('file/paste literals stay text while exact image spans survive context prefix and durable projection replay', async () => {
  const input = draft();
  input.chips[1].text = 'literal file syntax [imagePath: /file-example.png]';
  input.chips[1].sha256 = sha(input.chips[1].text); input.chips[1].bytes = Buffer.byteLength(input.chips[1].text);
  input.chips[2].text = '[imagePath: /paste-example.png]';
  const result = await prepareStructuredAuthoring(input);
  const prepared = '<saved_prompt name="context">[imagePath: /context-example.png]</saved_prompt>\n\n' + result.prompt;
  const presentation = bindStructuredAuthoringPresentation(result.presentationSnapshot, result.prompt, prepared);
  const staged = [];
  const plan = buildCodexImagePastePlan(prepared, file => {
    const ref = { path: file, size: 42, mediaType: 'image/png' }; staged.push(ref);
    return { success: true, ...ref, inputPath: '/alias/' + path.basename(file) };
  }, { authoringTransport: presentation.authoringTransport });
  assert.deepEqual(staged.map(ref => ref.path), ['/not-materialized/B.png', '/not-materialized/A.png']);
  for (const name of ['file', 'paste', 'context']) assert.ok(plan.text.includes('[imagePath: /' + name + '-example.png]'));
  const scope = { tabId: 'T', handoffId: 'H', operationKey: 'O', attemptId: 'A' };
  const proof = createCodexImageRequestProjection({ ...scope, requestText: prepared, transportText: plan.text,
    segments: plan.segments, imageRefs: staged, authoringTransport: presentation.authoringTransport });
  assert.ok(proof);
  const record = { ...scope, provider: 'codex', promptHash: promptAuditFingerprint(prepared), promptLength: prepared.length,
    receipt: { operationKey: 'O', attemptId: 'A', promptText: prepared, transportText: plan.text,
      expectedImageRefs: staged, expectedImagePaths: plan.segments.filter(segment => segment.kind === 'image').map(segment => segment.text), imageRequestProjection: proof } };
  assert.equal(readPersistedCodexImageRequestProjection(clone(record)).valid, true);
  const corrupt = clone(record); corrupt.receipt.imageRequestProjection.authoringTransport.imageRanges[0].start++;
  assert.equal(readPersistedCodexImageRequestProjection(corrupt).valid, false);
  assert.throws(() => bindStructuredAuthoringPresentation(result.presentationSnapshot, result.prompt, 'different body'), /changed authoring body/);
});

test('invalid image span refuses before even the first staging callback', async () => {
  const result = await prepareStructuredAuthoring(draft());
  const plan = clone(result.presentationSnapshot.authoringTransport);
  plan.imageRanges[1].end--;
  let stages = 0;
  assert.throws(() => buildCodexImagePastePlan(result.prompt, () => { stages++; }, { authoringTransport: plan }), /structured_image_plan_invalid/);
  assert.equal(stages, 0);
});

test('raw anchor compatibility rejects stale counts instead of prepending an edited paste twice', async () => {
  await assert.rejects(prepareStructuredAuthoring({ version: 1, text: 'A [Pasted Content 4 chars] B',
    chips: [{ id: 'p', kind: 'paste', text: 'now longer' }], imagePaths: [] }), /stale or unbound/);
});

test('actual App send caller forwards typed image spans and editable draft without a second serializer', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const parsed = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let call;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'runHistoryPromptHandoff'
      && node.getText(parsed).includes('authoringSnapshot.editorText')) call = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed); assert.ok(call);
  const prepared = await prepareStructuredAuthoring(draft());
  let handoff, sent;
  const context = { tabId: 'T', toolType: 'codex', sessionId: 'S', prompt: prepared.prompt,
    presentationSnapshot: prepared.presentationSnapshot, authoringSnapshot: prepared.authoringSnapshot,
    handoffId: 'H', sendAttemptId: 'A', sendOperationKey: 'O', promptSource: 'project-api',
    statusAtSend: 'active', runtime: {}, cwd: '/fixture', tab: {}, queue: false,
    model: undefined, effort: undefined, thinking: undefined, returnDraftOnConflict: false,
    payload: { workContextPrepared: true },
    createAgentSettingsIntent: input => input,
    sendAgentPromptScenario: async input => { sent = input; return { submitted: true }; },
    runHistoryPromptHandoff: async input => { handoff = input; return input.send('H'); },
  };
  const js = ts.transpileModule(call.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  await vm.runInNewContext(js, context);
  assert.equal(handoff.authoringText, prepared.authoringSnapshot.editorText);
  assert.equal(handoff.authoringChips, prepared.authoringSnapshot.chips);
  assert.equal(sent.prompt, prepared.prompt);
  assert.equal(sent.presentationSnapshot.authoringTransport, prepared.presentationSnapshot.authoringTransport);
  assert.equal(sent.workContextPrepared, true);
});

test('zero-byte context file and an empty paste wrapper do not become dangling or dropped authoring refs', async () => {
  const file = { id: 'empty', kind: 'prompt', attachmentKind: 'file', filePath: '/empty.md', role: 'source',
    label: 'empty.md', text: '', bytes: 0, sha256: sha(''), sourceKey: 'empty-source' };
  const text = codec.serializeComposerDraft({ chips: [file], text: '<pasted_content>\n\n</pasted_content> hello' });
  const restored = codec.restoreComposerDraftFromHistoryPresentation({ text, chips: [file], includeAuthoring: true });
  const prepared = await prepareStructuredAuthoring(restored.authoring);
  assert.equal(prepared.prompt, text);
  const durable = normalizePromptPresentationSnapshot(prepared.presentationSnapshot);
  assert.equal(durable.promptChips[0].sourceKey, 'empty-source');
  assert.equal(durable.promptChips[0].bytes, 0);
});

test('prompt-chip-only message has an empty body, not a negative prefix offset', async () => {
  const result = await prepareStructuredAuthoring({ version: 1, parts: [], chips: [draft().chips[0]], imagePaths: [] });
  assert.equal(result.presentationSnapshot.authoringTransport.bodyLength, 0);
  const bound = bindStructuredAuthoringPresentation(result.presentationSnapshot, result.prompt, 'context\n' + result.prompt);
  assert.deepEqual(bound.authoringTransport.imageRanges, []);
});
