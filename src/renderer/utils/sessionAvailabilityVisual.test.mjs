import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_MISSING_TINT,
  SESSION_PARTIAL_TINT,
  SESSION_STALE_VALUE_TINT,
  sessionAvailabilityAccent,
  sessionAvailabilityBackgroundImage,
  sessionAvailabilityLabel,
  sessionAvailabilityRailShadow,
  sessionAvailabilityTone,
  sessionDerivedSignalsStale,
  sessionHistoryActionUnavailable,
} from './sessionAvailabilityVisual.mjs';

test('missing transcript has a separate raspberry signal without replacing tab identity', () => {
  const availability = { state: 'missing', reason: 'session-file-not-found' };
  assert.equal(sessionAvailabilityTone(availability), 'missing');
  assert.equal(sessionAvailabilityAccent(availability), SESSION_MISSING_TINT);
  assert.match(sessionAvailabilityRailShadow(availability), /inset -3px/);
  assert.match(sessionAvailabilityBackgroundImage(availability), /linear-gradient/);
  assert.match(sessionAvailabilityLabel(availability), /не найден/);
});

test('last-known session metrics are muted only when no exact live runtime remains', () => {
  const missing = { state: 'missing' };
  assert.equal(sessionDerivedSignalsStale(missing, false), true);
  assert.equal(sessionDerivedSignalsStale(missing, true), false);
  assert.equal(SESSION_STALE_VALUE_TINT, '#6f6f78');
  assert.equal(sessionDerivedSignalsStale({ state: 'partial' }, false), false);
  assert.equal(sessionDerivedSignalsStale({ state: 'archived' }, false), true);
});

test('partial and archived sessions are visually distinct from permanent absence', () => {
  assert.equal(sessionAvailabilityTone({ state: 'partial' }), 'partial');
  assert.equal(sessionAvailabilityAccent({ state: 'partial' }), SESSION_PARTIAL_TINT);
  assert.equal(sessionAvailabilityTone({ state: 'archived' }), 'partial');
  assert.equal(sessionHistoryActionUnavailable({ state: 'archived' }), true);
  assert.equal(sessionHistoryActionUnavailable({ state: 'partial' }), false);
  assert.equal(sessionHistoryActionUnavailable({ state: 'available' }), false);
});

test('unknown and checking never masquerade as deleted history', () => {
  for (const state of ['unknown', 'checking', 'available', 'none']) {
    assert.equal(sessionAvailabilityTone({ state }), 'normal');
    assert.equal(sessionAvailabilityRailShadow({ state }), null);
    assert.equal(sessionHistoryActionUnavailable({ state }), false);
  }
});
