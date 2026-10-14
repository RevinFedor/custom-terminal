#!/usr/bin/env node
// Private Electron renderer verification for captured native image History.
// The provider, PTY, production API, receipts, and JSONL remain untouched.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const packet = '/private/tmp/ios-settings-images-20261003';
const artifact = process.env.NOTED_NATIVE_IMAGES_ARTIFACT
  || await fs.mkdtemp('/private/tmp/noted-native-images-ui-');
const snapshot = path.join(artifact, 'source');
const packetEntryPath = path.join(packet, 'image-entry.json');
const packetReceiptsPath = path.join(packet, 'receipt-captures.json');
const eventLog = [];
const errors = [];
const stamp = () => new Date().toISOString();
const log = (message, data = {}) => {
  const line = `${stamp()} ${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`;
  eventLog.push(line);
  return line;
};
const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const result = {
  status: 'RUNNING',
  artifact,
  executor: { model: 'Codex delegated E2E executor', effort: 'standard' },
  target: { runtime: 'Electron 28', mode: 'private standalone launch', provider: false, cdp: false },
  actions: [], evidence: {}, blockers: [], errors,
};
let app;
let worktreeAdded = false;
const frozenFiles = [
  'src/main/main.js',
  'src/main/web-server.js',
  'src/main/history-authoring-projection.js',
  'src/main/history-prompt-presentations.js',
  'src/renderer/components/Workspace/HistoryPanel.tsx',
  'src/renderer/utils/historyImageRuns.mjs',
  'scripts/fixtures/history-native-images.tsx',
  'scripts/history-native-images-regression.mjs',
];

function memoryPresentationStore() {
  const rows = [];
  return {
    rows,
    getHistoryPromptPresentations: (toolType, sessionId) => rows.filter(
      (row) => row.toolType === toolType && row.sessionId === sessionId,
    ),
    getHistoryPromptPresentationsForEntries: (toolType, uuids) => rows.filter(
      (row) => row.toolType === toolType && uuids.includes(row.entryUuid),
    ),
    getHistoryPromptPresentationByAudit: (toolType, sessionId, auditTimestamp, transportHash) => rows.find(
      (row) => row.toolType === toolType && row.sessionId === sessionId
        && row.auditTimestamp === auditTimestamp && row.transportHash === transportHash,
    ) || null,
    saveHistoryPromptPresentation(input) {
      const existing = this.getHistoryPromptPresentationByAudit(
        input.toolType, input.sessionId, input.auditTimestamp, input.transportHash,
      );
      if (existing) Object.assign(existing, clone(input));
      else rows.push(clone(input));
      return true;
    },
    bindHistoryPromptPresentationEntry() { throw new Error('fixture must not infer an audit address'); },
  };
}

async function buildProjectedFixture() {
  await fs.access(packetEntryPath);
  await fs.access(packetReceiptsPath);
  const entry = JSON.parse(await fs.readFile(packetEntryPath, 'utf8'));
  const captures = JSON.parse(await fs.readFile(packetReceiptsPath, 'utf8'));
  const captured = captures?.[0]?.records?.[0];
  assert.ok(captured, 'first captured receipt must be present');
  assert.equal(captured.handoffId, '1D6A70F3-CFA0-4947-8080-828CADECD38B');
  assert.equal(captured.provider, 'codex');
  assert.equal(captured.sessionId, entry.sessionId);
  assert.equal(captured.entryUuid, 'codex-user-918b29e9-3369-4d94-8739-3b2cbefe7351-31727');
  assert.equal(entry.uuid, 'codex-user-918b29e9-3369-4d94-8739-3b2cbefe7351-31728');
  assert.equal(entry.imagePaths.length, 2);

  const record = {
    ...captured,
    receipt: captured,
    promptLength: captured.imageRequestProjection.requestLength,
    auditIdentity: {
      provider: captured.provider,
      attemptId: captured.attemptId,
      sessionId: captured.sessionId,
      promptHash: captured.actualHash,
      entryUuid: captured.entryUuid,
      sourceIdentity: captured.sourceIdentity,
      auditTimestamp: captured.auditTimestamp,
    },
  };
  const { backfillConfirmedCanonicalAuthoringPresentations, decorateHistoryPromptPresentations } =
    require(path.join(repo, 'src/main/history-prompt-presentations.js'));
  const store = memoryPresentationStore();
  const saved = backfillConfirmedCanonicalAuthoringPresentations(store, [record]);
  assert.equal(saved, 1, 'captured receipt must create one durable authoring projection');
  const projected = decorateHistoryPromptPresentations(store, {
    toolType: 'codex', sessionId: entry.sessionId, entries: [entry],
  })[0];
  assert.equal(projected.uuid, entry.uuid);
  assert.equal(projected.content, entry.content);
  assert.deepEqual(projected.imagePaths.map((ref) => ref.path), captured.expectedImageRefs.map((ref) => ref.path));
  assert.deepEqual(projected.imagePaths.map((ref) => ref.id), [1, 2]);
  assert.equal(projected.sourceIdentityAliases.includes(captured.sourceIdentity), true);
  return { entry: projected, record, originalEntry: entry, storeRows: store.rows };
}

try {
  const sourceHashes = {};
  for (const file of frozenFiles) sourceHashes[file] = await sha256(path.join(repo, file));
  result.sourceHashes = sourceHashes;
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify({ capturedAt: stamp(), sourceHashes }, null, 2));
  log('FREEZE current source hashes recorded', sourceHashes);
  const projected = await buildProjectedFixture();
  const imagesDir = path.join(artifact, 'private-images');
  await fs.mkdir(imagesDir, { recursive: true });
  const previewMap = {};
  const copied = [];
  for (const [index, ref] of projected.entry.imagePaths.entries()) {
    const source = ref.path;
    const stat = await fs.stat(source);
    assert.ok(stat.isFile() && stat.size > 0, `captured image ${index + 1} must be readable`);
    const target = path.join(imagesDir, `image-${index + 1}.jpg`);
    await fs.copyFile(source, target);
    const originalHash = await sha256(source);
    const copiedHash = await sha256(target);
    assert.equal(copiedHash, originalHash, `private image ${index + 1} copy must be byte exact`);
    previewMap[source] = { file: target, mediaType: 'image/jpeg', originalHash, copiedHash };
    copied.push({ id: index + 1, source, target, bytes: stat.size, originalHash, copiedHash });
  }
  result.evidence.projection = {
    receiptHandoffId: projected.record.handoffId,
    receiptEntryUuid: projected.record.entryUuid,
    displayedEntryUuid: projected.entry.uuid,
    canonicalPaths: projected.entry.imagePaths.map((ref) => ref.path),
    transportPaths: projected.entry.imagePaths.map((ref) => ref.transportPath),
    sidecarRows: projected.storeRows.length,
  };
  result.evidence.privateImageCopies = copied;
  await fs.writeFile(path.join(artifact, 'preview-map.json'), JSON.stringify(previewMap, null, 2));
  log('PROJECTOR captured receipt → canonical History entry', result.evidence.projection);
  log('FIXTURE private image copies verified', { copies: copied.map(({ id, bytes, originalHash }) => ({ id, bytes, originalHash })) });

  const assistantBefore = {
    uuid: 'history-native-images-fixture-before', role: 'assistant', sessionId: projected.entry.sessionId,
    timestamp: '2026-10-03T05:01:50.000Z', content: 'Fixture context before the captured user message.',
  };
  const assistantAfter = {
    uuid: 'history-native-images-fixture-after', role: 'assistant', sessionId: projected.entry.sessionId,
    timestamp: '2026-10-03T05:01:52.000Z', content: 'Fixture response after the captured user message.',
  };
  const fixtureData = {
    sessionId: projected.entry.sessionId,
    entry: projected.entry,
    entries: [assistantBefore, projected.entry, assistantAfter],
    previewMap,
    footerNeedle: 'Attached files from iOS are already uploaded to this Mac.',
    expectedImagePaths: projected.entry.imagePaths.map((ref) => ref.path),
  };
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  worktreeAdded = true;
  for (const name of ['src', 'packages/claude-blocks']) {
    await fs.cp(path.join(repo, name), path.join(snapshot, name), {
      recursive: true, force: true,
      filter: (entry) => !entry.includes('/node_modules') && !entry.includes('/.git'),
    });
  }
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(
    path.join(repo, 'scripts/fixtures/history-native-images.tsx'),
    path.join(snapshot, 'scripts/fixtures/history-native-images.tsx'),
  );
  await fs.writeFile(
    path.join(snapshot, 'scripts/fixtures/history-native-images.data.json'),
    JSON.stringify(fixtureData),
  );
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) {
    await fs.mkdir(shared, { recursive: true });
    await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name), {
      recursive: true, force: true, filter: (entry) => !entry.includes('/node_modules'),
    });
  }
  await build({
    entryPoints: [path.join(snapshot, 'scripts/fixtures/history-native-images.tsx')],
    bundle: true,
    outfile: path.join(artifact, 'bundle.js'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome120',
    logLevel: 'silent',
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
    '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  await fs.mkdir(path.join(artifact, 'user-data'), { recursive: true });
  const previewMapJson = JSON.stringify(previewMap);
  await fs.writeFile(path.join(artifact, 'preload.cjs'),
    "const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>invoke('fixture:invoke',{channel,args});");
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const fs=require('fs');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
const previewMap=${previewMapJson};
ipcMain.handle('fixture:invoke',(_e,{channel,args})=>{
 if(channel==='prompt-queue:get-image-preview-data-url'){
  const payload=args?.[0]||{}; const ref=previewMap[String(payload.path||'')];
  if(!ref)return{success:false,error:'fixture_path_not_admitted'};
  const data=fs.readFileSync(ref.file).toString('base64'); return{success:true,dataUrl:'data:'+ref.mediaType+';base64,'+data};
 }
 if(channel==='agent:list-background-work')return{success:true,records:[]};
 if(channel==='terminal:getCommandStates')return{};
 if(channel==='terminal:hasRunningProcess')return{isRunning:false};
 if(channel==='terminal:getCommandState')return null;
 if(channel.includes('getState')||channel.includes('get-state'))return null;
 return{success:true};
});
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:980,height:900,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact, 'preload.cjs'))}}});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  result.actions.push('projected captured record, private image copies, fixture bundle and disposable Electron target created');
  log('SETUP private target ready', { artifact, snapshot });

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
  page.on('pageerror', (error) => { errors.push(error.stack || error.message); log('UI pageerror', { error: error.message }); });
  page.on('console', (message) => {
    const line = message.text();
    if (message.type() === 'error') errors.push(line);
    log(`UI console ${message.type()}`, { line: line.slice(0, 500) });
  });
  await page.waitForFunction(() => window.require('process').env.NOTED_E2E_TEST === 'true');
  await page.screenshot({ path: path.join(artifact, 'window-boot.png'), fullPage: true });
  result.actions.push('full-surface boot screenshot captured before fixture DOM analysis');
  log('BASELINE full-window boot screenshot captured before DOM analysis');

  await page.waitForSelector('[data-history-native-images-fixture]');
  await page.waitForFunction(() => document.querySelector('[data-history-native-images-fixture] [data-history-viewport-ready="1"]'));
  const host = page.locator('[data-history-native-images-fixture]');
  await page.waitForFunction(() => document.querySelector('[data-history-native-images-fixture] [data-history-row-real]'));
  const scroller = host.locator('[data-virtuoso-scroller]');
  const box = await scroller.boundingBox();
  assert.ok(box, 'History scroller must be visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 5000);
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(artifact, 'initial-history.png'), fullPage: true });
  log('BASELINE captured History viewport after trusted tail scroll');

  const initial = await page.evaluate(() => {
    const root = document.querySelector('[data-history-native-images-fixture]');
    const row = root?.querySelector('[data-history-image-row]');
    const tokens = [...(root?.querySelectorAll('[data-history-image-row] [data-history-composer-token="image"]') || [])];
    const rect = (node) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
    return {
      imageRows: root?.querySelectorAll('[data-history-image-row]').length || 0,
      tokenCount: tokens.length,
      labels: tokens.map((node) => node.textContent?.trim()),
      rowRect: rect(row),
      tokenRects: tokens.map(rect),
      flowText: root?.querySelector('[data-history-user-composer-flow]')?.textContent || '',
      visibleRows: [...(root?.querySelectorAll('[data-history-row-real]') || [])].map((node) => node.getAttribute('data-uuid')),
    };
  });
  result.evidence.initial = initial;
  log('VERIFY initial image grouping', { imageRows: initial.imageRows, tokenCount: initial.tokenCount, labels: initial.labels, rowRect: initial.rowRect });
  assert.equal(initial.imageRows, 1, JSON.stringify(initial));
  assert.equal(initial.tokenCount, 2, JSON.stringify(initial));
  assert.deepEqual(initial.labels, ['image #1', 'image #2']);
  assert.ok(initial.rowRect && initial.tokenRects.every((rect) => rect && Math.abs(rect.y - initial.rowRect.y) <= 2));
  assert.ok(initial.tokenRects[0].x < initial.tokenRects[1].x, JSON.stringify(initial.tokenRects));
  assert.ok(initial.flowText.includes('image #1') && initial.flowText.includes('image #2'));
  result.actions.push('trusted tail scroll verified one horizontal image row with ordered #1/#2 labels');

  const expandButton = host.getByRole('button', { name: /Раскрыть полностью/ }).first();
  if (await expandButton.count()) {
    await expandButton.click();
    await page.waitForTimeout(180);
  }
  const expandedText = await page.locator('[data-history-user-composer-flow]').textContent();
  result.evidence.messageText = {
    hasFooter: expandedText.includes(fixtureData.footerNeedle),
    hasAssistantAfter: (await host.locator('[data-history-row-real]').allTextContents()).some((text) => text.includes('Fixture response after')),
    textLength: expandedText.length,
  };
  log('VERIFY normal prompt/footer retained', result.evidence.messageText);
  assert.equal(result.evidence.messageText.hasFooter, true);

  const imageTokens = host.locator('[data-history-image-row] [data-history-composer-token="image"]');
  const previewState = async () => page.evaluate(() => {
    const previews = [...document.querySelectorAll('[data-ai-composer-image-attachment-preview]')];
    const imgs = [...document.querySelectorAll('[data-ai-composer-image-preview] img')];
    const digest = (value) => value ? `${value.slice(0, 30)}…${value.slice(-18)}` : '';
    const signature = (value) => {
      let hash = 2166136261;
      const step = Math.max(1, Math.floor(value.length / 2048));
      for (let index = 0; index < value.length; index += step) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };
    return {
      cards: previews.length,
      states: [...document.querySelectorAll('[data-ai-composer-image-preview]')].map((node) => node.getAttribute('data-preview-state')),
      srcs: imgs.map((img) => digest(img.getAttribute('src') || '')),
      srcLengths: imgs.map((img) => (img.getAttribute('src') || '').length),
      srcSignatures: imgs.map((img) => signature(img.getAttribute('src') || '')),
      errors: [...document.querySelectorAll('[data-ai-composer-image-preview]')].map((node) => node.textContent || '').filter(Boolean),
    };
  });
  const openByTrustedClick = async (index) => {
    await imageTokens.nth(index).click();
    await page.waitForFunction(() => document.querySelector('[data-history-chip-popover-backdrop]'));
    await page.waitForFunction(() => document.querySelector('[data-ai-composer-image-preview][data-preview-state="ready"] img'));
    return previewState();
  };
  const closeByBackdrop = async () => {
    const point = await page.evaluate(() => {
      const popup = [...document.querySelectorAll('body > div')].find((node) => {
        const style = window.getComputedStyle(node);
        return style.position === 'fixed' && Number(style.zIndex) >= 10070 && style.visibility !== 'hidden';
      });
      const popupRect = popup?.getBoundingClientRect();
      const candidates = [
        { x: window.innerWidth - 6, y: window.innerHeight - 6 },
        { x: 6, y: window.innerHeight - 6 },
        { x: window.innerWidth - 6, y: 6 },
      ];
      return candidates.find((candidate) => !popupRect || !(
        candidate.x >= popupRect.left && candidate.x <= popupRect.right
        && candidate.y >= popupRect.top && candidate.y <= popupRect.bottom
      )) || { x: window.innerWidth - 6, y: window.innerHeight - 6 };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !document.querySelector('[data-history-chip-popover-backdrop]'));
  };

  const firstPreview = await openByTrustedClick(0);
  result.evidence.firstPreview = firstPreview;
  log('TRIGGER trusted click image #1', { cards: firstPreview.cards, states: firstPreview.states, dataUrlLength: firstPreview.srcs[0]?.length || 0 });
  assert.equal(firstPreview.cards, 1);
  assert.equal(firstPreview.states[0], 'ready');
  assert.ok(firstPreview.srcs[0].startsWith('data:image/jpeg;base64,'));
  assert.ok(firstPreview.srcLengths[0] > 1000);
  await closeByBackdrop();
  result.actions.push('image #1 opened with nonempty data preview and closed by trusted outside click');

  await imageTokens.nth(1).dblclick();
  await page.waitForTimeout(180);
  const afterDouble = await previewState();
  result.evidence.doubleClick = afterDouble;
  log('VERIFY trusted double click toggles preview closed', afterDouble);
  assert.equal(afterDouble.cards, 0);

  const secondPreview = await openByTrustedClick(1);
  result.evidence.secondPreview = secondPreview;
  log('TRIGGER trusted click image #2', { cards: secondPreview.cards, states: secondPreview.states, dataUrlLength: secondPreview.srcs[0]?.length || 0 });
  assert.equal(secondPreview.cards, 1);
  assert.equal(secondPreview.states[0], 'ready');
  assert.ok(secondPreview.srcs[0].startsWith('data:image/jpeg;base64,'));
  assert.ok(secondPreview.srcLengths[0] > 1000);
  assert.notEqual(secondPreview.srcSignatures[0], firstPreview.srcSignatures[0], 'image #2 must differ from image #1');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-history-chip-popover-backdrop]'));
  result.actions.push('image #2 produced a distinct ready preview and closed with trusted Escape');
  const finalState = await previewState();
  result.evidence.final = finalState;
  assert.equal(finalState.cards, 0);
  assert.deepEqual(errors, [], `renderer errors: ${errors.join('; ')}`);
  await page.screenshot({ path: path.join(artifact, 'final-history.png'), fullPage: true });
  log('PASS renderer image History scenario', { errors: errors.length });
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.errors.push(error?.stack || String(error));
  log('FAIL renderer image History scenario', { error: error?.message || String(error) });
} finally {
  if (app) {
    try { await app.close(); log('CLEANUP private Electron closed'); } catch (error) { result.errors.push(`app close: ${error?.message || error}`); }
  }
  if (worktreeAdded) {
    try { execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' }); log('CLEANUP private worktree removed'); }
    catch (error) { result.errors.push(`worktree cleanup: ${error?.message || error}`); }
  }
  await fs.writeFile(path.join(artifact, 'test-run.log'), `${eventLog.join('\n')}\n`);
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}
