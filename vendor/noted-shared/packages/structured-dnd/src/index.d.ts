export type StructuredEntity = { type: 'container' | 'item'; id: string };
export type StructuredModel = {
  containers: Array<Record<string, unknown> & { id: string; position: number }>;
  items: Array<Record<string, unknown> & { id: string; containerId: string | null; parentId: string | null; position: number }>;
};
export type RectSnapshot = { left: number; right: number; top: number; bottom: number; width: number; height: number; midX: number; midY: number; translateX: number; translateY: number };
export type GroupedListTarget = { key: string; kind: 'block'; targetType: 'container' | 'item'; targetId: string; placement: 'before' | 'after'; reason: string };
export type AxisThresholdStepResult<TState> = { ok: boolean; next?: TState } & Record<string, unknown>;
export type AxisThresholdConsumption<TState> = {
  direction: -1 | 0 | 1;
  requestedSteps: number;
  acceptedSteps: number;
  acceptedResults: Array<AxisThresholdStepResult<TState>>;
  blockedResult: AxisThresholdStepResult<TState> | null;
  blockedAtStep: number | null;
  state: TState;
  consumedDelta: number;
  remainder: number;
};
export type HorizontalThresholdFrame<TState> = AxisThresholdConsumption<TState> & {
  deltaX: number;
  deltaY: number;
  blockedAtThreshold: boolean;
  releaseBlocked: boolean;
  nextHorizontalBaseX: number;
  nextVerticalBaseY: number;
  residualDeltaX: number;
};

export function entityKey(entity: StructuredEntity): string;
export function consumeAxisThresholdSteps<TState>(args: {
  delta: number;
  threshold: number;
  state: TState;
  resolveStep: (state: TState, stepIndex: number) => AxisThresholdStepResult<TState> | null;
  maxSteps?: number;
}): AxisThresholdConsumption<TState>;
export function resolveAxisFrameOwner(args: {
  deltaX?: number;
  deltaY?: number;
  horizontalDeadzone?: number;
  verticalThreshold?: number;
  forceVertical?: boolean;
}): 'horizontal' | 'vertical' | null;
export function shouldHandoffBlockedHorizontalToVertical(args: {
  horizontalBlocked?: boolean;
  deltaX?: number;
  deltaY?: number;
  verticalThreshold?: number;
}): boolean;
export function shouldShowAxisBoundaryStop(args: {
  previewChanged?: boolean;
  canContinue?: boolean;
  acceptedAt?: number | null;
  currentPosition?: number | null;
  holdDistance?: number;
}): boolean;
export function resolveIdleAxisFeedbackState(args: {
  feedbackAxis?: 'horizontal' | 'vertical' | null;
  releaseBlocked?: boolean;
  retainHorizontal?: boolean;
  clearHorizontalBlock?: boolean;
}): {
  feedbackAxis: 'horizontal' | 'vertical' | null;
  releaseBlocked: boolean;
};
export function resolveIdleHorizontalSessionState(args: {
  boundaryActive?: boolean;
  boundaryStartX?: number | null;
  boundaryStartY?: number | null;
  feedbackDirection?: 'left' | 'right' | null;
  deltaX?: number;
  clearHorizontalBlock?: boolean;
}): {
  boundaryActive: boolean;
  boundaryStartX: number | null;
  boundaryStartY: number | null;
  feedbackDirection: 'left' | 'right' | null;
};
export function shouldClearHorizontalBoundary(args: {
  feedbackAxis?: 'horizontal' | 'vertical' | null;
  boundaryActive?: boolean;
  deltaX?: number;
  horizontalDeadzone?: number;
}): boolean;
export function shouldRestartHorizontalBoundary(args: {
  boundaryActive?: boolean;
  boundaryDirection?: 'left' | 'right' | null;
  frameDirection?: 'left' | 'right' | null;
}): boolean;
export function resolveFrozenCommitProjection(args: {
  hasCommitProjection?: boolean;
  commitKey?: string | null;
  releaseBlocked?: boolean;
}): {
  canCommit: boolean;
  frozenCommitKey: string | null;
  frozenHasCommitProjection: boolean;
  resumeCommitKey: string | null;
  resumeHasCommitProjection: boolean;
};
export function consumeHorizontalThresholdFrame<TState>(args: {
  clientX: number;
  clientY: number;
  previousClientX?: number | null;
  previousClientY?: number | null;
  horizontalBaseX: number;
  verticalBaseY: number;
  horizontalBoundaryActive?: boolean;
  threshold: number;
  state: TState;
  resolveStep: (state: TState, stepIndex: number) => AxisThresholdStepResult<TState> | null;
  maxSteps?: number;
}): HorizontalThresholdFrame<TState>;
export function snapRect(element: Element, options?: { compensateTransform?: boolean }): RectSnapshot;
export function normalizeStructuredModel(raw?: Partial<StructuredModel>): StructuredModel;
export function orderVisualHierarchyItems<T extends { id: string }>(items: T[], options?: { parentKey?: string }): T[];
export function buildVisualHierarchyDepthMap(items: Array<{ id: string }>, options?: { parentKey?: string; maxDepth?: number }): Map<string, number>;
export function visualHierarchyAncestorIds(items: Array<{ id: string }>, itemId: string, options?: { parentKey?: string }): string[];
export function visualHierarchySubtreeItems<T extends { id: string }>(items: T[], itemId: string, options?: { parentKey?: string }): T[];
export function normalizeSelectedVisualRootIds(items: Array<{ id: string }>, selectedIds: Iterable<string>, options?: { parentKey?: string }): string[];
export function resolveVisualBlockMove(args: {
  items: Array<Record<string, unknown> & { id: string }>;
  sourceId: string;
  selectedIds?: Iterable<string>;
  targetId: string;
  placement?: 'before' | 'after';
  parentKey?: string;
  containerKey?: string;
}): any;
export function resolveVisualHierarchyStep(args: { items: Array<Record<string, unknown> & { id: string }>; sourceId: string; direction: 'left' | 'right'; parentKey?: string; containerKey?: string; maxDepth?: number }): any;
export function flatStructuredEntities(raw: Partial<StructuredModel>): StructuredEntity[];
export function moveStructuredEntity(raw: Partial<StructuredModel>, drag: StructuredEntity, target: { kind: 'flat'; index: number } | { kind: 'container'; containerId: string; index: number }): StructuredModel;
export function resolveStructuredVerticalMove(args: {
  model: Partial<StructuredModel>;
  geometry: any;
  drag: StructuredEntity;
  clientX: number;
  clientY: number;
  parentKey?: string;
  containerKey?: string;
}): any;
export function resolveStructuredHierarchyStep(args: {
  model: Partial<StructuredModel>;
  sourceId: string;
  direction: 'left' | 'right';
  parentKey?: string;
  containerKey?: string;
  maxDepth?: number;
  targetContainerId?: string | null;
  geometry?: any;
  clientY?: number | null;
  openContainerIds?: Iterable<string | number> | null;
}): any;
export function captureGroupedListGeometry(root: HTMLElement | null, flatEntities: StructuredEntity[], options?: { compensateTransform?: boolean }): any;
export function resolveGroupedListTarget(args: { geometry: any; drag: StructuredEntity; clientX: number; clientY: number }): GroupedListTarget | null;
export function autoScrollNearEdge(element: HTMLElement | null, clientY: number, options?: { edge?: number; minStep?: number; divisor?: number }): boolean;
export function startPointerDragSession(event: any, options: any): { session: any; cancel(): void } | null;
