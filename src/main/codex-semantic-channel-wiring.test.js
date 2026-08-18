'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(__dirname, 'terminal-history-preview-controller.js'),
  'utf8',
);
const codexRoot = path.resolve(__dirname, '../../packages/codex/codex-rs/tui/src');
const codexLib = fs.readFileSync(path.join(codexRoot, 'lib.rs'), 'utf8');
const codexProtocol = fs.readFileSync(path.join(codexRoot, 'chatwidget/protocol.rs'), 'utf8');
const codexChannel = fs.readFileSync(path.join(codexRoot, 'noted_side_channel.rs'), 'utf8');

test('terminal generation owns one private semantic socket and custom Codex PATH', () => {
  const prepareAt = mainSource.indexOf('await prepareCodexSemanticChannel(tabId)');
  const spawnAt = mainSource.indexOf('ptyProcess = pty.spawn(', prepareAt);
  assert.ok(prepareAt > 0 && spawnAt > prepareAt);
  assert.match(mainSource.slice(prepareAt, spawnAt), /NOTED_TERMINAL_CODEX_EVENTS_SOCKET/);
  assert.match(mainSource.slice(prepareAt, spawnAt), /notedCodexBinPath/);
  assert.match(mainSource.slice(prepareAt, spawnAt), /expectSemanticSource\(\{ tabId \}\)/);
  assert.match(mainSource, /closeCodexSemanticChannel\(tabId, 'pty-exit'\)/);
  assert.match(mainSource, /closeCodexSemanticChannel\(tabId, 'terminal-kill'\)/);
});

test('semantic hello disables xterm prose inference and raw deltas own preview text', () => {
  assert.match(mainSource, /activateSemanticSource\(\{/);
  assert.match(mainSource, /observeSemanticEvent\(\{/);
  assert.match(controllerSource, /state\.sourceMode === 'semantic-pending'/);
  assert.match(controllerSource, /semanticItem\.text \+= event\.delta/);
  assert.match(controllerSource, /semantic-assistant-completed/);
});

test('patched Codex exports pre-render notifications without replacing its PTY', () => {
  assert.match(codexLib, /mod noted_side_channel;/);
  assert.match(codexLib, /noted_side_channel::initialize\(\)/);
  assert.match(codexProtocol, /noted_side_channel::emit_notification\(&notification\)/);
  assert.match(codexChannel, /NOTED_TERMINAL_CODEX_EVENTS_SOCKET/);
  assert.match(codexChannel, /ServerNotification::AgentMessageDelta/);
  assert.match(codexChannel, /ServerNotification::ItemCompleted/);
});
