// Presentation only. The existing Main return receipt owns cancellation,
// adoption and delivery. Never retain message bodies or grant Send authority.
const fields = ['tabId', 'sourceSessionId', 'handoffId', 'token'];
const same = (a, b) => fields.every(key => a[key] === b[key]);
const project = value => ({ tabId: value.tabId, sourceSessionId: value.sourceSessionId || null,
  handoffId: value.handoffId, token: value.token });

export function beginComposerReturnPreparation(current, owner) {
  const operation = project(owner);
  return current.some(value => same(value, operation)) ? current : [...current, operation];
}

export function finishComposerReturnPreparation(current, owner) {
  const operation = project(owner);
  return current.some(value => same(value, operation))
    ? current.filter(value => !same(value, operation)) : current;
}

export function composerReturnPreparationView(current, tabId, sourceSessionId) {
  const count = current.filter(value => value.tabId === tabId
    && value.sourceSessionId === (sourceSessionId || null)).length;
  return count ? { label: count === 1 ? 'Возвращаю сообщение…' : 'Возвращаю сообщения…', count } : null;
}
