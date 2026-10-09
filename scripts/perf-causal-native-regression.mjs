// Owned Electron-runtime + actual external watchdog. No production process,
// inspector, clipboard, provider or application database is opened or mutated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildSync } = require('esbuild');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-causal-native-'));
buildSync({ entryPoints: [path.join(repo, 'src/renderer/utils/perfIncidentChannel.ts')], bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', outfile: path.join(root, 'renderer-channel.cjs') });
const results = [];
for (const kind of ['cpu', 'wait', 'critical']) {
  const caseDir = path.join(root, kind); fs.mkdirSync(caseDir);
  const log = fs.openSync(path.join(caseDir, 'runner.log'), 'w');
  const child = spawn(require('electron'), [path.join(repo, 'scripts/fixtures/perf-causal-native.cjs'), repo, caseDir, kind,
    path.join(root, 'renderer-channel.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log, log] });
  const exit = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGTERM'); reject(Error('native canary timeout: ' + kind)); }, 35000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }); });
  });
  fs.closeSync(log);
  const resultFile = path.join(caseDir, 'result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : { status: 'missing-result' };
  results.push({ kind, pid: child.pid, exit, ...result });
  if (exit.code !== 0 || result.status !== 'pass') break;
}
const result = { status: results.length === 3 && results.every(r => r.status === 'pass') ? 'pass' : 'fail',
  artifact: root, results, limits: ['Electron28 Node runtime, not full workspace or live input acceptance',
    'private heavy receipts prefilled; watchdog startup warmup also remains active',
    'sample overlap uses verified capture envelope where sample v7 has no actual end timestamp'] };
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.status !== 'pass') process.exitCode = 1;
