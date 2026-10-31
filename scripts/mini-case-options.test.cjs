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
