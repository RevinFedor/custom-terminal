#!/usr/bin/env node
// Private offscreen UI: actual TSX/stores/plan operations, mocked IPC transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-task-plan-popover-'));
const snapshot = path.join(artifact, 'source');
const result = { artifact, pass: false, checks: [], errors: [], sources: {} };
let app;
try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name), { recursive: true, filter: p => !p.includes('/node_modules') });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/task-plan-popover.tsx'), path.join(snapshot, 'scripts/fixtures/task-plan-popover.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), { recursive: true, filter: p => !p.includes('/node_modules') });
  for (const name of ['src/renderer/components/Workspace/TabTaskPlanPanel.tsx', 'src/renderer/components/Workspace/TaskPlanPopover.tsx', 'src/renderer/store/useUIStore.ts', 'src/renderer/store/useWorkspaceStore.ts', 'src/main/tab-task-plan.js'])
    result.sources[name] = createHash('sha256').update(await fs.readFile(path.join(snapshot, name))).digest('hex');
  await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/task-plan-popover.tsx')], bundle: true, sourcemap: true,
    outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent', external: ['crypto'],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'), '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  function shim() {
    const listeners = new Map(), saved = new Map();
    const f = window.taskFixture = { calls: [], unknown: [], violations: [], underlayClicks: 0 };
    const deny = value => { f.violations.push(value); throw Error('Fixture forbids ' + value); };
    const response = (c, p) => {
      if (c === 'app:getState') return saved.get(p) ?? null;
      if (c === 'app:setState') { saved.set(p.key, p.value); return { success: true }; }
      if (c === 'tab-work-context:get') return { success: true, context: { tabId: p.tabId, responsibility: 'Область задач и редактора. '.repeat(30), revision: 1, files: [], updates: [], pendingCount: 0 } };
      if (/^tab-task-plan:(apply|undo|redo)$/.test(c)) return f.operation(c, p);
      if (c === 'file:read-directory') return [{ name: 'план.md', path: '/fixture/docs/tmp/план.md', isDirectory: false }];
      if (/^(terminal:(input|paste|create|kill)|codex:|claude:|agent:|shell:)/.test(c)) return deny(c);
      if (/^(tab:|project:|log:|renderer:|perf:)/.test(c)) return { success: true };
      if (/list|catalog|get-models|get-prompts|prompts:get/.test(c)) return [];
      f.unknown.push(c); return null;
    };
    const ipc = { invoke: (c, ...a) => { f.calls.push(c); return Promise.resolve().then(() => structuredClone(response(c, a[0]))); },
      send: (c, ...a) => response(c, a[0]), sendSync: (c, ...a) => response(c, a[0]),
      on(c, cb) { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return ipc; },
      once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
      off(c, cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c, cb) { return ipc.off(c, cb); }, removeAllListeners(c) { listeners.delete(c); } };
    window.require = name => {
      if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', availableFormats: () => [], writeText: () => deny('clipboard') }, shell: { openExternal: () => deny('shell') }, webFrame: { getZoomFactor: () => 1 } };
      if (name === 'crypto') return { randomUUID: () => crypto.randomUUID() };
      if (name === 'path') return { sep: '/', join: (...s) => s.join('/').replace(/\/+/g, '/'), basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '', isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/') };
      if (name === 'node:v8') return { deserialize: v => v };
      if (name === 'node:buffer') return { Buffer: { from: v => v } };
      if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true' } };
      if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
      return deny('require:' + name);
    };
    window.process = window.require('process');
    window.fetch = () => Promise.reject(Error('Fixture network denied'));
    window.WebSocket = class { constructor() { deny('WebSocket'); } };
    window.EventSource = class { constructor() { deny('EventSource'); } };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1b1b1b;color:#ccc;font-family:Arial,sans-serif}*{box-sizing:border-box}button,textarea,input{font-family:inherit}</style><div id="root"></div><script>(${shim.toString()})()</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact,'user-data'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));const w=new BrowserWindow({show:false,focusable:false,width:1100,height:700,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  const page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', e => result.errors.push(e.stack || e.message));
  await page.screenshot({ path: path.join(artifact, 'initial.png') });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const owner = page.locator('[data-owner-fixture] [data-tab-task-plan]');
  const topic = i => owner.locator(`[data-task-plan-topic="task-${i}"]`);
  const editor = page.locator('[data-task-plan-popup="editor"]');
  const preview = page.locator('[data-task-plan-popup="preview"]');
  const outside = async () => {
    const r = await page.locator('[data-underlay]').boundingBox();
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  };
  await owner.locator('[data-tab-responsibility]').waitFor(); await frames();
  const geometry = await owner.evaluate(n => { const r=n.getBoundingClientRect();return { height:r.height, width:r.width, scroll:n.querySelector('[data-task-plan-topic-strip]').scrollWidth }; });
  assert.ok(geometry.height <= 30, JSON.stringify(geometry)); assert.equal(await owner.locator('[data-task-plan-topic]').count(),7);
  assert.ok(await owner.locator('[data-task-plan-overflow]').isVisible());
  const stripY = await owner.locator('[data-task-plan-topic]').evaluateAll(ns => ns.map(n=>n.getBoundingClientRect().y));
  assert.equal(new Set(stripY).size,1); result.checks.push('responsibility/New/topics/controls share one line; overflow count visible; no wrapping');
  await topic(0).hover(); await preview.waitFor(); await frames();
  assert.match(await preview.innerText(), /Отступы/);
  const pv=await preview.boundingBox(), root=await owner.boundingBox();assert.ok(pv.width < root.width);assert.ok(pv.y >= root.y+root.height-2);
  await preview.screenshot({ path:path.join(artifact,'hover.png') });
  await page.mouse.move(20,660);await frames();assert.equal(await preview.count(),0);
  result.checks.push('hover preview below strip is narrower than panel and closes on leave');
  await topic(0).click();await editor.waitFor();await page.mouse.move(20,660);await frames();assert.equal(await editor.count(),1);
  assert.equal(await editor.locator('button[title="Назад · Cmd+Z"]').count(),0);
  await editor.getByTitle('Редактировать').first().click();await page.keyboard.press('Meta+A');await page.keyboard.insertText('Отступы изменены');
  await editor.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await frames();
  assert.equal(await editor.count(),0);assert.equal(await page.evaluate(()=>window.taskFixture.state().items[0].title),'Отступы изменены');
  assert.equal(await page.evaluate(()=>window.taskFixture.state('other').items[0].title),'Отступы');
  result.checks.push('click editor survives roaming; X commits exact task, other owner unchanged');
  await topic(0).click();await editor.waitFor();await editor.getByTitle('Редактировать').first().click();await page.keyboard.press('Meta+A');await page.keyboard.insertText('Сохранение с отказом');
  await page.evaluate(()=>window.taskFixture.failNext=true);await editor.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await frames();
  assert.equal(await editor.count(),1);assert.equal(await editor.locator('textarea').inputValue(),'Сохранение с отказом');
  await editor.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await frames();assert.equal(await editor.count(),0);
  result.checks.push('failed save keeps editor and draft; explicit retry saves');
  await topic(0).click();await editor.waitFor();await outside();await frames();
  assert.equal(await editor.count(),0);assert.equal(await page.evaluate(()=>window.taskFixture.underlayClicks),0);
  result.checks.push('outside overlay dismiss does not activate underlying action');
  await topic(0).click();await editor.waitFor();await editor.getByTitle('Редактировать').first().click();await page.keyboard.press('Meta+A');await page.keyboard.insertText('@план');
  const picker=page.locator('[data-task-plan-file-picker]');await picker.waitFor();await page.mouse.move(20,660);await frames();assert.equal(await editor.count(),1);
  await outside();await frames();assert.equal(await picker.count(),0);assert.equal(await editor.count(),1);
  await page.keyboard.press('Escape');await frames();assert.equal(await editor.count(),1);
  await page.keyboard.press('Escape');await frames();assert.equal(await editor.count(),0);
  result.checks.push('file-picker cancellation closes one level; editing Escape and editor Escape remain separate');
  await owner.locator('[data-task-plan-overflow]').click();await frames();
  const moved=await owner.locator('[data-task-plan-topic-strip]').evaluate(n=>n.scrollLeft);assert.ok(moved>0);
  await page.evaluate(()=>window.taskFixture.titles(false));await frames();
  assert.equal(await owner.locator('[data-task-plan-topic]').first().innerText(),'×1');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('noted-terminal-task-status-marker')).showTitles),false);
  await topic(0).hover();await preview.waitFor();assert.match(await preview.innerText(),/Сохранение с отказом/);
  result.checks.push('overflow action scrolls; manual marker-only preference persists and preserves hover access');
  await page.mouse.move(20,660);await page.evaluate(()=>window.taskFixture.titles(true));await frames();
  const other=page.locator('[data-other-fixture] [data-task-plan-topic="task-0"]');await other.click();await editor.waitFor();await frames();
  const edge=await editor.boundingBox();assert.ok(edge.x>=8&&edge.x+edge.width<=1092);await editor.screenshot({path:path.join(artifact,'right-edge-editor.png')});
  await page.keyboard.press('Escape');await frames();
  await owner.getByTitle('Новая задача',{exact:true}).click();await editor.waitFor();await editor.locator('textarea').waitFor();
  assert.equal(await editor.locator('textarea').evaluate(n=>document.activeElement===n),true);
  await page.keyboard.press('Meta+A');await page.keyboard.insertText('Новая мысль');await page.keyboard.press('Enter');await frames();
  assert.equal(await page.evaluate(()=>window.taskFixture.state().items.at(-1).title),'Новая мысль');
  await editor.getByRole('button',{name:'Закрыть задачу',exact:true}).click();await frames();
  result.checks.push('right-edge placement stays in viewport; New opens editor directly and saves through original plan operations');
  await owner.locator('[data-task-plan-header]').focus();await page.keyboard.press('Meta+z');await frames();
  assert.equal(await page.evaluate(()=>window.taskFixture.state().items.at(-1).title),'Новая задача');
  await page.keyboard.press('Meta+Shift+z');await frames();
  assert.equal(await page.evaluate(()=>window.taskFixture.state().items.at(-1).title),'Новая мысль');
  assert.equal(await owner.locator('[data-task-plan-footer]').count(),0);
  result.checks.push('removed footer preserves keyboard undo/redo on the plan');
  await topic(0).click();await editor.waitFor();await editor.locator('[data-task-plan-editor]').click({button:'right'});
  const actions=page.locator('[data-task-plan-action-menu]');await actions.waitFor();await page.keyboard.press('Escape');await frames();
  assert.equal(await actions.count(),0);assert.equal(await editor.count(),1);
  await topic(0).click();await frames();assert.equal(await editor.count(),0);
  result.checks.push('context-menu Escape is top-only; repeated topic trigger closes its editor');
  await owner.locator('[data-task-plan-header]').focus();await page.keyboard.press('Enter');await frames();
  await owner.locator('[data-task-plan-open="task-0"]').click({button:'right'});await actions.waitFor();
  await actions.getByText('Отметить выполненной',{exact:true}).click();await frames();
  assert.equal(await page.evaluate(()=>window.taskFixture.state().archivedItems[0].id),'task-0');
  await owner.locator('[data-task-plan-archive-toggle]').click();await frames();
  await owner.locator('[data-task-plan-open="task-0"]').click({button:'right'});await actions.waitFor();
  await actions.getByText('Вернуть в активное',{exact:true}).click();await frames();
  assert.ok(await page.evaluate(()=>window.taskFixture.state().items.some(t=>t.id==='task-0')));
  result.checks.push('expanded list, archive and restoration remain available through existing actions');
  await page.screenshot({path:path.join(artifact,'final.png')});
  const safety=await page.evaluate(()=>({unknown:window.taskFixture.unknown,violations:window.taskFixture.violations}));
  assert.deepEqual(safety.violations,[]);assert.deepEqual(safety.unknown,[]);assert.deepEqual(result.errors,[]);
  result.pass=true;
} catch(error) { result.error=error.stack||String(error); }
finally { if(app)try{await app.close();result.closed=true;}catch{} await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2)); }
if(!result.pass)process.exitCode=1;
