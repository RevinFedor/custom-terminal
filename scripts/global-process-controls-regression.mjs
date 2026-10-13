#!/usr/bin/env node
// Actual Resource/MCP menus after removing unsolicited process controls.
// Frozen source, private offscreen renderer, synthetic IPC; no Main/process writes.
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
      builder.onResolve({ filter: /\/store\/use(?:(?:Workspace|Projects)Store|DiskCapacity)$/ }, () => ({ path: stores }));
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
    const metrics = () => ({ ok: true, hasCpu: true, durationMs: 4,
      totals: { projectBytes: 200e6, otherBytes: 0, allBytes: 2100e6, commandBytes: 96e6, commandCpu: 2.1 },
      projectTabs: [{ tabId: 'bound-tab', projectId: 'fixture-project', pid: 200, title: 'Owned Codex tab', alive: true,
        selfBytes: 20e6, toolsBytes: 84e6, totalBytes: 200e6, selfCpu: 0.2, toolsCpu: 0.3, totalCpu: 2.6,
        commands: [{ pid: 701, label: 'npm run dev', bytes: 96e6, cpu: 2.1 }], commandTotalBytes: 96e6, commandTotalCpu: 2.1,
        tools: [{ pid: 501, label: 'knowledge', bytes: 84e6, cpu: 0.3 }], otherBytes: 0, toolCount: 1 }],
      otherTabs: [], app: { totalBytes: 1800e6, totalCpu: 1.2, rows: [] }, orphans: { count: 1, totalBytes: 100e6, rows: [{ pid: 501, label: 'MCP', bytes: 100e6, cpu: 0 }] } });
    const respond = async (channel, payload) => {
      f.calls.push({ channel, payload });
      if (channel === 'system:process-metrics-ambient-start') return { ok: true, totalBytes: 2100e6, commandBytes: 96e6, orphanCount: 1 };
      if (channel === 'system:process-metrics-subscribe') return metrics();
      if (['system:process-metrics-ambient-stop', 'system:process-metrics-unsubscribe', 'history-preparation:unsubscribe'].includes(channel)) return null;
      if (channel === 'history-preparation:subscribe') return { epoch: 'synthetic', revision: 1, operations: [] };
      if (channel === 'mcp-hub:status') return { port: 53133, pid: 900, clients: [], servers: [{ name: 'terminal', up: true, initialized: true, pid: 502, startedAt: Date.now(), restarts: 0 }] };
      if (channel === 'mcp-hub:codex-catalog') return { servers: [{ id: 'fixture-external', name: 'fixture-external', transport: 'stdio', source: 'config', enabled: true, managedByHub: false, address: 'node /synthetic/server.mjs' }], fetchedAt: new Date().toISOString(), stale: false, error: null };
      if (channel === 'mcp-hub:restart-server') { f.writes.push({ channel, payload }); return { ok: true, servers: [{ name: 'terminal', up: true, initialized: true, pid: 502, startedAt: Date.now(), restarts: 1 }] }; }
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
  const absentControls = async () => {
    assert.equal(await page.locator('[data-global-process-controls]').count(), 0);
    assert.equal(await page.locator('[data-process-stop], [data-process-bulk], [data-process-refresh]').count(), 0);
    assert.equal(await page.evaluate(() => window.processFixture.calls.filter(x => x.channel === 'system:get-dashboard-processes').length), 0);
  };
  await resource.waitFor(); await frames(); await absentControls();
  await page.locator('[data-fixture-toggle]').click(); await page.locator('[data-fixture-toggle]').click();
  await absentControls();
  check('Closed menus and Home/workspace toggles never read or mount the global process inventory');

  await resource.click(); await page.locator('[data-resource-usage-panel]').waitFor();
  await page.getByText('Fixture directory', {exact:true}).waitFor();
  await absentControls();
  assert.equal(await page.getByText('Брошенные инструменты', {exact:true}).count(), 0);
  assert.equal(await page.getByText('Управление в меню MCP', {exact:true}).count(), 0);
  assert.equal(await resource.locator('[data-resource-command-value]').count(), 1);
  const total = await resource.innerText();
  assert.match(total, /2[.,]0/);
  check('Resource menu removes duplicate process cards and orphan banner without changing the total or command subset');

  await page.getByText('Fixture directory', {exact:true}).click();
  await page.locator('[data-resource-tab-id="bound-tab"]').click();
  await page.getByText('MCP · knowledge', {exact:true}).waitFor();
  await page.getByText('ЦП', {exact:true}).click();
  await page.getByText('Память', {exact:true}).click();
  await absentControls();
  check('Existing resource tab details, command/MCP attribution and CPU/memory selection remain usable');

  for (const width of [350, 800, 1440]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await frames();
    const geometry = await page.locator('[data-resource-usage-panel]').evaluate(node => {
      const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, width:r.width, viewport:innerWidth, overflow:node.scrollWidth>node.clientWidth };
    });
    (result.geometry ||= []).push({width,...geometry});
    assert.ok(geometry.left>=0&&geometry.right<=width); assert.equal(geometry.overflow,false);
  }
  await page.screenshot({path:path.join(artifact,'resource-menu.png')});
  check('Resource menu fits 350/800/1440 widths with no nested process list or horizontal overflow');
  await page.keyboard.press('Escape');
  await page.locator('[data-resource-usage-panel]').waitFor({state:'hidden'});

  const hubButton = page.getByRole('button',{name:'Статус MCP-хаба',exact:true});
  await hubButton.click();
  await page.getByText('MCP-хаб · порт 53133', {exact:true}).waitFor();
  await page.getByText('fixture-external', {exact:true}).waitFor();
  await absentControls();
  assert.equal(await page.getByText('MCP processes', {exact:true}).count(), 0);
  assert.equal(await page.getByText('Stop orphans', {exact:false}).count(), 0);
  assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).count(), 0);
  assert.equal(await page.getByText('1/1', {exact:true}).count(), 1);
  check('Hub readiness and external configuration remain; no raw MCP PID cards, orphan cleanup or Refresh control');

  await page.getByRole('button', {name:'Перезапустить terminal',exact:true}).click();
  await page.waitForFunction(() => window.processFixture.writes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.processFixture.writes), [{channel:'mcp-hub:restart-server',payload:'terminal'}]);
  check('Existing hub per-server restart still uses its dedicated handler, never generic process kill');
  await page.screenshot({path:path.join(artifact,'mcp-menu.png')});
  await hubButton.click();
  await page.getByText('MCP-хаб · порт 53133', {exact:true}).waitFor({state:'hidden'});
  await hubButton.click(); await page.getByText('fixture-external', {exact:true}).waitFor();
  await absentControls();
  check('Closing and reopening MCP menu does not restore deleted controls or start dashboard inventory');
  assert.deepEqual(result.errors,[]); assert.deepEqual(await page.evaluate(() => window.processFixture.violations),[]);
  assert.equal(await app.evaluate(() => global.win.isFocused()),false);
  result.writes=await page.evaluate(() => window.processFixture.writes);
  await hubButton.click();
  const cache = page.locator('[data-disk-capacity]');
  const typography = await page.evaluate(() => {
    const a = document.querySelector('[data-resource-usage-button]'); const b = document.querySelector('[data-disk-capacity]');
    const style = element => { const s=getComputedStyle(element), icon=element.querySelector('svg');return{font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,iconWidth:icon.getBoundingClientRect().width,height:element.getBoundingClientRect().height}; };
    return {resource:style(a),cache:style(b)};
  });
  assert.deepEqual(typography.cache,typography.resource); result.typography=typography;
  assert.match(await cache.innerText(),/20.*1,61.*ГБ/s);assert.doesNotMatch(await cache.innerText(),/ГиБ/);
  await cache.click();const capacityPanel=page.locator('[data-disk-capacity-panel]');await capacityPanel.waitFor();
  assert.match(await capacityPanel.innerText(),/Свободно \/ возможный рост/);
  assert.match(await capacityPanel.innerText(),/62,78\s*\/\s*\+0\s*ГБ/);
  assert.match(await capacityPanel.innerText(),/≈1,61\s*\/\s*2\s*ГБ/);
  assert.doesNotMatch(await capacityPanel.innerText(),/ГиБ/);
  await page.screenshot({path:path.join(artifact,'cache-chip.png')});
  check('Cache and resource chips share font family/size/weight, icon size and height; GB and +growth keep their real meaning');
  check('Private renderer stayed unfocused; no unknown IPC, process Stop, external network or application mutation');
  result.status='pass';
} catch(error) { result.status='fail';result.error=error.stack;process.exitCode=1; }
finally {
  await app?.close();await fs.rm(path.join(artifact,'profile'),{recursive:true,force:true});
  result.cleanup=!child||child.exitCode!==null||child.signalCode!==null;
  await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify(result,null,2));
  await fs.writeFile(path.join(artifact,'manifest.json'),JSON.stringify(result.sources,null,2));
  console.log(JSON.stringify({artifact,status:result.status,checks:result.checks.length,error:result.error,cleanup:result.cleanup}));
}
