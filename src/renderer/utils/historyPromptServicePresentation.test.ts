import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import {
  beginHistoryPromptHandoff,
  HistoryPromptHandoffStore,
  consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  hydrateHistoryPromptHandoffFromDurableReceipt,
  reconcileHistoryPromptHandoffRows,
  historyPromptHandoffPresentationIdentity,
} from './historyPromptHandoffs.ts';
import * as presentation from './historyOrchestrationPromptPresentation.mjs';

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const panelSource = readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const panelAst = ts.createSourceFile('HistoryPanel.tsx', panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let tagStatements: string[] = [];
const visit = (node: ts.Node) => {
  if (ts.isBlock(node) && node.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(panelAst) === 'semanticTags'))) {
    tagStatements = node.statements.filter(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => ['orchestrationHandoff', 'semanticTags'].includes(declaration.name.getText(panelAst))))
      .map(statement => statement.getText(panelAst));
  }
  ts.forEachChild(node, visit);
};
visit(panelAst);
assert.ok(tagStatements.length, 'actual History handoff subscriber presentation block');
const selectTags = (record: any) => vm.runInNewContext(ts.transpileModule(
  tagStatements.join('\n') + '\nsemanticTags;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText, { ...presentation, record });

function receipt(key: string, phase = 'reply', state = 'confirmed') {
  const body = '**Exact answer**\n\nFull body with a quoted [Tab message: reply].';
  const envelope = '[Tab message: ' + phase + ']\nMessage ID: ' + key + '\n\n';
  const text = envelope + body;
  const semanticTags = [{ kind: 'tab-message', messageId: key, phase,
    replyTo: phase === 'reply' ? 'original-question' : null,
    sourceTabId: 'sender', sourceTabName: 'optimization windows', sourceProjectId: 'project', targetTabId: 'recipient',
    envelopeStart: 0, envelopeText: envelope, bodyStart: envelope.length, bodyEnd: text.length, bodyProjectionHash: fingerprint(text) }];
  return { tabId: 'recipient', handoffId: 'tab-message:' + key, operationKey: 'tab-message:' + key,
    attemptId: 'attempt-' + key, provider: 'codex', sessionId: 'same-session', surface: 'tab-message', state,
    applicationQueue: { version: 1, id: 824, state: state === 'confirmed' ? 'completed' : 'dispatching', queuedAt: 1 },
    createdAt: 1, updatedAt: 2,
    receipt: { promptText: text, source: 'codex-tab-message:' + key, presentationSnapshot: { semanticTags },
      actualHash: 'exact-audit-hash', sessionId: 'same-session', auditTimestamp: '2026-10-07T04:48:45.519Z',
      entryUuid: 'canonical-' + key, sourceIdentity: 'source-' + key }, body, semanticTags };
}

for (const phase of ['question', 'reply']) {
  for (const state of ['audit-pending', 'confirmed']) {
    test('actual durable handoff -> local History retains ' + phase + ' header at ' + state, () => {
      const record = receipt(phase + '-' + state, phase, state);
      try {
        const result = hydrateHistoryPromptHandoffFromDurableReceipt(record);
        assert.equal(result.hydrated, true);
        const handoff = result.handoff!;
        const tags = selectTags(handoff);
        const entry = { role: 'queued', content: handoff.text, semanticTags: tags };
        const source = presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation(entry));
        assert.equal(source?.sourceTabId, 'sender', 'sender must survive the optimistic receipt projection');
        assert.equal(source?.messageId, record.semanticTags[0].messageId);
        assert.equal(source?.sourceTabName, 'optimization windows');
        assert.deepEqual(presentation.projectHistoryServicePromptBody(entry, fingerprint), { text: record.body, projected: true });
        assert.equal(handoff.text, record.receipt.promptText, 'transport/copy text remains full');
        assert.equal(handoff.sendAttemptId, record.attemptId);
        assert.equal(handoff.queueStatus, state === 'confirmed' ? 'sent' : 'audit-pending');
      } finally { consumeHistoryPromptHandoff(record.tabId, record.handoffId); }
    });
  }
}

test('exact late receipt enriches an existing owner without resetting delivery or text', () => {
  const record = receipt('late');
  try {
    beginHistoryPromptHandoff({ tabId: record.tabId, handoffId: record.handoffId, toolType: 'codex',
      sessionIdHint: record.sessionId, text: record.receipt.promptText, source: record.receipt.source,
      sendAttemptId: record.attemptId, sendOperationKey: record.operationKey, submittedAt: 1 });
    const result = hydrateHistoryPromptHandoffFromDurableReceipt(record);
    assert.equal(result.hydrated, true);
    assert.equal(presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation({
      role: 'queued', semanticTags: selectTags(result.handoff),
    }))?.sourceTabId, 'sender');
    const settled = getHistoryPromptHandoffsSnapshot(record.tabId)[0];
    assert.equal(settled.queueStatus, 'sent');
    assert.equal(settled.text, record.receipt.promptText);
    assert.equal(settled.sendAttemptId, record.attemptId);
  } finally { consumeHistoryPromptHandoff(record.tabId, record.handoffId); }
});

test('late metadata rejects another attempt, operation, session, provider, handoff or text', () => {
  const record = receipt('guards');
  const store = new HistoryPromptHandoffStore();
  store.begin({ tabId: record.tabId, handoffId: record.handoffId, toolType: 'codex',
    sessionIdHint: record.sessionId, text: record.receipt.promptText, source: record.receipt.source,
    sendAttemptId: record.attemptId, sendOperationKey: record.operationKey });
  const original = store.getSnapshot(record.tabId)[0];
  for (const change of [{ attemptId: 'foreign' }, { operationKey: 'foreign' }, { sessionId: 'foreign' },
    { provider: 'claude' }, { handoffId: 'foreign' }, { tabId: 'foreign' },
    { receipt: { ...record.receipt, promptText: 'changed text' } }]) {
    assert.equal(store.hydrateSemanticPresentation({ ...record, ...change }), false);
    assert.strictEqual(store.getSnapshot(record.tabId)[0], original);
  }
  assert.equal(store.hydrateSemanticPresentation(record), true);
  const enriched = store.getSnapshot(record.tabId)[0];
  assert.equal(enriched.text, original.text);
  assert.equal(enriched.queueStatus, original.queueStatus);
  assert.equal(enriched.statusChangedAt, original.statusChangedAt);
  assert.equal(enriched.auditProof, original.auditProof);
  assert.equal(store.hydrateSemanticPresentation({ ...record, receipt: { ...record.receipt,
    presentationSnapshot: { semanticTags: [{ ...record.semanticTags[0], sourceTabId: 'foreign' }] } } }), false);
  assert.strictEqual(store.getSnapshot(record.tabId)[0], enriched);
});

test('frozen service metadata cannot be rewritten by its caller or a late old attempt', () => {
  const record = receipt('frozen');
  const store = new HistoryPromptHandoffStore();
  const original = store.begin({ tabId: record.tabId, handoffId: record.handoffId, toolType: 'codex',
    text: record.receipt.promptText, semanticTags: record.semanticTags as any,
    sendAttemptId: record.attemptId, sendOperationKey: record.operationKey })!;
  assert.equal(Object.isFrozen(original.semanticTags), true);
  assert.equal(Object.isFrozen(original.semanticTags![0]), true);
  record.semanticTags[0].sourceTabName = 'Changed by caller';
  assert.equal(original.semanticTags![0].sourceTabName, 'optimization windows');
  store.begin({ tabId: record.tabId, handoffId: record.handoffId, toolType: 'codex', text: original.text,
    sendAttemptId: 'new-attempt', sendOperationKey: record.operationKey, semanticTags: [] });
  assert.equal(store.hydrateSemanticPresentation(record), false);
  assert.equal(store.getSnapshot(record.tabId)[0].sendAttemptId, 'new-attempt');
});

test('service metadata is counted in the existing bounded handoff cache', () => {
  const store = new HistoryPromptHandoffStore({ maxTabs: 2, maxHandoffs: 2, maxBytes: 4096 });
  const record = receipt('bounds');
  const original = store.begin({ tabId: record.tabId, handoffId: record.handoffId, toolType: 'codex',
    text: record.receipt.promptText, sendAttemptId: record.attemptId, sendOperationKey: record.operationKey })!;
  assert.equal(store.hydrateSemanticPresentation({ ...record, receipt: { ...record.receipt,
    presentationSnapshot: { semanticTags: [{ ...record.semanticTags[0], envelopeText: 'x'.repeat(4096) }] } } }), false);
  assert.strictEqual(store.getSnapshot(record.tabId)[0], original);
});

test('legacy owned handoffs retain colour without inventing a sender from envelope text', () => {
  const id = 'tab-message:d0d7ff77-1a0f-4954-b0f1-9e317b7de37b';
  const tags = selectTags({ handoffId: id, source: 'codex-' + id, text: '[Tab message: reply]\nFrom: Fake' });
  assert.deepEqual(JSON.parse(JSON.stringify(tags)), [{ kind: 'prompt-origin', source: 'terminal-mcp' }]);
  assert.equal(presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation({
    role: 'queued', semanticTags: tags,
  })), null);
  assert.equal(selectTags({ handoffId: 'manual', source: 'history-panel', text: '[Tab message: reply]\nFrom: Fake' }), undefined);
});

test('remount reconciliation enriches an already-cached local row from the exact handoff', () => {
  const record = receipt('remount');
  try {
    const result = hydrateHistoryPromptHandoffFromDurableReceipt(record);
    const handoff = result.handoff!;
    const old = { handoffId: handoff.handoffId, queueStatus: handoff.queueStatus,
      statusAtSend: handoff.statusAtSend, statusReason: handoff.statusReason, statusChangedAt: handoff.statusChangedAt,
      semanticTags: [{ kind: 'prompt-origin' as const, source: 'terminal-mcp' }] };
    const projected = reconcileHistoryPromptHandoffRows({ rows: [old], handoffs: [handoff], createRow: () => null });
    const source = presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation({
      role: 'queued', semanticTags: projected.rows[0].semanticTags,
    }));
    assert.equal(source?.sourceTabId, 'sender');
    assert.equal(projected.rows.length, 1);
    assert.equal(projected.rows[0].handoffId, old.handoffId);
    assert.equal(projected.rows[0].queueStatus, old.queueStatus);
  } finally { consumeHistoryPromptHandoff(record.tabId, record.handoffId); }
});

test('actual stable-row comparator observes late semantic metadata but reuses identical rows', () => {
  const node = panelAst.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(panelAst) === 'historyEntryPresentationEqual'));
  assert.ok(node);
  const equal = vm.runInNewContext(ts.transpileModule(node.getText(panelAst) + '\nhistoryEntryPresentationEqual;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { historySourceIdentityAliasesEqual: () => true,
    haveSameComposerChips: () => true, haveSamePromptImageRefs: () => true });
  const row = { uuid: 'same-row', role: 'user', content: 'Same full transport', semanticTags: [] };
  const decorated = { ...row, semanticTags: receipt('late-canonical').semanticTags };
  assert.equal(equal(row, row), true);
  assert.equal(equal(row, decorated), false, 'same UUID/text is not unchanged presentation');
  assert.equal(equal(decorated, { ...decorated, semanticTags: structuredClone(decorated.semanticTags) }), true);
});

test('actual owner-remount row factory retains the service header before any new event', () => {
  let createRow: ts.Node | undefined;
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(panelAst) === 'reconcileHistoryPromptHandoffRows') {
      const input = node.arguments[0];
      if (ts.isObjectLiteralExpression(input)) {
        const property = input.properties.find(property => ts.isPropertyAssignment(property)
          && property.name.getText(panelAst) === 'createRow');
        if (property && ts.isPropertyAssignment(property)) createRow = property.initializer;
      }
    }
    ts.forEachChild(node, find);
  };
  find(panelAst);
  assert.ok(createRow);
  const record = receipt('owner-remount');
  try {
    const result = hydrateHistoryPromptHandoffFromDurableReceipt(record);
    const factory = vm.runInNewContext(ts.transpileModule('const create = ' + createRow.getText(panelAst) + ';\ncreate;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, { ...presentation, historyPromptHandoffPresentationIdentity,
      normalizeHistoryPromptText: (text: string) => text.trim(), normalizeComposerChips: (chips: any) => chips,
      retainHistoryDraftImages: () => [], LOCAL_PROMPT_PREFIX: 'local-prompt-', tabId: record.tabId,
      handoffSessionRoutes: new Map([[record.handoffId, { presentationSessionId: record.sessionId }]]) });
    const entry = factory(result.handoff);
    assert.equal(presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation(entry))?.sourceTabId, 'sender');
    assert.deepEqual(presentation.projectHistoryServicePromptBody(entry, fingerprint), { text: record.body, projected: true });
  } finally { consumeHistoryPromptHandoff(record.tabId, record.handoffId); }
});

if (process.env.NOTED_QUEUED_HEADER_CAPTURE) {
  test('captured4929 exact Application API receipt renders the same header/body as its canonical row', () => {
    const root = process.env.NOTED_QUEUED_HEADER_CAPTURE!;
    const flat = JSON.parse(readFileSync(root + '/receipt.json', 'utf8'));
    const canonical = JSON.parse(readFileSync(root + '/canonical.json', 'utf8'));
    try {
      const result = hydrateHistoryPromptHandoffFromDurableReceipt({ ...flat, receipt: flat });
      assert.equal(result.hydrated, true);
      const local = { role: 'queued', content: result.handoff!.text, semanticTags: selectTags(result.handoff) };
      assert.deepEqual(JSON.parse(JSON.stringify(presentation.resolveHistoryPromptSender(
        presentation.resolveHistoryOrchestrationPromptPresentation(local)))),
      presentation.resolveHistoryPromptSender(presentation.resolveHistoryOrchestrationPromptPresentation(canonical)));
      assert.deepEqual(presentation.projectHistoryServicePromptBody(local, fingerprint),
        presentation.projectHistoryServicePromptBody(canonical, fingerprint));
      assert.equal(local.content, canonical.content);
      assert.equal(result.handoff!.queueStatus, 'sent');
    } finally { consumeHistoryPromptHandoff(flat.tabId, flat.handoffId); }
  });
}
