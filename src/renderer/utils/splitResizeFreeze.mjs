import { beginHistoryResize } from './historyResizeAnchor.mjs';

/**
 * Pixel box of a pane's heavy content relative to its movable outer wrapper.
 *
 * During divider drag the wrapper follows the pointer, while this box remains
 * fixed until release. Keeping the arithmetic pure makes sub-pixel offsets and
 * invalid/zero geometry testable without mounting the Electron renderer.
 */
export function paneResizeFreezeBox(wrapperRect, contentRect) {
  const values = [
    wrapperRect?.left,
    wrapperRect?.top,
    contentRect?.left,
    contentRect?.top,
    contentRect?.width,
    contentRect?.height,
  ];
  if (!values.every(Number.isFinite)) return null;
  if (contentRect.width <= 0 || contentRect.height <= 0) return null;
  const left = contentRect.left - wrapperRect.left;
  const top = contentRect.top - wrapperRect.top;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top, width: contentRect.width, height: contentRect.height };
}
export function freezePaneContentsForResize(host, { includeRetained = false, reason = 'split-divider' } = {}) {
  // A divider moves only assigned pane wrappers. A sidebar changes their
  // common containing block, including retained hidden owners and the plain
  // single-center surface. Freeze that flow child instead of its descendants.
  const centerContents = includeRetained
    ? Array.from(host.querySelectorAll('[data-single-center-resize-content]')) : [];
  const targets = Array.from(host.querySelectorAll(includeRetained
    ? '[data-terminal-pane-wrapper]'
    : '[data-terminal-pane-wrapper][data-pane-event-index]'))
    .filter(wrapper => !centerContents.some(content => content.contains(wrapper)))
    .map(wrapper => ({ wrapper, content: wrapper.querySelector('[data-terminal-pane-content]') }));
  targets.push(...centerContents.map(content => ({ wrapper: content.parentElement, content })));
  const measurements = targets.map(({ wrapper, content }) => {
    if (!wrapper || !content) return null;
    const wrapperRect = wrapper.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const box = paneResizeFreezeBox(wrapperRect, contentRect);
    if (!box) return null;
    return {
      wrapper,
      content,
      box,
      previous: {
        wrapperOverflow: wrapper.style.overflow,
        wrapperFrozen: wrapper.getAttribute('data-split-resize-frozen'),
        contentFrozen: content.getAttribute('data-split-resize-content-frozen'),
        left: content.style.left,
        top: content.style.top,
        right: content.style.right,
        bottom: content.style.bottom,
        width: content.style.width,
        height: content.style.height,
        position: content.style.position,
      },
    };
  }).filter(entry => entry !== null);

  const finishHistoryResize = beginHistoryResize(host, reason);

  measurements.forEach(({ wrapper, content, box }) => {
    wrapper.setAttribute('data-split-resize-frozen', '1');
    wrapper.style.overflow = 'clip';
    content.setAttribute('data-split-resize-content-frozen', '1');
    content.style.position = 'absolute';
    content.style.left = `${box.left}px`;
    content.style.top = `${box.top}px`;
    content.style.right = 'auto';
    content.style.bottom = 'auto';
    content.style.width = `${box.width}px`;
    content.style.height = `${box.height}px`;
  });

  let released = false;
  return {
    count: measurements.length,
    release: (changed = true) => {
      if (released) return;
      released = true;
      measurements.forEach(({ wrapper, content, previous }) => {
        wrapper.style.overflow = previous.wrapperOverflow;
        if (previous.wrapperFrozen === null) wrapper.removeAttribute('data-split-resize-frozen');
        else wrapper.setAttribute('data-split-resize-frozen', previous.wrapperFrozen);
        if (previous.contentFrozen === null) content.removeAttribute('data-split-resize-content-frozen');
        else content.setAttribute('data-split-resize-content-frozen', previous.contentFrozen);
        content.style.left = previous.left;
        content.style.top = previous.top;
        content.style.right = previous.right;
        content.style.bottom = previous.bottom;
        content.style.width = previous.width;
        content.style.height = previous.height;
        content.style.position = previous.position;
      });
      finishHistoryResize(changed);
    },
  };
}
