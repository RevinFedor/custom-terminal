import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const history = fs.readFileSync(
  path.join(repoRoot, 'renderer/components/Workspace/HistoryPanel.tsx'),
  'utf8',
);
const coordinator = fs.readFileSync(
  path.join(repoRoot, 'renderer/utils/agentActionCoordinator.mjs'),
  'utf8',
);

test('History accepts ordinary backlog sends, but local commands/context rewrite keep their existing pending guard', () => {
  const actionStart = history.indexOf('const runAction = useCallback(async (');
  const handoffGuard = history.indexOf('historyPromptHandoffBlocksNewSubmit(', actionStart);
  const begin = history.indexOf('beginCoordinatedAgentSend(', actionStart);
  assert.ok(actionStart >= 0 && handoffGuard > actionStart && begin > handoffGuard);
  assert.match(history, /const canSend = canAcceptSubmitIntent\s*&& \(activeInputStatus === null \|\| !isTerminalOnlyComposerDraft\(prompt\)\)/);
  assert.match(history, /kind === 'send' && \(recordWithoutReply \|\| isTerminalOnlyComposerDraft/);
  assert.match(history, /applicationQueued === true[\s\S]*queueStatus: 'application-queued'/);
  assert.ok(
    history.indexOf('const [activeInputStatus, setActiveInputStatus]')
      < history.indexOf('const canSend = canAcceptSubmitIntent'),
    'render-time admission cannot read a later TDZ alias',
  );
  assert.match(history, /reason=previous-delivery-pending/);
});

test('the short snapshot coordinator rejects duplicate clicks before immutable admission', () => {
  assert.match(
    coordinator,
    /if \(queue\.length > 0\) \{[\s\S]{0,240}reason: 'send-inflight'/,
  );
  assert.doesNotMatch(coordinator, /emit\(key, queue\.length === 1 \? 'send-started' : 'send-queued'\)/);
});
