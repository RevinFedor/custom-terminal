import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceHistoryPresentationProof,
  createHistoryPresentationProof,
  historyPresentationOwnsWrite,
  resolveHistoryViewportPaintProof,
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

test('load-success viewport pending is consumed by the exact mount-wave painted surface', () => {
  const presentation = createHistoryPresentationProof(true);
  const result = resolveHistoryViewportPaintProof({
    currentOwnerKey: 'owner-a',
    currentGeneration: 7,
    currentPresentation: presentation,
    readyOwnerKey: '',
    proofRequired: true,
    ownerKey: 'owner-a',
    generation: 7,
    presentationVisit: presentation.visit,
    proof: 'mounted-painted-row',
    domRows: 14,
  });

  assert.deepEqual(result, {
    readyOwnerKey: 'owner-a',
    proofRequired: false,
    accepted: true,
    changed: true,
  });
});

test('shells and stale owner, generation, or presentation visits cannot clear the loader', () => {
  const first = createHistoryPresentationProof(true);
  const dormant = advanceHistoryPresentationProof(first, false);
  const second = advanceHistoryPresentationProof(dormant, true);
  const base = {
    currentOwnerKey: 'owner-b',
    currentGeneration: 4,
    currentPresentation: second,
    readyOwnerKey: '',
    proofRequired: true,
    ownerKey: 'owner-b',
    generation: 4,
    presentationVisit: second.visit,
    proof: 'mounted-painted-row',
    domRows: 8,
  };

  for (const override of [
    { ownerKey: 'owner-a' },
    { generation: 3 },
    { presentationVisit: first.visit },
    { domRows: 0 },
  ]) {
    const result = resolveHistoryViewportPaintProof({ ...base, ...override });
    assert.equal(result.accepted, false);
    assert.equal(result.readyOwnerKey, '');
    assert.equal(result.proofRequired, true);
  }
});

test('an honest painted empty state consumes viewport pending', () => {
  const presentation = createHistoryPresentationProof(true);
  const result = resolveHistoryViewportPaintProof({
    currentOwnerKey: 'empty-owner',
    currentGeneration: 2,
    currentPresentation: presentation,
    readyOwnerKey: '',
    proofRequired: true,
    ownerKey: 'empty-owner',
    generation: 2,
    presentationVisit: presentation.visit,
    proof: 'painted-empty-state',
    domRows: 0,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.readyOwnerKey, 'empty-owner');
  assert.equal(result.proofRequired, false);
});

test('repeated stable presentation visits never re-arm settled viewport readiness', () => {
  const first = createHistoryPresentationProof(true);
  const settled = resolveHistoryViewportPaintProof({
    currentOwnerKey: 'owner-a',
    currentGeneration: 9,
    currentPresentation: first,
    readyOwnerKey: '',
    proofRequired: true,
    ownerKey: 'owner-a',
    generation: 9,
    presentationVisit: first.visit,
    proof: 'mounted-painted-row',
    domRows: 3,
  });
  const dormant = advanceHistoryPresentationProof(first, false);
  const second = advanceHistoryPresentationProof(dormant, true);

  // Stable hide/show only versions presentation ownership. It does not change
  // the already-settled viewport state while the same geometry stays mounted.
  assert.equal(settled.readyOwnerKey, 'owner-a');
  assert.equal(settled.proofRequired, false);
  const repeated = resolveHistoryViewportPaintProof({
    currentOwnerKey: 'owner-a',
    currentGeneration: 9,
    currentPresentation: second,
    readyOwnerKey: settled.readyOwnerKey,
    proofRequired: settled.proofRequired,
    ownerKey: 'owner-a',
    generation: 9,
    presentationVisit: second.visit,
    proof: 'mounted-painted-row',
    domRows: 3,
  });
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.readyOwnerKey, 'owner-a');
  assert.equal(repeated.proofRequired, false);
});
