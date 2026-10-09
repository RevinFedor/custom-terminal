'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computedPatchWriteIntents, computedPatchResultFailed, computedPatchResultYielded } = require('./codex-computed-patch-intent');

const patch = 'text(await tools.apply_patch(`*** Begin Patch\n*** Update File: ${path}\n@@\n${old}\n*** End Patch`));';
const call = input => ({ type: 'custom_tool_call', name: 'exec', input });

test('a computed patch with an immutable absolute path has one bounded write intent', () => {
  const source = 'const path="/project/work.md"; const old=await tools.exec_command({cmd:"read"});\n' + patch;
  assert.deepEqual(computedPatchWriteIntents(call(source)).map(x => x.filePath), ['/project/work.md']);
  assert.deepEqual(computedPatchWriteIntents({ type: 'function_call', name: 'exec',
    arguments: JSON.stringify({ input: source }) }).map(x => x.filePath), ['/project/work.md']);
});

test('dynamic, mutable, reassigned, shadowed and relative paths supply no write authority', () => {
  for (const prefix of ['const path=lookup();', 'let path="/project/work.md";',
    'const path="/project/work.md"; path="/other.md";', 'const path="work.md";',
    'const path="/project/work.md"; const tools={};',
    'const path="/project/work.md"; tools.apply_patch=other;',
    'const path="/project/work.md"; function tools(){}',
    'const path="/project/work.md"; exit();',
    'const path="/project/work.md"; if(done)exit();']) {
    assert.deepEqual(computedPatchWriteIntents(call(prefix + patch)), [], prefix);
  }
});

test('quoted, conditional and unawaited patch calls never become an operation', () => {
  const prefix = 'const path="/project/work.md";';
  for (const source of [prefix + 'if(flag){' + patch + '}', prefix + 'async function run(){' + patch + '}',
    'const quoted=' + JSON.stringify(prefix + patch) + ';', prefix + patch.replace('await ', '')]) {
    assert.deepEqual(computedPatchWriteIntents(call(source)), []);
  }
});

test('literal structured patches keep their existing owner; foreign namespaces and malformed scripts are ignored', () => {
  assert.deepEqual(computedPatchWriteIntents(call('text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /project/work.md\\n@@\\n-old\\n+new\\n*** End Patch"));')), []);
  assert.deepEqual(computedPatchWriteIntents({ ...call('const path="/project/work.md";' + patch), namespace: 'mcp__foreign' }), []);
  assert.deepEqual(computedPatchWriteIntents(call('const = broken;')), []);
});

test('computed bodies are parsed without running code or inspecting a quoted error in successful output', () => {
  const source = 'const path="/project/work.md"; const old=(() => { throw new Error("NEVER EXECUTE"); })();' + patch;
  assert.equal(computedPatchWriteIntents(call(source)).length, 1);
  assert.equal(computedPatchResultFailed({ output: 'Script error: failed patch' }), true);
  assert.equal(computedPatchResultFailed({ output: '{"isError":true}' }), true);
  assert.equal(computedPatchResultFailed({ output: { error: 'failed' } }), true);
  assert.equal(computedPatchResultFailed({ is_error: true, output: '' }), true);
  assert.equal(computedPatchResultFailed({ output: 'quoted: Script error: example' }), false);
  assert.equal(computedPatchResultFailed({ output: JSON.stringify('Script error: failed') }), true);
  assert.equal(computedPatchResultFailed({ output: JSON.stringify({ content: [{ type: 'text', text: 'Script error: failed' }] }) }), true);
});

test('yielded exec frames retain uncertainty for both text and standard content wrappers', () => {
  const frame = 'Script running with cell ID 73';
  for (const output of [frame, JSON.stringify(frame), JSON.stringify({ content: [{ type: 'text', text: frame }] })]) {
    assert.equal(computedPatchResultYielded({ output }), true);
  }
  assert.equal(computedPatchResultYielded({ output: 'quoted: Script running with cell ID 73' }), false);
});
