'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const esbuild = require('esbuild');
const vm = require('node:vm');

const mainPath = path.join(__dirname, 'main.js');
const queueStorePath = path.join(__dirname, '../renderer/store/usePromptQueueStore.ts');

function parse(filePath, scriptKind) {
  const source = fs.readFileSync(filePath, 'utf8');
  return {
    source,
    file: ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind),
  };
}

function extractIpcHandler(filePath, channel) {
  const parsed = parse(filePath, ts.ScriptKind.JS);
  let callback = null;
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'handle'
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === channel
    ) {
      callback = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.file);
  assert.ok(callback, `missing IPC handler ${channel}`);
  return parsed.source.slice(callback.getStart(parsed.file), callback.end);
}

async function loadExactQueueOwnershipClassifier() {
  const parsed = parse(queueStorePath, ts.ScriptKind.TS);
  let declaration = null;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'queueSendTransferredOwnership') {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.file);
  assert.ok(declaration, 'missing queueSendTransferredOwnership');
  const snippet = parsed.source.slice(declaration.getStart(parsed.file), declaration.end);
  const transformed = await esbuild.transform(snippet, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });
  const loaded = new Module(queueStorePath, module);
  loaded.filename = queueStorePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(queueStorePath));
  loaded._compile(transformed.code, queueStorePath);
  return loaded.exports.queueSendTransferredOwnership;
}

function buildAppendInputCaller(safePasteResult, onSafePaste = null) {
  const callbackSource = extractIpcHandler(mainPath, 'claude:append-input');
  const term = { write() {} };
  const context = vm.createContext({
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8_000,
    console: { log() {}, warn() {}, error() {} },
    hasLiveClaudeInTab: () => true,
    safePasteAndSubmit: async (_term, _text, options) => {
      onSafePaste?.(options);
      return { ...safePasteResult };
    },
    terminals: new Map([['tab-replay', term]]),
  });
  return new vm.Script(`(${callbackSource})`, {
    filename: mainPath + '#claude:append-input',
  }).runInContext(context);
}

test('F2 complete Cmd+Replay path keeps the queue chip when physical paste refused before Enter', async () => {
  const appendInput = buildAppendInputCaller({
    success: false,
    submitted: false,
    pasteWritten: true,
    error: 'claude_submit_guard_failed_before_enter',
  });
  const queueSendTransferredOwnership = await loadExactQueueOwnershipClassifier();

  const receipt = await appendInput({}, 'tab-replay', 'keep this prompt', {
    submit: true,
    handoffId: 'replay-handoff-pre-enter',
    source: 'prompt-queue-replay',
  });
  const overlayWouldRemoveChip = receipt?.submitted === true
    && queueSendTransferredOwnership(receipt);

  assert.deepEqual({
    submitted: receipt?.submitted,
    overlayWouldRemoveChip,
  }, {
    submitted: false,
    overlayWouldRemoveChip: false,
  }, 'User-visible invariant violated: Cmd+Replay must preserve submitted:false and keep the queue chip when Enter never crossed the PTY boundary.');
});

test('F2 strongest counterexample: post-Enter audit timeout still transfers Replay ownership exactly once', async () => {
  const appendInput = buildAppendInputCaller({
    success: false,
    submitted: true,
    pasteWritten: true,
    error: 'claude_user_message_audit_timeout',
  });
  const queueSendTransferredOwnership = await loadExactQueueOwnershipClassifier();

  const receipt = await appendInput({}, 'tab-replay', 'already submitted prompt', {
    submit: true,
    handoffId: 'replay-handoff-post-enter',
    source: 'prompt-queue-replay',
  });

  assert.equal(receipt.submitted, true);
  assert.equal(queueSendTransferredOwnership(receipt), true);
});

test('Cmd+Replay forwards the image presentation snapshot into the audited submit path', async () => {
  let safePasteOptions = null;
  const appendInput = buildAppendInputCaller({
    success: true,
    submitted: true,
    pasteWritten: true,
  }, (options) => {
    safePasteOptions = options;
  });
  const presentationSnapshot = {
    promptChips: [{ id: 'prompt-1', kind: 'prompt', label: 'Saved', text: 'saved' }],
    imagePaths: [{
      id: 1,
      path: '/managed/' + 'e'.repeat(64) + '.png',
      assetId: 'e'.repeat(64) + '.png',
      mediaType: 'image/png',
      size: 10,
      availability: 'available',
    }],
  };

  await appendInput({}, 'tab-replay', '[imagePath: /managed/image.png] body', {
    submit: true,
    source: 'prompt-queue-replay',
    presentationSnapshot,
  });

  assert.deepEqual(safePasteOptions.presentationSnapshot, presentationSnapshot);
});
