#!/usr/bin/env node
// Frozen actual Settings components in owned offscreen Electron. No product Main,
// user storage, process controls, native focus, clipboard or real file removal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
// Darwin aliases /var to /private/var. Canonicalize before module aliases so
// fixture stores cannot accidentally bundle twice under two absolute paths.
const artifact = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-workflow-settings-')));
const snapshot = path.join(artifact, 'source');
const result = { artifact, status: 'running', checks: [], widths: [], errors: [], sources: {}, cleanup: false };
let app, child;
try {
  await fs.cp(path.join(repo, 'src'), path.join(snapshot, 'src'), { recursive: true });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  for (const file of ['workflow-settings.tsx', 'workflow-settings-stores.ts']) {
    await fs.copyFile(path.join(repo, 'scripts/fixtures', file), path.join(snapshot, 'scripts/fixtures', file));
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const stores = path.join(snapshot, 'scripts/fixtures/workflow-settings-stores.ts');
  const bundle = await build({
    entryPoints: [path.join(snapshot, 'scripts/fixtures/workflow-settings.tsx')],
    bundle: true, metafile: true, sourcemap: true, outfile: path.join(artifact, 'bundle.js'),
    platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'private-stores', setup(builder) {
      builder.onResolve({ filter: /\/store\/use(?:Workspace|UI)Store$/ }, () => ({ path: stores }));
    } }],
  });
  await fs.writeFile(path.join(artifact, 'bundle-inputs.json'), JSON.stringify(bundle.metafile, null, 2));
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const full = path.resolve(input);
    if (full.startsWith(snapshot)) result.sources[path.relative(snapshot, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
  }
  const cssInput = path.join(snapshot, 'src/renderer/styles/globals.css');
  result.sources['src/renderer/styles/globals.css'] = createHash('sha256').update(await fs.readFile(cssInput)).digest('hex');
  result.sources['scripts/workflow-settings-regression.mjs'] = createHash('sha256').update(await fs.readFile(path.join(repo, 'scripts/workflow-settings-regression.mjs'))).digest('hex');
  for (const file of ['src/renderer/components/UI/SettingsModal.tsx', 'scripts/workflow-settings-wiring.test.mjs']) {
    result.sources[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
  }
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', cssInput, '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });

  function installAdapters() {
    const f = window.settingsFixture = { calls: [], workflowCalls: [], violations: [], receipts: {}, revision: 5,
      icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7355aa"/><circle cx="32" cy="32" r="19" fill="#ddd"/></svg>'),
      tabBindings:{'source-a':['r1'],'source-b':[]},
      roots: [{ id: 'r1', name: 'Source', path: '/synthetic/source', enabled: true, kind: 'prompt', revision: 3, future: { retained: true }, icon: null },
        { id: 'missing', name: 'Missing root', path: '/synthetic/missing', enabled: false, kind: 'cwd', revision: 2, missing: true }],
    };
    const respond = async (channel, payload) => {
      f.calls.push({ channel, payload: payload ? structuredClone(payload) : undefined });
      if (channel === 'workflow:list-roots') {
        if (f.failRead) throw new Error('Root read failed');
        if (f.malformed) return { version: 1, roots: [] };
        return structuredClone({ version: 1, revision: f.revision, roots: f.roots, bindings: { immutable: ['tab-owner'] }, future: true });
      }
      if(channel==='workflow:tab-roots')return structuredClone({version:1,revision:f.revision,roots:f.roots,rootIds:f.tabBindings[payload] || [],sources:[]});
      if(channel==='project-prompts:set-tab-sources'){
        if(payload.expectedRevision!==f.revision)return {success:false,error:'root_revision_changed'};
        f.tabBindings[payload.tabId]=[...payload.rootIds];return {success:true};
      }
      if (channel === 'app:select-directory') return f.cancelChooser ? null : '/synthetic/chosen';
      if (channel === 'workflow:save-root' || channel === 'workflow:remove-root') {
        if (f.delayMutation) await new Promise(resolve => { f.releaseMutation = resolve; });
        if (f.receipts[payload.mutationId]) return f.receipts[payload.mutationId];
        if (payload.expectedRevision !== f.revision) return { success: false, error: 'stale_revision' };
        if (channel === 'workflow:remove-root') {
          const root = f.roots.find(x => x.id === payload.id);
          if (!root || payload.expectedRootRevision !== root.revision) return { success: false, error: 'stale_root' };
          f.roots = f.roots.filter(x => x.id !== payload.id);
        } else {
          const current = f.roots.find(x => x.id === payload.id);
          const updated = { ...(current || { id: 'root-' + f.revision }), path: payload.path, name: payload.name, enabled: payload.enabled, kind: payload.kind, revision: (current?.revision || 0) + 1 };
          f.roots = current ? f.roots.map(x => x.id === current.id ? updated : x) : [...f.roots, updated];
        }
        f.revision++;
        f.receipts[payload.mutationId] = { success: true };
        if (f.loseReply) { f.loseReply = false; throw new Error('Reply lost after commit'); }
        return { success: true };
      }
      f.violations.push(channel); throw new Error('Unexpected channel ' + channel);
    };
    window.require = name => {
      if (name === 'electron') return { ipcRenderer: { invoke: respond } };
      throw new Error('Forbidden require ' + name);
    };
  }
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;font-family:Arial}button{cursor:pointer}</style><div id="root"></div><script>(${installAdapters.toString()})();</script><script src="bundle.js"></script>`);
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
global.win=new BrowserWindow({show:false,focusable:false,width:800,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
win.webContents.on('paint',()=>{});win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  child = app.process(); result.pid = child.pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(9000);
  page.on('pageerror', error => result.errors.push(error.stack || error.message));
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const check = name => result.checks.push(name);
  const roots = page.locator('[data-directory-roots]');
  const calls = () => page.evaluate(() => window.settingsFixture.calls);
  const workflow = name => page.getByRole('region', { name: 'Workflow ' + name, exact: true });
  await roots.getByText('Missing root', { exact: true }).waitFor();
  assert.equal(await page.getByText('Директория недоступна', { exact: true }).count(), 1);
  await page.locator('[data-fixture-workflow-settings]').click({button:'right'});
  const scoped=page.locator('[data-workflow-settings-modal="b"]');await scoped.waitFor();
  assert.equal(await scoped.locator('section[aria-label^="Workflow "]').count(),1);
  assert.equal(await scoped.locator('[data-directory-roots]').count(),0);
  assert.equal(await scoped.getByRole('button',{name:'Создать workflow в фоне'}).count(),0);
  const scopedName=scoped.locator('section[aria-label^="Workflow "] input');
  await scopedName.fill('Scoped workflow');await scopedName.press('Enter');
  assert.equal(await page.evaluate(()=>window.settingsFixture.getSpaces().find(x=>x.id==='b').name),'Scoped workflow');
  assert.equal(await page.evaluate(()=>window.settingsFixture.getSpaces().find(x=>x.id==='a').name),'Development');
  await page.screenshot({path:path.join(artifact,'workflow-scoped-modal.png')});
  await scoped.getByRole('textbox',{name:'Workflow default directory'}).fill('/synthetic/workflow-b');
  await scoped.getByRole('button',{name:'Save workflow directory'}).click();
  assert.equal(await page.evaluate(()=>window.settingsFixture.getSpaces().find(x=>x.id==='b').defaultCwd),'/synthetic/workflow-b');
  assert.equal(await page.evaluate(()=>window.settingsFixture.getSpaces().find(x=>x.id==='a').defaultCwd),undefined);
  await scoped.getByRole('button',{name:'Sources',exact:true}).click();
  await scoped.locator('[data-prompt-source-root-id="r1"]').check();
  await scoped.getByRole('button',{name:'Save',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.settingsFixture.tabBindings),{'source-a':['r1'],'source-b':['r1']});
  await page.screenshot({path:path.join(artifact,'workflow-directory-sources.png')});
  check('Workflow default directory is metadata; Sources binds the explicitly selected tab, not all workflow members');
  await scopedName.fill('Inbox');await scopedName.press('Enter');
  await scoped.getByRole('button',{name:'Close workflow settings'}).click();
  check('Exact workflow modal edits the context target instead of active workflow; no other workflows/directories');
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await page.getByText('Проекты', { exact: true }).count(), 0);
  assert.equal(await workflow('Renamed system inbox').getByRole('button', { name: 'Системный Inbox нельзя удалить' }).isDisabled(), true);
  assert.equal(await workflow('Inbox').getByRole('button', { name: 'Удалить workflow «Inbox»', exact: true }).isEnabled(), true);
  check('Workflow-only settings; no project selector; Inbox protection by kind; missing and disabled roots retained');

  await workflow('Development').getByRole('button', { name: 'Переместить workflow «Development» вправо' }).click();
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.getSpaces().map(x => x.id)), ['b', 'a', 'inbox']);
  const name = workflow('Development').getByRole('textbox');
  await name.fill('Build'); await name.press('Enter');
  await workflow('Build').waitFor();
  await workflow('Build').getByRole('textbox').fill('Cancelled rename');
  await workflow('Build').getByRole('textbox').press('Escape');
  assert.equal(await workflow('Build').getByRole('textbox').inputValue(), 'Build');
  assert.equal(await page.evaluate(() => window.settingsFixture.workflowCalls.some(x => x.name === 'Cancelled rename')), false);
  await page.evaluate(() => { window.settingsFixture.delayCreate = true; });
  await page.getByRole('button', { name: 'Создать workflow в фоне' }).dblclick();
  assert.equal(await page.evaluate(() => window.settingsFixture.workflowCalls.filter(x => x.type === 'add').length), 1);
  await page.evaluate(() => { window.settingsFixture.releaseCreate(); window.settingsFixture.delayCreate = false; });
  await page.getByRole('textbox', { name: 'Название workflow Workflow', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.workflowCalls.find(x => x.type === 'add').options), { activate: false, name: 'Workflow' });
  check('Reorder, rename and background creation; async double-click cannot create twice');

  await workflow('Build').getByRole('button', { name: 'Обрезать иконку workflow «Build»' }).click();
  await page.getByRole('button', { name: 'Применить', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.waitForFunction(() => window.settingsFixture.workflowCalls.some(x => x.type === 'metadata' && x.metadata.icon?.startsWith('data:image/png')));
  assert.equal(await page.getByText('Обрезка иконки', { exact: true }).count(), 0);
  await workflow('Build').getByRole('button', { name: 'Сбросить иконку workflow «Build»' }).click();
  await page.waitForFunction(() => window.settingsFixture.getSpaces().find(x => x.id === 'a').icon === null);
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.getSpaces().find(x => x.id === 'a').future), { preserved: true });
  check('Actual canvas crop saves PNG through workflow metadata; reset preserves unrelated metadata');

  const svg = Buffer.from((await page.evaluate(() => window.settingsFixture.icon)).split(',')[1], 'base64');
  // CDP intercepts the file chooser before its click: no native OS picker.
  const interceptedChooser = page.waitForEvent('filechooser');
  await workflow('Build').getByRole('button', { name: 'Выбрать цветную иконку workflow «Build»' }).click();
  await (await interceptedChooser).setFiles({ name: 'private-icon.svg', mimeType: 'image/svg+xml', buffer: svg });
  await page.evaluate(() => { window.settingsFixture.failIcon = true; });
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.getByText('Не удалось сохранить иконку. Попробуйте ещё раз.', { exact: false }).first().waitFor();
  assert.equal(await page.evaluate(() => window.settingsFixture.getSpaces().find(x => x.id === 'a').icon), null);
  await page.screenshot({ path: path.join(artifact, 'crop-refused.png'), fullPage: true });
  await page.evaluate(() => { window.settingsFixture.failIcon = false; });
  await page.getByRole('button', { name: 'Применить', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#icon-cropper-title'));
  check('Actual file input/crop failure retains modal and stored icon; explicit retry succeeds');

  await roots.getByRole('button', { name: 'Source', exact: false }).first().click();
  await page.getByRole('textbox', { name: 'Название директории' }).fill('Sources');
  await page.getByRole('button', { name: 'Сохранить директорию' }).click();
  await roots.getByText('Sources', { exact: true }).waitFor();
  const saved = (await calls()).find(x => x.channel === 'workflow:save-root').payload;
  assert.equal(saved.expectedRevision, 5); assert.equal(saved.id, 'r1'); assert.equal(saved.kind, 'prompt');
  assert.ok(saved.mutationId); assert.equal('icon' in saved, false);
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.roots.find(x => x.id === 'r1').future), { retained: true });
  check('Exact registry revision; edited root scope and unknown metadata preserved; no implicit binding expansion');

  await roots.getByRole('button', { name: 'Директория', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать директорию', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Путь директории' }).inputValue(), '/synthetic/chosen');
  await page.getByRole('textbox', { name: 'Название директории' }).fill('Independent');
  await page.evaluate(() => { window.settingsFixture.delayMutation = true; });
  await page.getByRole('button', { name: 'Сохранить директорию' }).dblclick();
  assert.equal((await calls()).filter(x => x.channel === 'workflow:save-root').length, 2);
  await page.evaluate(() => { window.settingsFixture.releaseMutation(); window.settingsFixture.delayMutation = false; });
  await roots.getByText('Independent', { exact: true }).waitFor();
  assert.equal((await calls()).filter(x => x.channel === 'workflow:save-root').at(-1).payload.kind, 'cwd');
  check('Independent directory chooser and create; delayed double-submit guarded');

  await roots.getByRole('button', { name: 'Убрать регистрацию Missing root' }).click();
  await page.locator('[data-directory-remove-confirm]').getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal((await calls()).filter(x => x.channel === 'workflow:remove-root').length, 0);
  await roots.getByRole('button', { name: 'Убрать регистрацию Missing root' }).click();
  await page.locator('[data-directory-remove-confirm]').getByRole('button', { name: 'Убрать регистрацию', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-directory-root="missing"]'));
  const removed = (await calls()).find(x => x.channel === 'workflow:remove-root').payload;
  assert.deepEqual({ id: removed.id, expectedRevision: removed.expectedRevision, expectedRootRevision: removed.expectedRootRevision }, { id: 'missing', expectedRevision: 7, expectedRootRevision: 2 });
  check('Cancel preserves registry; explicit unregister carries exact registry and root revisions; no disk deletion IPC');

  await page.evaluate(() => { window.settingsFixture.failRead = true; });
  await roots.getByRole('button', { name: 'Обновить директории' }).click();
  await roots.getByRole('alert').waitFor();
  assert.equal(await roots.getByText('Sources', { exact: true }).count(), 1);
  assert.equal(await roots.getByRole('button', { name: 'Директория', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.settingsFixture.failRead = false; window.settingsFixture.malformed = true; });
  await roots.getByRole('button', { name: 'Прочитать заново' }).click();
  await roots.getByText('Неподдерживаемый ответ реестра директорий', { exact: false }).waitFor();
  assert.equal(await roots.getByRole('button', { name: 'Директория', exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.settingsFixture.malformed = false; });
  await roots.getByRole('button', { name: 'Прочитать заново' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-directory-roots] [role="alert"]'));
  check('Read failure and malformed schema retain rows and forbid empty overwrite; reread recovery');

  await roots.getByRole('button', { name: 'Sources', exact: false }).first().click();
  await page.getByRole('textbox', { name: 'Название директории' }).fill('Conflicting edit');
  await page.evaluate(() => { window.settingsFixture.revision++; });
  await page.getByRole('button', { name: 'Сохранить директорию' }).click();
  await roots.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Название директории' }).inputValue(), 'Conflicting edit');
  assert.equal(await roots.getByRole('button', { name: 'Повторить запрос' }).count(), 0);
  assert.equal(await page.evaluate(() => window.settingsFixture.roots.find(x => x.id === 'r1').name), 'Sources');
  await roots.getByRole('button', { name: 'Прочитать заново' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-directory-roots] [role="alert"]'));
  await roots.getByRole('button', { name: 'Отмена', exact: true }).click();
  check('Known stale refusal does not resubmit/rebase or overwrite server; draft retained for explicit decision');

  await roots.getByRole('button', { name: 'Sources', exact: false }).first().click();
  await page.getByRole('textbox', { name: 'Название директории' }).fill('Committed once');
  await page.evaluate(() => { window.settingsFixture.loseReply = true; });
  await page.getByRole('button', { name: 'Сохранить директорию' }).click();
  await roots.getByRole('button', { name: 'Повторить запрос' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Название директории' }).isDisabled(), true);
  await roots.getByRole('button', { name: 'Повторить запрос' }).click();
  await roots.getByText('Committed once', { exact: true }).waitFor();
  const retries = (await calls()).filter(x => x.channel === 'workflow:save-root').slice(-2);
  assert.deepEqual(retries[0].payload, retries[1].payload);
  assert.equal(await page.evaluate(() => window.settingsFixture.roots.find(x => x.id === 'r1').revision), 5);
  check('Lost commit reply retries identical mutation ID/envelope; controls prevent edits to unknown delivery');

  for (const width of [350, 800, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 1000), width);
    await frames();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifact, 'settings-' + width + '.png'), fullPage: true });
    result.widths.push(width);
  }
  await page.evaluate(() => window.settingsFixture.setSpaces([{ id: 'only', kind: 'ordinary', name: 'Last' }, { id: 'inbox', kind: 'inbox', name: 'System' }]));
  await workflow('Last').getByRole('button', { name: 'Удалить workflow «Last»' }).click();
  await page.waitForFunction(() => window.settingsFixture.getSpaces().length === 1);
  assert.equal(await workflow('System').getByRole('button', { name: 'Системный Inbox нельзя удалить' }).isDisabled(), true);
  check('Narrow widths do not overflow; last ordinary workflow can be deleted while system Inbox remains');
  assert.deepEqual(await page.evaluate(() => window.settingsFixture.violations), []);
  assert.deepEqual(result.errors, []);
  assert.equal(await app.evaluate(() => global.win.isFocused()), false);
  result.calls = await calls();
  result.workflowCalls = await page.evaluate(() => window.settingsFixture.workflowCalls);
  result.status = 'pass';
} catch (error) {
  result.status = 'fail'; result.error = error.stack; process.exitCode = 1;
} finally {
  await app?.close();
  await fs.rm(path.join(artifact, 'profile'), { recursive: true, force: true });
  result.cleanup = !child || child.exitCode !== null || child.signalCode !== null;
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(artifact, 'manifest.json'), JSON.stringify(result.sources, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, checks: result.checks.length, error: result.error, cleanup: result.cleanup }));
}
