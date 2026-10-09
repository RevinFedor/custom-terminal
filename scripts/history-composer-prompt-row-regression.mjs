#!/usr/bin/env node
// Production band JSX + scoped CSS + ComposerChip, rendered in an isolated
// Chromium component fixture. Not full Electron/Main/provider acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('..', import.meta.url));
const artifact = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-prompt-row-'));
const source = await fs.readFile(path.join(repo, 'src/renderer/components/Workspace/HistoryPanel.tsx'), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let band;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'historyComposerPromptBand') band = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(band, 'actual production band must be found');
const start = source.indexOf('[data-history-composer-prompt-band] .cb-composer-chip {');
const end = source.indexOf('.hp-composer-chip-preview {', start);
assert.ok(start >= 0 && end > start);
const scopedCSS = source.slice(start, end);
const originalLayout = await fs.readFile(path.join(repo, 'src/renderer/utils/historyComposerPromptBandLayout.mjs'), 'utf8');
const result = { artifact, boundary: 'Actual production band JSX/scoped CSS/ComposerChip and layout helper; synthetic draft, no Electron/Main/IPC/provider/OS clipboard', cases: [], cleanup: {} };
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ComposerChip } from './packages/claude-blocks/src/components/ComposerFrame';
import { promptChipDisplayLabel } from './src/shared/composer-chips.mjs';
import { resolveHistoryComposerPromptBandLayout } from './src/renderer/utils/historyComposerPromptBandLayout.mjs';
import './packages/claude-blocks/src/theme.css';
import './packages/claude-blocks/src/blocks.css';
const state = window.promptRowFixture = { selected: null, dismissed: [], input: 'UNCHANGED PRIVATE DRAFT' };
const HISTORY_SERVICE_TEXT_RATIO = .82, HISTORY_SERVICE_TEXT_WEIGHT = 400;
const historyComposerStatusRise = size => Math.ceil(size * HISTORY_SERVICE_TEXT_RATIO * 1.35 / 2);
function Fixture() {
  const [config, setConfig] = useState({width:327, font:13, inherited:false, count:2});
  state.setCase = config => flushSync(() => { state.selected = null; state.dismissed = []; setConfig(config); });
  const contextUpdates = [], tabId = 'PRIVATE-PROMPT-ROW', previewChipId = null;
  const promptBandRightInset = 58, historyTranscriptFontSize = config.font;
  const composerPromptChips = Array.from({length:config.count}, (_, index) => ({
    id:'private-prompt-' + index, kind:'prompt', text:'PRIVATE BODY ' + index,
    label:index === 0 ? 'правила общения с ai' : index === 1 ? 'разбор-продуктового-решения' : 'независимый длинный промпт ' + index,
    inheritanceDepth:config.inherited && index === 1 ? 1 : 0,
    inheritanceParentLabel:config.inherited && index === 1 ? 'правила общения с ai' : undefined,
  }));
  const historyContextFileChipProps = chip => ({title:chip.inheritanceParentLabel ? 'Наследует: ' + chip.inheritanceParentLabel : undefined});
  const setPreviewChipId = update => { state.selected = update(state.selected); };
  const discardComposerChip = id => { state.dismissed.push(id); };
  const historyComposerPromptBandLayout = resolveHistoryComposerPromptBandLayout(composerPromptChips.length);
  const ${band};
  return <div data-fixture-panel style={{position:'relative',width:config.width,height:130,marginTop:150,background:'#191919',fontSize:config.font,
    '--cb-fs-label':config.font * .82 + 'px'}}>
    <div data-fixture-composer style={{position:'absolute',inset:'60px 4px 0',border:'1px solid #cf896b'}}>{state.input}</div>
    <div style={{position:'absolute',left:4,right:4,bottom:70}}>{historyComposerPromptBand}</div>
  </div>;
}
document.body.style.background = '#191919';
createRoot(document.getElementById('root')).render(<Fixture />);
`;
let browser;
try {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: repo, loader: 'tsx' }, bundle: true,
    outfile:path.join(artifact,'bundle.js'), write: false, format: 'iife', platform: 'browser', target: 'chrome120', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' } });
  const js = bundled.outputFiles.find(file => file.path.endsWith('.js') || file.path === '<stdout>')?.text;
  const css = bundled.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  assert.ok(js && css, 'production component and stylesheet must be bundled');
  browser = await chromium.launch({ headless: true, channel:'chrome' });
  const page = await browser.newPage({ viewport: {width:1000,height:650}, deviceScaleFactor:2 });
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css + '\n' + scopedCSS });
  await page.addScriptTag({ content: js });
  await page.locator('[data-history-composer-prompt-band]').waitFor();
  for (const width of [327,500,900]) for (const font of [13,24]) for (const count of [2,3,7,12]) {
    const inherited = count === 2 && font === 24;
    await page.evaluate(config => window.promptRowFixture.setCase(config), {width,font,count,inherited});
    const measurement = await page.evaluate(() => {
      const band = document.querySelector('[data-history-composer-prompt-band]');
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      return {band:rect(band),chips:[...band.children].map(chip=>({rect:rect(chip),label:chip.querySelector('.cb-composer-chip-label')?.textContent})),
        composer:rect(document.querySelector('[data-fixture-composer]')),input:window.promptRowFixture.input};
    });
    const rows = [...new Set(measurement.chips.map(chip=>chip.rect.top))];
    const item = {width,font,count,inherited,...measurement,rows:rows.length}; result.cases.push(item);
    if (count === 2 && width === 327) await page.screenshot({path:path.join(artifact,'pair-'+font+'.png')});
    assert.ok(rows.length <= 3, 'large sets still use at most three rows');
    if (count <= 3) assert.equal(rows.length,1, 'small sets must stay in a left-to-right row');
    for (let i=0;i<measurement.chips.length;i++) {
      const chip=measurement.chips[i], previous=measurement.chips[i-1];
      assert.ok(chip.rect.left >= measurement.band.left-.1 && chip.rect.right <= measurement.band.right+.1, 'chip must not clip');
      if (previous) assert.ok(chip.rect.top > previous.rect.top || chip.rect.left >= previous.rect.right+4.9, 'LTR order/no overlap');
    }
    assert.equal(measurement.input,'UNCHANGED PRIVATE DRAFT');
    if (count === 2 && width === 327) {
      await page.screenshot({path:path.join(artifact,'pair-'+font+'.png')});
      await page.locator('[data-history-composer-prompt-band] .cb-composer-chip-hit').nth(1).click();
      assert.equal(await page.evaluate(()=>window.promptRowFixture.selected),'private-prompt-1');
      await page.locator('[data-history-composer-prompt-band] .cb-composer-chip-hit').nth(1).click({button:'middle'});
      assert.deepEqual(await page.evaluate(()=>window.promptRowFixture.dismissed),['private-prompt-1']);
      assert.equal(measurement.chips[1].label.startsWith('↳ '),inherited,'inheritance label is preserved, not inferred from rows');
    }
  }
  result.status='PASS';
} catch(error) {
  result.status='FAIL'; result.error=String(error.stack); process.exitCode=1;
} finally {
  if(browser) { await browser.close(); result.cleanup.browserClosed=true; }
  result.sourceUnchanged = originalLayout === await fs.readFile(path.join(repo,'src/renderer/utils/historyComposerPromptBandLayout.mjs'),'utf8');
  result.sourceHash = createHash('sha256').update(originalLayout).digest('hex');
  await fs.writeFile(path.join(artifact,'RESULT.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({artifact,status:result.status,cases:result.cases.length,error:result.error,cleanup:result.cleanup}));
}
