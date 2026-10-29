#!/usr/bin/env node
// Source-only checks. No package installation, build, app, provider or live DB.
// Each suite gets an independent process: source runtime bounds do not include
// the Babel/TypeScript ASTs used to extract actual Panel/Surface callbacks.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--report-dir')) {
  throw new Error('Usage: node scripts/run-primary-address-v46-source-checks.mjs [--report-dir NEW_DIRECTORY]');
}
const report = args.length ? resolve(args[1]) : mkdtempSync(join(tmpdir(), 'primary-address-v46-source-'));
if (args.length) mkdirSync(report, { recursive: false });
const suites = [
  ['producer', 'scripts/history-primary-address-source.test.cjs', true],
  ['model', 'src/renderer/utils/historyPrimaryPresentationAddress.actual.test.mjs', true],
  ['virtuoso', 'scripts/lib/history-primary-key-admission.test.mjs', false],
  ['panel', 'scripts/lib/history-primary-panel-callbacks.test.mjs', false],
  ['surface', 'src/renderer/utils/historyPrimaryExternalPresentation.actual.test.mjs', false],
  ['selected', 'src/renderer/utils/historyPrimarySelectedAddress.test.mjs', false],
  ['resize', 'src/renderer/utils/historyPrimaryResizeAdmission.actual.test.mjs', false],
  ['tail', 'src/renderer/utils/historyPrimaryTailCallbacks.actual.test.mjs', false],
];
const results = [];
for (const [name, file, bounded] of suites) {
  const flags = bounded ? ['--max-old-space-size=64', '--max-semi-space-size=8'] : [];
  const argv = [...flags, '--test', '--test-reporter=tap', file];
  const started = Date.now();
  const outputPath = join(report, name + '.tap'), outputFd = openSync(outputPath, 'wx');
  let child;
  try { child = spawnSync(process.execPath, argv, { cwd: root, env: process.env,
    stdio: ['ignore', outputFd, outputFd] }); }
  finally { closeSync(outputFd); }
  const output = readFileSync(outputPath, 'utf8');
  const metric = key => Number(output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? 0);
  const result = { name, file, argv, exitCode: child.status, signal: child.signal,
    error: child.error?.message, tests: metric('tests'), pass: metric('pass'),
    fail: metric('fail'), skipped: metric('skipped'), durationMs: Date.now() - started,
    testSHA256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') };
  result.success = !result.error && result.exitCode === 0 && result.tests > 0
    && result.pass === result.tests && result.skipped === 0;
  results.push(result);
  console.log(name + ': ' + (result.success ? 'PASS ' : 'FAIL ') + result.pass + '/' + result.tests);
  // Finish other independent source checks so one failure cannot hide gaps.
}
const summary = { scope: 'SOURCE_ONLY_NOT_NATIVE_E28', node: process.version, root,
  allPassed: results.every(result => result.success), suites: results,
  totals: Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    results.reduce((sum, result) => sum + result[key], 0)])) };
writeFileSync(join(report, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('Source report: ' + report);
process.exitCode = summary.allPassed ? 0 : 1;
