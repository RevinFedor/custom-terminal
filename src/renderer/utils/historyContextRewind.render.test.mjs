import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { buildPromptChipWrapper, restoreComposerDraftFromHistoryPresentation,
  serializeComposerDraft, insertComposerSnapshotAtSelection, promptChipDisplayLabel,
} from './composerChips.mjs';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const icons = require('lucide-react');
const history = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', history, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, name);
  return found;
}
const compile = source => transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', compile(fs.readFileSync(
  new URL('../../../packages/claude-blocks/src/components/ComposerFrame.tsx', import.meta.url), 'utf8',
)))(require, componentModule, componentModule.exports);
const { ComposerChip } = componentModule.exports;
const update = { id: 'update-chip', kind: 'prompt', label: 'Состояние вкладки',
  contextUpdateId: 'file-context-exact-source', text: 'Exact saved diff\nincluding <saved_prompt>example<\\/saved_prompt>' };
const ordinary = { id: 'library-chip', kind: 'prompt', label: 'Состояние вкладки', text: 'Ordinary library prompt' };

test('actual Rewind reconstruction and actual composer band preserve orange context type alongside purple prompts', () => {
  const transport = serializeComposerDraft({ text: 'User draft', chips: [update, ordinary] });
  const restored = restoreComposerDraftFromHistoryPresentation({ text: transport });
  assert.equal(restored.chips[0].contextUpdateId, update.contextUpdateId);
  assert.equal(restored.chips[1].contextUpdateId, undefined, 'same title is not context identity');
  assert.equal(serializeComposerDraft(restored), transport);
  const discarded = [];
  const context = vm.createContext({ React, ...icons, ComposerChip,
    WORK_CONTEXT_COLOR: '#e9a345', promptChipDisplayLabel,
    composerPromptChips: restored.chips, contextUpdates: [],
    TabContextUpdateChip: () => { throw new Error('restored snapshots must not invent pending DB updates'); },
    historyComposerStatusRise: () => 0, historyTranscriptFontSize: 14,
    HISTORY_SERVICE_TEXT_RATIO: 0.9, HISTORY_SERVICE_TEXT_WEIGHT: 600,
    historyComposerPromptBandLayout: {
      gapPx: 5,
      maxHeight: 'calc(3.6em + 22px)',
      itemMaxWidth: 'min(168px, calc(100% - 0px))',
    },
    composerPromptBandPreviewNavigation: undefined,
    tabId: 'owner', previewChipId: null, setPreviewChipId() {}, discardContextUpdate() {},
    discardComposerChip: id => discarded.push(id), restoreChipToComposer() {},
  });
  const script = compile('const ' + declaration('historyContextFileChipProps').getText(ast) + ';\n'
    + 'const ' + declaration('historyComposerPromptBand').getText(ast) + ';')
    + '\nthis.band = historyComposerPromptBand;';
  vm.runInContext(script, context);
  const chips = React.Children.toArray(context.band.props.children);
  assert.equal(chips.length, 2);
  assert.equal(chips[0].props.style.color, '#e9a345');
  assert.equal(chips[1].props.style, undefined);
  const html = renderToStaticMarkup(context.band);
  assert.match(html, /color:#e9a345/);
  assert.match(html, /lucide-refresh-cw/);
  assert.match(html, /Обновление рабочего состояния/);
  assert.equal(chips[0].props.trailing, undefined);
  chips[0].props.onAuxClick({ button: 1, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(discarded, [restored.chips[0].id]);
});

test('actual move-to-input callback keeps the context wrapper and Undo snapshot; ordinary prompt still unwraps', () => {
  const imported = ast.statements.find(node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === '../../utils/composerChips.mjs');
  assert.ok(imported.importClause.namedBindings.elements.some(item => item.name.text === 'buildPromptChipWrapper'),
    'the actual caller must import the helper, not only receive it from a test stub');
  const callback = declaration('restoreChipToComposer').initializer.arguments[0];
  for (const selected of [update, ordinary]) {
    let applied;
    const context = vm.createContext({
      isCancellingTurn: false, rewindLocked: false, effectiveStopping: false,
      tabId: 'owner', setDraftWarning() {},
      useUIStore: { getState: () => ({ historyPromptDrafts: { owner: 'AB' },
        historyPromptDraftChips: { owner: [selected] }, historyPromptDraftImages: {},
        historyPromptDraftPendingImages: {} }) },
      promptTextareaRef: { current: null }, promptCaretRef: { current: { start: 1, end: 1 } },
      buildPromptChipWrapper, insertComposerSnapshotAtSelection,
      retainHistoryDraftImages: () => [], mapHistoryPendingImageImports: () => [],
      applyHistoryComposerSnapshot: snapshot => { applied = snapshot; },
      setPreviewChipId() {}, requestAnimationFrame() {},
    });
    vm.runInContext(compile('const restore = ' + callback.getText(ast) + ';') + '\nthis.restore = restore;', context);
    context.restore(selected);
    assert.equal(applied.ownerTabId, 'owner');
    assert.equal(applied.history, 'add');
    assert.equal(applied.chips.length, 0);
    assert.equal(applied.text, 'A' + (selected.contextUpdateId ? buildPromptChipWrapper(selected) : selected.text) + 'B');
  }
});
