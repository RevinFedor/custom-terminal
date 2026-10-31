import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const filename = path.join(here, '../components/Workspace/HistoryPanel.tsx');
const source = fs.readFileSync(filename, 'utf8');
const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let actual;
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'applyPreviewState') {
    assert.equal(actual, undefined, 'one actual preview state applier');
    actual = node.getText(tree);
  }
  ts.forEachChild(node, find);
}
find(tree);
assert.ok(actual);
const code = ts.transpileModule(`const ${actual}; globalThis.apply = applyPreviewState;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const follow of [true, false]) {
  test(`actual preview publication keeps follow intent ${follow} without diagnostic layout reads`, () => {
    const preview = { previewId: 'fixture', previewSeq: 1, text: 'owned synthetic output', reason: 'semantic-assistant-delta' };
    const events = [];
    const state = { current: null };
    const followIntent = { current: follow };
    const scroller = new Proxy({}, { get(_target, property) {
      throw new Error(`unexpected diagnostic geometry access: ${String(property)}`);
    } });
    const ctx = vm.createContext({
      terminalPreviewRef: state,
      setTerminalPreview(value) { events.push(['state', value]); },
      historyDiag(value) { events.push(['log', value]); },
      isAtBottomRef: followIntent,
      virtuosoScrollerRef: { current: scroller },
      tabId: 'synthetic-owner', toolType: 'codex',
    });
    vm.runInContext(code, ctx);
    ctx.apply(preview, 'event', { reason: 'priority-owned', waitedMs: 4 });
    assert.strictEqual(state.current, preview);
    assert.equal(followIntent.current, follow, 'diagnostics do not change product tail-follow intent');
    assert.strictEqual(events[0][1], preview);
    assert.match(events[1][1], new RegExp(`followBottom=${follow ? '1' : '0'}`));
    assert.match(events[1][1], /physicalPinned=unknown scrollTop=unknown scrollHeight=unknown/);
    assert.match(events[1][1], /priority=priority-owned:4/);
    assert.match(events[1][1], /reason=semantic-assistant-delta/);
  });
}
