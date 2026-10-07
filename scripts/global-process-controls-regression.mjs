#!/usr/bin/env node
// Actual global Resource/MCP menus and action callbacks. Frozen source, private
// sandboxed offscreen renderer, synthetic IPC; no Noted Main/process writes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-global-process-controls-')));
const snapshot = path.join(artifact, 'source');
const result = { artifact, checks: [], errors: [], sources: {}, status: 'running', cleanup: false };
let app, child;
try {
  await fs.cp(path.join(repo, 'src'), path.join(snapshot, 'src'), { recursive: true });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  for (const name of ['global-process-controls.tsx', 'global-process-controls-stores.ts']) {
    await fs.copyFile(path.join(repo, 'scripts/fixtures', name), path.join(snapshot, 'scripts/fixtures', name));
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const stores = path.join(snapshot, 'scripts/fixtures/global-process-controls-stores.ts');
  const bundle = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/global-process-controls.tsx')],
    bundle: true, metafile: true, sourcemap: true, platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic',
    outfile: path.join(artifact, 'bundle.js'), define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl' }, logLevel: 'silent',
    plugins: [{ name: 'private-process-stores', setup(builder) {
      builder.onResolve({ filter: /\/store\/use(?:Workspace|Projects)Store$/ }, () => ({ path: stores }));
    } }],
  });
  await fs.writeFile(path.join(artifact, 'bundle-inputs.json'), JSON.stringify(bundle.metafile, null, 2));
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const full = path.resolve(input);
    if (full.startsWith(snapshot)) result.sources[path.relative(snapshot, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
  }
  for (const name of ['src/renderer/styles/globals.css', 'scripts/global-process-controls-regression.mjs', 'src/renderer/utils/globalProcessControls.test.mjs']) {
    result.sources[name] = createHash('sha256').update(await fs.readFile(path.join(repo, name))).digest('hex');
  }
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  function installAdapters() {
    const f = window.processFixture = { calls: [], writes: [], navigation: [], violations: [], pending: [], listeners: new Map() };
    const ai = (pid, extra = {}) => ({ pid, ppid: 1, cwd: '/synthetic/workspace', command: 'codex --no-alt-screen',
      startTime: '12:40', tabId: null, cpu: '1.2', mem: '2.3', ownerInstance: 'external', ownerPid: null,
      ownerLabel: 'external', protectedByApp: false, killable: true, ...extra });
    f.resetInventory = () => { f.inventory = {
      claude: [ai(102, { command: 'claude --permission-mode bypassPermissions' })], gemini: [],
      codex: [ai(101), ai(105), ai(201, { ppid: 200, tabId: 'bound-tab', ownerInstance: 'current', ownerPid: 500, ownerLabel: 'this prod', protectedByApp: true }),
        ai(301, { ppid: 300, ownerInstance: 'custom-terminal', ownerPid: 600, ownerLabel: 'other dev', protectedByApp: true, killable: false })],
      electronDev: [ai(401, { ppid: 400, launcherPid: 400, name: 'Synthetic Electron Dev', command: '/synthetic/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /synthetic/app', isOrphan: false })],
      mcp: [ai(501, { name: 'synthetic-mcp', command: 'node /synthetic/mcp/server.mjs', isAlive: false }),
        ai(502, { name: 'shared-hub-child', command: 'node /synthetic/terminal-server.mjs', isAlive: true, ownerInstance: 'current', ownerPid: 500, ownerLabel: 'this prod', protectedByApp: true }),
        ai(503, { name: 'protected-mcp', command: 'node /synthetic/mcp/other.mjs', isAlive: false, ownerInstance: 'custom-terminal', ownerPid: 600, protectedByApp: true, killable: false })],
    }; }; f.resetInventory();
    f.releaseInventory = () => { while (f.pending.length) f.pending.shift()(); };
    const metrics = () => ({ ok: true, hasCpu: true, durationMs: 4,
      totals: { projectBytes: 200e6, otherBytes: 0, allBytes: 2100e6, commandBytes: 96e6, commandCpu: 2.1 },
      projectTabs: [{ tabId: 'bound-tab', projectId: 'fixture-project', pid: 200, title: 'Owned Codex tab', alive: true,
        selfBytes: 20e6, toolsBytes: 84e6, totalBytes: 200e6, selfCpu: 0.2, toolsCpu: 0.3, totalCpu: 2.6,
        commands: [{ pid: 701, label: 'npm run dev', bytes: 96e6, cpu: 2.1 }], commandTotalBytes: 96e6, commandTotalCpu: 2.1,
        tools: [{ pid: 501, label: 'knowledge', bytes: 84e6, cpu: 0.3 }], otherBytes: 0, toolCount: 1 }],
      otherTabs: [], app: { totalBytes: 1800e6, totalCpu: 1.2, rows: [] }, orphans: { count: 1, totalBytes: 100e6, rows: [{ pid: 501, label: 'MCP', bytes: 100e6, cpu: 0 }] } });
    const respond = async (channel, payload) => {
      f.calls.push({ channel, payload });
      if (channel === 'system:get-dashboard-processes') {
        if (f.delayInventory) await new Promise(resolve => f.pending.push(resolve));
        return structuredClone(f.inventory);
      }
      if (channel === 'system:process-metrics-ambient-start') return { ok: true, totalBytes: 2100e6, commandBytes: 96e6, orphanCount: 1 };
      if (channel === 'system:process-metrics-subscribe') return metrics();
      if (['system:process-metrics-ambient-stop', 'system:process-metrics-unsubscribe', 'history-preparation:unsubscribe'].includes(channel)) return null;
      if (channel === 'history-preparation:subscribe') return { epoch: 'synthetic', revision: 1, operations: [] };
      if (channel === 'mcp-hub:status') return { port: 53133, pid: 900, clients: [], servers: [{ name: 'terminal', up: true, initialized: true, pid: 502, startedAt: Date.now(), restarts: 0 }] };
      if (channel === 'mcp-hub:codex-catalog') return { servers: [], fetchedAt: new Date().toISOString(), stale: false, error: null };
      if (['system:kill-process', 'system:kill-electron-dev-process', 'terminal:stop-ai-process'].includes(channel)) {
        f.writes.push({ channel, payload });
        if (f.delayWrite) await new Promise(resolve => { f.releaseWrite = resolve; });
        return f.failWrite ? { success: false, error: 'protected custom-terminal process' } : { success: true };
      }
      f.violations.push(channel); throw Error('Forbidden private IPC: ' + channel);
    };
    const ipc = { invoke: respond,
      on(channel, fn) { if (!f.listeners.has(channel)) f.listeners.set(channel, new Set()); f.listeners.get(channel).add(fn); },
      removeListener(channel, fn) { f.listeners.get(channel)?.delete(fn); } };
    window.require = name => {
      if (name === 'electron') return { ipcRenderer: ipc, clipboard: { writeText() { throw Error('Clipboard forbidden'); } } };
      throw Error('Forbidden require: ' + name);
    };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="globals.css"><style>body{margin:0;background:#191919;color:#ccc;font-family:Arial}button{cursor:pointer}</style><div id="root"></div><script>(${installAdapters.toString()})();</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));global.win=new BrowserWindow({show:false,focusable:false,width:800,height:900,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});win.webContents.on('paint',()=>{});win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env }); child = app.process(); result.pid = child.pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(9000); page.on('pageerror', e => result.errors.push(e.stack || e.message));
  const check = name => result.checks.push(name);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const resource = page.locator('[data-resource-usage-button]');
  const agentControls = page.locator('[data-global-process-controls="agents"]');
  const mcpControls = page.locator('[data-global-process-controls="mcp-orphans"]');
  const stop = pid => page.locator(`[data-process-stop="${pid}"]`);
  const refreshAgents = async () => { await agentControls.locator('[data-process-refresh]').click(); await agentControls.getByText('Reading processes…', {exact:true}).waitFor({state:'hidden'}); };
  await resource.waitFor(); await frames();
  assert.equal(await page.locator('[data-global-process-controls]').count(), 0);
  assert.equal(await page.evaluate(() => window.processFixture.calls.filter(x => x.channel === 'system:get-dashboard-processes').length), 0);
  await page.locator('[data-fixture-toggle]').click(); await page.locator('[data-fixture-toggle]').click();
  assert.equal(await page.locator('[data-global-process-controls]').count(), 0);
  assert.equal(await page.evaluate(() => window.processFixture.calls.filter(x => x.channel === 'system:get-dashboard-processes').length), 0);
  assert.equal(await resource.locator('[data-resource-command-value]').count(), 1);
  check('Home/workspace outer view toggles keep global chips; closed menus mount no inventory/list');

  await resource.click(); await stop(101).waitFor();
  assert.equal(await stop(301).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.processFixture.calls.filter(x => x.channel === 'system:get-dashboard-processes').length), 1);
  assert.equal(await resource.locator('[data-resource-command-value]').count(), 1);
  await page.getByText('Fixture directory', {exact:true}).click();
  await page.locator('[data-resource-tab-id="bound-tab"]').click();
  await page.getByText('MCP · knowledge', {exact:true}).waitFor();
  await page.getByText('ЦП', {exact:true}).click();
  await page.getByText('Память', {exact:true}).click();
  check('Actual Resource menu lazy inventory; usage totals/commands, CPU toggle and MCP labels remain');

  await stop(101).click(); await page.locator('[data-process-confirmation]').waitFor();
  assert.match(await page.locator('[data-process-confirmation]').innerText(), /PID 101.*codex/);
  assert.equal(await page.evaluate(() => window.processFixture.writes.length), 0);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-process-confirmation]').count(), 0);
  check('Exact process confirmation and Escape cancel send zero actions');

  for (const change of ['command', 'owner', 'missing']) {
    await page.evaluate(() => window.processFixture.resetInventory()); await refreshAgents();
    await stop(101).click();
    await page.evaluate(change => {
      const f=window.processFixture; f.delayInventory=true;
      if(change==='command') f.inventory.codex[0].command='different process';
      if(change==='owner') Object.assign(f.inventory.codex[0],{ownerInstance:'custom-terminal',ownerPid:888,protectedByApp:true,killable:false});
      if(change==='missing') f.inventory.codex=f.inventory.codex.filter(x=>x.pid!==101);
    }, change);
    await page.locator('[data-process-confirm]').click();
    await page.waitForFunction(() => window.processFixture.pending.length === 1);
    await page.evaluate(() => { window.processFixture.delayInventory=false; window.processFixture.releaseInventory(); });
    await agentControls.locator('[data-process-outcome]').waitFor();
    assert.match(await agentControls.locator('[data-process-outcome]').innerText(), /Process or owner changed/);
    assert.equal(await page.evaluate(() => window.processFixture.writes.length), 0);
  }
  check('Delayed confirmation refuses changed command, changed owner/protection and disappeared exact PID');

  await page.evaluate(() => window.processFixture.resetInventory()); await refreshAgents();
  await stop(101).click();
  for (const width of [350, 800, 1440]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await frames();
    await page.locator('[data-process-confirm]').scrollIntoViewIfNeeded();
    const geometry=await page.locator('[data-resource-usage-panel]').evaluate(node=>{const r=node.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,viewport:innerWidth,overflow:node.scrollWidth>node.clientWidth};});
    (result.geometry ||= []).push({width,...geometry});
    assert.ok(geometry.left>=0&&geometry.right<=width); assert.equal(geometry.overflow,false);
    await page.screenshot({path:path.join(artifact,`resource-confirm-${width}.png`)});
  }
  check('Actual Resource confirmation fits 350/800/1440 with no horizontal overflow');
  await page.locator('[data-process-cancel]').click();
  await agentControls.locator('[data-process-bulk="codex"]').click();
  assert.match(await page.locator('[data-process-confirmation]').innerText(), /2 selected/);
  await page.evaluate(() => { const f=window.processFixture;f.inventory.codex.push({...f.inventory.codex[0],pid:106});f.delayWrite=true; });
  await page.locator('[data-process-confirm]').dblclick();
  await page.waitForFunction(() => window.processFixture.writes.length === 1);
  await page.evaluate(() => { window.processFixture.delayWrite=false; window.processFixture.releaseWrite(); });
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.deepEqual(await page.evaluate(() => window.processFixture.writes), [{channel:'system:kill-process',payload:101},{channel:'system:kill-process',payload:105}]);
  check('External provider bulk is frozen, excludes bound/protected/new processes; delayed duplicate apply stops once per exact PID');

  await stop(201).click(); await page.locator('[data-process-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.deepEqual(await page.evaluate(() => window.processFixture.writes.at(-1)), {channel:'terminal:stop-ai-process',payload:{tabId:'bound-tab',toolType:'codex',reason:'manual-global-process-controls'}});
  check('Current bound tab routes through owned Main agent stop, never generic PID/terminal kill');
  await stop(401).click(); await page.locator('[data-process-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.deepEqual(await page.evaluate(() => window.processFixture.writes.at(-1)),{channel:'system:kill-electron-dev-process',payload:401});
  check('Electron Dev one-PID gesture uses dedicated API including its original launcher behavior');

  await page.evaluate(() => { window.processFixture.failWrite=true; });
  await stop(102).click(); await page.locator('[data-process-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.match(await agentControls.locator('[data-process-outcome]').innerText(), /protected custom-terminal process/);
  await page.evaluate(() => { window.processFixture.failWrite=false; });
  check('Main refusal remains visible and never counted as successful stop');

  await stop(101).click();
  await page.evaluate(() => { window.processFixture.delayInventory=true; });
  await page.locator('[data-process-confirm]').click(); await page.waitForFunction(() => window.processFixture.pending.length===1);
  const beforeClose=await page.evaluate(() => window.processFixture.writes.length);
  await page.mouse.click(2,850);
  await page.waitForFunction(() => !document.querySelector('[data-global-process-controls="agents"]'));
  await page.evaluate(() => { window.processFixture.delayInventory=false;window.processFixture.releaseInventory(); });
  await frames(); assert.equal(await page.evaluate(() => window.processFixture.writes.length),beforeClose);
  check('Closing Resource menu during fresh owner reread cancels pending action');

  await page.getByRole('button',{name:'Статус MCP-хаба',exact:true}).click(); await mcpControls.waitFor(); await stop(501).waitFor();
  assert.equal(await stop(503).isDisabled(),true); assert.equal(await stop(502).count(),0);
  await stop(501).click();
  await page.evaluate(() => { window.processFixture.inventory.mcp[0].isAlive=true;window.processFixture.delayInventory=true; });
  await page.locator('[data-process-confirm]').click(); await page.waitForFunction(() => window.processFixture.pending.length===1);
  await page.evaluate(() => { window.processFixture.delayInventory=false;window.processFixture.releaseInventory(); });
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.equal(await page.evaluate(() => window.processFixture.writes.length),beforeClose);
  check('MCP orphan action lives in Hub menu, excludes active shared child and protected owner; reattached orphan refused');
  await page.evaluate(() => { window.processFixture.resetInventory(); });
  await mcpControls.locator('[data-process-refresh]').click(); await stop(501).waitFor();
  await mcpControls.locator('[data-process-bulk="mcp"]').click();
  await page.locator('[data-process-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('[data-process-confirmation]'));
  assert.deepEqual(await page.evaluate(() => window.processFixture.writes.at(-1)),{channel:'system:kill-process',payload:501});
  await page.screenshot({path:path.join(artifact,'mcp-orphans.png')});
  check('MCP exact orphan cleanup retains guarded original process API, no hub restart/kill-all');
  assert.deepEqual(result.errors,[]); assert.deepEqual(await page.evaluate(() => window.processFixture.violations),[]);
  assert.equal(await app.evaluate(() => global.win.isFocused()),false);
  result.writes=await page.evaluate(() => window.processFixture.writes);
  result.status='pass';
} catch(error) { result.status='fail';result.error=error.stack;process.exitCode=1; }
finally {
  await app?.close();await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});
  result.cleanup=!child||child.exitCode!==null||child.signalCode!==null;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(artifact,'manifest.json'),JSON.stringify(result.sources,null,2));
  console.log(JSON.stringify({artifact,status:result.status,checks:result.checks.length,error:result.error,cleanup:result.cleanup}));
}
