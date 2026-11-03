'use strict';

// One catalog-v2 response must never contradict itself across its two layers.
//
// Reported by the «iOS chat» tab from Fyodor's real iPhone (01.11 18:41): a
// 842KB response arrived with status 200 and parsed as valid JSON, then the
// client rejected it in `windowLayout.valid(for: catalog)` and showed a red
// toast with empty workspace statuses. It happened while tabs were being
// dragged — five `POST /api/workflow-organization/drag`, organization revision
// 22127 → 22128 (accepted) → REJECTED → 22129 (accepted). The same client
// rules pass on the same data at rest.
//
// The brief's hypothesis was that `catalog` and the nested `windowLayout` come
// from two separate reads. These tests check that claim against the real
// projection and a real SQLite fixture, and pin the invariant either way: the
// five fields the client compares must agree inside ONE response, including
// while the organization changes between requests.
//
// Run: node --test src/main/workflowCatalogLayerConsistency.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { directoryFixture } = require('./fixtures/workflow-directory-sqlite.cjs');

/** The exact guard the iOS client applies (TerminalWorkflowDirectoryV2.swift:406). */
function clientValid(reply) {
  const layout = reply.windowLayout;
  if (!layout) return { valid: true, reason: 'no-layout' };
  if (layout.sourceEpoch !== reply.sourceEpoch) return { valid: false, reason: 'sourceEpoch' };
  if (layout.catalogClock !== reply.catalogClock) return { valid: false, reason: 'catalogClock' };
  if (layout.source.generation !== reply.clocks.organization.generation) return { valid: false, reason: 'generation' };
  if (layout.source.revision !== reply.clocks.organization.revision) return { valid: false, reason: 'revision' };
  for (const entry of layout.workflows) {
    const workflow = reply.workflows.find(w => w.id === entry.workflowId);
    if (!workflow) return { valid: false, reason: 'workflow-missing:' + entry.workflowId };
    if (workflow.revision !== entry.workflowRevision) {
      return { valid: false, reason: 'workflowRevision:' + entry.workflowId };
    }
  }
  return { valid: true, reason: 'ok' };
}

test('a catalog read at rest satisfies every client rule', async t => {
  const f = await directoryFixture(t);
  f.add('root');
  f.add('child', { parentTabId: 'root' });
  const reply = await f.api.readCatalogV2();
  assert.deepEqual(clientValid(reply), { valid: true, reason: 'ok' });
});

test('the two layers come from ONE snapshot: concurrent reads are byte-identical', async t => {
  // If catalog and windowLayout were assembled from separate reads, two
  // in-flight requests could interleave and differ.
  const f = await directoryFixture(t);
  f.add('root');
  const [a, b] = await Promise.all([f.api.readCatalogV2(), f.api.readCatalogV2()]);
  assert.equal(JSON.stringify(a.windowLayout), JSON.stringify(b.windowLayout));
  assert.equal(a.catalogClock, b.catalogClock);
});

test('a layout change between reads moves BOTH layers together', async t => {
  // The reported scenario: drag rewrites `workflow_org_workflows.layout_json`
  // and bumps that workflow's revision. The catalog clock must move with it,
  // otherwise a client holding one layer and receiving the other sees a
  // contradiction.
  const f = await directoryFixture(t);
  f.add('root');
  const before = await f.api.readCatalogV2();
  assert.equal(clientValid(before).valid, true);

  const workflowId = before.workflows[0].id;
  const current = f.db.prepare('SELECT revision, layout_json FROM workflow_org_workflows WHERE workflow_id=?').get(workflowId);
  f.db.prepare('UPDATE workflow_org_workflows SET layout_json=?, revision=revision+1 WHERE workflow_id=?')
    .run(JSON.stringify({ version: 1, splitPanes: [{ windowId: 'win-moved', tabs: [{ tabId: 'root' }] }] }), workflowId);

  const after = await f.api.readCatalogV2();
  assert.deepEqual(clientValid(after), { valid: true, reason: 'ok' },
    'the response after a drag must still be self-consistent');
  assert.notEqual(after.catalogClock, before.catalogClock,
    'a layout edit must move the catalog clock, or a stale cursor would be accepted');
  assert.equal(after.windowLayout.workflows.find(w => w.workflowId === workflowId).workflowRevision,
    current.revision + 1, 'the layer reports the new workflow revision');
  assert.equal(after.workflows.find(w => w.id === workflowId).revision, current.revision + 1,
    'and the catalog reports the same one');
});

test('repeated layout edits keep every response self-consistent', async t => {
  // Mirrors the reported burst: five drags in one window, revision climbing.
  const f = await directoryFixture(t);
  f.add('root');
  f.add('second');
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const reply = await f.api.readCatalogV2();
    const verdict = clientValid(reply);
    assert.deepEqual(verdict, { valid: true, reason: 'ok' }, 'rejected on iteration ' + i);
    seen.add(reply.catalogClock);
    const workflowId = reply.workflows[0].id;
    f.db.prepare('UPDATE workflow_org_workflows SET layout_json=?, revision=revision+1 WHERE workflow_id=?')
      .run(JSON.stringify({ version: 1, splitPanes: [{ windowId: 'win-' + i, tabs: [{ tabId: 'root' }] }] }), workflowId);
  }
  assert.equal(seen.size, 5, 'each layout edit must produce a distinct catalog clock');
});

test('a membership change also keeps the layers aligned', async t => {
  // Not every drag is a layout edit: moving a tab between workflows changes
  // membership and the organization revision instead.
  const f = await directoryFixture(t);
  f.add('root');
  f.add('mover');
  const before = await f.api.readCatalogV2();
  f.db.prepare('UPDATE workflow_org_tabs SET revision=revision+1 WHERE tab_id=?').run('mover');
  const after = await f.api.readCatalogV2();
  assert.deepEqual(clientValid(after), { valid: true, reason: 'ok' });
});

test('the guard would actually catch a mismatched layer', async t => {
  // Proves the checks above are not vacuous: if the server ever did emit two
  // layers from different moments, `clientValid` rejects it.
  const f = await directoryFixture(t);
  f.add('root');
  const reply = await f.api.readCatalogV2();
  const workflowId = reply.workflows[0].id;

  const skewedClock = { ...reply, windowLayout: { ...reply.windowLayout, catalogClock: 'other-clock' } };
  assert.deepEqual(clientValid(skewedClock), { valid: false, reason: 'catalogClock' });

  const skewedRevision = { ...reply, windowLayout: { ...reply.windowLayout,
    source: { ...reply.windowLayout.source, revision: reply.clocks.organization.revision + 1 } } };
  assert.deepEqual(clientValid(skewedRevision), { valid: false, reason: 'revision' });

  const skewedWorkflow = { ...reply, windowLayout: { ...reply.windowLayout,
    workflows: reply.windowLayout.workflows.map(w => ({ ...w, workflowRevision: w.workflowRevision + 1 })) } };
  assert.deepEqual(clientValid(skewedWorkflow), { valid: false, reason: 'workflowRevision:' + workflowId });
});

test('windowLayout is part of the catalog clock, so the layers cannot drift silently', async t => {
  // The structural reason the layers stay aligned: `catalogClock` hashes
  // `core.windowLayout`, and the layer is then stamped with that same basis.
  // If the layer were ever computed outside the hashed input, this fails.
  const f = await directoryFixture(t);
  f.add('root');
  const reply = await f.api.readCatalogV2();
  assert.equal(reply.windowLayout.catalogClock, reply.catalogClock);
  assert.equal(reply.windowLayout.sourceEpoch, reply.sourceEpoch);

  f.db.prepare('UPDATE workflow_org_workflows SET layout_json=? WHERE workflow_id=?')
    .run(JSON.stringify({ version: 1, splitPanes: [{ windowId: 'only-layout-changed', tabs: [{ tabId: 'root' }] }] }),
      reply.workflows[0].id);
  const after = await f.api.readCatalogV2();
  assert.notEqual(after.catalogClock, reply.catalogClock,
    'changing ONLY the layout must still move the catalog clock');
  assert.deepEqual(clientValid(after), { valid: true, reason: 'ok' });
});

test('the layer inherits the catalog order, so a zip-by-position guard is safe', async t => {
  // The client's `mismatch(for:)` compares `zip(layout.workflows, catalog.workflows)`
  // — by POSITION, not by id. That is only sound because the layer is built as
  // `core.workflows.map(...)`: it cannot reorder or omit a workflow. If the
  // projection ever sorted the layer independently, every revision check would
  // compare two different workflows and reject a perfectly good catalog.
  const f = await directoryFixture(t);
  f.add('root');
  f.add('second');
  const reply = await f.api.readCatalogV2();
  assert.deepEqual(reply.windowLayout.workflows.map(w => w.workflowId),
    reply.workflows.map(w => w.id),
    'layer order must equal catalog order element by element');
});

test('a workflow added between reads appears in BOTH layers at the same position', async t => {
  const f = await directoryFixture(t);
  f.add('root');
  const before = await f.api.readCatalogV2();
  const beforeIds = before.workflows.map(w => w.id);
  f.add('late');
  const after = await f.api.readCatalogV2();
  assert.deepEqual(after.windowLayout.workflows.map(w => w.workflowId), after.workflows.map(w => w.id));
  assert.deepEqual(clientValid(after), { valid: true, reason: 'ok' });
  assert.ok(after.workflows.length >= beforeIds.length);
});
