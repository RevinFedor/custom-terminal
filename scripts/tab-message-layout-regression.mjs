#!/usr/bin/env node
// Actual components, a frozen source snapshot and a private offscreen Electron.
// No production connection, provider, PTY, external network or OS-level input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-tab-message-layout-'));
const snapshot = path.join(artifact, 'source');
const widths = [350, 500, 1000];
const report = { artifact, startedAt: new Date().toISOString(), source: {}, results: [], pass: false };
const ownedApps = new Map();

async function closeOwnedApp(app, result) {
  const child = app.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  let deadline;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Private Electron close timed out')), 5000);
    })]);
  } catch (error) {
    result.electronCloseWarning = String(error);
    // This ChildProcess belongs to our launch, never a name/port lookup.
    if (!exited()) {
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGKILL');
      await exit;
    }
  } finally {
    clearTimeout(deadline);
    result.electron = { pid: child.pid, closed: exited(), exitCode: child.exitCode, signal: child.signalCode };
    if (exited()) ownedApps.delete(app);
  }
  assert.equal(result.electron.closed, true, 'owned Electron process did not exit');
}

try {
for (const name of ['src', 'packages/claude-blocks']) {
  await fs.cp(path.join(repo, name), path.join(snapshot, name), { recursive: true,
    filter: file => !file.includes('/node_modules') && !file.includes('/.git') });
}
await fs.mkdir(path.join(snapshot, 'scripts/fixtures'), { recursive: true });
await fs.copyFile(path.join(repo, 'scripts/fixtures/tab-message-layout.tsx'), path.join(snapshot, 'scripts/fixtures/tab-message-layout.tsx'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(snapshot, 'node_modules'));
for (const name of ['structured-dnd', 'file-explorer']) {
  await fs.cp(path.join(repo, '../noted-shared/packages', name), path.join(artifact, 'noted-shared/packages', name),
    { recursive: true, filter: file => !file.includes('/node_modules') });
}
for (const name of ['PromptQueueOverlay', 'OrchestrationStatusChip', 'TabMessageTracker', 'TabMessageSourceChip', 'RequestTrackerRow']) {
  const file = `src/renderer/components/Workspace/${name}.tsx`;
  report.source[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex');
}
for (const file of ['src/renderer/hooks/useRequestDockLayout.ts', 'src/renderer/hooks/useTabMessages.ts',
  'src/renderer/utils/tabMessageProjection.ts', 'src/renderer/utils/requestTrackerVisibility.mjs',
  'src/renderer/utils/orchestrationDetails.mjs', 'src/renderer/styles/globals.css']) {
  report.source[file] = createHash('sha256').update(await fs.readFile(path.join(snapshot, file))).digest('hex');
}
for (const file of ['scripts/tab-message-layout-regression.mjs', 'scripts/fixtures/tab-message-layout.tsx']) {
  report.source[file] = createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex');
}
await build({ entryPoints: [path.join(snapshot, 'scripts/fixtures/tab-message-layout.tsx')],
  bundle: true, outfile: path.join(artifact, 'bundle.js'), platform: 'browser', format: 'iife',
  target: 'chrome120', jsx: 'automatic', sourcemap: true, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false,"MODE":"test"}' },
  alias: { '@noted/claude-blocks': path.join(snapshot, 'packages/claude-blocks/src'),
    '@noted/structured-dnd': path.join(artifact, 'noted-shared/packages/structured-dnd/src'),
    '@noted/file-explorer': path.join(artifact, 'noted-shared/packages/file-explorer/src'),
    react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') },
  loader: { '.ttf': 'file', '.woff2': 'file', '.svg': 'dataurl' },
});
execFileSync(path.join(repo, 'node_modules/.bin/tailwindcss'), ['-i', path.join(snapshot, 'src/renderer/styles/globals.css'),
  '-o', path.join(artifact, 'globals.css'), '--minify'], { cwd: snapshot, stdio: 'pipe' });
await fs.writeFile(path.join(artifact, 'index.html'), `<!doctype html><meta charset="utf-8">
  <link rel="stylesheet" href="globals.css"><link rel="stylesheet" href="bundle.css">
  <style>html,body{margin:0;background:#181818;color:#ccc;font-family:Arial,sans-serif}*{box-sizing:border-box}</style>
  <div id="root"></div><script src="bundle.js"></script>`);

await test('isolated actual-component layout matrix', { timeout: 300000 }, async suite => {
for (const width of widths) await suite.test(`actual tab-message layout at ${width}px`, { timeout: 90000 }, async () => {
  const runDir = path.join(artifact, String(width));
  await fs.mkdir(runDir);
  const result = { width, checks: [], geometry: [], errors: [], console: [], pass: false };
  report.results.push(result);
  let app;
  let page;
  try {
    const main = path.join(runDir, 'main.cjs');
    await fs.writeFile(main, `const {app,BrowserWindow,session}=require('electron');
      app.setPath('userData',${JSON.stringify(path.join(runDir, 'user-data'))});
      app.setActivationPolicy?.('accessory');
      app.whenReady().then(()=>{app.dock?.hide();global.blockedRequests=[];
        session.defaultSession.webRequest.onBeforeRequest((request,done)=>{
          const cancel=!/^(file:|data:|blob:)/.test(request.url);
          if(cancel)global.blockedRequests.push(request.url);done({cancel});});
        const window=new BrowserWindow({show:false,focusable:false,width:${width + 80},height:800,
          webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
        window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        window.webContents.on('paint',()=>{});
        window.loadFile(${JSON.stringify(path.join(artifact, 'index.html'))},{query:{width:${JSON.stringify(String(width))}}});
      });app.on('window-all-closed',()=>app.quit());`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: path.join(repo, 'node_modules/.bin/electron'),
      args: [main], cwd: runDir, env, timeout: 20000 });
    ownedApps.set(app, result);
    page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => result.errors.push(error.stack || error.message));
    page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
    await page.screenshot({ path: path.join(runDir, 'initial.png') });
    await page.waitForFunction(() => window.tabMessageLayout?.ready || window.tabMessageLayout?.error);
    assert.equal(await page.evaluate(() => window.tabMessageLayout.error), undefined);
    const owner = page.locator('[data-tab-layout-fixture]');
    const rail = owner.locator('.pq-collapsed-rail');
    const count = owner.locator('.pq-rail-count');
    const queue = owner.locator('[data-prompt-queue-panel-mode]');
    const historyButton = owner.locator('[data-orchestration-history-button]');
    const historyPanel = page.locator('[data-orchestration-history-panel]');
    const preview = page.locator('[data-tab-message-preview]');
    const state = () => page.evaluate(() => window.tabMessageLayout.state());
    const far = async () => { await page.mouse.move(10, 780); await settle(); };
    const settle = () => page.evaluate(() => new Promise((resolve, reject) => {
      let previous = '', same = 0;
      const deadline = performance.now() + 3000;
      const frame = () => {
        const current = JSON.stringify([...document.querySelectorAll('.pq-collapsed-rail, [data-prompt-queue-panel-mode], [data-orchestration-activity-dock], [data-tab-message-preview], [data-orchestration-history-panel]')]
          .map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
        same = current === previous ? same + 1 : 0;
        previous = current;
        if (same >= 3) return resolve(null);
        if (performance.now() > deadline) return reject(new Error('Layout did not settle'));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    const rect = locator => locator.evaluate(node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const measure = async () => ({ rail: await rect(rail), count: await rect(count),
      play: await rect(owner.locator('.pq-rail-run')), history: await rect(historyButton), queue: await rect(queue) });
    const equalRect = (actual, expected, label) => {
      for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[field] - expected[field]) <= 1,
        `${label}.${field} shifted: ${expected[field]} -> ${actual[field]}`);
    };
    const checkGeometry = async (label, requireDock = false) => {
      const geometry = await page.evaluate(() => {
        const box = element => {
          const r = element.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const pane = box(document.querySelector('[data-tab-layout-fixture]'));
        const dockNode = document.querySelector('[data-orchestration-activity-dock]');
        const dock = dockNode && visible(dockNode) ? box(dockNode) : null;
        const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const obstacles = [...document.querySelectorAll('[data-prompt-queue-panel-mode], [data-prompt-queue-edge-controls], .pq-collapsed-rail')]
          .filter(visible).map(box);
        const rows = [...document.querySelectorAll('[data-tab-message-row]')].filter(visible);
        return { pane, dock, insideRail: !!dockNode?.closest('.pq-collapsed-rail'),
          dockPosition: dockNode ? getComputedStyle(dockNode).position : null,
          overlap: !!dock && obstacles.some(obstacle => overlaps(dock, obstacle)),
          outsidePane: !!dock && (dock.left < pane.left - 1 || dock.right > pane.right + 1 || dock.top < pane.top - 1 || dock.bottom > pane.bottom + 1),
          rows: rows.map(element => ({ id: element.getAttribute('data-tab-message-row'), ...box(element),
            overflow: element.scrollWidth > element.clientWidth + 1,
            buttons: [...element.querySelectorAll('[data-tab-message-source], [data-tab-message-dismiss], [data-tab-message-open], [data-tab-message-stage]')]
              .map(button => ({ ...box(button), tag: button.tagName, kind: button.getAttribute('data-tab-message-stage')
                || button.hasAttribute('data-tab-message-open') && 'open' || button.hasAttribute('data-tab-message-dismiss') && 'dismiss' || 'source' })) })),
        };
      });
      result.geometry.push({ label, ...geometry });
      assert.ok(['absolute', 'fixed'].includes(geometry.dockPosition), 'activity dock must be outside normal rail flow');
      assert.equal(geometry.overlap, false, 'activity dock overlaps Run After or its controls');
      assert.equal(geometry.outsidePane, false, 'activity dock escaped its owning pane');
      if (requireDock) {
        assert.ok(geometry.dock && geometry.rows.length >= 2, 'wide pane must expose native/message activity dock');
        assert.equal(await owner.locator('[data-orchestration-activity-dock] [data-orchestration-active-run="layout-native-run"]').count(), 1);
      }
      for (const row of geometry.rows) {
        assert.ok(row.height >= 40 && row.height <= 48, `${row.id}: expected 40..48px, got ${row.height}`);
        assert.equal(row.overflow, false, `${row.id}: long label causes horizontal overflow`);
        for (const button of row.buttons) assert.ok(button.left >= row.left - 1 && button.right <= row.right + 1
          && button.top >= row.top - 1 && button.bottom <= row.bottom + 1, `${row.id}: ${button.kind} outside row`);
        const send = row.buttons.find(button => button.kind === 'send');
        const reply = row.buttons.find(button => button.kind === 'reply');
        const source = row.buttons.find(button => button.kind === 'source');
        const dismiss = row.buttons.find(button => button.kind === 'dismiss');
        const open = row.buttons.filter(button => button.kind === 'open');
        assert.equal(open.length, 1, `${row.id}: exactly one conversation opener`);
        assert.equal(open[0].tag, 'BUTTON');
        assert.ok(send && reply && source && dismiss, `${row.id}: both statuses, navigation and dismiss must remain visible`);
        assert.equal(send.tag, 'SPAN', 'Send is a status, not a second opener');
        assert.equal(reply.tag, 'SPAN', 'Reply is a status, not a third opener');
        assert.ok(Math.abs(send.top - reply.top) <= 1 && source.bottom <= send.top + 1,
          `${row.id}: expected separate source and stage lines`);
        assert.ok(send.right <= reply.left + 1 && source.right <= dismiss.left + 1, `${row.id}: controls overlap`);
      }
    };

    await page.evaluate(() => window.tabMessageLayout.historyDetails());
    await historyButton.click();
    await historyPanel.waitFor();
    const failedHistoryRow = historyPanel.locator('[data-orchestration-run-id="details-browser-failed"]');
    await failedHistoryRow.locator('button[aria-expanded]').click();
    const failedDetails = failedHistoryRow.locator('[data-orchestration-run-details]');
    const detailText = await failedDetails.innerText();
    assert.doesNotMatch(detailText, /Состояние|Доставка\s+sent|Причина\s|Исход\s/);
    assert.equal(detailText.split('Extension not connected').length - 1, 1, 'same execution/result error must appear once');
    assert.match(detailText, /Об ошибке доставлено/);
    assert.match(detailText, /Не выполнено: ошибка внешнего исследования/);
    assert.doesNotMatch(detailText, /Отправлен/, 'browser job acceptance must not invent ChatGPT delivery');
    const date = failedHistoryRow.locator('[data-orchestration-request-time]');
    const expectedDate = await page.evaluate(() => new Date('2026-10-04T15:10:31.022Z').toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
    assert.equal(await date.innerText(), 'Создан ' + expectedDate);
    assert.equal((await failedHistoryRow.innerText()).split(expectedDate).length - 1, 1, 'request timestamp is not repeated in details');
    assert.equal(await date.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'creation date clipped by a long title');
    assert.equal(await failedDetails.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'details have horizontal overflow');
    await page.screenshot({ path: path.join(runDir, 'history-failed-details.png') });
    await failedHistoryRow.locator('button[aria-expanded]').click();
    const successHistoryRow = historyPanel.locator('[data-orchestration-run-id="details-completed-undelivered"]');
    await successHistoryRow.locator('button[aria-expanded]').click();
    const successText = await successHistoryRow.locator('[data-orchestration-run-details]').innerText();
    assert.match(successText, /Выполнено/);
    assert.match(successText, /С результатом не доставлено/);
    assert.match(successText, /Synthetic notification-only failure/);
    assert.match(await successHistoryRow.locator('[data-orchestration-request-time]').innerText(), /Отправлен/);
    await page.screenshot({ path: path.join(runDir, 'history-success-notification-failed.png') });
    await successHistoryRow.locator('button[aria-expanded]').click();
    const differentHistoryRow = historyPanel.locator('[data-orchestration-run-id="details-different-errors"]');
    await differentHistoryRow.locator('button[aria-expanded]').click();
    const differentText = await differentHistoryRow.locator('[data-orchestration-run-details]').innerText();
    assert.match(differentText, /Synthetic execution failure/);
    assert.match(differentText, /Synthetic result proof failure/);
    assert.match(differentText, /future-specific-reason/);
    assert.match(differentText, /Доставка уведомления не подтверждена/);
    const historyDateGeometry = await historyPanel.locator('[data-orchestration-request-time]').evaluateAll(nodes => nodes.map(node => {
      const date = node.getBoundingClientRect();
      const header = node.parentElement.getBoundingClientRect();
      const preceding = [...node.parentElement.querySelectorAll('button[aria-expanded] span')].map(child => child.getBoundingClientRect());
      return { clipped: node.scrollWidth > node.clientWidth, contained: date.left >= header.left && date.right <= header.right,
        overlaps: preceding.some(box => box.bottom > date.top + 1 && box.right > date.left && box.left < date.right) };
    }));
    assert.ok(historyDateGeometry.every(item => !item.clipped && item.contained && !item.overlaps), 'request date overlaps or clips on a long status/title');
    result.checks.push('History: one error copy, combined outcome, notification distinct from execution, full minute dates, unknown evidence retained');
    await page.keyboard.press('Escape');
    await historyPanel.waitFor({ state: 'hidden' });

    for (const mode of ['pinned', 'preview']) {
      await page.evaluate(width => window.tabMessageLayout.reset(width), width);
      await far();
      await historyButton.waitFor();
      if (mode === 'pinned') await count.click();
      else await count.hover();
      await queue.waitFor();
      await settle();
      assert.equal(await queue.getAttribute('data-prompt-queue-panel-mode'), mode);
      const before = await measure();
      const beforeState = await state();
      await page.evaluate(() => window.tabMessageLayout.arrive());
      await settle();
      const after = await measure();
      result.geometry.push({ label: mode + '-arrival', before, after });
      for (const key of Object.keys(before)) equalRect(after[key], before[key], `${mode}.${key}`);
      assert.ok(after.rail.height <= 30, `service rail grew to ${after.rail.height}px`);
      assert.equal(await queue.getAttribute('data-prompt-queue-panel-mode'), mode);
      assert.deepEqual((await state()).queue, beforeState.queue, 'message arrival mutated queue state');
      assert.deepEqual((await state()).runs, beforeState.runs, 'message arrival mutated native run');
      assert.equal((await state()).calls.filter(call => call.channel === 'tab-messages:get').length, 0,
        'layout must not eagerly load message bodies');
      await checkGeometry(mode, width === 1000);
      await page.screenshot({ path: path.join(runDir, mode + '.png') });
      result.checks.push(`${mode}: stable rail/queue, compact rows, no overlap, no lifecycle mutation`);
      if (width === 350 && mode === 'pinned') {
        assert.equal(await owner.locator('[data-orchestration-activity-dock]').isVisible(), false,
          '350px pinned queue should use the shared History fallback');
        await historyButton.click();
        await historyPanel.waitFor();
        assert.equal(await historyPanel.locator('[data-tab-message-history-row]').count(), 2);
        const native = historyPanel.locator('[data-orchestration-run-id="layout-native-run"]');
        await native.locator('button[aria-expanded]').click();
        for (const action of ['pause', 'detach']) {
          const actionButton = native.locator(`[data-orchestration-action="${action}"]`);
          await actionButton.waitFor();
          await actionButton.click({ trial: true });
        }
        const paneBox = await rect(owner), historyBox = await rect(historyPanel);
        assert.ok(historyBox.x >= paneBox.x && historyBox.x + historyBox.width <= paneBox.x + paneBox.width + 1,
          'narrow History fallback escaped the pane');
        await page.screenshot({ path: path.join(runDir, 'narrow-pinned-native-actions.png') });
        await page.keyboard.press('Escape');
        await historyPanel.waitFor({ state: 'hidden' });
        assert.equal(await queue.getAttribute('data-prompt-queue-panel-mode'), 'pinned');
        assert.deepEqual((await state()).queue, beforeState.queue, 'fallback changed pinned/auto-run queue');
        result.checks.push('narrow pinned fallback retains hittable native Pause/Detach and queue state');
      }
      if (mode === 'pinned') { await count.click(); await far(); }
      else { await far(); }
      await queue.waitFor({ state: 'hidden' });
    }

    const getQuestionRow = async (id = 'layout-question') => {
      const live = owner.locator(`[data-orchestration-activity-dock] [data-tab-message-row="${id}"]`);
      if (!await historyPanel.isVisible() && await live.isVisible()) return live;
      if (!await historyPanel.isVisible()) await historyButton.click();
      await historyPanel.waitFor();
      const archived = historyPanel.locator(`[data-tab-message-history-row="${id}"]`);
      await archived.waitFor();
      return archived;
    };
    let row = await getQuestionRow();
    await checkGeometry('interaction-rows');
    for (const closeMethod of ['escape', 'close']) {
      const rowBox = await rect(row);
      const fromHistory = await historyPanel.isVisible();
      const opener = row.locator('[data-tab-message-open]');
      assert.equal(await opener.count(), 1);
      assert.equal(await row.locator('button[data-tab-message-stage]').count(), 0);
      await opener.click();
      await preview.waitFor();
      await preview.locator('details[data-tab-message-body="layout-reply"]').waitFor();
      await settle();
      if (fromHistory) assert.equal(await historyPanel.isVisible(), true,
        'opening the message preview must keep request History open');
      assert.equal(await opener.getAttribute('aria-expanded'), 'true');
      assert.equal(await preview.locator('details[data-tab-message-body]').count(), 2);
      assert.deepEqual(await preview.locator('details[data-tab-message-body]').evaluateAll(nodes => nodes.map(node => node.open)),
        [false, false], 'both message bodies must start collapsed');
      assert.equal((await state()).navigation.length, 0, 'stage click navigated instead of opening preview');
      const panelBox = await rect(preview);
      const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= viewport.width + 1, 'preview exceeds viewport');
      if (width === 1000 && !fromHistory) {
        const overlapX = Math.min(panelBox.x + panelBox.width, rowBox.x + rowBox.width) - Math.max(panelBox.x, rowBox.x);
        const overlapY = Math.min(panelBox.y + panelBox.height, rowBox.y + rowBox.height) - Math.max(panelBox.y, rowBox.y);
        assert.ok(overlapX <= 1 || overlapY <= 1, `${closeMethod} preview overlaps its own card despite available wide space`);
      }
      await preview.locator('details[data-tab-message-body="layout-question"] > summary').click();
      await preview.locator('[data-tab-message-text="layout-question"]').waitFor();
      assert.match(await preview.locator('[data-tab-message-text="layout-question"]').innerText(), /Question body sentinel/);
      await preview.locator('details[data-tab-message-body="layout-reply"] > summary').click();
      assert.match(await preview.locator('[data-tab-message-text="layout-reply"]').innerText(), /Answer body sentinel/);
      await page.screenshot({ path: path.join(runDir, `preview-${closeMethod}.png`) });
      if (closeMethod === 'escape') await page.keyboard.press('Escape');
      else await preview.getByRole('button', { name: '\u0417\u0430\u043a\u0440\u044b\u0442\u044c \u0432\u043e\u043f\u0440\u043e\u0441 \u0438 \u043e\u0442\u0432\u0435\u0442', exact: true }).click();
      await preview.waitFor({ state: 'hidden' });
      if (fromHistory) assert.equal(await historyPanel.isVisible(), true, 'closing a child preview must retain History');
      row = await getQuestionRow();
    }
    result.checks.push('one opener with Send/Reply statuses, closed details, expandable bodies, Escape and close');
    await row.locator('[data-tab-message-source]').click();
    assert.equal((await state()).navigation.at(-1)?.tabId, 'layout-peer');
    assert.equal((await state()).navigation.at(-1)?.projectId, 'layout-peer-project');
    assert.equal((await state()).navigation.at(-1)?.kind, 'placeTab', 'message source navigation must preserve window placement');
    assert.equal(await preview.count(), 0, 'source navigation also opened a preview');
    result.checks.push('source chip navigation is independent from preview');

    const queueBeforeDismiss = structuredClone((await state()).queue);
    const runBeforeDismiss = structuredClone((await state()).runs);
    const navigationBeforeDismiss = structuredClone((await state()).navigation);
    for (const [id, field] of [['layout-question', 'targetDismissedAt'], ['layout-outgoing', 'sourceDismissedAt']]) {
      row = await getQuestionRow(id);
      await row.locator('[data-tab-message-dismiss]').click();
      await page.waitForFunction(({ id, field }) => !!window.tabMessageLayout.state().messages.find(item => item.messageId === id)?.[field], { id, field });
      await settle();
      assert.equal(await owner.locator(`[data-orchestration-activity-dock] [data-tab-message-row="${id}"]`).count(), 0,
        'dismissed question remains in live dock');
      const calls = (await state()).calls.filter(call => call.channel === 'tab-messages:dismiss' && call.args[0].messageId === id);
      assert.equal(calls.length, 1, 'one close gesture must make exactly one dismiss request');
      assert.deepEqual(calls[0].args[0], { tabId: 'layout-owner', messageId: id });
      if (!await historyPanel.isVisible()) await historyButton.click();
      await historyPanel.locator(`[data-tab-message-history-row="${id}"]`).waitFor();
    }
    assert.deepEqual((await state()).queue, queueBeforeDismiss, 'dismiss changed Run After');
    assert.deepEqual((await state()).runs, runBeforeDismiss, 'dismiss changed native orchestration');
    assert.deepEqual((await state()).navigation, navigationBeforeDismiss, 'dismiss also navigated');
    assert.equal(await preview.count(), 0, 'dismiss also opened a preview');
    assert.equal(await historyPanel.locator('[data-tab-message-history-row]').count(), 2);
    assert.equal(await historyPanel.locator('[data-orchestration-run-id="layout-native-run"]').count(), 1);
    await page.screenshot({ path: path.join(runDir, 'history-dismissed.png') });
    result.checks.push('both-side dismiss is exact-once, retains shared history and never changes queue/run');

    const native = historyPanel.locator('[data-orchestration-run-id="layout-native-run"]');
    if (width === 500) {
      await historyButton.click();
      await historyPanel.waitFor({ state: 'hidden' });
      await far();
      await owner.locator('[data-orchestration-active-run="layout-native-run"]').hover();
      await page.getByRole('tooltip').filter({ hasText: 'layout-native-run' }).waitFor();
      // A quick, trusted move into History exercises the interactive tooltip's
      // existing leave grace. Waiting for it to vanish would hide this overlap.
      const trigger = await rect(historyButton);
      await page.mouse.click(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
      await historyPanel.waitFor();
      const target = await rect(native.locator('button[aria-expanded]'));
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    }
    await native.locator('button[aria-expanded]').click();
    for (const action of ['pause', 'detach']) {
      const button = native.locator(`[data-orchestration-action="${action}"]`);
      await button.waitFor();
      assert.equal(await button.isEnabled(), true, `native ${action} is unavailable in shared history`);
    }
    await native.getByRole('button', { name: '\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u0441\u0432\u044f\u0437\u0430\u043d\u043d\u0443\u044e \u0432\u043a\u043b\u0430\u0434\u043a\u0443', exact: true }).click();
    assert.equal((await state()).navigation.at(-1)?.tabId, 'layout-target');
    assert.equal((await state()).navigation.at(-1)?.kind, 'placeTab');
    await historyPanel.waitFor({ state: 'hidden' });
    await historyButton.click(); await historyPanel.waitFor();
    await historyButton.click(); await historyPanel.waitFor({ state: 'hidden' });
    await historyButton.click(); await historyPanel.waitFor();
    await page.keyboard.press('Escape'); await historyPanel.waitFor({ state: 'hidden' });
    await historyButton.click(); await historyPanel.waitFor();
    await page.mouse.click(10, 780); await historyPanel.waitFor({ state: 'hidden' });
    result.checks.push('native navigation retained; repeated History click, Escape and outside close');
    await page.evaluate(() => window.tabMessageLayout.remount());
    await settle();
    assert.equal(await owner.locator('[data-orchestration-activity-dock] [data-tab-message-row]').count(), 0);
    await historyButton.click();
    await historyPanel.locator('[data-tab-message-history-row="layout-question"]').waitFor();
    assert.equal(await historyPanel.locator('[data-tab-message-history-row]').count(), 2);
    result.checks.push('dismissal survives component remount through the list IPC');

    await page.evaluate(() => window.tabMessageLayout.addHistory());
    const historyList = historyPanel.locator('[data-request-history-list]');
    const question = historyPanel.locator('[data-tab-message-history-row="layout-question"]');
    await question.scrollIntoViewIfNeeded();
    await settle();
    const scrollBefore = await historyList.evaluate(node => node.scrollTop);
    assert.ok(scrollBefore > 0, 'fixture must exercise a scrolled request list');
    const historyBefore = await rect(historyPanel);
    const historyOpener = question.locator('[data-tab-message-open]');
    const assertHistoryRetained = async label => {
      assert.equal(await historyPanel.isVisible(), true, label + ': History closed');
      assert.equal(await historyList.evaluate(node => node.scrollTop), scrollBefore, label + ': History scroll changed');
      equalRect(await rect(historyPanel), historyBefore, label + ': History geometry');
    };
    for (const closeMethod of ['close', 'escape']) {
      await historyOpener.click();
      await preview.waitFor();
      await settle();
      await assertHistoryRetained('open from scrolled History');
      assert.equal(await historyPanel.locator('[data-orchestration-run-id]').count(), 17);
      const child = await rect(preview), parent = await rect(historyPanel);
      if (width === 1000) assert.ok(child.x + child.width <= parent.x || child.x >= parent.x + parent.width,
        'side preview must not cover History when there is space beside it');
      await page.screenshot({ path: path.join(runDir, `history-with-preview-collapsed-${closeMethod}.png`) });
      for (const id of ['layout-question', 'layout-reply']) await preview.locator(`[data-tab-message-body="${id}"] > summary`).click();
      await assertHistoryRetained('read both message bodies');
      await page.screenshot({ path: path.join(runDir, `history-with-preview-${closeMethod}.png`) });
      if (closeMethod === 'escape') await page.keyboard.press('Escape');
      else await preview.getByRole('button', { name: '\u0417\u0430\u043a\u0440\u044b\u0442\u044c \u0432\u043e\u043f\u0440\u043e\u0441 \u0438 \u043e\u0442\u0432\u0435\u0442', exact: true }).click();
      await preview.waitFor({ state: 'hidden' });
      await assertHistoryRetained(closeMethod + ' child only');
      assert.equal(await historyOpener.getAttribute('aria-expanded'), 'false');
    }
    if (width === 1000) {
      await historyOpener.click(); await preview.waitFor();
      await historyOpener.click(); await preview.waitFor({ state: 'hidden' });
      await assertHistoryRetained('toggle same conversation');
      await historyOpener.click(); await preview.waitFor();
      await historyPanel.locator('[data-tab-message-history-row="layout-outgoing"] [data-tab-message-open]').click();
      await page.locator('[data-tab-message-preview="layout-outgoing"]').waitFor();
      await assertHistoryRetained('switch conversation');
      await historyPanel.getByRole('button', { name: '\u0417\u0430\u043a\u0440\u044b\u0442\u044c', exact: true }).click();
      await historyPanel.waitFor({ state: 'hidden' });
      await preview.waitFor({ state: 'hidden' });
      await historyButton.click(); await historyPanel.waitFor();
    }
    await page.keyboard.press('Escape'); await historyPanel.waitFor({ state: 'hidden' });
    await historyButton.click(); await historyPanel.waitFor();
    await question.scrollIntoViewIfNeeded(); await historyOpener.click(); await preview.waitFor();
    await page.mouse.click(10, 780);
    await historyPanel.waitFor({ state: 'hidden' }); await preview.waitFor({ state: 'hidden' });
    result.checks.push('scrolled History survives preview read/close/Escape; single opener; side-by-side, toggle, switch and parent/outside close');

    await page.evaluate(width => window.tabMessageLayout.reset(width), width);
    await far();
    await page.evaluate(() => { window.tabMessageLayout.arrive(); window.tabMessageLayout.overflow(); });
    await settle();
    const dock = owner.locator('[data-orchestration-activity-dock]');
    if (width === 1000) {
      const metrics = await dock.evaluate(node => {
        const headers = [...node.querySelectorAll('[data-request-row-header]')];
        const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height }; };
        return { headers: headers.map(box), slots: [...node.querySelectorAll('[data-request-status-slot]')].map(box),
          closes: [...node.querySelectorAll('[data-tab-message-dismiss], [data-orchestration-dismiss]')].map(box),
          children: [...node.querySelectorAll('[data-request-child-row]')].map(box),
          childIcons: [...node.querySelectorAll('[data-tab-message-stage]')].map(stage => stage.querySelectorAll('svg').length),
          chevrons: node.querySelectorAll('[data-tab-message-open] .lucide-chevron-right').length,
          overflow: node.scrollHeight > node.clientHeight,
          nativeOverflow: [...node.querySelectorAll('[data-orchestration-active-list]')].some(list => getComputedStyle(list).overflowY === 'auto'),
          scrollbarWidth: getComputedStyle(node, '::-webkit-scrollbar').width,
          horizontalOverflow: node.scrollWidth > node.clientWidth,
        };
      });
      result.geometry.push({ label: 'unified-overflow-metrics', ...metrics });
      assert.ok(metrics.headers.length > 3 && metrics.closes.length > 3 && metrics.overflow);
      assert.ok(metrics.headers.every(row => row.height === 26));
      assert.ok(metrics.headers.every(row => Math.abs(row.left - metrics.headers[0].left) < 1 && Math.abs(row.right - metrics.headers[0].right) < 1));
      assert.ok(metrics.closes.every(button => Math.abs(button.right - metrics.closes[0].right) < 1 && button.height === 24));
      assert.ok(metrics.slots.every(slot => Math.abs(slot.left - metrics.slots[0].left) < 1 && slot.right - slot.left === 26));
      assert.ok(metrics.children.every(child => child.left >= metrics.headers[0].left + 18));
      assert.ok(metrics.childIcons.every(count => count === 1), 'status stages must not repeat success as extra check icons');
      assert.equal(metrics.chevrons, 0);
      assert.equal(metrics.scrollbarWidth, '3px');
      assert.equal(metrics.nativeOverflow, false);
      assert.equal(metrics.horizontalOverflow, false);
      await page.screenshot({ path: path.join(runDir, 'unified-rows-scrollbar.png') });
    }
    result.checks.push('shared header/status/action metrics, one indented Send/Reply child, no duplicate checks/chevron, one thin scroller');

    const dismissCallsBefore = (await state()).calls.filter(call => call.channel === 'tab-messages:dismiss').length;
    await page.evaluate(() => window.tabMessageLayout.completePair());
    row = await getQuestionRow('layout-outgoing');
    await row.locator('[data-tab-message-open]').click();
    await preview.waitFor();
    await dock.locator('[data-tab-message-row="layout-question"]').waitFor({ state: 'detached' });
    assert.equal(await dock.locator('[data-tab-message-row="layout-outgoing"]').count(), 1,
      'later success must keep its own visibility interval');
    await dock.locator('[data-orchestration-active-run="layout-native-run"]').waitFor({ state: 'detached' });
    await dock.locator('[data-tab-message-row="layout-outgoing"]').waitFor({ state: 'detached' });
    assert.equal(await preview.isVisible(), true, 'expiry must not close the answer being read');
    assert.equal(await dock.locator('[data-orchestration-active-run="layout-error-run"]').count(), 1);
    assert.equal(await dock.locator('[data-tab-message-row="layout-extra-0"]').count(), 1, 'waiting for a reply is not completion');
    assert.equal((await state()).calls.filter(call => call.channel === 'tab-messages:dismiss').length, dismissCallsBefore,
      'auto-hide is a read projection, not an acknowledgement/dismiss mutation');
    await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
    if (!await historyPanel.isVisible()) await historyButton.click();
    await historyPanel.locator('[data-tab-message-history-row="layout-question"]').waitFor();
    await historyPanel.locator('[data-tab-message-history-row="layout-outgoing"]').waitFor();
    assert.equal(await historyPanel.locator('[data-orchestration-run-id="layout-native-run"]').count(), 1);
    await page.screenshot({ path: path.join(runDir, 'completed-in-history.png') });
    await page.keyboard.press('Escape'); await historyPanel.waitFor({ state: 'hidden' });
    await page.evaluate(() => window.tabMessageLayout.remount()); await settle();
    assert.equal(await dock.locator('[data-tab-message-row="layout-question"]').count(), 0);
    assert.equal(await dock.locator('[data-tab-message-row="layout-outgoing"]').count(), 0);
    result.checks.push('success expiry advances without new events, retains History/open preview, keeps failure/waiting, survives remount without mutations');
    assert.deepEqual((await state()).violations, []);
    assert.deepEqual(await app.evaluate(() => global.blockedRequests), []);
    assert.deepEqual(result.errors, []);
    result.pass = true;
  } catch (error) {
    result.failure = error.stack || String(error);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => {});
      result.fixture = await page.evaluate(() => window.tabMessageLayout?.state?.() || window.tabMessageLayout).catch(() => null);
      result.failureSurfaces = await page.evaluate(() => [...document.querySelectorAll(
        '[role="tooltip"], [data-orchestration-history-panel], [data-orchestration-activity-dock], [data-tab-message-preview]',
      )].map(element => {
        const rect = element.getBoundingClientRect();
        return { role: element.getAttribute('role'), attributes: [...element.attributes].filter(attribute => attribute.name.startsWith('data-'))
          .map(attribute => [attribute.name, attribute.value]), text: element.textContent?.slice(0, 500),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 500) };
      })).catch(() => null);
    }
    throw error;
  } finally {
    try {
      if (app) await closeOwnedApp(app, result);
    } finally {
      await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    }
  }
});
});
} catch (error) {
  report.setupError = error.stack || String(error);
  throw error;
} finally {
  const cleanup = report.cleanup = { removed: [], errors: [] };
  for (const [app, result] of ownedApps) {
    await closeOwnedApp(app, result).catch(error => cleanup.errors.push(String(error)));
  }
  // Save evidence before removing only paths made under this mkdtemp root.
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(report, null, 2));
  if (ownedApps.size === 0) {
    const temporary = ['source', 'noted-shared', 'bundle.js', 'bundle.js.map', 'bundle.css', 'bundle.css.map',
      'globals.css', 'index.html', ...widths.flatMap(width => [`${width}/user-data`, `${width}/main.cjs`])];
    for (const relative of temporary) {
      try {
        await fs.rm(path.join(artifact, relative), { recursive: true, force: true });
        cleanup.removed.push(relative);
      } catch (error) { cleanup.errors.push(`${relative}: ${error}`); }
    }
  } else cleanup.errors.push('Owned Electron still alive; launch artifacts retained for diagnosis');
  report.pass = !report.setupError && cleanup.errors.length === 0 && report.results.length === widths.length
    && report.results.every(result => result.pass && result.electron?.closed);
  await fs.writeFile(path.join(artifact, 'result.json'), JSON.stringify(report, null, 2));
  console.log('Tab message layout artifacts:', artifact);
  assert.deepEqual(cleanup.errors, [], 'private harness cleanup failed');
}
