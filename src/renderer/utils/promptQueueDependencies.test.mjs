import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPromptTabDependency, completePromptTabDependency, normalizePromptTabTrigger,
  pendingPromptTabIds, promptTabTriggerReady } from './promptQueueDependencies.mjs';
import { collectQueueRelations, layoutRunAfterCards, routeRunAfterEdges, runAfterEdgeKey } from './runAfterDependencyLayout.mjs';

test('legacy target is preserved when a second is appended, and only post-selection outcomes count', () => {
  let trigger = appendPromptTabDependency({ kind: 'onTab', tabId: 'A' }, 'B', 200, 100);
  assert.deepEqual(pendingPromptTabIds(trigger), ['A', 'B']);
  trigger = completePromptTabDependency(trigger, 'A', 150);
  assert.deepEqual(pendingPromptTabIds(trigger), ['B']);
  assert.equal(promptTabTriggerReady(trigger), false);
  assert.equal(completePromptTabDependency(trigger, 'B', 199), trigger);
  trigger = completePromptTabDependency(trigger, 'B', 201);
  assert.equal(promptTabTriggerReady(trigger), true); assert.equal(trigger.tabId, 'B');
  assert.deepEqual(normalizePromptTabTrigger(JSON.parse(JSON.stringify(trigger))), trigger);
});

test('no artificial target-count cap; malformed timing cannot manufacture completion', () => {
  let trigger = null;
  for (let i = 0; i < 130; i++) trigger = appendPromptTabDependency(trigger, 'tab-' + i, 200);
  assert.equal(pendingPromptTabIds(trigger).length, 130);
  const malformed = normalizePromptTabTrigger({ kind: 'onTab', tabId: 'A', dependencies: [{ tabId: 'A', completedAt: 1 }] });
  assert.equal(promptTabTriggerReady(malformed), false);
});

test('one item awaiting two targets produces two independent global routes and removes only the completed relation', () => {
  const item = { id: 'step', trigger: appendPromptTabDependency({ kind: 'onTab', tabId: 'A' }, 'B', 200, 100) };
  const queue = { items: [item] }, edges = collectQueueRelations('owner', queue);
  assert.equal(edges.length, 2); assert.equal(new Set(edges.map(runAfterEdgeKey)).size, 2);
  const sizes = ['owner', 'A', 'B'].map(id => ({ id, width: 260, height: 100 }));
  const layout = layoutRunAfterCards({ nodeIds: sizes.map(x => x.id), sizes, edges, availableWidth: 900 });
  const anchors = new Map(sizes.map(x => [x.id, { headerX: 0, headerY: 12, stepAnchors: new Map([['step', { x: 0, y: 60 }]]) }]));
  const routes = routeRunAfterEdges({ ...layout, edges, anchors });
  assert.equal(routes.length, 2); assert.notEqual(routes[0].d, routes[1].d);
  item.trigger = completePromptTabDependency(item.trigger, 'A', 201);
  assert.deepEqual(collectQueueRelations('owner', queue).map(x => x.target), ['B']);
});
