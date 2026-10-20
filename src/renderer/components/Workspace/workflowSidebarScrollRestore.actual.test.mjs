// Execute the actual restore effect and scroller handlers. Geometry, the native
// scrollTop setter and ResizeObserver delivery are controlled ports, not a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(process.env.NOTED_SIDEBAR_SCROLL_SOURCE
  || new URL('./WorkflowTabSidebar.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('WorkflowTabSidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(tree.parseDiagnostics.length, 0);
function findAll(predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(tree); return found;
}
const effects = findAll(node => ts.isCallExpression(node) && node.expression.getText(tree) === 'useLayoutEffect'
  && node.arguments[0]?.getText(tree).includes('scroller.scrollTop ='));
assert.equal(effects.length, 1, 'select the real sidebar scroll restoration effect');
const scrollers = findAll(node => ts.isJsxOpeningElement(node)
  && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'data-workflow-reserve-scroll'));
assert.equal(scrollers.length, 1);
function attribute(name) {
  const attr = scrollers[0].attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === name);
  assert.ok(attr, name); return attr.initializer;
}
const js = ts.transpileModule(`({restore: ${effects[0].arguments[0].getText(tree)},
  onWheel: ${attribute('onWheel').expression.getText(tree)},
  onPointerDown: ${attribute('onPointerDown').expression.getText(tree)},
  onScroll: ${attribute('onScroll').expression.getText(tree)}})`,
  {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;

function fixture({scrollHeight = 1000, clientHeight = 200, initialTop = 91, child = true, missing = false} = {}) {
  const geometry = {scrollHeight, clientHeight}, reads = {scrollHeight: 0, clientHeight: 0};
  const writes = [], changes = [], observers = [], userScroll = {current: true};
  let top = initialTop;
  const scroller = {
    firstElementChild: child ? {} : null,
    get scrollHeight() { reads.scrollHeight++; return geometry.scrollHeight; },
    get clientHeight() { reads.clientHeight++; return geometry.clientHeight; },
    get scrollTop() { return top; },
    set scrollTop(value) { writes.push(value); top = value; },
  };
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this); }
    observe(element) { this.observed.push(element); }
    disconnect() { this.disconnected = true; }
  }
  return {
    scroller, reads, writes, changes, observers, userScroll,
    mount({scrollTop, workflowId = 'workflow-A'} = {}) {
      const handlers = vm.runInNewContext(js, {dnd: {scrollerRef: {current: missing ? null : scroller}},
        userScroll, props: {scrollTop, onScrollOffsetChange: (...args) => changes.push(args)}, workflowId, ResizeObserver: Observer});
      return {...handlers, cleanup: handlers.restore()};
    },
    resize(height, viewportHeight) {
      geometry.scrollHeight = height; geometry.clientHeight = viewportHeight;
      for (const observer of observers) if (!observer.disconnected) observer.callback();
    },
  };
}

test('the optimized effect belongs to a normal vertical scroller and restores on workflow changes', () => {
  assert.equal(effects[0].arguments[1].getText(tree), '[workflowId]');
  assert.equal(attribute('className').text, 'workflow-reserve-scroll');
  const css = fs.readFileSync(new URL('./WorkflowTabSidebar.css', import.meta.url), 'utf8');
  const rule = css.match(/\.workflow-reserve-scroll\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule); assert.match(rule, /overflow:\s*auto/);
  assert.doesNotMatch(rule, /display:\s*flex|flex-direction|writing-mode/);
  assert.doesNotMatch(css, /column-reverse|writing-mode\s*:/);
});

test('zero and existing falsy defaults keep the setter and observer without either JS height getter', () => {
  for (const scrollTop of [0, -0, undefined, NaN]) for (const [scrollHeight, clientHeight] of [[0, 0], [100, 200], [200, 200], [1000, 200]]) {
    const f = fixture({scrollHeight, clientHeight}), view = f.mount({scrollTop});
    assert.deepEqual(f.writes, [0], 'restoring the top still assigns scrollTop');
    assert.deepEqual(f.reads, {scrollHeight: 0, clientHeight: 0});
    assert.equal(f.observers.length, 1); assert.deepEqual(f.observers[0].observed, [f.scroller.firstElementChild]);
    f.resize(1500, 200); f.resize(100, 200);
    assert.deepEqual(f.writes, [0, 0, 0], 'observer reapplication retains the original setter');
    assert.deepEqual(f.reads, {scrollHeight: 0, clientHeight: 0});
    view.onScroll({currentTarget: f.scroller}); assert.deepEqual(f.changes, [], 'restore is not user scroll');
    view.cleanup(); assert.equal(f.observers[0].disconnected, true);
    f.resize(2000, 200); assert.deepEqual(f.writes, [0, 0, 0]);
  }
});

test('positive restore keeps its clamp and retries as content grows and shrinks', () => {
  const f = fixture({scrollHeight: 200, clientHeight: 200}), view = f.mount({scrollTop: 640});
  f.resize(500, 200); f.resize(1000, 200); f.resize(400, 200); f.resize(1500, 300);
  assert.deepEqual(f.writes, [0, 300, 640, 200, 640]);
  assert.deepEqual(f.reads, {scrollHeight: 5, clientHeight: 5});
  view.onScroll({currentTarget: f.scroller}); assert.deepEqual(f.changes, []);
  view.cleanup(); f.resize(3000, 200); assert.equal(f.writes.length, 5);
});

test('nonzero fractional, out-of-range and negative inputs retain the original setter arguments', () => {
  for (const [scrollTop, expected] of [[12.75, 12.75], [900, 800], [-20, -20], [Infinity, 800], [-Infinity, -Infinity]]) {
    const f = fixture(), view = f.mount({scrollTop});
    assert.deepEqual(f.writes, [expected]); assert.deepEqual(f.reads, {scrollHeight: 1, clientHeight: 1});
    view.cleanup();
  }
});

test('actual wheel and pointer handlers preserve user ownership for zero and positive restores', () => {
  for (const handler of ['onWheel', 'onPointerDown']) for (const scrollTop of [0, 640]) {
    const f = fixture(), view = f.mount({scrollTop});
    assert.equal(f.userScroll.current, false);
    view[handler](); assert.equal(f.userScroll.current, true);
    f.scroller.scrollTop = 125; view.onScroll({currentTarget: f.scroller});
    assert.deepEqual(f.changes, [['workflow-A', 125]]);
    const beforeReads = {...f.reads}, beforeWrites = [...f.writes];
    f.resize(2000, 200);
    assert.deepEqual(f.reads, beforeReads); assert.deepEqual(f.writes, beforeWrites, 'resize must not override the user');
    view.cleanup();
  }
});

test('effect cleanup and the next workflow reset preserve the same shared scroller and user guard', () => {
  const f = fixture(), first = f.mount({scrollTop: 640});
  first.onWheel(); f.scroller.scrollTop = 90; first.onScroll({currentTarget: f.scroller}); first.cleanup();
  const beforeReads = {...f.reads}, second = f.mount({scrollTop: 0, workflowId: 'workflow-B'});
  assert.equal(f.userScroll.current, false); assert.equal(f.observers[0].disconnected, true);
  f.resize(1800, 200); assert.equal(f.scroller.scrollTop, 0); assert.deepEqual(f.reads, beforeReads);
  second.onScroll({currentTarget: f.scroller}); assert.deepEqual(f.changes, [['workflow-A', 90]]);
  second.onPointerDown(); f.scroller.scrollTop = 25; second.onScroll({currentTarget: f.scroller}); second.cleanup();
  assert.deepEqual(f.changes, [['workflow-A', 90], ['workflow-B', 25]]);
  const returned = f.mount({scrollTop: 640});
  assert.equal(f.scroller.scrollTop, 640); assert.equal(f.userScroll.current, false);
  returned.cleanup(); assert.ok(f.observers.every(observer => observer.disconnected));
});

test('a missing scroller still returns before changing ownership or creating an observer', () => {
  const f = fixture({missing: true}), view = f.mount({scrollTop: 0});
  assert.equal(view.cleanup, undefined); assert.equal(f.userScroll.current, true);
  assert.deepEqual(f.writes, []); assert.equal(f.observers.length, 0);
});

test('an empty scroller still applies and disconnects the observer without observing a missing child', () => {
  const f = fixture({child: false}), view = f.mount({scrollTop: 0});
  assert.deepEqual(f.writes, [0]); assert.equal(f.observers.length, 1); assert.deepEqual(f.observers[0].observed, []);
  view.cleanup(); assert.equal(f.observers[0].disconnected, true);
});
