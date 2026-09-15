'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createCodexSettingsSendRuntime } = require('./codex-settings-send');
const { createCodexLiveSettingsObserver } = require('./codex-live-settings');

for (const churn of [false, true]) test('settings read observes provider movement across await, churn=' + churn, async () => {
  const terminal = {}; let model = 'A', version = 1, reads = 0, pastes = 0;
  const selected = [];
  const scope = () => ({ terminal, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1,
    live: true, ownerId: 'S', settingsObservationKey: JSON.stringify(['S', model, 'high', version]) });
  const runtime = createCodexSettingsSendRuntime({
    readScope: scope,
    readSettings: async () => {
      const result = { ownerId: 'S', model, effort: 'high' };
      if (++reads === 1 || churn) { model = model === 'A' ? 'B' : 'A'; version++; }
      return result;
    },
    withSettingsQueue: run => run(), withWriteLock: (_term, run) => run({}),
    selectSettings: async (_sender, request) => { selected.push(request.model); return { success: true,
      applied: true, model: request.model, effort: request.effort, applicationProofSource: 'fixture-picker' }; },
    paste: async () => { pastes++; return { submitted: true }; },
  });
  const result = await runtime.sendPrompt({ tabId: 'T', model: 'A', effort: 'high', content: 'prompt' });
  assert.equal(reads, 2);
  if (churn) { assert.equal(result.code, 'codex_settings_observation_changed'); assert.equal(pastes, 0); }
  else { assert.deepEqual(selected, ['A']); assert.equal(pastes, 1); }
});

test('remembered picker result cannot acquire a newer conflicting observation key; same current pair is allowed', () => {
  const terminal = {}; let key = JSON.stringify(['S', 'A', 'high', 1]);
  const scope = () => ({ terminal, lifecycleGeneration: 'G', runSeq: 1, inputRevision: 1,
    live: true, ownerId: 'S', settingsObservationKey: key });
  const runtime = createCodexSettingsSendRuntime({ readScope: scope });
  const before = scope(); const proof = { success: true, model: 'A', effort: 'high', applicationProofSource: 'fixture' };
  key = JSON.stringify(['S', 'B', 'high', 2]); assert.equal(runtime.rememberApplied('T', proof, before), false);
  key = JSON.stringify(['S', 'A', 'high', 3]); assert.equal(runtime.rememberApplied('T', proof, before), true);
});

test('actual main picker late return cannot poison subsequent actual settings+Send cache', async () => {
  const filename = path.join(__dirname, 'codex-settings-send.integration.test.js');
  const text = fs.readFileSync(filename, 'utf8'); const end = text.indexOf("test('actual picker measures");
  assert.ok(end > 0);
  const fixture = new Module(filename, module);
  fixture.filename = filename; fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  fixture._compile(text.slice(0, end) + '\nmodule.exports=harness;', filename);
  const h = await fixture.exports();
  const observer = createCodexLiveSettingsObserver({
    capture: () => ({ terminal: h.terminals.get('tab'), runSeq: 2, lifecycleGeneration: 'generation',
      live: true, ownerId: 'writer', sessionId: 'writer' }), publish() {}, now: () => Date.now() + 100,
  });
  h.context.codexLiveSettingsObserver = observer;
  h.set({ afterSelection: () => {
    h.set({ model: 'gpt-reserve', effort: 'high', afterSelection: null });
    observer.observe('tab', { valid: true, seq: 1, text: '› Ask Codex to do anything\ngpt-reserve high · Context 42% used' });
  } });
  const chosen = await h.context.executeCodexSelectModelEffortRequest({}, { tabId: 'tab', model: 'requested-model', effort: 'high' });
  assert.equal(chosen.model, 'requested-model'); assert.equal(observer.read('tab').model, 'gpt-reserve');
  const result = await h.direct({ model: 'requested-model', effort: 'high' });
  assert.equal(result.submitted, true);
  assert.equal(h.events.filter(event => event.kind === 'settings').length, 2);
  assert.equal(h.events.find(event => event.kind === 'prompt').model, 'requested-model');
});
