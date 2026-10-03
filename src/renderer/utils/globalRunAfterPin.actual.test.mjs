import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pointInHoverCluster } from './hoverBridge.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/GlobalRunAfterControl.tsx', import.meta.url), 'utf8');
function body(pattern) {
  const matched = source.match(pattern)?.[1];
  assert.ok(matched, 'actual callback must exist');
  return matched.replaceAll('<HTMLElement>', '');
}
const recheck = body(/const recheckPreviewHover = useCallback\(\(point: \{ clientX: number; clientY: number \} \| null\) => \{([\s\S]*?)\n  \}, \[closePanel, editorGestureActive, editorState\?\.tabId, mode, pickingRewind\]\);/);
const close = body(/const closePanel = useCallback\(\(reason\?: 'outside'\) => \{([\s\S]*?)\n  \}, \[editorState\?\.tabId\]\);/);
const toggle = body(/const togglePinned = \(\) => \{([\s\S]*?)\n  \};/);
const resize = body(/const startResize = useCallback\(\(edge: 'right' \| 'bottom' \| 'corner', event: React\.PointerEvent<HTMLElement>\) => \{([\s\S]*?)\n  \}, \[panelSize, position, startResizeGesture\]\);/);
const relay = body(/const handleEditorGesture = useCallback\(\(active: boolean, point: \{ clientX: number; clientY: number \} \| null\) => \{([\s\S]*?)\n  \}, \[\]\);/);

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
function fixture() {
  class Element { blur() {} }
  const calls = [];
  let allowed = true;
  const base = rect(100, 200, 600, 420);
  const pages = { getBoundingClientRect: () => rect(105, 186, 330, 214) };
  const handle = { getBoundingClientRect: () => rect(597, 210, 605, 408) };
  const ctx = vm.createContext({ mode: 'preview', pickingRewind: false, editorGestureActive: false, editorState: null,
    HTMLElement: Element, CSS: { escape: (s) => s },
    beforeCloseRef: { current: () => { calls.push('save'); return allowed; } },
    resizeActiveRef: { current: false }, previewPointerRef: { current: null },
    editorGestureActiveRef: { current: false },
    panelRef: { current: { style: {}, contains: (el) => el?.inside === true,
      getBoundingClientRect() {
        const width = parseFloat(this.style.width) || base.width;
        const height = parseFloat(this.style.height) || base.height;
        return rect(base.left, base.top, base.left + width, base.top + height);
      }, querySelectorAll: () => [pages, handle] } },
    panelContentRef: { current: { style: {} } },
    triggerRef: { current: { getBoundingClientRect: () => rect(100, 165, 230, 191) } },
    document: { activeElement: null, querySelectorAll: () => [], querySelector: () => null },
    window: { innerWidth: 1000, innerHeight: 900 },
    panelSize: { width: 500, height: 300, heightFixed: false }, position: { left: 100, top: 200, width: 500, height: 300 },
    PANEL_MARGIN: 8, PANEL_MIN_W: 300, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    pointInHoverCluster, queueHoverSatelliteRects: () => [], startResizeGesture: (_e, options) => { ctx.gesture = options; },
    setPanelSize: (size) => { ctx.panelSize = size; calls.push('size'); },
    setEditorGestureActive: (active) => { ctx.editorGestureActive = active; calls.push('gesture:' + active); },
    setEditorState: (state) => { ctx.editorState = state; calls.push('editor'); },
    setMode: (mode) => { ctx.mode = mode; calls.push(mode); },
  });
  vm.runInContext(`function closePanel(reason) {${close}}; function recheckPreviewHover(point) {${recheck}}; function togglePinned() {${toggle}}; function startResize(edge, event) {${resize}}; function handleEditorGesture(active, point) {${relay}};`, ctx);
  ctx.recheckPreviewHoverRef = { current: (point) => ctx.recheckPreviewHover(point) };
  return { ctx, calls, Element, allowClose: (value) => { allowed = value; } };
}

test('only the header trigger can promote the global preview to pinned', () => {
  assert.equal((source.match(/setMode\('pinned'\)/g) || []).length, 1);
  assert.doesNotMatch(source, /pinParent/);
  assert.match(source, /onClick=\{togglePinned\}/);
  const panel = source.slice(source.indexOf('<div ref={panelRef} data-global-run-after-panel'), source.indexOf('<div data-global-run-after-pages'));
  assert.doesNotMatch(panel, /onPointerDownCapture|onMouseDownCapture|onClickCapture/);
  const floating = source.slice(source.indexOf('data-global-run-after-floating-editor={selectedTab.id}'), source.indexOf('export function GlobalRunAfterControl'));
  assert.doesNotMatch(floating, /onPointerDownCapture|onMouseDownCapture|onClickCapture/);
  assert.match(floating, /embeddedPinned=\{editorState\.mode === 'pinned'\}/);
});

test('internal page/control use remains preview; pointer leave closes through the save guard', () => {
  const { ctx, calls } = fixture();
  ctx.recheckPreviewHover({ clientX: 400, clientY: 300 });
  assert.equal(ctx.mode, 'preview');
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'hidden');
  assert.deepEqual(calls, ['save', 'editor', 'hidden']);
});

test('header pages and protruding resize handles are part of preview hover geometry', () => {
  const { ctx } = fixture();
  ctx.recheckPreviewHover({ clientX: 310, clientY: 188 });
  ctx.recheckPreviewHover({ clientX: 604, clientY: 300 });
  assert.equal(ctx.mode, 'preview');
});

test('header click pins; internal pointer leave cannot unpin; repeat header click closes', () => {
  const { ctx } = fixture();
  ctx.togglePinned();
  assert.equal(ctx.mode, 'pinned');
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'pinned');
  ctx.togglePinned();
  assert.equal(ctx.mode, 'hidden');
});

test('hover exit commits focused fields before the editor is unmounted', () => {
  const { ctx, calls, Element } = fixture();
  const field = new Element();
  field.inside = true;
  field.blur = () => calls.push('blur-field');
  ctx.document.activeElement = field;
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.deepEqual(calls, ['blur-field', 'save', 'editor', 'hidden']);
});

test('pending image ownership refuses close without turning preview into a pin', () => {
  const { ctx, allowClose } = fixture();
  allowClose(false);
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'preview');
  allowClose(true);
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'hidden');
});

test('resize holds the preview only for its captured gesture and releases without a permanent pin', () => {
  const { ctx, calls } = fixture();
  ctx.startResize('corner', { button: 0, clientX: 600, clientY: 420 });
  assert.equal(ctx.resizeActiveRef.current, true);
  assert.equal(ctx.mode, 'preview');
  ctx.gesture.onMove({ clientX: 1100, clientY: 1000 });
  ctx.recheckPreviewHover({ clientX: 1100, clientY: 1000 });
  assert.equal(ctx.mode, 'preview');
  assert.ok(!calls.includes('size'), 'pointermove must stay DOM-only');
  ctx.gesture.onEnd('up', { clientX: 1100, clientY: 1000 });
  assert.equal(ctx.resizeActiveRef.current, false);
  assert.equal(ctx.mode, 'hidden');
  assert.equal(calls.filter((c) => c === 'size').length, 1);
  assert.ok(!calls.includes('pinned'));
});

test('cancelling a resize preserves the old size and an explicitly pinned panel', () => {
  const { ctx, calls } = fixture();
  ctx.mode = 'pinned';
  ctx.startResize('right', { button: 0, clientX: 600, clientY: 300 });
  ctx.gesture.onMove({ clientX: 1000, clientY: 300 });
  ctx.gesture.onEnd('escape');
  assert.equal(ctx.mode, 'pinned');
  assert.equal(ctx.resizeActiveRef.current, false);
  assert.ok(!calls.includes('size'));
});

test('Rewind selection temporarily holds preview without pin and rechecks on release', () => {
  const { ctx } = fixture();
  ctx.pickingRewind = true;
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'preview');
  ctx.pickingRewind = false;
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'hidden');
  assert.match(source, /recheckPreviewHover\(previewPointerRef\.current\);/);
});

test('a child resize holds only its gesture, not a focus-based or permanent pin', () => {
  const { ctx } = fixture();
  ctx.editorGestureActive = true;
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'preview');
  ctx.editorGestureActive = false;
  ctx.recheckPreviewHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.mode, 'hidden');
});

test('captured gesture forwards its final point with only two React state commits', () => {
  const { ctx, calls } = fixture();
  ctx.handleEditorGesture(true, { clientX: 400, clientY: 300 });
  for (let i = 0; i < 60; i++) ctx.handleEditorGesture(true, { clientX: 800 + i, clientY: 700 });
  assert.equal(ctx.previewPointerRef.current.clientX, 859);
  ctx.handleEditorGesture(false, { clientX: 900, clientY: 700 });
  ctx.recheckPreviewHover(ctx.previewPointerRef.current);
  assert.equal(ctx.mode, 'hidden');
  assert.deepEqual(calls.filter(c => c.startsWith('gesture:')), ['gesture:true', 'gesture:false']);
});

test('leaving the application closes preview but never an explicit header pin', () => {
  const { ctx } = fixture();
  ctx.recheckPreviewHover(null);
  assert.equal(ctx.mode, 'hidden');
  ctx.togglePinned();
  ctx.recheckPreviewHover(null);
  assert.equal(ctx.mode, 'pinned');
});

test('window exit while a temporary hold is active closes when that hold ends', () => {
  const { ctx } = fixture();
  ctx.pickingRewind = true;
  ctx.recheckPreviewHover(null);
  assert.equal(ctx.mode, 'preview');
  ctx.pickingRewind = false;
  ctx.recheckPreviewHover(null);
  assert.equal(ctx.mode, 'hidden');
});

test('viewport backdrops are not part of hover geometry', () => {
  const recheckSource = source.slice(source.indexOf('const recheckPreviewHover'), source.indexOf('const recheckPreviewHoverRef'));
  assert.doesNotMatch(recheckSource, /data-run-after-picker-overlay/);
  assert.match(source, /element\.dataset\.runAfterHoverOwner === owner/);
});
