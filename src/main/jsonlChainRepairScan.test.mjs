// Executes the REAL repairJsonlChainBreaks (sliced out of claude-data.js and
// compiled) against temporary transcript files.
//
// Why it exists: the boot sweep calls this function for every session touched
// since the last sweep. Measured on 01.11 (boot mvxri7jk, right after an
// install): 31 files, 17.2s of sweep, 16.9s of it blocking the main loop,
// peak heap 2261MB, 6297ms on a single 37.9MB session — and `repaired=0`, in
// both sweeps this machine has on record. The user felt it as a multi-second
// stall on the first workspace switch after the install.
//
// The cost came from retaining every decoded record for the whole file while
// only two fields are needed. The scan now keeps `uuid`/`parentUuid` per line
// and re-parses solely the lines it will rewrite.
//
// Detection correctness outranks that saving, so most assertions below are
// about WHICH breaks are found and what gets written, not about speed.
//
// Run: node --test src/main/jsonlChainRepairScan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(HERE, '../../package.json'));

const source = fs.readFileSync(path.join(HERE, 'ipc/claude-data.js'), 'utf8');
const from = source.indexOf('async function repairJsonlChainBreaks');
assert.ok(from > 0, 'repairJsonlChainBreaks must exist');
const to = source.indexOf('\nmodule.exports =', from);
assert.ok(to > from, 'the function must be sliceable');
const code = source.slice(from, to);

function build() {
  const logs = [];
  const sandbox = {
    fs,
    // The slice must not reach anything else from claude-data.js.
    findSessionFile: (sessionId, cwd) => {
      const filePath = path.join(cwd, sessionId + '.jsonl');
      return fs.existsSync(filePath) ? { filePath } : null;
    },
    _classifyOrphanFlavor: () => ({ flavor: 'test' }),
    invalidateClaudeJsonlCache: () => {},
    console: { log: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(code + '\nmodule.exports = repairJsonlChainBreaks;', sandbox);
  return { repair: sandbox.module.exports, logs };
}

function writeSession(dir, sessionId, records) {
  const filePath = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(filePath, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'), 'utf-8');
  return filePath;
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-chain-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a healthy file is reported as clean and left byte-identical', async t => {
  const dir = tmpdir(t);
  const filePath = writeSession(dir, 'healthy', [
    { uuid: 'a', parentUuid: null, type: 'user' },
    { uuid: 'b', parentUuid: 'a', type: 'assistant' },
    { uuid: 'c', parentUuid: 'b', type: 'user' },
  ]);
  const before = fs.readFileSync(filePath);
  const { repair } = build();
  const result = await repair('healthy', dir);
  assert.deepEqual({ ...result }, { repaired: 0, reason: 'no-dangling' });
  assert.deepEqual(fs.readFileSync(filePath), before, 'a clean file must not be rewritten');
  assert.deepEqual(fs.readdirSync(dir), ['healthy.jsonl'], 'and must not leave a backup');
});

test('a dangling parentUuid is relinked to the nearest preceding uuid', async t => {
  const dir = tmpdir(t);
  const filePath = writeSession(dir, 'broken', [
    { uuid: 'a', parentUuid: null, type: 'user' },
    { uuid: 'b', parentUuid: 'a', type: 'assistant' },
    { uuid: 'c', parentUuid: 'GONE', type: 'user' },
  ]);
  const { repair } = build();
  const result = await repair('broken', dir);
  assert.equal(result.repaired, 1);
  const rows = fs.readFileSync(filePath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[2].parentUuid, 'b', 'the orphan now points at its predecessor');
  assert.equal(rows[2].uuid, 'c', 'and keeps its own identity');
  assert.ok(fs.readdirSync(dir).some(name => name.includes('.autorepair-')), 'a backup is written first');
});

test('every other field of a repaired record survives verbatim', async t => {
  // The rewrite re-serializes the record, so anything dropped here is data
  // loss in the user's transcript.
  const dir = tmpdir(t);
  const original = {
    uuid: 'c', parentUuid: 'GONE', type: 'user', timestamp: '2026-11-01T10:00:00Z',
    sessionId: 'broken', cwd: '/tmp/x', message: { role: 'user', content: 'текст с "кавычками" и \n переводом' },
    toolUseResult: { nested: { deep: [1, 2, { three: true }] } }, isSidechain: false,
  };
  writeSession(dir, 'broken', [{ uuid: 'a', parentUuid: null }, original]);
  const { repair } = build();
  await repair('broken', dir);
  const rows = fs.readFileSync(path.join(dir, 'broken.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(JSON.parse(JSON.stringify(rows[1])), { ...original, parentUuid: 'a' },
    'only parentUuid may differ from the original record');
});

test('a NESTED uuid field does not satisfy the chain', async t => {
  // The scan must read top-level keys through real JSON parsing. A regex over
  // raw text (`/"uuid":"([^"]+)"/`) also matches `uuid` inside tool results
  // and sub-records — those are NOT escaped, unlike a uuid quoted inside a
  // content string — and would declare the chain intact while history is
  // actually truncated. This is the documented scar that made a "fake-OK
  // audit" report a healthy file to a user who saw truncated history.
  const dir = tmpdir(t);
  writeSession(dir, 'tricky', [
    { uuid: 'a', parentUuid: null, type: 'user',
      toolUseResult: { entries: [{ uuid: 'GONE', type: 'file' }] } },
    { uuid: 'b', parentUuid: 'GONE', type: 'assistant' },
  ]);
  const raw = fs.readFileSync(path.join(dir, 'tricky.jsonl'), 'utf-8');
  assert.match(raw, /"uuid":"GONE"/,
    'the fixture must contain an UNESCAPED decoy, or it does not test the regex trap');
  const { repair } = build();
  const result = await repair('tricky', dir);
  assert.equal(result.repaired, 1, 'the break must still be detected');
  const rows = raw && fs.readFileSync(path.join(dir, 'tricky.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows[1].parentUuid, 'a');
});

test('a forward reference is a real break, not a valid link', async t => {
  // `uuids` holds the whole file, so a parent defined LATER counts as present.
  // That is existing behaviour and must not change silently.
  const dir = tmpdir(t);
  writeSession(dir, 'forward', [
    { uuid: 'a', parentUuid: 'b' },
    { uuid: 'b', parentUuid: null },
  ]);
  const { repair } = build();
  assert.deepEqual({ ...(await repair('forward', dir)) }, { repaired: 0, reason: 'no-dangling' });
});

test('an orphan with no predecessor within 10 lines is left alone', async t => {
  const dir = tmpdir(t);
  const records = [{ uuid: 'orphan', parentUuid: 'GONE' }];
  writeSession(dir, 'first-line', records);
  const { repair } = build();
  assert.deepEqual({ ...(await repair('first-line', dir)) }, { repaired: 0, reason: 'no-dangling' });
});

test('unparsable and blank lines are preserved exactly', async t => {
  const dir = tmpdir(t);
  const filePath = writeSession(dir, 'mixed', [
    JSON.stringify({ uuid: 'a', parentUuid: null }),
    'not json at all',
    '',
    JSON.stringify({ uuid: 'b', parentUuid: 'GONE' }),
  ]);
  const { repair } = build();
  const result = await repair('mixed', dir);
  assert.equal(result.repaired, 1);
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  assert.equal(lines[1], 'not json at all', 'a junk line is untouched');
  assert.equal(lines[2], '', 'a blank line is untouched');
  assert.equal(JSON.parse(lines[3]).parentUuid, 'a', 'the orphan skips junk to find its predecessor');
});

test('several breaks in one file are all repaired', async t => {
  const dir = tmpdir(t);
  writeSession(dir, 'many', [
    { uuid: 'a', parentUuid: null },
    { uuid: 'b', parentUuid: 'X' },
    { uuid: 'c', parentUuid: 'b' },
    { uuid: 'd', parentUuid: 'Y' },
  ]);
  const { repair } = build();
  const result = await repair('many', dir);
  assert.equal(result.repaired, 2);
  const rows = fs.readFileSync(path.join(dir, 'many.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows[1].parentUuid, 'a');
  assert.equal(rows[3].parentUuid, 'c');
});

test('a missing file is reported, not thrown', async t => {
  const dir = tmpdir(t);
  const { repair } = build();
  assert.deepEqual({ ...(await repair('nope', dir)) }, { repaired: 0, reason: 'file-not-found' });
});

test('the clean path retains no decoded records', async t => {
  // The actual regression under repair: heap grew with the file, not with the
  // damage. 7946 records of the user's own 34MB transcript cost 59MB retained
  // in the old shape and 0 in the new one.
  //
  // Counting allocations directly is brittle, so this measures the heap the
  // function leaves behind for a file built to be large but healthy.
  const dir = tmpdir(t);
  const records = [{ uuid: 'u0', parentUuid: null, message: { content: 'x'.repeat(2000) } }];
  for (let i = 1; i < 4000; i++) {
    records.push({ uuid: 'u' + i, parentUuid: 'u' + (i - 1), message: { content: 'x'.repeat(2000) } });
  }
  writeSession(dir, 'large', records);
  const { repair } = build();
  // Warm up so lazily-compiled code is not counted as retention.
  await repair('large', dir);
  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const result = await repair('large', dir);
  global.gc?.();
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  assert.deepEqual({ ...result }, { repaired: 0, reason: 'no-dangling' });
  // Without --expose-gc the numbers are noise; the assertion then only has to
  // not be absurd. With it, the old shape retained tens of MB here.
  if (typeof global.gc === 'function') {
    assert.ok(retainedMb < 8, 'a clean scan must not retain the file (retained ' + retainedMb.toFixed(1) + 'MB)');
  }
});
