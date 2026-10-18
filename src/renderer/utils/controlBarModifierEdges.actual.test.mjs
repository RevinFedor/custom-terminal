import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(process.env.NOTED_CONTROLBAR_MODIFIERS_SOURCE
  || new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ClaudeControlBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(ast.parseDiagnostics.length, 0);
let component;
const visit = node => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'ClaudeControlBar') component = node;
  ts.forEachChild(node, visit);
};
visit(ast); assert.ok(component?.body, 'actual ControlBar function');
const statements = [...component.body.statements];
const effectMatches = statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect'
  && node.expression.arguments[0]?.getText(ast).includes("window.addEventListener('keydown', sync, true)"));
assert.equal(effectMatches.length, 1, 'one actual capture modifier effect (setter may live in callback)');
const effect = effectMatches[0];
const names = node => ts.isIdentifier(node) ? [node.text]
  : ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
    ? node.elements.flatMap(item => ts.isBindingElement(item) ? names(item.name) : []) : [];
// Keep real store/owner snapshots as inputs. Within this small existing region,
// collect actual declarations transitively used by the effect and UI consumers.
const regionStart = statements.findIndex(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(decl => decl.name.getText(ast) === 'isPrimaryHistoryAgent'));
const region = statements.slice(regionStart, statements.indexOf(effect) + 1);
assert.ok(regionStart >= 0 && region.includes(effect));
const declarations = new Map();
for (const statement of region) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations)
    for (const name of names(declaration.name)) declarations.set(name, statement);
}
const identifiers = node => {
  const found = new Set();
  const scan = child => { if (ts.isIdentifier(child)) found.add(child.text); ts.forEachChild(child, scan); };
  scan(node); return found;
};
const selected = new Set([effect]);
for (const name of ['enterPending', 'enterHovered', 'enterCmdHeld', 'runAfterControlHeld',
  'enterRecordMode', 'runAfterCaptureHotkeyPreview', 'runAfterToggleHotkeyPreview', 'showComposerInputActions']) {
  assert.ok(declarations.has(name), name); selected.add(declarations.get(name));
}
let changed;
do {
  changed = false;
  const add = node => { if (node && !selected.has(node)) { selected.add(node); changed = true; } };
  for (const node of [...selected]) for (const name of identifiers(node)) add(declarations.get(name));
  const selectedNames = new Set([...declarations].filter(([, node]) => selected.has(node)).map(([name]) => name));
  for (const node of region) if (ts.isExpressionStatement(node)) {
    const expression = node.expression;
    if (ts.isCallExpression(expression) && expression.expression.getText(ast) === 'useLayoutEffect'
      && expression.arguments.some(arg => [...identifiers(arg)].some(name => selectedNames.has(name)))) add(node);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && [...identifiers(expression.left)].some(name => selectedNames.has(name))) add(node);
  }
} while (changed);
const extracted = region.filter(node => selected.has(node)).map(node => node.getText(ast)).join('\n');
const javascript = ts.transpileModule('function render() {\n' + extracted + `
return { meta: enterCmdHeld, control: runAfterControlHeld, feedback: enterRecordMode,
  capture: runAfterCaptureHotkeyPreview, toggle: runAfterToggleHotkeyPreview,
  actions: showComposerInputActions, setEnterHovered, setEnterPending };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup() {
  const listeners = new Map(), owners = new Set();
  const window = {
    addEventListener(type, fn, capture = false) {
      const key = type + ':' + capture;
      if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn);
    },
    removeEventListener(type, fn, capture = false) { listeners.get(type + ':' + capture)?.delete(fn); },
  };
  const mount = (overrides = {}) => {
    const { hovered = false, ...snapshots } = overrides;
    const slots = [], calls = [], changes = [], refReplacements = [];
    let index = 0, stateIndex = 0, dirty = false, current, mounted = true;
    const layout = [], passive = [];
    const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
    const inputs = { agentRoleOwnsControls: true, historyIsPrimary: true, sessionType: 'claude', isSDKTab: false,
      isCommandRunning: true, tabId: 'tab-a', historyCanSend: true, historyCanAcceptSubmitIntent: false,
      historyDraftHasText: false, historyDraftImageCount: 0, historyDraftChipCount: 0,
      workspaceOwnsKeyboard: false, runAfterHotkeyTargetsThisTab: false, promptPickerOpen: false,
      runAfterActiveItemCount: 0, ...snapshots };
    const stateNames = ['enterPending', 'enterCmdHeld', 'enterHovered', 'runAfterControlHeld'];
    const context = vm.createContext({ ...inputs, window,
      useState(initial) {
        const i = index++, name = stateNames[stateIndex++];
        if (!slots[i]) {
          const slot = slots[i] = { kind: 'state', value: initial };
          slot.set = value => {
            assert.ok(mounted, 'no setter after unmount');
            const next = typeof value === 'function' ? value(slot.value) : value;
            const field = name === 'enterCmdHeld' ? 'meta' : name === 'runAfterControlHeld' ? 'control' : null;
            if (field) { calls.push([field, next]); if (!Object.is(slot.value, next)) changes.push([field, next]); }
            if (!Object.is(slot.value, next)) { slot.value = next; dirty = true; }
          };
        }
        return [slots[i].value, slots[i].set];
      },
      useRef(initial) {
        const i = index++;
        if (!slots[i]) {
          let value = initial;
          const ref = Object.defineProperty({}, 'current', {
            get: () => value,
            set: next => { if (!Object.is(value, next)) refReplacements.push({ previous: value, next }); value = next; },
          });
          slots[i] = { kind: 'ref', value: ref };
        }
        return slots[i].value;
      },
      useCallback(fn, deps) {
        const i = index++;
        if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { kind: 'callback', value: fn, deps };
        return slots[i].value;
      },
      useDictationSnapshot: () => ({ owner: null, recording: false, stopping: false }),
    });
    for (const [name, kind] of [['useEffect', 'passive'], ['useLayoutEffect', 'layout']]) context[name] = (fn, deps) => {
      const i = index++;
      if (!slots[i]) { slots[i] = { kind, fn, deps, cleanup: null }; (kind === 'layout' ? layout : passive).push(i); }
      else if (!same(slots[i].deps, deps)) { slots[i].fn = fn; slots[i].deps = deps; (kind === 'layout' ? layout : passive).push(i); }
    };
    vm.runInContext(javascript, context);
    const run = queue => { for (const i of queue.splice(0)) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].fn() || null; } };
    const flush = () => {
      if (!mounted) return;
      let turns = 0;
      do { assert.ok(++turns < 20, 'controlled hooks settle'); dirty = false; index = stateIndex = 0; current = context.render(); run(layout); run(passive); } while (dirty);
    };
    const owner = {
      get state() { return current; }, calls, changes, refReplacements, flush,
      set(values) { Object.assign(context, values); flush(); },
      hover(value) { current.setEnterHovered(value); flush(); },
      pending(value) { current.setEnterPending(value); flush(); },
      refs() { return slots.filter(slot => slot.kind === 'ref').map(slot => slot.value.current); },
      dispose() { for (const slot of slots) if (slot.kind === 'passive' || slot.kind === 'layout') slot.cleanup?.(); mounted = false; owners.delete(owner); },
    };
    owners.add(owner); flush(); if (hovered) owner.hover(true); calls.length = changes.length = refReplacements.length = 0;
    return owner;
  };
  const dispatch = (type, flags = {}) => {
    const event = { type, key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...flags };
    for (const capture of [true, false]) for (const listener of [...(listeners.get(type + ':' + capture) || [])]) listener(event);
    for (const owner of owners) owner.flush();
  };
  return { dispatch, mount, listeners };
}
const keyboardOwner = { workspaceOwnsKeyboard: true, runAfterHotkeyTargetsThisTab: true, historyDraftHasText: true };

test('plain rename typing enqueues no same-valued updates in retained bars', () => {
  const h = setup(), owners = Array.from({ length: 84 }, () => h.mount());
  for (let key = 0; key < 24; key++) { h.dispatch('keydown'); h.dispatch('keyup'); }
  assert.equal(owners.reduce((sum, owner) => sum + owner.calls.length, 0), 0);
  owners.forEach(owner => owner.dispose());
});
test('idle modifier edges publish no React state in retained bars', () => {
  const h = setup(), owners = Array.from({ length: 84 }, () => h.mount());
  h.dispatch('keydown', { metaKey: true }); h.dispatch('keyup');
  h.dispatch('keydown', { ctrlKey: true }); h.dispatch('keyup');
  assert.equal(owners.reduce((sum, owner) => sum + owner.calls.length, 0), 0);
  owners.forEach(owner => owner.dispose());
});
test('hovered Cmd press, repeated key events and release preserve feedback', () => {
  const h = setup(), owner = h.mount({ hovered: true });
  h.dispatch('keydown', { metaKey: true }); assert.equal(owner.state.meta, true); assert.equal(owner.state.feedback, true);
  h.dispatch('keydown', { metaKey: true }); h.dispatch('keyup', { metaKey: true }); h.dispatch('keyup');
  assert.deepEqual(owner.changes, [['meta', true], ['meta', false]]); owner.dispose();
});
test('strict Ctrl preview tracks Shift, Alt, Cmd, composition and their release', () => {
  const h = setup(), owner = h.mount(keyboardOwner);
  for (const flags of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true },
    { ctrlKey: true, altKey: true }, { ctrlKey: true }, { ctrlKey: true, metaKey: true }, { ctrlKey: true },
    { ctrlKey: true, isComposing: true }, { ctrlKey: true }, {}]) h.dispatch('keydown', flags);
  assert.equal(owner.state.meta, false); assert.equal(owner.state.control, false);
  assert.deepEqual(owner.changes.filter(([field]) => field === 'control').map(([, value]) => value),
    [true, false, true, false, true, false, true, false, true, false]); owner.dispose();
});
test('blur clears held previews and does not change a neutral owner', () => {
  const h = setup(), owner = h.mount({ hovered: true }), idle = h.mount();
  h.dispatch('keydown', { metaKey: true }); h.dispatch('blur'); h.dispatch('blur');
  assert.deepEqual(owner.changes, [['meta', true], ['meta', false]]); assert.equal(idle.calls.length, 0);
  owner.hover(false); owner.hover(true); assert.equal(owner.state.feedback, false); owner.dispose(); idle.dispose();
});
test('retained owners are independent and cleanup removes only its own listeners', () => {
  const h = setup(), a = h.mount(keyboardOwner), b = h.mount(keyboardOwner);
  h.dispatch('keydown', { ctrlKey: true }); a.dispose(); h.dispatch('keyup');
  assert.equal(a.state.control, true); assert.equal(b.state.control, false);
  b.dispose(); assert.ok([...h.listeners.values()].every(listeners => listeners.size === 0));
});
test('Cmd-before-hover and hover-before-Cmd keep actual Record feedback, including unfocused Enter', () => {
  for (const first of ['Cmd', 'hover']) {
    const h = setup(), owner = h.mount();
    if (first === 'Cmd') { h.dispatch('keydown', { metaKey: true }); assert.equal(owner.state.feedback, false); owner.hover(true); }
    else { owner.hover(true); assert.equal(owner.state.feedback, false); h.dispatch('keydown', { metaKey: true }); }
    assert.equal(owner.state.feedback, true); owner.hover(false); assert.equal(owner.state.meta, false);
    owner.hover(true); assert.equal(owner.state.feedback, true); h.dispatch('blur'); assert.equal(owner.state.feedback, false); owner.dispose();
  }
});
test('eligibility, picker, owner, draft and queue changes reproject already-held keys', () => {
  const h = setup(), owner = h.mount();
  h.dispatch('keydown', { ctrlKey: true }); assert.equal(owner.calls.length, 0);
  owner.set(keyboardOwner); assert.equal(owner.state.capture, true);
  owner.set({ promptPickerOpen: true }); assert.equal(owner.state.control, false);
  owner.set({ promptPickerOpen: false, runAfterHotkeyTargetsThisTab: false }); assert.equal(owner.state.control, false);
  owner.set({ runAfterHotkeyTargetsThisTab: true }); assert.equal(owner.state.capture, true);
  owner.set({ historyDraftHasText: false }); assert.equal(owner.state.control, false);
  owner.set({ runAfterActiveItemCount: 1 }); assert.equal(owner.state.toggle, true);
  owner.set({ isSDKTab: true }); assert.equal(owner.state.control, false);
  owner.set({ isSDKTab: false }); assert.equal(owner.state.toggle, true);
  h.dispatch('keyup'); owner.dispose();
});
test('pending retains original Record predicate semantics on both PRE and POST', () => {
  const h = setup(), owner = h.mount({ hovered: true }); h.dispatch('keydown', { metaKey: true });
  owner.pending(true); assert.equal(owner.state.feedback, true); owner.pending(false); assert.equal(owner.state.feedback, true);
  owner.dispose();
});
test('disabled eligibility clears only UI projection and restores held Cmd', () => {
  const h = setup(), owner = h.mount({ hovered: true }); h.dispatch('keydown', { metaKey: true });
  owner.set({ historyCanSend: false }); assert.equal(owner.state.meta, false);
  owner.set({ historyCanSend: true }); assert.equal(owner.state.feedback, true); owner.dispose();
});
test('physical/ref objects are stable across key events, exact flags, blur, render and cleanup', () => {
  const h = setup(), owner = h.mount();
  const refs = owner.refs();
  const physical = refs.find(value => value && typeof value === 'object' && 'composing' in value);
  // PRE uses lexical physical booleans; POST stores the same event flags in one ref.
  for (const flags of [{ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true, isComposing: true },
    { ctrlKey: true }, {}, { metaKey: true }]) {
    h.dispatch('keydown', flags);
    assert.equal(owner.refReplacements.length, 0, 'no per-key ref object replacement');
    if (physical) assert.deepEqual(JSON.parse(JSON.stringify(physical)), {
      meta: !!flags.metaKey, control: !!flags.ctrlKey, alt: !!flags.altKey, shift: !!flags.shiftKey, composing: !!flags.isComposing,
    });
  }
  owner.set(keyboardOwner); owner.hover(true); h.dispatch('blur');
  if (physical) assert.ok(Object.values(physical).every(value => value === false));
  owner.refs().forEach((value, i) => assert.equal(value, refs[i]));
  assert.equal(owner.refReplacements.length, 0, 'no .current object replacement per event or render');
  owner.dispose(); if (physical) assert.ok(Object.values(physical).every(value => value === false));
});
