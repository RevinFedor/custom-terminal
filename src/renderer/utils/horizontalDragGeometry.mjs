import { horizontalInsertIndex } from './horizontalReorder.mjs';

const idsKey = (ids) => (Array.isArray(ids) ? ids : [])
  .filter(Boolean)
  .map(String)
  .sort()
  .join('\u0000');

/**
 * Keep insertion boundaries stable for one drag gesture.
 *
 * Live horizontal preview physically moves the chips. Reading their animated
 * rectangles again would move the very midpoint that decides whether the
 * pointer is before or after a neighbour: the preview changes the target, the
 * target reverses the preview, and the row oscillates under a stationary
 * cursor. A lease captures the target strip once, in content coordinates, and
 * only the pointer/scroll position remains live until the gesture ends.
 */
export function createHorizontalDragGeometryCache() {
  const leases = new Map();

  return {
    clear(ownerKey) {
      if (ownerKey === undefined) leases.clear();
      else leases.delete(String(ownerKey));
    },

    resolve({
      ownerKey,
      excludedIds = [],
      clientX,
      viewportLeft = 0,
      scrollLeft = 0,
      readChips,
    }) {
      const key = String(ownerKey || '');
      if (!key || typeof readChips !== 'function') return 0;
      const excluded = new Set((excludedIds || []).filter(Boolean).map(String));
      const excludedKey = idsKey([...excluded]);
      let lease = leases.get(key);

      if (!lease || lease.excludedKey !== excludedKey) {
        const origin = Number(viewportLeft) || 0;
        const scroll = Number(scrollLeft) || 0;
        const chips = (readChips() || [])
          .filter((chip) => chip?.id && !excluded.has(String(chip.id)))
          .map((chip) => ({
            id: String(chip.id),
            left: Number(chip.left) - origin + scroll,
            right: Number(chip.right) - origin + scroll,
          }));
        lease = { excludedKey, chips };
        leases.set(key, lease);
      }

      const pointerInContent = Number(clientX) - (Number(viewportLeft) || 0) + (Number(scrollLeft) || 0);
      return horizontalInsertIndex(lease.chips, pointerInContent);
    },
  };
}
