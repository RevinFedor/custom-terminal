import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { HistoryPromptHandoffStore } from './historyPromptHandoffs.ts';
import { historySendReturnEnabled } from './historySendReturn.mjs';
const source = fs.readFileSync(process.env.HISTORY_RETURN_PANEL_SOURCE
  || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let subscriber, equality, append;
function walk(n) {
  if (ts.isCallExpression(n) && n.expression.getText(ast) === 'useEffect'
    && n.arguments[0]?.getText(ast).startsWith('() => subscribeHistoryPromptHandoffs')) subscriber = n.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'historyEntryPresentationEqual') equality = n.initializer.getText(ast);
  if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'appendLocalPromptEntry') append = n;
  ts.forEachChild(n, walk);
}
walk(ast);
let rowExpression;
function entry(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'entry' && ts.isObjectLiteralExpression(n.initializer)) rowExpression = n.initializer.getText(ast);
  ts.forEachChild(n, entry);
}
entry(append);
const evaluate = (text, ctx) => vm.runInContext(ts.transpileModule('globalThis.result=(' + text + ');', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);

for (const queueStatus of ['preparing', 'failed']) test('actual live subscriber → local row → memo retains return control: ' + queueStatus, () => {
  const control = { version: 1, tabId: 'T', handoffId: 'H', token: 'return-H', state: 'available' };
  const records = [{ tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'original', submittedAt: 1,
    queueStatus, historyReturn: control, promptChips: [], imagePaths: [], requiresAuditIdentity: true }];
  let meta;
  const ctx = vm.createContext({ tabId: 'T', toolType: 'codex', sessionId: 'S',
    subscribeHistoryPromptHandoffs: (_id, cb) => cb(records, { type: 'replay' }),
    resolveHistoryPromptHandoffPresentationSession: () => ({ belongsToCurrent: true, presentationSessionId: 'S' }),
    resolveHistoryPromptHandoffSemanticTags: () => [], removeLocalPromptEntry() {}, updateLocalPromptEntry() {},
    appendLocalPromptEntry: (_text, _status, input) => { meta = input; },
  });
  evaluate(subscriber, ctx); ctx.result(); assert.equal(meta.historyReturn, control);
  Object.assign(ctx, { meta, LOCAL_PROMPT_PREFIX: 'local-', handoffId: 'H', queueStatus,
    submittedAt: 1, statusChangedAt: 1, cleanContent: 'original', resolvedSessionId: 'S',
    normalizeComposerChips: x => x, retainHistoryDraftImages: (_t, x) => x });
  evaluate(rowExpression, ctx); const row = ctx.result;
  assert.equal(row.historyReturn, control); assert.equal(historySendReturnEnabled(row), true);
  Object.assign(ctx, { recordTimes: { historyRecordTimeEqual: () => true }, historySourceIdentityAliasesEqual: () => true,
    haveSameComposerChips: () => true, haveSamePromptImageRefs: () => true });
  evaluate(equality, ctx);
  assert.equal(ctx.result(row, { ...row, historyReturn: { ...control, state: 'writing' } }), false);
});
test('late available/rebegin cannot revive restored H; foreign control cannot affect its button', () => {
  const store = new HistoryPromptHandoffStore();
  const control = { version: 1, tabId: 'T', handoffId: 'H', token: 'return-H', state: 'available' };
  const original = { tabId: 'T', handoffId: 'H', toolType: 'codex', text: 'original', historyReturn: control };
  store.begin(original);
  store.recordReturnControl({ ...control, token: 'foreign', state: 'writing' });
  assert.equal(store.getSnapshot('T')[0].historyReturn.state, 'available');
  store.recordReturnControl({ ...control, state: 'restored' });
  store.consume('T', 'H'); store.recordReturnControl(control); store.begin(original);
  assert.equal(store.getSnapshot('T').length, 0);
});
