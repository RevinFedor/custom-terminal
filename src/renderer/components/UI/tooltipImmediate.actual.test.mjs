import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(process.env.TOOLTIP_SOURCE_PATH || new URL('./Tooltip.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
// Actual Tooltip module/hooks/handlers. React scheduling, DOM, clipboard and
// timer delivery are finite controlled ports; this is not mounted/native UI.
function fixture(options = {}) {
  const slots = [], layout = new Map(), passive = new Map(), listeners = new Map(), timers = new Map();
  let cursor = 0, dirty = true, tree, clock = 0, timerId = 0, flushes = 0, physicalHover = false, childEntered = 0;
  const childRef = { current: null }, copies = [];
  const trigger = { matches: () => physicalHover, closest: () => null,
    getBoundingClientRect: () => ({ left: 100, right: 126, top: 80, bottom: 106, width: 26, height: 26 }) };
  const tip = { getBoundingClientRect: () => ({ left: 0, right: 90, top: 0, bottom: 30, width: 90, height: 30 }) };
  const child = { type: 'button', ref: childRef, props: { onPointerEnter: () => childEntered++, ref: childRef } };
  let props = { content: 'finite own label', children: child, always: true, interactive: false, ...options };
  const state = initial => { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next;
      if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; };
  const effect = (queue, fn, deps) => { const i = cursor++, old = slots[i];
    if (!old || deps.some((value, k) => value !== old.deps[k])) { slots[i] = { ...old, deps }; queue.set(i, fn); } };
  const react = { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }),
    cloneElement: (node, attributes) => ({ ...node, props: { ...node.props, ...attributes } }), Fragment: 'fragment',
    useState: state, useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback: fn => { cursor++; return fn; }, useLayoutEffect: (fn, deps) => effect(layout, fn, deps),
    useEffect: (fn, deps) => effect(passive, fn, deps) };
  const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return;
    if (node.type === 'button') node.props.ref?.(trigger);
    if (node.props?.role === 'tooltip') node.props.ref.current = tip;
    visit(node.props?.children); };
  const runQueue = queue => { const pending = [...queue]; queue.clear(); for (const [i, fn] of pending) {
    slots[i].cleanup?.(); slots[i].cleanup = fn(); } };
  let module;
  const commit = () => { let iterations = 0; do { assert(++iterations < 20, 'finite commit'); dirty = false; cursor = 0;
    tree = module.exports.default(props); visit(tree); runQueue(layout); } while (dirty); return tree; };
  const context = { module: module = { exports: {} }, exports: module.exports, console,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, due: clock + ms, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    document: { body: {} }, navigator: { clipboard: { writeText: () => { throw Error('no browser clipboard'); } } },
    window: { innerWidth: 800, innerHeight: 600,
      addEventListener: (name, fn) => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      require: name => { assert.equal(name, 'electron'); return { clipboard: { writeText: text => copies.push(text) } }; } },
    require: name => name === 'react' ? react : name === 'react-dom'
      ? { createPortal: node => ({ type: 'portal', props: { children: [node] } }), flushSync: fn => { flushes++; fn(); commit(); } }
      : name.includes('uiPerformanceDiagnostics') ? { captureUIHoverAction: () => null, uiPerformancePhaseForAction() {}, uiPerformanceCommitForAction() {} }
      : (() => { throw Error('unexpected dependency ' + name); })() };
  vm.runInNewContext(code, context);
  const find = (node, predicate) => { if (Array.isArray(node)) return node.map(n => find(n, predicate)).find(Boolean);
    if (!node || typeof node !== 'object') return null; return predicate(node) ? node : find(node.props?.children, predicate); };
  const flushPassive = () => { let steps = 0; while (passive.size) { assert(++steps < 20); runQueue(passive); if (dirty) commit(); } };
  commit(); flushPassive();
  const fire = (name, onTip = false) => { if (!onTip && name === 'onPointerEnter') physicalHover = true;
    if (!onTip && name === 'onPointerLeave') physicalHover = false;
    const node = find(tree, n => onTip ? n.props?.role === 'tooltip' : n.type === 'button');
    node?.props[name]?.({ stopPropagation() {}, type: name, currentTarget: onTip ? tip : trigger }); if (dirty) commit(); };
  return { fire, flushPassive, timers, copies, childRef, trigger,
    get visible() { return !!find(tree, n => n.props?.role === 'tooltip'); }, get flushes() { return flushes; },
    get childEntered() { return childEntered; },
    update: patch => { props = { ...props, ...patch }; commit(); },
    tick: ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
      if (dirty) commit(); },
    key: (type, key = 'Meta') => { for (const fn of listeners.get(type) || []) fn({ key }); if (dirty) commit(); },
    dispose: () => { for (const slot of slots) slot?.cleanup?.(); timers.clear(); } };
}
test('zero-delay simple label opens before passive effects and closes in the leaving event commit', () => {
  const f = fixture(); try { f.fire('onPointerEnter'); assert.equal(f.visible, true, 'no post-paint effect required');
    f.fire('onPointerLeave'); assert.equal(f.visible, false); assert.equal(f.timers.size, 0); assert(f.flushes >= 1);
  } finally { f.dispose(); }
});
test('an already visible simple label does not survive a leave until passive effects run', () => {
  const f = fixture(); try { f.fire('onPointerEnter'); f.flushPassive(); assert(f.visible);
    f.fire('onPointerLeave'); assert.equal(f.visible, false, 'hide must not depend on the later passive effect');
  } finally { f.dispose(); }
});
test('interactive trigger-to-tip bridge keeps its60ms interval and selectable body', () => {
  const f = fixture({ interactive: true }); try { f.fire('onPointerEnter'); f.flushPassive(); assert(f.visible);
    f.fire('onPointerLeave'); assert(f.visible); assert([...f.timers.values()].some(t => t.ms === 60));
    f.fire('onPointerEnter', true); assert.equal(f.timers.size, 0); f.tick(100); f.flushPassive(); assert(f.visible);
    f.fire('onPointerLeave', true); f.flushPassive(); assert.equal(f.visible, false);
  } finally { f.dispose(); }
});
test('explicit opening delay remains finite and leaving cancels it without late reappearance', () => {
  const f = fixture({ delay: 120 }); try { f.fire('onPointerEnter'); f.flushPassive(); assert.equal(f.visible, false);
    f.tick(119); assert.equal(f.visible, false); f.fire('onPointerLeave'); assert.equal(f.timers.size, 0);
    f.tick(500); f.flushPassive(); assert.equal(f.visible, false);
  } finally { f.dispose(); }
});
test('Cmd-only labels keep both input orders, disabled guard and existing child handlers/ref', () => {
  for (const metaFirst of [true, false]) { const f = fixture({ always: false }); try {
    if (metaFirst) { f.key('keydown'); f.fire('onPointerEnter'); } else { f.fire('onPointerEnter'); f.key('keydown'); }
    assert(f.visible); assert.equal(f.childEntered, 1); assert.equal(f.childRef.current, f.trigger);
    f.key('keyup'); assert.equal(f.visible, false); f.update({ disabled: true }); f.key('keydown'); f.fire('onPointerEnter'); assert.equal(f.visible, false);
  } finally { f.dispose(); } }
});
test('Sidebar ControlHint keeps the actual simple-label profile and disabled native title', () => {
  const hintSource=fs.readFileSync(new URL('./ControlHint.tsx',import.meta.url),'utf8');
  const compiled=ts.transpileModule(hintSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
  for(const enabled of [true,false]){const module={exports:{}},react={createElement:(type,props,...children)=>({type,props:{...props,children}}),cloneElement:(node,props)=>({...node,props:{...node.props,...props}})};
    vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>name==='react'?react:name==='./Tooltip'?{__esModule:true,default:'ActualTooltip'}:{useControlHelpStore:selector=>selector({enabled})}});
    const child={type:'button',props:{title:'why unavailable'}};
    const view=module.exports.default({label:'own finite label',children:child,disabled:!enabled});
    assert.equal(view.type,'ActualTooltip');assert.equal(view.props.interactive,false);assert.equal(view.props.disabled,!enabled);
    assert.equal(view.props.children[0].props.title,enabled?undefined:'why unavailable');
  }
});
