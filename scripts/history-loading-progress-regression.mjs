// Isolated actual loader + store + main IPC. Controlled source work; no app,
// user transcript, production cursor or AI process is involved.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-loading-progress-'));
await fs.copyFile(path.join(root, 'src/main/history-preparation-activity.js'), path.join(dir, 'activity.cjs'));
const component = path.join(root, 'src/renderer/components/Workspace/HistoryLoadingStatus.tsx');
await build({ stdin: { contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
 import Status from ${JSON.stringify(component)};
 window.parentRenders=0;
 function App(){window.parentRenders++;const[owner,setOwner]=useState('A');
 return <><nav>{['A','B','wrong-cwd'].map(id=><button key={id} onClick={()=>setOwner(id)}>{id}</button>)}</nav>
 <main><Status toolType="codex" sessionId={owner==='B'?'B':'A'} cwd={owner==='wrong-cwd'?'/wrong':'/fixture'}><span aria-hidden="true">◌</span></Status></main></>}
 const app=createRoot(document.getElementById('root'));app.render(<App/>);window.unmount=()=>app.unmount();`,
  loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(dir, 'bundle.js'), logLevel: 'silent' });
await fs.writeFile(path.join(dir, 'index.html'), `<meta charset="utf-8"><style>
 body{margin:0;background:#151515;color:#818cf8;font:13px system-ui}nav{height:40px}button{background:#222;color:#ccc;border:1px solid #444;padding:8px}main{height:300px;display:flex;align-items:center;justify-content:center}
 </style><div id="root"></div><script src="bundle.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');
 app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');
 const{createHistoryPreparationActivity,installHistoryPreparationIpc}=require('./activity.cjs');
 global.activity=createHistoryPreparationActivity({minBytes:1,progressIntervalMs:0});global.leases=new Map();
 installHistoryPreparationIpc({ipcMain,activity:global.activity});
 app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({width:520,height:360,show:false,focusable:false,
 webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
let app;
const result = { artifact: dir, checks: [], errors: [] };
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow(); page.on('pageerror', e => result.errors.push(e.message));
  const label = page.locator('[data-history-loading-status]');
  await label.getByText('Loading...', { exact: true }).waitFor();
  await app.evaluate(() => {
    for (const id of ['A', 'B']) global.leases.set(id, global.activity.begin({
      sessionId: id, bytes: 100 * 1048576, source: { toolType: 'codex', cwd: '/fixture' },
    }));
    global.leases.get('A').update({ completedBytes: 25 * 1048576 });
    global.leases.get('B').update({ completedBytes: 75 * 1048576 });
  });
  await page.getByRole('progressbar').waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), '25');
  assert.match(await label.textContent(), /25 \/ 100 МБ/);
  result.checks.push('exact A progress after short-loader grace');
  await page.screenshot({ path: path.join(dir, 'reading.png') });
  const renders = await page.evaluate(() => window.parentRenders);
  for (let percent = 26; percent <= 45; percent++) await app.evaluate((_e, percent) =>
    global.leases.get('A').update({ completedBytes: percent * 1048576 }), percent);
  await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '45');
  assert.equal(await page.evaluate(() => window.parentRenders), renders, 'progress does not render the History parent');
  result.checks.push('20 source updates leave parent unchanged');
  await page.getByRole('button', { name: 'B', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') === '75');
  result.checks.push('tab switch takes only B progress');
  await page.getByRole('button', { name: 'wrong-cwd', exact: true }).click();
  assert.equal(await page.getByRole('progressbar').count(), 0);
  assert.equal(await label.textContent(), '◌Loading...');
  result.checks.push('same session in another cwd never borrows A');
  await page.getByRole('button', { name: 'A', exact: true }).click();
  await app.evaluate(() => global.leases.get('A').update({ completedBytes: 100 * 1048576, phase: 'preparing' }));
  await label.getByText('Подготовка отображения…', { exact: true }).waitFor();
  assert.equal(await page.getByRole('progressbar').count(), 0, '100% bytes is not total completion');
  await page.screenshot({ path: path.join(dir, 'preparing.png') });
  await app.evaluate(() => global.leases.get('A')());
  assert.match(await label.textContent(), /Подготовка отображения/);
  result.checks.push('metadata and IPC-to-paint gap do not claim completion');
  await page.evaluate(() => window.unmount());
  await app.evaluate(() => { global.leases.get('B')(); global.leases.get('A').update({ completedBytes: 100 }); });
  assert.deepEqual(result.errors, []);
  result.checks.push('unmount and stale completion clean');
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await app?.close(); }
