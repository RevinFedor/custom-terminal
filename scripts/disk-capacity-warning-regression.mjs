#!/usr/bin/env node
// Actual titlebar + disk service/IPC/store, controlled capacity readings in a
// private offscreen Electron. No production state/PTY/provider/network/Git.
// --paired-build runs one full main+renderer build in the frozen TMPDIR source.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const repo = fileURLToPath(new URL('..', import.meta.url));
const arg = key => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const source = arg('source') || repo;
const pairedBuild = process.argv.includes('--paired-build');
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-disk-capacity-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'noted-shared');
const result = { artifact, pairedBuild, checks: [], errors: [], cleanup: {},
  boundary: 'Actual WorkspaceTitleBarTools, ResourceUsageButton, McpHubButton, disk service/IPC/store/component/CSS; synthetic capacity readings and neighbors IPC; trusted CDP clicks/keys. No real state, lifecycle, provider, install.' };
let app;
function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { createDiskCapacityService, installDiskCapacityIpc } = require(config.service);
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  const state = global.diskFixture = { free: 5, used: 14, fail: false, stale: false, reads: 0, calls: [], violations: [], logs: [] };
  const service = createDiskCapacityService({ cacheDirectory: config.cache,
    log: { log: line => state.logs.push(line), warn: line => state.logs.push(line) },
    readUsage: async () => { state.reads++; if (state.fail) throw Object.assign(Error('synthetic denied'), { code: 'EACCES' }); return Math.round(state.used * 1024 ** 3); },
    readFree: async () => Math.round(state.free * 1024 ** 3), now: () => Date.now() - (state.stale ? 61000 : 0) });
  const cleanup = installDiskCapacityIpc({ ipcMain, service });
  ipcMain.handle('fixture:capacity', async (_event, next) => { Object.assign(state, next); return service.sample(); });
  ipcMain.handle('fixture:state', () => ({ ...state, snapshot: service.snapshot() }));
  app.once('will-quit', cleanup);
  app.whenReady().then(() => {
    app.dock?.hide();
    const win = new BrowserWindow({ show: false, focusable: false, frame: false, width: 960, height: 520,
      webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    win.loadFile(config.html);
  });
  app.on('window-all-closed', () => app.quit());
}
function installShim() {
  const native = window.require('electron').ipcRenderer;
  const listeners = new Map();
  const f = window.diskFixture = { unknown: [], calls: [], events: [], violations: [] };
  f.capacity = next => native.invoke('fixture:capacity', next);
  f.state = () => native.invoke('fixture:state');
  document.addEventListener('click', event => f.events.push({ type: 'click', trusted: event.isTrusted,
    disk: !!event.target.closest?.('[data-disk-capacity]') }), true);
  document.addEventListener('keydown', event => f.events.push({ type: 'key', trusted: event.isTrusted, key: event.key }), true);
  const answer = (c, args) => {
    if (c.startsWith('system:disk-capacity')) return native.invoke(c, ...args);
    if (c === 'system:process-metrics-ambient-start') return { ok: true, totalBytes: 14.8 * 1024 ** 3, commandBytes: 401 * 1024 ** 2, orphanCount: 0 };
    if (c === 'system:process-metrics-subscribe') return { ok: true, projectTabs: [], otherTabs: [], totals: { allBytes: 0, commandBytes: 0 }, orphans: { count: 0, bytes: 0 }, app: { bytes: 0 } };
    if (c === 'history-preparation:subscribe') return { epoch: 'fixture', revision: 1, operations: [] };
    if (c === 'mcp-hub:status') return { servers: [{ name: 'terminal', initialized: true, up: true, pid: 123 }] };
    if (c === 'mcp-hub:codex-catalog') return { servers: [] };
    if (c === 'app:getState') return null;
    if (c === 'app:setState') return {success:true}; // fixture persistence only
    if (c === 'file:exists-batch') return Object.fromEntries(args[0].map(file => [file, true]));
    if (/usage|plan-usage|usage-limits/.test(c)) return { success: false };
    if (/git.*status/.test(c)) return { success: true, isGitRepo: false };
    if (/getCommandStates|get-all-status/.test(c)) return {};
    if (/^(system:process-metrics-.*stop|system:process-metrics-unsubscribe|history-preparation:unsubscribe|log:|renderer:|perf:)/.test(c)) return undefined;
    if (/^(terminal:(create|input|paste|kill|restart|stop)|agent:(send|stop|rewind)|claude-sdk:|codex:(send|run))/.test(c)) { f.violations.push(c); throw Error('Forbidden ' + c); }
    f.unknown.push(c); return null;
  };
  const ipc = {
    invoke(c, ...args) { f.calls.push(c); return Promise.resolve(answer(c, args)); },
    send(c, ...args) { f.calls.push(c); return answer(c, args); },
    on(c, fn) { if (c === 'system:disk-capacity') { native.on(c, fn); return ipc; }
      if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(fn); return ipc; },
    removeListener(c, fn) { if (c === 'system:disk-capacity') native.removeListener(c, fn); else listeners.get(c)?.delete(fn); return ipc; },
    once(c, fn) { return ipc.on(c, fn); },
  };
  window.require = name => {
    if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true }) } };
    if (name === 'path') return { join: (...v) => v.join('/'), dirname: p => p.slice(0, p.lastIndexOf('/')), basename: p => p.split('/').pop(), isAbsolute: p => p.startsWith('/') };
    throw Error('Forbidden require ' + name);
  };
  window.fetch = () => Promise.reject(Error('Network denied'));
}
try {
  result.snapshotStartedAt = new Date().toISOString();
  await fs.mkdir(snapshot);
  for (const entry of ['src', 'packages/claude-blocks']) await fs.cp(path.join(source, entry), path.join(snapshot, entry),
    { recursive: true, filter: file => !file.includes('/node_modules') && !file.includes('/.git') });
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, 'packages', name),
    { recursive: true, filter: file => !file.includes('/node_modules') });
  const rootFiles = ['package.json', 'package-lock.json', 'electron.vite.config.js', 'index.html'];
  for (const file of rootFiles) await fs.copyFile(path.join(source,file),path.join(snapshot,file));
  for (const entry of ['package.json','build']) await fs.cp(path.join(repo,'vendor/noted-shared',entry),path.join(shared,entry),{recursive:true});
  if (await fs.stat(path.join(source,'public')).catch(()=>null)) await fs.cp(path.join(source,'public'),path.join(snapshot,'public'),{recursive:true});
  const filesUnder = async directory => {
    const found=[];
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()) found.push(...await filesUnder(file)); else if(entry.isFile()) found.push(file);
    }
    return found;
  };
  const frozenFiles=[...rootFiles.map(file=>path.join(snapshot,file)),...await filesUnder(path.join(snapshot,'src')),
    ...await filesUnder(path.join(snapshot,'packages'))];
  const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  result.frozenSource = {};
  for(const file of frozenFiles) {
    const relative=path.relative(snapshot,file), original=path.join(source,relative);
    const stat=await fs.stat(original).catch(()=>null), snapshotHash=await sha(file), sourceHash=await sha(original).catch(()=>null);
    result.frozenSource[relative]={sha256:snapshotHash,sourceSha256AtFreeze:sourceHash,sourceMtimeMs:stat?.mtimeMs,size:stat?.size};
  }
  result.snapshotCompletedAt=new Date().toISOString();
  result.driftDuringSnapshot=Object.entries(result.frozenSource).filter(([,v])=>v.sha256!==v.sourceSha256AtFreeze).map(([file])=>file);
  assert.deepEqual(result.driftDuringSnapshot,[],'copied source must match at freeze');
  if(pairedBuild) {
    const before=Date.now();result.build={startedAt:new Date(before).toISOString(),cwd:snapshot};
    console.log(JSON.stringify({artifact,stage:'paired-main-renderer-build',snapshotCompletedAt:result.snapshotCompletedAt}));
    let output;
    try { output=execFileSync(path.join(repo,'node_modules/.bin/electron-vite'),['build'],{cwd:snapshot,encoding:'utf8',maxBuffer:24*1024*1024}); }
    catch(error) { await fs.writeFile(path.join(artifact,'paired-build.log'),String(error.stdout||'')+'\n'+String(error.stderr||''));throw error; }
    await fs.writeFile(path.join(artifact,'paired-build.log'),output);
    await fs.rename(path.join(snapshot,'dist'),path.join(artifact,'build'));
    result.build={...result.build,completedAt:new Date().toISOString(),durationMs:Date.now()-before,pass:true};
  }
  const fixture = path.join(snapshot, 'disk-fixture.tsx');
  await fs.writeFile(fixture, `import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceTitleBarTools from './src/renderer/components/Workspace/WorkspaceTitleBarTools';
import DiskCapacityWarning from './src/renderer/components/Workspace/DiskCapacityWarning';
import { useWorkspaceStore } from './src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from './src/renderer/store/useProjectsStore';
const f:any=(window as any).diskFixture;
const root=createRoot(document.getElementById('root')!);
f.project=(pid='disk-test')=>{
const tab={id:'file-fixture',name:'Synthetic document',tabType:'file',filePath:'/synthetic/readme.md'};
useProjectsStore.setState({projects:{[pid]:{id:pid,name:pid,path:'/synthetic'}}} as any);
useWorkspaceStore.setState({view:'workspace',activeProjectId:pid,focusedProjectId:pid,activeSpaceTab:{projectId:pid,tabId:tab.id},
openProjects:new Map([[pid,{projectId:pid,projectPath:'/synthetic',tabs:new Map([[tab.id,tab]]),activeTabId:tab.id,currentView:'terminal',tabGroups:[],tabHistory:[]}]]),
splitPanes:[],activeSpaceId:null,spaces:[],centerStrips:{}} as any);};
f.mount=(twice=false)=>root.render(<><div id="titlebar" style={{display:'flex',justifyContent:'flex-end',padding:8,background:'#292929',overflow:'auto'}}><WorkspaceTitleBarTools/></div>
{twice&&<div id="second-disk"><DiskCapacityWarning/></div>}<button id="outside" style={{position:'fixed',bottom:10,left:10}}>Outside</button></>);
f.unmount=()=>root.render(null);
f.project();f.mount();f.ready=true;`);
  const bundle = await build({ entryPoints: [fixture], outfile: path.join(artifact, 'bundle.js'), bundle: true, sourcemap: true, metafile: true,
    nodePaths: [path.join(repo, 'node_modules')], format: 'iife', platform: 'browser', target: 'chrome120', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'), '@noted/structured-dnd': path.join(shared, 'packages/structured-dnd/src'),
      '@noted/file-explorer': path.join(shared, 'packages/file-explorer/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' }, logLevel: 'silent' });
  if(pairedBuild || arg('css-from')) {
    const assets=arg('css-from') || path.join(artifact,'build/renderer/assets');
    result.cssSource=assets;
    const styles=(await fs.readdir(assets)).filter(file=>file.endsWith('.css'));
    assert.ok(styles.length,'paired renderer CSS required');
    await fs.writeFile(path.join(artifact,'globals.css'),(await Promise.all(styles.map(file=>fs.readFile(path.join(assets,file),'utf8')))).join('\n'));
  } else {
    execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  }
  const files = ['src/main/disk-capacity-service.js', 'src/main/history-cache-policy.js', 'src/main/history-prepared-cache.js', 'src/main/history-read-worker.js', 'src/main/main.js', 'src/renderer/components/Workspace/DiskCapacityWarning.tsx',
    'src/renderer/components/Workspace/WorkspaceTitleBarTools.tsx', 'src/renderer/components/Workspace/ResourceUsageButton.tsx', 'src/renderer/components/Workspace/McpHubButton.tsx',
    'src/renderer/store/diskCapacityStore.mjs', 'src/renderer/store/useDiskCapacity.ts', 'src/renderer/utils/diskCapacityPresentation.mjs'];
  result.sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex')])));
  result.bundleInputs = Object.keys(bundle.metafile.inputs).length;
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="globals.css"><style>html,body{margin:0;background:#181818;color:#ddd;font:14px sans-serif}</style><div id="root"></div><script>(${installShim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `(${privateMain.toString()})(${JSON.stringify({ service: path.join(snapshot, 'src/main/disk-capacity-service.js'),
    cache: path.join(artifact, 'user-data/history-prepared-cache'), html: path.join(artifact, 'index.html'), userData: path.join(artifact, 'user-data') })});`);
  app = await electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(artifact, 'main.cjs')] });
  result.pid = app.process().pid;
  const page = await app.firstWindow(); page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForFunction(() => window.diskFixture?.ready);
  const chip = page.locator('#titlebar [data-disk-capacity]'), panel = page.locator('[data-disk-capacity-panel]');
  const set = values => page.evaluate(values => window.diskFixture.capacity(values), values);
  const open = async () => { await chip.click(); await panel.waitFor(); };
  await chip.waitFor(); assert.equal(await chip.getAttribute('data-disk-capacity'), 'warning');
  assert.equal(await chip.textContent(), '');
  assert.equal(await chip.locator('svg').count(), 1);
  assert.equal(await chip.locator('.lucide-hard-drive').count(), 1);
  assert.equal(await panel.count(), 0); result.checks.push('warning appears automatically without auto popup');
  const placement = await chip.evaluate(el => ({ before: el.previousElementSibling?.textContent, after: el.nextElementSibling?.getAttribute('data-tooltip-wrapper') || el.nextElementSibling?.outerHTML.slice(0,250),
    color: getComputedStyle(el).color, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, appRegion: getComputedStyle(el).getPropertyValue('-webkit-app-region') }));
  assert.ok(placement.before?.includes('14.8') || placement.before?.includes('14,8'));
  const mcp = page.getByRole('button', { name: 'Статус MCP-хаба', exact: true });
  assert.ok(await chip.evaluate((el, mcp) => !!(el.compareDocumentPosition(document.querySelector(mcp)) & Node.DOCUMENT_POSITION_FOLLOWING), 'button[aria-label="Статус MCP-хаба"]'));
  assert.equal(placement.height, 26); assert.equal(placement.color, 'rgb(251, 191, 36)'); assert.equal(placement.appRegion, 'no-drag');
  assert.equal(placement.width, 26);
  result.placement = placement; result.checks.push('actual toolbar placement between unchanged resources and MCP, styled 26px amber chip');
  await open();
  for (const [key, value] of [['free','5'],['used','14'],['limit','20'],['remaining','6'],['projected','-1'],['reserve','6']])
    assert.equal((await page.locator(`[data-disk-value="${key}"]`).textContent()).trim(), value);
  assert.equal(await panel.locator('dt').count(), 3);
  assert.equal(await panel.locator('dd').count(), 3);
  assert.deepEqual(await panel.locator('dt').allTextContents(), ['Кэш / лимит', 'Свободно / рост кэша', 'После роста / минимум']);
  assert.equal(await panel.locator('p').count(), 0);
  assert.ok(!(await panel.textContent()).includes('Мало места'));
  await page.screenshot({ path: path.join(artifact, 'warning.png') }); result.checks.push('single disk icon, three paired rows, all six amounts and no heading/paragraph');
  await set({free:15,used:5.87});
  for (const [key,value] of [['free','15'],['used','5,87'],['remaining','14,13'],['projected','0,87']])
    assert.equal(await page.locator(`[data-disk-value="${key}"]`).textContent(),value);
  const widthFit=await panel.locator('dt,dd').evaluateAll(elements=>elements.every(el=>el.scrollWidth<=el.clientWidth));
  assert.equal(widthFit,true);
  await page.screenshot({path:path.join(artifact,'compact.png')});
  result.checks.push('15GiB free and 5.87/20GiB cache fit three compact rows with decimal values');
  await set({free:5,used:14});
  await page.keyboard.press('Escape'); await panel.waitFor({ state:'detached' });
  assert.equal(await chip.evaluate(el => document.activeElement === el), true);
  await open(); await chip.click(); await panel.waitFor({state:'detached'});
  await open(); await page.locator('#outside').click(); await panel.waitFor({state:'detached'});
  result.checks.push('trusted Escape restores focus, repeat click and outside click close popup');
  await page.evaluate(() => window.diskFixture.project('__noted_inbox__'));
  await chip.waitFor(); await open(); assert.equal(await mcp.count(), 1); await page.keyboard.press('Escape');
  result.checks.push('same warning in Inbox without changing resource or MCP behavior');
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(420,520));
  await open();
  const narrow = await panel.evaluate(el => { const b=el.getBoundingClientRect(); return {left:b.left,right:b.right,bottom:b.bottom,width:innerWidth,height:innerHeight}; });
  result.narrow = narrow; assert.ok(narrow.left>=0&&narrow.right<=narrow.width&&narrow.bottom<=narrow.height);
  await page.screenshot({path:path.join(artifact,'narrow-inbox.png')}); await page.keyboard.press('Escape'); result.checks.push('420px Inbox popover fits viewport');
  await set({free:10,used:14}); await chip.waitFor(); await open();
  assert.equal(await page.locator('[data-disk-value="projected"]').textContent(),'4'); await page.keyboard.press('Escape');
  result.checks.push('free10 used14 leaves4 and warns');
  await set({free:12}); await chip.waitFor({state:'detached'}); result.checks.push('exact 6GiB projected reserve is healthy and hides chip');
  await set({free:10,used:12}); await chip.waitFor(); assert.equal(await chip.getAttribute('data-disk-capacity'),'warning');
  await set({free:7,used:24}); await chip.waitFor({state:'detached'});
  await set({free:5}); await chip.waitFor(); await open(); assert.equal(await page.locator('[data-disk-value="remaining"]').textContent(),'0');
  await page.keyboard.press('Escape'); result.checks.push('remaining growth formula and over-budget cache');
  await set({fail:true}); assert.equal(await chip.getAttribute('data-disk-capacity'),'error'); await open();
  assert.equal(await chip.evaluate(el=>getComputedStyle(el).color),'rgb(248, 113, 113)');
  assert.equal(await page.locator('[data-disk-value="free"]').textContent(),'—'); await page.screenshot({path:path.join(artifact,'error.png')}); await page.keyboard.press('Escape');
  await set({fail:false,free:40,used:0,stale:true}); await chip.waitFor(); assert.equal(await chip.getAttribute('data-disk-capacity'),'stale'); await open();
  assert.ok((await panel.textContent()).includes('Замер устарел')); await page.screenshot({path:path.join(artifact,'stale.png')});
  await set({stale:false}); await chip.waitFor({state:'detached'}); await panel.waitFor({state:'detached'});
  result.checks.push('failure and stale healthy reading show unknown status, fresh healthy reading recovers');
  await set({free:5,used:14}); await page.evaluate(()=>window.diskFixture.mount(true));
  await page.locator('#second-disk [data-disk-capacity]').waitFor();
  const calls=await page.evaluate(()=>window.diskFixture.calls.filter(c=>c==='system:disk-capacity-subscribe').length); assert.equal(calls,1);
  await open(); const firstPanelId=await chip.getAttribute('aria-controls');
  assert.equal(await panel.getAttribute('id'),firstPanelId);
  await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
  const secondChip=page.locator('#second-disk [data-disk-capacity]');await secondChip.click();
  const secondPanelId=await secondChip.getAttribute('aria-controls');
  assert.notEqual(firstPanelId,secondPanelId);assert.equal(await panel.count(),1);assert.equal(await panel.getAttribute('id'),secondPanelId);
  await page.keyboard.press('Escape');await panel.waitFor({state:'detached'});
  result.checks.push('useId gives each mounted copy its own aria panel identity');
  await page.evaluate(()=>window.diskFixture.unmount());
  await page.waitForFunction(()=>window.diskFixture.calls.includes('system:disk-capacity-unsubscribe'));
  await page.evaluate(()=>window.diskFixture.mount()); await chip.waitFor();
  const end=await page.evaluate(()=>({unknown:[...new Set(window.diskFixture.unknown)],violations:window.diskFixture.violations,events:window.diskFixture.events,calls:window.diskFixture.calls}));
  assert.deepEqual(end.unknown,[]); assert.deepEqual(end.violations,[]); assert.ok(end.events.length>10&&end.events.every(e=>e.trusted));
  result.events=end.events; result.calls=end.calls; result.checks.push('two mounted copies share lease; unmount cleanup and remount work');
  const main=await page.evaluate(()=>window.diskFixture.state());
  result.diskLogs=main.logs.map(line=>JSON.parse(line.slice('[DiskCapacity] '.length)));
  assert.ok(result.diskLogs.some(log=>log.state==='ready-warning')&&result.diskLogs.some(log=>log.state==='ready-healthy')&&result.diskLogs.some(log=>log.state==='error'));
  assert.ok(result.diskLogs.every(log=>Number.isFinite(log.durMs)&&log.source==='statfs+cache-file-metadata'));
  assert.ok(!/user-data|synthetic denied|\/Users\//.test(main.logs.join('')));
  result.checks.push('actual Main logs transitions and sanitized errno, with duration and numeric capacity');
  result.sourceDrift=[];
  for(const [relative, original] of Object.entries(result.frozenSource)) {
    const file=path.join(source,relative), currentSha256=await sha(file).catch(()=>null),stat=await fs.stat(file).catch(()=>null);
    if(original.sha256!==currentSha256) result.sourceDrift.push({file:relative,snapshotSha256:original.sha256,currentSha256,
      sourceMtimeMsAtFreeze:original.sourceMtimeMs,currentMtimeMs:stat?.mtimeMs});
  }
  result.sourceCheckedAt=new Date().toISOString();
  assert.deepEqual(result.errors,[]); result.pass=true;
} catch(error) { result.pass=false; result.failure=String(error.stack||error); }
finally {
  if(app){await app.close();result.cleanup.electronClosed=true;}
  await fs.rm(snapshot,{recursive:true,force:true});await fs.rm(shared,{recursive:true,force:true});result.cleanup.snapshotRemoved=true;
  await fs.rm(path.join(artifact,'user-data'),{recursive:true,force:true});result.cleanup.profileRemoved=true;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({artifact,pass:result.pass,build:result.build,checks:result.checks,errors:result.errors,sourceDrift:result.sourceDrift,failure:result.failure,cleanup:result.cleanup},null,2));
}
if(!result.pass)process.exitCode=1;
