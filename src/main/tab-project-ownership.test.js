'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commitTabGroupProjectTransfer,
  commitTabProjectTransfer,
} = require('./tab-project-ownership');

test('row transfer commits before live PTY ownership changes', () => {
  const terminals = new Map([['tab-a', {}]]);
  const owners = new Map([['tab-a', 'project-a']]);
  const order = [];
  const originalSet = owners.set.bind(owners);
  owners.set = (key, value) => {
    order.push('owner:' + key + ':' + value);
    return originalSet(key, value);
  };

  const result = commitTabProjectTransfer({
    terminals,
    terminalProjectIds: owners,
    tabIds: ['tab-a'],
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
    transferRows: () => {
      order.push('db');
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(order, ['db', 'owner:tab-a:project-b']);
  assert.equal(owners.get('tab-a'), 'project-b');
});

test('batch ownership transfer is fail-closed and all-or-none', () => {
  const terminals = new Map([['tab-a', {}], ['tab-b', {}]]);
  const owners = new Map([
    ['tab-a', 'project-a'],
    ['tab-b', 'project-c'],
  ]);
  let dbCalls = 0;
  const mismatch = commitTabProjectTransfer({
    terminals,
    terminalProjectIds: owners,
    tabIds: ['tab-a', 'tab-b'],
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
    transferRows: () => {
      dbCalls += 1;
      return { success: true };
    },
  });
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error, 'tab_project_owner_mismatch');
  assert.equal(dbCalls, 0);
  assert.equal(owners.get('tab-a'), 'project-a');

  owners.set('tab-b', 'project-a');
  const failedDb = commitTabProjectTransfer({
    terminals,
    terminalProjectIds: owners,
    tabIds: ['tab-a', 'tab-b'],
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
    transferRows: () => ({ success: false, error: 'sqlite_busy' }),
  });
  assert.equal(failedDb.success, false);
  assert.equal(failedDb.error, 'sqlite_busy');
  assert.equal(owners.get('tab-a'), 'project-a');
  assert.equal(owners.get('tab-b'), 'project-a');
});

test('group transfer commits its durable group and rows before live owners change', () => {
  const terminals = new Map([['tab-a', {}], ['tab-b', {}]]);
  const owners = new Map([
    ['tab-a', 'project-a'],
    ['tab-b', 'project-a'],
  ]);
  const order = [];
  const originalSet = owners.set.bind(owners);
  owners.set = (key, value) => {
    order.push('owner:' + key + ':' + value);
    return originalSet(key, value);
  };

  const result = commitTabGroupProjectTransfer({
    terminals,
    terminalProjectIds: owners,
    tabIds: ['tab-a', 'tab-b'],
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
    groupId: 'group-a',
    targetGroupId: 'group-b',
    transferRows: ({ groupId, targetGroupId, tabIds }) => {
      order.push('db:' + groupId + ':' + targetGroupId);
      return { success: true, transferred: tabIds };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(order, [
    'db:group-a:group-b',
    'owner:tab-a:project-b',
    'owner:tab-b:project-b',
  ]);
  assert.equal(owners.get('tab-a'), 'project-b');
  assert.equal(owners.get('tab-b'), 'project-b');
});

test('empty group transfer still commits the group transaction', () => {
  let calls = 0;
  const result = commitTabGroupProjectTransfer({
    terminals: new Map(),
    terminalProjectIds: new Map(),
    tabIds: [],
    sourceProjectId: 'project-a',
    targetProjectId: 'project-b',
    groupId: 'group-a',
    targetGroupId: 'group-b',
    transferRows: ({ tabIds }) => {
      calls += 1;
      return { success: true, transferred: tabIds };
    },
  });

  assert.equal(result.success, true);
  assert.equal(calls, 1);
  assert.deepEqual(result.transferred, []);
});
