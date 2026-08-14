import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getHistoryDraftNoticeMeta,
  isHistoryDeliveryConfirmationNotice,
} from './historyDraftNoticeMeta.mjs';

test('delayed delivery confirmation is not presented as a stopped send', () => {
  const message = 'Prompt was submitted, but delivery confirmation is delayed. It will not be sent again automatically.';
  assert.equal(isHistoryDeliveryConfirmationNotice(message), true);
  assert.deepEqual(getHistoryDraftNoticeMeta(message), {
    label: 'Confirming send',
    tone: 'info',
  });
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
});

test('unclassified warnings do not claim that a draft was moved', () => {
  assert.deepEqual(getHistoryDraftNoticeMeta('History input is temporarily locked'), {
    label: 'Send needs attention',
    tone: 'warning',
  });
});
