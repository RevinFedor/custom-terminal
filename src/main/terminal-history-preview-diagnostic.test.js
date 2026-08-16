'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ARTIFACT_DIRECTORY,
  buildTerminalHistoryPreviewDiagnosticReference,
  persistTerminalHistoryPreviewDiagnostic,
  pruneTerminalHistoryPreviewDiagnostics,
} = require('./terminal-history-preview-diagnostic');

async function withTempDir(run) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-preview-diag-'));
  try {
    return await run(tempDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

test('persists one atomic bounded diagnostic artifact with stable identity', async () => {
  await withTempDir(async (logsDir) => {
    const result = await persistTerminalHistoryPreviewDiagnostic({
      logsDir,
      tabId: 'project-tab/unsafe',
      toolType: 'codex',
      incidentId: 'incident:one',
      capturedAt: 1_700_000_000_000,
      diagnostic: {
        incident: { reason: 'manual-preview-context-menu' },
        composerTrace: { transitions: [{ at: 123, pty: 'exact' }] },
      },
    });

    assert.equal(result.incidentId, 'incident_one');
    assert.equal(path.dirname(result.artifactPath), path.join(logsDir, ARTIFACT_DIRECTORY));
    assert.match(path.basename(result.artifactPath), /^terminal-history-preview-codex-/);
    const parsed = JSON.parse(await fs.promises.readFile(result.artifactPath, 'utf8'));
    assert.equal(parsed.kind, 'terminal-history-preview-diagnostic');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.tabId, 'project-tab/unsafe');
    assert.equal(parsed.diagnostic.composerTrace.transitions[0].pty, 'exact');
    assert.equal((await fs.promises.stat(result.artifactPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await fs.promises.readdir(path.dirname(result.artifactPath)))
        .filter((name) => name.includes('.tmp-')),
      [],
    );
  });
});

test('diagnostic retention removes old/excess artifacts but keeps the active save', async () => {
  await withTempDir(async (logsDir) => {
    const directory = path.join(logsDir, ARTIFACT_DIRECTORY);
    await fs.promises.mkdir(directory, { recursive: true });
    const paths = [0, 1, 2].map((index) => (
      path.join(directory, `terminal-history-preview-codex-tab-${index}.json`)
    ));
    for (let index = 0; index < paths.length; index += 1) {
      await fs.promises.writeFile(paths[index], '{}');
      const at = new Date(10_000 + index * 1_000);
      await fs.promises.utimes(paths[index], at, at);
    }

    const result = await pruneTerminalHistoryPreviewDiagnostics({
      directory,
      keepPath: paths[0],
      now: 30_000,
      maxArtifacts: 1,
      maxAgeMs: 60_000,
    });
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(paths[0]), true, 'active artifact is never pruned');
    assert.equal(fs.existsSync(paths[1]), false, 'artifact beyond the count cap is pruned');
    assert.equal(fs.existsSync(paths[2]), true, 'newest artifact remains');
  });
});

test('copied reference contains the exact incident and artifact lookup fields', () => {
  const reference = buildTerminalHistoryPreviewDiagnosticReference({
    incidentId: 'incident-42',
    capturedAt: Date.UTC(2026, 7, 15, 1, 2, 3),
    artifactPath: '/tmp/incident-42.json',
    tabId: 'tab-42',
    toolType: 'claude',
    sessionId: 'session-42',
    turnId: 'turn-42',
    previewId: 'preview-42',
  });
  assert.match(reference, /incidentId: incident-42/);
  assert.match(reference, /capturedAt: 2026-08-15T01:02:03\.000Z/);
  assert.match(reference, /tabId: tab-42/);
  assert.match(reference, /sessionId: session-42/);
  assert.match(reference, /artifactPath: \/tmp\/incident-42\.json/);
});
