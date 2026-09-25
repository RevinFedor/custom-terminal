import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL_OPTIONS, GEMINI_LEGACY_MODEL_OPTIONS,
  isGeminiModelId, legacyGeminiModelLabel } from './geminiModels.ts';

test('system prompt picker offers the current documented text models in the established order', () => {
  assert.deepEqual(GEMINI_MODEL_OPTIONS.map(model => model.value), [
    'gemini-3.8-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview', 'gemini-3.7-flash',
  ]);
  assert.deepEqual(GEMINI_MODEL_OPTIONS.map(model => model.label), [
    'Flash 3.8', 'Flash-Lite 3.5', 'Pro 3.1', 'Flash 3.7',
  ]);
});

test('saved older model choices remain readable without becoming new picker options', () => {
  const current = new Set(GEMINI_MODEL_OPTIONS.map(model => model.value));
  for (const model of GEMINI_LEGACY_MODEL_OPTIONS) {
    assert.equal(isGeminiModelId(model.value), true);
    assert.equal(current.has(model.value), false);
    assert.equal(legacyGeminiModelLabel(model.value), model.label);
  }
  assert.equal(legacyGeminiModelLabel('gemini-3.8-flash'), null);
  assert.equal(isGeminiModelId('gemini-unknown'), false);
});
