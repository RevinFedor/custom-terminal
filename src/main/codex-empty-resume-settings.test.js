'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planCodexCommandLaunchSettings } = require('./codex-runtime-contract');
const choice = { command: 'codex-c', sessionId: 'empty-source', model: 'gpt-5.6-luna', effort: 'medium',
  modelSource: 'tab-or-explicit', effortSource: 'tab-or-explicit',
  sourceSettingsStatus: 'absent', sourceMetadata: { id: 'empty-source', history_mode: 'legacy' },
  sourceMaterialization: { metadataOnly: true, userRecords: 0 } };

test('restart of an unused standalone session reuses its durable complete tab choice as intent, not a forged settings proof', () => {
  const result = planCodexCommandLaunchSettings(choice);
  assert.equal(result.allowed, true);
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.effort, 'medium');
  assert.equal(result.settingsSource, 'resume-empty-tab-choice');
});

test('empty-source recovery never launders real/inherited history, corrupt settings or global fallback', () => {
  for (const delta of [
    { command: 'codex-f' },
    { sourceMetadata: null },
    { sourceMetadata: { id: 'foreign' } },
    { sourceMetadata: { id: 'empty-source', forked_from_id: 'parent' } },
    { sourceMetadata: { id: 'empty-source', history_base: {} } },
    { sourceMetadata: { id: 'empty-source', history_mode: 'paginated' } },
    { sourceMetadata: { id: 'empty-source', history_mode: 'future-format' } },
    { sourceMaterialization: { metadataOnly: false, userRecords: 2 } },
    { sourceMaterialization: { metadataOnly: true, userRecords: 2 } },
    { sourceSettingsStatus: 'invalid' },
    { modelSource: 'global' },
    { effortSource: 'global' },
    { effort: '' },
    { model: '' },
  ]) assert.equal(planCodexCommandLaunchSettings({ ...choice, ...delta }).allowed, false, JSON.stringify(delta));
});

test('main supplies physical metadata and keeps the recovered pair pending until the real TUI accepts it', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('const commandSettings = planCodexCommandLaunchSettings(');
  const call = main.slice(start, main.indexOf('\n  });', start));
  assert.match(call, /sourceMetadata: sourceMetadataForLaunch/);
  assert.match(call, /sourceMaterialization/);
  assert.match(main, /sourceMetadataForLaunch = loaded\?\.success[\s\S]{0,180}find\(\(record\) => record\?\.type === 'session_meta'\)/);
  assert.match(main, /settingsIntent: \(preferRequestedSettings\s*\|\| commandSettings\.settingsSource === 'resume-empty-tab-choice'/);
});
