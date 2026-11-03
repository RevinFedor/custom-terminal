#!/usr/bin/env node
'use strict';
// `npm run <любая-команда>-tg` — выполнить команду и прислать итог в Telegram.
//
// Usage: node scripts/run-with-telegram.js <npm-script> [args…]
//
// The point is unattended builds: `build:install` and friends run for minutes,
// and the user is not watching the terminal. The suffix says "tell me when it
// is done", nothing more.
//
// TRANSPARENCY IS THE CONTRACT. This wrapper must be invisible to the command:
//
//   • stdio is inherited, so output appears live exactly as without `-tg`;
//   • the wrapper exits with the command's own code, so `&&` chains and CI
//     behave identically;
//   • SIGINT/SIGTERM are forwarded, so Ctrl+C stops the BUILD, not just this
//     wrapper. Two paths deliver it and both must keep working: a terminal's
//     Ctrl+C signals the whole foreground process group (wrapper, npm and the
//     command all get it directly), and a programmatic kill of the wrapper
//     alone is forwarded down through npm. Deliberately NOT `detached:true`:
//     putting the build in its own group takes it OUT of the terminal's
//     foreground group, so a wrapper killed with SIGKILL would orphan a build
//     that keeps running — the "cancelled install keeps installing" case;
//   • a failed notification is reported on stderr and changes nothing else —
//     the build already happened, and swallowing its exit code because a
//     message did not send would be strictly worse than a missing message.
//
// It also must not become a second installer guard: `build:install` and the
// others already refuse to run inside Noted (`installer_inside_noted`). Those
// checks live in the commands themselves and fire normally through here.

const path = require('path');
const { spawn } = require('child_process');
const { notifyTelegram, describeOutcome } = require(path.join(__dirname, 'notify-telegram'));

function main() {
  const [script, ...args] = process.argv.slice(2);
  if (!script) {
    console.error('[run-with-telegram] usage: run-with-telegram.js <npm-script> [args…]');
    process.exitCode = 2;
    return;
  }
  const label = 'npm run ' + [script, ...args].join(' ').trim();
  const startedAt = Date.now();
  // `npm run` rather than the raw command: the suffix wraps an existing script,
  // and resolving its command line here would duplicate package.json.
  const child = spawn('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], {
    // The caller's directory, NOT this script's repo root. npm already resolved
    // the `-tg` alias in whichever package.json the user invoked, and pinning a
    // root here would silently run a different package's script in a workspace.
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  // Forward, do not intercept. The wrapper exits through the child's own close
  // event, so the interruption is still reported.
  //
  // A failure here is deliberately silent: the common case is "the build has
  // already exited", and warning about signalling a dead process would be noise
  // on every ordinary Ctrl+C that lands a moment late.
  const forward = (signal) => () => { try { child.kill(signal); } catch {} };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  child.on('error', (error) => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    console.error('[run-with-telegram] failed to start: ' + error.message);
    process.exitCode = 1;
  });

  child.on('close', async (code, signal) => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    const text = describeOutcome({ command: label, code, signal, startedAt });
    const result = await notifyTelegram({ text, label });
    if (!result.ok) {
      // Visible, but never fatal. The user asked to be told about the build;
      // if that failed they must at least learn it failed, right here.
      console.error('[run-with-telegram] Telegram-уведомление не отправлено: ' + result.reason
        + (result.error ? ' (' + result.error + ')' : ''));
    } else {
      console.log('[run-with-telegram] уведомление отправлено в Telegram');
    }
    // The command's own result, unchanged.
    process.exit(signal ? 1 : (code ?? 1));
  });
}

if (require.main === module) main();
module.exports = { main };
