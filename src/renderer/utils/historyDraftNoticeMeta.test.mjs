import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHistoryDraftNoticeMeta,
  historyDraftNoticeBelongsOnComposerBorder,
  isHistoryDeliveryConfirmationNotice,
} from './historyDraftNoticeMeta.mjs';

test('delayed delivery confirmation is not presented as a stopped send', () => {
  const message = 'Prompt was submitted, but delivery confirmation is delayed. It will not be sent again automatically.';
  assert.equal(isHistoryDeliveryConfirmationNotice(message), true);
  assert.deepEqual(getHistoryDraftNoticeMeta(message), {
    label: 'Confirming send',
    tone: 'info',
  });
  assert.equal(historyDraftNoticeBelongsOnComposerBorder(message), false);
});

test('unknown delivery and a moved terminal draft keep distinct warnings', () => {
  assert.deepEqual(getHistoryDraftNoticeMeta(
    'Prompt delivery is unconfirmed. It will not be sent again automatically.',
  ), {
    label: 'Delivery unconfirmed',
    tone: 'warning',
  });
  assert.deepEqual(getHistoryDraftNoticeMeta(
    'Terminal draft found — send stopped, text moved to top.',
  ), {
    label: 'Send stopped · draft moved',
    tone: 'warning',
  });
  assert.equal(historyDraftNoticeBelongsOnComposerBorder(
    'Terminal draft found — send stopped, text moved to top.',
  ), true);
});

test('unclassified warnings do not claim that a draft was moved', () => {
  assert.deepEqual(getHistoryDraftNoticeMeta('History input is temporarily locked'), {
    label: 'Send needs attention',
    tone: 'warning',
  });
});

test('a stopped send stays a stopped send even when it also mentions images', () => {
  // These two classes are DRAWN IN DIFFERENT PLACES: an attachment problem gets a
  // wide block above the input (it has to show an exact slot and file path), a
  // stopped send sits on the composer's border beside «Resuming»/«Stopping».
  // So the classification decides placement, and the subject of the sentence —
  // «nothing was sent» — must win over the aside about placeholders. It did not:
  // the image rule matched first and a stopped send appeared as its own block at
  // the top of the composer.
  assert.deepEqual(getHistoryDraftNoticeMeta(
    'Terminal draft found — send stopped, text moved to top. Review image placeholders.',
  ), {
    label: 'Send stopped · draft moved',
    tone: 'warning',
  });
  assert.deepEqual(getHistoryDraftNoticeMeta(
    'Send stopped before Enter. The failed prompt was restored before your newer draft.',
  ), {
    label: 'Send stopped · draft moved',
    tone: 'warning',
  });
});

test('a real attachment problem is still an attachment problem', () => {
  // The other side of the ordering above: nothing about the send is claimed here,
  // so this must keep the class that earns the block with the slot and the path.
  assert.deepEqual(getHistoryDraftNoticeMeta(
    '[Image #3] is damaged or has no exact attachment. Near “foo”. Restore the complete marker or remove it before sending.',
  ), {
    label: 'Image needs attention',
    tone: 'warning',
  });
  // Progress, not a problem — and it must not be swallowed by either rule.
  assert.deepEqual(getHistoryDraftNoticeMeta('Saving image attachment…'), {
    label: 'Attaching image',
    tone: 'info',
  });
});
