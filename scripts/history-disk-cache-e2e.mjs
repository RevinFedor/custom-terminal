#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const objectControl = process.env.NOTED_HISTORY_E2E_OBJECT === '1';
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-disk-e2e-'));
const snapshot = path.join(artifact, 'source');
execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
// Snapshot dirty implementation exactly once. No HMR observes the shared tree.
for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name), {
  recursive: true, force: true, filter: source => !source.includes('/node_modules') && !source.includes('/.git'),
});
await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
await fs.copyFile(path.join(repo, 'scripts/fixtures/history-disk-cache.tsx'), path.join(snapshot, 'scripts/fixtures/history-disk-cache.tsx'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
const shared = path.join(artifact, 'noted-shared/packages');
for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), { recursive: true, filter: source => !source.includes('/node_modules') });
const manifest = {};
for (const name of ['history-prepared-cache.js', 'history-read-worker.js', 'history-read-client.js', 'session-transcript-service.js', 'ipc/codex-data.js',
  '../renderer/components/Workspace/HistoryPanel.tsx', '../renderer/utils/historyRewriteSnapshot.ts']) {
  manifest[name] = createHash('sha256').update(await fs.readFile(path.join(snapshot, 'src/main', name))).digest('hex');
}
await fs.writeFile(path.join(artifact, 'manifest.json'), JSON.stringify(manifest, null, 2));
const sources = path.join(artifact, 'rollouts'); await fs.mkdir(sources);
const sessions = ['history-e2e-a', 'history-e2e-b', 'history-e2e-cold', 'history-e2e-virtual'];
function records(sessionId, turns, heavy = false) {
  const out = [{ type: 'session_meta', timestamp: '2026-09-25T00:00:00Z', payload: { id: sessionId, cwd: sources } }];
  for (let i = 0; i < turns; i++) {
    const timestamp = new Date(Date.UTC(2026, 8, 25) + i * 2000).toISOString();
    out.push({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'PROMPT-' + String(i).padStart(4, '0') + ' ' + sessionId } });
    out.push({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'ANSWER-' + String(i).padStart(4, '0') + '\n\n' + (heavy ? 'long synthetic history '.repeat(190) : 'Readable history. '.repeat(25)) }] } });
  }
  return out.map(row => JSON.stringify(row) + '\n').join('');
}
await fs.writeFile(path.join(sources, 'rollout-' + sessions[0] + '.jsonl'), records(sessions[0], 1400));
await fs.writeFile(path.join(sources, 'rollout-' + sessions[1] + '.jsonl'), records(sessions[1], 80));
await fs.writeFile(path.join(sources, 'rollout-' + sessions[2] + '.jsonl'), records(sessions[2], 12000, true));
await fs.writeFile(path.join(sources, 'rollout-' + sessions[3] + '.jsonl'), records(sessions[3], 0));
await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-disk-cache.tsx')], bundle: true,
  outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
  alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
    '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
    react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' },
});
execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>button[data-fixture-tab],nav>button{border:1px solid #777;padding:3px 10px}html,body,#root{height:100%;width:100%;margin:0}</style><div id="root"></div><script type="module" src="bundle.js"></script>`);
await fs.writeFile(path.join(artifact, 'preload.cjs'), `const{ipcRenderer}=require('electron');const invoke=ipcRenderer.invoke.bind(ipcRenderer);
 const real=new Set(['fixture:config','fixture:release','fixture:append','fixture:stream','fixture:replace','fixture:cold','fixture:cold-finished','agent-transcript:get-history','agent-transcript:get-timeline','agent-transcript:subscribe','agent-transcript:unsubscribe','agent-transcript:refresh','history:get-tool-payload','history-preparation:subscribe','history-preparation:unsubscribe']);
 const objectControl=${JSON.stringify(objectControl)};
 ipcRenderer.invoke=(channel,payload,...args)=>{if(objectControl&&payload?.readTransport)payload={...payload,readTransport:undefined};return real.has(channel)?invoke(channel,payload,...args):invoke('fixture:aux',{channel,payload})};`);
const sourceMain = path.join(snapshot, 'src/main');
await fs.mkdir(path.join(artifact, 'user-data'), { recursive: true });
await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');
const source=${JSON.stringify(sourceMain)};const cwd=${JSON.stringify(sources)};const sessions=${JSON.stringify(sessions)};
const DatabaseManager=require(path.join(source,'database'));const codexData=require(path.join(source,'ipc/codex-data'));
const{HistoryReadClient}=require(path.join(source,'history-read-client'));const{createSessionTranscriptService}=require(path.join(source,'session-transcript-service'));
const{installHistoryPreparationIpc,historyPreparationActivity}=require(path.join(source,'history-preparation-activity'));let window;
const db=new DatabaseManager(); const originalFind=codexData._api.findCodexSessionFile;
const digest=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
const parentBytes=fs.readFileSync(path.join(cwd,'rollout-'+sessions[0]+'.jsonl'));
const childBytes=fs.readFileSync(path.join(cwd,'rollout-'+sessions[3]+'.jsonl'));
const lineage=require(path.join(source,'session-history-events')).buildCodexForkLineageManifest({
 sourceSessionId:sessions[0],childSessionId:sessions[3],sourceSegments:[{physicalSessionId:sessions[0],fromByte:0,toByte:parentBytes.length,startLine:0,endLine:2801,prefixDigest:digest(parentBytes)}],
 childTailStart:{byteOffset:childBytes.length,line:1,prefixDigest:digest(childBytes)}});
db.saveSessionForkEvent({provider:'codex',sourceSessionId:sessions[0],childSessionId:sessions[3],entryUuids:[],lineageManifest:lineage,snapshotComplete:true,isDirect:true,origin:'app'});
codexData._api.findCodexSessionFile=(id,dir)=>originalFind(id,dir,{sessionsDir:cwd});
global.reader=new HistoryReadClient({codexData,databasePath:db.db.name,cacheDirectory:${JSON.stringify(path.join(artifact, 'cache'))},sessionsDir:cwd,memoryBudgetMb:64,
onWindowEvent:(channel,payload)=>window?.webContents.send(channel,payload)});
const service=createSessionTranscriptService({codexData,sessionHistoryStore:db,promptPresentationStore:db,getMainWindow:()=>window,historyReader:global.reader});
service.registerIpc();installHistoryPreparationIpc({ipcMain});
global.calls=[];global.maxGap=0;let last=performance.now();const heartbeat=setInterval(()=>{const now=performance.now();global.maxGap=Math.max(global.maxGap,now-last);last=now},10);
ipcMain.handle('fixture:config',()=>({cwd,sessions}));
ipcMain.handle('fixture:release',()=>global.reader.call('releaseMemory'));
const fixtureLines=[2801,161,24001,1];
async function appendFixtureRecord(index,row){const file=path.join(cwd,'rollout-'+sessions[index]+'.jsonl');const before=(await fs.promises.stat(file)).size;
 const data=JSON.stringify(row)+'\\n';const line=fixtureLines[index]++;await fs.promises.appendFile(file,data);
 return{...row,__line:line,__byteOffset:before,__byteEndOffset:before+Buffer.byteLength(data)};}
ipcMain.handle('fixture:append',async(_e,index)=>{const text='APPENDED-RECORD';const row={type:'response_item',timestamp:'2026-09-25T13:00:00Z',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}};
 await appendFixtureRecord(index,row);return{success:true};});
let fixturePreview=null;
ipcMain.handle('fixture:stream',async(_e,{index=0,action,text,sequence=1})=>{
 const envelope={tabId:'fixture-'+index,sessionId:sessions[index],toolType:'codex'};
 let sourceSize=0;
 if(action==='update'){
  sourceSize=(await appendFixtureRecord(index,{type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'token_count',info:{}}})).__byteEndOffset;
  fixturePreview={...envelope,previewId:'stream-retention-'+index,phase:'streaming',text,previewSeq:sequence,
   startedAt:fixturePreview?.startedAt||Date.now(),updatedAt:Date.now(),lifecycleGeneration:'fixture-live',mirrorGeneration:'fixture-mirror',
   mirrorGenerationOrdinal:1,committedFrameGeneration:sequence,writeSeq:sequence,textHash:null,sourceMode:'semantic'};
  window.webContents.send('agent-transcript:terminal-preview',{...envelope,action:'update',preview:fixturePreview});
 }else{
  const record=await appendFixtureRecord(index,{type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:fixturePreview.text}]}});
  const canonical=codexData._api.buildCodexFullHistory([record],sessions[index])[0];
  window.webContents.send('agent-transcript:live-message',{...envelope,recordByteOffset:record.__byteOffset,timestamp:record.timestamp,
    message:{type:'assistant',uuid:canonical.uuid,sourceIdentity:canonical.sourceIdentity,message:{role:'assistant',content:[{type:'text',text:fixturePreview.text}]}}});
  window.webContents.send('agent-transcript:terminal-preview',{...envelope,action:'clear',previewId:fixturePreview.previewId,
    reason:'canonical-materialized',canonicalIdentity:canonical.sourceIdentity});
 }
 return{success:true,sourceSize};
});
ipcMain.handle('fixture:replace',async(_e,{index,atomic})=>{
 const file=path.join(cwd,'rollout-'+sessions[index]+'.jsonl');
 const text=atomic?'REPLACED-FILE':'REWRITTEN-END';
 const rows=[{type:'session_meta',payload:{id:sessions[index],cwd}},{type:'response_item',timestamp:'2026-09-25T00:00:00Z',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text}]}}];
 const data=rows.map(row=>JSON.stringify(row)+'\\n').join('');
 if(atomic){await fs.promises.writeFile(file+'.replacement',data);await fs.promises.rename(file+'.replacement',file)}else await fs.promises.writeFile(file,data);
 fixtureLines[index]=2;return{success:true};
});
ipcMain.handle('fixture:cold',()=>{global.coldPending=true;return true});
ipcMain.handle('fixture:cold-finished',()=>{global.coldPending=false;return true});
historyPreparationActivity.subscribe(snapshot=>{if(snapshot.operations.some(op=>op.sessionId===sessions[2]))window?.webContents.send('fixture:cold-started')});
ipcMain.handle('fixture:aux',(_e,{channel,payload})=>{if(!global.calls.includes(channel)){global.calls.push(channel);console.log('[FixtureAux]',channel)}
 if(channel==='agent-session:get-availability-batch')return{success:true,results:payload.sessions.map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel.includes('presence'))return{status:'inactive',isBusy:false,hasTerm:false,inputReady:false,sessionId:payload?.sessionId};
 if(channel==='app:getState'||channel==='app:get-state'||channel==='storage:get')return null;
 if(channel==='codex:get-runtime-projection'){const id=sessions[Number(String(payload?.tabId||'fixture-0').split('-').pop())]||sessions[0];
 return{success:true,projectId:'fixture-project',sessionStatus:'inactive',busy:false,inputReady:false,liveLifecycle:false,sessionId:id,readSessionId:id,readIdentitySource:'stopped-history',savedSessionId:id,conversationMaterialized:true,timelineCount:1400,materializationReason:'fixture',canCopySessionId:true,hasTerm:false,lastNotReady:null,startupFailed:false,startupError:null,manualActionRequired:false,manualActionType:null,lifecycleWarning:null,hasWatcher:false,catchUpPending:false,outcomeKnown:true,lastOutcomeReason:'completed'};}
 if(channel.includes('get-terminal-preview'))return{success:true,preview:null};
 if(channel.includes('get-models')||channel.includes('list-models'))return{success:true,models:[]};
 if(channel.includes('summary')||channel.includes('summaries'))return{success:true,summaries:[],auto:false};
 if(channel.includes('list')||channel.includes('get-'))return[];
 return{success:true};});
app.whenReady().then(()=>{app.dock?.hide();window=new BrowserWindow({show:false,focusable:false,width:1100,height:900,
webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact, 'preload.cjs'))}}});
window.webContents.on('paint',()=>{});window.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});
app.on('window-all-closed',()=>{clearInterval(heartbeat);global.reader.close().finally(()=>{db.close();app.quit()})});`);

const result = { artifact, objectControl, checks: [], errors: [], manifest };
let app;
try {
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: path.join(artifact, 'user-data') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const logs = []; page.on('pageerror', error => result.errors.push(error.message));
  page.on('console', message => logs.push(message.type() + ': ' + message.text()));
  app.process().stdout.on('data', data => fs.appendFile(path.join(artifact, 'main.log'), data));
  app.process().stderr.on('data', data => fs.appendFile(path.join(artifact, 'main.log'), data));
  await page.screenshot({ path: path.join(artifact, 'initial.png') });
  await page.locator('[data-history-row-real]').first().waitFor({ timeout: 60000 });
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.screenshot({ path: path.join(artifact, 'loaded.png') });
  const firstStats = await app.evaluate(() => global.reader.call('stats'));
  await page.locator('[data-release]').click();
  await page.locator('[data-notice]').filter({ hasText: 'memory released' }).waitFor();
  await page.locator('[data-history-row-real]').first().waitFor();
  const reopened = await app.evaluate(() => global.reader.call('stats'));
  assert.equal(reopened.sourceBytes, firstStats.sourceBytes);
  assert.equal(reopened.projector.sessions, 0);
  result.checks.push('real History remount after RAM eviction uses disk pages');
  const point = page.locator('[data-timeline-entry-uuid]').first();
  await point.waitFor();
  const uuid = await point.getAttribute('data-timeline-entry-uuid');
  await point.click();
  await page.locator('[data-history-row-real][data-uuid="' + uuid + '"]').waitFor();
  const sought = await app.evaluate(() => global.reader.call('stats'));
  assert.equal(sought.sourceBytes, reopened.sourceBytes);
  assert.equal(sought.projector.sessions, 0);
  result.checks.push('trusted Timeline click displays the exact old row without whole parser');
  await page.screenshot({ path: path.join(artifact, 'timeline-seek.png') });
  const scroller = page.locator('[data-virtuoso-scroller]').first();
  await scroller.hover(); await page.mouse.wheel(0, 240);
  await page.locator('[data-fixture-tab="1"]').click();
  await page.locator('[data-history-row-real]').first().waitFor();
  await page.locator('[data-fixture-tab="0"]').click();
  await page.locator('[data-history-row-real]').first().waitFor();
  result.checks.push('trusted wheel and tab return keep real rows');
  await page.locator('[data-timeline-entry-uuid]').last().click();
  await page.locator('[data-history-row-real]').filter({ hasText: 'PROMPT-1399' }).waitFor();
  await scroller.hover(); await page.mouse.wheel(0, 700);
  const composer = page.locator('[data-history-composer-tab-id="fixture-0"] [contenteditable="true"]').first();
  const baselineInputAt = performance.now(); await composer.fill('BASELINE-INPUT');
  result.baselineInputMs = performance.now() - baselineInputAt;
  await app.evaluate(() => { global.maxGap = 0; });
  await page.evaluate(() => { window.coldStarted = new Promise(resolve => require('electron').ipcRenderer.once('fixture:cold-started', () => resolve(Date.now()))); });
  await page.locator('[data-cold]').click();
  result.coldStartedAt = await page.evaluate(() => window.coldStarted);
  assert.equal(await app.evaluate(() => global.coldPending), true);
  const coldInputAt = performance.now();
  await composer.fill('INPUT-WHILE-COLD');
  result.coldInputMs = performance.now() - coldInputAt;
  assert.equal(await app.evaluate(() => global.coldPending), true, 'input must finish before actual cold work finishes');
  assert.ok(result.coldInputMs < Math.max(300, result.baselineInputMs * 3 + 50));
  assert.match(await composer.innerText(), /INPUT-WHILE-COLD/);
  result.checks.push('real History composer accepts trusted input during cold worker preparation');
  await page.evaluate(() => window.fixture.coldFinished);
  // Include final reply delivery, but exclude our screenshot/readback from
  // the application's event-loop latency measurement.
  await page.waitForTimeout(20);
  result.mainLoopDuringColdMs = await app.evaluate(() => global.maxGap);
  await page.screenshot({ path: path.join(artifact, 'input-during-cold.png') });
  result.beforeAppend = await page.evaluate(() => {
    const s = document.querySelector('[data-virtuoso-scroller]');
    return { scrollTop: s?.scrollTop, scrollHeight: s?.scrollHeight, clientHeight: s?.clientHeight,
      ready: document.querySelector('[data-history-viewport-ready]')?.getAttribute('data-history-viewport-ready') };
  });
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.evaluate(() => {
    window.retentionFailures = [];
    window.retentionObserver = new MutationObserver(() => {
      const rows = document.querySelectorAll('[data-history-row-real]').length;
      const ready = document.querySelector('[data-history-viewport-ready]')?.getAttribute('data-history-viewport-ready');
      if (!rows || ready !== '1' || document.querySelector('[data-history-viewport-loader]')) {
        if (window.retentionFailures.length < 12) window.retentionFailures.push({ rows, ready });
      }
    });
    window.retentionObserver.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true });
  });
  await page.locator('[data-append]').click();
  await page.getByText('APPENDED-RECORD', { exact: true }).waitFor({ timeout: 60000 });
  const retentionFailures = await page.evaluate(() => { window.retentionObserver.disconnect(); return window.retentionFailures; });
  assert.deepEqual(retentionFailures, [], 'ordinary append must retain painted History throughout the refresh');
  result.checks.push('source append is delivered through actual watcher/IPC into History');
  await page.evaluate(() => {
    window.retentionFailures = [];
    window.retentionObserver.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true });
    window.fixture.setBusy(0, true);
  });
  for (let sequence = 1; sequence <= 3; sequence++) {
    await page.evaluate(async sequence => {
      const { ipcRenderer } = window.require('electron');
      let requiredSize = Infinity, observedSize = 0, done;
      const changed = new Promise(resolve => { done = resolve; });
      const listener = (_event, detail) => {
        if (detail.sessionId !== window.fixture.config.sessions[0]) return;
        observedSize = Math.max(observedSize, detail.size || 0);
        if (observedSize >= requiredSize) done();
      };
      ipcRenderer.on('agent-transcript:changed', listener);
      let timer;
      try {
        const result = await ipcRenderer.invoke('fixture:stream', { action: 'update', sequence, text: 'LIVE-ANSWER-' + sequence + ' saved exactly once' });
        requiredSize = result.sourceSize;
        if (observedSize >= requiredSize) done();
        await Promise.race([changed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('source watcher did not deliver streaming append')), 10000); })]);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      } finally { clearTimeout(timer); ipcRenderer.removeListener('agent-transcript:changed', listener); }
    }, sequence);
    await page.locator('[data-history-terminal-preview]').filter({ hasText: 'LIVE-ANSWER-' + sequence }).waitFor();
  }
  await page.evaluate(async () => {
    await window.require('electron').ipcRenderer.invoke('fixture:stream', { action: 'canonical' });
    window.fixture.setBusy(0, false);
  });
  await page.locator('[data-history-terminal-preview]').waitFor({ state: 'detached' });
  const liveAnswer = page.getByText('LIVE-ANSWER-3 saved exactly once', { exact: true });
  await liveAnswer.waitFor();
  assert.equal(await liveAnswer.count(), 1, 'canonical adoption must leave exactly one answer');
  assert.deepEqual(await page.evaluate(() => { window.retentionObserver.disconnect(); return window.retentionFailures; }), [],
    'streaming updates and canonical adoption must never hide loaded History');
  result.checks.push('three busy streaming updates keep History painted; canonical adoption leaves one answer and no preview');
  await page.locator('[data-fixture-tab="3"]').click();
  await page.locator('[data-history-row-real]').first().waitFor();
  await page.locator('[data-history-viewport-ready="1"]').waitFor();
  await page.locator('[data-release]').click();
  await page.locator('[data-history-row-real]').first().waitFor();
  const virtualPoint = page.locator('[data-timeline-entry-uuid]').first();
  await virtualPoint.waitFor();
  const ancestorUuid = await virtualPoint.getAttribute('data-timeline-entry-uuid');
  await virtualPoint.click();
  await page.locator('[data-history-row-real][data-uuid="' + ancestorUuid + '"]').waitFor();
  const virtualStats = await app.evaluate(() => global.reader.call('stats'));
  assert.equal(virtualStats.virtual.views, 0, 'virtual seek after release must not rebuild ancestor parser');
  assert.equal(virtualStats.projector.sessions, 0);
  result.checks.push('virtual fork remount and trusted Timeline seek use SSD pages after all graphs are released');
  await page.screenshot({ path: path.join(artifact, 'virtual-seek.png') });
  await page.locator('[data-timeline-entry-uuid]').last().click();
  await page.locator('[data-history-row-real]').filter({ hasText: 'PROMPT-1399' }).waitFor();
  await scroller.hover(); await page.mouse.wheel(0, 1800);
  await page.locator('[data-append]').click();
  await page.getByText('APPENDED-RECORD', { exact: true }).waitFor({ timeout: 60000 });
  const virtualAppended = await app.evaluate(() => global.reader.call('stats'));
  assert.ok(virtualAppended.virtual.continuationRestores > 0);
  assert.ok(virtualAppended.virtual.sourceBytes - virtualStats.virtual.sourceBytes < 4096,
    'child append must not replay the frozen ancestor');
  result.checks.push('virtual child append after RAM eviction restores continuation and reaches the real History through watcher/IPC');
  await page.locator('[data-fixture-tab="0"]').click();
  await page.locator('[data-history-row-real]').first().waitFor();
  for (const atomic of [true, false]) {
    await page.evaluate(atomic => window.require('electron').ipcRenderer.invoke('fixture:replace', { index: 0, atomic }), atomic);
    await page.getByText(atomic ? 'REPLACED-FILE' : 'REWRITTEN-END', { exact: true }).waitFor();
  }
  result.checks.push('real inode replacement and same-inode rewrite still replace the old document');
  result.stats = await app.evaluate(() => global.reader.call('stats'));
  result.mainLoopMaxMs = await app.evaluate(() => global.maxGap);
  result.auxiliaryChannels = await app.evaluate(() => global.calls);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false);
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  assert.deepEqual(result.errors, []);
  result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  if (app) { await app.firstWindow().then(page => page.screenshot({ path: path.join(artifact, 'failure.png') })).catch(() => {});
    result.auxiliaryChannels = await app.evaluate(() => global.calls).catch(() => []); }
} finally {
  await app?.close();
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
