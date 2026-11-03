'use strict';
// The next launch injected `/model Opus 5` and Claude answered
// `Model 'Opus5' not found`.
//
// 03.11, tab 5b20bf267cca, launch-14. Picking a model sends the runtime id —
// `/model claude-opus-5[1m]`. Claude prints a human LABEL in reply:
//
//   Set model to `Opus 5` and saved as your default for new sessions
//
// `applySetting` returns that printed label as `value` (proof.actualValue),
// and the retain step stored it as the tab's preference. On the next launch
// the stored label went back out as a command, and `Opus 5` is not an id.
//
// The label is display text. What must be retained is what we SENT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const section = (from, to) => {
  const start = main.indexOf(from);
  assert.ok(start > 0, 'anchor not found: ' + from);
  const end = main.indexOf(to, start);
  assert.ok(end > start, 'end not found: ' + to);
  return main.slice(start, end);
};

test('a single setting retains the id it sent, not the printed label', () => {
  const body = section("ipcMain.handle('claude:apply-setting'", '// Decision 01.11 (Fedor)');
  assert.match(body, /applied\.requestedValue \?\? request\.value/,
    'the sent id is the retained value');
  assert.doesNotMatch(body, /retainClaudeManualSettingChoice\(request\.tabId, \{ \[request\.kind\]: applied\.value \}/,
    'applied.value is Claude\'s printed label and must not be retained');
});

test('a model+effort pair retains both sent ids', () => {
  const body = section("ipcMain.handle('claude:apply-settings'", "ipcMain.handle('claude:send-prompt-with-settings'");
  assert.match(body, /\.\.\.\(request\.model \? \{ model: request\.model \} : \{\}\)/);
  assert.match(body, /\.\.\.\(request\.effort \? \{ effort: request\.effort \} : \{\}\)/);
  assert.doesNotMatch(body, /retainClaudeManualSettingChoice\(request\.tabId, applied\.appliedSettings/,
    'appliedSettings carries the printed labels');
});

test('an absent half is not invented', () => {
  // Changing only the effort must not retain a model, and the retain function
  // already ignores empty strings — but the caller must not pass a stray key.
  const body = section("ipcMain.handle('claude:apply-settings'", "ipcMain.handle('claude:send-prompt-with-settings'");
  assert.match(body, /request\.model \? \{ model: request\.model \} : \{\}/,
    'the model key appears only when a model was requested');
});

test('the printed label is still what observation compares against', () => {
  // The fix must not touch the proof: Claude\'s label is exactly how
  // `claude_setting_applied_different` detects a mismatch (02.11).
  const observation = fs.readFileSync(path.join(__dirname, 'claude-setting-observation.js'), 'utf8');
  assert.match(observation, /leadingModelValue/,
    'the observation still reads the printed value');
  const send = fs.readFileSync(path.join(__dirname, 'claude-settings-send.js'), 'utf8');
  assert.match(send, /value: proof\.actualValue \?\? normalizedValue, requestedValue: normalizedValue/,
    'the result keeps BOTH: the observed label and the id we sent');
});

test('retention still refuses an empty value', () => {
  const retain = section('function retainClaudeManualSettingChoice', "ipcMain.handle('claude:apply-settings'");
  assert.match(retain, /if \(!model && !effort\) return;/);
  assert.match(retain, /appliedSettings\?\.model === 'string' \? appliedSettings\.model\.trim\(\)/);
});

// ---------------------------------------------------------------------------
// Second half of the same scar: the retain fix stops NEW labels, but one was
// already stored. Tab 5b20bf267cca kept `startupModel: "Opus 5"` and failed on
// EVERY launch after the fix was installed — a repair has to cover the value
// already on disk, not only the next write.

test('a stored display label is dropped when the preference is read', () => {
  const read = section('function withoutClaudeDisplayLabelPreference', 'function setProviderState');
  assert.match(read, /\/\\s\/\.test\(model\)/, 'whitespace is what separates a label from an id');
  assert.match(read, /const \{ startupModel: _label, \.\.\.rest \} = state;/,
    'only the poisoned key is removed, the rest of the preference survives');
  assert.match(read, /getProviderState/, 'the cleanup sits on the single read point');
});

test('the cleanup cannot discard a real id or another provider', () => {
  const read = section('function withoutClaudeDisplayLabelPreference', 'function setProviderState');
  assert.match(read, /!model \|\| !\/\\s\/\.test\(model\)/,
    'an id without whitespace is returned untouched');
  assert.match(read, /state\.type && state\.type !== 'anthropic'/,
    'a Codex preference is none of this rule\'s business');
});

test('a display label is refused by the provider contract too', () => {
  const contract = require('./agent-provider-model-contract.js');
  // assert.throws matches the MESSAGE; the code lives on the error object.
  for (const label of ['Opus 5', 'Haiku 5.5']) {
    assert.throws(() => contract.assertAgentProviderModel({ provider: 'claude', model: label }),
      (error) => error.code === 'agent_model_display_label'
        && /display label, not a model id/.test(error.message), label);
  }
  // Real ids and short aliases stay valid.
  for (const model of ['claude-opus-5[1m]', 'claude-sonnet-5', 'opus', 'haiku', 'default']) {
    assert.ok(contract.assertAgentProviderModel({ provider: 'claude', model }).ok, model);
  }
});
