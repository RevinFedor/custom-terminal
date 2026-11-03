// Установка заменила `terminal-server.mjs` на диске — значит в хабе должен
// перезапуститься именно `terminal`, и только он.
//
// Шрам 02.11.2026 (Asia/Bangkok): хаб detached и переживает Build Install, а
// новый Main на старте принимает уже живой хаб как есть. Установка в 20:28:48
// переписала файл, но сервер в памяти ещё двенадцать минут исполнял код от
// 17:13 — до ручного `POST /mcp/_restart/terminal` в 20:40:43. В 20:42 вкладки
// получили `stale_transcript_revision`. Доказательство, что установка детей не
// трогала: `restarts: 1` у `terminal`, ровно тот ручной.
//
// Здесь исполняются НАСТОЯЩИЕ функции шага; HTTP — контролируемый порт.
//
// НИ ОДИН случай не ходит в живой хаб. Первый прогон этого файла реально
// перезапустил рабочий `terminal` дважды (restarts 3→5): `fetchImpl: undefined`
// не включал значение по умолчанию и запрос уходил на 53133. Поэтому транспорт
// подставляется явно, а `url` указывает в заведомо закрытый порт — чтобы
// будущая правка не достала боевой сервер по забывчивости.
//
// Запуск: node --test scripts/refresh-terminal-mcp-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readTerminalMcpRuntimeChange,
  refreshTerminalMcpRuntime,
  restartTerminalMcpServer,
  TERMINAL_MCP_RESTART_URL,
} from './refresh-terminal-mcp-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The exact shape `scripts/install-terminal-mcp.mjs` prints, with npm's own
// lines in front of it — that is what the installer actually captures.
const stepOutput = (changed) => '\n> noted-terminal@1.0.0 install:terminal-mcp\n'
  + '> node scripts/install-terminal-mcp.mjs\n\n'
  + JSON.stringify({
    ok: true,
    dryRun: false,
    serverPath: '/Users/x/.claude/mcp/terminal-server.mjs',
    changed: {
      files: ['/Users/x/.claude/mcp/terminal-server.mjs'],
      runtime: changed,
      runtimeFiles: changed ? ['/Users/x/.claude/mcp/terminal-server.mjs'] : [],
      claude: false,
      codex: false,
    },
  }, null, 2) + '\n';

function harness({ restartResult = { ok: true, restarts: 2 } } = {}) {
  const logs = [];
  let calls = 0;
  return {
    logs,
    get calls() { return calls; },
    run: (output) => refreshTerminalMcpRuntime(output, {
      restart: async () => { calls += 1; return restartResult; },
      log: (line) => logs.push(line),
    }),
  };
}

test('a replaced server file restarts terminal in the hub', async () => {
  // The reported case exactly: the file on disk is new, the process in memory
  // is old, and nobody would notice until a tab fails.
  const h = harness();
  const result = await h.run(stepOutput(true));
  assert.equal(h.calls, 1);
  assert.equal(result.restarted, true);
  assert.equal(result.reason, 'changed');
  assert.deepEqual(result.files, ['/Users/x/.claude/mcp/terminal-server.mjs']);
  assert.match(h.logs.join('\n'), /код сервера обновлён/);
  assert.match(h.logs.join('\n'), /перезапущен в хабе \(restarts=2\)/);
});

test('an unchanged file restarts nothing', async () => {
  // A needless restart is not free: it drops the live server for a moment on
  // every install that changed only the app.
  const h = harness();
  const result = await h.run(stepOutput(false));
  assert.equal(h.calls, 0, 'no request may be sent at all');
  assert.deepEqual(result, { restarted: false, reason: 'unchanged' });
  assert.match(h.logs.join('\n'), /не менялся/);
});

test('an unreachable hub reports the reason and never fails the install', async () => {
  // The install already produced a new app and a new file on disk. Losing it
  // because a messenger-grade call failed would be strictly worse; the server
  // comes up later with the new file anyway.
  for (const [reason, pattern] of [['hub_unavailable', /hub_unavailable/], ['timeout', /timeout/]]) {
    const h = harness({ restartResult: { ok: false, reason } });
    const result = await h.run(stepOutput(true));
    assert.equal(result.restarted, false);
    assert.equal(result.reason, reason);
    assert.match(h.logs.join('\n'), pattern);
    assert.match(h.logs.join('\n'), /установка продолжается/);
  }
});

test('unreadable step output restarts rather than silently skipping', async () => {
  // Skipping on an unparsed answer would reproduce the original scar: a real
  // replacement left running old code. An extra restart is the cheaper error.
  for (const output of ['', 'npm ERR! something', '{ not json', JSON.stringify({ ok: true })]) {
    const h = harness();
    const result = await h.run(output);
    assert.equal(h.calls, 1, 'unknown must not mean "unchanged" for: ' + JSON.stringify(output.slice(0, 20)));
    assert.equal(result.reason, 'unknown-output');
  }
});

test('the change is read from the step, not guessed', () => {
  assert.deepEqual(readTerminalMcpRuntimeChange(stepOutput(true)),
    { known: true, changed: true, files: ['/Users/x/.claude/mcp/terminal-server.mjs'] });
  assert.deepEqual(readTerminalMcpRuntimeChange(stepOutput(false)),
    { known: true, changed: false, files: [] });
  // A non-boolean `runtime` is not a false: it is an answer we do not have.
  assert.equal(readTerminalMcpRuntimeChange(JSON.stringify({ changed: { runtime: 'yes' } })).known, false);
  assert.equal(readTerminalMcpRuntimeChange(null).known, false);
});

test('the request targets ONLY terminal, never restart-all or the hub itself', async () => {
  // `electron` and `ios` are declared stateful: restarting them would drop a
  // live CDP connection and a simulator session. The other five are not ours.
  let seen = null;
  await restartTerminalMcpServer({
    fetchImpl: async (url, init) => {
      seen = { url, method: init?.method };
      return { ok: true, status: 200, json: async () => ({ ok: true, server: { restarts: 3 } }) };
    },
  });
  assert.equal(seen.url, 'http://127.0.0.1:53133/mcp/_restart/terminal');
  assert.equal(seen.method, 'POST');
  assert.equal(TERMINAL_MCP_RESTART_URL, seen.url);
  assert.doesNotMatch(seen.url, /_restart-all|_shutdown|_generation/);
});

test('every hub failure is distinguishable, and none of them throw', async () => {
  assert.deepEqual(await restartTerminalMcpServer({ fetchImpl: 'not-a-function', url: 'http://127.0.0.1:1/unused' }),
    { ok: false, reason: 'fetch_unavailable' });
  assert.equal((await restartTerminalMcpServer({ url: 'http://127.0.0.1:1/unused',
    fetchImpl: async () => { throw new Error('fetch failed'); } })).reason, 'hub_unavailable');
  assert.equal((await restartTerminalMcpServer({ url: 'http://127.0.0.1:1/unused',
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'unknown server: terminal' }) }) })).reason,
    'hub_refused');
  // A 200 that does not confirm `ok` is not a restart.
  assert.equal((await restartTerminalMcpServer({ url: 'http://127.0.0.1:1/unused',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).reason, 'hub_refused');
  const fine = await restartTerminalMcpServer({ url: 'http://127.0.0.1:1/unused',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, server: { restarts: 7 } }) }) });
  assert.deepEqual(fine, { ok: true, restarts: 7 });
});

test('the installer runs this step right after install:terminal-mcp and captures its output', () => {
  // Structural: the whole repair is that this step exists in the chain at all.
  const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-install-noted-terminal.mjs'), 'utf8');
  assert.match(installer, /import \{ refreshTerminalMcpRuntime \} from '\.\/refresh-terminal-mcp-runtime\.mjs';/);
  assert.match(installer, /const captureRuntimeChange = script === 'install:terminal-mcp';/);
  assert.match(installer, /captureRuntimeChange \? \{ capture: true \} : \{\}/,
    'only this one step may be captured; the others keep streaming to the terminal');
  assert.match(installer, /await refreshTerminalMcpRuntime\(stepOutput, \{ log \}\)/);
  // Captured output must still reach the install log.
  assert.match(installer, /process\.stdout\.write\(stepOutput\)/);
  // The step belongs to the prepare chain, before the app is replaced.
  const chain = installer.indexOf('for (const script of PREPARE_SCRIPTS)');
  const validate = installer.indexOf("step = 'validate-release'");
  const refresh = installer.indexOf('refreshTerminalMcpRuntime(stepOutput');
  assert.ok(chain > 0 && refresh > chain && refresh < validate);
  // PREPARE_SCRIPTS itself is unchanged: this is a step inside the loop, not a
  // seventh npm script.
  assert.match(installer, /export const PREPARE_SCRIPTS = \['build:markdown', 'build:mobile', 'build', 'sign:local-fast', 'install:terminal-mcp', 'install:claude-hook'\];/);
});

test('the hub really exposes this route and restartServer touches one child', () => {
  // Guards the assumption the whole step rests on: a single-server restart
  // exists and does not take the hub or its port down.
  const hub = fs.readFileSync(path.join(repoRoot, 'src', 'main', 'mcp-hub.js'), 'utf8');
  assert.match(hub, /parts\[1\] === '_restart' && req\.method === 'POST'/);
  assert.match(hub, /async restartServer\(name\) \{[\s\S]{0,200}await child\.restart\(\)/);
  assert.match(hub, /sendJson\(res, 200, \{ ok: true, server: st \}\)/);
});
