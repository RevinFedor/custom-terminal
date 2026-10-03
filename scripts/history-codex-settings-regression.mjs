#!/usr/bin/env node
// Private Electron renderer only. Controlled Codex History events, trusted
// wheel/click/type, no provider process, account, global setting, or Send.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = process.env.NOTED_MODEL_HISTORY_ARTIFACT
  || '/private/tmp/noted-model-history-20260930.CN0aGJ';
await fs.mkdir(artifact, { recursive: true });
const snapshot = path.join(artifact, 'source');
const eventLog = [];
const stamp = () => new Date().toISOString();
const log = (message, data = {}) => {
  const line = `${stamp()} ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`;
  eventLog.push(line);
  return line;
};
const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

const frozenFiles = [
  'src/renderer/components/Workspace/HistoryPanel.tsx',
  'src/renderer/utils/historyLiveProjection.mjs',
  'src/main/codex-settings-history.js',
  'scripts/fixtures/history-codex-settings.tsx',
  'scripts/history-codex-settings-regression.mjs',
];
const sourceHashes = {};
for (const file of frozenFiles) sourceHashes[file] = await sha256(path.join(repo, file));
await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify({ capturedAt: stamp(), sourceHashes }, null, 2));
log('FREEZE source hashes recorded', sourceHashes);

const result = {
  status: 'RUNNING', artifact, executor: { model: 'Codex delegated E2E executor', effort: 'standard' },
  sourceHashes, actions: [], evidence: {}, blockers: [], errors: [],
};
let app;

try {
  log('SETUP worktree snapshot start', { snapshot });
  execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  for (const name of ['src', 'packages/claude-blocks']) {
    await fs.cp(path.join(repo, name), path.join(snapshot, name), {
      recursive: true, force: true,
      filter: (entry) => !entry.includes('/node_modules') && !entry.includes('/.git'),
    });
  }
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(
    path.join(repo, 'scripts/fixtures/history-codex-settings.tsx'),
    path.join(snapshot, 'scripts/fixtures/history-codex-settings.tsx'),
  );
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) {
    await fs.mkdir(shared, { recursive: true });
    await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), {
      recursive: true, filter: (entry) => !entry.includes('/node_modules'),
    });
  }
  await build({
    entryPoints: [path.join(snapshot, 'scripts/fixtures/history-codex-settings.tsx')],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm',
    target: 'chrome120', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
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
    '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  await fs.mkdir(path.join(artifact, 'user-data'), { recursive: true });
  await fs.writeFile(path.join(artifact, 'preload.cjs'),
    `const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if(channel==='agent:list-background-work')return{success:true,records:[]};
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:720,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact, 'preload.cjs'))}}});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  result.actions.push('private fixture bundle and disposable Electron target created');
  log('SETUP private target files ready', { artifact });

  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: path.join(artifact, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const child = app.process();
  await fs.writeFile(path.join(artifact, 'process-lease.json'), JSON.stringify({
    startedAt: stamp(), pid: child?.pid || null, cwd: artifact,
    command: [path.join(repo, 'node_modules/.bin/electron'), path.join(artifact, 'main.cjs')],
    ownedByThisRun: true,
  }, null, 2));
  log('LEASE private Electron started', { pid: child?.pid || null, cwd: artifact });

  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => { result.errors.push(error.stack || error.message); log('UI pageerror', { error: error.message }); });
  page.on('console', (message) => { const line = message.text(); result.evidence.lastConsole = line; log(`UI console ${message.type()}`, { line }); });

  await page.waitForFunction(() => window.require('process').env.NOTED_E2E_TEST === 'true');
  // Full-window baseline is intentionally first renderer evidence, before the
  // fixture mount or any DOM/input action.
  await page.screenshot({ path: path.join(artifact, 'window-boot.png') });
  result.actions.push('full-window boot baseline screenshot captured before fixture/UI actions');
  log('BASELINE boot full-window screenshot captured');

  await page.waitForFunction(() => !!window.__codexSettingsFixture?.host);
  const fixture = page.locator('[data-codex-settings-fixture]');
  await page.waitForFunction(() => window.__codexSettingsFixture?.host?.querySelector('[data-history-viewport-ready="1"]'));
  await page.waitForFunction(() => window.__codexSettingsFixture?.ready ||
    !!window.__codexSettingsFixture?.host?.querySelector('[data-history-row-real]'));
  // Establish the baseline viewport with trusted user scrolling. The fixture
  // restores a disposable prior tail anchor on cold mount, so this explicit
  // Home gesture makes the baseline settings rows the visible subject.
  const baselineScroller = fixture.locator('[data-virtuoso-scroller]');
  const baselineBox = await baselineScroller.boundingBox();
  assert.ok(baselineBox, 'baseline History scroller must be visible');
  await page.mouse.move(baselineBox.x + baselineBox.width / 2, baselineBox.y + baselineBox.height / 2);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(artifact, 'baseline-initial.png') });
  result.actions.push('Codex History fixture mounted; baseline model A / effort max observed');
  log('BASELINE fixture mounted and painted');

  const snapshotRows = async () => page.evaluate(() => {
    const f = window.__codexSettingsFixture;
    const root = f.host;
    const rows = [...root.querySelectorAll('[data-history-row-real]')].map((node) => ({
      uuid: node.getAttribute('data-uuid'), text: node.textContent || '',
      rect: (() => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
    }));
    return {
      current: f.current(), rows,
      slash: rows.filter((row) => row.text.includes('/model') || row.text.includes('/effort')),
      scroller: (() => { const s = root.querySelector('[data-virtuoso-scroller]'); if (!s) return null; return {
        top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight,
      }; })(),
    };
  });
  const rowText = async () => (await snapshotRows()).slash.map((row) => row.text);
  const countText = async (needle) => page.evaluate((needle) => {
    const root = window.__codexSettingsFixture.host;
    return [...root.querySelectorAll('.hp-history-slash-cmd')].filter((node) => node.textContent?.trim() === needle).length;
  }, needle);
  await page.waitForFunction(() => {
    const texts = [...window.__codexSettingsFixture.host.querySelectorAll('.hp-history-slash-cmd')].map((node) => node.textContent?.trim());
    return texts.includes('/model A') && texts.includes('/effort max');
  });
  const baseline = await snapshotRows();
  result.evidence.baseline = baseline;
  log('BASELINE durable settings rows visible', { slash: baseline.slash.map((row) => row.text) });
  assert.equal(await countText('/model A'), 1);
  assert.equal(await countText('/effort max'), 1);

  const sourceModel = await page.evaluate(() => window.__codexSettingsFixture.sourceModel);
  const sourceEffort = await page.evaluate(() => window.__codexSettingsFixture.sourceEffort);
  const liveModelUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-live-model-b`);
  const liveEffortUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-live-effort-max`);
  const liveListenerCount = await page.evaluate(() => window.require('electron').ipcRenderer.listenerCount('agent-transcript:live-message'));
  log('LIVE listener preflight', { liveListenerCount });
  assert.ok(liveListenerCount > 0, 'HistoryPanel live-message listener must be installed');
  const emitProbe = await page.evaluate(() => {
    const ipc = window.require('electron').ipcRenderer;
    let seen = 0;
    const handler = () => { seen += 1; };
    ipc.on('__codex-settings-e2e-probe', handler);
    ipc.emit('__codex-settings-e2e-probe', {}, { ok: true });
    ipc.removeListener('__codex-settings-e2e-probe', handler);
    return seen;
  });
  log('LIVE emitter preflight', { emitProbe });
  assert.equal(emitProbe, 1, 'ipcRenderer emitter must deliver fixture events');
  await page.evaluate(() => {
    const ipc = window.require('electron').ipcRenderer;
    window.__codexSeenLive = [];
    window.__codexCaptureLive = (_event, detail) => window.__codexSeenLive.push(detail);
    ipc.on('agent-transcript:live-message', window.__codexCaptureLive);
  });
  await page.evaluate(() => window.__codexSettingsFixture.setBusy(true, 'a'));
  await page.evaluate(({ sourceModel, sourceEffort, liveModelUuid, liveEffortUuid }) => {
    const f = window.__codexSettingsFixture;
    f.emitSetting('model', 'B', sourceModel, liveModelUuid, 'a', 420);
    f.emitSetting('effort', 'max', sourceEffort, liveEffortUuid, 'a', 421);
  }, { sourceModel, sourceEffort, liveModelUuid, liveEffortUuid });
  log('LIVE event details', await page.evaluate(() => ({
    count: window.__codexSeenLive?.length || 0,
    details: (window.__codexSeenLive || []).map((detail) => ({
      type: detail?.type, toolType: detail?.toolType, tabId: detail?.tabId,
      sessionId: detail?.sessionId, role: detail?.entry?.role,
      content: detail?.entry?.content, settingsFact: detail?.entry?.settingsFact,
      })),
  })));
  const liveBox = await baselineScroller.boundingBox();
  assert.ok(liveBox, 'live History scroller must remain visible');
  await page.mouse.move(liveBox.x + liveBox.width / 2, liveBox.y + liveBox.height / 2);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(350);
  await page.waitForFunction(() => {
    const root = window.__codexSettingsFixture.host;
    return [...root.querySelectorAll('.hp-history-slash-cmd')].some((node) => node.textContent?.trim() === '/model B');
  });
  const liveBottom = await snapshotRows();
  result.actions.push('trusted-visible UI observed live /model B before durable refresh; unchanged /effort max remained single');
  log('LIVE settings rows painted before full refresh', { slash: liveBottom.slash.map((row) => row.text) });
  assert.equal(await countText('/model B'), 1);
  // The unchanged effort is retained in the durable prefix, not duplicated in
  // the tail live projection. Visit both sides with trusted wheel input so the
  // virtualized DOM proves one max row as well as the visible B row.
  const topBoxAfterLive = await baselineScroller.boundingBox();
  assert.ok(topBoxAfterLive, 'live History scroller must remain visible at tail');
  await page.mouse.move(topBoxAfterLive.x + topBoxAfterLive.width / 2, topBoxAfterLive.y + topBoxAfterLive.height / 2);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(300);
  const liveTop = await snapshotRows();
  assert.equal(await countText('/effort max'), 1);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => [...window.__codexSettingsFixture.host.querySelectorAll('.hp-history-slash-cmd')]
    .some((node) => node.textContent?.trim() === '/model B'));
  const live = await snapshotRows();
  const liveViewport = await page.evaluate(() => {
    const root = window.__codexSettingsFixture.host;
    const row = [...root.querySelectorAll('.hp-history-slash-cmd')]
      .find((node) => node.textContent?.trim() === '/model B')?.closest('[data-history-row-real]');
    const scroller = root.querySelector('[data-virtuoso-scroller]');
    const rowRect = row?.getBoundingClientRect();
    const scrollRect = scroller?.getBoundingClientRect();
    return { intersects: !!rowRect && !!scrollRect && rowRect.bottom > scrollRect.top && rowRect.top < scrollRect.bottom,
      rowRect: rowRect ? { x: rowRect.x, y: rowRect.y, width: rowRect.width, height: rowRect.height } : null,
      scrollRect: scrollRect ? { x: scrollRect.x, y: scrollRect.y, width: scrollRect.width, height: scrollRect.height } : null };
  });
  assert.equal(liveViewport.intersects, true, JSON.stringify(liveViewport));
  result.evidence.liveBeforeRefresh = { top: liveTop, bottom: live, bottomViewport: liveViewport };
  await page.screenshot({ path: path.join(artifact, 'live-before-refresh.png') });

  await page.evaluate(() => {
    const f = window.__codexSettingsFixture;
    const live = f.host.querySelector(`[data-uuid="${f.id}-live-model-b"]`);
    const rect = live?.getBoundingClientRect();
    f.modelHandoffBefore = live ? { node: live, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null } : null;
  });
  const canonicalModelUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-canonical-model-b`);
  const baseRows = await page.evaluate(() => window.__codexSettingsFixture.fixture('a').entries);
  const canonicalBaseRows = baseRows.map((row) => row.uuid?.endsWith('-base-effort')
    ? { ...row, sourceIdentityAliases: [...(row.sourceIdentityAliases || []), sourceEffort] }
    : row);
  const canonicalRows = [...canonicalBaseRows,
    await page.evaluate(({ canonicalModelUuid, sourceModel }) => {
      const f = window.__codexSettingsFixture; return {
        uuid: canonicalModelUuid, role: 'slash', content: '/model B', sessionId: f.ownerA.sessionId,
        sourceIdentity: sourceModel, recordByteOffset: 420,
        settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'B', source: 'thread_settings_applied' },
      };
    }, { canonicalModelUuid, sourceModel }),
  ];
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), canonicalRows);
  await page.waitForFunction((uuid) => {
    const root = window.__codexSettingsFixture.host;
    return !!root.querySelector(`[data-uuid="${uuid}"][data-history-row-real]`);
  }, canonicalModelUuid);
  await page.waitForTimeout(250);
  const handoff = await page.evaluate(() => {
    const f = window.__codexSettingsFixture;
    const current = f.host.querySelector(`[data-uuid="${f.id}-canonical-model-b"]`);
    const prior = f.modelHandoffBefore;
    const rect = current?.getBoundingClientRect();
    return {
      sameDomNode: !!prior?.node && prior.node === current,
      beforeRect: prior?.rect || null,
      afterRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      modelB: [...f.host.querySelectorAll('.hp-history-slash-cmd')].filter((node) => node.textContent?.trim() === '/model B').length,
      effortMax: [...f.host.querySelectorAll('.hp-history-slash-cmd')].filter((node) => node.textContent?.trim() === '/effort max').length,
      durableEffortMax: f.fixture('a').entries.filter((entry) => entry.content === '/effort max').length,
    };
  });
  result.evidence.canonicalHandoff = handoff;
  result.actions.push('durable canonical rows used a different UUID with the same sourceIdentity');
  log('CANONICAL handoff observed', handoff);
  assert.equal(handoff.modelB, 1);
  assert.ok(handoff.effortMax <= 1);
  assert.equal(handoff.durableEffortMax, 1);
  assert.ok(handoff.sameDomNode, JSON.stringify(handoff));
  assert.ok(handoff.beforeRect && handoff.afterRect);
  assert.ok(Math.abs(handoff.beforeRect.x - handoff.afterRect.x) <= 1);
  assert.ok(Math.abs(handoff.beforeRect.y - handoff.afterRect.y) <= 2);
  assert.ok(Math.abs(handoff.beforeRect.height - handoff.afterRect.height) <= 2);
  await page.screenshot({ path: path.join(artifact, 'canonical-handoff.png') });
  const canonicalTopBox = await baselineScroller.boundingBox();
  assert.ok(canonicalTopBox, 'canonical History scroller must remain visible');
  await page.mouse.move(canonicalTopBox.x + canonicalTopBox.width / 2, canonicalTopBox.y + canonicalTopBox.height / 2);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(300);
  const canonicalTopEffortMax = await countText('/effort max');
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  const canonicalTailEffortMax = await countText('/effort max');
  result.evidence.normalCanonicalEffortCounts = { durable: handoff.durableEffortMax, topVisible: canonicalTopEffortMax, tailVisible: canonicalTailEffortMax };
  assert.equal(canonicalTopEffortMax, 1);
  assert.ok(canonicalTailEffortMax <= 1);

  // Alias-primary handoff: the first visible live row carries the repeated
  // physical record's later source identity (offset 300), while the durable
  // canonical row uses the provider's earlier primary (offset 200) and keeps
  // the live identity as an exact alias. The row must retire in place.
  const aliasLiveSource = await page.evaluate(() => `${window.__codexSettingsFixture.id}:alias:model:300`);
  const aliasPrimarySource = await page.evaluate(() => `${window.__codexSettingsFixture.id}:alias:model:200`);
  const aliasLiveUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-alias-live-model-b`);
  const aliasCanonicalUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-alias-canonical-model-b`);
  // Reset to the baseline physical history first. The alias case must contain
  // one live B, not a second B beside the prior normal-path canonical row.
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), canonicalBaseRows);
  await page.waitForTimeout(300);
  await page.evaluate(({ aliasLiveSource, aliasLiveUuid }) => {
    const f = window.__codexSettingsFixture;
    f.setBusy(true, 'a');
    f.emitSetting('model', 'B', aliasLiveSource, aliasLiveUuid, 'a', 300);
  }, { aliasLiveSource, aliasLiveUuid });
  const aliasTailBox = await baselineScroller.boundingBox();
  assert.ok(aliasTailBox, 'alias live History scroller must remain visible');
  await page.mouse.move(aliasTailBox.x + aliasTailBox.width / 2, aliasTailBox.y + aliasTailBox.height / 2);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  await page.waitForFunction((uuid) => !!window.__codexSettingsFixture.host
    .querySelector(`[data-uuid="${uuid}"][data-history-row-real]`), aliasLiveUuid);
  await page.screenshot({ path: path.join(artifact, 'alias-live-before-refresh.png') });
  await page.evaluate((uuid) => {
    const f = window.__codexSettingsFixture;
    const node = f.host.querySelector(`[data-uuid="${uuid}"]`);
    const rect = node?.getBoundingClientRect();
    f.aliasHandoffBefore = node ? {
      node, rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    } : null;
  }, aliasLiveUuid);
  const aliasCanonicalRows = [...canonicalBaseRows,
    await page.evaluate(({ aliasCanonicalUuid, aliasPrimarySource, aliasLiveSource }) => {
      const f = window.__codexSettingsFixture; return {
        uuid: aliasCanonicalUuid, role: 'slash', content: '/model B', sessionId: f.ownerA.sessionId,
        sourceIdentity: aliasPrimarySource, sourceIdentityAliases: [aliasLiveSource], recordByteOffset: 200,
        settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'B', source: 'thread_settings_applied' },
      };
    }, { aliasCanonicalUuid, aliasPrimarySource, aliasLiveSource }),
  ];
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), aliasCanonicalRows);
  await page.waitForFunction((uuid) => !!window.__codexSettingsFixture.host
    .querySelector(`[data-uuid="${uuid}"][data-history-row-real]`), aliasCanonicalUuid);
  await page.waitForTimeout(250);
  const aliasHandoff = await page.evaluate(({ aliasLiveUuid, aliasCanonicalUuid }) => {
    const f = window.__codexSettingsFixture;
    const prior = f.aliasHandoffBefore;
    const current = f.host.querySelector(`[data-uuid="${aliasCanonicalUuid}"]`);
    const rect = current?.getBoundingClientRect();
    const modelRows = [...f.host.querySelectorAll('.hp-history-slash-cmd')]
      .filter((node) => node.textContent?.trim() === '/model B');
    return {
      sameDomNode: !!prior?.node && prior.node === current,
      liveUuidStillMounted: !!f.host.querySelector(`[data-uuid="${aliasLiveUuid}"]`),
      modelBCount: modelRows.length,
      canonicalUuid: current?.getAttribute('data-uuid') || null,
      beforeRect: prior?.rect || null,
      afterRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    };
  }, { aliasLiveUuid, aliasCanonicalUuid });
  result.evidence.aliasHandoff = aliasHandoff;
  result.actions.push('alias-primary handoff: live offset 300 → canonical primary offset 200 with live source alias');
  log('ALIAS canonical handoff observed', aliasHandoff);
  assert.equal(aliasHandoff.sameDomNode, true, JSON.stringify(aliasHandoff));
  assert.equal(aliasHandoff.liveUuidStillMounted, false, JSON.stringify(aliasHandoff));
  assert.equal(aliasHandoff.modelBCount, 1, JSON.stringify(aliasHandoff));
  assert.equal(aliasHandoff.canonicalUuid, aliasCanonicalUuid);
  assert.ok(aliasHandoff.beforeRect && aliasHandoff.afterRect);
  assert.ok(Math.abs(aliasHandoff.beforeRect.x - aliasHandoff.afterRect.x) <= 1);
  assert.ok(Math.abs(aliasHandoff.beforeRect.y - aliasHandoff.afterRect.y) <= 2);
  assert.ok(Math.abs(aliasHandoff.beforeRect.height - aliasHandoff.afterRect.height) <= 2);
  await page.screenshot({ path: path.join(artifact, 'alias-canonical-handoff.png') });

  const contradictoryUuid = await page.evaluate(() => `${window.__codexSettingsFixture.id}-canonical-model-contradictory`);
  // Keep the live B fact in-flight while a deliberately contradictory durable
  // row is refreshed. The mismatch badge is a comparison of these two
  // structured facts, not a text comparison after the live row has retired.
  await page.evaluate(({ sourceModel }) => {
    const f = window.__codexSettingsFixture;
    f.setBusy(true, 'a');
    f.emitSetting('model', 'B', sourceModel, `${f.id}-late-live-model-b`, 'a', 421);
  }, { sourceModel });
  await page.waitForTimeout(120);
  const contradictionRows = [...canonicalRows, await page.evaluate(({ contradictoryUuid, sourceModel }) => {
    const f = window.__codexSettingsFixture; return {
      uuid: contradictoryUuid, role: 'slash', content: '/model C', sessionId: f.ownerA.sessionId,
      sourceIdentity: sourceModel, recordByteOffset: 422,
      settingsFact: { version: 1, provider: 'codex', kind: 'model', value: 'C', source: 'thread_settings_applied' },
    };
  }, { contradictoryUuid, sourceModel })];
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), contradictionRows);
  const mismatchBox = await baselineScroller.boundingBox();
  assert.ok(mismatchBox, 'mismatch History scroller must remain visible');
  await page.mouse.move(mismatchBox.x + mismatchBox.width / 2, mismatchBox.y + mismatchBox.height / 2);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(350);
  await page.waitForFunction(() => {
    const root = window.__codexSettingsFixture.host;
    return [...root.querySelectorAll('[role="status"]')].filter((node) => node.textContent?.includes('History mismatch')).length === 1;
  });
  const mismatch = await page.evaluate(() => {
    const root = window.__codexSettingsFixture.host;
    return { badges: [...root.querySelectorAll('[role="status"]')].filter((node) => node.textContent?.includes('History mismatch')).map((node) => ({
      text: node.textContent, title: node.getAttribute('title'), uuid: node.closest('[data-uuid]')?.getAttribute('data-uuid'),
    })), modelC: [...root.querySelectorAll('.hp-history-slash-cmd')].filter((node) => node.textContent?.trim() === '/model C').length };
  });
  result.evidence.mismatch = mismatch;
  log('MISMATCH contradictory canonical value marked once', mismatch);
  assert.equal(mismatch.badges.length, 1);
  assert.equal(mismatch.modelC, 1);
  await page.screenshot({ path: path.join(artifact, 'mismatch.png') });

  const correctedRows = canonicalRows;
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), correctedRows);
  await page.waitForFunction(() => ![...window.__codexSettingsFixture.host.querySelectorAll('[role="status"]')]
    .some((node) => node.textContent?.includes('History mismatch')));
  const corrected = await snapshotRows();
  result.evidence.corrected = corrected;
  log('CORRECTION canonical source value removed mismatch', { slash: corrected.slash.map((row) => row.text) });
  assert.equal(await countText('/model B'), 1);
  assert.equal(await page.locator('[role="status"]', { hasText: 'History mismatch' }).count(), 0);

  const repeatLogStart = eventLog.length;
  await page.evaluate(() => window.__codexSettingsFixture.setBusy(true, 'a'));
  await page.evaluate(({ sourceModel, sourceEffort }) => {
    const f = window.__codexSettingsFixture;
    f.emitSetting('model', 'B', sourceModel, `${f.id}-repeat-model-b`, 'a', 430);
    f.emitSetting('model', 'B', sourceModel, `${f.id}-repeat-model-b-again`, 'a', 430);
    f.emitSetting('effort', 'max', sourceEffort, `${f.id}-repeat-effort-max`, 'a', 431);
    f.emitSetting('effort', 'low', `${f.id}:physical:effort:43`, `${f.id}-follow-up-effort-low`, 'a', 432);
  }, { sourceModel, sourceEffort });
  await page.waitForFunction(() => {
    const root = window.__codexSettingsFixture.host;
    return [...root.querySelectorAll('.hp-history-slash-cmd')].some((node) => node.textContent?.trim() === '/effort low');
  });
  // Prove the follow-up row while it is still a live projection, then make
  // that same disposable row canonical before switching owners so the switch
  // cannot erase a valid later operation from the test surface.
  const followUpBox = await baselineScroller.boundingBox();
  assert.ok(followUpBox, 'follow-up History scroller must remain visible');
  await page.mouse.move(followUpBox.x + followUpBox.width / 2, followUpBox.y + followUpBox.height / 2);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(250);
  const followUpLive = await snapshotRows();
  result.evidence.followUpLive = followUpLive;
  assert.equal(await countText('/effort low'), 1);
  const followUpCanonical = await page.evaluate(() => {
    const f = window.__codexSettingsFixture;
    return {
      uuid: `${f.id}-canonical-effort-low`, role: 'slash', content: '/effort low', sessionId: f.ownerA.sessionId,
      sourceIdentity: `${f.id}:physical:effort:43`, recordByteOffset: 432,
      settingsFact: { version: 1, provider: 'codex', kind: 'effort', value: 'low', source: 'thread_settings_applied' },
    };
  });
  await page.evaluate((rows) => window.__codexSettingsFixture.replaceDurable(rows, 'a'), [...canonicalRows, followUpCanonical]);
  await page.waitForTimeout(300);
  // Exercise a real owner switch and a hidden presentation visit. The foreign
  // session event is delivered while A owns the panel and must be ignored.
  await page.evaluate(() => window.__codexSettingsFixture.emitForeignSetting(
    'model', 'FOREIGN', window.__codexSettingsFixture.sourceModel, `${window.__codexSettingsFixture.id}-foreign-model`));
  await page.evaluate(() => window.__codexSettingsFixture.switchTo('b'));
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__codexSettingsFixture.switchTo('a'));
  await page.waitForFunction(() => window.__codexSettingsFixture.current() === 'a');
  await page.evaluate(() => window.__codexSettingsFixture.show(false));
  await page.evaluate(({ sourceModel }) => {
    const f = window.__codexSettingsFixture;
    f.emitSetting('model', 'B', sourceModel, `${f.id}-hidden-repeat-model-b`, 'a', 440);
  }, { sourceModel });
  await page.evaluate(() => window.__codexSettingsFixture.show(true));
  const scroller = fixture.locator('[data-virtuoso-scroller]');
  const box = await scroller.boundingBox();
  assert.ok(box, 'History scroller must be visible for trusted scroll');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => [...window.__codexSettingsFixture.host.querySelectorAll('.hp-history-slash-cmd')]
    .some((node) => node.textContent?.trim() === '/effort low'));
  const repeat = await snapshotRows();
  const duplicateUuids = await page.evaluate(() => {
    const root = window.__codexSettingsFixture.host;
    const uuids = [...root.querySelectorAll('[data-history-row-real][data-uuid]')].map((node) => node.getAttribute('data-uuid')).filter(Boolean);
    return [...new Set(uuids.filter((uuid, index) => uuids.indexOf(uuid) !== index))];
  });
  const keyErrors = result.errors.filter((line) => /same key|duplicate key/i.test(line));
  const orphanLogs = eventLog.slice(repeatLogStart).filter((line) => /LIVE_ORPHANS|orphan/i.test(line));
  const earlierOrphanLogs = eventLog.slice(0, repeatLogStart).filter((line) => /LIVE_ORPHANS|orphan/i.test(line));
  result.evidence.repeatSwitchHiddenScroll = {
    ...repeat, duplicateUuids, keyErrors, orphanLogs, earlierOrphanLogs,
    scrollerAfter: await scroller.evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight })),
  };
  result.actions.push('repeated same settings, follow-up effort, foreign-session event, owner switch, hidden visit, and trusted scroll');
  log('REPEAT switch/hidden/trusted-scroll invariants observed', { duplicateUuids, keyErrors, orphanLogs });
  assert.equal(await countText('/model B'), 1);
  const repeatDurableEffortMax = await page.evaluate(() => window.__codexSettingsFixture.fixture('a').entries
    .filter((entry) => entry.content === '/effort max').length);
  assert.equal(repeatDurableEffortMax, 1);
  const repeatTopBox = await baselineScroller.boundingBox();
  assert.ok(repeatTopBox, 'repeat History scroller must remain visible');
  await page.mouse.move(repeatTopBox.x + repeatTopBox.width / 2, repeatTopBox.y + repeatTopBox.height / 2);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(300);
  const repeatTopEffortMax = await countText('/effort max');
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(300);
  const repeatTailEffortMax = await countText('/effort max');
  result.evidence.repeatSwitchHiddenScroll.effortMaxCounts = {
    durable: repeatDurableEffortMax, topVisible: repeatTopEffortMax, tailVisible: repeatTailEffortMax,
  };
  assert.equal(repeatTopEffortMax, 1);
  assert.ok(repeatTailEffortMax <= 1);
  assert.equal(await countText('/effort low'), 1);
  assert.deepEqual(duplicateUuids, []);
  assert.deepEqual(keyErrors, []);
  assert.deepEqual(orphanLogs, []);
  await page.screenshot({ path: path.join(artifact, 'repeat-switch-hidden-scroll.png') });

  const composer = fixture.locator('.gt-composer-editor .cm-content[contenteditable="true"]').last();
  await composer.click();
  await composer.fill('codex settings draft retained');
  assert.match(await composer.innerText(), /codex settings draft retained/);
  result.evidence.composer = { usable: true, text: await composer.innerText() };
  result.actions.push('trusted click/type verified the History composer remains usable');
  log('COMPOSER trusted click/type usable');
  await page.screenshot({ path: path.join(artifact, 'composer-proof.png') });

  result.status = result.errors.length === 0 ? 'PASS' : 'FAIL';
  if (result.errors.length) throw new Error(`renderer errors: ${result.errors.join('; ')}`);
} catch (error) {
  result.status = 'FAIL';
  result.failure = error.stack || String(error);
  result.blockers.push({ classification: 'FAIL', message: result.failure });
  log('FAIL bounded UI verification', { error: result.failure });
  if (app) {
    try { await app.firstWindow().then((page) => page.screenshot({ path: path.join(artifact, 'failure.png') })); } catch {}
  }
  process.exitCode = 1;
} finally {
  result.finishedAt = stamp();
  await fs.writeFile(path.join(artifact, 'test-run.log'), `${eventLog.join('\n')}\n`);
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  if (app) {
    log('CLEANUP closing private Electron target');
    try { await app.close(); } catch (error) { result.blockers.push({ classification: 'CLEANUP', message: String(error) }); }
  }
  try { execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' }); log('CLEANUP owned worktree removed', { snapshot }); }
  catch (error) { result.blockers.push({ classification: 'CLEANUP', message: String(error) }); }
  await fs.writeFile(path.join(artifact, 'test-run.log'), `${eventLog.join('\n')}\n`);
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'alias-result.json'), JSON.stringify({
    status: result.status,
    executor: result.executor,
    sourceHashes: result.sourceHashes,
    evidence: {
      aliasHandoff: result.evidence.aliasHandoff,
      liveBeforeRefresh: result.evidence.liveBeforeRefresh,
      normalCanonicalEffortCounts: result.evidence.normalCanonicalEffortCounts,
    },
    errors: result.errors,
    blockers: result.blockers,
  }, null, 2));
  console.log(JSON.stringify({ status: result.status, artifact, actions: result.actions, failure: result.failure || null }));
}
