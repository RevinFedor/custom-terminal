import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// AskUserQuestion: the purple running ring existed around the workflow chip in
// the top strip (App awaitingTabs -> SpaceStrip -> WorkflowActivityBadges) and in
// the legacy list row (TabBar TabItem), which is no longer mounted once
// organizationReady. Every live tab surface - sidebar row, window chip, Run After
// and hidden-window pickers - is the shared TabCard, and TabCard never read the
// event, so the tab itself stayed plain while its workflow was lit.
//
// This runs the REAL TabCard.tsx and the REAL claudeAwaitingInput.ts through
// esbuild and renders them to markup. Only the stores and the IPC-bound hooks
// around them are controlled ports; pure helpers (tabChrome, tabCardVisual, ...)
// stay real. NOTED_TAB_CARD_SOURCE points the same test at another TabCard.tsx
// (for example the one from before the fix) without copying it into the tree.

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', '..');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const cardPath = process.env.NOTED_TAB_CARD_SOURCE || path.join(here, 'TabCard.tsx');
const storePath = path.join(rendererDir, 'utils', 'claudeAwaitingInput.ts');
const quiet = { log() {}, warn() {}, error() {} };

const nothing = 'const none = () => null;';
const PORTS = {
  '../../store/useWorkspaceStore': 'exports.useWorkspaceStore = (select) => select(__ports.workspace);',
  '../../store/useUIStore': 'exports.useUIStore = (select) => select(__ports.ui);',
  '../../utils/sessionAvailabilityTracker':
    "exports.resolveTabSessionDescriptor = () => ({}); exports.useSessionAvailability = () => ({ state: 'none' });",
  '../../utils/tabWorkContext': 'exports.useTabWorkContext = () => ({ pendingCount: 0 });',
  '../../utils/codexNativeQuestions': 'exports.useCodexNativeQuestion = () => null;',
  '../../utils/tabCardTitleMetrics': 'exports.useLinkedTitleLayout = () => null;',
  './TabLinkedFiles': `${nothing} exports.default = none; exports.useTabLinkedFiles = () => [];`,
  './TabSignals': `${nothing}
    for (const name of ['TabProcessBar', 'TabStatusMarker', 'TabStatusMarkerButton', 'TabTopLeftSignals',
      'TabContextUpdateBadge', 'TabCompletionNotificationBadge', 'TabCompletionNotificationAlert',
      'TabSessionAvailabilityMarker']) exports[name] = none;
    exports.useTabActivitySignals = () => ({ hasProcess: false, busy: false, inheritedBusy: false });
    exports.useTabContextUsage = () => null;
    exports.TAB_CONTEXT_UPDATE_INSET_PX = 14; exports.TAB_PROCESS_BAR_W_PX = 3;
    exports.tabFastBadgeOutsidePx = () => 3;`,
};

const define = { 'import.meta.hot': 'undefined' };
const external = ['react', 'lucide-react'];
const cardBundle = (await build({
  stdin: { contents: fs.readFileSync(cardPath, 'utf8'), resolveDir: here, sourcefile: 'TabCard.tsx', loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external, define,
  plugins: [{
    name: 'tab-card-ports',
    setup(b) {
      // Only TabCard's own sibling imports are replaced; nested modules resolve normally.
      b.onResolve({ filter: /.*/ }, (a) => (a.resolveDir === here && Object.hasOwn(PORTS, a.path)
        ? { path: a.path, namespace: 'port' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'port' }, (a) => ({ contents: PORTS[a.path], loader: 'js' }));
    },
  }],
})).outputFiles[0].text;
const storeBundle = (await build({
  entryPoints: [storePath], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external, define,
})).outputFiles[0].text;

function fakeIpc() {
  const channels = new Map();
  return {
    on(channel, fn) { if (!channels.has(channel)) channels.set(channel, new Set()); channels.get(channel).add(fn); },
    removeListener(channel, fn) { channels.get(channel)?.delete(fn); },
    invoke: async () => ({ success: true }),
    emit(channel, payload) { for (const fn of [...(channels.get(channel) || [])]) fn({}, payload); },
    count: (channel) => channels.get(channel)?.size || 0,
  };
}

function load(code, ipc, ports = {}, overrides = {}) {
  const exports = {};
  const module = { exports };
  vm.runInNewContext(code, {
    module, exports, console: quiet, __ports: ports,
    require: (name) => (Object.hasOwn(overrides, name) ? overrides[name] : require(name)),
    window: { require: (name) => {
      if (name !== 'electron') throw new Error('unexpected window.require(' + name + ')');
      return { ipcRenderer: ipc };
    } },
  });
  return module.exports;
}

// A fresh renderer per test: new module instances, so no awaiting flag leaks over.
function mountCard() {
  const ipc = fakeIpc();
  const tab = (name) => ({ name, color: 'default', tabType: 'terminal', commandType: 'claude',
    cwd: '/work', claudeSessionId: 'session-' + name });
  const ports = {
    workspace: {
      openProjects: new Map([['P', { tabs: new Map([['A', tab('A')], ['B', tab('B')]]) }]]),
      globalGroups: { tabGroups: {}, groups: [] },
    },
    ui: {
      filePreview: null, toasts: [], sessionStatuses: [], tabsFontSize: 14, processBar: { position: 'left' },
      tabGeometry: { paddingY: 3, paddingX: 6, paddingLeft: 16, borderRadius: 6, gap: 4 },
    },
  };
  const Card = load(cardBundle, ipc, ports).default;
  const render = (tabId) => {
    const html = renderToStaticMarkup(React.createElement(Card, { projectId: 'P', tabId }));
    // Proves a real card was drawn, so "no ring" below cannot be an empty render.
    assert.match(html, new RegExp('data-tab-card="' + tabId + '"'));
    return html;
  };
  const rings = (tabId) => (render(tabId).match(/data-tab-awaiting-ring/g) || []).length;
  return { ipc, render, rings };
}

test('the tab Claude is asking in shows the purple ring on its own shared card, its neighbour stays plain', () => {
  const { ipc, rings } = mountCard();
  assert.equal(rings('A'), 0, 'no question yet');
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  assert.equal(rings('A'), 1, 'PreToolUse(AskUserQuestion) lights the tab itself');
  assert.equal(rings('B'), 0, 'another tab of the same project is not lit');
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: false });
  assert.equal(rings('A'), 0, 'PostToolUse puts the tab back');
});

test('a card mounted after the event still shows it: the event is a transition, the store remembers it', () => {
  const { ipc, rings } = mountCard();
  // First render of this card happens only now, as when a window chip or a
  // picker opens while the question is already on screen.
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  assert.equal(rings('A'), 1);
});

test('a turn end clears a lost PostToolUse (Esc), but another tab, a spinner frame or live work do not', () => {
  const { ipc, rings } = mountCard();
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  for (const kept of [
    { tabId: 'B', busy: false },
    { tabId: 'A', busy: true },
    { tabId: 'A', busy: false, reason: 'spinner' },
    { tabId: 'A', busy: false, activityBusy: true },
  ]) {
    ipc.emit('claude:busy-state', kept);
    assert.equal(rings('A'), 1, 'must stay lit on ' + JSON.stringify(kept));
  }
  ipc.emit('claude:busy-state', { tabId: 'A', busy: false });
  assert.equal(rings('A'), 0, 'Esc ends the turn without PostToolUse; busy:false still arrives');

  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  ipc.emit('claude:busy-state', { tabId: 'A', busy: true, activityBusy: false });
  assert.equal(rings('A'), 0, 'main aggregate says idle: same rule as the workflow chip and the legacy row');
});

test('the ring reuses the existing purple CSS owner, its hidden-window pause and its geometry contract', () => {
  const { ipc, render } = mountCard();
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  const ring = render('A').match(/<span[^>]*data-tab-awaiting-ring[^>]*>/)?.[0] || '';
  assert.match(ring, /class="tab-awaiting-input noted-infinite-animation"/);
  assert.match(ring, /aria-hidden="true"/);
  assert.match(ring, /position:absolute/);
  assert.match(ring, /inset:0/);
  assert.match(ring, /border-radius:inherit/, 'follows the configured card radius like the completion ring');
  assert.match(ring, /z-index:3/, 'below the process bar and corner signals, like the Codex question ring');

  const globals = fs.readFileSync(path.join(rendererDir, 'styles/globals.css'), 'utf8');
  assert.match(globals, /\.tab-awaiting-input \{[^}]*pointer-events: none;/);
  assert.match(globals, /\.tab-awaiting-input::before \{[^}]*rgba\(168, 85, 247/, 'the purple that already means a pending question');
  const pause = fs.readFileSync(path.join(rendererDir, 'styles/presentationAnimations.css'), 'utf8');
  assert.match(pause, /\.noted-infinite-animation,/);
  assert.match(pause, /\.tab-awaiting-input,/);
  assert.doesNotMatch(pause, /\[(?:style|class)\s*[*^$|~]?=/);
});

test('the hook hands React a subscription bound to its own tab: only that tab wakes, repeats stay silent', () => {
  const ipc = fakeIpc();
  // The real hook, with React reduced to the two calls it makes. What React
  // would receive - subscribe and getSnapshot - is exactly what is asserted.
  const fakeReact = { useCallback: (fn) => fn, useSyncExternalStore: (subscribe, getSnapshot) => ({ subscribe, getSnapshot }) };
  const store = load(storeBundle, ipc, {}, { react: fakeReact });
  const woke = { A: 0, B: 0 };
  const a = store.useTabAwaitingInput('A'), b = store.useTabAwaitingInput('B');
  const offA = a.subscribe(() => { woke.A += 1; }), offB = b.subscribe(() => { woke.B += 1; });
  assert.equal(a.getSnapshot(), false);
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  assert.deepEqual(woke, { A: 1, B: 0 }, 'one flip wakes one tab');
  assert.equal(a.getSnapshot(), true);
  assert.equal(b.getSnapshot(), false);
  assert.equal(typeof a.getSnapshot(), 'boolean', 'a primitive snapshot cannot tear or loop');
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: true });
  ipc.emit('claude:busy-state', { tabId: 'B', busy: false });
  assert.deepEqual(woke, { A: 1, B: 0 }, 'same value and a tab that was never awaiting wake nobody');
  offA();
  ipc.emit('claude:awaiting-input', { tabId: 'A', awaiting: false });
  assert.deepEqual(woke, { A: 1, B: 0 }, 'a detached subscriber is not called');
  assert.equal(a.getSnapshot(), false);
  offB();
  assert.equal(ipc.count('claude:awaiting-input'), 1, 'one renderer-wide listener, not one per card');
  assert.equal(ipc.count('claude:busy-state'), 1);
});

test('every live card surface gets the ring from TabCard; none keeps a copy of its markup', () => {
  const card = fs.readFileSync(cardPath, 'utf8');
  assert.match(card, /useTabAwaitingInput\(tabId\)/);
  assert.equal(card.match(/className="tab-awaiting-input noted-infinite-animation"/g)?.length, 1);
  for (const surface of ['WorkflowTabSidebar.tsx', 'PaneTabChip.tsx', 'HiddenWindowPicker.tsx',
    'RunAfterTabPicker.tsx', 'GlobalRunAfterControl.tsx']) {
    const source = fs.readFileSync(path.join(here, surface), 'utf8');
    assert.match(source, /<TabCard\b/, surface + ' draws its tab through the shared card');
    assert.doesNotMatch(source, /tab-awaiting-input|isAwaitingInput|awaitingMap/, surface + ' must not carry its own ring');
  }
});
