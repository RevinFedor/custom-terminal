const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = require('node:path').resolve(__dirname, '../../../..');
const sharedBundle = esbuild.buildSync({ stdin: { contents: `export { ComposerChip, ConversationMessage } from '@noted/claude-blocks'; export { HistoryTranscriptPresentation } from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' }, loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' });
const shared = { exports: {} };
new Function('require', 'module', 'exports', sharedBundle.outputFiles[0].text)(require, shared, shared.exports);

const source = fs.readFileSync(require('node:path').join(__dirname, 'MiniOrchestratorControl.tsx'), 'utf8');
const code = esbuild.transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const moduleStub = { exports: {} };
vm.runInNewContext(code, { module: moduleStub, exports: moduleStub.exports, document: { body: { ownPortalTarget: true } }, window: { require: () => ({ ipcRenderer: {} }) }, require: (name) => {
  if (name === 'react') return require('react');
  if (name === 'react-dom') return { createPortal: (node, target) => ({ node, target }) };
  if (name === 'lucide-react') return require('lucide-react');
  if (name === '../../constants/geminiModels') return { GEMINI_MODEL_OPTIONS: [{ value: 'gemini-3.8-flash', label: 'Flash 3.8' }], legacyGeminiModelLabel: () => null };
  if (name === '../../store/useUIStore') return { useUIStore: () => undefined };
  if (name === '../../hooks/usePointerGesture') return {};
  if (name === './AIConversation/PastedContentPreview') return { default: () => null };
  if (name === '../../utils/tabMessageSourceJump') return { jumpToTerminalMessageTarget: () => Promise.resolve(true) };
  if (name === '../../utils/miniOrchestratorGeometry.mjs') return require('../../utils/miniOrchestratorGeometry.mjs');
  if (name === '../../utils/historyResponseTiming.mjs') return require('../../utils/historyResponseTiming.mjs');
  if (name.endsWith('.css')) return {};
  if (name === '../../utils/paneLayerPresentation.mjs') return { PANE_LAYER_PRESENTATION_EVENT: 'noted:pane-layer-presentation' };
  if (name === './HistoryTranscriptPresentation' || name === '@noted/claude-blocks') return shared.exports;
  throw new Error(name);
} });
const { miniEntriesToSteps, miniEntriesByRound, MiniReviewInput, MiniReviewInputContent, miniPopupLayout, MiniOrchestratorToggle, miniStatusPresentation, miniPhaseLabel, MiniOrchestratorStatus, MiniModelControls } = moduleStub.exports;

test('source pair and internal notices are not reviewer messages', () => {
  const steps = miniEntriesToSteps([{ id: '1', type: 'request', text: 'question' }, { id: '2', type: 'answer', text: 'answer' }, { id: '3', type: 'notice', text: 'internal' }]);
  assert.equal(steps.length, 0);
});

test('entries split by round keep every completed review visible instead of only the latest', () => {
  const entries = [
    { id: 'i1', type: 'instruction', text: 'rules', round: 1 }, { id: 'q1', type: 'request', text: 'first', round: 1 },
    { id: 'a1', type: 'answer', text: 'first answer', round: 1 }, { id: 'r1', type: 'review', text: 'first review', round: 1 },
    { id: 'i2', type: 'instruction', text: 'rules', round: 2 }, { id: 'q2', type: 'request', text: 'second', round: 2 },
    { id: 'a2', type: 'answer', text: 'second answer', round: 2 }, { id: 'r2', type: 'review', text: 'second review', round: 2 },
  ];
  const rounds = miniEntriesByRound(entries);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].round, 1); assert.equal(rounds[1].round, 2);
  assert.equal(rounds[0].entries.find(e => e.type === 'review').text, 'first review');
  assert.equal(rounds[1].entries.find(e => e.type === 'review').text, 'second review');
  const legacy = miniEntriesByRound([{ id: 'x', type: 'answer', text: 'no round field' }]);
  assert.equal(legacy.length, 1); assert.equal(legacy[0].round, undefined);
});

test('Worked footer uses the completed request pair, not current picker state', () => {
  const steps = miniEntriesToSteps([{ id: 'i', type: 'instruction', text: 'rules', name: 'Instruction', promptRevision: 'a'.repeat(80) },
    { id: 'r', type: 'review', text: '**Done**', reviewMeta: { model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', durationMs: 65000, finishedAt: 1793354902040 } }]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, '**Done**');
  assert.equal(steps[0].footerText, 'Worked · 01:05 / gemini-3.8-flash / high');
});

test('actual shared bubble and chips show only compact labels; previews isolate captured data', () => {
  const entries = [{ id: 'i', type: 'instruction', text: 'FULL INSTRUCTION', name: 'role', filePath: '/private/full/path', promptRevision: 'revision:abcdef123' },
    { id: 'q1', type: 'request', text: 'ORIGINAL REQUEST ONE' }, { id: 'q2', type: 'request', text: 'ORIGINAL REQUEST TWO' },
    { id: 'a', type: 'answer', text: 'ORIGINAL **ANSWER**' }, { id: 'n', type: 'notice', text: 'INTERNAL NOTICE' }];
  const sourceRef = { provider: 'codex', sessionId: 'session-exact', turnId: 'turn-exact', jobId: 'job-exact', requestIds: ['q1', 'q2'] };
  const render = () => renderToStaticMarkup(React.createElement(MiniReviewInputContent, { entries, source: sourceRef, onInstruction() {}, onIteration() {} }));
  const closed = render();
  assert.equal((closed.match(/data-message-layout="user"/g) || []).length, 1);
  assert.equal((closed.match(/data-composer-chip-kind=/g) || []).length, 2);
  assert.match(closed, /cb-user-bubble/); assert.match(closed, />Инструкция</); assert.match(closed, />Итерация</);
  const visible = closed.replace(/ title="[^"]*"/g, '');
  assert.doesNotMatch(visible, /\/private\/full\/path|FULL INSTRUCTION|ORIGINAL REQUEST|ORIGINAL ANSWER|INTERNAL NOTICE/);
  assert.match(closed, /\/private\/full\/path/, 'full path is available only in tooltip');
  assert.equal(render(), closed, 'click actions never add inline payload or alter bubble markup');
  const actions = [];
  const bubble = MiniReviewInputContent({ entries, source: sourceRef, onInstruction: () => actions.push('instruction'), onIteration: () => actions.push('iteration') });
  const chips = bubble.props.children.props.children;
  chips[0].props.onClick(); chips[1].props.onClick();
  assert.deepEqual(actions, ['instruction', 'iteration']);
  assert.equal(render(), closed, 'both clicks leave bubble markup unchanged');
  assert.match(source, /createPortal\(<div data-mini-instruction-preview/);
  assert.doesNotMatch(source, /data-mini-review-iteration|data-mini-review-instruction/);
});

test('archive label applies only to completed archived presentation', () => {
  assert.equal(miniPhaseLabel({ phase: 'complete', reviewSource: { archived: true } }), 'Готово · архив');
  assert.equal(miniPhaseLabel({ phase: 'complete', reviewSource: {} }), 'Готово');
  assert.equal(miniPhaseLabel({ phase: 'reviewing', reviewSource: { archived: true } }), 'Проверяет');
  assert.equal(miniPhaseLabel(null), 'Inactive');
});

test('instruction portal permits its own interaction and closes only its child preview', () => {
  const events = [], entries = [{ id: 'i', type: 'instruction', text: 'actual frozen instruction' },
    { id: 'q', type: 'request', text: 'question' }, { id: 'a', type: 'answer', text: 'answer' }];
  const tree = MiniReviewInput({ entries, tabId: 'own', source: { provider: 'codex', sessionId: 'sid', turnId: 'turn', requestIds: ['q'] },
    preview: true, setPreview: value => events.push(['preview', value]), onCopy: text => events.push(['copy', text]) });
  const portal = tree.props.children[1], overlay = portal.node, content = overlay.props.children;
  assert.equal(portal.target.ownPortalTarget, true);
  assert.equal(overlay.props['data-run-after-satellite'], 'true');
  const event = { stopPropagation: () => events.push(['stop']) };
  content.props.onMouseDown(event);
  assert.deepEqual(events, [['stop']], 'clicking inside does not dismiss the preview');
  content.props.children.props.onCopy('actual frozen instruction');
  assert.deepEqual(events.at(-1), ['copy', 'actual frozen instruction']);
  overlay.props.onMouseDown(event);
  assert.deepEqual(events.at(-1), ['preview', false]);
  // React portals still participate in their parent's React capture path.
  // A capture-close on the Mini parent would eat the child's Copy click first.
  assert.doesNotMatch(source, /onMouseDownCapture=/);
});

test('read-only tool displays a read receipt without inventing a terminal send', () => {
  const [step] = miniEntriesToSteps([{ id: 'read', type: 'tool', name: 'read_review_iteration', status: 'read', text: 'Чтение закреплённой итерации', receipt: { status: 'read', sessionId: 's', turnId: 't', requestCount: 2 } }]);
  assert.equal(step.family, 'read'); assert.equal(step.tool, 'read_review_iteration');
  assert.equal(step.args.sessionId, 's'); assert.equal(step.args.turnId, 't');
  assert.match(step.result, /только чтение/); assert.equal(step.mcpMethod, undefined);
});

test('Gemini controls display the immutable active request pair and are blocked while it runs', () => {
  const node = MiniModelControls({ controller: { settingsPending: false, snapshot: { phase: 'reviewing',
    activeReview: { model: 'gemini-3.8-flash', thinkingLevel: 'HIGH' },
    settings: { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW', revision: 'r:1', thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'] } } } });
  const [model, , effort] = node.props.children;
  assert.equal(model.props.value, 'gemini-3.8-flash'); assert.equal(effort.props.value, 'HIGH');
  assert.equal(model.props.disabled, true); assert.equal(effort.props.disabled, true);
  assert.match(source, /usePointerGesture\(\)/); assert.match(source, /data-mini-orchestrator-drag-handle/);
  assert.match(source, /\['left', 'bottom', 'left-bottom'\]/);
  assert.match(source, />Clear</);
});

test('receipt exposes only bounded named metadata and preserves unknown', () => {
  const [step] = miniEntriesToSteps([{ id: '3', type: 'tool', text: 'send', receipt: { status: 'unknown', handoffId: 'h1', error: 'x'.repeat(300), secret: 'do-not-show' } }]);
  assert.match(step.result, /^unknown · handoff: h1 · error: /);
  assert.doesNotMatch(step.result, /do-not-show/);
  assert.ok(step.result.length < 300);
  const [queued] = miniEntriesToSteps([{ id: '4', type: 'tool', text: 'send', receipt: { status: 'queued' } }]);
  assert.equal(queued.result, 'queued');
});

test('reviewer has a direct independent switch, not just a chat opener', () => {
  let calls = 0;
  const button = MiniOrchestratorToggle({ controller: { snapshot: { enabled: false }, pending: false,
    toggleEnabled: () => { calls++; }, error: '' } });
  assert.equal(button.props.role, 'switch');
  assert.equal(button.props['aria-checked'], false);
  assert.match(button.props['aria-label'], /выключен/);
  assert.equal(button.props['data-active'], false);
  assert.equal(Array.isArray(button.props.children), false, 'only one shared glyph, no visible On/Off label');
  assert.equal(button.props.children.props.size, 13);
  button.props.onClick();
  assert.equal(calls, 1);
  const active = MiniOrchestratorToggle({ controller: { snapshot: { enabled: true }, pending: false, toggleEnabled() {}, error: '' } });
  assert.equal(active.props['aria-checked'], true); assert.equal(active.props['data-active'], true);
  assert.equal(active.props.children.type, button.props.children.type, 'the glyph never changes with mode');
  assert.equal(active.props.children.props.size, 13);
  assert.notEqual(active.props.style.color, button.props.style.color);
  for (const node of [button, active]) {
    const html = renderToStaticMarkup(node);
    assert.equal(html.replace(/<[^>]*>/g, '').trim(), '', 'actual SVG switch has no visible text');
    assert.match(html, /<svg/);
  }
});

test('mode uses the same glyph and active color; lifecycle status distinguishes waiting, Gemini, completion and failure', () => {
  const status = phase => miniStatusPresentation({ enabled: true, phase });
  assert.equal(miniStatusPresentation({ enabled: false, phase: 'reviewing' }), null);
  assert.equal(status('idle'), null); assert.equal(status('collecting').kind, 'waiting');
  assert.equal(status('reviewing').kind, 'running'); assert.equal(status('sending').kind, 'running');
  assert.equal(status('complete'), null, 'no redundant permanent Done badge'); assert.equal(status('error').kind, 'error'); assert.equal(status('unknown').kind, 'unknown');
  const running = MiniOrchestratorStatus({ snapshot: { enabled: true, phase: 'reviewing' } });
  assert.equal(running.props['data-mini-orchestrator-status'], 'running');
  assert.equal(running.props.children.type, 'span', 'only the HTML carrier rotates, no SVG animation');
  assert.match(running.props.children.props.className, /noted-infinite-animation/);
});

test('popup right edge follows its bot, not the viewport beyond Timeline', () => {
  const p = miniPopupLayout({ right: 850, bottom: 100 }, { width: 1200, height: 800 });
  assert.equal(p.left + p.width, 850);
  assert.equal(p.top, 100);
  assert.equal(p.height, 500);
  const narrow = miniPopupLayout({ right: 220, bottom: 300 }, { width: 240, height: 430 });
  assert.equal(narrow.left, 8);
  assert.equal(narrow.width, 224);
  assert.equal(narrow.height, 122);
  assert.ok(narrow.left + narrow.width <= 232);
});

test('popup escapes clipping; menus close it and hidden panes cannot retain a body portal', () => {
  assert.match(source, /createPortal\(<div ref=\{popup\}/);
  assert.match(source, /document\.body\)/);
  assert.match(source, /position: 'fixed'/);
  assert.match(source, /!popup\.current\?\.contains/);
  assert.match(source, /detail\.presented === false\) setOpen\(false\)/);
  const overlay = fs.readFileSync(require('node:path').join(__dirname, 'PromptQueueOverlay.tsx'), 'utf8');
  assert.match(overlay, /<AutoCompactControl tabId=\{tabId\} \/>\s*<MiniOrchestratorToggle controller=\{miniOrchestrator\} \/>/);
});
