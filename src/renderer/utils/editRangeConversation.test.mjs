import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildEditRangeSubmission,
  buildInitialEditRangeMessages,
} from './editRangeConversation.mjs';

test('Chat mode keeps an empty response list until the configured prompt is explicitly sent', () => {
  assert.deepEqual(buildInitialEditRangeMessages(''), []);
  assert.deepEqual(buildInitialEditRangeMessages('  '), []);
});

test('the first Chat send combines the editable prompt with the source in one Gemini turn', () => {
  const result = buildEditRangeSubmission({
    sourceContent: 'SOURCE HISTORY',
    messages: [],
    inputValue: 'Configured Rewind prompt + my note',
    promptDraftMode: true,
    now: 42,
  });

  assert.equal(result.userMessage.content, 'Configured Rewind prompt + my note');
  assert.equal(result.contents.length, 1);
  assert.deepEqual(result.contents[0], {
    role: 'user',
    parts: [{ text: 'Configured Rewind prompt + my note\n\nSOURCE HISTORY' }],
  });
});

test('automatic AI review preserves source, initial answer and follow-up order', () => {
  const messages = buildInitialEditRangeMessages('INITIAL SUMMARY');
  const result = buildEditRangeSubmission({
    sourceContent: 'SOURCE HISTORY',
    messages,
    inputValue: 'Make it shorter',
    promptDraftMode: false,
    now: 43,
  });

  assert.deepEqual(result.contents.map((item) => item.role), ['user', 'model', 'user']);
  assert.deepEqual(result.contents.map((item) => item.parts[0].text), [
    'SOURCE HISTORY',
    'INITIAL SUMMARY',
    'Make it shorter',
  ]);
});

test('single-point Timeline exposes exactly the named Rewind, AI and Chat actions', () => {
  const timelinePath = fileURLToPath(new URL('../components/Workspace/Timeline.tsx', import.meta.url));
  const source = fs.readFileSync(timelinePath, 'utf8');

  assert.match(source, /data-testid="timeline-rewind-native-single"[\s\S]{0,6000}data-testid="timeline-rewind-ai-single"[\s\S]{0,3000}data-testid="timeline-rewind-chat-single"/);
  assert.doesNotMatch(source, /data-testid="timeline-rewind-rewrite-prompt-single"/);
  assert.doesNotMatch(source, /data-testid="timeline-rewind-rewrite-empty-single"/);
});
