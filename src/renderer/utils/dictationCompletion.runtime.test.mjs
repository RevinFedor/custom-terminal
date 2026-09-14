import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as registry from './dictationChipRegistry.mjs';

const panelUrl = new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
const appUrl = new URL('../App.tsx', import.meta.url);
const panel = fs.readFileSync(panelUrl, 'utf8');
const app = fs.readFileSync(appUrl, 'utf8');
const part = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

// Load only bindings actually imported by each consumer. Spreading the whole
// helper module into a sandbox hides missing imports (the production bug).
async function imports(source, url) {
  const syntax = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values = {};
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!/\/(dictationChips|dictationChipRegistry|promptImageAttachments|composerClipboard|historyImageImportOwnership)\.mjs$/.test(specifier)) continue;
    const dependency = await import(new URL(specifier, url));
    for (const binding of statement.importClause?.namedBindings?.elements || []) {
      values[binding.name.text] = dependency[(binding.propertyName || binding.name).text];
    }
  }
  return values;
}
const panelImports = await imports(panel, panelUrl);
const appImports = await imports(app, appUrl);
const resolveSource = part(panel, '    const resolveChip = (event: Event)', "    window.addEventListener('history-panel:resolve-dictation-chip'");
const submitSource = part(panel, '    const submitComposer = (event: Event)', "    window.addEventListener('history-panel:submit-composer'");
const bridgeSource = part(app, "        if (action === 'dictationChipResolve')", "        if (action === 'getOpenProjectIds')");

function harness({ armed = true, mounted = true, text = '[Dictating vr-101]', failEditor = false,
  selectionStart = 0, selectionEnd = selectionStart, focused = true, imagePaths = [] } = {}) {
  registry.__resetDictationChips();
  registry.beginDictationChip({ id: 'vr-101', tabId: 'T', label: 'tail', autoSend: armed });
  const state = { historyPromptDrafts: { T: text }, historyPromptDraftImages: { T: imagePaths },
    historyPromptDraftChips: { T: [] }, historyPromptDraftPendingImages: { T: [] } };
  state.setHistoryPromptDraft = (id, value, options) => {
    state.historyPromptDrafts[id] = value;
    if (options.images) state.historyPromptDraftImages[id] = options.images;
  };
  const frames = [], sends = [], errors = [], logs = [], listeners = new Map();
  const window = {
    addEventListener(name, fn) { listeners.set(name, fn); },
    // Native dispatchEvent reports listener errors separately; it DOES NOT
    // throw to App's caller. This is why the old fallback disguised the bug.
    dispatchEvent(event) {
      try { listeners.get(event.type)?.(event); }
      catch (error) { errors.push(error); }
      return true;
    },
  };
  const shared = { console: { log: (...v) => logs.push(v.join(' ')), error: (...v) => logs.push(v.join(' ')) },
    window, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    requestAnimationFrame: fn => frames.push(fn), useUIStore: { getState: () => state },
    historyDiag: message => logs.push(message) };
  const editor = { getAttribute: () => 'T', isFocused: () => focused, selectionStart, selectionEnd };
  const panelContext = vm.createContext({ ...shared, ...panelImports, tabId: 'T',
    promptTextareaRef: { current: editor }, promptCaretRef: { current: { start: selectionStart, end: selectionEnd } },
    applyHistoryComposerSnapshot(snapshot) {
      if (failEditor) throw new Error('injected editor failure');
      state.setHistoryPromptDraft('T', snapshot.text, { images: snapshot.images });
      editor.selectionStart = snapshot.selectionStart;
      editor.selectionEnd = snapshot.selectionEnd;
      return true;
    },
    runAction: (kind) => sends.push({ kind, text: state.historyPromptDrafts.T }),
    setDraftWarning: warning => logs.push(warning),
  });
  if (mounted) {
    vm.runInContext(compile(resolveSource + '\nglobalThis.resolve = typeof onResolveChip === "function" ? onResolveChip : resolveChip;'), panelContext);
    window.addEventListener('history-panel:resolve-dictation-chip', panelContext.resolve);
    vm.runInContext(compile(submitSource + '\nglobalThis.submit = submitComposer;'), panelContext);
    window.addEventListener('history-panel:submit-composer', panelContext.submit);
  }
  const appContext = vm.createContext({ ...shared, ...appImports,
    reply: (ok, data, error) => ({ ok, ...data, error }),
  });
  vm.runInContext(compile('globalThis.resolve = async (payload) => { const action = "dictationChipResolve";\n' + bridgeSource + '\n};'), appContext);
  return { state, sends, errors, logs, editor, resolve: payload => appContext.resolve({ chipId: 'vr-101', outcome: 'text', text: 'finished words', autoSend: armed, ...payload }),
    flush() { while (frames.length) frames.shift()(); } };
}

test('mounted History consumes actual bridge resolve and sends finished text without a remount', async () => {
  const h = harness();
  const result = await h.resolve();
  assert.deepEqual(h.errors.map(e => e.message), [], 'native event must not hide a missing import');
  assert.equal(result.ok, true);
  assert.equal(result.resolved, true);
  assert.notEqual(result.reason, 'background-draft');
  h.flush();
  assert.deepEqual(h.sends, [{ kind: 'send', text: 'finished words' }]);
});

test('manual typing disarm survives the unchanged Voice Record flag repeated at resolve', async () => {
  const h = harness();
  registry.disarmDictationChipsForTab('T');
  h.state.historyPromptDrafts.T += ' still editing';
  await h.resolve();
  h.flush();
  assert.equal(h.state.historyPromptDrafts.T, 'finished words still editing');
  assert.deepEqual(h.sends, []);
});

test('local Option+1 arm survives the original unarmed flag repeated at resolve', async () => {
  const h = harness({ armed: false });
  registry.armDictationChipsForTab('T');
  await h.resolve();
  h.flush();
  assert.deepEqual(h.sends, [{ kind: 'send', text: 'finished words' }]);
});

test('late remote arm reaches an existing chip and its repeated final preserves a later cancellation', async () => {
  const h = harness({ armed: false });
  assert.equal(registry.updateDictationChipAutoSendFromVoice('vr-101', true), true);
  assert.equal(registry.getDictationChip('vr-101').autoSend, true);
  registry.disarmDictationChipsForTab('T');
  await h.resolve({ autoSend: true });
  h.flush();
  assert.deepEqual(h.sends, []);
});

test('final can recover a changed remote choice when its state-only request never arrived', async () => {
  const h = harness({ armed: false });
  await h.resolve({ autoSend: true });
  h.flush();
  assert.deepEqual(h.sends, [{ kind: 'send', text: 'finished words' }]);
});

test('multiple pending takes settle before one submit and duplicate final cannot send twice', async () => {
  const h = harness({ text: '[Dictating vr-101] [Dictating vr-102]' });
  registry.beginDictationChip({ id: 'vr-102', tabId: 'T', autoSend: true });
  await h.resolve({ text: 'first' });
  h.flush();
  assert.deepEqual(h.sends, []);
  await h.resolve({ chipId: 'vr-102', text: 'second' });
  h.flush();
  assert.deepEqual(h.sends, [{ kind: 'send', text: 'first second' }]);
  await h.resolve({ chipId: 'vr-102', text: 'second' });
  h.flush();
  assert.equal(h.sends.length, 1);
});

test('moving the marker to Run After prevents both local and remote direct arming', () => {
  const h = harness();
  registry.moveDictationChipsToRunAfter({ tabId: 'T', queueItemId: 'Q', text: h.state.historyPromptDrafts.T });
  assert.equal(registry.armDictationChipsForTab('T'), false);
  assert.equal(registry.updateDictationChipAutoSendFromVoice('vr-101', false), false);
  assert.equal(registry.updateDictationChipAutoSendFromVoice('vr-101', true), false);
  assert.equal(registry.getDictationChip('vr-101').autoSend, false);
});

test('deleted marker is not restored or sent by late completion', async () => {
  const h = harness({ text: 'new thought' });
  const result = await h.resolve();
  h.flush();
  assert.equal(result.reason, 'marker-deleted');
  assert.equal(h.state.historyPromptDrafts.T, 'new thought');
  assert.deepEqual(h.sends, []);
});

test('genuinely unmounted History keeps the same deferred draft contract', async () => {
  const h = harness({ mounted: false });
  const result = await h.resolve();
  assert.equal(result.reason, 'background-draft');
  assert.equal(registry.takeDeferredDictationSubmit('T').text, 'finished words');
  assert.deepEqual(h.sends, []);
});

test('a newer manual edit between resolve and the send frame cancels automatic submit', async () => {
  const h = harness();
  await h.resolve();
  h.state.historyPromptDrafts.T += ' unfinished edit';
  h.flush();
  assert.deepEqual(h.sends, []);
});

test('a mounted handler exception is logged and cannot masquerade as an unmounted panel', async () => {
  const h = harness({ failEditor: true });
  const result = await h.resolve();
  assert.equal(result.ok, false);
  assert.ok(h.logs.some(line => line.includes('injected editor failure')));
  assert.equal(h.state.historyPromptDrafts.T, '[Dictating vr-101]');
  assert.equal(registry.takeDeferredDictationSubmit('T'), null);
});

const marker = '[Dictating vr-101]';
for (const spoken of ['short', 'A much longer recognized sentence than the original inline placeholder.']) {
  test('untouched caret after a terminal chip follows the end of its resolved speech: ' + spoken, async () => {
    const text = 'prefix ' + marker;
    const h = harness({ armed: false, text, selectionStart: text.length });
    const result = await h.resolve({ text: spoken });
    assert.equal(result.resolved, true);
    assert.notEqual(result.reason, 'background-draft');
    assert.equal(h.editor.selectionStart, ('prefix ' + spoken).length);
    assert.equal(h.editor.selectionEnd, h.state.historyPromptDrafts.T.length);
  });
}

test('caret after a chip inserted in the middle stays between speech and the existing suffix', async () => {
  const prefix = 'before ';
  const h = harness({ armed: false, text: prefix + marker + ' after', selectionStart: prefix.length + marker.length });
  await h.resolve({ text: 'recognized words' });
  assert.equal(h.state.historyPromptDrafts.T, 'before recognized words after');
  assert.equal(h.editor.selectionStart, 'before recognized words'.length);
});

test('an image pasted after the chip keeps its attachment and the caret after that image', async () => {
  const text = marker + ' [Image #1] ';
  const image = { id: 1, path: '/tmp/caret-fixture.png', assetId: 'caret-fixture.png', size: 70, mediaType: 'image/png' };
  const h = harness({ armed: false, text, selectionStart: text.length, imagePaths: [image] });
  await h.resolve({ text: 'recognized words longer than a marker' });
  assert.equal(h.state.historyPromptDrafts.T, 'recognized words longer than a marker [Image #1] ');
  assert.equal(h.editor.selectionStart, h.state.historyPromptDrafts.T.length);
  assert.equal(h.editor.selectionEnd, h.state.historyPromptDrafts.T.length);
  assert.equal(h.state.historyPromptDraftImages.T[0].path, image.path);
});

test('a manually moved caret before the chip is not pulled to the end of speech', async () => {
  const h = harness({ armed: false, text: 'earlier text ' + marker, selectionStart: 4 });
  await h.resolve({ text: 'recognized words longer than a marker' });
  assert.equal(h.editor.selectionStart, 4);
  assert.equal(h.editor.selectionEnd, 4);
});

test('a saved caret after the chip follows speech when composer temporarily loses keyboard focus', async () => {
  const h = harness({ armed: false, text: marker, selectionStart: marker.length, focused: false });
  await h.resolve({ text: 'recognized words longer than a marker' });
  assert.equal(h.editor.selectionStart, h.state.historyPromptDrafts.T.length);
});

test.afterEach(() => registry.__resetDictationChips());
