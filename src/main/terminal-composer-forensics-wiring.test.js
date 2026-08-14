'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('every headless mirror owns a bounded composer forensic ledger', () => {
  const createStart = main.indexOf('function createHeadlessTerminalMirror(');
  const createEnd = main.indexOf('function waitForHeadlessSynchronizedOutputClose(', createStart);
  const create = main.slice(createStart, createEnd);
  assert.match(create, /composerForensics:\s*createTerminalComposerForensics\(\)/);

  const writeStart = main.indexOf('function writeHeadlessTerminalMirror(');
  const writeEnd = main.indexOf('function getHeadlessTerminalBufferText(', writeStart);
  const write = main.slice(writeStart, writeEnd);
  assert.match(write, /recordTerminalComposerOutput\(state\.composerForensics, data, \{ seq \}\)/);
  assert.ok(
    write.indexOf('recordTerminalComposerOutput') < write.indexOf('state.writePump.push'),
    'raw PTY bytes must be retained before the same sequence is parsed by xterm',
  );
});

test('only authoritative committed frames become composer observations', () => {
  const commitStart = main.indexOf('function commitHeadlessVisibleBufferSnapshot(');
  const commitEnd = main.indexOf('function parseClaudeDraftFromVisibleSnapshot(', commitStart);
  const commit = main.slice(commitStart, commitEnd);
  assert.match(commit, /frameBlocker !== null/);
  assert.match(commit, /authoritativeFrameCommitted:\s*true/);
  assert.match(commit, /observeCommittedTerminalComposerForensics\(/);
  assert.ok(
    commit.indexOf('state.lastCommittedVisibleSnapshot = committed')
      < commit.indexOf('observeCommittedTerminalComposerForensics'),
    'forensics must describe the same frame that main accepted as committed truth',
  );
});

test('paste, Enter, manual input, and Ctrl+G leave causal input boundaries', () => {
  assert.match(main, /kind:\s*'programmatic-paste'[\s\S]{0,420}term\.write\(payload\)/);
  const programmaticEnter = main.indexOf("? 'programmatic-enter'");
  const submitWrite = main.indexOf('term.write(submitSequence)', programmaticEnter);
  assert.ok(
    programmaticEnter > 0 && submitWrite > programmaticEnter && submitWrite - programmaticEnter < 900,
    'the final safe-paste submit boundary must record its exact input before writing it',
  );
  assert.match(main, /phase:\s*'renderer-received'[\s\S]{0,280}source:\s*'terminal:input'/);
  assert.match(main, /source:\s*'manual-terminal-enter'[\s\S]{0,300}term\.write\(data\)/);
  const ctrlGTrace = main.indexOf("kind: 'ctrl-g'");
  const ctrlGWrite = main.indexOf("term.write('\\x07')", ctrlGTrace);
  assert.ok(
    ctrlGTrace > 0 && ctrlGWrite > ctrlGTrace && ctrlGWrite - ctrlGTrace < 420,
    'the exact-editor shortcut must be recorded before Ctrl+G crosses the PTY',
  );
});

test('a screen-versus-exact-input contradiction persists one latest JSON artifact', () => {
  const contradictionStart = main.indexOf('function logAgentDraftProofContradiction(');
  const contradictionEnd = main.indexOf('function logAgentDraftProofContradictionAfterReturn(', contradictionStart);
  const contradiction = main.slice(contradictionStart, contradictionEnd);
  assert.match(contradiction, /captureAgentDraftForensicArtifact\(/);

  const artifactStart = main.indexOf('async function captureAgentDraftForensicArtifact(');
  const artifactEnd = main.indexOf("ipcMain.on('terminal:draft-screen-diagnostic-response'", artifactStart);
  const artifact = main.slice(artifactStart, artifactEnd);
  assert.match(artifact, /snapshotTerminalComposerForensics\(/);
  assert.match(artifact, /agent-draft-forensics-\$\{safeTab\}-latest\.json/);
  assert.match(artifact, /fs\.promises\.rename\(temporaryPath, artifactPath\)/);
  assert.match(artifact, /\[AgentDraftProof:FORENSIC_ARTIFACT\]/);
});
