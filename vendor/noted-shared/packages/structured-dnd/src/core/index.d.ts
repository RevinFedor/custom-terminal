export type OutlineId = string | number;
export type OutlineDirection = 'left' | 'right';

export interface OutlineNode<TKind = string> {
  id: OutlineId;
  label?: string;
  kind?: TKind;
  collapsible?: boolean;
  expanded?: boolean;
  children?: Array<OutlineNode<TKind>>;
  [key: string]: unknown;
}

export interface OutlineRow<TKind = string> {
  id: OutlineId;
  label: string | undefined;
  kind: TKind | undefined;
  collapsible: boolean;
  parentId: OutlineId | null;
  index: number;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  hasNextSibling: boolean;
  ancestorContinuationDepths: number[];
  path: OutlineId[];
}

export interface OutlineLocation<TKind = string> {
  node: OutlineNode<TKind>;
  parentId: OutlineId | null;
  index: number;
  depth: number;
  ancestors: OutlineId[];
}

export interface OutlinePosition {
  parentId: OutlineId | null;
  index: number;
  depth: number;
}

export interface OutlineSlot extends OutlinePosition {
  boundary: number;
}

export interface DetachedOutline<TKind = string> {
  tree: Array<OutlineNode<TKind>>;
  detached: OutlineNode<TKind> | null;
  location: Omit<OutlineLocation<TKind>, 'node'> | null;
  changed: boolean;
}

export interface PreparedOutlineDrag<TKind = string> {
  baseTree: Array<OutlineNode<TKind>>;
  sourceNode: OutlineNode<TKind>;
  sourceLocation: Omit<OutlineLocation<TKind>, 'node'>;
  slot: OutlineSlot;
  preferredDepth: number;
  sourceRootIds?: OutlineId[];
  sourceNodes?: Array<OutlineNode<TKind>>;
  sourceIds?: OutlineId[];
  sourceLocations?: Array<OutlineLocation<TKind>>;
}

export interface VerticalProjection<TKind = string> {
  tree: Array<OutlineNode<TKind>>;
  slot: OutlineSlot;
  boundary: number;
  resolvedDepth: number;
  autoDepthDelta: number;
}

export type OutlineMutation<TKind = string> =
  | {
      ok: true;
      tree: Array<OutlineNode<TKind>>;
      parentId: OutlineId | null;
      index: number;
      depth: number;
      reason: 'indent' | 'outdent';
    }
  | {
      ok: false;
      tree: Array<OutlineNode<TKind>>;
      reason: 'missing-source' | 'missing-previous-sibling' | 'closed-parent' | 'root-boundary' | 'missing-parent';
    };

export const ROOT_PARENT_ID: null;

export function cloneTree<TKind = string>(nodes?: Array<OutlineNode<TKind>>): Array<OutlineNode<TKind>>;
export function flattenVisible<TKind = string>(nodes?: Array<OutlineNode<TKind>>): Array<OutlineRow<TKind>>;
export function flattenSubtree<TKind = string>(node?: OutlineNode<TKind> | null): Array<OutlineRow<TKind>>;
export function getSubtreeIds(node?: OutlineNode | null): OutlineId[];
export function findNodeLocation<TKind = string>(nodes: Array<OutlineNode<TKind>>, targetId: OutlineId): OutlineLocation<TKind> | null;
export function detachNode<TKind = string>(nodes: Array<OutlineNode<TKind>>, targetId: OutlineId): DetachedOutline<TKind>;
export function insertNode<TKind = string>(
  nodes: Array<OutlineNode<TKind>>,
  node: OutlineNode<TKind>,
  parentId: OutlineId | null,
  rawIndex: number,
  options?: { expandParent?: boolean },
): Array<OutlineNode<TKind>>;
export function enumerateVisibleSlots<TKind = string>(
  nodes: Array<OutlineNode<TKind>>,
  options?: { includeEmptyParentIds?: OutlineId[]; includeAllEmptyParents?: boolean },
): OutlineSlot[];
export function chooseVerticalSlot(
  slots: OutlineSlot[],
  options?: { boundary?: number; preferredDepth?: number; previousDepth?: number },
): OutlineSlot | null;
export function normalizeDragRoots(tree:OutlineNode[], requestedIds?:OutlineId[]):OutlineId[];
export function prepareDrag<TKind = string>(tree: Array<OutlineNode<TKind>>, sourceId: OutlineId,
  options?:{sourceRootIds?:OutlineId[]}): PreparedOutlineDrag<TKind>;
export function projectForestToRootEnd<TKind=string>(tree:Array<OutlineNode<TKind>>,sourceId:OutlineId,
  sourceRootIds?:OutlineId[]):Array<OutlineNode<TKind>>;
export function projectVerticalMove<TKind = string>(options: {
  baseTree: Array<OutlineNode<TKind>>;
  sourceNode: OutlineNode<TKind>;
  sourceNodes?: Array<OutlineNode<TKind>>;
  boundary?: number;
  preferredDepth?: number;
  previousDepth?: number;
  currentParentId?: OutlineId | null;
  canUseSlot?: (slot: OutlineSlot) => boolean;
}): VerticalProjection<TKind>;
export function indentNode<TKind = string>(tree: Array<OutlineNode<TKind>>, sourceId: OutlineId): OutlineMutation<TKind>;
export function outdentNode<TKind = string>(tree: Array<OutlineNode<TKind>>, sourceId: OutlineId): OutlineMutation<TKind>;
export function outlineSnapshot<TKind = string>(nodes: Array<OutlineNode<TKind>>): Array<{ id: OutlineId } & OutlinePosition>;
export function assertValidOutline<TKind = string>(nodes: Array<OutlineNode<TKind>>): true;

export const ROW_HEIGHT: 44;
export const HORIZONTAL_THRESHOLD: 40;
export const HORIZONTAL_PREVIEW_START: 7;
export const HORIZONTAL_Y_TOLERANCE: 3;
export const VERTICAL_REBASE_DISTANCE: 7;
export const EDGE_ZONE_SIZE: 72;
export const MAX_SCROLL_STEP: 14;
export const EDGE_ACTIVATION_DISTANCE: 5;
export const COLLAPSIBLE_DWELL_INTERVAL: 900;

export interface HorizontalIntent {
  direction: OutlineDirection | null;
  deltaX: number;
  progress: number;
  crossed: boolean;
}

export interface EdgeGesture {
  zone: 'top' | 'bottom' | null;
  active: boolean;
  anchorY: number;
}

export interface CollapsibleDwell {
  targetId: OutlineId;
  blocked: boolean;
  startedAt: number;
  progress: number;
  cycle: number;
}

export function boundaryFromPointer(options: {
  clientY: number;
  grabOffsetY: number;
  containerTop: number;
  scrollTop: number;
  rowHeight?: number;
  visibleCount: number;
}): number;
export function detachedBoundaryTops(options: {
  rows: Array<{ id: OutlineId; top: number; bottom: number }>;
  sourceIds: OutlineId[];
  currentBoundary: number;
  allowDisjoint?: boolean;
}): number[];
export function forestAnchorOffset(options:{rows:Array<{id:OutlineId;top:number;bottom:number}>;
  sourceIds:OutlineId[];anchorId:OutlineId}):number;
export function boundaryFromGeometry(options: {
  sourceTop: number;
  boundaryTops: number[];
  fallbackBoundary?: number;
}): number;
export function horizontalIntent(options: {
  clientX: number;
  baseX: number;
  threshold?: number;
  previewStart?: number;
}): HorizontalIntent;
export function edgeScrollVelocity(options: {
  clientY: number;
  top: number;
  bottom: number;
  zoneSize?: number;
  maxStep?: number;
}): number;
export function edgeZoneFromPointer(options: {
  clientY: number;
  top: number;
  bottom: number;
  zoneSize?: number;
}): 'top' | 'bottom' | null;
export function createEdgeGesture(options: {
  clientY: number;
  top: number;
  bottom: number;
  zoneSize?: number;
}): EdgeGesture;
export function updateEdgeGesture(
  gesture: EdgeGesture | null,
  options: {
    clientY: number;
    top: number;
    bottom: number;
    zoneSize?: number;
    activationDistance?: number;
  },
): EdgeGesture;
export function advanceCollapsibleDwell(
  dwell: CollapsibleDwell | null,
  options: {
    targetId?: OutlineId | null;
    blocked?: boolean;
    now?: number;
    interval?: number;
  },
): { dwell: CollapsibleDwell | null; shouldToggle: boolean };

export interface OutlineSession<TKind = string> {
  phase: 'active';
  sourceId: OutlineId;
  baselineTree: Array<OutlineNode<TKind>>;
  origin: OutlinePosition;
  tree: Array<OutlineNode<TKind>>;
  baseTree: Array<OutlineNode<TKind>>;
  sourceNode: OutlineNode<TKind>;
  slot: OutlineSlot;
  boundary: number;
  position: OutlinePosition;
  preferredDepth: number;
  resolvedDepth: number;
  autoDepthDelta: number;
  lastStep: {
    direction: OutlineDirection;
    ok: boolean;
    reason: string;
  } | null;
}

export interface OutlineSessionResult<TKind = string> {
  type: 'commit' | 'cancel';
  committed: boolean;
  sourceId: OutlineId;
  tree: Array<OutlineNode<TKind>>;
  position: OutlinePosition;
}

export function begin<TKind = string>(tree: Array<OutlineNode<TKind>>, sourceId: OutlineId): OutlineSession<TKind>;
export function project<TKind = string>(session: OutlineSession<TKind>, options: { boundary?: number }): OutlineSession<TKind>;
export function step<TKind = string>(session: OutlineSession<TKind>, direction: OutlineDirection): OutlineSession<TKind>;
export function commit<TKind = string>(session: OutlineSession<TKind>): OutlineSessionResult<TKind> & { type: 'commit'; committed: true };
export function cancel<TKind = string>(session: OutlineSession<TKind>): OutlineSessionResult<TKind> & { type: 'cancel'; committed: false };
