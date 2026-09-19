#!/usr/bin/env node
// Actual ResourceUsageButton + main IPC, with fixture metrics/project metadata.
// No Noted application, accounts, provider commands or production connection.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-preparation-ui-'));
await fs.copyFile(path.join(root, 'src/main/history-preparation-activity.js'), path.join(dir, 'activity.cjs'));
const component = path.join(root, 'src/renderer/components/Workspace/ResourceUsageButton.tsx');
const status = path.join(root, 'src/renderer/utils/historyPreparationStatus.mjs');
const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
import ResourceUsageButton from ${JSON.stringify(component)};
import {historyPreparationStatus} from ${JSON.stringify(status)};
window.fixturePrewarm=n=>historyPreparationStatus().setPrewarm(n);
const root=createRoot(document.getElementById('root'));
window.fixtureMount=()=>root.render(React.createElement(ResourceUsageButton));
window.fixtureUnmount=()=>root.render(null);window.fixtureMount();`;
await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'bundle.js'),
  loader: { '.svg': 'dataurl', '.png': 'dataurl' },
  plugins: [{ name: 'fixture-store-metadata', setup(b) {
    b.onResolve({ filter: /store\/use(Workspace|Projects)Store$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.includes('Workspace')
      ? `const state={activeProjectId:'fixture',openProjects:new Map([['fixture',{projectPath:'/fixture',tabs:new Map([['A',{name:'Resume test',commandType:'codex'}]])}]])};export const useWorkspaceStore=selector=>selector(state);`
      : `const state={projects:{}};export const useProjectsStore=selector=>selector(state);`, loader: 'js' }));
  } }], logLevel: 'silent' });
await fs.writeFile(path.join(dir, 'input.css'), `@import ${JSON.stringify(path.join(root, 'node_modules/tailwindcss/index.css'))} source(none);
@source ${JSON.stringify(component)};@source ${JSON.stringify(path.join(root, 'src/renderer/components/UI/Tooltip.tsx'))};
body{margin:0;background:#161616;color:#ccc;font-family:Arial,sans-serif}#root{padding:64px;width:820px;height:520px;display:flex;justify-content:flex-end;align-items:flex-start}`);
execFileSync(process.execPath, [path.join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs'),
  '-i', path.join(dir, 'input.css'), '-o', path.join(dir, 'style.css')], { cwd: root, stdio: 'pipe' });
await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="bundle.js"></script>');
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');
const {historyPreparationActivity:activity,installHistoryPreparationIpc}=require('./activity.cjs');
installHistoryPreparationIpc({ipcMain});global.activity=activity;global.leases=new Map();
const payload={ok:true,totalBytes:2400000000,orphanCount:0};
ipcMain.handle('system:process-metrics-ambient-start',()=>payload);
ipcMain.handle('system:process-metrics-ambient-stop',()=>{});
ipcMain.handle('system:process-metrics-subscribe',()=>({ok:true,projectTabs:[],otherTabs:[],app:{rows:[],totalBytes:2400000000,totalCpu:0},totals:{allBytes:2400000000}}));
ipcMain.handle('system:process-metrics-unsubscribe',()=>{});
app.whenReady().then(()=>{app.dock?.hide();global.fixture=new BrowserWindow({width:820,height:520,show:false,focusable:false,
 webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true,backgroundThrottling:false}});
global.fixture.webContents.on('paint',()=>{});global.fixture.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});});
app.on('window-all-closed',()=>app.quit());`);
execFileSync(process.execPath, ['--check', path.join(dir, 'main.cjs')], { stdio: 'pipe' });

let app;
const result = { artifacts: dir, errors: [] };
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env, timeout: 30000 });
  const page = await app.firstWindow(); page.on('pageerror', error => result.errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.locator('#root button').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#root button')?.textContent.includes('ГБ'));
  const sample = () => page.evaluate(() => {
    const b = document.querySelector('#root button'), icon = b.querySelector('svg');
    return { width: b.getBoundingClientRect().width, text: b.textContent,
      color: getComputedStyle(icon).color, active: icon.getAttribute('data-history-preparation'),
      animations: icon.getAnimations().length };
  });
  result.before = await sample();
  await app.evaluate(() => global.leases.set('A', global.activity.begin({ kind: 'resume', tabId: 'A', bytes: 60e6 })));
  await page.locator('[data-history-preparation="active"]').waitFor();
  await page.locator('#root button').first().hover();
  result.active = await sample();
  assert.equal(result.active.color, 'rgb(232, 121, 168)');
  assert.equal(result.active.animations, 0);
  assert.equal(result.active.width, result.before.width);
  assert.equal(result.active.text, result.before.text);
  await page.keyboard.down('Meta');
  await page.getByText('Загрузка истории: Resume test', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(dir, 'preparing.png') });
  await page.keyboard.up('Meta');
  await page.locator('#root button').first().click();
  assert.ok(await page.getByText('Память', { exact: true }).count());
  assert.equal((await sample()).color, 'rgb(232, 121, 168)', 'panel open does not overwrite preparation color');
  await page.mouse.click(20, 480);
  await app.evaluate(() => global.leases.set('B', global.activity.begin({ kind: 'history', bytes: 20e6 })));
  await app.evaluate(() => global.leases.get('A')());
  assert.equal((await sample()).active, 'active');
  await page.evaluate(() => window.fixtureUnmount());
  await page.waitForFunction(() => !document.querySelector('#root button'));
  await app.evaluate(() => global.leases.get('B')());
  await page.evaluate(() => window.fixtureMount());
  await page.waitForFunction(() => document.querySelector('#root button') && !document.querySelector('[data-history-preparation="active"]'));
  await page.evaluate(() => window.fixturePrewarm(3));
  await page.locator('[data-history-preparation="active"]').waitFor();
  await page.evaluate(() => window.fixturePrewarm(0));
  await page.waitForFunction(() => !document.querySelector('[data-history-preparation="active"]'));
  result.after = await sample();
  assert.equal(result.after.width, result.before.width); assert.equal(result.after.text, result.before.text);
  assert.deepEqual(result.errors, []);
  result.engine = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome,
    visible: global.fixture.isVisible(), focused: global.fixture.isFocused() }));
  assert.equal(result.engine.focused, false); result.status = 'pass';
} catch (error) { result.status = 'fail'; result.error = error.stack; process.exitCode = 1; }
finally { await app?.close(); await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
