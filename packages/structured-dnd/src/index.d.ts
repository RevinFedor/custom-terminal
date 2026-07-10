export type StructuredEntity = { type: 'container' | 'item'; id: string };
export type StructuredModel = {
  containers: Array<Record<string, unknown> & { id: string; position: number }>;
  items: Array<Record<string, unknown> & { id: string; containerId: string | null; parentId: string | null; position: number }>;
};
export type RectSnapshot = { left: number; right: number; top: number; bottom: number; width: number; height: number; midX: number; midY: number; translateX: number; translateY: number };
export type GroupedListTarget = { key: string; kind: 'flat'; index: number; reason: string } | { key: string; kind: 'container'; containerId: string; index: number; reason: string };

export function entityKey(entity: StructuredEntity): string;
export function snapRect(element: Element, options?: { compensateTransform?: boolean }): RectSnapshot;
export function normalizeStructuredModel(raw?: Partial<StructuredModel>): StructuredModel;
export function orderVisualHierarchyItems<T extends { id: string }>(items: T[], options?: { parentKey?: string }): T[];
export function buildVisualHierarchyDepthMap(items: Array<{ id: string }>, options?: { parentKey?: string; maxDepth?: number }): Map<string, number>;
export function visualHierarchyAncestorIds(items: Array<{ id: string }>, itemId: string, options?: { parentKey?: string }): string[];
export function resolveVisualHierarchyStep(args: { items: Array<Record<string, unknown> & { id: string }>; sourceId: string; direction: 'left' | 'right'; parentKey?: string; containerKey?: string; maxDepth?: number }): any;
export function flatStructuredEntities(raw: Partial<StructuredModel>): StructuredEntity[];
export function moveStructuredEntity(raw: Partial<StructuredModel>, drag: StructuredEntity, target: { kind: 'flat'; index: number } | { kind: 'container'; containerId: string; index: number }): StructuredModel;
export function captureGroupedListGeometry(root: HTMLElement | null, flatEntities: StructuredEntity[], options?: { compensateTransform?: boolean }): any;
export function resolveGroupedListTarget(args: { geometry: any; drag: StructuredEntity; clientX: number; clientY: number }): GroupedListTarget | null;
export function autoScrollNearEdge(element: HTMLElement | null, clientY: number, options?: { edge?: number; minStep?: number; divisor?: number }): boolean;
export function startPointerDragSession(event: any, options: any): { session: any; cancel(): void } | null;
