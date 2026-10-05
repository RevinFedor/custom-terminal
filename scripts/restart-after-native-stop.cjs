// Run with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron (node-pty ABI).
// Private zsh + harmless sleeps. Uses the actual production Stop functions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const ts = require('typescript');
const pty = require('node-pty');
const { createTerminalCommandAdmission } = require('../src/main/terminal-command-admission');
const execute = promisify(execFile);
const artifact = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-restart-stop-'));
const source = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ['deterministicStopTerminal', 'performDeterministicStopTerminal'].map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}).join('\n');
let terminal;
const result = { artifact, pass: false, output: '', stopEvents: [], logs: [] };
const env = { ...process.env, ZDOTDIR: artifact, PS1: '__RA_READY__', PROMPT: '__RA_READY__', TERM: 'xterm-256color' };
for (const key of Object.keys(env)) if (/^(NOTED_|CLAUDE|CODEX_|ELECTRON_)/.test(key)) delete env[key];
const wait = (predicate, message) => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { clearInterval(timer); reject(Error(message)); }, 8000);
  const timer = setInterval(() => { if (predicate()) { clearTimeout(deadline); clearInterval(timer); resolve(); } }, 5);
});
(async () => {
  try {
    terminal = pty.spawn('/bin/zsh', ['-f'], { name: 'xterm-256color', cols: 120, rows: 25, cwd: artifact, env });
    terminal.onData(data => { result.output += data; });
    await wait(() => result.output.includes('__RA_READY__'), 'private shell did not initialize');
    terminal.write('stty -echo\r');
    await wait(() => (result.output.match(/__RA_READY__/g) || []).length >= 2, 'stty did not finish');
    const baseline = result.output.length;
    const terminals = new Map([['fixture-target', terminal]]);
    const state = { isRunning: true, runSeq: 1 };
    const context = vm.createContext({ process, console: { log: (...args) => result.logs.push(args.join(' ')) },
      terminals, terminalProjects: new Map(), terminalCommandState: new Map([['fixture-target', state]]),
      terminalCommandAdmission: createTerminalCommandAdmission(id => terminals.get(id)), terminalCommandStops: new Map(),
      mainWindow: { isDestroyed: () => false, webContents: { send: (channel, event) => result.stopEvents.push({ channel, ...event }) } },
      useUIStore_freePortsToggle: () => false, getLiveAiRuntimeOwners: () => [], resolveAiToolTypeForTab: () => null,
      clearTerminalCommandOrigin: () => {}, queueRestartRerunCommandMeta: () => {}, setTimeout,
      findDescendantPids: async root => {
        const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=,ppid=']);
        const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const found = [], parents = new Set([root]);
        let changed = true;
        while (changed) { changed = false; for (const [pid, parent] of rows) if (parents.has(parent) && !parents.has(pid)) {
          parents.add(pid); found.push(pid); changed = true;
        } }
        return found;
      },
    });
    vm.runInContext(functions, context);
    terminal.write(Array.from({ length: 10 }, (_, i) => `print __RA_BEGIN_${i + 1}__; sleep 30\r`).join(''));
    await wait(() => /\r?\n__RA_BEGIN_1__\r?\n/.test(result.output.slice(baseline)), 'first harmless command did not start');
    result.stop = await context.deterministicStopTerminal('fixture-target', false);
    assert.equal(result.stop.success, true);
    terminal.write('print __RA_VERIFY__\r');
    await wait(() => /\r?\n__RA_VERIFY__\r?\n/.test(result.output.slice(baseline)), 'old buffered commands ran instead of verification');
    const actual = result.output.slice(baseline);
    assert.deepEqual([...actual.matchAll(/\r?\n(__RA_BEGIN_\d+__)\r?\n/g)].map(match => match[1]), ['__RA_BEGIN_1__']);
    assert.ok(result.logs.some(line => line.includes('shell-input-interrupt=true')));
    assert.equal(result.stopEvents.filter(e => e.phase === 'starting').length, 1);
    result.pass = true;
  } catch (error) { result.error = error.stack || String(error); process.exitCode = 1; }
  finally {
    if (terminal) { try { terminal.kill(); } catch {} }
    fs.writeFileSync(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ artifact, pass: result.pass, error: result.error, stop: result.stop }, null, 2));
  }
})();
