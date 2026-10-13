// Native fields and registered ComposerEditors share the same clipboard lease.
// A rich editor supplies its document/selection, never DOM textContent (which
// omits hidden token bodies and can include widget labels).
const composers = new WeakMap();
const composerPasteObservers = new Set();
export function registerDictationComposer(node, adapter) {
  if (!node) return () => {};
  const registration = { ...adapter };
  composers.set(node, registration);
  return () => { if (composers.get(node) === registration) composers.delete(node); };
}
export function observeDictationComposerPaste(node, event) {
  for (const observe of composerPasteObservers) observe(event, node);
}

// A lease identifies the actual editor and its semantic owner, not whichever
// field happens to own focus when a delayed native Paste arrives.
export function createEditableDictationClipboard({ document, ipc, hashText,
  randomId = () => crypto.randomUUID(), now = Date.now, timeoutMs = 4000,
  log = line => console.log(line) } = {}) {
  const targets = new Map();
  let pendingEnter = null;
  const ownerKey = node => composers.get(node)?.ownerKey()
    ?? node.closest('[data-dictation-owner-key]')?.getAttribute('data-dictation-owner-key') ?? '';
  const nativeEligible = node => node && !node.disabled && !node.readOnly
    && (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT'
      && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(node.type)));
  const eligible = node => nativeEligible(node) || (!!composers.get(node) && !composers.get(node).readOnly());
  const valid = lease => lease && lease.node.isConnected && eligible(lease.node)
    && composers.get(lease.node) === lease.composer
    && ownerKey(lease.node) === lease.ownerKey;
  const focused = lease => valid(lease) && document.activeElement === lease.node;
  const value = lease => lease.composer ? lease.composer.value() : lease.node.value;
  const selection = lease => lease.composer ? lease.composer.selection()
    : { start: lease.node.selectionStart, end: lease.node.selectionEnd };
  const sweep = () => {
    for (const [id, lease] of targets) if (lease.expiresAt < now()
      || (!lease.request && !valid(lease))) targets.delete(id);
  };
  function offer(node, tabId) {
    sweep();
    if (!eligible(node) || targets.size >= 64) return null;
    for (const [id, lease] of targets) if (lease.node === node) targets.delete(id);
    const targetId = randomId();
    const composer = composers.get(node);
    targets.set(targetId, { targetId, node, composer, ownerKey: ownerKey(node), expiresAt: now() + 60000 });
    log('[DictationClipboard:Editable] offer target=' + targetId + ' kind=' + (composer ? 'composer' : 'native'));
    return { version: 2, surface: 'editable', targetId, tabId: tabId || 'field-' + targetId };
  }
  async function arm(payload) {
    sweep();
    const lease = targets.get(payload?.targetId);
    if (!focused(lease)) return { ok: false, error: 'editable-target-changed' };
    const result = await ipc.invoke('dictation-clipboard:arm-field', payload);
    if (!result?.ok || !focused(lease)) return { ok: false, error: result?.error || 'editable-target-changed' };
    lease.request = payload; lease.captured = false; lease.observing = false; lease.afterValue = null;
    lease.expiresAt = now() + 60000;
    return result;
  }
  function report(lease, status, extra = {}) {
    const p = lease.request;
    if (!p) return;
    ipc.send('dictation-clipboard:field-capture', { requestId: p.requestId, targetId: lease.targetId,
      tabId: p.tabId, status, textHash: p.textHash, textChars: p.textChars, ...extra });
  }
  function onPaste(event, composerNode) {
    if (composerNode && composerNode.ownerDocument !== document) return;
    sweep();
    const text = String(event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
    const pending = [...targets.values()].filter(x => x.request && !x.captured);
    const target = composerNode || event.target;
    const ownsTarget = lease => target === lease.node || (!!lease.composer && lease.node.contains(target));
    const lease = pending.find(ownsTarget)
      || pending.find(x => x.request.textChars === text.length && x.request.textHash === hashText(text));
    if (!lease) return;
    const block = () => { event.preventDefault(); event.stopPropagation?.();
      (event.nativeEvent || event).stopImmediatePropagation?.(); };
    if (!focused(lease) || !ownsTarget(lease)) {
      block(); report(lease, 'unconfirmed'); lease.request = null; return;
    }
    if (text.length !== lease.request.textChars || hashText(text) !== lease.request.textHash) {
      block();
      report(lease, 'mismatch', { observedChars: text.length });
      lease.request = null;
      return;
    }
    // Both the native DOM paste and CM's synchronous Mod-v facade can reach
    // this observer for one edit. Observe the edit once; never insert it here.
    if (lease.observing) return;
    lease.observing = true;
    const node = lease.node, before = value(lease), range = selection(lease);
    const start = range.start ?? before.length, end = range.end ?? start;
    const variants = lease.composer || node.tagName === 'TEXTAREA' ? [text]
      : [text.replace(/\n/g, ''), text.replace(/\n/g, ' ')];
    const expected = variants.map(inserted => before.slice(0, start) + inserted + before.slice(end));
    log('[DictationClipboard:Editable] observe id=' + lease.request.requestId
      + ' kind=' + (lease.composer ? 'composer' : 'native') + ' chars=' + text.length);
    // A native Paste's default editing action and React onChange run before
    // this task. Merely seeing the clipboard event is not a commit receipt.
    setTimeout(() => {
      if (!lease.request) return;
      if (valid(lease) && expected.includes(value(lease))) {
        lease.afterValue = value(lease); lease.captured = true; lease.expiresAt = now() + 60000;
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
      || (!p.keyDown && value(p.lease) !== p.lease.afterValue)) {
      p.rejected = true;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    if (event.type === 'keydown') p.keyDown = true;
    if (event.type === 'keyup') p.finish({ delivered: p.keyDown && !p.rejected, requestId: p.requestId });
  }
  async function enter(payload) {
    const lease = targets.get(payload?.targetId);
    if (!focused(lease) || !lease.captured || lease.request?.requestId !== payload.requestId
      || value(lease) !== lease.afterValue || pendingEnter) return { delivered: false, error: 'editable-target-changed' };
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
  composerPasteObservers.add(onPaste);
  for (const name of ['keydown', 'keypress', 'keyup']) document.addEventListener(name, onEnter, true);
  return { offer, arm, enter, release, dispose() {
    document.removeEventListener('paste', onPaste, true);
    composerPasteObservers.delete(onPaste);
    for (const name of ['keydown', 'keypress', 'keyup']) document.removeEventListener(name, onEnter, true);
    pendingEnter?.finish({ delivered: false, error: 'disposed' }); targets.clear();
  } };
}
