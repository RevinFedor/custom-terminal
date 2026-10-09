import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyHistoryRevealUpdate');
assert.ok(declaration);
const compiled = ts.transpileModule(declaration.getText(ast) + '\napplyHistoryRevealUpdate;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ scroller = {}, transaction = false } = {}) {
  const calls = [], ops = {
    unpinTail: () => calls.push('unpin'),
  };
  if (transaction) {
    ops.beginReveal = () => { calls.push('begin'); const committed=()=>calls.push('commit');
      committed.finishAnchor=()=>calls.push('settled');return committed; };
    ops.afterRevealCommit = (_anchor,_opening,onFinish) => { calls.push('existing-anchor-after-commit');onFinish?.(); };
  }
  const toggle = vm.runInNewContext(compiled, {
    findHistoryScrollParent: () => scroller,
    historyRevealOpsByScroller: new Map(scroller ? [[scroller, ops]] : []),
    flushSync: update => update(),
  });
  return { calls, run(opening) { toggle({}, opening, () => calls.push('update')); } };
}

// Canonical-only replay missed the optimistic 2807-row case. Its corrected
// down/up/top-collapse gesture exposed a second late resize subtract AFTER
// legal native clamping. Keep the old unpin guard and start the shared anchor
// only after the size-changing commit; this VM check is wiring, not pixels.
test('actual card collapse clears stale follow before the height-changing commit', () => {
  const f = fixture(); f.run(false);
  assert.deepEqual(f.calls, ['unpin', 'update']);
});

test('actual away-from-tail collapse still clears stale follow before changing height', () => {
  const f = fixture(); f.run(false);
  assert.deepEqual(f.calls, ['unpin', 'update']);
});

test('actual expansion still unpins before changing height', () => {
  const f = fixture(); f.run(true);
  assert.deepEqual(f.calls, ['unpin', 'update']);
});

test('detached cards do not write another owner position', () => {
  const f = fixture({ scroller: null }); f.run(false);
  assert.deepEqual(f.calls, ['update']);
});

test('actual transaction binds diagnostic begin and existing collapse anchor after its commit, never before',()=>{
  const f=fixture({transaction:true});f.run(false);
  assert.deepEqual(f.calls,['begin','unpin','update','commit','existing-anchor-after-commit','settled']);
});
