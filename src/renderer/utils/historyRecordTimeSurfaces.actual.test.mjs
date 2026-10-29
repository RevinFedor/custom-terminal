import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import nativeQuestion from '../../shared/native-question-reply.cjs';

// Actual message/group markup and service projectors. Host store/navigation,
// reveal and unrelated body/actions are controlled; no Electron/IPC/effects.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const panel = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = name => ast.statements.find(s => ts.isVariableStatement(s)
  && s.declarationList.declarations.some(d => d.name.getText(ast) === name))?.getText(ast);
const user = declaration('HistoryUserEntry'), research = declaration('HistoryResearchReply');
assert.ok(user && research);
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, { memo, useState, useRef, useMemo, useCallback, useEffect } from 'react';
  import { Check, Copy, RotateCcw, X, ArrowUp, Repeat2, RefreshCw } from 'lucide-react';
  import { ConversationMessage, MessageActionRail, MessageActionButton, MessageStatusBadge } from '@noted/claude-blocks';
  import { historyEntryRecordTime, historyRecordTimeAttributes } from './src/renderer/utils/historyRecordTimePresentation.mjs';
  import { projectHistoryServicePromptBody, resolveHistoryOrchestrationPromptPresentation, resolveHistoryPromptSender } from './src/renderer/utils/historyOrchestrationPromptPresentation.mjs';
  import { researchReplyFromProjection } from './src/renderer/utils/researchResultPresentation.mjs';
  import { buildHistoryComposerPresentationParts } from './src/renderer/utils/composerChips.mjs';
  import { ResearchResultContent } from './src/renderer/components/Workspace/ResearchResultContent.tsx';
  import { createHash } from 'node:crypto';
  const historyServicePromptFingerprint = text => createHash('sha256').update(text).digest('hex');
  let mcpAsUser = false;
  const setMcpAsUser = value => { mcpAsUser = value; };
  const useUIStore = selector => selector({historyMcpAsUserTabs:{tab:mcpAsUser}});
  const historyInstructionAttachment = () => null;
  const isLocalPromptEntry = entry => entry.role === 'queued' && entry.uuid.startsWith('local-prompt-');
  const historyPromptHandoffStatusPresentation = () => null;
  const historySendPresentationAction = () => ({});
  const historyUserPromptIsChipOnly = () => false;
  const getAutomaticContinuationKind = () => null;
  const Tooltip = ({children}) => children;
  const HistoryPromptSource = ({source}) => <span data-source-kind={source?.kind}>Source</span>;
  const HistoryUserPromptContent = ({text}) => <span>{text}</span>;
  const HistoryUserPromptBand = () => null;
  const useHistoryRevealToggle = () => () => { throw Error('SSR must not toggle'); };
  const HistoryResearchModelsContext = React.createContext(null);
  const timelineResearchModelLabel = () => '';
  const ResearchSourceAction = () => null;
  ${declaration('splitLeadingHistoryPromptParts')}
  ${research}
  ${user}
  export { HistoryUserEntry, setMcpAsUser };
  export { HistoryCollapsedGroupRow } from './src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx';
` }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'node:crypto'],
  alias: { '@noted/claude-blocks': root + 'packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty' }, logLevel: 'silent' });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { HistoryUserEntry, HistoryCollapsedGroupRow } = loaded.exports;
const time = timestamp => ({ version: 1, timestamp, kind: 'message', scope: 'record' });
const at = '2026-10-23T00:25:47.011Z', audit = '2026-10-23T00:26:07.921Z';
const hash = text => createHash('sha256').update(text).digest('hex');
const local = extra => ({ uuid: 'local-prompt-tab-handoff', role: 'queued', handoffId: 'handoff',
  queueStatus: 'sent', optimisticAt: Date.parse(at), timestamp: at, content: 'message', ...extra });
const renderUser = (entry, forceExpanded = false) => renderToStaticMarkup(React.createElement(HistoryUserEntry, {
  entry, tabId: 'tab', toolType: 'codex', allowRewind: false, rewindLocked: false,
  allowHistoryRewriteRewind: false, historyRewriteRewindLocked: false, allowDeleteIteration: false,
  deleteIterationLocked: false, forceExpanded,
}));

test('actual queued and canonical outcome rows are purple unless the user explicitly chose MCP-as-user', () => {
  const semanticTags = [{ kind: 'prompt-origin', source: 'system', systemSource: 'tab-message-outcome' }];
  for (const role of ['user', 'queued']) for (const expanded of [false, true]) {
    const entry = { ...local({ semanticTags }), role, content: '[Tab message: waiting outcome]\nOutcome: reply_processing_timeout' };
    const before = JSON.stringify(entry);
    loaded.exports.setMcpAsUser(false);
    const html = renderUser(entry, expanded);
    assert.match(html, /hp-history-user-bubble--orchestration/);
    assert.match(html, /data-history-orchestration-phase="prompt"/);
    loaded.exports.setMcpAsUser(true);
    assert.doesNotMatch(renderUser(entry, expanded), /hp-history-user-bubble--orchestration/);
    loaded.exports.setMcpAsUser(false);
    assert.equal(JSON.stringify(entry), before);
    assert.doesNotMatch(renderUser({ ...entry, semanticTags: [] }, expanded), /hp-history-user-bubble--orchestration/,
      'quoting the same envelope cannot change an ordinary user into MCP');
  }
});

function service(kind, phase) {
  const envelope = '[saved service]\n', body = '**Actual answer**', content = envelope + body;
  return { content, semanticTags: [kind === 'research' ? { kind: 'orchestration', runKind: 'external-research',
    runId: 'research-run', phase, envelopeStart: 0, envelopeText: envelope, bodyStart: envelope.length,
    bodyEnd: content.length, bodyProjectionHash: hash(content) }
    : { kind: 'tab-message', messageId: 'message', phase, sourceTabId: 'sender', sourceTabName: 'sender',
      sourceProjectId: 'project', targetTabId: 'tab', envelopeStart: 0, envelopeText: envelope,
      bodyStart: envelope.length, bodyEnd: content.length, bodyProjectionHash: hash(content) }] };
}

for (const [kind, phase] of [['terminal', 'question'], ['terminal', 'reply'], ['research', 'completion'], ['research', 'failure']]) {
  for (const expanded of [false, true]) test('actual ' + kind + '/' + phase + ' retains hover time at expanded=' + expanded, () => {
    const entry = local({ ...service(kind, phase), auditTimestamp: audit, auditEntryUuid: 'canonical' });
    const before = JSON.stringify(entry), html = renderUser(entry, expanded);
    assert.match(html, /data-history-time-key="local-prompt-tab-handoff:user"/);
    assert.ok(html.includes('data-history-time-at="' + audit + '"'));
    if (kind === 'research') assert.match(html, /data-history-research-result="true"/);
    assert.equal(JSON.stringify(entry), before);
  });
}

test('actual native reply keeps its blue proof, exact source time and transport bytes', () => {
  const definitions = new Map();
  nativeQuestion.registerNativeQuestionDefinition(definitions, nativeQuestion.codexNativeQuestionDefinition({
    callId: 'call-exact', toolName: 'request_user_input_async', namespace: '', sourceIdentity: 'call-source',
    physicalSessionId: 'session', turnIndex: 1, args: { questions: [{ title: 'Exact question?' }] },
  }, hash));
  const content = '<send_user_message_question_reply>\n' + JSON.stringify([{ question: 'Exact question?', answer: 'Yes',
    questionItemId: JSON.stringify(['request_user_input_async', 'call-exact', 0]) }]) + '\n</send_user_message_question_reply>';
  const proof = nativeQuestion.proveCodexNativeQuestionReply(content, definitions, 'session', hash);
  assert.ok(proof);
  const entry = { uuid: 'native-reply', role: 'user', content, recordTime: time(at), questionReplyProof: proof };
  const before = JSON.stringify(entry), html = renderUser(entry);
  assert.match(html, /data-history-question-reply="codex"/);
  assert.match(html, /data-history-time-key="native-reply:user"/);
  assert.ok(html.includes('data-history-time-at="' + at + '"'));
  assert.equal(JSON.stringify(entry), before);
});

test('ordinary local prompt dates its saved handoff; unknown canonical row does not borrow timestamp', () => {
  assert.ok(renderUser(local({})).includes('data-history-time-at="' + at + '"'));
  assert.doesNotMatch(renderUser({ uuid: 'unknown', role: 'user', content: 'unknown', timestamp: at }), /data-history-time-at/);
});

for (const family of ['run', 'research']) {
  for (const expanded of [false, true]) test('actual ' + family + ' group header owns range; caption keeps its own time, expanded=' + expanded, () => {
    const group = { key: 'group', familyKey: family, errorCount: 0,
      entries: [{ uuid: 'A', role: 'assistant', recordTime: time(at) },
        { uuid: 'B', role: 'assistant', recordTime: time(audit) }],
      facts: [{ toolName: 'Bash', family: 'run' }], captionEntries: [
        { uuid: 'caption', role: 'assistant', content: 'Caption', recordTime: time(at) }],
    };
    const html = renderToStaticMarkup(React.createElement(HistoryCollapsedGroupRow, { group, expanded, onToggle() {} }));
    assert.match(html, /data-history-time-key="group:time-range"/);
    assert.ok(html.includes('data-history-time-end-at="' + audit + '"'));
    if (family !== 'research' && !expanded) assert.match(html, /data-history-time-key="caption:caption"/);
  });
}
