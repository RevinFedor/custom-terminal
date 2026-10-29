// Private source-snapshot acceptance. No production API, userData or provider.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('..', import.meta.url));
const preflightOnly = process.env.TAB_MESSAGE_UI_PREFLIGHT === '1';
const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-tab-message-ui-'));
console.log('Tab message UI owned root:', artifactRoot);
const results = [];
const require = createRequire(import.meta.url);
after(async () => {
  await fs.writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({
    pass: results.length === 2 && results.every(result => result.pass), preflightOnly,
    guiExecuted: results.some(result => result.guiExecuted === true), results,
  }, null, 2));
  console.log('Tab message UI acceptance artifacts:', artifactRoot);
});

for (const width of [900, 350]) test(`${preflightOnly ? 'packaging preflight only' : 'isolated tracker, History hash/envelope guards and moved-source navigation'} at ${width}px`, { timeout: 90000 }, async () => {
  const artifact = path.join(artifactRoot, String(width));
  await fs.mkdir(artifact);
  const snapshot = path.join(artifact, 'source');
  let app;
  let instance;
  const errors = [];
  try {
    execFileSync('git', ['worktree', 'add', '--detach', snapshot, 'HEAD'], { cwd: repo, stdio: 'pipe' });
    for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name), { recursive: true, filter: p => !p.includes('/node_modules') && !p.includes('/.git') });
    await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
    const shared = path.join(artifact, 'noted-shared/packages');
    for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name), { recursive: true, filter: p => !p.includes('/node_modules') });
    await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
    await fs.copyFile(path.join(repo, 'scripts/fixtures/tab-message-ui.tsx'), path.join(snapshot, 'scripts/fixtures/tab-message-ui.tsx'));
    await fs.copyFile(path.join(repo, 'scripts/fixtures/codex-service-presentation.cjs'), path.join(snapshot, 'scripts/fixtures/codex-service-presentation.cjs'));
    const { makeServiceFixture, memoryPresentationStore } = require(path.join(snapshot, 'scripts/fixtures/codex-service-presentation.cjs'));
    const service = makeServiceFixture(memoryPresentationStore());
    const longBody = service.body + '\n' + 'Long answer paragraph. Details remain available after expanding.\n\n'.repeat(320)
      + '\nFULL ANSWER END';
    const longServices = [
      { name: 'browser', fixture: makeServiceFixture(memoryPresentationStore(), { sessionId: 'long-browser', body: longBody }) },
      { name: 'native', fixture: makeServiceFixture(memoryPresentationStore(), { sessionId: 'long-native', runKind: 'agent', body: longBody }) },
      { name: 'reply', fixture: makeServiceFixture(memoryPresentationStore(), { sessionId: 'long-reply', kind: 'tab-message', phase: 'reply', body: longBody }) },
      { name: 'mixed', fixture: makeServiceFixture(memoryPresentationStore(), { sessionId: 'long-mixed',
        runKind: 'agent', body: 'Start of answer.\n\n<saved_prompt name="Attached scope">\nScope body\n</saved_prompt>\n\n' + longBody }) },
      { name: 'ordinary', fixture: { content: longBody,
        entries: [{ uuid: 'long-ordinary', role: 'user', content: longBody }] } },
    ];
    await fs.writeFile(path.join(artifact, 'service-projection.json'), JSON.stringify(service.entries, null, 2));
    await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(Object.fromEntries(await Promise.all([
      'src/main/ipc/codex-data.js', 'src/main/history-prompt-presentations.js',
      'src/renderer/utils/historyOrchestrationPromptPresentation.mjs', 'src/renderer/components/Workspace/HistoryPanel.tsx',
      'src/main/main.js', 'src/main/web-server.js', 'src/main/message-loop-waits.js', 'src/main/message-return-proofs.js',
      'src/renderer/utils/tabMessageProjection.ts', 'src/renderer/components/Workspace/TabMessageTracker.tsx',
      'src/renderer/assets/sc-desktop.png',
      'scripts/fixtures/tab-message-ui.tsx',
    ].map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex')]))), null, 2));
    await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/tab-message-ui.tsx')], bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife', target: 'chrome120', jsx: 'automatic', logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
      alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'), '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
      loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl', '.png': 'dataurl' },
      plugins: [{ name: 'private-history-export', setup(b) { b.onLoad({ filter: /\/HistoryPanel\.tsx$/ }, async args => ({ contents: await fs.readFile(args.path, 'utf8') + '\nexport { HistoryUserEntry };', loader: 'tsx', resolveDir: path.dirname(args.path) })); } }],
    });
    const png = await fs.readFile(path.join(snapshot, 'src/renderer/assets/sc-desktop.png'));
    const bundled = await fs.readFile(path.join(artifact, 'bundle.js'), 'utf8');
    assert.ok(bundled.includes(png.toString('base64')), 'the real source PNG must be embedded, not replaced by a stub');
    await fs.writeFile(path.join(artifact, 'png-asset.json'), JSON.stringify({
      sha256: createHash('sha256').update(png).digest('hex'), bytes: png.length, loader: 'dataurl', embedded: true,
    }, null, 2));
    execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'), '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
    function shim() {
      const crypto = window.require('node:crypto');
      const listeners = new Map();
      const f = window.fixture = { calls: [], unknown: [], violations: [], navigation: [], copies: [], rewinds: [], deferred: {} };
      f.ownedPairs = {};
      const stamp = '2026-10-03T10:12:00.000Z';
      f.q = { messageId: 'q1', kind: 'question', sourceTabId: 'a', sourceTabName: 'Stored source A', sourceProjectId: 'pa', sourceSessionId: 'sa', targetTabId: 'b', targetTabName: 'Stored target B', targetProjectId: 'pb', targetSessionId: 'sb', deliveryState: 'sent', createdAt: stamp, updatedAt: stamp, textPreview: 'Which value?', textChars: 15 };
      f.q2 = { ...f.q, messageId: 'q2', sourceTabId: 'b', sourceTabName: 'Stored source B', sourceProjectId: 'pb', sourceSessionId: 'sb', targetTabId: 'a', targetTabName: 'Stored target A', targetProjectId: 'pa', targetSessionId: 'sa', deliveryState: 'queued', createdAt: '2026-10-03T10:11:00.000Z', textPreview: 'Second question' };
      f.r = { ...f.q2, messageId: 'r1', kind: 'reply', replyTo: 'q1', deliveryState: 'failed', error: 'Reverse delivery conflict', text: '| Key | Value |\n| --- | --- |\n| Exact | 42 |\n' };
      f.questionText = '  Exact question\n\nwith whitespace  ';
      const deny = c => { f.violations.push(c); throw Error('Forbidden fixture operation: ' + c); };
      const response = (c, p) => {
        if (c === 'tab-messages:list') {
          if (p.tabId !== 'a') return [];
          if (!f.listRead) { f.listRead = true; return new Promise(resolve => { f.listResolve = resolve; }); }
          return [f.q, f.q2];
        }
        if (c === 'tab-messages:get') {
          if (f.failRead) throw Error('Controlled read failure');
          if (f.hold === p.messageId) return new Promise(resolve => { f.deferred[p.messageId] = resolve; });
          if (f.ownedPairs[p.messageId]) return f.ownedPairs[p.messageId];
          return p.messageId === 'q1' ? { message: { ...f.q, replyMessageId: 'r1', answeredAt: stamp, text: f.questionText }, reply: f.r }
            : { message: { ...f.q2, text: 'Second exact question' } };
        }
        if (c === 'tab-messages:dismiss') {
          const pair = f.ownedPairs[p.messageId];
          if (p.tabId !== 'a' || pair?.message.sourceTabId !== p.tabId) return deny('foreign dismiss');
          pair.message = { ...pair.message, sourceDismissedAt: '2026-10-27T00:02:00Z', updatedAt: '2026-10-27T00:02:00Z' };
          return { message: pair.message };
        }
        if (c === 'orchestration:list-for-tab') return [];
        if (c === 'orchestration:get-settings') return null;
        if (c === 'build-install:status-for-tab') return { known: true, stale: false, error: null, jobs: [], revision: 1 };
        if (c === 'orchestration:open-research-job' || c === 'orchestration:open-research-browser') {
          if (typeof p?.runId !== 'string' || !p.runId) return deny('missing saved research run');
          return { success: true, jobId: 'fixture-' + p.runId, ...(c.endsWith('-browser') ? { tabId: 7 } : {}) };
        }
        if (c === 'app:getState') return null;
        if (c === 'tab-work-context:delivered-update') return { success: false };
        if (c === 'agent-session:get-availability-batch') return { success: true, results: [] };
        if (/^(agent:(send|stop|rewind)|terminal:(input|create|paste|kill)|claude-sdk:(start|send)|codex:(run|append-input)|shell:)/.test(c)) return deny(c);
        if (/^(app:setState|tab:|tab-task-plan:|project:|log:|renderer:|perf:)/.test(c)) return { success: true };
        if (/list|catalog|get-models|get-prompts|get-task-plan|prompts:get/.test(c)) return [];
        if (/get.*(busy|process-status|activity)|get-all-status/.test(c)) return {};
        f.unknown.push(c); return null;
      };
      const ipc = f.ipc = { invoke(c, ...a) { f.calls.push({ c, p: a[0] }); return Promise.resolve().then(() => response(c, a[0])); },
        send(c, ...a) { return response(c, a[0]); }, sendSync(c, ...a) { return response(c, a[0]); },
        on(c, cb) { if (!listeners.has(c)) listeners.set(c, new Set()); listeners.get(c).add(cb); return ipc; },
        once(c, cb) { const fn = (...a) => { ipc.off(c, fn); cb(...a); }; return ipc.on(c, fn); },
        off(c, cb) { listeners.get(c)?.delete(cb); return ipc; }, removeListener(c, cb) { return ipc.off(c, cb); },
        removeAllListeners(c) { listeners.delete(c); return ipc; }, emit(c, ...a) { for (const fn of listeners.get(c) || []) fn(...a); } };
      window.require = name => {
        if (name === 'node:crypto' || name === 'crypto') return crypto;
        if (name === 'electron') return { ipcRenderer: ipc, clipboard: { readText: () => '', writeText: text => f.copies.push(text), availableFormats: () => [] }, webFrame: { getZoomFactor: () => 1 } };
        if (name === 'process') return { platform: 'darwin', env: {} };
        if (name === 'path') return { sep: '/', basename: s => s.split('/').pop(), dirname: s => s.slice(0, s.lastIndexOf('/')) || '/', join: (...s) => s.join('/'), extname: s => s.includes('.') ? '.' + s.split('.').pop() : '', isAbsolute: s => s.startsWith('/'), resolve: (...s) => s.join('/'), relative: (a, b) => b.replace(a + '/', '') };
        if (name === 'net') return { createConnection: () => ({ on() { return this; }, unref() {}, destroy() {}, write() {} }) };
        return deny('require:' + name);
      };
      window.process = window.require('process');
      window.fetch = () => Promise.reject(Error('Fixture network disabled'));
      window.WebSocket = class { constructor() { deny('WebSocket'); } };
      window.EventSource = class { constructor() { deny('EventSource'); } };
    }
    if (preflightOnly) {
      const receipt = { width, pass: true, preflightOnly: true, guiExecuted: false,
        checks: ['actual imports bundled', 'real PNG embedded byte-exact', 'actual CSS packaged'], controlledPorts: true };
      results.push({ width, pass: true, artifact, preflightOnly: true, guiExecuted: false });
      await fs.writeFile(path.join(artifact, 'preflight.json'), JSON.stringify(receipt, null, 2));
      return;
    }
    await fs.writeFile(path.join(artifact, 'index.html'), `<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ccc;font-family:Arial,sans-serif}*{box-sizing:border-box}.cb-prose{font-size:12px}.cb-prose pre{max-width:100%;overflow:auto}</style><div id="root"></div><script>(${shim.toString()})()</script><script src="bundle.js"></script>`);
    await fs.writeFile(path.join(artifact, 'main.cjs'), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(artifact, 'user-data'))});app.setActivationPolicy?.('accessory');app.whenReady().then(()=>{app.dock?.hide();session.defaultSession.webRequest.onBeforeRequest((d,r)=>r({cancel:! /^(file:|data:|blob:)/.test(d.url)}));const w=new BrowserWindow({show:false,focusable:false,width:${width},height:850,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});w.webContents.on('paint',()=>{});w.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { _electron: electron } = await import('playwright');
    app = await electron.launch({ args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    instance = await app.evaluate(({ app, BrowserWindow }) => ({ pid: process.pid, executable: process.execPath,
      profile: app.getPath('userData'), version: process.versions.electron, windows: BrowserWindow.getAllWindows().map(window => ({
        id: window.id, url: window.webContents.getURL(), visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen(),
      })) }));
    assert.equal(instance.profile, path.join(artifact, 'user-data'));
    assert.equal(instance.windows.length, 1); assert.equal(instance.windows[0].visible, false); assert.equal(instance.windows[0].focused, false);
    assert.equal(instance.windows[0].offscreen, true);
    await fs.writeFile(path.join(artifact, 'instance.json'), JSON.stringify(instance, null, 2));
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.fixture?.listResolve);
    assert.equal(await page.evaluate(() => window.innerWidth), width);
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x.c === 'tab-messages:get').length), 0);
    await page.evaluate(() => {
      const f = window.fixture;
      f.ipc.emit('tab-messages:changed', {}, { message: f.q, reason: 'sent' });
      f.listResolve([{ ...f.q, deliveryState: 'queued', updatedAt: '2026-10-03T10:11:59.000Z' }, f.q2]);
    });
    const q1 = page.locator('[data-tab-message-row="q1"]');
    await q1.waitFor();
    assert.equal(await page.locator('[data-orchestration-status] [data-tab-message-row]').count(), 2);
    assert.equal(await page.locator('[data-orchestration-active-list]').count(), 0);
    assert.equal(await q1.locator('[data-tab-question-delivery]').getAttribute('data-tab-question-delivery'), 'sent');
    assert.equal(await page.locator('[data-tab-message-row="q2"] .animate-spin').count(), 0);
    await q1.locator('[data-tab-message-source]').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'pb', tabId: 'b' });
    assert.equal(await page.locator('[data-tab-message-preview]').count(), 0);
    assert.equal(await q1.locator('[data-tab-message-open]').count(), 1);
    assert.equal(await q1.locator('button[data-tab-message-stage]').count(), 0);
    await q1.locator('[data-tab-message-open]').click();
    await page.locator('[data-tab-message-body="r1"]').waitFor();
    assert.equal(await page.locator('[data-tab-message-preview] [data-tab-message-body][open]').count(), 0);
    await page.locator('[data-tab-message-body="q1"] > summary').click();
    await page.locator('[data-tab-message-body="r1"] > summary').click();
    await page.locator('[data-tab-message-preview="q1"] [data-tab-message-body="r1"] table').waitFor();
    assert.ok(await page.evaluate(() => window.fixture.calls.filter(x => x.c === 'tab-messages:get').length) <= 2);
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(x => x.c === 'tab-messages:get').every(x => x.p.messageId === 'q1')), true);
    assert.equal(await q1.locator('[data-tab-reply-delivery]').getAttribute('data-tab-reply-delivery'), 'failed');
    assert.equal(await q1.locator('[data-tab-question-delivery]').getAttribute('data-tab-question-delivery'), 'sent');
    await page.locator('[data-tab-message-body="q1"] [data-attachment-preview-copy]').click();
    assert.equal(await page.evaluate(() => window.fixture.copies.at(-1)), await page.evaluate(() => window.fixture.questionText));
    await page.locator('[data-tab-message-body="q1"] [data-tab-message-source]').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'pa', tabId: 'a' });
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-preview]'));
    await checkOwnedWaitStates();
    await q1.locator('[data-tab-message-open]').click();
    await page.locator('[data-tab-message-preview]').waitFor();
    const checkGeometry = async () => {
      const geometry = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-tab-message-row]')].map(el => el.getBoundingClientRect());
        const panel = document.querySelector('[data-tab-message-preview]');
        const body = panel?.lastElementChild;
        return { rowOverlap: rows.some((rect, i) => i > 0 && rect.top < rows[i - 1].bottom - 0.5),
          bodyOverflow: !!body && body.scrollWidth > body.clientWidth + 1,
          sourcesOverflow: [...document.querySelectorAll('[data-tab-message-source]')].some(el => el.getBoundingClientRect().right > window.innerWidth + 1),
          rowsOverflow: rows.some(rect => rect.left < 0 || rect.right > window.innerWidth + 1),
        };
      });
      assert.deepEqual(geometry, { rowOverlap: false, bodyOverflow: false, sourcesOverflow: false, rowsOverflow: false });
    };
    await checkGeometry();
    await page.screenshot({ path: path.join(artifact, 'desktop.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-preview]'));
    const history = page.locator('[data-history-fixture]');
    assert.equal(await history.locator('table').count(), 1);
    assert.equal(await history.locator('.cb-code-block').count(), 1);
    assert.equal((await history.innerText()).includes('APP ENVELOPE'), false);
    assert.equal((await history.innerText()).includes('Saved context'), true);
    assert.equal((await history.innerText()).includes('Stored source B'), true);
    await history.locator('.hp-context-update-chip').click();
    await page.waitForFunction(() => window.fixture.calls.some(x => x.c === 'tab-work-context:delivered-update'));
    assert.equal(await page.evaluate(() => window.fixture.calls.find(x => x.c === 'tab-work-context:delivered-update').p.prompt), await page.evaluate(() => window.fixture.history.content));
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(artifact, 'history-wide.png') });
    await history.getByRole('button', { name: 'Copy prompt', exact: true }).click({ force: true });
    assert.equal(await page.evaluate(() => window.fixture.copies.at(-1)), await page.evaluate(() => window.fixture.history.content));
    await history.getByRole('button', { name: 'Rewrite saved history to prompt', exact: true }).click({ force: true });
    assert.equal(await page.evaluate(() => window.fixture.rewinds.at(-1)), await page.evaluate(() => window.fixture.history.content));
    await history.locator('[data-tab-message-source]').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'pb', tabId: 'b' });
    const sourceChip = history.locator('[data-tab-message-source="b"]');
    const originalSourceColor = await sourceChip.locator('svg').evaluate(el => getComputedStyle(el).color);
    const projectReads = await page.evaluate(() => window.fixture.calls.filter(call => call.c === 'project:getById').length);
    await page.evaluate(() => window.fixture.moveSource());
    await page.waitForFunction(previousColor => {
      const icon = document.querySelector('[data-history-fixture] [data-tab-message-source="b"] svg');
      return icon && getComputedStyle(icon).color !== previousColor;
    }, originalSourceColor);
    assert.equal(await sourceChip.textContent(), 'Stored source B', 'the message keeps its stored label after a move/rename');
    assert.equal(await sourceChip.getAttribute('title'), 'Stored source B\npb\nb', 'stored project provenance is not rewritten');
    await sourceChip.click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'moved-project', tabId: 'b' });
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.c === 'project:getById').length), projectReads, 'a live exact ID needs no stored-project load');
    assert.equal(await history.getByRole('alert').count(), 0);
    await page.screenshot({ path: path.join(artifact, 'moved-source.png') });
    await page.evaluate(() => window.fixture.restoreSource());
    await page.evaluate(() => {
      const f = window.fixture;
      f.originalHistory = f.history;
      f.history = { ...f.history, semanticTags: [{ ...f.history.semanticTags[0], kind: 'orchestration', runId: 'completion-run', phase: 'completion', sourceTabId: 'a', sourceProjectId: 'pa', targetTabId: 'b', targetTabName: 'Executor B', targetProjectId: 'pb' }] };
      delete f.history.semanticTags[0].messageId;
      f.render();
    });
    await history.getByRole('button', { name: 'Открыть источник: Executor B' }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'pb', tabId: 'b' });
    await page.evaluate(() => {
      const f = window.fixture;
      f.history = { ...f.history, semanticTags: [{ ...f.history.semanticTags[0], runKind: 'external-research', targetTabId: null, targetTabName: 'ChatGPT' }] };
      f.render();
    });
    const research = history.locator('[data-history-research-result]');
    await research.getByText('Research', { exact: true }).waitFor();
    assert.equal(await history.locator('[data-tab-message-source]').count(), 0);
    assert.equal(await research.locator('[data-external-research-source="completion-run"]').count(), 2);
    await research.locator('[data-research-disclosure]').click();
    assert.equal(await history.locator('table').count(), 1);
    await page.screenshot({ path: path.join(artifact, 'external-completion.png') });
    await page.evaluate(entry => { window.fixture.history = entry; window.fixture.render(); }, service.entries[0]);
    await research.getByText('Research', { exact: true }).waitFor();
    const serviceBubble = history.locator('.cb-user-bubble');
    assert.equal(await research.locator('[data-external-research-source="service-run"]').count(), 2);
    assert.equal(await serviceBubble.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await serviceBubble.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    await research.locator('[data-research-disclosure]').click();
    assert.equal(await history.locator('table').count(), 1);
    assert.equal(await history.locator('.cb-code-block').count(), 1);
    assert.equal((await history.innerText()).includes('[orchestration-result'), false);
    assert.equal(await history.locator('[data-tab-message-source]').count(), 0, 'browser executor is not a fake native tab');
    await research.getByRole('button', { name: 'Copy original answer', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.copies.at(-1)), service.content);
    await history.getByRole('button', { name: 'Rewrite saved history to prompt', exact: true }).click({ force: true });
    assert.equal(await page.evaluate(() => window.fixture.rewinds.at(-1)), service.content);
    await page.screenshot({ path: path.join(artifact, 'canonical-astra-completion.png') });
    await page.evaluate(entry => { window.fixture.history = { ...entry, uuid: 'ordinary-quote', semanticTags: undefined }; window.fixture.render(); }, service.entries[0]);
    await page.waitForFunction(() => !document.querySelector('[data-history-fixture] .hp-history-user-bubble--orchestration'));
    assert.notEqual(await serviceBubble.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(124, 58, 237, 0.08)');
    assert.ok((await history.innerText()).includes('[orchestration-result'), 'a literal quote must retain its full text');
    for (const { name, fixture: long } of longServices) {
      await page.evaluate(entry => { window.fixture.history = entry; window.fixture.render(); }, long.entries[0]);
      const isResearch = name === 'browser';
      const expand = isResearch ? research.locator('[data-research-disclosure]') : history.getByRole('button', { name: /^Раскрыть полностью/ });
      await expand.waitFor();
      assert.equal(await expand.count(), 1, name + ': one collapsed message toggle');
      assert.equal(await history.locator('.cb-collapse-top').count(), 0);
      assert.equal((await history.innerText()).includes('FULL ANSWER END'), false, name + ': full answer leaked into collapsed view');
      assert.equal((await history.innerText()).includes('[orchestration-result'), false);
      const collapsedHeight = await serviceBubble.evaluate(node => node.getBoundingClientRect().height);
      if (name === 'native') {
        assert.equal(await serviceBubble.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(124, 58, 237, 0.08)');
        assert.equal(await serviceBubble.evaluate(node => getComputedStyle(node).borderTopColor), 'rgba(167, 139, 250, 0.2)');
      }
      if (isResearch) assert.equal(await research.locator('[data-research-full]').count(), 0, 'collapsed Research cannot retain its full body DOM');
      else assert.equal(await history.locator('.cb-prose').count(), 0, name + ': collapsed view must share the ordinary text preview');
      const previewText = (await history.locator(isResearch ? '.hp-research-result-excerpt' : '.cb-msg-text').allTextContents()).join('');
      assert.ok(previewText.length < 500, name + ': preview exceeds the shared 400-character budget');
      if (name === 'mixed') assert.equal(await history.getByText('Attached scope', { exact: true }).count(), 1);
      if (isResearch) await research.getByRole('button', { name: 'Copy original answer', exact: true }).click();
      else await history.getByRole('button', { name: 'Copy prompt', exact: true }).click({ force: true });
      const copied = await page.evaluate(() => window.fixture.copies.at(-1));
      if (name === 'mixed') {
        assert.ok(copied.includes(longBody), 'Copy retains the complete answer beside the restored prompt attachment');
        assert.ok(copied.includes('Scope body'), 'Copy retains the full attached scope');
      } else assert.ok(copied === long.content, name + ': Copy lost the hidden tail');
      await page.screenshot({ path: path.join(artifact, 'long-' + name + '-collapsed.png') });
      for (const position of ['top', 'bottom']) {
        await expand.click();
        await history.getByText(/FULL ANSWER END/).waitFor();
        assert.equal(await history.getByRole('button', { name: isResearch ? /^Collapse(?: Research)? answer/ : 'Свернуть', exact: !isResearch }).count(), 2);
        if (name !== 'ordinary') {
          assert.equal(await history.locator('table').count(), 1, name + ': expanded Markdown table missing');
          assert.equal(await history.locator('.cb-code-block').count(), 1, name + ': expanded Markdown code missing');
        }
        if (isResearch) assert.ok(await research.locator('[data-research-full]').evaluate(node => node.scrollHeight > node.clientHeight), 'the complete long answer is retained in its bounded scroller');
        else assert.ok(await serviceBubble.evaluate(node => node.getBoundingClientRect().height) > collapsedHeight * 3);
        assert.equal((await history.innerText()).includes('[orchestration-result'), false);
        if (isResearch) await research.locator(position === 'top' ? '.hp-research-result-toggle' : '[data-research-disclosure]').click();
        else await history.locator('.cb-collapse-' + position).getByRole('button', { name: 'Свернуть', exact: true }).click();
        await expand.waitFor();
        assert.equal((await history.innerText()).includes('FULL ANSWER END'), false);
        assert.ok(Math.abs(await serviceBubble.evaluate(node => node.getBoundingClientRect().height) - collapsedHeight) < 2,
          name + ': collapse did not return to preview geometry');
      }
      await history.getByRole('button', { name: 'Rewrite saved history to prompt', exact: true }).click({ force: true });
      assert.ok(await page.evaluate(() => window.fixture.rewinds.at(-1)) === long.content, name + ': Rewind lost the hidden tail');
      await page.evaluate(() => { window.fixture.forceExpanded = true; window.fixture.render(); });
      await history.getByText(/FULL ANSWER END/).waitFor();
      assert.equal(await history.locator('.cb-collapse-btn').count(), 0, name + ': full-text search view exposes collapse controls');
      if (isResearch) assert.equal(await research.locator('[data-research-disclosure]').count(), 0);
      await page.evaluate(() => { window.fixture.forceExpanded = false; window.fixture.render(); });
      await expand.waitFor();
    }
    await page.evaluate(() => { window.fixture.history = window.fixture.originalHistory; window.fixture.render(); });
    for (const kind of ['tab-message', 'orchestration']) {
      for (const transform of ['body-tabs', 'body-crlf', 'prefix-shift', 'same-length-body', 'same-length-prefix', 'saved-envelope-mismatch', 'missing-hash']) {
        const canonical = await page.evaluate(({ kind, transform }) => {
          const f = window.fixture;
          const prefix = 'deferred\tcontext\n';
          const envelope = 'APP ENVELOPE: message identity and instructions\n\n';
          const body = 'first\tvalue\r\nsecond\r\nthird\r\nEXACT ANSWER TAIL';
          const prepared = prefix + envelope + body;
          const content = transform === 'body-tabs' ? prefix + envelope + body.replace('\t', '    ')
            : transform === 'body-crlf' ? prefix + envelope + body.replaceAll('\r\n', '\n')
              : transform === 'same-length-body' ? prefix + envelope + body.replace('first', 'other')
                : transform === 'same-length-prefix' ? prefix.replace('context', 'changed') + envelope + body
                  : transform === 'prefix-shift' ? prefix.replace('\t', '    ') + envelope + body.replaceAll('\r\n', '\n') : prepared;
          f.history = { ...f.originalHistory, content, promptChips: [], semanticTags: [{
            ...f.originalHistory.semanticTags[0], kind, ...(kind === 'orchestration' ? { runId: 'guard-run', phase: 'completion' } : {}),
            envelopeStart: prefix.length, envelopeText: transform === 'saved-envelope-mismatch' ? envelope.replace('APP', 'OLD') : envelope,
            bodyStart: prefix.length + envelope.length, bodyEnd: prepared.length,
            bodyProjectionHash: transform === 'missing-hash' ? undefined : f.fingerprint(prepared),
          }] };
          f.render();
          return content;
        }, { kind, transform });
        await page.waitForFunction(content => document.querySelector('[data-history-fixture]')?.textContent.includes(content), canonical);
        assert.ok((await history.textContent()).includes(canonical), 'the full canonical text remains displayed');
        assert.equal(await history.locator('.cb-prose').count(), 0, 'unsafe projection keeps the ordinary full-text path');
        await history.getByRole('button', { name: 'Copy prompt', exact: true }).click({ force: true });
        assert.equal(await page.evaluate(() => window.fixture.copies.at(-1)), canonical);
        await history.getByRole('button', { name: 'Rewrite saved history to prompt', exact: true }).click({ force: true });
        assert.equal(await page.evaluate(() => window.fixture.rewinds.at(-1)), canonical);
      }
    }
    await page.screenshot({ path: path.join(artifact, 'canonical-offset-fallback.png') });
    await page.evaluate(() => { window.fixture.history = window.fixture.originalHistory; window.fixture.render(); });
    await page.evaluate(() => { window.fixture.hold = 'q2'; });
    await page.locator('[data-tab-message-row="q2"] [data-tab-message-open]').click();
    await page.waitForFunction(() => window.fixture.deferred.q2);
    // A narrow viewport puts the preview over the list; close it before
    // choosing another row while its previous body read is still pending.
    if (width === 350) await page.keyboard.press('Escape');
    await q1.locator('[data-tab-message-open]').click();
    await page.evaluate(() => window.fixture.deferred.q2({ message: { ...window.fixture.q2, text: 'LATE WRONG QUESTION' } }));
    assert.equal((await page.locator('[data-tab-message-preview]').innerText()).includes('LATE WRONG QUESTION'), false);
    await page.evaluate(() => window.fixture.ipc.emit('tab-messages:changed', {}, { message: { ...window.fixture.q, deliveryState: 'pending' }, reason: 'old-same-time' }));
    assert.equal(await q1.locator('[data-tab-question-delivery]').getAttribute('data-tab-question-delivery'), 'sent');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(350, 700));
    await page.waitForFunction(() => window.innerWidth === 350);
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-tab-message-preview]')?.getBoundingClientRect();
      return rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    const bounds = await page.locator('[data-tab-message-preview]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 350 && bounds.y >= 0 && bounds.y + bounds.height <= 700);
    await checkGeometry();
    await page.screenshot({ path: path.join(artifact, 'narrow.png') });
    await page.mouse.click(10, 650);
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-preview]'));
    await page.screenshot({ path: path.join(artifact, 'history-narrow.png') });
    await page.evaluate(() => { window.fixture.failRead = true; window.fixture.hold = null; });
    await page.locator('[data-tab-message-row="q2"] [data-tab-message-open]').click();
    await page.getByRole('button', { name: 'Повторить загрузку текста' }).waitFor();
    await page.evaluate(() => { window.fixture.failRead = false; });
    await page.getByRole('button', { name: 'Повторить загрузку текста' }).click();
    await page.locator('[data-tab-message-body="q2"] > summary').click();
    await page.getByText('Second exact question', { exact: true }).waitFor();
    async function checkOwnedWaitStates() {
    await page.keyboard.press('Escape');
    const emitOwned = async (id, patch) => page.evaluate(({ id, patch }) => {
      const f = window.fixture, pair = f.ownedPairs[id];
      pair.message = { ...pair.message, ...patch };
      f.ipc.emit('tab-messages:changed', {}, { message: pair.message, reason: 'controlled-owner-state' });
    }, { id, patch });
    await page.evaluate(() => {
      const f = window.fixture, id = 'owned-processing';
      const reply = { ...f.r, messageId: 'owned-reply', replyTo: id, deliveryState: 'queued', error: null, text: 'Owned received reply' };
      const message = { ...f.q, messageId: id, replyMessageId: reply.messageId, text: 'Owned processing question',
        createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
        loopWait: { revision: 1, state: 'returning', replyMessageId: reply.messageId, replyDeliveryState: 'queued' } };
      f.ownedPairs[id] = { message, reply };
      for (const item of [reply, message]) f.ipc.emit('tab-messages:changed', {}, { message: item });
    });
    const processing = page.locator('[data-tab-message-row="owned-processing"]');
    await processing.waitFor();
    assert.equal(await processing.locator('[data-tab-reply-delivery]').getAttribute('data-tab-reply-delivery'), 'queued');
    assert.match(await processing.locator('[data-tab-message-open]').getAttribute('title'), /В очереди/);
    await page.evaluate(() => {
      const f = window.fixture, pair = f.ownedPairs['owned-processing'];
      pair.reply = { ...pair.reply, deliveryState: 'unconfirmed', updatedAt: '2026-10-27T00:00:00Z' };
      f.ipc.emit('tab-messages:changed', {}, { message: pair.reply });
    });
    await emitOwned('owned-processing', { loopWait: { revision: 2, state: 'settled', replyDeliveryState: 'unconfirmed',
      disposition: 'reply_delivery_timeout', notice: { state: 'sent' } } });
    await page.waitForFunction(() => document.querySelector('[data-tab-message-row="owned-processing"] [data-tab-message-open]')?.title.includes('Доставка ответа не подтверждена'));
    assert.equal(await processing.locator('[data-tab-message-status-icon]').getAttribute('data-tab-message-status-icon'), 'error');
    assert.equal(await processing.locator('[data-tab-message-stage="reply"]').evaluate(node => getComputedStyle(node).color), 'rgb(251, 191, 36)');
    await processing.locator('[data-tab-message-source="b"]').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.at(-1)), { projectId: 'pb', tabId: 'b' });
    await processing.locator('[data-tab-message-open]').click();
    await page.locator('[data-tab-message-body="owned-reply"]').waitFor();
    await page.locator('[data-tab-message-body="owned-processing"] > summary').click();
    await page.evaluate(() => { window.fixture.rejectNavigation = true; });
    await page.locator('[data-tab-message-body="owned-processing"] [data-tab-message-source]').click();
    await page.waitForFunction(() => document.querySelector('[data-tab-message-body="owned-processing"] [data-tab-message-source]')?.title.includes('недоступна'));
    assert.equal(await page.locator('[data-tab-message-preview]').count(), 1, 'refused navigation must not close the original preview');
    await page.evaluate(() => { window.fixture.rejectNavigation = false; });
    await page.locator('[data-tab-message-body="owned-processing"] [data-tab-message-source]').click();
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-preview]'));
    await page.screenshot({ path: path.join(artifact, 'received-processing.png') });
    await emitOwned('owned-processing', { loopWait: { revision: 3, state: 'settled', replyDeliveryState: 'unconfirmed',
      disposition: 'reply_delivery_timeout', notice: { state: 'sent' } } });
    await page.waitForFunction(() => document.querySelector('[data-tab-message-row="owned-processing"] [data-tab-message-open]')?.title.includes('исход сохранён'));
    assert.equal(await processing.count(), 1, 'terminal warning is not hidden as a successful Reply');
    await page.screenshot({ path: path.join(artifact, 'terminal-warning.png') });
    await page.evaluate(() => {
      const f = window.fixture, id = 'owned-late';
      const message = { ...f.q, messageId: id, text: 'Owned late-reply question', createdAt: '2026-10-25T00:01:00Z',
        loopWait: { revision: 1, state: 'settled', disposition: 'reply_timeout', notice: { state: 'sent' } } };
      f.ownedPairs[id] = { message };
      f.ipc.emit('tab-messages:changed', {}, { message });
    });
    const late = page.locator('[data-tab-message-row="owned-late"]');
    await late.waitFor(); assert.match(await late.locator('[data-tab-message-open]').getAttribute('title'), /Срок ответа истёк/);
    await page.evaluate(() => {
      const f = window.fixture, pair = f.ownedPairs['owned-late'];
      pair.reply = { ...f.r, messageId: 'owned-late-reply', replyTo: pair.message.messageId,
        deliveryState: 'queued', error: null, text: 'Exact late reply, not the old status final' };
      f.ipc.emit('tab-messages:changed', {}, { message: pair.reply });
    });
    await emitOwned('owned-late', { replyMessageId: 'owned-late-reply', loopWait: { revision: 2, state: 'returning',
      replyDeliveryState: 'queued', disposition: 'reply-return' } });
    await page.waitForFunction(() => document.querySelector('[data-tab-message-row="owned-late"] [data-tab-message-open]')?.title.includes('В очереди'));
    await late.locator('[data-tab-message-open]').click();
    await page.locator('[data-tab-message-body="owned-late-reply"] > summary').click();
    await page.getByText('Exact late reply, not the old status final', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(call => call.c === 'tab-messages:get').at(-1).p), { messageId: 'owned-late' });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(artifact, 'late-reply.png') });
    await page.evaluate(() => {
      const f = window.fixture, pair = f.ownedPairs['owned-late'];
      pair.reply = { ...pair.reply, deliveryState: 'sent', updatedAt: '2026-10-27T00:01:00Z' };
      f.ipc.emit('tab-messages:changed', {}, { message: pair.reply });
    });
    await emitOwned('owned-late', { loopWait: { revision: 3, state: 'settled', replyDeliveryState: 'sent',
      settlement: { kind: 'reply-delivered', at: Date.now() } } });
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-tracker] [data-tab-message-row="owned-late"]'));
    await page.locator('[data-orchestration-history-button]').click();
    const savedLate = page.locator('[data-orchestration-history-panel] [data-tab-message-history-row="owned-late"]');
    await savedLate.waitFor();
    for (const stage of ['send', 'reply']) assert.equal(await savedLate.locator('[data-tab-message-stage="' + stage + '"]')
      .evaluate(node => getComputedStyle(node).color), 'rgb(74, 222, 128)');
    assert.equal(await savedLate.locator('[data-tab-message-status-icon]').getAttribute('data-tab-message-status-icon'), 'delivered');
    await savedLate.locator('[data-tab-message-open="owned-late"]').click();
    await page.locator('[data-tab-message-body="owned-late-reply"] > summary').click();
    await page.getByText('Exact late reply, not the old status final', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(call => call.c === 'tab-messages:get').at(-1).p), { messageId: 'owned-late' });
    await page.keyboard.press('Escape');
    if (await page.locator('[data-orchestration-history-panel]').count()) await page.locator('[data-orchestration-history-button]').click();
    await processing.locator('[data-tab-message-dismiss="owned-processing"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-tracker] [data-tab-message-row="owned-processing"]'));
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(call => call.c === 'tab-messages:dismiss').map(call => call.p)), [{ tabId: 'a', messageId: 'owned-processing' }]);
    assert.equal(await page.evaluate(() => window.fixture.ownedPairs['owned-processing'].reply.text), 'Owned received reply');
    await fs.writeFile(path.join(artifact, 'wait-state-results.json'), JSON.stringify({ width, pass: true,
      controlledPorts: true, providerOrNaturalFinalProof: false,
      checks: ['queued Reply is not sent', 'unconfirmed delivery attention is amber', 'terminal delivery warning is not green Reply',
        'late Reply retains exact question', 'same-ID selected body and source navigation',
        'confirmed Reply hides the exchange without natural final', 'same green exchange remains readable in unified History',
        'local participant dismissal preserves late delivery and saved Reply'] }, null, 2));
    }
    await page.evaluate(() => window.fixture.render('unrelated'));
    await page.waitForFunction(() => !document.querySelector('[data-tab-message-tracker]'));
    assert.deepEqual(await page.evaluate(() => window.fixture.violations), []);
    assert.deepEqual(errors, []);
    console.log('Tab message isolated screenshots:', artifact);
    results.push({ width, pass: true, artifact, guiExecuted: true });
    await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify({ pass: true, artifact, errors, checks: ['message-only root', 'event before list', 'lazy bounded selected get', 'question and failed reverse reply', 'Markdown table/code', 'exact body copy', 'stored source navigation', 'exact ID follows moved project/color while stored label/provenance survives and same-name decoy is ignored', 'deferred context chip', 'envelope stripped', 'raw transport Copy/Rewind', 'actual Codex response/event promotion retains the service tag, computed purple background/border and body-only Markdown', 'literal orchestration quote stays ordinary and complete', 'canonical TAB/CRLF and same-length prefix shift preserve full text for both tag types', 'full UTF-8 SHA256 refuses equal-length body/prefix edits with unchanged header and UUID', 'late selected get', 'ISO tie', '350/900 viewport', 'Escape/outside/retry', 'tab ownership cleanup', 'no live mutations'] }, null, 2));
  } catch (error) {
    if (app) await app.firstWindow().then(page => page.screenshot({ path: path.join(artifact, 'failure.png') })).catch(() => {});
    console.log('Failed isolated renderer artifact:', artifact);
    const failure = { width, pass: false, artifact, guiExecuted: !!app, error: String(error?.stack || error), errors };
    results.push(failure);
    await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(failure, null, 2));
    throw error;
  } finally {
    try {
      if (app) await app.close();
      if (instance) {
        let absent = false;
        try { process.kill(instance.pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; absent = true; }
        await fs.writeFile(path.join(artifact, 'instance-closed.json'), JSON.stringify({ pid: instance.pid, absent, normalClose: true }));
        assert.equal(absent, true, 'the exact owned Electron must exit before profile cleanup');
      }
    }
    finally {
      const cleanup = { removed: [], errors: [] };
      try {
        if (await fs.stat(path.join(snapshot, '.git')).catch(() => null)) {
          execFileSync('git', ['worktree', 'remove', '--force', snapshot], { cwd: repo, stdio: 'pipe' });
          cleanup.removed.push('source');
        }
      } catch (error) { cleanup.errors.push(String(error)); }
      for (const name of ['noted-shared', 'user-data', 'bundle.js', 'bundle.css', 'globals.css', 'index.html', 'main.cjs']) {
        try { await fs.rm(path.join(artifact, name), { recursive: true, force: true }); cleanup.removed.push(name); }
        catch (error) { cleanup.errors.push(String(error)); }
      }
      await fs.writeFile(path.join(artifact, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
      assert.deepEqual(cleanup.errors, [], 'private test cleanup failed');
    }
  }
});
