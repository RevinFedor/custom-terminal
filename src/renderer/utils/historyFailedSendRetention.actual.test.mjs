import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { historyPromptFailureHasRecoveryOwner } from './historyPromptHandoffs.ts';

// Real History merge, finite rows. The provider/audit leaf says explicitly
// that no canonical user entry exists. No host/History RPC/storage/UI action.
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = parsed.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(node => node.name.getText(parsed) === 'mergeServerAndLocalEntries'));
assert.ok(declaration);
const code = ts.transpileModule(declaration.getText(parsed) + '\nglobalThis.merge = mergeServerAndLocalEntries;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const now = 100_000;
const context = { Date: class extends Date { static now() { return now; } },
  LOCAL_PROMPT_FAILURE_TTL_MS: 15_000,
  historyPromptFailureHasRecoveryOwner,
  isLocalCompactErrorEntry: () => false, isLocalRewindEntry: () => false,
  isLocalPromptEntry: entry => entry.role === 'queued' && entry.uuid.startsWith('local-prompt-'),
  findServerPromptEntry: () => undefined,
  buildHistoryLivePresentation: (canonical, local) => [...canonical, ...local],
};
vm.runInNewContext(code, context);
const row = { uuid: 'local-prompt-private-synthetic-H', handoffId: 'H', role: 'queued',
  content: 'preserve exact authoring [Image #1]', sessionId: 'private-source',
  statusChangedAt: now - 16_000, optimisticAt: now - 80_000, queueStatus: 'failed',
  statusReason: 'send-error-before-submit', applicationQueueId: 9179, applicationQueuePosition: 9179,
  imagePaths: [{ id: 1, path: '/synthetic/managed.png' }],
  historyReturn: { version: 1, token: 'private-return', state: 'available' } };

test('causal: an admitted no-submit failure stays visible past 15 seconds without losing authoring', () => {
  const before = JSON.stringify(row);
  const result = context.merge([], [row]);
  assert.equal(result.length, 1, 'the old failure TTL must not erase an app-owned recoverable card');
  assert.equal(result[0], row);
  assert.equal(JSON.stringify(row), before);
});

test('the same recent failure and UNKNOWN are not dropped by the current merge', () => {
  for (const item of [{ ...row, statusChangedAt: now - 1000 }, { ...row, queueStatus: 'delivery-unknown' }]) {
    const result = context.merge([], [item]);
    assert.equal(result.length, 1);
    assert.equal(result[0], item);
  }
});
