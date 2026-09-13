// Cursor ownership follows pointer capture on the small gesture handle/row.
// `:root * { cursor:... !important }` invalidated every retained History at
// pickup/release. Body user-select had the same cost. Native capture keeps
// this cursor over editors without a global rule or an input-blocking overlay.
type Lease = { target: HTMLElement; pointerId: number; cursor: string };
const leases = new Map<symbol, Lease>();
const authored = new Map<HTMLElement, { value: string; priority: string }>();

export function getInteractionCursor(): string {
  return Array.from(leases.values()).at(-1)?.cursor || '';
}

function paintTarget(target: HTMLElement) {
  const active = Array.from(leases.values()).filter(lease => lease.target === target).at(-1);
  const original = authored.get(target);
  if (active) {
    if (target.style.getPropertyValue('cursor') !== active.cursor
      || target.style.getPropertyPriority('cursor') !== 'important') {
      target.style.setProperty('cursor', active.cursor, 'important');
    }
  } else if (original) {
    if (original.value) target.style.setProperty('cursor', original.value, original.priority);
    else target.style.removeProperty('cursor');
    authored.delete(target);
  }
}

/** Release is idempotent; an older cleanup cannot clear a newer owner. */
export function acquireInteractionCursor(cursor: string, { target, pointerId }: {
  target: HTMLElement;
  pointerId: number;
}): () => void {
  const owner = Symbol(cursor);
  if (!authored.has(target)) authored.set(target, {
    value: target.style.getPropertyValue('cursor'), priority: target.style.getPropertyPriority('cursor'),
  });
  leases.set(owner, { cursor, target, pointerId });
  paintTarget(target);
  try { target.setPointerCapture(pointerId); } catch {
    // Cancel/detach may race acquisition. Document-level move/up/blur cleanup
    // still works; a failed capture never leaves a global cursor behind.
  }
  return () => {
    if (!leases.delete(owner)) return;
    paintTarget(target);
    const remaining = Array.from(leases.values()).filter(lease => lease.pointerId === pointerId).at(-1);
    try {
      if (remaining) {
        if (!remaining.target.hasPointerCapture(pointerId)) remaining.target.setPointerCapture(pointerId);
      } else if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch { /* pointer already released or its handle was removed */ }
  };
}
