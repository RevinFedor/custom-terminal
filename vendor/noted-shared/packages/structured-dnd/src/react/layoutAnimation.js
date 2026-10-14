export const DEFAULT_LAYOUT_ANIMATION = Object.freeze({
  enabled: true,
  duration: 120,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  respectReducedMotion: true,
  maxAnimatedRows: 16,
  minRetargetInterval: 32,
  animateDuringScroll: false,
});

export function normalizeLayoutAnimation(value = true) {
  if (value === false || value?.enabled === false) {
    return { ...DEFAULT_LAYOUT_ANIMATION, enabled: false };
  }
  const options = value && typeof value === 'object' ? value : {};
  const duration = Number(options.duration);
  const maxAnimatedRows = Number(options.maxAnimatedRows);
  const minRetargetInterval = Number(options.minRetargetInterval);
  return {
    enabled: true,
    duration: Number.isFinite(duration)
      ? Math.max(0, duration)
      : DEFAULT_LAYOUT_ANIMATION.duration,
    easing: typeof options.easing === 'string' && options.easing.trim()
      ? options.easing
      : DEFAULT_LAYOUT_ANIMATION.easing,
    respectReducedMotion: options.respectReducedMotion !== false,
    maxAnimatedRows: Number.isFinite(maxAnimatedRows)
      ? Math.max(0, Math.floor(maxAnimatedRows))
      : DEFAULT_LAYOUT_ANIMATION.maxAnimatedRows,
    minRetargetInterval: Number.isFinite(minRetargetInterval)
      ? Math.max(0, minRetargetInterval)
      : DEFAULT_LAYOUT_ANIMATION.minRetargetInterval,
    animateDuringScroll: options.animateDuringScroll === true,
  };
}

export function changedOutlineLayoutKeys(
  previousRows = [],
  nextRows = [],
  keyOf = (row) => row?.id,
) {
  const previous = new Map();
  previousRows.forEach((row, index) => {
    previous.set(keyOf(row), { index, depth: row?.depth ?? 0 });
  });

  const changed = new Set();
  const nextKeys = new Set();
  nextRows.forEach((row, index) => {
    const key = keyOf(row);
    nextKeys.add(key);
    const before = previous.get(key);
    if (!before || before.index !== index || before.depth !== (row?.depth ?? 0)) {
      changed.add(key);
    }
  });
  for (const key of previous.keys()) {
    if (!nextKeys.has(key)) changed.add(key);
  }
  return changed;
}

export function layoutAnimationBudgetReason({
  animationConfig = DEFAULT_LAYOUT_ANIMATION,
  origin = null,
  sourceRows = 0,
  changedRows = 0,
  projectedActiveRows = 0,
  elapsedSinceLayoutChange = Infinity,
} = {}) {
  if (origin === 'scroll' && animationConfig.animateDuringScroll !== true) {
    return 'scroll';
  }

  const rowBudget = Math.max(0, Number(animationConfig.maxAnimatedRows) || 0);
  if (sourceRows > rowBudget) return 'source-row-budget';
  if (changedRows > rowBudget) return 'changed-row-budget';
  if (projectedActiveRows > rowBudget) return 'active-row-budget';

  const minimumInterval = Math.max(
    0,
    Number(animationConfig.minRetargetInterval) || 0,
  );
  if (elapsedSinceLayoutChange < minimumInterval) return 'retarget-rate';
  return null;
}

export function allowsLayoutAnimationForMotionPreference(
  animationConfig,
  reducedMotion = false,
) {
  return !reducedMotion || animationConfig?.respectReducedMotion === false;
}

export function layoutAnimationCancelReason({
  layoutChanged = false,
  dragging = false,
  navigationMode = false,
  layoutChangeAxis = null,
} = {}) {
  const animatableAxis = layoutChangeAxis === 'vertical' || layoutChangeAxis === 'horizontal';
  if (layoutChanged) {
    return dragging && !navigationMode && animatableAxis
      ? 'retarget'
      : 'layout-change';
  }
  if (!dragging) return 'drag-end';
  if (navigationMode) return 'navigation';
  if (layoutChangeAxis && !animatableAxis) {
    return `axis-${layoutChangeAxis}`;
  }
  return null;
}

export function layoutFlipDelta({
  beforeLeft,
  beforeTop,
  afterLeft,
  afterTop,
  beforeScrollTop = 0,
  afterScrollTop = 0,
} = {}) {
  const beforeX = Number(beforeLeft);
  const afterX = Number(afterLeft);
  const beforeY = Number(beforeTop);
  const afterY = Number(afterTop);
  const previousScroll = Number(beforeScrollTop);
  const nextScroll = Number(afterScrollTop);
  const scrollDelta = Number.isFinite(previousScroll) && Number.isFinite(nextScroll)
    ? nextScroll - previousScroll
    : 0;
  return {
    x: Number.isFinite(beforeX) && Number.isFinite(afterX) ? beforeX - afterX : 0,
    y: Number.isFinite(beforeY) && Number.isFinite(afterY)
      ? beforeY - afterY - scrollDelta
      : 0,
  };
}

export function verticalFlipDelta({
  beforeTop,
  afterTop,
  beforeScrollTop = 0,
  afterScrollTop = 0,
} = {}) {
  return layoutFlipDelta({
    beforeTop,
    afterTop,
    beforeScrollTop,
    afterScrollTop,
  }).y;
}
