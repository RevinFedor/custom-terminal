import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as chips from './composerChips.mjs';
import * as images from './promptImageAttachments.mjs';
import * as clipboard from './composerClipboard.mjs';
import * as ownership from './historyImageImportOwnership.mjs';
import * as cmState from '@codemirror/state';
import * as cmCommands from '@codemirror/commands';
import * as persistence from './composerDraftPersistence.mjs';
import { mergeFailedHistoryAuthoringSnapshots } from './historyDraftOwnership.mjs';
import { recoverAgentDraftTransferToHistory } from './agentDraftTransfer.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(directory, '../components/Workspace/HistoryPanel.tsx'), 'utf8');
const storeSource = fs.readFileSync(path.join(directory, '../store/useUIStore.ts'), 'utf8');
const part = (value, first, next) => {
  const start = value.indexOf(first);
  const end = value.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, first);
  return value.slice(start, end);
};
const compile = value => ts.transpileModule(value, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const setterSource = part(storeSource, '  setHistoryPromptDraft: (tabId, draft, options = {}) =>', '  setHistoryPromptDraftChips:');
const applySource = part(source, '  const applyHistoryComposerSnapshot = useCallback((', '  const acceptHistorySlashCommand =');
const handlerSource = part(source, '  const handleComposerImagePaste = useCallback((', '  const restoreChipToComposer =');
const copySource = part(source, '  const handleComposerImageAwareCopy =', '  const handleComposerImagePaste =');
const messageCopySource = part(source, '  const copyPrompt = (event:', '  const requestRewind =');
const adapterSource = fs.readFileSync(path.join(directory, 'electronComposerClipboardAdapter.ts'), 'utf8');
const deriveSource = part(source, '  const deriveComposerHistoryPayload =', '  const ');
const equalSource = part(source, 'const historyComposerAggregateEqual =', 'const retainHistoryDraftImages');
const syntax = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findNodes = (node, predicate) => {
  const found = [];
  const visit = current => { if (predicate(current)) found.push(current); ts.forEachChild(current, visit); };
  visit(node);
  return found;
};
const changeCallback = findNodes(syntax, node => ts.isJsxAttribute(node) && node.name.text === 'onChange')
  .map(node => node.initializer?.expression)
  .find(node => node?.getText(syntax).includes('const aggregate = historyPayload'));
assert.ok(changeCallback);

// Execute the actual installed bundle's pure aggregate helper, its host derive
// wrapper, and imperative applySnapshot method. Reading only source-map TS here
// would allow a stale consumed JS artifact to produce a false green result.
const bundleText = fs.readFileSync(path.join(directory, '../../../node_modules/@gt-editor/markdown-editor/dist/index.js'), 'utf8');
const bundle = ts.createSourceFile('installed-editor.js', bundleText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const imported = {};
for (const statement of bundle.statements) {
  if (!ts.isImportDeclaration(statement)) continue;
  const dependency = statement.moduleSpecifier.text === '@codemirror/state' ? cmState
    : statement.moduleSpecifier.text === '@codemirror/commands' ? cmCommands : null;
  if (!dependency) continue;
  for (const binding of statement.importClause?.namedBindings?.elements || []) {
    imported[binding.name.text] = dependency[(binding.propertyName || binding.name).text];
  }
}
const aggregateNode = bundle.statements.find(node => ts.isFunctionDeclaration(node)
  && node.getText(bundle).includes('"composer.history.reconcile"'));
assert.ok(aggregateNode, 'installed aggregate history function');
const aggregateCall = findNodes(bundle, node => ts.isCallExpression(node)
  && node.expression.getText(bundle) === aggregateNode.name.text)[0];
const deriveWrapper = aggregateCall.arguments[0].properties.find(node => node.name?.text === 'derive').initializer;
const applyMethod = findNodes(bundle, node => ts.isMethodDeclaration(node) && node.name?.text === 'applySnapshot')[0];
assert.ok(deriveWrapper && applyMethod);
const currentRefNames = node => [...new Set(findNodes(node, current => ts.isPropertyAccessExpression(current)
  && current.name.text === 'current').map(current => current.expression.getText(bundle)))];
const installedContext = vm.createContext({ ...imported });
vm.runInContext(aggregateNode.getText(bundle)
  + '\nglobalThis.createAggregate = ' + aggregateNode.name.text, installedContext);
function installedEditor({ initial, derive, equal, onChange }) {
  const wrapperContext = vm.createContext(Object.fromEntries(currentRefNames(deriveWrapper)
    .map(name => [name, { current: derive }])));
  const wrapped = vm.runInContext('(' + deriveWrapper.getText(bundle) + ')', wrapperContext);
  const aggregate = installedContext.createAggregate({ initial: initial.payload, derive: wrapped, equal });
  let state = cmState.EditorState.create({ doc: initial.text,
    extensions: [cmCommands.history(), aggregate.extension] });
  const view = { get state() { return state; }, dispatch(input) {
    state = input instanceof cmState.Transaction ? input.state : state.update(input).state;
  } };
  const applyRefs = currentRefNames(applyMethod);
  assert.equal(applyRefs.length, 2, 'installed method owns editor and aggregate refs');
  const globals = { ...imported, [applyRefs[0]]: { current: view }, [applyRefs[1]]: { current: aggregate } };
  // The installed host-external annotation is a pure Annotation.define().
  for (const node of findNodes(bundle, current => ts.isVariableDeclaration(current))) {
    if (!ts.isIdentifier(node.name) || !node.initializer || !/^[\w$]+\.define\(\)$/.test(node.initializer.getText(bundle))) continue;
    const receiver = node.initializer.expression.expression.getText(bundle);
    if (imported[receiver]) globals[node.name.text] = imported[receiver].define();
  }
  const apply = vm.runInNewContext('({' + applyMethod.getText(bundle) + '}).applySnapshot', globals);
  const emit = () => {
    const selection = state.selection.main;
    onChange(state.doc.toString(), { start: selection.from, end: selection.to }, aggregate.read(state));
  };
  return {
    get state() { return state; },
    apply(snapshot) { const result = apply(snapshot); if (result !== false) emit(); return result; },
    change(changes) {
      view.dispatch({ changes, annotations: cmCommands.isolateHistory.of('full'), userEvent: 'input' });
      emit();
    },
    replay(command) {
      const result = command({ state, dispatch(transaction) {
        const reconciliation = aggregate.reconciliationFor(transaction);
        view.dispatch(transaction);
        if (reconciliation) view.dispatch(reconciliation);
      } });
      emit();
      return result;
    },
    payload: () => aggregate.read(state),
  };
}
const pendingMarker = '[Image saving…]';
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let state = { historyPromptDrafts: {}, historyPromptDraftImages: {}, historyPromptDraftChips: {},
    historyPromptDraftUpdatedAt: {}, historyPromptDraftPendingImages: {}, historyComposerViewByTab: {} };
  const storeContext = vm.createContext({ ...chips, ...ownership, set: update => { state = { ...state, ...update(state) }; } });
  vm.runInContext(compile('globalThis.methods = {' + setterSource + '};'), storeContext);
  const requests = [];
  const updates = [];
  const warnings = [];
  const frames = [];
  let snapshot = null;
  const contexts = {};
  let clipboardItem = {};
  const fakeClipboard = {
    clear() { clipboardItem = {}; },
    write(item) { clipboardItem = { ...item }; },
    writeText(text) { clipboardItem = { text }; },
    readText: () => clipboardItem.text || '',
    readHTML: () => clipboardItem.html || '',
    availableFormats: () => Object.keys(clipboardItem).map(type => 'text/' + (type === 'text' ? 'plain' : type)),
  };
  const adapter = vm.createContext({ exports: {}, Buffer, console: { log() {}, warn() {} },
    require: name => name.includes('composerClipboard') ? clipboard : chips,
    window: { require: () => ({ clipboard: fakeClipboard }) },
  });
  vm.runInContext(compile(adapterSource), adapter);
  let nextId = 1;
  const mounted = [];
  const api = { getState: () => ({ ...state, ...storeContext.methods, showToast() {} }) };
  function mount(tabId = 'T') {
    const element = { selectionStart: 0, selectionEnd: 0,
      getAttribute: name => name === 'data-history-composer-tab-id' ? tabId : null,
      focus() {}, isFocused: () => true,
      setSelectionRange(start, end = start) { this.selectionStart = start; this.selectionEnd = end; },
      applySnapshot(value) { updates.push({ tabId, ...value }); return native.apply(value); },
    };
    const context = vm.createContext({
      ...chips, ...images, ...clipboard, ...ownership, useUIStore: api,
      tabId, tabIdRef: { current: tabId }, promptTextareaRef: { current: element }, promptCaretRef: { current: { start: 0, end: 0 } },
      dismissedContextUpdatesRef: { current: [] },
      getTabWorkContextSnapshot: id => ({ updates: contexts[id] || [] }),
      reconcileContextDismissalHistory: () => {},
      // Dictation-chip hooks referenced by the extracted onChange. Real
      // registry semantics are covered by dictationChips.test.mjs; here they
      // only need to exist and be inert.
      isProgrammaticDictationEdit: () => false,
      disarmDictationChipsForTab: () => false,
      historyDiag: () => {},
      isCancellingTurn: false, rewindLocked: false, effectiveStopping: false, aiComposerChipThreshold: 800,
      HISTORY_IMAGE_PENDING_MARKER: pendingMarker,
      retainHistoryDraftImages: images.retainPromptImageRefsForText,
      setHistoryPromptDraft: storeContext.methods.setHistoryPromptDraft,
      setDraftWarning: value => warnings.push({ tabId, value }),
      readElectronComposerSnapshotClipboard: () => snapshot || adapter.exports.readElectronComposerSnapshotClipboard(),
      writeElectronComposerSnapshotClipboard: adapter.exports.writeElectronComposerSnapshotClipboard,
      setCopied() {}, copiedTimerRef: { current: null }, setTimeout() {}, clearTimeout() {},
      clipboard: { writeText() {} }, draftChips: [], draftImages: [],
      isElectronDictationClipboardPayload: () => false,
      createComposerChipId: kind => `${kind}-${nextId++}`,
      runtime: { logPrefix: 'Test' }, console: { log() {}, warn() {} },
      useCallback: value => value,
      useLayoutEffect(callback) { context.reconcilePending = callback; }, draftPendingImages: [], prompt: '',
      setPrompt: (text, options) => storeContext.methods.setHistoryPromptDraft(tabId, text, options), draftWarning: null,
      requestAnimationFrame: callback => { frames.push(callback); },
      ipcRenderer: { invoke(channel, payload) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        requests.push({ channel, payload, resolve, reject });
        return promise;
      } },
    });
    vm.runInContext(compile(deriveSource + equalSource + applySource + copySource + handlerSource + messageCopySource
      + '\nglobalThis.paste = handleComposerImagePaste;'
      + '\nglobalThis.apply = applyHistoryComposerSnapshot;'
      + '\nglobalThis.derive = deriveComposerHistoryPayload;'
      + '\nglobalThis.equal = historyComposerAggregateEqual;'
      + '\nglobalThis.copy = handleComposerImageAwareCopy;'
      + '\nglobalThis.copyMessage = copyPrompt;'
      + '\nglobalThis.onChange = ' + changeCallback.getText(syntax) + ';'), context);
    const native = installedEditor({ initial: { text: text(tabId), payload: {
      images: state.historyPromptDraftImages[tabId] || [], chips: state.historyPromptDraftChips[tabId] || [],
      pendingImages: state.historyPromptDraftPendingImages[tabId] || [],
      dismissedContextUpdates: [],
    } }, derive: context.derive, equal: context.equal, onChange: context.onChange });
    Object.defineProperty(element, 'value', { get: () => native.state.doc.toString() });
    const reconcile = () => {
      context.draftPendingImages = state.historyPromptDraftPendingImages[tabId] || [];
      context.prompt = text(tabId);
      context.reconcilePending();
    };
    const result = { context, element, native, reconcile,
      copyMessage(entry) {
        context.entry = { uuid: 'failed-message', ...entry };
        snapshot = null;
        context.copyMessage({ preventDefault() {}, stopPropagation() {} });
        return { ...clipboardItem };
      },
      syncFromStore() {
        native.apply({ value: text(tabId), history: 'external', historyPayload: {
          images: state.historyPromptDraftImages[tabId] || [], chips: state.historyPromptDraftChips[tabId] || [],
          pendingImages: state.historyPromptDraftPendingImages[tabId] || [],
          dismissedContextUpdates: [],
        } });
        reconcile();
      },
      change(changes) { native.change(changes); reconcile(); },
      undo() { const value = native.replay(cmCommands.undo); reconcile(); return value; },
      redo() { const value = native.replay(cmCommands.redo); reconcile(); return value; },
      cut(start, end) {
        element.setSelectionRange(start, end);
        context.draftChips = state.historyPromptDraftChips[tabId] || [];
        context.draftImages = state.historyPromptDraftImages[tabId] || [];
        context.copy({ currentTarget: element, type: 'cut', preventDefault() {} });
      },
      paste({ start = text(tabId).length, end = start, mode = 'bitmap', value = '' } = {}) {
        snapshot = mode === 'snapshot' ? { version: 1, text: '[Image #1]', chips: [],
          imagePaths: [{ id: 1, path: '/synthetic/copied.png', size: 1 }] } : null;
        element.setSelectionRange(start, end);
        context.paste({ currentTarget: element, clipboardData: {
          items: mode === 'bitmap' ? [{ kind: 'file', type: 'image/png' }] : [],
          getData: type => type === 'text/plain' ? (mode === 'path' ? '[imagePath: /synthetic/source.png]' : value) : '',
        }, preventDefault() {}, stopPropagation() {} });
      },
    };
    mounted.push(result);
    return result;
  }
  const text = tabId => state.historyPromptDrafts[tabId] || '';
  const write = (tabId, text, value = {}) => storeContext.methods.setHistoryPromptDraft(tabId, text, { images: [], chips: [], ...value });
  const serialized = tabId => chips.serializeComposerDraft({
    text: images.buildPromptImagePayload(text(tabId), state.historyPromptDraftImages[tabId] || []),
    chips: state.historyPromptDraftChips[tabId] || [],
  });
  const finish = (request, name = 'saved') => request.resolve(request.channel === 'prompt-queue:save-clipboard-image'
    ? { success: true, path: `/synthetic/${name}.png`, assetId: name, size: 1 }
    : { refs: [{ id: 1, path: `/synthetic/${name}.png`, assetId: name, size: 1 }] });
  return { mount, requests, warnings, updates, frames, text, write, serialized, finish, contexts,
    state: () => state, snapshot: () => structuredClone(state), api };
}

function twoPastes(reverse = false) {
  const first = { id: 'A', kind: 'paste', text: 'A'.repeat(1000) };
  const second = { id: 'B', kind: 'paste', text: 'B'.repeat(1000) };
  const initial = chips.insertComposerSnapshotAtSelection({ text: '', chips: [],
    insertedText: chips.buildPasteChipMarker(first), insertedChips: [first] });
  return chips.insertComposerSnapshotAtSelection({ text: initial.text, chips: initial.chips,
    insertedText: (reverse ? '' : '|') + chips.buildPasteChipMarker(second) + (reverse ? '|' : ''),
    insertedChips: [second], selectionStart: reverse ? 0 : initial.text.length, selectionEnd: reverse ? 0 : initial.text.length });
}

test('failed Send -> actual History Copy/clipboard/paste keeps returned prompt chips once and inserts text', () => {
  const h = harness();
  const returned = { id: 'returned', kind: 'prompt', label: 'Attached', text: 'attached context' };
  const deferred = { id: 'update-1', title: 'Deferred', text: 'deferred context', status: 'pending' };
  h.contexts.T = [deferred];
  h.write('T', 'new draft', { chips: [returned] });
  const view = h.mount();
  const transport = chips.serializeComposerDraft({ text: 'message text', chips: [
    { id: 'deferred-chip', kind: 'prompt', label: deferred.title, text: deferred.text, contextUpdateId: deferred.id },
    returned,
  ] });
  const copied = view.copyMessage({ content: transport, promptChips: [returned] });
  assert.equal(copied.text, transport, 'portable copy still contains every chip and message byte');
  assert.ok(copied.html.includes('data-noted-terminal-composer-snapshot'));
  view.paste({ mode: 'clipboard', start: 0, end: h.text('T').length });
  assert.equal(h.text('T'), 'message text');
  assert.deepEqual(h.state().historyPromptDraftChips.T, [returned]);
  assert.deepEqual(h.contexts.T, [deferred], 'paste never consumes the pending context owner');
  view.paste({ mode: 'clipboard', start: 0, end: h.text('T').length });
  assert.deepEqual(h.state().historyPromptDraftChips.T, [returned]);
  assert.equal(view.undo(), true);
  assert.equal(view.undo(), true);
  assert.equal(h.text('T'), 'new draft');
  assert.deepEqual(h.state().historyPromptDraftChips.T, [returned]);
});

test('actual Copy/paste keeps revised same-source chips beside the returned version', () => {
  const h = harness();
  const current = { id: 'prompt-1', kind: 'prompt', sourceKey: 'prompt:1', text: 'revision two' };
  const previous = { ...current, text: 'revision one' };
  h.write('T', '', { chips: [current] });
  const view = h.mount();
  view.copyMessage({ content: chips.serializeComposerDraft({ text: 'old message', chips: [previous] }), promptChips: [previous] });
  view.paste({ mode: 'clipboard' });
  assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.text), ['revision two', 'revision one']);
  assert.equal(h.text('T'), 'old message');
});

for (const changed of [false, true]) {
  test(`async copied-image replay compares latest owner chips/context on background completion (changed=${changed})`, async () => {
    const h = harness();
    const attached = { id: 'attached', kind: 'prompt', text: 'attached', label: 'Attached' };
    const update = { id: 'update-1', status: 'pending', text: 'context', title: 'Deferred' };
    const contextChip = { id: 'context', kind: 'prompt', text: update.text, label: update.title, contextUpdateId: update.id };
    const view = h.mount();
    view.copyMessage({ content: chips.serializeComposerDraft({ text: 'message [Image #1]', chips: [contextChip, attached] }),
      promptChips: [attached], imagePaths: [{ id: 1, path: '/synthetic/copied.png' }] });
    view.paste({ mode: 'clipboard' });
    h.contexts.T = [{ ...update, text: changed ? 'new version' : update.text }];
    h.write('T', h.text('T'), { chips: [attached], pendingImages: h.state().historyPromptDraftPendingImages.T });
    h.write('OTHER', 'unrelated');
    view.context.tabIdRef.current = 'OTHER';
    h.finish(h.requests[0]); await tick();
    assert.equal(h.text('T'), 'message [Image #1]');
    assert.equal(h.text('OTHER'), 'unrelated');
    assert.equal(h.state().historyPromptDraftChips.T.length, changed ? 2 : 1);
    assert.equal(h.state().historyPromptDraftChips.T.filter(chip => chip.id === attached.id).length, 1);
  });
}

for (const mode of ['bitmap', 'snapshot', 'path']) {
  test(`actual ${mode} image admission keeps B after replacing equal-length paste A`, async () => {
    const h = harness();
    const initial = twoPastes();
    h.write('T', initial.text, { chips: initial.chips });
    const view = h.mount();
    const range = chips.getPasteMarkerHighlightRanges(initial.text, initial.chips)[0];
    view.paste({ start: range.start, end: range.end, mode });
    h.finish(h.requests[0]); await tick();
    const payload = h.serialized('T');
    assert.deepEqual({ sendsA: payload.includes('A'.repeat(1000)), sendsB: payload.includes('B'.repeat(1000)) },
      { sendsA: false, sendsB: true }, 'actual payload must contain the surviving body, not the removed body');
    assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.id), ['B']);
  });
}

for (const order of ['A-first', 'B-first']) {
  test(`late image A cannot fill B after deletion and another paste: ${order}`, async () => {
    const h = harness();
    const view = h.mount();
    view.paste();
    const A = h.requests[0];
    h.write('T', '');
    view.paste();
    const B = h.requests[1];
    assert.equal(h.text('T'), pendingMarker, 'operation IDs must not become visible text');
    if (order === 'A-first') {
      h.finish(A, 'A'); await tick();
      assert.equal(h.text('T'), pendingMarker);
      h.finish(B, 'B'); await tick();
    } else {
      h.finish(B, 'B'); await tick();
      h.finish(A, 'A'); await tick();
    }
    assert.equal(h.serialized('T').includes('/synthetic/B.png'), true);
    assert.equal(h.serialized('T').includes('/synthetic/A.png'), false);
  });
}

test('late exception from deleted A cannot replace pending B with an error', async () => {
  const h = harness();
  const view = h.mount();
  view.paste();
  const A = h.requests[0];
  h.write('T', '');
  view.paste();
  A.reject(Error('A failed')); await tick();
  assert.equal(h.text('T'), pendingMarker);
  h.finish(h.requests[1], 'B'); await tick();
  assert.equal(h.serialized('T').includes('/synthetic/B.png'), true);
});

test('valid background completion survives remount and does not change another tab', async () => {
  const h = harness();
  const old = h.mount('A');
  old.paste();
  old.context.promptTextareaRef.current = null;
  h.mount('A');
  h.write('B', 'other tab input');
  const other = h.mount('B');
  other.element.setSelectionRange(3, 3);
  h.finish(h.requests[0], 'A'); await tick();
  assert.equal(h.serialized('A').includes('/synthetic/A.png'), true);
  assert.equal(h.text('B'), 'other tab input');
  assert.equal(other.element.selectionStart, 3);
});

for (const reverse of [false, true]) {
  for (const removedIndex of [0, 1]) {
    test(`installed editor transaction deletes the right equal marker and Undo restores both: reverse=${reverse} index=${removedIndex}`, () => {
      const h = harness();
      const initial = twoPastes(reverse);
      h.write('T', initial.text, { chips: initial.chips });
      const view = h.mount();
      const ranges = chips.getPasteMarkerHighlightRanges(initial.text, initial.chips);
      const removed = ranges[removedIndex];
      const survivor = ranges[1 - removedIndex];
      view.change({ from: removed.start, to: removed.end, insert: '' });
      assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.id), [survivor.id]);
      assert.equal(h.serialized('T').includes(survivor.id.repeat(1000)), true);
      assert.equal(h.serialized('T').includes(removed.id.repeat(1000)), false);
      assert.equal(view.undo(), true);
      assert.equal(h.serialized('T').includes('A'.repeat(1000)), true);
      assert.equal(h.serialized('T').includes('B'.repeat(1000)), true);
      assert.equal(view.redo(), true);
      assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.id), [survivor.id]);
    });
  }
}

test('actual cut owns the removed equal marker and can undo the authoring snapshot', () => {
  const h = harness();
  const initial = twoPastes();
  h.write('T', initial.text, { chips: initial.chips });
  const view = h.mount();
  const range = chips.getPasteMarkerHighlightRanges(initial.text, initial.chips)[0];
  view.cut(range.start, range.end);
  assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.id), ['B']);
  assert.equal(view.undo(), true);
  assert.equal(h.serialized('T').includes('A'.repeat(1000)), true);
  assert.equal(h.serialized('T').includes('B'.repeat(1000)), true);
});

test('installed multi-range transaction maps pending ownership and removes a partial paste anchor', async () => {
  const h = harness();
  const initial = twoPastes();
  h.write('T', initial.text, { chips: initial.chips });
  const view = h.mount();
  view.paste();
  const range = chips.getPasteMarkerHighlightRanges(initial.text, initial.chips)[0];
  view.change([{ from: range.start, to: range.start + 2, insert: 'replacement' },
    { from: initial.text.length, insert: 'prefix ' }]);
  assert.deepEqual(h.state().historyPromptDraftChips.T.map(chip => chip.id), ['B']);
  assert.equal(h.state().historyPromptDraftPendingImages.T.length, 1);
  h.finish(h.requests[0], 'mapped'); await tick();
  assert.equal(h.serialized('T').includes('/synthetic/mapped.png'), true);
  assert.equal(h.serialized('T').includes('A'.repeat(1000)), false);
  assert.equal(h.serialized('T').includes('B'.repeat(1000)), true);
});

for (const result of ['ready', 'failure']) {
  test(`Undo restores deleted A after its only completion arrived while absent: ${result}`, async () => {
    const h = harness();
    const view = h.mount();
    view.paste();
    const operation = h.state().historyPromptDraftPendingImages.T[0].operation;
    view.change({ from: 0, to: pendingMarker.length, insert: '' });
    if (result === 'ready') h.finish(h.requests[0], 'A');
    else h.requests[0].reject(Error('A failed'));
    await tick();
    assert.equal(h.text('T'), '');
    assert.equal(ownership.getHistoryImageImportOutcome(operation) !== null, true);
    assert.equal(view.undo(), true);
    assert.equal(h.text('T').includes(pendingMarker), false);
    assert.equal(h.serialized('T').includes(result === 'ready' ? '/synthetic/A.png' : '[imageError:'), true);
    assert.equal(view.undo(), true);
    assert.equal(h.text('T'), '');
    assert.equal(view.redo(), true);
    assert.equal(h.text('T').includes(pendingMarker), false);
  });
}

for (const order of ['A-first', 'B-first']) {
  test(`A delete/B paste and two Undo/Redo operations preserve both completions: ${order}`, async () => {
    const h = harness();
    const view = h.mount();
    view.paste();
    view.change({ from: 0, to: pendingMarker.length, insert: '' });
    view.paste({ mode: 'snapshot' });
    const [A, B] = h.requests;
    if (order === 'A-first') { h.finish(A, 'A'); await tick(); h.finish(B, 'B'); }
    else { h.finish(B, 'B'); await tick(); h.finish(A, 'A'); }
    await tick();
    assert.equal(h.serialized('T').includes('/synthetic/B.png'), true);
    assert.equal(view.undo(), true);
    assert.equal(h.text('T'), '');
    assert.equal(view.undo(), true);
    assert.equal(h.serialized('T').includes('/synthetic/A.png'), true);
    assert.equal(h.serialized('T').includes('/synthetic/B.png'), false);
    assert.equal(view.redo(), true);
    assert.equal(h.text('T'), '');
    assert.equal(view.redo(), true);
    assert.equal(h.serialized('T').includes('/synthetic/B.png'), true);
  });
}

test('unchanged live-slot admission does not start a second native clipboard read', () => {
  const h = harness();
  const view = h.mount();
  view.paste();
  view.paste();
  assert.equal(h.requests.length, 1);
  assert.equal(h.text('T'), pendingMarker);
});

test('native text typed after pending A retains its own Undo/Redo after completion', async () => {
  const h = harness();
  const view = h.mount();
  view.paste();
  view.change({ from: pendingMarker.length, insert: ' suffix' });
  h.finish(h.requests[0], 'A'); await tick();
  assert.equal(h.text('T').endsWith(' suffix'), true);
  assert.equal(view.undo(), true);
  assert.equal(h.text('T').includes('suffix'), false);
  assert.equal(h.serialized('T').includes('/synthetic/A.png'), true);
  assert.equal(view.redo(), true);
  assert.equal(h.text('T').endsWith(' suffix'), true);
});

test('context-chip removal shares native Undo order with later text edits', () => {
  const h = harness();
  h.write('T', 'draft');
  const view = h.mount();
  const initial = view.native.payload();
  view.native.apply({
    value: 'draft',
    selectionStart: 5,
    history: 'add',
    historyPayload: { ...initial, dismissedContextUpdates: [{ id: 'group-1', memberIds: ['update-1'] }] },
    userEvent: 'delete',
  });
  view.change({ from: 5, insert: ' next' });

  assert.deepEqual(view.native.payload().dismissedContextUpdates, [{ id: 'group-1', memberIds: ['update-1'] }]);
  assert.equal(view.undo(), true);
  assert.equal(h.text('T'), 'draft');
  assert.deepEqual(view.native.payload().dismissedContextUpdates, [{ id: 'group-1', memberIds: ['update-1'] }]);
  assert.equal(view.undo(), true);
  assert.deepEqual(view.native.payload().dismissedContextUpdates, []);
  assert.equal(view.redo(), true);
  assert.deepEqual(view.native.payload().dismissedContextUpdates, [{ id: 'group-1', memberIds: ['update-1'] }]);
});

test('actual persisted draft initialization expires unavailable imports only at renderer reload', () => {
  const h = harness();
  const view = h.mount();
  view.paste();
  const before = h.state();
  const memory = persistence.buildComposerDraftMemory({ drafts: before.historyPromptDrafts,
    images: before.historyPromptDraftImages, chips: before.historyPromptDraftChips,
    updatedAtByTab: before.historyPromptDraftUpdatedAt, pendingImages: before.historyPromptDraftPendingImages });
  const raw = JSON.stringify(memory);
  assert.equal(raw.includes('history-image-import:'), false, 'operation handles are never persisted');
  const storeSyntax = ts.createSourceFile('useUIStore.ts', storeSource, ts.ScriptTarget.Latest, true);
  const initializer = storeSyntax.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(storeSyntax) === 'initialHistoryComposerDraftState')).getText(storeSyntax);
  const reload = vm.createContext({ ...persistence, ...ownership,
    HISTORY_COMPOSER_DRAFTS_STORAGE_KEY: 'drafts', localStorage: { getItem: () => raw } });
  vm.runInContext(compile(initializer + '\nglobalThis.restored = initialHistoryComposerDraftState;'), reload);
  assert.equal(reload.restored.drafts.T, '[imageError: image_import_interrupted]');
  assert.equal(h.text('T'), pendingMarker, 'same-renderer store and its live promise are untouched');
  assert.equal(h.requests.length, 1, 'reload performs no re-import');
});

test('background failed-send prepend preserves current operation in actual store and completes it', async () => {
  const h = harness();
  const view = h.mount();
  view.paste();
  const before = h.state();
  const merged = mergeFailedHistoryAuthoringSnapshots({ currentText: h.text('T'),
    currentPendingImages: before.historyPromptDraftPendingImages.T,
    snapshots: [{ text: 'first failed' }, { text: 'second failed' }] });
  h.write('T', merged.text, { images: merged.images, chips: merged.chips, pendingImages: merged.pendingImages });
  await recoverAgentDraftTransferToHistory({ draftTransfer: { id: 'ownership-regression', tabId: 'T', text: 'transfer' } }, 'T', h.api);
  h.finish(h.requests[0], 'current'); await tick();
  assert.equal(h.text('T').includes(pendingMarker), true, 'stale mounted editor range is rejected until controlled host sync');
  view.syncFromStore();
  assert.equal(h.text('T').startsWith('transfer\n\nfirst failed\n\nsecond failed\n\n'), true);
  assert.equal(h.serialized('T').includes('/synthetic/current.png'), true);
  assert.equal(h.text('T').includes(pendingMarker), false);
});
