'use strict';
// Actual store, three production JSX buttons and Loop prompt selector.
// Electron persistence is a private map; no renderer, provider or app is started.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), esbuild = require('esbuild'), React = require('react');
const protocol = require('../../shared/task-completion-protocol.cjs');
const defaultText = require('../../shared/prompt-loop.cjs').DEFAULT_LOOP_PROMPT;
async function fixture(t, initial = {}, delayed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-modes-')), file = path.join(root, 'store.cjs');
  const saved = new Map([['promptQueueByTab', initial]]);
  let resolveRead;
  const read = delayed ? new Promise(resolve => { resolveRead = resolve; }) : null;
  let initialRead = read;
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../store/usePromptQueueStore.ts')], outfile: file,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  global.window = { require: () => ({ ipcRenderer: { on() {}, removeListener() {},
    invoke: async (channel, value) => {
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: defaultText }] };
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:getState') {
        if (initialRead) { const pending = initialRead; initialRead = null; return pending; }
        return saved.get(value);
      }
      if (channel === 'app:setState') { saved.set(value.key, value.value); return { success: true }; }
      throw Error('unexpected IPC: ' + channel);
    }, sendSync: (_channel, value) => { saved.set(value.key, value.value); return { success: true }; } } }) };
  let module = require(file);
  t.after(() => { module.flushPromptQueueStoreSync(); delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  const hydration = module.hydratePromptQueueStore();
  if (!delayed) await hydration;
  return { get module() { return module; }, state: () => module.usePromptQueueStore.getState(),
    resolveRead: () => resolveRead(initial), hydration,
    restore: async () => {
      module.flushPromptQueueStoreSync(); delete require.cache[require.resolve(file)];
      module = require(file); await module.hydratePromptQueueStore();
    } };
}
const uiFile = path.resolve(__dirname, '../components/Workspace/PromptQueueOverlay.tsx');
const tree = ts.createSourceFile(uiFile, fs.readFileSync(uiFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let controlsJSX;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.text === 'data-prompt-queue-loop-modes')) controlsJSX = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(controlsJSX, 'production segmented control');
function buttons(h) {
  const q = h.state().getQueue('P'), enabled = q.loopPromptEnabled;
  const context = vm.createContext({ React, ControlHint: 'hint', GitBranch: 'branch', RefreshCw: 'refresh', Pencil: 'pencil',
    ownTurnLoopEnabled: enabled && h.module.loopPromptMode(q) === 'own-turn',
    standardLoopEnabled: enabled && h.module.loopPromptMode(q) === 'all-work', loopPromptEnabled: enabled,
    loopWait: null, overview: false, effectiveWidth: 300, PULSE: 'purple', BORDER: 'gray', PANEL_BG: 'black', TEXT_MUTED: 'gray',
    tabId: 'P', setLoopPromptEnabled: (...args) => h.state().setLoopPromptEnabled(...args),
    openLoopPromptEditor: () => { context.edited = true; } });
  vm.runInContext(ts.transpileModule('globalThis.element = (' + controlsJSX + ');',
    { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, fileName: 'controls.tsx' }).outputText, context);
  const found = [];
  function walk(element) {
    if (!element || typeof element !== 'object') return;
    if (element.type === 'button') found.push(element.props);
    React.Children.forEach(element.props?.children, walk);
  }
  walk(context.element); return { found, context };
}

test('actual left/Loop/pencil buttons select exclusive modes; same active segment switches OFF', async t => {
  const h = await fixture(t); let ui = buttons(h);
  assert.equal(ui.found.length, 3);
  assert.equal(h.module.loopPromptMode(h.state().getQueue('P')), 'all-work');
  ui.found[1].onClick(); ui = buttons(h);
  assert.deepEqual(ui.found.slice(0, 2).map(button => button['aria-pressed']), [false, true]);
  const ordinaryEpoch = h.state().getQueue('P').loopPromptEpoch;
  ui.found[0].onClick(); ui = buttons(h);
  assert.deepEqual(ui.found.slice(0, 2).map(button => button['aria-pressed']), [true, false]);
  assert.notEqual(h.state().getQueue('P').loopPromptEpoch, ordinaryEpoch);
  const text = h.state().getQueue('P').loopPromptText;
  ui.found[2].onClick(); assert.equal(ui.context.edited, true);
  assert.equal(h.state().getQueue('P').loopPromptText, text, 'one shared editor/prompt');
  ui.found[0].onClick(); assert.equal(h.state().getQueue('P').loopPromptEnabled, false);
  await h.restore();
  assert.equal(h.module.loopPromptMode(h.state().getQueue('P')), 'own-turn', 'OFF preference also survives empty-queue restore');
  buttons(h).found[1].onClick(); assert.equal(h.module.loopPromptMode(h.state().getQueue('P')), 'all-work');
});

test('legacy/default mode stays ordinary, selected mode/ON survive restart and install floors', async t => {
  const h = await fixture(t, { P: { loopPromptEnabled: true, loopPromptArmedAt: 1 } });
  assert.equal(h.module.loopPromptMode(h.state().getQueue('P')), 'all-work');
  h.state().setLoopPromptEnabled('P', true, 'own-turn');
  const epoch = h.state().getQueue('P').loopPromptEpoch;
  h.state().suspendWorkflowsForRestart(); h.state().applyBuildInstallContinuationFloor('P', Date.now());
  await h.restore(); const q = h.state().getQueue('P');
  assert.equal(q.loopPromptEnabled, true); assert.equal(q.loopPromptMode, 'own-turn'); assert.equal(q.loopPromptEpoch, epoch);
  assert.equal(h.module.serializePromptQueueCore(q).loopPromptMode, 'own-turn');
});

test('mode selected before hydration wins over an older ordinary snapshot', async t => {
  const h = await fixture(t, { P: { loopPromptEnabled: true, loopPromptMode: 'all-work', loopPromptArmedAt: 1 } }, true);
  h.state().setLoopPromptEnabled('P', true, 'own-turn');
  h.resolveRead(); await h.hydration;
  assert.equal(h.state().getQueue('P').loopPromptMode, 'own-turn');
  await h.restore(); assert.equal(h.state().getQueue('P').loopPromptMode, 'own-turn');
});

test('actual prompt selector advertises await_dependencies only for explicit own-turn mode', async t => {
  const h = await fixture(t);
  const file = path.resolve(__dirname, '../hooks/usePromptQueueRunner.ts'), source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getLoopPrompt');
  const context = vm.createContext({ ...protocol, loopPromptMode: h.module.loopPromptMode,
    isLoopPromptActive: h.module.isLoopPromptActive, loopDependencyEntry: () => null, shortPromptFingerprint: () => 'test' });
  vm.runInContext(ts.transpileModule(fn.getText(ast) + '\nglobalThis.prompt = getLoopPrompt;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  h.state().setLoopPromptEnabled('P', true);
  let prompt = context.prompt(h.state().getQueue('P'), 'P');
  assert.doesNotMatch(prompt.text, /await_dependencies/); assert.match(prompt.text, /complete_task/);
  h.state().setLoopPromptEnabled('P', true, 'own-turn');
  const next = context.prompt(h.state().getQueue('P'), 'P');
  assert.match(next.text, /await_dependencies/); assert.notEqual(next.id, prompt.id, 'old prepared send loses its identity');
});
