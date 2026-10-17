import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const text = fs.readFileSync(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['historyInstructionAttachment', 'HistoryInstructionChip'];
const nodes = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) nodes.push('const ' + node.getText(ast) + ';');
  ts.forEachChild(node, visit);
}
visit(ast); assert.equal(nodes.length, names.length);
const context = { React: { createElement: (type, props, ...children) => ({ type, props, children }) },
  useState: () => [false, () => {}], useRef: () => ({ current: null }), useCallback: fn => fn,
  ComposerChip: 'ComposerChip', HistoryInstructionProviderIcon: 'ProviderIcon', PastedContentPreview: 'Preview' };
vm.createContext(context);
vm.runInContext(ts.transpileModule(nodes.join('\n') + '\nthis.inspect=historyInstructionAttachment; this.render=HistoryInstructionChip;', {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const instructions = '# AGENTS.md instructions for /Users/test/custom-terminal\n<INSTRUCTIONS>keep exact</INSTRUCTIONS>';

test('canonical CLI bootstrap is visibly Project instructions, not a selected file attachment', () => {
  const attachment = context.inspect(instructions, 'codex', 'project-instructions');
  const tree = context.render({ attachment, text: instructions });
  assert.equal(tree.props['data-history-service-carrier'], 'project-instructions');
  const chip = tree.children[0].children[0];
  assert.equal(chip.props.label, 'Project instructions · AGENTS.md');
  assert.equal(chip.props.preview, 'custom-terminal');
});

test('file names, explicit AGENTS file chips and ordinary pasted text do not acquire bootstrap provenance', () => {
  for (const carrier of [undefined, 'goal-continuation', 'turn-aborted']) {
    assert.equal(context.inspect(instructions, 'codex', carrier), null);
  }
  const explicit = '<context_file name="AGENTS.md" path="/fixture/AGENTS.md">actual explicit user file</context_file>';
  assert.equal(context.inspect(explicit, 'codex', 'project-instructions'), null);
  assert.equal(context.inspect('Please read AGENTS.md', 'codex', 'project-instructions'), null);
  assert.match(text, /serviceCarrier=\{entry\.serviceCarrier\}/, 'canonical row provenance reaches actual content renderer');
});
