'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  AGENT_SHELL_TOOL_CLASSIFIER,
  buildAgentShellLaunchInput,
  classifyTerminalForegroundSnapshot,
  classifyAgentShellCommand,
  createClaudeBridgeProcessStartTracker,
  decideAgentShellLaunchAdmission,
  isAgentShellLaunchInterruptPrelude,
  parseOsc133AgentTool,
  shouldClaimManualClaudeShellLaunch,
  shouldClearClaudeShellLaunchOnCommandFinished,
} = require('./ai-shell-launch');

test('hook-route prebinding cannot consume the first Bridge process-start signal', () => {
  const tracker = createClaudeBridgeProcessStartTracker();

  // The hook router may already know pid -> tab before statusLine writes its
  // first bridge file. Fresh-process ownership is deliberately independent of
  // that routing cache, so the first Bridge observation still emits readiness.
  assert.equal(tracker.claim(4242, 'tab-a'), true);
  assert.equal(tracker.claim(4242, 'tab-a'), false);

  assert.equal(tracker.clearTab('tab-a'), 1);
  assert.equal(tracker.claim(4242, 'tab-a'), true, 'a later process generation can emit again');
  assert.equal(tracker.clearPid(4242), true);
  assert.equal(tracker.claim(4242, 'tab-b'), true, 'PID reuse by another tab is a fresh owner');
});

test('agent shell launch cancels the raw shell draft before the command', () => {
  assert.equal(
    buildAgentShellLaunchInput('codex resume 123'),
    '\x03codex resume 123\r',
  );
  assert.equal(
    buildAgentShellLaunchInput('claude --resume 123\r'),
    '\x03claude --resume 123\r',
  );
});

test('agent shell launch rejects an empty command', () => {
  assert.throws(() => buildAgentShellLaunchInput(' \r\n'), /command is required/i);
});

test('only a proven idle shell admits the destructive Ctrl+C launch byte', () => {
  assert.deepEqual(
    decideAgentShellLaunchAdmission({ processLookupStatus: 'absent' }),
    { allowed: true, reason: 'proven_idle_shell' },
  );
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'unknown' }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'found' }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', commandRunning: true }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', lifecycleClaimed: true }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', stopping: true }).allowed, false);
});

test('foreground snapshot distinguishes idle shell, live job and unknown process group', () => {
  assert.deepEqual(classifyTerminalForegroundSnapshot({
    shellProcess: { pid: 100, pgid: 100, tpgid: 100 },
    descendants: [],
  }), {
    status: 'absent',
    reason: 'shell-is-foreground',
    matches: [],
  });

  const live = classifyTerminalForegroundSnapshot({
    shellProcess: { pid: 100, pgid: 100, tpgid: 200 },
    descendants: [{ pid: 201, ppid: 100, pgid: 200, cmd: 'npm run dev' }],
  });
  assert.equal(live.status, 'found');
  assert.deepEqual(live.matches.map((entry) => entry.pid), [201]);

  assert.equal(classifyTerminalForegroundSnapshot({
    shellProcess: { pid: 100, pgid: 100, tpgid: 200 },
    descendants: [],
  }).status, 'unknown');
});

test('only the expected Ctrl+C edge before the new OSC command start is launch prelude', () => {
  assert.equal(isAgentShellLaunchInterruptPrelude({
    exitCode: 130,
    expectsInterruptPrelude: true,
    sawOscCommandStart: false,
    sameTerminal: true,
  }), true);

  assert.equal(isAgentShellLaunchInterruptPrelude({
    exitCode: 0,
    expectsInterruptPrelude: true,
    sawOscCommandStart: false,
    sameTerminal: true,
  }), false);
  assert.equal(isAgentShellLaunchInterruptPrelude({
    exitCode: 130,
    expectsInterruptPrelude: true,
    sawOscCommandStart: true,
    sameTerminal: true,
  }), false);
  assert.equal(isAgentShellLaunchInterruptPrelude({
    exitCode: 130,
    expectsInterruptPrelude: true,
    sawOscCommandStart: false,
    sameTerminal: false,
  }), false);
});

test('shell command classification identifies agent executable positions without returning arguments', () => {
  assert.equal(classifyAgentShellCommand('claude --dangerously-skip-permissions'), 'claude');
  assert.equal(classifyAgentShellCommand(' command claude --resume secret-session-id'), 'claude');
  assert.equal(classifyAgentShellCommand('cd /tmp && /opt/bin/claude --resume secret-session-id'), 'claude');
  assert.equal(classifyAgentShellCommand('echo claude --dangerously-skip-permissions'), null);
  assert.equal(classifyAgentShellCommand('printf codex | sed s/x/y/'), null);
  assert.equal(classifyAgentShellCommand('codex resume secret-session-id'), 'codex');
  assert.equal(classifyAgentShellCommand('gemini'), 'gemini');
});

test('generated shell classifier emits only allow-listed tool names', () => {
  assert.match(AGENT_SHELL_TOOL_CLASSIFIER, /printf "claude"/);
  assert.match(AGENT_SHELL_TOOL_CLASSIFIER, /printf "codex"/);
  assert.match(AGENT_SHELL_TOOL_CLASSIFIER, /printf "gemini"/);
  assert.doesNotMatch(AGENT_SHELL_TOOL_CLASSIFIER, /printf[^\n]*__ct_cmd/);
});

test('generated classifier runs in both supported shells', () => {
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    const classify = (command) => spawnSync(
      shell,
      ['-fc', AGENT_SHELL_TOOL_CLASSIFIER + '\n__ct_agent_tool "$1"', 'noted-test', command],
      { encoding: 'utf8' },
    );
    const direct = classify('claude --dangerously-skip-permissions');
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(direct.stdout, 'claude');
    assert.equal(classify('cd /tmp && /opt/bin/codex resume secret').stdout, 'codex');
    assert.equal(classify('echo claude --dangerously-skip-permissions').stdout, '');
  }
});

test('OSC 133 tool metadata accepts only the explicit allow-list', () => {
  assert.equal(parseOsc133AgentTool('tool=claude'), 'claude');
  assert.equal(parseOsc133AgentTool('source=shell;tool=codex'), 'codex');
  assert.equal(parseOsc133AgentTool('tool=CLAUDE'), 'claude');
  assert.equal(parseOsc133AgentTool('tool=unknown'), null);
  assert.equal(parseOsc133AgentTool('tool=claude --resume secret'), null);
  assert.equal(parseOsc133AgentTool(null), null);
});

test('manual Claude OSC command claims lifecycle only when no accepted launch already owns it', () => {
  assert.deepEqual(
    shouldClaimManualClaudeShellLaunch({ oscTool: 'claude' }),
    { claim: true, reason: 'manual_shell_command' },
  );
  assert.deepEqual(
    shouldClaimManualClaudeShellLaunch({ oscTool: 'claude', hasMatchingStartupIntent: true }),
    { claim: false, reason: 'launch_already_claimed' },
  );
  assert.equal(shouldClaimManualClaudeShellLaunch({ oscTool: 'codex' }).claim, false);
  assert.equal(shouldClaimManualClaudeShellLaunch({ oscTool: null }).claim, false);
});

test('manual shell claim is cleared by its real command-finished boundary', () => {
  assert.deepEqual(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true,
    startupIntentReason: 'claude-shell-osc',
    sawOscCommandStart: true,
    sameTerminal: true,
  }), {
    clear: true,
    reason: 'manual-shell-command-finished',
  });

  assert.equal(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true,
    startupIntentReason: 'claude-run-command',
    sawOscCommandStart: true,
    sameTerminal: true,
  }).clear, true);
  assert.equal(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true,
    hasPendingPrompt: true,
    startupIntentReason: 'claude-run-command',
    sawOscCommandStart: false,
    sameTerminal: true,
  }).clear, false, 'the launch Ctrl+C prelude must still be ignored');
  assert.equal(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true,
    startupIntentReason: 'claude-shell-osc',
    sawOscCommandStart: true,
    sameTerminal: false,
  }).clear, false);
  assert.equal(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: false,
    hasPendingPrompt: false,
  }).clear, true);
});

test('graceful shutdown preserves Claude session ownership through command-finished', () => {
  assert.deepEqual(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true,
    startupIntentReason: 'claude-shell-osc',
    sawOscCommandStart: true,
    sameTerminal: true,
    gracefulShutdownInProgress: true,
  }), {
    clear: false,
    reason: 'graceful-shutdown-preserve-session',
  });

  assert.deepEqual(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: false,
    hasPendingPrompt: false,
    gracefulShutdownInProgress: true,
  }), {
    clear: false,
    reason: 'graceful-shutdown-preserve-session',
  });
});
