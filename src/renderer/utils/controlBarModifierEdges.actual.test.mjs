import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(process.env.NOTED_CONTROLBAR_MODIFIERS_SOURCE
  || new URL('../components/Workspace/ClaudeControlBar.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ClaudeControlBar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes("window.addEventListener('keydown', sync, true)")
    && node.arguments[0].getText(ast).includes('setEnterCmdHeld')) effects.push(node.arguments[0].getText(ast));
  ts.forEachChild(node, visit);
};
visit(ast); assert.equal(effects.length, 1, 'one actual modifier effect');

function setup() {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const dispatch = (type, flags = {}) => {
    const event = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...flags };
    for (const listener of listeners.get(type) || []) listener(event);
  };
  const mount = () => {
    const state = { meta: false, control: false }, calls = [], changes = [];
    const setter = field => value => {
      calls.push([field, value]);
      if (state[field] !== value) changes.push([field, value]);
      state[field] = value;
    };
    const context = { window, setEnterCmdHeld: setter('meta'), setRunAfterControlHeld: setter('control') };
    vm.runInNewContext(ts.transpileModule('globalThis.effect = (' + effects[0] + ');', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context);
    return { state, calls, changes, dispose: context.effect() };
  };
  return { dispatch, mount, listeners };
}

test('plain rename typing enqueues no same-valued updates in retained bars', () => {
  const harness = setup(), owners = Array.from({ length: 84 }, harness.mount);
  for (let key = 0; key < 24; key++) { harness.dispatch('keydown'); harness.dispatch('keyup'); }
  assert.equal(owners.reduce((sum, owner) => sum + owner.calls.length, 0), 0);
  owners.forEach(owner => owner.dispose());
});

test('Cmd press, repeated key events and release preserve the physical state', () => {
  const h = setup(), owner = h.mount();
  h.dispatch('keydown', { metaKey: true });
  assert.equal(owner.state.meta, true);
  h.dispatch('keydown', { metaKey: true }); h.dispatch('keyup', { metaKey: true });
  h.dispatch('keyup');
  assert.deepEqual(owner.changes, [['meta', true], ['meta', false]]);
});

test('strict Ctrl preview tracks Shift, Alt, Cmd, composition and their release', () => {
  const h = setup(), owner = h.mount();
  for (const flags of [
    { ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true },
    { ctrlKey: true, altKey: true }, { ctrlKey: true },
    { ctrlKey: true, metaKey: true }, { ctrlKey: true },
    { ctrlKey: true, isComposing: true }, { ctrlKey: true }, {},
  ]) h.dispatch('keydown', flags);
  assert.equal(owner.state.meta, false); assert.equal(owner.state.control, false);
  assert.deepEqual(owner.changes.filter(([field]) => field === 'control').map(([, value]) => value),
    [true, false, true, false, true, false, true, false, true, false]);
});

test('blur clears held previews and does not change a neutral owner', () => {
  const h = setup(), owner = h.mount();
  h.dispatch('keydown', { metaKey: true }); h.dispatch('blur'); h.dispatch('blur');
  assert.deepEqual(owner.changes, [['meta', true], ['meta', false]]);
  assert.equal(owner.state.control, false);
});

test('retained owners are independent and cleanup removes only its own listeners', () => {
  const h = setup(), a = h.mount(), b = h.mount();
  h.dispatch('keydown', { ctrlKey: true }); a.dispose(); h.dispatch('keyup');
  assert.equal(a.state.control, true); assert.equal(b.state.control, false);
  b.dispose(); assert.ok([...h.listeners.values()].every(listeners => listeners.size === 0));
});

test('Cmd-before-hover and hover-before-Cmd keep the existing Record feedback', () => {
  let expression;
  const find = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'enterRecordMode') expression = node.initializer.getText(ast);
    ts.forEachChild(node, find);
  };
  find(ast); assert.ok(expression);
  const feedback = (owner, hovered) => vm.runInNewContext(expression, {
    isPrimaryHistoryAgent: true, historySubmitButtonEnabled: true, enterHovered: hovered, enterCmdHeld: owner.state.meta,
  });
  const first = setup(), a = first.mount(); first.dispatch('keydown', { metaKey: true });
  assert.equal(feedback(a, false), false); assert.equal(feedback(a, true), true);
  const second = setup(), b = second.mount(); assert.equal(feedback(b, true), false);
  second.dispatch('keydown', { metaKey: true }); assert.equal(feedback(b, true), true);
  second.dispatch('blur'); assert.equal(feedback(b, true), false);
});
