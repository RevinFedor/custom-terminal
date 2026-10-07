#!/usr/bin/env node
// Actual isolated archive component; synthetic versioned callbacks, no Main/provider/OS/user data.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-global-tab-archive-')));
const files = ['src/renderer/components/Workspace/GlobalTabArchive.tsx', 'src/renderer/components/Workspace/GlobalTabArchive.css',
  'src/renderer/utils/globalTabArchive.mjs', 'src/renderer/utils/globalTabArchive.test.mjs',
  'scripts/fixtures/global-tab-archive.tsx', 'scripts/global-tab-archive-regression.mjs'];
const result = { artifact, status: 'running', checks: [], errors: [], hashes: {}, cleanup: false };
let app, child;
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  for (const file of files) {
    const dest = path.join(artifact, 'source', file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const data = await fs.readFile(path.join(repo, file)); await fs.writeFile(dest, data);
    result.hashes[file] = hash(data);
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(artifact, 'source/node_modules'));
  const bundle = await build({ entryPoints: [path.join(artifact, 'source/scripts/fixtures/global-tab-archive.tsx')],
    outfile: path.join(artifact, 'bundle.js'), bundle: true, sourcemap: true, metafile: true,
    platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' } });
  await fs.writeFile(path.join(artifact, 'bundle-inputs.json'), JSON.stringify(bundle.metafile, null, 2));
  await fs.writeFile(path.join(artifact, 'index.html'), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0;background:#19191b}#root{display:flex}</style><div id="root"></div><script src="bundle.js"></script>');
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(artifact, 'profile'))});app.setActivationPolicy?.('accessory');
app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:!/^(file:|data:|blob:)/.test(d.url)}));
const win=new BrowserWindow({show:false,focusable:false,width:800,height:820,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});win.webContents.on('paint',()=>{});win.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], cwd: artifact, env });
  child = app.process(); result.pid = child.pid;
  const page = await app.firstWindow(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => result.errors.push(error.message));
  const check = value => result.checks.push(value);
  // Attribute values are JSON; use evaluate identity then trusted locator click by nth.
  const selectRow = async (namespace, id) => {
    const index = await page.locator('[data-archive-record]').evaluateAll((nodes, target) => nodes.findIndex(node => {
      const [, ns, rowId] = JSON.parse(node.getAttribute('data-archive-record')); return ns === target.namespace && rowId === target.id;
    }), { namespace, id });
    assert.ok(index >= 0); await page.locator('[data-archive-record]').nth(index).click();
  };
  await page.locator('[data-archive-record]').first().waitFor();
  assert.equal(await page.locator('[data-archive-record]').count(), 4);
  await selectRow('legacy', 7);
  assert.match(await page.locator('[data-private-preview]').innerText(), /old-sid/);
  assert.equal(await page.evaluate(() => window.archiveFixture.calls.length), 0);
  check('All inactive records, pre-opaque IDs and file rows visible; ordinary selection only previews exact saved session');

  for (const width of [350, 800, 1440]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 820), width);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const list = document.querySelector('.gta-list').getBoundingClientRect(), detail = document.querySelector('.gta-details').getBoundingClientRect();
      return { list: { x: list.x, y: list.y, right: list.right, bottom: list.bottom }, detail: { x: detail.x, y: detail.y },
        overflow: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(geometry.overflow <= 1);
    if (width <= 800) assert.ok(geometry.detail.y >= geometry.list.bottom - 1);
    else assert.ok(geometry.detail.x >= geometry.list.right - 1);
    await page.screenshot({ path: path.join(artifact, `archive-${width}.png`), fullPage: true });
  }
  check('350/800 stacked and 1440 columns, no horizontal overflow; screenshots captured');

  await page.getByLabel('Поиск архива').fill('legacy draft');
  assert.equal(await page.locator('[data-archive-record]').count(), 1);
  await page.getByLabel('Поиск архива').fill('');
  await page.getByLabel('Фильтр workflow').selectOption('a');
  assert.equal(await page.locator('[data-archive-record]').count(), 2);
  await page.getByLabel('Фильтр директории').selectOption('/old/dir');
  assert.equal(await page.locator('[data-archive-record]').count(), 0);
  await page.getByLabel('Фильтр workflow').selectOption(''); await page.getByLabel('Фильтр директории').selectOption('');
  check('Global text/workflow/exact-cwd filters include deleted workflow context');

  await selectRow('legacy', 7);
  await page.evaluate(() => { window.archiveFixture.delay = true; window.archiveFixture.mode = 'false'; });
  await page.locator('[data-archive-open]').click();
  assert.equal(await page.locator('[data-archive-open]').isDisabled(), true);
  await page.locator('[data-archive-open]').dispatchEvent('click'); // Additional adversarial event, not the trusted proof.
  assert.equal(await page.evaluate(() => window.archiveFixture.calls.length), 1);
  const first = await page.evaluate(() => window.archiveFixture.calls[0].request);
  assert.equal(first.namespace, 'legacy'); assert.equal(first.historyId, 7); assert.equal(first.targetWorkflowId, 'i');
  assert.equal(first.expectedRevision, 1); assert.ok(!('expectedTabId' in first));
  assert.deepEqual(first.record.assets, [{ id: 'stable-asset' }]);
  await page.evaluate(() => { window.archiveFixture.release(); window.archiveFixture.delay = false; });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-archive-record]').count(), 4);
  check('Delayed false restore deduped; exact legacy address/revision/assets and Inbox fallback; no optimistic removal');

  await page.evaluate(() => { window.archiveFixture.mode = 'true'; });
  await page.locator('[data-archive-open]').click();
  await page.waitForFunction(() => window.archiveFixture.reads >= 2 && !document.querySelector('[data-archive-open]').disabled);
  const retry = await page.evaluate(() => window.archiveFixture.calls[1].request);
  assert.deepEqual(retry, first);
  assert.match(await page.getByRole('status').innerText(), /запись архива сохранена/);
  assert.equal(await page.locator('[data-archive-record]').count(), 4);
  check('Unknown/false receipt retry preserves intent ID and frozen payload; restore-delete-failure keeps record');

  await selectRow('other', 7); await page.getByLabel('Куда восстановить').selectOption('a');
  await page.evaluate(() => { window.archiveFixture.mode = 'foreign'; });
  await page.locator('[data-archive-open]').click(); await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /другой записи/);
  await page.evaluate(() => { window.archiveFixture.mode = 'true'; });
  await page.locator('[data-archive-open]').click();
  await page.waitForFunction(() => window.archiveFixture.calls.length >= 4 && !document.querySelector('[data-archive-open]').disabled);
  const current = await page.evaluate(() => window.archiveFixture.calls[3].request);
  assert.equal(current.expectedTabId, 'opaque'); assert.equal(current.targetWorkflowId, 'a'); assert.equal(current.record.claude_session_id, 'new-sid');
  check('Same integer ID in another namespace routes exact opaque owner and explicit target');

  await page.getByRole('button', { name: 'Переименовать', exact: true }).click();
  await page.getByLabel('Название записи').fill('Renamed saved tab');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => window.archiveFixture.history.some(row => row.name === 'Renamed saved tab'));
  await page.getByRole('button', { name: 'Изменить заметки', exact: true }).click();
  await page.getByLabel('Заметки записи').fill('Updated stored notes');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await page.evaluate(() => window.archiveFixture.history[1].notes), 'Other draft');
  await page.getByRole('button', { name: 'Изменить заметки', exact: true }).click();
  await page.getByLabel('Заметки записи').fill('Updated stored notes');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForFunction(() => window.archiveFixture.history[1].notes === 'Updated stored notes' && !document.querySelector('[data-archive-open]').disabled);
  await page.getByRole('button', { name: 'В избранное', exact: true }).click();
  await page.waitForFunction(() => window.archiveFixture.calls.some(call => call.kind === 'favorite') && !document.querySelector('[data-archive-open]').disabled);
  const add = await page.evaluate(() => window.archiveFixture.calls.find(call => call.kind === 'favorite').request);
  assert.equal(add.record.claude_session_id, 'new-sid'); assert.equal(add.record.notes, 'Updated stored notes');
  check('Exact rename callback; notes edit cancelled without mutation');

  await page.locator('[data-archive-delete]').click();
  await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.archiveFixture.calls.filter(call => call.kind === 'delete').length), 0);
  await page.locator('[data-archive-delete]').click();
  await page.evaluate(() => { window.archiveFixture.revision++; });
  await page.locator('[data-archive-confirm]').click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Stale revision/);
  assert.equal(await page.evaluate(() => window.archiveFixture.history.length), 4);
  await page.keyboard.press('Escape');
  await page.getByLabel('Обновить архив').click();
  await page.waitForFunction(() => document.querySelector('.gta-list').getAttribute('aria-busy') === 'false');
  // Explicit fresh intent is allowed only following the audited not-applied disposition.
  await page.locator('[data-archive-delete]').click(); await page.locator('[data-archive-confirm]').click();
  await page.waitForFunction(() => window.archiveFixture.history.length === 3);
  const deletes = await page.evaluate(() => window.archiveFixture.calls.filter(call => call.kind === 'delete'));
  assert.notEqual(deletes[0].request.requestId, deletes[1].request.requestId);
  assert.equal(deletes[1].request.namespace, 'other'); assert.equal(deletes[1].request.historyId, 7);
  await selectRow('file', 9); await page.locator('[data-archive-delete]').click();
  await page.evaluate(() => { window.archiveFixture.delay = true; });
  await page.locator('[data-archive-confirm]').click();
  assert.equal(await page.locator('[data-archive-confirm]').isDisabled(), true);
  await page.locator('[data-archive-confirm]').dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.archiveFixture.calls.filter(call => call.kind === 'delete' && call.request.namespace === 'file').length), 1);
  await page.evaluate(() => { window.archiveFixture.release(); window.archiveFixture.delay = false; });
  await page.waitForFunction(() => window.archiveFixture.history.length === 2);
  assert.ok(await page.evaluate(() => window.archiveFixture.history.some(row => row.namespace === 'legacy' && row.id === 7)));
  check('Delete confirmation Escape + exact stale-revision refusal; deleting file archive row only calls archive callback');

  await selectRow('other', 8);
  assert.equal(await page.locator('[data-archive-open]').isDisabled(), true);
  assert.equal(await page.locator('[data-archive-delete]').isDisabled(), true);
  assert.match(await page.locator('.gta-details').innerText(), /Restore lease active/);
  check('Protected lease rows remain readable with all mutations disabled');

  await page.getByRole('tab', { name: /Избранное/ }).click();
  await selectRow('favorite', 11);
  await page.evaluate(() => { window.archiveFixture.mode = 'missing'; });
  await page.locator('[data-archive-open]').click(); await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-archive-record]').count(), 1);
  await page.evaluate(() => { window.archiveFixture.mode = 'true'; });
  await page.locator('[data-archive-open]').click();
  await page.waitForFunction(() => !document.querySelector('[data-archive-open]').disabled);
  const favorite = await page.evaluate(() => window.archiveFixture.calls.filter(call => call.kind === 'open').at(-1).request);
  assert.equal(favorite.favoriteId, 11); assert.equal(favorite.namespace, 'favorite');
  assert.equal(favorite.record.notes, 'Saved notes'); assert.deepEqual(favorite.record.assets, ['exact']);
  assert.equal(favorite.record.codex_session_id, 'favorite-sid');
  await page.locator('[data-archive-delete]').click(); await page.locator('[data-archive-confirm]').click();
  await page.waitForFunction(() => window.archiveFixture.favorites.length === 0);
  check('Favorites unknown ACK retained; exact command/provider/notes/assets forwarded; removal only after confirmation/receipt');

  await page.getByRole('tab', { name: /Архив/ }).click();
  await page.getByLabel('Поиск архива').fill('two iterations');
  await page.getByLabel('Тип поиска').selectOption('iterations');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-archive-record]').length === 2);
  await page.locator('[data-archive-record]').nth(1).click();
  assert.match(await page.locator('[data-private-preview]').innerText(), /iteration-2/);
  await page.evaluate(() => { window.archiveFixture.delaySearch = true; });
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByLabel('Поиск архива').fill('Protected');
  await page.evaluate(() => { window.archiveFixture.releaseSearch(); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-archive-record]').count(), 1);
  assert.equal(await page.evaluate(() => window.archiveFixture.searches[0].version), 1);
  check('Multiple exact iteration hits preview read-only; delayed stale search cannot replace current filters');
  await page.evaluate(() => { window.archiveFixture.failRead = true; });
  await page.getByLabel('Обновить архив').click(); await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('[data-archive-record]').count(), 1);
  await page.evaluate(() => { window.archiveFixture.failRead = false; });
  await page.getByLabel('Обновить архив').click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Обновить архив"]').disabled);
  assert.equal(await page.getByRole('alert').count(), 0);
  check('Read failure preserves last known records and refresh is retryable');
  assert.deepEqual(result.errors, []);
  result.sourceDrift = [];
  for (const file of files) if (hash(await fs.readFile(path.join(repo, file))) !== result.hashes[file]) result.sourceDrift.push(file);
  assert.deepEqual(result.sourceDrift, []); result.status = 'pass';
} catch (error) { result.status = 'fail'; result.failure = error.stack || String(error); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {});
  const pid = child?.pid;
  let gone = true; if (pid) { try { process.kill(pid, 0); gone = false; } catch {} }
  result.processClosed = gone;
  await fs.rm(path.join(artifact, 'profile'), { recursive: true, force: true });
  result.cleanup = gone;
  await fs.writeFile(path.join(artifact, 'manifest.json'), JSON.stringify(result.hashes, null, 2));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ artifact, status: result.status, checks: result.checks.length, errors: result.errors, cleanup: result.cleanup, failure: result.failure }));
}
