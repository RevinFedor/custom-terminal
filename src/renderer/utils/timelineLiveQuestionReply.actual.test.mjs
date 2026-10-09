import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import * as timeline from './timelineTranscriptRefresh.mjs';
import { timelinePromptPreview } from './timelineEntryPreview.mjs';
import { timelineMarkerKind } from './timelineMarkerPresentation.mjs';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
import { codexNativeQuestionDefinition, registerNativeQuestionDefinition, proveCodexNativeQuestionReply } from '../../shared/native-question-reply.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const source = fs.readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Timeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let body;
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('projectTimelineLiveUserMessage(')) body = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
};
visit(ast); assert.ok(body);
const code = transformSync('globalThis.effect=' + body, { loader: 'tsx', format: 'cjs', target: 'es2022' }).code;

test('actual busy Timeline listener upgrades the same point when native proof arrives, without a full snapshot or a duplicate', () => {
  const question = 'Exact question?', answer = 'Exact answer';
  const content = '<send_user_message_question_reply>\n' + JSON.stringify([{ question, answer,
    questionItemId: JSON.stringify(['request_user_input_async', 'live-call', 0]) }]) + '\n</send_user_message_question_reply>';
  const definitions = new Map();
  registerNativeQuestionDefinition(definitions, codexNativeQuestionDefinition({ callId: 'live-call',
    toolName: 'request_user_input_async', args: { questions: [{ title: question }] },
    sourceIdentity: 'exact-call', physicalSessionId: 's' }, hash));
  const proof = proveCodexNativeQuestionReply(content, definitions, 's', hash);
  const message = { type: 'user', uuid: 'reply', sessionId: 's', sourceIdentity: 'reply-source',
    message: { role: 'user', content: [{ type: 'text', text: content }] } };
  const detail = { tabId: 'tab', toolType: 'codex', sessionId: 's', timestamp: '2026-10-09T03:45:07.360Z', message };
  let listener, snapshot = { ownerKey: 'owner', entries: [] }, commits = 0;
  const scope = { ...timeline, sessionId: 's', toolType: 'codex', tabId: 'tab', timelineOwnerKey: 'owner',
    timelineInstanceIdRef: { current: 'instance' }, isTurnBusyRef: { current: true }, console: { warn() {} },
    window: { require: name => { assert.equal(name, 'node:crypto'); return crypto; } },
    setLiveUserSnapshot: fn => { const next = fn(snapshot); if (next !== snapshot) commits++; snapshot = next; },
    useUIStore: { getState: () => ({ historyRewindPreviews: {} }) }, shouldClearRewindPreviewForDurableUser: () => false,
    ipcRenderer: { on: (_key, fn) => { listener = fn; }, removeListener() {} }, setHistoryRewindPreview() {},
  };
  vm.runInNewContext(code, scope); scope.effect();
  listener({}, detail); assert.equal(timelineMarkerKind(snapshot.entries[0], hash), 'ordinary');
  listener({}, { ...detail, message: { ...message, questionReplyProof: proof } });
  assert.equal(snapshot.entries.length, 1); assert.equal(timelineMarkerKind(snapshot.entries[0], hash), 'question-reply');
  assert.match(timelinePromptPreview(snapshot.entries[0], hash).text, /^Вопрос: Exact question\? Ответ: Exact answer$/);
  const before = commits;
  listener({}, { ...detail, message: { ...message, questionReplyProof: { ...proof, links: proof.links.map(link => ({ ...link })) } } });
  assert.equal(commits, before, 'equivalent proof does not re-render');
  listener({}, { ...detail, tabId: 'foreign' }); assert.equal(commits, before);
  assert.equal(scope.isTurnBusyRef.current, true, 'blue presentation does not finish the turn');
  const canonical = { ...snapshot.entries[0], isLiveUserProjection: false, isSentHandoffProjection: false };
  const adopted = timeline.mergeTimelineEntriesWithSentHandoffs([canonical], [], snapshot.entries);
  assert.equal(adopted.length, 1); assert.equal(timelineMarkerKind(adopted[0], hash), 'question-reply');
});
