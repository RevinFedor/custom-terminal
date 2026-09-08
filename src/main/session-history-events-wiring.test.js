const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('session_stats publishes app-owned lineage and zero-based iteration coordinates', () => {
  const main = read('src/main/main.js');
  const mcp = read('mcp/terminal-server.mjs');

  assert.match(main, /totalIterations:\s*sessionHistoryProjection/);
  assert.match(main, /historyEvents:\s*_sessionHistoryContextForApi/);
  assert.match(main, /appRelations:/);
  assert.match(main, /afterIterationIndex:\s*t\.afterIterationIndex/);
  assert.match(main, /nextIterationIndex:\s*t\.nextIterationIndex/);
  assert.match(mcp, /app-owned compact\/fork historyEvents/);
});

test('Codex and Claude Timeline load one canonical app-owned fork marker', () => {
  const timeline = read('src/renderer/components/Workspace/Timeline.tsx');
  const codexBranch = timeline.slice(
    timeline.indexOf('} else if (isCodex) {'),
    timeline.indexOf('// Claude: load timeline entries', timeline.indexOf('} else if (isCodex) {')),
  );

  assert.match(codexBranch, /timeline:get-session-history-events/);
  assert.match(codexBranch, /selectAppForkMarker/);
  assert.equal((timeline.match(/selectAppForkMarker\(all, sessionId, markerEntries\)/g) || []).length, 2,
    'both provider views distinguish a retained app origin from the physical writer hop');
  assert.doesNotMatch(codexBranch, /setForkMarkers\(\[\]\)/);
  assert.match(timeline, /resolveForkMarkerBoundary\(entries, marker\)\.boundaryIndex/);
});

test('all non-visual fork boundary consumers use the shared sparse resolver', () => {
  const outline = read('src/main/timeline-outline-service.js');
  const claude = read('src/main/ipc/claude-data.js');

  assert.match(outline, /selectDirectForkMarker/);
  assert.match(outline, /resolveForkMarkerBoundary/);
  assert.match(claude, /selectDirectForkMarker/);
  assert.match(claude, /resolveForkMarkerBoundary/);
  assert.doesNotMatch(claude, /nextTimelineEntry.*snapshotSet/s);
});

test('mobile Claude SDK fork uses the canonical rewrite and metadata-copy path', () => {
  const main = read('src/main/main.js');
  const start = main.indexOf("ipcMain.handle('claude-sdk:fork-from-session'");
  const end = main.indexOf("// Edit range", start);
  const handler = main.slice(start, end);

  assert.match(handler, /writeClaudeForkJsonlExclusive/);
  assert.match(handler, /copyTimelineMetadataForFork/);
  assert.doesNotMatch(handler, /fs\.copyFileSync\(sourcePath, destPath\)/);
});
