// Real MCP button + IPC + private hub, never the user's global port or cursor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { build } = require('esbuild');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

test('MCP panel reports failed restarts and all/single restart really restore tools', { timeout: 30000 }, async () => {
  const repo = path.resolve(__dirname, '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-mcp-ui-'));
  const stub = `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{serverInfo:{name:'stub'},capabilities:{}}:{tools:[{name:'alive'}]}})+'\\n')})`;
  await build({ stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import McpHubButton from './src/renderer/components/Workspace/McpHubButton';function Fixture(){const [cwd,setCwd]=useState('/fixture');window.setCatalogCwd=setCwd;return <McpHubButton cwd={cwd}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`, loader: 'tsx', resolveDir: repo },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(root, 'ui.js') });
  const cssInput = `@import ${JSON.stringify(path.join(repo, 'node_modules/tailwindcss/index.css'))};\n@source ${JSON.stringify(path.join(repo, 'src/renderer/components/Workspace/McpHubButton.tsx'))};`;
  fs.writeFileSync(path.join(root, 'input.css'), cssInput);
  execFileSync(process.execPath, [path.join(repo, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', path.join(root, 'input.css'), '-o', path.join(root, 'style.css')], { stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'index.html'), '<html><link rel="stylesheet" href="./style.css"><body style="background:#111;color:#ddd;padding:20px;font-family:system-ui"><div id="root" style="display:flex;justify-content:flex-end"></div><script src="./ui.js"></script></body></html>');
  fs.writeFileSync(path.join(root, 'app.cjs'), `
    const {app,BrowserWindow,ipcMain}=require('electron');
    const {McpHub}=require(${JSON.stringify(path.join(__dirname, 'mcp-hub.js'))});
    const {createCodexMcpCatalogReader}=require(${JSON.stringify(path.join(__dirname, 'codex-mcp-catalog.js'))});
    app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});app.setActivationPolicy('accessory');
    app.whenReady().then(async()=>{
      const def={command:'node',args:['-e',${JSON.stringify(stub)}],env:{}};
      const hub=new McpHub({port:0,log(){},env:{PATH:'/usr/bin:/bin'},serverDefs:{knowledge:def,terminal:{...def}}});
      await hub.start({eager:false}); let fail=true;global.testHub=hub;global.calls=[];
      global.catalogConfig={mcp_servers:{native_sample:{command:'node',args:['SECRET']}}};
      global.catalogCalls=[];global.catalogFailure=false;
      const catalog=createCodexMcpCatalogReader({ttlMs:0,hubPort:hub.actualPort,hubNames:['knowledge','terminal'],log(){},
        clientFactory:()=>({async start(){},close(){},async request(method,params){
          global.catalogCalls.push(method);
          if(method==='config/read'&&params.cwd==='/slow'){
            const config=global.catalogConfig;global.slowCatalogWaiting=true;
            await new Promise(resolve=>global.releaseSlowCatalog=resolve);return{config};
          }
          if(global.catalogFailure)throw new Error('SECRET');
          if(method==='config/read')return{config:global.catalogConfig};
          if(method==='plugin/installed')return{marketplaces:[]};
          throw new Error('unexpected catalog method');
        }})});
      global.testCatalog=catalog;
      ipcMain.handle('mcp-hub:status',()=>({port:hub.actualPort,...hub.status()}));
      ipcMain.handle('mcp-hub:codex-catalog',(_event,request)=>catalog.read(request));
      ipcMain.handle('__test:slow-catalog-ready',()=>global.slowCatalogWaiting===true);
      ipcMain.handle('mcp-hub:restart-all',async()=>{global.calls.push('all');if(fail){fail=false;return{ok:false,error:'Не удалось запустить Node.js — тестовая ошибка'}}return hub.restartAll()});
      ipcMain.handle('mcp-hub:restart-server',async(_e,name)=>{global.calls.push(name);return{ok:true,server:await hub.restartServer(name)}});
      const win=new BrowserWindow({show:false,width:700,height:500,focusable:false,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
      await win.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
    });`);
  const app = await _electron.launch({ executablePath: path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [path.join(root, 'app.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Статус MCP-хаба', exact: true }).click();
    await page.getByText('0/2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Перезапустить MCP хаба', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Не удалось запустить Node.js' }).waitFor();
    await page.screenshot({ path: path.join(root, 'restart-error.png') });
    await page.getByRole('button', { name: 'Перезапустить MCP хаба', exact: true }).click();
    await page.getByText('2/2', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    const before = await app.evaluate(() => global.testHub.status().servers.map(s => s.pid));
    await page.getByRole('button', { name: 'Перезапустить knowledge', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Перезапустить knowledge"]').disabled);
    const after = await app.evaluate(async () => {
      const result = await global.testHub.children.get('knowledge').request('tools/list', {});
      return { servers: global.testHub.status().servers, tools: result.tools, calls: global.calls };
    });
    assert.notEqual(after.servers[0].pid, before[0]);
    assert.equal(after.servers[1].pid, before[1], 'individual restart preserves the neighbour');
    assert.equal(after.tools[0].name, 'alive');
    assert.deepEqual(after.calls, ['all', 'all', 'knowledge']);
    const native=page.getByRole('region',{name:'Внешние MCP Codex'});
    await native.getByText('native_sample',{exact:true}).waitFor();
    assert.equal(await native.getByText('настроен',{exact:true}).count(),1);
    assert.equal(await native.getByText(/pid /).count(),0,'configuration has no invented process/connection proof');
    assert.equal(await native.getByText(/SECRET/).count(),0);
    await app.evaluate(()=>{global.catalogConfig={mcp_servers:{replacement:{url:'https://user:SECRET@example.test/SECRET?token=SECRET'}}}});
    await native.getByText('replacement',{exact:true}).waitFor();
    assert.equal(await native.getByText('native_sample',{exact:true}).count(),0,'removed registrations disappear without app restart');
    const metadata=await app.evaluate(()=>global.testCatalog.read({cwd:'/fixture'}));
    assert.equal(metadata.servers[0].address,'https://example.test');
    await app.evaluate(()=>{global.catalogFailure=true});
    await native.getByRole('status').waitFor();
    assert.equal(await native.getByText('replacement',{exact:true}).count(),1,'failed read retains useful last data');
    await page.getByRole('button',{name:'Статус MCP-хаба',exact:true}).click();
    await app.evaluate(()=>{global.catalogFailure=false;global.catalogConfig={mcp_servers:{}}});
    await page.getByRole('button',{name:'Статус MCP-хаба',exact:true}).click();
    await native.getByText('Нет внешних MCP',{exact:true}).waitFor();
    assert.equal(await native.getByRole('status').count(),0,'a successful read clears the previous error');
    await app.evaluate(()=>{global.catalogConfig={mcp_servers:{late_old_scope:{command:'node'}}}});
    await page.evaluate(()=>window.setCatalogCwd('/slow'));
    await page.waitForFunction(()=>window.require('electron').ipcRenderer.invoke('__test:slow-catalog-ready'));
    await app.evaluate(()=>{global.catalogConfig={mcp_servers:{current_scope:{command:'node'}}}});
    await page.evaluate(()=>window.setCatalogCwd('/other'));
    await app.evaluate(()=>global.releaseSlowCatalog());
    await native.getByText('current_scope',{exact:true}).waitFor();
    assert.equal(await native.getByText('late_old_scope',{exact:true}).count(),0,'late read cannot populate a different cwd');
    const catalogCalls=await app.evaluate(()=>global.catalogCalls);
    assert.ok(catalogCalls.every(m=>['config/read','plugin/installed'].includes(m)), 'panel does not start MCP connections or model turns');
    await page.screenshot({ path: path.join(root, 'restart-ready.png') });
    console.log('MCP UI artifacts: ' + root);
  } finally {
    await app.evaluate(async () => { global.testCatalog.close();await global.testHub.stop(); });
    await app.close();
  }
});
