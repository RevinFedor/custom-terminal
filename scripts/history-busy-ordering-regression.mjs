#!/usr/bin/env node
// Immutable standalone HistoryPanel renderer. No Noted main, DB, PTY, native
// input, installed app connection or real IPC/API. Only our Electron is closed.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-busy-'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = new Map(), report = { dir, checks: [], errors: [] };
const candidates = new Scanner({ sources: [{ base: path.join(root, 'src'), pattern: '**/*.{ts,tsx,js,jsx}', negated: false }] }).scan();
function shim() {
  const f = window.__busyFixture = { calls: [], violations: [], entries: [] };
  const listeners = new Map();
  const denied = name => { f.violations.push(name); throw new Error('Fixture denied ' + name); };
  const result = (channel, payload) => {
    f.calls.push(channel);
    if (/terminal:(create|input|paste|kill)|claude:send|codex:send|shell:/.test(channel)) return denied(channel);
    if (channel === 'agent-transcript:get-history') return { success: true, entries: f.entries, revision: { token: String(f.entries.length) } };
    if (channel === 'agent-session:get-availability-batch') return { success: true,
      results: payload.sessions.map(s => ({ ...s, state: 'available', historyState: 'available' })) };
    if (channel === 'agent:get-send-receipts') return { success: true, records: [] };
    if (channel === 'agent-transcript:get-terminal-preview') return { success: true, preview: null };
    if (/subscribe|unsubscribe|acknowledge/.test(channel)) return { success: true };
    if (/list|catalog|prompts/.test(channel)) return [];
    if (channel === 'app:getState') return null;
    return { success: true };
  };
  const ipc = {
    invoke: (channel, payload) => Promise.resolve(result(channel, payload)),
    send: result, sendSync: result,
    on(channel, fn) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); return ipc; },
    once(channel, fn) { const one = (...args) => { ipc.removeListener(channel, one); fn(...args); }; return ipc.on(channel, one); },
    removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return ipc; },
    emit(channel, ...args) { for (const fn of listeners.get(channel) || []) fn(...args); },
  };
  const fakePath = { sep: '/', basename: p => p.split('/').pop(), dirname: p => p.slice(0, p.lastIndexOf('/')),
    join: (...p) => p.join('/'), resolve: (...p) => p.join('/'), isAbsolute: p => p.startsWith('/'), extname: () => '' };
  window.require = name => {
    if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', writeText: () => denied('clipboard') }, webFrame: { getZoomFactor: () => 1 } };
    if (name === 'path') return fakePath;
    if (name === 'process') return { platform: 'darwin', env: { NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: '/fixture' } };
    if (name === 'fs') return { promises: {} };
    return denied('require:' + name);
  };
  window.process = window.require('process');
  window.fetch = () => Promise.reject(new Error('Fixture denies network'));
  window.WebSocket = class { constructor() { denied('WebSocket'); } };
  window.EventSource = class { constructor() { denied('EventSource'); } };
}
const bundle = await build({ entryPoints: [path.join(root, 'scripts/fixtures/history-busy-ordering.tsx')],
  bundle: true, write: false, format: 'iife', platform: 'browser', outfile: path.join(dir, 'renderer.js'),
  alias: { '@noted/claude-blocks': path.join(root, 'packages/claude-blocks/src'),
    '@noted/structured-dnd': path.resolve(root, '../noted-shared/packages/structured-dnd/src'),
    react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom') },
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  external: ['../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  plugins: [{ name: 'capture-source', setup(b) {
    b.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs|css)$/ }, async args => {
      if (args.path.includes('/node_modules/')) return;
      let contents = await fs.readFile(args.path, 'utf8'); sources.set(args.path, { sha256: sha(contents) });
      if (args.path === path.join(root, 'src/renderer/styles/globals.css')) {
        const compiler = await compile(contents, { base: path.dirname(args.path), onDependency() {} });
        contents = compiler.build(candidates);
      }
      const ext = path.extname(args.path).slice(1);
      return { contents, loader: ['mjs', 'cjs'].includes(ext) ? 'js' : ext };
    });
  } }], logLevel: 'silent',
});
for (const output of bundle.outputFiles) await fs.writeFile(output.path, output.contents);
for (const [file, metadata] of sources) assert.equal(sha(await fs.readFile(file)), metadata.sha256, 'parallel edit during bundle: ' + file);
await fs.writeFile(path.join(dir, 'source-manifest.json'), JSON.stringify(Object.fromEntries(sources), null, 2));
await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css">
<style>body{margin:0;background:#181818;color:#ddd;font:16px sans-serif}#root{position:fixed;inset:0;display:flex}</style>
<div id="root"></div><script>(${shim.toString()})()</script><script src="renderer.js"></script>`);
await fs.writeFile(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, 'user-data'))});app.setActivationPolicy?.('accessory');app.disableHardwareAcceleration();
app.whenReady().then(()=>{app.dock?.hide();const w=new BrowserWindow({width:1000,height:1100,show:false,
webPreferences:{nodeIntegration:false,contextIsolation:true,offscreen:true,backgroundThrottling:false}});
w.webContents.on('paint',()=>{});w.webContents.setFrameRate(60);w.loadFile(${JSON.stringify(path.join(dir, 'index.html'))});});
app.on('window-all-closed',()=>app.quit());`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: dir, env });
  const page = await app.firstWindow();
  page.on('pageerror', e => report.errors.push(e.message));
  await page.waitForFunction(() => window.__busyFixture?.seed && document.querySelector('[data-history-row-real]'), null, { timeout: 15000 });
  await page.evaluate(() => window.__busyFixture.seed('failed'));
  await page.waitForFunction(() => window.__busyFixture.snapshot().texts.some(t => t.includes('LIVE ANSWER')), null, { timeout: 10000 });
  const checkOrder = async name => {
    const snapshot = await page.evaluate(() => window.__busyFixture.snapshot());
    const text = snapshot.texts.join('\n');
    for (const [a, b] of [['ACCEPTED REQUEST', 'LIVE ANSWER'], ['LIVE ANSWER', 'LATER NOTICE'], ['LATER NOTICE', 'FUTURE INPUT']]) {
      assert.ok(text.includes(a) && text.includes(b) && text.indexOf(a) < text.indexOf(b), `${name}: ${a} before ${b}: ${text}`);
    }
    for (const label of ['FAILED EARLIER SEND', 'ACCEPTED REQUEST', 'LIVE ANSWER', 'LATER NOTICE', 'FUTURE INPUT']) {
      assert.equal(text.split(label).length - 1, 1, `${name}: one ${label}`);
    }
    assert.deepEqual(snapshot.violations, []);
    report.checks.push({ name, snapshot });
    await page.screenshot({ path: path.join(dir, name + '.png') });
    return snapshot;
  };
  assert.equal((await checkOrder('busy-interleaving')).busy, true);
  await page.evaluate(() => window.__busyFixture.promote());
  await page.waitForFunction(() => window.__busyFixture.snapshot().handoffs.find(h => h.id === 'old')?.status === 'sent'
    && !document.querySelector('[data-history-session]').textContent.includes('SEND FAILED'));
  await checkOrder('late-exact-receipt');
  await page.evaluate(() => window.__busyFixture.finish());
  await page.waitForFunction(() => !window.__busyFixture.snapshot().handoffs.some(h => h.id === 'accepted'), null, { timeout: 10000 });
  await checkOrder('durable-no-duplicates');
  assert.deepEqual(report.errors, []);
  report.status = 'pass';
} catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
finally {
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, status: report.status, checks: report.checks.map(c => c.name), errors: report.errors, error: report.error }));
  await app?.close();
}
