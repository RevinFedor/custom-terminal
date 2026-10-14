#!/usr/bin/env node
// Private offscreen Electron, frozen renderer, synthetic IPC and memory-only clipboard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-history-copy-replay-'));
const snapshot = path.join(artifact, 'source'), shared = path.join(artifact, 'shared');
const result = { artifact, checks: [], errors: [], cleanup: {},
  boundary: 'Actual Copy button, Electron clipboard adapter, composer keymap and paste handlers; memory clipboard and synthetic failed-send state. No OS clipboard/provider/production state access.' };
let app, page;
const logs = [];

function privateMain(config) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', config.userData); app.setActivationPolicy?.('accessory');
  global.copyReplayForbidden = [];
  ipcMain.handle('fixture:invoke', (_event, { channel, args }) => {
    if (/send-command|send-prompt|enqueue-prompt|terminal:(create|input|paste|kill|restart|stop-ai)|orchestration.*create/.test(channel)) {
      global.copyReplayForbidden.push(channel); throw Error('Forbidden fixture mutation: ' + channel);
    }
    if (channel === 'file:exists-batch') return Object.fromEntries(args[0].map(file => [file, false]));
    if (channel === 'terminal:getCommandStates') return {};
    if (channel === 'terminal:hasRunningProcess') return { isRunning: false };
    if (channel === 'terminal:getCommandState' || /getState|get-state/.test(channel)) return null;
    if (/list|List|catalog|get-models|get-prompts|project:getGroups/.test(channel)) return [];
    return { success: true };
  });
  app.whenReady().then(() => {
    app.dock?.hide();
    const window = new BrowserWindow({ show: false, focusable: false, width: 1060, height: 760,
      webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false,
        backgroundThrottling: false, preload: config.preload } });
    window.webContents.on('paint', () => {}); window.loadFile(config.html);
  });
  app.on('window-all-closed', () => app.quit());
}
function privatePreload() {
  const electron = require('electron'), invoke = electron.ipcRenderer.invoke.bind(electron.ipcRenderer);
  electron.ipcRenderer.invoke = (channel, ...args) => invoke('fixture:invoke', { channel, args });
  let item = {};
  const clipboard = { clear() { item = {}; }, write(value) { item = { ...value }; }, writeText(text) { item = { text }; },
    readText: () => item.text || '', readHTML: () => item.html || '',
    availableFormats: () => Object.keys(item).map(type => 'text/' + (type === 'text' ? 'plain' : type)) };
  const realRequire = window.require;
  window.require = name => name === 'electron' ? { ...electron, clipboard } : realRequire(name);
  // Native CodeMirror copy uses ClipboardEvent, whereas our paste keymap uses
  // the injected Electron adapter. Join both paths into this one memory sink;
  // prevent the native event from writing the user's OS clipboard.
  window.copyReplayNativeCopies = 0;
  window.addEventListener('copy', event => {
    window.copyReplayNativeCopies++;
    if (Array.from(event.clipboardData?.types || []).includes('text/plain')) {
      clipboard.writeText(event.clipboardData.getData('text/plain'));
    } else if (!event.defaultPrevented) {
      // Model Blink's ordinary selected-text copy at its native clipboard seam.
      // This selection belongs only to the synthetic private fixture.
      clipboard.writeText(window.getSelection()?.toString() || '');
    }
    event.preventDefault();
  });
}

try {
  for (const name of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, name), path.join(snapshot, name), {
    recursive: true, filter: value => !value.includes('/node_modules') && !value.includes('/.git'),
  });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, 'scripts/fixtures/history-copy-replay.tsx'), path.join(snapshot, 'scripts/fixtures/history-copy-replay.tsx'));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  for (const name of ['structured-dnd', 'file-explorer']) await fs.cp(path.join(repo, 'vendor/noted-shared/packages', name), path.join(shared, name), {
    recursive: true, filter: value => !value.includes('/node_modules') && !value.includes('/.git'),
  });
  const bundled = await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/history-copy-replay.tsx')],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'esm', target: 'chrome120',
    logLevel: 'silent', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      '@noted/structured-dnd': path.join(shared, 'structured-dnd/src'), '@noted/file-explorer': path.join(shared, 'file-explorer/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' } });
  const hashes = {}, sourceRoot = await fs.realpath(snapshot);
  for (const file of Object.keys(bundled.metafile.inputs)) {
    if (file.startsWith('<') && file.endsWith('>')) continue;
    const absolute = await fs.realpath(path.resolve(file)), relative = path.relative(sourceRoot, absolute);
    if (/^(src|packages|scripts)\//.test(relative)) hashes[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
  }
  assert.ok(hashes['src/renderer/utils/composerClipboard.mjs'], 'manifest must include the actual bundled replay helper');
  await fs.writeFile(path.join(artifact, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
  execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
  const config = { userData: path.join(artifact, 'user-data'), preload: path.join(artifact, 'preload.cjs'), html: path.join(artifact, 'index.html') };
  await fs.mkdir(config.userData);
  await fs.writeFile(config.html, '<meta charset="utf-8"><link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css"><style>html,body{margin:0;background:#1a1a1a;color:#ddd}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  await fs.writeFile(config.preload, '(' + privatePreload.toString() + ')();');
  await fs.writeFile(path.join(artifact, 'main.cjs'), '(' + privateMain.toString() + ')(' + JSON.stringify(config) + ');');
  const env = { ...process.env, NOTED_E2E_TEST: 'true', NOTED_USER_DATA_DIR: config.userData };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[key];
  app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [path.join(artifact, 'main.cjs')], env, cwd: artifact });
  result.pid = app.process().pid;
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('console', message => logs.push(message.text()));
  await page.waitForFunction(() => window.copyReplayFixture?.ready);
  const band = page.locator('[data-history-composer-prompt-band] .cb-composer-chip');
  const editor = page.locator('.cm-content[contenteditable="true"]').last();
  await page.getByRole('button', { name: 'Copy prompt', exact: true }).last().waitFor();
  for (const mode of ['failed', 'revised', 'rewind', 'empty']) {
    await page.evaluate(mode => window.copyReplayFixture.reset(mode), mode);
    await page.locator('[data-entry-uuid="local-prompt-copy-replay-private-tab-failed-copy"]').last().hover();
    await page.getByRole('button', { name: 'Copy prompt', exact: true }).last().click();
    assert.equal(await page.evaluate(() => window.require('electron').clipboard.readText()),
      await page.evaluate(() => window.copyReplayFixture.transport));
    for (let repeat = 0; repeat < 2; repeat++) {
      await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+v');
      await page.waitForFunction(() => window.copyReplayFixture.snapshot().text === window.copyReplayFixture.message);
      assert.equal(await editor.innerText(), 'updated API');
      const expected = mode === 'revised' ? 4 : 3;
      assert.equal(await band.count(), expected, mode + ': prompt band must not duplicate on repeat ' + repeat);
    }
    result.checks.push({ mode, chips: await band.count(), state: await page.evaluate(() => window.copyReplayFixture.snapshot()) });
    await page.screenshot({ path: path.join(artifact, mode + '.png') });
  }
  await page.evaluate(() => window.copyReplayFixture.plainClipboard());
  await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+v');
  await page.waitForFunction(() => window.copyReplayFixture.snapshot().text === 'ordinary paste');
  assert.equal(await band.count(), 3);
  result.checks.push('ordinary short plain-text paste preserves existing chips');
  for (const value of ['abc', '111', 'xyz', '111']) {
    await page.keyboard.press('Meta+a'); await page.keyboard.insertText(value);
    await page.keyboard.press('Meta+a');
    const nativeBefore = await page.evaluate(() => window.copyReplayNativeCopies);
    await page.keyboard.press('Meta+c');
    if (await page.evaluate(() => window.copyReplayNativeCopies) === nativeBefore) {
      // Offscreen CDP keys do not run the platform menu command. Execute that
      // native edit command in this exact owned webContents; the memory sink
      // above still receives the real CodeMirror ClipboardEvent.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
    }
    await page.keyboard.press('Meta+v');
    assert.equal(await editor.innerText(), value);
    assert.equal(await page.evaluate(() => window.require('electron').clipboard.readText()), value);
  }
  result.checks.push('rapid SelectAll/Copy/Paste uses the latest three-character selection four times');
  await page.evaluate(() => window.copyReplayFixture.reset('empty'));
  await editor.click();
  await page.evaluate(() => window.copyReplayFixture.bitmapPaste());
  await page.waitForFunction(() => window.copyReplayFixture.imageRequestPending === true);
  await page.waitForFunction(() => window.copyReplayFixture.snapshot().text.includes('[Image saving…]'));
  await editor.getByText('[Image saving…]', {exact:true}).waitFor({state:'visible'});
  const phases = await page.evaluate(() => window.copyReplayFixture.actions.filter(Boolean).flatMap(action => action.phases));
  assert.ok(phases.some(phase => phase.name === 'history-image-pending-applied' && phase.applied === true));
  assert.ok(phases.some(phase => phase.name === 'composer-clipboard-read-text' && phase.chars === 3));
  const shortcuts = await page.evaluate(() => window.copyReplayFixture.actions.filter(Boolean).map(action => action.shortcutClass));
  assert.ok(shortcuts.includes('Copy') && shortcuts.includes('Paste') && shortcuts.includes('SelectAll'));
  await page.screenshot({path:path.join(artifact,'image-pending.png')});
  await page.evaluate(() => window.copyReplayFixture.finishImage());
  await page.waitForFunction(() => !window.copyReplayFixture.snapshot().text.includes('[Image saving…]'));
  result.checks.push('image pending DOM precedes IPC completion; classified paste and clipboard phases survive');
  const answer = page.locator('[data-entry-uuid="previous-answer"]').first();
  await answer.click();
  await answer.evaluate(node => {
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
    let text;
    while((text=walker.nextNode()))if(text.textContent?.includes('Previous response.')){
      const start=text.textContent.indexOf('Previous response.');
      const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+8);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return;
    }
    throw Error('private answer text node missing');
  });
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.copy());
  assert.equal(await page.evaluate(()=>window.require('electron').clipboard.readText()),'Previous');
  await editor.click();await page.keyboard.press('Meta+a');await page.keyboard.press('Meta+v');
  assert.equal(await editor.innerText(),'Previous');
  const selectedCopy=await page.evaluate(()=>window.copyReplayFixture.actions.filter(action=>action?.event==='copy').at(-1));
  assert.equal(selectedCopy.clipboardState.selectedChars,8);
  assert.equal(selectedCopy.clipboardState.trusted,true);
  await page.waitForFunction(id=>window.copyReplayFixture.outcomes.some(record=>record.actionId===id&&record.finalDefaultPrevented===true),selectedCopy.id);
  for(const [step,value] of ['abc','111'].entries()) {
    await answer.click();
    await answer.evaluate((node,value)=>{
      const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;
      while((text=walker.nextNode()))if(text.textContent?.includes('Previous response.')){
        const start=text.textContent.indexOf(value);const range=document.createRange();
        range.setStart(text,start);range.setEnd(text,start+value.length);
        const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return;
      }
      throw Error('private same-length History selection missing');
    },value);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.copy());
    await editor.click();await page.keyboard.press('Meta+a');
    await page.evaluate(step=>window.copyReplayFixture.armOracle(step),step);
    await page.keyboard.press('Meta+v');
    assert.equal(await editor.innerText(),value);
    const action=await page.evaluate(()=>window.copyReplayFixture.actions.filter(action=>action?.event==='copy').at(-1));
    assert.equal(action.clipboardState.selectedChars,3);assert.equal(action.clipboardState.trusted,true);
    await page.waitForFunction(id=>window.copyReplayFixture.outcomes.some(record=>record.actionId===id&&record.finalDefaultPrevented===true),action.id);
  }
  const oracle=logs.filter(line=>line.startsWith('[Perf:ClipboardOracle]')).map(line=>JSON.parse(line.slice(line.indexOf('{'))));
  assert.equal(oracle.length,2);assert.ok(oracle.every(record=>record.matchesExpected===true));
  assert.equal(oracle[1].matchesPrevious,false);
  result.oracle=oracle;
  result.clipboardOutcomes=await page.evaluate(()=>window.copyReplayFixture.outcomes);
  result.checks.push('native selected History copy and two distinct same-length selections reach the existing paste read; final outcomes use the original action ID');
  const trusted = await page.evaluate(() => window.copyReplayFixture.trusted);
  assert.ok(trusted.some(event => event.type === 'keydown' && event.key === 'v' && event.trusted));
  assert.ok(trusted.some(event => event.type === 'click' && event.trusted));
  assert.deepEqual(await app.evaluate(() => global.copyReplayForbidden), []);
  assert.deepEqual(result.errors, []);
  result.checks.push('trusted clicks/keys, no provider mutation, no renderer errors');
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = error.stack; process.exitCode = 1;
  result.failedDiagnostics = await page?.evaluate(() => ({ actions:window.copyReplayFixture?.actions,
    nativeCopies:window.copyReplayNativeCopies, calls:window.copyReplayFixture?.calls })).catch(() => null);
  await page?.screenshot({ path: path.join(artifact, 'failure.png') }).catch(() => {});
} finally {
  if (app) {
    await app.close().catch(error => { result.cleanup.closeError = String(error); });
    try { process.kill(result.pid, 0); result.cleanup.processExited = false; }
    catch { result.cleanup.processExited = true; }
  }
  for (const folder of [snapshot, shared, path.join(artifact, 'user-data')]) await fs.rm(folder, { recursive: true, force: true });
  result.cleanup.privateFilesRemoved = true;
  await fs.writeFile(path.join(artifact, 'renderer.log'), logs.join('\n'));
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
