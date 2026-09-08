'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifyClaudeProcessCommand, claudeProcessSessionArgument } = require('./claude-process-command');

const SID = '61543df8-35ba-4a0d-b341-d61f32e7e526';
const OTHER = '11111111-2222-3333-4444-555555555555';
// Exact E2E invocation at 2026-09-05T01:00:54.378Z. The incident's transient
// PID was not captured, so this fixture intentionally contains no claimed PID.
const MCP_CLIENT = `node /private/tmp/noted-control-20260905.NgdE2L/e2e-mcp.mjs start_ai '{"tabId":"__noted_inbox__-tab-9","projectId":"__noted_inbox__","agent":"claude","sessionId":"${SID}","mode":"continue","cwd":"/private/tmp/noted-control-20260905.NgdE2L/fixture","model":"claude-haiku-4-5-20251001","effort":"low"}'`;

test('the real Node MCP JSON request is not a Claude process or an external session owner', () => {
  assert.equal(classifyClaudeProcessCommand(MCP_CLIENT), null);
  assert.equal(claudeProcessSessionArgument(MCP_CLIENT, SID), null);
  assert.equal(claudeProcessSessionArgument(MCP_CLIENT.replace(/'/g, ''), SID), null,
    'ps can omit the shell quoting; JSON contents must still not identify the executable');
});

test('native and Node CLI entrypoints accept exact resume, short resume and session-id argv', () => {
  const executables = [
    'claude', '/Users/test/.local/bin/claude', '"/Applications/Claude Tools/claude"',
    '/Users/test/.local/share/claude/versions/2.1.88',
    'node /usr/local/bin/claude',
    '"/Applications/Node Tools/node" "/Applications/Claude Tools/claude"',
    '/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    'node /usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    'node --require "./preload helper.cjs" --max-old-space-size=8192 /usr/local/bin/claude',
  ];
  for (const executable of executables) {
    for (const flag of ['--resume', '-r', '--session-id']) {
      for (const argument of [`${flag} ${SID}`, `${flag}="${SID}"`]) {
        const command = `${executable} --dangerously-skip-permissions ${argument}`;
        assert.ok(classifyClaudeProcessCommand(command), command);
        assert.ok(claudeProcessSessionArgument(command, SID), command);
        assert.equal(claudeProcessSessionArgument(command, OTHER), null, command);
      }
    }
  }
});

test('client/eval/echo text, quoted prompt text and wrong UUIDs never authorize ownership', () => {
  const nonOwners = [
    `node /tmp/claude-client/client.mjs --resume ${SID}`,
    `node --eval 'console.log("claude --resume ${SID}")'`,
    `node --title claude /tmp/client.mjs --resume ${SID}`,
    `node --require /usr/local/bin/claude /tmp/client.mjs --resume ${SID}`,
    `echo claude --resume ${SID}`,
    `bash -lc 'claude --resume ${SID}'`,
    `claude --system-prompt 'example --resume ${SID}'`,
    `claude -- ${'--resume'} ${SID}`,
    `claude --resume ${SID}extra`,
    `claude --resume ${OTHER} --model '${SID}'`,
    `claude '{"agent":"claude","sessionId":"${SID}"}'`,
  ];
  for (const command of nonOwners) assert.equal(claudeProcessSessionArgument(command, SID), null, command);
});

function mainHelpers(processes, bridge = null) {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const part = (name, async = false) => {
    const start = main.indexOf((async ? 'async ' : '') + 'function ' + name + '(');
    return main.slice(start, main.indexOf('\n}\n', start) + 3);
  };
  const logs = [];
  const context = {
    classifyClaudeProcessCommand, claudeProcessSessionArgument,
    claudeSessionKey: value => String(value || '').trim().toLowerCase(),
    CLAUDE_SESSION_ID_RE: /^[0-9a-f-]{36}$/,
    getProcessTreeSnapshot: async () => ({ processesByPid: new Map(processes.map((p, i) => [p.pid ?? i, p])) }),
    path, bridgeDir: '/synthetic/bridge', BRIDGE_STALE_SECONDS: 600,
    fs: { promises: { readFile: async file => {
      assert.equal(file, '/synthetic/bridge/' + SID + '.json');
      if (!bridge) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return JSON.stringify(bridge);
    } }, existsSync: () => true },
    console: { warn: message => logs.push(message) },
  };
  const functions = vm.runInNewContext(
    part('commandLooksLikeAiProcess') + '\n' + part('looksLikeClaudeProcessCommand')
    + '\n' + part('getClaudeJsonlExternalOwner', true)
    + '\n({ getClaudeJsonlExternalOwner, looksLikeClaudeProcessCommand })', context,
  );
  return { ...functions, logs };
}

test('actual main external argv guard selects a real CLI and logs PID/proof without argv', async () => {
  const h = mainHelpers([{ cmd: MCP_CLIENT },
    { pid: 42, ppid: 7, cmd: `claude --resume=${SID} --system-prompt VERY_SECRET_VALUE` }]);
  const owner = await h.getClaudeJsonlExternalOwner(SID);
  assert.equal(owner.pid, 42, 'synthetic real CLI PID, not an alleged incident PID');
  assert.equal(owner.reason, 'external-ps-resume');
  assert.equal(owner.proofKind, 'claude-native-cli:--resume');
  assert.match(h.logs.join('\n'), /pid=42 proofKind=claude-native-cli:--resume/);
  assert.doesNotMatch(h.logs.join('\n'), /VERY_SECRET_VALUE|--system-prompt|e2e-mcp/);
});

test('exact bridge guard still protects a real continued CLI with no session flag', async () => {
  const bridge = { session_id: SID, ppid: 42, updated_at: Math.floor(Date.now() / 1000), transcript_path: '/synthetic/transcript' };
  const h = mainHelpers([{ pid: 42, cmd: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --continue' }], bridge);
  const owner = await h.getClaudeJsonlExternalOwner(SID);
  assert.equal(owner.reason, 'external-bridge');
  assert.equal(owner.pid, 42);
  assert.equal(owner.proofKind, 'exact-session-bridge:claude-node-cli');
  const reusedPid = mainHelpers([{ pid: 42, cmd: MCP_CLIENT }], bridge);
  assert.equal(await reusedPid.getClaudeJsonlExternalOwner(SID), null);
  const wrongSession = mainHelpers([{ pid: 42, cmd: 'claude --continue' }], { ...bridge, session_id: OTHER });
  assert.equal(await wrongSession.getClaudeJsonlExternalOwner(SID), null);
});
