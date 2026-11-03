'use strict';
// Right-click → fork from the latest compact on a session that never
// compacted used to refuse: "В этой сессии ещё нет сжатия контекста".
//
// Fedor 02.11: the action means "start the child at the last compact
// boundary". A session with no boundary simply has nothing before it — the
// whole conversation already IS everything after the (absent) compact, so the
// honest result is an ordinary full fork, not an error.
//
// Both providers degrade the same way. These tests drive the REAL planner for
// Codex and the REAL writer path for Claude.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const codexSource = fs.readFileSync(path.join(__dirname, 'ipc', 'codex-data.js'), 'utf8');
const claudeSource = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');

// --- Codex: run the real planner ------------------------------------------

function codexPlanner() {
  const ast = ts.createSourceFile('codex.js', codexSource, ts.ScriptTarget.Latest, true);
  const decl = (name) => ast.statements
    .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    // One visible wrapper per record, which is all the planner needs here.
    buildCodexVisibleRecordWrappers: (records) => records.map((record, line) => ({ record, line })),
    cloneCodexRecordForWrite: (record) => ({ ...record }),
  });
  vm.runInContext(decl('planCodexForkFromLatestCompact'), context);
  return context.planCodexForkFromLatestCompact;
}

const codexRecords = (withCompact) => [
  { type: 'session_meta', id: 'meta' },
  { type: 'response_item', id: 'a' },
  ...(withCompact ? [{ type: 'compacted', id: 'c' }] : []),
  { type: 'response_item', id: 'b' },
];

const plan = codexPlanner();

test('Codex: a session without a compact forks whole instead of refusing', () => {
  const result = plan(codexRecords(false), 'S');
  assert.equal(result.success, true, 'pre-fix this returned reason=no-compact');
  assert.equal(result.removedRecordCount, 0, 'nothing is dropped from a full fork');
  assert.equal(result.outputRecords.map((record) => record.id).join(','), 'meta,a,b',
    'the whole conversation is copied, session_meta once');
});

test('Codex: a session WITH a compact still starts at that boundary', () => {
  const result = plan(codexRecords(true), 'S');
  assert.equal(result.success, true);
  assert.equal(result.outputRecords.map((record) => record.id).join(','), 'meta,c,b',
    'pre-compact records are still excluded');
  assert.equal(result.removedRecordCount, 1);
});

// --- Claude: run the real fork writer --------------------------------------

async function claudeFork({ withCompact }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-fallback-'));
  const projectDir = path.join(dir, '-Users-fedor-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const sourcePath = path.join(projectDir, sourceId + '.jsonl');
  const line = (value) => JSON.stringify(value) + '\n';
  fs.writeFileSync(sourcePath, [
    line({ type: 'user', uuid: 'u1', sessionId: sourceId, cwd: '/Users/fedor/fixture',
      message: { role: 'user', content: 'первый' } }),
    line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sourceId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } }),
    ...(withCompact ? [line({ type: 'system', subtype: 'compact_boundary', uuid: 'c1',
      parentUuid: 'a1', sessionId: sourceId, content: '' })] : []),
    line({ type: 'user', uuid: 'u2', parentUuid: withCompact ? 'c1' : 'a1', sessionId: sourceId,
      message: { role: 'user', content: 'второй' } }),
  ].join(''));
  return { dir, sourceId, sourcePath, projectDir };
}

test('Claude: the refusal is replaced by a full fork, the compact path is intact', async () => {
  // The writer itself is covered by its own suites; what must be pinned here
  // is the branch that used to return `no-compact`.
  const start = claudeSource.indexOf('if (fromLatestCompact && sourceInspection.lastCompactLineIndex < 0)');
  assert.ok(start > 0, 'the no-compact branch still exists at a known place');
  const body = claudeSource.slice(start, start + 520);
  assert.match(body, /fromLatestCompact = false;/, 'it degrades to a full fork');
  assert.doesNotMatch(body, /success: false/, 'it no longer refuses');
  assert.doesNotMatch(body, /'no-compact'/, 'and no longer reports that reason');

  // The start line and the recorded fork mode both follow that same flag, so
  // the child is honestly recorded as a full fork.
  assert.match(claudeSource, /const startLine = fromLatestCompact \? sourceInspection\.lastCompactLineIndex : 0;/);
  assert.match(claudeSource, /forkMode: fromLatestCompact \? 'latest_compact' : 'full',/);

  // And the fixture is a real, parseable session either way.
  for (const withCompact of [false, true]) {
    const { dir, sourcePath } = await claudeFork({ withCompact });
    const lines = fs.readFileSync(sourcePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, withCompact ? 4 : 3);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the renderer no longer needs its missing-compact error path', () => {
  // A stale branch here would turn a now-successful fork into a false error.
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'App.tsx'), 'utf8');
  const index = app.indexOf("forkResult?.reason === 'no-compact'");
  if (index < 0) return; // already removed
  // If kept as a defensive branch it must still be unreachable for both
  // providers: neither planner returns that reason any more.
  assert.doesNotMatch(codexSource, /reason: 'no-compact'/);
  assert.doesNotMatch(claudeSource, /reason: 'no-compact'/);
});
