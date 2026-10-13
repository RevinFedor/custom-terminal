#!/usr/bin/env node
// Actual source snapshot + private offscreen Electron. Only fixture IPC and
// workspace/UI stores are substituted; no production/CDP server is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtureFile = 'scripts/fixtures/orchestration-continuation-ui.tsx';
const runnerFile = 'scripts/orchestration-continuation-ui-regression.mjs';
const chipFile = 'src/renderer/components/Workspace/OrchestrationStatusChip.tsx';
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-continuation-ui-'));
const snapshot = path.join(artifact, 'source');
const widths = [350, 500, 1000];
const ownedApps = new Map();
const report = { artifact, startedAt: new Date().toISOString(), source: {}, results: [], pass: false,
  substitutions: ['fixture-only IPC; no production main/RunStore/web/MCP',
    'workspace/UI Zustand stores and collapsed rail host; no History/Timeline/Run After executor',
    'synthetic run/provider/execution evidence; no provider, research, real Send or clipboard'],
  limitations: ['UI-to-IPC boundary only; no backend continuation/receipt/FIFO/end-to-end proof'],
  cleanup: { serversStarted: 0, ownedElectron: [], complete: false } };
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const runFile = promisify(execFile);

async function closeOwnedApp(app, result) {
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let deadline;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Owned offscreen Electron close timed out')), 5000);
    })]);
  } catch (error) {
    result.closeWarning = String(error);
    if (!exited()) {
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGKILL');
      await exit;
    }
  } finally {
    clearTimeout(deadline);
    result.electron = { pid: child.pid, closed: exited(), exitCode: child.exitCode, signal: child.signalCode };
    report.cleanup.ownedElectron.push(result.electron);
    if (exited()) ownedApps.delete(app);
  }
  assert.equal(exited(), true, 'owned offscreen Electron still running');
}

try {
  report.snapshotStartedAt = new Date().toISOString();
  const beforeChip = await hash(path.join(repo, chipFile));
  for (const directory of ['src', 'packages/claude-blocks']) await fs.cp(path.join(repo, directory), path.join(snapshot, directory), {
    recursive: true, filter: file => !file.includes('/node_modules') && !file.includes('/.git'),
  });
  await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
  await fs.copyFile(path.join(repo, fixtureFile), path.join(snapshot, fixtureFile));
  await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
  assert.equal(await hash(path.join(snapshot, chipFile)), beforeChip, 'chip changed while source was captured; rerun with a stable snapshot');
  assert.equal(await hash(path.join(repo, chipFile)), beforeChip, 'live chip changed during snapshot capture');
  report.source[chipFile] = beforeChip;
  report.snapshotCompletedAt = new Date().toISOString();
  const stores = { name: 'explicit-fixture-stores', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)use(Workspace|UI)Store(?:\.[jt]sx?)?$/ }, args => ({ path: args.path, namespace: 'fixture-store' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture-store' }, args => ({ loader: 'js', contents:
      args.path.includes('useWorkspaceStore')
        ? 'export const useWorkspaceStore = window.orchestrationContinuationUI.workspace;'
        : 'export const useUIStore = window.orchestrationContinuationUI.ui;',
    }));
  } };
  const bundled = await build({ entryPoints: [path.join(snapshot, fixtureFile)],
    bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife',
    target: 'chrome120', jsx: 'automatic', sourcemap: true, metafile: true, logLevel: 'silent', plugins: [stores],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
    alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
      react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'file', '.woff2': 'file' },
  });
  const canonicalSnapshot = await fs.realpath(snapshot);
  for (const input of Object.keys(bundled.metafile.inputs)) {
    const absolute = path.resolve(repo, input);
    if (absolute.startsWith(canonicalSnapshot + path.sep)) report.source[path.relative(canonicalSnapshot, absolute)] = await hash(absolute);
  }
  for (const file of ['src/renderer/styles/globals.css', fixtureFile]) report.source[file] = await hash(path.join(snapshot, file));
  report.source[runnerFile] = await hash(path.join(repo, runnerFile));
  report.dependencyVersions = {};
  for (const name of ['electron', 'playwright', 'esbuild', 'react', 'react-dom', 'zustand', 'lucide-react', 'tailwindcss']) {
    report.dependencyVersions[name] = JSON.parse(await fs.readFile(path.join(repo, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  await fs.writeFile(path.join(artifact, 'build-metafile.json'), JSON.stringify(bundled.metafile, null, 2));
  await runFile(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
    '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, timeout: 30000 });
  await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="utf-8">
    <link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css">
    <style>html,body{margin:0;background:#181818;color:#ccc;font-family:Arial,sans-serif}*{box-sizing:border-box}</style>
    <div id="root"></div><script src="bundle.js"></script>`);

  for (const width of widths) {
    const runDir = path.join(artifact, String(width));
    await fs.mkdir(runDir);
    const result = { width, checks: [], geometry: [], screenshots: [], failures: [], errors: [], console: [], pass: false };
    report.results.push(result);
    let app;
    let page;
    try {
      const main = path.join(runDir, 'main.cjs');
      await fs.writeFile(main, `const {app,BrowserWindow,session}=require('electron');
        app.setPath('userData',${JSON.stringify(path.join(runDir, 'user-data'))});
        app.setPath('logs',${JSON.stringify(path.join(runDir, 'logs'))});
        app.setActivationPolicy?.('accessory');
        app.whenReady().then(()=>{app.dock?.hide();global.blockedRequests=[];
          session.defaultSession.webRequest.onBeforeRequest((request,done)=>{
            const cancel=!/^(file:|data:|blob:)/.test(request.url);
            if(cancel)global.blockedRequests.push(request.url);done({cancel});});
          session.defaultSession.setPermissionRequestHandler((_contents,_permission,done)=>done(false));
          const window=new BrowserWindow({show:false,focusable:false,width:${width + 40},height:800,
            webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
          window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
          window.webContents.on('paint',()=>{});
          window.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))},{query:{width:${JSON.stringify(String(width))}}});
        });app.on('window-all-closed',()=>app.quit());`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'), args: [main], cwd: runDir, env, timeout: 20000 });
      ownedApps.set(app, result);
      page = await app.firstWindow();
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => result.errors.push(error.stack || error.message));
      page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
      await page.waitForFunction(() => window.orchestrationContinuationUI?.ready || window.orchestrationContinuationUI?.error);
      assert.equal(await page.evaluate(() => window.orchestrationContinuationUI.error), undefined);
      const pane = page.locator('[data-continuation-pane]');
      const tooltip = page.getByRole('tooltip');
      const historyPanel = page.locator('[data-orchestration-history-panel]');
      const state = () => page.evaluate(() => window.orchestrationContinuationUI.state());
      const actions = async () => {
        const current = await state();
        return current.calls.filter(call => call.caseId === current.caseId && call.channel === 'orchestration:action');
      };
      const settle = () => page.evaluate(() => new Promise((resolve, reject) => {
        let previous = '', stable = 0;
        const deadline = performance.now() + 3000;
        const frame = () => {
          const signature = JSON.stringify([...document.querySelectorAll('[data-continuation-pane], [data-orchestration-activity-dock], [role="tooltip"], [data-orchestration-action], [data-orchestration-history-panel]')]
            .map(node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height, getComputedStyle(node).opacity]; }));
          stable = signature === previous ? stable + 1 : 0;
          previous = signature;
          if (stable >= 3) return resolve(null);
          if (performance.now() > deadline) return reject(new Error('Continuation layout failed to settle'));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      const capture = async label => {
        await settle();
        const file = path.join(runDir, label + '.png');
        await page.screenshot({ path: file });
        result.screenshots.push(file);
      };
      const reset = async (caseId, patch = {}) => {
        await page.mouse.move(5, 780);
        await page.evaluate(({ caseId, patch }) => window.orchestrationContinuationUI.reset(caseId, patch), { caseId, patch });
        await pane.locator(`[data-orchestration-active-run="continuation-ui-${caseId}"]`).waitFor({ state: ['cancelled', 'failed'].includes(patch.status) ? 'hidden' : 'visible' });
        await settle();
      };
      const hover = async caseId => {
        await pane.locator(`[data-orchestration-active-run="continuation-ui-${caseId}"]`).hover();
        await tooltip.waitFor();
        await settle();
      };
      const button = action => tooltip.locator(`[data-orchestration-action="${action}"]`);
      const geometry = async label => {
        const measured = await page.evaluate(() => {
          const box = node => {
            const b = node.getBoundingClientRect();
            return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
          };
          const visible = node => { const b = node.getBoundingClientRect(), s = getComputedStyle(node);
            return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0; };
          const paneNode = document.querySelector('[data-continuation-pane]');
          const surfaceNodes = [...document.querySelectorAll('[data-orchestration-activity-dock], [role="tooltip"], [data-orchestration-history-panel]')].filter(visible);
          return { pane: box(paneNode), viewport: { width: innerWidth, height: innerHeight },
            paneOverflow: paneNode.scrollWidth > paneNode.clientWidth + 1,
            documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
            surfaces: surfaceNodes.map(node => ({ kind: node.getAttribute('role') || (node.hasAttribute('data-orchestration-history-panel') ? 'history' : 'dock'),
              ...box(node), overflow: node.scrollWidth > node.clientWidth + 1 })),
            rows: [...document.querySelectorAll('[data-orchestration-active-run]')].filter(visible).map(node => ({
              runId: node.getAttribute('data-orchestration-active-run'), ...box(node),
              status: node.querySelector('[data-request-status-slot]') ? box(node.querySelector('[data-request-status-slot]')) : null,
            })),
            buttons: [...document.querySelectorAll('[data-orchestration-action]')].filter(visible).map(node => ({
              action: node.getAttribute('data-orchestration-action'), ...box(node), disabled: node.disabled,
              color: getComputedStyle(node).color, iconClass: node.querySelector('svg')?.getAttribute('class'),
              icon: node.querySelector('svg') ? box(node.querySelector('svg')) : null,
            })),
          };
        });
        const violations = [];
        const check = (condition, message) => { if (!condition) violations.push(message); };
        check(!measured.paneOverflow, 'pane overflows horizontally');
        check(!measured.documentOverflow, 'document overflows horizontally');
        for (const surface of measured.surfaces) {
          check(!surface.overflow, `${surface.kind} horizontal overflow`);
          check(surface.left >= measured.pane.left - 1 && surface.right <= measured.pane.right + 1
            && surface.top >= measured.pane.top - 1 && surface.bottom <= measured.pane.bottom + 1,
          `${surface.kind} escaped pane: ${JSON.stringify(surface)}`);
          check(surface.left >= 0 && surface.right <= measured.viewport.width + 1 && surface.top >= 0
            && surface.bottom <= measured.viewport.height + 1, `${surface.kind} escaped viewport`);
        }
        for (const row of measured.rows) {
          check(row.height === 26, `${row.runId}: recovery row height is ${row.height}, not 26`);
          if (row.status) check(row.status.width === 26 && row.status.height === 14, `${row.runId}: status slot geometry changed`);
        }
        for (const control of measured.buttons) {
          check(control.width === 25 && control.height === 25, `${control.action}: expected 25x25 action, got ${control.width}x${control.height}`);
          check(Boolean(control.icon), `${control.action}: missing icon`);
          if (!control.icon) continue;
          check(control.icon.width === 13 && control.icon.height === 13, `${control.action}: expected 13x13 icon`);
          check(Math.abs((control.left + control.right) / 2 - (control.icon.left + control.icon.right) / 2) <= 0.5
            && Math.abs((control.top + control.bottom) / 2 - (control.icon.top + control.icon.bottom) / 2) <= 0.5,
          `${control.action}: icon not centered`);
          check(measured.surfaces.some(surface => control.left >= surface.left - 1 && control.right <= surface.right + 1
            && control.top >= surface.top - 1 && control.bottom <= surface.bottom + 1), `${control.action}: action escaped its surface`);
        }
        result.geometry.push({ label, ...measured, violations, pass: violations.length === 0 });
        if (violations.length) {
          result.failures.push({ label: 'geometry: ' + label, violations });
          process.stdout.write(`FAIL ${width}px geometry ${label}: ${violations.join('; ')}\n`);
        } else {
          process.stdout.write(`PASS ${width}px geometry ${label}\n`);
        }
        return measured;
      };
      const attempt = async (label, run) => {
        try {
          await run();
          result.checks.push(label);
          process.stdout.write(`PASS ${width}px ${label}\n`);
        } catch (error) {
          result.failures.push({ label, error: String(error.stack || error) });
          process.stdout.write(`FAIL ${width}px ${label}: ${error.message}\n`);
          await capture('failure-' + result.failures.length).catch(() => {});
          const current = await state();
          if (current.pendingCancellation) await page.evaluate(() => window.orchestrationContinuationUI.releaseCancellation());
          if (current.pending) await page.evaluate(() => window.orchestrationContinuationUI.release('unconfirmed'));
        }
      };
      const expectContinue = async label => {
        assert.equal(await button('continue').getAttribute('title'), label);
        assert.equal(await button('continue').getAttribute('aria-label'), label);
        assert.equal(await button('continue').evaluate(node => getComputedStyle(node).color), 'rgb(167, 139, 250)');
        assert.match(await button('continue').locator('svg').getAttribute('class'), /lucide-play/);
      };
      const clickContinue = async caseId => {
        await button('continue').click();
        const current = await state();
        const sent = await actions();
        assert.equal(sent.length, 1, 'one trusted Continue click must yield exactly one orchestration:action invocation');
        assert.deepEqual(sent[0].args, [{ runId: 'continuation-ui-' + caseId, action: 'continue',
          tabId: 'continuation-ui-owner', cancelSendAccepted: false }]);
        assert.equal(current.events.filter(event => event.caseId === caseId && event.type === 'click' && event.action === 'continue').length, 1);
        assert.equal(current.events.find(event => event.caseId === caseId && event.type === 'click' && event.action === 'continue').trusted, true);
      };

      await attempt('yellow recovery card -> purple Play Continue', async () => {
        await reset('visual');
        const row = pane.locator('[data-orchestration-active-run="continuation-ui-visual"]');
        assert.equal(await row.locator('button').first().evaluate(node => getComputedStyle(node).color), 'rgb(251, 191, 36)');
        assert.equal(await row.locator('[data-orchestration-status-icon="recovery"] svg').count(), 2);
        await hover('visual');
        await expectContinue('Продолжить запрос');
        await capture('01-yellow-recovery-continue');
        await geometry('yellow-recovery-continue');
      });
      await attempt('trusted Continue -> one exact IPC; held response blocks repeats, not Dismiss/Cancel', async () => {
        await reset('held');
        await hover('held');
        await page.evaluate(() => window.orchestrationContinuationUI.hold());
        await clickContinue('held');
        assert.equal(await button('continue').isDisabled(), true);
        assert.equal(await button('dismiss').isEnabled(), true);
        assert.equal(await button('report').isEnabled(), true);
        assert.equal(await pane.locator('[data-orchestration-dismiss="continuation-ui-held"]').isEnabled(), true);
        const box = await button('continue').boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal((await actions()).filter(call => call.args[0].action === 'continue').length, 1);
        assert.equal((await state()).pending, 1);
        await capture('02-held-continue');
        await geometry('held-continue');
        await page.evaluate(() => { window.orchestrationContinuationUI.holdCancellation = true; });
        await button('dismiss').click();
        await button('dismiss').click();
        assert.equal((await actions()).filter(call => call.args[0].action === 'dismiss').length, 1,
          'Dismiss must reach IPC despite held Continue, with duplicate cancellation guarded separately');
        assert.equal((await state()).pendingCancellation, 1);
        await page.evaluate(() => window.orchestrationContinuationUI.releaseCancellation());
        await page.evaluate(() => window.orchestrationContinuationUI.release('unconfirmed'));
        await page.waitForFunction(() => document.querySelector('[data-orchestration-action="continue"]')?.getAttribute('aria-label') === 'Проверить продолжение');
      });
      await attempt('unknown continuation -> Check continuation; check uses Continue IPC once', async () => {
        await reset('unknown');
        await hover('unknown');
        await clickContinue('unknown');
        await page.waitForFunction(() => document.querySelector('[data-orchestration-action="continue"]')?.getAttribute('aria-label') === 'Проверить продолжение');
        await expectContinue('Проверить продолжение');
        assert.equal(await button('continue').isEnabled(), true);
        assert.match(await tooltip.innerText(), /Проверка продолжения/);
        await capture('03-unknown-check-continuation');
        await geometry('unknown-check-continuation');
        await button('continue').click();
        const sent = await actions();
        assert.equal(sent.length, 2);
        assert.ok(sent.every(call => call.args[0].action === 'continue' && call.args[0].runId === 'continuation-ui-unknown'));
        assert.ok((await state()).events.filter(event => event.caseId === 'unknown' && event.type === 'click' && event.action === 'continue').every(event => event.trusted));
      });
      await attempt('changed history -> explicit new-request; no automatic new request', async () => {
        await reset('changed');
        await page.evaluate(() => { window.orchestrationContinuationUI.reply = 'history-changed'; });
        await hover('changed');
        await clickContinue('changed');
        await button('new-request').waitFor();
        const label = 'Создать новое поручение в текущих историях; старый запрос сохраняется';
        assert.equal(await button('new-request').getAttribute('title'), label);
        assert.equal(await button('new-request').getAttribute('aria-label'), label);
        assert.match(await tooltip.innerText(), /История исполнителя изменилась/);
        assert.equal((await actions()).length, 1, 'changed history must not automatically create a new request');
        await capture('04-history-changed-new-request');
        await geometry('history-changed-new-request');
        await button('new-request').click();
        const sent = await actions();
        assert.equal(sent.length, 2);
        assert.deepEqual(sent[1].args, [{ runId: 'continuation-ui-changed', action: 'new-request',
          tabId: 'continuation-ui-owner', cancelSendAccepted: false }]);
        assert.equal((await state()).events.find(event => event.caseId === 'changed' && event.type === 'click' && event.action === 'new-request')?.trusted, true);
      });
      await attempt('held Continue does not block report/cancellation intent', async () => {
        await reset('report');
        await hover('report');
        await page.evaluate(() => window.orchestrationContinuationUI.hold());
        await clickContinue('report');
        await button('report').click();
        assert.equal((await actions()).filter(call => call.args[0].action === 'report').length, 1);
        assert.equal((await state()).pending, 1);
        await capture('05-held-report-usable');
        await page.evaluate(() => window.orchestrationContinuationUI.release('unconfirmed'));
        await settle();
      });
      await attempt('held Continue does not block detach/Cancel of paused relationship', async () => {
        await reset('cancel');
        await hover('cancel');
        await page.evaluate(() => window.orchestrationContinuationUI.hold());
        await clickContinue('cancel');
        await page.evaluate(() => window.orchestrationContinuationUI.publish({ outcome: 'paused' }));
        await button('detach').waitFor();
        assert.equal(await button('detach').isEnabled(), true);
        assert.equal(await button('continue').count(), 0);
        await page.evaluate(() => { window.orchestrationContinuationUI.holdCancellation = true; });
        await button('detach').click();
        await button('detach').click();
        const current = await state();
        assert.equal(current.calls.filter(call => call.caseId === 'cancel' && call.channel === 'agent:cancel-send').length, 1);
        assert.equal((await actions()).filter(call => call.args[0].action === 'detach').length, 1);
        assert.equal(current.pending, 1);
        await capture('06-held-detach-usable');
        await page.evaluate(() => window.orchestrationContinuationUI.releaseCancellation());
        await page.evaluate(() => window.orchestrationContinuationUI.release('unconfirmed'));
        await settle();
      });
      for (const [caseId, patch] of [
        ['external-research', { runKind: 'external-research', targetTabId: null, targetTabName: 'Synthetic research target' }],
        ['response-observation', { runKind: 'response-observation' }],
        ['paused', { outcome: 'paused' }],
      ]) await attempt(caseId + ' never receives Continue', async () => {
        await reset(caseId, patch);
        await hover(caseId);
        assert.equal(await button('continue').count(), 0);
        assert.equal(await button('new-request').count(), 0);
        if (caseId === 'paused') assert.equal(await button('resume').count(), 1);
        if (caseId !== 'paused') assert.equal(await button('resume').count(), 0);
        await capture('excluded-' + caseId);
        await geometry('excluded-' + caseId);
        assert.equal((await actions()).length, 0);
      });
      for (const status of ['cancelled', 'failed']) await attempt(`${status} agent History -> new-request ArrowUpRight, never Continue`, async () => {
        await reset(status, { status, outcome: 'interrupted', completedAt: Date.now() - 1000 });
        await pane.locator('[data-orchestration-history-button]').click();
        await historyPanel.waitFor();
        await historyPanel.locator(`[data-orchestration-run-id="continuation-ui-${status}"] button[aria-expanded]`).click();
        await historyPanel.locator('[data-orchestration-run-details]').waitFor();
        assert.equal(await historyPanel.locator('[data-orchestration-action="continue"]').count(), 0);
        const newRequest = historyPanel.locator('[data-orchestration-action="new-request"]');
        assert.equal(await newRequest.count(), 1);
        assert.match(await newRequest.locator('svg').getAttribute('class'), /lucide-arrow-up-right/);
        assert.equal(await newRequest.getAttribute('aria-label'), 'Создать новое поручение в текущих историях; старый запрос сохраняется');
        await capture('excluded-' + status + '-history');
        await geometry('excluded-' + status + '-history');
        assert.equal((await actions()).length, 0);
        await newRequest.click();
        assert.deepEqual((await actions())[0].args, [{ runId: 'continuation-ui-' + status, action: 'new-request',
          tabId: 'continuation-ui-owner', cancelSendAccepted: false }]);
      });
      await attempt('actual History Continue also retains fixed action geometry', async () => {
        await reset('history');
        await pane.locator('[data-orchestration-history-button]').click();
        await historyPanel.waitFor();
        await historyPanel.locator('[data-orchestration-run-id="continuation-ui-history"] button[aria-expanded]').click();
        const historyContinue = historyPanel.locator('[data-orchestration-action="continue"]');
        await historyContinue.waitFor();
        assert.equal(await historyContinue.getAttribute('aria-label'), 'Продолжить запрос');
        await capture('07-history-continue');
        await geometry('history-continue');
        await historyContinue.click();
        assert.deepEqual((await actions())[0].args, [{ runId: 'continuation-ui-history', action: 'continue',
          tabId: 'continuation-ui-owner', cancelSendAccepted: false }]);
      });
      await attempt('strict pane containment and fixed geometry in every measured state', async () => {
        assert.deepEqual(result.geometry.flatMap(({ label, violations }) =>
          violations.map(violation => ({ label, violation }))), [],
        'all captured orchestration surfaces and controls must fit the owning pane');
      });
      result.fixture = await state();
      result.blockedRequests = await app.evaluate(() => globalThis.blockedRequests);
      assert.deepEqual(result.fixture.violations, [], 'fixture attempted a prohibited operation');
      assert.deepEqual(result.errors, [], 'actual component renderer errors');
      assert.deepEqual(result.blockedRequests, [], 'test attempted external networking');
      assert.ok(result.fixture.events.filter(event => event.type === 'click').every(event => event.trusted), 'untrusted click used');
      result.pass = result.failures.length === 0;
    } catch (error) {
      result.failures.push({ label: 'harness', error: String(error.stack || error) });
      if (page) await page.screenshot({ path: path.join(runDir, 'harness-failure.png') }).catch(() => {});
    } finally {
      if (app) await closeOwnedApp(app, result);
    }
  }
  report.liveChipAfterRun = await hash(path.join(repo, chipFile));
  report.liveChipChangedAfterSnapshot = report.liveChipAfterRun !== report.source[chipFile];
  report.pass = report.results.every(result => result.pass);
} catch (error) {
  report.error = String(error.stack || error);
} finally {
  for (const [app, result] of ownedApps) await closeOwnedApp(app, result).catch(error => {
    report.cleanup.error = String(error);
  });
  report.finishedAt = new Date().toISOString();
  report.cleanup.complete = ownedApps.size === 0;
  await fs.writeFile(path.join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ artifact, report: path.join(artifact, 'report.json'), pass: report.pass,
    results: report.results.map(({ width, checks, failures }) => ({ width, passed: checks.length, failures })),
    sourceHash: report.source[chipFile], cleanup: report.cleanup }, null, 2) + '\n');
  if (!report.pass || !report.cleanup.complete) process.exitCode = 1;
}
