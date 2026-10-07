const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const tree = ts.createSourceFile('driver.mjs', fs.readFileSync(path.join(__dirname,
  'renderer-ring-glow-regression.mjs'), 'utf8'), ts.ScriptTarget.Latest, true);
let callback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'app.evaluate'
    && node.arguments[0].getText(tree).includes("once('paint'")) callback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(callback);

for (const outcome of ['paint', 'timeout', 'invalidate-error']) test(`actual native barrier cleans its listener and deadline on ${outcome}`, async () => {
  const contents = new EventEmitter();
  contents.invalidate = () => { if (outcome === 'invalidate-error') throw new Error('closed'); };
  const timers = new Map();
  const wait = vm.runInNewContext('(' + callback.getText(tree) + ')', {
    win: { webContents: contents }, setTimeout: (fn, delay) => { assert.equal(delay, 3000); timers.set(1, fn); return 1; },
    clearTimeout: id => timers.delete(id),
  });
  const result = wait();
  if (outcome === 'paint') { contents.emit('paint'); assert.equal(await result, true); }
  else if (outcome === 'timeout') { timers.get(1)(); await assert.rejects(result, /native paint timeout/); }
  else await assert.rejects(result, /closed/);
  assert.equal(contents.listenerCount('paint'), 0);
  assert.equal(timers.size, 0);
});
