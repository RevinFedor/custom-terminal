import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimelineCornerBadges,
  collectTimelineDocs,
  isTimelineGroupExpanded,
  timelineMarkerGeometry,
} from './timelineMarkerPresentation.mjs';

test('collapsed orchestration group aggregates unique docs activity from every call', () => {
  assert.deepEqual(collectTimelineDocs([
    { docsEdited: ['a.md'], docsSearchQueries: ['first'] },
    { docsEdited: ['b.md', 'a.md'], docsSearchQueries: ['second'] },
  ]), {
    edited: ['a.md', 'b.md'],
    searched: ['first', 'second'],
  });
});

test('group children cannot remain expanded in the narrow Timeline rail', () => {
  assert.equal(isTimelineGroupExpanded(false, true), false);
  assert.equal(isTimelineGroupExpanded(true, true), true);
});

test('orchestration marker remains a square before rotation in every rail state', () => {
  for (const variant of [
    { showAsChild: false, isHovered: false, isInViewport: true },
    { showAsChild: true, isHovered: false, isInViewport: true },
    { showAsChild: true, isHovered: false, isInViewport: false },
    { showAsChild: true, isHovered: true, isInViewport: true },
  ]) {
    const geometry = timelineMarkerGeometry({
      isOrchestration: true,
      displaysAsCompact: false,
      ...variant,
    });
    assert.equal(geometry.width, geometry.height);
    assert.equal(geometry.radius, '2px');
  }
});

test('system marker reuses orchestration diamond geometry without changing rail dimensions', () => {
  for (const showAsChild of [false, true]) for (const isHovered of [false, true]) {
    for (const isInViewport of [false, true]) {
      const state = { showAsChild, isHovered, isInViewport, displaysAsCompact: false };
      assert.deepEqual(timelineMarkerGeometry({ ...state, isSystem: true }),
        timelineMarkerGeometry({ ...state, isOrchestration: true }));
    }
  }
});

test('corner badges keep a plain group count separate from source and docs icons', () => {
  assert.deepEqual(buildTimelineCornerBadges({
    isLoop: true,
    docsEditedCount: 2,
    collapsedGroupSize: 3,
  }), {
    icons: ['loop', 'docs-edit'],
    count: '3',
    countTone: 'group',
    items: [
      { kind: 'loop', slot: 'top-right' },
      { kind: 'docs-edit', slot: 'middle-right' },
      { kind: 'count', text: '3', tone: 'group', slot: 'bottom-right' },
    ],
  });
});

test('two icons without a group count occupy different right-side corners', () => {
  assert.deepEqual(buildTimelineCornerBadges({
    isLoop: true,
    docsEditedCount: 1,
  }).items, [
    { kind: 'loop', slot: 'top-right' },
    { kind: 'docs-edit', slot: 'bottom-right' },
  ]);
});

test('compact count shares one right-side axis with edit and search icons', () => {
  const presentation = buildTimelineCornerBadges({
    docsEditedCount: 1,
    docsSearchCount: 1,
    compactClusterSize: 4,
  });

  assert.equal(presentation.count, '4');
  assert.equal(presentation.countTone, 'compact');
  assert.deepEqual(presentation.items, [
    { kind: 'docs-edit', slot: 'top-right' },
    { kind: 'count', text: '4', tone: 'compact', slot: 'middle-right' },
    { kind: 'docs-search', slot: 'bottom-right' },
  ]);
  assert.equal(presentation.items.every(item => item.slot.endsWith('right')), true);
});
