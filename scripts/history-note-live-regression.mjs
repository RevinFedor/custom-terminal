#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-note-live-'));
const snapshot = path.join(artifact, 'source');
const fixture = path.join(repo, 'scripts/fixtures/history-note-live.tsx');
const sharedLog = path.join(repo, 'logs/dev.log');
const runLog = path.join(artifact, 'run.log');
const mainLog = path.join(artifact, 'main.log');
const stampLog = async (message, data = undefined) => {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
  await fs.appendFile(runLog, `${new Date().toISOString()} ${message}${suffix}\n`);
};
await fs.writeFile(runLog, '');

await stampLog('run-start', { target: repo, scenario: 'codex-live-timeline-note' });
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
for (const name of ['src', 'packages/claude-blocks']) {
  await fs.cp(path.join(repo, name), path.join(snapshot, name), {
    recursive: true,
    force: true,
    filter: p => !p.includes('/node_modules') && !p.includes('/.git'),
  });
}
await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
await fs.copyFile(fixture, path.join(snapshot, 'scripts/fixtures/history-note-live.tsx'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));

const shared = path.join(artifact, 'noted-shared/packages');
for (const name of ['structured-dnd', 'file-explorer']) {
  await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), {
    recursive: true,
    filter: p => !p.includes('/node_modules'),
  });
}

await build({
  entryPoints: [path.join(snapshot, 'scripts/fixtures/history-note-live.tsx')],
  bundle: true,
  outfile: path.join(artifact, 'bundle.js'),
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  logLevel: 'silent',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ DEV: false, PROD: true, MODE: 'test' }),
  },
  alias: {
    '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
    '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'),
    '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
    react: path.join(repo, 'node_modules/react'),
    'react-dom': path.join(repo, 'node_modules/react-dom'),
  },
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' },
});
execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), [
  '-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
  '-o', path.join(artifact, 'globals.css'), '--minify',
], { cwd: snapshot, stdio: 'pipe' });
await fs.writeFile(path.join(artifact, 'index.html'),
  '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><div id="root"></div><script type="module" src="bundle.js"></script>');
await fs.mkdir(path.join(artifact, 'user-data'));
await fs.writeFile(path.join(artifact, 'preload.cjs'), `
const { ipcRenderer } = require('electron');
const invoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = (channel, ...args) => invoke('fixture:invoke', { channel, args });
`);

// This is a private app main, not the production main. It calls the actual
// timeline-note-identity resolver and stores notes in a fixture-only SQLite
// database. The renderer still reaches it through the real Electron IPC path.
await fs.writeFile(path.join(artifact, 'main.cjs'), `
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const Database = require(${JSON.stringify(path.join(repo, 'node_modules/better-sqlite3'))});
const { resolveTimelineNoteAnchor } = require(${JSON.stringify(path.join(snapshot, 'src/main/timeline-note-identity.js'))});
const artifact = ${JSON.stringify(artifact)};
const userData = ${JSON.stringify(path.join(artifact, 'user-data'))};
const logFile = ${JSON.stringify(mainLog)};
const noteDbPath = ${JSON.stringify(path.join(artifact, 'user-data', 'timeline-notes.sqlite'))};
const log = (event, data) => {
  const suffix = data === undefined ? '' : ' ' + JSON.stringify(data);
  fs.appendFileSync(logFile, new Date().toISOString() + ' ' + event + suffix + '\\n');
};
app.setPath('userData', userData);
app.setActivationPolicy?.('accessory');
const db = new Database(noteDbPath);
db.exec('CREATE TABLE IF NOT EXISTS timeline_notes (entry_uuid TEXT NOT NULL, session_id TEXT NOT NULL, tab_id TEXT, content TEXT NOT NULL, position TEXT NOT NULL, PRIMARY KEY(entry_uuid, session_id))');
const sessionId = 'S';
const tabId = 'note-live-tab';
const canonicalEntry = {
  uuid: 'codex-user-S-42', role: 'user', type: 'user', sessionId,
  timestamp: ${JSON.stringify(new Date(Date.now() + 42).toISOString())},
  sourceIdentity: 'codex-user-source-S-42', content: 'LIVE CODEX QUESTION',
};
const physicalEntry = {
  uuid: 'physical-normal-S', role: 'user', type: 'user', sessionId,
  timestamp: ${JSON.stringify(new Date(Date.now() + 900).toISOString())},
  sourceIdentity: 'codex-user-source-S-900', content: 'NORMAL PHYSICAL QUESTION',
};
db.prepare('INSERT INTO timeline_notes(entry_uuid,session_id,tab_id,content,position) VALUES(?,?,?,?,?)').run('physical-normal-S', sessionId, tabId, 'normal physical note', 'before');
log('physical-control-seeded', { uuid: 'physical-normal-S' });
const resolverTimeline = [canonicalEntry, physicalEntry];
let presentedTimeline = [];
const readTimeline = async request => {
  log('identity-read', { sessionId: request.sessionId, entries: resolverTimeline.map(e => e.uuid) });
  return { success: true, entries: resolverTimeline };
};
const rows = session => db.prepare('SELECT entry_uuid, session_id, tab_id, content, position FROM timeline_notes WHERE session_id = ? ORDER BY entry_uuid').all(session);
const noteResponse = session => {
  const notes = {}; const positions = {};
  for (const row of rows(session)) { notes[row.entry_uuid] = row.content; positions[row.entry_uuid] = row.position; }
  return { success: true, notes, positions };
};
const save = async request => {
  log('note-save-attempt', { entryUuid: request.entryUuid, sourceIdentity: request.sourceIdentity, previousEntryUuid: request.previousEntryUuid || null });
  const resolved = await resolveTimelineNoteAnchor(request, readTimeline);
  if (resolved.success !== true) {
    log('note-save-rejected', { entryUuid: request.entryUuid, error: resolved.error });
    return { success: false, error: resolved.error };
  }
  if (request.previousEntryUuid) {
    const prior = db.prepare('SELECT content FROM timeline_notes WHERE entry_uuid = ? AND session_id = ?').get(request.previousEntryUuid, request.sessionId);
    if (!prior || prior.content !== request.expectedPreviousContent) {
      log('note-move-rejected', { error: 'timeline_note_changed' });
      return { success: false, error: 'timeline_note_changed' };
    }
    const move = db.transaction(() => {
      db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ? AND session_id = ?').run(request.previousEntryUuid, request.sessionId);
      db.prepare('INSERT INTO timeline_notes(entry_uuid,session_id,tab_id,content,position) VALUES(?,?,?,?,?)').run(resolved.entryUuid, request.sessionId, request.tabId, request.content, request.position || 'before');
    });
    move();
  } else {
    db.prepare('INSERT INTO timeline_notes(entry_uuid,session_id,tab_id,content,position) VALUES(?,?,?,?,?) ON CONFLICT(entry_uuid,session_id) DO UPDATE SET content=excluded.content, position=excluded.position, tab_id=excluded.tab_id').run(resolved.entryUuid, request.sessionId, request.tabId, request.content, request.position || 'before');
  }
  log('note-save-accepted', { requestedUuid: request.entryUuid, savedUuid: resolved.entryUuid, content: request.content });
  return { ...resolved, success: true };
};

ipcMain.handle('fixture:invoke', async (event, { channel, args }) => {
  const request = args?.[0] || {};
  if (channel === 'agent-transcript:get-timeline') {
    log('timeline-read', { visible: presentedTimeline.length, uuids: presentedTimeline.map(e => e.uuid) });
    return { success: true, entries: presentedTimeline, revision: { sources: [{ sessionId, fileIdentity: 'fixture', linkKind: 'end' }] } };
  }
  if (channel === 'timeline:get-notes') return noteResponse(request.sessionId || sessionId);
  if (channel === 'timeline:save-note') return save(request);
  if (channel === 'timeline:delete-note') {
    db.prepare('DELETE FROM timeline_notes WHERE entry_uuid = ? AND session_id = ?').run(request.entryUuid, request.sessionId);
    log('note-delete', { entryUuid: request.entryUuid });
    return { success: true };
  }
  if (channel === 'timeline:get-rewind-markers') return { success: true, markers: [] };
  if (channel === 'timeline:get-session-history-events') return { success: true, events: [] };
  if (channel === 'agent-transcript:subscribe' || channel === 'agent-transcript:unsubscribe' || channel === 'agent-transcript:refresh') return { success: true };
  if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
  if (channel === 'agent-session:get-availability-batch') return { success: true, results: [] };
  if (channel === 'claude:estimate-range-tokens') return { success: false, error: 'fixture-not-supported' };
  if (channel === 'ai-prompts:read-files') return { success: true, files: [] };
  if (channel === 'terminal:getCommandState') return null;
  if (channel === 'fixture:promote') {
    presentedTimeline = [canonicalEntry, physicalEntry];
    log('canonical-promote', { uuids: presentedTimeline.map(e => e.uuid) });
    return { success: true, entries: presentedTimeline };
  }
  if (channel === 'fixture:rows') return { rows: rows(sessionId), dbPath: noteDbPath, presentedTimeline };
  if (channel.includes('get') || channel.includes('list')) return { success: true, entries: [], results: [], markers: [] };
  return { success: true };
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false, focusable: false, width: 1100, height: 900,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, preload: ${JSON.stringify(path.join(artifact, 'preload.cjs'))} },
  });
  window.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});
  log('window-ready', { pid: process.pid, cwd: process.cwd(), userData });
});
app.on('window-all-closed', () => { try { db.close(); } catch {} app.quit(); });
`);

const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: path.join(artifact, 'user-data') };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const app = await electron.launch({ executablePath, args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
const pid = app.process()?.pid || null;
await stampLog('process-lease', { pid, executablePath, cwd: artifact, userData: path.join(artifact, 'user-data') });

const result = { status: 'RUNNING', artifact, target: repo, pid, steps: [], errors: [], screenshots: [], evidence: null };
const rendererLogs = [];
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
page.on('pageerror', error => result.errors.push(error.message));
page.on('console', message => rendererLogs.push(`${new Date().toISOString()} ${message.type()} ${message.text()}`));

const saveShot = async (name) => {
  const file = path.join(artifact, name);
  await page.screenshot({ path: file });
  result.screenshots.push(file);
  return file;
};
const rowsSnapshot = async () => page.evaluate(async () => window.fixture.dbSnapshot());
const domEvidence = async () => page.evaluate(() => {
  const stripFor = (row) => {
    const siblings = [row.previousElementSibling, row.nextElementSibling].filter(Boolean);
    const strip = siblings.find(node => {
      const child = node.querySelector('div');
      if (!child) return false;
      const color = getComputedStyle(child).backgroundColor;
      return color === 'rgb(8, 145, 178)' || color === 'rgb(103, 232, 249)';
    });
    return strip ? { position: strip === row.previousElementSibling ? 'before' : 'after', color: getComputedStyle(strip.querySelector('div')).backgroundColor } : null;
  };
  return {
    rows: [...document.querySelectorAll('[data-timeline-entry-uuid]')].map(row => ({
      uuid: row.getAttribute('data-timeline-entry-uuid'),
      text: row.textContent?.trim(),
      noteStrip: stripFor(row),
    })),
    noteTextareas: [...document.querySelectorAll('textarea')].map(el => ({ value: el.value, visible: !!(el.offsetWidth || el.offsetHeight) })),
    notePopovers: [...document.querySelectorAll('[data-cmd-hover-popover]')].map(el => el.textContent?.trim()),
  };
});

try {
  // Full-surface baseline before any live-message or user UI action.
  await page.waitForFunction(() => window.fixture?.state?.ready === true);
  await saveShot('baseline.png');
  await stampLog('baseline-ready');

  // Live Codex point is painted while the tab remains busy; this is the exact
  // source identity later consumed by the main-process resolver.
  await page.evaluate(() => window.fixture.emitLive('good'));
  await page.waitForSelector(`[data-timeline-entry-uuid="${'codex-live-S-42-user'}"]`);
  const liveBeforeSave = await domEvidence();
  assert.ok(liveBeforeSave.rows.some(row => row.uuid === 'codex-live-S-42-user'), 'live Codex point must be visible before save');
  await stampLog('live-point-painted', { busy: true, uuid: 'codex-live-S-42-user', sourceIdentity: 'codex-user-source-S-42' });

  // Trusted context-menu -> Add note -> textarea -> Save.
  await page.locator('[data-timeline-entry-uuid="codex-live-S-42-user"]').click({ button: 'right' });
  await stampLog('context-menu-opened', await page.evaluate(() => {
    const timeline = document.querySelector('[data-timeline]')?.getBoundingClientRect();
    const row = document.querySelector('[data-timeline-entry-uuid="codex-live-S-42-user"]')?.getBoundingClientRect();
    const menu = document.querySelector('[data-timeline-context-menu]')?.getBoundingClientRect();
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, timeline, row, menu };
  }));
  await page.getByText('Добавить заметку', { exact: true }).click();
  await page.locator('textarea').fill('fixture note');
  assert.equal(await page.locator('textarea').inputValue(), 'fixture note');
  await page.getByText('Сохранить', { exact: true }).click();
  await page.waitForFunction(async () => (await window.fixture.dbSnapshot()).rows.some(row => row.entry_uuid === 'codex-user-S-42' && row.content === 'fixture note'));
  const afterSaveRows = await rowsSnapshot();
  assert.ok(afterSaveRows.rows.some(row => row.entry_uuid === 'codex-user-S-42' && row.content === 'fixture note'), 'save must persist canonical UUID');
  assert.equal(afterSaveRows.rows.some(row => row.entry_uuid === 'codex-live-S-42-user'), false, 'live watcher UUID must never be stored');
  const afterSaveDom = await domEvidence();
  assert.ok(afterSaveDom.rows.some(row => row.uuid === 'codex-user-S-42' && row.noteStrip), 'saved note must paint a cyan marker on the adopted row');
  await saveShot('live-note-saved.png');
  result.steps.push({ phase: 'live-save', liveBeforeSave, afterSaveRows, afterSaveDom });
  await stampLog('live-note-saved', { requestedUuid: 'codex-live-S-42-user', savedUuid: 'codex-user-S-42', content: 'fixture note' });

  // Let the durable/canonical Timeline arrive after the busy turn settles.
  await page.evaluate(() => window.fixture.promote());
  await page.waitForSelector('[data-timeline-entry-uuid="codex-user-S-42"]');
  await page.waitForFunction(() => window.fixture.state.durableVisible === true);
  const adoptedDom = await domEvidence();
  const adoptedRows = await rowsSnapshot();
  assert.ok(adoptedDom.rows.some(row => row.uuid === 'codex-user-S-42' && row.noteStrip), 'canonical Timeline must retain the cyan note marker');
  assert.ok(adoptedDom.notePopovers.some(text => text?.includes('fixture note')) || adoptedRows.rows.some(row => row.content === 'fixture note'), 'canonical note content must remain visible/persisted');
  await saveShot('canonical-adopted.png');
  result.steps.push({ phase: 'canonical-adoption', adoptedRows, adoptedDom });
  await stampLog('canonical-adopted', { canonicalUuid: 'codex-user-S-42', noteVisible: true });

  // The private store contains one ordinary physical note as a control row.
  // It is loaded by the real timeline:get-notes IPC and must survive the
  // failed live-proof attempt below.
  await page.waitForFunction(async () => (await window.fixture.dbSnapshot()).rows.some(row => row.entry_uuid === 'physical-normal-S' && row.content === 'normal physical note'));
  const controlRows = await rowsSnapshot();
  assert.ok(controlRows.rows.some(row => row.entry_uuid === 'physical-normal-S' && row.content === 'normal physical note'));
  await stampLog('physical-control-loaded', { uuid: 'physical-normal-S' });

  // Reopen/remount from the same private SQLite store and prove both notes
  // hydrate back into the actual component.
  await page.evaluate(() => window.fixture.remount());
  await page.waitForSelector('[data-timeline-entry-uuid="codex-user-S-42"]');
  await page.waitForSelector('[data-timeline-entry-uuid="physical-normal-S"]');
  await page.waitForFunction(async () => {
    const evidence = await window.fixture.dbSnapshot();
    return evidence.rows.some(row => row.entry_uuid === 'codex-user-S-42' && row.content === 'fixture note')
      && evidence.rows.some(row => row.entry_uuid === 'physical-normal-S' && row.content === 'normal physical note');
  });
  const remountedDom = await domEvidence();
  assert.ok(remountedDom.rows.some(row => row.uuid === 'codex-user-S-42' && row.noteStrip), 'remount must retain the canonical note marker');
  assert.ok(remountedDom.rows.some(row => row.uuid === 'physical-normal-S' && row.noteStrip), 'remount must retain the normal physical marker');
  await saveShot('remounted.png');
  result.steps.push({ phase: 'remount', rows: await rowsSnapshot(), remountedDom });
  await stampLog('remount-verified', { canonical: true, physical: true });

  // Failed proof: a second live point has an exact-looking source identity,
  // but no canonical row. The real resolver must reject it and Timeline must
  // leave the typed text in the open editor.
  await page.evaluate(() => window.fixture.emitLive('failed'));
  await page.waitForSelector('[data-timeline-entry-uuid="codex-live-S-43-user"]');
  await page.locator('[data-timeline-entry-uuid="codex-live-S-43-user"]').click({ button: 'right' });
  await page.getByText('Добавить заметку', { exact: true }).click();
  await page.locator('textarea').fill('failed proof text');
  await page.getByText('Сохранить', { exact: true }).click();
  await page.waitForTimeout(250);
  const failedDom = await domEvidence();
  const failedRows = await rowsSnapshot();
  const failedEditor = failedDom.noteTextareas.find(entry => entry.visible);
  assert.equal(failedEditor?.value, 'failed proof text', 'failed proof must retain note editor text');
  assert.equal(failedRows.rows.some(row => row.entry_uuid === 'codex-live-S-43-user'), false, 'failed live proof must not persist watcher UUID');
  assert.ok(failedRows.rows.some(row => row.entry_uuid === 'codex-user-S-42' && row.content === 'fixture note'), 'failed proof must not disturb canonical note');
  assert.ok(failedRows.rows.some(row => row.entry_uuid === 'physical-normal-S' && row.content === 'normal physical note'), 'failed proof must not disturb physical note');
  await saveShot('failed-proof-retained.png');
  result.steps.push({ phase: 'failed-proof-retained', failedRows, failedDom });
  await stampLog('failed-proof-retained', { editorText: failedEditor?.value, storedRows: failedRows.rows.map(row => row.entry_uuid) });

  assert.deepEqual(result.errors, [], 'renderer must stay free of page errors');
  result.status = 'PASS';
  await stampLog('run-pass', { steps: result.steps.map(step => step.phase) });
} catch (error) {
  result.status = 'FAIL';
  result.error = error.stack || String(error);
  await stampLog('run-fail', { error: result.error });
  try { await saveShot('failure.png'); } catch {}
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(artifact, 'renderer.log'), rendererLogs.join('\n') + '\n');
  result.artifacts = {
    originalSharedLog: sharedLog,
    runLog,
    mainLog,
    rendererLog: path.join(artifact, 'renderer.log'),
    sqlite: path.join(artifact, 'user-data', 'timeline-notes.sqlite'),
    screenshots: result.screenshots,
    sourceSnapshot: snapshot,
  };
  result.cleanup = { pid, appClosed: false };
  await app.close();
  result.cleanup.appClosed = true;
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await stampLog('run-cleanup', { pid, appClosed: true });
  console.log(JSON.stringify(result));
}
