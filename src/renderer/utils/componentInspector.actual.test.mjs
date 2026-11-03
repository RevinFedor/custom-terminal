import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// Compiles the ACTUAL `componentInspector.ts` and drives it through a counting
// DOM. Only the browser participants are substituted: the inspector's own
// logic, listeners, rAF coalescing and clipboard payloads are the real ones.
// What this guards is the reason the inspector was rewritten — the upstream
// client recalculated style and layout for the whole document on every pointer
// move. So the counters here are the contract: zero getComputedStyle, one
// getBoundingClientRect per newly hovered element, one rAF per burst of moves.

const compiled = transformSync(
  readFileSync(new URL('componentInspector.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'node18' },
).code;

function harness() {
  const counts = { rect: 0, computedStyle: 0, raf: 0, querySelectorAll: 0 };
  const clipboard = [];
  const rafQueue = [];
  const timerQueue = [];
  const listeners = new Map();

  class Node {
    constructor(tag, attrs = {}, box = null, parent = null) {
      this.tagName = tag.toUpperCase();
      this.attrs = { ...attrs };
      this.box = box;
      this.parentNode = parent;
      this.children = [];
      this.style = makeStyle();
      this.textContent = '';
      this.ownerNode = this;
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() {
      const index = this.parentNode?.children.indexOf(this) ?? -1;
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
    hasAttribute(name) { return name in this.attrs; }
    closest(selector) {
      const attr = /^\[([^\]]+)\]$/.exec(selector)?.[1];
      let node = this;
      while (node) {
        if (attr && node.hasAttribute?.(attr)) return node;
        node = node.parentNode;
      }
      return null;
    }
    querySelectorAll(selector) {
      counts.querySelectorAll++;
      const attr = /^\[([^\]]+)\]$/.exec(selector)?.[1];
      const found = [];
      const walk = node => node.children.forEach(child => {
        if (attr && child.hasAttribute(attr)) found.push(child);
        walk(child);
      });
      walk(this);
      return found;
    }
    cloneNode() {
      const copy = new Node(this.tagName, this.attrs, this.box, null);
      copy.textContent = this.textContent;
      this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
      return copy;
    }
    get outerHTML() {
      const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
      const inner = this.textContent + this.children.map(child => child.outerHTML).join('');
      return `<${this.tagName.toLowerCase()}${attrs}>${inner}</${this.tagName.toLowerCase()}>`;
    }
    getBoundingClientRect() {
      counts.rect++;
      if (!this.box) throw new Error('unexpected layout read on an unframed node');
      const [left, top, width, height] = this.box;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
  }

  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      set(target, key, value) { target[key] = value; return true; },
      get(target, key) {
        if (key === 'cssText') return target.cssText || '';
        if (key === 'setProperty') return (name, value) => { target[name] = value; };
        return target[key];
      },
    });
  }

  const body = new Node('body');
  const htmlElementCtor = Node;
  const document = {
    body,
    createElement: tag => new Node(tag),
  };

  const window = {
    innerWidth: 1440,
    innerHeight: 900,
    document,
    HTMLElement: htmlElementCtor,
    navigator: { clipboard: { writeText: text => { clipboard.push({ via: 'navigator', text }); } } },
    getComputedStyle: () => { counts.computedStyle++; throw new Error('inspector must never read computed style'); },
    requestAnimationFrame: callback => { counts.raf++; rafQueue.push(callback); return rafQueue.length; },
    cancelAnimationFrame: id => { rafQueue[id - 1] = null; },
    // The copy-confirmation flash schedules its own removal.
    setTimeout: callback => { timerQueue.push(callback); return timerQueue.length; },
    clearTimeout: id => { timerQueue[id - 1] = null; },
    addEventListener: (type, handler, capture) => {
      const key = `${type}:${capture ? 'capture' : 'bubble'}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(handler);
    },
    removeEventListener: (type, handler, capture) => {
      const key = `${type}:${capture ? 'capture' : 'bubble'}`;
      const list = listeners.get(key) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    require: name => {
      if (name === 'electron') return { clipboard: { writeText: text => { clipboard.push({ via: 'electron', text }); } } };
      throw new Error('unexpected dependency ' + name);
    },
  };

  const module = { exports: {} };
  const factory = new Function('module', 'exports', 'require', 'window', 'document', 'navigator',
    'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement', 'console', compiled);
  factory(module, module.exports,
    specifier => {
      if (specifier.includes('componentInspectorModel')) {
        return requireModel();
      }
      throw new Error('unexpected import ' + specifier);
    },
    window, document, window.navigator,
    window.requestAnimationFrame, window.cancelAnimationFrame, htmlElementCtor,
    { warn: () => {}, error: () => {}, log: () => {} });

  const dispatch = (type, event, { capture = true } = {}) => {
    for (const handler of listeners.get(`${type}:${capture ? 'capture' : 'bubble'}`) || []) handler(event);
  };
  const flush = () => {
    const pending = rafQueue.splice(0, rafQueue.length);
    pending.forEach(callback => callback && callback());
  };
  const runTimers = () => {
    const pending = timerQueue.splice(0, timerQueue.length);
    pending.forEach(callback => callback && callback());
  };

  return { module, window, document, body, Node, counts, clipboard, dispatch, flush, runTimers, listeners, rafQueue };
}

let cachedModel = null;
function requireModel() {
  if (!cachedModel) {
    const code = transformSync(
      readFileSync(new URL('componentInspectorModel.mjs', import.meta.url), 'utf8'),
      { loader: 'js', format: 'cjs', target: 'node18' },
    ).code;
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    cachedModel = module.exports;
  }
  return cachedModel;
}

function scene(env) {
  const root = new env.Node('div', { 'data-insp-path': 'src/renderer/App.tsx:1:1:div' }, [0, 0, 1440, 900], env.body);
  env.body.appendChild(root);
  const a = new env.Node('button', { 'data-insp-path': 'src/renderer/components/A.tsx:10:3:button' }, [100, 100, 80, 30], root);
  root.appendChild(a);
  const aLabel = new env.Node('span', {}, null, a); // unstamped child: resolves to A
  aLabel.textContent = 'A';
  a.appendChild(aLabel);
  const b = new env.Node('div', { 'data-insp-path': 'src/renderer/components/B.tsx:20:5:div' }, [300, 160, 50, 20], root);
  root.appendChild(b);
  return { root, a, aLabel, b };
}

const alt = { altKey: true, shiftKey: true };
const move = (path, extra = {}) => ({ ...alt, ...extra, clientX: 0, clientY: 0, composedPath: () => path });
const key = (code, extra = {}) => ({
  ...alt, ...extra, code,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
});
const clickOn = path => ({
  ...alt, composedPath: () => path,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
});

test('install is idempotent and uninstall drops every listener and the overlay', () => {
  const env = harness();
  const first = env.module.exports.installComponentInspector();
  const countAll = () => [...env.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  const installed = countAll();
  assert.ok(installed >= 10);
  const second = env.module.exports.installComponentInspector();
  assert.equal(countAll(), installed, 'a second install must not double listeners');
  second();
  assert.equal(countAll(), installed, 'the no-op uninstall must not remove the real one');
  assert.equal(env.body.children.some(node => node.id === 'noted-component-inspector'), true);
  first();
  assert.equal(countAll(), 0);
  assert.equal(env.body.children.some(node => node.id === 'noted-component-inspector'), false);
});

test('hovering reads layout once per newly hovered element and never computed style', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  env.counts.rect = 0;

  env.dispatch('keydown', key('AltLeft'));
  // A burst of moves inside one element coalesces into a single frame…
  for (let i = 0; i < 25; i++) env.dispatch('pointermove', move([nodes.aLabel, nodes.a, nodes.root]));
  assert.equal(env.counts.raf, 1, 'moves must be coalesced into one animation frame');
  env.flush();
  assert.equal(env.counts.rect, 1, 'one rect for the newly framed element');

  // …and further moves that stay on the same stamped element read nothing.
  for (let i = 0; i < 25; i++) env.dispatch('pointermove', move([nodes.aLabel, nodes.a, nodes.root]));
  env.flush();
  assert.equal(env.counts.rect, 1, 'an unchanged target must not re-read layout');

  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.flush();
  assert.equal(env.counts.rect, 2, 'exactly one rect for the next element');
  assert.equal(env.counts.computedStyle, 0);
  uninstall();
});

test('overlay frames the hovered element with fixed transforms and a source label', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  assert.match(overlay.style.cssText, /position:fixed/);
  assert.match(overlay.style.cssText, /pointer-events:none/);
  assert.ok(!/contain:/.test(overlay.style.cssText), 'containment would clip the fixed frame');
  assert.ok(!/will-change/.test(overlay.style.cssText), 'no permanent compositor layers');

  env.dispatch('keydown', key('ShiftLeft'));
  env.dispatch('pointermove', move([nodes.aLabel, nodes.a, nodes.root]));
  env.flush();
  const visible = overlay.children.filter(node => node.style.display === 'block');
  const frame = visible.find(node => node.style.width === '80px' && node.style.height === '30px');
  assert.ok(frame, 'frame matches the element box');
  assert.equal(frame.style.transform, 'translate3d(100px, 100px, 0)');
  const label = visible.find(node => typeof node.textContent === 'string'
    && node.textContent.includes('src/renderer/components/A.tsx:10:3'));
  assert.ok(label, 'label carries file:line:column');
  assert.match(label.textContent, /button · 80×30/);
  uninstall();
});

test('releasing the modifier, leaving focus or a foreign modifier clears the overlay', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  const anyVisible = () => overlay.children.some(node => node.style.display === 'block');

  const arm = () => {
    env.dispatch('keydown', key('AltLeft'));
    env.dispatch('pointermove', move([nodes.a, nodes.root]));
    env.flush();
    assert.equal(anyVisible(), true);
  };

  arm();
  env.dispatch('keyup', { altKey: false, shiftKey: true, code: 'AltLeft' });
  assert.equal(anyVisible(), false, 'releasing Option disarms');

  arm();
  env.dispatch('blur', {}, { capture: false });
  assert.equal(anyVisible(), false, 'window blur disarms');

  arm();
  // Cmd joining the chord belongs to the application, not the inspector.
  env.dispatch('pointermove', move([nodes.b, nodes.root], { metaKey: true }));
  assert.equal(anyVisible(), false);
  uninstall();
});

test('click copies the element reference and never reaches the application', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  env.dispatch('keydown', key('AltLeft'));
  env.dispatch('pointermove', move([nodes.aLabel, nodes.a, nodes.root]));
  env.flush();

  const press = clickOn([nodes.aLabel, nodes.a, nodes.root]);
  env.dispatch('mousedown', press);
  assert.equal(press.prevented, true, 'press must not start a drag or move focus');
  assert.equal(press.stopped, true);

  const click = clickOn([nodes.aLabel, nodes.a, nodes.root]);
  env.dispatch('click', click);
  assert.equal(click.prevented, true);
  assert.equal(env.clipboard.length, 1);
  assert.equal(env.clipboard[0].via, 'electron', 'Electron clipboard is preferred over navigator');
  const [payload] = env.clipboard;
  assert.match(payload.text, /^<button><span>A<\/span><\/button>\n\nin <button> at src\/renderer\/components\/A\.tsx:10:3$/);
  assert.ok(!payload.text.includes('data-insp-path'), 'the stamp is stripped from the snippet');
  uninstall();
});

test('clicks on unstamped chrome and inside the overlay are left alone', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  scene(env);
  const bare = new env.Node('div', {}, [0, 0, 10, 10], env.body);
  env.body.appendChild(bare);
  env.dispatch('keydown', key('AltLeft'));

  const onBare = clickOn([bare, env.body]);
  env.dispatch('click', onBare);
  assert.equal(onBare.prevented, undefined, 'an element with no stamp is not ours');
  assert.equal(env.clipboard.length, 0);

  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  const onOverlay = clickOn([overlay.children[0], overlay]);
  env.dispatch('click', onOverlay);
  assert.equal(onOverlay.prevented, undefined);
  assert.equal(env.clipboard.length, 0);
  uninstall();
});

test('M pins an anchor, the gap is drawn live and a click copies the measurement', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  env.dispatch('keydown', key('AltLeft'));
  env.dispatch('pointermove', move([nodes.a, nodes.root]));
  env.flush();

  const pin = key('KeyM');
  env.dispatch('keydown', pin);
  assert.equal(pin.prevented, true, 'M is consumed by the inspector while armed');

  env.counts.rect = 0;
  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.flush();
  assert.equal(env.counts.rect, 1, 'measuring reads only the new element');

  // A: [100,100,80,30] → right 180, bottom 130. B: [300,160,50,20].
  // gap x = 300-180 = 120, gap y = 160-130 = 30.
  const gapLabel = overlay.children.find(node => node.style.display === 'block'
    && typeof node.textContent === 'string' && node.textContent.startsWith('X '));
  assert.equal(gapLabel.textContent, 'X 120px · Y 30px');
  const lines = overlay.children.filter(node => node.style.display === 'block'
    && (node.style.width === '1px' || node.style.height === '1px'));
  assert.equal(lines.length, 2, 'one connector per axis with a real gap');
  assert.ok(lines.some(line => line.style.width === '120px' && line.style.height === '1px'));
  assert.ok(lines.some(line => line.style.height === '30px' && line.style.width === '1px'));

  const click = clickOn([nodes.b, nodes.root]);
  env.dispatch('click', click);
  assert.equal(env.clipboard.length, 1);
  const text = env.clipboard[0].text;
  assert.match(text, /A <button> at src\/renderer\/components\/A\.tsx:10:3 {2}80×30 @ \(100, 100\)/);
  assert.match(text, /B <div> at src\/renderer\/components\/B\.tsx:20:5 {2}50×20 @ \(300, 160\)/);
  assert.match(text, /gap x 120px · gap y 30px/);
  uninstall();
});

test('M is passed through when no element is framed, so typing keeps working', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  scene(env);
  env.dispatch('keydown', key('AltLeft'));
  // Armed, but the pointer is not over any stamped element: Option+Shift+M is a
  // printable character and must reach the composer.
  const typed = key('KeyM');
  env.dispatch('keydown', typed);
  assert.equal(typed.prevented, undefined);
  assert.equal(typed.stopped, undefined);
  uninstall();
});

test('Escape drops the anchor but keeps the inspector armed; re-pinning the same element toggles it off', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  const gapShown = () => overlay.children.some(node => node.style.display === 'block'
    && typeof node.textContent === 'string' && node.textContent.startsWith('X '));

  env.dispatch('keydown', key('AltLeft'));
  env.dispatch('pointermove', move([nodes.a, nodes.root]));
  env.flush();
  env.dispatch('keydown', key('KeyM'));
  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.flush();
  assert.equal(gapShown(), true);

  const escape = key('Escape');
  env.dispatch('keydown', escape);
  assert.equal(escape.prevented, true);
  assert.equal(gapShown(), false, 'Escape clears the measurement');
  // Still armed: the frame follows the pointer without a new key press.
  env.dispatch('pointermove', move([nodes.a, nodes.root]));
  env.flush();
  assert.equal(overlay.children.some(node => node.style.display === 'block'
    && node.style.width === '80px'), true);

  // Right click pins, and pinning the same element again releases it.
  const first = clickOn([nodes.a, nodes.root]);
  env.dispatch('contextmenu', first);
  assert.equal(first.prevented, true, 'the native context menu must not open');
  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.flush();
  assert.equal(gapShown(), true);
  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.dispatch('contextmenu', clickOn([nodes.b, nodes.root]));
  env.dispatch('contextmenu', clickOn([nodes.b, nodes.root]));
  assert.equal(gapShown(), false);
  uninstall();
});

test('scrolling re-reads only the framed elements', () => {
  const env = harness();
  const uninstall = env.module.exports.installComponentInspector();
  const nodes = scene(env);
  env.dispatch('keydown', key('AltLeft'));
  env.dispatch('pointermove', move([nodes.a, nodes.root]));
  env.flush();
  env.dispatch('keydown', key('KeyM'));
  env.dispatch('pointermove', move([nodes.b, nodes.root]));
  env.flush();

  env.counts.rect = 0;
  nodes.a.box = [100, 40, 80, 30];
  nodes.b.box = [300, 100, 50, 20];
  env.dispatch('scroll', {});
  assert.equal(env.counts.rect, 2, 'two framed elements, two reads — never the tree');
  const overlay = env.body.children.find(node => node.id === 'noted-component-inspector');
  const gapLabel = overlay.children.find(node => node.style.display === 'block'
    && typeof node.textContent === 'string' && node.textContent.startsWith('X '));
  assert.equal(gapLabel.textContent, 'X 120px · Y 30px');
  assert.equal(env.counts.computedStyle, 0);
  uninstall();
});

test('source holds no getComputedStyle, no tree query on the pointer path and no dev-only gate', () => {
  const source = readFileSync(new URL('componentInspector.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
  assert.ok(!/getComputedStyle/.test(code));
  assert.ok(!/import\.meta\.env/.test(code), 'the inspector must also work in a packaged build');
  assert.ok(!/process\.env\.NODE_ENV/.test(code));
  // The only document-wide query is the stamp strip on a detached clone.
  const queries = code.match(/document\.querySelector(All)?\(/g) || [];
  assert.equal(queries.length, 0);
  assert.equal((code.match(/cloneNode/g) || []).length, 1);
});
