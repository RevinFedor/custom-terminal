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
  const historyEntryStart = history.indexOf('const HistoryEntry = memo');
  const historyEntryEnd = history.indexOf('// The feed\'s quietest voice', historyEntryStart);
  const historyEntry = history.slice(historyEntryStart, historyEntryEnd);
  assert.match(historyEntry, /onDismissRewindPresentation\?: \(entry: FullHistoryEntry\) => void/);
  assert.match(historyEntry, /onDismissRewindPresentation\(entry\)/);
  assert.match(history, /onDismissRewindPresentation=\{dismissLocalRewindPresentation\}/);
  const userEntry = history.slice(
    history.indexOf('const HistoryUserEntry = memo'),
    historyEntryStart,
  );
  assert.doesNotMatch(userEntry, /onDismissRewindPresentation/,
    'Rewind-row callback belongs to HistoryEntry, not the user-message renderer');
  assert.match(history, /previous\.filter\(\(candidate\) => candidate\.uuid !== entry\.uuid\)/);
});

test('MessageEvent keeps its action inside the event-card header', () => {
  assert.match(conversationMessage, /actions\?: React\.ReactNode/);
  assert.match(conversationMessage, /className="cb-message-event-head"/);
  assert.match(conversationMessage, /className="cb-message-event-actions"/);
  assert.match(styles, /\.cb-message-event-head\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(styles, /\.cb-message-event-actions\s*\{[\s\S]*?justify-content:\s*center/);
});
