'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function claudeRewindHandlerSource() {
  const start = mainSource.indexOf("ipcMain.handle('claude:open-history-menu'");
  const end = mainSource.indexOf('// Codex rewind through the native TUI backtrack flow.', start);
  assert.ok(start >= 0, 'Claude Rewind handler must exist');
  assert.ok(end > start, 'Claude Rewind handler boundary must exist');
  return mainSource.slice(start, end);
}

function codexRewindHandlerSource() {
  const start = mainSource.indexOf("ipcMain.handle('codex:open-history-menu'");
  const end = mainSource.indexOf("ipcMain.on('claude:prompt-boundary-ack'", start);
  assert.ok(start >= 0, 'Codex Rewind handler must exist');
  assert.ok(end > start, 'Codex Rewind handler boundary must exist');
  return mainSource.slice(start, end);
}

test('Claude native Rewind uses one PTY transaction for both draft captures', () => {
  const handler = claudeRewindHandlerSource();

  assert.doesNotMatch(
    handler,
    /captureClaudeInput\(/,
    'the public capture wrapper would acquire the PTY lock recursively',
  );
  assert.equal(
    (handler.match(/captureAgentInputAtWriteBoundary\(/g) || []).length,
    2,
    'preflight copy and restored-input grab must reuse the owned boundary',
  );
  assert.match(handler, /ownedWriteOperation:\s*claudeRewindPtyOperation/g);
  assert.match(
    handler,
    /withPtyWriteLock\([\s\S]*?claudeRewindPtyOperation\s*\);/,
    'the outer Rewind transaction must publish its PTY owner',
  );
});

test('Claude Rewind observes cancellation before and after its preflight writes', () => {
  const handler = claudeRewindHandlerSource();
  assert.match(handler, /throwIfRewindCancelled\('locked-before-preflight'\)/);
  assert.match(handler, /throwIfRewindCancelled\('after-input-preflight'\)/);
  assert.match(handler, /throwIfRewindCancelled\('before-rewind-command'\)/);
  assert.match(handler, /throwIfRewindCancelled\('after-rewind-command'\)/);

  const cancelStart = mainSource.indexOf("ipcMain.handle('rewind:cancel'");
  const cancelEnd = mainSource.indexOf('function makeRewindCancelledError', cancelStart);
  const cancelHandler = mainSource.slice(cancelStart, cancelEnd);
  assert.match(cancelHandler, /operation\.ptyWriteOperation\.cancelRequested\s*=\s*true/);
  assert.match(cancelHandler, /operation\.ptyWriteOperation\.resolveCancel/);
  assert.match(cancelHandler, /await waitForActiveRewindSettlement\(operation\)/);
  assert.doesNotMatch(cancelHandler, /term\.write\(/, 'Cancel handler must not bypass the PTY owner');
  assert.match(handler, /sendOperationContext:\s*claudeRewindPtyOperation/);
  assert.match(handler, /throwIfRewindCancelled\('after-menu-wait'\)/);
  assert.match(handler, /throwIfRewindCancelled\('before-confirm'\)/);
});

test('Codex Rewind publishes the same cancellable PTY ownership boundary', () => {
  const handler = codexRewindHandlerSource();
  assert.match(handler, /activeRewindOperation\.ptyWriteOperation\s*=\s*codexRewindPtyOperation/);
  assert.match(handler, /throwIfCodexRewindCancelled\('locked-before-authorization'\)/);
  assert.match(handler, /throwIfCodexRewindCancelled\('after-target-authorization'\)/);
  assert.match(handler, /throwIfCodexRewindCancelled\('after-prime-' \+ attemptLabel\)/);
  assert.match(handler, /throwIfCodexRewindCancelled\('after-open-' \+ attemptLabel\)/);
  assert.match(
    handler,
    /withPtyWriteLock\([\s\S]*?codexRewindPtyOperation\s*\);/,
    'Codex cancellation must settle the exact transaction before UI unlock',
  );
});
