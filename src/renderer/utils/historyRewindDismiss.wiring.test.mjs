import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const history = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);
const conversationMessage = fs.readFileSync(
  new URL('../../../packages/claude-blocks/src/components/ConversationMessage.tsx', import.meta.url),
  'utf8',
);
const styles = fs.readFileSync(
  new URL('../../../packages/claude-blocks/src/blocks.css', import.meta.url),
  'utf8',
);

test('failed local Rewind cards expose an always-visible dismiss action', () => {
  assert.match(history, /actions=\{failed && entry\.uuid\.startsWith\(LOCAL_REWIND_PREFIX\)/);
  assert.match(history, /data-history-rewind-dismiss="1"/);
  assert.match(history, /onDismissRewindPresentation\(entry\)/);
  assert.match(history, /previous\.filter\(\(candidate\) => candidate\.uuid !== entry\.uuid\)/);
});

test('MessageEvent keeps its action inside the event-card header', () => {
  assert.match(conversationMessage, /actions\?: React\.ReactNode/);
  assert.match(conversationMessage, /className="cb-message-event-head"/);
  assert.match(conversationMessage, /className="cb-message-event-actions"/);
  assert.match(styles, /\.cb-message-event-head\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(styles, /\.cb-message-event-actions\s*\{[\s\S]*?justify-content:\s*center/);
});
