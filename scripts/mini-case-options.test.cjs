'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function parser(name) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  const start = source.indexOf('function options('), end = source.indexOf('\nconst json', start);
  const fallbackEnd = source.indexOf('\nconst sha', start);
  const body = source.slice(start, end < 0 ? fallbackEnd : end);
  const context = { path, topic: '/own/topic' }; vm.runInNewContext(body + '\nthis.parse=options;', context); return context.parse;
}
test('read evaluator supports new immutable cases with explicit environment notes', () => {
  const parse = parser('evaluate-mini-cases.cjs');
  const p = parse(['--main-case', '/own/A.json', '--logs-case', '/own/B.json', '--generation', 'readonly-v3-real-read', '--notes', '/own/notes.json']);
  assert.equal(p.mainCase, '/own/A.json'); assert.equal(p.logsCase, '/own/B.json'); assert.equal(p.generation, 'readonly-v3-real-read');
  assert.equal(p.notesFile, '/own/notes.json');
  assert.throws(() => parse(['--main-case', '/own/A.json']), /notes_required/);
  assert.throws(() => parse(['--generation', '../foreign', '--notes', '/own/n.json']), /invalid_generation/);
  assert.throws(() => parse(['--send', 'foreign']), /invalid_arguments/);
});
test('new ready generation changes only owned output namespace, never resets old profile', () => {
  const parse = parser('prepare-mini-ready-dev.cjs');
  const p = parse(['--generation', 'readonly-v3-real-read', '--reviews-folder', '/own/reviews']);
  assert.equal(p.generation, 'readonly-v3-real-read'); assert.equal(p.reviewsFolder, '/own/reviews');
  assert.throws(() => parse(['--generation', '../../other']), /invalid_generation/);
});

test('actual ready result loader admits bounded real receipts, retains input counts and refuses foreign or duplicate owners', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'prepare-mini-ready-dev.cjs'), 'utf8');
  const begin = source.indexOf('  if (!Array.isArray(latest.results)'), end = source.indexOf('  const root = await fs.realpath', begin);
  assert.ok(begin >= 0 && end > begin);
  const load = new Function('latest', 'fs', 'topic', 'path', 'return (async()=>{' + source.slice(begin, end) + ';return latest.results})()');
  const receipt = (id) => ({ apiReceivedAndReturned: true, rpcCount: 2, automaticSends: 0,
    sessionId: id, caseFile: '/own/topic/replay/' + id + '/CASE.json' });
  const rows = { '/own/topic/replay/a/RESULT.json': receipt('a'), '/own/topic/replay/b/RESULT.json': receipt('b'),
    '/own/topic/replay/a/CASE.json': { additionalInputsFile: '/own/topic/replay/a/extra.json' },
    '/own/topic/replay/b/CASE.json': {}, '/own/topic/replay/a/extra.json': [{ rawLine: 389, text: 'literal' }] };
  const calls = [], io = { realpath: async p => p, lstat: async () => ({ size: 20 }),
    readFile: async p => { calls.push(p); assert.ok(rows[p], p); return JSON.stringify(rows[p]); } };
  const entries = [{ resultFile: '/own/topic/replay/a/RESULT.json', caseName: 'Before', caseKey: 'before', sessionId: 'must-not-override' },
    { resultFile: '/own/topic/replay/b/RESULT.json', caseName: 'After', caseKey: 'after' }];
  const result = await load({ results: entries }, io, '/own/topic', path);
  assert.equal(result[0].sessionId, 'a'); assert.equal(result[0].requestCount, 2);
  assert.equal(result[1].requestCount, 1); assert.equal(result[0].caseName, 'Before');
  assert.equal(rows['/own/topic/replay/a/RESULT.json'].caseName, undefined, 'frozen receipt never rewritten');
  await assert.rejects(load({ results: [entries[0], entries[0]] }, io, '/own/topic', path), /bounded_genuine/);
  await assert.rejects(load({ results: [entries[0], { resultFile: '/foreign/RESULT.json' }] }, io, '/own/topic', path), /scope_or_cap/);
  assert.equal((await load({ results: [receipt('a')] }, io, '/own/topic', path)).length, 1, 'a ready primary example does not need an optional secondary');
  await assert.rejects(load({ results: [] }, io, '/own/topic', path), /bounded_genuine/);
  const unconfirmed = { ...receipt('b'), apiReceivedAndReturned: false };
  await assert.rejects(load({ results: [receipt('a'), unconfirmed] }, io, '/own/topic', path), /bounded_genuine/);
});
