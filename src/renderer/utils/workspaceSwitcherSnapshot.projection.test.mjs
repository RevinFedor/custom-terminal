import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createStore } from 'zustand/vanilla';
import { createWorkspaceSwitcherSnapshot } from './workspaceSwitcherSnapshot.mjs';
import { emptySpaceLayout } from './workspaceSpacesModel.mjs';

const epoch = 'private-switcher-epoch';
const native = { epoch, scope: 'native', anchorTabId: null, visibleTabIds: [] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(factory = createWorkspaceSwitcherSnapshot, count = null) {
  const tab = (id, extra = {}) => ({ id, name: id, tabType: 'terminal', commandType: 'codex',
    notes: { toJSON() { throw new Error('private body serialized'); } }, ...extra });
  const list = count === null ? [tab('a'), tab('a2'), tab('b'), tab('child', { parentTabId: 'a' }),
    tab('file', { tabType: 'file', commandType: null, filePath: '/private-fixture/readme.md' }),
    tab('file2', { tabType: 'file', filePath: '/private-fixture/readme.md' }),
    tab('sdk', { tabType: 'claude-sdk', commandType: null }),
    tab('visual', { visualParentTabId: 'a', commandType: 'gemini' }), tab('unplaced')]
    : Array.from({ length: count }, (_, i) => tab('t' + i));
  const tabs = new Map(list.map(t => [t.id, t]));
  const aIds = count === null ? ['a', 'a2', 'file', 'file2', 'sdk', 'visual'] : list.map(t => t.id);
  const ws = { isRestoring: false, openProjects: new Map([['P', { projectPath: '/private-fixture/P', activeTabId: aIds[0], tabs }]]),
    projectHistory: ['P'], globalTabMru: (count === null ? ['b', 'a2', 'file', 'file2', 'a', 'visual', 'sdk', 'unplaced', 'child', 'closed'] : aIds)
      .map(tabId => ({ projectId: 'P', tabId })), activeProjectId: 'P', activeSpaceId: 'A', splitFocusedIndex: 0,
    splitPanes: [{ projectId: 'P', tabId: aIds[0], tabs: aIds.map(tabId => ({ projectId: 'P', tabId })) }], centerStrips: {},
    spaces: [{ id: 'A', name: 'Workflow A', projectIds: ['P'], layout: emptySpaceLayout() },
      { id: 'B', name: 'Workflow B', icon: null, projectIds: ['P'],
        layout: { ...emptySpaceLayout(), splitPanes: count === null ? [{ projectId: 'P', tabId: 'b' }] : [] } }] };
  const projects = { P: { name: 'Directory project', icon: 'data:image/png;base64,' + 'A'.repeat(32000) } };
  const workspace = createStore(() => ws), projectStore = createStore(() => ({ projects }));
  const files = new Map([['/private-fixture/readme.md', true]]), changes = [], probes = [], reads = [], hooks = {};
  let ready = true, publication = 0;
  const snapshot = factory({ epoch,
    readWorkspace: () => { reads.push('workspace'); return workspace.getState(); },
    readProjects: () => { reads.push('projects'); return projectStore.getState().projects; },
    readReady: () => { reads.push('ready'); return ready; },
    fileVerdict: p => { reads.push('verdict:' + p); return files.get(p); },
    probeFiles: async paths => { probes.push([...paths]); if (hooks.probe) await hooks.probe(paths); },
    onChanged: value => { changes.push({ ...value }); hooks.changed?.(value); },
  });
  const unsub = [workspace.subscribe(() => snapshot.refresh()), projectStore.subscribe(() => snapshot.refresh())];
  return { workspace, projectStore, tabs, projects, files, changes, probes, reads, hooks, snapshot,
    publish: () => workspace.setState({ publication: ++publication }),
    ready: value => { ready = value; snapshot.refresh(); },
    close() { unsub.forEach(fn => fn()); snapshot.dispose(); },
  };
}

// Count actual map-returned DTO objects, not elapsed time. This is confined to
// one synchronous operation; production code has no instrumentation or cache.
function countProjection(fn) {
  const map = Array.prototype.map, stringify = JSON.stringify, seen = new WeakSet();
  const counters = { dtoObjects: 0, fingerprints: 0, fingerprintBytes: 0 };
  Array.prototype.map = function(callback, receiver) {
    return map.call(this, function(value, index, array) {
      const result = callback.call(receiver, value, index, array);
      if (result && ['tab', 'workflow'].includes(result.kind) && typeof result.rowId === 'string' && !seen.has(result)) {
        seen.add(result); counters.dtoObjects++;
      }
      return result;
    });
  };
  JSON.stringify = function(value, ...args) {
    const result = stringify.call(this, value, ...args);
    if (Array.isArray(value) && value.length === 3 && value[0]?.activeSpaceId && value[2]?.icons && value[2]?.rows) {
      counters.fingerprints++; counters.fingerprintBytes += Buffer.byteLength(result);
    }
    return result;
  };
  try { fn(); return counters; } finally { Array.prototype.map = map; JSON.stringify = stringify; }
}

test('two synchronous Zustand publications make one DTO per row each; both fingerprints/notifications remain', t => {
  const f = fixture(undefined, 32); t.after(() => f.close());
  f.snapshot.refresh(); f.changes.length = 0;
  const events = []; f.hooks.changed = c => events.push('changed:' + c.revision);
  const sameMap = f.workspace.getState().openProjects;
  const counts = countProjection(() => {
    events.push('before-1'); f.tabs.get('t0').name = 'renamed'; f.publish(); events.push('after-1');
    events.push('before-2'); f.workspace.getState().globalTabMru.reverse(); f.publish(); events.push('after-2');
  });
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.dtoObjects, 2 * (32 + 1), 'do not build raw-icon DTOs and then copy each DTO for compaction');
  assert.equal(counts.fingerprints, 2, 'publication count/timing must not be coalesced');
  assert.deepEqual(events, ['before-1', 'changed:2', 'after-1', 'before-2', 'changed:3', 'after-2']);
  assert.equal(f.workspace.getState().openProjects, sameMap, 'mutable nested state was reused');
});

test('wire keeps order, repeated workflow headers, icons, metadata exclusions and native/desktop contexts', async t => {
  const f = fixture(); t.after(() => f.close());
  const r = await f.snapshot.read({ ...native, anchorTabId: 'a', visibleTabIds: ['a'] });
  assert.deepEqual(r.rows.filter(x => x.kind === 'tab').map(x => x.tabId), ['a', 'b', 'a2', 'file', 'file2', 'visual', 'sdk', 'unplaced']);
  assert.deepEqual(r.rows.filter(x => x.kind === 'workflow').map(x => x.rowId), ['workflow:A:0', 'workflow:B:0', 'workflow:A:1', 'workflow:__workflow_unplaced__:0']);
  assert.equal(r.initialTabId, 'b'); assert.equal(r.totalTabs, 8); assert.equal(r.truncated, false);
  assert.deepEqual(Object.values(r.icons), [f.projects.P.icon]);
  assert.equal(r.rows.find(x => x.tabId === 'sdk').provider, 'claude');
  assert.equal(r.rows.find(x => x.tabId === 'visual').provider, 'gemini');
  const file = r.rows.find(x => x.tabId === 'file');
  assert.equal(file.availability, 'available'); assert.equal(file.selectable, true);
  assert.deepEqual(Object.keys(file), ['kind', 'rowId', 'tabId', 'projectId', 'projectName', 'workflowId', 'title',
    'tabType', 'commandType', 'provider', 'fileRef', 'availability', 'missing', 'selectable', 'projectIconId', 'anchor']);
  assert.deepEqual(f.probes, [['/private-fixture/readme.md', '/private-fixture/readme.md']], 'one original batch including duplicate refs');
  assert.equal(f.reads.filter(x => x.startsWith('verdict:')).length, 10, 'two full captures plus selected file DTOs');
  assert.equal(f.reads.filter(x => x === 'workspace').length, 2);
  assert.equal(JSON.stringify(r).includes('private body'), false);
  const desktop = await f.snapshot.read({ epoch, scope: 'desktop' });
  assert.deepEqual(desktop.rows.filter(x => x.kind === 'tab').map(x => x.tabId), ['a', 'b', 'unplaced']);
  assert.equal(desktop.view.anchorTabId, 'a');
  const all = r.rows.filter(x => x.kind === 'tab').map(x => x.tabId);
  const onlyAnchor = await f.snapshot.read({ ...native, anchorTabId: 'a', visibleTabIds: all });
  assert.equal(onlyAnchor.initialIndex, -1); assert.equal(onlyAnchor.initialTabId, null);
});

test('probe await re-captures mutable state and missing/unknown file availability; closed native anchor rejects', async t => {
  const f = fixture(); t.after(() => f.close());
  let entered = deferred(), release = deferred();
  f.hooks.probe = () => { entered.resolve(); return release.promise; };
  const pending = f.snapshot.read(native); await entered.promise;
  f.tabs.get('b').name = 'during probe'; f.files.set('/private-fixture/readme.md', false); f.publish();
  release.resolve(); const r = await pending;
  assert.equal(r.rows.find(x => x.tabId === 'b').title, 'during probe');
  assert.equal(r.rows.find(x => x.tabId === 'file').availability, 'missing');
  assert.equal(r.rows.find(x => x.tabId === 'file').selectable, false);
  assert.equal(r.revision, f.changes.at(-1).revision);
  f.hooks.probe = null; f.files.delete('/private-fixture/readme.md'); f.snapshot.refresh();
  const unknown = (await f.snapshot.read(native)).rows.find(x => x.tabId === 'file');
  assert.equal(unknown.availability, 'unknown'); assert.equal(unknown.selectable, true);
  entered = deferred(); release = deferred();
  f.hooks.probe = () => { entered.resolve(); return release.promise; };
  const closing = f.snapshot.read({ ...native, anchorTabId: 'a2', visibleTabIds: ['a2'] }); await entered.promise;
  f.tabs.delete('a2'); f.publish(); release.resolve();
  await assert.rejects(closing, e => e.code === 'switcher_context_stale' && e.statusCode === 409);
});

test('same-object metadata changes publish; body/busy do not; restoration and disposal retain exact failures', async t => {
  const f = fixture(); t.after(() => f.close()); f.snapshot.refresh();
  const before = f.changes.length;
  f.tabs.get('a').aiBusy = true; f.tabs.get('a').notes = 'changed body'; f.publish();
  assert.equal(f.changes.length, before);
  f.projects.P.name = 'renamed project'; f.projectStore.setState({ publication: 1 });
  f.workspace.getState().spaces[0].icon = null; f.publish();
  assert.equal(f.changes.length, before + 2);
  f.workspace.setState({ isRestoring: true }); const unavailable = f.changes.at(-1);
  assert.equal(unavailable.available, false); assert.equal(unavailable.reason, 'switcher_renderer_restoring');
  f.snapshot.refresh(); assert.equal(f.changes.at(-1), unavailable);
  await assert.rejects(f.snapshot.read(native), e => e.code === 'switcher_renderer_restoring');
  f.workspace.setState({ isRestoring: false }); f.ready(false);
  await assert.rejects(f.snapshot.read(native), e => e.code === 'switcher_renderer_restoring');
  f.ready(true); assert.equal((await f.snapshot.read(native)).known, true);
  const probes = f.probes.length;
  await assert.rejects(f.snapshot.read({ epoch: 'wrong', scope: 'desktop' }), e => e.code === 'switcher_renderer_retired' && e.statusCode === 409);
  await assert.rejects(f.snapshot.read({ epoch, scope: 'desktop', anchorTabId: 'a' }), e => e.code === 'switcher_desktop_context_forbidden');
  await assert.rejects(f.snapshot.read({ ...native, anchorTabId: 'child', visibleTabIds: ['child'] }), e => e.code === 'switcher_context_stale');
  assert.equal(f.probes.length, probes);
  f.snapshot.dispose(); f.snapshot.refresh();
  await assert.rejects(f.snapshot.read(native), e => e.code === 'switcher_renderer_retired' && e.statusCode === 503);
});

test('reentrant onChanged publication remains synchronous and the next read has current metadata', async t => {
  const f = fixture(); t.after(() => f.close()); let entered = false;
  f.hooks.changed = clock => {
    if (clock.revision !== 1 || entered) return;
    entered = true; f.tabs.get('b').name = 'nested'; f.projects.P.icon = 'nested-icon'; f.publish();
  };
  f.snapshot.refresh();
  assert.deepEqual(f.changes.map(x => x.revision), [1, 2]);
  const r = await f.snapshot.read(native);
  assert.equal(r.revision, 2); assert.equal(r.rows.find(x => x.tabId === 'b').title, 'nested');
  assert.deepEqual(Object.values(r.icons), ['nested-icon']);
});

test('complete large catalog still serializes each shared icon once and no large tab bodies', async t => {
  const f = fixture(undefined, 240); t.after(() => f.close());
  const body = 'SECRET_BODY'.repeat(10000);
  for (const tab of f.tabs.values()) { tab.notes = body; tab.historyPrompt = body; tab.draft = { toJSON() { throw Error('draft serialized'); } }; }
  const r = await f.snapshot.read(native), wire = JSON.stringify(r);
  assert.equal(r.totalTabs, 240); assert.equal(r.truncated, false);
  assert.equal(Object.values(r.icons).length, 1); assert.equal(wire.split(f.projects.P.icon).length - 1, 1);
  assert.ok(wire.length < 150000); assert.equal(wire.includes('SECRET_BODY'), false);
});

async function transcript(factory) {
  const f = fixture(factory), values = [];
  const take = async label => values.push([label, JSON.stringify(await f.snapshot.read(native))]);
  try {
    f.snapshot.refresh(); await take('initial');
    f.tabs.get('a').name = 'renamed'; f.publish(); f.workspace.getState().globalTabMru.reverse(); f.publish(); await take('mutable');
    f.workspace.getState().spaces[0].icon = null; f.projects.P.icon = 'next'; f.publish(); await take('icons');
    f.hooks.probe = () => { f.files.set('/private-fixture/readme.md', false); f.tabs.get('b').name = 'probe'; f.publish(); };
    await take('after-probe'); f.hooks.probe = null;
    f.workspace.setState({ isRestoring: true }); f.snapshot.refresh(); f.workspace.setState({ isRestoring: false });
    let nested = false;
    f.hooks.changed = () => { if (!nested) { nested = true; f.tabs.get('b').name = 'nested'; f.publish(); } };
    f.tabs.get('a').name = 'outer'; f.publish(); await take('reentrant');
    return { values, changes: f.changes, probes: f.probes, reads: f.reads };
  } finally { f.close(); }
}
test('wire JSON, publication clocks, reader/probe order match the immutable source13 producer',
  { skip: !process.env.NOTED_SWITCHER_BASELINE_FILE }, async () => {
    const baseline = await import(pathToFileURL(process.env.NOTED_SWITCHER_BASELINE_FILE));
    assert.deepEqual(await transcript(createWorkspaceSwitcherSnapshot), await transcript(baseline.createWorkspaceSwitcherSnapshot));
  });
