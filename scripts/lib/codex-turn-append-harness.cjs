'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const audit = require(path.join(root, 'src/main/codex-prompt-audit'));
const outcome = require(path.join(root, 'src/main/codex-turn-outcome'));
const { readCodexTurnAppend } = require(path.join(root, 'src/main/codex-turn-append-reader'));

function createHarness(filePath, options = {}) {
  const main = fs.readFileSync(options.mainPath || path.join(root, 'src/main/main.js'), 'utf8');
  const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['codexEventType', 'summarizeCodexTurnChunk', 'processCodexTurnText',
    'processCodexSourceAuditOnlyText', 'scanCodexTurnAppend'];
  const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(ast)).join('\n');
  const state = { tabId: 'test-fork-child', sessionId: 'synthetic-child', filePath,
    offset: 0, partial: '', partialStartOffset: 0, sourceAuditPartial: '', sourceAuditPartialStartOffset: 0,
    livePromptOwnersBySource: new Map(), processGeneration: 'synthetic:1', ...options.state };
  const watchers = new Map([[state.tabId, state]]);
  const result = { records: 0, selected: [], sourceAudits: [], offsets: [], finalized: 0,
    published: [], warnings: [], logs: [], maxInputBytes: 0, read: null };
  const hash = createHash('sha256');
  let compact = options.compact ? { operationId: 'compact-test' } : null;
  const context = vm.createContext({
    fs, Buffer, Date, setImmediate, ...audit,
    console: { log: s => result.logs.push(s), warn: s => result.warnings.push(s) },
    codexTurnWatchers: watchers,
    readCodexTurnAppend: async args => {
      const r = await readCodexTurnAppend({ ...args, ...options.reader,
        onBatch: (batch, prepared) => {
          result.maxInputBytes = Math.max(result.maxInputBytes, batch.buffer.length);
          return args.onBatch(batch, prepared);
        } });
      result.read = r; return r;
    },
    processCodexTurnLine: (_state, line, offset) => {
      if (!line.trim()) return;
      let record; try { record = JSON.parse(line); } catch { return; }
      result.records += 1;
      hash.update(String(offset) + ':' + line + '\n');
      if (options.keepOffsets) result.offsets.push(offset);
      const event = record?.type === 'event_msg' ? record.payload?.type : null;
      if (event === 'user_message' || _state.preferredUserAuditOffsets?.has(offset)) result.selected.push(offset);
      if (compact && event === 'task_complete') compact.codexTaskCompleteOffset = offset;
      if (record.type === 'compacted') compact = null;
      options.onRecord?.(record, offset, state);
    },
    compactOperations: {
      getActive: () => compact,
      finalizeCodexTaskComplete: () => { result.finalized += 1; compact = null; },
    },
    createCodexResumeUserActivityProof: require(path.join(root, 'src/main/codex-resume-user-activity')).createCodexResumeUserActivityProof,
    processCodexUserMessagePasteAudit: (_state, record) => result.sourceAudits.push(record.__byteOffset),
    requestCodexSourceWriterProof() {},
    takeCodexSourceProofReleaseAtScanBoundary: outcome.takeCodexSourceProofReleaseAtScanBoundary,
    completeCodexSuppressedCatchUpRelease: outcome.completeCodexSuppressedCatchUpRelease,
    publishCodexSuppressedCatchUpRelease: (_tab, _state, release) => { if (release?.released) result.published.push(release); },
    emitCodexTurnStateResolved() {}, closeCodexTurnWatcher() {},
    releaseCodexSourceObservationAfterWriterProof() {},
  });
  vm.runInContext(code, context);
  const processText = context.processCodexTurnText;
  context.processCodexTurnText = (...args) => {
    result.maxInputBytes = Math.max(result.maxInputBytes, Buffer.byteLength(args[1] || ''));
    return processText(...args);
  };
  return { state, watchers, result, digest: () => hash.copy().digest('hex'),
    scan: reason => context.scanCodexTurnAppend(state.tabId, reason || 'linked-live-catchup') };
}

module.exports = { createHarness };
