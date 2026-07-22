export type VerticalRect = {
  top: number;
  bottom: number;
  midY?: number;
};

export type VerticalBoundarySide = 'before' | 'after';

export type VerticalSemanticBoundary = {
  blockKey: string;
  side: VerticalBoundarySide;
};

export type AtomicVerticalTarget<T> = {
  key: string;
  rect: VerticalRect;
  value: T;
};

export type ResolvedAtomicVerticalTarget<T> = {
  target: AtomicVerticalTarget<T>;
  boundary: VerticalSemanticBoundary;
};

export type VerticalResolutionCache<T> = {
  geometryId: number;
  sourceKey: string;
  projectionRevision: number;
  scrollAdjustedY: number;
  value: T;
};

const EPSILON = 1e-6;
export const DEFAULT_VERTICAL_BOUNDARY_HYSTERESIS_PX = 6;

export function horizontalPointerIntentOwnsFrame(
  deltaX: number,
  deltaY: number,
  deadzonePx = DEFAULT_VERTICAL_BOUNDARY_HYSTERESIS_PX,
) {
  const safeDeadzone = Math.max(0, Number.isFinite(deadzonePx) ? deadzonePx : 0);
  return Number.isFinite(deltaX)
    && Number.isFinite(deltaY)
    && Math.abs(deltaX) > safeDeadzone
    && Math.abs(deltaX) >= Math.abs(deltaY);
}

export function horizontalIntentFrameDeltaY(
  currentY: number,
  suspendedAtY: number | null | undefined,
  previousY: number,
) {
  const baseY = Number.isFinite(suspendedAtY) ? Number(suspendedAtY) : previousY;
  return Number.isFinite(currentY) && Number.isFinite(baseY) ? currentY - baseY : 0;
}

const midpoint = (rect: VerticalRect) =>
  Number.isFinite(rect.midY) ? Number(rect.midY) : (rect.top + rect.bottom) / 2;

const distanceFromRect = (rect: VerticalRect, y: number) => {
  if (y < rect.top) return rect.top - y;
  if (y > rect.bottom) return y - rect.bottom;
  return 0;
};

export function unionVerticalRects(rects: VerticalRect[]): VerticalRect | null {
  const valid = rects.filter(rect => Number.isFinite(rect.top) && Number.isFinite(rect.bottom));
  if (valid.length === 0) return null;
  const top = Math.min(...valid.map(rect => Math.min(rect.top, rect.bottom)));
  const bottom = Math.max(...valid.map(rect => Math.max(rect.top, rect.bottom)));
  return { top, bottom, midY: (top + bottom) / 2 };
}

export function resolveAtomicVerticalTarget<T>(
  targets: AtomicVerticalTarget<T>[],
  y: number,
  previousBoundary?: VerticalSemanticBoundary | null,
  hysteresisPx = DEFAULT_VERTICAL_BOUNDARY_HYSTERESIS_PX,
): ResolvedAtomicVerticalTarget<T> | null {
  if (!Number.isFinite(y) || targets.length === 0) return null;

  const safeHysteresis = Math.max(0, Number.isFinite(hysteresisPx) ? hysteresisPx : 0);
  let nearest: AtomicVerticalTarget<T> | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const distance = distanceFromRect(target.rect, y);
    const isCloser = distance < nearestDistance - EPSILON;
    const keepsPreviousOnTie = Math.abs(distance - nearestDistance) <= EPSILON
      && previousBoundary?.blockKey === target.key;
    if (isCloser || keepsPreviousOnTie) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  if (!nearest) return null;

  const previousTarget = previousBoundary
    ? targets.find(target => target.key === previousBoundary.blockKey) || null
    : null;
  if (previousTarget && previousTarget.key !== nearest.key) {
    const previousDistance = distanceFromRect(previousTarget.rect, y);
    const candidateWinsOutsideBand = nearestDistance + safeHysteresis < previousDistance - EPSILON;
    if (!candidateWinsOutsideBand) {
      nearest = previousTarget;
    }
  }

  const midY = midpoint(nearest.rect);
  const previousSide = previousBoundary?.blockKey === nearest.key
    ? previousBoundary.side
    : null;
  const side = previousSide === 'before' && y <= midY + safeHysteresis
    ? 'before'
    : previousSide === 'after' && y >= midY - safeHysteresis
      ? 'after'
      : y < midY - EPSILON
        ? 'before'
        : y > midY + EPSILON
          ? 'after'
          : previousSide || 'after';

  return {
    target: nearest,
    boundary: { blockKey: nearest.key, side },
  };
}

export function canReuseVerticalResolution<T>(
  cached: VerticalResolutionCache<T> | null | undefined,
  geometryId: number,
  sourceKey: string,
  projectionRevision: number,
  scrollAdjustedY: number,
): boolean {
  return !!cached
    && cached.geometryId === geometryId
    && cached.sourceKey === sourceKey
    && cached.projectionRevision === projectionRevision
    && Math.abs(cached.scrollAdjustedY - scrollAdjustedY) <= EPSILON;
}

export function sameVerticalSemanticBoundary(
  preview: VerticalSemanticBoundary | null | undefined,
  release: VerticalSemanticBoundary | null | undefined,
) {
  return !!preview
    && !!release
    && preview.blockKey === release.blockKey
    && preview.side === release.side;
}

export function isMainVerticalDropTarget(
  data: { type?: unknown; zone?: unknown } | null | undefined,
) {
  return data?.zone === 'main'
    || data?.type === 'GROUP'
    || data?.type === 'TAB_GROUP';
}
