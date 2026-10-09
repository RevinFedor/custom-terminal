import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transformSync } from 'esbuild';
import * as linked from '../../utils/tabLinkedFiles.mjs';

// Execute the actual TSX/event handlers. Hook scheduling, stores, portal,
// file tree and DOM are controlled: this does not prove browser hit-testing.
const source = fs.readFileSync(new URL('./TabLinkedFiles.tsx', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const file = id => ({ id, ownerTabId: 'owner', projectId: 'p', path: `/fixture/${id}.md`, name: `${id}.md` });
const one = file('one'), two = file('two');

function fixture(files = [one], mode = 'menu') {
  const slots = [], effects = [], opened = [], closed = [], listeners = new Map();
  let cursor = 0, dirty = false, output;
  const effect = (callback, deps) => {
    const index = cursor++, prior = slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
      slots[index] = { deps, cleanup: prior?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    }
  };
  const hooks = { ...React,
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect,
    useCallback: callback => callback, useMemo: callback => callback(),
  };
  const FileTree = () => null;
  const modules = {
    react: hooks,
    'react-dom': { createPortal: children => React.createElement('test-portal', null, children) },
    'lucide-react': { FileText: 'file-icon' },
    '../../store/useWorkspaceStore': { useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) } },
    '../../store/useUIStore': { useUIStore: selector => selector({ filePreview: null, lastLinkedFileByOwner: {} }) },
    '../../utils/tabLinkedFiles.mjs': linked,
    '../../utils/missingFileTracker': { isFileMissing: () => false, probeFiles: async () => {}, subscribeMissingFiles: () => () => {} },
    '../../utils/tabLinkedFilePreview': { closeTabLinkedFile: id => closed.push(id) },
    './TabLinkedFileTree': { default: FileTree, __esModule: true },
    '../../utils/tabCardVisual.mjs': { TAB_CARD_LINE_HEIGHT: 1.2 },
    '../../hooks/useWorkspaceOverlayTarget': { useWorkspaceOverlayTarget: () => ({}) },
    './TabLinkedFiles.css': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, Node: class {},
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
    target.props[handler]({ stopPropagation() {}, preventDefault() {}, relatedTarget: null, ...values }); render();
  };
  render();
  return { props, render, event, by, find, FileTree, opened, closed, listeners };
}

test('one file has its hover menu and direct click still selects that exact file', () => {
  const f = fixture();
  f.event('data-tab-linked-files', 'onMouseEnter');
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
  f.props.files = [one]; f.render();
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  assert.deepEqual(f.find(node => node.type === f.FileTree)[0].props.files, [one]);
  f.props.files = []; f.render();
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  assert.equal(f.by('data-tab-linked-files').length, 0);
});

test('single-file chip middle click closes the reader and suppresses hover until reentry', () => {
  const f = fixture(); f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
  f.event('data-tab-linked-files', 'onAuxClick', { button: 1 });
  assert.deepEqual(f.closed, ['owner']);
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.by('data-tab-linked-files-popup').length, 0);
  f.event('data-tab-linked-files', 'onMouseLeave');
  f.event('data-tab-linked-files', 'onMouseEnter');
  assert.equal(f.by('data-tab-linked-files-popup').length, 1);
});

test('hidden-window navigate mode keeps click-only navigation for one or many files', () => {
  for (const files of [[one], [one, two]]) {
    const f = fixture(files, 'navigate'); f.event('data-tab-linked-files', 'onMouseEnter');
    assert.equal(f.by('data-tab-linked-files-popup').length, 0);
    assert.equal(f.by('data-tab-linked-files')[0].props['aria-haspopup'], undefined);
    f.event('data-linked-file-open', 'onClick');
    assert.deepEqual(f.opened, [one]);
  }
});
