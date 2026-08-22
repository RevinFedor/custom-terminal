import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { joinPromptInsertionText } from '../../utils/promptInsertMenuModel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'PromptPickerOverlay.tsx'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('prompt row contextmenu is inert and suppresses the native menu before resolving', () => {
  const handler = between('const handleCopyPrompt = useCallback', 'const handleSelectScript');
  const preventAt = handler.indexOf('event.preventDefault()');
  const stopAt = handler.indexOf('event.stopPropagation()');
  const awaitAt = handler.indexOf('await resolvePromptInsertion(prompt)');

  assert.ok(preventAt >= 0 && preventAt < awaitAt, 'preventDefault must run synchronously');
  assert.ok(stopAt >= 0 && stopAt < awaitAt, 'stopPropagation must run synchronously');
  assert.doesNotMatch(
    handler,
    /setSelectedKey|setSelectedPromptIdx|setPickerLevel|setSelectedRoot|handleSelectPrompt\(|closePicker\(/,
    'right-click must not select, activate, or close a prompt row',
  );

  const rowHandlers = source.match(
    /onContextMenu=\{\(event\) => \{ void handleCopyPrompt\(event, (?:item\.prompt|p)\); \}\}/g,
  ) || [];
  assert.equal(rowHandlers.length, 3, 'every prompt-row render path must wire the inert contextmenu handler');
});

test('clipboard receives the exact shared resolved prompt text, never a path/reference variant', () => {
  const resolver = between('async function resolvePromptInsertion', 'function promptFeedbackKey');
  const delivery = between('async function deliverPrompt', '// SDK composer textarea.');
  const handler = between('const handleCopyPrompt = useCallback', 'const handleSelectScript');

  assert.match(resolver, /const fileContents = await readPromptFileContents\(prompt\.file_paths\);/);
  assert.match(resolver, /assembledText: joinPromptInsertionText\(promptText, fileContents\)/);
  assert.match(delivery, /const resolved = await resolvePromptInsertion\(prompt\);/);
  assert.match(delivery, /const chipText = resolved\.assembledText;/);
  assert.match(handler, /const resolved = await resolvePromptInsertion\(prompt\);/);
  assert.match(handler, /clipboard\.writeText\(resolved\.assembledText\);/);
  assert.doesNotMatch(handler, /buildPromptFilePathText|prepareFilePathInsertion|navigator\.clipboard/);
  assert.match(source, /const \{ clipboard, ipcRenderer \} = window\.require\('electron'\);/);

  assert.equal(
    joinPromptInsertionText('Prompt body', ['resolved file A', '', 'resolved file B']),
    'Prompt body\n\nresolved file A\n\nresolved file B',
    'the shared assembly preserves the exact body/file ordering copied by the handler',
  );
});

test('copy feedback reuses a permanent trailing slot and restarts its fade timers', () => {
  const timers = between('const clearCopyFeedbackTimers', '// Cmd is the reference-insert modifier.');
  const handler = between('const handleCopyPrompt = useCallback', 'const handleSelectScript');
  const slot = between('const renderPromptTrailingSlot', 'const placeholderStyle');

  assert.match(timers, /clearCopyFeedbackTimers\(\);[\s\S]*\+\+copyFeedbackSeqRef\.current/);
  assert.match(timers, /window\.clearTimeout\(copyFadeTimerRef\.current\)/);
  assert.match(timers, /window\.clearTimeout\(copyClearTimerRef\.current\)/);
  assert.match(timers, /COPY_FEEDBACK_HOLD_MS \+ COPY_FEEDBACK_FADE_MS/);
  assert.ok(
    handler.indexOf('clipboard.writeText(resolved.assembledText)')
      < handler.indexOf('restartCopyFeedback(promptFeedbackKey(prompt))'),
    'feedback must only start after Electron accepts the clipboard write',
  );

  assert.match(slot, /data-prompt-trailing-icon-slot/);
  assert.match(slot, /data-prompt-copy-feedback=\{feedback\.fading \? 'fading' : 'visible'\}/);
  assert.match(slot, /<Copy/);
  assert.match(slot, /color: '#22c55e'/);
  assert.match(slot, /opacity: feedback\.fading \? 0 : 1/);
  assert.match(slot, /transform: feedback\.fading \? 'scale\(0\.82\)' : 'scale\(1\)'/);
  assert.match(slot, /willChange: 'opacity, transform'/);
  assert.match(slot, /aria-label="Full prompt copied"/);
  assert.doesNotMatch(slot, /if \(!promptHasFileReferences\(prompt\)\) return null/);

  const renderedSlots = source.match(/\{renderPromptTrailingSlot\((?:item\.prompt|p)\)\}/g) || [];
  assert.equal(renderedSlots.length, 3, 'all prompt rows reserve the same trailing feedback slot');
});
