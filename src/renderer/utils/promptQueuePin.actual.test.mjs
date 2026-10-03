import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { pointInHoverCluster, pointInRect } from './hoverBridge.mjs';

const source = fs.readFileSync(new URL('../components/Workspace/PromptQueueOverlay.tsx', import.meta.url), 'utf8');
const bodies = {
  prepareQueueClose: source.match(/const prepareQueueClose = useCallback\(\(reason\?: 'outside'\) => \{([\s\S]*?)\n  \}, \[/)?.[1],
  closeQueueHoverPreview: source.match(/const closeQueueHoverPreview = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/)?.[1],
  recheckQueueHover: source.match(/const recheckQueueHover = useCallback\(\(point: \{ clientX: number; clientY: number \} \| null\) => \{([\s\S]*?)\n  \}, \[/)?.[1],
};
for (const [name, body] of Object.entries(bodies)) assert.ok(body, name + ' actual callback must exist');
const callbacks = transformSync(Object.entries(bodies).map(([name, body]) => `function ${name}(${name === 'prepareQueueClose' ? 'reason' : name === 'recheckQueueHover' ? 'point' : ''}) {${body}}`).join('\n'), { loader: 'ts' }).code;
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const surface = (bounds, owner = 'local-owner') => ({ dataset: { runAfterHoverOwner: owner }, getBoundingClientRect: () => bounds });
function fixture() {
  const calls = [], satellites = [];
  class Element { blur() { calls.push('blur'); } }
  const panel = { contains: el => el?.inside === true, querySelectorAll: () => [], getBoundingClientRect: () => rect(200, 140, 500, 360) };
  const ctx = vm.createContext({ queueHoverPreviewOpen: true, collapsed: true, editorOpen: true, editorPinned: true, editorFocusWithin: true,
    editorText: 'User text', rewindTargetRequestId: null, tabId: 'owner', HOVER_CLUSTER_SELECTOR: 'owned-menu', HOVER_CLUSTER_PAD: 2,
    RUN_AFTER_IMAGE_PENDING_MARKER: '[Image saving…]', HTMLElement: Element,
    dragIdRef: { current: null }, previewResizeActiveRef: { current: false }, editorLockTokenRef: { current: 'local-owner' },
    panelRef: { current: panel }, queueHoverPreviewPanelRef: { current: panel },
    queueCountButtonRef: { current: surface(rect(440, 100, 466, 126)) }, railRef: { current: surface(rect(400, 100, 500, 128)) },
    editorRef: { current: { contains: () => false } }, editorPreviewRef: { current: null },
    document: { activeElement: null, querySelectorAll: () => satellites }, pointInHoverCluster, pointInRect,
    commitEditor: () => calls.push('commit'), cancelQueuedRewindTarget: () => calls.push('cancel-rewind'),
    setQueueHoverPreviewOpen: value => { ctx.queueHoverPreviewOpen = value; calls.push('preview:' + value); },
    setOnTabTriggerOpenKeys: () => calls.push('retire-picker-request'), setMetaActionsMenu: () => calls.push('close-meta'),
    setChipContextMenu: () => calls.push('close-context'),
  });
  vm.runInContext(callbacks, ctx);
  return { ctx, calls, satellites, Element };
}

test('a focused or pinned item editor cannot pin the preview parent', () => {
  const { ctx, calls, Element } = fixture();
  const field = new Element(); field.inside = true; ctx.document.activeElement = field;
  ctx.recheckQueueHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.queueHoverPreviewOpen, false);
  assert.equal(ctx.collapsed, true);
  assert.deepEqual(calls.slice(0, 3), ['blur', 'commit', 'preview:false']);
});

test('count-to-panel gap and owned child editor remain part of hover geometry', () => {
  const { ctx, calls, satellites } = fixture();
  ctx.recheckQueueHover({ clientX: 450, clientY: 135 });
  satellites.push(surface(rect(20, 160, 190, 320)));
  ctx.recheckQueueHover({ clientX: 100, clientY: 200 });
  ctx.recheckQueueHover({ clientX: 195, clientY: 200 });
  assert.equal(ctx.queueHoverPreviewOpen, true); assert.deepEqual(calls, []);
});

test('neighbouring rail buttons are excluded even if a wide bridge crosses them', () => {
  const { ctx } = fixture();
  ctx.recheckQueueHover({ clientX: 480, clientY: 115 });
  assert.equal(ctx.queueHoverPreviewOpen, false);
});

test('a foreign queue satellite cannot hold this preview open', () => {
  const { ctx, satellites } = fixture();
  satellites.push(surface(rect(700, 500, 950, 800), 'other-instance'));
  ctx.recheckQueueHover({ clientX: 800, clientY: 600 });
  assert.equal(ctx.queueHoverPreviewOpen, false);
});

test('pending image guard preserves the draft, not an implicit pin', () => {
  const { ctx, calls } = fixture();
  ctx.editorText = '[Image saving…]';
  ctx.recheckQueueHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.queueHoverPreviewOpen, true); assert.equal(ctx.collapsed, true); assert.deepEqual(calls, []);
  ctx.editorText = '[Image #1]';
  ctx.recheckQueueHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.queueHoverPreviewOpen, false); assert.equal(ctx.collapsed, true);
});

test('Rewind selection and captured resize hold temporarily, then resume immediate close', () => {
  const { ctx } = fixture();
  ctx.rewindTargetRequestId = 'selection'; ctx.recheckQueueHover(null);
  assert.equal(ctx.queueHoverPreviewOpen, true);
  ctx.rewindTargetRequestId = null; ctx.previewResizeActiveRef.current = true; ctx.recheckQueueHover(null);
  assert.equal(ctx.queueHoverPreviewOpen, true);
  ctx.previewResizeActiveRef.current = false; ctx.recheckQueueHover(null);
  assert.equal(ctx.queueHoverPreviewOpen, false);
});

test('native drag holds only until release, without changing persistent collapsed state', () => {
  const { ctx } = fixture();
  ctx.dragIdRef.current = 'card'; ctx.recheckQueueHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.queueHoverPreviewOpen, true);
  ctx.dragIdRef.current = null; ctx.recheckQueueHover({ clientX: 900, clientY: 700 });
  assert.equal(ctx.queueHoverPreviewOpen, false); assert.equal(ctx.collapsed, true);
});

test('only the count handler expands the local queue, without delayed animation state', () => {
  assert.equal((source.match(/expandPanel\(\)/g) || []).length, 1);
  assert.doesNotMatch(source, /pinPanelForInteraction|panelClosing|panelOpening|PANEL_SLIDE_MS/);
  const panel = source.slice(source.indexOf('data-prompt-queue-panel-mode'), source.indexOf('data-prompt-queue-edge-controls'));
  assert.doesNotMatch(panel, /onPointerDownCapture|onMouseDownCapture|onClickCapture/);
});
