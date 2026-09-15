import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

const cssRule = (selector) => {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing selector: ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `incomplete selector: ${selector}`);
  return source.slice(open + 1, close);
};

test('History selects orchestration colour only from audited semantic metadata', () => {
  assert.match(source, /resolveHistoryOrchestrationPromptPresentation\(entry\)/);
  assert.match(source, /hp-history-user-bubble--orchestration/);
  assert.match(source, /data-history-orchestration-phase=\{orchestrationPrompt\?\.phase\}/);
  const rule = cssRule('.hp-history-transcript .cb-user-bubble.hp-history-user-bubble--orchestration');
  assert.match(rule, /--cb-user-bubble-bg:\s*rgba\(124, 58, 237, 0\.08\)/);
  assert.match(rule, /--cb-user-bubble-border:\s*rgba\(167, 139, 250, 0\.20\)/);
});

test('the exact orchestration handoff gives the optimistic row the same colour before audit', () => {
  assert.match(source, /resolveHistoryOrchestrationHandoffPresentation\(record\)/);
  assert.match(source, /semanticTags:\s*meta\.semanticTags/);
  assert.match(source, /semanticTags,\s*\n\s*sessionId: sessionRoute\.presentationSessionId/);
});

test('ordinary user bubble top padding matches its local left inset', () => {
  const rule = cssRule('.hp-history-transcript .cb-user-bubble {');
  assert.match(rule, /padding-top:\s*var\(--hp-horizontal-padding, 4px\)/);
  assert.match(rule, /padding-left:\s*var\(--hp-horizontal-padding, 4px\)/);
  assert.match(
    source,
    /\.hp-history-transcript \.cb-user-bubble:has\(\.cb-collapse-top\) \{\s*padding-top: 8px;/,
    'expanded long prompts retain enough seam for their top collapse control',
  );
});

test('Working and entry-owned Worked start on the same History inset', () => {
  const tail = cssRule('.hp-history-response-tail {');
  assert.match(tail, /padding:\s*4px var\(--hp-horizontal-padding, 4px\)/);
  assert.doesNotMatch(tail, /padding:\s*4px 12px/);
  const entry = cssRule('.hp-history-response-tail[data-placement="entry"]');
  assert.match(entry, /padding:\s*4px 0 0/);
});
