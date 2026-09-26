import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { createPackageWithOptions } = require('@electron/asar');
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-asar-'));
const stage = path.join(artifact, 'stage');
for (const name of ['main', 'shared']) await fs.cp(path.join(repo, 'src', name), path.join(stage, 'src', name), { recursive: true });
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
await fs.mkdir(path.join(artifact, 'data')); await fs.mkdir(path.join(artifact, 'sessions'));
await fs.mkdir(path.join(artifact, 'node_modules'));
await fs.symlink(path.join(repo, 'node_modules/better-sqlite3'), path.join(artifact, 'node_modules/better-sqlite3'));
await fs.writeFile(path.join(artifact, 'sessions/rollout-packaged.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: '2026-09-25T00:00:00Z', payload: { type: 'user_message', message: 'PACKAGED HISTORY' } }) + '\n');
await fs.writeFile(path.join(stage, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'data'))});app.setActivationPolicy?.('accessory');
const {HistoryReadClient}=require('./src/main/history-read-client');
global.reader=new HistoryReadClient({cacheDirectory:${JSON.stringify(path.join(artifact, 'cache'))},sessionsDir:${JSON.stringify(path.join(artifact, 'sessions'))}});
ipcMain.handle('fixture:history',(_event,request)=>global.reader.call('getHistory',request,request.readTransport==='v8-1'));
ipcMain.handle('fixture:release',()=>global.reader.call('releaseMemory'));
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false}});w.loadURL('data:text/html,Packaged worker fixture')});
app.on('window-all-closed',()=>{global.reader.close().finally(()=>app.quit())});`);
await createPackageWithOptions(stage, path.join(artifact, 'app.asar'), {});
let app; const result = { artifact };
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'app.asar')], cwd: artifact, env });
  app.process().on('exit', (code, signal) => { result.exit = { code, signal }; });
  app.process().stdout.on('data', data => fs.appendFile(path.join(artifact, 'main.log'), data));
  app.process().stderr.on('data', data => fs.appendFile(path.join(artifact, 'main.log'), data));
  // The first harness's early inspector evaluate crashed E28 (SIGSEGV).
  // Exercise the actual renderer -> main IPC path after the window is ready.
  const page = await app.firstWindow();
  const output = await page.evaluate(async () => require('electron').ipcRenderer.invoke('fixture:history', { toolType: 'codex', sessionId: 'packaged', cwd: '/fixture', dehydrate: true }));
  assert.equal(output.success, true, JSON.stringify(output));
  assert.equal(output.entries[0].content, 'PACKAGED HISTORY');
  await page.evaluate(async () => require('electron').ipcRenderer.invoke('fixture:release'));
  const second = await page.evaluate(async () => {
    const encoded = await require('electron').ipcRenderer.invoke('fixture:history', { toolType: 'codex', sessionId: 'packaged', cwd: '/fixture', dehydrate: true, readTransport: 'v8-1' });
    if (encoded.__notedHistoryTransport !== 'v8-1') throw new Error('missing encoded response');
    return require('node:v8').deserialize(Buffer.from(encoded.data));
  });
  assert.deepEqual(second.entries, output.entries);
  result.status = 'PASS';
} catch (error) { result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1; }
finally { await app?.close(); await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
