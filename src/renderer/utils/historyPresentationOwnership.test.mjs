import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceHistoryPresentationProof,
  createHistoryPresentationProof,
  historyPresentationOwnsWrite,
} from './historyPresentationOwnership.mjs';

test('a dormant mounted History cannot commit a visible-visit write', () => {
  const visible = createHistoryPresentationProof(true);
  const dormant = advanceHistoryPresentationProof(visible, false);

  assert.equal(dormant.visit, visible.visit, 'hiding does not invent a visit');
  assert.equal(historyPresentationOwnsWrite(dormant, visible.visit), false);
});

test('a return gets a new visit and rejects delayed work from before the hide', () => {
  const first = createHistoryPresentationProof(true);
  const dormant = advanceHistoryPresentationProof(first, false);
  const second = advanceHistoryPresentationProof(dormant, true);

  assert.equal(second.visit, first.visit + 1);
  assert.equal(second.resumes, 1);
  assert.equal(historyPresentationOwnsWrite(second, first.visit), false);
  assert.equal(historyPresentationOwnsWrite(second, second.visit), true);
});

test('a background-prewarmed History gets its first visit only when shown', () => {
  const cold = createHistoryPresentationProof(false);
  const shown = advanceHistoryPresentationProof(cold, true);

  assert.equal(cold.visit, 0);
  assert.equal(shown.visit, 1);
  assert.equal(shown.resumes, 1);
});
