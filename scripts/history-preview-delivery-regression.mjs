#!/usr/bin/env node
// A private off-screen Electron process, actual HistoryPanel/Virtuoso, controlled
// incoming IPC only. No provider, PTY, production API, shared DB or rollout.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { runCanonicalPreviewCases } from './history-preview-canonical-cases.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const canonicalHandoff = process.argv.includes('--canonical-handoff');
const fixtureName = canonicalHandoff ? 'history-preview-canonical' : 'history-preview-delivery';
const canonicalCase = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) || 'hidden-rebind';
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-preview-delivery-'));
const snapshot = path.join(artifact, 'source');
const result = { artifact, checks: [], errors: [], rollback: false };
const logs = [];
let app;
let worktree = false;
let staticServer;
try {
  execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  worktree = true;
  for (const name of ['src', 'packages/claude-blocks']) {
    await fs.cp(path.join(repo, name), path.join(snapshot, name), { recursive: true,
      filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
  }
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  for (const name of ['history-preview-reading.tsx', `${fixtureName}.tsx`]) {
    await fs.copyFile(path.join(repo, 'scripts/fixtures', name), path.join(snapshot, 'scripts/fixtures', name));
  }
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  const shared = path.join(artifact, 'noted-shared/packages');
  for (const name of ['structured-dnd', 'file-explorer']) {
    await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(shared, name), {
      recursive: true, filter: p => !p.includes('/node_modules') });
  }
  result.sourceHash = createHash('sha256').update(await fs.readFile(path.join(snapshot,
    'src/renderer/components/Workspace/HistoryPanel.tsx'))).digest('hex');
  await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures', `${fixtureName}.tsx`)],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm',
    target: 'chrome120', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'),
      '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    plugins: [{ name: 'electron-fixture', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const ipcRenderer=window.require("electron").ipcRenderer;' })); } }],
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot,
    'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  await fs.writeFile(path.join(artifact, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc}</style><script type="module" src="bundle.js"></script>');
  await fs.mkdir(path.join(artifact, 'user-data'));
  await fs.writeFile(path.join(artifact, 'preload.cjs'), 'const{ipcRenderer}=require("electron");ipcRenderer.invoke=async(channel,...args)=>{if(channel.includes("list")||channel.includes("List"))return[];if(channel.includes("getState")||channel.includes("get-state"))return null;return{success:true};};');
  staticServer = createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://127.0.0.1').pathname) || 'index.html';
    try { const body = await fs.readFile(path.join(artifact, name));
      res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${staticServer.address().port}/`;
  await fs.writeFile(path.join(artifact, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({show:false,focusable:false,width:720,height:1150,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,preload:${JSON.stringify(path.join(artifact, 'preload.cjs'))}}});w.webContents.on('paint',()=>{});w.loadURL(${JSON.stringify(url)});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: path.join(artifact, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.lease = { pid: app.process().pid, cwd: artifact, main: path.join(artifact, 'main.cjs'), staticUrl: url, api: 'none' };
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => result.errors.push(e.message));
  page.on('console', m => logs.push(m.text()));
  await page.screenshot({ path: path.join(artifact, 'initial.png') });
  await page.waitForFunction(() => window.fixture?.ready && !!document.querySelector('[data-history-viewport-ready="1"]'));
  if (canonicalHandoff) {
    await runCanonicalPreviewCases(page, { artifact, result, logs, scenario: canonicalCase });
  } else {
  await page.evaluate(() => window.fixture.held());
  const held = page.locator('[data-preview-item-id="held-291"]');
  await held.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-preview-item-id="held-291"]')
    ?.textContent.includes(window.fixture.text.trim()));
  assert((await held.textContent()).includes(await page.evaluate(() => window.fixture.text.trim())));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', { detail: { tabId: window.fixture.tabId } })));
  await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s.scrollHeight - s.clientHeight - s.scrollTop <= 2; });
  const inspect = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-preview-item-id]')).map(n => {
    const badge = n.querySelector('.cb-message-status');
    const spinner = n.querySelector('.cb-message-status-spinner');
    const rect = badge.getBoundingClientRect();
    const viewport = n.closest('[data-virtuoso-scroller]').getBoundingClientRect();
    const style = getComputedStyle(badge);
    return {
      id: n.getAttribute('data-preview-item-id'), phase: n.getAttribute('data-response-phase'),
      label: badge.textContent, spinner: !!spinner,
      spinnerAnimation: spinner ? getComputedStyle(spinner).animationName : null,
      rowPosition: getComputedStyle(n).position,
      badge: { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        display: style.display, visibility: style.visibility, opacity: style.opacity,
        inViewport: rect.width > 0 && rect.height > 0 && rect.left >= viewport.left
          && rect.right <= viewport.right && rect.top >= viewport.top && rect.bottom <= viewport.bottom },
    };
  }));
  const assertVisibleBadges = blocks => {
    for (const block of blocks) {
      assert.equal(block.rowPosition, 'relative', 'load the same conversation styles as the application');
      assert.equal(block.badge.display, 'flex');
      assert.equal(block.badge.visibility, 'visible');
      assert.equal(block.badge.opacity, '1');
      assert.equal(block.badge.inViewport, true, JSON.stringify(block));
    }
  };
  let blocks = await inspect();
  assert.equal(blocks.length, 1); assert.match(blocks[0].label, /Response · history not confirmed/);
  assert.equal(blocks[0].spinner, false);
  assertVisibleBadges(blocks);
  result.held = blocks;
  await page.screenshot({ path: path.join(artifact, 'held.png') });
  result.checks.push('settled unconfirmed text is retained with truthful label, no spinner');
  await page.evaluate(() => window.fixture.continued());
  await page.locator('[data-preview-item-id="active-293"]').waitFor();
  await page.waitForFunction(() => { const s = document.querySelector('[data-virtuoso-scroller]'); return s.scrollHeight - s.clientHeight - s.scrollTop <= 2; });
  blocks = await inspect(); assert.equal(blocks.length, 2);
  assert.match(blocks[0].label, /history not confirmed/); assert.equal(blocks[0].phase, 'settled');
  assert.match(blocks[1].label, /Live response/); assert.equal(blocks[1].phase, 'streaming');
  assert.equal(blocks[0].spinner, false); assert.equal(blocks[1].spinner, true);
  assert.notEqual(blocks[1].spinnerAnimation, 'none');
  assertVisibleBadges(blocks);
  assert(blocks[0].badge.y + blocks[0].badge.height <= blocks[1].badge.y,
    'independent response status badges must not overlap');
  result.continued = blocks;
  await page.screenshot({ path: path.join(artifact, 'continued.png') });
  result.checks.push('same-turn next request has its own live block; held item stays separate');
  await page.evaluate(() => window.fixture.completed());
  await page.waitForFunction(() => document.querySelector('[data-preview-item-id="active-293"]').getAttribute('data-response-phase') === 'settled');
  blocks = await inspect(); assert(blocks.every(b => !b.spinner && !b.label.includes('Live')));
  await page.evaluate(() => window.fixture.held());
  await page.waitForFunction(() => document.querySelectorAll('[data-preview-item-id]').length === 1);
  const node = await held.elementHandle();
  await page.evaluate(() => window.fixture.held());
  assert.equal(await node.evaluate(n => n.isConnected), true, 'metadata update must not remount its stable item');
  await page.evaluate(() => window.fixture.adopt());
  await page.waitForFunction(() => !document.querySelector('[data-history-terminal-preview]'));
  result.final = await page.evaluate(() => {
    const s = document.querySelector('[data-virtuoso-scroller]');
    const rows = Array.from(document.querySelectorAll('[data-history-row-real]')).filter(n => n.textContent.includes(window.fixture.text.trim()));
    return { canonicalRows: rows.length, canonicalIds: rows.map(n => n.getAttribute('data-uuid')),
      bottomGap: s.scrollHeight - s.clientHeight - s.scrollTop,
      previewRows: document.querySelectorAll('[data-history-terminal-preview]').length };
  });
  assert.equal(result.final.canonicalRows, 1); assert.equal(result.final.previewRows, 0);
  assert(result.final.bottomGap <= 2);
  await page.screenshot({ path: path.join(artifact, 'adopted.png') });
  result.checks.push('late exact canonical identity adopts once across live/durable alias, no duplicate, bottom preserved');
  await page.evaluate(() => window.fixture.destroy());
  assert.equal(await page.locator('[data-history-preview-fixture]').count(), 0);
  result.rollback = true;
  assert.deepEqual(result.errors, []);
  result.verdict = 'PASS';
  }
} catch (error) { result.verdict = result.checks.length ? 'FAIL' : 'BLOCKED'; result.failure = error.stack;
  if (app) { try { const page = await app.firstWindow();
    await page.screenshot({ path: path.join(artifact, 'failure.png') });
    result.lastCheckpoint = await page.evaluate(() => Array.from(document.querySelectorAll('[data-preview-item-id]'))
      .map(n => ({ id: n.getAttribute('data-preview-item-id'), text: n.textContent.slice(0, 100), chars: n.textContent.length })));
  } catch {} }
}
finally {
  if (app) await app.close();
  if (staticServer) await new Promise(resolve => staticServer.close(resolve));
  if (worktree) execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
  result.cleanup = true;
  await fs.writeFile(path.join(artifact, 'logs.txt'), logs.filter(l => /TERMINAL_PREVIEW|SURFACE_OWNER|LOAD_APPLY|FILE_REPLACED/.test(l)).join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
if (result.verdict !== 'PASS') process.exitCode = 1;
