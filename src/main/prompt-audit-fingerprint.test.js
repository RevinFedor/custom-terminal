'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

test('prompt audit fingerprint matches the terminal transport contract', () => {
  assert.equal(promptAuditFingerprint('hello'), 'aaf4c61ddcc5e8a2');
  assert.notEqual(promptAuditFingerprint(' hello '), promptAuditFingerprint('hello'));
});
