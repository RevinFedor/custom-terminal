import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const history = read('../components/Workspace/HistoryPanel.tsx');
const timeline = read('../components/Workspace/TimelineEntryPreview.tsx');
const css = read('../components/Workspace/TimelineEntryPreview.css');
const queue = read('../components/Workspace/PromptQueueOverlay.tsx');

test('History Loop surface is owned-tag-only, while native blue and MCP source stay more specific', () => {
  assert.match(history,/const automaticContinuation = !orchestrationPrompt && !serviceBody\.questionReply \? getAutomaticContinuationKind\(entry\) : null/);
  assert.match(history,/data-history-prompt-origin=\{loopPrompt \? 'loop'/);
  assert.match(history,/data-history-loop-label/);
  assert.match(history,/hp-history-user-bubble--continue \{/);
  assert.match(history,/--cb-user-bubble-bg: rgba\(114, 90, 159, 0\.08\)/);
  assert.match(history,/--cb-msg-text: #8f8d88/);
});

test('Timeline Loop keeps its distinct label and violet surface without replacing the native reply class', () => {
  assert.match(timeline,/prompt\.questionReply \? ' timeline-entry-preview--question-reply' : kind === 'loop' \? ' timeline-entry-preview--loop'/);
  assert.match(css,/\.timeline-preview-kind--loop, \.timeline-preview-kind--continue \{ color: #8f8d88/);
  assert.match(css,/\.timeline-entry-preview--loop, \.timeline-entry-preview--continue \{ background-color: rgba\(114, 90, 159, 0\.08\)/);
});

test('Timeline question replies put blue on the type chip, not a second panel inside the popup', () => {
  assert.match(css,/\.timeline-preview-kind--question-reply \{ color: #93c5fd; background: #3b82f620; \}/);
  assert.ok(!/\.timeline-entry-preview--question-reply\s*\{[^}]*background/.test(css),
    'the popup owns the surface; the native reply only colors its type chip');
  assert.ok(history.includes("tone={serviceBody.questionReply ? 'info' : 'default'}"),
    'the separately approved blue History message remains intact');
});

test('only actual MCP and remaining system sources rotate; auto Continue/Loop cannot inherit a service diamond',()=>{
  const rail=read('../components/Workspace/Timeline.tsx');
  assert.match(rail,/const entryUsesDiamond = markerKind === 'system' \|\| markerKind === 'terminal-mcp'/);
  assert.match(rail,/transform: entryUsesDiamond \? 'rotate\(45deg\)'/);
  assert.doesNotMatch(rail,/transform: entryIsServicePrompt \? 'rotate\(45deg\)'/);
  assert.match(rail,/const entryIsSystem = markerKind === 'system'/);
  assert.match(rail,/let previewColor = entryIsAutomaticContinuation \? '#8f8d88'/);
});

test('Run After counter replaces only the Loop dot with an existing static SVG; Post keeps its dot', () => {
  const start=queue.indexOf('{(postPromptEnabled || loopPromptEnabled) && (');
  const end=queue.indexOf('</ControlHint>',start);const indicator=queue.slice(start,end);
  assert.ok(start>0 && end>start);
  assert.match(indicator,/postPromptEnabled && <span/);
  assert.match(indicator,/loopPromptEnabled && <RefreshCw data-prompt-queue-loop-indicator size=\{8\}/);
  assert.doesNotMatch(indicator,/loopPromptEnabled && <span/);
  assert.doesNotMatch(indicator,/animate|animation|pq-spinner/);
  assert.match(queue,/data-prompt-queue-count-label style=\{\{ transform: loopPromptEnabled \? 'translateY\(-3px\)'/);
});
