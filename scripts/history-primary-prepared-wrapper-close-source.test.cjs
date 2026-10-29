'use strict';
// V52 new wrapper edge only. Actual exported wrapper executes with finite
// owned-view/bundle failure injectors; no backing corruption/native claims.
const test = require('node:test'), assert = require('node:assert/strict');
const { wrapPrimaryView } = require('../src/main/history-root-engine/main/history-primary-semantic-bundle');
const error = code => Object.assign(Error(code), { code });
function fixture({ construction, viewFailure, bundleFailure } = {}) {
  const calls = { view: 0, bundle: 0 }, cursor = { length: 0, field() { return this; } }, lease = { cursor: () => cursor };
  const bundle = { retain: () => () => { calls.bundle++; if (bundleFailure) throw bundleFailure; },
    assertOpen() {}, canonical: { sessionMeta: cursor }, metadataRoot: lease, durableMetadataRoot: lease,
    settingsKeyRoot: lease, metrics: { promptPasses: 0, timingPasses: 0 }, canonicalEntryCount: 0 };
  const view = { root: { cursor() { if (construction) throw construction; return cursor; } }, length: 0,
    close() { calls.view++; if (viewFailure) throw viewFailure; } };
  return { bundle, view, calls };
}

test('new independently retained wrapper construction keeps the original failure while attempting both owned releases', () => {
  for (const frozen of [false, true]) {
    const primary = error('ORIGINAL_CONSTRUCTION'), viewFailure = error('VIEW_CLEANUP'), bundleFailure = error('BUNDLE_CLEANUP');
    if (frozen) Object.freeze(primary);
    const f = fixture({ construction: primary, viewFailure, bundleFailure });
    assert.throws(() => wrapPrimaryView(f.bundle, f.view, 'view', 'source'), thrown => thrown === primary);
    assert.deepEqual(f.calls, { view: 1, bundle: 1 });
  }
  const primary = error('ORIGINAL_VIEW_RETAIN'), bundleFailure = error('BUNDLE_CLEANUP'), f = fixture({ bundleFailure });
  assert.throws(() => wrapPrimaryView(f.bundle, f.view, 'view', 'source', { retain() { throw primary; } }), thrown => thrown === primary);
  assert.deepEqual(f.calls, { view: 0, bundle: 1 }, 'unacquired view is never released');
});

test('normal wrapper close preserves first close failure and attempts each release only once', () => {
  const first = error('VIEW_CLOSE'), f = fixture({ viewFailure: first, bundleFailure: error('BUNDLE_CLOSE') });
  const wrapper = wrapPrimaryView(f.bundle, f.view, 'view', 'source');
  assert.throws(() => wrapper.close(), thrown => thrown === first);
  assert.equal(wrapper.close(), undefined); assert.deepEqual(f.calls, { view: 1, bundle: 1 });
  assert.throws(() => wrapper.presentationSource(), { code: 'HISTORY_PRIMARY_RELEASED' });
});
