import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimelineCornerBadges,
  collectTimelineDocs,
  isTimelineGroupExpanded,
  timelineMarkerGeometry,
  timelineMarkerKind,
} from './timelineMarkerPresentation.mjs';
import { projectTimelineSentHandoff, mergeTimelineEntriesWithSentHandoffs } from './timelineTranscriptRefresh.mjs';

test('Continue and Loop have ordinary non-diamond marker semantics, not fake MCP or context recovery',()=>{
  const retry={type:'user',content:'continue',semanticTags:[{kind:'prompt-origin',source:'system',systemSource:'codex-capacity-retry'}]};
  assert.equal(timelineMarkerKind(retry),'continue');
  assert.equal(timelineMarkerKind({semanticTags:[{kind:'prompt-origin',source:'loop'}]}),'loop');
  assert.equal(timelineMarkerKind({type:'user',content:'continue'}),'ordinary');
  assert.equal(timelineMarkerKind({...retry,semanticTags:[{kind:'prompt-origin',source:'system',systemSource:'build-install-return'}]}),'system');
});

test('SC channel comes only from an exact external research tag, not its model or quoted text', () => {
  const tag = { kind: 'orchestration', runId: 'run', runKind: 'external-research', phase: 'completion' };
  for (const targetTabName of ['ChatGPT - 6-astra', 'Another model', undefined]) {
    assert.equal(timelineMarkerKind({ semanticTags: [{ ...tag, targetTabName }] }), 'sc-desktop');
  }
  assert.equal(timelineMarkerKind({ content: 'SC Desktop ChatGPT - 6-astra' }), 'ordinary');
  assert.equal(timelineMarkerKind({ semanticTags: [{ ...tag, runKind: 'agent' }] }), 'terminal-mcp');
  assert.equal(timelineMarkerKind({ semanticTags: [{ ...tag, runId: '' }] }), 'terminal-mcp');
  assert.equal(timelineMarkerKind({ semanticTags: [{ kind: 'prompt-origin', source: 'terminal-mcp' }] }), 'terminal-mcp');
});

test('exact confirmed SC handoff retains its channel before canonical adoption without a duplicate', () => {
  const tag = { kind: 'orchestration', runId: 'run', runKind: 'external-research', phase: 'completion', targetTabName: 'ChatGPT - 6-astra' };
  const handoff = { handoffId: 'orchestration-complete:run', source: 'codex-orchestration-completion:run',
    queueStatus: 'sent', toolType: 'codex', text: 'answer', submittedAt: 1000, semanticTags: [tag],
    auditProof: { sessionId: 's', entryUuid: 'canonical', sourceIdentity: 'source', auditTimestamp: '2026-10-07T04:00:00.000Z' } };
  const point = projectTimelineSentHandoff(handoff, { toolType: 'codex', sessionId: 's' });
  assert.equal(timelineMarkerKind(point), 'sc-desktop');
  assert.equal(point.semanticTags[0].targetTabName, tag.targetTabName);
  for (const queueStatus of ['queued', 'audit-pending', 'delivery-unknown']) {
    assert.equal(projectTimelineSentHandoff({ ...handoff, queueStatus }, { toolType: 'codex', sessionId: 's' }), null);
  }
  const canonical = { ...point, isSentHandoffProjection: false };
  const merged = mergeTimelineEntriesWithSentHandoffs([canonical], [point]);
  assert.equal(merged.length, 1);
  assert.equal(timelineMarkerKind(merged[0]), 'sc-desktop');
});

test('collapsed orchestration group aggregates unique docs activity from every call', () => {
  assert.deepEqual(collectTimelineDocs([
    { docsEdited: ['a.md'], docsSearchQueries: ['first'] },
    { docsEdited: ['b.md', 'a.md'], docsSearchQueries: ['second'] },
  ]), {
    edited: ['a.md', 'b.md'],
    searched: ['first', 'second'],
  });
});

test('vertical group expansion is independent of narrow/wide Timeline layout', () => {
  assert.equal(isTimelineGroupExpanded(false, true), true);
  assert.equal(isTimelineGroupExpanded(true, true), true);
  assert.equal(isTimelineGroupExpanded(false, false), false);
  assert.equal(isTimelineGroupExpanded(true, false), false);
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
