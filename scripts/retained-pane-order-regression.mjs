#!/usr/bin/env node
// Isolated Chromium only: real React/Virtuoso, no app, PTY, API or native input.
// The control deliberately moves an existing DOM owner; the fixed path imports
// the same ordering function used by TerminalArea.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const { outputFiles } = await build({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
import React, { useEffect, useState, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { retainedTabLayers } from './src/renderer/utils/retainedLayerOrder.mjs';
window.proof = { mounts: {}, unmounts: {}, ranges: {}, scrolls: {} };
const Panel = memo(({ tab, projectId, presented }) => {
  const id = tab.id;
  useEffect(() => {
    window.proof.mounts[id] = (window.proof.mounts[id] || 0) + 1;
    return () => { window.proof.unmounts[id] = (window.proof.unmounts[id] || 0) + 1; };
  }, []);
  return <div data-panel={id} data-project={projectId} data-presented={presented}
    style={{ position: 'absolute', top: 0, left: id === 'tab-b' ? 320 : 0,
      width: 300, height: 500, opacity: presented ? 1 : 0, pointerEvents: presented ? 'auto' : 'none' }}>
    <Virtuoso style={{ height: 500 }} totalCount={1000} initialTopMostItemIndex={990}
      rangeChanged={range => { window.proof.ranges[id] = range; }}
      itemContent={i => <div data-row={i} style={{ height: 60 }}>row {i}</div>} />
  </div>;
});
const workspace = (...ids) => ({ tabs: new Map(ids.map(id => [id, { id }])) });
function App() {
  const [projects, setProjects] = useState(() => new Map([
    ['project-a', workspace('tab-a', 'tab-c')], ['project-b', workspace('tab-b', 'tab-d')],
  ]));
  const [shown, setShown] = useState(true);
  const change = update => flushSync(() => setProjects(update));
  window.actions = {
    projects: () => change(previous => new Map([...previous].reverse())),
    tabs: () => change(previous => new Map([...previous].map(([id, value]) => [id, {
      ...value, tabs: new Map([...value.tabs].reverse()),
    }]))),
    move: () => change(previous => {
      const next = new Map([...previous].map(([id, value]) => [id, { ...value, tabs: new Map(value.tabs) }]));
      const source = next.get('project-a'), target = next.get('project-b');
      target.tabs.set('tab-a', source.tabs.get('tab-a')); source.tabs.delete('tab-a'); return next;
    }),
    insert: () => change(previous => new Map([['project-new', workspace('tab-0')], ...previous])),
    remove: () => change(previous => { const next = new Map(previous); next.delete('project-new'); return next; }),
    visibility: () => flushSync(() => setShown(value => !value)),
  };
  const layers = window.stableOrder ? retainedTabLayers(projects)
    : [...projects].flatMap(([projectId, workspace]) => [...workspace.tabs.values()].map(tab => ({ projectId, tab })));
  return <div id="layers">{layers.map(({ tab, projectId }) => <Panel key={tab.id}
    tab={tab} projectId={projectId} presented={shown && ['tab-a', 'tab-b'].includes(tab.id)} />)}</div>;
}
createRoot(document.getElementById('root')).render(<App />);
` },
  bundle: true, write: false, format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const browser = await chromium.launch({ headless: true });
try {
  const outcomes = [];
  for (const stableOrder of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 660, height: 550 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.evaluate(stable => { window.stableOrder = stable; }, stableOrder);
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-panel]')].length === 4
      && [...document.querySelectorAll('[data-panel] [data-testid="virtuoso-scroller"]')].every(s => s.scrollTop > 50000));
    // Let initial positioning finish before testing silent DOM reinsert.
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      window.originalScrollers = Object.fromEntries([...document.querySelectorAll('[data-panel]')].map(node => {
        const id = node.dataset.panel;
        const scroller = node.querySelector('[data-testid="virtuoso-scroller"]');
        scroller.addEventListener('scroll', () => { window.proof.scrolls[id] = (window.proof.scrolls[id] || 0) + 1; });
        return [id, scroller];
      }));
      window.sample = () => Object.fromEntries(Object.entries(window.originalScrollers).map(([id, scroller]) => {
        const viewport = scroller.getBoundingClientRect();
        const rows = [...scroller.querySelectorAll('[data-row]')].filter(node => {
          const rect = node.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        return [id, { top: scroller.scrollTop, height: scroller.scrollHeight, rows: rows.length,
          firstRow: rows[0]?.dataset.row, offset: rows[0]?.getBoundingClientRect().top - viewport.top,
          same: scroller === document.querySelector('[data-panel="' + id + '"] [data-testid="virtuoso-scroller"]') }];
      }));
    });
    const baseline = await page.evaluate(() => window.sample());
    const actions = stableOrder
      ? ['projects', 'projects', 'tabs', 'projects', 'move', 'insert', 'remove', 'visibility', 'visibility', 'tabs', 'projects']
      : ['projects'];
    let last;
    for (const action of actions) {
      last = await page.evaluate(async action => {
        window.actions[action]();
        const immediate = window.sample();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { immediate, settled: window.sample(), proof: window.proof };
      }, action);
      if (stableOrder) {
        assert.deepEqual(last.immediate, baseline, action + ': atomic retained viewport');
        assert.deepEqual(last.settled, baseline, action + ': settled retained viewport');
        for (const id of Object.keys(baseline)) assert.equal(last.proof.unmounts[id] || 0, 0);
      }
    }
    if (!stableOrder) {
      assert.equal(last.immediate['tab-a'].top, 0);
      assert.equal(last.immediate['tab-a'].rows, 0);
      assert.equal(last.immediate['tab-a'].same, true);
      assert.equal(last.proof.unmounts['tab-a'] || 0, 0);
      await page.waitForTimeout(1000);
      const stale = await page.evaluate(() => ({ viewport: window.sample()['tab-a'], range: window.proof.ranges['tab-a'] }));
      assert.equal(stale.viewport.rows, 0);
      assert.equal(stale.range.startIndex, 990);
    }
    assert.deepEqual(errors, []);
    outcomes.push({ mode: stableOrder ? 'stable-content-order' : 'old-navigation-order-control',
      actions: actions.length, before: baseline['tab-a'], after: last.settled['tab-a'],
      scrollEvents: last.proof.scrolls['tab-a'] || 0, unmounts: last.proof.unmounts['tab-a'] || 0 });
    await page.close();
  }
  console.log(JSON.stringify({ success: true, browser: browser.version(), outcomes }, null, 2));
} finally {
  await browser.close();
}
