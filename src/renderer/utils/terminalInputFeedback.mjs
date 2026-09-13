// A border flash acknowledges a written key only. It never sets busy, delivery
// or lifecycle state, and never replays input.
export function installTerminalInputFeedback({ ipc, document, getTerminal }) {
  const animations = new Set();
  const byElement = new WeakMap();
  const handler = (_event, detail) => {
    if (!detail?.tabId || detail.key !== 'Escape' || detail.written !== true) return;
    const targets = new Set();
    for (const owner of document.querySelectorAll('[data-agent-input-feedback-tab]')) {
      if (owner.getAttribute('data-agent-input-feedback-tab') !== detail.tabId) continue;
      const frame = owner.querySelector('.hp-history-composer-frame');
      if (frame) targets.add(frame);
    }
    const terminal = getTerminal(detail.tabId)?.element;
    if (terminal) targets.add(terminal);
    for (const target of targets) {
      if (!target.isConnected || !target.getClientRects().length || typeof target.animate !== 'function') continue;
      byElement.get(target)?.cancel();
      const animation = target.animate([
        { outline: '2px solid rgba(165,180,252,0)', outlineOffset: '-2px' },
        { outline: '2px solid rgba(165,180,252,1)', outlineOffset: '-2px', offset: 0.15 },
        { outline: '2px solid rgba(165,180,252,0)', outlineOffset: '-2px' },
      ], { duration: 450, easing: 'ease-out' });
      animations.add(animation);
      byElement.set(target, animation);
      animation.finished.catch(() => {}).finally(() => {
        animations.delete(animation);
        if (byElement.get(target) === animation) byElement.delete(target);
      });
    }
  };
  ipc.on('terminal:input-feedback', handler);
  return () => {
    ipc.removeListener('terminal:input-feedback', handler);
    for (const animation of animations) animation.cancel();
    animations.clear();
  };
}
