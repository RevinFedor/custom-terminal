'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(__dirname, 'terminal-history-preview-controller.js'),
  'utf8',
);
const diagnosticSource = fs.readFileSync(
  path.join(__dirname, 'terminal-history-preview-diagnostic.js'),
  'utf8',
);
const serviceSource = fs.readFileSync(path.join(__dirname, 'session-transcript-service.js'), 'utf8');
const historySource = fs.readFileSync(path.join(
  __dirname,
  '..',
  'renderer',
  'components',
  'Workspace',
  'HistoryPanel.tsx',
), 'utf8');
const composerSource = fs.readFileSync(path.join(
  __dirname,
  '..',
  'renderer',
  'components',
  'Workspace',
  'AIConversation',
  'AIComposerSurface.tsx',
), 'utf8');
const uiStoreSource = fs.readFileSync(path.join(
  __dirname,
  '..',
  'renderer',
  'store',
  'useUIStore.ts',
), 'utf8');

test('terminal preview consumes only committed headless frames', () => {
  assert.match(
    mainSource,
    /const committedSnapshot = commitHeadlessVisibleBufferSnapshot[\s\S]{0,240}terminalHistoryPreviewController\.observeFrame\(tabId, state, committedSnapshot\)/,
  );
  assert.match(mainSource, /function readTerminalHistoryPreviewFrame\(/);
  assert.match(mainSource, /const preViewportLines = Array\.isArray\(snapshot\?\.preViewportLines\)/);
  assert.match(mainSource, /const leadingPhysicalLines = \[\.\.\.preViewportLines, \.\.\.lines\]\.filter/);
  assert.match(controllerSource, /leadingPhysicalLines: frame\.leadingPhysicalLines/);
  assert.match(controllerSource, /committedSnapshot\?\.authoritativeFrameCommitted/);
});

test('Claude and Codex exact lifecycle edges own preview start and finish', () => {
  assert.match(
    mainSource,
    /event === 'UserPromptSubmit'[\s\S]{0,20000}terminalHistoryPreviewController\.begin\(\{[\s\S]{0,500}provider: 'claude'/,
  );
  const codexBusyStart = mainSource.indexOf("if (turnOutcome?.busy === true)");
  assert.notEqual(codexBusyStart, -1);
  assert.match(
    mainSource.slice(codexBusyStart, codexBusyStart + 6000),
    /terminalHistoryPreviewController\.begin\(\{[\s\S]{0,240}provider: 'codex'/,
  );
  assert.match(
    mainSource,
    /state\.busy === true[\s\S]{0,300}state\.currentTurnId[\s\S]{0,300}ownedByCurrentProcess[\s\S]{0,300}terminalHistoryPreviewController\.beginIfAbsent\(\{/,
  );
  assert.match(mainSource, /terminalHistoryPreviewController\.finish\(\{/);
});

test('canonical transcript records are observed before provisional text is retired', () => {
  assert.match(serviceSource, /this\.onLiveMessage\(detail\)/);
  assert.match(serviceSource, /recordEndByteOffset/);
  assert.match(mainSource, /observeTerminalHistoryCanonicalLiveMessage\(liveDetail\)/);
  assert.match(mainSource, /sourceEndOffset: detail\.recordEndByteOffset/);
  assert.match(mainSource, /canonicalText: text/);
  assert.match(mainSource, /terminalHistoryStructuredBoundaryKind/);
  assert.match(mainSource, /terminalHistoryStructuredProofTexts/);
  assert.match(mainSource, /structuredTexts/);
  assert.match(mainSource, /terminalHistoryPreviewController\.observeBoundary/);
  assert.match(controllerSource, /createTerminalHistoryStructuredProof/);
  assert.match(controllerSource, /STRUCTURED_SUPPRESS/);
  assert.match(mainSource, /promptTruncated:\s*commandDetail\?\.truncated === true/);
  assert.match(mainSource, /\? 'provisional-tail'/);
  assert.match(mainSource, /promptAuthority: 'exact-transcript'/);
});

test('History renders terminal preview as an O(1) footer, outside durable rows', () => {
  const footerStart = historySource.indexOf('const HistoryTerminalPreviewFooter');
  const footerEnd = historySource.indexOf('// Cheap stand-in row', footerStart);
  const footerSource = historySource.slice(footerStart, footerEnd);
  assert.match(historySource, /data-history-terminal-preview/);
  assert.match(historySource, /Footer: HistoryTerminalPreviewFooter/);
  assert.match(historySource, /context=\{historyVirtuosoContext\}/);
  // The list renders display UNITS (series collapsing) built from
  // transcriptEntries — the projection stays presentation-only.
  assert.match(historySource, /data=\{displayUnits\}/);
  assert.doesNotMatch(
    historySource,
    /buildHistoryLivePresentation\([^)]*terminalPreview/,
  );
  assert.match(footerSource, /<ConversationMessage/);
  assert.match(footerSource, /layout="assistant"/);
  assert.match(footerSource, /<CBMarkdown text=\{preview\.text\}/);
  assert.match(footerSource, /position: 'absolute'/);
  assert.match(footerSource, /transform: 'translateY\(-50%\)'/);
  assert.doesNotMatch(footerSource, /margin: '2px 0 4px'/);
});

test('preview context menu saves bounded main diagnostics before copying a reference', () => {
  assert.match(historySource, /onContextMenu=\{\(event\) => openTerminalHistoryPreviewContextMenu/);
  assert.match(historySource, /show-terminal-history-preview-context-menu/);
  assert.match(historySource, /selectionInside[\s\S]{0,500}selectionText:/);
  assert.match(mainSource, /ipcMain\.on\('show-terminal-history-preview-context-menu'/);
  assert.match(mainSource, /label: 'Save & copy diagnostic reference'/);
  assert.match(mainSource, /snapshotTerminalComposerForensics\(mirror\.composerForensics/);
  assert.match(mainSource, /snapshotTerminalRedrawTrace\(mirror\?\.redrawTrace, 48\)/);
  assert.match(mainSource, /committedSnapshot: mirror\?\.lastCommittedVisibleSnapshot/);
  assert.match(
    historySource,
    /removeListener\(\s*'agent-transcript:terminal-preview-diagnostic-result'/,
  );
  const saveAt = mainSource.indexOf('await captureTerminalHistoryPreviewDiagnostic(payload)');
  const copyAt = mainSource.indexOf('clipboard.writeText(result.reference)', saveAt);
  assert.notEqual(saveAt, -1);
  assert.ok(copyAt > saveAt, 'clipboard acknowledgement must follow durable persistence');
  assert.match(historySource, /Diagnostics saved · reference copied/);
  assert.match(diagnosticSource, /mode: 0o600/);
  assert.match(diagnosticSource, /pruneTerminalHistoryPreviewDiagnostics/);
});

test('diagnostics expose frame, write, identity, canonical handoff and renderer apply', () => {
  assert.match(controllerSource, /\[TerminalHistoryPreview\]/);
  assert.match(controllerSource, /'CANONICAL'/);
  assert.match(controllerSource, /'CANONICAL_SUPPRESS'/);
  assert.match(controllerSource, /'PROMPT_UPGRADE'/);
  assert.match(controllerSource, /'BOUNDARY_REBASE'/);
  assert.match(controllerSource, /'BOUNDARY_HELD'/);
  assert.match(historySource, /TERMINAL_PREVIEW_APPLY/);
  assert.match(historySource, /TERMINAL_PREVIEW_CLEAR/);
  assert.match(historySource, /TERMINAL_PREVIEW_PIN/);
  assert.match(historySource, /followBottom=/);
  assert.match(historySource, /physicalPinned=/);
  assert.match(controllerSource, /systemBlocks/);
  assert.match(controllerSource, /styleEvidence/);
  assert.match(mainSource, /row\.allTextDim = summary\.allTextDim/);
  assert.match(mainSource, /row\.hasNonDefaultFg = summary\.hasNonDefaultFg/);
});

test('full-screen redraw recovers from exact submitted prompt instead of marker lifetime', () => {
  assert.match(mainSource, /findTerminalHistorySubmittedPromptBoundary\(\{/);
  assert.match(mainSource, /promptText:\s*state\.promptText,[\s\S]*?provider:\s*state\.provider,[\s\S]*?beforeRow:\s*composerRow/);
  assert.match(mainSource, /\[TerminalHistoryPreview\] PROMPT_CAPTURE/);
  assert.match(mainSource, /terminalHistoryPreviewController\.bindPrompt\(\{/);
  assert.match(controllerSource, /'ANCHOR_LOST'/);
  assert.match(controllerSource, /'ANCHOR'/);
});

test('post-JSONL full-screen redraw retains a same-generation frame baseline', () => {
  assert.match(controllerSource, /lastCommittedSnapshot/);
  assert.match(controllerSource, /rebaseBaselineSnapshot/);
  assert.match(controllerSource, /'BASELINE_CAPTURE'/);
  assert.match(controllerSource, /deriveTerminalHistoryPreviewTextAfterBaseline/);
  assert.match(mainSource, /boundaryKind = 'exact-jsonl-frame-baseline'/);
  assert.match(mainSource, /exact-jsonl-baseline-composer-unavailable/);
});

test('shared AI composer exposes a persisted global terminal streaming toggle', () => {
  assert.match(composerSource, /data-terminal-history-streaming=/);
  assert.match(composerSource, /TerminalHistoryStreamIcon/);
  assert.match(uiStoreSource, /terminalHistoryStreamingEnabled: boolean/);
  assert.match(uiStoreSource, /agent-transcript:set-terminal-preview-enabled/);
  assert.match(mainSource, /terminalHistoryPreviewController\.clearAll\('global-toggle-disabled'\)/);
  assert.match(historySource, /!terminalHistoryStreamingEnabled/);
});
