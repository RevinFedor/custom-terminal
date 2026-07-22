'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSaveTabsAck,
  runSaveTabsWithAck,
} = require('./save-tabs-ack');

test('save-tabs ACK is true only when the persistence layer explicitly committed', () => {
  assert.deepEqual(normalizeSaveTabsAck({ success: true }), { success: true });
  assert.deepEqual(normalizeSaveTabsAck({ success: false, error: 'project_not_found' }), {
    success: false,
    error: 'project_not_found',
  });
  assert.deepEqual(normalizeSaveTabsAck(undefined), {
    success: false,
    error: 'save_tabs_not_committed',
  });
});

test('save-tabs ACK converts thrown DB failures into an explicit failure', () => {
  assert.deepEqual(runSaveTabsWithAck(() => ({ success: true })), { success: true });
  assert.deepEqual(runSaveTabsWithAck(() => {
    throw new Error('database is locked');
  }), {
    success: false,
    error: 'database is locked',
  });
});
