import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUsageAccountPresentation } from './usageAccountPresentation.mjs';

const account = (accountKey, extras = {}) => ({ accountKey, label: accountKey, ...extras });

test('popover selection and compact current-account face are independent', () => {
  const current = account('current', { isCurrent: true });
  const historical = account('historical');
  const view = resolveUsageAccountPresentation([historical, current], 'historical', 'current');

  assert.strictEqual(view.selected, historical);
  assert.strictEqual(view.compact, current);
});

test('backend current marker is used when the explicit current key is not hydrated yet', () => {
  const current = account('current', { isCurrent: true });
  const selected = account('selected');
  const view = resolveUsageAccountPresentation([selected, current], 'selected', null);

  assert.strictEqual(view.selected, selected);
  assert.strictEqual(view.compact, current);
});

test('a disconnected historical account never impersonates the local login', () => {
  const only = account('only');
  assert.deepEqual(resolveUsageAccountPresentation([only], 'missing', null), {
    selected: only,
    compact: null,
  });
});
