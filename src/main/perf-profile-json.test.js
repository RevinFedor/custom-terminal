'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { writeProfileJson } = require('./perf-profile-json');
test('bounded writer preserves profile data without invoking getters and refuses overwrite', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-profile-writer-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'profile.json'), data = { nodes: [{ id: 1, callFrame: { functionName: 'testCPU', url: 'file.js', lineNumber: 10 } }], samples: [1,1,1], startTime: 1, endTime: 5, unknown: undefined };
  const size = await writeProfileJson(file, data, 4096); assert.equal(size, fs.statSync(file).size); assert.deepEqual(JSON.parse(fs.readFileSync(file)), JSON.parse(JSON.stringify(data)));
  await assert.rejects(writeProfileJson(file, data), /EEXIST/);
  const bad = { get body() { throw Error('getter accessed'); } }; await assert.rejects(writeProfileJson(path.join(dir, 'bad.json'), bad), /accessor-refused/);
  await assert.rejects(writeProfileJson(path.join(dir, 'large.json'), { samples: new Array(4096).fill(123) }, 256), /size-limit/);
  assert(fs.statSync(path.join(dir, 'large.json')).size <= 256);
});
