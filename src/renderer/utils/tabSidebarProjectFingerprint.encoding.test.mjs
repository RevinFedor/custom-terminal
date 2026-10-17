import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createStore} from 'zustand/vanilla';
import * as before from './fixtures/tabSidebarProjectFingerprint.836929ef.before.mjs';

const actual = await import(process.env.NOTED_SIDEBAR_FINGERPRINT_SOURCE
  ? pathToFileURL(process.env.NOTED_SIDEBAR_FINGERPRINT_SOURCE).href
  : new URL('./tabSidebarProjectFingerprint.mjs', import.meta.url).href);
const fingerprint = actual.tabSidebarProjectFingerprint;
const oracle = before.tabSidebarProjectFingerprint;
const make = () => ({
  projectId: 'p', activeTabId: 'a', currentView: 'terminal', selectedTabIds: ['a'],
  tabGroups: [{id: 'g', name: 'Group', collapsed: false}],
  tabs: new Map([
    ['a', {id: 'a', name: 'A', cwd: '/a', completionNotificationFired: false,
      bgTasks: [{id: 'b', status: 'running'}],
      taskPlan: {id: 'plan', title: 'Plan', items: [{id: 'i', title: 'Item', status: 'pending',
        subtasks: [{id: 's', title: 'Subtask', status: 'pending'}]}],
        archivedItems: [{id: 'old', status: 'completed'}]}}],
    ['b', {id: 'b', name: 'B', cwd: '/b', groupId: 'g'}],
  ]),
});
const equal = value => assert.equal(fingerprint(value), oracle(value));

test('differential oracle is the complete pinned preimage', () => {
  const bytes = fs.readFileSync(new URL('./fixtures/tabSidebarProjectFingerprint.836929ef.before.mjs', import.meta.url));
  assert.equal(bytes.length, 5526);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '836929efb3aace64d3d0de181290371067b1a2280764bc46353234eeaded3774');
});

test('exact encoding retains separators, UTF-16 lengths and scalar normalization', () => {
  const value = make();
  for (const name of [null, undefined, '', false, 0, 17n, 'a:|💬\ud800', Symbol('x')]) {
    value.tabs.get('a').name = name;
    equal(value);
  }
  for (const missing of [undefined, null, false, 0, '']) equal(missing);
});

test('every projected tab scalar observes in-place changes', () => {
  const fields = ['id', 'name', 'cwd', 'color', 'commandType', 'tabType', 'filePath', 'groupId',
    'visualParentTabId', 'parentTabId', 'isCollapsed', 'sessionStatus', 'claudeSessionId',
    'geminiSessionId', 'codexSessionId', 'wasInterrupted', 'completionNotificationPersistent',
    'completionNotificationArmed', 'completionNotificationFired', 'restartAfterTabId',
    'restartAfterCommand', 'restartAfterPaused', 'sdkProcessAlive', 'sdkState', 'aiClosing', 'pendingOperation'];
  for (const field of fields) {
    const value = make(), tab = value.tabs.get('a'), previous = fingerprint(value);
    tab[field] = 'changed:|💬';
    equal(value);
    assert.notEqual(fingerprint(value), previous, field);
  }
  for (const [field, child] of [['restoreError', 'type'], ['restoreError', 'message'],
    ['externalRun', 'status'], ['externalRun', 'collapsed']]) {
    const value = make(), previous = fingerprint(value);
    value.tabs.get('a')[field] = {[child]: 'new'};
    equal(value); assert.notEqual(fingerprint(value), previous);
  }
});

test('workspace, groups, task plans and ordered collections remain exact', () => {
  const mutations = [
    v => {v.activeTabId = 'b';}, v => {v.activeGroupId = 'g';},
    v => {v.currentView = 'graph';}, v => {v.viewingSubAgentTabId = 'b';},
    v => v.selectedTabIds.reverse(), v => v.selectedTabIds.push('b'),
    v => {v.tabGroups[0].collapsed = true;}, v => {v.tabGroups[0].anchorTabId = 'a';},
    v => {v.tabGroups[0].color = 'red';}, v => {v.tabGroups[0].sessionStatus = 'archived';},
    v => {v.tabs = new Map([...v.tabs].reverse());},
    v => {v.tabs.get('a').restartAfterTabIds = ['a', 'b'];},
    v => {v.tabs.get('a').restartAfterWorkflowIds = ['p', 'q'];},
    v => {v.tabs.get('a').bgTasks[0].isError = true;},
    v => {v.tabs.get('a').taskPlan.items[0].subtasks[0].status = 'completed';},
    v => {v.tabs.get('a').taskPlan.archivedItems[0].status = 'pending';},
  ];
  const value = make();
  for (const mutate of mutations) {fingerprint(value); mutate(value); equal(value);}
});

test('new publications re-read mutable rows while an old STATE keeps its memo', () => {
  const value = make(), state = {openProjects: new Map([['p', value]])};
  const saved = actual.publishedTabSidebarProjectFingerprint(state, 'p');
  value.tabs.get('b').name = 'Changed in place';
  assert.equal(actual.publishedTabSidebarProjectFingerprint(state, 'p'), saved);
  const next = {openProjects: new Map(state.openProjects)};
  assert.equal(actual.publishedTabSidebarProjectFingerprint(next, 'p'), oracle(value));
  assert.notEqual(actual.publishedTabSidebarProjectFingerprint(next, 'p'), saved);
});

test('getter, iteration and String coercion order matches complete oracle on cache hit', () => {
  function fixture(log) {
    const value = make(), tab = value.tabs.get('a');
    const rawValues = value.tabs.values.bind(value.tabs);
    value.tabs.values = function* () {log.push('values'); for (const t of rawValues()) {log.push('yield:' + t.id); yield t;}};
    Object.defineProperty(tab, 'name', {get() {log.push('name'); return {toString() {log.push('coerce'); tab.cwd = '/changed'; return 'A';}};}});
    let cwd = '/a'; Object.defineProperty(tab, 'cwd', {get() {log.push('cwd'); return cwd;}, set(v) {log.push('set-cwd'); cwd = v;}});
    return value;
  }
  const left = [], right = [], a = fixture(left), b = fixture(right);
  for (let i = 0; i < 3; i++) assert.equal(fingerprint(a), oracle(b));
  assert.deepEqual(left, right);
});

test('getter reentry cannot reuse or overwrite a partial scalar vector', () => {
  function run(fn) {
    const value = make(), tab = value.tabs.get('a'); let inside = false, nested;
    Object.defineProperty(tab, 'name', {get() {
      if (!inside) {inside = true; value.activeTabId = 'b'; nested = fn(value); inside = false;}
      return 'A';
    }});
    const outer = fn(value);
    assert.equal(typeof nested, 'string');
    return {outer, nested, next: fn(value)};
  }
  assert.deepEqual(run(fingerprint), run(oracle));
});

test('a throwing getter after a hit leaves no partial encoding and recovery stays fresh', () => {
  const value = make(), tab = value.tabs.get('a'); fingerprint(value);
  Object.defineProperty(tab, 'name', {configurable: true, get() {throw Error('selected getter');}});
  assert.throws(() => fingerprint(value), /selected getter/);
  Object.defineProperty(tab, 'name', {value: 'Recovered', writable: true});
  equal(value); tab.name = 'Newer'; equal(value);
});

test('actual Zustand synchronous nested callbacks retain the exact observation sequence', () => {
  function run(module) {
    const value = make(), store = createStore(() => ({phase: 0, openProjects: new Map([['p', value]])})), seen = [];
    const select = state => module.publishedTabSidebarProjectFingerprint(state, 'p');
    const observe = side => state => {seen.push([side, state.phase, select(state)]);};
    const stop = [store.subscribe(observe('before')), store.subscribe(state => {
      if (state.phase !== 1) return;
      value.tabs.get('a').name = 'Nested'; store.setState({phase: 2});
    }), store.subscribe(observe('after'))];
    store.setState({phase: 1}); store.setState({phase: 3}); stop.forEach(f => f()); return seen;
  }
  assert.deepEqual(run(actual), run(before));
});

test('independent retained workspaces do not share stale encodings', () => {
  const a = make(), b = make(); b.projectId = 'other';
  for (let i = 0; i < 12; i++) {
    a.tabs.get('a').completionNotificationFired = i % 2 === 0;
    b.tabs.get('a').completionNotificationArmed = i % 3 === 0;
    equal(a); equal(b);
  }
});

test('History, composer and provider payloads remain unread', () => {
  const value = make();
  for (const obj of [value, ...value.tabs.values()]) for (const field of ['notes', 'sdkMessages', 'draft', 'providerConfig', 'scrollPosition']) {
    Object.defineProperty(obj, field, {get() {throw Error('private ' + field);}});
  }
  equal(value); equal(value);
});

test('equal fresh captures keep all scalar reads but encode only once', () => {
  const value = make(), tab = value.tabs.get('a'); let reads = 0, joins = 0;
  Object.defineProperty(tab, 'name', {get() {reads++; return 'A';}});
  const join = Array.prototype.join;
  try {
    Array.prototype.join = function (...args) {joins++; return Reflect.apply(join, this, args);};
    fingerprint(value); fingerprint(value); fingerprint(value);
  } finally {Array.prototype.join = join;}
  assert.equal(reads, 3);
  assert.equal(joins, 1, 'unchanged vectors must avoid repeated encoding/join');
});

test('ordered project IDs keep exact encoding without identity reuse', () => {
  const projects = new Map([['p:|💬', {}], [2n, {}], ['', {}]]);
  for (const map of [projects, new Map([...projects].reverse()), new Map(projects), null]) {
    assert.equal(actual.openProjectIdsFingerprint(map), before.openProjectIdsFingerprint(map));
  }
});

test('1200 mixed in-place publications compare exactly with the full preimage', () => {
  const value = make();
  for (let i = 0; i < 1200; i++) {
    const tab = value.tabs.get(i % 2 ? 'a' : 'b');
    switch (i % 6) {
      case 0: tab.name = 'name:|' + i; break;
      case 1: tab.completionNotificationFired = i % 4 === 1; break;
      case 2: value.activeTabId = i % 4 ? 'a' : 'b'; break;
      case 3: tab.restartAfterTabIds = [String(i), 'a']; break;
      case 4: value.selectedTabIds = [tab.id]; break;
      case 5: tab.cwd = '/path/' + i; break;
    }
    const state = {openProjects: new Map([['p', value]])};
    assert.equal(actual.publishedTabSidebarProjectFingerprint(state, 'p'), before.publishedTabSidebarProjectFingerprint(state, 'p'));
    equal(value);
  }
});
