import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeTerminalMessageSnapshot, readTerminalMessageClipboard } from '../../shared/terminal-message-reference.mjs';
import { normalizeComposerChips, buildPasteChipMarker, serializeComposerDraft, buildHistoryComposerPresentationParts,
  restoreComposerDraftFromHistoryPresentation } from '../../shared/composer-chips.mjs';
import { buildHistoryMessageComposerSnapshot, insertHistoryClipboardSnapshotAtSelection } from './composerClipboard.mjs';
import { resolveHistoryToolNavigationTarget } from './historyToolNavigation.mjs';
import { historyEntryMessageReference, copiedHistoryMessageIteration } from './historyEntryMessageReference.mjs';
import { timelineMessageSnapshotCache, makeTimelineSnapshotKey } from './timelineSnapshotCache.mjs';
const require = createRequire(import.meta.url);
const { writeTerminalMessageDetails } = require('../../main/terminal-message-clipboard.js');
const { normalizePromptPresentationSnapshot, saveAuditedPromptPresentation, decorateHistoryPromptPresentations } = require('../../main/history-prompt-presentations.js');
const target = { tabId: 'new_project_1780063688522_5r84fv-tab-224', provider: 'codex', sessionId: 'view',
  messageId: 'composite-uuid', physicalSessionId: 'parent', rawUuid: 'raw-user', transcriptSegmentId: 'original-segment',
  viewOwnerSessionId: 'view', tabName: '日本語 · разработка', iteration: 4, timeLabel: '14.10.2026, 14:00:00' };
const details = 'Agent: Codex\nRole: user\nMessage ID: composite-uuid\nSession ID: parent\nQueue status: sent\n🙂\nTerminal diagnostic: original-reference';
const reference = makeTerminalMessageSnapshot(details, target, 'copy-action');
const chip = { id: 'chip1', kind: 'paste', text: details, messageReference: reference };
test('actual copy helper writes one native item, keeps final diagnostic Details and exact selected source', async () => {
  const writes = [];
  await writeTerminalMessageDetails({ write: data => writes.push(data), writeText: text => writes.push({ text }) }, details,
    { source: target, referenceId: reference.referenceId });
  assert.equal(writes.length, 1); assert.equal(writes[0].text, details);
  const decoded = readTerminalMessageClipboard({ getData: type => type === 'text/html' ? writes[0].html : '' }, details);
  assert.equal(decoded.source.rawUuid, target.rawUuid); assert.equal(decoded.source.terminalInstancePid, process.pid);
  const ambiguous = { write() { throw Error('unknown-dispatch'); }, writeText() { assert.fail('must not overwrite after dispatch'); } };
  await assert.rejects(writeTerminalMessageDetails(ambiguous, details, { source: target, referenceId: reference.referenceId }), /unknown/);
});
test('draft/Send/persisted presentation/replay retain full message reference and repeated position', () => {
  const chips = normalizeComposerChips([chip, { ...chip, id: 'chip2' }]);
  const text = 'before ' + buildPasteChipMarker(chips[0]) + ' middle ' + buildPasteChipMarker(chips[1]) + ' after';
  const transport = serializeComposerDraft({ text, chips });
  assert.equal(transport.split(details).length, 3);
  const stored = normalizePromptPresentationSnapshot({ promptChips: chips });
  const rows = [], store = { saveHistoryPromptPresentation(row) { rows.push(row); return true; },
    getHistoryPromptPresentations() { return rows; }, getHistoryPromptPresentationsForEntries() { return rows; } };
  const timestamp = '2026-10-14T07:00:00Z';
  assert.equal(saveAuditedPromptPresentation(store, { toolType: 'codex', sessionId: 'view', entryUuid: 'entry', auditTimestamp: timestamp,
    actualText: transport, snapshot: { promptChips: stored.promptChips } }), true);
  const [decorated] = decorateHistoryPromptPresentations(store, { toolType: 'codex', sessionId: 'view',
    entries: [{ uuid: 'entry', role: 'user', timestamp, content: transport }] });
  assert.equal(decorated.content, transport);
  const readback = decorated.promptChips;
  const parts = buildHistoryComposerPresentationParts({ text: transport, chips: readback }).parts;
  assert.equal(parts.filter(part => part.messageReference).length, 2);
  const restored = restoreComposerDraftFromHistoryPresentation({ text: transport, chips: readback });
  assert.equal(restored.chips.length, 2); assert.equal(restored.chips[0].messageReference.referenceId, 'copy-action');
  const copied = buildHistoryMessageComposerSnapshot({ text: transport, chips: readback });
  assert.equal(copied.chips[1].messageReference.detailsText, details);
  const insertion = insertHistoryClipboardSnapshotAtSelection({ text: 'left selected right', chips: [], insertedText: copied.text,
    insertedChips: copied.chips, selectionStart: 5, selectionEnd: 13 });
  assert.equal(insertion.chips.length, 2); assert.ok(insertion.text.startsWith('left before ')); assert.ok(insertion.text.endsWith(' after right'));
  const mismatch = buildHistoryComposerPresentationParts({ text: transport.replace('🙂', 'different'), chips: readback }).parts;
  assert.equal(mismatch.find(part => part.kind === 'paste').messageReference, undefined);
});
test('navigation rejects equal UUID in another physical source and ambiguous duplicates, accepts exact stub/canonical alias', () => {
  const row = { uuid: 'composite-uuid', sessionId: 'new-view', physicalSessionId: 'parent', rawUuid: 'raw-user', transcriptSegmentId: 'original-segment', role: 'user' };
  const tool = { messageReference: target };
  assert.equal(resolveHistoryToolNavigationTarget([row, { ...row, physicalSessionId: 'other' }], target.messageId, tool), row);
  assert.equal(resolveHistoryToolNavigationTarget([{ ...row, physicalSessionId: 'other' }], target.messageId, tool), null);
  assert.equal(resolveHistoryToolNavigationTarget([row, { ...row }], target.messageId, tool), null);
  assert.equal(resolveHistoryToolNavigationTarget([{ ...row, uuid: 'canonical', sourceIdentityAliases: [target.messageId] }], target.messageId, tool).uuid, 'canonical');
  assert.equal(resolveHistoryToolNavigationTarget([{ ...row, rowStub: true }], target.messageId, tool).rowStub, true);
  assert.equal(resolveHistoryToolNavigationTarget([{ ...row, transcriptSegmentId: 'other-segment' }], target.messageId, tool), null);
});
test('selected entryRef is authoritative; iteration is only the existing addressed Timeline cache label', () => {
  const entry = { uuid: target.messageId, sessionId: 'physical-fallback', physicalSessionId: 'wrong', rawUuid: 'wrong', role: 'user',
    entryRef: { physicalSessionId: 'parent', rawUuid: 'raw-user', viewOwnerSessionId: 'view', segmentId: 'original-segment' } };
  const copy = historyEntryMessageReference(entry, { tabId: target.tabId, provider: 'codex', referenceId: 'copy-action' });
  assert.equal(copy.source.physicalSessionId, 'parent'); assert.equal(copy.source.rawUuid, 'raw-user');
  const owner = { tabId: target.tabId, toolType: 'codex', sessionId: 'view', cwd: '/tmp/fixture' };
  assert.equal(copiedHistoryMessageIteration([entry], entry, owner, () => true), null);
  timelineMessageSnapshotCache.set(makeTimelineSnapshotKey(owner), { entries: [
    { uuid: 'user1', type: 'user' }, { uuid: 'service', type: 'user', semanticTags: [{ kind: 'orchestration' }] },
    { uuid: target.messageId, type: 'user' } ] });
  assert.equal(copiedHistoryMessageIteration([entry], entry, owner, row => row.type === 'user'), 2);
  const assistant = { uuid: 'reply', role: 'assistant' };
  assert.equal(copiedHistoryMessageIteration([entry, assistant], assistant, owner, row => row.type === 'user'), 2);
});
