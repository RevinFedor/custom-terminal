'use strict';
// An instance with a private NOTED_USER_DATA_DIR must keep its diagnostics in
// that profile. Electron's `logs` path is separate from `userData` and does NOT
// follow it, so an isolated stand kept appending to the shared
// ~/Library/Logs/noted-terminal/production.log: on 01.11.2026 the user's own
// log carried 124 lines from /private/tmp/ios-e2e-20261101 (PTY:CREATED,
// Store, RestoreSession, renderer meta of foreign tabs), which is exactly the
// noise that makes an incident search return someone else's tabs.
//
// Drives the REAL startup block from main.js over a stub Electron app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const overrideBlock = ast.statements.find((node) => ts.isIfStatement(node)
  && node.expression.getText(ast) === 'process.env.NOTED_USER_DATA_DIR'
  && node.thenStatement.getText(ast).includes("app.setPath('userData'"));
assert.ok(overrideBlock, 'userData override block found in main.js');

const CANONICAL = '/Users/tester/Library/Application Support/noted-terminal';
const CANONICAL_LOGS = '/Users/tester/Library/Logs/noted-terminal';

function run(userDataDir) {
  const paths = { userData: CANONICAL, logs: CANONICAL_LOGS };
  const made = [];
  const logs = [];
  const ctx = vm.createContext({
    process: { env: userDataDir ? { NOTED_USER_DATA_DIR: userDataDir } : {} },
    path,
    fs: { mkdirSync: (target) => { made.push(target); } },
    app: {
      getPath: (key) => paths[key],
      setPath: (key, value) => { paths[key] = value; },
    },
    canonicalNotedUserDataDir: CANONICAL,
    console: { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) },
  });
  vm.runInContext(overrideBlock.getText(ast), ctx);
  return { paths, made, logs };
}

test('a private profile keeps its logs inside that profile', () => {
  const root = path.join(os.tmpdir(), 'ios-e2e-20261101', 'data', 'userData');
  const { paths, made, logs } = run(root);
  assert.equal(paths.userData, root);
  // Pre-fix this stayed at the shared ~/Library/Logs/noted-terminal.
  assert.equal(paths.logs, path.join(root, 'logs'));
  assert.ok(made.includes(path.join(root, 'logs')), 'the private logs directory is created');
  assert.ok(logs.some((line) => line.includes('logs override:')));
});

test('the ordinary install keeps the shared log, and no override leaves both paths alone', () => {
  const sameAsCanonical = run(CANONICAL);
  assert.equal(sameAsCanonical.paths.userData, CANONICAL);
  assert.equal(sameAsCanonical.paths.logs, CANONICAL_LOGS, 'the real profile must not be redirected');
  assert.ok(!sameAsCanonical.logs.some((line) => line.includes('logs override:')));

  const untouched = run(null);
  assert.equal(untouched.paths.userData, CANONICAL);
  assert.equal(untouched.paths.logs, CANONICAL_LOGS);
  assert.deepEqual(untouched.made, []);
});

test('the logs redirect happens before the file logger resolves its path', () => {
  const overrideAt = mainSource.indexOf("app.setPath('logs', logsDir)");
  const loggerAt = mainSource.indexOf("const LOG_DIR = isDev");
  assert.ok(overrideAt > 0 && loggerAt > 0);
  assert.ok(overrideAt < loggerAt,
    'PRODUCTION FILE LOGGER reads app.getPath("logs") once at startup');
});
