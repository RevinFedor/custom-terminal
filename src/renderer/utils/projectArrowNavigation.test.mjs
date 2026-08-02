import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldNavigateProjectsWithArrow } from './projectArrowNavigation.mjs';

const event = (overrides = {}) => ({
  code: 'ArrowRight',
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target: { closest: () => null },
  ...overrides,
});

test('project arrows remain active on the project rail', () => {
  assert.equal(shouldNavigateProjectsWithArrow(event(), 'projects', null), true);
});

test('terminal and composer own arrows even when project area is stale', () => {
  const target = { closest: () => ({}) };
  assert.equal(shouldNavigateProjectsWithArrow(event({ target }), 'projects', null), false);
});

test('modified or already handled arrows never navigate projects', () => {
  assert.equal(shouldNavigateProjectsWithArrow(event({ altKey: true }), 'projects', null), false);
  assert.equal(shouldNavigateProjectsWithArrow(event({ defaultPrevented: true }), 'projects', null), false);
});
