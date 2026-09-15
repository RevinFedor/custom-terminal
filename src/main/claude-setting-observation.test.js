'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClaudeSettingObservation, compareClaudeSettingObservation,
  parseClaudeObservedModelValue } = require('./claude-setting-observation');

function record(body, carrier = 'user') {
  const content = '<local-command-stdout>' + body + '</local-command-stdout>';
  return carrier === 'user' ? { type: 'user', message: { role: 'user', content } }
    : { type: 'system', subtype: 'local_command', content };
}

function model(body, requested, options) {
  return parseClaudeSettingObservation(record(body), { kind: 'model', value: requested }, options);
}

test('both real stdout carriers report the observation, never the requested model', () => {
  for (const carrier of ['user', 'system']) {
    const result = parseClaudeSettingObservation(record('Set model to Sonnet 5', carrier), {
      kind: 'model', value: 'claude-fable-5[1m]',
    });
    assert.equal(result.recognized, true);
    assert.equal(result.kind, 'model');
    assert.equal(result.actualValue, 'Sonnet 5');
    assert.equal(result.requestedValue, 'claude-fable-5[1m]');
    assert.deepEqual(result.observed, { label: 'Sonnet 5', modelId: null, contextTokens: null });
    assert.equal(result.requestSatisfied, false);
    assert.equal(result.mismatch.reason, 'model-family-mismatch');
  }
});

test('installed Fable label does not invent its context from the catalog or requested suffix', () => {
  const result = model('Set model to `Fable 5` and saved as your default for new sessions', 'claude-fable-5[1m]');
  assert.equal(result.actualValue, 'Fable 5');
  assert.equal(result.observed.modelId, null);
  assert.equal(result.observed.contextTokens, null);
  assert.equal(result.requestSatisfied, null);
  assert.equal(result.mismatch.reason, 'context-unobserved');
  assert.equal(result.mismatch.components.find(item => item.component === 'model').satisfied, true);
  assert.equal(result.mismatch.components.find(item => item.component === 'context').satisfied, null);
});

test('model family and complete versions do not collapse to prefix matches', () => {
  const cases = [
    ['Fable 5.1', 'claude-fable-5', false],
    ['Fable 5', 'claude-fable-5-1', false],
    ['Opus 4.8', 'claude-opus-4-7', false],
    ['Opus 5', 'claude-opus-4-8', false],
    ['Sonnet 5', 'claude-opus-5', false],
    ['Fable 5 Preview', 'claude-fable-5', null],
    ['Fable 50', 'claude-fable-5', false],
    ['Fable 5', 'claude-fable-5', true],
    ['Fable 5.1', 'claude-fable-5-1', true],
    ['Claude 3.5 Sonnet', 'claude-3-5-sonnet-20241022', null],
    ['Haiku 4.5', 'claude-haiku-4-5-20251001', null],
  ];
  for (const [label, requested, satisfied] of cases) {
    assert.equal(model('Set model to ' + label, requested).requestSatisfied, satisfied, label + ' versus ' + requested);
  }
});

test('explicit context annotations are independent from version and are never inferred when missing', () => {
  for (const annotation of ['(1M context)', '(1m context)', '(1000K context)', '(1,000,000 token context)', '(context: 1000000 tokens)', '[1m]']) {
    const result = model('Set model to Opus 5 ' + annotation, 'claude-opus-5[1m]');
    assert.equal(result.observed.contextTokens, 1000000, annotation);
    assert.equal(result.requestSatisfied, true, annotation);
  }
  const insufficient = model('Set model to Opus 5 (200K context)', 'claude-opus-5[1m]');
  assert.equal(insufficient.observed.contextTokens, 200000);
  assert.equal(insufficient.requestSatisfied, false);
  assert.equal(insufficient.mismatch.reason, 'context-mismatch');
  assert.equal(model('Set model to Opus 5', 'claude-opus-5[1m]').requestSatisfied, null);
  const conflict = model('Set model to Opus 5[1m] (200K context)', 'claude-opus-5[1m]');
  assert.equal(conflict.observed.contextTokens, null);
  assert.equal(conflict.requestSatisfied, null);
  assert.equal(conflict.mismatch.reason, 'context-observation-conflict');
  assert.equal(model('Set model to custom[1m]-route', 'custom[1m]-route').observed.contextTokens, null);
  assert.equal(model('Set model to My 1M Model', 'custom').observed.contextTokens, null);
});

test('startup restoration and stdout observation share the complete display-label grammar', () => {
  assert.deepEqual(parseClaudeObservedModelValue('Sonnet 4.5 (1M context window)'), {
    family: 'sonnet', version: '4.5', release: null, modelId: null,
    contextTokens: 1000000, contextConflicting: false,
  });
  assert.deepEqual(parseClaudeObservedModelValue('Haiku 4.5 (200K context)'), {
    family: 'haiku', version: '4.5', release: null, modelId: null,
    contextTokens: 200000, contextConflicting: false,
  });
  assert.equal(parseClaudeObservedModelValue('My private route'), null);
});

test('ANSI, NBSP, saved/default/session-only, effort and Fast text do not contaminate the model', () => {
  const cases = [
    'Set model to \u001b[1mOpus\u00a05 (1M context)\u001b[22m and saved as your default for new sessions',
    'Set model to `Opus 5 (1M context)` for this session only · Fast mode ON',
    'Set model to ``Opus 5 (1M context)`` (this session only) (effort: xhigh) · Fast mode OFF',
    'Set model to Opus 5 (1M context) (effort: high) · Fast mode ON · Draws from usage credits',
    'Set model to Opus 5 (1M context) (default) for this session only',
    'Set model to `Opus 5 (1M context) (default)` for this session only',
    'Set model to `Opus 5` (1M context) for this session only',
    'Set model to Opus 5 (1M context) · couldn\'t save it as your default: settings.json is not valid JSON',
    'Set model to \u001b]8;;https://example.invalid/model\u0007Opus 5 (1M context)\u001b]8;;\u0007 and saved as your default for new sessions',
  ];
  for (const body of cases) {
    const result = model(body, 'claude-opus-5[1m]');
    assert.equal(result.observed.label, 'Opus 5 (1M context)', body);
    assert.equal(result.observed.modelId, null);
    assert.equal(result.observed.contextTokens, 1000000);
    assert.equal(result.requestSatisfied, true);
    assert.equal(result.rawOutput, record(body).message.content);
  }
  const withEffort = model(cases[2], 'claude-opus-5[1m]');
  assert.equal(withEffort.observed.effort, 'xhigh');
  assert.equal(model('Set model to `Research and saved defaults` for this session only', 'custom').observed.label,
    'Research and saved defaults');
});

test('a separate ANTHROPIC_MODEL reminder never supplies the current model, ID, effort or context', () => {
  for (const separator of ['\n', '\r\n', ' ']) {
    const body = 'Set model to `Fable 5` and saved as your default for new sessions' + separator
      + 'ANTHROPIC_MODEL is set to `claude-opus-5[1m]` (effort: max) — new sessions use that while it is set';
    const result = model(body, 'claude-fable-5[1m]');
    assert.deepEqual(result.observed, { label: 'Fable 5', modelId: null, contextTokens: null });
    assert.equal(result.requestSatisfied, null);
    assert.match(result.outputText, /ANTHROPIC_MODEL is set to/);
    assert.match(result.rawOutput, /claude-opus-5\[1m\]/);
  }
  const withoutSaved = model('Set model to Fable 5\nANTHROPIC_MODEL is set to Opus 5 (1M context)', 'claude-fable-5[1m]');
  assert.equal(withoutSaved.observed.label, 'Fable 5');
  assert.equal(withoutSaved.observed.contextTokens, null);
});

test('only explicit IDs become observed.modelId; label identity does not synthesize an ID', () => {
  for (const label of ['claude-opus-5', '`claude-opus-5`', 'Opus 5 (model ID: claude-opus-5)', 'Opus 5 (`claude-opus-5`)']) {
    const result = model('Set model to ' + label, 'claude-opus-5');
    assert.equal(result.observed.modelId, 'claude-opus-5', label);
    assert.equal(result.actualValue, 'claude-opus-5');
    assert.equal(result.requestSatisfied, true);
  }
  const suffix = model('Set model to `claude-opus-5[1m]`', 'claude-opus-5[1m]');
  assert.equal(suffix.actualValue, 'claude-opus-5');
  assert.equal(suffix.observed.contextTokens, 1000000);
  assert.equal(suffix.requestSatisfied, true);
  assert.equal(model('Set model to Opus 5', 'claude-opus-5').observed.modelId, null);
  const dated = model('Set model to claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20241022');
  assert.equal(dated.requestSatisfied, true);
  assert.equal(model('Set model to claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620').requestSatisfied, false);
});

test('aliases, default and custom labels do not imply exact resolution even on a textual match', () => {
  const cases = [
    ['Opus 5', 'opus'], ['Sonnet 5', 'opus'], ['Fable 5.1', 'fable'],
    ['Opus 5 (default)', 'default'], ['Fable 5', 'best'], ['Opus Plan', 'opusplan'],
    ['My Model', 'My Model'], ['my-deployment', 'my-deployment'],
    ['claude-custom-route', 'claude-custom-route'],
    ['Opus 5', 'my-gateway/claude-opus-5'],
  ];
  for (const [label, requested] of cases) {
    assert.equal(model('Set model to ' + label, requested).requestSatisfied, null, requested);
  }
  const unresolvedAlias = model('Set model to Opus 5 (1M context)', 'opus[1m]');
  assert.equal(unresolvedAlias.observed.contextTokens, 1000000);
  assert.equal(unresolvedAlias.requestSatisfied, null);
  assert.equal(model('Set model to Opus 5 (200K context)', 'opus[1m]').requestSatisfied, false);
});

test('supplied exact resolution is compared without ever writing expected data into observed fields', () => {
  const known = model('Set model to Opus 5', 'opus', { resolvedRequest: { modelId: 'claude-opus-5' } });
  assert.equal(known.requestSatisfied, true);
  assert.equal(known.observed.modelId, null);
  const unknownContext = model('Set model to Fable 5', 'fable', {
    resolvedRequest: { modelId: 'claude-fable-5', contextTokens: 1000000 },
  });
  assert.equal(unknownContext.requestSatisfied, null);
  assert.equal(unknownContext.observed.contextTokens, null);
  const custom = model('Set model to My Model (model ID: route-blue)', 'custom', { resolvedRequest: { modelId: 'route-blue' } });
  assert.equal(custom.requestSatisfied, true);
  assert.equal(custom.observed.modelId, 'route-blue');
  assert.equal(custom.actualValue, 'route-blue');
  const labelOnly = model('Set model to My Model', 'custom', { resolvedRequest: { modelId: 'route-blue' } });
  assert.equal(labelOnly.requestSatisfied, null);
  assert.equal(labelOnly.observed.modelId, null);
});

test('effort is parsed as a whole exact token, including interactive pickers', () => {
  for (const carrier of ['user', 'system']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      const body = 'Set effort level to `' + effort.toUpperCase() + '` (this session only)';
      const result = parseClaudeSettingObservation(record(body, carrier), { kind: 'effort', value: effort });
      assert.equal(result.actualValue, effort);
      assert.equal(result.observed.effort, effort);
      assert.equal(result.observed.modelId, null);
      assert.equal(result.requestSatisfied, true);
    }
  }
  const changed = parseClaudeSettingObservation(record('Set effort level to high (saved as your default for new sessions)'), { kind: 'effort', value: 'max' });
  assert.equal(changed.actualValue, 'high');
  assert.equal(changed.requestSatisfied, false);
  assert.equal(changed.mismatch.reason, 'effort-mismatch');
  const picker = parseClaudeSettingObservation(record('Set effort level to xhigh'), { kind: 'effort', value: '' });
  assert.equal(picker.actualValue, 'xhigh');
  assert.equal(picker.requestSatisfied, null);
  assert.equal(parseClaudeSettingObservation(record('Set effort level to highly'), { kind: 'effort', value: 'high' }).requestSatisfied, false);
  assert.equal(parseClaudeSettingObservation(record('Set effort level to high+'), { kind: 'effort', value: 'high' }), null);
});

test('unsupported carriers, stderr, wrapper arguments and non-affirmative output do not become observations', () => {
  const content = '<local-command-stdout>Set model to Opus 5</local-command-stdout>';
  const inputs = [
    { type: 'assistant', message: { content } },
    { type: 'system', subtype: 'other', content },
    { type: 'user', message: { content: '<local-command-stderr>Set model to Opus 5</local-command-stderr>' } },
    { type: 'user', message: { content: '<command-name>/model</command-name><command-args>claude-opus-5</command-args>' } },
    record('Unable to validate model: API error: 429'),
    record('Kept model as Opus 5'),
    record('Current model: Opus 5'),
    record('ANTHROPIC_MODEL is set to Opus 5 (1M context)'),
    record('Set model to '),
    record('Set model to <local-command-stdout>Sonnet 5</local-command-stdout>'),
    null,
  ];
  for (const input of inputs) assert.equal(parseClaudeSettingObservation(input, { kind: 'model', value: 'claude-opus-5' }), null);
  const wrongKind = parseClaudeSettingObservation(record('Set effort level to max'), { kind: 'model', value: 'claude-opus-5' });
  assert.equal(wrongKind.requestSatisfied, false);
  assert.equal(wrongKind.mismatch.reason, 'setting-kind-mismatch');
});

test('standalone comparison accepts an authoritative observed ID/context DTO without mutating it', () => {
  const observed = Object.freeze({ label: 'Fable 5', modelId: 'claude-fable-5', contextTokens: 1000000 });
  const result = compareClaudeSettingObservation({ kind: 'model', value: 'claude-fable-5[1m]' }, observed);
  assert.equal(result.requestSatisfied, true);
  assert.equal(result.mismatch, null);
  assert.deepEqual(observed, { label: 'Fable 5', modelId: 'claude-fable-5', contextTokens: 1000000 });
});
