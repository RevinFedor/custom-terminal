'use strict';

// A run going inactive must NOT tell clients the workflow organization moved.
//
// Measured scar 01.11 (iOS, Fyodor's real phone): one drag produced TWO
// publication changes (22128, 22129) but FIVE `organization-wake`s on the
// client. Native clients treat `layoutChangedProjectIds` as "the organization
// moved": they invalidate their catalog snapshot and bump a generation
// counter. Each spurious wake bumped that counter while an 842KB catalog
// response was still crossing a slow tunnel, so on arrival it no longer
// belonged to the current generation and was discarded — twice, byte-identical
// to the third response that was accepted. The user got a red error and empty
// workspace statuses.
//
// The extra wakes came from `scheduleProjectLayoutBroadcast(…, '*-runtime-inactive')`.
// A stopped run changes runtime, not the tree, the membership or the
// publication.
//
// These tests execute the REAL `scheduleProjectLayoutBroadcast` and
// `scheduleProjectRuntimeBroadcast` extracted from main.js, so the wiring they
// assert is the shipped one.
//
// Run: node --test src/main/projectRuntimeWakeScope.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', MAIN, ts.ScriptTarget.Latest, true);
const fn = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error('Missing actual function ' + name);
  return node.getText(ast);
};

function host() {
  const activity = [];
  const cardSignals = [];
  const scope = vm.createContext({
    projectLayoutChangedIds: new Set(),
    noteProjectCardSignalsChanged: projectId => cardSignals.push(projectId),
    scheduleProjectActivityBroadcast: reason => activity.push(reason),
  });
  vm.runInContext(fn('scheduleProjectLayoutBroadcast'), scope);
  vm.runInContext(fn('scheduleProjectRuntimeBroadcast'), scope);
  return { scope, activity, cardSignals,
    changed: () => [...scope.projectLayoutChangedIds] };
}

test('an inactive run wakes cards but does not flag the organization', () => {
  const h = host();
  vm.runInContext("scheduleProjectRuntimeBroadcast('proj-1', 'claude-runtime-inactive')", h.scope);
  assert.deepEqual(h.changed(), [], 'the organization did not move');
  assert.deepEqual(h.cardSignals, ['proj-1'], 'the card must still gray out immediately');
  assert.deepEqual(h.activity, ['claude-runtime-inactive'], 'clients are still notified');
});

test('a real layout change still flags the organization', () => {
  // The guard must not become "never flag anything": a tab actually moving
  // between windows IS an organization change and clients must refetch.
  const h = host();
  vm.runInContext("scheduleProjectLayoutBroadcast('proj-1', 'tab-layout')", h.scope);
  assert.deepEqual(h.changed(), ['proj-1']);
  assert.deepEqual(h.cardSignals, ['proj-1']);
  assert.deepEqual(h.activity, ['tab-layout']);
});

test('both providers use the runtime path, not the layout path', () => {
  // The exact regression: either call slipping back to the layout broadcast
  // re-creates the spurious wake. Checked against the real source, because the
  // defect is a single wrong function name at the call site.
  for (const provider of ['claude', 'codex']) {
    const runtime = `scheduleProjectRuntimeBroadcast(persisted.project_id, '${provider}-runtime-inactive')`;
    const layout = `scheduleProjectLayoutBroadcast(persisted.project_id, '${provider}-runtime-inactive')`;
    assert.ok(MAIN.includes(runtime), provider + ' must use the runtime broadcast');
    assert.ok(!MAIN.includes(layout), provider + ' must not flag the organization');
  }
});

test('the runtime broadcast never touches the changed-id set', () => {
  // Structural: a future edit adding the flag back here would be invisible in
  // behaviour tests that only look at one call.
  const body = fn('scheduleProjectRuntimeBroadcast');
  assert.ok(!body.includes('projectLayoutChangedIds'),
    'scheduleProjectRuntimeBroadcast must not reference the organization flag');
  assert.ok(fn('scheduleProjectLayoutBroadcast').includes('projectLayoutChangedIds'),
    'and the layout broadcast must still set it');
});

test('repeated inactive runs stay quiet about the organization', () => {
  // The reported burst: several runs stopping while a catalog read is in
  // flight. Each one used to cost the client a generation bump.
  const h = host();
  for (let i = 0; i < 5; i++) {
    vm.runInContext(`scheduleProjectRuntimeBroadcast('proj-${i}', 'codex-runtime-inactive')`, h.scope);
  }
  assert.deepEqual(h.changed(), [], 'five stopped runs, zero organization wakes');
  assert.equal(h.cardSignals.length, 5, 'but every card still updates');
  assert.equal(h.activity.length, 5);
});

test('a null projectId is survivable on both paths', () => {
  const h = host();
  vm.runInContext("scheduleProjectRuntimeBroadcast(null, 'claude-runtime-inactive')", h.scope);
  vm.runInContext("scheduleProjectLayoutBroadcast(null, 'tab-layout')", h.scope);
  assert.deepEqual(h.changed(), [], 'an unknown project cannot be flagged');
  assert.deepEqual(h.activity, ['claude-runtime-inactive', 'tab-layout']);
});

test('startup defaults use the runtime path, not the layout path', () => {
  // Second source, found 01.11 after iOS checked the log: two of the spurious
  // wakes happened while every tab was `busy->busy` / `starting->starting` —
  // no run had stopped at all. They came from the Claude startup-defaults
  // gate (`startup-defaults-pending|ready|failed|cleared`). A launch becoming
  // ready is runtime readiness, not an organization change.
  const runtime = "if (persisted?.project_id) scheduleProjectRuntimeBroadcast(persisted.project_id, reason);";
  const layout = "if (persisted?.project_id) scheduleProjectLayoutBroadcast(persisted.project_id, reason);";
  assert.equal(MAIN.split(runtime).length - 1, 2,
    'both startup-defaults branches must use the runtime broadcast');
  assert.ok(!MAIN.includes(layout),
    'no startup-defaults branch may flag the organization');
});

test('only genuine organization changes still flag the project', () => {
  // The inverse guard: after narrowing, the ONLY remaining callers of the
  // layout broadcast must be real structural edits. A future runtime signal
  // added here would silently re-create the scar.
  const calls = MAIN.split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(entry => entry.line.includes('scheduleProjectLayoutBroadcast(')
      && !entry.line.startsWith('function '));
  const reasons = calls.map(entry => (entry.line.match(/'([a-z-]+)'/) || [])[1]
    || (entry.line.includes("reason || 'tab-layout'") ? 'tab-layout' : '?'));
  assert.deepEqual(reasons.sort(), ['tab-groups', 'tab-layout'],
    'unexpected caller of the organization flag: ' + calls.map(c => c.line).join(' | '));
});
