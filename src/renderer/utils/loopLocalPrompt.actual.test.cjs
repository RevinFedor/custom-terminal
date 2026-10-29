'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), vm = require('node:vm');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const esbuild = require('esbuild'), ts = require('typescript');
const repo = path.resolve(__dirname, '../../..'), before = process.env.LOOP_LOCAL_PRE_ROOT;
let bundle, fields;
test.before(async () => {
  const output = await esbuild.build({ entryPoints: [path.join(repo, 'src/renderer/store/usePromptQueueStore.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: before ? [{ name: 'saved-store', setup(build) {
      build.onLoad({ filter: /usePromptQueueStore\.ts$/ }, args => ({ contents: fs.readFileSync(path.join(before,
        'src/renderer/store/usePromptQueueStore.ts'), 'utf8'), loader: 'ts', resolveDir: path.dirname(args.path) }));
    } }] : [] });
  bundle = output.outputFiles[0].text;
  const result = await esbuild.build({ entryPoints: [path.join(repo, 'src/renderer/components/Workspace/LoopPromptFields.tsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react'], logLevel: 'silent',
    plugins: [{ name: 'controlled-composer-leaf', setup(build) {
      build.onLoad({ filter: /components\/ComposerEditor\.tsx$/ }, () => ({ contents: `const React=require('react');
        export const ComposerEditor=React.forwardRef((props,ref)=>React.createElement('textarea',{
        ref,value:props.value,onChange:props.onChange,onKeyDown:props.onKeyDown,
        'data-history-owner':props.historyOwnerKey,style:props.style}));`, loader: 'tsx' }));
      build.onLoad({ filter: /electronComposerClipboardAdapter\.ts$/ }, () => ({ contents: 'export const electronComposerClipboardAdapter={};', loader: 'ts' }));
    } }] });
  fields = load(result.outputFiles[0].text, 'fields').LoopPromptFields;
});
function load(code, name) {
  const file = path.join(__dirname, name + '.private.cjs'), m = new Module(file, require.main);
  m.filename = file; m.paths = Module._nodeModulePaths(__dirname); m._compile(code, file); return m.exports;
}
async function fixture(t, initial = {}, delayed = false) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const old = global.window, saved = new Map([['promptQueueByTab', initial]]);
  let release; let pending = delayed ? new Promise(resolve => { release = resolve; }) : null;
  global.window = { require: () => ({ ipcRenderer: { on() {}, removeListener() {},
    invoke: async (name, arg) => {
      if (name === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'shared instructions' }] };
      if (name === 'ai-prompts:save-content') return { success: true };
      if (name === 'app:getState') { if (pending) { const p = pending; pending = null; return p; } return saved.get(arg); }
      if (name === 'app:setState') { saved.set(arg.key, arg.value); return { success: true }; }
      throw Error(name);
    }, sendSync(_name, arg) { saved.set(arg.key, arg.value); return { success: true }; } } }) };
  let module = load(bundle, 'local-store'), hydration = module.hydratePromptQueueStore();
  if (!delayed) await hydration;
  t.after(() => { module.flushPromptQueueStoreSync(); if (old === undefined) delete global.window; else global.window = old; t.mock.timers.reset(); });
  return { get module() { return module; }, state: () => module.usePromptQueueStore.getState(), saved,
    hydrate: async () => { release(initial); await hydration; },
    restore: async () => { module.flushPromptQueueStoreSync(); module = load(bundle, 'local-restored'); await module.hydratePromptQueueStore(); } };
}

test('local text edits only this owner; shared text remains shared and no other arm changes', async t => {
  const h = await fixture(t); const s = h.state();
  assert.equal(typeof s.setLocalLoopPromptText, 'function', 'local prompt has its own writer');
  s.setLoopPromptEnabled('A', true); s.setLoopPromptEnabled('B', true, 'own-turn');
  const a = s.getQueue('A').loopPromptEpoch, b = s.getQueue('B').loopPromptEpoch;
  t.mock.timers.setTime(1100); s.setLocalLoopPromptText('A', 'only A');
  assert.equal(h.state().getQueue('A').localLoopPromptText, 'only A');
  assert.equal(h.state().getQueue('B').localLoopPromptText || '', '');
  assert.notEqual(h.state().getQueue('A').loopPromptEpoch, a); assert.equal(h.state().getQueue('B').loopPromptEpoch, b);
  h.state().setLoopPromptText('B', 'new shared');
  assert.equal(h.state().getQueue('A').loopPromptText, 'new shared');
  assert.equal(h.state().getQueue('A').localLoopPromptText, 'only A');
});

test('local-only OFF settings survive hydration/restart; pre-load edits win older disk values', async t => {
  const h = await fixture(t, { A: { localLoopPromptText: 'old', loopPromptEnabled: false } }, true);
  assert.equal(typeof h.state().setLocalLoopPromptText, 'function');
  h.state().setLocalLoopPromptText('A', 'typed before hydration'); await h.hydrate();
  assert.equal(h.state().getQueue('A').localLoopPromptText, 'typed before hydration');
  await h.restore(); assert.equal(h.state().getQueue('A').localLoopPromptText, 'typed before hydration');
  assert.equal(h.state().getQueue('A').loopPromptEnabled, false);
  assert.equal(h.module.serializePromptQueueCore(h.state().getQueue('A')).localLoopPromptText, 'typed before hydration');
});

test('actual getLoopPrompt composes shared then local before exact protocol in BOTH modes', async t => {
  const h = await fixture(t); assert.equal(typeof h.state().setLocalLoopPromptText, 'function');
  const file = path.join(before || repo, 'src/renderer/hooks/usePromptQueueRunner.ts');
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getLoopPrompt');
  const protocol = require('../../shared/task-completion-protocol.cjs');
  const c = vm.createContext({ ...protocol, isLoopPromptActive: h.module.isLoopPromptActive, loopPromptMode: h.module.loopPromptMode,
    loopDependencyEntry: () => null, shortPromptFingerprint: value => value });
  vm.runInContext(ts.transpileModule(fn.getText(tree) + '\nglobalThis.prompt = getLoopPrompt;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, c);
  for (const mode of ['all-work', 'own-turn']) {
    h.state().setLoopPromptEnabled('A', true, mode); h.state().setLocalLoopPromptText('A', 'local instructions');
    const q = h.state().getQueue('A'), p = c.prompt(q, 'A');
    assert.match(p.text, /^shared instructions\n\nlocal instructions\n\n<terminal_task_completion_protocol>/);
    assert.equal(p.text.includes('await_dependencies'), mode === 'own-turn');
    const id = p.id; h.state().setLocalLoopPromptText('A', 'changed local');
    assert.notEqual(c.prompt(h.state().getQueue('A'), 'A').id, id, 'prepared old local text is revoked');
  }
  h.state().setLoopPromptText('A', ''); h.state().setLocalLoopPromptText('A', 'local alone');
  assert.ok(c.prompt(h.state().getQueue('A'), 'A'), 'an authored local prompt can stand alone');
});

test('two clearly labelled fields share one height budget and keep independent text/undo owners', () => {
  const updates = [], props = { tabId: 'A', sharedText: 'global', localText: 'local', height: 320, fontSize: 13,
    autoFocus: true, sharedRef: null, onSharedChange: value => updates.push(['shared', value]),
    onLocalChange: value => updates.push(['local', value]), onSave() {}, onClose() {} };
  const element = fields(props), html = renderToStaticMarkup(element);
  assert.match(html, /Общий для всех вкладок/); assert.match(html, /Только для этой вкладки/);
  assert.equal((html.match(/<textarea/g) || []).length, 2); assert.match(html, /height:320px/);
  assert.match(html, /minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  const rows = element.props.children;
  rows[0].props.children[1].props.onChange('new shared'); rows[1].props.children[1].props.onChange('new local');
  assert.deepEqual(updates, [['shared', 'new shared'], ['local', 'new local']]);
  assert.notEqual(rows[0].props.children[1].props.historyOwnerKey, rows[1].props.children[1].props.historyOwnerKey);
});
