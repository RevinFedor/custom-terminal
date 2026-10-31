'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { installAgentSendWebBindings } = require('./agent-send-web-bindings.cjs');
const { isDesktopCodexCompactQueueRequest } = require('../../shared/agent-local-command.cjs');

const compactRequest = extra => ({ toolType: 'codex', source: 'history-panel', prompt: '/compact', ...extra });

for (const prompt of ['/compact', ' /compact ', '\t/compact\t']) {
  test('shared Compact eligibility accepts only normalized argument-free command: ' + JSON.stringify(prompt), () => {
    assert.equal(isDesktopCodexCompactQueueRequest(compactRequest({ prompt })), true);
  });
}

for (const [label, extra] of [
  ['missing request', null],
  ['missing provider', { toolType: undefined }],
  ['Claude', { toolType: 'claude' }],
  ['SDK', { toolType: 'claude-sdk' }],
  ['case-changed provider', { toolType: 'Codex' }],
  ['mixed provider', { toolType: 'codex', provider: 'claude' }],
  ['missing source', { source: undefined }],
  ['Project API', { source: 'project-api' }],
  ['native', { source: 'mobile-native' }],
  ['automatic queue', { source: 'prompt-queue' }],
  ['source suffix', { source: 'history-panel-extra' }],
  ['source whitespace', { source: ' history-panel ' }],
  ['record without reply', { recordWithoutReply: true }],
  ['another slash', { prompt: '/fast' }],
  ['argument', { prompt: '/compact now' }],
  ['tab-separated argument', { prompt: '/compact\tnow' }],
  ['multiline authoring', { prompt: '/compact\nkeep this text' }],
  ['carriage-return authoring', { prompt: '/compact\rkeep this text' }],
  ['changed case command', { prompt: '/Compact' }],
  ['zero-width suffix', { prompt: '/compact\u200b' }],
  ['non-string prompt', { prompt: { text: '/compact' } }],
]) test('shared Compact eligibility refuses ' + label, () => {
  assert.equal(isDesktopCodexCompactQueueRequest(extra === null ? null : compactRequest(extra)), false);
});

for (const [label, presentationSnapshot] of [
  ['image', { imagePaths: [{ id: 1, path: '/fixture/image.png' }] }],
  ['prompt chip', { promptChips: [{ kind: 'prompt', text: 'keep this chip' }] }],
  ['image range', { authoringTransport: { imageRanges: [{ start: 0, end: 8, path: '/fixture/image.png' }] } }],
  ['file range', { authoringTransport: { fileRanges: [{ start: 0, end: 8, path: '/fixture/file.pdf' }] } }],
  ['malformed presentation array', []],
  ['malformed presentation string', 'not-a-snapshot'],
  ['malformed images object', { imagePaths: {} }],
  ['malformed images boolean', { imagePaths: false }],
  ['malformed chips string', { promptChips: 'not-chips' }],
  ['malformed ranges object', { authoringTransport: { imageRanges: {} } }],
  ['malformed transport array', { authoringTransport: [] }],
  ['malformed transport string', { authoringTransport: 'not-transport' }],
]) test('shared Compact eligibility refuses ' + label + ' without interpreting it as empty', () => {
  assert.equal(isDesktopCodexCompactQueueRequest(compactRequest({ presentationSnapshot })), false);
});

for (const [label, extra] of [
  ['authoring image despite empty presentation', { authoringSnapshot: {
    editorText: '/compact', chips: [], imagePaths: [{ id: 1, path: '/fixture/image.png' }],
  } }],
  ['authoring chip despite empty presentation', { authoringSnapshot: {
    editorText: '/compact', chips: [{ kind: 'prompt', text: 'keep this chip' }], imagePaths: [],
  } }],
  ['malformed authoring chips', { authoringSnapshot: { editorText: '/compact', chips: {}, imagePaths: [] } }],
  ['malformed authoring images', { authoringSnapshot: { editorText: '/compact', chips: [], imagePaths: false } }],
  ['structured image parts', { authoring: { version: 1, parts: [{ kind: 'image', imageId: 1 }], chips: [],
    imagePaths: [{ id: 1, path: '/fixture/image.png' }] } }],
  ['malformed structured parts', { authoring: { version: 1, parts: {}, chips: [], imagePaths: [] } }],
]) test('shared Compact eligibility does not broaden desktop admission for ' + label, () => {
  // The mismatch/malformed cases are synthetic edge inputs, not evidence that
  // a real renderer currently emits this DTO. They must not gain a capability.
  assert.equal(isDesktopCodexCompactQueueRequest(compactRequest({
    presentationSnapshot: { imagePaths: [], promptChips: [] }, ...extra,
  })), false);
});

test('Web extraction fixtures use actual imports/private symbol and preserve their route loader', () => {
  const restrictedRequire = () => { throw Error('restricted unrelated route dependency'); };
  const context = vm.createContext({ require: restrictedRequire });
  installAgentSendWebBindings(context);
  assert.equal(context.require, restrictedRequire);
  assert.equal(Object.hasOwn(context, 'path'), false);
  assert.equal(Object.hasOwn(context, 'srcMainDir'), false);
  assert.equal(vm.runInContext('typeof DESKTOP_COMPACT_ADMISSION', context), 'symbol');
  assert.equal(vm.runInContext('typeof BUILD_CONTINUE_ADMISSION', context), 'symbol');
  assert.equal(vm.runInContext('typeof SELF_REWIND_ADMISSION', context), 'symbol');
  assert.equal(vm.runInContext('SELF_REWIND_ADMISSION === Symbol.for("self-rewind-admission")', context), false);
  assert.equal(vm.runInContext('BUILD_CONTINUE_ADMISSION === DESKTOP_COMPACT_ADMISSION', context), false);
  assert.equal(vm.runInContext('BUILD_CONTINUE_ADMISSION === Symbol.for("build-continue-admission")', context), false);
  assert.equal(vm.runInContext('isDesktopCodexCompactQueueRequest', context),
    require('../../shared/agent-local-command.cjs').isDesktopCodexCompactQueueRequest);
  assert.equal(vm.runInContext('compactSendDeliveryIdentity', context),
    require('../../shared/compact-send-delivery.cjs').compactSendDeliveryIdentity);
  assert.equal(vm.runInContext('compactSendDeliveryIdentity({ state: "confirmed", provider: "codex" })', context), null);
  assert.throws(() => vm.runInContext('unboundFutureProductionDependency()', context), /is not defined/);
  assert.equal(installAgentSendWebBindings(context), context, 'same declarations are installed once');
});

for (const name of ['DESKTOP_COMPACT_ADMISSION', 'BUILD_CONTINUE_ADMISSION', 'SELF_REWIND_ADMISSION']) {
test('a missing actual declaration fails rather than silently supplying a test-only authorizer: ' + name, () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web-server.js'), 'utf8');
  const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => value.name.getText(tree) === name));
  assert.ok(declaration);
  const missing = source.slice(0, declaration.pos) + source.slice(declaration.end);
  assert.throws(() => installAgentSendWebBindings(vm.createContext({}), missing),
    new RegExp('actual Web binding must have one top-level declaration: ' + name));
});
}

test('serialized public fields and same-description symbols cannot forge the real Compact queue admission', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web-server.js'), 'utf8');
  const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  const prepared = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runPreparedAgentSendScenario');
  assert.ok(prepared);
  let gate;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(tree).includes('args[DESKTOP_COMPACT_ADMISSION]')) gate = node.expression.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(prepared);
  assert.ok(gate, 'the actual Web queue admission predicate');
  const context = vm.createContext({
    durableIdentity: {}, agentSendQueue: {}, applicationQueueExecution: false, provider: 'codex',
    prompt: '/compact', tabId: 'T',
    isLocalSlashCommandPrompt: require('../agent-history-send-receipt').isLocalSlashCommandPrompt,
    findOrchestrationTabDescriptor: () => ({ tabType: 'terminal' }),
  });
  installAgentSendWebBindings(context, tree);
  const publicFields = { DESKTOP_COMPACT_ADMISSION: true, desktopCompactAdmission: true,
    'desktop-compact-fifo-admission': true, applicationQueueAcceptedResponse: true };
  for (const forged of [publicFields, { [Symbol('desktop-compact-fifo-admission')]: true },
    { [Symbol.for('desktop-compact-fifo-admission')]: true }]) {
    context.args = compactRequest(forged);
    assert.equal(vm.runInContext(gate, context), false);
  }
  vm.runInContext('args = { ...args, [DESKTOP_COMPACT_ADMISSION]: true };', context);
  assert.equal(vm.runInContext(gate, context), true, 'only the exact Main lexical Symbol authorizes this queue branch');
});
