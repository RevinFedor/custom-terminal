import type { HTMLAttributes, MutableRefObject, PointerEvent as ReactPointerEvent, RefCallback } from 'react';

export type OutlineDndId = string | number;

export type OutlineDndNode = {
  id: OutlineDndId;
  kind?: 'file' | 'folder' | string;
  collapsible?: boolean;
  expanded?: boolean;
  children?: OutlineDndNode[];
  [key: string]: unknown;
};

export type OutlineDndRow = {
  id: OutlineDndId;
  label?: string;
  kind?: string;
  collapsible: boolean;
  parentId: OutlineDndId | null;
  index: number;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  hasNextSibling: boolean;
  ancestorContinuationDepths: number[];
  path: OutlineDndId[];
};

export type OutlineDndCommitPayload<TNode extends OutlineDndNode = OutlineDndNode> = {
  sourceId: OutlineDndId;
  sourceIds: OutlineDndId[];
  sourceNode: TNode;
  sourceRootIds?: OutlineDndId[];
  sourceNodes?: TNode[];
  sourceContext?: any;
  isCurrent?: () => boolean;
  originalOutline: TNode[];
  previewOutline: TNode[];
  sessionId: string;
  reason: string;
  externalTarget: unknown | null;
};

export type OutlineDndExternalTargetPayload<TNode extends OutlineDndNode = OutlineDndNode> = {
  clientX: number;
  clientY: number;
  startX: number;
  startY: number;
  sourceId: OutlineDndId;
  sourceIds: OutlineDndId[];
  sourceNode: TNode;
  sourceRootIds?: OutlineDndId[];
  sourceNodes?: TNode[];
  sourceContext?: any;
  previewOutline: TNode[];
  /** True while the platform Command/Meta modifier is held for this gesture. */
  metaKey: boolean;
  /** The outline is frozen in its Cmd navigation mode. */
  navigationMode: boolean;
};

export type OutlineDndExpansionPayload = {
  nodeId: OutlineDndId;
  expanded: boolean;
  reason: 'pointer-toggle' | 'cmd-dwell' | 'drag-cancel' | string;
};

export type OutlineDndCallbackResult = void | boolean | { ok: boolean };
export type OutlineDndMaybeAsyncResult = OutlineDndCallbackResult | Promise<OutlineDndCallbackResult>;

export type OutlineDndHorizontalMovePayload<TNode extends OutlineDndNode = OutlineDndNode> = {
  direction: 'left' | 'right';
  sourceId: OutlineDndId;
  sourceNode: TNode;
  sourceRootIds?: OutlineDndId[];
  sourceContext?: any;
  currentOutline: TNode[];
  proposedOutline: TNode[];
  result: {
    ok: true;
    tree: TNode[];
    parentId: OutlineDndId | null;
    index: number;
    depth: number;
    reason: string;
  };
};

export type OutlineDndHorizontalMoveDecision =
  | void
  | boolean
  | { ok: boolean; reason?: string };

export type OutlineDndVerticalSlotPayload<TNode extends OutlineDndNode = OutlineDndNode> = {
  sourceId: OutlineDndId;
  sourceNode: TNode;
  sourceRootIds?: OutlineDndId[];
  sourceNodes?: TNode[];
  sourceContext?: any;
  baseOutline: TNode[];
  slot: {
    parentId: OutlineDndId | null;
    index: number;
    depth: number;
    boundary: number;
  };
};

export type OutlineDndFeedback = {
  direction: 'left' | 'right';
  progress: number;
  blocked: boolean;
  reason: string | null;
};

export type OutlineDndDwell = {
  targetId: OutlineDndId;
  blocked: boolean;
  pending: boolean;
  startedAt: number;
  progress: number;
  cycle: number;
};

export type OutlineDndScrollLease = {
  height: number;
  /** May be negative when rendered content is shorter than the scroller viewport. */
  naturalMax: number;
  ceiling: number;
};

export type OutlineDndDragState = {
  phase: 'pending' | 'dragging' | 'committing';
  sessionId: string;
  sourceId: OutlineDndId;
  sourceIds?: OutlineDndId[];
  sourceRootIds?: OutlineDndId[];
  sourceContext?: any;
  externalOwnerKey?: string;
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  boundary?: number;
  pointerBoundary?: number | null;
  preferredDepth?: number;
  resolvedDepth?: number;
  currentParentId?: OutlineDndId | null;
  slot?: { parentId: OutlineDndId | null; index: number; depth: number; boundary: number };
  feedback?: OutlineDndFeedback | null;
  edge?: 'top' | 'bottom' | null;
  edgeOrigin?: 'pointer' | 'scroll' | 'navigation-release' | null;
  navigationMode?: boolean;
  hierarchyMode?: boolean;
  navigationDwell?: OutlineDndDwell | null;
  scrollReserve?: number;
  scrollCeiling?: number;
  lastAnchor?: {
    topBefore: number;
    topAfter: number;
    scrollCompensation: number;
  } | null;
  expansionPendingIds?: OutlineDndId[];
  layoutChangeAxis?: 'vertical' | 'horizontal' | 'navigation' | 'external' | null;
  externalTarget?: unknown | null;
  previewRevision: number;
};

export type OutlineDndLayoutAnimationOptions = {
  enabled?: boolean;
  duration?: number;
  easing?: string;
  respectReducedMotion?: boolean;
  maxAnimatedRows?: number;
  minRetargetInterval?: number;
  animateDuringScroll?: boolean;
};

export type OutlineDndOutsidePointerPolicy = 'cancel' | 'horizontal-corridor';

export type OutlineDndLogEvent = {
  type: string;
  detail: Record<string, unknown>;
  sessionId: string | null;
  sourceId: OutlineDndId | null;
  timestamp: number;
};

export type UseOutlineDndOptions<TNode extends OutlineDndNode = OutlineDndNode> = {
  outline: TNode[];
  scopeKey?: string;
  getDragSource?: (input: {outline:TNode[];sourceId:OutlineDndId;sessionId:string;
    pointerId:number;clientX:number;clientY:number;metaKey:boolean;grabOffsetY:number}) => false | {
      rootIds:OutlineDndId[];context?:any;releaseOwnerKey?:string};
  validateDragSource?: (drag:OutlineDndDragState) => boolean;
  externalDrag?: {active?:boolean;ownerKey:string;sourceId:OutlineDndId;pointerId:number;pointerType?:string;
    clientX:number;clientY:number;metaKey?:boolean;sourceRootIds?:OutlineDndId[];sourceContext?:any;rollbackOutline?:TNode[];
    gestureId?:string;
    /** Optional original sidebar grab, in viewport CSS pixels. Omitted keeps pane centre grab. */
    grabOffsetY?:number;
    /** Inside adoption RAF, reread physical identity/coordinates without recapturing the frozen source. */
    readCurrentInput?:()=>Readonly<{active:boolean;ownerKey:string;gestureId:string;pointerId:number;clientX:number;clientY:number;metaKey?:boolean}> | null;
    releaseOwner?:'bridge' | 'hook'} | null;
  disabled?: boolean;
  onCommit?: (payload: OutlineDndCommitPayload<TNode>) => OutlineDndMaybeAsyncResult;
  onExternalCommit?: (payload: OutlineDndCommitPayload<TNode>) => OutlineDndMaybeAsyncResult;
  onExpansionRequest?: (payload: OutlineDndExpansionPayload) => OutlineDndMaybeAsyncResult;
  onToggle?: (payload: OutlineDndExpansionPayload) => OutlineDndMaybeAsyncResult;
  onLog?: (event: OutlineDndLogEvent) => void;
  onDiagnostic?: (phase: string, fields: Record<string, unknown>) => void;
  canHorizontalMove?: (
    payload: OutlineDndHorizontalMovePayload<TNode>,
  ) => OutlineDndHorizontalMoveDecision;
  canUseVerticalSlot?: (
    payload: OutlineDndVerticalSlotPayload<TNode>,
  ) => boolean | { ok: boolean };
  resolveExternalTarget?: (payload: OutlineDndExternalTargetPayload<TNode>) => unknown | null;
  createSessionId?: () => string;
  pointerThreshold?: number;
  rowHeight?: number | null;
  horizontalThreshold?: number;
  horizontalPreviewStart?: number;
  horizontalYTolerance?: number;
  /** Opt-in Cmd-gated X and plain folder hover; default keeps legacy Cmd navigation pause. */
  hierarchyModifier?: 'meta' | null;
  /** Explicit immutable-outline host with its own imperative floating preview. Default publishes every processed frame. */
  pointerPublication?: 'frame' | 'semantic';
  /** Continuous real-row Y; merge getRowProps().style. X stays semantic. Default off for hosts with their own feedback. */
  sourceFollow?: 'y' | null;
  verticalRebaseDistance?: number;
  edgeZoneSize?: number;
  edgeScrollStep?: number;
  edgeActivationDistance?: number;
  folderDwellInterval?: number;
  ignoreSelector?: string;
  outsidePointerPolicy?: OutlineDndOutsidePointerPolicy;
  layoutAnimation?: boolean | OutlineDndLayoutAnimationOptions;
};

export type OutlineDndRowProps = HTMLAttributes<HTMLElement> & {
  ref: RefCallback<HTMLElement>;
  draggable: false;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
};

export type UseOutlineDndResult<TNode extends OutlineDndNode = OutlineDndNode> = {
  previewOutline: TNode[];
  rows: OutlineDndRow[];
  dragState: OutlineDndDragState | null;
  scrollerRef: MutableRefObject<HTMLElement | null>;
  getRowProps: (rowOrId: OutlineDndRow | OutlineDndId) => OutlineDndRowProps;
  requestExpansion: (nodeId: OutlineDndId, expanded: boolean, reason?: string) => Promise<boolean>;
  scrollReserve: number;
  scrollLease: OutlineDndScrollLease | null;
  scrollSpacerProps: HTMLAttributes<HTMLElement> & {
    ref: (element: HTMLElement | null) => void;
  };
  cancel: (reason?: string) => boolean;
  commitExternalDrag: (reason?: string, finalInput?:{ownerKey:string;pointerId:number;releasePoint?:{clientX:number;clientY:number}}) => boolean;
  /** Immutable DTOs only; excludes frozen compiler context and external-target preview forests. Never flushes queued input. */
  getDragSnapshot: () => Readonly<{ownerEpoch:number;
    current:Readonly<Omit<OutlineDndDragState,'sourceContext'> & {gestureId:string|null;ownerEpoch?:number;releasePending:boolean}> | null;
    painted:Readonly<{sessionId:string;ownerEpoch:number;ownerKey:string|null;pointerId:number;gestureId:string|null;revision:number;
      drag:Readonly<Omit<OutlineDndDragState,'sourceContext'> & {gestureId:string|null;ownerEpoch?:number;releasePending:boolean}>}> | null}>;
};

export function useOutlineDnd<TNode extends OutlineDndNode = OutlineDndNode>(
  options: UseOutlineDndOptions<TNode>,
): UseOutlineDndResult<TNode>;
