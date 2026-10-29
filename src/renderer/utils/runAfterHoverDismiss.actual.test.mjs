import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { pointInHoverCluster } from './hoverBridge.mjs';
const source = fs.readFileSync(process.env.RUN_AFTER_PICKER_SOURCE || new URL('../components/Workspace/RunAfterTabPicker.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('picker.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let selected, effectName;
const visit = node => { if (ts.isCallExpression(node) && ['useEffect', 'useLayoutEffect'].includes(node.expression.getText(ast))
  && node.arguments[0]?.getText(ast).includes('if (!open || !openOnHover) return;')) { selected = node.arguments[0].getText(ast); effectName = node.expression.getText(ast); }
  ts.forEachChild(node, visit); };
visit(ast); assert.ok(selected);
const code = ts.transpileModule('globalThis.run=' + selected, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture({ openOnHover = true, menuLeft = 30 } = {}) {
  let closed = false, reads = 0, flushes = 0, frameId = 0; const listeners = new Map(), frames = new Map();
  class Node { constructor(parent) { this.parent = parent; } contains(other) { for (; other; other = other.parent) if (other === this) return true; return false; } }
  const trigger = new Node(), menu = new Node(), child = new Node(menu), outside = new Node();
  trigger.getBoundingClientRect = () => { reads++; return { left: 0, right: 20, top: 0, bottom: 20 }; };
  menu.getBoundingClientRect = () => { reads++; return { left: menuLeft, right: menuLeft + 80, top: 0, bottom: 80 }; };
  const context = { open: true, openOnHover, Node, triggerRef: { current: trigger }, menuRef: { current: menu }, HOVER_CLOSE_TOLERANCE: 4, pointInHoverCluster,
    setOpen: value => { assert.equal(value, false); closed = true; }, flushSync: fn => { flushes++; fn(); },
    captureUIHoverAction: () => ({ id: 'own-leave' }), uiPerformancePhaseForAction() {}, uiPerformanceCommitForAction() {},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } };
  vm.runInNewContext(code, context); const cleanup = context.run();
  return { child, outside, menu, trigger, frames, move: (x, y, target = outside) => listeners.get('mousemove')?.({ clientX: x, clientY: y, target }),
    get closed() { return closed; }, get reads() { return reads; }, get flushes() { return flushes; }, dispose: () => cleanup?.() };
}
test('outside hover closes in its event without an intervening frame', () => { const f = fixture(); try {
  f.move(500, 500); assert.equal(f.closed, true); assert.equal(f.frames.size, 0); assert.equal(f.flushes, 1);
} finally { f.dispose(); } });
test('actual menu children and trigger stay open without per-move geometry inventory', () => { const f = fixture(); try {
  for (let n = 0; n < 20; n++) { f.move(40, 10, f.child); f.move(10, 10, f.trigger); }
  assert.equal(f.closed, false); assert.equal(f.reads, 0); assert.equal(f.frames.size, 0);
} finally { f.dispose(); } });
test('left/right popup gaps keep the existing coordinate bridge before outside close', () => {
  for (const menuLeft of [30, -90]) { const f = fixture({ menuLeft }); try {
    f.move(menuLeft > 0 ? 25 : -5, 10); assert.equal(f.closed, false);
    f.move(500, 500); assert(f.closed);
  } finally { f.dispose(); } }
});
test('click-open profile installs no hover-close listener and cleanup leaves no pending frame', () => { const f = fixture({ openOnHover: false });
  f.move(500, 500); assert.equal(f.closed, false); assert.equal(f.frames.size, 0); f.dispose();
  assert.equal(effectName, 'useLayoutEffect', 'click/hover mode listener scope is replaced in the commit');
});
