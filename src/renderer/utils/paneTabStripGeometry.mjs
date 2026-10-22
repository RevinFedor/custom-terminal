/** CSS viewport coordinates of the actual tab boxes, in their shown order.
 * Read only at an owned layout boundary; no observer, subscription or loop is
 * installed here. File-chip silhouette measurements remain the outline's job.
 */
export function readPaneTabStripChips(strip) {
  if (!strip) return [];
  return Array.from(strip.querySelectorAll('[data-strip-item]:not([data-strip-group-inactive="1"])'), chip => {
    const rect = chip.getBoundingClientRect();
    return { id: chip.dataset.stripTabId || '', left: rect.left, right: rect.right,
      top: rect.top, bottom: rect.bottom };
  }).filter(rect=>rect.right>rect.left&&rect.bottom>rect.top);
}
