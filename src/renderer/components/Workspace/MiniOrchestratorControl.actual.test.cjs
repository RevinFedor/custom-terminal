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
vm.runInNewContext(code, { module: moduleStub, exports: moduleStub.exports, window: { require: () => ({ ipcRenderer: {} }) }, require: (name) => {
  if (name === 'react') return require('react');
  if (name === 'react-dom') return { createPortal: (node, target) => ({ node, target }) };
  if (name === 'lucide-react') return {};
  if (name === '../../constants/geminiModels') return { GEMINI_MODEL_OPTIONS: [{ value: 'gemini-3.8-flash', label: 'Flash 3.8' }], legacyGeminiModelLabel: () => null };
  if (name === '../../store/useUIStore') return { useUIStore: () => undefined };
  if (name === '../../hooks/usePointerGesture') return {};
  if (name === '../../utils/miniOrchestratorGeometry.mjs') return require('../../utils/miniOrchestratorGeometry.mjs');
  if (name === '../../utils/historyResponseTiming.mjs') return require('../../utils/historyResponseTiming.mjs');
  if (name.endsWith('.css')) return {};
  if (name === '../../utils/paneLayerPresentation.mjs') return { PANE_LAYER_PRESENTATION_EVENT: 'noted:pane-layer-presentation' };
  if (name === './HistoryTranscriptPresentation' || name === '@noted/claude-blocks') return shared.exports;
  throw new Error(name);
} });
const { miniEntriesToSteps, MiniReviewInputContent, miniPopupLayout, MiniOrchestratorToggle, miniStatusPresentation, miniPhaseLabel, MiniOrchestratorStatus, MiniModelControls } = moduleStub.exports;

test('source pair and internal notices are not reviewer messages', () => {
  const steps = miniEntriesToSteps([{ id: '1', type: 'request', text: 'question' }, { id: '2', type: 'answer', text: 'answer' }, { id: '3', type: 'notice', text: 'internal' }]);
  assert.equal(steps.length, 0);
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
  const render = expanded => renderToStaticMarkup(React.createElement(MiniReviewInputContent, { entries, source: sourceRef, expanded, onToggle() {}, onCopy() {} }));
  const closed = render(null);
  assert.equal((closed.match(/data-message-layout="user"/g) || []).length, 1);
  assert.equal((closed.match(/data-composer-chip-kind=/g) || []).length, 2);
  assert.match(closed, /cb-user-bubble/); assert.match(closed, />Инструкция</); assert.match(closed, />Итерация</);
  const visible = closed.replace(/ title="[^"]*"/g, '');
  assert.doesNotMatch(visible, /\/private\/full\/path|FULL INSTRUCTION|ORIGINAL REQUEST|ORIGINAL ANSWER|INTERNAL NOTICE/);
  assert.match(closed, /\/private\/full\/path/, 'full path is available only in tooltip');
  const instruction = render('instruction');
  assert.match(instruction, /FULL INSTRUCTION/); assert.match(instruction, /revision:abcdef123/); assert.match(instruction, /\/private\/full\/path/);
  assert.doesNotMatch(instruction, /ORIGINAL REQUEST|ORIGINAL ANSWER|INTERNAL NOTICE/);
  const iteration = render('iteration');
  assert.doesNotMatch(iteration, /Архив headless-проверки/);
  assert.match(iteration, /session-exact/); assert.match(iteration, /turn-exact/); assert.match(iteration, /ORIGINAL REQUEST ONE/); assert.match(iteration, /ORIGINAL REQUEST TWO/);
  assert.match(iteration, /ORIGINAL <strong>ANSWER<\/strong>/); assert.doesNotMatch(iteration, /FULL INSTRUCTION|INTERNAL NOTICE/);
  assert.doesNotMatch(iteration, /<textarea|contenteditable="true"/);
  const archiveSource = { ...sourceRef, archived: true, verificationNotes: ['low not max', 'shell disabled', 'compact count: 2', 'x'.repeat(260), 'note5', 'note6', 'note7', 'note8', 'note9'] };
  const archive = renderToStaticMarkup(React.createElement(MiniReviewInputContent, { entries, source: archiveSource, expanded: 'iteration', onToggle() {}, onCopy() {} }));
  assert.match(archive, /Архив headless-проверки/);
  assert.match(archive, /low not max\nshell disabled\ncompact count: 2/);
  assert.match(archive, /x{240}/); assert.doesNotMatch(archive, /x{241}|note9/);
  const archiveClosed = renderToStaticMarkup(React.createElement(MiniReviewInputContent, { entries, source: archiveSource, expanded: null, onToggle() {}, onCopy() {} }));
  assert.doesNotMatch(archiveClosed, /low not max|shell disabled|compact count/);
});

test('archive label applies only to completed archived presentation', () => {
  assert.equal(miniPhaseLabel({ phase: 'complete', reviewSource: { archived: true } }), 'Готово · архив');
  assert.equal(miniPhaseLabel({ phase: 'complete', reviewSource: {} }), 'Готово');
  assert.equal(miniPhaseLabel({ phase: 'reviewing', reviewSource: { archived: true } }), 'Проверяет');
  assert.equal(miniPhaseLabel(null), 'Inactive');
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
  assert.match(button.props['aria-label'], /Inactive/);
  assert.equal(button.props.children[1].props.children, 'Off');
  button.props.onClick();
  assert.equal(calls, 1);
});

test('mode label is just On/Off; lifecycle status distinguishes waiting, Gemini, completion and failure', () => {
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
