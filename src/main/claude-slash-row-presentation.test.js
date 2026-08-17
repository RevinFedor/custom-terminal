'use strict';

/**
 * Slash rows in History must read as the FULL command.
 *
 * Production shape (session b11c2736, user screenshot 16.08): a bare
 * `/effort` or `/model` — Claude's picker flow — writes EMPTY <command-args>;
 * the chosen value exists only in the NEXT record's <local-command-stdout>
 * («Set effort level to max…», «Set model to \x1b[1mFable 5\x1b[22m…»).
 * The row rendered as a naked «/effort», which broke the user contract:
 * «пишется полная команда — название и продолжение до конца».
 *
 * These tests lock the projection-side recovery in claude-data.js: the
 * source must look ahead for the stdout record, strip its ANSI bolding, and
 * rebuild the display as `/command <recovered>`; a cancelled picker recovers
 * nothing and keeps the bare name (the honest whole truth).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dataSource = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');

test('bare picker commands recover their outcome from the stdout record', () => {
  const recover = dataSource.indexOf('const recoverBareCommandArgs =');
  assert.ok(recover >= 0, 'recovery helper must exist');
  const block = dataSource.slice(recover, recover + 1600);
  // Looks ahead in the SAME branch the projection walks.
  assert.match(block, /historyBranch\[k\]/);
  // Reads the stdout envelope, not the free text around it.
  assert.match(block, /<local-command-stdout>/);
  // Strips ANSI SGR (the stdout carries \x1b[1m…\x1b[22m around the value).
  assert.match(block, /String\.fromCharCode\(27\)/);
  // Both picker commands are covered.
  assert.match(block, /Set model to/);
  assert.match(block, /Set effort level to/);
});

test('recovery feeds the same display formatter as explicit args', () => {
  const entryFn = dataSource.indexOf('const slashCommandEntryFromText =');
  assert.ok(entryFn >= 0);
  const block = dataSource.slice(entryFn, entryFn + 900);
  // The recovered value goes through formatSlashCommandDisplay — one format
  // for `/effort max`, whether the args were explicit or recovered.
  assert.match(block, /recoverBareCommandArgs\(/);
  assert.match(block, /formatSlashCommandDisplay\(slash\.name, recovered\)/);
});
