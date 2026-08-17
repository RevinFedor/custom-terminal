import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelSource = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'HistoryPanel.tsx'),
  'utf8',
);
const blocksCss = fs.readFileSync(
  path.join(here, '..', '..', '..', 'packages', 'claude-blocks', 'src', 'blocks.css'),
  'utf8',
);
const toolCardsSource = fs.readFileSync(
  path.join(here, '..', '..', '..', 'packages', 'claude-blocks', 'src', 'components', 'ToolCards.tsx'),
  'utf8',
);

test('opening an inner aggregate reveals collapsed child cards, never forced-open bodies', () => {
  assert.doesNotMatch(panelSource, /forceToolOpen|forceOpen/);
  assert.match(panelSource, /collapse=\{\{ open, onToggle, anchorRef \}\}/);
  assert.doesNotMatch(
    panelSource,
    /\.hp-history-subgroup-member \.cb-tool-head\s*\{\s*display:\s*none/,
  );
  assert.match(
    panelSource,
    /\.hp-history-subgroup-member \.cb-tool:has\(> \.cb-tool-body\)/,
    'body spacing may appear only after the user opens that child card',
  );
});

test('ordinary card chevrons are hover-only; group chevrons remain structural', () => {
  assert.match(blocksCss, /\.cb-tool-chevron\s*\{[^}]*opacity:\s*0/s);
  assert.match(
    blocksCss,
    /\.cb-tool-head--clickable \.cb-tool-head-inner:hover \.cb-tool-chevron\s*\{\s*opacity:\s*1/,
  );
  assert.match(panelSource, /expanded\s*\?\s*<ChevronDown[\s\S]*:\s*<ChevronRight/);
});

test('outer uniform styling cannot erase labels from nested child cards', () => {
  assert.match(
    panelSource,
    /\.hp-history-group-member\[data-history-group-uniform="1"\]\s*>\s*\.cb-row \.cb-tool-label/,
  );
  assert.doesNotMatch(
    panelSource,
    /\.hp-history-group-member\[data-history-group-uniform="1"\]\s+\.cb-tool-label/,
  );
});

test('ordinary outer members and inner aggregate headers use the same icon column', () => {
  assert.match(
    panelSource,
    /\.hp-history-group-member\s*>\s*\[data-history-group\] \.hp-history-group--inner\s*\{[^}]*padding-left:\s*12px;[^}]*padding-right:\s*12px;/s,
  );
});

test('the injected History CSS remains one runtime-safe template literal', () => {
  const start = panelSource.indexOf('const historyPanelStyleText = `');
  const end = panelSource.indexOf('let historyPanelStyle =', start);
  assert.ok(start >= 0 && end > start);
  const styleLiteral = panelSource.slice(start, end);
  assert.equal(
    (styleLiteral.match(/`/g) || []).length,
    2,
    'a Markdown backtick inside a CSS comment terminates the JS template at runtime',
  );
});

test('an MCP prompt is expanded-body payload, never collapsed-header summary', () => {
  assert.match(toolCardsSource, /const rawPrompt = typeof args\?\.prompt === 'string'/);
  assert.match(toolCardsSource, /if \(rawPrompt && summary\.includes\(rawPrompt\)\) return ''/);
  assert.match(toolCardsSource, /<div className="cb-mcp-section-label">arguments<\/div>/);
});

test('a semantic Bash headline never falls back to a raw command preview', () => {
  assert.match(toolCardsSource, /const hasInjectedHeadline = Boolean\(injected\)/);
  assert.match(toolCardsSource, /\(isScript \|\| hasInjectedHeadline\) \? null/);
});
