'use strict';
// Deliberate work in a dedicated acceptance workspace, not an app busy stub.
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.cwd()), release = path.join(root, 'finish-work');
if (!root.includes('/noted4412-batch-') || !root.endsWith('/workspace')) throw Error('wrong fixture cwd');
const epoch = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(epoch || '')) throw Error('exact work epoch required');
function released() {
  try { return JSON.parse(fs.readFileSync(release, 'utf8')).epoch === epoch; } catch { return false; }
}
let sequence = 0, done = false;
function publish(name, value) {
  const output = path.join(root, name), staged = output + '.tmp-' + process.pid;
  fs.writeFileSync(staged, JSON.stringify(value)); fs.renameSync(staged, output);
}
publish('busy-started.json', { epoch, pid: process.pid, root, startedAt: Date.now() });
const output = () => process.stdout.write('owned-work-sequence:' + (++sequence) + '\n');
output();
const interval = setInterval(output, 5000);
const timer = setTimeout(() => finish('finite deadline'), 180000);
const watcher = fs.watch(root, (_event, name) => { if (name === 'finish-work' && released()) finish('released'); });
function finish(reason) {
  if (done) return;
  done = true; clearTimeout(timer); clearInterval(interval); watcher.close();
  publish('busy-finished.json', { epoch, reason, finishedAt: Date.now(), sequence });
  console.log(reason);
}
if (released()) finish('already released');
