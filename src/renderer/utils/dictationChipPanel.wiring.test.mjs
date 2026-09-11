// Wiring invariants for dictation chips inside HistoryPanel + the App bridge.
// Source-text assertions in the project's wiring style: they break loudly
// when a guard is deleted, renamed, or moved out of its owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSrc = fs.readFileSync(path.join(here, '../components/Workspace/HistoryPanel.tsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(here, '../App.tsx'), 'utf8');
const webSrc = fs.readFileSync(path.join(here, '../../main/web-server.js'), 'utf8');

const between = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, 'anchor not found: ' + from);
  const j = src.indexOf(to, i);
  assert.ok(j > i, 'end anchor not found: ' + to);
  return src.slice(i, j);
};

test('send gate: any dictation marker blocks canSend', () => {
  const block = between(panelSrc, 'const dictationHoldsSend', 'const canGrabDraft');
  assert.ok(block.includes('dictationBlocksSend(prompt)'));
  assert.ok(block.includes('!dictationHoldsSend'));
});

test('Enter during pending arms auto-send instead of swallowing the intent', () => {
  const enter = between(panelSrc, "if (e.key !== 'Enter' || e.shiftKey", 'onSelectionChange');
  assert.ok(enter.includes('armDictationChipsForTab(tabId)'));
  assert.ok(enter.includes('DICTATION_ARM'));
});

test('submit-composer event holds and arms too — ControlBar Enter and auto-send share the same door', () => {
  const submit = between(panelSrc, 'const submitComposer = (event: Event)', 'window.addEventListener(\'history-panel:submit-composer\'');
  assert.ok(submit.includes('dictationBlocksSend(currentDraft)'));
  assert.ok(submit.includes("detail.source === 'dictation-chip-auto-send'"));
  assert.ok(submit.includes('armDictationChipsForTab(tabId)'));
});

test('manual typing disarms; programmatic marker edits do not', () => {
  const onChange = between(panelSrc, 'onChange={(nextText, selection, historyPayload)', 'onCopy=');
  assert.ok(onChange.includes('isProgrammaticDictationEdit()'));
  assert.ok(onChange.includes('disarmDictationChipsForTab(tabId)'));
});

test('resolve replaces the marker where it sits and fires auto-send only when nothing is pending', () => {
  const resolve = between(panelSrc, 'const resolveChip = (event: Event)', "window.addEventListener('history-panel:resolve-dictation-chip'");
  assert.ok(resolve.includes('resolveDictationMarker({ text: currentText, chipId, replacement })'));
  assert.ok(resolve.includes('runProgrammaticDictationEdit'));
  assert.ok(resolve.includes('dropDictationChip(chipId)'));
  assert.ok(resolve.includes('!dictationBlocksSend(resolved.text)'));
  assert.ok(resolve.includes('dictation-chip-auto-send'));
  // Deleted marker = user cancelled: late text must NOT be re-added.
  assert.ok(resolve.includes("{ resolved: false, reason: 'marker-deleted' }"));
});

test('insert lands at the caret through the atomic snapshot helper', () => {
  const insert = between(panelSrc, 'const insertChip = (event: Event)', "window.addEventListener('history-panel:insert-dictation-chip'");
  assert.ok(insert.includes('insertComposerSnapshotAtSelection'));
  assert.ok(insert.includes('buildDictationMarker(detail.chipId)'));
  assert.ok(insert.includes('settle?.(true)'));
});

test('error/stale chip click retries through the Voice Record client', () => {
  const click = between(panelSrc, "if (token.id.startsWith('dictation:'))", 'return false;');
  assert.ok(click.includes('retryVoiceRecordDictation(chipId)'));
  assert.ok(click.includes("setDictationChipStatus(chipId, 'pending')"));
});

test('bridge begin: composer-focus proof, registry entry, and rollback on failed insert', () => {
  const begin = between(appSrc, "if (action === 'dictationChipBegin')", "if (action === 'dictationChipResolve')");
  assert.ok(begin.includes('resolveFocusedTerminalSelection'));
  assert.ok(begin.includes('composerHost.contains(active)'));
  assert.ok(begin.includes('beginDictationChip({'));
  assert.ok(begin.includes('dropDictationChip(chipId)'), 'failed insert must not leave a registry orphan');
});

test('HTTP endpoints exist and validate the chip id shape', () => {
  const beginRoute = between(webSrc, "'/api/dictation-chip/begin'", "'/api/dictation-chip/resolve'");
  assert.ok(beginRoute.includes('vr-[0-9]+'));
  assert.ok(beginRoute.includes("bridgeRequest('dictationChipBegin'"));
  const resolveRoute = between(webSrc, "'/api/dictation-chip/resolve'", 'outcome must be');
  assert.ok(resolveRoute.includes('vr-[0-9]+'));
});

test('word motion treats the dictation marker as one opaque object', () => {
  const motion = between(panelSrc, 'const handleComposerWordMotion', 'const draftImagePreviewUrls');
  assert.ok(motion.includes('dictationMarkerRanges'));
});
