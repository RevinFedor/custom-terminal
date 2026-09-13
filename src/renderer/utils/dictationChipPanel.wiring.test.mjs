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
const toastSrc = fs.readFileSync(path.join(here, '../components/UI/Toast.tsx'), 'utf8');
const queueSrc = fs.readFileSync(path.join(here, '../components/Workspace/PromptQueueOverlay.tsx'), 'utf8');
const runnerSrc = fs.readFileSync(path.join(here, '../hooks/usePromptQueueRunner.ts'), 'utf8');
const backgroundChipSrc = fs.readFileSync(path.join(here, '../components/UI/BackgroundTabOperationChip.tsx'), 'utf8');

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

test('Option+1 in History is the canonical send intent for pending and ready text', () => {
  const keydown = between(panelSrc, 'const optionAutoEnter = isDictationAutoEnterShortcut(e);', 'onSelectionChange={(selection) => {');
  assert.ok(keydown.includes('isDictationAutoEnterShortcut(e)'));
  assert.ok(keydown.includes("source: 'option-1-auto-enter'"));
  assert.ok(keydown.includes("new CustomEvent('history-panel:submit-composer'"));
  assert.ok(keydown.includes('stopImmediatePropagation'),
    'Option+1 must not insert the layout-transformed printable character');
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
  assert.ok(resolve.includes('!dictationBlocksSend(inserted.text)'));
  assert.ok(resolve.includes('dictation-chip-auto-send'));
  // Deleted marker = user cancelled: late text must NOT be re-added.
  assert.ok(resolve.includes("{ resolved: false, reason: 'marker-deleted' }"));
});

test('resolve keeps the USER caret: live selection is remapped across the replacement', () => {
  const resolve = between(panelSrc, 'const resolveChip = (event: Event)', "window.addEventListener('history-panel:resolve-dictation-chip'");
  // The caret may have been moved while the tail was committing — never
  // force it to the end of the resolved text.
  assert.ok(resolve.includes('remapPromptImageSelectionAfterReplacement'));
  assert.ok(resolve.includes('editor.isFocused()'));
  assert.ok(resolve.includes('selectionStart: selection.start'));
  assert.ok(resolve.includes('selectionEnd: selection.end'));
  assert.ok(!resolve.includes('selectionStart: resolved.caret'),
    'the old force-to-end selection write must be gone');
});

test('progress bridge action is registry-only (label), never a draft write', () => {
  const progress = between(appSrc, "if (action === 'dictationChipProgress')", "if (action === 'dictationChipResolve')");
  assert.ok(progress.includes('updateDictationChipLabel'));
  assert.ok(!progress.includes('setHistoryPromptDraft'), 'progress must not touch draft text');
  const route = between(webSrc, "'/api/dictation-chip/progress'", "'/api/ios/push-token'");
  assert.ok(route.includes('vr-[0-9]+'));
  assert.ok(route.includes("bridgeRequest('dictationChipProgress'"));
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
  assert.ok(begin.includes("window.addEventListener('focusin', onFocusIn, true)"),
    'finish-before-focus must wait on the concrete composer focus edge');
  assert.ok(begin.includes('composer-focus-timeout'));
});

test('late Voice Record auto-send updates the visible chip and resolve repeats it atomically', () => {
  const update = between(appSrc, "if (action === 'dictationChipAutoSend')", "if (action === 'dictationChipResolve')");
  assert.ok(update.includes('updateDictationChipAutoSendFromVoice(chipId, armed)'));
  assert.ok(update.includes("entry.surface === 'run-after'"),
    'Run After must keep ownership of its own timing');
  const resolve = between(appSrc, "if (action === 'dictationChipResolve')", "if (action === 'getOpenProjectIds')");
  assert.ok(resolve.includes("typeof payload?.autoSend === 'boolean'"));
  assert.ok(resolve.includes("entry.surface !== 'run-after'"));
});

test('Run After takes ownership of unresolved dictation and cannot send the raw marker', () => {
  const grab = between(queueSrc, 'const enqueueGrabbedPrompt', '// Exactly the same authoring clipboard contract');
  assert.ok(grab.includes('moveDictationChipsToRunAfter'));
  const addAt = grab.indexOf('const id = addPrompt');
  const moveAt = grab.indexOf('moveDictationChipsToRunAfter');
  const titleAwaitAt = grab.indexOf('await findSavedInsertPromptTitle');
  assert.ok(addAt >= 0 && moveAt > addAt && titleAwaitAt > moveAt,
    'queue item and pending-chip ownership must commit before async title lookup');
  const detachedTitleAt = grab.indexOf('void (async () => {');
  assert.ok(detachedTitleAt > moveAt,
    'title lookup must be detached so History can CAS-clear immediately');
  const transferCode = grab.slice(0, detachedTitleAt)
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\bawait\b/.test(transferCode),
    'the transfer boundary must not await presentation work');
  const gate = between(runnerSrc, 'function beginValidatedQueueSend', 'queueSendInflight.add(ownerTabId)');
  assert.ok(gate.includes('dictationBlocksSend(headAtStart.text)'));
  assert.ok(gate.includes('deferredDictationSends.set'));
  assert.ok(runnerSrc.includes('signalPromptQueueDictationResolved'));
  const resolve = between(appSrc, "if (action === 'dictationChipResolve')", "if (action === 'getOpenProjectIds')");
  assert.ok(resolve.includes("entry.surface === 'run-after'"));
  assert.ok(resolve.includes('queueStore.updatePrompt'));
  assert.ok(resolve.includes('signalPromptQueueDictationResolved'));
});

test('dictation resolve materializes portable image paths before publishing text', () => {
  const resolve = between(appSrc, "if (action === 'dictationChipResolve')", "if (action === 'getOpenProjectIds')");
  assert.ok(resolve.includes("'prompt-queue:materialize-image-refs'"));
  assert.ok(resolve.includes('buildPortableImageImportSnapshot'));
  assert.ok(resolve.includes('insertPromptImageAttachments'));
  const paste = between(panelSrc, 'const handleComposerImagePaste', 'const restoreChipToComposer');
  assert.ok(paste.indexOf('collectPortableImagePathMarkers') < paste.indexOf('isElectronDictationClipboardPayload'),
    'a mixed dictation must classify portable images before the pure-text bypass');
});

test('HTTP endpoints exist and validate the chip id shape', () => {
  const beginRoute = between(webSrc, "'/api/dictation-chip/begin'", "'/api/dictation-chip/resolve'");
  assert.ok(beginRoute.includes('vr-[0-9]+'));
  assert.ok(beginRoute.includes("bridgeRequest('dictationChipBegin'"));
  const resolveRoute = between(webSrc, "'/api/dictation-chip/resolve'", 'outcome must be');
  assert.ok(resolveRoute.includes('vr-[0-9]+'));
  const autoSendRoute = between(webSrc, "'/api/dictation-chip/auto-send'", '// Live tail of a still-committing take');
  assert.ok(autoSendRoute.includes("bridgeRequest('dictationChipAutoSend'"));
  assert.ok(autoSendRoute.includes('armed must be boolean'));
});

test('word motion treats the dictation marker as one opaque object', () => {
  const motion = between(panelSrc, 'const handleComposerWordMotion', 'const draftImagePreviewUrls');
  assert.ok(motion.includes('dictationMarkerRanges'));
});

test('background chips of a HIDDEN tab surface in the app corner, by window visibility', () => {
  const status = between(toastSrc, 'function DictationChipBackgroundStatus', '\n}\n');
  // "Is the tab on screen" is the History-operations answer (pane-aware),
  // NOT `effectiveTabId` focus — a visible-but-unfocused pane must not spawn
  // a corner loader.
  assert.ok(status.includes('historyOperationOwnerView'));
  assert.ok(status.includes('owner.visible || !owner.exists'));
  assert.ok(status.includes('openHistoryOperationOwner'));
  // The RECORDING loader follows the same visibility answer.
  const rec = between(toastSrc, 'function DictationBackgroundStatus', '\n}\n');
  assert.ok(rec.includes('historyOperationOwnerView'));
  assert.ok(!rec.includes('getEffectiveTabId()'),
    'focus-based visibility must be gone from the recording loader');
});

test('hidden dictation completion gets a sub-second green check presentation', () => {
  const status = between(toastSrc, 'function DictationChipBackgroundStatus', '\n}\n');
  assert.ok(status.includes("'ГОТОВО'"));
  assert.ok(status.includes('completed={row.pending === 0'));
  assert.ok(backgroundChipSrc.includes("completed ? '#4ade80'"));
  assert.ok(backgroundChipSrc.includes("data-background-tab-operation-state={completed ? 'completed'"));
});
