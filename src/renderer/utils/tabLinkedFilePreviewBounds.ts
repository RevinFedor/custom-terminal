import { useLayoutEffect } from 'react';

/** Scope the existing portal reader to the owner's placed view, below its
 * measured header. This is geometry only; it makes no navigation decision. */
export function useTabLinkedFilePreviewBounds(preview: { ownerTabId?: string } | null) {
  useLayoutEffect(() => {
    if (!preview?.ownerTabId) return;
    const selector = `[data-split-pane-tab-chip][data-tab-id="${CSS.escape(preview.ownerTabId)}"][data-pane-chip-preview-only="0"]`;
    const card = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(node => node.getBoundingClientRect().width > 0);
    const header = card?.closest<HTMLElement>('[data-split-attach-row]');
    const view = card?.closest<HTMLElement>('[data-terminal-pane-chrome-host]')
      || card?.closest<HTMLElement>('[data-workspace-center]');
    const reader = document.querySelector<HTMLElement>('[data-file-preview-root]');
    if (!header || !view || !reader) return;
    const place = () => {
      const bounds = view.getBoundingClientRect(), edge = header.getBoundingClientRect().bottom;
      reader.dataset.linkedFileView = preview.ownerTabId;
      reader.style.setProperty('--linked-file-preview-left', `${bounds.left}px`);
      reader.style.setProperty('--linked-file-preview-top', `${edge}px`);
      reader.style.setProperty('--linked-file-preview-width', `${bounds.width}px`);
      reader.style.setProperty('--linked-file-preview-height', `${Math.max(0, bounds.bottom - edge)}px`);
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(header); observer.observe(view);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', place);
      delete reader.dataset.linkedFileView;
      for (const field of ['left', 'top', 'width', 'height']) reader.style.removeProperty(`--linked-file-preview-${field}`);
    };
  }, [preview]);
}
