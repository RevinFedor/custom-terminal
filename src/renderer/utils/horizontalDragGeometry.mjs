import { horizontalInsertIndex, wrappedInsertIndex } from './horizontalReorder.mjs';

const idsKey = (ids) => (Array.isArray(ids) ? ids : [])
  .filter(Boolean)
  .map(String)
  .sort()
  .join('\u0000');

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * One event-sized horizontal autoscroll step.
 *
 * The resolver calls this for both native pane drags and pointer-driven
 * sidebar adoption, so the edge affordance cannot silently disappear when the
 * source changes host. The caller owns applying the returned delta.
 */
export function horizontalDragAutoScrollDelta({
  clientX,
  viewportLeft,
  viewportRight,
  scrollLeft,
  scrollWidth,
  clientWidth,
  edgeSize = 42,
  maxStep = 28,
}) {
  const left = Number(viewportLeft) || 0;
  const right = Number(viewportRight) || left;
  const current = Math.max(0, Number(scrollLeft) || 0);
  const max = Math.max(0, (Number(scrollWidth) || 0) - (Number(clientWidth) || 0));
  if (max <= 0 || right <= left) return 0;
  const edge = Math.max(8, Number(edgeSize) || 42);
  const step = Math.max(4, Number(maxStep) || 28);
  const x = Number(clientX) || 0;

  if (x < left + edge && current > 0) {
    const pressure = clamp((left + edge - x) / edge, 0, 1);
    return -Math.min(current, Math.max(4, Math.round(step * pressure)));
  }
  if (x > right - edge && current < max) {
    const pressure = clamp((x - (right - edge)) / edge, 0, 1);
    return Math.min(max - current, Math.max(4, Math.round(step * pressure)));
  }
  return 0;
}

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
      clientY = 0,
      viewportLeft = 0,
      viewportTop = 0,
      scrollLeft = 0,
      scrollTop = 0,
      wrap = false,
      readChips,
    }) {
      const key = String(ownerKey || '');
      if (!key || typeof readChips !== 'function') return 0;
      const excluded = new Set((excludedIds || []).filter(Boolean).map(String));
      const excludedKey = idsKey([...excluded]);
      let lease = leases.get(key);

      if (!lease || lease.excludedKey !== excludedKey || lease.wrap !== wrap) {
        const origin = Number(viewportLeft) || 0;
        const scroll = Number(scrollLeft) || 0;
        const chips = (readChips() || [])
          .filter((chip) => chip?.id && (wrap || !excluded.has(String(chip.id))))
          .map((chip) => ({
            id: String(chip.id),
            left: Number(chip.left) - origin + scroll,
            right: Number(chip.right) - origin + scroll,
            top: Number(chip.top) - Number(viewportTop) + Number(scrollTop),
            bottom: Number(chip.bottom) - Number(viewportTop) + Number(scrollTop),
          }));
        lease = { excludedKey, chips, wrap };
        leases.set(key, lease);
      }

      const pointerInContent = Number(clientX) - (Number(viewportLeft) || 0) + (Number(scrollLeft) || 0);
      if (wrap) {
        const y = Number(clientY) - (Number(viewportTop) || 0) + (Number(scrollTop) || 0);
        return wrappedInsertIndex(lease.chips, pointerInContent, y, excluded);
      }
      return horizontalInsertIndex(lease.chips, pointerInContent);
    },
  };
}
