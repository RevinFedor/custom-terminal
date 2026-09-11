import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as chips from './composerChips.mjs';
import { normalizeAgentLocalCommand } from './agentLocalCommand.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const mainCommands = require('../../main/agent-history-send-receipt');
const source = fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const start = source.indexOf("const rawDraftSnapshot = useUIStore.getState().historyPromptDrafts[actionTabId] || '';");
const end = source.indexOf('sendIncidentPromptText = presentationText;', start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

for (const text of ['/Users/fedor/Desktop/voice-record Описание задачи',
  '/tmp/readme.md', '/status\nexplain this example', 'ordinary text']) {
  test('actual History send retains every attached prompt for ' + JSON.stringify(text), () => {
    const sourceChips = [
      { id: 'rules', kind: 'prompt', name: 'Rules', text: 'RULES_BODY' },
      { id: 'context', kind: 'prompt', name: 'Updated file', text: 'UPDATED_BODY', contextUpdateId: 'ctx-1' },
    ];
    const result = vm.runInNewContext('(function () { ' + compiled
      + '; return { systemCommand, sendDraftChips, presentationText }; })()', {
      ...chips, actionTabId: 'T', useUIStore: { getState: () => ({
        historyPromptDrafts: { T: text }, historyPromptDraftChips: { T: sourceChips },
      }) },
    });
    assert.equal(result.systemCommand, false);
    assert.equal(result.sendDraftChips.length, 2);
    assert.ok(result.presentationText.includes('RULES_BODY'));
    assert.ok(result.presentationText.includes('UPDATED_BODY'));
    assert.ok(result.presentationText.includes('context-update-id="ctx-1"'));
    assert.ok(result.presentationText.endsWith(text));
    assert.equal(sourceChips.length, 2, 'serialization never mutates the authoring snapshot');
  });
}

for (const text of ['/compact', ' \n\t /model haiku', '/effort max']) {
  test('actual History local command leaves chips for the next ordinary message: ' + JSON.stringify(text), () => {
    const sourceChips = [{ id: 'rules', kind: 'prompt', text: 'RULES_BODY' }];
    const result = vm.runInNewContext('(function () { ' + compiled
      + '; return { systemCommand, sendDraftChips, presentationText, sourceDraftChips }; })()', {
      ...chips, actionTabId: 'T', useUIStore: { getState: () => ({
        historyPromptDrafts: { T: text }, historyPromptDraftChips: { T: sourceChips },
      }) },
    });
    assert.equal(result.systemCommand, true);
    assert.equal(result.sendDraftChips.length, 0);
    assert.equal(result.sourceDraftChips.length, 1);
    assert.equal(result.presentationText, text.trim());
  });
}

test('renderer, main receipt and composer use one local-command grammar', () => {
  for (const text of [null, '', '/compact', '/Users/fedor/file', '/status\nexplain',
    '//text', 'text /model', '/custom-command arguments', ' \n /effort max']) {
    const expected = normalizeAgentLocalCommand(text) !== null;
    assert.equal(chips.isTerminalOnlyComposerDraft(text), expected);
    assert.equal(mainCommands.isLocalSlashCommandPrompt(text), expected);
  }
});
