import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { createTimelineSnapshotCache, createTimelineSnapshotOwner } from './timelineSnapshotCache.mjs';
const require = createRequire(import.meta.url);
const { SessionTranscriptService } = require('../../main/session-transcript-service');
const fs = require('node:fs/promises');

const snapshot = id => ({ entries: [{ uuid: id, type: 'user', content: 'prompt' }], sessionMeta: { id }, revision: { token: id } });
const churn = cache => { for (let i = 0; i < 47; i++) cache.set('background-' + i, snapshot('background-' + i)); };

test('47 background owners may evict remount acceleration but not the live rows/revision pair', () => {
  const cache = createTimelineSnapshotCache(), owner = createTimelineSnapshotOwner(cache, 'A'), value = snapshot('A');
  owner.remember(value); churn(cache);
  assert.equal(cache.peek('A'), null); assert.equal(cache.size(), 8);
  assert.equal(owner.source(), 'owner'); assert.equal(owner.peek(), value);
  assert.equal(owner.read().entries, value.entries, 'no second array copy');
  assert.equal(owner.read().revision, value.revision);
});

test('remount and owner change use the bounded shared cache; no foreign revision is retained', () => {
  const cache = createTimelineSnapshotCache({ maxOwners: 2, maxEntries: 4 });
  const a = createTimelineSnapshotOwner(cache, 'A'), value = snapshot('A'); a.remember(value);
  const remounted = createTimelineSnapshotOwner(cache, 'A'); assert.equal(remounted.source(), 'remount');
  assert.equal(remounted.read(), value); churn(cache); assert.equal(remounted.read(), value);
  assert.equal(createTimelineSnapshotOwner(cache, 'B').read(), null);
  assert.equal(createTimelineSnapshotOwner(cache, 'A').read(), null, 'an actual remount after eviction is cold');
});

test('empty and oversized live rails keep their own accepted revision without increasing shared limits', () => {
  const cache = createTimelineSnapshotCache({ maxEntries: 2 });
  const empty = createTimelineSnapshotOwner(cache, 'empty'); empty.remember({ ...snapshot('empty'), entries: [] });
  const huge = createTimelineSnapshotOwner(cache, 'huge'); const value = { ...snapshot('huge'), entries: Array.from({ length: 10 }, (_, i) => ({ uuid: String(i) })) };
  huge.remember(value); assert.equal(cache.size(), 0); assert.equal(cache.entryCount(), 0);
  assert.equal(huge.read(), value); assert.equal(empty.read().revision.token, 'empty');
});

// Execute the actual Timeline load callback against the real service/revision
// validator. Only the expensive projector and React setters are fixture seams.
const source = readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const runTimelineLoad = useCallback(');
const end = source.indexOf('\n  // Transcript changes can arrive in bursts', start);
assert.ok(start >= 0 && end > start);
const callbackCode = transformSync(source.slice(start, end).replaceAll('import.meta.env.DEV', 'false'), { loader: 'tsx' }).code + '\nrunTimelineLoad';

async function harness(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'noted-timeline-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.jsonl'); writeFileSync(filePath, '{"type":"session_meta"}\n');
  let projections = 0, rowGeneration = 1, presentationRevision = 'one', hold = null;
  const service = new SessionTranscriptService({ getMainWindow: () => null, claudeData: null, webBroadcast: null,
    promptPresentationStore: { getHistoryPromptPresentationRevision: () => presentationRevision,
      getHistoryPromptPresentationsForEntries: () => [] },
    codexData: { _api: { findCodexSessionFile: async () => ({ filePath }),
      projectCodexTimelineFromFile: async () => {
        projections++; if (hold) await hold;
        const stat = await fs.stat(filePath);
        return { success: true, entries: [{ uuid: 'user-' + rowGeneration, type: 'user', content: 'prompt' }],
          sessionMeta: { id: 'session-a' }, filePath,
          sourceSnapshot: { filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: 'session-a', linkKind: 'end' } };
      } } },
  });
  const cache = createTimelineSnapshotCache(), owner = createTimelineSnapshotOwner(cache, 'owner-a');
  let entries = { ownerKey: 'owner-a', entries: [] }, metadata = null;
  const ownerKey = { current: 'owner-a' }, generation = { current: 0 }, seenRequests = [];
  const run = vm.runInNewContext(callbackCode, {
    useCallback: fn => fn, timelineOwnerKey: 'owner-a', timelineOwnerKeyRef: ownerKey,
    timelineSnapshotOwner: owner, timelineLoadGenerationRef: generation,
    isVisibleRef: { current: true }, historyPresentationGateOpenRef: { current: true },
    hasDurableEntriesRef: { current: true }, document: { visibilityState: 'visible' },
    historyForegroundPriority: { waitForBackgroundSlot: async () => ({ waitedMs: 0, reason: 'idle' }) },
    shouldBypassTimelineApplyPriority: () => false,
    performance, perfAbsNow: () => performance.timeOrigin + performance.now(),
    sessionId: 'session-a', cwd: dir, tabId: 'tab-a', isGemini: false, isCodex: true,
    timelineInstanceIdRef: { current: 'fixture' }, entriesCountRef: { current: 1 },
    startTransition: fn => fn(),
    setEntriesSnapshot: value => { entries = typeof value === 'function' ? value(entries) : value; },
    setCodexSessionMeta: value => { metadata = typeof value === 'function' ? value(metadata) : value; },
    setSessionBoundaries() {}, setForkMarkers() {}, setClaudeMemoryBoundaryUuid() {},
    setNotes() {}, setNotePositions() {}, setRewindMarkers() {},
    normalizeForkMarkers: () => [], selectAppForkMarker: () => null,
    ipcRenderer: { invoke: async (channel, payload) => {
      if (channel === 'agent-transcript:get-timeline') { seenRequests.push(payload); return service.getTimeline(payload); }
      if (channel === 'timeline:get-notes') return { success: true, notes: [] };
      return { success: true, markers: [] };
    } },
    console: { warn() {}, error(...args) { throw Error(args.join(' ')); } },
  });
  return { run, cache, owner, service, ownerKey, generation, filePath, dir, seenRequests,
    projections: () => projections, entries: () => entries,
    append: () => { rowGeneration++; appendFileSync(filePath, '{"type":"event_msg"}\n'); },
    changePresentation: () => { presentationRevision = 'two'; },
    hold: promise => { hold = promise; } };
}

test('actual load retains ifRevision after saturation: unchanged source never invokes cold projector', async t => {
  const h = await harness(t); await h.run('initial');
  const first = h.entries(), revision = h.owner.peek().revision; assert.ok(revision?.token);
  churn(h.cache); assert.equal(h.cache.peek('owner-a'), null);
  // Negative control: the former remount-only lookup omits ifRevision and
  // necessarily enters the expensive projector on this identical source.
  await h.service.getTimeline({ toolType: 'codex', sessionId: 'session-a', cwd: h.dir, ifRevision: h.cache.peek('owner-a')?.revision || null });
  assert.equal(h.projections(), 2);
  await h.run('surface-resume'); assert.equal(h.projections(), 2);
  assert.equal(h.seenRequests.at(-1).ifRevision, revision);
  assert.equal(h.entries(), first, 'unchanged update keeps React snapshot identity');
});

test('real append and presentation changes still refresh the live rail after remount-cache eviction', async t => {
  const h = await harness(t); await h.run('initial');
  const firstToken = h.owner.peek().revision.token; churn(h.cache); h.append();
  await h.run('transcript-change'); assert.equal(h.projections(), 2);
  assert.equal(h.entries().entries[0].uuid, 'user-2'); assert.notEqual(h.owner.peek().revision.token, firstToken);
  const nextToken = h.owner.peek().revision.token; churn(h.cache); h.changePresentation();
  await h.run('presentation-change'); assert.equal(h.projections(), 3);
  assert.notEqual(h.owner.peek().revision.token, nextToken);
});

test('late previous-owner result cannot remember a revision or paint its rows into the next owner', async t => {
  const h = await harness(t); let release; h.hold(new Promise(resolve => { release = resolve; }));
  const pending = h.run('initial');
  h.ownerKey.current = 'owner-b'; h.generation.current++;
  release(); await pending;
  assert.equal(h.owner.peek(), null); assert.equal(h.entries().entries.length, 0);
  const b = createTimelineSnapshotOwner(h.cache, 'owner-b'); assert.equal(b.read(), null);
});

test('actual component keys the holder by tab/provider/session/cwd and uses it for both providers and loader', () => {
  assert.match(source, /JSON\.stringify\(\{ tabId, toolType, sessionId: sessionId \|\| '', cwd: cwd \|\| '' \}\)/);
  assert.match(source, /useMemo\(\(\) => createTimelineSnapshotOwner\([\s\S]{0,110}\[timelineOwnerKey\]\)/);
  assert.equal((source.match(/timelineSnapshotOwner\.remember\(/g) || []).length, 2);
  assert.match(source, /const cachedClaudeSnapshot = timelineSnapshotOwner\.read\(\)/);
  assert.match(source, /const hasCachedSnapshot = isCodex &&\s*!!timelineSnapshotOwner\.peek\(\)/);
});
