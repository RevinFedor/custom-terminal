'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Fedor31Oct incident: a 959-character draft was sent as 2,031,330 characters
// because a context chip republished two linked files in full. Two causes, both
// covered here:
//   1. the recognized edit-tool list was incomplete, so an unrecognized writer
//      (NotebookEdit / apply_patch) looked like an external filesystem change;
//   2. a nested subagent's edits were attributed to the parent tab.
// Both gates decide only ATTRIBUTION of a file change; the durable receipt,
// FIFO and context storage are untouched.

const contextPath = path.join(__dirname, 'tab-work-context.js');
const source = fs.readFileSync(contextPath, 'utf8');

test('every structured file writer of both providers is recognized as an own edit', () => {
  // Load the real module so the set cannot drift from the shipped file.
  const mod = require('./tab-work-context.js');
  const probe = source.slice(source.indexOf('const AGENT_EDIT_TOOLS'),
    source.indexOf('function applyOwnedEdit'));
  for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit',
    'edit_file', 'write_file', 'apply_patch']) {
    assert.ok(probe.includes(`'${tool}'`), `missing writer: ${tool}`);
  }
  assert.ok(mod, 'module still loads with the extended set');
});

test('the observer consults the shared helper instead of an inline literal list', () => {
  // The old inline array silently omitted NotebookEdit/apply_patch. A literal
  // list at the call site is exactly how that drift happened.
  assert.match(source, /if \(step\.kind !== 'tool' \|\| !isRecognizedAgentEditTool\(step\.tool\)\) continue;/);
  assert.ok(!/\['Edit','MultiEdit','Write','edit_file','write_file'\]/.test(source),
    'the inline writer list must be gone');
});

test('MCP-prefixed and case-variant writer names resolve to the same decision', () => {
  const start = source.indexOf('function isRecognizedAgentEditTool');
  const body = source.slice(start, source.indexOf('function applyOwnedEdit'));
  // A prefixed MCP writer must be matched on its bare name, without inventing
  // new tool identities or rewriting the persisted source.
  assert.match(body, /lastIndexOf\('__'\)/);
  assert.match(body, /toLowerCase\(\)/);
});

test('subagent records never raise a context chip on the parent tab', () => {
  const start = source.indexOf('observeRecord(detail) {');
  const body = source.slice(start, start + 1600);
  assert.match(body, /message\?\.isSidechain === true\) return;/,
    'isSidechain must short-circuit before any attribution work');
  // The gate must come before the edit/shell observation, otherwise a subagent
  // edit is already attributed by the time it is checked.
  const gate = body.indexOf('isSidechain === true');
  const userText = body.indexOf('userText');
  assert.ok(gate > 0 && gate < userText,
    'the subagent gate must precede record processing');
});

test('the gate is exact: only a true flag suppresses, nothing else is inferred', () => {
  const start = source.indexOf('observeRecord(detail) {');
  const body = source.slice(start, start + 1600);
  // `=== true` keeps undefined/false/absent records on the normal path; a
  // loose check would hide ordinary edits of the owner tab.
  assert.ok(!/isSidechain\)\s*return;/.test(body),
    'a truthy check would also swallow records without the flag');
});
