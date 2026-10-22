import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transformSync } from 'esbuild';
import * as linked from '../../utils/tabLinkedFiles.mjs';
import * as hoverIntent from '../../utils/chipHoverIntent.mjs';

// Execute the actual TSX/event handlers. Hook scheduling, stores, portal,
// file tree and DOM are controlled: this does not prove browser hit-testing.
const source = fs.readFileSync(new URL('./TabLinkedFiles.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const file = id => ({ id, ownerTabId: 'owner', projectId: 'p', path: `/fixture/${id}.md`, name: `${id}.md` });
const one = file('one'), two = file('two');

function fixture(files = [one], mode = 'menu') {
  const slots = [], effects = [], opened = [], closed = [], listeners = new Map();
  let cursor = 0, dirty = false, output, clock = 0, stateWrites = 0, probes = 0;
  class TestNode {}
  const attributes = new Map();
  const triggerNode = Object.assign(new TestNode(), { isConnected: true, hovered: true,
    matches: selector => selector === ':hover' && triggerNode.hovered,
    contains: target => target === triggerNode,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name) });
  const effect = (callback, deps) => {
    const index = cursor++, prior = slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
      slots[index] = { deps, cleanup: prior?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    }
  };
  const memo = (callback, deps) => {
    const index = cursor++, prior = slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[index] = { deps, value: callback() };
    return slots[index].value;
  };
  const hooks = { ...React,
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; stateWrites++; }
      }];
    },
    useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect,
    useCallback: (callback, deps) => memo(() => callback, deps), useMemo: memo,
  };
  const FileTree = () => null;
  const modules = {
    react: hooks,
    'react-dom': { createPortal: children => React.createElement('test-portal', null, children) },
    'lucide-react': { FileText: 'file-icon' },
    '../../store/useWorkspaceStore': { useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) } },
    '../../store/useUIStore': { useUIStore: selector => selector({ filePreview: null, lastLinkedFileByOwner: {} }) },
    '../../utils/tabLinkedFiles.mjs': linked,
    '../../utils/chipHoverIntent.mjs': hoverIntent,
    '../../utils/missingFileTracker': { isFileMissing: () => false, probeFiles: async () => { probes++; }, subscribeMissingFiles: () => () => {} },
    '../../utils/tabLinkedFilePreview': { closeTabLinkedFile: id => closed.push(id) },
    './TabLinkedFileTree': { default: FileTree, __esModule: true },
    '../../utils/tabCardVisual.mjs': { TAB_CARD_LINE_HEIGHT: 1.2 },
    '../../hooks/useWorkspaceOverlayTarget': { useWorkspaceOverlayTarget: () => ({}) },
    './TabLinkedFiles.css': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, Node: TestNode, performance: { now: () => clock },
    require: name => { assert.ok(name in modules, name); return modules[name]; },
    window: { addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); } },
  });
  const props = { ownerTabId: 'owner', files, mode, fontSize: 14,
    geometry: { paddingX: 2, paddingY: 1, borderRadius: 4 }, onOpen: item => opened.push(item) };
  const render = () => {
    let pass = 0;
    do {
      assert.ok(pass++ < 10, 'render settles'); dirty = false; cursor = 0;
      output = module.exports.default(props);
      const chip = by('data-tab-linked-files')[0];
      triggerNode.isConnected = !!chip;
      if (chip) chip.props.ref.current = triggerNode;
      while (effects.length) effects.shift()();
    } while (dirty);
  };
  const find = predicate => {
    const visit = node => {
      if (Array.isArray(node)) return node.flatMap(visit);
      if (!node || typeof node !== 'object') return [];
      return [...(predicate(node) ? [node] : []), ...visit(node.props?.children)];
    };
    return visit(output);
  };
  const by = key => find(node => key in (node.props || {}));
  const event = (key, handler, values = {}) => {
    const target = by(key)[0]; assert.ok(target, key);
    target.props[handler]({ stopPropagation() {}, preventDefault() {}, relatedTarget: null,
      target: triggerNode, currentTarget: triggerNode, ...values }); render();
  };
  render();
  const advance = ms => { clock += ms; };
  const animationEnd = (values = {}) => event('data-tab-linked-files', 'onAnimationEnd', { animationName: 'tab-linked-file-hover-intent', ...values });
  const settleHover = () => { advance(hoverIntent.CHIP_HOVER_MS); animationEnd(); };
  const dispose = () => { triggerNode.isConnected = false; for (const slot of slots) slot?.cleanup?.(); };
  return { props, render, event, by, find, FileTree, opened, closed, listeners, advance, animationEnd, settleHover, dispose,
    attributes, triggerNode, stateWrites: () => stateWrites, probes: () => probes };
}

test('one file has its hover menu and direct click still selects that exact file', () => {
  const f = fixture();
  f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.settleHover();
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  assert.deepEqual(f.find(node => node.type === f.FileTree)[0].props.files, [one]);
  assert.equal(f.by('data-linked-file-more').length, 0);
  f.event('data-linked-file-open', 'onClick');
  assert.deepEqual(f.opened, [one]);
  assert.equal(f.by('data-tab-linked-files')[0].props['aria-haspopup'], 'menu');
});

test('the last remaining file keeps the open menu; removing the last link removes it', () => {
  const f = fixture([one, two]);
  f.event('data-tab-linked-files', 'onMouseEnter');
  f.settleHover();
  f.props.files = [one]; f.render();
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  assert.deepEqual(f.find(node => node.type === f.FileTree)[0].props.files, [one]);
  f.props.files = []; f.render();
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  assert.equal(f.by('data-tab-linked-files').length, 0);
});

test('single-file chip middle click closes the reader and suppresses hover until reentry', () => {
  const f = fixture(); f.event('data-tab-linked-files', 'onMouseEnter'); f.settleHover();
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  f.event('data-tab-linked-files', 'onAuxClick', { button: 1 });
  assert.deepEqual(f.closed, ['owner']);
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.event('data-tab-linked-files', 'onMouseLeave');
  f.event('data-tab-linked-files', 'onMouseEnter');
  f.settleHover();
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
});

test('quick crossing cancels dwell; scale starts immediately without mounting, probes or per-frame React writes', () => {
  const f = fixture(), probes = f.probes();
  f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.attributes.get('data-linked-files-opening'), '1');
  const writes = f.stateWrites(); f.advance(40);
  assert.equal(f.stateWrites(), writes); assert.equal(f.probes(), probes);
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.event('data-tab-linked-files', 'onMouseLeave'); f.advance(100); f.animationEnd();
  assert.equal(f.by('data-tab-linked-files-popup').length, 0); assert.equal(f.attributes.size, 0);
  assert.equal(f.listeners.size, 0); assert.equal(f.probes(), probes);
});

test('reentry starts a full new dwell and ignores a late old end or a child animation', () => {
  const f = fixture();
  f.event('data-tab-linked-files', 'onMouseEnter'); f.advance(80);
  f.event('data-tab-linked-files', 'onMouseLeave');
  f.event('data-tab-linked-files', 'onMouseEnter'); f.advance(20); f.animationEnd();
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.advance(80); f.animationEnd({ target: {} });
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.animationEnd({ animationName: 'other' }); assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.animationEnd(); assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  assert.equal(f.attributes.size, 0);
});

test('pending hover is cancelled by blur, Escape, pointer action, owner replacement, empty files and unmount', () => {
  for (const cancel of ['blur','Escape','pointerdown','owner','empty','unmount']) {
    const f = fixture(); f.event('data-tab-linked-files', 'onMouseEnter');
    if (cancel==='Escape') f.listeners.get('keydown')({ key:'Escape' });
    else if (cancel==='owner') f.props.ownerTabId='new-owner';
    else if (cancel==='empty') f.props.files=[];
    else if (cancel==='unmount') f.dispose();
    else f.listeners.get(cancel)({});
    f.render(); f.advance(100);
    if (f.by('data-tab-linked-files').length) f.animationEnd();
    assert.equal(f.by('data-tab-linked-files-popup').length,0,cancel);
    assert.equal(f.attributes.size,0,cancel); assert.equal(f.listeners.size,0,cancel);
    f.dispose();
  }
});

test('clicking a file or pin is immediate and retires pending hover work', () => {
  const direct = fixture(); direct.event('data-tab-linked-files','onMouseEnter');
  direct.event('data-linked-file-open','onClick'); assert.deepEqual(direct.opened,[one]);
  direct.settleHover(); assert.equal(direct.by('data-tab-linked-files-popup').length,0);
  const pin=fixture([one,two]); pin.event('data-tab-linked-files','onMouseEnter');
  pin.event('data-linked-file-more','onClick'); assert.equal(pin.by('data-tab-linked-files-popup').length,1);
  assert.equal(pin.by('data-tab-linked-files-popup')[0].props['data-pinned'],'1');
  pin.event('data-tab-linked-files','onMouseLeave'); assert.equal(pin.by('data-tab-linked-files-popup').length,1);
});

test('animation completion checks actual hover even when no leave callback was delivered', () => {
  const f=fixture(); f.event('data-tab-linked-files','onMouseEnter');
  f.triggerNode.hovered=false; f.settleHover();
  assert.equal(f.by('data-tab-linked-files-popup').length,0);
  assert.equal(f.attributes.size,0); assert.equal(f.listeners.size,0);
});

test('dwell uses the shorter shared60ms/1.04 token; group badge has the same finite scale and actual hit box', () => {
  const css=fs.readFileSync(new URL('./TabLinkedFiles.css',import.meta.url),'utf8');
  const group=fs.readFileSync(new URL('./PaneStripCollapsedGroup.css',import.meta.url),'utf8');
  assert.equal(hoverIntent.CHIP_HOVER_MS,60);assert.equal(hoverIntent.CHIP_HOVER_SCALE,1.04);
  assert.match(css,/animation: tab-linked-file-hover-intent var\(--noted-chip-hover-ms\) linear/);
  const keyframes=css.match(/@keyframes tab-linked-file-hover-intent \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(keyframes); assert.match(keyframes,/from \{ transform: scale\(1\); \}/);
  assert.match(keyframes,/to \{ transform: scale\(var\(--noted-chip-hover-scale\)\); \}/);
  assert.match(group,/transform-origin:center/);assert.match(group,/scale\(var\(--noted-chip-hover-scale\)\)/);
  assert.doesNotMatch(group,/::before|inset:0 0 -50% -50%|scale\(1\.5\)/);
  assert.doesNotMatch(keyframes,/width|height|padding|margin|infinite/);
  assert.doesNotMatch(source,/setTimeout|setInterval|requestAnimationFrame/);
  assert.doesNotMatch(css,/will-change/);
});

test('hidden-window navigate mode keeps click-only navigation for one or many files', () => {
  for (const files of [[one], [one, two]]) {
    const f = fixture(files, 'navigate'), probes=f.probes(); f.event('data-tab-linked-files', 'onMouseEnter');
    assert.equal(f.by('data-tab-linked-files-popup').length, 0);
    assert.equal(f.probes(),probes+1); assert.equal(f.listeners.size,0);
    assert.equal(f.by('data-tab-linked-files')[0].props['aria-haspopup'], undefined);
    f.event('data-linked-file-open', 'onClick');
    assert.deepEqual(f.opened, [one]);
  }
});
