export function isHistoryDeliveryConfirmationNotice(message) {
  const value = String(message || '');
  return /delivery is unconfirmed|delivery confirmation is delayed/i.test(value);
}

export function historyDraftNoticeBelongsOnComposerBorder(message) {
  // Delivery is already rendered on the exact optimistic message card. A
  // second "Confirming send" chip on the terminal/composer frame makes an old
  // receipt look like current terminal activity and can outlive the turn.
  return !isHistoryDeliveryConfirmationNotice(message);
}

export function getHistoryDraftNoticeMeta(message) {
  const value = String(message || '');
  if (/диктовк|перезапустить распознавание/i.test(value)) {
    // A dictation chip is holding the send (still resolving, failed retry,
    // or waiting for a retry/delete). Same border slot as other send states.
    return {
      label: 'Диктовка в черновике',
      tone: 'warning',
    };
  }
  if (/terminal input is empty/i.test(value)) {
    return {
      label: 'Terminal input empty',
      tone: 'info',
    };
  }
  if (/prompt was not returned/i.test(value)) {
    return {
      label: 'Cancel confirmed',
      tone: 'info',
    };
  }
  if (/interrupted prompt/i.test(value)) {
    return {
      label: 'Prompt restored',
      tone: 'warning',
    };
  }
  if (/saving image attachment/i.test(value)) {
    return {
      label: 'Attaching image',
      tone: 'info',
    };
  }
  // A STOPPED SEND is a fact about the send, even when the sentence also asks the
  // user to look at image placeholders. It has to be classified here, ABOVE the
  // attachment rule, because the two classes are presented in different places:
  // an attachment problem gets a wide block above the input (it must show an
  // exact slot and file path), while a stopped send belongs on the composer's
  // border next to «Resuming» / «Stopping» — it is the same kind of thing as
  // those, a state of the send.
  //
  // The bug this ordering fixes: «Terminal draft found — send stopped, text moved
  // to top. Review image placeholders.» matched the image rule first, so a
  // stopped send was announced as an attachment problem in its own block at the
  // top of the composer (user: «это тоже семантическая ошибка, она не должна
  // появляться отдельно вверху»). The mention of placeholders is an aside; the
  // subject of the sentence is that nothing was sent.
  if (/terminal draft found|another terminal draft|text moved to top|send stopped/i.test(value)) {
    return {
      label: 'Send stopped · draft moved',
      tone: 'warning',
    };
  }
  if (/\bimage(?:\s+#?\d+)?\b|imageError|image attachment|image marker|image file|картинк|вложени/i.test(value)) {
    return {
      label: 'Image needs attention',
      tone: 'warning',
    };
  }
  if (/delivery confirmation is delayed/i.test(value)) {
    return {
      label: 'Confirming send',
      tone: 'info',
    };
  }
  if (/delivery is unconfirmed/i.test(value)) {
    return {
      label: 'Delivery unconfirmed',
      tone: 'warning',
    };
  }
  return {
    label: 'Send needs attention',
    tone: 'warning',
  };
}
