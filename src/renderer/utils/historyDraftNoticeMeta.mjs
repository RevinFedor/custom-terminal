export function isHistoryDeliveryConfirmationNotice(message) {
  const value = String(message || '');
  return /delivery is unconfirmed|delivery confirmation is delayed/i.test(value);
}

export function getHistoryDraftNoticeMeta(message) {
  const value = String(message || '');
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
  if (/terminal draft found|another terminal draft|text moved to top/i.test(value)) {
    return {
      label: 'Send stopped · draft moved',
      tone: 'warning',
    };
  }
  return {
    label: 'Send needs attention',
    tone: 'warning',
  };
}
