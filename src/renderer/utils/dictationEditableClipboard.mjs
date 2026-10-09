// Clipboard delivery for native text controls. History/CM editors and xterm
// retain their existing adapters. A lease identifies the actual element, not
// whichever field happens to own focus when a delayed native Paste arrives.
export function createEditableDictationClipboard({ document, ipc, hashText,
  randomId = () => crypto.randomUUID(), now = Date.now, timeoutMs = 4000 } = {}) {
  const targets = new Map();
  let pendingEnter = null;
  const ownerKey = node => node.getAttribute('data-dictation-owner-key') || '';
  const eligible = node => node && !node.disabled && !node.readOnly
    && (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT'
      && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(node.type)));
  const valid = lease => lease && lease.node.isConnected && eligible(lease.node)
    && ownerKey(lease.node) === lease.ownerKey;
  const focused = lease => valid(lease) && document.activeElement === lease.node;
  const sweep = () => {
    for (const [id, lease] of targets) if (lease.expiresAt < now()
      || (!lease.request && !valid(lease))) targets.delete(id);
  };
  function offer(node, tabId) {
    sweep();
    if (!eligible(node) || targets.size >= 64) return null;
    for (const [id, lease] of targets) if (lease.node === node) targets.delete(id);
    const targetId = randomId();
    targets.set(targetId, { targetId, node, ownerKey: ownerKey(node), expiresAt: now() + 60000 });
    return { version: 2, surface: 'editable', targetId, tabId: tabId || 'field-' + targetId };
  }
  async function arm(payload) {
    sweep();
    const lease = targets.get(payload?.targetId);
    if (!focused(lease)) return { ok: false, error: 'editable-target-changed' };
    const result = await ipc.invoke('dictation-clipboard:arm-field', payload);
    if (!result?.ok || !focused(lease)) return { ok: false, error: result?.error || 'editable-target-changed' };
    lease.request = payload; lease.captured = false; lease.afterValue = null;
    lease.expiresAt = now() + 60000;
    return result;
  }
  function report(lease, status, extra = {}) {
    const p = lease.request;
    if (!p) return;
    ipc.send('dictation-clipboard:field-capture', { requestId: p.requestId, targetId: lease.targetId,
      tabId: p.tabId, status, textHash: p.textHash, textChars: p.textChars, ...extra });
  }
  function onPaste(event) {
    sweep();
    const text = String(event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    const pending = [...targets.values()].filter(x => x.request && !x.captured);
    const lease = pending.find(x => x.node === event.target)
      || pending.find(x => x.request.textChars === text.length && x.request.textHash === hashText(text));
    if (!lease) return;
    if (!focused(lease) || event.target !== lease.node) {
      event.preventDefault(); event.stopImmediatePropagation(); report(lease, 'unconfirmed'); lease.request = null; return;
    }
    if (text.length !== lease.request.textChars || hashText(text) !== lease.request.textHash) {
      event.preventDefault(); event.stopImmediatePropagation();
      report(lease, 'mismatch', { observedChars: text.length });
      lease.request = null;
      return;
    }
    const node = lease.node, before = node.value;
    const start = node.selectionStart ?? before.length, end = node.selectionEnd ?? start;
    const variants = node.tagName === 'TEXTAREA' ? [text] : [text.replace(/\n/g, ''), text.replace(/\n/g, ' ')];
    const expected = variants.map(inserted => before.slice(0, start) + inserted + before.slice(end));
    // A native Paste's default editing action and React onChange run before
    // this task. Merely seeing the clipboard event is not a commit receipt.
    setTimeout(() => {
      if (!lease.request) return;
      if (valid(lease) && expected.includes(node.value)) {
        lease.afterValue = node.value; lease.captured = true; lease.expiresAt = now() + 60000;
        report(lease, 'captured', { observedChars: text.length });
      } else { report(lease, 'unconfirmed'); lease.request = null; }
    }, 0);
  }
  function onEnter(event) {
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.code === 'KeyV') {
      for (const [id, lease] of targets) if (lease.released && lease.node === event.target) targets.delete(id);
    }
    const p = pendingEnter;
    if (!p || !['Enter', '\r'].includes(event.key)) return;
    if (!focused(p.lease) || event.target !== p.lease.node
      || (!p.keyDown && p.lease.node.value !== p.lease.afterValue)) {
      p.rejected = true;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    if (event.type === 'keydown') p.keyDown = true;
    if (event.type === 'keyup') p.finish({ delivered: p.keyDown && !p.rejected, requestId: p.requestId });
  }
  async function enter(payload) {
    const lease = targets.get(payload?.targetId);
    if (!focused(lease) || !lease.captured || lease.request?.requestId !== payload.requestId
      || lease.node.value !== lease.afterValue || pendingEnter) return { delivered: false, error: 'editable-target-changed' };
    return new Promise(resolve => {
      const timer = setTimeout(() => finish({ delivered: false, error: 'editable-enter-unconfirmed' }), timeoutMs);
      const finish = value => { clearTimeout(timer); if (pendingEnter?.requestId === payload.requestId) pendingEnter = null; resolve(value); };
      pendingEnter = { lease, requestId: payload.requestId, keyDown: false, rejected: false, finish };
      ipc.invoke('dictation-clipboard:press-field-enter', payload).then(result => {
        if (!result?.ok) finish({ delivered: false, error: result?.error || 'editable-enter-unavailable' });
      }).catch(() => finish({ delivered: false, error: 'editable-enter-unavailable' }));
    });
  }
  function release(payload) {
    const lease = targets.get(payload?.targetId);
    if (lease?.request?.requestId !== payload.requestId) return { released: false };
    if (payload.noDispatch) targets.delete(payload.targetId);
    else if (!lease.captured) lease.released = true;
    return { released: true };
  }
  document.addEventListener('paste', onPaste, true);
  for (const name of ['keydown', 'keypress', 'keyup']) document.addEventListener(name, onEnter, true);
  return { offer, arm, enter, release, dispose() {
    document.removeEventListener('paste', onPaste, true);
    for (const name of ['keydown', 'keypress', 'keyup']) document.removeEventListener(name, onEnter, true);
    pendingEnter?.finish({ delivered: false, error: 'disposed' }); targets.clear();
  } };
}
